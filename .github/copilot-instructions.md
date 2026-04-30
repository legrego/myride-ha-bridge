# Copilot Instructions

## What this project does

A Node.js bridge that streams real-time school bus GPS data from Tyler Technologies' MyRide K-12 platform into Home Assistant via MQTT. The data path is: AWS Cognito token refresh → MyRide REST API (`/api/student`) → Microsoft SignalR (`LiveVehicleHub`) → MQTT broker → Home Assistant auto-discovery entities.

## Architecture

```
src/index.js          Orchestrator — wires all modules, manages lifecycle
src/cognito-auth.js   Cognito REFRESH_TOKEN_AUTH via plain fetch (no SDK)
src/myride-api.js     MyRide REST wrapper — GET /api/student with Bearer auth
src/signalr-client.js SignalR EventEmitter — connects to LiveVehicleHub, emits 'location'
src/mqtt-bridge.js    Publishes HA MQTT Discovery configs + state topics
src/api-server.js     HTTP server (port 8099) — POST /token, GET /status, GET /
src/student-tracker.js Polls /api/student every 15 min, normalizes run data, drives bus filter
src/simulator.js      SIMULATE=true mode — fake buses + fake student with substitute run
```

## Key design decisions

- **No AWS SDK, no axios** — all HTTP uses Node's built-in `fetch` with `AbortSignal.timeout(10000)`.
- **No `dotenv` package** — `.env` is parsed manually in `src/index.js` (env vars take precedence over file).
- **`busFilter` in `MyRideSignalRClient`** accepts either a string (exact match) or a predicate function `(id) => boolean`. String form is the legacy `BUS_FILTER` env var override; function form is driven by `StudentTracker`.
- **`StudentTracker` drives the SignalR filter** — polls `/api/student`, computes the union of all `activeVehicle` values across every student's runs for today, and updates the live `allowedBuses` Set. `BUS_FILTER` env var bypasses this when set.
- **Token expiry** is a first-class lifecycle state: `refreshTokenExpired=true` stops SignalR and the student tracker, publishes a `binary_sensor` problem to HA, and idles waiting for a new token via `POST /token`.
- **No `withAutomaticReconnect()`** on the SignalR connection — it causes zombie connections with `skipNegotiation: true`. Instead, `onclose` fires and `index.js` rebuilds a fresh `HubConnection` with exponential backoff.
- **In-flight poll guard** — `StudentTracker._poll()` uses a `_polling` boolean so slow network calls don't overlap across `setInterval` ticks.

## MQTT topic layout

| Topic | Value |
|---|---|
| `myride/bridge/status` | `online` / `offline` (LWT) |
| `myride/bridge/credentials` | `ON` (expired) / `OFF` (OK) |
| `myride/<bus_id>/attributes` | JSON: lat, lng, heading, speed, last_update |
| `myride/<bus_id>/state` | `None` (resets HA zone matching) |
| `myride/<bus_id>/speed` | mph string |
| `myride/<bus_id>/heading` | degrees string |
| `myride/<bus_id>/moving` | `ON` / `OFF` |
| `myride/student/<student_id>/state` | active bus ID string |
| `myride/student/<student_id>/attributes` | JSON: regular_bus, active_bus, is_substitute, todays_runs |
| `myride/student/<student_id>/substitute` | `ON` (substitute running) / `OFF` |

Bus IDs are sanitized via `_sanitizeId()`: `"BUS 042"` → `"bus_042"`.

## Testing

- **Framework**: Node's built-in `node:test` (requires Node ≥22).
- **Run**: `node --test test/*.test.js` or `npm test`.
- **Mocking pattern**: external modules (`mqtt`, `@microsoft/signalr`) are intercepted by patching `Module._resolveFilename` and `require.cache` before `require`-ing the source module under test. Global `fetch` is replaced directly on `globalThis`.
- Tests must not use `jest`, `mocha`, or `sinon`. No external test dependencies.
- Each new module gets its own `test/<module-name>.test.js`.

## Coding conventions

- `"use strict"` at the top of every source file.
- CommonJS (`require` / `module.exports`) — no ESM.
- No TypeScript. No build step.
- Error objects that represent an expired/invalid Cognito token carry `err.tokenExpired = true`; callers use this to route into `handleTokenExpired()` rather than a generic retry.
- Console logging uses bracketed prefixes: `[Auth]`, `[MyRide]`, `[MQTT]`, `[Students]`, `[Bridge]`, `[Sim]`.
- No inline comments unless the *why* is non-obvious. No JSDoc on private/internal functions.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `MYRIDE_REFRESH_TOKEN` | Yes (or ACCESS_TOKEN) | Cognito refresh token |
| `MYRIDE_TENANT_ID` | Yes | District UUID |
| `COGNITO_CLIENT_ID` | No | Default: `3c5382gsq7g13djnejo98p2d98` |
| `MQTT_BROKER` | Yes | e.g. `homeassistant.local` |
| `MQTT_PORT` | No | Default `1883` |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | No | |
| `BUS_FILTER` | No | Hard-lock to one bus ID; bypasses student-tracker |
| `API_PORT` | No | Default `8099` |
| `TOKEN_FILE` | No | Default `/data/refresh_token` |
| `SIMULATE` | No | `true` to run without a real MyRide account |
| `LOG_LEVEL` | No | `debug`/`info`/`warn`/`error` |
