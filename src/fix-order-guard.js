"use strict";

/**
 * fix-order-guard.js — Per-bus monotonic ordering guard for SignalR fixes.
 *
 * SignalR replays superseded `NewLocation` events (observed live: a fix's logTime
 * alternating with an older one over ~16 s). A replayed, out-of-order fix rewinds
 * the bus's route position and makes distance/eta/stops_away bounce and `moving`
 * flap. This guard drops any fix whose `logTime` is not strictly newer than the
 * last one it accepted for that bus.
 *
 * `logTime` is the vehicle's GPS fix time and is monotonic per bus across
 * reconnects and runs, so the accepted-time map never needs resetting. Fixes with
 * an unparseable `logTime` are always accepted (we can't order what we can't
 * parse) and leave the baseline untouched.
 */
class FixOrderGuard {
  constructor() {
    // busId → last accepted fix time (ms since epoch)
    this._lastMsByBus = new Map();
  }

  /**
   * Decide whether a fix should be processed, updating the per-bus baseline when it
   * is accepted.
   *
   * @param {string} busId — the bus's assetUniqueId
   * @param {string} logTime — ISO fix time from the NewLocation payload
   * @returns {boolean} true to process the fix; false to drop it as out-of-order
   */
  accept(busId, logTime) {
    const fixMs = Date.parse(logTime);
    if (!Number.isFinite(fixMs)) return true; // can't compare → let it through
    const lastMs = this._lastMsByBus.get(busId);
    if (lastMs != null && fixMs <= lastMs) return false; // stale/duplicate → drop
    this._lastMsByBus.set(busId, fixMs);
    return true;
  }

  /**
   * Last accepted fix time (ms) for a bus, or undefined if none yet. Exposed for
   * diagnostics/logging.
   *
   * @param {string} busId
   * @returns {number|undefined}
   */
  lastAcceptedMs(busId) {
    return this._lastMsByBus.get(busId);
  }
}

module.exports = { FixOrderGuard };
