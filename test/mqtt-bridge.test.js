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

// Stub out the DNS/TCP pre-flight check so no real network calls are made
const origCheckConnectivity = MqttBridge.prototype._checkConnectivity;
MqttBridge.prototype._checkConnectivity = () => {};

describe("MqttBridge", () => {
  let bridge;

  beforeEach(() => {
    publishCalls.length = 0;

    bridge = new MqttBridge({
      broker: "mqtt://localhost",
      port: 1883,
      username: "user",
      password: "pass",
      topicPrefix: "myride",
    });
    bridge.discoveredBuses.clear();
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

  describe("_publishDiscovery()", () => {
    it("publishes 4 discovery configs on first call", () => {
      publishCalls.length = 0;
      bridge._publishDiscovery("BUS 042");

      const topics = publishCalls.map((c) => c[0]);
      assert.ok(topics.includes("homeassistant/device_tracker/myride_bus_042/config"));
      assert.ok(topics.includes("homeassistant/sensor/myride_bus_042_speed/config"));
      assert.ok(topics.includes("homeassistant/sensor/myride_bus_042_heading/config"));
      assert.ok(topics.includes("homeassistant/binary_sensor/myride_bus_042_moving/config"));
    });

    it("publishes with retain flag", () => {
      publishCalls.length = 0;
      bridge._publishDiscovery("BUS 042");

      for (const call of publishCalls) {
        assert.deepEqual(call[2], { retain: true });
      }
    });

    it("is idempotent — second call does not publish again", () => {
      publishCalls.length = 0;
      bridge._publishDiscovery("BUS 042");
      const firstCount = publishCalls.length;
      bridge._publishDiscovery("BUS 042");
      assert.equal(publishCalls.length, firstCount);
    });

    it("discovery config includes correct device info", () => {
      publishCalls.length = 0;
      bridge._publishDiscovery("BUS 042");

      const trackerPayload = JSON.parse(publishCalls[0][1]);
      assert.equal(trackerPayload.device.manufacturer, "Tyler Technologies");
      assert.equal(trackerPayload.device.model, "MyRide K-12");
      assert.deepEqual(trackerPayload.device.identifiers, ["myride_bus_042"]);
    });
  });

  describe("publishLocation()", () => {
    it("skips when assetUniqueId is falsy", () => {
      publishCalls.length = 0;
      bridge.publishLocation({ assetUniqueId: null });
      // Only constructor publishes (connect event); this should add nothing
      assert.equal(publishCalls.length, 0);
    });

    it("publishes state, attributes, speed, heading, moving", () => {
      // Pre-discover so we can isolate location publishes
      bridge._publishDiscovery("BUS 042");
      publishCalls.length = 0;

      bridge.publishLocation({
        assetUniqueId: "BUS 042",
        latitude: 40.689,
        longitude: -74.044,
        heading: 138,
        speed: 26,
        logTime: "2026-03-18T18:37:41Z",
      });

      const topics = publishCalls.map((c) => c[0]);
      assert.ok(topics.includes("myride/bus_042/attributes"));
      assert.ok(topics.includes("myride/bus_042/speed"));
      assert.ok(topics.includes("myride/bus_042/heading"));
      assert.ok(topics.includes("myride/bus_042/moving"));
    });

    it("publishes speed as string", () => {
      bridge._publishDiscovery("BUS 042");
      publishCalls.length = 0;
      bridge.publishLocation({
        assetUniqueId: "BUS 042",
        latitude: 0,
        longitude: 0,
        heading: 0,
        speed: 42,
        logTime: "",
      });

      const speedCall = publishCalls.find((c) => c[0] === "myride/bus_042/speed");
      assert.equal(speedCall[1], "42");
    });

    it("publishes moving ON when speed > 0", () => {
      bridge._publishDiscovery("BUS 042");
      publishCalls.length = 0;
      bridge.publishLocation({
        assetUniqueId: "BUS 042",
        latitude: 0,
        longitude: 0,
        heading: 0,
        speed: 10,
        logTime: "",
      });

      const movingCall = publishCalls.find((c) => c[0] === "myride/bus_042/moving");
      assert.equal(movingCall[1], "ON");
    });

    it("publishes moving OFF when speed is 0", () => {
      bridge._publishDiscovery("BUS 042");
      publishCalls.length = 0;
      bridge.publishLocation({
        assetUniqueId: "BUS 042",
        latitude: 0,
        longitude: 0,
        heading: 0,
        speed: 0,
        logTime: "",
      });

      const movingCall = publishCalls.find((c) => c[0] === "myride/bus_042/moving");
      assert.equal(movingCall[1], "OFF");
    });

    it("publishes attributes with correct lat/lng", () => {
      bridge._publishDiscovery("BUS 042");
      publishCalls.length = 0;
      bridge.publishLocation({
        assetUniqueId: "BUS 042",
        latitude: 40.689,
        longitude: -74.044,
        heading: 138,
        speed: 26,
        logTime: "2026-03-18T18:37:41Z",
      });

      const attrCall = publishCalls.find((c) => c[0] === "myride/bus_042/attributes");
      const attrs = JSON.parse(attrCall[1]);
      assert.equal(attrs.latitude, 40.689);
      assert.equal(attrs.longitude, -74.044);
      assert.equal(attrs.gps_accuracy, 10);
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
