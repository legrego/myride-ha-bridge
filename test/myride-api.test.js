const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { MyRideApi } = require("../src/myride-api");

describe("MyRideApi", () => {
  let api;
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    api = new MyRideApi({
      accessTokenFactory: async () => "test-access-token",
      tenantId: "test-tenant-uuid",
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("getStudents()", () => {
    it("returns parsed JSON array on success", async () => {
      const fakeStudents = [{ uniqueId: "123", firstName: "Lucas", runInfo: [] }];
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => fakeStudents,
      });

      const result = await api.getStudents();
      assert.deepEqual(result, fakeStudents);
    });

    it("sends correct headers", async () => {
      let capturedUrl, capturedOpts;
      globalThis.fetch = async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return { ok: true, json: async () => [] };
      };

      await api.getStudents();

      assert.equal(capturedUrl, "https://myridek12.tylerapi.com/api/student");
      assert.equal(capturedOpts.method, "GET");
      assert.equal(capturedOpts.headers["Authorization"], "Bearer test-access-token");
      assert.equal(capturedOpts.headers["x-tenant-id"], "test-tenant-uuid");
      assert.equal(capturedOpts.headers["x-client-language"], "en");
      assert.equal(capturedOpts.headers["x-device-type"], "browser");
      assert.equal(capturedOpts.headers["origin"], "https://myridek12.tylerapp.com");
      assert.equal(capturedOpts.headers["accept"], "*/*");
      assert.equal(capturedOpts.headers["referer"], "https://myridek12.tylerapp.com/");
      assert.ok(/Mozilla\/5\.0/.test(capturedOpts.headers["user-agent"]));
      assert.ok(/^\d{4}\.\d+\.\d+/.test(capturedOpts.headers["x-client-version"]));
    });

    it("calls accessTokenFactory to get current token", async () => {
      let tokenRequested = false;
      const apiWithFactory = new MyRideApi({
        accessTokenFactory: async () => {
          tokenRequested = true;
          return "dynamic-token";
        },
        tenantId: "t",
      });

      let capturedAuth;
      globalThis.fetch = async (url, opts) => {
        capturedAuth = opts.headers["Authorization"];
        return { ok: true, json: async () => [] };
      };

      await apiWithFactory.getStudents();
      assert.equal(tokenRequested, true);
      assert.equal(capturedAuth, "Bearer dynamic-token");
    });

    it("throws with tokenExpired=true on 401", async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        headers: new Headers(),
        text: async () => "Unauthorized",
      });

      try {
        await api.getStudents();
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.tokenExpired, true);
        assert.match(err.message, /401/);
      }
    });

    it("throws with tokenExpired=false on non-401 errors", async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        headers: new Headers(),
        text: async () => "Internal Server Error",
      });

      try {
        await api.getStudents();
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.tokenExpired, false);
        assert.match(err.message, /500/);
      }
    });

    it("surfaces JSON error message from error body", async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 403,
        statusText: "Forbidden",
        headers: new Headers(),
        text: async () => JSON.stringify({ message: "Tenant not found" }),
      });

      try {
        await api.getStudents();
        assert.fail("should have thrown");
      } catch (err) {
        assert.match(err.message, /Tenant not found/);
      }
    });

    it("handles non-JSON error body gracefully", async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
        headers: new Headers(),
        text: async () => "Bad Gateway",
      });

      try {
        await api.getStudents();
        assert.fail("should have thrown");
      } catch (err) {
        assert.match(err.message, /Bad Gateway/);
      }
    });

    it("logs diagnostics and attaches response details on failure", async () => {
      let logged = "";
      const apiWithLogger = new MyRideApi({
        accessTokenFactory: async () => "test-access-token",
        tenantId: "test-tenant-uuid",
        logger: { error: (msg) => { logged += msg; }, log: () => {} },
      });

      globalThis.fetch = async () => ({
        ok: false,
        status: 417,
        statusText: "Expectation Failed",
        headers: new Headers({ server: "cloudflare", "cf-ray": "abc123" }),
        text: async () => "",
      });

      try {
        await apiWithLogger.getStudents();
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.status, 417);
        assert.equal(err.statusText, "Expectation Failed");
        assert.equal(err.responseHeaders["cf-ray"], "abc123");
        assert.equal(err.body, "");
      }

      // diagnostic log includes status, the edge/WAF response headers, and
      // never leaks the raw bearer token
      assert.match(logged, /417 Expectation Failed/);
      assert.match(logged, /cloudflare/);
      assert.match(logged, /\(empty\)/);
      assert.doesNotMatch(logged, /Bearer test-access-token/);
    });
  });
});
