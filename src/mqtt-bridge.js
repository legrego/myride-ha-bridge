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
const { haversineMeters, nearestVertexCumulative } = require("./student-tracker");

// Max snap distance (m) from the live bus to the nearest route vertex before we
// treat the fix as off-route/GPS-noise and fall back to haversine.
const ROUTE_SNAP_MAX_METERS = 150;
// Allowed backward movement (m) in cumulative route distance between frames before
// we reject the reading as a wrong-pass snap on a loop/U-turn. Backward motion is
// never legitimate within a run (cumulative only grows; a genuine restart resets
// this baseline via the stop-identity change), so this is a small jitter tolerance.
const ROUTE_MONOTONIC_TOLERANCE_METERS = 50;
// Forward progress allowance is time-based: a reading may advance the cumulative
// position by at most BASE + (seconds since the previous frame) × MAX_PLAUSIBLE_MPS.
// This is what separates a genuine long gap (e.g. a SignalR reconnect backing off
// up to ~60 s: large elapsed → large allowance → the guard re-acquires) from a
// deterministic wrong-pass snap at a loop/crossing (normal cadence → small
// allowance → stays rejected every frame, never promoted). Elapsed is measured
// frame-to-frame (not since the last *accepted* frame) so a persistent wrong snap
// can't accrue unbounded slack. BASE is a floor covering vertex spacing / GPS
// jitter when elapsed is ~0 or the timestamp is unknown.
const ROUTE_FORWARD_BASE_METERS = 150;
const ROUTE_MAX_PLAUSIBLE_MPS = 30; // ~67 mph, generous for a school bus

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
    // Guard against NaN/≤0 (e.g. a malformed APPROACH_RADIUS_METERS): an invalid
    // radius would make `meters <= radius` always false and silently disable the
    // "approaching" trigger. Fall back to the documented 500 m default.
    this.approachRadiusMeters =
      Number.isFinite(approachRadiusMeters) && approachRadiusMeters > 0
        ? approachRadiusMeters
        : 500;
    this.discoveredStudents = new Set();
    // studentId → last published "run|bus|stop" key, so we can clear stale
    // distance/ETA/approaching when any of them changes or disappears. Keying on
    // stopId alone is insufficient: the home stop shares one stopId across the AM
    // and PM runs, so only the run/active-vehicle change marks the transition.
    this.lastStopKeyByStudent = new Map();
    // studentId → { cum, seenMs }: last accepted cumulative route distance of the
    // bus (meters from the run start) and the source timestamp of the last frame
    // seen (accepted or not). Used by _routeDistanceMeters to reject wrong-pass
    // snaps on a loop/U-turn — backward to an earlier pass, or further forward than
    // the elapsed source time can justify — while re-acquiring after a genuine long
    // gap. Reset whenever stop progress is cleared (stop identity change / no run).
    this.lastRouteCumByStudent = new Map();

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
    if (!uniqueId) return;

    const studentId = this._sanitizeId(uniqueId);

    // No run today (e.g. runInfo empty on a non-school day): normalizeStudent
    // returns currentRun=null. Clear any retained stop/progress state so HA
    // doesn't keep showing a previous day's stop or a stale "approaching=ON".
    if (!currentRun) {
      if (this.discoveredStudents.has(studentId)) {
        this.client.publish(`${this.topicPrefix}/student/${studentId}/my_stop`, "unknown", { retain: true });
        this._clearStopProgress(studentId);
      }
      this.lastStopKeyByStudent.delete(studentId);
      return;
    }
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
          // Pin the display unit to meters. Without this, HA's imperial unit
          // system auto-converts a "distance" sensor to feet in the registry
          // (suggested_unit_of_measurement), which breaks downstream math that
          // assumes meters. Only affects fresh installs; existing entities keep
          // whatever unit is already stamped in their registry override.
          suggested_unit_of_measurement: "m",
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

    // Clear stale live-progress topics when the run, active vehicle, or stop
    // changes (e.g. the poll switched from the AM to the PM run — which share a
    // stop id but differ in run/bus), or when there is no stop. Otherwise the
    // retained distance/ETA/approaching values from the previous bus linger until
    // the next matching location — indefinitely if the new run has no active bus
    // yet. Fresh values are republished by publishStudentLocation().
    const curKey = `${currentRun.runId}|${currentRun.activeVehicle}|${myStop ? myStop.stopId : "none"}`;
    if (curKey !== this.lastStopKeyByStudent.get(studentId)) {
      this._clearStopProgress(studentId);
      this.lastStopKeyByStudent.set(studentId, curKey);
    }
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
    // logTime feeds the route guard's time-based forward allowance.
    this._publishStopProgress(studentId, currentRun.myStop, latitude, longitude, speed, Date.parse(logTime));
  }

  /**
   * Blank the live-progress topics (distance/ETA empty, approaching OFF) so no
   * stale value from a previous stop lingers. Used when the stop is unknown or
   * when the student's stop identity changes.
   *
   * @param {string} studentId — sanitized id
   */
  _clearStopProgress(studentId) {
    this.client.publish(`${this.topicPrefix}/student/${studentId}/distance_to_stop`, "", { retain: true });
    this.client.publish(`${this.topicPrefix}/student/${studentId}/eta`, "", { retain: true });
    this.client.publish(`${this.topicPrefix}/student/${studentId}/approaching`, "OFF", { retain: true });
    // Drop the monotonic route-distance baseline: a new/absent stop means the
    // cumulative frame changed, so the previous bus position is no longer comparable.
    this.lastRouteCumByStudent.delete(studentId);
  }

  /**
   * Road-following distance (meters) from the live bus to the student's stop,
   * using the precomputed route polyline on `myStop`. Returns null when route
   * geometry is unavailable, the bus is off-route, or the reading fails the
   * wrong-pass guard (backward, or further forward than the elapsed source time
   * can justify) — in every such case the caller falls back to haversine.
   *
   * @param {string} studentId — sanitized id (keys the wrong-pass guard)
   * @param {object} myStop — normalized stop; needs routePolyline, cumulativeMeters,
   *   cumulativeAtStopMeters (attached by StudentTracker.attachRouteGeometry)
   * @param {number} busLat
   * @param {number} busLng
   * @param {number} [nowMs] — source timestamp (ms) of this fix, for the forward
   *   allowance; when unknown the allowance falls back to BASE only.
   * @returns {number|null}
   */
  _routeDistanceMeters(studentId, myStop, busLat, busLng, nowMs) {
    if (
      !myStop ||
      !Array.isArray(myStop.routePolyline) ||
      !Array.isArray(myStop.cumulativeMeters) ||
      !Number.isFinite(myStop.cumulativeAtStopMeters)
    ) {
      return null;
    }

    const snap = nearestVertexCumulative(
      busLat, busLng, myStop.routePolyline, myStop.cumulativeMeters
    );
    if (!snap) return null;

    // Off-route / GPS noise: the bus is nowhere near the route → don't trust the snap.
    if (snap.distMeters > ROUTE_SNAP_MAX_METERS) return null;

    const busCum = snap.cumulativeMeters;
    const prev = this.lastRouteCumByStudent.get(studentId);
    // Always record that we saw a frame at this time, so the *next* frame's forward
    // allowance is measured frame-to-frame (a rejected frame still advances the clock).
    const seenMs = Number.isFinite(nowMs) ? nowMs : (prev ? prev.seenMs : null);

    // Wrong-pass guard: the route can revisit streets (loops/U-turns), so a global
    // nearest-vertex snap can land on the wrong pass. Reject anything that moves
    // backward (never legitimate within a run) or further forward than the elapsed
    // source time plausibly allows. A genuine long gap justifies a large forward
    // jump (→ re-acquire); a deterministic wrong-pass snap at normal cadence never
    // does (→ stays on haversine, frame after frame).
    if (prev) {
      const elapsedSec =
        prev.seenMs != null && Number.isFinite(nowMs)
          ? Math.max(0, (nowMs - prev.seenMs) / 1000)
          : 0;
      const allowedForward = ROUTE_FORWARD_BASE_METERS + elapsedSec * ROUTE_MAX_PLAUSIBLE_MPS;
      const rejected =
        busCum < prev.cum - ROUTE_MONOTONIC_TOLERANCE_METERS ||
        busCum > prev.cum + allowedForward;
      if (rejected) {
        this.lastRouteCumByStudent.set(studentId, { cum: prev.cum, seenMs });
        return null;
      }
    }
    this.lastRouteCumByStudent.set(studentId, { cum: busCum, seenMs });

    return Math.max(0, myStop.cumulativeAtStopMeters - busCum);
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
   * @param {number} [nowMs] — source timestamp (ms) of this fix (for the route guard)
   */
  _publishStopProgress(studentId, myStop, busLat, busLng, speedMph, nowMs) {
    const distTopic = `${this.topicPrefix}/student/${studentId}/distance_to_stop`;
    const etaTopic = `${this.topicPrefix}/student/${studentId}/eta`;
    const approachingTopic = `${this.topicPrefix}/student/${studentId}/approaching`;

    if (!myStop || !Number.isFinite(myStop.lat) || !Number.isFinite(myStop.lng)) {
      // Unknown stop position — publish empty states rather than stale numbers.
      this._clearStopProgress(studentId);
      return;
    }

    // Straight-line distance drives "approaching" (physical proximity is the
    // right trigger) and is the fallback when route geometry is unavailable.
    const haversine = haversineMeters(busLat, busLng, myStop.lat, myStop.lng);

    // Road-following distance when we have route geometry and a trustworthy snap;
    // otherwise fall back to crow-flies. Drives distance_to_stop and the ETA.
    const routeMeters = this._routeDistanceMeters(studentId, myStop, busLat, busLng, nowMs);
    const effectiveMeters = routeMeters != null ? routeMeters : haversine;
    if (effectiveMeters == null) return;

    this.client.publish(distTopic, String(Math.round(effectiveMeters)), { retain: true });

    // ETA estimate: distance / current speed. Only meaningful while moving;
    // when stopped we leave ETA blank rather than emit Infinity.
    if (speedMph > 0) {
      const metersPerMin = speedMph * 26.8224; // 1 mph = 26.8224 m/min
      const etaMin = Math.round(effectiveMeters / metersPerMin);
      this.client.publish(etaTopic, String(etaMin), { retain: true });
    } else {
      this.client.publish(etaTopic, "", { retain: true });
    }

    const approaching = haversine != null && haversine <= this.approachRadiusMeters;
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
