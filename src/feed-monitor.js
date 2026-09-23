"use strict";

/**
 * feed-monitor.js — Per-bus feed health: silence detection and drop accounting.
 *
 * The bridge can't tell from its own state whether "no fixes" means the bus is
 * parked, the vehicle's AVL unit went dark, or MyRide stopped relaying. What it can
 * do is make each of those visible: how long since a bus's last accepted fix
 * (drives the `feed_live` sensor and a one-per-episode silence warning), how late
 * fixes arrive relative to their GPS time (a large lag on the first fix after a gap
 * points at the vehicle's modem re-registering), and how many fixes the
 * FixOrderGuard dropped as not-newer (a stream of frozen-timestamp fixes would
 * otherwise vanish silently at the default log level).
 *
 * Pure bookkeeping — no timers, no logging, no MQTT. The orchestrator (index.js)
 * feeds it events and a clock and decides what to log/publish, so every decision
 * here is unit-tested directly (test/feed-monitor.test.js).
 */

// How long without an accepted fix before a bus's feed counts as silent. Normal
// cadence is 15–30 s, so this is several missed fixes — long enough not to flap on
// one late fix, short enough to flag a gap well before the per-fix sensors'
// expire_after (600 s) would.
const FEED_SILENCE_MS = 120_000;
// Minimum interval between out-of-order drop summaries per bus.
const DROP_SUMMARY_INTERVAL_MS = 60_000;
// Slack around a run's stop-time window when deciding whether a silent feed is
// worth warning about: the bus is driving before the student's first own stop (an AM
// pickup is usually near the end of the route) and may run late after the last.
const WINDOW_LEAD_MINUTES = 45;
const WINDOW_TRAIL_MINUTES = 30;

class FeedMonitor {
  /**
   * @param {object} [opts]
   * @param {number} [opts.silenceMs=FEED_SILENCE_MS]
   * @param {number} [opts.dropSummaryIntervalMs=DROP_SUMMARY_INTERVAL_MS]
   */
  constructor({ silenceMs = FEED_SILENCE_MS, dropSummaryIntervalMs = DROP_SUMMARY_INTERVAL_MS } = {}) {
    this.silenceMs = silenceMs;
    this.dropSummaryIntervalMs = dropSummaryIntervalMs;
    // busId → { receivedMs, logTime } of the last accepted fix
    this._lastFix = new Map();
    // busId → ms the monitor first watched a bus that has had no fix yet, so a feed
    // that is dead from the start still registers as silent
    this._watchStartMs = new Map();
    // busIds whose current silence episode has already been warned about
    this._warned = new Set();
    // busId → { count, newestLogTime, lastAcceptedMs, lastSummaryMs }
    this._drops = new Map();
  }

  /**
   * Record an accepted fix.
   *
   * @param {string} busId
   * @param {string} logTime — the fix's GPS time (ISO)
   * @param {number} nowMs — wall-clock receipt time
   * @returns {{gapMs: number|null, lagMs: number|null, resumed: boolean}} —
   *   `gapMs` since the previous accepted fix was received; `lagMs` receipt time
   *   minus GPS time; `resumed` when the gap exceeded the silence threshold.
   */
  onAccepted(busId, logTime, nowMs) {
    const prev = this._lastFix.get(busId);
    const fixMs = Date.parse(logTime);
    const gapMs = prev ? nowMs - prev.receivedMs : null;
    this._lastFix.set(busId, { receivedMs: nowMs, logTime });
    this._watchStartMs.delete(busId);
    this._warned.delete(busId);
    return {
      gapMs,
      lagMs: Number.isFinite(fixMs) ? nowMs - fixMs : null,
      resumed: gapMs != null && gapMs > this.silenceMs,
    };
  }

  /**
   * Record a fix the FixOrderGuard dropped as not-newer. Returns a summary when one
   * is due (the first drop, then at most once per interval), else null. Drops that
   * accumulate after the last summary are surfaced by flushDrops().
   *
   * @param {string} busId
   * @param {string} logTime — the dropped fix's GPS time
   * @param {number|undefined} lastAcceptedMs — the guard's baseline for this bus
   * @param {number} nowMs
   * @returns {{busId:string, count:number, newestLogTime:string, lastAcceptedMs:number|undefined}|null}
   */
  onDropped(busId, logTime, lastAcceptedMs, nowMs) {
    const entry = this._drops.get(busId) || { count: 0, newestLogTime: null, lastAcceptedMs: undefined, lastSummaryMs: null };
    entry.count++;
    entry.newestLogTime = logTime;
    entry.lastAcceptedMs = lastAcceptedMs;
    this._drops.set(busId, entry);
    if (entry.lastSummaryMs == null || nowMs - entry.lastSummaryMs >= this.dropSummaryIntervalMs) {
      return this._takeDropSummary(busId, entry, nowMs);
    }
    return null;
  }

  /**
   * Summaries for buses with drops pending past the summary interval.
   *
   * @param {number} nowMs
   * @returns {Array<{busId:string, count:number, newestLogTime:string, lastAcceptedMs:number|undefined}>}
   */
  flushDrops(nowMs) {
    const out = [];
    for (const [busId, entry] of this._drops) {
      if (entry.count > 0 && nowMs - entry.lastSummaryMs >= this.dropSummaryIntervalMs) {
        out.push(this._takeDropSummary(busId, entry, nowMs));
      }
    }
    return out;
  }

  _takeDropSummary(busId, entry, nowMs) {
    const summary = {
      busId,
      count: entry.count,
      newestLogTime: entry.newestLogTime,
      lastAcceptedMs: entry.lastAcceptedMs,
    };
    entry.count = 0;
    entry.lastSummaryMs = nowMs;
    return summary;
  }

  /**
   * Silence state of a bus's feed. A bus with no fix yet is measured from the first
   * time it was checked.
   *
   * @param {string} busId
   * @param {number} nowMs
   * @returns {{silent: boolean, silentMs: number, lastLogTime: string|null, warned: boolean}}
   */
  silence(busId, nowMs) {
    const last = this._lastFix.get(busId);
    let sinceMs;
    if (last) {
      sinceMs = last.receivedMs;
    } else {
      if (!this._watchStartMs.has(busId)) this._watchStartMs.set(busId, nowMs);
      sinceMs = this._watchStartMs.get(busId);
    }
    const silentMs = nowMs - sinceMs;
    return {
      silent: silentMs > this.silenceMs,
      silentMs,
      lastLogTime: last ? last.logTime : null,
      warned: this._warned.has(busId),
    };
  }

  /** Mark the current silence episode of a bus as warned (cleared by the next fix). */
  markWarned(busId) {
    this._warned.add(busId);
  }
}

/**
 * Whether "now" falls inside a run's stop-time window, widened by the lead/trail
 * slack — i.e. whether the bus should be driving and a silent feed is a problem.
 *
 * @param {{windowStart:number|null, windowEnd:number|null}|null} run — minutes since
 *   midnight, district-local (normalized currentRun)
 * @param {number|null} nowMinutes — district-local minutes since midnight
 * @returns {boolean}
 */
function inRunWindow(run, nowMinutes) {
  if (!run || !Number.isFinite(nowMinutes)) return false;
  const { windowStart, windowEnd } = run;
  if (!Number.isFinite(windowStart)) return false;
  const end = Number.isFinite(windowEnd) ? windowEnd : windowStart;
  return nowMinutes >= windowStart - WINDOW_LEAD_MINUTES && nowMinutes <= end + WINDOW_TRAIL_MINUTES;
}

module.exports = {
  FeedMonitor,
  inRunWindow,
  FEED_SILENCE_MS,
  DROP_SUMMARY_INTERVAL_MS,
};
