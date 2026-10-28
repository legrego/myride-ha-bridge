# Spike: getting MyRide credentials without DevTools

**Date:** 2026-10-28
**Question:** Can users connect the bridge without pasting a script into the browser console to pull a refresh token out of `sessionStorage`?

## What we know about MyRide auth

Facts from public endpoints (probed 2026-10-28):

- The user pool `us-east-1_sfRczsC0e` has a **Cognito managed-login domain**. Its discovery document (`https://cognito-idp.us-east-1.amazonaws.com/us-east-1_sfRczsC0e/.well-known/openid-configuration`) lists:
  - `authorization_endpoint`: `https://login.myridek12.tylerapp.com/oauth2/authorize`
  - `token_endpoint`: `https://login.myridek12.tylerapp.com/oauth2/token`
  - `response_types_supported`: `code`, `token`
- We sent `InitiateAuth` to client `3c5382gsq7g13djnejo98p2d98` with a made-up username. Cognito checks whether a flow is enabled before it looks up the user, so the error shows which flows are on:

  | AuthFlow | Response | Meaning |
  |---|---|---|
  | `USER_PASSWORD_AUTH` | `NotAuthorizedException: Incorrect username or password.` | **Enabled** |
  | `USER_SRP_AUTH` | `USER_SRP_AUTH is not enabled for the client.` | Disabled |
  | `CUSTOM_AUTH` | `CUSTOM_AUTH is not enabled for the client.` | Disabled |
  | `USER_AUTH` (passwordless/OTP) | `USER_AUTH flow not enabled for this client` | Disabled |
  | `REFRESH_TOKEN_AUTH` | (what the bridge uses today) | Enabled |

  This contradicts the README and the `cognito-auth.js` header, which say `USER_PASSWORD_AUTH` is disabled. A likely reason it is on: the Ride360 → MyRide migration. Ride360 users could sign in with their old passwords, and a Cognito user-migration trigger needs `USER_PASSWORD_AUTH`.

Inference, not verified because `*.tylerapp.com` was unreachable from the spike environment:

- The web app's `oidc.user…` sessionStorage key is what `oidc-client-ts` writes. The likely sequence:
  1. The SPA runs an authorization-code + PKCE flow against Cognito's `/oauth2/authorize`.
  2. Cognito federates to Tyler's IdentityServer (`myridek12.tylerapp.com/login/core/connect/authorize`), which hosts the login form.
  3. Back on the SPA callback, the SPA exchanges the code at Cognito's `/oauth2/token`.

  That explains why the refresh token works with plain Cognito `REFRESH_TOKEN_AUTH`.
- If accounts are **federated** (their Cognito user comes from Tyler's IdP), they have no Cognito password. In that case `USER_PASSWORD_AUTH` fails for real users even though the flow is enabled. That may be what the original "disabled" finding actually saw.

### Decisive test (2 minutes, needs a real account)

```bash
printf "MyRide email: "; read -r U
printf "Password: "; stty -echo; read -r P; stty echo; echo
curl -sS https://cognito-idp.us-east-1.amazonaws.com/ \
  -H 'Content-Type: application/x-amz-json-1.1' \
  -H 'X-Amz-Target: AWSCognitoIdentityProviderService.InitiateAuth' \
  -d "$(jq -n --arg u "$U" --arg p "$P" '{AuthFlow:"USER_PASSWORD_AUTH",ClientId:"3c5382gsq7g13djnejo98p2d98",AuthParameters:{USERNAME:$u,PASSWORD:$p}}')" \
  | jq '{type: .__type, message, challenge: .ChallengeName, hasRefresh: (.AuthenticationResult.RefreshToken != null)}'
```

- `hasRefresh: true` → Option A works.
- `NotAuthorizedException` with credentials that are definitely correct → the account is federated. Go to Option B.
- `ChallengeName` (for example `NEW_PASSWORD_REQUIRED` or an MFA challenge) → Option A works but needs challenge handling. Without that, users with a challenge fall back to B or C.

You can also check the decoded access token for a `cognito:groups` entry named `us-east-1_sfRczsC0e_<Provider>`. Cognito adds every federated user to such a group automatically.

## Options, ranked

### A. Email + password, direct to Cognito (best, if the test passes)

The add-on gets `myride_email` and `myride_password` options (`password` schema type). `CognitoAuth.login()` calls `InitiateAuth` with `USER_PASSWORD_AUTH` and gets an access token, an ID token and a refresh token. The bridge keeps refreshing as it does today. When the refresh token expires, it **logs in again by itself** instead of going idle.

- **User effort:** type email and password once. No DevTools, and no 30-day re-capture.
- **Code:** small. One new method beside `refresh()` (same plain `fetch`, no SDK). `handleTokenExpired()` tries `login()` before going idle. Add option plumbing in `addon-config.js` and a `MYRIDE_EMAIL`/`MYRIDE_PASSWORD` env pair.
- **Risks:**
  - Tyler can turn the flow off at any time (especially if it exists only for migration). Keep the token form as the fallback, and set the credentials binary sensor when login fails.
  - The password sits in `/data/options.json`. The MQTT password already does, and the refresh token already grants full account access. The new exposure is password reuse elsewhere, so the docs should say so.
  - MFA or challenge users need handling or a fallback.
  - Too many failed logins can lock the account. Never retry a failed `login()` in a loop: on `NotAuthorizedException`, go idle.

### B. "Sign in with MyRide", then paste the redirect URL (no DevTools, still manual)

The bridge UI creates its own PKCE `code_verifier`/`state` and opens Cognito's `/oauth2/authorize`. It uses the web app's `client_id` and its **registered** `redirect_uri`, plus whatever `identity_provider` parameter the SPA sends. The user signs in on the normal Tyler page and lands back on myridek12.tylerapp.com with `?code=…&state=…`. The SPA cannot find a matching state, so it does not redeem the code. The user copies the address bar URL into the bridge. The bridge then redeems the code at `/oauth2/token` with its verifier and gets the refresh token. Cognito codes are single-use and valid for about 5 minutes.

- **User effort:** one click, a normal login, and one URL paste. This is the same pattern many Home Assistant cloud integrations use. It works on desktop and phone browsers, and with federated accounts.
- **Needs first (one HAR capture of a real login):**
  - The SPA's exact authorize URL: `redirect_uri`, `scope`, `identity_provider`/`idp_identifier`, and how the district is chosen.
  - Whether the SPA wipes the callback URL (`history.replaceState`) before the user can copy it. If it does, look for a less aggressive registered redirect (a silent-renew page, for example).
- **Risks:**
  - Breaks if Tyler changes its registered redirect URIs.
  - The refresh token still expires about every 30 days, so the user repeats the flow. It is easier each time, though.

### C. Bookmarklet with a `postMessage` handoff (quick win, independent of auth internals)

Instead of a console paste, the status page shows a **"drag to bookmarks bar"** link. The user clicks it while on MyRide. It reads the `oidc.user…` entry (same logic as `capture-tokens.js`) and hands it to the bridge:

- **Full handoff:**
  1. The bookmarklet opens the bridge UI (its URL is baked in when the status page renders the link).
  2. The bridge page sees `window.top.opener` and posts `ready` to `https://myridek12.tylerapp.com`.
  3. The bookmarklet answers with the token via `event.source.postMessage(token, event.origin)`.
  4. The bridge accepts it only when `event.origin === 'https://myridek12.tylerapp.com'`, then calls the existing relative `POST token`.
- **Simpler fallback:** the bookmarklet copies the token to the clipboard and shows "Copied — paste it on the status page."
- **Risks:**
  - Desktop only; bookmarklets are impractical on phones.
  - Opening the ingress URL standalone needs a live ingress session cookie.
  - A `Cross-Origin-Opener-Policy` header on either side would cut `opener`. This needs a prototype; the clipboard fallback avoids all of it.
- **Worth shipping regardless.** It is small, and it stays the fallback for A and B.

### Not recommended

- **Headless Chromium (Playwright) login:** adds hundreds of MB to a multi-arch add-on image, breaks on every login-page change, and invites bot detection.
- **Scripted HTTP login against Tyler's IdentityServer form** (antiforgery token, cookies, redirects): only worth it if A fails *and* users strongly want full automation. It is brittle and closer to scraping than to using an API.
- **Device code grant:** Cognito does not support it.
- **Browser extension:** more install friction than the bookmarklet, for the same result.

## Recommendation

1. Run the decisive test above with a real account.
2. If it passes, build **A**, with the token form (and **C**) as the fallback.
3. If it fails because accounts are federated, capture one HAR of the web login and build **B**, plus **C** for desktop users.
4. Either way, fix the README and the `cognito-auth.js` header. "SRP disabled" is right; "USER_PASSWORD_AUTH disabled" is not, at the client level.

Side note for whichever option ships: Cognito now offers refresh-token rotation (`GetTokensFromRefreshToken`, which the pool already answers). If Tyler enables rotation, `REFRESH_TOKEN_AUTH` stops working and the bridge would have to persist each new refresh token. Watch for it, but there is nothing to do now.
