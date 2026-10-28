const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { CognitoAuth, PasswordLogin, tenantIdsFromToken, resolveTenantId } = require("../src/cognito-auth");

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

  describe("login()", () => {
    function cognitoError(status, type, message) {
      return async () => ({
        ok: false,
        status,
        text: async () => JSON.stringify({ __type: type, message }),
      });
    }

    it("signs in with USER_PASSWORD_AUTH and returns the refresh token", async () => {
      let capturedBody, capturedTarget;
      const accessToken = fakeJwt({ exp: 1700000000 });
      globalThis.fetch = async (url, opts) => {
        capturedBody = JSON.parse(opts.body);
        capturedTarget = opts.headers["X-Amz-Target"];
        return {
          ok: true,
          json: async () => ({
            AuthenticationResult: { AccessToken: accessToken, IdToken: "id", RefreshToken: "rt" },
          }),
        };
      };

      const result = await auth.login("parent@example.com", "pw");
      assert.deepEqual(capturedBody, {
        AuthFlow: "USER_PASSWORD_AUTH",
        ClientId: "test-client-id",
        AuthParameters: { USERNAME: "parent@example.com", PASSWORD: "pw" },
      });
      assert.equal(capturedTarget, "AWSCognitoIdentityProviderService.InitiateAuth");
      assert.deepEqual(result, { accessToken, idToken: "id", refreshToken: "rt", expiresIn: 1700000000 });
    });

    for (const [type, message] of [
      ["NotAuthorizedException", "Incorrect username or password."],
      ["NotAuthorizedException", "Password attempts exceeded"],
      ["UserNotFoundException", "User does not exist."],
      ["PasswordResetRequiredException", "Password reset required for the user"],
      ["InvalidParameterException", "USER_PASSWORD_AUTH flow not enabled for this client"],
    ]) {
      it(`rejects the credentials for ${type}: ${message}`, async () => {
        globalThis.fetch = cognitoError(400, type, message);
        await assert.rejects(auth.login("u", "p"), (err) => {
          assert.equal(err.credentialsRejected, true);
          assert.equal(err.tokenExpired, true);
          assert.match(err.message, /USER_PASSWORD_AUTH failed \(400\)/);
          assert.ok(err.message.includes(message));
          return true;
        });
      });
    }

    it("treats throttling, server and network errors as transient", async () => {
      for (const fetchImpl of [
        cognitoError(400, "TooManyRequestsException", "Rate exceeded"),
        cognitoError(500, "InternalErrorException", "Internal error"),
        async () => { throw new TypeError("fetch failed"); },
      ]) {
        globalThis.fetch = fetchImpl;
        await assert.rejects(auth.login("u", "p"), (err) => {
          assert.equal(err.credentialsRejected, false);
          assert.equal(err.tokenExpired, false);
          return true;
        });
      }
    });

    it("rejects the credentials when MyRide answers with a challenge", async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "s" }),
      });
      await assert.rejects(auth.login("u", "p"), (err) => {
        assert.equal(err.credentialsRejected, true);
        assert.equal(err.tokenExpired, true);
        assert.match(err.message, /NEW_PASSWORD_REQUIRED/);
        return true;
      });
    });

    it("throws when the sign-in returns no refresh token", async () => {
      globalThis.fetch = async () => ({
        ok: true,
        json: async () => ({ AuthenticationResult: { AccessToken: fakeJwt({ exp: 1 }) } }),
      });
      await assert.rejects(auth.login("u", "p"), /no refresh token/);
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

describe("PasswordLogin", () => {
  const TOKENS = { accessToken: "a", idToken: "i", refreshToken: "r", expiresIn: 1 };

  function rejected(message = "Incorrect username or password.") {
    const err = new Error(message);
    err.credentialsRejected = true;
    err.tokenExpired = true;
    return err;
  }

  function fakeAuth(...outcomes) {
    const calls = [];
    return {
      calls,
      login: async (username, password) => {
        calls.push([username, password]);
        const next = outcomes.shift();
        if (next instanceof Error) throw next;
        return next;
      },
    };
  }

  it("is configured only with both an email and a password", () => {
    assert.equal(new PasswordLogin({ auth: fakeAuth(), username: "u", password: "p" }).configured, true);
    assert.equal(new PasswordLogin({ auth: fakeAuth(), username: "u", password: null }).configured, false);
    assert.equal(new PasswordLogin({ auth: fakeAuth(), username: "", password: "p" }).configured, false);
  });

  it("refuses to sign in when not configured", async () => {
    const auth = fakeAuth();
    await assert.rejects(new PasswordLogin({ auth, username: null, password: null }).login(), /No MyRide email/);
    assert.equal(auth.calls.length, 0);
  });

  it("signs in with the configured credentials", async () => {
    const auth = fakeAuth(TOKENS);
    const login = new PasswordLogin({ auth, username: "u", password: "p" });
    assert.deepEqual(await login.login(), TOKENS);
    assert.deepEqual(auth.calls, [["u", "p"]]);
    assert.equal(login.available, true);
  });

  it("shares one sign-in between concurrent callers", async () => {
    const auth = fakeAuth(TOKENS);
    const login = new PasswordLogin({ auth, username: "u", password: "p" });
    const [a, b] = await Promise.all([login.login(), login.login()]);
    assert.equal(a, b);
    assert.equal(auth.calls.length, 1);
  });

  it("stops trying rejected credentials until reset()", async () => {
    const auth = fakeAuth(rejected(), TOKENS);
    const login = new PasswordLogin({ auth, username: "u", password: "p" });

    await assert.rejects(login.login(), /Incorrect username or password/);
    assert.equal(login.available, false);
    assert.equal(login.rejection, "Incorrect username or password.");

    // Further attempts fail without contacting Cognito, as an expired token would.
    await assert.rejects(login.login(), (err) => {
      assert.equal(err.tokenExpired, true);
      assert.match(err.message, /rejected the email and password/);
      return true;
    });
    assert.equal(auth.calls.length, 1);

    login.reset();
    assert.equal(login.available, true);
    assert.deepEqual(await login.login(), TOKENS);
    assert.equal(auth.calls.length, 2);
  });

  it("keeps trying after a transient failure", async () => {
    const auth = fakeAuth(new Error("fetch failed"), TOKENS);
    const login = new PasswordLogin({ auth, username: "u", password: "p" });
    await assert.rejects(login.login(), /fetch failed/);
    assert.equal(login.available, true);
    assert.deepEqual(await login.login(), TOKENS);
  });
});

describe("tenantIdsFromToken", () => {
  const A = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
  const B = "11111111-2222-3333-4444-555555555555";

  it("returns the UUID-shaped cognito:groups, keeping their case", () => {
    const token = fakeJwt({ "cognito:groups": [A.toUpperCase(), "Parents", B] });
    assert.deepEqual(tenantIdsFromToken(token), [A.toUpperCase(), B]);
  });

  it("returns [] without the claim or for an undecodable token", () => {
    assert.deepEqual(tenantIdsFromToken(fakeJwt({ sub: "u" })), []);
    assert.deepEqual(tenantIdsFromToken(fakeJwt({ "cognito:groups": "nope" })), []);
    assert.deepEqual(tenantIdsFromToken("not-a-jwt"), []);
    assert.deepEqual(tenantIdsFromToken(undefined), []);
  });
});

describe("resolveTenantId", () => {
  const A = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
  const B = "11111111-2222-3333-4444-555555555555";

  it("uses the token's tenant when none is configured", () => {
    const r = resolveTenantId(null, fakeJwt({ "cognito:groups": [A] }));
    assert.equal(r.tenantId, A);
    assert.equal(r.warning, null);
  });

  it("uses the first of several and warns", () => {
    const r = resolveTenantId(null, fakeJwt({ "cognito:groups": [A, B] }));
    assert.equal(r.tenantId, A);
    assert.match(r.warning, /several tenant IDs/);
  });

  it("returns null when neither the config nor the token has one", () => {
    assert.equal(resolveTenantId(null, fakeJwt({ sub: "u" })).tenantId, null);
  });

  it("prefers the configured tenant, case-insensitively matching the token", () => {
    const r = resolveTenantId(A.toUpperCase(), fakeJwt({ "cognito:groups": [A] }));
    assert.equal(r.tenantId, A.toUpperCase());
    assert.equal(r.warning, null);
  });

  it("keeps the configured tenant but warns when the token disagrees", () => {
    const r = resolveTenantId(B, fakeJwt({ "cognito:groups": [A] }));
    assert.equal(r.tenantId, B);
    assert.match(r.warning, /isn't in this token/);
  });

  it("keeps the configured tenant silently when the token has none", () => {
    const r = resolveTenantId(B, fakeJwt({ sub: "u" }));
    assert.equal(r.tenantId, B);
    assert.equal(r.warning, null);
  });
});
