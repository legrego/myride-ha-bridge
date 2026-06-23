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
  const { uniqueId, firstName, lastName, runInfo = [] } = student;

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
  nowMinutesInTimeZone,
  isValidTimeZone,
  DEFAULT_TIME_ZONE,
};
