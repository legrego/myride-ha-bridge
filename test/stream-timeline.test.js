const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { StreamTimeline, BUCKET_MS, MAX_SAMPLE_GAP_MS } = require("../src/stream-timeline");

// A bucket boundary, so frame buckets line up with whole 10-minute slots.
const T0 = Math.ceil(Date.parse("2026-01-05T13:00:00Z") / BUCKET_MS) * BUCKET_MS;
const sec = (n) => T0 + n * 1000;
const iso = (ms) => new Date(ms).toISOString();

describe("StreamTimeline", () => {
  describe("record()", () => {
    it("merges consecutive samples of one state into a segment", () => {
      const tl = new StreamTimeline();
      tl.record("live", sec(0));
      tl.record("live", sec(30));
      tl.record("live", sec(60));
      assert.deepEqual(tl.snapshot(sec(60)).segments, [{ state: "live", start: iso(sec(0)), end: iso(sec(60)) }]);
    });

    it("starts a new segment on a state change, closing the previous one there", () => {
      const tl = new StreamTimeline();
      tl.record("live", sec(0));
      tl.record("silent", sec(30));
      assert.deepEqual(tl.snapshot(sec(30)).segments, [
        { state: "live", start: iso(sec(0)), end: iso(sec(30)) },
        { state: "silent", start: iso(sec(30)), end: iso(sec(30)) },
      ]);
    });

    it("leaves a hole after a gap longer than the sample gap", () => {
      const tl = new StreamTimeline();
      tl.record("live", sec(0));
      const later = sec(0) + MAX_SAMPLE_GAP_MS + 1000;
      tl.record("live", later);
      const { segments } = tl.snapshot(later);
      assert.equal(segments.length, 2);
      assert.equal(segments[0].end, iso(sec(0)));
      assert.equal(segments[1].start, iso(later));
    });

    it("ignores unknown states", () => {
      const tl = new StreamTimeline();
      tl.record("bogus", sec(0));
      assert.deepEqual(tl.snapshot(sec(0)).segments, []);
    });

    it("drops history older than retainMs", () => {
      const tl = new StreamTimeline({ retainMs: 60_000 });
      tl.record("live", sec(0));
      tl.record("silent", sec(30));
      tl.record("idle", sec(400)); // after a gap, so "silent" ends at 30 s
      assert.deepEqual(tl.snapshot(sec(400)).segments.map((s) => s.state), ["idle"]);
    });
  });

  describe("snapshot()", () => {
    it("extends the current segment to now", () => {
      const tl = new StreamTimeline();
      tl.record("live", sec(0));
      assert.equal(tl.snapshot(sec(20)).segments[0].end, iso(sec(20)));
    });

    it("doesn't extend a segment whose samples stopped long ago", () => {
      const tl = new StreamTimeline();
      tl.record("live", sec(0));
      const later = sec(0) + MAX_SAMPLE_GAP_MS + 1000;
      assert.equal(tl.snapshot(later).segments[0].end, iso(sec(0)));
    });
  });

  describe("countFrame()", () => {
    it("counts frames per 10-minute bucket", () => {
      const tl = new StreamTimeline();
      tl.countFrame(sec(1));
      tl.countFrame(sec(2));
      tl.countFrame(T0 + BUCKET_MS + 5);
      const snap = tl.snapshot(T0 + BUCKET_MS + 5);
      assert.equal(snap.bucketMinutes, 10);
      assert.deepEqual(snap.frames, [
        { start: iso(T0), count: 2 },
        { start: iso(T0 + BUCKET_MS), count: 1 },
      ]);
    });
  });
});
