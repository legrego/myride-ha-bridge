const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { describeStudents, addonConfigUrl, maskId, describeOptions } = require("../src/status");

// All students, buses and runs are fabricated.
const student = {
  uniqueId: "900001",
  firstName: "Avery",
  currentRun: { runId: 11 },
  todaysRuns: [
    {
      runId: 11, busNumber: "BUS 900", activeVehicle: "BUS 901", isSubstitute: true,
      windowStart: 7 * 60 + 5, windowEnd: 7 * 60 + 52, myStopAction: "Pickup", myStopTimeMinutes: 7 * 60 + 31,
    },
    {
      runId: 12, busNumber: "BUS 900", activeVehicle: "BUS 900", isSubstitute: false,
      windowStart: 14 * 60 + 35, windowEnd: 15 * 60 + 20, myStopAction: "Dropoff", myStopTimeMinutes: 15 * 60 + 2,
    },
  ],
};

describe("describeStudents()", () => {
  it("describes each run with its period, bus and window", () => {
    const [s] = describeStudents([student], { nowMinutes: 7 * 60 + 38 });
    assert.equal(s.id, "900001");
    assert.equal(s.name, "Avery");
    assert.equal(s.currentRunId, 11);
    assert.deepEqual(s.runs[0], {
      runId: 11, period: "AM", bus: "BUS 901", regularBus: "BUS 900", substitute: true,
      windowStart: "07:05", windowEnd: "07:52", myStopTime: "07:31", myStopAction: "Pickup",
      current: true, state: "active",
    });
    assert.equal(s.runs[1].period, "PM");
    assert.equal(s.runs[1].substitute, false);
    assert.equal(s.runs[1].current, false);
    assert.equal(s.runs[1].state, "upcoming");
  });

  it("marks a run whose window has ended as done", () => {
    const [s] = describeStudents([student], { nowMinutes: 9 * 60 });
    assert.equal(s.runs[0].state, "done");
  });

  it("reads live values from what was published, mapping None and ON/OFF", () => {
    const published = {
      feed_live: "ON", last_fix: "2026-01-05T12:37:00.000Z", route_snap_ok: "OFF",
      stops_away: "3", eta: "None", delay: "-2", distance_to_stop: "812",
    };
    const [s] = describeStudents([student], {
      nowMinutes: 7 * 60 + 38,
      readPublished: (id, name) => (id === "900001" ? published[name] ?? null : null),
    });
    assert.deepEqual(s.live, {
      feedLive: true, lastFixAt: "2026-01-05T12:37:00.000Z", routeSnap: false,
      stopsAway: 3, etaMinutes: null, delayMinutes: -2, distanceMeters: 812, stopServed: null,
    });
  });

  it("asks whether the current run's stop was served", () => {
    const asked = [];
    const [s] = describeStudents([student], {
      nowMinutes: 16 * 60,
      readServed: (id, runId) => { asked.push([id, runId]); return true; },
    });
    assert.equal(s.live.stopServed, true);
    assert.deepEqual(asked, [["900001", 11]]);
  });

  it("has all-null live values without an MQTT bridge", () => {
    const [s] = describeStudents([student], { nowMinutes: 0 });
    assert.ok(Object.values(s.live).every((v) => v === null));
  });

  it("handles a student with no runs", () => {
    const [s] = describeStudents([{ uniqueId: "900002", firstName: "Blake", currentRun: null, todaysRuns: [] }], { nowMinutes: 0 });
    assert.equal(s.currentRunId, null);
    assert.deepEqual(s.runs, []);
  });
});

describe("addonConfigUrl()", () => {
  it("maps the add-on container hostname back to its slug", () => {
    assert.equal(addonConfigUrl("a0d7b954-myride-bridge"), "/config/app/a0d7b954_myride_bridge/config");
    assert.equal(addonConfigUrl("local-myride-bridge"), "/config/app/local_myride_bridge/config");
  });

  it("returns null for anything else", () => {
    assert.equal(addonConfigUrl(undefined), null);
    assert.equal(addonConfigUrl("3f1c0a9b2d4e"), null);
    assert.equal(addonConfigUrl("evil/../x-myride-bridge"), null);
  });
});

describe("maskId()", () => {
  it("keeps the ends of a long ID", () => {
    assert.equal(maskId("00000000-1111-2222-3333-444444444444"), "0000…4444");
  });

  it("leaves short IDs and empty values alone", () => {
    assert.equal(maskId("abc"), "abc");
    assert.equal(maskId(null), null);
  });
});

describe("describeOptions()", () => {
  const config = { timeZone: "America/Chicago", busFilter: null, logLevel: "info", mqtt: { broker: "broker.lan", port: 1883 } };
  const base = { config, configuredTenantId: null, approachRadiusMeters: 500, streamSilenceSeconds: 300 };

  it("lists every setting with its environment variable when standalone", () => {
    const options = describeOptions({ ...base, isAddon: false });
    assert.deepEqual(options.map((o) => o.env), [
      "TZ", "MYRIDE_TENANT_ID", "APPROACH_RADIUS_METERS", "BUS_FILTER", "STREAM_SILENCE_SECONDS", "MQTT_BROKER", "LOG_LEVEL",
    ]);
    assert.equal(options.find((o) => o.env === "MQTT_BROKER").value, "broker.lan:1883");
  });

  it("lists only the add-on's own options as an add-on", () => {
    const options = describeOptions({ ...base, isAddon: true });
    assert.deepEqual(options.map((o) => o.option), ["timezone", "tenant_id", "approach_radius_meters", "bus_filter", "log_level"]);
  });

  it("masks a configured tenant ID", () => {
    const options = describeOptions({ ...base, configuredTenantId: "00000000-1111-2222-3333-444444444444", isAddon: true });
    assert.equal(options.find((o) => o.option === "tenant_id").value, "Set: 0000…4444");
  });
});
