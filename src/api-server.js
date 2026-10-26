/**
 * api-server.js — Minimal HTTP API for managing the bridge at runtime.
 *
 * Endpoints:
 *   POST /token  — Submit a new refresh token (plain-text body).
 *                  Persists to TOKEN_FILE and hot-reloads the bridge.
 *   GET  /status — JSON health check (token validity, SignalR state, etc.)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { version } = require("./version");

class ApiServer {
  /**
   * @param {object} opts
   * @param {number}   opts.port       — Listen port (default 8099)
   * @param {string}   opts.tokenFile  — Path to persist refresh token
   * @param {function} opts.onNewToken — async callback(refreshToken) for hot-reload
   * @param {function} opts.getStatus  — callback() returning status object
   * @param {string[]} [opts.allowedRemotes] — if set, only these client IPs are
   *   served (others get 403). The HA add-on uses it to accept only ingress
   *   (the Supervisor) and the container's own healthcheck.
   */
  constructor({ port = 8099, tokenFile, onNewToken, getStatus, allowedRemotes = null }) {
    this.port = port;
    this.tokenFile = tokenFile;
    this.onNewToken = onNewToken;
    this.getStatus = getStatus;
    this.allowedRemotes = allowedRemotes ? new Set(allowedRemotes) : null;

    this.server = http.createServer((req, res) => {
      this._handleRequest(req, res);
    });
  }

  /**
   * Load a previously-saved refresh token from the token file.
   * Returns null if the file doesn't exist or is empty.
   */
  loadTokenFromFile() {
    try {
      const token = fs.readFileSync(this.tokenFile, "utf-8").trim();
      if (token) {
        console.log(`[API] Loaded refresh token from ${this.tokenFile}`);
        return token;
      }
    } catch (err) {
      if (err.code !== "ENOENT") {
        console.warn(`[API] Could not read token file: ${err.message}`);
      }
    }
    return null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, () => {
        console.log(`[API] Listening on http://0.0.0.0:${this.port}`);
        console.log(`[API]   POST /token — submit new refresh token`);
        console.log(`[API]   GET  /status — bridge health check`);
        console.log(`[API]   GET  /version — build version info`);
        console.log(`[API]   GET  /snippet — token capture browser snippet`);
        resolve();
      });
      this.server.on("error", reject);
    });
  }

  stop() {
    return new Promise((resolve) => {
      this.server.close(resolve);
    });
  }

  _isAllowedRemote(address) {
    if (!this.allowedRemotes) return true;
    // IPv4 clients of a dual-stack socket appear as ::ffff:a.b.c.d
    const ip = String(address || "").replace(/^::ffff:/, "");
    return this.allowedRemotes.has(ip);
  }

  async _handleRequest(req, res) {
    try {
      if (!this._isAllowedRemote(req.socket.remoteAddress)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Forbidden" }));
        return;
      }
      const pathname = req.url.split("?")[0];
      if (req.method === "GET" && pathname === "/") {
        this._handleGetRoot(req, res);
      } else if (req.method === "POST" && pathname === "/token") {
        await this._handlePostToken(req, res);
      } else if (req.method === "GET" && pathname === "/status") {
        this._handleGetStatus(req, res);
      } else if (req.method === "GET" && pathname === "/version") {
        this._handleGetVersion(req, res);
      } else if (req.method === "GET" && pathname === "/snippet") {
        this._handleGetSnippet(req, res);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    } catch (err) {
      console.error("[API] Request error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }

  async _handlePostToken(req, res) {
    const body = await this._readBody(req);
    const token = body.trim();

    if (!token) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Empty token. Send the refresh token as the request body." }));
      return;
    }

    // Persist to file
    const dir = path.dirname(this.tokenFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.tokenFile, token + "\n", { mode: 0o600 });
    console.log(`[API] Saved new refresh token to ${this.tokenFile}`);

    // Hot-reload
    try {
      await this.onNewToken(token);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, message: "Token updated. Bridge is reconnecting." }));
    } catch (err) {
      res.writeHead(422, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        error: "Token saved but validation failed: " + err.message,
      }));
    }
  }

  _handleGetRoot(_req, res) {
    const html = fs.readFileSync(path.join(__dirname, "../public/index.html"));
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(html);
  }

  _handleGetSnippet(_req, res) {
    const snippet = fs.readFileSync(path.join(__dirname, "capture-tokens.js"), "utf-8");
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(snippet);
  }

  _handleGetStatus(req, res) {
    const status = this.getStatus();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(status, null, 2));
  }

  _handleGetVersion(_req, res) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(version, null, 2));
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolve(Buffer.concat(chunks).toString()));
      req.on("error", reject);
    });
  }
}

module.exports = { ApiServer };
