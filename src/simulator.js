/**
 * simulator.js — Simulation mode for local testing.
 *
 * Activated via SIMULATE=true in the environment.
 * Emits fake NewLocation events on a timer with no real connections.
 * The API server runs normally so the UI is accessible.
 *
 * Usage:
 *   SIMULATE=true node src/index.js
 *   SIMULATE=true npm start
 */

"use strict";

const { ApiServer } = require("./api-server");
const { MqttBridge } = require("./mqtt-bridge");

// Home stop sits inside the fake buses' wander area so distance/approaching
// sensors visibly change in sim. School is a bit further off.
const HOME_STOP = { stopId: 1638, desc: "MAPLE ST @ 3RD AVE", lat: 40.713, lng: -74.007 };
const SCHOOL_STOP = { stopId: 21, desc: "PS 42", locationName: "PS 42", lat: 40.72, lng: -74.0 };

// Fabricated approach polylines the student's buses follow, matching the WKT
// geometry on the runDetail rows below (all coordinates invented). The AM bus
// (BUS 099) winds toward HOME_STOP then on to school; the PM bus (BUS 042) runs
// school → HOME_STOP. Both routes deliberately jog (a dogleg east then back) so
// the road distance is visibly longer than crow-flies — exercising the
// route-aware distance/ETA path in sim.
const AM_ROUTE = [
  [40.7100, -74.0040],
  [40.7104, -74.0022], // jog east...
  [40.7118, -74.0028],
  [40.7126, -74.0052], // ...back west toward the stop
  [40.7130, -74.0070], // HOME_STOP
  [40.7190, -73.9990], // toward school
];
const PM_ROUTE = [
  [40.7190, -73.9990], // near school
  [40.7160, -74.0020],
  [40.7150, -74.0055], // jog
  [40.7135, -74.0050],
  [40.7130, -74.0070], // HOME_STOP
];

// Four fake buses doing a random walk around a generic suburban area. The two
// that carry the student (BUS 099 AM, BUS 042 PM) instead follow a fixed route
// once from start to finish, then idle at the final vertex.
const FAKE_BUSES = [
  { id: "BUS 001", lat: 40.7128, lng: -74.0060, heading: 45,  speed: 22 },
  { id: "BUS 002", lat: 40.7148, lng: -74.0090, heading: 180, speed: 0  },
  { id: "BUS 042", lat: PM_ROUTE[0][0], lng: PM_ROUTE[0][1], heading: 270, speed: 20, route: PM_ROUTE, routeIdx: 1 },
  { id: "BUS 099", lat: AM_ROUTE[0][0], lng: AM_ROUTE[0][1], heading: 90,  speed: 20, route: AM_ROUTE, routeIdx: 1 },
];

/**
 * WKT LINESTRING (lng lat order) for a slice of the route, [from..to] inclusive.
 * Concatenating the rows' slices reproduces the whole route polyline.
 */
function wktPath(route, from, to) {
  const pairs = route.slice(from, to + 1).map(([lat, lng]) => `${lng} ${lat}`);
  return `LINESTRING (${pairs.join(", ")})`;
}

// Fake student: normally rides BUS 042 (AM), today BUS 099 is substituting.
// PM run uses BUS 042 as usual. Mirrors the real Lucas/bus-57 scenario.
// stopsInfo/runDetail mirror the real /api/student shape so the stop-tracking
// entities (my_stop, distance_to_stop, eta, approaching) have data to work with.
const FAKE_STUDENTS = [
  {
    uniqueId: "sim_001",
    firstName: "Lucas",
    lastName: "Sim",
    locationName: SCHOOL_STOP.locationName,
    homeAddress: { latitude: 40.7132, longitude: -74.0072 },
    runInfo: [
      {
        runId: 1,
        busNumber: "BUS 042",
        activeVehicle: "BUS 099",  // substitute today
        stopsInfo: [
          { stopTime: "1900-01-01T08:45:00", actionType: "Pickup", stopId: HOME_STOP.stopId, stopDescription: HOME_STOP.desc, stopAddress: "MAPLE ST", stopCity: "TESTBORO", stopState: "NY", stopZip: "10001", stopLat: HOME_STOP.lat, stopLong: HOME_STOP.lng, locationName: "" },
          { stopTime: "1900-01-01T09:10:00", actionType: "Dropoff", stopId: SCHOOL_STOP.stopId, stopDescription: SCHOOL_STOP.desc, stopAddress: "1 SCHOOL WAY", stopCity: "TESTBORO", stopState: "NY", stopZip: "10001", stopLat: SCHOOL_STOP.lat, stopLong: SCHOOL_STOP.lng, locationName: SCHOOL_STOP.locationName },
        ],
        runDetail: [
          { runStopSeq: 0, stopId: 9001, stopTime: "1900-01-01T08:40:00", directionSeq: 0, directionGeomLine: wktPath(AM_ROUTE, 0, 1) },
          { runStopSeq: 1, stopId: 9002, stopTime: "1900-01-01T08:43:00", directionSeq: 0, directionGeomLine: wktPath(AM_ROUTE, 1, 2) },
          { runStopSeq: 2, stopId: HOME_STOP.stopId, stopTime: "1900-01-01T08:45:00", directionSeq: 0, directionGeomLine: wktPath(AM_ROUTE, 2, 4) },
          { runStopSeq: 3, stopId: SCHOOL_STOP.stopId, stopTime: "1900-01-01T09:10:00", directionSeq: 0, directionGeomLine: wktPath(AM_ROUTE, 4, 5) },
        ],
      },
      {
        runId: 2,
        busNumber: "BUS 042",
        activeVehicle: "BUS 042",  // no substitute for PM
        stopsInfo: [
          { stopTime: "1900-01-01T15:15:00", actionType: "Pickup", stopId: SCHOOL_STOP.stopId, stopDescription: SCHOOL_STOP.desc, stopAddress: "1 SCHOOL WAY", stopCity: "TESTBORO", stopState: "NY", stopZip: "10001", stopLat: SCHOOL_STOP.lat, stopLong: SCHOOL_STOP.lng, locationName: SCHOOL_STOP.locationName },
          { stopTime: "1900-01-01T15:45:00", actionType: "Dropoff", stopId: HOME_STOP.stopId, stopDescription: HOME_STOP.desc, stopAddress: "MAPLE ST", stopCity: "TESTBORO", stopState: "NY", stopZip: "10001", stopLat: HOME_STOP.lat, stopLong: HOME_STOP.lng, locationName: "" },
        ],
        runDetail: [
          { runStopSeq: 0, stopId: SCHOOL_STOP.stopId, stopTime: "1900-01-01T15:15:00", directionSeq: 0, directionGeomLine: wktPath(PM_ROUTE, 0, 1) },
          { runStopSeq: 1, stopId: 9003, stopTime: "1900-01-01T15:30:00", directionSeq: 0, directionGeomLine: wktPath(PM_ROUTE, 1, 3) },
          { runStopSeq: 2, stopId: HOME_STOP.stopId, stopTime: "1900-01-01T15:45:00", directionSeq: 0, directionGeomLine: wktPath(PM_ROUTE, 3, 4) },
        ],
      },
    ],
  },
];

/**
 * Returns fake student data in the same shape as MyRideApi.getStudents().
 * Used by the orchestrator when SIMULATE=true.
 */
async function getStudents() {
  return FAKE_STUDENTS;
}

const TICK_MS = 5000; // emit a location update every 5 s

// bus.speed is mph (that's what we publish/consume), so convert to m/s before
// moving. Meters-per-degree of latitude is ~constant; longitude degrees shrink
// by cos(latitude), so divide lng deltas by it to keep movement physical.
const MPH_TO_MS = 0.44704;
const METERS_PER_DEG_LAT = 111320;

/** Meters the bus travels in one tick at its current mph. */
function metersPerTick(bus) {
  return bus.speed * MPH_TO_MS * (TICK_MS / 1000);
}

/** Build a NewLocation payload from a bus's current position/heading/speed. */
function locationOf(bus) {
  return {
    assetUniqueId: bus.id,
    logTime: new Date().toISOString(),
    latitude: +bus.lat.toFixed(6),
    longitude: +bus.lng.toFixed(6),
    heading: Math.round(bus.heading),
    speed: bus.speed,
  };
}

function randomWalk(bus) {
  // Route-following buses advance along their fixed polyline instead of wandering,
  // so the route-aware distance/ETA sensors have coherent geometry to track.
  if (bus.route) return routeWalk(bus);

  // Drift heading slowly
  bus.heading = (bus.heading + (Math.random() * 20 - 10) + 360) % 360;

  // Toggle speed occasionally (simulate stops)
  if (Math.random() < 0.1) {
    bus.speed = bus.speed > 0 ? 0 : Math.round(10 + Math.random() * 25);
  } else if (bus.speed > 0) {
    bus.speed = Math.max(5, Math.min(45, bus.speed + Math.round(Math.random() * 6 - 3)));
  }

  // Move position based on heading and speed (mph → m/s → degrees).
  if (bus.speed > 0) {
    const rad = (bus.heading * Math.PI) / 180;
    const meters = metersPerTick(bus);
    const cosLat = Math.cos((bus.lat * Math.PI) / 180) || 1;
    bus.lat += (meters * Math.cos(rad)) / METERS_PER_DEG_LAT;
    bus.lng += (meters * Math.sin(rad)) / (METERS_PER_DEG_LAT * cosLat);
  }

  return locationOf(bus);
}

/**
 * Advance a route-following bus one tick toward its current target vertex. It
 * travels the route forward once and then idles at the final vertex (its run is
 * done) — it never reverses back through the same cumulative frame, which the
 * route-distance guard rightly treats as backward motion (a real run restart is a
 * new run, not a reversal). Returns the same NewLocation shape as randomWalk().
 */
function routeWalk(bus) {
  const route = bus.route;
  // Past the last vertex: the run is finished — hold position, speed 0.
  if (bus.routeIdx >= route.length) {
    bus.speed = 0;
    return locationOf(bus);
  }
  const target = route[bus.routeIdx];
  // Work in meters (mph → m/s) so speed is physical and lng isn't over-counted at
  // these latitudes; interpolate the raw degree deltas by the same fraction.
  const cosLat = Math.cos((bus.lat * Math.PI) / 180) || 1;
  const dLatM = (target[0] - bus.lat) * METERS_PER_DEG_LAT;
  const dLngM = (target[1] - bus.lng) * METERS_PER_DEG_LAT * cosLat;
  const distM = Math.hypot(dLatM, dLngM);
  const stepM = metersPerTick(bus);

  if (distM <= stepM || distM === 0) {
    // Reached (or overshoot) the waypoint — snap to it and pick the next one.
    bus.lat = target[0];
    bus.lng = target[1];
    bus.routeIdx += 1;
    if (bus.routeIdx >= route.length) bus.speed = 0; // arrived at the run's end
  } else {
    const frac = stepM / distM;
    bus.lat += (target[0] - bus.lat) * frac;
    bus.lng += (target[1] - bus.lng) * frac;
    bus.heading = ((Math.atan2(dLngM, dLatM) * 180) / Math.PI + 360) % 360;
  }

  return locationOf(bus);
}

async function runSimulation({ port, tokenFile, mqtt }) {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║     MyRide K-12 → Home Assistant MQTT Bridge     ║");
  console.log("║              *** SIMULATION MODE ***              ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log();
  console.log(`[Sim] Fake buses: ${FAKE_BUSES.map((b) => b.id).join(", ")}`);
  console.log(`[Sim] Fake students: ${FAKE_STUDENTS.map((s) => `${s.firstName} ${s.lastName}`).join(", ")}`);
  console.log(`[Sim] Tick interval: ${TICK_MS / 1000}s`);

  // Optionally connect to MQTT if broker config is present
  let mqttBridge = null;
  if (mqtt) {
    console.log("[Sim] MQTT broker configured — will publish fake locations and student sensors.");
    mqttBridge = new MqttBridge(mqtt);
    mqttBridge.publishCredentialStatusDiscovery();
    mqttBridge.publishCredentialStatus(false);
  } else {
    console.log("[Sim] No MQTT_BROKER set — running without MQTT.");
  }
  console.log();

  // Bus assetUniqueId → [students] whose current run rides that bus today.
  const busToStudents = new Map();

  // Run student tracker with fake data if MQTT is available
  let simStudentTracker = null;
  if (mqttBridge) {
    const { StudentTracker } = require("./student-tracker");
    simStudentTracker = new StudentTracker({
      api: { getStudents },
      intervalMs: 15 * 60 * 1000,
      timeZone: process.env.TZ || "America/New_York",
    });
    simStudentTracker.on("update", (snapshot) => {
      busToStudents.clear();
      for (const student of snapshot.students) {
        mqttBridge.publishStudent(student);
        const activeBus = student.currentRun && student.currentRun.activeVehicle;
        if (activeBus) {
          const list = busToStudents.get(activeBus) || [];
          list.push(student);
          busToStudents.set(activeBus, list);
        }
      }
      for (const bus of snapshot.activeBuses) {
        mqttBridge.clearBusDiscovery(bus);
      }
    });
    await simStudentTracker.start();
  }

  const busStates = new Map();

  const apiServer = new ApiServer({
    port,
    tokenFile,
    onNewToken: async () => {
      console.log("[Sim] Token submission ignored in simulation mode.");
    },
    getStatus: () => ({
      bridge: "myride-ha-bridge",
      simulate: true,
      tokenExpired: false,
      tokenExpiresAt: new Date(Date.now() + 50 * 60 * 1000).toISOString(),
      tokenExpiresInSeconds: 50 * 60,
      signalrConnected: true,
      mqttConnected: mqttBridge ? mqttBridge.client.connected : false,
      buses: Array.from(busStates.values()).sort((a, b) => a.name.localeCompare(b.name)),
    }),
  });

  await apiServer.start();
  console.log();

  // Emit fake location events
  let count = 0;
  const timer = setInterval(() => {
    for (const bus of FAKE_BUSES) {
      const loc = randomWalk(bus);
      busStates.set(loc.assetUniqueId, {
        name: loc.assetUniqueId,
        lastSeen: loc.logTime,
        speed: loc.speed,
        moving: loc.speed > 0,
      });
      count++;
      if (count === 1 || count % 10 === 0) {
        console.log(
          `[Bus] ${loc.assetUniqueId} @ ${loc.latitude},${loc.longitude} ` +
          `heading=${loc.heading}° speed=${loc.speed}mph`
        );
      }
      if (mqttBridge) {
        const students = busToStudents.get(loc.assetUniqueId);
        if (students) {
          for (const student of students) {
            mqttBridge.publishStudentLocation(student, loc);
          }
        }
      }
    }
    if (count >= 10000) count = 0;
  }, TICK_MS);

  console.log("[Sim] Running. Press Ctrl+C to stop.");

  async function shutdown(signal) {
    console.log(`\n[Sim] ${signal} received, shutting down...`);
    clearInterval(timer);
    if (simStudentTracker) simStudentTracker.stop();
    await apiServer.stop();
    if (mqttBridge) await mqttBridge.disconnect();
    process.exit(0);
  }

  process.on("SIGINT",  () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

module.exports = { runSimulation, getStudents, FAKE_STUDENTS };
