const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { FixOrderGuard } = require("../src/fix-order-guard");

describe("FixOrderGuard", () => {
  const T0 = "2026-09-16T13:00:00Z";
  const T1 = "2026-09-16T13:00:15Z"; // +15 s
  const T2 = "2026-09-16T13:00:30Z"; // +30 s

  it("accepts the first fix for a bus", () => {
    const g = new FixOrderGuard();
    assert.equal(g.accept("BUS 012", T1), true);
  });

  it("accepts a strictly newer fix", () => {
    const g = new FixOrderGuard();
    g.accept("BUS 012", T1);
    assert.equal(g.accept("BUS 012", T2), true);
  });

  it("drops an older (replayed) fix", () => {
    const g = new FixOrderGuard();
    g.accept("BUS 012", T1);
    assert.equal(g.accept("BUS 012", T0), false);
  });

  it("drops a duplicate fix with the same timestamp", () => {
    const g = new FixOrderGuard();
    g.accept("BUS 012", T1);
    assert.equal(g.accept("BUS 012", T1), false);
  });

  it("a dropped fix does not advance the baseline", () => {
    const g = new FixOrderGuard();
    g.accept("BUS 012", T2); // baseline = T2
    assert.equal(g.accept("BUS 012", T0), false); // stale, ignored
    assert.equal(g.accept("BUS 012", T1), false); // still older than T2 → dropped
    assert.equal(g.lastAcceptedMs("BUS 012"), Date.parse(T2));
  });

  it("reproduces the observed replay alternation (newer/older/newer ...)", () => {
    // Live capture: 19:47:37Z and 19:47:10Z alternated. Only the forward steps pass.
    const g = new FixOrderGuard();
    const older = "2026-09-16T19:47:10Z";
    const newer = "2026-09-16T19:47:37Z";
    assert.equal(g.accept("BUS 012", newer), true);
    assert.equal(g.accept("BUS 012", older), false);
    assert.equal(g.accept("BUS 012", newer), false); // equal to baseline → dropped
    assert.equal(g.accept("BUS 012", older), false);
  });

  it("tracks each bus independently", () => {
    const g = new FixOrderGuard();
    assert.equal(g.accept("BUS 012", T2), true);
    // A different bus has its own baseline — an earlier time is still accepted.
    assert.equal(g.accept("BUS 999", T0), true);
    assert.equal(g.accept("BUS 999", T1), true);
    // BUS 012 is unaffected by BUS 999's activity.
    assert.equal(g.accept("BUS 012", T1), false);
  });

  it("passes through fixes with an unparseable timestamp without setting a baseline", () => {
    const g = new FixOrderGuard();
    assert.equal(g.accept("BUS 012", "not-a-date"), true);
    assert.equal(g.accept("BUS 012", undefined), true);
    assert.equal(g.lastAcceptedMs("BUS 012"), undefined);
    // A later valid fix still establishes the baseline normally.
    assert.equal(g.accept("BUS 012", T1), true);
    assert.equal(g.accept("BUS 012", T0), false);
  });

  it("lastAcceptedMs is undefined for an unseen bus", () => {
    const g = new FixOrderGuard();
    assert.equal(g.lastAcceptedMs("BUS 000"), undefined);
  });
});
