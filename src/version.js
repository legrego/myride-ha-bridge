"use strict";

/**
 * version.js — Resolves the running build's version identifier.
 *
 * Resolution order (computed once at require time):
 *   commit:    GIT_COMMIT env (injected at Docker build time) → live
 *              `git rev-parse` (local dev checkouts) → "unknown".
 *   buildTime: BUILD_TIME env (ISO string, injected at build time) → null.
 *   version:   package.json "version".
 *
 * The deployed container is built without .git, so the env vars are the real
 * source in production; the git fallback keeps `npm start`/`npm run simulate`
 * meaningful locally.
 */

const { execSync } = require("child_process");
const pkg = require("../package.json");

// Treat the Dockerfile's default ARG value the same as unset.
function clean(val) {
  if (!val) return null;
  const trimmed = String(val).trim();
  if (!trimmed || trimmed === "unknown") return null;
  return trimmed;
}

function resolveCommit() {
  const fromEnv = clean(process.env.GIT_COMMIT);
  if (fromEnv) return fromEnv;
  try {
    return execSync("git rev-parse HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const commit = resolveCommit();
const commitShort = commit ? commit.slice(0, 7) : "unknown";

const version = {
  version: pkg.version,
  commit: commit || "unknown",
  commitShort,
  buildTime: clean(process.env.BUILD_TIME),
};

module.exports = { version };
