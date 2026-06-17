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
