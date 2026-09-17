---
name: code-review
description: Review-focused instructions for Copilot code review of the MyRide → Home Assistant bridge. Use when reviewing a pull request or diff in this repository. Prioritizes the correctness bugs that actually break bus tracking (route snapping, fix ordering, timezone/run selection, MQTT clearing/retention semantics) over style nits.
---

# Code review — MyRide HA bridge

You are reviewing a Node.js bridge that streams school-bus GPS from Tyler MyRide into
Home Assistant over MQTT. A "good" review here catches the bugs that silently produce
**wrong data on a parent's dashboard** (a bus snapped to the wrong route, a frozen
"stops away", a delay computed against the wrong run) — not formatting.

## How to review

- **Lead with correctness and data-integrity findings.** Rank comments by real-world
  impact: a bug that mis-tracks a live bus outranks everything else. Aim for a few
  high-confidence, specific findings over a long list of low-value ones.
- **Be concrete.** Cite the file/line, describe the failing input or state, and say what
  the user-visible symptom would be (e.g. "`distance_to_stop` freezes at the last value
  in HA because…"). Suggest the minimal fix.
- **Don't nitpick.** No style/formatting/naming opinions unless they cause a real bug.
  There is no linter-style bar to enforce here; the `.github/copilot-instructions.md`
  already documents the house conventions — flag a violation only when it breaks behavior.
- **Verify claims against the code**, not the PR description. If the diff says it fixes a
  route-snap bug, check the guard logic actually holds for the edge cases below.

## Highest-value bug classes for this repo (check these first)

1. **Route snapping / distance / stops-away** (`src/mqtt-bridge.js`,
   `src/student-tracker.js`). This is the most bug-prone area. Scrutinize any change to:
   - `_routeDistanceMeters()` snap logic — the off-route (`ROUTE_SNAP_MAX_METERS` 150 m),
     wrong-pass (`lastRouteCumByStudent`, backward > 50 m / forward > 150 m + elapsed×30),
     and plausibility (`routeMeters < haversine − 500 m`) guards. A regression here snaps
     the bus to the wrong pass of a looping route and reads "at the stop" while it's km away.
   - The **held-fix** budget (`ROUTE_MAX_HELD_FIXES` 3, `_holdOrClearRoute()`) and the
     distinction between advancing vs preserving the accept clock on wrong-pass vs off-route
     failures. Getting the clock handling wrong either loses route mode for the rest of a run
     or lets a recurring bad snap get promoted.
   - `attachRouteGeometry()` WKT parsing — LINESTRINGs are **lng-lat** and swapped on parse.
     A lat/lng transposition is a classic silent bug here.
2. **Fix ordering** (`src/fix-order-guard.js`). SignalR replays superseded fixes. Any change
   must keep the strict-monotonic-per-bus (`logTime`, keyed on `assetUniqueId`) drop rule;
   dropping the guard makes the bus rewind and `moving` flap. Unparseable timestamps must
   pass through.
3. **Timezone / current-run selection** (`pickCurrentRun`, `nowMinutesInTimeZone`). MyRide
   stop times are **district-local wall-clock**; "now" must be computed in `TZ`, never the
   container clock or UTC. Evaluating in the wrong zone silently selects the wrong run
   (tracks the regular bus instead of a substitute, or snaps against the wrong route →
   the −395-min-delay class of bug). Check the `RUN_LATE_GRACE_MINUTES` (30) grace still
   prefers a just-ended run over the next one, and that it can't bleed into the next window.
4. **MQTT clearing & retention semantics** (`src/mqtt-bridge.js`). These conventions are
   load-bearing for HA and easy to break:
   - Numeric/timestamp stop-tracking topics must clear to the literal string **`None`**,
     never `""` — an empty payload makes HA *freeze* the last value instead of going unknown.
   - The five per-fix topics (`distance_to_stop`, `eta`, `delay`, `predicted_arrival`,
     `stops_away`) are **non-retained** with `expire_after: 600`. `scheduled_time`/`my_stop`
     stay **retained**. A change that retains a per-fix topic (or drops `expire_after`)
     reintroduces frozen-value bugs. `_evictRetainedProgress()` must still zero-byte-clear
     any retained value left by an older build.
   - Discovery configs are retained and idempotent; `origin.sw_version` comes from
     `version.js`. `has_entity_name` is set on the newer entities and must NOT be added to
     the ten pre-existing ones (it would change their entity_ids).
5. **Delay / predicted-arrival sanity** (`_publishDelay()`). Both blank to `None` unless
   route mode is active with ≥2 checkpoints, and the `DELAY_SANITY_MAX_MINUTES` (120) guard
   must still blank absurd values (the wrong-run signature).
6. **Lifecycle & auth** (`src/index.js`, `src/cognito-auth.js`). Token-expiry idle mode must
   stop SignalR + tracker, set the credentials problem sensor, and keep the API server up.
   No `withAutomaticReconnect()` (zombie connections with `skipNegotiation`). Errors carrying
   `err.tokenExpired` must route to `handleTokenExpired()`, not a generic retry.

## Tests

- Framework is Node's built-in `node:test` (Node ≥22); run with `npm test`. No jest/mocha/
  sinon, no external test deps. Mocks patch `Module._resolveFilename`/`require.cache` and
  replace `globalThis.fetch`.
- Every new module needs its own `test/<module>.test.js`. **Flag new/changed guard logic in
  the bug classes above that ships without a test** — especially `fix-order-guard` and the
  route-snap guards, whose whole point is to be unit-testable in isolation.

## Out of scope (do not comment on)

- CommonJS vs ESM, `"use strict"`, bracketed log prefixes, absence of JSDoc — these are
  intentional house conventions, already documented. Only raise them if a change breaks them
  in a way that changes behavior.
