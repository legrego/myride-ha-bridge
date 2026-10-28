/**
 * Preloaded into a spawned bridge (node --require) by startup.test.js: answers
 * every Cognito InitiateAuth call as a wrong password would, and logs the auth
 * flow so the test can count sign-in attempts. Other requests pass through.
 */

"use strict";

const realFetch = globalThis.fetch;

globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith("https://cognito-idp.")) return realFetch(url, opts);
  const { AuthFlow } = JSON.parse(opts.body);
  console.log(`[fake-cognito] ${AuthFlow}`);
  return new Response(
    JSON.stringify({ __type: "NotAuthorizedException", message: "Incorrect username or password." }),
    { status: 400, headers: { "Content-Type": "application/x-amz-json-1.1" } }
  );
};
