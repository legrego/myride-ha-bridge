/**
 * simulator.test.js
 *
 * Spawns the bridge in SIMULATE=true mode as a subprocess and tests the HTTP
 * API it exposes.  Using a subprocess keeps the setInterval / process.on()
 * side-effects fully isolated from the test runner.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SIM_PORT = 18877; // fixed port unlikely to collide with the real bridge

// ─── Subprocess helpers ───────────────────────────────────────────────────────

/**
 * Resolve once the simulator prints its "Running" line, reject on timeout or
 * early exit.
 */
function waitForReady(proc, timeout = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("Simulator did not start within timeout")),
      timeout
    );
    function check(chunk) {
      if (chunk.toString().includes("[Sim] Running")) {
        clearTimeout(t);
        proc.stdout.off("data", check);
        resolve();
      }
    }
    proc.stdout.on("data", check);
    proc.on("error", (err) => { clearTimeout(t); reject(err); });
    proc.on("exit", (code) => {
      clearTimeout(t);
      reject(new Error(`Simulator exited early (code ${code})`));
    });
  });
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

async function get(urlPath) {
  const res = await fetch(`http://127.0.0.1:${SIM_PORT}${urlPath}`);
  const body = await res.text();
  return { status: res.status, contentType: res.headers.get("content-type"), body };
}

async function post(urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${SIM_PORT}${urlPath}`, {
    method: "POST",
    body,
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Simulation mode (subprocess)", () => {
  let proc;
  let tmpDir;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "simtest-"));
    const tokenFile = path.join(tmpDir, "token");

    proc = spawn("node", ["src/index.js"], {
      env: {
        ...process.env,
        SIMULATE: "true",
        API_PORT: String(SIM_PORT),
        TOKEN_FILE: tokenFile,
      },
      cwd: ROOT,
    });

    await waitForReady(proc);
  });

  after(async () => {
    if (proc) {
      proc.kill("SIGTERM");
      await new Promise((resolve) => proc.on("exit", resolve));
    }
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── /status ──────────────────────────────────────────────────────────────

  it("GET /status returns 200 with JSON", async () => {
    const res = await get("/status");
    assert.equal(res.status, 200);
    assert.ok(res.contentType.includes("application/json"));
  });

  it("GET /status has simulate: true", async () => {
    const res = await get("/status");
    const data = JSON.parse(res.body);
    assert.equal(data.simulate, true);
  });

  it("GET /status reports signalrConnected: true", async () => {
    const res = await get("/status");
    const data = JSON.parse(res.body);
    assert.equal(data.signalrConnected, true);
  });

  it("GET /status reports tokenExpired: false", async () => {
    const res = await get("/status");
    const data = JSON.parse(res.body);
    assert.equal(data.tokenExpired, false);
  });

  it("GET /status has tokenExpiresAt in the future", async () => {
    const res = await get("/status");
    const data = JSON.parse(res.body);
    assert.ok(data.tokenExpiresAt, "tokenExpiresAt should be present");
    const expiry = new Date(data.tokenExpiresAt).getTime();
    assert.ok(expiry > Date.now(), "tokenExpiresAt should be in the future");
  });

  it("GET /status has tokenExpiresInSeconds > 0", async () => {
    const res = await get("/status");
    const data = JSON.parse(res.body);
    assert.ok(typeof data.tokenExpiresInSeconds === "number");
    assert.ok(data.tokenExpiresInSeconds > 0);
  });

  it("GET /status reports mqttConnected: false when no broker is configured", async () => {
    const res = await get("/status");
    const data = JSON.parse(res.body);
    // No MQTT_BROKER env var set → should be false
    assert.equal(data.mqttConnected, false);
  });

  // ── /token ───────────────────────────────────────────────────────────────

  it("POST /token returns 200 (submission accepted but ignored)", async () => {
    const res = await post("/token", "fake-refresh-token-abc123");
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.ok, true);
  });

  it("POST /token with empty body returns 400", async () => {
    const res = await post("/token", "");
    assert.equal(res.status, 400);
    const data = JSON.parse(res.body);
    assert.ok(data.error.toLowerCase().includes("empty"));
  });

  // ── / (UI) ───────────────────────────────────────────────────────────────

  it("GET / returns 200 with text/html content-type", async () => {
    const res = await get("/");
    assert.equal(res.status, 200);
    assert.ok(res.contentType.includes("text/html"));
  });

  it("GET / includes the bridge title", async () => {
    const res = await get("/");
    assert.ok(res.body.includes("MyRide HA Bridge"));
  });

  // ── unknown routes ───────────────────────────────────────────────────────

  it("GET /unknown returns 404", async () => {
    const res = await get("/unknown");
    assert.equal(res.status, 404);
  });
});
