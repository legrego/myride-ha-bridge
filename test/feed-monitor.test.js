const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { FeedMonitor, inRunWindow } = require("../src/feed-monitor");

// All bus ids and times are fabricated.
const BUS = "BUS 900";
const T0 = Date.parse("2026-01-05T13:00:00Z");
const s = (sec) => T0 + sec * 1000;
const iso = (sec) => new Date(s(sec)).toISOString();

describe("FeedMonitor", () => {
  describe("onAccepted()", () => {
    it("reports receipt lag against the fix's GPS time", () => {
      const m = new FeedMonitor();
      const r = m.onAccepted(BUS, iso(0), s(10));
      assert.equal(r.lagMs, 10_000);
      assert.equal(r.gapMs, null);
      assert.equal(r.resumed, false);
    });

    it("flags a resume when the gap exceeds the silence threshold", () => {
      const m = new FeedMonitor({ silenceMs: 120_000 });
      m.onAccepted(BUS, iso(0), s(10));
      assert.equal(m.onAccepted(BUS, iso(30), s(40)).resumed, false);
      const r = m.onAccepted(BUS, iso(900), s(938));
      assert.equal(r.resumed, true);
      assert.equal(r.gapMs, 898_000);
      assert.equal(r.lagMs, 38_000);
    });

    it("tolerates an unparseable logTime", () => {
      const m = new FeedMonitor();
      assert.equal(m.onAccepted(BUS, "garbage", s(0)).lagMs, null);
    });
  });

  describe("silence()", () => {
    it("is not silent within the threshold, silent past it", () => {
      const m = new FeedMonitor({ silenceMs: 120_000 });
      m.onAccepted(BUS, iso(0), s(0));
      assert.equal(m.silence(BUS, s(120)).silent, false);
      const r = m.silence(BUS, s(121));
      assert.equal(r.silent, true);
      assert.equal(r.silentMs, 121_000);
      assert.equal(r.lastLogTime, iso(0));
    });

    it("measures a never-seen bus from when it was first watched", () => {
      const m = new FeedMonitor({ silenceMs: 120_000 });
      assert.equal(m.silence(BUS, s(0)).silent, false);
      assert.equal(m.silence(BUS, s(60)).silent, false);
      const r = m.silence(BUS, s(150));
      assert.equal(r.silent, true);
      assert.equal(r.lastLogTime, null);
    });

    it("warns once per silence episode; the next fix re-arms it", () => {
      const m = new FeedMonitor({ silenceMs: 120_000 });
      m.onAccepted(BUS, iso(0), s(0));
      assert.equal(m.silence(BUS, s(200)).warned, false);
      m.markWarned(BUS);
      assert.equal(m.silence(BUS, s(230)).warned, true);
      m.onAccepted(BUS, iso(240), s(240));
      assert.equal(m.silence(BUS, s(400)).warned, false);
    });

    it("tracks buses independently", () => {
      const m = new FeedMonitor({ silenceMs: 120_000 });
      m.onAccepted(BUS, iso(0), s(0));
      m.onAccepted("BUS 901", iso(100), s(100));
      assert.equal(m.silence(BUS, s(150)).silent, true);
      assert.equal(m.silence("BUS 901", s(150)).silent, false);
    });
  });

  describe("drop accounting", () => {
    it("summarizes the first drop immediately, then at most once per interval", () => {
      const m = new FeedMonitor({ dropSummaryIntervalMs: 60_000 });
      const first = m.onDropped(BUS, iso(0), s(5), s(10));
      assert.deepEqual(first, { busId: BUS, count: 1, newestLogTime: iso(0), lastAcceptedMs: s(5) });
      assert.equal(m.onDropped(BUS, iso(0), s(5), s(20)), null);
      assert.equal(m.onDropped(BUS, iso(0), s(5), s(30)), null);
      const next = m.onDropped(BUS, iso(1), s(5), s(70));
      assert.equal(next.count, 3);
      assert.equal(next.newestLogTime, iso(1));
    });

    it("flushes drops that accumulated after the last summary", () => {
      const m = new FeedMonitor({ dropSummaryIntervalMs: 60_000 });
      m.onDropped(BUS, iso(0), s(5), s(10)); // summarized immediately
      m.onDropped(BUS, iso(0), s(5), s(20)); // pending
      assert.deepEqual(m.flushDrops(s(50)), []); // interval not yet elapsed
      const out = m.flushDrops(s(70));
      assert.equal(out.length, 1);
      assert.equal(out[0].count, 1);
      assert.deepEqual(m.flushDrops(s(200)), []); // nothing pending
    });
  });
});

describe("inRunWindow()", () => {
  const run = { windowStart: 9 * 60, windowEnd: 9 * 60 + 10 }; // 09:00–09:10

  it("includes the lead-in before the student's first stop and the late tail", () => {
    assert.equal(inRunWindow(run, 8 * 60 + 15), true);  // 45 min lead
    assert.equal(inRunWindow(run, 8 * 60 + 14), false);
    assert.equal(inRunWindow(run, 9 * 60 + 40), true);  // 30 min tail
    assert.equal(inRunWindow(run, 9 * 60 + 41), false);
  });

  it("handles a single-stop window and missing data", () => {
    assert.equal(inRunWindow({ windowStart: 540, windowEnd: null }, 560), true);
    assert.equal(inRunWindow({ windowStart: null, windowEnd: null }, 540), false);
    assert.equal(inRunWindow(null, 540), false);
    assert.equal(inRunWindow(run, null), false);
  });
});
