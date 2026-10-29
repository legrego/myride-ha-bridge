const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventLog } = require("../src/event-log");

const T0 = Date.parse("2026-01-05T13:00:00Z");

describe("EventLog", () => {
  it("lists events newest first with ISO times", () => {
    const log = new EventLog();
    log.add("info", "Bridge", "Started", { marker: "S", atMs: T0 });
    log.add("warn", "Stream", "Reconnecting", { atMs: T0 + 1000 });
    assert.deepEqual(log.list(), [
      { at: new Date(T0 + 1000).toISOString(), level: "warn", category: "Stream", message: "Reconnecting", marker: null },
      { at: new Date(T0).toISOString(), level: "info", category: "Bridge", message: "Started", marker: "S" },
    ]);
  });

  it("drops the oldest events beyond maxEvents", () => {
    const log = new EventLog({ maxEvents: 3 });
    for (let i = 0; i < 5; i++) log.add("info", "X", `e${i}`, { atMs: T0 + i });
    assert.deepEqual(log.list().map((e) => e.message), ["e4", "e3", "e2"]);
  });

  it("treats an unknown level as info", () => {
    const log = new EventLog();
    log.add("debug", "X", "m", { atMs: T0 });
    assert.equal(log.list()[0].level, "info");
  });

  it("returns a copy", () => {
    const log = new EventLog();
    log.add("info", "X", "m", { atMs: T0 });
    log.list().pop();
    assert.equal(log.list().length, 1);
  });
});
