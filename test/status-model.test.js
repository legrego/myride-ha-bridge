/**
 * Behavior of the status page's step logic (public/status-model.js), the same
 * code the page runs in the browser. All students, buses and times are fabricated.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const M = require("../public/status-model");

const NOW = Date.parse("2026-01-05T20:31:00Z"); // 15:31 in America/New_York
const ago = (sec) => NOW - sec * 1000;
const iso = (ms) => new Date(ms).toISOString();

/** A healthy standalone bridge: signed in, polled, streaming, MQTT up. */
function healthy(overrides = {}) {
  const s = {
    runtime: "standalone",
    timeZone: "America/New_York",
    startedAt: iso(ago(3 * 3600)),
    tokenMissing: false,
    tokenExpired: false,
    login: null,
    tokenExpiresAt: iso(NOW + 30 * 60e3),
    signalrConnected: true,
    mqttConnected: true,
    signIn: { method: "password", renewedAt: iso(ago(600)), nextRenewalAt: iso(NOW + 40 * 60e3) },
    roster: { lastPollAt: iso(ago(120)), pollMinutes: 15, lastError: null },
    stream: {
      expected: true, live: true, lastWatchedFrameMs: ago(5), connectedSinceMs: ago(3600),
      silenceMs: 300_000, watchedBuses: ["BUS 900"], reconnects: 0,
    },
    students: [{
      id: "900001", name: "Avery", currentRunId: 12,
      runs: [
        { runId: 11, period: "AM", bus: "BUS 900", regularBus: "BUS 900", substitute: false, windowStart: "07:05", windowEnd: "07:52", current: false, state: "done" },
        { runId: 12, period: "PM", bus: "BUS 900", regularBus: "BUS 900", substitute: false, windowStart: "15:00", windowEnd: "15:40", current: true, state: "active" },
      ],
      live: { feedLive: true, lastFixAt: iso(ago(5)), routeSnap: true, stopsAway: 2, etaMinutes: 4, delayMinutes: 5, distanceMeters: 900 },
    }],
    mqtt: { broker: "broker.lan", port: 1883, connected: true, lastPublishAt: iso(ago(5)) },
    homeAssistant: { devices: 2, entities: 20, haStatus: { state: null, at: null }, credentialsProblem: false, entityCheck: null },
  };
  return Object.assign(s, overrides);
}

const step = (s, id) => M.computeSteps(s, NOW).find((x) => x.id === id);
const verdict = (s) => M.computeVerdict(s, M.computeSteps(s, NOW), NOW);

describe("status model", () => {
  it("calls a healthy bridge Working", () => {
    const s = healthy();
    assert.deepEqual(M.computeSteps(s, NOW).map((x) => x.tone), ["ok", "ok", "ok", "ok", "ok"]);
    const v = verdict(s);
    assert.equal(v.tone, "ok");
    assert.match(v.sub, /BUS 900 is sending positions/);
  });

  describe("a late bus", () => {
    // PM window ended at 15:30; it's 15:31 and the bus is still on its way.
    const late = () => {
      const s = healthy();
      s.students[0].runs[1].windowEnd = "15:30";
      s.students[0].runs[1].state = "done";
      return s;
    };

    it("keeps live progress visible past the scheduled end", () => {
      const row = M.todayRows(late()).find((r) => r.run.runId === 12);
      assert.equal(row.status, "Running late");
      assert.equal(row.tone, "warn");
      assert.equal(row.progress, "2 stops away · ETA 4 min · 5 min late");
      assert.equal(row.snap, "On route");
    });

    it("still counts as a current run", () => {
      assert.match(step(late(), "roster").detail, /PM run in progress/);
    });

    const noEstimates = { lastFixAt: iso(ago(5)), routeSnap: null, stopsAway: null, etaMinutes: null, delayMinutes: null, distanceMeters: null };
    const rowOf = (s) => M.todayRows(s).find((r) => r.run.runId === 12);

    it("stays Running late on distance alone (no route mode, bus stopped)", () => {
      const s = late();
      s.students[0].live = { ...noEstimates, feedLive: true, routeSnap: false, distanceMeters: 1112 };
      const row = rowOf(s);
      assert.equal(row.status, "Running late");
      assert.equal(row.progress, "1.1 km away");
      assert.equal(row.snap, "Off route");
    });

    it("is Done once the bridge saw the bus serve the stop", () => {
      const s = late();
      s.students[0].live = { ...noEstimates, feedLive: true, stopServed: true };
      assert.equal(rowOf(s).status, "Done");
    });

    it("says Window over, not Done, while the bus reports but nothing confirms arrival", () => {
      const s = late();
      s.students[0].live = { ...noEstimates, feedLive: true, stopServed: false };
      const row = rowOf(s);
      assert.equal(row.status, "Window over");
      assert.equal(row.progress, "Bus still reporting · arrival not confirmed");
    });

    it("is Done once the window is over and the bus stopped reporting", () => {
      const s = late();
      s.students[0].live = { ...noEstimates, feedLive: false, stopServed: false, lastFixAt: iso(ago(1800)) };
      assert.equal(rowOf(s).status, "Done");
    });
  });

  describe("stream liveness", () => {
    const withStream = (stream) => healthy({ stream: { ...healthy().stream, ...stream } });

    it("is not Live right after connecting, before any frame", () => {
      // The supervisor's `live` is true here (connect grace); the page must not say Live.
      const s = withStream({ live: true, lastWatchedFrameMs: null, connectedSinceMs: ago(30) });
      assert.equal(M.streamLiveness(s, NOW), "waiting");
      const st = step(s, "stream");
      assert.equal(st.state, "Waiting for frames");
      assert.equal(st.tone, "idle");
      assert.doesNotMatch(verdict(s).sub, /sending positions/);
    });

    it("is not Live after a watchdog reconnect of a silent stream", () => {
      const s = withStream({ live: true, lastWatchedFrameMs: ago(20 * 60), connectedSinceMs: ago(30) });
      assert.equal(M.streamLiveness(s, NOW), "waiting");
      assert.notEqual(step(s, "stream").state, "Live");
    });

    it("is Silent once the silence window passes with no frame", () => {
      const s = withStream({ live: false, lastWatchedFrameMs: ago(20 * 60), connectedSinceMs: ago(10 * 60) });
      const st = step(s, "stream");
      assert.equal(st.tone, "warn");
      assert.equal(st.state, "Silent 20 min");
      assert.equal(verdict(s).chip, "Positions stalled");
    });

    it("never presents the connect time as the last frame", () => {
      const s = withStream({ lastWatchedFrameMs: null, connectedSinceMs: ago(10 * 60) });
      const st = step(s, "stream");
      assert.match(st.detail, /No frame since connecting/);
      assert.equal(st.rows.find((r) => r[0] === "Last watched frame")[1], "None yet");
    });

    it("is Live with a recent watched frame", () => {
      assert.equal(M.streamLiveness(healthy(), NOW), "live");
    });
  });

  describe("roster polls", () => {
    it("warns when the first poll fails, instead of Loading forever", () => {
      const s = healthy({
        students: [],
        roster: { lastPollAt: null, pollMinutes: 15, lastError: { message: "MyRide API returned HTTP 500", at: iso(ago(60)) } },
      });
      const st = step(s, "roster");
      assert.equal(st.tone, "warn");
      assert.equal(st.state, "Poll failing");
      assert.equal(st.detail, "No successful poll yet");
      assert.match(st.explain, /HTTP 500/);
      const v = verdict(s);
      assert.equal(v.tone, "warn");
      assert.notEqual(v.title, "Starting up");
    });

    it("recovers once a poll succeeds", () => {
      const s = healthy();
      assert.equal(step(s, "roster").tone, "ok");
    });

    it("shows Loading while the first poll is simply in progress", () => {
      const s = healthy({ students: [], roster: { lastPollAt: null, pollMinutes: 15, lastError: null } });
      assert.equal(step(s, "roster").state, "Loading");
      assert.equal(verdict(s).title, "Starting up");
    });

    it("warns when the last good poll is long overdue", () => {
      const s = healthy({ roster: { lastPollAt: iso(ago(24 * 3600)), pollMinutes: 15, lastError: null } });
      const st = step(s, "roster");
      assert.equal(st.tone, "warn");
      assert.equal(st.state, "Poll overdue");
    });

    it("says Paused, not failing, while the sign-in is the problem", () => {
      const s = healthy({ tokenExpired: true, roster: { lastPollAt: iso(ago(3600)), pollMinutes: 15, lastError: null } });
      assert.equal(step(s, "roster").state, "Paused");
      assert.equal(verdict(s).tone, "error");
    });
  });

  describe("Home Assistant status", () => {
    const withHa = (haStatus) => healthy({ homeAssistant: { ...healthy().homeAssistant, haStatus } });

    it("is unhealthy after HA's MQTT integration reports offline", () => {
      const s = withHa({ state: "offline", at: iso(ago(120)) });
      const st = step(s, "ha");
      assert.equal(st.tone, "warn");
      assert.equal(st.state, "HA offline");
      assert.notEqual(verdict(s).chip, "Working");
    });

    it("recovers when HA reports online again", () => {
      assert.equal(step(withHa({ state: "online", at: iso(ago(60)) }), "ha").tone, "ok");
    });

    it("treats a never-seen birth message as unknown, not offline", () => {
      const st = step(withHa({ state: null, at: null }), "ha");
      assert.equal(st.tone, "ok");
      assert.match(st.rows.find((r) => r[0] === "HA last seen online")[1], /Not seen since the bridge started/);
    });

    it("warns when Home Assistant is missing entities (add-on check)", () => {
      const s = healthy({ runtime: "addon" });
      s.homeAssistant.entityCheck = { found: 17, expected: 20, checkedAt: iso(ago(60)), error: null };
      assert.equal(step(s, "ha").state, "17 of 20 found");
    });
  });

  describe("sign-in", () => {
    it("points a rejected add-on password at the Configuration tab", () => {
      const s = healthy({ runtime: "addon", configUrl: "/config/app/a0d7b954_myride_bridge/config", tokenExpired: true, login: { rejected: "Incorrect username or password." } });
      const st = step(s, "signin");
      assert.equal(st.state, "Rejected");
      assert.deepEqual(st.action, { type: "config", href: "/config/app/a0d7b954_myride_bridge/config", label: "Open Configuration tab" });
      assert.match(st.explain, /Configuration tab/);
    });

    it("names the environment variables when standalone", () => {
      const s = healthy({ tokenExpired: true, login: { rejected: "Incorrect username or password." } });
      const st = step(s, "signin");
      assert.equal(st.action, null);
      assert.match(st.explain, /MYRIDE_EMAIL and MYRIDE_PASSWORD environment variables/);
    });
  });
});
