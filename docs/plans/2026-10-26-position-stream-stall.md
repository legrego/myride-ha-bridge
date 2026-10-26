# Implementation plan: reconnect the position stream when MyRide stops tracking

Status: ready to implement · Incident: 2026-10-26 "position stream stalled" · Branch: `claude/festive-galileo-ffe74j`

This plan is self-contained. Read it, then `CLAUDE.md`, `src/index.js`, `src/signalr-client.js`,
`src/feed-monitor.js` and `src/mqtt-bridge.js` (`publishCredentialStatusDiscovery`, `publishFeedLive`).

## 1. What is broken (from the bridge logs, 2026-10-23 → 10-26)

- The bridge never subscribes to anything. It negotiates, opens the LiveVehicleHub WebSocket, and MyRide
  pushes `NewLocation` frames for the account's buses. **MyRide decides which buses a connection receives
  when the connection is made**, based on the account's runs for that day.
- A connection made on a day with runs receives its bus. While tracked, MyRide **re-sends the latest fix
  about every 5 s** even when the bus is parked (these are the `[Bus] Dropped N out-of-order fix(es)` lines,
  ~12/min), plus real fixes every 15–30 s on the road or ~30 min parked.
- A connection made on a day with **no** runs immediately receives server calls to the client methods
  `errorcode` and `error`. The bridge registers no handlers for them, so `@microsoft/signalr` only logs
  `Warning: No client method with the name 'errorcode' found.` The connection then stays open, keepalives
  succeed, and it receives **zero frames, indefinitely**.
- An existing tracked connection lost its bus ~1 h into a no-run day (Sat 01:00 local) without being closed,
  and nothing re-adds it when runs return.
- MyRide closes sockets with WebSocket code 1006 at irregular times (6 in 3 days). The existing `closed`
  handler reconnects within ~2 s, and a fresh negotiate while runs exist re-registers tracking. **That is
  the only recovery path today**, and on 2026-10-26 it happened about 50 min after the AM pickup.
- When runs appeared (Mon 00:04 `Active buses: <bus> [changed]`) the bridge only updated its client-side
  bus filter. `FeedMonitor` logged `[Feed] no fix … during run …` at 08:17 and `feed_live` was OFF, but
  nothing acted on either.

Consequence: every school day after a no-run day (Mondays, post-holiday days) is tracked only if MyRide
happens to close the socket between 00:05 and the AM run.

## 2. Goal and non-goals

Goal: within one roster poll of runs appearing, and within a bounded time of any silent stream on a run
day, the bridge holds a connection that MyRide is actively tracking, without a manual restart; and HA can
see connection-level stream health.

Non-goals (do not do these):
- No Home Assistant configuration changes (automations, helpers, dashboards). Owner decides separately.
- No "subscribe/join" hub invocation. None exists; the official app sends none.
- No `withAutomaticReconnect()`. `signalr-client.js` explains why: always build a fresh `HubConnection`.
- No change to `FeedMonitor`'s per-student `feed_live`/`last_fix` semantics or to the 120 s
  `FEED_SILENCE_MS`. New logic sits beside it.
- No keepalive/server-timeout tuning. Socket-level failures (1006) are already detected and recovered.

## 3. Design

### 3.1 New module `src/stream-supervisor.js` (pure, unit-tested)

Pure bookkeeping and decisions, no timers, logging, MQTT or SignalR. Same style as `src/feed-monitor.js`
(module header comment explaining the why, exported constants, JSDoc on every method). `index.js` feeds it
events and a clock and performs the actions it returns.

```js
const STREAM_SILENCE_MS = 300_000;          // env STREAM_SILENCE_SECONDS, default 300
const WATCHDOG_BACKOFF_MS = [0, 300_000, 600_000, 900_000]; // gap before watchdog attempt n; last repeats

class StreamSupervisor {
  constructor({ silenceMs, backoffMs } = {})

  // A connection finished start(). Resets the silence baseline so a fresh connection always gets a full
  // silence window. Records connectedSinceMs, reason, and bumps the reconnect counter (except "startup").
  onConnected(nowMs, reason)

  // A NewLocation frame for a watched bus arrived, whether FixOrderGuard accepts or drops it (the 5 s
  // repeats are the liveness signal). Resets the watchdog backoff.
  onFrame(busId, nowMs)

  // The server invoked `errorcode` or `error`. `args` is the raw invocation arguments.
  onServerError(method, args, nowMs) -> Decision | null

  // The buses this bridge should be receiving (see 3.3). Call on every student poll.
  setWatchedBuses(busIds /* Iterable<string> */, nowMs) -> Decision | null

  // Periodic check (index.js calls it from the existing 30 s feed-watchdog interval).
  check(nowMs) -> Decision | null

  // index.js calls this when it actually starts a supervisor-initiated reconnect, so backoff advances.
  onReconnectStarted(reason, nowMs)

  // For MQTT/status: { expected, live, lastWatchedFrameMs, connectedSinceMs, connectionReason,
  //   reconnects, lastReconnectReason, lastReconnectMs, watchedBuses, lastServerError }
  status(nowMs)
}

// Decision = { reconnect: true, reason: "runs-changed" | "watchdog" | "server-error", detail: {...} }
```

Decision rules:

- **R1 runs-changed.** `setWatchedBuses` returns a reconnect when the new set contains any bus not in the
  previous set (this covers none → some, and a substitute bus appearing mid-day). An identical set returns
  null: the daily AM → PM run switch on the same bus must **not** reconnect. Shrinking to a subset or to
  empty returns null. R1 is not subject to watchdog backoff, but suppress it if a connection was made less
  than 30 s ago (`MIN_RECONNECT_GAP_MS`) to absorb poll jitter.
- **R2 watchdog.** When the watched set is non-empty and no watched-bus frame has arrived for longer than
  `silenceMs` since `max(lastWatchedFrameMs, connectedSinceMs)`, `check` returns a reconnect, subject to
  backoff. Attempt *n* of a silent episode is allowed only `WATCHDOG_BACKOFF_MS[min(n, last)]` after the
  previous watchdog attempt. A frame ends the episode and resets backoff. This runs all day on run days:
  tracked connections receive the 5 s repeats around the clock (seen overnight Friday and Monday afternoon).
  The backoff cap keeps a genuine upstream outage (bus GPS dark) to one cheap reconnect per 15 min.
- **R3 server-error.** `onServerError` records `{method, args, atMs}`. If the watched set is non-empty it
  returns a reconnect (reason `server-error`), sharing R2's backoff so a server that keeps refusing doesn't
  cause a reconnect loop. If the watched set is empty it returns null; R1 reconnects once runs appear.

`status().expected` is true when the watched set is non-empty. `live` is `expected && now − lastBaseline ≤
silenceMs`, where `lastBaseline` is the most recent watched frame, or the connection time if none has
arrived yet.

### 3.2 `src/signalr-client.js` changes

1. **Server error handlers.** In `start()`, register `connection.on("errorcode", (...args) => …)` and
   `connection.on("error", …)` that emit `"serverError", { method, args }`. This also silences the
   library's "No client method" warnings.
2. **Pre-filter frame event.** In the `NewLocation` handler, emit `"frame", locationData` **before** the bus
   filter, then the existing filtered `"location"`. This is used for "any bus" accounting (3.4, 3.5).
3. **Intentional restart without a spurious `closed`.** Today `stop()` fires `onclose`, which emits
   `closed`, and `index.js` starts a reconnect loop. The log shows this on every SIGTERM
   (`Connection closed.` → `Reconnect attempt 1 in 1s...` during shutdown). Fix it:
   - In `start()`, capture `const conn = this.connection` and only emit `closed` from `conn.onclose` when
     `conn === this.connection && !this._stopping`.
   - `stop()` sets `this._stopping = true` around `connection.stop()`.
   - Add `async restart()`: stop the current connection, ignoring errors, without emitting `closed`, then
     `start()`. A late `onclose` from a superseded connection must also not emit `closed`.
4. **Test seam.** Accept an optional `hubConnectionFactory(url, options, logLevel)` constructor option. The
   default is the current `HubConnectionBuilder` chain. Tests pass a fake with `on`, `onclose`, `start`,
   `stop` and `state`.
5. Expose `connectionId` (the `id=` query value isn't available directly; use `connection.connectionId`
   after start, which `@microsoft/signalr` sets) for logging and status.

### 3.3 `src/index.js` wiring

- Create `const streamSupervisor = new StreamSupervisor({ silenceMs: … })` beside `feedMonitor`. Parse
  `STREAM_SILENCE_SECONDS` loosely and fall back to the default on NaN/≤0, as `APPROACH_RADIUS_METERS` does.
- **Watched buses** = keys of `busToStudents` after it is rebuilt in the `studentTracker.on("update")`
  handler (the buses some student's *current run* rides), intersected with `config.busFilter` when that
  override is set. Call `setWatchedBuses` there on **every** update, not only on `change`, so it works with
  the `BUS_FILTER` override too.
- **One reconnect path.** Add `reconnectSignalR(reason, detail)`:
  - No-op while `refreshTokenExpired`, or while a reconnect is already in flight (a module-level
    `reconnectInFlight` promise; the existing `closed` loop must also set and respect it).
  - Logs `[Stream] reconnect reason=<reason> …` at WARN for `watchdog`/`server-error` and INFO otherwise,
    then calls `signalrClient.restart()`. On success it calls `streamSupervisor.onConnected(now, reason)`
    and logs `[Stream] connected reason=<reason> connectionId=<id> watched=<buses>`. On failure it falls
    back to the existing exponential backoff loop, extracted into a shared function and reused by `closed`.
  - Call `streamSupervisor.onReconnectStarted(reason, now)` before restarting for `watchdog`/`server-error`.
- Route the existing callers through it, with their reasons:
  - initial connect → `startup`; mark it with `onConnected(now, "startup")` after `signalrClient.start()`;
  - `closed` loop → `closed`;
  - `handleNewToken` → `token`.
- In the `location` handler, call `streamSupervisor.onFrame(bus, now)` **before** the `fixOrderGuard`
  check, so dropped repeats count as liveness.
- `signalrClient.on("serverError", …)`: log at WARN
  `[Stream] server called <method>(<JSON args, truncated to 500 chars>) watched=<buses>`, then act on the
  returned decision.
- In the existing 30 s feed-watchdog interval, call `streamSupervisor.check(now)` and act on any decision;
  then publish stream health (3.4). The watchdog log line must include run ID, window and gap, e.g.
  `[Stream] no frame for BUS 042 in 312s on a run day (run 101 window 07:40–07:48); reconnecting (attempt 2, next allowed in 10 min)`.
  Use the run lookup the feed watchdog already does; outside any run window print `run - window -`.
- Hourly INFO line: `[Stream] frames last hour: total=<all buses, pre-filter> watched=<watched buses> connectionAge=<h>`.
  Count them in `index.js` from the `frame` event and the watched-bus `onFrame` calls.
- Add `stream: streamSupervisor.status(Date.now())` to `getBridgeStatus()` for `GET /status`.

### 3.4 MQTT discovery (bridge device `myride_bridge`, beside the credentials sensor)

Add `publishStreamHealthDiscovery()` and `publishStreamHealth(status, lastFrameAnyMs)` to `MqttBridge`.
Reuse `publishCredentialStatusDiscovery`'s `deviceConfig` and `availability` (factor them into a helper
rather than copying). Include `origin: ORIGIN`, `has_entity_name: true` and `entity_category: "diagnostic"`.

| unique_id | Component | Name | State topic | Payloads | Retained | Published |
| --- | --- | --- | --- | --- | --- | --- |
| `myride_bridge_position_stream` | binary_sensor, `device_class: connectivity` | Position Stream | `<prefix>/bridge/position_stream` | `ON` when `status.live`; `OFF` when `expected && !live`; `None` (→ unknown) when not expected (no runs today) | yes | on change |
| `myride_bridge_last_frame_received` | sensor, `device_class: timestamp` | Last Frame Received | `<prefix>/bridge/last_frame_received` | ISO-8601 bridge receipt time of the latest `NewLocation` frame from any bus (pre-filter), not MyRide's fix time; `None` until the first frame | yes | at most once per 60 s (the 5 s repeats would otherwise flood the recorder) |

`position_stream` also gets `json_attributes_topic: <prefix>/bridge/position_stream/attributes` (retained,
published with each state change and at most once per 60 s otherwise), carrying `connected_since`,
`connection_reason`, `connection_id`, `reconnects`, `last_reconnect_reason`, `last_reconnect_at`,
`watched_buses`, `last_server_error` (`{method, at, args}` with args truncated) and `frames_last_hour`.

Entity IDs HA will derive: `binary_sensor.myride_bridge_position_stream` and
`sensor.myride_bridge_last_frame_received`. These don't collide with the existing
`binary_sensor.myride_bridge_myride_credentials` or with any per-student entity
(`myride_student_<id>_feed_live` / `_last_fix`). Follow the repo's clearing convention: clear with the
literal `None`, never an empty payload.

Call `publishStreamHealthDiscovery()` right after `publishCredentialStatusDiscovery()` in `main()`.

### 3.5 Logging summary (all new lines prefixed `[Stream]`)

| Level | When |
| --- | --- |
| INFO | every connect: reason (`startup`/`closed`/`runs-changed`/`watchdog`/`server-error`/`token`), connection id, watched buses |
| INFO | `runs-changed` reconnect decision, with old → new watched set |
| WARN | watchdog reconnect: bus, gap seconds, run ID and window, attempt number, next allowed time |
| WARN | server `errorcode`/`error` with truncated payload |
| INFO | hourly frame counts |

## 4. Tests (node:test, `npm test`)

New `test/stream-supervisor.test.js`:
1. none → {A} returns `runs-changed`; {A} → {A} returns null; {A} → {A, B} returns `runs-changed`;
   {A} → {} and {A, B} → {A} return null.
2. R1 is suppressed within 30 s of a connect.
3. Watchdog: null before `silenceMs` after connect, a reconnect after it; a frame resets the clock.
4. Backoff: consecutive silent attempts are spaced 0 / 5 / 10 / 15 / 15 min; a frame resets to attempt 0.
5. No watchdog decision while the watched set is empty.
6. `onServerError` with watched buses returns `server-error` (respecting backoff); with none returns null
   but `status().lastServerError` is set.
7. `onConnected` resets the silence baseline; `reconnects` counts every connect except `startup`.
8. `status()`: `expected=false` with no watched buses; `live` true/false around `silenceMs`.
9. **Incident replay.** Drive the 10-24 → 10-26 sequence with real timestamps:
   - Sat 06:19 connect with no buses, then `errorcode`;
   - Mon 00:04 `setWatchedBuses({A})` returns `runs-changed`;
   - with no frames afterwards, the watchdog fires at about connect + 5 min;
   - after a frame, `live` is true and backoff is reset.

`test/signalr-client.test.js` (via `hubConnectionFactory` fake):
10. `errorcode` and `error` invocations emit `serverError` with the method and args.
11. `frame` is emitted for a filtered-out bus; `location` is not.
12. `stop()` and `restart()` do not emit `closed`; a server-side close of the current connection does; a
    late `onclose` from a superseded connection does not.

`test/mqtt-bridge.test.js` (existing fake-client pattern):
13. Discovery configs for both entities: unique_ids, `device.identifiers = ["myride_bridge"]`, retained,
    diagnostic, `origin`.
14. `position_stream` publishes `ON`/`OFF`/`None` on change only; `last_frame_received` is throttled to
    ≤ 1 per 60 s and uses receipt time.

`index.js` has no unit tests. Keep its new code to wiring and the reconnect path, with every decision in
`StreamSupervisor`.

## 5. Acceptance criteria

- [ ] Starting with no runs, then receiving runs, triggers a reconnect within one roster poll (≤ 15 min),
      with no manual restart (tests 1 and 9).
- [ ] A run switch that keeps the same bus (AM → PM) does not reconnect (test 1).
- [ ] A silent but open connection on a run day is reconnected within `STREAM_SILENCE_SECONDS` + one
      reconnect, then backs off to ≤ 1 attempt per 15 min while it stays silent (tests 3, 4 and 9).
- [ ] Server `errorcode`/`error` calls are logged with their payload and, on a run day, trigger a reconnect
      (tests 6 and 10).
- [ ] Stopping the bridge (SIGTERM) no longer logs a reconnect attempt (test 12).
- [ ] The two new MQTT entities appear via discovery on the MyRide Bridge device with the entity IDs above,
      without colliding with existing entities (test 13).
- [ ] `npm test` passes; `npm run simulate` still starts. Simulation returns before the SignalR wiring, so
      confirm nothing in the new code runs there.

## 6. Docs to update in the same change

- `CLAUDE.md`: add `StreamSupervisor` to the Architecture tree and a **Stream supervision** paragraph
  covering the connect-time tracking behaviour, R1–R3, the 5 s repeats as the liveness signal, and the new
  entities. Update the `SignalR` paragraph: it still says `skipNegotiation: true`, but the code negotiates.
- `README.md` and `.env.example`: document `STREAM_SILENCE_SECONDS` and the two bridge entities.

## 7. Verification after deploy (owner)

On the next school day after a no-run day, the log should show `[Stream] reconnect reason=runs-changed`
within a minute of the 00:05 roster poll. That should be followed by `[Stream] connected reason=runs-changed …`
and `[Bus] Dropped … out-of-order` lines (the 5 s repeats) within seconds. `binary_sensor.myride_bridge_position_stream`
should then read `on`.

## 8. Assumptions to watch

- The 5 s repeats are inferred from one log covering Friday night and Monday afternoon. If a tracked
  connection is ever seen without them (e.g. overnight on a run day), the watchdog will still only cost one
  reconnect per 15 min. If that proves noisy, limit R2 to the run window (`inRunWindow` with its 45/30 min
  slack) instead of the whole run day.
- The meaning of the `errorcode`/`error` payloads is unknown. The new WARN log will capture them; revisit R3
  once they are seen.
