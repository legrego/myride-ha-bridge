/**
 * status-model.js — Turns GET /status into what the status page shows.
 *
 * Pure functions (no DOM): the five Overview steps, the verdict banner, the Today
 * rows and the stream's observed liveness. The page loads this file with a <script>
 * tag (as window.StatusModel); the tests require() it, so the page's decisions are
 * tested behaviorally rather than by searching the HTML.
 *
 * Every function takes the status object `s` and `nowMs`. Actions are descriptors
 * ({ type: "config" | "goto" | "link", ... }) that the page turns into buttons.
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StatusModel = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MQTT_DEVICES_URL = "/config/integrations/integration/mqtt";
  // A roster poll more than this late (beyond its interval) means the run data is stale.
  const ROSTER_GRACE_MINUTES = 5;
  const DEFAULT_SILENCE_MS = 5 * 60 * 1000;

  const METHOD_LABELS = {
    password: "Email and password",
    "refresh-token": "Refresh token",
    "access-token": "Access token (no renewal)",
    simulated: "Simulated",
  };

  // ── Formatting ────────────────────────────────────────────────────────

  // Wall-clock time of an instant in the district time zone.
  function fmtTime(iso, timeZone, withSeconds) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return "—";
    const opts = { hour: "numeric", minute: "2-digit", timeZone: timeZone || undefined };
    if (withSeconds) opts.second = "2-digit";
    try {
      return d.toLocaleTimeString([], opts);
    } catch {
      delete opts.timeZone;
      return d.toLocaleTimeString([], opts);
    }
  }

  // A district-local "HH:MM" (from the schedule) in the viewer's time style.
  function fmtClock(hhmm) {
    if (!hhmm) return "—";
    const [h, m] = hhmm.split(":").map(Number);
    return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
  }

  function ago(iso, nowMs) {
    if (!iso) return "never";
    const sec = Math.round((nowMs - new Date(iso).getTime()) / 1000);
    if (sec < 5) return "just now";
    if (sec < 60) return sec + " s ago";
    if (sec < 3600) return Math.floor(sec / 60) + " min ago";
    if (sec < 86400) return Math.floor(sec / 3600) + " h " + Math.floor((sec % 3600) / 60) + " min ago";
    return Math.floor(sec / 86400) + " d ago";
  }

  function plural(n, word, many) {
    return n + " " + (n === 1 ? word : many || word + "s");
  }

  function isoOf(ms) {
    return ms ? new Date(ms).toISOString() : null;
  }

  function clockMinutes(hhmm) {
    if (!hhmm) return null;
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  }

  // ── Where things are configured (add-on options vs environment) ───────

  function isAddon(s) {
    return s.runtime === "addon";
  }

  function credentialsWhere(s) {
    return isAddon(s)
      ? "the myride_email and myride_password options on the add-on’s Configuration tab"
      : "the MYRIDE_EMAIL and MYRIDE_PASSWORD environment variables";
  }

  function applyWhere(s) {
    return isAddon(s) ? "Saving there restarts the add-on." : "Restart the container after changing them.";
  }

  function configAction(s) {
    return isAddon(s) && s.configUrl ? { type: "config", href: s.configUrl, label: "Open Configuration tab" } : null;
  }

  function gotoAction(tab, label, primary) {
    return { type: "goto", tab, label, primary: Boolean(primary) };
  }

  function credentialsProblem(s) {
    return Boolean(s.tokenMissing || s.tokenExpired);
  }

  // ── Students and runs ─────────────────────────────────────────────────

  // Route-derived progress is published only while the bus is on its way to the
  // stop (blank once served) and expires 10 minutes after the last fix, so any
  // value here means the bus is still driving to the stop.
  function hasProgress(live) {
    return Boolean(live) && (live.stopsAway != null || live.etaMinutes != null || live.delayMinutes != null);
  }

  /**
   * What a run is doing now: "active" (inside its window), "late" (window over,
   * bus still heading to the stop), "on-its-way" (before its window, bus already
   * reporting), "done", "upcoming", or "unknown".
   */
  function runPhase(student, run) {
    const live = student.live || {};
    if (run.current && run.state === "done" && hasProgress(live)) return "late";
    if (run.current && run.state === "upcoming" && live.feedLive === true) return "on-its-way";
    return run.state;
  }

  function inProgress(student, run) {
    return run.current && ["active", "late", "on-its-way"].includes(runPhase(student, run));
  }

  function activeRuns(s) {
    const out = [];
    for (const st of s.students || []) {
      for (const r of st.runs) if (r.current && ["active", "late"].includes(runPhase(st, r))) out.push({ student: st, run: r });
    }
    return out;
  }

  function nextRun(s) {
    let best = null;
    for (const st of s.students || []) {
      for (const r of st.runs) {
        if (r.state === "upcoming" && (!best || clockMinutes(r.windowStart) < clockMinutes(best.run.windowStart))) best = { student: st, run: r };
      }
    }
    return best;
  }

  function rosterOverdue(s, nowMs) {
    const roster = s.roster || {};
    if (!roster.lastPollAt || !roster.pollMinutes) return false;
    return nowMs - new Date(roster.lastPollAt).getTime() > (roster.pollMinutes + ROSTER_GRACE_MINUTES) * 60000;
  }

  function rosterStale(s, nowMs) {
    const roster = s.roster || {};
    return Boolean(roster.lastError) || rosterOverdue(s, nowMs);
  }

  /** One row per run for the Today tab. */
  function todayRows(s) {
    const rows = [];
    for (const st of s.students || []) {
      for (const r of st.runs) {
        const l = st.live || {};
        const phase = runPhase(st, r);
        let tone = "idle", status = "Upcoming", progress = "—", snap = "—";
        if (phase === "done") status = "Done";
        if (phase === "active") { tone = "ok"; status = "In progress"; }
        if (r.current && inProgress(st, r)) {
          tone = phase === "late" ? "warn" : "ok";
          status = phase === "late" ? "Running late" : phase === "on-its-way" ? "On its way" : "In progress";
          if (l.feedLive === false) { tone = "warn"; status = "No fixes"; }
          const parts = [];
          if (l.stopsAway != null) parts.push(plural(l.stopsAway, "stop") + " away");
          if (l.etaMinutes != null) parts.push("ETA " + l.etaMinutes + " min");
          if (l.delayMinutes != null) parts.push(l.delayMinutes === 0 ? "on time" : Math.abs(l.delayMinutes) + " min " + (l.delayMinutes > 0 ? "late" : "early"));
          progress = parts.join(" · ") || (l.feedLive === false
            ? (l.lastFixAt ? "Last fix " + fmtTime(l.lastFixAt, s.timeZone) : "Waiting for fixes")
            : "Waiting for a route fix");
          snap = l.routeSnap === true ? "On route" : l.routeSnap === false ? "Off route" : "—";
        }
        rows.push({ student: st.name, run: r, tone, status, progress, snap });
      }
    }
    return rows;
  }

  // ── Stream ────────────────────────────────────────────────────────────

  /**
   * The stream as observed from frames: "live" (a watched-bus frame within the
   * silence window), "waiting" (connected less than the silence window ago, no
   * frame since), "silent", "idle" (nothing to watch) or "disconnected". The
   * supervisor's own `live` counts the post-connect grace as live, which would
   * call a stream with no frames at all healthy.
   */
  function streamLiveness(s, nowMs) {
    const st = s.stream || {};
    if (!s.signalrConnected) return "disconnected";
    if (!st.expected) return "idle";
    const silenceMs = st.silenceMs || DEFAULT_SILENCE_MS;
    if (st.lastWatchedFrameMs != null && nowMs - st.lastWatchedFrameMs <= silenceMs) return "live";
    if (st.connectedSinceMs != null && nowMs - st.connectedSinceMs <= silenceMs &&
        (st.lastWatchedFrameMs == null || st.lastWatchedFrameMs < st.connectedSinceMs)) return "waiting";
    return "silent";
  }

  // ── Steps: MyRide sign-in → students → stream → MQTT → Home Assistant ──

  function signInStep(s, nowMs) {
    const si = s.signIn || {};
    const tz = s.timeZone;
    const rejected = s.login && s.login.rejected;
    const method = METHOD_LABELS[si.method] || "Not configured";
    const rows = [["Method", method]];
    if (si.renewedAt) rows.push(["Access token", "Renewed " + fmtTime(si.renewedAt, tz) + (si.nextRenewalAt ? " · next " + fmtTime(si.nextRenewalAt, tz) : "")]);
    else if (s.tokenExpiresAt && !s.tokenExpired) rows.push(["Access token", "Expires " + fmtTime(s.tokenExpiresAt, tz)]);
    if (si.method === "password") rows.push(["Refresh token", "Kept in memory, not saved to disk"]);
    if (si.tenant) rows.push(["District", (si.tenant.source === "configured" ? "Set in the configuration · " : "Detected from sign-in · ") + si.tenant.id]);
    const step = { id: "signin", name: "MyRide sign-in", rows };
    if (s.simulate) {
      return Object.assign(step, { tone: "ok", state: "Simulated", detail: "No MyRide sign-in in simulation mode", explain: "Simulation mode uses made-up buses and students." });
    }
    if (s.tokenMissing) {
      return Object.assign(step, {
        tone: "error", state: "Not set up", detail: "No email and password or token",
        explain: "Set " + credentialsWhere(s) + ". " + applyWhere(s) + " Or paste a refresh token on the Setup tab.",
        action: configAction(s) || gotoAction("setup", "Go to Setup", true),
      });
    }
    if (rejected) {
      rows.push(["MyRide said", rejected], ["Retries", "Paused, so the MyRide account doesn’t get locked"]);
      return Object.assign(step, {
        tone: "error", state: "Rejected", detail: "MyRide rejected the email and password" + (si.rejectedAt ? " at " + fmtTime(si.rejectedAt, tz) : ""),
        explain: "Correct " + credentialsWhere(s) + ". " + applyWhere(s) + " A refresh token pasted on the Setup tab also works.",
        action: configAction(s),
      });
    }
    if (s.tokenExpired) {
      return Object.assign(step, {
        tone: "error", state: "Expired", detail: "The refresh token no longer works",
        explain: "Set " + credentialsWhere(s) + " so the bridge can sign in itself, or paste a new refresh token on the Setup tab (no restart needed).",
        action: gotoAction("setup", "Go to Setup", true),
      });
    }
    if (!si.renewedAt && !s.tokenExpiresAt) {
      return Object.assign(step, { tone: "idle", state: "Signing in", detail: method, explain: "The bridge is signing in to MyRide." });
    }
    return Object.assign(step, {
      tone: "ok", state: "Signed in",
      detail: method + (si.renewedAt ? " · renewed " + ago(si.renewedAt, nowMs) : ""),
      explain: si.method === "password"
        ? "The bridge signs in with " + credentialsWhere(s) + " and renews its access token every 50 minutes."
        : si.method === "access-token"
          ? "A raw access token expires after an hour. Set " + credentialsWhere(s) + " for continuous operation."
          : "The bridge renews its access token from the refresh token every 50 minutes.",
    });
  }

  function pollFailureExplain(roster) {
    return "The bridge can’t get students and runs from MyRide" +
      (roster.lastPollAt ? ", so the runs shown may be out of date. " : ". ") +
      (roster.lastError ? "MyRide answered: " + roster.lastError.message + ". " : "") +
      "The bridge keeps trying every " + (roster.pollMinutes || 15) + " minutes; the Events tab lists each failure.";
  }

  function rosterStep(s, nowMs) {
    const students = s.students || [];
    const roster = s.roster || {};
    const tz = s.timeZone;
    const step = { id: "roster", name: "Students and runs", rows: [] };
    const failedRow = roster.lastError ? ["Last failed poll", fmtTime(roster.lastError.at, tz) + ": " + roster.lastError.message] : null;
    if (!roster.lastPollAt) {
      if (credentialsProblem(s)) {
        return Object.assign(step, { tone: "idle", state: "Waiting", detail: "Loads after sign-in", explain: "Student and run data loads once the bridge has signed in.", rows: [["Students", "Not loaded"]] });
      }
      if (roster.lastError) {
        return Object.assign(step, {
          tone: "warn", state: "Poll failing", detail: "No successful poll yet",
          explain: pollFailureExplain(roster),
          rows: [["Students", "Not loaded"], failedRow],
          action: gotoAction("events", "See the failures"),
        });
      }
      return Object.assign(step, { tone: "idle", state: "Loading", detail: "First poll in progress", explain: "The bridge is fetching students and today’s runs from MyRide.", rows: [["Students", "Not loaded yet"]] });
    }
    const active = activeRuns(s);
    const next = nextRun(s);
    const subs = [];
    for (const st of students) for (const r of st.runs) if (r.current && r.substitute) subs.push(r.bus + " replaces " + r.regularBus + " for " + st.name);
    step.rows = [
      ["Students", students.map((st) => st.name).join(", ") || "None"],
      ["Current runs", active.map((a) => a.run.period + " " + a.run.runId + " on " + a.run.bus).join(" · ") || "None right now"],
      ["Substitutes", subs.join(" · ") || "None"],
      ["Last poll", fmtTime(roster.lastPollAt, tz) + ", " + ago(roster.lastPollAt, nowMs) + (roster.pollMinutes ? " (every " + roster.pollMinutes + " min)" : "")],
      ["District time", fmtTime(new Date(nowMs).toISOString(), tz) + ", " + (tz || "")],
    ];
    if (failedRow) step.rows.push(failedRow);
    step.explain = "Each poll picks every student’s current run from today’s schedule, in the district time zone. A wrong time zone shows up here as the wrong run. The Today tab lists every run.";
    if (credentialsProblem(s)) {
      return Object.assign(step, {
        tone: "idle", state: "Paused", detail: "Resumes after sign-in · last poll " + ago(roster.lastPollAt, nowMs),
        explain: "Polling stopped with the sign-in. The runs shown are from the last successful poll.",
      });
    }
    if (rosterStale(s, nowMs)) {
      return Object.assign(step, {
        tone: "warn",
        state: roster.lastError ? "Poll failing" : "Poll overdue",
        detail: "Last successful poll " + ago(roster.lastPollAt, nowMs),
        explain: pollFailureExplain(roster),
        action: gotoAction("events", "See the failures"),
      });
    }
    if (students.length === 0) {
      return Object.assign(step, { tone: "warn", state: "No students", detail: "MyRide returned no students for this account" });
    }
    const detail = active.length
      ? active[0].run.period + " run" + (active.length > 1 ? "s" : "") + " in progress · polled " + ago(roster.lastPollAt, nowMs)
      : next ? "Next run " + fmtClock(next.run.windowStart) + " · polled " + ago(roster.lastPollAt, nowMs)
        : "No more runs today · polled " + ago(roster.lastPollAt, nowMs);
    return Object.assign(step, { tone: "ok", state: plural(students.length, "student"), detail });
  }

  function streamStep(s, nowMs) {
    const st = s.stream || {};
    const tz = s.timeZone;
    const step = { id: "stream", name: "Position stream", rows: [] };
    if (credentialsProblem(s) && !s.signalrConnected) {
      return Object.assign(step, { tone: "idle", state: "Stopped", detail: "Starts after sign-in", explain: "The position stream needs a signed-in session.", rows: [["Connection", "Not running"]] });
    }
    const watching = (st.watchedBuses || []).join(", ") || "Nothing";
    const lastFrame = isoOf(st.lastWatchedFrameMs);
    step.rows = [
      ["Connected", st.connectedSinceMs ? "Since " + fmtTime(isoOf(st.connectedSinceMs), tz) + (st.connectionReason ? " (reason: " + st.connectionReason + ")" : "") : "Not yet"],
      ["Watching", watching],
      ["Last watched frame", lastFrame ? fmtTime(lastFrame, tz, true) + " (" + ago(lastFrame, nowMs) + ")" : "None yet"],
      ["Frames, last full hour", st.framesLastHour ? st.framesLastHour.watched + " watched of " + st.framesLastHour.total : "Not counted yet"],
      ["Reconnects", String(st.reconnects || 0) + (st.lastReconnectReason ? " · last " + st.lastReconnectReason + " at " + fmtTime(isoOf(st.lastReconnectMs), tz) : "")],
      ["Last server error", st.lastServerError ? st.lastServerError.method + " at " + fmtTime(isoOf(st.lastServerError.atMs), tz) : "None"],
    ];
    step.explain = "MyRide decides which buses a connection receives at the moment it connects. The bridge reconnects when the watched buses change, or when a watched bus is silent for the stream silence limit. The Events tab shows today’s history.";
    const liveness = streamLiveness(s, nowMs);
    if (liveness === "disconnected") return Object.assign(step, { tone: "warn", state: "Disconnected", detail: "Reconnecting to MyRide" });
    if (liveness === "idle") return Object.assign(step, { tone: "idle", state: "Nothing to watch", detail: "Connected · no student is on a bus now" });
    if (liveness === "live") {
      return Object.assign(step, {
        tone: "ok", state: "Live",
        detail: "Last frame " + ago(lastFrame, nowMs) + " · " + plural((st.watchedBuses || []).length, "bus", "buses"),
      });
    }
    if (liveness === "waiting") {
      return Object.assign(step, {
        tone: "idle", state: "Waiting for frames",
        detail: "Connected " + ago(isoOf(st.connectedSinceMs), nowMs) + " · nothing yet from " + watching,
        explain: "The bridge just connected and is waiting for the first frame from " + watching + ". If none arrives within the stream silence limit, it reconnects. " + step.explain,
      });
    }
    const since = lastFrame || isoOf(st.connectedSinceMs);
    const mins = since ? Math.floor((nowMs - new Date(since).getTime()) / 60000) : null;
    return Object.assign(step, {
      tone: "warn", state: "Silent" + (mins != null ? " " + mins + " min" : ""),
      detail: (lastFrame ? "Last frame " + ago(lastFrame, nowMs) : "No frame since connecting") + " · " + watching,
      explain: "MyRide can keep a connection open while sending nothing for a bus. The bridge reconnects automatically, spacing attempts 0, 5, 10 and 15 minutes apart. If it stays silent for a whole run, check whether the bus shows in the MyRide app, which reads the same feed.",
      action: gotoAction("events", "See what happened"),
    });
  }

  function mqttStep(s) {
    const m = s.mqtt;
    const tz = s.timeZone;
    const step = { id: "mqtt", name: "MQTT broker", rows: [] };
    if (!m) {
      return Object.assign(step, {
        tone: s.mqttConnected ? "ok" : "idle", state: s.mqttConnected ? "Connected" : "Not started",
        detail: s.simulate ? "No MQTT_BROKER set" : "Starts after sign-in",
        explain: s.simulate ? "Simulation mode runs without MQTT unless MQTT_BROKER is set." : "The bridge connects to MQTT once it has signed in to MyRide.",
        rows: [["Broker", "Not connected"]],
      });
    }
    step.rows = [
      ["Broker", m.broker + ":" + m.port + (isAddon(s) ? " (Supervisor service)" : "")],
      ["Bridge availability", m.connected ? "online" : "offline"],
      ["Last publish", m.lastPublishAt ? fmtTime(m.lastPublishAt, tz, true) : "None yet"],
    ];
    step.explain = (isAddon(s) ? "The broker comes from the Supervisor’s MQTT service. " : "The broker is MQTT_BROKER and MQTT_PORT. ") +
      "If the bridge disconnects, its last will marks every entity unavailable.";
    return Object.assign(step, m.connected
      ? { tone: "ok", state: "Connected", detail: m.broker + ":" + m.port }
      : { tone: "error", state: "Disconnected", detail: "Can’t reach " + m.broker + ":" + m.port });
  }

  function haStep(s, nowMs) {
    const ha = s.homeAssistant;
    const tz = s.timeZone;
    const step = { id: "ha", name: "HA discovery", rows: [] };
    if (!ha) {
      return Object.assign(step, { tone: "idle", state: "Waiting", detail: "Needs MQTT", explain: "Entities are published to Home Assistant through MQTT discovery.", rows: [["Entities", "None published yet"]] });
    }
    const haState = ha.haStatus && ha.haStatus.state;
    const seen = ha.haStatus && ha.haStatus.at
      ? fmtTime(ha.haStatus.at, tz) + " (MQTT birth message" + (haState !== "online" ? ": " + haState : "") + ")"
      : "Not seen since the bridge started at " + fmtTime(s.startedAt, tz);
    const check = ha.entityCheck;
    step.rows = [
      ["Devices", String(ha.devices)],
      ["Entities published", String(ha.entities)],
      [haState && haState !== "online" ? "HA reported" : "HA last seen online", seen],
      isAddon(s)
        ? ["Entities found in HA", !check ? "Not checked yet" : check.error ? "Check failed: " + check.error : check.found + " of " + check.expected + " (checked " + fmtTime(check.checkedAt, tz) + ")"]
        : ["Entity check", "Not available when standalone"],
      ["Credentials sensor", ha.credentialsProblem ? "on" : "off"],
    ];
    step.explain = "Discovery configs are retained, so Home Assistant rebuilds the devices after a restart. " + (isAddon(s)
      ? "As an add-on, the bridge also asks Home Assistant through the Supervisor whether the entities exist."
      : "Running standalone, the bridge can’t reach Home Assistant’s API, so it can’t confirm the entities exist. It only sees the birth message Home Assistant’s MQTT integration posts when it starts.");
    if (isAddon(s)) step.action = { type: "link", href: MQTT_DEVICES_URL, label: "Open MQTT devices in Home Assistant" };
    if (ha.credentialsProblem) {
      return Object.assign(step, { tone: "error", state: "Problem reported", detail: "Credentials sensor is on" });
    }
    // An explicit "offline" from HA's MQTT integration (its last will, or a clean
    // shutdown) means it isn't receiving updates, whatever is registered. Never
    // having seen a message is different: the birth message isn't retained.
    if (haState && haState !== "online") {
      return Object.assign(step, {
        tone: "warn", state: "HA offline",
        detail: "Home Assistant’s MQTT integration reported " + haState + " at " + fmtTime(ha.haStatus.at, tz),
        explain: "Home Assistant’s MQTT integration said it went " + haState + ", so it isn’t receiving the bridge’s updates. This clears when it reports online again. " + step.explain,
      });
    }
    if (check && !check.error && check.found < check.expected) {
      return Object.assign(step, { tone: "warn", state: check.found + " of " + check.expected + " found", detail: "Home Assistant is missing some entities" });
    }
    const silentStudents = activeRuns(s).filter((a) => a.student.live && a.student.live.feedLive === false).map((a) => a.student.name);
    if (silentStudents.length) {
      step.rows.push(["Feed live", "off for " + silentStudents.join(" and ")]);
      return Object.assign(step, { tone: "warn", state: "Feed live off", detail: silentStudents.join(" and ") + " show feed live: off" });
    }
    const detail = isAddon(s) && check && !check.error
      ? check.found + " of " + check.expected + " entities found in HA"
      : ha.entities + " entities published" + (ha.haStatus && ha.haStatus.at ? " · HA seen " + fmtTime(ha.haStatus.at, tz) : "");
    return Object.assign(step, { tone: "ok", state: plural(ha.devices, "device"), detail });
  }

  function computeSteps(s, nowMs) {
    return [signInStep(s, nowMs), rosterStep(s, nowMs), streamStep(s, nowMs), mqttStep(s), haStep(s, nowMs)];
  }

  function computeVerdict(s, steps, nowMs) {
    const bad = steps.find((x) => x.tone === "error") || steps.find((x) => x.tone === "warn");
    if (bad) {
      if (bad.id === "signin") {
        const rejected = s.login && s.login.rejected;
        return {
          tone: "error",
          chip: "Action needed",
          title: s.tokenMissing ? "Set up the MyRide sign-in"
            : rejected ? "Action needed: MyRide rejected the email and password"
              : "Action needed: the MyRide sign-in expired",
          sub: s.tokenMissing ? "Add your MyRide email and password (" + credentialsWhere(s) + "), or paste a refresh token on the Setup tab."
            : rejected ? "Tracking is stopped. So the MyRide account doesn’t get locked, the bridge won’t try these credentials again until they change."
              : "Tracking is stopped until the bridge gets a working sign-in.",
          action: bad.action,
        };
      }
      if (bad.id === "stream") {
        const mins = bad.state.match(/\d+/);
        return {
          tone: "warn", chip: "Positions stalled",
          title: bad.state === "Disconnected" ? "Reconnecting to MyRide" : "Positions stalled" + (mins ? " for " + mins[0] + " minutes" : ""),
          sub: bad.state === "Disconnected" ? "The connection to MyRide dropped. The bridge is reconnecting on its own."
            : "The connection to MyRide is open, but the watched buses have sent nothing. The bridge is reconnecting on its own.",
          action: gotoAction("events", "See what happened"),
        };
      }
      return {
        tone: bad.tone, chip: bad.tone === "error" ? "Action needed" : "Check " + bad.name,
        title: bad.name + ": " + bad.state, sub: bad.detail,
        action: bad.action || gotoAction("events", "See what happened"),
      };
    }
    const students = s.students || [];
    if (!s.roster || !s.roster.lastPollAt) {
      return { tone: "idle", chip: "Starting", title: "Starting up", sub: "Signing in and loading today’s runs." };
    }
    const live = streamLiveness(s, nowMs) === "live" ? (s.stream.watchedBuses || []) : [];
    const next = nextRun(s);
    return {
      tone: "ok", chip: "Working",
      title: "Working: tracking " + plural(students.length, "student"),
      sub: (live.length ? live.join(" and ") + (live.length === 1 ? " is" : " are") + " sending positions. "
        : streamLiveness(s, nowMs) === "waiting" ? "Waiting for the first positions since connecting. " : "No bus is on a run right now. ") +
        (next ? "Next: " + next.run.period + " run at " + fmtClock(next.run.windowStart) + "." : ""),
    };
  }

  return {
    METHOD_LABELS,
    MQTT_DEVICES_URL,
    fmtTime,
    fmtClock,
    ago,
    plural,
    isoOf,
    clockMinutes,
    isAddon,
    rosterStale,
    runPhase,
    todayRows,
    streamLiveness,
    computeSteps,
    computeVerdict,
  };
});
