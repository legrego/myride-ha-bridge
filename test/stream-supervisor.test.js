const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  StreamSupervisor,
  STREAM_SILENCE_MS,
  WATCHDOG_BACKOFF_MS,
  MIN_RECONNECT_GAP_MS,
} = require("../src/stream-supervisor");

const MIN = 60_000;
const T0 = Date.parse("2026-10-26T12:00:00Z");

// A supervisor connected at T0 (as a startup connect), watching `buses` — in the
// real order: the first roster poll runs before the SignalR connect.
function connected(buses = [], opts) {
  const s = new StreamSupervisor(opts);
  if (buses.length) s.setWatchedBuses(buses, T0);
  s.onConnectStarted(T0);
  s.onConnected(T0, "startup");
  return s;
}

describe("StreamSupervisor", () => {
  describe("R1 runs-changed", () => {
    it("reconnects when a bus is added, not on an identical set, subset or empty set", () => {
      const s = connected();
      const at = T0 + 10 * MIN;

      const d = s.setWatchedBuses(["A"], at);
      assert.equal(d.reconnect, true);
      assert.equal(d.reason, "runs-changed");
      assert.deepEqual(d.detail.previous, []);
      assert.deepEqual(d.detail.next, ["A"]);
      assert.deepEqual(d.detail.added, ["A"]);

      // Identical set — the AM → PM switch on the same bus must not reconnect.
      assert.equal(s.setWatchedBuses(["A"], at + MIN), null);

      const d2 = s.setWatchedBuses(["A", "B"], at + 2 * MIN);
      assert.equal(d2.reason, "runs-changed");
      assert.deepEqual(d2.detail.added, ["B"]);

      assert.equal(s.setWatchedBuses(["A"], at + 3 * MIN), null); // subset
      assert.equal(s.setWatchedBuses([], at + 4 * MIN), null); // empty
    });

    it("is suppressed within MIN_RECONNECT_GAP_MS of a connect", () => {
      const s = connected();
      s.onConnected(T0 + 10 * MIN, "closed");
      assert.equal(s.setWatchedBuses(["A"], T0 + 10 * MIN + MIN_RECONNECT_GAP_MS - 1), null);
      // The set was recorded, so the same set later is not a change either.
      assert.equal(s.setWatchedBuses(["A"], T0 + 20 * MIN), null);

      const s2 = connected();
      s2.onConnected(T0 + 10 * MIN, "closed");
      assert.equal(s2.setWatchedBuses(["A"], T0 + 10 * MIN + MIN_RECONNECT_GAP_MS).reason, "runs-changed");
    });

    it("returns null before the first connect (the connect picks the runs up)", () => {
      const s = new StreamSupervisor();
      assert.equal(s.setWatchedBuses(["A"], T0), null);
      s.onConnectStarted(T0 + 1000);
      s.onConnected(T0 + 2000, "startup");
      s.onFrame("A", T0 + 9 * MIN);
      assert.equal(s.check(T0 + 10 * MIN), null);
    });

    it("retries a roster change that arrived while a connect was in flight", () => {
      const s = connected();
      // A reconnect starts (e.g. after a socket close) …
      s.onConnectStarted(T0 + 10 * MIN);
      // … a poll adds bus B before it finishes: the decision is issued, but index.js
      // drops it because a reconnect is already in flight.
      assert.equal(s.setWatchedBuses(["B"], T0 + 10 * MIN + 1000).reason, "runs-changed");
      s.onConnected(T0 + 10 * MIN + 2000, "closed");
      // That connection began before the change, so check() re-issues R1 once the
      // new connection is past the jitter window — even with no watchdog silence.
      s.onFrame("B", T0 + 10 * MIN + 3000);
      assert.equal(s.check(T0 + 10 * MIN + 2000 + MIN_RECONNECT_GAP_MS - 1), null);
      const d = s.check(T0 + 10 * MIN + 2000 + MIN_RECONNECT_GAP_MS);
      assert.equal(d.reason, "runs-changed");
      assert.deepEqual(d.detail.next, ["B"]);
      assert.equal(d.detail.changedAtMs, T0 + 10 * MIN + 1000);
      // A connection started after the change satisfies it.
      s.onConnectStarted(T0 + 11 * MIN);
      s.onConnected(T0 + 11 * MIN + 1000, "runs-changed");
      s.onFrame("B", T0 + 11 * MIN + 2000);
      assert.equal(s.check(T0 + 13 * MIN), null);
    });

    it("keeps a bus added during an attempt pending after an earlier addition is covered", () => {
      const s = connected(["A"]);
      s.setWatchedBuses(["A", "B"], T0 + 10 * MIN); // B added; its reconnect starts …
      s.onConnectStarted(T0 + 10 * MIN + 1000);
      s.setWatchedBuses(["A", "B", "C"], T0 + 10 * MIN + 2000); // … C added mid-attempt (dropped)
      s.onConnected(T0 + 10 * MIN + 3000, "runs-changed");
      // The connection covers B but predates C, so C is still pending even though
      // frames from A and B keep the watchdog satisfied.
      for (let t = T0 + 10 * MIN + 4000; t < T0 + 12 * MIN; t += 5000) {
        s.onFrame("A", t);
        s.onFrame("B", t);
      }
      const d = s.check(T0 + 12 * MIN);
      assert.equal(d.reason, "runs-changed");
      assert.equal(d.detail.changedAtMs, T0 + 10 * MIN + 2000);
      // A connection started after C's addition settles it.
      s.onConnectStarted(T0 + 12 * MIN);
      s.onConnected(T0 + 12 * MIN + 1000, "runs-changed");
      s.onFrame("C", T0 + 12 * MIN + 2000);
      assert.equal(s.check(T0 + 14 * MIN), null);
    });

    it("keeps frames from another watched bus from masking a pending change", () => {
      const s = connected(["A"]);
      s.onConnectStarted(T0 + 10 * MIN);
      s.setWatchedBuses(["A", "B"], T0 + 10 * MIN + 1000); // dropped: connect in flight
      s.onConnected(T0 + 10 * MIN + 2000, "watchdog");
      for (let t = T0 + 10 * MIN; t < T0 + 12 * MIN; t += 5000) s.onFrame("A", t);
      assert.equal(s.check(T0 + 12 * MIN).reason, "runs-changed");
    });

    it("does not retry a change that preceded the connect attempt (e.g. during a backoff sleep)", () => {
      const s = connected();
      s.setWatchedBuses(["A"], T0 + 10 * MIN); // dropped: backoff loop sleeping
      s.onConnectStarted(T0 + 10 * MIN + 4000);
      s.onConnected(T0 + 10 * MIN + 5000, "closed");
      s.onFrame("A", T0 + 11 * MIN);
      assert.equal(s.check(T0 + 12 * MIN), null);
    });

    it("retries a change suppressed by the jitter window if the connection predates it", () => {
      const s = connected();
      s.onConnectStarted(T0 + 10 * MIN);
      s.onConnected(T0 + 10 * MIN, "closed");
      assert.equal(s.setWatchedBuses(["A"], T0 + 10 * MIN + 5000), null); // suppressed
      s.onFrame("A", T0 + 10 * MIN + 6000);
      assert.equal(s.check(T0 + 10 * MIN + MIN_RECONNECT_GAP_MS).reason, "runs-changed");
    });

    it("drops a pending change when the watched set empties", () => {
      const s = connected();
      s.onConnectStarted(T0 + 10 * MIN);
      s.setWatchedBuses(["A"], T0 + 10 * MIN + 1000);
      s.setWatchedBuses([], T0 + 10 * MIN + 1500);
      s.onConnected(T0 + 10 * MIN + 2000, "closed");
      s.setWatchedBuses(["A"], T0 + 10 * MIN + 2500); // within the jitter window
      s.onConnectStarted(T0 + 11 * MIN);
      s.onConnected(T0 + 11 * MIN, "runs-changed");
      s.onFrame("A", T0 + 11 * MIN + 1000);
      assert.equal(s.check(T0 + 13 * MIN), null);
    });
  });

  describe("R2 watchdog", () => {
    it("fires only after silenceMs since connect, and a frame resets the clock", () => {
      const s = connected(["A"]);
      assert.equal(s.check(T0 + STREAM_SILENCE_MS), null);
      const d = s.check(T0 + STREAM_SILENCE_MS + 1);
      assert.equal(d.reason, "watchdog");
      assert.deepEqual(d.detail.buses, ["A"]);
      assert.equal(d.detail.silentMs, STREAM_SILENCE_MS + 1);
      assert.equal(d.detail.attempt, 1);

      const s2 = connected(["A"]);
      s2.onFrame("A", T0 + 4 * MIN);
      assert.equal(s2.check(T0 + STREAM_SILENCE_MS + 1), null);
      assert.equal(s2.check(T0 + 4 * MIN + STREAM_SILENCE_MS + 1).reason, "watchdog");
    });

    it("ignores frames for buses outside the watched set", () => {
      const s = connected(["A"]);
      assert.equal(s.onFrame("B", T0 + 4 * MIN), false);
      assert.equal(s.check(T0 + STREAM_SILENCE_MS + 1).reason, "watchdog");
    });

    it("spaces consecutive silent attempts 0 / 5 / 10 / 15 / 15 min", () => {
      const s = connected(["A"]);
      const attempts = [];
      // Simulate index.js: act on each decision, reconnect, never receive a frame.
      for (let t = T0; t <= T0 + 120 * MIN && attempts.length < 6; t += 30_000) {
        const d = s.check(t);
        if (!d) continue;
        attempts.push({ t, attempt: d.detail.attempt, nextAllowedInMs: d.detail.nextAllowedInMs });
        s.onReconnectStarted(d.reason, t);
        s.onConnected(t, d.reason);
      }
      const gaps = attempts.slice(1).map((a, i) => (a.t - attempts[i].t) / MIN);
      // The first fires on the first 30 s tick past the silence window; later ones
      // wait for the backoff gap or a fresh silence window, whichever is longer
      // (both 5 min for attempt 2, hence the extra tick).
      assert.equal(attempts[0].t - T0, STREAM_SILENCE_MS + 30_000);
      assert.deepEqual(gaps, [5.5, 10, 15, 15, 15]);
      assert.deepEqual(attempts.map((a) => a.attempt), [1, 2, 3, 4, 5, 6]);
      assert.deepEqual(
        attempts.map((a) => a.nextAllowedInMs / MIN),
        [5, 10, 15, 15, 15, 15]
      );
    });

    it("enforces the backoff gaps exactly", () => {
      const s = connected(["A"], { silenceMs: 1000 });
      let t = T0 + 2000;
      for (const gap of [0, ...WATCHDOG_BACKOFF_MS.slice(1), WATCHDOG_BACKOFF_MS.at(-1)]) {
        t += gap;
        if (gap > 0) assert.equal(s.check(t - 1), null, `attempt before ${gap / MIN} min gap`);
        const d = s.check(t);
        assert.equal(d && d.reason, "watchdog");
        s.onReconnectStarted("watchdog", t);
      }
    });

    it("a frame resets the backoff to attempt 1", () => {
      const s = connected(["A"]);
      let t = T0 + STREAM_SILENCE_MS + 1;
      s.onReconnectStarted(s.check(t).reason, t);
      s.onConnected(t, "watchdog");
      t += STREAM_SILENCE_MS + 1;
      const d2 = s.check(t);
      assert.equal(d2.detail.attempt, 2);
      s.onReconnectStarted(d2.reason, t);
      s.onConnected(t, "watchdog");

      s.onFrame("A", t + MIN);
      const d = s.check(t + MIN + STREAM_SILENCE_MS + 1);
      assert.equal(d.detail.attempt, 1);
    });

    it("never fires while the watched set is empty", () => {
      const s = connected();
      assert.equal(s.check(T0 + 24 * 60 * MIN), null);
    });

    it("never fires before the first connect", () => {
      const s = new StreamSupervisor();
      s.setWatchedBuses(["A"], T0);
      assert.equal(s.check(T0 + 60 * MIN), null);
    });
  });

  describe("R3 server-error", () => {
    it("reconnects when buses are watched, sharing the watchdog backoff", () => {
      const s = connected(["A"]);
      const d = s.onServerError("errorcode", [7], T0 + MIN);
      assert.equal(d.reason, "server-error");
      assert.equal(d.detail.method, "errorcode");
      s.onReconnectStarted(d.reason, T0 + MIN);
      // A second refusal right away is held back by the backoff …
      assert.equal(s.onServerError("error", ["nope"], T0 + 2 * MIN), null);
      // … and so is the watchdog.
      assert.equal(s.check(T0 + MIN + 5 * MIN - 1), null);
      assert.equal(s.onServerError("error", ["nope"], T0 + MIN + 5 * MIN).reason, "server-error");
    });

    it("returns null during startup (before the first connect), but records the error", () => {
      // SignalR dispatches invocations that arrive with the handshake before start()
      // resolves; restarting there would reject the startup start().
      const s = new StreamSupervisor();
      s.setWatchedBuses(["A"], T0);
      s.onConnectStarted(T0);
      assert.equal(s.onServerError("errorcode", [1], T0 + 100), null);
      assert.equal(s.status(T0 + 100).lastServerError.method, "errorcode");
      // Once connected, a later refusal is acted on.
      s.onConnected(T0 + 200, "startup");
      assert.equal(s.onServerError("errorcode", [1], T0 + 300).reason, "server-error");
    });

    it("records the error but returns null with no watched buses", () => {
      const s = connected();
      assert.equal(s.onServerError("errorcode", ["x"], T0 + MIN), null);
      assert.deepEqual(s.status(T0 + MIN).lastServerError, { method: "errorcode", args: ["x"], atMs: T0 + MIN });
    });
  });

  describe("onConnected()", () => {
    it("resets the silence baseline and counts every connect except startup", () => {
      const s = connected(["A"]);
      assert.equal(s.status(T0).reconnects, 0);
      s.onConnected(T0 + 4 * MIN, "closed");
      assert.equal(s.check(T0 + STREAM_SILENCE_MS + 1), null);
      assert.equal(s.check(T0 + 4 * MIN + STREAM_SILENCE_MS + 1).reason, "watchdog");
      s.onConnected(T0 + 20 * MIN, "token");
      const st = s.status(T0 + 20 * MIN);
      assert.equal(st.reconnects, 2);
      assert.equal(st.lastReconnectReason, "token");
      assert.equal(st.lastReconnectMs, T0 + 20 * MIN);
      assert.equal(st.connectionReason, "token");
      assert.equal(st.connectedSinceMs, T0 + 20 * MIN);
    });
  });

  describe("status()", () => {
    it("is not expected with no watched buses", () => {
      const st = connected().status(T0);
      assert.equal(st.expected, false);
      assert.equal(st.live, false);
    });

    it("is live within silenceMs of the last frame or connect, not after", () => {
      const s = connected(["A"]);
      assert.equal(s.status(T0 + STREAM_SILENCE_MS).live, true);
      assert.equal(s.status(T0 + STREAM_SILENCE_MS + 1).live, false);
      s.onFrame("A", T0 + 10 * MIN);
      const st = s.status(T0 + 10 * MIN + 1000);
      assert.equal(st.expected, true);
      assert.equal(st.live, true);
      assert.equal(st.lastWatchedFrameMs, T0 + 10 * MIN);
      assert.deepEqual(st.watchedBuses, ["A"]);
    });
  });

  it("incident replay: Sat no-run connect → Mon runs appear → silent → frame", () => {
    const s = new StreamSupervisor();
    // Sat 2026-10-24 06:19 EDT: (re)connect on a no-run day, server refuses.
    const sat = Date.parse("2026-10-24T10:19:00Z");
    s.onConnected(sat, "closed");
    assert.equal(s.onServerError("errorcode", [{ code: 1 }], sat + 500), null);
    assert.equal(s.status(sat + 1000).expected, false);
    // Sunday: still nothing watched, nothing fires.
    assert.equal(s.check(Date.parse("2026-10-25T16:00:00Z")), null);

    // Mon 2026-10-26 00:04 EDT: the roster poll sees today's runs.
    const mon = Date.parse("2026-10-26T04:04:00Z");
    const d = s.setWatchedBuses(["BUS 042"], mon);
    assert.equal(d.reason, "runs-changed");
    s.onConnected(mon + 2000, d.reason);

    // No frames afterwards: the watchdog fires at about connect + 5 min.
    const connectAt = mon + 2000;
    let firedAt = null;
    for (let t = connectAt; t <= connectAt + 10 * MIN; t += 30_000) {
      const w = s.check(t);
      if (w) {
        assert.equal(w.reason, "watchdog");
        firedAt = t;
        s.onReconnectStarted(w.reason, t);
        s.onConnected(t, w.reason);
        break;
      }
    }
    assert.ok(firedAt != null && firedAt - connectAt > STREAM_SILENCE_MS && firedAt - connectAt <= STREAM_SILENCE_MS + 30_000);

    // A frame (even a dropped 5 s repeat) arrives: live, and backoff is reset.
    s.onFrame("BUS 042", firedAt + 3000);
    assert.equal(s.status(firedAt + 4000).live, true);
    const next = s.check(firedAt + 3000 + STREAM_SILENCE_MS + 1);
    assert.equal(next.detail.attempt, 1);
    assert.equal(s.status(firedAt + 4000).reconnects, 3);
  });
});
