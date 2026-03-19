/**
 * CAPTURE-TOKENS — Browser Console Snippet
 *
 * HOW TO USE:
 * 1. Log in to https://myridek12.tylerapp.com in Chrome
 * 2. Open DevTools (F12) → Console tab
 * 3. Paste this entire script and press Enter
 * 4. Copy the MYRIDE_REFRESH_TOKEN value into your .env file
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

  // ─── Strategy 3: Scan all storage for Cognito JWTs ───
  const allStorage = [
    ...Array.from({ length: localStorage.length }, (_, i) => [localStorage.key(i), localStorage.getItem(localStorage.key(i))]),
    ...Array.from({ length: sessionStorage.length }, (_, i) => [sessionStorage.key(i), sessionStorage.getItem(sessionStorage.key(i))]),
  ];

  for (const [key, val] of allStorage) {
    if (isJwt(val)) {
      const payload = decodeJwt(val);
      if (payload && payload.client_id === CLIENT_ID && payload.token_use === "access") {
        results.accessToken = results.accessToken || val;
        results.tenantId = results.tenantId || (payload["cognito:groups"] || [])[0];
        console.log("  ✅ Found Cognito access token (JWT scan):", key);
      }
    }
  }

  // ─── Strategy 4: Intercept SignalR negotiate to capture a live token ───
  if (!results.accessToken) {
    console.log("  ⏳ No stored tokens found. Intercepting next network request...");
    console.log("  ⏳ Navigate to the Bus Location page to trigger a SignalR connection.");

    const originalFetch = window.fetch;
    await new Promise((resolve) => {
      window.fetch = function (...args) {
        const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
        if (url && url.includes("livevehiclehub")) {
          const urlObj = new URL(url);
          const token = urlObj.searchParams.get("access_token");
          const tenant = urlObj.searchParams.get("x-tenant-id");
          if (token) {
            results.accessToken = token;
            console.log("  ✅ Captured access token from SignalR negotiate!");
          }
          if (tenant) results.tenantId = tenant;
          window.fetch = originalFetch;
          resolve();
        }
        return originalFetch.apply(this, args);
      };

      const origXhr = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        if (url && url.includes("livevehiclehub")) {
          const urlObj = new URL(url, window.location.origin);
          const token = urlObj.searchParams.get("access_token");
          const tenant = urlObj.searchParams.get("x-tenant-id");
          if (token) results.accessToken = results.accessToken || token;
          if (tenant) results.tenantId = results.tenantId || tenant;
          XMLHttpRequest.prototype.open = origXhr;
          resolve();
        }
        return origXhr.call(this, method, url, ...rest);
      };

      setTimeout(() => {
        window.fetch = originalFetch;
        XMLHttpRequest.prototype.open = origXhr;
        resolve();
      }, 60000);
    });
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

  if (results.refreshToken) {
    console.log("%c✅ REFRESH TOKEN FOUND", "color: green; font-weight: bold;");
    console.log("Add this to your .env file:");
    console.log(`\nMYRIDE_REFRESH_TOKEN=${results.refreshToken}\n`);
    console.log("%cOr send it directly to your running bridge:", "font-weight: bold;");
    console.log(`\ncurl -X POST http://YOUR_BRIDGE_HOST:8099/token -d '${results.refreshToken}'\n`);
  } else {
    console.log("%c⚠️  No refresh token found in browser storage.", "color: orange; font-weight: bold;");
    console.log("Try the Network tab method described in the README.");
  }

  if (results.accessToken) {
    console.log("%c✅ ACCESS TOKEN FOUND", "color: green; font-weight: bold;");
    const payload = decodeJwt(results.accessToken);
    if (payload) {
      const exp = new Date(payload.exp * 1000);
      console.log(`  Expires: ${exp.toLocaleString()}`);
      console.log(`  Username: ${payload.username}`);
    }
    console.log(`\n# You can also use this directly (expires in ~60min):`);
    console.log(`MYRIDE_ACCESS_TOKEN=${results.accessToken}\n`);
  }

  if (results.tenantId) {
    console.log(`%c✅ TENANT ID: ${results.tenantId}`, "color: green;");
    console.log(`\nMYRIDE_TENANT_ID=${results.tenantId}\n`);
  }

  if (!results.refreshToken) {
    console.log("%c\n═══ Network Tab Method ═══", "font-size: 13px; font-weight: bold; color: #FF9800;");
    console.log("1. Open DevTools → Network tab → check 'Preserve log'");
    console.log("2. Log OUT of MyRide, then log back IN");
    console.log("3. In the Network filter, search for 'token'");
    console.log("4. Look for a response containing 'refresh_token'");
    console.log("5. Copy that value into your .env as MYRIDE_REFRESH_TOKEN");
  }

  return results;
})();
