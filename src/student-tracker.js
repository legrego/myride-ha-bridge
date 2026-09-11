"use strict";

const { EventEmitter } = require("events");

/**
 * Default IANA timezone for interpreting "now" against district stop times.
 * MyRide stop times are local to the district; if no timezone is configured
 * we assume US Eastern, which covers the districts this bridge is used with.
 */
const DEFAULT_TIME_ZONE = "America/New_York";

/**
 * True if `timeZone` is a valid IANA timezone that Intl can resolve.
 */
function isValidTimeZone(timeZone) {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute minutes-since-midnight for `date` as observed in `timeZone`.
 *
 * MyRide stop times are district-local wall-clock times, so "now" must be
 * evaluated in the same timezone for the run-window comparisons in
 * pickCurrentRun() to be correct. Relying on the host's local time
 * (Date#getHours) breaks whenever the container runs in a different zone
 * (e.g. UTC), which would push "now" outside every run window.
 *
 * Uses Intl (ICU) rather than the system clock so it works regardless of
 * whether the OS has tzdata installed. Returns null if the time can't be
 * parsed.
 */
function nowMinutesInTimeZone(date, timeZone = DEFAULT_TIME_ZONE) {
  const effectiveZone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: effectiveZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  let hours = null;
  let minutes = null;
  for (const part of parts) {
    if (part.type === "hour") hours = parseInt(part.value, 10);
    else if (part.type === "minute") minutes = parseInt(part.value, 10);
  }
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours === 24) hours = 0; // some ICU builds emit "24" at midnight
  return hours * 60 + minutes;
}

/**
 * Parse a stopTime string like "1900-01-01T09:02:22.99" into minutes-since-midnight.
 * The date portion is always a placeholder; only the time part matters.
 */
function stopTimeToMinutes(stopTime) {
  if (!stopTime) return null;
  const parts = stopTime.split("T");
  if (parts.length < 2) return null;
  const [h, m] = parts[1].split(":");
  const hours = parseInt(h, 10);
  const minutes = parseInt(m, 10);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  return hours * 60 + minutes;
}

/**
 * Format minutes-since-midnight as "HH:MM" (24h). Returns null for null input.
 */
function formatMinutes(mins) {
  if (mins == null || !Number.isFinite(mins)) return null;
  const h = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/**
 * Great-circle distance between two lat/lng points, in meters.
 * Returns null if any coordinate is missing/non-finite.
 */
function haversineMeters(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every((n) => Number.isFinite(n))) return null;
  const R = 6371000; // Earth radius in meters
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Parse a WKT LINESTRING into an array of [lat, lng] vertices.
 *
 * WKT stores coordinates in **lng lat** order (X = longitude, Y = latitude), so
 * each pair is swapped to the [lat, lng] convention used everywhere else here.
 * Returns null for anything that isn't a parseable LINESTRING with ≥1 vertex.
 *
 * @param {string} wkt — e.g. "LINESTRING (-72.0 41.5, -72.01 41.51)"
 * @returns {Array<[number, number]>|null}
 */
function parseLineString(wkt) {
  if (typeof wkt !== "string") return null;
  const m = wkt.match(/LINESTRING\s*\(([^)]*)\)/i);
  if (!m) return null;
  const points = [];
  for (const pair of m[1].split(",")) {
    const nums = pair.trim().split(/\s+/).map(Number);
    if (nums.length < 2 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[1])) continue;
    points.push([nums[1], nums[0]]); // WKT is lng lat → [lat, lng]
  }
  return points.length > 0 ? points : null;
}

/**
 * Concatenate a run's ordered `runDetail[].directionGeomLine` WKT segments into a
 * single [lat, lng] polyline in travel order, dropping the duplicate vertex where
 * one segment's end coincides with the next segment's start.
 *
 * `runDetail` is already ordered in travel order (ascending runStopSeq, then
 * directionSeq), so we walk it as-is. Rows with missing/unparseable geometry are
 * skipped. Returns [] when no geometry is present.
 *
 * @param {Array} runDetail
 * @returns {Array<[number, number]>}
 */
function buildRoutePolyline(runDetail) {
  const detail = Array.isArray(runDetail) ? runDetail : [];
  const polyline = [];
  for (const row of detail) {
    if (!row) continue;
    const seg = parseLineString(row.directionGeomLine);
    if (!seg) continue;
    for (const pt of seg) {
      const last = polyline[polyline.length - 1];
      if (last && last[0] === pt[0] && last[1] === pt[1]) continue; // drop join dup
      polyline.push(pt);
    }
  }
  return polyline;
}

/**
 * Cumulative road distance (meters from the polyline start) at each vertex.
 * `out[0]` is always 0; `out[i]` sums the haversine leg lengths up to vertex i.
 *
 * @param {Array<[number, number]>} polyline
 * @returns {number[]}
 */
function cumulativeMetersAlong(polyline) {
  const cumulative = [];
  let total = 0;
  for (let i = 0; i < polyline.length; i++) {
    if (i > 0) {
      const leg = haversineMeters(
        polyline[i - 1][0], polyline[i - 1][1], polyline[i][0], polyline[i][1]
      );
      total += leg != null ? leg : 0;
    }
    cumulative.push(total);
  }
  return cumulative;
}

/**
 * Snap a point to the nearest polyline **vertex** and read that vertex's
 * cumulative road distance from the route start.
 *
 * Deliberately vertex-granular (not full point-to-segment projection): the
 * LINESTRINGs are dense enough (tens of meters between vertices) for a
 * neighborhood-scale ETA, and it needs far less code.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {Array<[number, number]>} polyline
 * @param {number[]} cumulative — from cumulativeMetersAlong(polyline)
 * @returns {{cumulativeMeters: number, distMeters: number}|null} — `distMeters`
 *   is the snap distance (how far the point sits off the route)
 */
function nearestVertexCumulative(lat, lng, polyline, cumulative) {
  if (!Array.isArray(polyline) || polyline.length === 0) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let bestDist = Infinity;
  let bestCum = null;
  for (let i = 0; i < polyline.length; i++) {
    const d = haversineMeters(lat, lng, polyline[i][0], polyline[i][1]);
    if (d != null && d < bestDist) {
      bestDist = d;
      bestCum = cumulative[i];
    }
  }
  if (bestCum == null) return null;
  return { cumulativeMeters: bestCum, distMeters: bestDist };
}

/**
 * Attach route geometry to a normalized `myStop` so the publisher can compute
 * road-following (rather than crow-flies) distance to the stop.
 *
 * Adds three fields to `myStop` (kept in memory only — never published to MQTT):
 *   - `routePolyline`         — [lat,lng] vertices of the whole run, in travel order
 *   - `cumulativeMeters`      — per-vertex cumulative distance from the run start
 *   - `cumulativeAtStopMeters`— cumulative distance at the vertex nearest the stop pin
 *
 * The remaining road distance to the stop is then
 * `cumulativeAtStopMeters − cumulativeAtBus`, where the bus is snapped live. When
 * geometry is missing/unparseable (or the stop lacks coordinates), the fields are
 * left unset and the publisher falls back to haversine.
 *
 * @param {object} run — raw run carrying `runDetail`
 * @param {object|null} myStop — normalized stop (mutated in place)
 */
function attachRouteGeometry(run, myStop) {
  if (!myStop || !Number.isFinite(myStop.lat) || !Number.isFinite(myStop.lng)) return;
  const polyline = buildRoutePolyline(run && run.runDetail);
  if (polyline.length < 2) return; // need at least one leg for cumulative distance
  const cumulative = cumulativeMetersAlong(polyline);
  const stopSnap = nearestVertexCumulative(myStop.lat, myStop.lng, polyline, cumulative);
  if (!stopSnap) return;
  myStop.routePolyline = polyline;
  myStop.cumulativeMeters = cumulative;
  myStop.cumulativeAtStopMeters = stopSnap.cumulativeMeters;
}

/**
 * Build a normalized "my stop" descriptor for one run.
 *
 * MyRide's `stopsInfo` contains ONLY this student's own stops (their Pickup and
 * Dropoff), each carrying a friendly name and authoritative coordinates. The
 * stop the parent cares about is the *home-side* one (Pickup in the morning,
 * Dropoff in the afternoon), which is the stop nearest the student's home.
 *
 * Selection priority:
 *   1. Nearest to the student's home coordinates (most robust — works for both
 *      AM and PM runs regardless of Pickup/Dropoff labeling).
 *   2. The stop whose locationName differs from the school's (home stop's
 *      locationName is blank; the school stop carries the school name).
 *   3. The Pickup stop, else the first stop.
 *
 * @param {object} run — a raw run from runInfo[]
 * @param {{latitude:number, longitude:number}} [home] — student home coordinates
 * @param {string} [schoolName] — the student's school (top-level locationName)
 * @returns {object|null} normalized stop, or null when no stopsInfo is present
 */
function pickMyStop(run, home, schoolName) {
  const stops = (run && run.stopsInfo) || [];
  if (stops.length === 0) return null;

  let chosen = null;

  // 1. Nearest to home
  if (home && Number.isFinite(home.latitude) && Number.isFinite(home.longitude)) {
    let best = Infinity;
    for (const s of stops) {
      const d = haversineMeters(home.latitude, home.longitude, s.stopLat, s.stopLong);
      if (d != null && d < best) {
        best = d;
        chosen = s;
      }
    }
  }

  // 2. Not-the-school by name
  if (!chosen && schoolName) {
    const norm = (v) => String(v || "").trim().toLowerCase();
    const school = norm(schoolName);
    const nonSchool = stops.filter((s) => norm(s.locationName) !== school);
    if (nonSchool.length === 1) chosen = nonSchool[0];
  }

  // 3. Pickup, then first
  if (!chosen) {
    chosen = stops.find((s) => s.actionType === "Pickup") || stops[0];
  }

  const name =
    chosen.stopDescription ||
    chosen.stopAddress ||
    (chosen.stopId != null ? `Stop ${chosen.stopId}` : null);
  const addressParts = [
    chosen.stopAddress,
    [chosen.stopCity, chosen.stopState].filter(Boolean).join(", "),
    chosen.stopZip,
  ].filter(Boolean);

  return {
    stopId: chosen.stopId != null ? chosen.stopId : null,
    name,
    address: chosen.stopAddressFull || addressParts.join(" ") || null,
    lat: Number.isFinite(chosen.stopLat) ? chosen.stopLat : null,
    lng: Number.isFinite(chosen.stopLong) ? chosen.stopLong : null,
    actionType: chosen.actionType || null,
    stopTime: chosen.stopTime || null,
    stopTimeMinutes: stopTimeToMinutes(chosen.stopTime),
    etaMinutes: Number.isFinite(chosen.etaMinutes) ? chosen.etaMinutes : null,
  };
}

/**
 * Collapse a run's turn-by-turn `runDetail` into an ordered stop schedule.
 *
 * `runDetail` has one row per direction segment; many rows share a `runStopSeq`.
 * We keep one entry per runStopSeq (the stop it leads to), carrying its stopId
 * and scheduled time. `nowMinutes` (district-local) marks each stop done/upcoming.
 *
 * @returns {{stops: Array, totalStops: number}}
 */
function summarizeRunStops(run, nowMinutes) {
  const detail = (run && run.runDetail) || [];
  const bySeq = new Map();
  for (const row of detail) {
    if (row == null || row.runStopSeq == null) continue;
    if (!bySeq.has(row.runStopSeq)) {
      const mins = stopTimeToMinutes(row.stopTime);
      bySeq.set(row.runStopSeq, {
        seq: row.runStopSeq,
        stopId: row.stopId != null ? row.stopId : null,
        stopTimeMinutes: mins,
        time: formatMinutes(mins),
        done: mins != null && nowMinutes != null ? mins <= nowMinutes : null,
      });
    }
  }
  const stops = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  return { stops, totalStops: stops.length };
}

/**
 * Pick which run in runInfo[] is "current" based on the time of day.
 *
 * Strategy:
 *   1. Compute each run's window from its first/last stop times.
 *   2. Return the run whose window contains now-in-minutes.
 *   3. If no window contains now, return the next upcoming run.
 *   4. If all windows are in the past, return the most recent one.
 *   5. If there's only one run, return it.
 *
 * `nowMinutes` is minutes-since-midnight in the district's timezone — the
 * caller is responsible for computing it in the correct zone (see
 * nowMinutesInTimeZone), since stop times are district-local wall-clock times.
 */
function pickCurrentRun(runInfo, nowMinutes) {
  if (!runInfo || runInfo.length === 0) return null;
  if (runInfo.length === 1) return runInfo[0];

  const runs = runInfo.map((run) => {
    const stops = run.stopsInfo || [];
    const start = stops.length > 0 ? stopTimeToMinutes(stops[0].stopTime) : null;
    const end = stops.length > 1 ? stopTimeToMinutes(stops[stops.length - 1].stopTime) : start;
    return { run, start, end };
  });

  // Current: window contains now
  for (const { run, start, end } of runs) {
    if (start !== null && end !== null && nowMinutes >= start && nowMinutes <= end) {
      return run;
    }
  }

  // Next upcoming: earliest start after now
  const upcoming = runs
    .filter(({ start }) => start !== null && start > nowMinutes)
    .sort((a, b) => a.start - b.start);
  if (upcoming.length > 0) return upcoming[0].run;

  // Most recent past: latest end before now
  const past = runs
    .filter(({ end }) => end !== null && end <= nowMinutes)
    .sort((a, b) => b.end - a.end);
  if (past.length > 0) return past[0].run;

  return runInfo[0];
}

/**
 * Normalize a raw student object from /api/student into a simpler shape.
 */
function normalizeStudent(student, nowMinutes) {
  const { uniqueId, firstName, lastName, runInfo = [], homeAddress, locationName } = student;

  const todaysRuns = runInfo.map((run) => {
    const stops = run.stopsInfo || [];
    const windowStart = stops.length > 0 ? stopTimeToMinutes(stops[0].stopTime) : null;
    const windowEnd = stops.length > 1 ? stopTimeToMinutes(stops[stops.length - 1].stopTime) : windowStart;
    return {
      runId: run.runId,
      busNumber: run.busNumber,
      activeVehicle: run.activeVehicle,
      isSubstitute: run.activeVehicle !== run.busNumber,
      windowStart,
      windowEnd,
      stopsInfo: run.stopsInfo,
    };
  });

  const currentRunRaw = pickCurrentRun(runInfo, nowMinutes);
  const currentRun = currentRunRaw
    ? todaysRuns.find((r) => r.runId === currentRunRaw.runId) || todaysRuns[0]
    : todaysRuns[0] || null;

  // Enrich the current run with the student's own stop and the run's stop
  // schedule so the bridge can publish stop-tracking entities. Derived from the
  // *raw* current run (todaysRuns entries don't carry runDetail).
  if (currentRun && currentRunRaw) {
    const myStop = pickMyStop(currentRunRaw, homeAddress, locationName);
    // Enrich myStop with the run's route polyline + cumulative distances so the
    // publisher can compute road-following distance/ETA (falls back to haversine
    // when geometry is missing). In-memory only; not published to MQTT.
    attachRouteGeometry(currentRunRaw, myStop);
    const { stops, totalStops } = summarizeRunStops(currentRunRaw, nowMinutes);
    const myStopSeq =
      myStop && myStop.stopId != null
        ? (stops.find((s) => s.stopId === myStop.stopId) || {}).seq
        : undefined;
    currentRun.myStop = myStop;
    currentRun.stopSchedule = stops;
    currentRun.totalStops = totalStops;
    currentRun.myStopSeq = myStopSeq == null ? null : myStopSeq;
  }

  return { uniqueId: uniqueId == null ? uniqueId : String(uniqueId), firstName, lastName, currentRun, todaysRuns };
}

/**
 * Compare two Sets of strings for equality.
 */
function setsEqual(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

class StudentTracker extends EventEmitter {
  /**
   * @param {object} opts
   * @param {{ getStudents: function }} opts.api — MyRideApi instance (or compatible duck)
   * @param {number} [opts.intervalMs=900000] — poll interval (default 15 min)
   * @param {string} [opts.timeZone="America/New_York"] — IANA timezone used to
   *   evaluate "now" against district stop times. Invalid values fall back to
   *   the default.
   * @param {object} [opts.logger] — optional logger (defaults to console)
   */
  constructor({ api, intervalMs = 15 * 60 * 1000, timeZone = DEFAULT_TIME_ZONE, logger = console }) {
    super();
    this.api = api;
    this.intervalMs = intervalMs;
    this.logger = logger;
    if (isValidTimeZone(timeZone)) {
      this.timeZone = timeZone;
    } else {
      this.logger.error(
        `[Students] Invalid timezone "${timeZone}"; falling back to ${DEFAULT_TIME_ZONE}`
      );
      this.timeZone = DEFAULT_TIME_ZONE;
    }
    this.activeBuses = new Set();
    this.students = [];
    this._timer = null;
    this._running = false;
    this._polling = false;
  }

  /**
   * Start polling. Fetches immediately then on interval.
   */
  async start() {
    if (this._running) return;
    this._running = true;
    await this._poll();
    this._timer = setInterval(() => this._poll(), this.intervalMs);
  }

  /**
   * Stop polling.
   */
  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Force an immediate poll (e.g. after a token refresh).
   */
  async refresh() {
    await this._poll();
  }

  async _poll() {
    if (this._polling || !this._running) return;
    this._polling = true;
    try {
      const raw = await this.api.getStudents();
      if (!this._running) return;
      const now = new Date();
      const nowMinutes = nowMinutesInTimeZone(now, this.timeZone);

      const students = (Array.isArray(raw) ? raw : [raw]).map((s) =>
        normalizeStudent(s, nowMinutes)
      );

      const newActiveBuses = new Set(
        students.flatMap((s) => s.todaysRuns.map((r) => r.activeVehicle).filter(Boolean))
      );

      const changed = !setsEqual(newActiveBuses, this.activeBuses);
      this.students = students;
      this.activeBuses = newActiveBuses;

      const snapshot = {
        asOf: now.toISOString(),
        activeBuses: newActiveBuses,
        students,
      };

      this.emit("update", snapshot);
      if (changed) this.emit("change", snapshot);

      this.logger.log(
        `[Students] Polled ${students.length} student(s). Active buses: ${
          [...newActiveBuses].join(", ") || "(none)"
        }${changed ? " [changed]" : ""}`
      );
    } catch (err) {
      this.logger.error(`[Students] Poll failed: ${err.message}`);
      this.emit("error", err);
    } finally {
      this._polling = false;
    }
  }
}

module.exports = {
  StudentTracker,
  pickCurrentRun,
  normalizeStudent,
  stopTimeToMinutes,
  formatMinutes,
  haversineMeters,
  parseLineString,
  buildRoutePolyline,
  cumulativeMetersAlong,
  nearestVertexCumulative,
  attachRouteGeometry,
  pickMyStop,
  summarizeRunStops,
  nowMinutesInTimeZone,
  isValidTimeZone,
  DEFAULT_TIME_ZONE,
};
