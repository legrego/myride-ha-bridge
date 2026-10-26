"use strict";

/**
 * stream-supervisor.js — Decide when the LiveVehicleHub connection must be rebuilt.
 *
 * The bridge never subscribes to anything: MyRide decides which buses a SignalR
 * connection receives *when the connection is made*, from the account's runs that
 * day. Observed behaviour (2026-10-23 → 10-26):
 *   - A connection made on a day with runs receives its bus. While tracked, MyRide
 *     re-sends the latest fix about every 5 s even when the bus is parked (the
 *     FixOrderGuard drops these as not-newer), plus real fixes every 15–30 s.
 *   - A connection made on a day with NO runs is sent `errorcode`/`error` server
 *     calls, then stays open with healthy keepalives and receives zero frames,
 *     indefinitely. Nothing re-adds the bus when runs return.
 *   - A tracked connection can also silently lose its bus (seen ~1 h into a no-run
 *     day) without being closed.
 * Before this module the only recovery was MyRide happening to close the socket
 * (WebSocket 1006) between the overnight roster change and the AM run.
 *
 * Rules (each returns a reconnect Decision for index.js to act on):
 *   R1 runs-changed — the watched bus set gained a bus (none → some, or a substitute
 *      appearing). An identical set (the AM → PM switch on the same bus) or a shrink
 *      does not reconnect. Suppressed within MIN_RECONNECT_GAP_MS of a connect. A
 *      roster change stays pending until a connection whose start() began after it
 *      has connected, and check() re-issues it — so a change that arrives while
 *      another (re)connect is already in flight, or inside the suppression window,
 *      is retried rather than lost (frames from the other watched buses would
 *      otherwise keep R2 satisfied while the new bus never streams).
 *   R2 watchdog — the watched set is non-empty and no watched-bus frame (accepted or
 *      dropped — the 5 s repeats are the liveness signal) has arrived for silenceMs
 *      since max(last watched frame, connect). Backed off per silent episode.
 *   R3 server-error — the server called `errorcode`/`error` while buses are watched.
 *      Shares R2's backoff so a server that keeps refusing can't cause a loop.
 *      Ignored before the first connect: SignalR dispatches invocations that arrive
 *      with the handshake before start() resolves, and restarting the startup
 *      connection there would reject the initial start() (R2 covers it afterwards).
 *
 * Pure bookkeeping — no timers, no logging, no MQTT, no SignalR. The orchestrator
 * (index.js) feeds it events and a clock and performs the actions it returns, so
 * every decision here is unit-tested directly (test/stream-supervisor.test.js).
 */

// How long a watched set may go without a single frame before the connection is
// presumed untracked. Tracked connections see a frame at least every ~5 s, so this
// is generous; it stays well clear of a reconnect storm on a brief upstream hiccup.
const STREAM_SILENCE_MS = 300_000;
// Gap required before watchdog/server-error attempt n of a silent episode (measured
// from the previous attempt); the last entry repeats. Caps a genuine upstream outage
// (bus GPS dark) at one cheap reconnect per 15 min.
const WATCHDOG_BACKOFF_MS = [0, 300_000, 600_000, 900_000];
// R1 is suppressed this soon after a connect, to absorb roster-poll jitter: a
// connection that young was made with the new runs already in place.
const MIN_RECONNECT_GAP_MS = 30_000;

const BACKOFF_REASONS = new Set(["watchdog", "server-error"]);

/**
 * @typedef {object} Decision
 * @property {true} reconnect
 * @property {"runs-changed"|"watchdog"|"server-error"} reason
 * @property {object} detail — reason-specific context for logging
 */

class StreamSupervisor {
  /**
   * @param {object} [opts]
   * @param {number} [opts.silenceMs=STREAM_SILENCE_MS]
   * @param {number[]} [opts.backoffMs=WATCHDOG_BACKOFF_MS]
   * @param {number} [opts.minReconnectGapMs=MIN_RECONNECT_GAP_MS]
   */
  constructor({
    silenceMs = STREAM_SILENCE_MS,
    backoffMs = WATCHDOG_BACKOFF_MS,
    minReconnectGapMs = MIN_RECONNECT_GAP_MS,
  } = {}) {
    this.silenceMs = silenceMs;
    this.backoffMs = backoffMs;
    this.minReconnectGapMs = minReconnectGapMs;
    this._watched = new Set();
    this._connectedSinceMs = null;
    this._connectionReason = null;
    // When the in-progress connect attempt began, and when the current connection's
    // attempt began — a connection only reflects roster changes from before that.
    this._attemptStartedMs = null;
    this._connectionStartedMs = null;
    // Time of the latest roster change (watched set gained a bus) not yet covered
    // by a connection started after it; null when none is pending. The latest, not
    // the oldest: a connection that started between two additions covers only the
    // first, and must not clear the pending change for the second.
    this._rosterChangeMs = null;
    this._lastWatchedFrameMs = null;
    this._reconnects = 0;
    this._lastReconnectReason = null;
    this._lastReconnectMs = null;
    this._lastServerError = null;
    // Backoff state of the current silent episode: attempts made, and when the
    // last one started. Reset by a watched frame (the episode is over).
    this._attempts = 0;
    this._lastAttemptMs = null;
  }

  /**
   * A connection finished start(). Resets the silence baseline so a fresh
   * connection always gets a full silence window.
   *
   * @param {number} nowMs
   * @param {string} reason — "startup" | "closed" | "runs-changed" | "watchdog" |
   *   "server-error" | "token"; every reason but "startup" counts as a reconnect
   */
  onConnected(nowMs, reason) {
    this._connectedSinceMs = nowMs;
    this._connectionReason = reason;
    this._connectionStartedMs = this._attemptStartedMs ?? nowMs;
    this._attemptStartedMs = null;
    if (this._rosterChangeMs != null && this._connectionStartedMs >= this._rosterChangeMs) {
      this._rosterChangeMs = null;
    }
    if (reason !== "startup") {
      this._reconnects++;
      this._lastReconnectReason = reason;
      this._lastReconnectMs = nowMs;
    }
  }

  /**
   * A connect attempt is about to call start() (every attempt, including startup
   * and each retry of a backoff loop). Lets onConnected tell whether the resulting
   * connection was made before or after a roster change.
   *
   * @param {number} nowMs
   */
  onConnectStarted(nowMs) {
    this._attemptStartedMs = nowMs;
  }

  /**
   * A NewLocation frame arrived, whether FixOrderGuard accepts or drops it. Frames
   * for buses outside the watched set are ignored.
   *
   * @param {string} busId
   * @param {number} nowMs
   * @returns {boolean} whether the frame was for a watched bus
   */
  onFrame(busId, nowMs) {
    if (!this._watched.has(busId)) return false;
    this._lastWatchedFrameMs = nowMs;
    this._resetBackoff();
    return true;
  }

  /**
   * The server invoked `errorcode` or `error` (R3).
   *
   * @param {string} method
   * @param {Array} args — raw invocation arguments
   * @param {number} nowMs
   * @returns {Decision|null}
   */
  onServerError(method, args, nowMs) {
    this._lastServerError = { method, args, atMs: nowMs };
    if (this._watched.size === 0) return null; // R1 reconnects once runs appear
    if (this._connectedSinceMs == null) return null; // startup still in progress
    if (!this._backoffAllows(nowMs)) return null;
    return { reconnect: true, reason: "server-error", detail: { method, ...this._attemptDetail() } };
  }

  /**
   * The buses this bridge should be receiving — those some student's current run
   * rides (R1). Call on every student poll.
   *
   * @param {Iterable<string>} busIds
   * @param {number} nowMs
   * @returns {Decision|null}
   */
  setWatchedBuses(busIds, nowMs) {
    const prev = this._watched;
    const next = new Set(busIds);
    this._watched = next;
    if (next.size === 0) {
      // Nothing to supervise; a later silent episode starts from scratch.
      this._resetBackoff();
      this._rosterChangeMs = null;
      return null;
    }
    const added = [...next].filter((b) => !prev.has(b));
    if (added.length === 0) return null;
    this._rosterChangeMs = nowMs;
    const pending = this._pendingRunsChanged(nowMs);
    return pending && { ...pending, detail: { ...pending.detail, previous: [...prev], added } };
  }

  // R1 decision for a pending roster change, or null when none is pending, there is
  // no connection yet (the upcoming connect picks the new runs up by itself), or the
  // current connection is younger than MIN_RECONNECT_GAP_MS.
  _pendingRunsChanged(nowMs) {
    if (this._rosterChangeMs == null || this._connectedSinceMs == null) return null;
    if (nowMs - this._connectedSinceMs < this.minReconnectGapMs) return null;
    return {
      reconnect: true,
      reason: "runs-changed",
      detail: { next: [...this._watched], changedAtMs: this._rosterChangeMs },
    };
  }

  /**
   * Periodic check: a still-pending roster change (R1, retried), else a silent
   * stream (R2).
   *
   * @param {number} nowMs
   * @returns {Decision|null}
   */
  check(nowMs) {
    if (this._watched.size === 0 || this._connectedSinceMs == null) return null;
    const pending = this._pendingRunsChanged(nowMs);
    if (pending) return pending;
    const silentMs = nowMs - this._baselineMs();
    if (silentMs <= this.silenceMs) return null;
    if (!this._backoffAllows(nowMs)) return null;
    return {
      reconnect: true,
      reason: "watchdog",
      detail: { buses: [...this._watched], silentMs, ...this._attemptDetail() },
    };
  }

  /**
   * index.js is actually starting a supervisor-initiated reconnect; advances the
   * backoff for the reasons subject to it (watchdog, server-error).
   *
   * @param {string} reason
   * @param {number} nowMs
   */
  onReconnectStarted(reason, nowMs) {
    if (!BACKOFF_REASONS.has(reason)) return;
    this._attempts++;
    this._lastAttemptMs = nowMs;
  }

  /**
   * Snapshot for MQTT and GET /status.
   *
   * @param {number} nowMs
   * @returns {{expected:boolean, live:boolean, lastWatchedFrameMs:number|null,
   *   connectedSinceMs:number|null, connectionReason:string|null, reconnects:number,
   *   lastReconnectReason:string|null, lastReconnectMs:number|null,
   *   watchedBuses:string[], lastServerError:{method:string, args:Array, atMs:number}|null}}
   */
  status(nowMs) {
    const expected = this._watched.size > 0;
    const baseline = this._baselineMs();
    return {
      expected,
      live: expected && baseline != null && nowMs - baseline <= this.silenceMs,
      lastWatchedFrameMs: this._lastWatchedFrameMs,
      connectedSinceMs: this._connectedSinceMs,
      connectionReason: this._connectionReason,
      reconnects: this._reconnects,
      lastReconnectReason: this._lastReconnectReason,
      lastReconnectMs: this._lastReconnectMs,
      watchedBuses: [...this._watched],
      lastServerError: this._lastServerError,
    };
  }

  // Most recent of the last watched frame and the connect time (null if neither).
  _baselineMs() {
    const a = this._lastWatchedFrameMs;
    const b = this._connectedSinceMs;
    if (a == null) return b;
    if (b == null) return a;
    return Math.max(a, b);
  }

  _gapBeforeAttempt(n) {
    return this.backoffMs[Math.min(n, this.backoffMs.length - 1)];
  }

  _backoffAllows(nowMs) {
    if (this._lastAttemptMs == null) return true;
    return nowMs - this._lastAttemptMs >= this._gapBeforeAttempt(this._attempts);
  }

  // 1-based number of the attempt a decision proposes, and the gap that will be
  // required after it.
  _attemptDetail() {
    return { attempt: this._attempts + 1, nextAllowedInMs: this._gapBeforeAttempt(this._attempts + 1) };
  }

  _resetBackoff() {
    this._attempts = 0;
    this._lastAttemptMs = null;
  }
}

module.exports = {
  StreamSupervisor,
  STREAM_SILENCE_MS,
  WATCHDOG_BACKOFF_MS,
  MIN_RECONNECT_GAP_MS,
};
