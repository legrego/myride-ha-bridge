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
 *   - sensor.myride_student_<id>_scheduled_time   — scheduled arrival at the student's stop (HH:MM)
 *   - sensor.myride_student_<id>_stops_away       — stops still ahead of the bus before the stop (route-derived)
 *   - sensor.myride_student_<id>_delay            — minutes behind (+) / ahead (−) schedule
 *   - sensor.myride_student_<id>_predicted_arrival — schedule-anchored predicted arrival (timestamp)
 *
 * The device_tracker uses the "json_attributes" pattern so HA gets
 * latitude, longitude, and gps_accuracy in one payload.
 */

const mqtt = require("mqtt");
const {
  haversineMeters,
  nearestVertexCumulative,
  scheduledMinutesAt,
  nowMinutesInTimeZone,
  districtLocalTimestamp,
  DEFAULT_TIME_ZONE,
} = require("./student-tracker");
const { version } = require("./version");

// Discovery `origin` block — surfaces the running build on the HA device page
// (Settings → Devices) so "which bridge version is live" is answerable without a
// dedicated diagnostic entity. sw_version carries the package version plus the
// short commit when known.
const ORIGIN = {
  name: "myride-ha-bridge",
  sw_version:
    version.commitShort && version.commitShort !== "unknown"
      ? `${version.version}+${version.commitShort}`
      : version.version,
  support_url: "https://github.com/legrego/myride-ha-bridge",
};

// Seconds after which HA marks a per-fix sensor (distance/eta/delay/predicted/
// stops_away) unavailable if no new value arrives. Covers the failure mode where
// SignalR stops delivering fixes while MQTT stays connected (the LWT can't) — long
// enough not to flap in a GPS dead-zone, short enough not to show a stale value.
const PER_FIX_EXPIRE_AFTER = 600;

// Max snap distance (m) from the live bus to the nearest route vertex before we
// treat the fix as off-route/GPS-noise and fall back to haversine.
//
// Deliberately NOT widened: live off-route snap distances during a mismatched run
// were observed at 233 → 798 m and *rising monotonically* (the bus driving steadily
// away from a polyline that does not describe its path), which is the "route
// geometry is wrong for this run" signature, not "tolerance too tight" (that would
// be tens of meters). Raising this to accept those would make the confidently-wrong
// snap in _routeDistanceMeters (a fix landing near the wrong part of the polyline)
// *more* frequent, not less. The real defenses are the route-plausibility invariant
// below and correct run selection (pickCurrentRun's late-bus grace).
const ROUTE_SNAP_MAX_METERS = 150;
// A route snap is provably wrong when the road distance it implies is shorter than
// the crow-flies distance to the same stop: a straight line is a lower bound on any
// road path, and the run's cumulative distances are haversine-computed along the
// polyline (so in production road ≥ crow-flies always holds). This margin absorbs the
// two vertex-snap errors (bus + stop pin, each ≤ the trust radii above ⇒ a 300 m
// tight bound) plus GPS jitter / vertex granularity, so only a genuinely implausible
// snap is rejected — e.g. a fix wrongly snapping to the polyline's end reads ~0 m
// route distance while the bus is still kilometers away crow-flies. Unlike a raw
// distance threshold this can never false-positive on a legitimate long final leg:
// it is derived from a geometric invariant rather than a guessed cutoff.
const ROUTE_PLAUSIBILITY_MARGIN_METERS = 500;
// A schedule delay whose magnitude exceeds this (minutes) is not believable for a
// school run and is treated as a bad reading (blanked) rather than published. It is
// the signature of the bus being snapped against the wrong run's schedule (observed:
// −395 min). Symmetric: a bus is no more plausibly 2 h early than 2 h late.
const DELAY_SANITY_MAX_MINUTES = 120;
// Throttle (ms) for the "route mode still off" diagnostic. The first failures of a
// burst are logged as they happen (see _holdOrClearRoute); once route mode is off
// this keeps a heartbeat of the off-route distance + loaded run so a *sustained*
// outage isn't quieter in the logs than a brief one.
const OFF_ROUTE_LOG_THROTTLE_MS = 60_000;
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
// How many consecutive *transient* snap failures (off-route / wrong-pass) we ride
// out by holding the last accepted route position before giving up and returning
// null (→ haversine fallback + None on the route-only sensors). At the 15–30 s fix
// cadence this is ~45–90 s of cover — long enough to bridge the connector-stretch
// gaps where the polyline is thin, short enough that a genuinely stuck feed clears
// quickly (and expire_after: 600 backstops a total feed death regardless). Missing
// geometry is NOT a transient failure and is never held.
const ROUTE_MAX_HELD_FIXES = 3;

class MqttBridge {
  /**
   * @param {object} opts
   * @param {string} opts.broker       — e.g. "mqtt://homeassistant.local"
   * @param {string} [opts.username]
   * @param {string} [opts.password]
   * @param {string} [opts.topicPrefix="myride"]
   * @param {number} [opts.approachRadiusMeters=500] — distance within which the
   *   "Approaching My Stop" binary sensor turns ON.
   * @param {string} [opts.timeZone] — district IANA timezone, used to evaluate the
   *   live fix time against district-local schedule times for the delay model.
   *   Invalid/absent values fall back to the default (see nowMinutesInTimeZone).
   */
  constructor({ broker, port = 1883, username, password, topicPrefix = "myride", approachRadiusMeters = 500, timeZone = DEFAULT_TIME_ZONE }) {
    this.topicPrefix = topicPrefix;
    this.timeZone = timeZone || DEFAULT_TIME_ZONE;
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
    // studentId → { cum, seenMs, failCount }: last accepted cumulative route
    // distance of the bus (meters from the run start); the guard's *reference*
    // timestamp against which the next frame's forward allowance is measured; and
    // how many consecutive transient snap failures have occurred since the last
    // accepted fix. seenMs is NOT simply "the last frame seen": it is advanced on an
    // accepted fix and on a wrong-pass rejection (so a recurring wrong-pass snap
    // can't accrue slack), but *preserved* across off-route holds (so re-acquisition
    // after a connector gap measures from the last accepted fix — see
    // _holdOrClearRoute). Used by _routeDistanceMeters to (a) reject wrong-pass snaps
    // on a loop/U-turn — backward to an earlier pass, or further forward than the
    // elapsed reference time can justify — while re-acquiring after a genuine long
    // gap, and (b) hold the last accepted position through a short burst of transient
    // failures (off-route connector stretches / wrong-pass) before giving up. Reset
    // whenever stop progress is cleared (stop identity change / no run).
    this.lastRouteCumByStudent = new Map();
    // studentId → bool: whether the last fix was tracked in route mode (a trusted
    // snap, held or accepted). Drives the route_snap_ok diagnostic sensor and the
    // one-line "route mode acquired" log on each (re)acquisition.
    this.routeModeActiveByStudent = new Map();
    // studentId → ms of the last throttled "route mode still off" log, so a sustained
    // off-route outage logs a heartbeat without flooding (see OFF_ROUTE_LOG_THROTTLE_MS).
    this.lastOffRouteLogMsByStudent = new Map();

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
        // "None" is HA's documented sentinel for the unknown state (an empty string
        // is *ignored* on a numeric sensor, freezing its last value).
        this.client.publish(`${this.topicPrefix}/student/${studentId}/my_stop`, "None", { retain: true });
        this.client.publish(`${this.topicPrefix}/student/${studentId}/scheduled_time`, "None", { retain: true });
        this._clearStopProgress(studentId); // blanks stops_away + the per-fix topics
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
    const scheduledTimeTopic = `${this.topicPrefix}/student/${studentId}/scheduled_time`;
    const stopsAwayTopic = `${this.topicPrefix}/student/${studentId}/stops_away`;
    const distanceTopic = `${this.topicPrefix}/student/${studentId}/distance_to_stop`;
    const etaTopic = `${this.topicPrefix}/student/${studentId}/eta`;
    const approachingTopic = `${this.topicPrefix}/student/${studentId}/approaching`;
    const delayTopic = `${this.topicPrefix}/student/${studentId}/delay`;
    const predictedArrivalTopic = `${this.topicPrefix}/student/${studentId}/predicted_arrival`;
    const routeSnapOkTopic = `${this.topicPrefix}/student/${studentId}/route_snap_ok`;

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

      // Upgrade migration: evict any retained per-fix values an older version left
      // on the broker (distance/eta were published retained before this build), so
      // they can't be replayed to HA on reconnect and held fresh by expire_after.
      this._evictRetainedProgress(studentId);

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

      // Scheduled arrival time at my stop (district-local "HH:MM" wall clock).
      // Published as a plain string rather than a timestamp device_class: it is a
      // recurring wall-clock time with no date, which HA has no device_class for
      // (predicted_arrival is the concrete-instant companion). has_entity_name lets
      // HA compose the friendly name from the device, so this entity carries only
      // the short suffix.
      this.client.publish(
        `homeassistant/sensor/myride_student_${studentId}_scheduled_time/config`,
        JSON.stringify({
          name: "Scheduled Stop Time",
          has_entity_name: true,
          unique_id: `myride_student_${studentId}_scheduled_time`,
          state_topic: scheduledTimeTopic,
          availability,
          device: deviceConfig,
          origin: ORIGIN,
          icon: "mdi:clock-start",
        }),
        { retain: true }
      );

      // Stops remaining before my stop — GPS-truthful (count of the run's stops
      // still ahead of the live bus, from route geometry), published per fix.
      this.client.publish(
        `homeassistant/sensor/myride_student_${studentId}_stops_away/config`,
        JSON.stringify({
          name: "Stops Away",
          has_entity_name: true,
          unique_id: `myride_student_${studentId}_stops_away`,
          state_topic: stopsAwayTopic,
          unit_of_measurement: "stops",
          state_class: "measurement",
          suggested_display_precision: 0,
          expire_after: PER_FIX_EXPIRE_AFTER,
          availability,
          device: deviceConfig,
          origin: ORIGIN,
          icon: "mdi:bus-stop",
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
          // Per-fix value: expire so a frozen last-known distance can't linger after
          // fixes stop arriving. (No has_entity_name — this is a pre-existing entity
          // whose entity_id must stay stable.)
          expire_after: PER_FIX_EXPIRE_AFTER,
          availability,
          device: deviceConfig,
          origin: ORIGIN,
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
          expire_after: PER_FIX_EXPIRE_AFTER,
          availability,
          device: deviceConfig,
          origin: ORIGIN,
          icon: "mdi:clock-outline",
        }),
        { retain: true }
      );

      // Schedule delay (minutes behind (+) / ahead (−) schedule). No device_class:
      // "duration" implies a non-negative span, but this value is signed.
      this.client.publish(
        `homeassistant/sensor/myride_student_${studentId}_delay/config`,
        JSON.stringify({
          name: "Schedule Delay",
          has_entity_name: true,
          unique_id: `myride_student_${studentId}_delay`,
          state_topic: delayTopic,
          unit_of_measurement: "min",
          state_class: "measurement",
          suggested_display_precision: 0,
          expire_after: PER_FIX_EXPIRE_AFTER,
          availability,
          device: deviceConfig,
          origin: ORIGIN,
          icon: "mdi:clock-alert-outline",
        }),
        { retain: true }
      );

      // Predicted arrival at my stop — a concrete instant today (scheduled stop
      // time shifted by the current delay), so it's a `timestamp` sensor: HA renders
      // a native "in N minutes" countdown and it can anchor a Live Activity directly.
      this.client.publish(
        `homeassistant/sensor/myride_student_${studentId}_predicted_arrival/config`,
        JSON.stringify({
          name: "Predicted Stop Arrival",
          has_entity_name: true,
          unique_id: `myride_student_${studentId}_predicted_arrival`,
          state_topic: predictedArrivalTopic,
          device_class: "timestamp",
          expire_after: PER_FIX_EXPIRE_AFTER,
          availability,
          device: deviceConfig,
          origin: ORIGIN,
          icon: "mdi:clock-check-outline",
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

      // Route Snap OK — diagnostic. ON when the live bus is being tracked on-route
      // (a trusted route snap, or a held position within the hold budget); OFF when
      // the snap failed and distance fell back to crow-flies; unavailable (via
      // expire_after) when no fix is arriving at all. This is what distinguishes
      // "briefly waiting for a snap" from "route data has been dead for the whole
      // run" without reading the host logs. Non-retained + expire_after like the
      // other per-fix topics.
      this.client.publish(
        `homeassistant/binary_sensor/myride_student_${studentId}_route_snap_ok/config`,
        JSON.stringify({
          name: "Route Snap OK",
          has_entity_name: true,
          unique_id: `myride_student_${studentId}_route_snap_ok`,
          state_topic: routeSnapOkTopic,
          payload_on: "ON",
          payload_off: "OFF",
          entity_category: "diagnostic",
          expire_after: PER_FIX_EXPIRE_AFTER,
          availability,
          device: deviceConfig,
          origin: ORIGIN,
          icon: "mdi:map-marker-path",
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
    this.client.publish(myStopTopic, (myStop && myStop.name) || "None", { retain: true });
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

    // Scheduled arrival time: poll-derived (not per-location), so published here
    // rather than in publishStudentLocation(). Retained (slow-moving, worth
    // replaying on restart). "None" → HA unknown when unavailable. stops_away is
    // NOT published here anymore — it's route-derived per fix (see _publishStopsAway).
    this.client.publish(
      scheduledTimeTopic,
      (myStop && currentRun.scheduledTime) || "None",
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
   * Blank the live-progress topics so no stale value from a previous stop lingers.
   * Used when the stop is unknown or the student's stop identity changes.
   *
   * The numeric/timestamp topics are set to "None" (HA's unknown sentinel — an
   * empty payload would be *ignored* on those sensors, freezing the last value),
   * and published non-retained like their live updates. `approaching` is a binary
   * with a real OFF state, so it clears to OFF (retained).
   *
   * @param {string} studentId — sanitized id
   */
  _clearStopProgress(studentId) {
    const base = `${this.topicPrefix}/student/${studentId}`;
    for (const topic of ["distance_to_stop", "eta", "delay", "predicted_arrival", "stops_away"]) {
      this.client.publish(`${base}/${topic}`, "None", { retain: false });
    }
    this.client.publish(`${base}/approaching`, "OFF", { retain: true });
    // No trusted route position while the stop is unknown/changing.
    this.client.publish(`${base}/route_snap_ok`, "OFF", { retain: false });
    // Drop the monotonic route-distance baseline: a new/absent stop means the
    // cumulative frame changed, so the previous bus position is no longer comparable.
    this.lastRouteCumByStudent.delete(studentId);
    this.routeModeActiveByStudent.delete(studentId);
    this.lastOffRouteLogMsByStudent.delete(studentId);
  }

  /**
   * One-time upgrade migration: delete any *retained* per-fix progress values left
   * on the broker by an older bridge version, which published distance/eta (and, on
   * pre-release builds of this branch, delay/predicted/stops_away) with retain:true.
   * Those topics are now published non-retained; a lingering retained payload would
   * be replayed to Home Assistant on reconnect and — with expire_after — treated as
   * fresh for its full lease. A zero-byte *retained* publish clears the broker's
   * retained store; HA ignores the empty payload (no state change). Run once per
   * student when discovery is first published.
   *
   * @param {string} studentId — sanitized id
   */
  _evictRetainedProgress(studentId) {
    const base = `${this.topicPrefix}/student/${studentId}`;
    for (const topic of ["distance_to_stop", "eta", "delay", "predicted_arrival", "stops_away"]) {
      this.client.publish(`${base}/${topic}`, "", { retain: true });
    }
  }

  /**
   * Road-following distance (meters) from the live bus to the student's stop,
   * using the precomputed route polyline on `myStop`. Returns null when route
   * geometry is structurally unavailable. For a *transient* snap failure — the bus
   * snapping off-route (a thin/gapped connector stretch of the polyline) or failing
   * the wrong-pass guard — it holds the last accepted route position for up to
   * ROUTE_MAX_HELD_FIXES consecutive failures before finally returning null; only
   * then does the caller fall back to haversine and the route-only sensors blank.
   * This keeps stops_away/delay/predicted_arrival (and a route-consistent distance)
   * steady across the brief gaps where the polyline doesn't cover the road, instead
   * of flipping to "unknown" on a single bad fix.
   *
   * @param {string} studentId — sanitized id (keys the wrong-pass/hold state)
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
      return null; // structural: no geometry to hold against
    }

    const snap = nearestVertexCumulative(
      busLat, busLng, myStop.routePolyline, myStop.cumulativeMeters
    );
    if (!snap) return null; // no vertices — structural, treat like missing geometry

    const prev = this.lastRouteCumByStudent.get(studentId);
    // This frame's clock. It becomes the guard's reference timestamp on an accepted
    // fix or a wrong-pass rejection; off-route holds preserve the previous reference
    // instead (see _holdOrClearRoute). Falls back to the previous reference when the
    // source timestamp is unknown.
    const seenMs = Number.isFinite(nowMs) ? nowMs : (prev ? prev.seenMs : null);

    // Off-route / GPS noise: the bus is nowhere near the route → don't trust the snap.
    if (snap.distMeters > ROUTE_SNAP_MAX_METERS) {
      return this._holdOrClearRoute(studentId, myStop, prev, seenMs, "off-route", snap.distMeters);
    }

    const busCum = snap.cumulativeMeters;

    // Wrong-pass guard: the route can revisit streets (loops/U-turns), so a global
    // nearest-vertex snap can land on the wrong pass. Reject anything that moves
    // backward (never legitimate within a run) or further forward than the elapsed
    // source time plausibly allows. A genuine long gap justifies a large forward
    // jump (→ re-acquire); a deterministic wrong-pass snap at normal cadence never
    // does (→ held, then haversine, frame after frame).
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
        return this._holdOrClearRoute(studentId, myStop, prev, seenMs, "wrong-pass", snap.distMeters);
      }
    }

    // Plausibility invariant: the implied road distance to the stop can't be shorter
    // than the crow-flies distance (a straight line is a lower bound on any road
    // path). A snap that lands on the wrong part of the polyline — classically the
    // route's end, reading ~0 m — while the bus is far away crow-flies violates this
    // and is a confidently-wrong reading, so treat it as a transient failure (held,
    // not accepted) rather than publishing "0 m / at the stop". The margin absorbs
    // the bus + stop-pin snap errors. Non-"off-route" reason → the clock advances
    // like a wrong-pass, so a recurring bad snap can't accrue forward slack.
    const candidate = Math.max(0, myStop.cumulativeAtStopMeters - busCum);
    const straightLine = haversineMeters(busLat, busLng, myStop.lat, myStop.lng);
    if (straightLine != null && candidate < straightLine - ROUTE_PLAUSIBILITY_MARGIN_METERS) {
      return this._holdOrClearRoute(studentId, myStop, prev, seenMs, "implausible", snap.distMeters);
    }

    // Accepted fix: reset the failure counter and record the new position.
    this.lastRouteCumByStudent.set(studentId, { cum: busCum, seenMs, failCount: 0 });
    // Log once on each (re)acquisition of route mode, carrying the loaded run's
    // identity + schedule window — this is what makes an AM-vs-PM route mismatch
    // visible (the per-fix diagnostics key on the student id, identical for both runs).
    if (!this.routeModeActiveByStudent.get(studentId)) {
      this.routeModeActiveByStudent.set(studentId, true);
      this.lastOffRouteLogMsByStudent.delete(studentId);
      const ctx = myStop.runContext || {};
      console.log(
        `[Route] ${studentId} route mode acquired ` +
        `run=${ctx.runId != null ? ctx.runId : "?"} bus=${ctx.busNumber || "?"} ` +
        `stops=${ctx.totalStops != null ? ctx.totalStops : "?"} ` +
        `sched=${ctx.firstStop || "?"}–${ctx.lastStop || "?"}`
      );
    }
    return candidate;
  }

  /**
   * Handle a transient route-snap failure (off-route or wrong-pass): hold the last
   * accepted position for a few frames, then give up.
   *
   * Returns the held road distance (from `prev.cum`) while the consecutive-failure
   * count is within ROUTE_MAX_HELD_FIXES, otherwise null (→ haversine + None).
   *
   * Timestamp handling differs by failure kind, and this matters for re-acquisition:
   *  - **wrong-pass** advances the frame clock (`seenMs`), so the *next* frame's
   *    forward allowance is measured frame-to-frame — a recurring close-but-wrong
   *    snap at normal cadence can never accrue enough slack to be promoted.
   *  - **off-route** *preserves* the last accepted timestamp. An off-route snap is
   *    gated out by the distance check before the forward-allowance test, so it can
   *    never be promoted regardless — advancing its clock only shrinks the window
   *    for the eventual re-acquisition. The bus really does travel across a connector
   *    gap, so re-acquisition must compare its total movement against the time since
   *    the last *accepted* fix, not since the last off-route frame (otherwise a bus
   *    that moved a kilometer off-route can never rejoin the route and route mode is
   *    lost for the rest of the run).
   * The failure counter is always advanced.
   *
   * Logs the snap distance for the first failures of a burst so the true off-route
   * magnitude is visible (distinguishing "tolerance too tight" from "polyline omits
   * the road").
   *
   * @param {string} studentId — sanitized id
   * @param {object} myStop — normalized stop (cumulativeAtStopMeters already finite)
   * @param {{cum:number, seenMs:number, failCount?:number}|undefined} prev
   * @param {number|null} seenMs — this frame's clock (used only for wrong-pass)
   * @param {string} reason — "off-route" | "wrong-pass" (drives the clock + the log)
   * @param {number} distMeters — snap perpendicular distance (for the diagnostic log)
   * @returns {number|null}
   */
  _holdOrClearRoute(studentId, myStop, prev, seenMs, reason, distMeters) {
    // No accepted baseline yet (e.g. the run begins off-route): there is nothing to
    // hold against, and we deliberately persist no failure state here — so we also
    // stay silent rather than re-log failure #1 on every fix. The diagnostic exists
    // to measure off-route magnitude *during* a run; it starts once the route has
    // been acquired at least once.
    if (!prev) return null;

    const failCount = (prev.failCount || 0) + 1;
    const runId = myStop.runContext ? myStop.runContext.runId : undefined;
    // Log the first failures of a burst (through the give-up transition) so we
    // capture the off-route distance without flooding on a long legitimate gap. The
    // count is persisted below (prev exists), so this rate-limit actually holds.
    if (failCount <= ROUTE_MAX_HELD_FIXES + 1) {
      console.warn(
        `[Route] ${studentId} snap failure (${reason}) distMeters=${Math.round(distMeters)} ` +
        `run=${runId != null ? runId : "?"} ` +
        `consecutive=${failCount}${failCount <= ROUTE_MAX_HELD_FIXES ? " (holding)" : " (route mode off)"}`
      );
    } else {
      // Route mode is already off and the burst warn has fired. Keep a throttled
      // heartbeat so a *sustained* outage (which never re-enters the burst) isn't
      // quieter in the logs than a brief one — with the current off-route distance
      // and the loaded run for the wrong-route diagnosis.
      const now = Date.now();
      const lastLog = this.lastOffRouteLogMsByStudent.get(studentId) || 0;
      if (now - lastLog >= OFF_ROUTE_LOG_THROTTLE_MS) {
        this.lastOffRouteLogMsByStudent.set(studentId, now);
        console.warn(
          `[Route] ${studentId} route mode still off (${reason}) ` +
          `distMeters=${Math.round(distMeters)} run=${runId != null ? runId : "?"} ` +
          `consecutive=${failCount}`
        );
      }
    }
    // Once the hold budget is exhausted, route mode is off (drives route_snap_ok OFF
    // and re-arms the "route mode acquired" log for the eventual re-acquisition).
    if (failCount > ROUTE_MAX_HELD_FIXES) {
      this.routeModeActiveByStudent.set(studentId, false);
    }
    // Preserve the accepted timestamp across off-route holds (see doc above);
    // advance it for wrong-pass / implausible so recurring bad snaps can't accrue slack.
    const nextSeenMs = reason === "off-route" ? prev.seenMs : seenMs;
    this.lastRouteCumByStudent.set(studentId, { cum: prev.cum, seenMs: nextSeenMs, failCount });
    if (failCount <= ROUTE_MAX_HELD_FIXES) {
      return Math.max(0, myStop.cumulativeAtStopMeters - prev.cum);
    }
    return null;
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

    // Diagnostic: is the bus being tracked on-route right now? routeMeters != null
    // means a trusted or held snap (route mode); null means we fell back to crow-flies.
    this.client.publish(
      `${this.topicPrefix}/student/${studentId}/route_snap_ok`,
      routeMeters != null ? "ON" : "OFF",
      { retain: false }
    );

    // Schedule-anchored delay + predicted arrival, and route-truthful stops-away —
    // all route mode only (need the bus's cumulative position, derived from routeMeters).
    this._publishDelay(studentId, myStop, routeMeters, nowMs);
    this._publishStopsAway(studentId, myStop, routeMeters);

    const effectiveMeters = routeMeters != null ? routeMeters : haversine;
    if (effectiveMeters == null) {
      // Bad bus coordinates and no route reading — clear rather than freeze.
      this.client.publish(distTopic, "None", { retain: false });
      this.client.publish(etaTopic, "None", { retain: false });
      return;
    }

    // Per-fix values are non-retained (a retained value would replay stale on an HA
    // restart) and paired with expire_after in discovery.
    this.client.publish(distTopic, String(Math.round(effectiveMeters)), { retain: false });

    // ETA estimate: distance / current speed. Only meaningful while moving; when
    // stopped it is genuinely undefined, so publish "None" (→ unknown) rather than
    // a frozen last value. The schedule-anchored delay/predicted stay valid instead.
    if (speedMph > 0) {
      const metersPerMin = speedMph * 26.8224; // 1 mph = 26.8224 m/min
      const etaMin = Math.round(effectiveMeters / metersPerMin);
      this.client.publish(etaTopic, String(etaMin), { retain: false });
    } else {
      this.client.publish(etaTopic, "None", { retain: false });
    }

    const approaching = haversine != null && haversine <= this.approachRadiusMeters;
    this.client.publish(approachingTopic, approaching ? "ON" : "OFF", { retain: true });
  }

  /**
   * Compute and publish route-truthful "stops away": how many of the run's stops
   * are still ahead of the live bus but before the student's own stop.
   *
   * Uses `myStop.upstreamStopCums` (route positions of the stops before the
   * student's, from attachRouteGeometry) and the bus's cumulative route position
   * (`cumulativeAtStopMeters − routeMeters`): the answer is how many upstream stops
   * still lie ahead of the bus. GPS-truthful and counts down live, unlike a
   * schedule-clock estimate. Route mode only — publishes "None" (unknown) when the
   * geometry isn't available, rather than a schedule-based guess.
   *
   * @param {string} studentId — sanitized id
   * @param {object} myStop — normalized stop; needs upstreamStopCums + cumulativeAtStopMeters
   * @param {number|null} routeMeters — road distance bus→stop (null = no route mode)
   */
  _publishStopsAway(studentId, myStop, routeMeters) {
    const topic = `${this.topicPrefix}/student/${studentId}/stops_away`;
    if (
      routeMeters != null &&
      myStop &&
      Array.isArray(myStop.upstreamStopCums) &&
      Number.isFinite(myStop.cumulativeAtStopMeters)
    ) {
      const busCum = myStop.cumulativeAtStopMeters - routeMeters;
      const count = myStop.upstreamStopCums.filter((cum) => cum > busCum).length;
      this.client.publish(topic, String(count), { retain: false });
    } else {
      this.client.publish(topic, "None", { retain: false });
    }
  }

  /**
   * Compute and publish the schedule-anchored delay and predicted arrival time.
   *
   * The delay model compares where the bus actually is along the route to where
   * the schedule says it should be by now: `S(cumBus)` is the scheduled time
   * interpolated at the bus's cumulative route position, so `delay = now − S(cumBus)`
   * (positive = behind schedule). The predicted arrival is then the student's own
   * scheduled stop time shifted by that delay — assuming the bus holds its current
   * offset for the rest of the run.
   *
   * Unlike the distance ÷ speed ETA, this stays valid while the bus is stopped
   * (dwelling at a stop still means "N minutes behind"), and it is anchored to the
   * timetable rather than an instantaneous speed reading. It requires route mode:
   * a trustworthy route snap (`routeMeters != null`, which already passed the
   * off-route and wrong-pass guards) and schedule checkpoints on the stop. When any
   * input is missing, or the bus has reached/passed the stop, both topics are
   * blanked so no stale value lingers.
   *
   * @param {string} studentId — sanitized id
   * @param {object} myStop — normalized stop; needs cumulativeAtStopMeters,
   *   stopTimeMinutes and scheduleCheckpoints (from attachRouteGeometry)
   * @param {number|null} routeMeters — road distance bus→stop (null = no route mode)
   * @param {number} [nowMs] — source timestamp (ms) of this fix
   */
  _publishDelay(studentId, myStop, routeMeters, nowMs) {
    const delayTopic = `${this.topicPrefix}/student/${studentId}/delay`;
    const predictedTopic = `${this.topicPrefix}/student/${studentId}/predicted_arrival`;

    const checkpoints = myStop && myStop.scheduleCheckpoints;
    const usable =
      routeMeters != null &&
      routeMeters > 0 && // 0 = at/after the stop → nothing left to predict
      Number.isFinite(nowMs) &&
      Number.isFinite(myStop.cumulativeAtStopMeters) &&
      Number.isFinite(myStop.stopTimeMinutes) &&
      Array.isArray(checkpoints) &&
      checkpoints.length >= 2;

    if (usable) {
      const busCum = myStop.cumulativeAtStopMeters - routeMeters;
      const schedAtBus = scheduledMinutesAt(busCum, checkpoints);
      const nowMin = nowMinutesInTimeZone(new Date(nowMs), this.timeZone);
      if (schedAtBus != null && nowMin != null) {
        const delay = Math.round(nowMin - schedAtBus);
        // Sanity guard: an implausibly large delay is the signature of snapping the
        // bus against the wrong run's schedule (observed −395 min = a PM timetable
        // read during an AM run). Blank both topics rather than publish a value no
        // school run could produce; the route/run fixes should prevent this, this is
        // the backstop.
        if (Math.abs(delay) > DELAY_SANITY_MAX_MINUTES) {
          console.warn(
            `[Route] ${studentId} implausible delay ${delay} min ` +
            `(|delay| > ${DELAY_SANITY_MAX_MINUTES}) — blanking delay/predicted_arrival`
          );
          this.client.publish(delayTopic, "None", { retain: false });
          this.client.publish(predictedTopic, "None", { retain: false });
          return;
        }
        // Predicted arrival as an ISO timestamp (device_class: timestamp): the
        // scheduled stop time shifted by the delay, on this fix's district-local day.
        const predictedTs = districtLocalTimestamp(
          nowMs, myStop.stopTimeMinutes + delay, this.timeZone
        );
        this.client.publish(delayTopic, String(delay), { retain: false });
        this.client.publish(predictedTopic, predictedTs || "None", { retain: false });
        return;
      }
    }
    this.client.publish(delayTopic, "None", { retain: false });
    this.client.publish(predictedTopic, "None", { retain: false });
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
