"use strict";

const API_BASE = "https://myridek12.tylerapi.com";

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
        "x-tenant-id": this.tenantId,
        "x-client-language": "en",
        "x-device-type": "browser",
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
