/**
 * cognito-auth.js — Authenticate against MyRide K-12's AWS Cognito User Pool.
 *
 * Two ways in, both against the public web-app client (no client secret):
 *
 *   1. EMAIL + PASSWORD (USER_PASSWORD_AUTH): the bridge signs in itself and signs
 *      in again whenever the refresh token expires. The client has this flow
 *      enabled (SRP, CUSTOM_AUTH and USER_AUTH are off) — see
 *      docs/research/2026-10-28-credential-bootstrap.md. Tyler may turn it off,
 *      so a captured refresh token remains the fallback.
 *
 *   2. CAPTURED REFRESH TOKEN: the user logs in at myridek12.tylerapp.com and
 *      copies the refresh token out of the web app (capture-tokens.js).
 *
 * Either way the bridge then renews the access token with REFRESH_TOKEN_AUTH.
 *
 * Cognito settings (shared across all MyRide users):
 *   - User Pool:  us-east-1_sfRczsC0e
 *   - Client ID:  3c5382gsq7g13djnejo98p2d98
 *   - Region:     us-east-1
 *   - Token TTL:  60 min (access), 30 days (refresh, default)
 */

// Cognito errors from USER_PASSWORD_AUTH that the same credentials will always get
// again. Retrying them only counts toward the account's lockout.
const PERMANENT_LOGIN_ERRORS = [
  "NotAuthorizedException",        // wrong password, disabled user, too many attempts
  "UserNotFoundException",
  "UserNotConfirmedException",
  "PasswordResetRequiredException",
  "InvalidParameterException",     // e.g. USER_PASSWORD_AUTH turned off for the client
];

/** The access/ID tokens and access-token expiry from an InitiateAuth response. */
function tokensFrom(data) {
  const result = data && data.AuthenticationResult;
  if (!result || !result.AccessToken) {
    throw new Error(
      "Cognito returned unexpected response: " + JSON.stringify(data)
    );
  }

  // Decode the access token to get expiration timestamp
  const payload = JSON.parse(
    Buffer.from(result.AccessToken.split(".")[1], "base64url").toString()
  );

  return {
    accessToken: result.AccessToken,
    idToken: result.IdToken,
    expiresIn: payload.exp, // Unix timestamp of expiration
  };
}

class CognitoAuth {
  /**
   * @param {object} opts
   * @param {string} opts.clientId  — Cognito app client ID
   * @param {string} opts.region    — AWS region
   */
  constructor({ clientId, region = "us-east-1" }) {
    this.clientId = clientId;
    this.region = region;
    this.endpoint = `https://cognito-idp.${region}.amazonaws.com/`;
  }

  /**
   * Refresh the access token using a Cognito refresh token.
   * Uses the InitiateAuth API directly via HTTP — no AWS SDK required.
   *
   * @param {string} refreshToken — Cognito refresh token from browser capture
   * @returns {Promise<{accessToken: string, idToken: string, expiresIn: number}>}
   */
  async refresh(refreshToken) {
    let data;
    try {
      data = await this._initiateAuth("REFRESH_TOKEN_AUTH", {
        REFRESH_TOKEN: refreshToken,
      });
    } catch (err) {
      // Mark errors that mean the refresh token itself is invalid/expired
      // so callers can distinguish from transient network failures.
      const msg = err.cognitoMessage || "";
      err.tokenExpired = (err.cognitoType || "").includes("NotAuthorizedException") ||
        msg.includes("Refresh Token has expired") ||
        msg.includes("Refresh Token has been revoked") ||
        msg.includes("Invalid Refresh Token");
      throw err;
    }
    return tokensFrom(data);
  }

  /**
   * Sign in with the MyRide account's email and password (USER_PASSWORD_AUTH).
   * The returned refresh token then renews the access token like a captured one.
   *
   * Errors that retrying the same credentials can't fix (wrong password, unknown
   * or disabled user, the flow turned off, a challenge such as MFA or a forced
   * password change) carry `credentialsRejected` and `tokenExpired`, so callers
   * route them into the same idle path as an expired refresh token.
   *
   * @param {string} username — MyRide account email
   * @param {string} password
   * @returns {Promise<{accessToken: string, idToken: string, refreshToken: string, expiresIn: number}>}
   */
  async login(username, password) {
    let data;
    try {
      data = await this._initiateAuth("USER_PASSWORD_AUTH", {
        USERNAME: username,
        PASSWORD: password,
      });
    } catch (err) {
      const rejected = PERMANENT_LOGIN_ERRORS.some((t) => (err.cognitoType || "").includes(t));
      err.credentialsRejected = rejected;
      err.tokenExpired = rejected;
      throw err;
    }

    if (data.ChallengeName) {
      const err = new Error(
        `MyRide asked for ${data.ChallengeName} after the password, which the bridge can't answer`
      );
      err.credentialsRejected = true;
      err.tokenExpired = true;
      throw err;
    }

    const tokens = tokensFrom(data);
    if (!data.AuthenticationResult.RefreshToken) {
      throw new Error("Cognito sign-in returned no refresh token");
    }
    return { ...tokens, refreshToken: data.AuthenticationResult.RefreshToken };
  }

  /**
   * POST an InitiateAuth request. Uses the Cognito HTTP API directly — no AWS
   * SDK required. A failed request throws with the Cognito error type and
   * message on `cognitoType`/`cognitoMessage`.
   */
  async _initiateAuth(authFlow, authParameters) {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target":
          "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify({
        AuthFlow: authFlow,
        ClientId: this.clientId,
        AuthParameters: authParameters,
      }),
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errBody = await res.text();
      let errMsg;
      let errType;
      try {
        const parsed = JSON.parse(errBody);
        errMsg = parsed.message || parsed.__type || errBody;
        errType = parsed.__type || "";
      } catch {
        errMsg = errBody;
        errType = "";
      }
      const err = new Error(`Cognito ${authFlow} failed (${res.status}): ${errMsg}`);
      err.cognitoType = errType;
      err.cognitoMessage = errMsg;
      throw err;
    }

    return res.json();
  }

  /**
   * Validate that a refresh token is still usable by attempting a refresh.
   * @param {string} refreshToken
   * @returns {Promise<boolean>}
   */
  async validate(refreshToken) {
    try {
      await this.refresh(refreshToken);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Email/password sign-in with a lockout guard: once MyRide rejects the
 * credentials it refuses to try them again until reset() (a new token was
 * submitted) or a restart (the settings changed). Concurrent callers share one
 * in-flight sign-in.
 */
class PasswordLogin {
  /**
   * @param {object} opts
   * @param {CognitoAuth} opts.auth
   * @param {string|null} opts.username — MyRide account email
   * @param {string|null} opts.password
   */
  constructor({ auth, username, password }) {
    this.auth = auth;
    this.username = username || null;
    this.password = password || null;
    this.rejection = null; // message of the error that rejected the credentials
    this._inFlight = null;
  }

  /** Both an email and a password are set. */
  get configured() {
    return Boolean(this.username && this.password);
  }

  /** Configured and not rejected, so a sign-in may be attempted. */
  get available() {
    return this.configured && !this.rejection;
  }

  /** @returns {Promise<{accessToken, idToken, refreshToken, expiresIn}>} */
  login() {
    if (!this.configured) return Promise.reject(new Error("No MyRide email and password configured"));
    if (this.rejection) {
      const err = new Error(`MyRide rejected the email and password: ${this.rejection}`);
      err.credentialsRejected = true;
      err.tokenExpired = true;
      return Promise.reject(err);
    }
    if (!this._inFlight) {
      this._inFlight = this.auth.login(this.username, this.password)
        .catch((err) => {
          if (err.credentialsRejected) this.rejection = err.message;
          throw err;
        })
        .finally(() => { this._inFlight = null; });
    }
    return this._inFlight;
  }

  /** Allow another attempt with the same credentials. */
  reset() {
    this.rejection = null;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The district tenant IDs a MyRide access token grants: the UUID-shaped entries
 * of its `cognito:groups` claim, as written. Empty when the token can't be decoded
 * or carries none.
 * @param {string} accessToken — Cognito access token (JWT)
 * @returns {string[]}
 */
function tenantIdsFromToken(accessToken) {
  try {
    const payload = JSON.parse(
      Buffer.from(String(accessToken).split(".")[1], "base64url").toString()
    );
    const groups = Array.isArray(payload["cognito:groups"]) ? payload["cognito:groups"] : [];
    return groups.filter((g) => typeof g === "string" && UUID_RE.test(g));
  } catch {
    return [];
  }
}

/**
 * Pick the tenant ID to use: the configured one if set, else the first one in the
 * access token. `warning` explains a choice the user may want to override.
 * @param {string|null} configured — MYRIDE_TENANT_ID / the tenant_id option
 * @param {string} accessToken
 * @returns {{tenantId: string|null, fromToken: string[], warning: string|null}}
 */
function resolveTenantId(configured, accessToken) {
  const fromToken = tenantIdsFromToken(accessToken);
  if (configured) {
    const mismatch = fromToken.length > 0 &&
      !fromToken.some((t) => t.toLowerCase() === configured.toLowerCase());
    return {
      tenantId: configured,
      fromToken,
      warning: mismatch
        ? `Configured tenant ID ${configured} isn't in this token (it has ${fromToken.join(", ")}). ` +
          "Clear the tenant ID setting to use the token's."
        : null,
    };
  }
  return {
    tenantId: fromToken[0] || null,
    fromToken,
    warning: fromToken.length > 1
      ? `Token has several tenant IDs (${fromToken.join(", ")}); using the first. ` +
        "Set the tenant ID to pick another."
      : null,
  };
}

module.exports = { CognitoAuth, PasswordLogin, tenantIdsFromToken, resolveTenantId };
