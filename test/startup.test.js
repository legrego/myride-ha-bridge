/**
 * startup.test.js
 *
 * Spawns the real bridge (src/index.js) with nothing configured — a fresh
 * add-on install, without a token or a tenant ID — and checks it serves the
 * status page and waits for a token instead of exiting.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
// index.js loads ../.env for any var not already set; a developer's .env with a
// token would start the real bridge.
const hasDotEnv = fs.existsSync(path.join(ROOT, ".env"));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

describe("startup with no token", { skip: hasDotEnv && "a .env file is present" }, () => {
  let child;
  let port;
  let output = "";
  let exitCode = null;
  let tmpDir;

  before(async () => {
    port = await freePort();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myride-startup-"));
    const env = { ...process.env };
    // Nothing configured at all: the tenant ID is optional (read from the token).
    for (const key of ["MYRIDE_REFRESH_TOKEN", "MYRIDE_ACCESS_TOKEN", "MYRIDE_TENANT_ID", "SIMULATE", "SUPERVISOR_TOKEN", "MQTT_BROKER"]) {
      delete env[key];
    }
    Object.assign(env, {
      API_PORT: String(port),
      TOKEN_FILE: path.join(tmpDir, "refresh_token"),
    });
    child = spawn(process.execPath, [path.join(ROOT, "src/index.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => { output += d; });
    child.stderr.on("data", (d) => { output += d; });
    child.on("exit", (code) => { exitCode = code; });

    // Wait for the bridge to report it is waiting (or to exit early).
    const deadline = Date.now() + 10_000;
    while (!output.includes("Waiting for a refresh token") && exitCode === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  after(async () => {
    if (exitCode === null) {
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await exited;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stays running and waits for a token", () => {
    assert.equal(exitCode, null, `bridge exited early:\n${output}`);
    assert.ok(output.includes("No authentication token configured"), output);
    assert.ok(output.includes("Waiting for a refresh token"), output);
  });

  it("serves the status page", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('id="token-form"'));
  });

  it("reports the missing token in /status", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/status`);
    assert.equal(res.status, 200);
    const status = await res.json();
    assert.equal(status.tokenMissing, true);
    assert.equal(status.tokenExpired, false);
    assert.equal(status.signalrConnected, false);
    assert.equal(status.mqttConnected, false);
  });

  it("shuts down cleanly on SIGTERM", async () => {
    assert.equal(exitCode, null, "bridge already exited");
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    assert.equal(await exited, 0);
    exitCode = 0;
  });
});
