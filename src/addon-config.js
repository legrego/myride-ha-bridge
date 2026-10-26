"use strict";

/**
 * addon-config.js — Home Assistant add-on support.
 *
 * When the bridge runs as an HA add-on, the Supervisor writes the user's
 * add-on options to /data/options.json (not env vars), offers the Mosquitto
 * broker's credentials via its services API, and captures stdout as the
 * add-on log. These helpers adapt that environment to the bridge's existing
 * env-var configuration, so nothing downstream needs to know about add-on mode.
 */

const fs = require("fs");
const util = require("util");

const OPTIONS_PATH = "/data/options.json";
const SUPERVISOR_MQTT_URL = "http://supervisor/services/mqtt";

// add-on option name → env var the bridge already reads
const OPTION_ENV_MAP = {
  refresh_token: "MYRIDE_REFRESH_TOKEN",
  tenant_id: "MYRIDE_TENANT_ID",
  timezone: "TZ",
  approach_radius_meters: "APPROACH_RADIUS_METERS",
  bus_filter: "BUS_FILTER",
  log_level: "LOG_LEVEL",
};

/**
 * Copy add-on options into `env`. Options override env: under the Supervisor the
 * only env values are the image's defaults (e.g. LOG_LEVEL), which the user
 * can't change. Empty option values are skipped. A missing/unreadable file is
 * a no-op.
 * @returns {boolean} true if an options file was applied
 */
function applyAddonOptions(optionsPath = OPTIONS_PATH, env = process.env) {
  let options;
  try {
    options = JSON.parse(fs.readFileSync(optionsPath, "utf-8"));
  } catch {
    return false;
  }
  if (!options || typeof options !== "object") return false;

  for (const [option, key] of Object.entries(OPTION_ENV_MAP)) {
    const val = options[option];
    if (val == null || String(val).trim() === "") continue;
    env[key] = String(val).trim();
  }
  return true;
}

/**
 * Ask the Supervisor for the MQTT broker it provides (Mosquitto add-on).
 * @returns {Promise<{broker, port, username, password}|null>} null when not
 *   running under the Supervisor or the service is unavailable
 */
async function fetchMqttService({ token = process.env.SUPERVISOR_TOKEN, fetchImpl = fetch } = {}) {
  if (!token) return null;
  try {
    const res = await fetchImpl(SUPERVISOR_MQTT_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const body = await res.json();
    const data = body && body.data;
    if (!data || !data.host) return null;
    return {
      broker: data.host,
      port: parseInt(data.port || "1883"),
      username: data.username,
      password: data.password,
    };
  } catch {
    return null;
  }
}

/**
 * Retry fetchMqttService with exponential backoff (1s → 60s cap, like the
 * SignalR reconnect) until the Supervisor offers a broker, so a transient
 * Supervisor hiccup at boot doesn't crash the add-on.
 * @returns {Promise<{broker, port, username, password}|null>} null only when
 *   not running under the Supervisor
 */
async function waitForMqttService({
  token = process.env.SUPERVISOR_TOKEN,
  fetchImpl = fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  initialDelayMs = 1000,
  maxDelayMs = 60000,
  log = console.warn,
} = {}) {
  if (!token) return null;
  for (let delay = initialDelayMs; ; delay = Math.min(delay * 2, maxDelayMs)) {
    const service = await fetchMqttService({ token, fetchImpl });
    if (service) return service;
    log(`[MQTT] Supervisor MQTT service unavailable, retrying in ${Math.round(delay / 1000)}s`);
    await sleep(delay);
  }
}

/**
 * Prefix every console line with an ISO timestamp. The Supervisor's add-on log
 * text carries no per-line time, and feed-gap/route debugging depends on it.
 * Arguments are formatted first so printf-style specifiers keep working.
 */
function installLogTimestamps(target = console, now = () => new Date()) {
  for (const method of ["log", "info", "warn", "error", "debug"]) {
    const orig = target[method].bind(target);
    target[method] = (...args) => orig(`${now().toISOString()} ${util.format(...args)}`);
  }
}

module.exports = {
  applyAddonOptions,
  fetchMqttService,
  waitForMqttService,
  installLogTimestamps,
  OPTIONS_PATH,
  OPTION_ENV_MAP,
};
