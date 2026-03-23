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
  },
  busFilter: process.env.BUS_FILTER || null,
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
let refreshInterval = null;

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

function getBridgeStatus() {
  const now = Math.floor(Date.now() / 1000);
  return {
    bridge: "myride-ha-bridge",
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

  // Step 1: Get an initial access token
  await ensureFreshToken();

  // Step 2: Set up MQTT bridge
  mqttBridge = new MqttBridge({
    broker: config.mqtt.broker,
    port: config.mqtt.port,
    username: config.mqtt.username,
    password: config.mqtt.password,
    topicPrefix: config.mqtt.topicPrefix,
  });

  // Publish credential status sensor (problem = OFF means credentials are OK)
  mqttBridge.publishCredentialStatusDiscovery();
  mqttBridge.publishCredentialStatus(false);

  // Step 3: Connect to SignalR
  signalrClient = new MyRideSignalRClient({
    tenantId: config.myride.tenantId,
    accessTokenFactory: () => ensureFreshToken(),
    busFilter: config.busFilter,
    logLevel: config.logLevel,
  });

  // Wire SignalR location events → MQTT
  let locationCount = 0;
  signalrClient.on("location", (data) => {
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
    mqttBridge.publishLocation(data);
  });

  signalrClient.on("closed", async (error) => {
    if (refreshTokenExpired) return; // already handled, don't restart
    console.warn("[MyRide] Connection closed, will rebuild with fresh connection...");

    // Retry with exponential backoff, building a fresh connection each time
    for (let attempt = 1; ; attempt++) {
      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 60000);
      console.log(`[MyRide] Rebuild attempt ${attempt} in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));

      if (refreshTokenExpired) return;
      try {
        await ensureFreshToken();
        await signalrClient.start(); // builds a brand-new HubConnection
        console.log("[MyRide] Rebuild successful.");
        return;
      } catch (err) {
        if (err.tokenExpired) {
          await handleTokenExpired();
          return;
        }
        console.error(`[MyRide] Rebuild attempt ${attempt} failed: ${err.message}`);
      }
    }
  });

  await signalrClient.start();

  // Step 4: Periodic token refresh (every 50 minutes)
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
    await signalrClient.stop();
    await apiServer.stop();
    await mqttBridge.disconnect();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Step 5: Start API server
  await apiServer.start();

  console.log();
  console.log("[Bridge] Running. Press Ctrl+C to stop.");
  console.log(
    `[Bridge] Publishing to MQTT: ${config.mqtt.broker}:${config.mqtt.port}`
  );
  console.log(`[Bridge] Topic prefix: ${config.mqtt.topicPrefix}/`);
  if (config.busFilter) {
    console.log(`[Bridge] Filtering for: ${config.busFilter}`);
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
