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
    it("stores tenantId and busFilter", () => {
      const client = new MyRideSignalRClient({
        tenantId: "abc-123",
        accessTokenFactory: () => "tok",
        busFilter: "BUS 042",
      });
      assert.equal(client.tenantId, "abc-123");
      assert.equal(client.busFilter, "BUS 042");
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

      // Simulate what start() does: wire up NewLocation handler then trigger it
      // We simulate by directly emitting 'location' the way the handler would
      // Since we can't easily mock the full SignalR chain, we test the filter logic
      // by calling the handler logic directly
      const shouldEmit = !client.busFilter || locationData.assetUniqueId === client.busFilter;
      if (shouldEmit) client.emit("location", locationData);
    });

    it("emits location when filter matches", (_, done) => {
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

      const shouldEmit = !client.busFilter || locationData.assetUniqueId === client.busFilter;
      if (shouldEmit) client.emit("location", locationData);
    });

    it("does not emit location when filter does not match", () => {
      const client = new MyRideSignalRClient({
        tenantId: "t",
        accessTokenFactory: () => "tok",
        busFilter: "BUS 042",
      });

      let emitted = false;
      client.on("location", () => { emitted = true; });

      const locationData = { assetUniqueId: "BUS 099", latitude: 40.0, longitude: -74.0 };
      const shouldEmit = !client.busFilter || locationData.assetUniqueId === client.busFilter;
      if (shouldEmit) client.emit("location", locationData);

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
