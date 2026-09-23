#!/usr/bin/env node
/**
 * MyRide K-12 → Home Assistant MQTT Bridge
 *
 * Connects to the MyRide K-12 LiveVehicleHub via SignalR and publishes
 * real-time bus location data to MQTT for Home Assistant consumption.
 *
 * Auth approach: Cognito REFRESH_TOKEN_AUTH
 *   - One-time: capture your refresh token from the browser (see capture-tokens.js)
 *   - Ongoing: this bridge uses it to get fresh access tokens automatically
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
        const val = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) process.env[key] = val;
      }
    }
  }
} catch (e) {
  // .env loading is optional
}

const { CognitoAuth } = require("./cognito-auth");
const { MyRideSignalRClient } = require("./signalr-client");
const { MqttBridge } = require("./mqtt-bridge");
const { ApiServer } = require("./api-server");
const { runSimulation } = require("./simulator");
const { MyRideApi } = require("./myride-api");
const { StudentTracker } = require("./student-tracker");
const { FixOrderGuard } = require("./fix-order-guard");
const { FeedMonitor, inRunWindow } = require("./feed-monitor");
const { nowMinutesInTimeZone, formatMinutes } = require("./student-tracker");
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

// ─── Validation ──────────────────────────────────────────────────
if (!config.myride.tenantId) {
  console.error("ERROR: MYRIDE_TENANT_ID is required. Set it in your .env file.");
  console.error("Run capture-tokens.js in the browser — it prints your tenant ID.");
  process.exit(1);
}

if (!config.myride.refreshToken && !config.myride.accessToken) {
  console.error("╔═══════════════════════════════════════════════════════════╗");
  console.error("║  ERROR: No authentication token configured.              ║");
  console.error("╚═══════════════════════════════════════════════════════════╝");
  console.error();
  console.error("You need to capture your token from the MyRide web app:");
  console.error();
  console.error("  1. Log in to https://myridek12.tylerapp.com in Chrome");
  console.error("  2. Open DevTools (F12) → Console tab");
  console.error("  3. Paste the contents of capture-tokens.js and press Enter");
  console.error("  4. Copy the MYRIDE_REFRESH_TOKEN value into your .env file");
  console.error();
  console.error("If the capture script can't find a refresh token, you can set");
  console.error("MYRIDE_ACCESS_TOKEN instead (but it expires in 60 minutes).");
  process.exit(1);
}

// ─── Token management ────────────────────────────────────────────
let currentAccessToken = config.myride.accessToken || null;
let tokenExpiresAt = 0;
let refreshTokenExpired = false;
const busStates = new Map(); // assetUniqueId → { name, lastSeen, speed, moving }

const auth = config.myride.refreshToken
  ? new CognitoAuth({
    clientId: config.cognito.clientId,
    region: config.cognito.region,
  })
  : null;

// If we only have a raw access token, decode its expiry
if (currentAccessToken && !config.myride.refreshToken) {
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
        "[Auth] ⚠️  Token expires very soon! Set MYRIDE_REFRESH_TOKEN for auto-renewal."
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
      "Refresh token is expired or revoked. Update MYRIDE_REFRESH_TOKEN in .env and restart."
    );
  }

  const now = Math.floor(Date.now() / 1000);

  // If we have a refresh token and the access token is expiring soon, refresh
  if (auth && config.myride.refreshToken) {
    const needsRefresh = !currentAccessToken || now >= tokenExpiresAt - 300;
    if (needsRefresh) {
      console.log("[Auth] Refreshing access token via Cognito...");
      try {
        const tokens = await auth.refresh(config.myride.refreshToken);
        currentAccessToken = tokens.accessToken;
        tokenExpiresAt = tokens.expiresIn;
        console.log(
          `[Auth] Token refreshed, expires at ${new Date(tokenExpiresAt * 1000).toLocaleTimeString()}`
        );
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

// ─── Token expiry handler ───────────────────────────────────────
// References set by main() so handleTokenExpired can tear down gracefully
let mqttBridge = null;
let signalrClient = null;
let studentTracker = null;
let refreshInterval = null;

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
// Buses whose legacy per-bus HA entities have already been cleared (migration).
const clearedBuses = new Set();

// Dynamic bus filter driven by student assignments.
// null = allow all; Set = allow only those IDs.
// If BUS_FILTER env var is set it takes permanent precedence.
let allowedBuses = config.busFilter ? new Set([config.busFilter]) : null;

async function handleTokenExpired() {
  if (refreshTokenExpired) return; // already handled
  refreshTokenExpired = true;

  console.error("╔═══════════════════════════════════════════════════════════╗");
  console.error("║  REFRESH TOKEN EXPIRED — action required                 ║");
  console.error("╚═══════════════════════════════════════════════════════════╝");
  console.error();
  console.error("Your MyRide refresh token is no longer valid.");
  console.error("To fix: re-run capture-tokens.js in your browser,");
  console.error("update MYRIDE_REFRESH_TOKEN in .env, and restart the bridge.");
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

  // Success — swap in the new token
  config.myride.refreshToken = newRefreshToken;
  currentAccessToken = tokens.accessToken;
  tokenExpiresAt = tokens.expiresIn;
  refreshTokenExpired = false;

  console.log("[Auth] New token validated and active.");

  // Tell HA credentials are OK again
  if (mqttBridge) {
    mqttBridge.publishCredentialStatus(false);
  }

  // Restart student tracker if it was stopped
  if (studentTracker) {
    await studentTracker.start();
    console.log("[Students] Tracker restarted with new credentials.");
  }

  // Restart SignalR if it was stopped
  if (signalrClient) {
    try { await signalrClient.stop(); } catch { /* best effort */ }
    await signalrClient.start();
    console.log("[MyRide] SignalR reconnected with new credentials.");
  }

  // Restart periodic refresh if it was cleared
  if (auth && !refreshInterval) {
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
    }, 50 * 60 * 1000);
  }
}

function logDropSummary({ busId, count, newestLogTime, lastAcceptedMs }) {
  console.log(
    `[Bus] Dropped ${count} out-of-order fix(es) for ${busId} ` +
    `(newest dropped logTime ${newestLogTime}, last accepted ` +
    `${lastAcceptedMs != null ? new Date(lastAcceptedMs).toISOString() : "n/a"})`
  );
}

function getBridgeStatus() {
  const now = Math.floor(Date.now() / 1000);
  return {
    bridge: "myride-ha-bridge",
    version,
    tokenExpired: refreshTokenExpired,
    tokenExpiresAt: tokenExpiresAt ? new Date(tokenExpiresAt * 1000).toISOString() : null,
    tokenExpiresInSeconds: tokenExpiresAt ? Math.max(0, tokenExpiresAt - now) : null,
    signalrConnected: signalrClient ? signalrClient.state === "Connected" : false,
    mqttConnected: mqttBridge ? mqttBridge.client.connected : false,
    buses: Array.from(busStates.values()).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

// ─── Main ────────────────────────────────────────────────────────
async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     MyRide K-12 → Home Assistant MQTT Bridge     ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();
  console.log(
    `[Auth] Mode: ${auth ? "refresh token (auto-renewing)" : "static access token"}`
  );

  // Step 0: Start the API server FIRST so the status UI and POST /token
  // recovery endpoint are reachable no matter what happens below. If Cognito,
  // the student poll, or SignalR hang or throw, the page must still load —
  // otherwise the one tool for fixing a bad token is unavailable exactly when
  // it's needed (and the reverse proxy returns 502).
  await apiServer.start();

  // Step 1: Get an initial access token
  await ensureFreshToken();

  // Step 2: Set up MQTT bridge
  mqttBridge = new MqttBridge({
    broker: config.mqtt.broker,
    port: config.mqtt.port,
    username: config.mqtt.username,
    password: config.mqtt.password,
    topicPrefix: config.mqtt.topicPrefix,
    approachRadiusMeters: config.mqtt.approachRadiusMeters,
    timeZone: config.timeZone,
  });

  // Publish credential status sensor (problem = OFF means credentials are OK)
  mqttBridge.publishCredentialStatusDiscovery();
  mqttBridge.publishCredentialStatus(false);

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
    for (const student of snapshot.students) {
      mqttBridge.publishStudent(student);
      const activeBus = student.currentRun && student.currentRun.activeVehicle;
      if (activeBus) {
        const list = busToStudents.get(activeBus) || [];
        list.push(student);
        busToStudents.set(activeBus, list);
      }
    }
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

  signalrClient.on("closed", async (error) => {
    if (refreshTokenExpired) return; // already handled, don't restart
    console.warn("[MyRide] Connection lost, reconnecting...");

    // Retry with exponential backoff, building a fresh HubConnection each time.
    // A fresh connection avoids the zombie-reconnect problem seen with skipNegotiation.
    for (let attempt = 1; ; attempt++) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 60000);
      console.log(`[MyRide] Reconnect attempt ${attempt} in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));

      if (refreshTokenExpired) return;
      try {
        await ensureFreshToken();
        await signalrClient.start(); // builds a brand-new HubConnection
        console.log("[MyRide] Reconnected successfully.");
        return;
      } catch (err) {
        if (err.tokenExpired) {
          await handleTokenExpired();
          return;
        }
        console.error(`[MyRide] Reconnect attempt ${attempt} failed: ${err.message}`);
      }
    }
  });

  await signalrClient.start();

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
      }
    }
    for (const summary of feedMonitor.flushDrops(nowMs)) logDropSummary(summary);
  }, FEED_WATCHDOG_INTERVAL_MS);

  // Step 5: Periodic token refresh (every 50 minutes)
  refreshInterval = auth
    ? setInterval(async () => {
      try {
        await ensureFreshToken();
      } catch (err) {
        if (err.tokenExpired) {
          await handleTokenExpired();
        } else {
          console.error("[Auth] Periodic refresh failed:", err.message);
        }
      }
    }, 50 * 60 * 1000)
    : null;

  // Graceful shutdown
  async function shutdown(signal) {
    console.log(`\n[Bridge] ${signal} received, shutting down...`);
    if (refreshInterval) clearInterval(refreshInterval);
    if (feedWatchdogInterval) clearInterval(feedWatchdogInterval);
    if (studentTracker) studentTracker.stop();
    await signalrClient.stop();
    await apiServer.stop();
    await mqttBridge.disconnect();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

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
  if (!auth) {
    const remaining = tokenExpiresAt - Math.floor(Date.now() / 1000);
    console.warn(
      `[Bridge] ⚠️  Static token mode — will expire in ${Math.round(remaining / 60)} minutes.`
    );
    console.warn(
      `[Bridge]    Set MYRIDE_REFRESH_TOKEN in .env for continuous operation.`
    );
  }
}

main().catch(async (err) => {
  if (err.tokenExpired) {
    await handleTokenExpired();
    // Stay alive so MQTT sensor remains visible to HA
    console.log("[Bridge] Idling — waiting for token to be updated and bridge restarted.");
  } else {
    console.error("Fatal error:", err.message || err);
    process.exit(1);
  }
});
