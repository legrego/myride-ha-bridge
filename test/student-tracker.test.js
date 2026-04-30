const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const {
  StudentTracker,
  pickCurrentRun,
  normalizeStudent,
  stopTimeToMinutes,
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
