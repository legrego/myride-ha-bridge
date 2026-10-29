/**
 * ha-entity-check.js — Ask Home Assistant how many of the bridge's entities exist.
 *
 * The bridge knows what discovery configs it published, not whether Home Assistant
 * created the entities. As an add-on it can ask: the Supervisor proxies Core's REST
 * API (needs `homeassistant_api: true` in config.yaml), and a template counts the MQTT
 * entities on devices whose identifiers start with `myride_` (the student devices and
 * the bridge device). A standalone bridge has no such access, so the status page
 * shows the check only for the add-on.
 */

"use strict";

const CORE_API = "http://supervisor/core/api";
const REQUEST_TIMEOUT_MS = 10_000;

// Device identifiers are (domain, id) pairs; ours are ("mqtt", "myride_…").
const COUNT_TEMPLATE = `
{%- set ns = namespace(n=0) -%}
{%- for e in integration_entities('mqtt') -%}
{%- set d = device_id(e) -%}
{%- if d and device_attr(d, 'identifiers') | selectattr(1, 'match', 'myride_') | list | count > 0 -%}
{%- set ns.n = ns.n + 1 -%}
{%- endif -%}
{%- endfor -%}
{{ ns.n }}`;

/**
 * @param {object} [opts]
 * @param {string} [opts.token=process.env.SUPERVISOR_TOKEN]
 * @param {function} [opts.fetchImpl=fetch]
 * @returns {Promise<number>} entities Home Assistant has on the bridge's devices
 * @throws when the API is unreachable, refuses (e.g. missing homeassistant_api), or
 *   returns something that isn't a count
 */
async function countBridgeEntities({ token = process.env.SUPERVISOR_TOKEN, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`${CORE_API}/template`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ template: COUNT_TEMPLATE }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Home Assistant API returned HTTP ${res.status}`);
  const text = (await res.text()).trim();
  const count = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(count)) {
    throw new Error(`Home Assistant API returned an unexpected count: ${text.slice(0, 80)}`);
  }
  return count;
}

module.exports = { countBridgeEntities, COUNT_TEMPLATE };
