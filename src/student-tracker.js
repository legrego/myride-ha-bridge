"use strict";

const { EventEmitter } = require("events");

/**
 * Parse a stopTime string like "1900-01-01T09:02:22.99" into minutes-since-midnight.
 * The date portion is always a placeholder; only the time part matters.
 */
function stopTimeToMinutes(stopTime) {
  if (!stopTime) return null;
  const parts = stopTime.split("T");
  if (parts.length < 2) return null;
  const [h, m] = parts[1].split(":");
  return parseInt(h, 10) * 60 + parseInt(m, 10);
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
 * NOTE: stop times are local to the district; we use system local time (TODO: district TZ).
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

  return { uniqueId: String(uniqueId), firstName, lastName, currentRun, todaysRuns };
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
   * @param {object} [opts.logger] — optional logger (defaults to console)
   */
  constructor({ api, intervalMs = 15 * 60 * 1000, logger = console }) {
    super();
    this.api = api;
    this.intervalMs = intervalMs;
    this.logger = logger;
    this.activeBuses = new Set();
    this.students = [];
    this._timer = null;
    this._running = false;
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
    try {
      const raw = await this.api.getStudents();
      const now = new Date();
      const nowMinutes = now.getHours() * 60 + now.getMinutes();

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
    }
  }
}

module.exports = { StudentTracker, pickCurrentRun, normalizeStudent, stopTimeToMinutes };
