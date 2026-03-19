/**
 * cognito-auth.js — Authenticate against MyRide K-12's AWS Cognito User Pool.
 *
 * ARCHITECTURE DISCOVERY:
 * MyRide K-12 does NOT allow direct Cognito auth (SRP/USER_PASSWORD_AUTH are
 * disabled). Instead, Tyler Technologies runs their own IdentityServer at:
 *   myridek12.tylerapp.com/login/core/connect/authorize
 * which handles the login form and issues Cognito tokens server-side.
 *
 * STRATEGY — Two-phase auth:
 *   1. BOOTSTRAP (one-time, interactive):
 *      - User logs in via browser at myridek12.tylerapp.com
 *      - Runs capture-tokens.js bookmarklet/console snippet
 *      - Saves the refresh token to .env
 *
 *   2. RUNTIME (automated):
 *      - Uses REFRESH_TOKEN_AUTH flow via Cognito HTTP API
 *      - This flow is always enabled, even when SRP/PASSWORD are disabled
 *      - Refresh tokens last 30 days by default (up to 10 years configurable)
 *      - When it expires, re-run the browser capture
 *
 * Cognito settings (shared across all MyRide users):
 *   - User Pool:  us-east-1_sfRczsC0e
 *   - Client ID:  3c5382gsq7g13djnejo98p2d98
 *   - Region:     us-east-1
 *   - Token TTL:  60 min (access), 30 days (refresh, default)
 */

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
    const body = {
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: this.clientId,
      AuthParameters: {
        REFRESH_TOKEN: refreshToken,
      },
    };

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-amz-json-1.1",
        "X-Amz-Target":
          "AWSCognitoIdentityProviderService.InitiateAuth",
      },
      body: JSON.stringify(body),
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

      const err = new Error(
        `Cognito REFRESH_TOKEN_AUTH failed (${res.status}): ${errMsg}`
      );

      // Mark errors that mean the refresh token itself is invalid/expired
      // so callers can distinguish from transient network failures.
      const permanent = errType.includes("NotAuthorizedException") ||
        errMsg.includes("Refresh Token has expired") ||
        errMsg.includes("Refresh Token has been revoked") ||
        errMsg.includes("Invalid Refresh Token");
      err.tokenExpired = permanent;

      throw err;
    }

    const data = await res.json();
    const result = data.AuthenticationResult;

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

module.exports = { CognitoAuth };
