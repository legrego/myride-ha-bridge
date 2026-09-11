const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  StudentTracker,
  pickCurrentRun,
  normalizeStudent,
  stopTimeToMinutes,
  formatMinutes,
  haversineMeters,
  parseLineString,
  buildRoutePolyline,
  cumulativeMetersAlong,
  nearestVertexCumulative,
  pickMyStop,
  summarizeRunStops,
  nowMinutesInTimeZone,
  isValidTimeZone,
  DEFAULT_TIME_ZONE,
} = require("../src/student-tracker");

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AM_RUN = {
  runId: 1,
  busNumber: "BUS 012",
  activeVehicle: "BUS 057",
  stopsInfo: [
    { stopTime: "1900-01-01T08:45:00", actionType: "Pickup" },
    { stopTime: "1900-01-01T09:10:00", actionType: "Dropoff" },
  ],
};

const PM_RUN = {
  runId: 2,
  busNumber: "BUS 012",
  activeVehicle: "BUS 012",
  stopsInfo: [
    { stopTime: "1900-01-01T15:15:00", actionType: "Pickup" },
    { stopTime: "1900-01-01T15:45:00", actionType: "Dropoff" },
  ],
};

const STUDENT_RAW = {
  uniqueId: 2008416,
  firstName: "Lucas",
  lastName: "Gregory",
  runInfo: [AM_RUN, PM_RUN],
};

// ── Unit: stopTimeToMinutes ───────────────────────────────────────────────────

describe("stopTimeToMinutes()", () => {
  it("parses HH:MM correctly", () => {
    assert.equal(stopTimeToMinutes("1900-01-01T09:02:22.99"), 9 * 60 + 2);
  });

  it("parses 15:25 correctly", () => {
    assert.equal(stopTimeToMinutes("1900-01-01T15:25:00"), 15 * 60 + 25);
  });

  it("returns null for null input", () => {
    assert.equal(stopTimeToMinutes(null), null);
  });

  it("returns null for string without T separator", () => {
    assert.equal(stopTimeToMinutes("09:02:22"), null);
  });

  it("returns null for non-numeric hours/minutes (NaN guard)", () => {
    assert.equal(stopTimeToMinutes("1900-01-01Txx:yy:00"), null);
  });

  it("does not return NaN for non-numeric time parts", () => {
    const result = stopTimeToMinutes("1900-01-01Tbad:data");
    assert.equal(result, null);
    assert.equal(Number.isNaN(result), false); // explicit: NaN must not be returned
  });
});

// ── Unit: pickCurrentRun ─────────────────────────────────────────────────────

describe("pickCurrentRun()", () => {
  it("returns null for empty runInfo", () => {
    assert.equal(pickCurrentRun([], 600), null);
  });

  it("returns the only run when runInfo has one entry", () => {
    assert.equal(pickCurrentRun([AM_RUN], 0), AM_RUN);
  });

  it("picks AM run when current time is within AM window", () => {
    const nowMinutes = 9 * 60; // 09:00 — inside AM (08:45–09:10)
    assert.equal(pickCurrentRun([AM_RUN, PM_RUN], nowMinutes), AM_RUN);
  });

  it("picks PM run when current time is within PM window", () => {
    const nowMinutes = 15 * 60 + 30; // 15:30 — inside PM (15:15–15:45)
    assert.equal(pickCurrentRun([AM_RUN, PM_RUN], nowMinutes), PM_RUN);
  });

  it("picks next upcoming run when time is between windows", () => {
    const nowMinutes = 12 * 60; // 12:00 — between AM end (09:10) and PM start (15:15)
    assert.equal(pickCurrentRun([AM_RUN, PM_RUN], nowMinutes), PM_RUN);
  });

  it("picks most recent past run when all windows are past", () => {
    const nowMinutes = 20 * 60; // 20:00 — after both windows
    assert.equal(pickCurrentRun([AM_RUN, PM_RUN], nowMinutes), PM_RUN);
  });

  it("picks AM run when time is before all windows", () => {
    const nowMinutes = 6 * 60; // 06:00 — before AM start (08:45)
    assert.equal(pickCurrentRun([AM_RUN, PM_RUN], nowMinutes), AM_RUN);
  });
});

// ── Unit: isValidTimeZone ─────────────────────────────────────────────────────

describe("isValidTimeZone()", () => {
  it("accepts a valid IANA zone", () => {
    assert.equal(isValidTimeZone("America/New_York"), true);
  });

  it("accepts UTC", () => {
    assert.equal(isValidTimeZone("UTC"), true);
  });

  it("rejects a bogus zone", () => {
    assert.equal(isValidTimeZone("Not/AZone"), false);
  });

  it("rejects null/empty", () => {
    assert.equal(isValidTimeZone(null), false);
    assert.equal(isValidTimeZone(""), false);
  });
});

// ── Unit: nowMinutesInTimeZone ────────────────────────────────────────────────

describe("nowMinutesInTimeZone()", () => {
  // 12:55 UTC. In US Eastern (EDT, UTC-4) this is 08:55.
  const instant = new Date("2026-06-23T12:55:00Z");

  it("computes minutes-since-midnight in the given zone", () => {
    assert.equal(nowMinutesInTimeZone(instant, "America/New_York"), 8 * 60 + 55);
  });

  it("differs from UTC by the zone offset (the bug being fixed)", () => {
    // Reading the host clock as if it were district-local (UTC here) yields
    // 12:55 — the wrong value that pushed "now" outside every run window.
    assert.equal(nowMinutesInTimeZone(instant, "UTC"), 12 * 60 + 55);
  });

  it("defaults to America/New_York when no zone is given", () => {
    assert.equal(nowMinutesInTimeZone(instant), 8 * 60 + 55);
  });

  it("falls back to the default zone for an invalid timezone", () => {
    assert.equal(
      nowMinutesInTimeZone(instant, "Not/AZone"),
      nowMinutesInTimeZone(instant, DEFAULT_TIME_ZONE)
    );
  });

  it("handles midnight as 0, not 24", () => {
    // 04:30 UTC == 00:30 EDT
    const midnightish = new Date("2026-06-23T04:30:00Z");
    assert.equal(nowMinutesInTimeZone(midnightish, "America/New_York"), 30);
  });
});

// ── Regression: timezone-correct run selection ────────────────────────────────

describe("timezone-correct run selection (regression for substitute bug)", () => {
  // At 12:55 UTC it is 08:55 Eastern — inside the AM window (08:45–09:10).
  const instant = new Date("2026-06-23T12:55:00Z");

  it("picks the in-progress AM (substitute) run when evaluated in district TZ", () => {
    const nowMinutes = nowMinutesInTimeZone(instant, "America/New_York");
    const run = pickCurrentRun([AM_RUN, PM_RUN], nowMinutes);
    assert.equal(run, AM_RUN);
    assert.equal(run.activeVehicle, "BUS 057"); // substitute, not the regular BUS 012
  });

  it("reproduces the bug when host time (UTC) is used instead", () => {
    const wrongNow = nowMinutesInTimeZone(instant, "UTC"); // 12:55 → between windows
    assert.equal(pickCurrentRun([AM_RUN, PM_RUN], wrongNow), PM_RUN);
  });
});

// ── Unit: normalizeStudent ────────────────────────────────────────────────────

describe("normalizeStudent()", () => {
  it("converts uniqueId to string", () => {
    const s = normalizeStudent(STUDENT_RAW, 9 * 60);
    assert.equal(s.uniqueId, "2008416");
  });

  it("sets isSubstitute=true when activeVehicle differs from busNumber", () => {
    const s = normalizeStudent(STUDENT_RAW, 9 * 60);
    assert.equal(s.currentRun.isSubstitute, true);
    assert.equal(s.currentRun.activeVehicle, "BUS 057");
    assert.equal(s.currentRun.busNumber, "BUS 012");
  });

  it("sets isSubstitute=false when activeVehicle matches busNumber", () => {
    const s = normalizeStudent(STUDENT_RAW, 15 * 60 + 30);
    assert.equal(s.currentRun.isSubstitute, false);
    assert.equal(s.currentRun.activeVehicle, "BUS 012");
  });

  it("includes all runs in todaysRuns", () => {
    const s = normalizeStudent(STUDENT_RAW, 9 * 60);
    assert.equal(s.todaysRuns.length, 2);
    assert.equal(s.todaysRuns[0].runId, 1);
    assert.equal(s.todaysRuns[1].runId, 2);
  });

  it("returns null currentRun for empty runInfo", () => {
    const s = normalizeStudent({ uniqueId: "1", firstName: "A", lastName: "B", runInfo: [] }, 0);
    assert.equal(s.currentRun, null);
  });
});

// ── Unit: formatMinutes ───────────────────────────────────────────────────────

describe("formatMinutes()", () => {
  it("formats morning times zero-padded", () => {
    assert.equal(formatMinutes(9 * 60 + 2), "09:02");
  });
  it("formats afternoon times in 24h", () => {
    assert.equal(formatMinutes(15 * 60 + 45), "15:45");
  });
  it("returns null for null/NaN", () => {
    assert.equal(formatMinutes(null), null);
    assert.equal(formatMinutes(NaN), null);
  });
});

// ── Unit: haversineMeters ─────────────────────────────────────────────────────

describe("haversineMeters()", () => {
  it("is ~0 for identical points", () => {
    assert.equal(haversineMeters(41.5, -72.0, 41.5, -72.0), 0);
  });
  it("computes a known short distance within tolerance", () => {
    // Synthetic home (41.5, -72.0) → synthetic home stop (41.49865, -72.0): ~150m
    const d = haversineMeters(41.5, -72.0, 41.49865, -72.0);
    assert.ok(d > 100 && d < 200, `expected ~150m, got ${d}`);
  });
  it("returns null when a coordinate is missing", () => {
    assert.equal(haversineMeters(42.7, -73.8, null, -73.8), null);
    assert.equal(haversineMeters(42.7, -73.8, 42.7, undefined), null);
  });
});

// ── Unit: pickMyStop ──────────────────────────────────────────────────────────

// Synthetic fixture mirroring the /api/student *shape* (all values fabricated):
// stopsInfo carries the student's own two stops with coordinates; the school
// stop carries locationName.
const AM_RUN_FIXTURE = {
  runId: 719,
  busNumber: "BUS 012",
  activeVehicle: "BUS 012",
  stopsInfo: [
    { actionType: "Pickup", stopId: 1638, stopDescription: "MAPLE ST @ 3RD AVE", stopAddress: "MAPLE ST", stopCity: "TESTBORO", stopState: "", stopZip: "10001", stopLat: 41.49865, stopLong: -72.0, locationName: "", stopTime: "1900-01-01T09:01:52.277", etaMinutes: 0 },
    { actionType: "Dropoff", stopId: 21, stopDescription: "PS 42", stopAddress: "1 SCHOOL WAY", stopCity: "TESTBORO", stopState: "NY", stopZip: "10001", stopLat: 41.52, stopLong: -71.96, locationName: "PS 42", stopTime: "1900-01-01T09:10:00", etaMinutes: 0 },
  ],
  runDetail: [
    { runStopSeq: 0, stopId: 3704, stopTime: "1900-01-01T08:49:04.533", directionSeq: 1 },
    { runStopSeq: 0, stopId: 3704, stopTime: "1900-01-01T08:49:04.533", directionSeq: 2 },
    { runStopSeq: 1, stopId: 5917, stopTime: "1900-01-01T08:49:59.403", directionSeq: 0 },
    { runStopSeq: 14, stopId: 1638, stopTime: "1900-01-01T09:01:52.277", directionSeq: 1 },
    { runStopSeq: 16, stopId: 6024, stopTime: "1900-01-01T09:05:11.007", directionSeq: 5 },
  ],
};

const HOME = { latitude: 41.5, longitude: -72.0 };

describe("pickMyStop()", () => {
  it("picks the home-side stop (nearest to home coords)", () => {
    const s = pickMyStop(AM_RUN_FIXTURE, HOME, "PS 42");
    assert.equal(s.stopId, 1638);
    assert.equal(s.name, "MAPLE ST @ 3RD AVE");
    assert.equal(s.actionType, "Pickup");
    assert.equal(s.lat, 41.49865);
    assert.equal(s.stopTimeMinutes, 9 * 60 + 1);
  });

  it("falls back to the non-school stop by name when home coords are absent", () => {
    const s = pickMyStop(AM_RUN_FIXTURE, null, "PS 42");
    assert.equal(s.stopId, 1638);
  });

  it("falls back to the Pickup stop when neither home nor school is known", () => {
    const bare = {
      stopsInfo: [
        { actionType: "Dropoff", stopId: 99, stopTime: "1900-01-01T09:10:00" },
        { actionType: "Pickup", stopId: 88, stopTime: "1900-01-01T08:45:00" },
      ],
    };
    const s = pickMyStop(bare, null, null);
    assert.equal(s.stopId, 88);
  });

  it("returns null when the run has no stopsInfo", () => {
    assert.equal(pickMyStop({ stopsInfo: [] }, HOME, "PS 42"), null);
    assert.equal(pickMyStop({}, HOME, "PS 42"), null);
  });

  it("builds a name from stopId when no description/address exists", () => {
    const s = pickMyStop({ stopsInfo: [{ actionType: "Pickup", stopId: 42 }] }, null, null);
    assert.equal(s.name, "Stop 42");
  });
});

// ── Unit: summarizeRunStops ───────────────────────────────────────────────────

describe("summarizeRunStops()", () => {
  it("dedupes multi-direction rows down to one entry per runStopSeq, sorted", () => {
    const { stops, totalStops } = summarizeRunStops(AM_RUN_FIXTURE, 9 * 60);
    assert.equal(totalStops, 4); // seqs 0,1,14,16
    assert.deepEqual(stops.map((s) => s.seq), [0, 1, 14, 16]);
    assert.equal(stops[0].stopId, 3704);
  });

  it("marks stops done when scheduled time is at/before now", () => {
    // now = 09:00 → seqs 0 (08:49) and 1 (08:49) done; 14 (09:01) and 16 (09:05) upcoming
    const { stops } = summarizeRunStops(AM_RUN_FIXTURE, 9 * 60);
    const bySeq = Object.fromEntries(stops.map((s) => [s.seq, s.done]));
    assert.equal(bySeq[0], true);
    assert.equal(bySeq[1], true);
    assert.equal(bySeq[14], false);
    assert.equal(bySeq[16], false);
  });

  it("returns empty for a run without runDetail", () => {
    assert.deepEqual(summarizeRunStops({}, 600), { stops: [], totalStops: 0 });
  });
});

// ── Unit: normalizeStudent stop enrichment ────────────────────────────────────

describe("normalizeStudent() stop enrichment", () => {
  const student = {
    uniqueId: 999001,
    firstName: "Ada",
    lastName: "Tester",
    locationName: "PS 42",
    homeAddress: HOME,
    runInfo: [AM_RUN_FIXTURE],
  };

  it("attaches myStop, schedule, totalStops and myStopSeq to the current run", () => {
    const s = normalizeStudent(student, 9 * 60);
    assert.equal(s.currentRun.myStop.stopId, 1638);
    assert.equal(s.currentRun.totalStops, 4);
    assert.equal(s.currentRun.myStopSeq, 14); // home stop is runStopSeq 14
    assert.equal(s.currentRun.stopSchedule.length, 4);
  });

  it("sets myStopSeq null when the stop isn't found in runDetail", () => {
    const noDetail = { ...student, runInfo: [{ ...AM_RUN_FIXTURE, runDetail: [] }] };
    const s = normalizeStudent(noDetail, 9 * 60);
    assert.equal(s.currentRun.myStop.stopId, 1638);
    assert.equal(s.currentRun.myStopSeq, null);
    assert.equal(s.currentRun.totalStops, 0);
  });

  it("tolerates a student with no runInfo (currentRun stays null)", () => {
    const s = normalizeStudent({ uniqueId: "1", firstName: "A", lastName: "B", runInfo: [] }, 600);
    assert.equal(s.currentRun, null);
  });
});

// ── Unit: route geometry (WKT parse, polyline, cumulative, vertex snap) ────────

// A synthetic run whose route runs due north along the -72.0 meridian; each leg
// is 0.01° of latitude (~1112 m). All coordinates fabricated.
const ROUTE_RUN = {
  runId: 900,
  busNumber: "BUS 012",
  activeVehicle: "BUS 012",
  stopsInfo: [
    { actionType: "Pickup", stopId: 1638, stopDescription: "MAPLE ST @ 3RD AVE", stopLat: 41.53, stopLong: -72.0, locationName: "", stopTime: "1900-01-01T09:01:00" },
    { actionType: "Dropoff", stopId: 21, stopDescription: "PS 42", stopLat: 41.60, stopLong: -71.9, locationName: "PS 42", stopTime: "1900-01-01T09:20:00" },
  ],
  runDetail: [
    { runStopSeq: 0, stopId: 3704, stopTime: "1900-01-01T08:50:00", directionSeq: 0, directionGeomLine: "LINESTRING (-72.0 41.50, -72.0 41.51)" },
    { runStopSeq: 1, stopId: 5917, stopTime: "1900-01-01T08:55:00", directionSeq: 0, directionGeomLine: "LINESTRING (-72.0 41.51, -72.0 41.52)" },
    { runStopSeq: 2, stopId: 1638, stopTime: "1900-01-01T09:01:00", directionSeq: 0, directionGeomLine: "LINESTRING (-72.0 41.52, -72.0 41.53)" },
  ],
};

describe("parseLineString()", () => {
  it("parses vertices and swaps WKT lng-lat into [lat, lng]", () => {
    const pts = parseLineString("LINESTRING (-72.0 41.5, -71.99 41.51)");
    assert.deepEqual(pts, [[41.5, -72.0], [41.51, -71.99]]);
  });

  it("tolerates no space after LINESTRING and extra whitespace", () => {
    const pts = parseLineString("LINESTRING(-72.0 41.5,  -71.99 41.51 )");
    assert.deepEqual(pts, [[41.5, -72.0], [41.51, -71.99]]);
  });

  it("returns null for non-strings and non-LINESTRING input", () => {
    assert.equal(parseLineString(null), null);
    assert.equal(parseLineString(42), null);
    assert.equal(parseLineString("POINT (-72 41)"), null);
  });

  it("returns null when no vertex is parseable", () => {
    assert.equal(parseLineString("LINESTRING (foo bar)"), null);
  });
});

describe("buildRoutePolyline()", () => {
  it("concatenates segments in order, dropping duplicate join vertices", () => {
    const poly = buildRoutePolyline(ROUTE_RUN.runDetail);
    assert.deepEqual(poly, [
      [41.50, -72.0],
      [41.51, -72.0],
      [41.52, -72.0],
      [41.53, -72.0],
    ]);
  });

  it("skips rows with missing/unparseable geometry", () => {
    const poly = buildRoutePolyline([
      { directionGeomLine: "LINESTRING (-72.0 41.50, -72.0 41.51)" },
      { directionGeomLine: null },
      { /* no directionGeomLine */ },
      { directionGeomLine: "LINESTRING (-72.0 41.51, -72.0 41.52)" },
    ]);
    assert.deepEqual(poly, [[41.50, -72.0], [41.51, -72.0], [41.52, -72.0]]);
  });

  it("returns [] when no geometry is present", () => {
    assert.deepEqual(buildRoutePolyline([{ stopId: 1 }, {}]), []);
    assert.deepEqual(buildRoutePolyline(null), []);
  });
});

describe("cumulativeMetersAlong()", () => {
  it("starts at 0 and accumulates each leg length", () => {
    const poly = buildRoutePolyline(ROUTE_RUN.runDetail);
    const cum = cumulativeMetersAlong(poly);
    assert.equal(cum.length, 4);
    assert.equal(cum[0], 0);
    // Each 0.01° latitude leg is ~1112 m; cumulative is strictly increasing.
    assert.ok(cum[1] > 1000 && cum[1] < 1200, `leg1 ~1112m, got ${cum[1]}`);
    assert.ok(cum[2] > cum[1] && cum[3] > cum[2]);
    assert.ok(cum[3] > 3200 && cum[3] < 3400, `total ~3336m, got ${cum[3]}`);
  });
});

describe("nearestVertexCumulative()", () => {
  const poly = buildRoutePolyline(ROUTE_RUN.runDetail);
  const cum = cumulativeMetersAlong(poly);

  it("snaps an on-vertex point to that vertex's cumulative distance", () => {
    const r = nearestVertexCumulative(41.52, -72.0, poly, cum);
    assert.equal(r.cumulativeMeters, cum[2]);
    assert.ok(r.distMeters < 1, `expected ~0m snap, got ${r.distMeters}`);
  });

  it("reports the snap distance for an off-route point", () => {
    // 0.01° of longitude east of the route (~830 m at this latitude).
    const r = nearestVertexCumulative(41.50, -71.99, poly, cum);
    assert.equal(r.cumulativeMeters, cum[0]);
    assert.ok(r.distMeters > 700 && r.distMeters < 1000, `got ${r.distMeters}`);
  });

  it("returns null for an empty polyline or non-finite point", () => {
    assert.equal(nearestVertexCumulative(41.5, -72.0, [], []), null);
    assert.equal(nearestVertexCumulative(NaN, -72.0, poly, cum), null);
  });
});

describe("normalizeStudent() route geometry enrichment", () => {
  const student = {
    uniqueId: 900001,
    firstName: "Ada",
    lastName: "Router",
    locationName: "PS 42",
    homeAddress: { latitude: 41.53, longitude: -72.0 }, // nearest the home stop (1638)
    runInfo: [ROUTE_RUN],
  };

  it("attaches routePolyline, cumulativeMeters and cumulativeAtStopMeters to myStop", () => {
    const s = normalizeStudent(student, 9 * 60);
    const stop = s.currentRun.myStop;
    assert.equal(stop.stopId, 1638);
    assert.equal(stop.routePolyline.length, 4);
    assert.equal(stop.cumulativeMeters.length, 4);
    // Home stop pin (41.53) snaps to the last vertex → full route length.
    assert.equal(stop.cumulativeAtStopMeters, stop.cumulativeMeters[3]);
  });

  it("leaves route fields unset when the run has no geometry (haversine fallback)", () => {
    const noGeom = {
      ...student,
      runInfo: [{ ...ROUTE_RUN, runDetail: ROUTE_RUN.runDetail.map(({ directionGeomLine, ...r }) => r) }],
    };
    const s = normalizeStudent(noGeom, 9 * 60);
    const stop = s.currentRun.myStop;
    assert.equal(stop.stopId, 1638);
    assert.equal(stop.routePolyline, undefined);
    assert.equal(stop.cumulativeAtStopMeters, undefined);
  });

  it("leaves route fields unset when the stop pin is far off the route geometry", () => {
    // Home stop ~7.8 km north of every route vertex (well beyond the 150 m trust
    // radius) — a sign of partial/wrong geometry. Route mode must not engage.
    const offRoute = {
      ...student,
      homeAddress: { latitude: 41.60, longitude: -72.0 },
      runInfo: [{
        ...ROUTE_RUN,
        stopsInfo: [
          { ...ROUTE_RUN.stopsInfo[0], stopLat: 41.60, stopLong: -72.0 },
          ROUTE_RUN.stopsInfo[1],
        ],
      }],
    };
    const s = normalizeStudent(offRoute, 9 * 60);
    const stop = s.currentRun.myStop;
    assert.equal(stop.stopId, 1638);
    assert.equal(stop.lat, 41.60); // stop pin still set
    assert.equal(stop.routePolyline, undefined); // but route geometry rejected
    assert.equal(stop.cumulativeAtStopMeters, undefined);
  });
});

// ── Integration: StudentTracker ───────────────────────────────────────────────

describe("StudentTracker", () => {
  let tracker;
  let fakeApi;
  let silentLogger;

  beforeEach(() => {
    fakeApi = { getStudents: async () => [STUDENT_RAW] };
    silentLogger = { log: () => {}, error: () => {} };
    tracker = new StudentTracker({ api: fakeApi, intervalMs: 100, logger: silentLogger });
  });

  afterEach(() => {
    tracker.stop();
  });

  it("activeBuses starts empty", () => {
    assert.equal(tracker.activeBuses.size, 0);
  });

  it("defaults timeZone to America/New_York", () => {
    assert.equal(tracker.timeZone, "America/New_York");
  });

  it("honors an explicit valid timeZone", () => {
    const t = new StudentTracker({ api: fakeApi, timeZone: "America/Chicago", logger: silentLogger });
    assert.equal(t.timeZone, "America/Chicago");
  });

  it("falls back to the default for an invalid timeZone", () => {
    let logged;
    const noisyLogger = { log: () => {}, error: (m) => { logged = m; } };
    const t = new StudentTracker({ api: fakeApi, timeZone: "Not/AZone", logger: noisyLogger });
    assert.equal(t.timeZone, DEFAULT_TIME_ZONE);
    assert.match(logged, /Invalid timezone/);
  });

  it("emits 'update' after start() with correct snapshot", async () => {
    let snapshot;
    tracker.on("update", (s) => { snapshot = s; });

    await tracker.start();

    assert.ok(snapshot);
    assert.equal(snapshot.students.length, 1);
    assert.equal(snapshot.students[0].firstName, "Lucas");
    assert.ok(snapshot.asOf);
  });

  it("activeBuses is the union of all run activeVehicles", async () => {
    await tracker.start();
    // AM run: BUS 057, PM run: BUS 012 — both should be tracked
    assert.ok(tracker.activeBuses.has("BUS 057"));
    assert.ok(tracker.activeBuses.has("BUS 012"));
    assert.equal(tracker.activeBuses.size, 2);
  });

  it("emits 'change' on first poll (empty set → non-empty)", async () => {
    let changeCount = 0;
    tracker.on("change", () => { changeCount++; });
    await tracker.start();
    assert.equal(changeCount, 1);
  });

  it("does NOT emit 'change' when activeBuses set is unchanged", async () => {
    await tracker.start(); // first poll
    let changeCount = 0;
    tracker.on("change", () => { changeCount++; });

    // Poll again with same data
    await tracker.refresh();
    assert.equal(changeCount, 0);
  });

  it("emits 'change' when active buses change between polls", async () => {
    await tracker.start(); // first poll → BUS 057, BUS 012
    let newSnapshot;
    tracker.on("change", (s) => { newSnapshot = s; });

    // Swap activeVehicle to a new bus
    fakeApi.getStudents = async () => [
      {
        ...STUDENT_RAW,
        runInfo: [
          { ...AM_RUN, activeVehicle: "BUS 099" },
          { ...PM_RUN, activeVehicle: "BUS 042" },
        ],
      },
    ];
    await tracker.refresh();

    assert.ok(newSnapshot);
    assert.ok(newSnapshot.activeBuses.has("BUS 099"));
    assert.ok(newSnapshot.activeBuses.has("BUS 042"));
  });

  it("emits 'error' (not throws) when api.getStudents fails", async () => {
    fakeApi.getStudents = async () => { throw new Error("network error"); };
    let errorEmitted;
    tracker.on("error", (e) => { errorEmitted = e; });

    await tracker.start();
    assert.ok(errorEmitted);
    assert.match(errorEmitted.message, /network error/);
  });

  it("stop() prevents further polling", async () => {
    let pollCount = 0;
    fakeApi.getStudents = async () => { pollCount++; return [STUDENT_RAW]; };

    await tracker.start(); // initial poll = 1
    tracker.stop();
    const countAfterStop = pollCount;

    // Wait longer than intervalMs to confirm no more polls
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(pollCount, countAfterStop);
  });

  it("refresh() triggers an immediate poll", async () => {
    let pollCount = 0;
    fakeApi.getStudents = async () => { pollCount++; return [STUDENT_RAW]; };

    await tracker.start(); // initial poll = 1
    await tracker.refresh();
    assert.equal(pollCount, 2);
  });

  it("concurrent _poll() calls are deduplicated by in-flight guard", async () => {
    let pollCount = 0;
    let resolveFirst;
    fakeApi.getStudents = () => new Promise((resolve) => {
      pollCount++;
      resolveFirst = () => resolve([STUDENT_RAW]);
    });

    // _running must be true for _poll() to proceed (normally set by start())
    tracker._running = true;

    // Fire two polls concurrently; second should be skipped while first is in flight
    const p1 = tracker._poll();
    const p2 = tracker._poll(); // should be a no-op because _polling = true
    resolveFirst();
    await Promise.all([p1, p2]);

    assert.equal(pollCount, 1);
  });
});
