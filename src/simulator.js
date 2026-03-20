/**
 * simulator.js — Simulation mode for local testing.
 *
 * Activated via SIMULATE=true in the environment.
 * Emits fake NewLocation events on a timer with no real connections.
 * The API server runs normally so the UI is accessible.
 *
 * Usage:
 *   SIMULATE=true node src/index.js
 *   SIMULATE=true npm start
 */

"use strict";

const { ApiServer } = require("./api-server");
const { MqttBridge } = require("./mqtt-bridge");

// Four fake buses doing a random walk around a generic suburban area
const FAKE_BUSES = [
  { id: "BUS 001", lat: 40.7128, lng: -74.0060, heading: 45,  speed: 22 },
  { id: "BUS 002", lat: 40.7148, lng: -74.0090, heading: 180, speed: 0  },
  { id: "BUS 042", lat: 40.7108, lng: -74.0040, heading: 270, speed: 31 },
  { id: "BUS 099", lat: 40.7168, lng: -74.0110, heading: 90,  speed: 14 },
];

const TICK_MS = 5000; // emit a location update every 5 s

function randomWalk(bus) {
  // Drift heading slowly
  bus.heading = (bus.heading + (Math.random() * 20 - 10) + 360) % 360;

  // Toggle speed occasionally (simulate stops)
  if (Math.random() < 0.1) {
    bus.speed = bus.speed > 0 ? 0 : Math.round(10 + Math.random() * 25);
  } else if (bus.speed > 0) {
    bus.speed = Math.max(5, Math.min(45, bus.speed + Math.round(Math.random() * 6 - 3)));
  }

  // Move position based on heading and speed
  if (bus.speed > 0) {
    const rad = (bus.heading * Math.PI) / 180;
    const dist = (bus.speed * TICK_MS) / 1000 / 111320; // degrees per tick
    bus.lat += dist * Math.cos(rad);
    bus.lng += dist * Math.sin(rad);
  }

  return {
    assetUniqueId: bus.id,
    logTime: new Date().toISOString(),
    latitude: +bus.lat.toFixed(6),
    longitude: +bus.lng.toFixed(6),
    heading: Math.round(bus.heading),
    speed: bus.speed,
  };
}

async function runSimulation({ port, tokenFile, mqtt }) {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     MyRide K-12 → Home Assistant MQTT Bridge     ║");
  console.log("║              *** SIMULATION MODE ***              ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();
  console.log(`[Sim] Fake buses: ${FAKE_BUSES.map((b) => b.id).join(", ")}`);
  console.log(`[Sim] Tick interval: ${TICK_MS / 1000}s`);

  // Optionally connect to MQTT if broker config is present
  let mqttBridge = null;
  if (mqtt) {
    console.log("[Sim] MQTT broker configured — will publish fake locations.");
    mqttBridge = new MqttBridge(mqtt);
    mqttBridge.publishCredentialStatusDiscovery();
    mqttBridge.publishCredentialStatus(false);
  } else {
    console.log("[Sim] No MQTT_BROKER set — running without MQTT.");
  }
  console.log();

  const apiServer = new ApiServer({
    port,
    tokenFile,
    onNewToken: async () => {
      console.log("[Sim] Token submission ignored in simulation mode.");
    },
    getStatus: () => ({
      bridge: "myride-ha-bridge",
      simulate: true,
      tokenExpired: false,
      tokenExpiresAt: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
      tokenExpiresInSeconds: 50 * 60,
      signalrConnected: true,
      mqttConnected: mqttBridge ? mqttBridge.client.connected : false,
    }),
  });

  await apiServer.start();
  console.log();

  // Emit fake location events
  let count = 0;
  const timer = setInterval(() => {
    for (const bus of FAKE_BUSES) {
      const loc = randomWalk(bus);
      count++;
      if (count === 1 || count % 10 === 0) {
        console.log(
          `[Bus] ${loc.assetUniqueId} @ ${loc.latitude},${loc.longitude} ` +
          `heading=${loc.heading}° speed=${loc.speed}mph`
        );
      }
      if (mqttBridge) mqttBridge.publishLocation(loc);
    }
    if (count >= 10000) count = 0;
  }, TICK_MS);

  console.log("[Sim] Running. Press Ctrl+C to stop.");

  async function shutdown(signal) {
    console.log(`\n[Sim] ${signal} received, shutting down...`);
    clearInterval(timer);
    await apiServer.stop();
    if (mqttBridge) await mqttBridge.disconnect();
    process.exit(0);
  }

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

module.exports = { runSimulation };
