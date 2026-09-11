const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const pkg = require("../package.json");

// Load version.js fresh with a controlled environment so we can exercise both
// the injected-env path and the fallback path deterministically.
function loadVersion(env) {
  const versionPath = require.resolve("../src/version");
  delete require.cache[versionPath];
  const saved = {
    GIT_COMMIT: process.env.GIT_COMMIT,
    BUILD_TIME: process.env.BUILD_TIME,
  };
  if ("GIT_COMMIT" in env) process.env.GIT_COMMIT = env.GIT_COMMIT;
  else delete process.env.GIT_COMMIT;
  if ("BUILD_TIME" in env) process.env.BUILD_TIME = env.BUILD_TIME;
  else delete process.env.BUILD_TIME;
  try {
    delete require.cache[versionPath];
    return require("../src/version").version;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete require.cache[versionPath];
  }
}

describe("version", () => {
  it("reports the package.json version", () => {
    const v = loadVersion({});
    assert.equal(v.version, pkg.version);
  });

  it("uses GIT_COMMIT and BUILD_TIME when injected", () => {
    const commit = "abc1234def5678";
    const buildTime = "2026-09-11T12:00:00Z";
    const v = loadVersion({ GIT_COMMIT: commit, BUILD_TIME: buildTime });
    assert.equal(v.commit, commit);
    assert.equal(v.commitShort, "abc1234");
    assert.equal(v.buildTime, buildTime);
  });

  it("treats the 'unknown' ARG default as unset", () => {
    const v = loadVersion({ GIT_COMMIT: "unknown", BUILD_TIME: "unknown" });
    // With no env commit, it may fall back to a live git sha (in a checkout)
    // or "unknown" (in a bare container). Either way it must never be "unknown"
    // *and* also expose the default ARG string verbatim as buildTime.
    assert.equal(v.buildTime, null);
    assert.ok(typeof v.commit === "string" && v.commit.length > 0);
    assert.ok(typeof v.commitShort === "string" && v.commitShort.length > 0);
  });
});
