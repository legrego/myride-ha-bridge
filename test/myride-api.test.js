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
        text: async () => "Bad Gateway",
      });

      try {
        await api.getStudents();
        assert.fail("should have thrown");
      } catch (err) {
        assert.match(err.message, /Bad Gateway/);
      }
    });
  });
});
