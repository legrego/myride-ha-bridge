#!/usr/bin/env node
/**
 * MyRide K-12 → Home Assistant MQTT Bridge
 *
 * Connects to the MyRide K-12 LiveVehicleHub via SignalR and publishes
 * real-time bus location data to MQTT for Home Assistant consumption.
 *
 * Auth approach: Cognito REFRESH_TOKEN_AUTH
 *   - Easiest: set your MyRide email and password; the bridge signs in itself
 *     and signs in again whenever the refresh token expires
 *   - Or: capture your refresh token from the browser (see capture-tokens.js)
 *   - Ongoing: either way it gets fresh access tokens automatically
 *   - Fallback: you can also set a raw access token (expires in 60 min)
 *
 * Usage:
 *   cp .env.example .env   # fill in your tokens
 *   node index.js
 */

// ─── Load .env ───────────────────────────────────────────────────
try {
  const fs = require("fs");
  const path = require("path");
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        // Matching quotes keep a value as written (a password with spaces or `$`),
        // as Docker Compose reads the same file.
        if (val.length >= 2 && (val[0] === "'" || val[0] === '"') && val.at(-1) === val[0]) {
          val = val.slice(1, -1);
        }
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
} catch (e) {
  // .env loading is optional
}

// ─── Home Assistant add-on mode ──────────────────────────────────
// Under the Supervisor, options arrive in /data/options.json and stdout is the
// add-on log (no per-line timestamps), so map options → env and stamp lines.
const { applyAddonOptions, waitForMqttService, installLogTimestamps } = require("./addon-config");
const isAddon = Boolean(process.env.SUPERVISOR_TOKEN);
if (isAddon) {
  installLogTimestamps(console);
  applyAddonOptions();
}

const { CognitoAuth, PasswordLogin, resolveTenantId } = require("./cognito-auth");
const { MyRideSignalRClient } = require("./signalr-client");
const { MqttBridge, truncateJson } = require("./mqtt-bridge");
const { ApiServer } = require("./api-server");
const { runSimulation } = require("./simulator");
const { MyRideApi } = require("./myride-api");
const { StudentTracker } = require("./student-tracker");
const { FixOrderGuard } = require("./fix-order-guard");
const { FeedMonitor, inRunWindow } = require("./feed-monitor");
const { StreamSupervisor, STREAM_SILENCE_MS } = require("./stream-supervisor");
const { nowMinutesInTimeZone, formatMinutes } = require("./student-tracker");
const { EventLog } = require("./event-log");
const { StreamTimeline } = require("./stream-timeline");
const { countBridgeEntities } = require("./ha-entity-check");
const { describeStudents, addonConfigUrl, maskId, describeOptions } = require("./status");
const { version } = require("./version");

// ─── Configuration ───────────────────────────────────────────────
const config = {
  cognito: {
    clientId: process.env.COGNITO_CLIENT_ID || "3c5382gsq7g13djnejo98p2d98",
    region: process.env.COGNITO_REGION || "us-east-1",
  },
  myride: {
    refreshToken: process.env.MYRIDE_REFRESH_TOKEN || null,
    accessToken: process.env.MYRIDE_ACCESS_TOKEN || null,
    email: process.env.MYRIDE_EMAIL || null,
    password: process.env.MYRIDE_PASSWORD || null,
    tenantId: process.env.MYRIDE_TENANT_ID || null,
  },
  mqtt: {
    broker: process.env.MQTT_BROKER || null,
    port: parseInt(process.env.MQTT_PORT || "1883"),
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    topicPrefix: process.env.MQTT_TOPIC_PREFIX || "myride",
    // Parsed loosely; MqttBridge validates and falls back to 500 for NaN/≤0.
    approachRadiusMeters: Number(process.env.APPROACH_RADIUS_METERS),
  },
  busFilter: process.env.BUS_FILTER || null,
  // Parsed loosely; NaN/≤0 falls back to the default (see streamSupervisor below).
  streamSilenceSeconds: Number(process.env.STREAM_SILENCE_SECONDS),
  timeZone: process.env.TZ || "America/New_York",
  logLevel: process.env.LOG_LEVEL || "info",
  api: {
    port: parseInt(process.env.API_PORT || "8099"),
    tokenFile: process.env.TOKEN_FILE || "/data/refresh_token",
  },
};

// ─── API server (created early so we can load token from file) ───
const apiServer = new ApiServer({
  port: config.api.port,
  tokenFile: config.api.tokenFile,
  onNewToken: (token) => handleNewToken(token), // wired below
  getStatus: () => getBridgeStatus(),            // wired below
  // As an add-on the UI is served through ingress: accept only the Supervisor
  // (ingress proxy + watchdog) and loopback (the image HEALTHCHECK).
  allowedRemotes: isAddon ? ["172.30.32.2", "127.0.0.1", "::1"] : null,
});

// Load persisted token (file takes precedence over env var)
const fileToken = apiServer.loadTokenFromFile();
if (fileToken) {
  config.myride.refreshToken = fileToken;
}

// ─── Simulation mode ─────────────────────────────────────────────
if (process.env.SIMULATE === "true") {
  runSimulation({
    port: config.api.port,
    tokenFile: config.api.tokenFile,
    mqtt: config.mqtt.broker ? config.mqtt : null,
  });
  return; // module-level: skip the rest of the file
}

// Always created: even in static access-token mode (or with no token yet) a
// refresh token can arrive through POST /token.
const auth = new CognitoAuth({
  clientId: config.cognito.clientId,
  region: config.cognito.region,
});

// Email/password sign-in: used when there's no refresh token, and again each time
// the refresh token expires. A saved or submitted refresh token is tried first.
const passwordLogin = new PasswordLogin({
  auth,
  username: config.myride.email,
  password: config.myride.password,
});
if (Boolean(config.myride.email) !== Boolean(config.myride.password)) {
  console.warn(
    `[Auth] Only the MyRide ${config.myride.email ? "email" : "password"} is set; ` +
    "set both to sign in with them."
  );
}

// No token is not fatal: the status page is the way to supply one (as an add-on it's
// the only way short of editing the options), so the bridge serves it and waits —
// handleNewToken() starts the data side once POST /token delivers a valid token.
const tokenMissing =
  !config.myride.refreshToken && !config.myride.accessToken && !passwordLogin.configured;
if (tokenMissing) {
  console.error("╔═══════════════════════════════════════════════════════════╗");
  console.error("║  No MyRide credentials configured — waiting for them.    ║");
  console.error("╚═══════════════════════════════════════════════════════════╝");
  console.error();
  if (isAddon) {
    console.error("Easiest: enter your MyRide email and password on the app's");
    console.error("Configuration tab, then restart the app.");
  } else {
    console.error("Easiest: set MYRIDE_EMAIL and MYRIDE_PASSWORD (your MyRide login)");
    console.error("in your .env file and restart.");
  }
  console.error();
  console.error("Or capture a refresh token from the MyRide web app:");
  console.error();
  console.error("  1. Log in to https://myridek12.tylerapp.com in Chrome");
  console.error("  2. Open DevTools (F12) → Console tab");
  console.error("  3. Paste the contents of capture-tokens.js and press Enter");
  if (isAddon) {
    console.error("  4. Open the app's Web UI and paste the refresh token on its Setup");
    console.error("     tab (or set the refresh_token option)");
  } else {
    console.error(`  4. Paste the refresh token on the status page`);
    console.error(`     (port ${config.api.port}), or set it in your .env file and restart`);
    console.error();
    console.error("If the capture script can't find a refresh token, you can set");
    console.error("MYRIDE_ACCESS_TOKEN instead (but it expires in 60 minutes).");
  }
  console.error();
}

// ─── Token management ────────────────────────────────────────────
let currentAccessToken = config.myride.accessToken || null;
let tokenExpiresAt = 0;
let refreshTokenExpired = false;
const busStates = new Map(); // assetUniqueId → { name, lastSeen, speed, moving }

// For the status page: what happened (event log), the stream's recent history, and
// how the bridge last got its token.
const startedAtMs = Date.now();
const eventLog = new EventLog();
const streamTimeline = new StreamTimeline();
const signIn = { method: null, renewedAtMs: null, rejectedAtMs: null };
const STREAM_TIMELINE_SAMPLE_MS = 30_000;
let streamTimelineInterval = null;

// If we only have a raw access token, decode its expiry
if (currentAccessToken && !config.myride.refreshToken && !passwordLogin.configured) {
  try {
    const payload = JSON.parse(
      Buffer.from(currentAccessToken.split(".")[1], "base64url").toString()
    );
    tokenExpiresAt = payload.exp;
    const expiresIn = tokenExpiresAt - Math.floor(Date.now() / 1000);
    console.log(
      `[Auth] Using direct access token (expires in ${Math.round(expiresIn / 60)} minutes)`
    );
    if (expiresIn < 300) {
      console.warn(
        "[Auth] ⚠️  Token expires very soon! Set MYRIDE_EMAIL and MYRIDE_PASSWORD " +
        "(or MYRIDE_REFRESH_TOKEN) for auto-renewal."
      );
    }
  } catch {
    console.warn("[Auth] Could not decode access token expiry.");
    tokenExpiresAt = Math.floor(Date.now() / 1000) + 3600; // assume 1hr
  }
}

async function ensureFreshToken() {
  if (refreshTokenExpired) {
    throw new Error(
      "MyRide credentials are expired or rejected. Submit a new refresh token on the status page, " +
      "or fix the MyRide email and password."
    );
  }

  const now = Math.floor(Date.now() / 1000);

  // If we have a refresh token (or can sign in for one) and the access token is
  // expiring soon, renew it
  if (config.myride.refreshToken || passwordLogin.configured) {
    const needsRefresh = !currentAccessToken || now >= tokenExpiresAt - 300;
    if (needsRefresh) {
      try {
        await renewAccessToken();
      } catch (err) {
        // Permanent token errors (expired/revoked) must propagate immediately
        if (err.tokenExpired) throw err;
        // Transient error — fall back to existing token if it hasn't fully expired
        if (currentAccessToken && now < tokenExpiresAt) {
          console.warn(
            `[Auth] Cognito refresh failed (${err.message}), using cached token ` +
            `(expires in ${tokenExpiresAt - now}s)`
          );
        } else {
          // No usable cached token — propagate the error
          throw err;
        }
      }
    }
    return currentAccessToken;
  }

  // Fallback: using a static access token
  if (currentAccessToken) {
    if (now >= tokenExpiresAt) {
      throw new Error(
        "Access token has expired. Re-run capture-tokens.js in your browser, " +
        "or set MYRIDE_REFRESH_TOKEN for automatic renewal."
      );
    }
    return currentAccessToken;
  }

  throw new Error("No valid token available.");
}

/**
 * Get a new access token: from the refresh token when there is one, otherwise —
 * or once MyRide says it has expired — by signing in with the email and password,
 * which also yields the next refresh token (kept in memory; a restart signs in
 * again). Throws like CognitoAuth: `tokenExpired` when nothing configured works.
 */
async function renewAccessToken() {
  if (config.myride.refreshToken) {
    console.log("[Auth] Refreshing access token via Cognito...");
    try {
      const tokens = await auth.refresh(config.myride.refreshToken);
      currentAccessToken = tokens.accessToken;
      tokenExpiresAt = tokens.expiresIn;
      console.log(
        `[Auth] Token refreshed, expires at ${new Date(tokenExpiresAt * 1000).toLocaleTimeString()}`
      );
      noteSignIn(signIn.method === "password" ? "password" : "refresh-token", "Access token renewed with the refresh token");
      return;
    } catch (err) {
      if (!err.tokenExpired || !passwordLogin.available) throw err;
      console.warn(`[Auth] Refresh token no longer works (${err.message}).`);
      eventLog.add("warn", "Sign-in", "The refresh token no longer works; signing in with the email and password");
    }
  }

  console.log(`[Auth] Signing in to MyRide as ${passwordLogin.username}...`);
  const tokens = await passwordLogin.login();
  config.myride.refreshToken = tokens.refreshToken;
  currentAccessToken = tokens.accessToken;
  tokenExpiresAt = tokens.expiresIn;
  console.log(
    `[Auth] Signed in, token expires at ${new Date(tokenExpiresAt * 1000).toLocaleTimeString()}`
  );
  noteSignIn("password", "Signed in with the email and password");
}

/** Record a successful sign-in or token renewal for the status page. */
function noteSignIn(method, message) {
  signIn.method = method;
  signIn.renewedAtMs = Date.now();
  signIn.rejectedAtMs = null;
  eventLog.add("info", "Sign-in", message, { marker: "T" });
}

// ─── Tenant ID ───────────────────────────────────────────────────
// The district's tenant ID is optional: the access token's cognito:groups carry it.
// config.myride.tenantId holds the one in use once the data side has started.
const configuredTenantId = config.myride.tenantId;
const TENANT_NOT_FOUND =
  "Couldn't find your district's tenant ID in the MyRide token. " +
  "Set it yourself: the app's Tenant ID option, or MYRIDE_TENANT_ID.";

/** Settle config.myride.tenantId from the configuration or the access token. */
function applyTenantId(accessToken) {
  const { tenantId, warning } = resolveTenantId(configuredTenantId, accessToken);
  if (warning) console.warn(`[Auth] ${warning}`);
  if (!tenantId) throw new Error(TENANT_NOT_FOUND);
  if (!configuredTenantId) console.log(`[Auth] Tenant ID from token: ${tenantId}`);
  config.myride.tenantId = tenantId;
}

// ─── Token expiry handler ───────────────────────────────────────
// References set by main() so handleTokenExpired can tear down gracefully
let mqttBridge = null;
let signalrClient = null;
let studentTracker = null;
let refreshInterval = null;
// The data-side startup (startBridge) once begun; null while waiting for a token.
let bridgeStartup = null;

// Bus assetUniqueId → [students] whose current run rides that bus today.
// Rebuilt on every student poll; used to route SignalR locations to students.
const busToStudents = new Map();
// Per-bus monotonic ordering guard: drops replayed/out-of-order SignalR fixes so a
// superseded location can't rewind the bus's route position (see fix-order-guard.js).
const fixOrderGuard = new FixOrderGuard();
// Per-bus feed health (silence, fix lag, guard drops) — see feed-monitor.js.
const feedMonitor = new FeedMonitor();
// How often the feed watchdog checks for silent buses.
const FEED_WATCHDOG_INTERVAL_MS = 30_000;
let feedWatchdogInterval = null;
// Connection-level stream supervision: reconnects when MyRide isn't tracking this
// connection (see stream-supervisor.js).
const streamSupervisor = new StreamSupervisor({
  silenceMs:
    Number.isFinite(config.streamSilenceSeconds) && config.streamSilenceSeconds > 0
      ? config.streamSilenceSeconds * 1000
      : STREAM_SILENCE_MS,
});
// The one reconnect in progress (supervisor-initiated, `closed` loop or token swap);
// every other reconnect request is a no-op while it is set.
let reconnectInFlight = null;
// Frame accounting for the hourly [Stream] log and the position_stream attributes.
const STREAM_FRAME_LOG_INTERVAL_MS = 60 * 60 * 1000;
let lastFrameAnyMs = null; // receipt time of the latest frame from any bus (pre-filter)
let framesThisHour = { total: 0, watched: 0 };
let framesLastHour = null; // counts of the last completed hour
let streamFrameLogInterval = null;
// Buses whose legacy per-bus HA entities have already been cleared (migration).
const clearedBuses = new Set();
// The latest student poll, for the status page.
let latestStudents = [];
let rosterPolledMs = null;
let rosterError = null; // { message, atMs } of the latest failed poll, cleared by a good one
let lastWatchedLabel = null;
// Add-on only: how many of the bridge's entities Home Assistant has (see
// ha-entity-check.js). { found, expected, checkedAt, error } once checked.
let entityCheck = null;
const ENTITY_CHECK_INTERVAL_MS = 5 * 60 * 1000;
let entityCheckInterval = null;

// Dynamic bus filter driven by student assignments.
// null = allow all; Set = allow only those IDs.
// If BUS_FILTER env var is set it takes permanent precedence.
let allowedBuses = config.busFilter ? new Set([config.busFilter]) : null;

async function handleTokenExpired() {
  if (refreshTokenExpired) return; // already handled
  refreshTokenExpired = true;
  signIn.rejectedAtMs = Date.now();
  eventLog.add(
    "error",
    "Sign-in",
    passwordLogin.rejection
      ? `MyRide rejected the email and password (${passwordLogin.rejection}). Not trying them again until they change`
      : "The MyRide refresh token is no longer valid. Tracking stopped",
    { marker: "!" }
  );
  streamTimeline.record("stopped", Date.now());

  console.error("╔═══════════════════════════════════════════════════════════╗");
  console.error("║  MYRIDE CREDENTIALS NO LONGER WORK — action required     ║");
  console.error("╚═══════════════════════════════════════════════════════════╝");
  console.error();
  if (passwordLogin.rejection) {
    console.error(`MyRide rejected the email and password: ${passwordLogin.rejection}`);
    console.error(isAddon
      ? "To fix: correct them on the app's Configuration tab and restart the app,"
      : "To fix: correct MYRIDE_EMAIL / MYRIDE_PASSWORD and restart,");
    console.error("or paste a refresh token on the status page (no restart needed).");
    console.error("The bridge won't try this email and password again until then.");
  } else {
    console.error("Your MyRide refresh token is no longer valid.");
    console.error("To fix: set your MyRide email and password so the bridge can sign in");
    console.error("itself, or re-run capture-tokens.js in your browser and paste the new");
    console.error("refresh token on the status page (no restart needed).");
  }
  console.error();
  console.error("[Bridge] Stopping data stream. MQTT stays connected for HA visibility.");

  // Stop retrying token refreshes
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }

  // Stop student tracker
  if (studentTracker) {
    studentTracker.stop();
  }

  // Disconnect SignalR (no point staying connected with bad credentials)
  if (signalrClient) {
    try { await signalrClient.stop(); } catch { /* best effort */ }
  }

  // Tell Home Assistant credentials are expired
  if (mqttBridge) {
    mqttBridge.publishCredentialStatus(true);
  }
}

/**
 * Hot-reload: called by the API server when a new refresh token is submitted.
 * Validates the token, then reconnects everything.
 */
async function handleNewToken(newRefreshToken) {
  console.log("[API] Received new refresh token, validating...");

  // Validate by attempting a refresh
  const tokens = await auth.refresh(newRefreshToken);

  // The running clients keep the tenant they were built with.
  const { tenantId, warning } = resolveTenantId(configuredTenantId, tokens.accessToken);
  if (warning) console.warn(`[Auth] ${warning}`);
  if (!tenantId) throw new Error(TENANT_NOT_FOUND);
  if (config.myride.tenantId && tenantId !== config.myride.tenantId) {
    console.warn(
      `[Auth] New token is for tenant ${tenantId}, but the bridge is using ` +
      `${config.myride.tenantId}. Restart the bridge to switch.`
    );
  }

  // Success — swap in the new token
  config.myride.refreshToken = newRefreshToken;
  currentAccessToken = tokens.accessToken;
  tokenExpiresAt = tokens.expiresIn;
  refreshTokenExpired = false;
  // When this token expires, the email and password may be tried again.
  passwordLogin.reset();

  console.log("[Auth] New token validated and active.");
  noteSignIn("refresh-token", "New refresh token accepted from the status page");

  // Tell HA credentials are OK again
  if (mqttBridge) {
    mqttBridge.publishCredentialStatus(false);
  }

  // Restart student tracker if it was stopped
  if (studentTracker) {
    await studentTracker.start();
    console.log("[Students] Tracker restarted with new credentials.");
  }

  // Reconnect SignalR with the new credentials (not awaited: on failure it falls
  // into the backoff loop, which must not hold up the API response).
  reconnectSignalR("token");

  // Restart periodic refresh if it was cleared
  startRefreshInterval();

  // No token at boot (or it was already expired): the data side never started.
  // Start it now, without holding up the API response (it waits on MQTT,
  // the first student poll and the SignalR connect).
  if (!bridgeStartup) runBridge();
}

const REFRESH_INTERVAL_MS = 50 * 60 * 1000;

/** Periodic token refresh (every 50 minutes); no-op if already running. */
function startRefreshInterval() {
  if (refreshInterval || !config.myride.refreshToken) return;
  refreshInterval = setInterval(async () => {
    try {
      await ensureFreshToken();
    } catch (err) {
      if (err.tokenExpired) {
        await handleTokenExpired();
      } else {
        console.error("[Auth] Periodic refresh failed:", err.message);
      }
    }
  }, REFRESH_INTERVAL_MS);
}

function logDropSummary({ busId, count, newestLogTime, lastAcceptedMs }) {
  console.log(
    `[Bus] Dropped ${count} out-of-order fix(es) for ${busId} ` +
    `(newest dropped logTime ${newestLogTime}, last accepted ` +
    `${lastAcceptedMs != null ? new Date(lastAcceptedMs).toISOString() : "n/a"})`
  );
}

const BACKOFF_RECONNECT_REASONS = new Set(["watchdog", "server-error"]);
// How each reconnect reason reads in the status page's event log and timeline.
const RECONNECT_EVENTS = {
  "runs-changed": { label: "watched buses changed", marker: "R1" },
  watchdog: { label: "no frames from watched buses", marker: "R2" },
  "server-error": { label: "MyRide server error", marker: "R3" },
  closed: { label: "connection closed", marker: "C" },
  token: { label: "new token", marker: null },
};

/**
 * The single path for rebuilding the SignalR connection. No-op while the refresh
 * token is expired, before SignalR exists, or while another reconnect is in flight.
 *
 * @param {string} reason — "closed" | "runs-changed" | "watchdog" | "server-error" | "token"
 * @param {string} [summary] — context appended to the log line
 * @returns {Promise<void>|null} the in-flight reconnect, or null when skipped
 */
function reconnectSignalR(reason, summary = "") {
  if (refreshTokenExpired || !signalrClient || reconnectInFlight) return null;
  reconnectInFlight = runReconnect(reason, summary)
    .catch((err) => console.error(`[Stream] reconnect (${reason}) failed: ${err.message}`))
    .finally(() => { reconnectInFlight = null; });
  return reconnectInFlight;
}

async function runReconnect(reason, summary) {
  const line = `[Stream] reconnect reason=${reason}${summary ? `: ${summary}` : ""}`;
  const reconnectEvent = RECONNECT_EVENTS[reason] || { label: reason, marker: null };
  eventLog.add(
    BACKOFF_RECONNECT_REASONS.has(reason) || reason === "closed" ? "warn" : "info",
    "Stream",
    `Reconnecting (${reconnectEvent.label})${summary ? `: ${summary}` : ""}`,
    { marker: reconnectEvent.marker }
  );
  if (BACKOFF_RECONNECT_REASONS.has(reason)) {
    console.warn(line);
    streamSupervisor.onReconnectStarted(reason, Date.now());
  } else {
    console.log(line);
  }
  // A closed socket keeps the original 1 s → 60 s backoff before its first attempt.
  if (reason === "closed") return reconnectWithBackoff(reason);
  try {
    await connectSignalR(reason);
  } catch (err) {
    if (err.tokenExpired) {
      await handleTokenExpired();
      return;
    }
    console.error(`[Stream] reconnect (${reason}) failed: ${err.message}`);
    await reconnectWithBackoff(reason);
  }
}

// Retry with exponential backoff, building a fresh HubConnection each time.
// A fresh connection avoids the zombie-reconnect problem seen with skipNegotiation.
async function reconnectWithBackoff(reason) {
  for (let attempt = 1; ; attempt++) {
    const delay = Math.min(1000 * Math.pow(2, attempt - 1), 60000);
    console.log(`[MyRide] Reconnect attempt ${attempt} in ${delay / 1000}s...`);
    await new Promise((r) => setTimeout(r, delay));

    if (refreshTokenExpired) return;
    try {
      await connectSignalR(reason);
      return;
    } catch (err) {
      if (err.tokenExpired) {
        await handleTokenExpired();
        return;
      }
      console.error(`[MyRide] Reconnect attempt ${attempt} failed: ${err.message}`);
    }
  }
}

// Build a fresh, negotiated connection and record it with the supervisor.
async function connectSignalR(reason) {
  await ensureFreshToken();
  streamSupervisor.onConnectStarted(Date.now());
  await signalrClient.restart(); // builds a brand-new HubConnection
  onStreamConnected(reason);
}

function onStreamConnected(reason) {
  const nowMs = Date.now();
  streamSupervisor.onConnected(nowMs, reason);
  const watched = watchedLabel(streamSupervisor.status(nowMs).watchedBuses);
  console.log(
    `[Stream] connected reason=${reason} connectionId=${signalrClient.connectionId || "?"} ` +
    `watched=${watched}`
  );
  eventLog.add("info", "Stream", `Connected (${reason}) · watching ${watched}`);
  streamTimeline.record(streamTimelineState(nowMs), nowMs);
  publishStreamHealth(nowMs);
}

/**
 * The stream's state for the status page's timeline. "live" needs an actual
 * watched-bus frame within the silence window: the supervisor's own `live` also
 * counts the grace after a connect, which a stream with no frames would pass.
 */
function streamTimelineState(nowMs) {
  if (refreshTokenExpired || !signalrClient || signalrClient.state !== "Connected") return "stopped";
  const { expected, lastWatchedFrameMs, connectedSinceMs } = streamSupervisor.status(nowMs);
  if (!expected) return "idle";
  const silenceMs = streamSupervisor.silenceMs;
  if (lastWatchedFrameMs != null && nowMs - lastWatchedFrameMs <= silenceMs) return "live";
  if (connectedSinceMs != null && nowMs - connectedSinceMs <= silenceMs) return "waiting";
  return "silent";
}

// Log context for a runs-changed decision: the set change from a roster poll, or a
// change retried because it arrived during an earlier connect.
function describeRunsChanged(detail) {
  return detail.previous
    ? `watched ${watchedLabel(detail.previous)} → ${watchedLabel(detail.next)}`
    : `roster change at ${new Date(detail.changedAtMs).toISOString()} not covered by the current connection; ` +
      `watched ${watchedLabel(detail.next)}`;
}

function watchedLabel(buses) {
  return buses && buses.length ? buses.join(", ") : "(none)";
}

function streamStatus(nowMs) {
  return {
    ...streamSupervisor.status(nowMs),
    silenceMs: streamSupervisor.silenceMs,
    connectionId: signalrClient ? signalrClient.connectionId : null,
    framesLastHour,
  };
}

function publishStreamHealth(nowMs) {
  if (mqttBridge) mqttBridge.publishStreamHealth(streamStatus(nowMs), lastFrameAnyMs, nowMs);
}

/**
 * Describe a watchdog decision for the log, with the run that should be driving.
 */
function describeWatchdog(detail, nowMs) {
  const nowMinutes = nowMinutesInTimeZone(new Date(nowMs), config.timeZone);
  const runs = detail.buses.flatMap((bus) => (busToStudents.get(bus) || []).map((st) => st.currentRun));
  const run = runs.find((r) => inRunWindow(r, nowMinutes));
  const runText = run
    ? `run ${run.runId} window ${formatMinutes(run.windowStart)}–${formatMinutes(run.windowEnd)}`
    : "run - window -";
  return (
    `no frame for ${detail.buses.join(", ")} in ${Math.round(detail.silentMs / 1000)}s on a run day ` +
    `(${runText}); reconnecting (attempt ${detail.attempt}, next allowed in ` +
    `${Math.round(detail.nextAllowedInMs / 60000)} min)`
  );
}

function getBridgeStatus() {
  const nowMs = Date.now();
  const now = Math.floor(nowMs / 1000);
  const mqtt = mqttBridge ? mqttBridge.snapshot() : null;
  return {
    bridge: "myride-ha-bridge",
    version,
    tokenExpired: refreshTokenExpired,
    // No token configured yet: the UI asks for one (the bridge is waiting on it).
    tokenMissing: !config.myride.refreshToken && !currentAccessToken && !passwordLogin.configured,
    // Email/password sign-in: null when not configured; `rejected` is MyRide's
    // reason once it has refused them. The email isn't exposed.
    login: passwordLogin.configured ? { rejected: passwordLogin.rejection } : null,
    tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt * 1000).toISOString() : null,
    tokenExpiresInSeconds: tokenExpiresAt ? Math.max(0, tokenExpiresAt - now) : null,
    signalrConnected: signalrClient ? signalrClient.state === "Connected" : false,
    mqttConnected: mqttBridge ? mqttBridge.client.connected : false,
    buses: Array.from(busStates.values()).sort((a, b) => a.name.localeCompare(b.name)),
    stream: streamStatus(nowMs),

    // ── For the status page (see public/index.html) ──
    runtime: isAddon ? "addon" : "standalone",
    configUrl: isAddon ? addonConfigUrl(process.env.HOSTNAME) : null,
    timeZone: config.timeZone,
    startedAt: new Date(startedAtMs).toISOString(),
    signIn: {
      method: signIn.method || (passwordLogin.configured ? "password" : config.myride.refreshToken ? "refresh-token" : currentAccessToken ? "access-token" : null),
      passwordConfigured: passwordLogin.configured,
      renewedAt: isoOrNull(signIn.renewedAtMs),
      // The 50-minute renewal timer, or the access token's expiry without one.
      nextRenewalAt: refreshInterval && signIn.renewedAtMs ? isoOrNull(signIn.renewedAtMs + REFRESH_INTERVAL_MS) : null,
      rejectedAt: isoOrNull(signIn.rejectedAtMs),
      tenant: config.myride.tenantId
        ? { id: maskId(config.myride.tenantId), source: configuredTenantId ? "configured" : "token" }
        : null,
    },
    roster: {
      lastPollAt: isoOrNull(rosterPolledMs),
      pollMinutes: studentTracker ? Math.round(studentTracker.intervalMs / 60000) : null,
      // The latest poll failed (MyRide error, network); null once a poll succeeds.
      lastError: rosterError && { message: rosterError.message, at: isoOrNull(rosterError.atMs) },
    },
    students: describeStudents(latestStudents, {
      nowMinutes: nowMinutesInTimeZone(new Date(nowMs), config.timeZone),
      readPublished: mqttBridge ? (id, name) => mqttBridge.studentValue(id, name) : undefined,
    }),
    mqtt: mqtt && {
      broker: mqtt.broker,
      port: mqtt.port,
      connected: mqtt.connected,
      lastPublishAt: mqtt.lastPublishAt,
    },
    homeAssistant: mqtt && {
      devices: mqtt.discovery.devices,
      entities: mqtt.discovery.entities,
      haStatus: mqtt.haStatus,
      credentialsProblem: refreshTokenExpired,
      entityCheck: isAddon ? entityCheck : null,
    },
    options: describeOptions({
      config,
      configuredTenantId,
      approachRadiusMeters: mqttBridge ? mqttBridge.approachRadiusMeters : config.mqtt.approachRadiusMeters || 500,
      streamSilenceSeconds: Math.round(streamSupervisor.silenceMs / 1000),
      isAddon,
    }),
    events: eventLog.list(),
    timeline: streamTimeline.snapshot(nowMs),
  };
}

function isoOrNull(ms) {
  return ms != null ? new Date(ms).toISOString() : null;
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     MyRide K-12 → Home Assistant MQTT Bridge     ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();

  // Start the API server FIRST so the status UI and POST /token recovery
  // endpoint are reachable no matter what happens next. If there's no token
  // yet, or Cognito, the student poll, or SignalR hang or throw, the page must
  // still load — otherwise the one tool for supplying a token is unavailable
  // exactly when it's needed (and the reverse proxy returns 502).
  await apiServer.start();
  eventLog.add(
    "info",
    "Bridge",
    `Started v${version.version}${isAddon ? " as a Home Assistant add-on" : ""}`,
    { marker: "S", atMs: startedAtMs }
  );
  if (currentAccessToken && !config.myride.refreshToken && !passwordLogin.configured) {
    signIn.method = "access-token";
  }
  // Sample the stream state for the status page's timeline, whether or not the
  // data side is running (waiting for a token or idle on bad credentials is "stopped").
  streamTimelineInterval = setInterval(() => {
    const nowMs = Date.now();
    streamTimeline.record(streamTimelineState(nowMs), nowMs);
  }, STREAM_TIMELINE_SAMPLE_MS);

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  if (tokenMissing) {
    console.log("[Bridge] Waiting for a refresh token from the status page (POST /token).");
    return;
  }
  runBridge();
}

/**
 * Start the data side (startBridge) once. A token-expired failure leaves the
 * bridge idle with the API up; if nothing was built yet, the next valid token
 * from POST /token starts it again (handleNewToken). Other failures are fatal.
 */
function runBridge() {
  bridgeStartup = startBridge().catch(async (err) => {
    if (err.tokenExpired) {
      await handleTokenExpired();
      // Expired at the first token check: nothing was built, so a new token
      // must start the bridge rather than hot-swap into it.
      if (!mqttBridge) bridgeStartup = null;
      console.log(passwordLogin.rejection
        ? "[Bridge] Idling — fix the MyRide email and password, or submit a refresh token on the status page."
        : "[Bridge] Idling — submit a new refresh token on the status page.");
    } else {
      console.error("Fatal error:", err.message || err);
      process.exit(1);
    }
  });
}

async function startBridge() {
  const modes = [];
  if (config.myride.refreshToken) modes.push("refresh token");
  if (passwordLogin.configured) modes.push(`email and password for ${passwordLogin.username}`);
  console.log(
    `[Auth] Mode: ${modes.length ? `${modes.join(", then ")} — auto-renewing` : "static access token"}`
  );

  // Step 1: Get an initial access token, and the tenant ID it carries
  applyTenantId(await ensureFreshToken());

  // Step 2: Set up MQTT bridge (as an add-on, default to the Supervisor's broker)
  if (isAddon && !config.mqtt.broker) {
    const service = await waitForMqttService();
    Object.assign(config.mqtt, service);
    console.log(`[MQTT] Using Supervisor-provided broker ${service.broker}:${service.port}`);
  }
  mqttBridge = new MqttBridge({
    broker: config.mqtt.broker,
    port: config.mqtt.port,
    username: config.mqtt.username,
    password: config.mqtt.password,
    topicPrefix: config.mqtt.topicPrefix,
    approachRadiusMeters: config.mqtt.approachRadiusMeters,
    timeZone: config.timeZone,
    onEvent: (level, category, message) => eventLog.add(level, category, message),
  });

  // Publish credential status sensor (problem = OFF means credentials are OK)
  mqttBridge.publishCredentialStatusDiscovery();
  mqttBridge.publishCredentialStatus(false);
  mqttBridge.publishStreamHealthDiscovery();

  // Step 3: Start student tracker (drives dynamic bus filter)
  const myRideApi = new MyRideApi({
    accessTokenFactory: () => ensureFreshToken(),
    tenantId: config.myride.tenantId,
  });
  studentTracker = new StudentTracker({ api: myRideApi, timeZone: config.timeZone });

  // Wire tracker events → MQTT + dynamic filter
  studentTracker.on("update", (snapshot) => {
    // Publish student discovery/state and rebuild the bus → students index
    // so incoming SignalR locations can be routed to the right student(s).
    busToStudents.clear();
    latestStudents = snapshot.students;
    rosterPolledMs = Date.now();
    rosterError = null;
    for (const student of snapshot.students) {
      mqttBridge.publishStudent(student);
      const activeBus = student.currentRun && student.currentRun.activeVehicle;
      if (activeBus) {
        const list = busToStudents.get(activeBus) || [];
        list.push(student);
        busToStudents.set(activeBus, list);
      }
    }
    // The buses this connection should be receiving. MyRide only decides that when
    // a connection is made, so a newly needed bus (runs appearing after a no-run
    // day, a substitute) means reconnecting. Every update, not only on `change`, so
    // the BUS_FILTER override is covered too.
    const watched = [...busToStudents.keys()].filter((bus) => !config.busFilter || bus === config.busFilter);
    const label = watchedLabel([...watched].sort());
    if (label !== lastWatchedLabel) {
      eventLog.add(
        "info",
        "Students",
        `${snapshot.students.length} student${snapshot.students.length === 1 ? "" : "s"} · watching ${label}`
      );
      lastWatchedLabel = label;
    }
    const decision = streamSupervisor.setWatchedBuses(watched, Date.now());
    if (decision) reconnectSignalR(decision.reason, describeRunsChanged(decision.detail));
    // One-time migration: remove legacy per-bus entities from HA
    for (const bus of snapshot.activeBuses) {
      if (!clearedBuses.has(bus)) {
        clearedBuses.add(bus);
        mqttBridge.clearBusDiscovery(bus);
      }
    }
  });
  // Only update the bus filter from student data if BUS_FILTER override is not set
  if (!config.busFilter) {
    studentTracker.on("change", (snapshot) => {
      allowedBuses = snapshot.activeBuses.size > 0 ? snapshot.activeBuses : null;
      console.log(
        `[Bridge] Active buses updated: ${[...(allowedBuses || [])].join(", ") || "(all)"}`
      );
    });
  }
  studentTracker.on("error", (err) => {
    if (!err.tokenExpired) {
      eventLog.add("warn", "Students", `Student poll failed: ${err.message}`);
      rosterError = { message: err.message, atMs: Date.now() };
    }
    if (err.tokenExpired) handleTokenExpired().catch((e) => console.error("[Students] handleTokenExpired failed:", e.message));
  });

  await studentTracker.start();

  // Step 4: Connect to SignalR
  signalrClient = new MyRideSignalRClient({
    tenantId: config.myride.tenantId,
    accessTokenFactory: () => ensureFreshToken(),
    busFilter: config.busFilter
      ? config.busFilter  // static string override
      : (id) => allowedBuses === null || allowedBuses.has(id),
    logLevel: config.logLevel,
  });

  // Wire SignalR location events → MQTT
  let locationCount = 0;
  // Every frame, before the bus filter (and before the order guard in the location
  // handler): last_frame_received, hourly counts and stream liveness. Liveness
  // counts every frame for a watched bus, including the repeats the order guard
  // drops — those ~5 s repeats are how a tracked connection shows it is tracked
  // while the bus is parked.
  signalrClient.on("frame", (data) => {
    const nowMs = Date.now();
    lastFrameAnyMs = nowMs;
    framesThisHour.total++;
    if (streamSupervisor.onFrame(data.assetUniqueId, nowMs)) {
      framesThisHour.watched++;
      streamTimeline.countFrame(nowMs);
    }
  });

  signalrClient.on("serverError", ({ method, args }) => {
    const nowMs = Date.now();
    console.warn(
      `[Stream] server called ${method}(${truncateJson(args)}) ` +
      `watched=${watchedLabel(streamSupervisor.status(nowMs).watchedBuses)}`
    );
    eventLog.add("warn", "Stream", `MyRide sent ${method}(${truncateJson(args, 200)})`);
    const decision = streamSupervisor.onServerError(method, args, nowMs);
    if (decision) {
      reconnectSignalR(
        decision.reason,
        `server called ${method} (attempt ${decision.detail.attempt}, next allowed in ` +
        `${Math.round(decision.detail.nextAllowedInMs / 60000)} min)`
      );
    }
    publishStreamHealth(nowMs);
  });

  signalrClient.on("location", (data) => {
    // Monotonic guard: drop replayed/out-of-order fixes so a superseded location
    // can't rewind the bus's route position (which bounces distance/eta/stops_away
    // and flaps `moving`). Unparseable timestamps pass through — we can't compare.
    if (!fixOrderGuard.accept(data.assetUniqueId, data.logTime)) {
      const lastMs = fixOrderGuard.lastAcceptedMs(data.assetUniqueId);
      if (config.logLevel === "debug") {
        console.log(
          `[Bus] Dropping out-of-order fix for ${data.assetUniqueId}: ` +
          `${data.logTime} <= last ${lastMs != null ? new Date(lastMs).toISOString() : "n/a"}`
        );
      }
      // Summarized at the default level too: a stream of frozen-timestamp fixes is
      // otherwise indistinguishable from a feed gap in the logs.
      const summary = feedMonitor.onDropped(data.assetUniqueId, data.logTime, lastMs, Date.now());
      if (summary) logDropSummary(summary);
      return;
    }
    const feed = feedMonitor.onAccepted(data.assetUniqueId, data.logTime, Date.now());
    if (feed.resumed) {
      console.log(
        `[Feed] ${data.assetUniqueId} fixes resumed after ${Math.round(feed.gapMs / 1000)}s ` +
        `(fix lag ${feed.lagMs != null ? `${Math.round(feed.lagMs / 1000)}s` : "?"}, logTime ${data.logTime})`
      );
      eventLog.add("info", "Feed", `${data.assetUniqueId} fixes resumed after ${Math.round(feed.gapMs / 1000)} s`);
    }
    locationCount++;
    if (config.logLevel === "debug") {
      console.log(
        `[Bus] ${data.assetUniqueId} @ ${data.latitude},${data.longitude} ` +
        `heading=${data.heading}° speed=${data.speed}mph (${data.logTime})`
      );
    } else if (locationCount === 1 || locationCount % 10 === 0) {
      console.log(
        `[Bus] ${data.assetUniqueId} @ ${data.latitude.toFixed(4)},${data.longitude.toFixed(4)} ` +
        `speed=${data.speed}mph`
      );
      if (locationCount >= 1000) locationCount = 0; // reset counter to avoid overflow
    }
    busStates.set(data.assetUniqueId, {
      name: data.assetUniqueId,
      lastSeen: data.logTime,
      speed: data.speed,
      moving: data.speed > 0,
    });
    // Route this bus location to every student whose current run rides it today
    const students = busToStudents.get(data.assetUniqueId);
    if (students) {
      for (const student of students) {
        mqttBridge.publishStudentLocation(student, data);
      }
    }
  });

  signalrClient.on("closed", () => {
    if (refreshTokenExpired) return; // already handled, don't restart
    console.warn("[MyRide] Connection lost, reconnecting...");
    reconnectSignalR("closed");
  });

  // The startup connect is part of the single-flight reconnect coordination, so
  // nothing (e.g. a server call dispatched with the handshake) can restart it
  // mid-start and make this start() reject.
  reconnectInFlight = (async () => {
    streamSupervisor.onConnectStarted(Date.now());
    await signalrClient.start();
    onStreamConnected("startup");
  })();
  try {
    await reconnectInFlight;
  } finally {
    reconnectInFlight = null;
  }

  // Feed watchdog: flip feed_live OFF for students whose bus has gone silent, and
  // warn once per silence episode when it happens during the run's window (when the
  // bus should be driving). Fix gaps are upstream of the bridge (MyRide / the bus's
  // AVL unit), so this can't prevent them — it makes them visible in HA and the log.
  feedWatchdogInterval = setInterval(() => {
    const nowMs = Date.now();
    const nowMinutes = nowMinutesInTimeZone(new Date(nowMs), config.timeZone);
    for (const [busId, students] of busToStudents) {
      const s = feedMonitor.silence(busId, nowMs);
      if (!s.silent) continue;
      for (const student of students) mqttBridge.publishFeedLive(student, false);
      const run = students.map((st) => st.currentRun).find((r) => inRunWindow(r, nowMinutes));
      if (run && !s.warned && !refreshTokenExpired) {
        feedMonitor.markWarned(busId);
        console.warn(
          `[Feed] no fix for ${busId} in ${Math.round(s.silentMs / 1000)}s during run ${run.runId} ` +
          `window ${formatMinutes(run.windowStart)}–${formatMinutes(run.windowEnd)}; ` +
          `last fix logTime ${s.lastLogTime || "none"}`
        );
        eventLog.add(
          "warn",
          "Feed",
          `No fix from ${busId} for ${Math.round(s.silentMs / 1000)} s during run ${run.runId} ` +
          `(${formatMinutes(run.windowStart)}–${formatMinutes(run.windowEnd)})`
        );
      }
    }
    for (const summary of feedMonitor.flushDrops(nowMs)) logDropSummary(summary);

    // Stream watchdog: a run-day connection with no watched-bus frame for the
    // silence window isn't being tracked by MyRide — reconnect (backed off). Also
    // retries a roster change the current connection was made too early to cover.
    const decision = streamSupervisor.check(nowMs);
    if (decision && !refreshTokenExpired && !reconnectInFlight) {
      reconnectSignalR(
        decision.reason,
        decision.reason === "watchdog" ? describeWatchdog(decision.detail, nowMs) : describeRunsChanged(decision.detail)
      );
    }
    publishStreamHealth(nowMs);
  }, FEED_WATCHDOG_INTERVAL_MS);

  streamFrameLogInterval = setInterval(() => {
    const { connectedSinceMs } = streamSupervisor.status(Date.now());
    const ageH = connectedSinceMs != null ? ((Date.now() - connectedSinceMs) / 3_600_000).toFixed(1) : "-";
    console.log(
      `[Stream] frames last hour: total=${framesThisHour.total} watched=${framesThisHour.watched} ` +
      `connectionAge=${ageH}h`
    );
    framesLastHour = framesThisHour;
    framesThisHour = { total: 0, watched: 0 };
  }, STREAM_FRAME_LOG_INTERVAL_MS);

  // Step 5: Periodic token refresh (every 50 minutes)
  startRefreshInterval();

  // As an add-on, check now and then that Home Assistant created the entities.
  if (isAddon) {
    setTimeout(checkEntities, 60_000).unref();
    entityCheckInterval = setInterval(checkEntities, ENTITY_CHECK_INTERVAL_MS);
  }

  console.log();
  console.log("[Bridge] Running. Press Ctrl+C to stop.");
  console.log(
    `[Bridge] Publishing to MQTT: ${config.mqtt.broker}:${config.mqtt.port}`
  );
  console.log(`[Bridge] Topic prefix: ${config.mqtt.topicPrefix}/`);
  if (config.busFilter) {
    console.log(`[Bridge] Filtering for: ${config.busFilter} (manual override)`);
  } else {
    console.log(`[Bridge] Bus filter: dynamic (driven by student assignments)`);
  }
  if (!config.myride.refreshToken) {
    const remaining = tokenExpiresAt - Math.floor(Date.now() / 1000);
    console.warn(
      `[Bridge] ⚠️  Static token mode — will expire in ${Math.round(remaining / 60)} minutes.`
    );
    console.warn(
      `[Bridge]    Set MYRIDE_EMAIL and MYRIDE_PASSWORD (or MYRIDE_REFRESH_TOKEN) in .env for continuous operation.`
    );
  }
}

/** Ask Home Assistant how many of the published entities it has (add-on only). */
async function checkEntities() {
  if (!mqttBridge || !mqttBridge.client.connected) return;
  const expected = mqttBridge.snapshot().discovery.entities;
  const previous = entityCheck;
  try {
    const found = await countBridgeEntities();
    entityCheck = { found, expected, checkedAt: new Date().toISOString(), error: null };
    if (found < expected && (!previous || previous.found !== found)) {
      eventLog.add("warn", "Home Assistant", `Home Assistant has ${found} of the ${expected} entities the bridge published`);
    }
  } catch (err) {
    entityCheck = { found: null, expected, checkedAt: new Date().toISOString(), error: err.message };
    if (!previous || previous.error !== err.message) {
      console.warn(`[HA] Entity check failed: ${err.message}`);
      eventLog.add("warn", "Home Assistant", `Couldn't check entities in Home Assistant: ${err.message}`);
    }
  }
}

// Graceful shutdown. Registered before the bridge starts, so any part may be
// missing (still waiting for a token, or startup idled on an expired one).
async function shutdown(signal) {
  console.log(`\n[Bridge] ${signal} received, shutting down...`);
  if (refreshInterval) clearInterval(refreshInterval);
  if (feedWatchdogInterval) clearInterval(feedWatchdogInterval);
  if (streamFrameLogInterval) clearInterval(streamFrameLogInterval);
  if (entityCheckInterval) clearInterval(entityCheckInterval);
  if (streamTimelineInterval) clearInterval(streamTimelineInterval);
  if (studentTracker) studentTracker.stop();
  if (signalrClient) await signalrClient.stop();
  await apiServer.stop();
  if (mqttBridge) await mqttBridge.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err.message || err);
  process.exit(1);
});
