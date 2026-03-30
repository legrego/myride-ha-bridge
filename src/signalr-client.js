/**
 * signalr-client.js — Connect to the MyRide K-12 LiveVehicleHub.
 *
 * Discovered from HAR capture:
 *   - Hub URL:     https://myridek12.tylerapi.com/livevehiclehub
 *   - Negotiate:   POST /livevehiclehub/negotiate?x-tenant-id=...&negotiateVersion=1
 *   - WebSocket:   wss://myridek12.tylerapi.com/livevehiclehub?x-tenant-id=...&id=...&access_token=...
 *   - Protocol:    SignalR JSON v1
 *   - Event:       "NewLocation" — pushed automatically, no subscription invoke needed
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

class MyRideSignalRClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.tenantId   — district tenant UUID (from cognito:groups)
   * @param {function} opts.accessTokenFactory — async/sync fn returning current access token
   * @param {string} [opts.busFilter] — optional bus ID to filter (e.g. "BUS 042")
   * @param {string} [opts.logLevel] — "debug" | "info" | "warn" | "error"
   */
  constructor({ tenantId, accessTokenFactory, busFilter, logLevel = "info" }) {
    super();
    this.tenantId = tenantId;
    this.accessTokenFactory = accessTokenFactory;
    this.busFilter = busFilter;
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
   * Connect to the LiveVehicleHub and start receiving NewLocation events.
   */
  async start() {
    const hubUrl = `${HUB_BASE_URL}?x-tenant-id=${this.tenantId}`;

    this.connection = new signalR.HubConnectionBuilder()
      .withUrl(hubUrl, {
        skipNegotiation: true,

        accessTokenFactory: this.accessTokenFactory,
        // Force WebSocket transport for lowest latency
        transport: signalR.HttpTransportType.WebSockets,
        // Required for Node.js — provide the ws WebSocket implementation
        WebSocket: require("ws"),
      })
      // No withAutomaticReconnect() — it reuses the existing HubConnection object,
      // which with skipNegotiation produces a zombie connection that appears Connected
      // but receives no events. Instead, we let onclose fire immediately and rely on
      // the rebuild loop in index.js, which creates a fresh HubConnection each time.
      .configureLogging(this.logLevel)
      .build();

    // Handle the main location event
    this.connection.on("NewLocation", (locationData) => {
      // Filter by bus if configured
      if (
        this.busFilter &&
        locationData.assetUniqueId !== this.busFilter
      ) {
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
    if (this.busFilter) {
      console.log(`[MyRide]   Bus filter: ${this.busFilter}`);
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
