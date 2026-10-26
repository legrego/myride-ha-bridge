/**
 * CAPTURE-TOKENS — Browser Console Snippet
 *
 * HOW TO USE:
 * 1. Log in to https://myridek12.tylerapp.com in Chrome
 * 2. Open DevTools (F12) → Console tab
 * 3. Paste this entire script and press Enter
 * 4. Copy the Tenant ID and Refresh token into the app's Configuration tab
 *    (or MYRIDE_TENANT_ID / MYRIDE_REFRESH_TOKEN in .env outside the app)
 *
 * The refresh token is stored in sessionStorage under a key starting with
 * "oidc.user". The value is JSON containing a "refresh_token" property.
 */

(async function captureMyRideTokens() {
  const CLIENT_ID = "3c5382gsq7g13djnejo98p2d98";
  const results = { accessToken: null, refreshToken: null, idToken: null, tenantId: null };

  console.log("%c🔍 Searching for MyRide K-12 Cognito tokens...", "font-size: 14px; font-weight: bold;");

  function isJwt(str) {
    return typeof str === "string" && str.split(".").length === 3 && str.length > 100;
  }

  function decodeJwt(token) {
    try {
      return JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    } catch { return null; }
  }

  // ─── Strategy 1: oidc.user key in sessionStorage (primary) ───
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (!key.startsWith("oidc.user")) continue;

    try {
      const parsed = JSON.parse(sessionStorage.getItem(key));
      if (parsed.refresh_token) {
        results.refreshToken = parsed.refresh_token;
        console.log("  ✅ Found refresh token in sessionStorage:", key);
      }
      if (parsed.access_token) {
        results.accessToken = results.accessToken || parsed.access_token;
        console.log("  ✅ Found access token in sessionStorage:", key);
      }
      if (parsed.id_token) {
        results.idToken = results.idToken || parsed.id_token;
      }
    } catch { /* not JSON, skip */ }
  }

  // ─── Strategy 2: localStorage (Cognito JS SDK default storage) ───
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    const val = localStorage.getItem(key);

    if (!results.refreshToken && (key.includes("refreshToken") || key.includes("RefreshToken"))) {
      results.refreshToken = val;
      console.log("  ✅ Found refresh token in localStorage:", key);
    }
    if (!results.accessToken && (key.includes("accessToken") || key.includes("AccessToken"))) {
      results.accessToken = val;
      console.log("  ✅ Found access token in localStorage:", key);
    }
    if (!results.idToken && (key.includes("idToken") || key.includes("IdToken"))) {
      results.idToken = val;
      console.log("  ✅ Found ID token in localStorage:", key);
    }
  }

  // ─── Extract tenant ID from access token ───
  if (results.accessToken && !results.tenantId) {
    const payload = decodeJwt(results.accessToken);
    if (payload) {
      results.tenantId = (payload["cognito:groups"] || [])[0];
    }
  }

  // ─── Output results ───
  console.log("\n%c═══ MyRide K-12 Token Capture Results ═══", "font-size: 14px; font-weight: bold; color: #2196F3;");

  if (results.tenantId) {
    console.log("%c✅ TENANT ID", "color: green; font-weight: bold;");
    console.log(`\n${results.tenantId}\n`);
  }

  if (results.refreshToken) {
    console.log("%c✅ REFRESH TOKEN", "color: green; font-weight: bold;");
    console.log(`\n${results.refreshToken}\n`);
    console.log("Paste both into the app's Configuration tab. To replace an expired token,");
    console.log("paste the refresh token on the bridge's status page instead.");
  } else {
    console.log("%c⚠️  No refresh token found in browser storage.", "color: orange; font-weight: bold;");
    console.log("Try the Network tab method below.");
  }

  console.log("\n%cNot using the Home Assistant app? Put these in your .env file:", "font-weight: bold;");
  if (results.tenantId) console.log(`\nMYRIDE_TENANT_ID=${results.tenantId}`);
  if (results.refreshToken) {
    console.log(`\nMYRIDE_REFRESH_TOKEN=${results.refreshToken}\n`);
    console.log("Or send a new token to a running bridge:");
    console.log(`\ncurl -X POST http://YOUR_BRIDGE_HOST:8099/token -d '${results.refreshToken}'\n`);
  } else if (results.accessToken) {
    const payload = decodeJwt(results.accessToken);
    const exp = payload ? ` (expires ${new Date(payload.exp * 1000).toLocaleString()})` : "";
    console.log(`\n# Short-lived fallback${exp}:`);
    console.log(`MYRIDE_ACCESS_TOKEN=${results.accessToken}\n`);
  }

  if (!results.refreshToken) {
    console.log("%c\n═══ Network Tab Method ═══", "font-size: 13px; font-weight: bold; color: #FF9800;");
    console.log("1. Open DevTools → Network tab → check 'Preserve log'");
    console.log("2. Log OUT of MyRide, then log back IN");
    console.log("3. In the Network filter, search for 'token'");
    console.log("4. Look for a response containing 'refresh_token'");
    console.log("5. Copy that value; it's your refresh token");
  }

  return results;
})();
