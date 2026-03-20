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

class ApiServer {
  /**
   * @param {object} opts
   * @param {number}   opts.port       — Listen port (default 8099)
   * @param {string}   opts.tokenFile  — Path to persist refresh token
   * @param {function} opts.onNewToken — async callback(refreshToken) for hot-reload
   * @param {function} opts.getStatus  — callback() returning status object
   */
  constructor({ port = 8099, tokenFile, onNewToken, getStatus }) {
    this.port = port;
    this.tokenFile = tokenFile;
    this.onNewToken = onNewToken;
    this.getStatus = getStatus;

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

  async _handleRequest(req, res) {
    try {
      if (req.method === "GET" && req.url === "/") {
        this._handleGetRoot(req, res);
      } else if (req.method === "POST" && req.url === "/token") {
        await this._handlePostToken(req, res);
      } else if (req.method === "GET" && req.url === "/status") {
        this._handleGetStatus(req, res);
      } else if (req.method === "GET" && req.url === "/snippet") {
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
