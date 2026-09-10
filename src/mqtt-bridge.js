/**
 * mqtt-bridge.js — Publish MyRide data to MQTT for Home Assistant.
 *
 * Entities are student-centric: each student is one HA device whose entities
 * follow whichever bus the student's current run maps to today (substitute or not).
 * Created via MQTT Discovery, per student:
 *   - device_tracker.myride_student_<id>          — map pin with lat/lng
 *   - sensor.myride_student_<id>_speed            — speed in mph
 *   - sensor.myride_student_<id>_heading          — compass heading
 *   - binary_sensor.myride_student_<id>_moving    — whether the bus is in motion
 *   - sensor.myride_student_<id>_bus              — which bus the student is on today
 *   - binary_sensor.myride_student_<id>_substitute — whether today's bus is a substitute
 *
 * The device_tracker uses the "json_attributes" pattern so HA gets
 * latitude, longitude, and gps_accuracy in one payload.
 */

const mqtt = require("mqtt");
const { haversineMeters } = require("./student-tracker");

class MqttBridge {
  /**
   * @param {object} opts
   * @param {string} opts.broker       — e.g. "mqtt://homeassistant.local"
   * @param {string} [opts.username]
   * @param {string} [opts.password]
   * @param {string} [opts.topicPrefix="myride"]
   * @param {number} [opts.approachRadiusMeters=500] — distance within which the
   *   "Approaching My Stop" binary sensor turns ON.
   */
  constructor({ broker, port = 1883, username, password, topicPrefix = "myride", approachRadiusMeters = 500 }) {
    this.topicPrefix = topicPrefix;
    this.approachRadiusMeters = approachRadiusMeters;
    this.discoveredStudents = new Set();



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
   * Remove legacy bus-keyed entities from Home Assistant.
   *
   * Earlier versions of the bridge published retained discovery configs for
   * per-bus devices. The bridge is now student-centric, so publish empty
   * retained payloads to those topics to delete the stale entities on upgrade.
   * Idempotent: HA ignores empty payloads for topics that were never set.
   */
  clearBusDiscovery(assetUniqueId) {
    if (!assetUniqueId) return;
    const busId = this._sanitizeId(assetUniqueId);
    const legacyTopics = [
      `homeassistant/device_tracker/myride_${busId}/config`,
      `homeassistant/sensor/myride_${busId}_speed/config`,
      `homeassistant/sensor/myride_${busId}_heading/config`,
      `homeassistant/binary_sensor/myride_${busId}_moving/config`,
    ];
    for (const topic of legacyTopics) {
      this.client.publish(topic, "", { retain: true });
    }
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

  /**
   * Publish HA discovery + state for a student's bus assignment.
   * Idempotent per student; re-publishes state on every call.
   *
   * @param {object} student — normalized student from StudentTracker
   */
  publishStudent(student) {
    const { uniqueId, firstName, lastName, currentRun, todaysRuns } = student;
    if (!uniqueId || !currentRun) return;

    const studentId = this._sanitizeId(uniqueId);
    const displayName = `${firstName} ${lastName}`.trim() || uniqueId;
    const stateTopic = `${this.topicPrefix}/student/${studentId}/state`;
    const attributesTopic = `${this.topicPrefix}/student/${studentId}/attributes`;
    const substituteTopic = `${this.topicPrefix}/student/${studentId}/substitute`;
    const gpsStateTopic = `${this.topicPrefix}/student/${studentId}/gps_state`;
    const gpsAttributesTopic = `${this.topicPrefix}/student/${studentId}/gps_attributes`;
    const speedTopic = `${this.topicPrefix}/student/${studentId}/speed`;
    const headingTopic = `${this.topicPrefix}/student/${studentId}/heading`;
    const movingTopic = `${this.topicPrefix}/student/${studentId}/moving`;
    const myStopTopic = `${this.topicPrefix}/student/${studentId}/my_stop`;
    const myStopAttributesTopic = `${this.topicPrefix}/student/${studentId}/my_stop_attributes`;
    const distanceTopic = `${this.topicPrefix}/student/${studentId}/distance_to_stop`;
    const etaTopic = `${this.topicPrefix}/student/${studentId}/eta`;
    const approachingTopic = `${this.topicPrefix}/student/${studentId}/approaching`;

    const availability = {
      topic: `${this.topicPrefix}/bridge/status`,
      payload_available: "online",
      payload_not_available: "offline",
    };
    const deviceConfig = {
      identifiers: [`myride_student_${studentId}`],
      name: displayName,
      manufacturer: "Tyler Technologies",
      model: "MyRide K-12",
    };

    if (!this.discoveredStudents.has(studentId)) {
      this.discoveredStudents.add(studentId);

      // Device tracker (provides map position; follows today's bus)
      this.client.publish(
        `homeassistant/device_tracker/myride_student_${studentId}/config`,
        JSON.stringify({
          name: `${displayName} Location`,
          unique_id: `myride_student_${studentId}_location`,
          state_topic: gpsStateTopic,
          json_attributes_topic: gpsAttributesTopic,
          source_type: "gps",
          availability,
          device: deviceConfig,
          icon: "mdi:bus-school",
        }),
        { retain: true }
      );

      // Speed sensor
      this.client.publish(
        `homeassistant/sensor/myride_student_${studentId}_speed/config`,
        JSON.stringify({
          name: `${displayName} Speed`,
          unique_id: `myride_student_${studentId}_speed`,
          state_topic: speedTopic,
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
        `homeassistant/sensor/myride_student_${studentId}_heading/config`,
        JSON.stringify({
          name: `${displayName} Heading`,
          unique_id: `myride_student_${studentId}_heading`,
          state_topic: headingTopic,
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
        `homeassistant/binary_sensor/myride_student_${studentId}_moving/config`,
        JSON.stringify({
          name: `${displayName} Moving`,
          unique_id: `myride_student_${studentId}_moving`,
          state_topic: movingTopic,
          payload_on: "ON",
          payload_off: "OFF",
          availability,
          device: deviceConfig,
          icon: "mdi:bus-clock",
        }),
        { retain: true }
      );

      // Active bus sensor
      this.client.publish(
        `homeassistant/sensor/myride_student_${studentId}_bus/config`,
        JSON.stringify({
          name: `${displayName} Bus Today`,
          unique_id: `myride_student_${studentId}_bus`,
          state_topic: stateTopic,
          json_attributes_topic: attributesTopic,
          availability,
          device: deviceConfig,
          icon: "mdi:bus-school",
        }),
        { retain: true }
      );

      // Substitute binary sensor
      this.client.publish(
        `homeassistant/binary_sensor/myride_student_${studentId}_substitute/config`,
        JSON.stringify({
          name: `${displayName} Substitute Bus`,
          unique_id: `myride_student_${studentId}_substitute`,
          state_topic: substituteTopic,
          payload_on: "ON",
          payload_off: "OFF",
          device_class: "problem",
          availability,
          device: deviceConfig,
          icon: "mdi:bus-alert",
        }),
        { retain: true }
      );

      // My Stop sensor (the student's own stop; attributes carry the schedule)
      this.client.publish(
        `homeassistant/sensor/myride_student_${studentId}_my_stop/config`,
        JSON.stringify({
          name: `${displayName} My Stop`,
          unique_id: `myride_student_${studentId}_my_stop`,
          state_topic: myStopTopic,
          json_attributes_topic: myStopAttributesTopic,
          availability,
          device: deviceConfig,
          icon: "mdi:map-marker",
        }),
        { retain: true }
      );

      // Distance to my stop (meters)
      this.client.publish(
        `homeassistant/sensor/myride_student_${studentId}_distance_to_stop/config`,
        JSON.stringify({
          name: `${displayName} Distance to Stop`,
          unique_id: `myride_student_${studentId}_distance_to_stop`,
          state_topic: distanceTopic,
          unit_of_measurement: "m",
          device_class: "distance",
          state_class: "measurement",
          availability,
          device: deviceConfig,
          icon: "mdi:map-marker-distance",
        }),
        { retain: true }
      );

      // ETA to my stop (minutes)
      this.client.publish(
        `homeassistant/sensor/myride_student_${studentId}_eta/config`,
        JSON.stringify({
          name: `${displayName} ETA to Stop`,
          unique_id: `myride_student_${studentId}_eta`,
          state_topic: etaTopic,
          unit_of_measurement: "min",
          device_class: "duration",
          state_class: "measurement",
          availability,
          device: deviceConfig,
          icon: "mdi:clock-outline",
        }),
        { retain: true }
      );

      // Approaching my stop (the automation trigger)
      this.client.publish(
        `homeassistant/binary_sensor/myride_student_${studentId}_approaching/config`,
        JSON.stringify({
          name: `${displayName} Approaching Stop`,
          unique_id: `myride_student_${studentId}_approaching`,
          state_topic: approachingTopic,
          payload_on: "ON",
          payload_off: "OFF",
          availability,
          device: deviceConfig,
          icon: "mdi:bus-marker",
        }),
        { retain: true }
      );

      console.log(`[MQTT] Published HA discovery for student ${displayName}`);
    }

    // State: active bus
    this.client.publish(stateTopic, currentRun.activeVehicle || "unknown", { retain: true });

    // Attributes
    this.client.publish(
      attributesTopic,
      JSON.stringify({
        student_name: displayName,
        regular_bus: currentRun.busNumber,
        active_bus: currentRun.activeVehicle,
        is_substitute: currentRun.isSubstitute,
        run_id: currentRun.runId,
        todays_runs: todaysRuns.map((r) => ({
          run_id: r.runId,
          regular_bus: r.busNumber,
          active_bus: r.activeVehicle,
          is_substitute: r.isSubstitute,
        })),
      }),
      { retain: true }
    );

    // Substitute flag
    this.client.publish(
      substituteTopic,
      currentRun.isSubstitute ? "ON" : "OFF",
      { retain: true }
    );

    // My stop: name as state, schedule + position in run as attributes.
    const myStop = currentRun.myStop || null;
    this.client.publish(myStopTopic, (myStop && myStop.name) || "unknown", { retain: true });
    this.client.publish(
      myStopAttributesTopic,
      JSON.stringify({
        stop_id: myStop ? myStop.stopId : null,
        address: myStop ? myStop.address : null,
        action: myStop ? myStop.actionType : null, // Pickup (AM) / Dropoff (PM)
        scheduled_time: myStop ? myStop.stopTime : null,
        latitude: myStop ? myStop.lat : null,
        longitude: myStop ? myStop.lng : null,
        stop_number: currentRun.myStopSeq == null ? null : currentRun.myStopSeq + 1,
        total_stops: currentRun.totalStops || null,
        schedule: currentRun.stopSchedule || [],
      }),
      { retain: true }
    );
  }

  /**
   * Publish a bus location update under a student's topics so the student's
   * device_tracker follows whichever bus their current run maps to today.
   *
   * @param {object} student  — normalized student from StudentTracker
   * @param {object} location — NewLocation payload from SignalR (the active bus)
   */
  publishStudentLocation(student, location) {
    if (!student || !student.uniqueId) return;
    const studentId = this._sanitizeId(student.uniqueId);
    // Discovery must exist before state is meaningful to HA
    if (!this.discoveredStudents.has(studentId)) return;

    const { latitude, longitude, heading, speed, logTime, assetUniqueId } = location;
    const currentRun = student.currentRun || {};
    const isMoving = speed > 0;

    // Attributes for device_tracker (latitude/longitude are magic keys HA uses for map)
    this.client.publish(
      `${this.topicPrefix}/student/${studentId}/gps_attributes`,
      JSON.stringify({
        latitude,
        longitude,
        gps_accuracy: 10,
        heading,
        speed,
        active_bus: assetUniqueId,
        regular_bus: currentRun.busNumber,
        is_substitute: currentRun.isSubstitute,
        last_update: logTime,
      }),
      { retain: true }
    );

    // Reset payload so HA clears location_name and uses GPS zone matching
    this.client.publish(`${this.topicPrefix}/student/${studentId}/gps_state`, "None", { retain: true });

    // Individual sensors
    this.client.publish(`${this.topicPrefix}/student/${studentId}/speed`, String(speed), { retain: true });
    this.client.publish(`${this.topicPrefix}/student/${studentId}/heading`, String(heading), { retain: true });
    this.client.publish(
      `${this.topicPrefix}/student/${studentId}/moving`,
      isMoving ? "ON" : "OFF",
      { retain: true }
    );

    // Stop tracking: distance / ETA / approaching, keyed off the student's own
    // stop. GPS-derived from the live bus position and the authoritative stop
    // pin, so it updates on every location event (not just each 15-min poll).
    this._publishStopProgress(studentId, currentRun.myStop, latitude, longitude, speed);
  }

  /**
   * Compute and publish distance/ETA/approaching for a student's own stop.
   * No-op when the stop has no coordinates.
   *
   * @param {string} studentId — sanitized id
   * @param {object|null} myStop — normalized stop ({lat, lng, ...})
   * @param {number} busLat
   * @param {number} busLng
   * @param {number} speedMph — current bus speed
   */
  _publishStopProgress(studentId, myStop, busLat, busLng, speedMph) {
    const distTopic = `${this.topicPrefix}/student/${studentId}/distance_to_stop`;
    const etaTopic = `${this.topicPrefix}/student/${studentId}/eta`;
    const approachingTopic = `${this.topicPrefix}/student/${studentId}/approaching`;

    if (!myStop || !Number.isFinite(myStop.lat) || !Number.isFinite(myStop.lng)) {
      // Unknown stop position — publish empty states rather than stale numbers.
      this.client.publish(distTopic, "", { retain: true });
      this.client.publish(etaTopic, "", { retain: true });
      this.client.publish(approachingTopic, "OFF", { retain: true });
      return;
    }

    const meters = haversineMeters(busLat, busLng, myStop.lat, myStop.lng);
    if (meters == null) return;

    this.client.publish(distTopic, String(Math.round(meters)), { retain: true });

    // ETA estimate: distance / current speed. Only meaningful while moving;
    // when stopped we leave ETA blank rather than emit Infinity.
    if (speedMph > 0) {
      const metersPerMin = speedMph * 26.8224; // 1 mph = 26.8224 m/min
      const etaMin = Math.round(meters / metersPerMin);
      this.client.publish(etaTopic, String(etaMin), { retain: true });
    } else {
      this.client.publish(etaTopic, "", { retain: true });
    }

    const approaching = meters <= this.approachRadiusMeters;
    this.client.publish(approachingTopic, approaching ? "ON" : "OFF", { retain: true });
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
