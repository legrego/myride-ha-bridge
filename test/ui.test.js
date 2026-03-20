/**
 * ui.test.js
 *
 * Tests the HTML UI served by ApiServer at GET /.
 * We spin up a real ApiServer (port 0) and inspect the HTML it returns.
 * JS-in-browser behaviour is verified by asserting that the expected
 * source strings are present in the document.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { ApiServer } = require("../src/api-server");

describe("UI (GET /)", () => {
  let server;
  let port;

  beforeEach(async () => {
    server = new ApiServer({
      port: 0,
      tokenFile: "/tmp/ui-test-token",
      onNewToken: async () => {},
      getStatus: () => ({ bridge: "myride-ha-bridge", ok: true }),
    });
    await server.start();
    port = server.server.address().port;
  });

  afterEach(async () => {
    await server.stop();
  });

  async function getRoot() {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      body: await res.text(),
    };
  }

  // ── HTTP response ─────────────────────────────────────────────────────────

  it("returns 200", async () => {
    const { status } = await getRoot();
    assert.equal(status, 200);
  });

  it("returns text/html content-type", async () => {
    const { contentType } = await getRoot();
    assert.ok(contentType.includes("text/html"));
  });

  // ── Page structure ────────────────────────────────────────────────────────

  it("contains the page title", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes("<title>MyRide HA Bridge</title>"));
  });

  it("contains the header heading", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes("<h1>MyRide HA Bridge</h1>"));
  });

  it("contains the simulation mode banner element", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes('id="sim-banner"'));
  });

  // ── Status card ───────────────────────────────────────────────────────────

  it("contains the SignalR status pill", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes('id="s-signalr"'));
  });

  it("contains the MQTT status pill", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes('id="s-mqtt"'));
  });

  it("contains the credentials status pill", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes('id="s-creds"'));
  });

  it("contains the token-expiry field", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes('id="s-expires"'));
  });

  it("contains the last-refresh note element", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes('id="last-refresh"'));
  });

  // ── Token form ────────────────────────────────────────────────────────────

  it("contains the token submission form", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes('id="token-form"'));
  });

  it("contains the token textarea", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes('id="token-input"'));
  });

  it("contains the token feedback message element", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes('id="token-msg"'));
  });

  // ── Client-side JS behaviour ──────────────────────────────────────────────

  it("polls /status on an interval", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes("fetchStatus"), "fetchStatus function should be defined");
    assert.ok(body.includes("setInterval(fetchStatus"), "fetchStatus should be polled");
  });

  it("reads simulate flag from status and toggles banner class", async () => {
    const { body } = await getRoot();
    // The JS sets banner className based on s.simulate
    assert.ok(body.includes("s.simulate"));
    assert.ok(body.includes("'visible'"));
  });

  it("reads signalrConnected and mqttConnected from status", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes("s.signalrConnected"));
    assert.ok(body.includes("s.mqttConnected"));
  });

  it("reads tokenExpired from status to set credentials pill", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes("s.tokenExpired"));
  });

  it("POSTs token to /token endpoint on form submit", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes("fetch('/token'"));
  });

  it("fetches /status endpoint from JS", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes("fetch('/status')"));
  });
});
