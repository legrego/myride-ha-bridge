# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

A Node.js bridge that streams real-time school bus GPS data from Tyler Technologies' MyRide K-12 platform into Home Assistant via MQTT. It connects AWS Cognito authentication → Microsoft SignalR (LiveVehicleHub) → MQTT broker → Home Assistant entities.

## Commands

```bash
npm install       # Install dependencies
npm start         # Run the bridge (node index.js)
npm test          # Syntax-check all .js files (node -c, no test framework)
```

## Configuration

Copy `.env.example` to `.env`. Key variables:
- `MYRIDE_REFRESH_TOKEN` — Cognito refresh token (captured via `capture-tokens.js` browser snippet)
- `MYRIDE_TENANT_ID` — District UUID extracted from JWT
- `COGNITO_CLIENT_ID` — Shared value: `3c5382gsq7g13djnejo98p2d98`
- `MQTT_BROKER`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD`
- `BUS_FILTER` — Optional single-bus filter (e.g., `BUS 042`)
- `API_PORT` — HTTP API port for runtime token updates (default `8099`)
- `TOKEN_FILE` — Persistent path for refresh token (default `/data/refresh_token`)

## Architecture

```
index.js (Orchestrator)
  ├── CognitoAuth  →  refreshes access token every 50 min via Cognito REFRESH_TOKEN_AUTH
  ├── MyRideSignalRClient  →  connects to LiveVehicleHub, emits 'location' events
  ├── MqttBridge  →  publishes HA auto-discovery configs + retained location messages
  └── ApiServer   →  HTTP API for runtime token updates (POST /token, GET /status)
```

**Token Bootstrap:** Users run `capture-tokens.js` as a browser console snippet to extract the Cognito refresh token from their MyRide session. The token is stored in sessionStorage under a key starting with `oidc.user`; the value is JSON with a `refresh_token` property. Direct email/password auth is disabled by Tyler Technologies. Tokens can be submitted at runtime via `POST /token` (no restart needed).

**Token Expiry Handling:** When a refresh token expires, the bridge enters idle mode: SignalR is stopped, a `binary_sensor.myride_bridge_credentials` (device_class: problem) is set to ON in HA, and the API server stays running to accept a new token via `POST /token`. The token is persisted to `TOKEN_FILE` (default `/data/refresh_token`) so it survives container recreates.

**SignalR:** Connects to `https://myridek12.tylerapi.com/livevehiclehub` with `skipNegotiation: true` (WebSocket transport). Receives `NewLocation` events with lat/lng/speed/heading every 15–30 seconds. Reconnects with exponential backoff (1s → 60s cap).

**MQTT / Home Assistant:** Publishes four entity types per bus — `device_tracker` (GPS), `sensor` (speed mph), `sensor` (heading °), `binary_sensor` (moving). Discovery configs are retained and idempotent. LWT marks bridge offline on disconnect.

## Key Data Flow

1. `index.js` calls `CognitoAuth.refresh()` to get a fresh access token
2. `MyRideSignalRClient` uses an `accessTokenFactory` closure to lazily retrieve the current token
3. On each `NewLocation` SignalR event, `index.js` logs the update and calls `MqttBridge.publishLocation()`
4. `MqttBridge` sanitizes the bus ID (`"BUS 042"` → `"bus_042"`), publishes discovery on first sight, then publishes state/attributes

## NewLocation Event Shape

```javascript
{
  assetUniqueId: "BUS 042",   // used as the entity identifier
  logTime: "2026-03-18T18:37:41Z",
  latitude: 40.689,
  longitude: -74.044,
  heading: 138,   // degrees
  speed: 26       // mph
}
```
