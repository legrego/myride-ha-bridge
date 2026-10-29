/**
 * status.js — Pure helpers that shape GET /status for the status page.
 *
 * index.js (and the simulator) gather the live objects; these functions turn them
 * into the plain JSON the page renders, so the shaping is unit-tested on its own.
 */

"use strict";

const { formatMinutes } = require("./student-tracker");

/**
 * Today's runs and live values for each student, as the page's Today tab shows them.
 *
 * @param {object[]} students — normalized students (StudentTracker)
 * @param {object} opts
 * @param {number|null} opts.nowMinutes — district-local minutes since midnight
 * @param {function} [opts.readPublished] — (uniqueId, topicLeaf) → last published payload
 *   or null (MqttBridge#studentValue); omitted when there's no MQTT bridge
 * @param {function} [opts.readServed] — (uniqueId, runId) → whether the bus has served
 *   the student's stop on that run today (MqttBridge#studentServed)
 */
function describeStudents(students, { nowMinutes, readPublished = () => null, readServed = null }) {
  return (students || []).map((student) => {
    const current = student.currentRun;
    const runs = (student.todaysRuns || []).map((run) => ({
      runId: run.runId,
      period: run.windowStart != null && run.windowStart >= 12 * 60 ? "PM" : "AM",
      bus: run.activeVehicle || run.busNumber || null,
      regularBus: run.busNumber || null,
      substitute: Boolean(run.isSubstitute && run.activeVehicle && run.busNumber),
      windowStart: formatMinutes(run.windowStart),
      windowEnd: formatMinutes(run.windowEnd),
      myStopTime: formatMinutes(run.myStopTimeMinutes),
      myStopAction: run.myStopAction || null,
      current: Boolean(current && run.runId === current.runId),
      state: runState(run, nowMinutes),
    }));
    const value = (name) => readPublished(student.uniqueId, name);
    return {
      id: student.uniqueId,
      name: student.firstName || student.uniqueId,
      currentRunId: current ? current.runId : null,
      runs,
      live: {
        feedLive: onOff(value("feed_live")),
        lastFixAt: noneToNull(value("last_fix")),
        routeSnap: onOff(value("route_snap_ok")),
        stopsAway: number(value("stops_away")),
        etaMinutes: number(value("eta")),
        delayMinutes: number(value("delay")),
        distanceMeters: number(value("distance_to_stop")),
        // null when unknown (no MQTT bridge or no current run)
        stopServed: readServed && current ? Boolean(readServed(student.uniqueId, current.runId)) : null,
      },
    };
  });
}

function runState(run, nowMinutes) {
  if (nowMinutes == null || run.windowStart == null) return "unknown";
  if (nowMinutes < run.windowStart) return "upcoming";
  if (run.windowEnd != null && nowMinutes > run.windowEnd) return "done";
  return "active";
}

function noneToNull(payload) {
  return payload == null || payload === "" || payload === "None" ? null : payload;
}

function onOff(payload) {
  if (payload === "ON") return true;
  if (payload === "OFF") return false;
  return null;
}

function number(payload) {
  const v = noneToNull(payload);
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The add-on's Configuration tab URL, from the container hostname. The Supervisor
 * names an add-on container after its slug with `_` → `-` (`a0d7b954-myride-bridge`
 * for `a0d7b954_myride_bridge`); our slug has no `-`, so the mapping reverses.
 *
 * @param {string|undefined} hostname
 * @returns {string|null} a path on the Home Assistant origin, or null
 */
function addonConfigUrl(hostname) {
  if (!hostname || !/^[a-z0-9-]+-myride-bridge$/.test(hostname)) return null;
  return `/hassio/addon/${hostname.replace(/-/g, "_")}/config`;
}

/** "3f2a1b…91c0" — enough to recognise a tenant ID without printing all of it. */
function maskId(id) {
  if (!id) return null;
  const s = String(id);
  return s.length <= 12 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * The settings in effect, each with its add-on option name and environment variable,
 * so the page can say where to change it. `option` is null for settings the add-on
 * doesn't expose.
 */
function describeOptions({ config, configuredTenantId, approachRadiusMeters, streamSilenceSeconds, isAddon }) {
  return [
    { label: "Time zone", value: config.timeZone, option: "timezone", env: "TZ" },
    {
      label: "District",
      value: configuredTenantId ? `Set: ${maskId(configuredTenantId)}` : "Detected from sign-in",
      option: "tenant_id",
      env: "MYRIDE_TENANT_ID",
    },
    { label: "Approach radius", value: `${approachRadiusMeters} m`, option: "approach_radius_meters", env: "APPROACH_RADIUS_METERS" },
    { label: "Bus filter", value: config.busFilter || "None (all buses)", option: "bus_filter", env: "BUS_FILTER" },
    { label: "Stream silence limit", value: `${streamSilenceSeconds} s`, option: null, env: "STREAM_SILENCE_SECONDS" },
    {
      label: "MQTT broker",
      value: config.mqtt.broker ? `${config.mqtt.broker}:${config.mqtt.port}` : isAddon ? "From the Supervisor" : "Not set",
      option: null,
      env: "MQTT_BROKER",
    },
    { label: "Log level", value: config.logLevel, option: "log_level", env: "LOG_LEVEL" },
  ].filter((o) => !isAddon || o.option);
}

module.exports = { describeStudents, addonConfigUrl, maskId, describeOptions };
