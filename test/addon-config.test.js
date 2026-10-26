const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  applyAddonOptions,
  fetchMqttService,
  waitForMqttService,
  installLogTimestamps,
} = require("../src/addon-config");

function writeOptions(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "addon-opts-"));
  const file = path.join(dir, "options.json");
  fs.writeFileSync(file, JSON.stringify(obj));
  return file;
}

describe("applyAddonOptions", () => {
  it("maps add-on options to the bridge's env vars", () => {
    const env = {};
    const applied = applyAddonOptions(
      writeOptions({
        tenant_id: "tenant-uuid",
        refresh_token: "rt",
        timezone: "America/Chicago",
        approach_radius_meters: 300,
        bus_filter: "BUS 042",
        log_level: "debug",
      }),
      env
    );
    assert.equal(applied, true);
    assert.deepEqual(env, {
      MYRIDE_TENANT_ID: "tenant-uuid",
      MYRIDE_REFRESH_TOKEN: "rt",
      TZ: "America/Chicago",
      APPROACH_RADIUS_METERS: "300",
      BUS_FILTER: "BUS 042",
      LOG_LEVEL: "debug",
    });
  });

  it("overrides image defaults such as LOG_LEVEL", () => {
    const env = { LOG_LEVEL: "info" };
    applyAddonOptions(writeOptions({ log_level: "debug" }), env);
    assert.equal(env.LOG_LEVEL, "debug");
  });

  it("skips empty and missing option values", () => {
    const env = { TZ: "America/New_York" };
    applyAddonOptions(writeOptions({ tenant_id: "t", bus_filter: "", refresh_token: "  " }), env);
    assert.deepEqual(env, { TZ: "America/New_York", MYRIDE_TENANT_ID: "t" });
  });

  it("is a no-op when the options file is missing or invalid", () => {
    const env = {};
    assert.equal(applyAddonOptions("/nonexistent/options.json", env), false);
    const bad = writeOptions({});
    fs.writeFileSync(bad, "not json");
    assert.equal(applyAddonOptions(bad, env), false);
    assert.deepEqual(env, {});
  });
});

describe("fetchMqttService", () => {
  it("returns the Supervisor's broker credentials", async () => {
    let seen;
    const fetchImpl = async (url, opts) => {
      seen = { url, auth: opts.headers.Authorization };
      assert.ok(opts.signal instanceof AbortSignal, "request has a timeout signal");
      return {
        ok: true,
        json: async () => ({
          result: "ok",
          data: { host: "core-mosquitto", port: 1883, ssl: false, username: "addons", password: "pw" },
        }),
      };
    };
    const svc = await fetchMqttService({ token: "tok", fetchImpl });
    assert.deepEqual(seen, { url: "http://supervisor/services/mqtt", auth: "Bearer tok" });
    assert.deepEqual(svc, { broker: "core-mosquitto", port: 1883, username: "addons", password: "pw" });
  });

  it("returns null without a Supervisor token", async () => {
    const fetchImpl = async () => assert.fail("should not fetch");
    assert.equal(await fetchMqttService({ token: undefined, fetchImpl }), null);
  });

  it("returns null when the service is unavailable or the request fails", async () => {
    assert.equal(
      await fetchMqttService({ token: "tok", fetchImpl: async () => ({ ok: false }) }),
      null
    );
    assert.equal(
      await fetchMqttService({ token: "tok", fetchImpl: async () => { throw new Error("ECONNREFUSED"); } }),
      null
    );
    assert.equal(
      await fetchMqttService({ token: "tok", fetchImpl: async () => ({ ok: true, json: async () => ({ data: {} }) }) }),
      null
    );
  });

  it("returns null when the request times out", async () => {
    const fetchImpl = async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    };
    assert.equal(await fetchMqttService({ token: "tok", fetchImpl }), null);
  });
});

describe("waitForMqttService", () => {
  const ok = {
    ok: true,
    json: async () => ({ data: { host: "core-mosquitto", port: 1883, username: "u", password: "p" } }),
  };

  it("retries with backoff until the Supervisor offers a broker", async () => {
    let calls = 0;
    const fetchImpl = async () => (++calls <= 2 ? { ok: false } : ok);
    const delays = [];
    const logs = [];
    const svc = await waitForMqttService({
      token: "tok",
      fetchImpl,
      sleep: async (ms) => delays.push(ms),
      log: (msg) => logs.push(msg),
    });
    assert.equal(svc.broker, "core-mosquitto");
    assert.deepEqual(delays, [1000, 2000]);
    assert.equal(logs.length, 2);
    assert.match(logs[0], /retrying in 1s/);
  });

  it("caps the backoff at maxDelayMs", async () => {
    let calls = 0;
    const fetchImpl = async () => (++calls <= 8 ? { ok: false } : ok);
    const delays = [];
    await waitForMqttService({
      token: "tok",
      fetchImpl,
      sleep: async (ms) => delays.push(ms),
      log: () => {},
    });
    assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
  });

  it("returns null without a Supervisor token", async () => {
    const fetchImpl = async () => assert.fail("should not fetch");
    assert.equal(await waitForMqttService({ token: undefined, fetchImpl }), null);
  });
});

describe("installLogTimestamps", () => {
  it("prefixes each line with an ISO timestamp, keeping printf formatting", () => {
    const lines = [];
    const target = {};
    for (const m of ["log", "info", "warn", "error", "debug"]) target[m] = (s) => lines.push(`${m}:${s}`);
    installLogTimestamps(target, () => new Date("2026-10-26T12:00:00Z"));
    target.log("[Bus] %s @ %d", "BUS 042", 5);
    target.warn("[Feed]", "no fix");
    assert.deepEqual(lines, [
      "log:2026-10-26T12:00:00.000Z [Bus] BUS 042 @ 5",
      "warn:2026-10-26T12:00:00.000Z [Feed] no fix",
    ]);
  });
});

describe("add-on manifest", () => {
  it("keeps config.yaml's version in sync with package.json", () => {
    const yaml = fs.readFileSync(path.join(__dirname, "..", "myride_bridge", "config.yaml"), "utf-8");
    const match = yaml.match(/^version:\s*"?([^"\n]+)"?\s*$/m);
    assert.ok(match, "config.yaml has a version");
    assert.equal(match[1], require("../package.json").version);
  });
});
