/**
 * event-log.js — In-memory record of what the bridge did, for the status page.
 *
 * The add-on log has the full story, but reading it means leaving the page. This
 * keeps the notable events (sign-in, stream reconnects and their reasons, feed gaps,
 * route acquisition, MQTT and Home Assistant state) in a ring buffer that GET /status
 * serves. The console lines stay as they are; this is a parallel, smaller record.
 *
 * `marker` is an optional short code the page draws on its day timeline:
 *   S  bridge started            T  signed in / access token renewed
 *   R1 watched buses changed     R2 silence watchdog      R3 MyRide server error
 *   C  connection closed         !  sign-in rejected or credentials expired
 */

"use strict";

const DEFAULT_MAX_EVENTS = 300;
const LEVELS = new Set(["info", "warn", "error"]);

class EventLog {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxEvents=300] — oldest events are dropped beyond this
   */
  constructor({ maxEvents = DEFAULT_MAX_EVENTS } = {}) {
    this.maxEvents = maxEvents;
    this.events = [];
  }

  /**
   * Record an event.
   *
   * @param {"info"|"warn"|"error"} level
   * @param {string} category — short area name: Bridge, Sign-in, Stream, Feed, …
   * @param {string} message
   * @param {object} [opts]
   * @param {string} [opts.marker] — timeline marker code (see the header)
   * @param {number} [opts.atMs=Date.now()]
   */
  add(level, category, message, { marker = null, atMs = Date.now() } = {}) {
    this.events.push({
      at: new Date(atMs).toISOString(),
      level: LEVELS.has(level) ? level : "info",
      category,
      message,
      marker,
    });
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
  }

  /** Events newest first (a copy). */
  list() {
    return this.events.slice().reverse();
  }
}

module.exports = { EventLog, DEFAULT_MAX_EVENTS };
