/**
 * signalr-client.js — Connect to the MyRide K-12 LiveVehicleHub.
 *
 * Discovered from HAR capture:
 *   - Hub URL:     https://myridek12.tylerapi.com/livevehiclehub
 *   - Negotiate:   POST /livevehiclehub/negotiate?x-tenant-id=...&negotiateVersion=1
 *   - WebSocket:   wss://myridek12.tylerapi.com/livevehiclehub?x-tenant-id=...&id=...&access_token=...
 *   - Protocol:    SignalR JSON v1
 *   - Event:       "NewLocation" — the server pushes these to us; the client never
 *                  invokes a subscribe method (a HAR of the official web app shows the
 *                  only outbound frames are the protocol handshake and keep-alive pings).
 *
 * IMPORTANT — why we negotiate instead of skipNegotiation:
 *   The server only streams a vehicle's live GPS once the parent's connection is
 *   present in MyRide's tracking registry. That registry is populated by the
 *   negotiate handshake (the official app's WS URL carries an `id=` connection
 *   token, proving it negotiated). A connection opened with `skipNegotiation: true`
 *   reaches the hub and receives ambient broadcasts that *other* watchers have
 *   already activated, but never activates its own students' buses — so the bridge
 *   would sit silent until someone opened the official app, then "resume" by
 *   piggy-backing on the relay the app turned on. Doing the full negotiate makes the
 *   bridge a first-class watcher that activates its own buses independently.
 *
 * NewLocation payload shape:
 *   {
 *     assetId: number | null,        // internal asset ID (may be null for vendor-sourced)
 *     assetUniqueId: "BUS 042",      // human-readable bus identifier
 *     logTime: "2026-03-18T18:37:41Z",
 *     latitude: 40.6892,
 *     longitude: -74.0445,
 *     heading: 138,                  // degrees, 0=N, 90=E, 180=S, 270=W
 *     speed: 26,                     // likely mph
 *     vendorId: number | null,       // GPS vendor ID
 *     visibleRunName: string | null,
 *     closestDirectionId: string | null,
 *     distanceToClosestDirection: number | null,
 *     distanceToStartPoint: number | null,
 *     distanceToEndPoint: number | null
 *   }
 */

const signalR = require("@microsoft/signalr");
const { EventEmitter } = require("events");

const HUB_BASE_URL = "https://myridek12.tylerapi.com/livevehiclehub";

const CLIENT_VERSION = "2026.2.17+bcb384";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

class MyRideSignalRClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.tenantId   — district tenant UUID (from cognito:groups)
   * @param {function} opts.accessTokenFactory — async/sync fn returning current access token
   * @param {string|function} [opts.busFilter] — optional filter: string ID for exact match,
   *   or predicate function (assetUniqueId) => boolean. Null/undefined allows all buses.
   * @param {string} [opts.logLevel] — "debug" | "info" | "warn" | "error"
   */
  constructor({ tenantId, accessTokenFactory, busFilter, logLevel = "info" }) {
    super();
    this.tenantId = tenantId;
    this.accessTokenFactory = accessTokenFactory;
    // Normalize busFilter: string → exact-match predicate, function → use as-is
    if (typeof busFilter === "string") {
      this.busFilter = (id) => id === busFilter;
      this._busFilterLabel = busFilter;
    } else if (typeof busFilter === "function") {
      this.busFilter = busFilter;
      this._busFilterLabel = "(dynamic)";
    } else {
      this.busFilter = null;
      this._busFilterLabel = null;
    }
    this.connection = null;
    this.logLevel = this._parseLogLevel(logLevel);
  }

  _parseLogLevel(level) {
    const map = {
      debug: signalR.LogLevel.Debug,
      info: signalR.LogLevel.Information,
      warn: signalR.LogLevel.Warning,
      error: signalR.LogLevel.Error,
    };
    return map[level] || signalR.LogLevel.Information;
  }

  /**
   * Build the IHttpConnectionOptions passed to withUrl().
   *
   * We deliberately do NOT set skipNegotiation: the negotiate handshake is what
   * registers this connection as an active watcher and activates the live GPS
   * relay for our students' buses (see the file header). Browser-like headers are
   * sent so the negotiate POST mirrors the official app and isn't rejected by the
   * edge/WAF that fronts the API.
   */
  _connectionOptions() {
    return {
      accessTokenFactory: this.accessTokenFactory,
      // Force WebSocket transport for lowest latency (negotiate still runs first).
      transport: signalR.HttpTransportType.WebSockets,
      // Required for Node.js — provide the ws WebSocket implementation.
      WebSocket: require("ws"),
      // Applied to the negotiate request so it looks like the official web client.
      headers: {
        "User-Agent": USER_AGENT,
        Origin: "https://myridek12.tylerapp.com",
        Referer: "https://myridek12.tylerapp.com/",
        "x-client-language": "en",
        "x-client-version": CLIENT_VERSION,
        "x-device-type": "browser",
        "x-tenant-id": this.tenantId,
      },
    };
  }

  /**
   * Connect to the LiveVehicleHub and start receiving NewLocation events.
   */
  async start() {
    const hubUrl = `${HUB_BASE_URL}?x-tenant-id=${this.tenantId}`;

    this.connection = new signalR.HubConnectionBuilder()
      .withUrl(hubUrl, this._connectionOptions())
      // No withAutomaticReconnect() — it reuses the existing HubConnection object,
      // which can produce a zombie connection that appears Connected but receives no
      // events. Instead, we let onclose fire immediately and rely on the rebuild loop
      // in index.js, which creates a fresh HubConnection (and re-negotiates) each time.
      .configureLogging(this.logLevel)
      .build();

    // Handle the main location event
    this.connection.on("NewLocation", (locationData) => {
      if (this.busFilter && !this.busFilter(locationData.assetUniqueId)) {
        return;
      }
      this.emit("location", locationData);
    });

    // Connection lifecycle events
    this.connection.onclose((error) => {
      console.log(`[MyRide] Connection closed.`, error?.message || "");
      this.emit("closed", error);
    });

    console.log(`[MyRide] Connecting to LiveVehicleHub...`);
    console.log(`[MyRide]   Tenant: ${this.tenantId}`);
    if (this._busFilterLabel) {
      console.log(`[MyRide]   Bus filter: ${this._busFilterLabel}`);
    }

    await this.connection.start();
    console.log(
      `[MyRide] Connected! State: ${this.connection.state}`
    );
  }

  async stop() {
    if (this.connection) {
      await this.connection.stop();
      console.log("[MyRide] Disconnected.");
    }
  }

  get state() {
    return this.connection?.state || "Disconnected";
  }
}

module.exports = { MyRideSignalRClient };
