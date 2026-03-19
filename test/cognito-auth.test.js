const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { CognitoAuth } = require("../src/cognito-auth");

// Helper: build a fake JWT with a given payload
function fakeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

describe("CognitoAuth", () => {
  let auth;
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    auth = new CognitoAuth({ clientId: "test-client-id", region: "us-west-2" });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("constructor", () => {
    it("builds the correct endpoint from region", () => {
      assert.equal(auth.endpoint, "https://cognito-idp.us-west-2.amazonaws.com/");
    });

    it("defaults region to us-east-1", () => {
      const a = new CognitoAuth({ clientId: "x" });
      assert.equal(a.endpoint, "https://cognito-idp.us-east-1.amazonaws.com/");
    });
  });

  describe("refresh()", () => {
    it("returns accessToken, idToken, expiresIn on success", async () => {
      const accessToken = fakeJwt({ sub: "user1", exp: 1700000000 });
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          AuthenticationResult: {
            AccessToken: accessToken,
            IdToken: "id-token-value",
          },
        }),
      });

      const result = await auth.refresh("my-refresh-token");
      assert.equal(result.accessToken, accessToken);
      assert.equal(result.idToken, "id-token-value");
      assert.equal(result.expiresIn, 1700000000);
    });

    it("sends correct request to Cognito endpoint", async () => {
      let capturedUrl, capturedOpts;
      const accessToken = fakeJwt({ exp: 999 });
      globalThis.fetch = async (url, opts) => {
        capturedUrl = url;
        capturedOpts = opts;
        return {
          ok: true,
          json: async () => ({
            AuthenticationResult: { AccessToken: accessToken, IdToken: "id" },
          }),
        };
      };

      await auth.refresh("rt-123");
      assert.equal(capturedUrl, "https://cognito-idp.us-west-2.amazonaws.com/");
      assert.equal(capturedOpts.method, "POST");
      const body = JSON.parse(capturedOpts.body);
      assert.equal(body.AuthFlow, "REFRESH_TOKEN_AUTH");
      assert.equal(body.ClientId, "test-client-id");
      assert.equal(body.AuthParameters.REFRESH_TOKEN, "rt-123");
    });

    it("throws with tokenExpired=true for NotAuthorizedException", async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({ __type: "NotAuthorizedException", message: "Token expired" }),
      });

      try {
        await auth.refresh("bad-token");
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.tokenExpired, true);
        assert.match(err.message, /Cognito REFRESH_TOKEN_AUTH failed/);
      }
    });

    it("throws with tokenExpired=true for 'Refresh Token has expired'", async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({ message: "Refresh Token has expired" }),
      });

      try {
        await auth.refresh("old-token");
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.tokenExpired, true);
      }
    });

    it("throws with tokenExpired=true for 'Refresh Token has been revoked'", async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 400,
        text: async () =>
          JSON.stringify({ message: "Refresh Token has been revoked" }),
      });

      try {
        await auth.refresh("revoked");
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.tokenExpired, true);
      }
    });

    it("throws with tokenExpired=false for transient errors", async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ message: "Internal error" }),
      });

      try {
        await auth.refresh("tok");
        assert.fail("should have thrown");
      } catch (err) {
        assert.equal(err.tokenExpired, false);
      }
    });

    it("handles non-JSON error body", async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 502,
        text: async () => "Bad Gateway",
      });

      try {
        await auth.refresh("tok");
        assert.fail("should have thrown");
      } catch (err) {
        assert.match(err.message, /Bad Gateway/);
        assert.equal(err.tokenExpired, false);
      }
    });

    it("throws when AccessToken is missing from response", async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ AuthenticationResult: {} }),
      });

      await assert.rejects(() => auth.refresh("tok"), /unexpected response/i);
    });

    it("throws when AuthenticationResult is missing", async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ SomethingElse: true }),
      });

      await assert.rejects(() => auth.refresh("tok"), /unexpected response/i);
    });
  });

  describe("validate()", () => {
    it("returns true when refresh succeeds", async () => {
      const accessToken = fakeJwt({ exp: 999 });
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({
          AuthenticationResult: { AccessToken: accessToken, IdToken: "id" },
        }),
      });

      assert.equal(await auth.validate("good-token"), true);
    });

    it("returns false when refresh throws", async () => {
      globalThis.fetch = async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: "Invalid" }),
      });

      assert.equal(await auth.validate("bad-token"), false);
    });
  });
});
