const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Mock mqtt module before requiring MqttBridge
const publishCalls = [];
const onHandlers = {};
let endCallback;

const fakeMqttClient = {
  publish(...args) {
    publishCalls.push(args);
  },
  on(event, handler) {
    onHandlers[event] = handler;
  },
  end(force, opts, cb) {
    endCallback = cb;
    if (cb) cb();
  },
};

// Intercept require("mqtt")
const Module = require("module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "mqtt") return "mqtt";
  return originalResolve.call(this, request, parent, ...rest);
};
require.cache["mqtt"] = {
  id: "mqtt",
  filename: "mqtt",
  loaded: true,
  exports: {
    connect: () => fakeMqttClient,
  },
};

const { MqttBridge } = require("../src/mqtt-bridge");

describe("MqttBridge", () => {
  let bridge;

  beforeEach(() => {
    publishCalls.length = 0;

    // Suppress console.log during tests
    bridge = new MqttBridge({
      broker: "mqtt://localhost",
      port: 1883,
      username: "user",
      password: "pass",
      topicPrefix: "myride",
    });
  });

  describe("_sanitizeId()", () => {
    it("lowercases and replaces spaces with underscores", () => {
      assert.equal(bridge._sanitizeId("BUS 042"), "bus_042");
    });

    it("collapses multiple spaces into one underscore", () => {
      assert.equal(bridge._sanitizeId("BUS  123"), "bus_123");
    });

    it("handles already lowercase", () => {
      assert.equal(bridge._sanitizeId("bus_001"), "bus_001");
    });

    it("handles mixed case with spaces", () => {
      assert.equal(bridge._sanitizeId("School Bus A"), "school_bus_a");
    });
  });

  describe("clearBusDiscovery()", () => {
    it("publishes empty retained payloads to the 4 legacy bus topics", () => {
      publishCalls.length = 0;
      bridge.clearBusDiscovery("BUS 042");

      const topics = publishCalls.map((c) => c[0]);
      assert.ok(topics.includes("homeassistant/device_tracker/myride_bus_042/config"));
      assert.ok(topics.includes("homeassistant/sensor/myride_bus_042_speed/config"));
      assert.ok(topics.includes("homeassistant/sensor/myride_bus_042_heading/config"));
      assert.ok(topics.includes("homeassistant/binary_sensor/myride_bus_042_moving/config"));

      for (const call of publishCalls) {
        assert.equal(call[1], "", "payload must be empty to delete the entity");
        assert.deepEqual(call[2], { retain: true });
      }
    });

    it("skips when assetUniqueId is falsy", () => {
      publishCalls.length = 0;
      bridge.clearBusDiscovery(null);
      assert.equal(publishCalls.length, 0);
    });
  });

  describe("publishCredentialStatusDiscovery()", () => {
    it("publishes discovery config for credentials sensor", () => {
      publishCalls.length = 0;
      bridge.publishCredentialStatusDiscovery();

      assert.equal(publishCalls.length, 1);
      assert.equal(publishCalls[0][0], "homeassistant/binary_sensor/myride_bridge_credentials/config");
      const payload = JSON.parse(publishCalls[0][1]);
      assert.equal(payload.device_class, "problem");
      assert.equal(payload.unique_id, "myride_bridge_credentials");
    });
  });

  describe("publishCredentialStatus()", () => {
    it("publishes ON when expired=true", () => {
      publishCalls.length = 0;
      bridge.publishCredentialStatus(true);
      assert.equal(publishCalls[0][1], "ON");
    });

    it("publishes OFF when expired=false", () => {
      publishCalls.length = 0;
      bridge.publishCredentialStatus(false);
      assert.equal(publishCalls[0][1], "OFF");
    });

    it("publishes to correct topic", () => {
      publishCalls.length = 0;
      bridge.publishCredentialStatus(true);
      assert.equal(publishCalls[0][0], "myride/bridge/credentials");
    });
  });

  describe("publishStudent()", () => {
    const makeStudent = (overrides = {}) => ({
      uniqueId: "2008416",
      firstName: "Lucas",
      lastName: "Gregory",
      currentRun: {
        runId: 147,
        busNumber: "BUS 012",
        activeVehicle: "BUS 057",
        isSubstitute: true,
        windowStart: 525,
        windowEnd: 550,
      },
      todaysRuns: [
        { runId: 147, busNumber: "BUS 012", activeVehicle: "BUS 057", isSubstitute: true },
        { runId: 154, busNumber: "BUS 012", activeVehicle: "BUS 012", isSubstitute: false },
      ],
      ...overrides,
    });

    beforeEach(() => {
      bridge.discoveredStudents.clear();
    });

    it("publishes all 6 discovery configs on first call", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent());

      const topics = publishCalls.map((c) => c[0]);
      assert.ok(topics.includes("homeassistant/device_tracker/myride_student_2008416/config"));
      assert.ok(topics.includes("homeassistant/sensor/myride_student_2008416_speed/config"));
      assert.ok(topics.includes("homeassistant/sensor/myride_student_2008416_heading/config"));
      assert.ok(topics.includes("homeassistant/binary_sensor/myride_student_2008416_moving/config"));
      assert.ok(topics.includes("homeassistant/sensor/myride_student_2008416_bus/config"));
      assert.ok(topics.includes("homeassistant/binary_sensor/myride_student_2008416_substitute/config"));
    });

    it("device name is the student's display name", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent());

      const trackerCall = publishCalls.find(
        (c) => c[0] === "homeassistant/device_tracker/myride_student_2008416/config"
      );
      const payload = JSON.parse(trackerCall[1]);
      assert.equal(payload.device.name, "Lucas Gregory");
      assert.equal(payload.source_type, "gps");
      assert.deepEqual(payload.device.identifiers, ["myride_student_2008416"]);
    });

    it("discovery configs are retained", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent());

      const discoveryCalls = publishCalls.filter((c) => c[0].includes("/config"));
      assert.ok(discoveryCalls.length >= 2);
      for (const call of discoveryCalls) {
        assert.deepEqual(call[2], { retain: true });
      }
    });

    it("is idempotent — discovery only published once per student", () => {
      bridge.publishStudent(makeStudent());
      const afterFirst = publishCalls.filter((c) => c[0].includes("/config")).length;
      bridge.publishStudent(makeStudent());
      const afterSecond = publishCalls.filter((c) => c[0].includes("/config")).length;
      assert.equal(afterFirst, afterSecond);
    });

    it("publishes state with activeVehicle", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent());

      const stateCall = publishCalls.find(
        (c) => c[0] === "myride/student/2008416/state"
      );
      assert.ok(stateCall);
      assert.equal(stateCall[1], "BUS 057");
    });

    it("publishes substitute=ON when isSubstitute=true", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent());

      const subCall = publishCalls.find((c) => c[0] === "myride/student/2008416/substitute");
      assert.ok(subCall);
      assert.equal(subCall[1], "ON");
    });

    it("publishes substitute=OFF when isSubstitute=false", () => {
      publishCalls.length = 0;
      const student = makeStudent();
      student.currentRun = { ...student.currentRun, activeVehicle: "BUS 012", isSubstitute: false };
      bridge.publishStudent(student);

      const subCall = publishCalls.find((c) => c[0] === "myride/student/2008416/substitute");
      assert.ok(subCall);
      assert.equal(subCall[1], "OFF");
    });

    it("attributes include regular_bus, active_bus, is_substitute, student_name", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent());

      const attrCall = publishCalls.find((c) => c[0] === "myride/student/2008416/attributes");
      assert.ok(attrCall);
      const attrs = JSON.parse(attrCall[1]);
      assert.equal(attrs.regular_bus, "BUS 012");
      assert.equal(attrs.active_bus, "BUS 057");
      assert.equal(attrs.is_substitute, true);
      assert.equal(attrs.student_name, "Lucas Gregory");
    });

    it("attributes include todays_runs array", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent());

      const attrCall = publishCalls.find((c) => c[0] === "myride/student/2008416/attributes");
      const attrs = JSON.parse(attrCall[1]);
      assert.equal(Array.isArray(attrs.todays_runs), true);
      assert.equal(attrs.todays_runs.length, 2);
    });

    it("skips when uniqueId is missing", () => {
      publishCalls.length = 0;
      bridge.publishStudent({ uniqueId: null, currentRun: {} });
      assert.equal(publishCalls.length, 0);
    });

    it("skips when currentRun is null", () => {
      publishCalls.length = 0;
      bridge.publishStudent({ uniqueId: "123", currentRun: null });
      assert.equal(publishCalls.length, 0);
    });

    it("substitute discovery uses device_class: problem", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent());

      const subConfig = publishCalls.find(
        (c) => c[0] === "homeassistant/binary_sensor/myride_student_2008416_substitute/config"
      );
      const payload = JSON.parse(subConfig[1]);
      assert.equal(payload.device_class, "problem");
    });
  });

  describe("publishStudentLocation()", () => {
    const makeStudent = () => ({
      uniqueId: "2008416",
      firstName: "Lucas",
      lastName: "Gregory",
      currentRun: {
        runId: 147,
        busNumber: "BUS 012",
        activeVehicle: "BUS 057",
        isSubstitute: true,
      },
      todaysRuns: [],
    });
    const makeLocation = (overrides = {}) => ({
      assetUniqueId: "BUS 057",
      latitude: 40.689,
      longitude: -74.044,
      heading: 138,
      speed: 26,
      logTime: "2026-03-18T18:37:41Z",
      ...overrides,
    });

    beforeEach(() => {
      bridge.discoveredStudents.clear();
    });

    it("skips when the student has not been discovered yet", () => {
      publishCalls.length = 0;
      bridge.publishStudentLocation(makeStudent(), makeLocation());
      assert.equal(publishCalls.length, 0);
    });

    it("skips when uniqueId is missing", () => {
      bridge.publishStudent(makeStudent()); // discover
      publishCalls.length = 0;
      bridge.publishStudentLocation({ uniqueId: null }, makeLocation());
      assert.equal(publishCalls.length, 0);
    });

    it("publishes gps_state, gps_attributes, speed, heading, moving", () => {
      bridge.publishStudent(makeStudent());
      publishCalls.length = 0;
      bridge.publishStudentLocation(makeStudent(), makeLocation());

      const topics = publishCalls.map((c) => c[0]);
      assert.ok(topics.includes("myride/student/2008416/gps_state"));
      assert.ok(topics.includes("myride/student/2008416/gps_attributes"));
      assert.ok(topics.includes("myride/student/2008416/speed"));
      assert.ok(topics.includes("myride/student/2008416/heading"));
      assert.ok(topics.includes("myride/student/2008416/moving"));
    });

    it("gps_state is the reset payload for HA zone detection", () => {
      bridge.publishStudent(makeStudent());
      publishCalls.length = 0;
      bridge.publishStudentLocation(makeStudent(), makeLocation());

      const stateCall = publishCalls.find((c) => c[0] === "myride/student/2008416/gps_state");
      assert.equal(stateCall[1], "None");
    });

    it("gps_attributes include lat/lng and the active bus", () => {
      bridge.publishStudent(makeStudent());
      publishCalls.length = 0;
      bridge.publishStudentLocation(makeStudent(), makeLocation());

      const attrCall = publishCalls.find((c) => c[0] === "myride/student/2008416/gps_attributes");
      const attrs = JSON.parse(attrCall[1]);
      assert.equal(attrs.latitude, 40.689);
      assert.equal(attrs.longitude, -74.044);
      assert.equal(attrs.gps_accuracy, 10);
      assert.equal(attrs.active_bus, "BUS 057");
      assert.equal(attrs.regular_bus, "BUS 012");
      assert.equal(attrs.is_substitute, true);
    });

    it("publishes speed as string and moving ON/OFF", () => {
      bridge.publishStudent(makeStudent());
      publishCalls.length = 0;
      bridge.publishStudentLocation(makeStudent(), makeLocation({ speed: 0 }));

      const speedCall = publishCalls.find((c) => c[0] === "myride/student/2008416/speed");
      assert.equal(speedCall[1], "0");
      const movingCall = publishCalls.find((c) => c[0] === "myride/student/2008416/moving");
      assert.equal(movingCall[1], "OFF");
    });
  });

  describe("stop tracking (my_stop / distance / eta / approaching)", () => {
    const myStop = {
      stopId: 1638,
      name: "MAPLE ST @ 3RD AVE",
      address: "MAPLE ST TESTBORO, NY 10001",
      lat: 41.5,
      lng: -72.0,
      actionType: "Pickup",
      stopTime: "1900-01-01T09:01:52.277",
      stopTimeMinutes: 541,
      etaMinutes: 0,
    };
    const makeStudent = (stop = myStop) => ({
      uniqueId: "2008416",
      firstName: "Lucas",
      lastName: "Gregory",
      currentRun: {
        runId: 719,
        busNumber: "BUS 012",
        activeVehicle: "BUS 012",
        isSubstitute: false,
        myStop: stop,
        myStopSeq: 14,
        totalStops: 17,
        stopSchedule: [{ seq: 0, stopId: 3704, time: "08:49", done: true }],
        scheduledTime: "09:01",
        stopsAway: 3,
      },
      todaysRuns: [],
    });
    // Bus ~145m from the stop (well within the 500m default radius)
    const near = { assetUniqueId: "BUS 012", latitude: 41.5013, longitude: -72.0, heading: 200, speed: 20, logTime: "2026-09-10T13:01:00Z" };
    // Bus ~2.2km away
    const far = { ...near, latitude: 41.52, longitude: -72.0 };

    beforeEach(() => {
      bridge.discoveredStudents.clear();
    });

    it("publishes discovery for my_stop, distance, eta and approaching", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent());
      const topics = publishCalls.map((c) => c[0]);
      assert.ok(topics.includes("homeassistant/sensor/myride_student_2008416_my_stop/config"));
      assert.ok(topics.includes("homeassistant/sensor/myride_student_2008416_distance_to_stop/config"));
      assert.ok(topics.includes("homeassistant/sensor/myride_student_2008416_eta/config"));
      assert.ok(topics.includes("homeassistant/binary_sensor/myride_student_2008416_approaching/config"));
    });

    it("my_stop state is the stop name; attributes carry schedule and position", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent());
      const stateCall = publishCalls.find((c) => c[0] === "myride/student/2008416/my_stop");
      assert.equal(stateCall[1], "MAPLE ST @ 3RD AVE");
      const attrs = JSON.parse(
        publishCalls.find((c) => c[0] === "myride/student/2008416/my_stop_attributes")[1]
      );
      assert.equal(attrs.stop_id, 1638);
      assert.equal(attrs.action, "Pickup");
      assert.equal(attrs.stop_number, 15); // seq 14 → 1-based 15
      assert.equal(attrs.total_stops, 17);
      assert.equal(attrs.schedule.length, 1);
    });

    it("my_stop state is 'None' (HA unknown) when the run has no myStop", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent(null));
      const stateCall = publishCalls.find((c) => c[0] === "myride/student/2008416/my_stop");
      assert.equal(stateCall[1], "None");
    });

    it("publishes discovery for scheduled_time and stops_away", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent());
      const topics = publishCalls.map((c) => c[0]);
      assert.ok(topics.includes("homeassistant/sensor/myride_student_2008416_scheduled_time/config"));
      assert.ok(topics.includes("homeassistant/sensor/myride_student_2008416_stops_away/config"));
    });

    it("evicts legacy retained per-fix values on first discovery (upgrade migration)", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent());
      for (const t of ["distance_to_stop", "eta", "delay", "predicted_arrival", "stops_away"]) {
        const evict = publishCalls.find(
          (c) => c[0] === `myride/student/2008416/${t}` && c[1] === "" && c[2] && c[2].retain === true
        );
        assert.ok(evict, `expected a retained empty payload evicting stale ${t}`);
      }
    });

    it("evicts only once — not again on the next poll for the same student", () => {
      bridge.publishStudent(makeStudent()); // first sight → evict
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent()); // same student, no re-eviction
      const evictions = publishCalls.filter(
        (c) => c[0] === "myride/student/2008416/eta" && c[1] === "" && c[2] && c[2].retain === true
      );
      assert.equal(evictions.length, 0);
    });

    it("publishes scheduled_time (HH:MM) from the current run", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent());
      assert.equal(
        publishCalls.find((c) => c[0] === "myride/student/2008416/scheduled_time")[1],
        "09:01"
      );
    });

    it("does not compute stops_away from the poll (route-derived per fix; poll only clears/evicts it)", () => {
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent());
      // The poll may clear stops_away to "None" (via _clearStopProgress) or evict a
      // stale retained value with "" — but must never publish a computed count.
      const stateCalls = publishCalls.filter((c) => c[0] === "myride/student/2008416/stops_away");
      for (const call of stateCalls) {
        assert.ok(
          call[1] === "None" || call[1] === "",
          `poll must only clear/evict stops_away, not compute it (got "${call[1]}")`
        );
      }
    });

    it("scheduled_time is 'None' when the run has no myStop", () => {
      publishCalls.length = 0;
      const s = makeStudent(null);
      s.currentRun.scheduledTime = null;
      bridge.publishStudent(s);
      assert.equal(
        publishCalls.find((c) => c[0] === "myride/student/2008416/scheduled_time")[1],
        "None"
      );
    });

    it("turns approaching ON and publishes distance/eta when the bus is near and moving", () => {
      bridge.publishStudent(makeStudent());
      publishCalls.length = 0;
      bridge.publishStudentLocation(makeStudent(), near);

      const dist = Number(publishCalls.find((c) => c[0] === "myride/student/2008416/distance_to_stop")[1]);
      assert.ok(dist > 0 && dist < 500, `expected <500m, got ${dist}`);
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/approaching")[1], "ON");
      const eta = publishCalls.find((c) => c[0] === "myride/student/2008416/eta")[1];
      assert.ok(Number(eta) >= 0, `expected numeric eta, got ${eta}`);
    });

    it("turns approaching OFF when the bus is beyond the radius", () => {
      bridge.publishStudent(makeStudent());
      publishCalls.length = 0;
      bridge.publishStudentLocation(makeStudent(), far);
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/approaching")[1], "OFF");
    });

    it("sets eta to None when stopped, but still publishes distance", () => {
      bridge.publishStudent(makeStudent());
      publishCalls.length = 0;
      bridge.publishStudentLocation(makeStudent(), { ...near, speed: 0 });
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/eta")[1], "None");
      assert.ok(publishCalls.find((c) => c[0] === "myride/student/2008416/distance_to_stop"));
    });

    it("publishes None distance/eta and OFF approaching when the stop has no coordinates", () => {
      const noCoords = { ...myStop, lat: null, lng: null };
      bridge.publishStudent(makeStudent(noCoords));
      publishCalls.length = 0;
      bridge.publishStudentLocation(makeStudent(noCoords), near);
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/distance_to_stop")[1], "None");
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/eta")[1], "None");
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/approaching")[1], "OFF");
    });

    it("honors a custom approachRadiusMeters", () => {
      const tight = new MqttBridge({ broker: "mqtt://localhost", port: 1883, approachRadiusMeters: 50 });
      tight.publishStudent(makeStudent());
      publishCalls.length = 0;
      tight.publishStudentLocation(makeStudent(), near); // ~145m away, radius 50
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/approaching")[1], "OFF");
    });

    it("falls back to the 500m default for a NaN/≤0 approachRadiusMeters", () => {
      for (const bad of [NaN, 0, -100, undefined]) {
        const b = new MqttBridge({ broker: "mqtt://localhost", port: 1883, approachRadiusMeters: bad });
        assert.equal(b.approachRadiusMeters, 500, `bad value ${bad} should fall back to 500`);
      }
    });

    it("clears stale distance/eta/approaching when the student's stop changes", () => {
      // First run: stop is nearby and moving → approaching ON, distance set.
      bridge.publishStudent(makeStudent());
      publishCalls.length = 0;
      bridge.publishStudentLocation(makeStudent(), near);
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/approaching")[1], "ON");

      // Poll switches to a different stop (e.g. AM→PM) with no location yet.
      publishCalls.length = 0;
      const otherStop = { ...myStop, stopId: 9999, name: "OTHER STOP", lat: 40.0, lng: -75.0 };
      bridge.publishStudent(makeStudent(otherStop));

      // Progress topics must be blanked (None → unknown), not left showing the previous stop.
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/distance_to_stop")[1], "None");
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/eta")[1], "None");
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/approaching")[1], "OFF");
    });

    it("does not re-clear progress when the stop is unchanged between polls", () => {
      bridge.publishStudent(makeStudent());
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent()); // same stop id
      assert.equal(publishCalls.filter((c) => c[0] === "myride/student/2008416/approaching").length, 0);
      assert.equal(publishCalls.filter((c) => c[0] === "myride/student/2008416/distance_to_stop").length, 0);
    });

    it("clears progress when the stop becomes unavailable", () => {
      bridge.publishStudent(makeStudent());
      bridge.publishStudentLocation(makeStudent(), near);
      publishCalls.length = 0;
      bridge.publishStudent(makeStudent(null)); // no myStop
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/distance_to_stop")[1], "None");
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/approaching")[1], "OFF");
    });

    it("clears progress at the AM→PM transition even though the stop id is unchanged", () => {
      // AM run: same home stop id, nearby & moving → approaching ON.
      bridge.publishStudent(makeStudent());
      publishCalls.length = 0;
      bridge.publishStudentLocation(makeStudent(), near);
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/approaching")[1], "ON");

      // PM run: same stopId (1638) but different runId + active vehicle.
      const pm = makeStudent();
      pm.currentRun = { ...pm.currentRun, runId: 794, activeVehicle: "BUS 057" };
      publishCalls.length = 0;
      bridge.publishStudent(pm);
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/distance_to_stop")[1], "None");
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/approaching")[1], "OFF");
    });

    it("clears progress and marks the stop unknown when there is no current run", () => {
      bridge.publishStudent(makeStudent());
      bridge.publishStudentLocation(makeStudent(), near); // approaching ON, retained
      publishCalls.length = 0;
      bridge.publishStudent({ uniqueId: "2008416", currentRun: null }); // no-school day
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/my_stop")[1], "None");
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/distance_to_stop")[1], "None");
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/approaching")[1], "OFF");
    });
  });

  describe("route-aware distance & ETA", () => {
    // Route runs due north along -72.0; legs are 1000 m each (hand-set cumulative,
    // independent of the haversine leg lengths so the assertions are exact). The
    // stop pin sits at the last vertex → cumulativeAtStopMeters = 3000. All fabricated.
    const routePolyline = [
      [41.50, -72.0],
      [41.51, -72.0],
      [41.52, -72.0],
      [41.53, -72.0],
    ];
    const cumulativeMeters = [0, 1000, 2000, 3000];
    const routeStop = {
      stopId: 1638,
      name: "MAPLE ST @ 3RD AVE",
      lat: 41.53,
      lng: -72.0,
      actionType: "Pickup",
      stopTime: "1900-01-01T09:01:00",
      stopTimeMinutes: 541,
      routePolyline,
      cumulativeMeters,
      cumulativeAtStopMeters: 3000,
      // Scheduled time at each vertex's cumulative position (minutes-since-midnight):
      // 08:50, 08:54, 08:58, 09:01. The last matches stopTimeMinutes (541).
      scheduleCheckpoints: [
        { cum: 0, sched: 530, seq: 0 },
        { cum: 1000, sched: 534, seq: 1 },
        { cum: 2000, sched: 538, seq: 2 },
        { cum: 3000, sched: 541, seq: 3 },
      ],
      // Stops before my stop (at cum 3000): the ones at cum 0, 1000, 2000.
      upstreamStopCums: [0, 1000, 2000],
    };
    const plainStop = {
      stopId: 1638, name: "MAPLE ST @ 3RD AVE", lat: 41.53, lng: -72.0,
      actionType: "Pickup", stopTime: "1900-01-01T09:01:00", stopTimeMinutes: 541,
    };
    const makeStudent = (stop) => ({
      uniqueId: "2008416",
      firstName: "Lucas",
      lastName: "Gregory",
      currentRun: {
        runId: 719, busNumber: "BUS 012", activeVehicle: "BUS 012",
        isSubstitute: false, myStop: stop, myStopSeq: 2, totalStops: 3,
        stopSchedule: [],
      },
      todaysRuns: [],
    });
    const at = (lat, lng, overrides = {}) => ({
      assetUniqueId: "BUS 012", latitude: lat, longitude: lng,
      heading: 0, speed: 20, logTime: "2026-09-11T13:01:00Z", ...overrides,
    });

    beforeEach(() => {
      bridge.discoveredStudents.clear();
    });

    describe("_routeDistanceMeters()", () => {
      // Source timestamps (ms). Normal cadence is ~30 s between frames; at
      // ROUTE_MAX_PLAUSIBLE_MPS (30) that permits ~150 + 30×30 = 1050 m of forward
      // progress — enough for one 1000 m vertex step but not a 3000 m jump.
      const t0 = 1_000_000;
      const t = (sec) => t0 + sec * 1000;

      it("returns cumulativeAtStop − cumulativeAtBus for a mid-route bus", () => {
        // Bus on vertex idx1 (cum 1000) → remaining 3000 − 1000 = 2000.
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.51, -72.0, t0), 2000);
      });

      it("clamps remaining at 0 when the bus is at/after the stop vertex", () => {
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.53, -72.0, t0), 0);
      });

      it("returns null when route geometry is missing", () => {
        assert.equal(bridge._routeDistanceMeters("s1", plainStop, 41.51, -72.0, t0), null);
      });

      it("returns null when the bus is off-route (snap beyond threshold)", () => {
        // ~0.02° longitude east (~1.6 km) — well past the 150 m snap cutoff.
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.51, -71.98, t0), null);
      });

      it("persists no state while off-route before any baseline is acquired", () => {
        // A run that starts off-route (never snapped on) must not accumulate hold
        // state — otherwise every fix would re-log failure #1 forever. Repeated
        // off-route fixes return null and leave the guard map empty until a real
        // on-route fix establishes the baseline.
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.51, -71.98, t0), null);
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.51, -71.98, t(30)), null);
        assert.equal(bridge.lastRouteCumByStudent.has("s1"), false);
        // Once on-route, a fix is accepted and becomes the baseline.
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.51, -72.0, t(60)), 2000);
        assert.equal(bridge.lastRouteCumByStudent.has("s1"), true);
      });

      it("holds the baseline on a backward jump, then re-acquires", () => {
        // Accept a forward reading at vertex idx2 (cum 2000).
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.52, -72.0, t0), 1000);
        // A jump back to idx0 (cum 0) is > 50 m backward → rejected, but within the
        // hold budget it returns the held distance from the baseline (cum 2000 → 1000),
        // not null and not the bad snap's value.
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.50, -72.0, t(30)), 1000);
        // Baseline preserved: a plausible forward reading (~30 s later) is accepted.
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.53, -72.0, t(60)), 0);
      });

      it("holds the baseline on an implausible forward jump, then re-acquires", () => {
        // Accept an early reading at vertex idx0 (cum 0).
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.50, -72.0, t0), 3000);
        // +3000 m over ~30 s (≈100 m/s) is implausible → rejected as a wrong-pass
        // snap, but held at the baseline distance (cum 0 → 3000) within budget.
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.53, -72.0, t(30)), 3000);
        // Baseline preserved: a plausible +1000 m step (~30 s) is accepted.
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.51, -72.0, t(60)), 2000);
      });

      it("tracks the guard per student id", () => {
        bridge._routeDistanceMeters("a", routeStop, 41.52, -72.0, t0); // a → 2000
        // Student b has no baseline, so an early-route reading is accepted.
        assert.equal(bridge._routeDistanceMeters("b", routeStop, 41.50, -72.0, t0), 3000);
      });

      it("does not promote a recurring wrong-pass snap: holds, gives up, then re-acquires", () => {
        // Baseline at the route start (cum 0).
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.50, -72.0, t0), 3000);
        // A deterministic far-ahead snap (cum 3000) recurs at normal cadence. Each
        // frame's elapsed is only ~30 s, so it stays rejected — repetition alone
        // never promotes it (the defect the count-based guard had). For the first
        // ROUTE_MAX_HELD_FIXES (3) rejections the baseline distance is held (3000)...
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.53, -72.0, t(30)), 3000);
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.53, -72.0, t(60)), 3000);
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.53, -72.0, t(90)), 3000);
        // ...then the hold budget is exhausted and it returns null (route mode off).
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.53, -72.0, t(120)), null);
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.53, -72.0, t(150)), null);
        // But after a genuine long gap (~140 s, e.g. a SignalR reconnect) the same
        // advance is time-plausible → adopted as the new baseline.
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.53, -72.0, t(290)), 0);
      });

      it("falls back to a small allowance when the source timestamp is unknown", () => {
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.50, -72.0), 3000);
        // No nowMs → elapsed treated as 0 → only the 150 m base is allowed, so a
        // +1000 m step is rejected — but held at the baseline distance (3000) within budget.
        assert.equal(bridge._routeDistanceMeters("s1", routeStop, 41.51, -72.0), 3000);
      });
    });

    it("publishes route distance (not haversine) for distance_to_stop and eta", () => {
      bridge.publishStudent(makeStudent(routeStop));
      publishCalls.length = 0;
      bridge.publishStudentLocation(makeStudent(routeStop), at(41.51, -72.0));

      // Route remaining is exactly 2000; crow-flies to the pin (0.02°) is ~2224 m.
      const dist = Number(publishCalls.find((c) => c[0] === "myride/student/2008416/distance_to_stop")[1]);
      assert.equal(dist, 2000);
      // ETA = 2000 m ÷ (20 mph × 26.8224) ≈ 3.7 → 4 min.
      const eta = Number(publishCalls.find((c) => c[0] === "myride/student/2008416/eta")[1]);
      assert.equal(eta, 4);
    });

    it("falls back to haversine distance when the stop has no route geometry", () => {
      bridge.publishStudent(makeStudent(plainStop));
      publishCalls.length = 0;
      bridge.publishStudentLocation(makeStudent(plainStop), at(41.51, -72.0));

      const dist = Number(publishCalls.find((c) => c[0] === "myride/student/2008416/distance_to_stop")[1]);
      // Crow-flies over 0.02° latitude ≈ 2224 m — clearly not the 2000 m route value.
      assert.ok(dist > 2200 && dist < 2250, `expected ~2224m haversine, got ${dist}`);
    });

    it("falls back to haversine when the bus is off-route", () => {
      bridge.publishStudent(makeStudent(routeStop));
      publishCalls.length = 0;
      // Off-route east: route snap exceeds 150 m → haversine to the pin instead.
      bridge.publishStudentLocation(makeStudent(routeStop), at(41.51, -71.98));
      const dist = Number(publishCalls.find((c) => c[0] === "myride/student/2008416/distance_to_stop")[1]);
      assert.ok(dist > 2000, `expected haversine (>2000m), got ${dist}`);
    });

    it("keeps approaching on haversine even when route distance is within the radius", () => {
      // Route says 400 m remaining (< 500 m radius) but the bus is physically
      // ~2224 m from the pin → approaching must be OFF (driven by haversine).
      const shortRouteStop = { ...routeStop, cumulativeAtStopMeters: 1400 };
      bridge.publishStudent(makeStudent(shortRouteStop));
      publishCalls.length = 0;
      bridge.publishStudentLocation(makeStudent(shortRouteStop), at(41.51, -72.0));

      const dist = Number(publishCalls.find((c) => c[0] === "myride/student/2008416/distance_to_stop")[1]);
      assert.equal(dist, 400); // route distance used for the sensor
      assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/approaching")[1], "OFF");
    });

    it("resets the wrong-pass guard when stop progress is cleared", () => {
      bridge.publishStudent(makeStudent(routeStop));
      bridge.publishStudentLocation(makeStudent(routeStop), at(41.52, -72.0)); // baseline 2000
      // A stop-identity change clears progress (and the route baseline).
      const moved = makeStudent(routeStop);
      moved.currentRun = { ...moved.currentRun, runId: 800, activeVehicle: "BUS 057" };
      bridge.publishStudent(moved);
      assert.equal(bridge.lastRouteCumByStudent.has("2008416"), false);
    });

    it("holds route-derived sensors through a transient off-route gap, then blanks", () => {
      const last = (topic) => {
        const hit = [...publishCalls].reverse().find((c) => c[0] === topic);
        return hit ? hit[1] : undefined;
      };
      const distTopic = "myride/student/2008416/distance_to_stop";
      const stopsTopic = "myride/student/2008416/stops_away";
      const student = makeStudent(routeStop);
      bridge.publishStudent(student);

      // Accept a mid-route fix at cum 1000: route distance 2000, one upstream stop
      // (cum 2000) still ahead → stops_away 1.
      bridge.publishStudentLocation(student, at(41.51, -72.0, { logTime: "2026-09-11T13:01:00Z" }));
      assert.equal(Number(last(distTopic)), 2000);
      assert.equal(last(stopsTopic), "1");

      // Now the bus snaps off-route (a thin connector stretch). Within the hold
      // budget the route-derived values are held — distance stays the route 2000
      // (NOT the ~2224 m haversine) and stops_away stays 1 (NOT "None").
      for (let i = 1; i <= 3; i++) {
        publishCalls.length = 0;
        bridge.publishStudentLocation(
          student,
          at(41.51, -71.98, { logTime: new Date(Date.parse("2026-09-11T13:01:00Z") + i * 30000).toISOString() })
        );
        assert.equal(Number(last(distTopic)), 2000, `held distance on failure #${i}`);
        assert.equal(last(stopsTopic), "1", `held stops_away on failure #${i}`);
      }

      // A 4th consecutive failure exhausts the budget: distance falls back to
      // haversine (>2200 m) and stops_away blanks to None (route mode off).
      publishCalls.length = 0;
      bridge.publishStudentLocation(
        student,
        at(41.51, -71.98, { logTime: new Date(Date.parse("2026-09-11T13:01:00Z") + 4 * 30000).toISOString() })
      );
      assert.ok(Number(last(distTopic)) > 2200, `expected haversine fallback, got ${last(distTopic)}`);
      assert.equal(last(stopsTopic), "None");
    });

    // Schedule-anchored delay + predicted arrival. The default bridge timezone is
    // America/New_York; the `at()` logTime is 2026-09-11T13:01:00Z (EDT, UTC−4) →
    // 09:01 local = 541 min. A bus at vertex idx1 (cum 1000) is where the schedule
    // put it at 08:54 (534 min), so it is 541 − 534 = 7 min behind → predicted
    // arrival = scheduled 09:01 (541) + 7 = 09:08.
    describe("schedule-anchored delay & predicted arrival", () => {
      it("publishes discovery for delay and predicted_arrival", () => {
        publishCalls.length = 0;
        bridge.publishStudent(makeStudent(routeStop));
        const topics = publishCalls.map((c) => c[0]);
        assert.ok(topics.includes("homeassistant/sensor/myride_student_2008416_delay/config"));
        assert.ok(topics.includes("homeassistant/sensor/myride_student_2008416_predicted_arrival/config"));
      });

      it("publishes signed delay and an ISO predicted arrival for a mid-route bus", () => {
        bridge.publishStudent(makeStudent(routeStop));
        publishCalls.length = 0;
        bridge.publishStudentLocation(makeStudent(routeStop), at(41.51, -72.0)); // cum 1000
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/delay")[1], "7");
        // Predicted 09:08 on 2026-09-11 (EDT) as an offset-aware timestamp.
        assert.equal(
          publishCalls.find((c) => c[0] === "myride/student/2008416/predicted_arrival")[1],
          "2026-09-11T09:08:00-04:00"
        );
      });

      it("reports a negative delay when the bus is ahead of schedule", () => {
        // Bus at vertex idx1 (cum 1000, scheduled 08:54 = 534), but the fix time is
        // 2026-09-11T12:52:00Z → 08:52 local = 532. now − S(cumBus) = 532 − 534 = −2
        // (2 min early). Predicted = scheduled 09:01 (541) + (−2) = 539 = 08:59.
        bridge.publishStudent(makeStudent(routeStop));
        publishCalls.length = 0;
        bridge.publishStudentLocation(
          makeStudent(routeStop),
          at(41.51, -72.0, { logTime: "2026-09-11T12:52:00Z" })
        );
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/delay")[1], "-2");
        assert.equal(
          publishCalls.find((c) => c[0] === "myride/student/2008416/predicted_arrival")[1],
          "2026-09-11T08:59:00-04:00"
        );
      });

      it("still reports delay/predicted while the bus is stopped (unlike ETA)", () => {
        bridge.publishStudent(makeStudent(routeStop));
        publishCalls.length = 0;
        bridge.publishStudentLocation(makeStudent(routeStop), at(41.51, -72.0, { speed: 0 }));
        // ETA goes unknown when stopped, but the schedule-anchored delay is not.
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/eta")[1], "None");
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/delay")[1], "7");
        assert.equal(
          publishCalls.find((c) => c[0] === "myride/student/2008416/predicted_arrival")[1],
          "2026-09-11T09:08:00-04:00"
        );
      });

      it("blanks delay/predicted to None when the stop has no route geometry", () => {
        bridge.publishStudent(makeStudent(plainStop));
        publishCalls.length = 0;
        bridge.publishStudentLocation(makeStudent(plainStop), at(41.51, -72.0));
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/delay")[1], "None");
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/predicted_arrival")[1], "None");
      });

      it("blanks delay/predicted to None once the bus reaches the stop (route distance 0)", () => {
        bridge.publishStudent(makeStudent(routeStop));
        publishCalls.length = 0;
        bridge.publishStudentLocation(makeStudent(routeStop), at(41.53, -72.0)); // at stop vertex
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/delay")[1], "None");
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/predicted_arrival")[1], "None");
      });

      it("blanks delay/predicted to None when the bus is off-route (no trusted snap)", () => {
        bridge.publishStudent(makeStudent(routeStop));
        publishCalls.length = 0;
        bridge.publishStudentLocation(makeStudent(routeStop), at(41.51, -71.98)); // off-route
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/delay")[1], "None");
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/predicted_arrival")[1], "None");
      });
    });

    // Route-derived "stops away": count of upstream stops still ahead of the bus.
    // routeStop.upstreamStopCums = [0, 1000, 2000]; the stop is at cum 3000.
    describe("route-derived stops away", () => {
      it("counts upstream stops still ahead of a mid-route bus", () => {
        bridge.publishStudent(makeStudent(routeStop));
        publishCalls.length = 0;
        bridge.publishStudentLocation(makeStudent(routeStop), at(41.51, -72.0)); // cum 1000
        // Stops at cum 2000 remain ahead; cum 0 and 1000 are passed → 1 stop away.
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/stops_away")[1], "1");
      });

      it("counts all upstream stops when the bus is at the route start", () => {
        bridge.publishStudent(makeStudent(routeStop));
        publishCalls.length = 0;
        bridge.publishStudentLocation(makeStudent(routeStop), at(41.50, -72.0)); // cum 0
        // Stops at cum 1000 and 2000 are ahead (cum 0 is the bus's own position) → 2.
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/stops_away")[1], "2");
      });

      it("reports 0 once the bus passes the last upstream stop", () => {
        bridge.publishStudent(makeStudent(routeStop));
        publishCalls.length = 0;
        bridge.publishStudentLocation(makeStudent(routeStop), at(41.53, -72.0)); // cum 3000 (at stop)
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/stops_away")[1], "0");
      });

      it("publishes None when route mode is unavailable (no geometry)", () => {
        bridge.publishStudent(makeStudent(plainStop));
        publishCalls.length = 0;
        bridge.publishStudentLocation(makeStudent(plainStop), at(41.51, -72.0));
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/stops_away")[1], "None");
      });

      it("publishes None when the bus is off-route", () => {
        bridge.publishStudent(makeStudent(routeStop));
        publishCalls.length = 0;
        bridge.publishStudentLocation(makeStudent(routeStop), at(41.51, -71.98)); // off-route
        assert.equal(publishCalls.find((c) => c[0] === "myride/student/2008416/stops_away")[1], "None");
      });
    });
  });

  describe("disconnect()", () => {
    it("publishes offline status and ends client", async () => {
      publishCalls.length = 0;
      await bridge.disconnect();

      const offlineCall = publishCalls.find(
        (c) => c[0] === "myride/bridge/status" && c[1] === "offline"
      );
      assert.ok(offlineCall, "should publish offline status");
    });
  });
});
