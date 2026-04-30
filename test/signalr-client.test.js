const { describe, it, beforeEach } = require("node:test");
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
});
