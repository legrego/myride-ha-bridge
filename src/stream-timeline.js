/**
 * stream-timeline.js — Recent history of the position stream, for the status page.
 *
 * The page draws a day timeline: when the stream was live, silent, connected with
 * nothing to watch, or stopped, and how many watched-bus frames arrived in each
 * 10-minute slot. The orchestrator samples the state on its 30 s watchdog tick and
 * counts frames as they arrive; consecutive samples of one state merge into a
 * segment. Pure bookkeeping (no timers), so it is unit-tested directly.
 */

"use strict";

const BUCKET_MS = 10 * 60 * 1000;
const RETAIN_MS = 24 * 60 * 60 * 1000;
// A gap between samples longer than this (the process was stalled or the data
// side stopped sampling) ends the segment instead of stretching it over the gap.
const MAX_SAMPLE_GAP_MS = 5 * 60 * 1000;

const STATES = new Set(["live", "waiting", "silent", "idle", "stopped"]);

class StreamTimeline {
  /**
   * @param {object} [opts]
   * @param {number} [opts.retainMs=24h] — history older than this is dropped
   */
  constructor({ retainMs = RETAIN_MS } = {}) {
    this.retainMs = retainMs;
    this.segments = []; // { state, startMs, endMs }
    this.buckets = new Map(); // bucket start ms → watched-bus frame count
  }

  /**
   * Record the stream state at `nowMs`.
   *
   * @param {"live"|"waiting"|"silent"|"idle"|"stopped"} state — live: a watched-bus
   *   frame within the silence window; waiting: just connected, no frame yet; silent:
   *   buses expected but quiet; idle: connected with nothing to watch; stopped: no
   *   connection (credentials, startup, or between reconnects)
   * @param {number} nowMs
   */
  record(state, nowMs) {
    if (!STATES.has(state)) return;
    const last = this.segments[this.segments.length - 1];
    if (last && last.state === state && nowMs - last.endMs <= MAX_SAMPLE_GAP_MS) {
      last.endMs = Math.max(last.endMs, nowMs);
    } else {
      // Close a different-state segment at this sample so the bar has no hole.
      if (last && nowMs - last.endMs <= MAX_SAMPLE_GAP_MS) last.endMs = nowMs;
      this.segments.push({ state, startMs: nowMs, endMs: nowMs });
    }
    this._prune(nowMs);
  }

  /** Count one frame from a watched bus. */
  countFrame(nowMs) {
    const start = nowMs - (nowMs % BUCKET_MS);
    this.buckets.set(start, (this.buckets.get(start) || 0) + 1);
  }

  _prune(nowMs) {
    const cutoff = nowMs - this.retainMs;
    while (this.segments.length && this.segments[0].endMs < cutoff) this.segments.shift();
    for (const start of this.buckets.keys()) {
      if (start + BUCKET_MS < cutoff) this.buckets.delete(start);
    }
  }

  /**
   * @param {number} nowMs
   * @returns {{ bucketMinutes: number, segments: object[], frames: object[] }}
   *   ISO timestamps; the last segment is extended to `nowMs` while it is current.
   */
  snapshot(nowMs) {
    this._prune(nowMs);
    const last = this.segments[this.segments.length - 1];
    return {
      bucketMinutes: BUCKET_MS / 60000,
      segments: this.segments.map((s) => ({
        state: s.state,
        start: new Date(s.startMs).toISOString(),
        end: new Date(s === last && nowMs - s.endMs <= MAX_SAMPLE_GAP_MS ? nowMs : s.endMs).toISOString(),
      })),
      frames: [...this.buckets.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([start, count]) => ({ start: new Date(start).toISOString(), count })),
    };
  }
}

module.exports = { StreamTimeline, BUCKET_MS, MAX_SAMPLE_GAP_MS };
