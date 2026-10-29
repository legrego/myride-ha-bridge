const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { countBridgeEntities, COUNT_TEMPLATE } = require("../src/ha-entity-check");

function fakeFetch(status, body, calls = []) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return new Response(body, { status });
  };
}

describe("countBridgeEntities()", () => {
  it("posts the counting template to Core's API through the Supervisor", async () => {
    const calls = [];
    const n = await countBridgeEntities({ token: "tok", fetchImpl: fakeFetch(200, "37", calls) });
    assert.equal(n, 37);
    assert.equal(calls[0].url, "http://supervisor/core/api/template");
    assert.equal(calls[0].opts.method, "POST");
    assert.equal(calls[0].opts.headers.Authorization, "Bearer tok");
    assert.deepEqual(JSON.parse(calls[0].opts.body), { template: COUNT_TEMPLATE });
  });

  it("tolerates surrounding whitespace", async () => {
    assert.equal(await countBridgeEntities({ token: "t", fetchImpl: fakeFetch(200, "\n 3 \n") }), 3);
  });

  it("throws on an HTTP error (e.g. homeassistant_api not granted)", async () => {
    await assert.rejects(countBridgeEntities({ token: "t", fetchImpl: fakeFetch(403, "") }), /HTTP 403/);
  });

  it("throws when the answer isn't a count", async () => {
    await assert.rejects(countBridgeEntities({ token: "t", fetchImpl: fakeFetch(200, "UndefinedError") }), /unexpected count/);
  });

  it("matches device identifiers that start with myride_", () => {
    assert.match(COUNT_TEMPLATE, /integration_entities\('mqtt'\)/);
    assert.match(COUNT_TEMPLATE, /'match', 'myride_'/);
  });
});
