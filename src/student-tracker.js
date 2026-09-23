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

const pad2 = (n) => String(n).padStart(2, "0");

/**
 * Signed minutes east of UTC for `date` observed in `timeZone` (e.g. −240 for
 * US Eastern in summer). Computed by re-reading the instant's wall-clock parts in
 * the zone and differencing against UTC — robust across Node/ICU builds, unlike
 * parsing a formatted "GMT−04:00" string.
 */
function timeZoneOffsetMinutes(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value])
  );
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    parts.hour === "24" ? 0 : Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return Math.round((asUTC - date.getTime()) / 60000);
}

/**
 * Build an ISO-8601 timestamp *with offset* for a district-local wall-clock time
 * on the day of `nowMs`, suitable for a Home Assistant `timestamp` sensor.
 *
 * `totalMinutes` is minutes-since-midnight (may be negative or ≥1440; the day rolls
 * accordingly). The date is taken from `nowMs` as observed in `timeZone`, and the
 * zone's offset at that instant is applied (DST-correct via timeZoneOffsetMinutes).
 * Seconds are zeroed so the value only changes on the minute — HA renders a stable
 * "in N minutes" and the recorder isn't flooded. Returns null on invalid input.
 *
 * @param {number} nowMs — reference instant (ms) whose local date anchors the day
 * @param {number} totalMinutes — target wall-clock minutes-since-midnight
 * @param {string} timeZone — district IANA zone
 * @returns {string|null} e.g. "2026-09-15T15:53:00-04:00"
 */
function districtLocalTimestamp(nowMs, totalMinutes, timeZone) {
  if (!Number.isFinite(nowMs) || !Number.isFinite(totalMinutes)) return null;
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const now = new Date(nowMs);
  const d = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  const dayOffset = Math.floor(totalMinutes / 1440);
  const mins = ((totalMinutes % 1440) + 1440) % 1440;
  const base = new Date(Date.UTC(Number(d.year), Number(d.month) - 1, Number(d.day)));
  base.setUTCDate(base.getUTCDate() + dayOffset);
  const off = timeZoneOffsetMinutes(now, zone);
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  return (
    `${base.getUTCFullYear()}-${pad2(base.getUTCMonth() + 1)}-${pad2(base.getUTCDate())}` +
    `T${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}:00` +
    `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
  );
}

/**
 * District-local calendar date ("YYYY-MM-DD") of the instant `date`, observed in
 * `timeZone`. Used to scope per-run state to a single service day so it can't bleed
 * into the next day when a stable assignment reuses the same run/stop identity.
 * Falls back to the default zone for an invalid `timeZone`; returns null for a
 * non-finite/invalid date.
 *
 * @param {Date|number} date — instant (Date or ms)
 * @param {string} [timeZone] — district IANA zone
 * @returns {string|null} e.g. "2026-09-18"
 */
function districtLocalDate(date, timeZone = DEFAULT_TIME_ZONE) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const zone = isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value])
  );
  if (!parts.year || !parts.month || !parts.day) return null;
  return `${parts.year}-${parts.month}-${parts.day}`;
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

// Max distance (m) the student's stop pin may sit from its nearest route vertex
// for the route geometry to be trusted for that stop. Beyond this the geometry is
// partial/wrong, so we skip route mode and fall back to haversine. Mirrors the
// live bus's ROUTE_SNAP_MAX_METERS trust radius in mqtt-bridge.js.
const STOP_SNAP_MAX_METERS = 150;

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
 * single [lat, lng] polyline in travel order, and record where each `runStopSeq`
 * ends along that polyline.
 *
 * `runDetail` is already ordered in travel order (ascending runStopSeq, then
 * directionSeq), so we walk it as-is, dropping the duplicate vertex where one
 * segment's end coincides with the next segment's start. Each direction segment
 * drives *toward* its stop, so the last vertex contributed while in a given
 * `runStopSeq` is that stop's position along the route — captured in `seqEnds`
 * (one `{ seq, index }` per seq, `index` into `polyline`). Rows with
 * missing/unparseable geometry are skipped.
 *
 * @param {Array} runDetail
 * @returns {{polyline: Array<[number, number]>, seqEnds: Array<{seq:number,index:number}>}}
 */
function buildRoutePolylineWithSeq(runDetail) {
  const detail = Array.isArray(runDetail) ? runDetail : [];
  const polyline = [];
  const seqEnds = [];
  for (const row of detail) {
    if (!row) continue;
    const seg = parseLineString(row.directionGeomLine);
    if (!seg) continue;
    for (const pt of seg) {
      const last = polyline[polyline.length - 1];
      if (last && last[0] === pt[0] && last[1] === pt[1]) continue; // drop join dup
      polyline.push(pt);
    }
    if (row.runStopSeq != null && polyline.length > 0) {
      const index = polyline.length - 1;
      const existing = seqEnds.find((e) => e.seq === row.runStopSeq);
      if (existing) existing.index = index; // extend to this seq's latest vertex
      else seqEnds.push({ seq: row.runStopSeq, index });
    }
  }
  return { polyline, seqEnds };
}

/**
 * Concatenate a run's route into a single [lat, lng] polyline (see
 * buildRoutePolylineWithSeq). Returns [] when no geometry is present.
 *
 * @param {Array} runDetail
 * @returns {Array<[number, number]>}
 */
function buildRoutePolyline(runDetail) {
  return buildRoutePolylineWithSeq(runDetail).polyline;
}

/**
 * Interpolate the scheduled district-local time (minutes-since-midnight) at a
 * given cumulative route distance, from a sorted list of schedule checkpoints.
 *
 * Each checkpoint is `{ cum, sched }` — a stop's cumulative meters from the run
 * start and its scheduled time. Between checkpoints the scheduled time is linearly
 * interpolated; outside the range it is clamped to the first/last checkpoint (so a
 * bus before the first checkpoint or past the last reads that endpoint's time
 * rather than an extrapolation). Returns null when there are no checkpoints or the
 * position isn't finite.
 *
 * @param {number} cum — cumulative meters from the run start
 * @param {Array<{cum:number, sched:number}>} checkpoints — sorted ascending by cum
 * @returns {number|null} scheduled minutes-since-midnight (may be fractional)
 */
function scheduledMinutesAt(cum, checkpoints) {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return null;
  if (!Number.isFinite(cum)) return null;
  if (cum <= checkpoints[0].cum) return checkpoints[0].sched;
  const last = checkpoints[checkpoints.length - 1];
  if (cum >= last.cum) return last.sched;
  for (let i = 1; i < checkpoints.length; i++) {
    const a = checkpoints[i - 1];
    const b = checkpoints[i];
    if (cum <= b.cum) {
      const span = b.cum - a.cum;
      if (span <= 0) return a.sched; // coincident checkpoints — avoid /0
      const t = (cum - a.cum) / span;
      return a.sched + t * (b.sched - a.sched);
    }
  }
  return last.sched;
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
 * Initial compass bearing (degrees, 0 = north, clockwise) from point 1 to point 2.
 *
 * @returns {number|null} bearing in [0, 360), or null for non-finite input
 */
function bearingDegrees(lat1, lng1, lat2, lng2) {
  if (![lat1, lng1, lat2, lng2].every(Number.isFinite)) return null;
  const toRad = (d) => (d * Math.PI) / 180;
  const φ1 = toRad(lat1);
  const φ2 = toRad(lat2);
  const Δλ = toRad(lng2 - lng1);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** Smallest absolute difference between two compass bearings, in [0, 180]. */
function bearingDiffDegrees(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Snap a point to every **pass** of the route that comes within `maxDistMeters`.
 *
 * A run's polyline can revisit the same street (loops, U-turns, out-and-back
 * spurs), so a single global nearest vertex is ambiguous there: two passes sit a
 * few meters apart and whichever vertex happens to be marginally closer wins. This
 * returns one candidate per pass instead, so the caller can pick the right one.
 *
 * A "pass" is a maximal run of consecutive vertices within `maxDistMeters` of the
 * point. Within a pass the candidate is the nearest vertex — or, when `headingDeg`
 * is given, the nearest vertex whose adjacent segment's travel bearing is within
 * `headingToleranceDeg` of it (so a U-turn, where the outbound and return legs form
 * one contiguous pass, still resolves to the leg the bus is on). The polyline is in
 * travel order, so segment bearing is the direction a bus on that pass is driving.
 *
 * @param {number} lat
 * @param {number} lng
 * @param {Array<[number, number]>} polyline
 * @param {number[]} cumulative — from cumulativeMetersAlong(polyline)
 * @param {number} maxDistMeters — trust radius for a vertex to count as "on" a pass
 * @param {object} [opts]
 * @param {number|null} [opts.headingDeg] — bus heading; omit/null when unusable
 *   (e.g. a stopped bus reports a stale heading)
 * @param {number} [opts.headingToleranceDeg=60]
 * @returns {{candidates: Array<{cumulativeMeters:number, distMeters:number, headingOk:boolean|null}>,
 *   nearestDistMeters: number}|null} — candidates in travel order (ascending cum);
 *   `headingOk` is null when no heading was given. `nearestDistMeters` is the global
 *   nearest vertex distance (for off-route diagnostics when there are no candidates).
 *   null for empty/invalid input.
 */
function routePassCandidates(lat, lng, polyline, cumulative, maxDistMeters, opts = {}) {
  if (!Array.isArray(polyline) || polyline.length === 0) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const heading = Number.isFinite(opts.headingDeg) ? opts.headingDeg : null;
  const tolerance = Number.isFinite(opts.headingToleranceDeg) ? opts.headingToleranceDeg : 60;

  // Travel bearing matches the heading on either segment touching vertex i (a
  // vertex at a corner belongs to both the leg into it and the leg out of it).
  const headingMatches = (i) => {
    for (const [a, b] of [[i - 1, i], [i, i + 1]]) {
      if (a < 0 || b >= polyline.length) continue;
      const brg = bearingDegrees(polyline[a][0], polyline[a][1], polyline[b][0], polyline[b][1]);
      if (brg != null && bearingDiffDegrees(brg, heading) <= tolerance) return true;
    }
    return false;
  };

  const candidates = [];
  let nearestDist = Infinity;
  let group = null; // { best, bestMatching } for the pass currently being scanned
  const closeGroup = () => {
    if (!group) return;
    const pick = group.bestMatching || group.best;
    candidates.push({
      cumulativeMeters: cumulative[pick.i],
      distMeters: pick.d,
      headingOk: heading == null ? null : group.bestMatching != null,
    });
    group = null;
  };
  for (let i = 0; i < polyline.length; i++) {
    const d = haversineMeters(lat, lng, polyline[i][0], polyline[i][1]);
    if (d == null || !Number.isFinite(cumulative[i])) {
      closeGroup();
      continue;
    }
    if (d < nearestDist) nearestDist = d;
    if (d > maxDistMeters) {
      closeGroup();
      continue;
    }
    if (!group) group = { best: null, bestMatching: null };
    if (!group.best || d < group.best.d) group.best = { i, d };
    if (heading != null && headingMatches(i) && (!group.bestMatching || d < group.bestMatching.d)) {
      group.bestMatching = { i, d };
    }
  }
  closeGroup();
  if (!Number.isFinite(nearestDist)) return null;
  return { candidates, nearestDistMeters: nearestDist };
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
 * geometry is missing/unparseable, the stop lacks coordinates, or the stop pin
 * doesn't sit on this geometry (snap beyond STOP_SNAP_MAX_METERS — a sign of
 * partial/wrong route data), the fields are left unset and the publisher falls
 * back to haversine.
 *
 * @param {object} run — raw run carrying `runDetail`
 * @param {object|null} myStop — normalized stop (mutated in place)
 */
function attachRouteGeometry(run, myStop) {
  if (!myStop || !Number.isFinite(myStop.lat) || !Number.isFinite(myStop.lng)) return;
  const { polyline, seqEnds } = buildRoutePolylineWithSeq(run && run.runDetail);
  if (polyline.length < 2) return; // need at least one leg for cumulative distance
  const cumulative = cumulativeMetersAlong(polyline);
  const stopSnap = nearestVertexCumulative(myStop.lat, myStop.lng, polyline, cumulative);
  // The stop pin is authoritative and lies on the run, so its nearest route vertex
  // should be close. A far snap means the geometry is partial/wrong for this stop —
  // don't enable route mode (which could report zero or omit a long final leg);
  // leave the fields unset so the publisher uses haversine. Mirrors the live bus's
  // ROUTE_SNAP_MAX_METERS trust radius in mqtt-bridge.js.
  if (!stopSnap || stopSnap.distMeters > STOP_SNAP_MAX_METERS) return;
  myStop.routePolyline = polyline;
  myStop.cumulativeMeters = cumulative;
  myStop.cumulativeAtStopMeters = stopSnap.cumulativeMeters;
  // Schedule checkpoints: (cumulative meters, scheduled minutes, seq) for each stop
  // the run passes, so the publisher can interpolate "where the bus should be by now"
  // and derive a schedule-anchored delay/predicted-arrival (see mqtt-bridge.js).
  // Cumulative comes from where each runStopSeq ends along the route; the scheduled
  // time from that seq's stopTime. Kept in memory on myStop; never published.
  const checkpoints = buildScheduleCheckpoints(run && run.runDetail, seqEnds, cumulative);
  myStop.scheduleCheckpoints = checkpoints;

  // Route positions of the stops *before* the student's own stop, in travel order,
  // so the publisher can derive a GPS-truthful "stops away" (count of these still
  // ahead of the live bus). Derived from the route geometry (seqEnds) directly, NOT
  // from scheduleCheckpoints: checkpoints drop any stop lacking a scheduled stopTime
  // (and collapse coincident-cum stops), which would silently undercount physical
  // stops. seqEnds is in travel order, so the stops before the student's own are the
  // ones preceding it. Left unset when the student's stop isn't in the geometry
  // (→ publisher reports unknown rather than a wrong count). In memory only.
  const mySeq = stopIdToSeqMap(run && run.runDetail).get(myStop.stopId);
  const myEndIdx = mySeq == null ? -1 : seqEnds.findIndex((e) => e.seq === mySeq);
  if (myEndIdx >= 0) {
    myStop.upstreamStopCums = seqEnds.slice(0, myEndIdx).map((e) => cumulative[e.index]);
  }
}

/**
 * Build the ordered schedule checkpoints used for schedule-anchored ETA.
 *
 * For each `runStopSeq` that has both a known route position (its end vertex, from
 * buildRoutePolylineWithSeq) and a scheduled `stopTime`, emit `{ cum, sched }` —
 * cumulative meters from the run start and scheduled minutes-since-midnight. The
 * result is sorted ascending by `cum` and deduped so scheduledMinutesAt() can
 * interpolate over it.
 *
 * @param {Array} runDetail
 * @param {Array<{seq:number,index:number}>} seqEnds — per-seq end vertex indices
 * @param {number[]} cumulative — per-vertex cumulative distance (from the polyline)
 * @returns {Array<{cum:number, sched:number}>}
 */
function buildScheduleCheckpoints(runDetail, seqEnds, cumulative) {
  const detail = Array.isArray(runDetail) ? runDetail : [];
  // First scheduled time seen for each seq (all rows of a seq share the stopTime).
  const schedBySeq = new Map();
  for (const row of detail) {
    if (row && row.runStopSeq != null && !schedBySeq.has(row.runStopSeq)) {
      schedBySeq.set(row.runStopSeq, stopTimeToMinutes(row.stopTime));
    }
  }
  const points = [];
  for (const { seq, index } of seqEnds || []) {
    const sched = schedBySeq.get(seq);
    const cum = cumulative[index];
    if (Number.isFinite(sched) && Number.isFinite(cum)) points.push({ cum, sched, seq });
  }
  points.sort((a, b) => a.cum - b.cum);
  // Drop exact-cum duplicates (keep the first), which would make interpolation
  // ambiguous at that position.
  const deduped = [];
  for (const p of points) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.cum === p.cum) continue;
    deduped.push(p);
  }
  return deduped;
}

/**
 * Map each stopId in `runDetail` to its `runStopSeq` (first occurrence wins;
 * all rows of a seq share the same stop).
 */
function stopIdToSeqMap(runDetail) {
  const map = new Map();
  for (const row of Array.isArray(runDetail) ? runDetail : []) {
    if (row && row.stopId != null && row.runStopSeq != null && !map.has(row.stopId)) {
      map.set(row.stopId, row.runStopSeq);
    }
  }
  return map;
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
 * Grace window (minutes) after a run's *scheduled* last stop during which that run
 * is still considered current, so a late-running bus keeps its own run's geometry
 * instead of flipping to the next upcoming run the instant the schedule window
 * closes.
 *
 * Why this exists: a run's window is `[firstStopTime, lastStopTime]` from the
 * student's own stops (schedule-based). A bus running behind schedule is still
 * physically on that run *after* its last scheduled stop time — but with a bare
 * window check "now" then falls between windows and pickCurrentRun would return the
 * NEXT run (e.g. the PM dropoff during a late AM pickup). The still-live AM bus fix
 * then gets snapped against PM route geometry, producing confidently-wrong
 * delay/stops_away/distance (observed: a −395 min delay implying a ~15:47 next stop
 * during a 09:xx AM run). The grace keeps the current run selected long enough to
 * cover realistic lateness before deferring to the next run.
 *
 * 30 min comfortably covers observed lateness (~10 min) while staying far short of
 * the multi-hour gap between AM and PM runs, so it can never bleed into the next
 * window. It does not *know* the bus is late (pickCurrentRun stays a pure function
 * of the schedule); the per-fix sanity guards in MqttBridge backstop the residual
 * case of a bus later than the grace.
 */
const RUN_LATE_GRACE_MINUTES = 30;

/**
 * Pick which run in runInfo[] is "current" based on the time of day.
 *
 * Strategy:
 *   1. Compute each run's window from its first/last stop times.
 *   2. Return the run whose window contains now-in-minutes.
 *   3. If no window contains now but a run's window ended within
 *      RUN_LATE_GRACE_MINUTES, return that (most-recently-ended) run — a late bus
 *      is still on it.
 *   4. Otherwise return the next upcoming run.
 *   5. If all windows are in the past, return the most recent one.
 *   6. If there's only one run, return it.
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

  // Recently-ended (late bus): window closed within the grace period. Prefer the
  // most-recently-ended such run over the next upcoming one, so a bus finishing its
  // run behind schedule keeps its own route geometry rather than adopting the next
  // run's (which snaps the live bus against the wrong route). Bounded by
  // RUN_LATE_GRACE_MINUTES so it never reaches into a genuinely later run.
  const graceEligible = runs
    .filter(({ end }) => end !== null && nowMinutes > end && nowMinutes <= end + RUN_LATE_GRACE_MINUTES)
    .sort((a, b) => b.end - a.end);
  if (graceEligible.length > 0) return graceEligible[0].run;

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
    // Stamp the run's identity + schedule window onto myStop (in-memory only, never
    // published) so MqttBridge can log *which* run's geometry it is snapping the live
    // bus against. This is what makes an AM-vs-PM route mismatch visible in the logs:
    // the per-fix route diagnostics key on the student id alone, which is identical
    // for both runs.
    if (myStop) {
      myStop.runContext = {
        runId: currentRun.runId,
        busNumber: currentRun.activeVehicle || currentRun.busNumber,
        totalStops,
        // The run's *selection* window — the stopsInfo-derived [windowStart, windowEnd]
        // that pickCurrentRun compares "now" against — NOT the full runDetail span. The
        // diagnostic exists to correlate a route snap with the run whose window expiry
        // (+grace) selected it, so it must log that same window.
        windowStart: formatMinutes(currentRun.windowStart),
        windowEnd: formatMinutes(currentRun.windowEnd),
      };
    }
    // Scheduled arrival at the student's own stop, as a district-local "HH:MM"
    // wall-clock string (null when unknown). Published as a first-class sensor so
    // a dashboard can show "scheduled 15:32" alongside the live ETA.
    currentRun.scheduledTime = myStop ? formatMinutes(myStop.stopTimeMinutes) : null;
    // "Stops away" is derived live from the bus's route position (myStop.upstreamStopCums,
    // attached above), not the schedule clock — see MqttBridge._publishStopsAway().
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
  buildRoutePolylineWithSeq,
  buildScheduleCheckpoints,
  scheduledMinutesAt,
  cumulativeMetersAlong,
  nearestVertexCumulative,
  routePassCandidates,
  bearingDegrees,
  bearingDiffDegrees,
  attachRouteGeometry,
  pickMyStop,
  summarizeRunStops,
  stopIdToSeqMap,
  nowMinutesInTimeZone,
  timeZoneOffsetMinutes,
  districtLocalTimestamp,
  districtLocalDate,
  isValidTimeZone,
  DEFAULT_TIME_ZONE,
  RUN_LATE_GRACE_MINUTES,
};
