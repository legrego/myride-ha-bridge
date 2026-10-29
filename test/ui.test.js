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

  it("contains the page title and heading", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes("<title>MyRide Bus Bridge</title>"));
    assert.ok(body.includes("<h1>MyRide Bus Bridge</h1>"));
  });

  it("contains the simulation mode banner element", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes('id="sim-banner"'));
  });

  it("has the four tabs and their panels", async () => {
    const { body } = await getRoot();
    for (const tab of ["overview", "today", "events", "setup"]) {
      assert.ok(body.includes(`data-tab="${tab}"`), `tab button ${tab}`);
      assert.ok(body.includes(`id="tab-${tab}"`), `tab panel ${tab}`);
    }
  });

  it("has the overview's verdict, steps and step details", async () => {
    const { body } = await getRoot();
    for (const id of ["verdict", "steps", "step-detail", "overall-chip", "last-refresh"]) {
      assert.ok(body.includes(`id="${id}"`), id);
    }
  });

  it("has the events tab's timeline, log and diagnostics download", async () => {
    const { body } = await getRoot();
    for (const id of ["timeline", "event-list", "download-diagnostics"]) {
      assert.ok(body.includes(`id="${id}"`), id);
    }
  });

  it("supports dark mode", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes("prefers-color-scheme: dark"));
  });

  // ── Token form (Setup tab) ────────────────────────────────────────────────

  it("contains the token submission form", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes('id="token-form"'));
    assert.ok(body.includes('id="token-input"'));
    assert.ok(body.includes('id="token-msg"'));
  });

  // ── Client-side JS behaviour ──────────────────────────────────────────────

  it("polls /status on an interval", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes("fetchStatus"), "fetchStatus function should be defined");
    assert.ok(body.includes("setInterval(fetchStatus"), "fetchStatus should be polled");
  });

  it("reads the simulate flag and the credential state from status", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes("s.simulate"));
    assert.ok(body.includes("s.tokenExpired"));
    assert.ok(body.includes("s.tokenMissing"));
    assert.ok(body.includes("s.login && s.login.rejected"));
  });

  it("says where settings change, by runtime", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes("s.runtime === 'addon'"));
    assert.ok(body.includes("Configuration tab"));
    assert.ok(body.includes("MYRIDE_EMAIL and MYRIDE_PASSWORD environment variables"));
  });

  it("keeps fetches relative, for Home Assistant ingress", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes("fetch('status')"));
    assert.ok(body.includes("fetch('token'"));
    assert.ok(body.includes("fetch('snippet')"));
    assert.ok(!/fetch\('\//.test(body), "no absolute fetch paths");
  });

  it("escapes values from the bridge before inserting them as HTML", async () => {
    const { body } = await getRoot();
    assert.ok(body.includes("function esc("));
  });
});
