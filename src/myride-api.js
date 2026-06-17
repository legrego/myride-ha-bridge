"use strict";

const API_BASE = "https://myridek12.tylerapi.com";

const CLIENT_VERSION = "2026.2.17+bcb384";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

class MyRideApi {
  /**
   * @param {object} opts
   * @param {function} opts.accessTokenFactory — async/sync fn returning current access token
   * @param {string} opts.tenantId — district tenant UUID
   */
  constructor({ accessTokenFactory, tenantId }) {
    this.accessTokenFactory = accessTokenFactory;
    this.tenantId = tenantId;
  }

  /**
   * Fetch the list of students for the authenticated parent.
   * Each student includes runInfo[] with today's active bus assignments.
   *
   * @returns {Promise<Array>} raw student objects from /api/student
   */
  async getStudents() {
    const token = await this.accessTokenFactory();

    const res = await fetch(`${API_BASE}/api/student`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        accept: "*/*",
        "accept-language": "en-US,en;q=0.9",
        "cache-control": "no-cache",
        pragma: "no-cache",
        referer: "https://myridek12.tylerapp.com/",
        "user-agent": USER_AGENT,
        "x-client-language": "en",
        "x-client-version": CLIENT_VERSION,
        "x-device-type": "browser",
        "x-tenant-id": this.tenantId,
        origin: "https://myridek12.tylerapp.com",
      },
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      const errBody = await res.text();
      let errMsg;
      try {
        const parsed = JSON.parse(errBody);
        errMsg = parsed.message || parsed.__type || errBody;
      } catch {
        errMsg = errBody;
      }

      const err = new Error(`MyRide /api/student failed (${res.status}): ${errMsg}`);
      err.tokenExpired = res.status === 401;
      throw err;
    }

    return res.json();
  }
}

module.exports = { MyRideApi };
