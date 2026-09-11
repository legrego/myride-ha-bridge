# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Does

A Node.js bridge that streams real-time school bus GPS data from Tyler Technologies' MyRide K-12 platform into Home Assistant via MQTT. It connects AWS Cognito authentication → Microsoft SignalR (LiveVehicleHub) → MQTT broker → Home Assistant entities.

## Commands

```bash
npm install          # Install dependencies
npm start            # Run the bridge (node src/index.js)
npm run simulate     # Run in simulation mode (SIMULATE=true node src/index.js)
npm test             # Run the node:test suite (test/*.test.js)
```

## Configuration

Copy `.env.example` to `.env`. Key variables:
- `MYRIDE_REFRESH_TOKEN` — Cognito refresh token (captured via `capture-tokens.js` browser snippet)
- `MYRIDE_TENANT_ID` — District UUID extracted from JWT
- `COGNITO_CLIENT_ID` — Shared value: `3c5382gsq7g13djnejo98p2d98`
- `MQTT_BROKER`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD`
- `BUS_FILTER` — Optional single-bus filter (e.g., `BUS 042`)
- `APPROACH_RADIUS_METERS` — Distance for the "Approaching Stop" sensor (default `500`)
- `TZ` — District IANA timezone for run selection (default `America/New_York`)
- `API_PORT` — HTTP API port for runtime token updates (default `8099`)
- `TOKEN_FILE` — Persistent path for refresh token (default `/data/refresh_token`)

## Architecture

```
src/index.js (Orchestrator)
  ├── CognitoAuth         →  refreshes access token every 50 min via Cognito REFRESH_TOKEN_AUTH
  ├── MyRideSignalRClient →  connects to LiveVehicleHub, emits 'location' events
  ├── MqttBridge          →  publishes HA auto-discovery configs + retained location messages
  └── ApiServer           →  HTTP server (port 8099)
        ├── POST /token   →  submit new refresh token (persists + hot-reloads)
        ├── GET  /status  →  JSON health check
        └── GET  /        →  browser status UI (public/index.html)

src/simulator.js  —  activated via SIMULATE=true; emits fake NewLocation events
                      from four fake buses every 5s; ApiServer runs normally so
                      the UI and /status are accessible for local testing
```

**Simulation Mode:** Set `SIMULATE=true` (or `npm run simulate`) to run without a
real MyRide account. Four fake buses do a random walk around a New York area suburb.
The API server runs at the configured port so the status UI is accessible and
POST /token is accepted (but ignored). Optionally connects to MQTT if `MQTT_BROKER`
is set so HA automations can be tested against fake data.

**Token Bootstrap:** Users run `capture-tokens.js` as a browser console snippet to extract the Cognito refresh token from their MyRide session. The token is stored in sessionStorage under a key starting with `oidc.user`; the value is JSON with a `refresh_token` property. Direct email/password auth is disabled by Tyler Technologies. Tokens can be submitted at runtime via `POST /token` (no restart needed).

**Token Expiry Handling:** When a refresh token expires, the bridge enters idle mode: SignalR is stopped, a `binary_sensor.myride_bridge_credentials` (device_class: problem) is set to ON in HA, and the API server stays running to accept a new token via `POST /token`. The token is persisted to `TOKEN_FILE` (default `/data/refresh_token`) so it survives container recreates.

**SignalR:** Connects to `https://myridek12.tylerapi.com/livevehiclehub` with `skipNegotiation: true` (WebSocket transport). Receives `NewLocation` events with lat/lng/speed/heading every 15–30 seconds. Reconnects with exponential backoff (1s → 60s cap).

**MQTT / Home Assistant:** Entities are **student-centric**. Each student is one HA device (`myride_student_<id>`, keyed on the stable `uniqueId`) with ten entities: `device_tracker` (GPS), `sensor` (speed mph), `sensor` (heading °), `binary_sensor` (moving), `sensor` (bus today), `binary_sensor` (substitute), plus **stop-tracking**: `sensor` (my stop), `sensor` (distance to stop, m), `sensor` (ETA to stop, min), and `binary_sensor` (approaching stop). The `device_tracker`/speed/heading/moving entities mirror the location of whichever bus the student's *current run* rides today (substitute-aware), so the entity IDs stay stable regardless of bus number. `index.js` maintains a `busToStudents` map (rebuilt on every student poll from `currentRun.activeVehicle`) and routes each SignalR `NewLocation` to the matching student(s) via `MqttBridge.publishStudentLocation()`. Raw per-bus entities are **not** published; `MqttBridge.clearBusDiscovery()` removes legacy per-bus discovery configs from HA on upgrade. Discovery configs are retained and idempotent. LWT marks bridge offline on disconnect.

**Stop Tracking (student's own stop):** `StudentTracker.normalizeStudent()` enriches each student's *current run* with a `myStop` descriptor and a `stopSchedule`. MyRide's per-run data has two stop arrays: `stopsInfo` contains **only this student's own two stops** (their Pickup + Dropoff) with friendly names *and* authoritative coordinates (`stopLat`/`stopLong`); `runDetail` is the full turn-by-turn list for the whole run, with one row per direction segment (many share a `runStopSeq`) but **no names/pins for other riders' stops**. `pickMyStop()` selects the home-side stop as the one nearest the student's `homeAddress` (falling back to the non-school stop by `locationName`, then the Pickup) — this handles AM (Pickup) and PM (Dropoff) automatically. `summarizeRunStops()` collapses `runDetail` to one entry per `runStopSeq` and marks each done/upcoming by comparing scheduled `stopTime` against timezone-aware "now" (schedule-based). On each SignalR `NewLocation`, `MqttBridge.publishStudentLocation()` computes **distance** and **approaching** (within `APPROACH_RADIUS_METERS`) and an **ETA estimate** (distance ÷ current speed; blank when stopped). Distance/approaching are GPS-accurate for the student's own stop; the broader done/upcoming picture is schedule-based. MyRide's `/api/student` live-progress fields (`etaMinutes`, `distanceToVehicle`, `distanceToEndPoint`, `vehicleStatus`, `hasRunToday`) are **confirmed null/0 both off-hours and mid-run** (verified against two captures incl. an active PM run), and the SignalR `NewLocation` route-progress fields (`distanceToStartPoint`/`distanceToEndPoint`/`closestDirectionId`) are likewise **null/0 in practice** (verified live 2026-09-11) — so there is no server ETA to use; distance/ETA are computed locally.

**Route-aware distance/ETA:** `distance_to_stop` and `eta` follow the road rather than crow-flies. `StudentTracker.normalizeStudent()` calls `attachRouteGeometry()` to concatenate the run's `runDetail[].directionGeomLine` WKT LINESTRINGs (**lng-lat** order — swapped on parse) into one `routePolyline`, precompute per-vertex `cumulativeMeters` from the run start (via `haversineMeters`), and snap the stop pin to a vertex for `cumulativeAtStopMeters`; all kept in memory on `currentRun.myStop`, never published. On each `NewLocation`, `MqttBridge._routeDistanceMeters()` snaps the **bus** to its nearest route vertex and returns `cumulativeAtStopMeters − cumulativeAtBus`. It returns null (→ haversine fallback) when geometry is missing, when the bus is off-route (snap > 150 m), or when a per-student **wrong-pass guard** (`lastRouteCumByStudent`) rejects a jump relative to the last accepted position — backward beyond 50 m or forward beyond `150 m + elapsed seconds × 30 m/s` — since the route loops/U-turns and nearest-vertex can otherwise snap to the wrong pass. Elapsed time is measured frame-to-frame, including rejected frames, so a genuine long update gap permits re-acquisition while a recurring wrong-pass snap at normal cadence remains rejected. `_publishStopProgress()` uses `routeMeters ?? haversine` for distance + ETA; **approaching stays on haversine** (physical proximity is the right trigger). Snap accuracy is bounded by vertex spacing (tens of meters) — plenty for a neighborhood ETA, and much less code than full point-to-segment map-matching.

**Current-Run Selection (timezone-aware):** `StudentTracker.normalizeStudent()` picks each student's *current run* from `runInfo[]` by comparing "now" against each run's stop-time window (`pickCurrentRun`). MyRide stop times are **district-local wall-clock** times, so "now" is computed in the `TZ` timezone (default `America/New_York`) via `nowMinutesInTimeZone()` using `Intl` — **not** the container's system clock. Getting this wrong (e.g. evaluating in UTC) shifts "now" outside every run window and silently selects the wrong run — which surfaces as tracking the regular bus instead of a substitute, or vice-versa. Invalid `TZ` values fall back to the default.

## Key Data Flow

1. `index.js` calls `CognitoAuth.refresh()` to get a fresh access token
2. `MyRideSignalRClient` uses an `accessTokenFactory` closure to lazily retrieve the current token
3. `StudentTracker` polls `/api/student`; on each poll `index.js` publishes per-student discovery/state via `MqttBridge.publishStudent()` and rebuilds the `busToStudents` map from each student's `currentRun.activeVehicle`
4. On each `NewLocation` SignalR event, `index.js` looks up `busToStudents` for that bus and calls `MqttBridge.publishStudentLocation(student, data)` for each matching student
5. `MqttBridge` sanitizes the student ID (`"2008416"` → `"2008416"`), publishes discovery on first sight, then publishes the student's GPS/speed/heading/moving state

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
