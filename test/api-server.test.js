const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { ApiServer } = require("../src/api-server");

// Helper: make an HTTP request and return { status, headers, body }
async function request(port, method, urlPath, body) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    body: body !== undefined ? body : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

describe("ApiServer", () => {
  let server;
  let tmpDir;
  let tokenFile;
  let port;
  let onNewTokenCalls;
  let statusObj;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "apitest-"));
    tokenFile = path.join(tmpDir, "token");
    onNewTokenCalls = [];
    statusObj = { ok: true, signalr: "Connected" };

    server = new ApiServer({
      port: 0, // OS-assigned
      tokenFile,
      onNewToken: async (token) => {
        onNewTokenCalls.push(token);
      },
      getStatus: () => statusObj,
    });
    await server.start();
    port = server.server.address().port;
  });

  afterEach(async () => {
    await server.stop();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("GET /status", () => {
    it("returns JSON from getStatus callback", async () => {
      const res = await request(port, "GET", "/status");
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.ok, true);
      assert.equal(data.signalr, "Connected");
    });
  });

  describe("POST /token", () => {
    it("returns 400 for empty body", async () => {
      const res = await request(port, "POST", "/token", "");
      assert.equal(res.status, 400);
      const data = JSON.parse(res.body);
      assert.ok(data.error.includes("Empty token"));
    });

    it("returns 400 for whitespace-only body", async () => {
      const res = await request(port, "POST", "/token", "   \n  ");
      assert.equal(res.status, 400);
    });

    it("returns 200 and calls onNewToken on success", async () => {
      const res = await request(port, "POST", "/token", "my-refresh-token-123");
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.ok, true);
      assert.deepEqual(onNewTokenCalls, ["my-refresh-token-123"]);
    });

    it("persists token to file", async () => {
      await request(port, "POST", "/token", "persisted-token");
      const saved = fs.readFileSync(tokenFile, "utf-8").trim();
      assert.equal(saved, "persisted-token");
    });

    it("returns 422 when onNewToken throws", async () => {
      server.onNewToken = async () => {
        throw new Error("validation failed");
      };

      const res = await request(port, "POST", "/token", "bad-token");
      assert.equal(res.status, 422);
      const data = JSON.parse(res.body);
      assert.equal(data.ok, false);
      assert.ok(data.error.includes("validation failed"));
    });
  });

  describe("unknown routes", () => {
    it("returns 404 for GET /unknown", async () => {
      const res = await request(port, "GET", "/unknown");
      assert.equal(res.status, 404);
    });

    it("returns 404 for POST /status", async () => {
      const res = await request(port, "POST", "/status");
      assert.equal(res.status, 404);
    });
  });

  describe("loadTokenFromFile()", () => {
    it("returns token from existing file", () => {
      fs.writeFileSync(tokenFile, "saved-token\n");
      const result = server.loadTokenFromFile();
      assert.equal(result, "saved-token");
    });

    it("returns null when file does not exist", () => {
      const result = server.loadTokenFromFile();
      assert.equal(result, null);
    });

    it("returns null when file is empty", () => {
      fs.writeFileSync(tokenFile, "");
      const result = server.loadTokenFromFile();
      assert.equal(result, null);
    });

    it("trims whitespace from token", () => {
      fs.writeFileSync(tokenFile, "  tok-123  \n");
      const result = server.loadTokenFromFile();
      assert.equal(result, "tok-123");
    });
  });
});
