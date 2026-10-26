const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const signalR = require("@microsoft/signalr");
const { MyRideSignalRClient } = require("../src/signalr-client");

describe("MyRideSignalRClient", () => {
  describe("_parseLogLevel()", () => {
    let client;
    beforeEach(() => {
      client = new MyRideSignalRClient({
        tenantId: "test-tenant",
        accessTokenFactory: () => "token",
      });
    });

    it("maps 'debug' to Debug", () => {
      assert.equal(client._parseLogLevel("debug"), signalR.LogLevel.Debug);
    });

    it("maps 'info' to Information", () => {
      assert.equal(client._parseLogLevel("info"), signalR.LogLevel.Information);
    });

    it("maps 'warn' to Warning", () => {
      assert.equal(client._parseLogLevel("warn"), signalR.LogLevel.Warning);
    });

    it("maps 'error' to Error", () => {
      assert.equal(client._parseLogLevel("error"), signalR.LogLevel.Error);
    });

    it("defaults to Information for unknown levels", () => {
      assert.equal(client._parseLogLevel("verbose"), signalR.LogLevel.Information);
      assert.equal(client._parseLogLevel(""), signalR.LogLevel.Information);
    });
  });

  describe("state getter", () => {
    it("returns 'Disconnected' when connection is null", () => {
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
      });
      assert.equal(client.state, "Disconnected");
    });

    it("returns connection.state when connection exists", () => {
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
      });
      client.connection = { state: "Connected" };
      assert.equal(client.state, "Connected");
    });
  });

  describe("constructor", () => {
    it("stores tenantId", () => {
      const client = new MyRideSignalRClient({
        tenantId: "abc-123",
        accessTokenFactory: () => "tok",
        busFilter: "BUS 042",
      });
      assert.equal(client.tenantId, "abc-123");
    });

    it("wraps string busFilter as an exact-match predicate", () => {
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
        busFilter: "BUS 042",
      });
      assert.equal(typeof client.busFilter, "function");
      assert.equal(client.busFilter("BUS 042"), true);
      assert.equal(client.busFilter("BUS 099"), false);
    });

    it("accepts a predicate function directly", () => {
      const pred = (id) => id.startsWith("BUS 0");
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
        busFilter: pred,
      });
      assert.equal(typeof client.busFilter, "function");
      assert.equal(client.busFilter("BUS 042"), true);
      assert.equal(client.busFilter("MINIBUS 1"), false);
    });

    it("sets busFilter to null when no filter provided", () => {
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
      });
      assert.equal(client.busFilter, null);
    });

    it("defaults logLevel to Information", () => {
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
      });
      assert.equal(client.logLevel, signalR.LogLevel.Information);
    });

    it("is an EventEmitter", () => {
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
      });
      assert.equal(typeof client.on, "function");
      assert.equal(typeof client.emit, "function");
    });
  });

  describe("bus filter logic", () => {
    function applyFilter(client, locationData) {
      if (client.busFilter && !client.busFilter(locationData.assetUniqueId)) return false;
      return true;
    }

    it("emits location when no filter is set", (_, done) => {
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
      });

      const locationData = { assetUniqueId: "BUS 042", latitude: 40.0, longitude: -74.0 };
      client.on("location", (data) => {
        assert.deepEqual(data, locationData);
        done();
      });

      if (applyFilter(client, locationData)) client.emit("location", locationData);
    });

    it("emits location when string filter matches", (_, done) => {
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
        busFilter: "BUS 042",
      });

      const locationData = { assetUniqueId: "BUS 042", latitude: 40.0, longitude: -74.0 };
      client.on("location", (data) => {
        assert.deepEqual(data, locationData);
        done();
      });

      if (applyFilter(client, locationData)) client.emit("location", locationData);
    });

    it("does not emit location when string filter does not match", () => {
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
        busFilter: "BUS 042",
      });

      let emitted = false;
      client.on("location", () => { emitted = true; });

      const locationData = { assetUniqueId: "BUS 099", latitude: 40.0, longitude: -74.0 };
      if (applyFilter(client, locationData)) client.emit("location", locationData);

      assert.equal(emitted, false);
    });

    it("emits location when predicate function returns true", (_, done) => {
      const allowedSet = new Set(["BUS 042", "BUS 057"]);
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
        busFilter: (id) => allowedSet.has(id),
      });

      const locationData = { assetUniqueId: "BUS 057", latitude: 40.0, longitude: -74.0 };
      client.on("location", (data) => {
        assert.deepEqual(data, locationData);
        done();
      });

      if (applyFilter(client, locationData)) client.emit("location", locationData);
    });

    it("does not emit location when predicate function returns false", () => {
      const allowedSet = new Set(["BUS 042", "BUS 057"]);
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
        busFilter: (id) => allowedSet.has(id),
      });

      let emitted = false;
      client.on("location", () => { emitted = true; });

      const locationData = { assetUniqueId: "BUS 099" };
      if (applyFilter(client, locationData)) client.emit("location", locationData);

      assert.equal(emitted, false);
    });
  });

  describe("_connectionOptions()", () => {
    it("does NOT skip negotiation (negotiate activates the bus relay)", () => {
      const client = new MyRideSignalRClient({
        tenantId: "tenant-1",
        accessTokenFactory: () => "tok",
      });
      const opts = client._connectionOptions();
      assert.notEqual(opts.skipNegotiation, true);
    });

    it("forces the WebSocket transport", () => {
      const client = new MyRideSignalRClient({
        tenantId: "tenant-1",
        accessTokenFactory: () => "tok",
      });
      const opts = client._connectionOptions();
      assert.equal(opts.transport, signalR.HttpTransportType.WebSockets);
    });

    it("passes the access token factory through", () => {
      const factory = () => "tok";
      const client = new MyRideSignalRClient({
        tenantId: "tenant-1",
        accessTokenFactory: factory,
      });
      assert.equal(client._connectionOptions().accessTokenFactory, factory);
    });

    it("sends browser-like headers including the tenant id on negotiate", () => {
      const client = new MyRideSignalRClient({
        tenantId: "tenant-abc",
        accessTokenFactory: () => "tok",
      });
      const { headers } = client._connectionOptions();
      assert.equal(headers["x-tenant-id"], "tenant-abc");
      assert.equal(headers["x-device-type"], "browser");
      assert.ok(headers["User-Agent"]);
    });
  });

  describe("stop()", () => {
    it("does nothing when connection is null", async () => {
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
      });
      // Should not throw
      await client.stop();
    });

    it("calls connection.stop() when connected", async () => {
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
      });
      let stopCalled = false;
      client.connection = {
        stop: async () => { stopCalled = true; },
      };
      await client.stop();
      assert.equal(stopCalled, true);
    });
  });

  describe("with a fake HubConnection (hubConnectionFactory)", () => {
    // Minimal stand-in for @microsoft/signalr's HubConnection.
    function fakeConnection(id) {
      const conn = {
        connectionId: id,
        state: "Disconnected",
        handlers: {},
        closeCallbacks: [],
        stopCalls: 0,
        on(method, fn) { this.handlers[method] = fn; },
        onclose(fn) { this.closeCallbacks.push(fn); },
        async start() { this.state = "Connected"; },
        async stop() {
          this.stopCalls++;
          this.state = "Disconnected";
          this.serverClose(); // the real library fires onclose on stop()
        },
        // Fire onclose as the library does when the socket closes.
        serverClose(error) { for (const cb of this.closeCallbacks) cb(error); },
        invoke(method, ...args) { this.handlers[method](...args); },
      };
      return conn;
    }

    function makeClient(opts = {}) {
      const conns = [];
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
        hubConnectionFactory: () => {
          const c = fakeConnection(`conn-${conns.length + 1}`);
          conns.push(c);
          return c;
        },
        ...opts,
      });
      return { client, conns };
    }

    // Keep the client's own console lines out of the test output.
    let restoreLog;
    beforeEach(() => {
      const { log, warn } = console;
      console.log = () => {};
      console.warn = () => {};
      restoreLog = () => { console.log = log; console.warn = warn; };
    });
    afterEach(() => restoreLog());

    it("emits serverError for errorcode and error invocations", async () => {
      const { client, conns } = makeClient();
      const seen = [];
      client.on("serverError", (e) => seen.push(e));
      await client.start();
      conns[0].invoke("errorcode", 42, "no runs");
      conns[0].invoke("error", { message: "nope" });
      assert.deepEqual(seen, [
        { method: "errorcode", args: [42, "no runs"] },
        { method: "error", args: [{ message: "nope" }] },
      ]);
    });

    it("emits frame for a filtered-out bus but not location", async () => {
      const { client, conns } = makeClient({ busFilter: "BUS 042" });
      const frames = [];
      const locations = [];
      client.on("frame", (d) => frames.push(d.assetUniqueId));
      client.on("location", (d) => locations.push(d.assetUniqueId));
      await client.start();
      conns[0].invoke("NewLocation", { assetUniqueId: "BUS 099" });
      conns[0].invoke("NewLocation", { assetUniqueId: "BUS 042" });
      assert.deepEqual(frames, ["BUS 099", "BUS 042"]);
      assert.deepEqual(locations, ["BUS 042"]);
    });

    it("does not emit closed on stop() or restart()", async () => {
      const { client, conns } = makeClient();
      let closed = 0;
      client.on("closed", () => closed++);
      await client.start();
      await client.restart();
      assert.equal(conns.length, 2);
      assert.equal(conns[0].stopCalls, 1);
      assert.equal(client.connectionId, "conn-2");
      await client.stop();
      assert.equal(closed, 0);
    });

    it("emits closed for a server-side close of the current connection", async () => {
      const { client, conns } = makeClient();
      const errors = [];
      client.on("closed", (e) => errors.push(e));
      await client.start();
      const err = new Error("WebSocket closed with status code: 1006");
      conns[0].serverClose(err);
      assert.deepEqual(errors, [err]);
    });

    it("ignores a late onclose from a superseded connection", async () => {
      const { client, conns } = makeClient();
      let closed = 0;
      client.on("closed", () => closed++);
      await client.start();
      await client.restart();
      conns[0].serverClose(new Error("late")); // e.g. delayed socket teardown
      assert.equal(closed, 0);
      conns[1].serverClose(new Error("1006"));
      assert.equal(closed, 1);
    });

    it("restart() still starts a fresh connection when stopping the old one fails", async () => {
      const { client, conns } = makeClient();
      await client.start();
      conns[0].stop = async () => { throw new Error("already gone"); };
      await client.restart();
      assert.equal(conns.length, 2);
      assert.equal(client.state, "Connected");
    });
  });
});
