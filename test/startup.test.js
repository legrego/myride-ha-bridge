/**
 * startup.test.js
 *
 * Spawns the real bridge (src/index.js) and checks how it starts:
 *  - with nothing configured — a fresh add-on install, without a token, a
 *    MyRide login or a tenant ID — it serves the status page and waits for a
 *    token instead of exiting;
 *  - with a MyRide email and password that Cognito rejects, it signs in once,
 *    then idles with the status page up instead of retrying or exiting.
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

/**
 * Start the bridge with nothing configured beyond `extraEnv`, and wait until its
 * output includes `readyText` (or it exits).
 */
async function startBridge({ extraEnv = {}, nodeArgs = [], readyText }) {
  const port = await freePort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "myride-startup-"));
  const env = { ...process.env };
  for (const key of [
    "MYRIDE_REFRESH_TOKEN", "MYRIDE_ACCESS_TOKEN", "MYRIDE_TENANT_ID", "MYRIDE_EMAIL",
    "MYRIDE_PASSWORD", "SIMULATE", "SUPERVISOR_TOKEN", "MQTT_BROKER",
  ]) {
    delete env[key];
  }
  Object.assign(env, {
    API_PORT: String(port),
    TOKEN_FILE: path.join(tmpDir, "refresh_token"),
    ...extraEnv,
  });
  const bridge = { port, tmpDir, output: "", exitCode: null };
  bridge.child = spawn(process.execPath, [...nodeArgs, path.join(ROOT, "src/index.js")], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.child.stdout.on("data", (d) => { bridge.output += d; });
  bridge.child.stderr.on("data", (d) => { bridge.output += d; });
  bridge.child.on("exit", (code) => { bridge.exitCode = code; });

  const deadline = Date.now() + 10_000;
  while (!bridge.output.includes(readyText) && bridge.exitCode === null && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  return bridge;
}

async function stopBridge(bridge) {
  if (bridge.exitCode === null) {
    const exited = new Promise((r) => bridge.child.once("exit", r));
    bridge.child.kill("SIGTERM");
    await exited;
  }
  fs.rmSync(bridge.tmpDir, { recursive: true, force: true });
}

async function getStatus(bridge) {
  const res = await fetch(`http://127.0.0.1:${bridge.port}/status`);
  assert.equal(res.status, 200);
  return res.json();
}

describe("startup with no token", { skip: hasDotEnv && "a .env file is present" }, () => {
  let bridge;

  before(async () => {
    bridge = await startBridge({ readyText: "Waiting for a refresh token" });
  });

  after(() => stopBridge(bridge));

  it("stays running and waits for a token", () => {
    assert.equal(bridge.exitCode, null, `bridge exited early:\n${bridge.output}`);
    assert.ok(bridge.output.includes("No MyRide credentials configured"), bridge.output);
    assert.ok(bridge.output.includes("Waiting for a refresh token"), bridge.output);
  });

  it("serves the status page", async () => {
    const res = await fetch(`http://127.0.0.1:${bridge.port}/`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('id="token-form"'));
  });

  it("reports the missing token in /status", async () => {
    const status = await getStatus(bridge);
    assert.equal(status.tokenMissing, true);
    assert.equal(status.tokenExpired, false);
    assert.equal(status.login, null);
    assert.equal(status.signalrConnected, false);
    assert.equal(status.mqttConnected, false);
  });

  it("shuts down cleanly on SIGTERM", async () => {
    assert.equal(bridge.exitCode, null, "bridge already exited");
    const exited = new Promise((r) => bridge.child.once("exit", r));
    bridge.child.kill("SIGTERM");
    assert.equal(await exited, 0);
    bridge.exitCode = 0;
  });
});

describe("startup with a rejected MyRide password", { skip: hasDotEnv && "a .env file is present" }, () => {
  let bridge;

  before(async () => {
    bridge = await startBridge({
      // Answers every Cognito call with "Incorrect username or password."
      nodeArgs: ["--require", path.join(__dirname, "fixtures", "cognito-rejects-login.js")],
      extraEnv: { MYRIDE_EMAIL: "parent@example.com", MYRIDE_PASSWORD: "wrong" },
      readyText: "[Bridge] Idling",
    });
  });

  after(() => stopBridge(bridge));

  it("tries the password once, then idles instead of exiting", () => {
    assert.equal(bridge.exitCode, null, `bridge exited early:\n${bridge.output}`);
    assert.ok(bridge.output.includes("Signing in to MyRide as parent@example.com"), bridge.output);
    assert.equal(bridge.output.match(/\[fake-cognito\] USER_PASSWORD_AUTH/g)?.length, 1, bridge.output);
    assert.ok(bridge.output.includes("MyRide rejected the email and password"), bridge.output);
    assert.ok(!bridge.output.includes("wrong"), "the password must not be logged");
  });

  it("reports the rejection in /status without the email", async () => {
    const status = await getStatus(bridge);
    assert.equal(status.tokenMissing, false);
    assert.equal(status.tokenExpired, true);
    assert.match(status.login.rejected, /Incorrect username or password/);
    assert.ok(!JSON.stringify(status).includes("parent@example.com"));
  });

  it("gives the status page the rejection's time and an event", async () => {
    const status = await getStatus(bridge);
    assert.equal(status.runtime, "standalone");
    assert.equal(status.signIn.method, "password");
    assert.ok(Date.parse(status.signIn.rejectedAt) > 0);
    const rejection = status.events.find((e) => e.marker === "!");
    assert.equal(rejection.level, "error");
    assert.match(rejection.message, /rejected the email and password/);
    assert.ok(status.events.some((e) => e.marker === "S"));
  });

  it("doesn't sign in again while idle", async () => {
    await new Promise((r) => setTimeout(r, 300));
    await getStatus(bridge);
    assert.equal(bridge.output.match(/\[fake-cognito\] USER_PASSWORD_AUTH/g)?.length, 1, bridge.output);
  });
});
