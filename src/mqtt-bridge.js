/**
 * mqtt-bridge.js — Publish MyRide bus locations to MQTT for Home Assistant.
 *
 * Creates HA entities via MQTT Discovery:
 *   - device_tracker.myride_bus_042  — map pin with lat/lng
 *   - sensor.myride_bus_042_speed    — speed in mph
 *   - sensor.myride_bus_042_heading  — compass heading
 *   - binary_sensor.myride_bus_042_moving — whether the bus is in motion
 *
 * The device_tracker uses the "json_attributes" pattern so HA gets
 * latitude, longitude, and gps_accuracy in one payload.
 */

const mqtt = require("mqtt");

class MqttBridge {
  /**
   * @param {object} opts
   * @param {string} opts.broker       — e.g. "mqtt://homeassistant.local"
   * @param {string} [opts.username]
   * @param {string} [opts.password]
   * @param {string} [opts.topicPrefix="myride"]
   */
  constructor({ broker, port = 1883, username, password, topicPrefix = "myride" }) {
    this.topicPrefix = topicPrefix;
    this.discoveredBuses = new Set();



    const url = broker.startsWith("mqtt://") ? broker : `mqtt://${broker}`;
    console.log(`[MQTT] Connecting to ${url}:${port} ...`);

    // Pre-flight DNS/TCP check
    this._checkConnectivity(broker.replace(/^mqtt:\/\//, ""), port);

    this.client = mqtt.connect(url, {
      port,
      username,
      password,
      connectTimeout: 10_000,
      reconnectPeriod: 5_000,
      will: {
        topic: `${topicPrefix}/bridge/status`,
        payload: "offline",
        retain: true,
      },
    });

    this.client.on("connect", () => {
      console.log("[MQTT] Connected to broker");
      this.client.publish(
        `${topicPrefix}/bridge/status`,
        "online",
        { retain: true }
      );
    });

    this.client.on("reconnect", () => {
      console.warn("[MQTT] Reconnecting...");
    });

    this.client.on("offline", () => {
      console.warn("[MQTT] Client went offline");
    });

    this.client.on("close", () => {
      console.warn("[MQTT] Connection closed");
    });

    this.client.on("error", (err) => {
      console.error(`[MQTT] Error: ${err.message} (code: ${err.code || "n/a"})`);
      if (err.code === "EHOSTUNREACH" || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT") {
        console.error(`[MQTT] Cannot reach broker at ${url}:${port}`);
        console.error("[MQTT] Check: 1) broker hostname/IP, 2) port open, 3) firewall/network");
      }
    });
  }

  /**
   * Pre-flight TCP check so we get a clear diagnostic before mqtt.connect times out.
   */
  _checkConnectivity(host, port) {
    const net = require("net");
    const dns = require("dns");

    dns.lookup(host, (dnsErr, address) => {
      if (dnsErr) {
        console.error(`[MQTT] DNS lookup failed for "${host}": ${dnsErr.message}`);
        return;
      }
      console.log(`[MQTT] Resolved "${host}" → ${address}`);

      const socket = new net.Socket();
      const timeout = 5_000;
      socket.setTimeout(timeout);

      socket.connect(port, address, () => {
        console.log(`[MQTT] TCP port ${port} is reachable at ${address}`);
        socket.destroy();
      });

      socket.on("timeout", () => {
        console.error(`[MQTT] TCP connection to ${address}:${port} timed out after ${timeout}ms`);
        socket.destroy();
      });

      socket.on("error", (err) => {
        console.error(`[MQTT] TCP check failed: ${err.message} (${address}:${port})`);
      });
    });
  }

  /**
   * Sanitize a bus ID for use in MQTT topics and HA entity IDs.
   * "BUS 042" → "bus_042"
   */
  _sanitizeId(assetUniqueId) {
    return assetUniqueId.toLowerCase().replace(/\s+/g, "_");
  }

  /**
   * Publish MQTT Discovery configs for a bus (only once per bus).
   */
  _publishDiscovery(assetUniqueId) {
    if (this.discoveredBuses.has(assetUniqueId)) return;
    this.discoveredBuses.add(assetUniqueId);

    const busId = this._sanitizeId(assetUniqueId);
    const deviceConfig = {
      identifiers: [`myride_${busId}`],
      name: `School Bus ${assetUniqueId}`,
      manufacturer: "Tyler Technologies",
      model: "MyRide K-12",
      sw_version: "1.0",
    };
    const availability = {
      topic: `${this.topicPrefix}/bridge/status`,
      payload_available: "online",
      payload_not_available: "offline",
    };

    // Device tracker (provides map position)
    this.client.publish(
      `homeassistant/device_tracker/myride_${busId}/config`,
      JSON.stringify({
        name: `${assetUniqueId} Location`,
        unique_id: `myride_${busId}_location`,
        // state_topic: `${this.topicPrefix}/${busId}/state`,
        json_attributes_topic: `${this.topicPrefix}/${busId}/attributes`,
        source_type: "gps",
        availability,
        device: deviceConfig,
        icon: "mdi:bus-school",
      }),
      { retain: true }
    );

    // Speed sensor
    this.client.publish(
      `homeassistant/sensor/myride_${busId}_speed/config`,
      JSON.stringify({
        name: `${assetUniqueId} Speed`,
        unique_id: `myride_${busId}_speed`,
        state_topic: `${this.topicPrefix}/${busId}/speed`,
        unit_of_measurement: "mph",
        device_class: "speed",
        state_class: "measurement",
        availability,
        device: deviceConfig,
        icon: "mdi:speedometer",
      }),
      { retain: true }
    );

    // Heading sensor
    this.client.publish(
      `homeassistant/sensor/myride_${busId}_heading/config`,
      JSON.stringify({
        name: `${assetUniqueId} Heading`,
        unique_id: `myride_${busId}_heading`,
        state_topic: `${this.topicPrefix}/${busId}/heading`,
        unit_of_measurement: "°",
        state_class: "measurement",
        availability,
        device: deviceConfig,
        icon: "mdi:compass-outline",
      }),
      { retain: true }
    );

    // Moving binary sensor
    this.client.publish(
      `homeassistant/binary_sensor/myride_${busId}_moving/config`,
      JSON.stringify({
        name: `${assetUniqueId} Moving`,
        unique_id: `myride_${busId}_moving`,
        state_topic: `${this.topicPrefix}/${busId}/moving`,
        payload_on: "ON",
        payload_off: "OFF",
        availability,
        device: deviceConfig,
        icon: "mdi:bus-clock",
      }),
      { retain: true }
    );

    console.log(`[MQTT] Published HA discovery for ${assetUniqueId}`);
  }

  /**
   * Publish a NewLocation update from SignalR to MQTT.
   * @param {object} location — NewLocation payload from SignalR
   */
  publishLocation(location) {
    const { assetUniqueId, latitude, longitude, heading, speed, logTime } =
      location;
    if (!assetUniqueId) return;

    // Publish discovery config (idempotent)
    this._publishDiscovery(assetUniqueId);

    const busId = this._sanitizeId(assetUniqueId);
    const isMoving = speed > 0;

    // Device tracker state (home/not_home is standard, but for a bus we just
    // need the attributes for map display — state can be a zone or "not_home")
    //  this.client.publish(`${this.topicPrefix}/${busId}/state`, "not_home", { retain: true });

    // Attributes for device_tracker (latitude/longitude are magic keys HA uses for map)
    this.client.publish(
      `${this.topicPrefix}/${busId}/attributes`,
      JSON.stringify({
        latitude,
        longitude,
        gps_accuracy: 10,
        heading,
        speed,
        bus_id: assetUniqueId,
        last_update: logTime,
        asset_id: location.assetId,
        vendor_id: location.vendorId,
        visible_run: location.visibleRunName,
      }),
      { retain: true }
    );

    // Individual sensors
    this.client.publish(`${this.topicPrefix}/${busId}/speed`, String(speed), { retain: true });
    this.client.publish(`${this.topicPrefix}/${busId}/heading`, String(heading), { retain: true });
    this.client.publish(
      `${this.topicPrefix}/${busId}/moving`,
      isMoving ? "ON" : "OFF",
      { retain: true }
    );
  }

  /**
   * Publish HA discovery config for a bridge-level credential status sensor.
   * Call once after MQTT connects.
   */
  publishCredentialStatusDiscovery() {
    const deviceConfig = {
      identifiers: ["myride_bridge"],
      name: "MyRide Bridge",
      manufacturer: "Tyler Technologies",
      model: "MyRide K-12 Bridge",
    };
    const availability = {
      topic: `${this.topicPrefix}/bridge/status`,
      payload_available: "online",
      payload_not_available: "offline",
    };

    this.client.publish(
      "homeassistant/binary_sensor/myride_bridge_credentials/config",
      JSON.stringify({
        name: "MyRide Credentials",
        unique_id: "myride_bridge_credentials",
        state_topic: `${this.topicPrefix}/bridge/credentials`,
        payload_on: "ON",
        payload_off: "OFF",
        device_class: "problem",
        availability,
        device: deviceConfig,
        icon: "mdi:key-alert",
      }),
      { retain: true }
    );
  }

  /**
   * Publish credential status.
   * @param {boolean} expired — true if the refresh token is expired/invalid
   */
  publishCredentialStatus(expired) {
    this.client.publish(
      `${this.topicPrefix}/bridge/credentials`,
      expired ? "ON" : "OFF",
      { retain: true }
    );
  }

  async disconnect() {
    this.client.publish(
      `${this.topicPrefix}/bridge/status`,
      "offline",
      { retain: true }
    );
    return new Promise((resolve) => {
      this.client.end(false, {}, resolve);
    });
  }
}

module.exports = { MqttBridge };
