# MyRide K-12 → Home Assistant MQTT Bridge

Real-time school bus tracking from Tyler Technologies' MyRide K-12 platform, piped
directly into Home Assistant via MQTT. No more opening that app just to see
where the bus is.

## What This Does

Connects to the same live GPS feed that powers the MyRide K-12 web app and mobile
app, then publishes bus location data to your MQTT broker. Home Assistant
auto-discovers the entities and gives you:

| Entity | Type | Description |
|--------|------|-------------|
| `device_tracker.myride_bus_042` | Device Tracker | Map pin with lat/lng |
| `sensor.myride_bus_042_speed` | Sensor | Speed in mph |
| `sensor.myride_bus_042_heading` | Sensor | Compass heading (degrees) |
| `binary_sensor.myride_bus_042_moving` | Binary Sensor | Is the bus in motion? |
| `binary_sensor.myride_bridge_credentials` | Binary Sensor | Credential problem alert (ON = expired) |

## How It Works

```
┌────────────-───────────┐
│  myridek12.tylerapp    │  ← You log in here once in a browser
│  (Tyler IdentityServer)│    to capture your Cognito refresh token
└───────────┬───────-────┘
            │ refresh_token (saved in .env)
            ▼
┌─────────────────┐   REFRESH_TOKEN_AUTH   ┌───────────────────────┐
│  cognito-auth   │────────────────-─────▶ │  AWS Cognito          │
│                 │◀── access_token ─-──── │  us-east-1_sfRczsC0e  │
└────────┬────────┘   (auto every 50 min)  └───────────────────────┘
         │
         │ access_token
         ▼
┌─────────────────┐    SignalR/WebSocket    ┌───────────────────────┐
│  signalr-client │◀════════════════════▶   │  LiveVehicleHub       │
│                 │   NewLocation events    │  myridek12.tylerapi   │
└────────┬────────┘    (every ~15-30s)      └───────────────────────┘
         │
         │ location data
         ▼
┌─────────────────┐      MQTT + Discovery   ┌───────────────────────┐
│  mqtt-bridge    │─────────-─────────────▶ │  Home Assistant       │
│                 │                         │  Mosquitto add-on     │
└─────────────────┘                         └───────────────────────┘

┌─────────────────┐
│  api-server     │  ← POST /token to update credentials at runtime
│  (port 8099)    │  ← GET  /status for health check
└─────────────────┘
```

### Why Not Just Use Email/Password?

Tyler Technologies doesn't allow direct Cognito authentication (SRP and
USER_PASSWORD_AUTH are both disabled on their Cognito client). Login goes through
Tyler's own IdentityServer at `myridek12.tylerapp.com/login/core/connect/authorize`,
which handles the web login form and issues Cognito tokens server-side.

The workaround: capture your Cognito **refresh token** once from the browser, then
this bridge uses Cognito's `REFRESH_TOKEN_AUTH` flow to get fresh access tokens
automatically. Refresh tokens last ~30 days, so you only need to re-capture
occasionally.

## Setup

### Prerequisites

- Node.js 22+
- An MQTT broker (the Mosquitto add-on in Home Assistant works great)
- A MyRide K-12 account (same email/password you use on myridek12.tylerapp.com)

### 1. Install

```bash
cd myride-ha-bridge
npm install
```

### 2. Capture Your Refresh Token

This is the one-time bootstrap step:

1. Open **Chrome** and log in to [myridek12.tylerapp.com](https://myridek12.tylerapp.com)
2. Open **DevTools** (F12) → **Console** tab
3. Copy the contents of `capture-tokens.js` and paste into the console
4. Press **Enter**

The script looks for Cognito tokens in sessionStorage (under a key starting with
`oidc.user`) and prints them. You should see output like:

```
🔍 Searching for MyRide K-12 Cognito tokens...
  ✅ Found refresh token in sessionStorage: oidc.user:https://...

═══ MyRide K-12 Token Capture Results ═══
✅ REFRESH TOKEN FOUND
Add this to your .env file:

MYRIDE_REFRESH_TOKEN=eyJjdHk...very_long_string...
```

**If the script doesn't find a refresh token**, use the Network tab method:

1. In DevTools → **Network** tab, check **"Preserve log"**
2. **Log out** of MyRide, then **log back in**
3. In the Network filter, search for `token`
4. Look through responses for one containing `refresh_token`
5. Copy that value

**Last resort — direct access token**: If you can't get a refresh token, grab the
access token from any SignalR WebSocket URL in the Network tab (it's the
`access_token=` query parameter). This works but expires in 60 minutes.

### 3. Configure

```bash
cp .env.example .env
```

Edit `.env`:

```env
# Paste your captured refresh token here
MYRIDE_REFRESH_TOKEN=eyJjdHk...

# Your district tenant ID (from capture-tokens.js output)
MYRIDE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

# Your Home Assistant MQTT broker
MQTT_BROKER=homeassistant.local
MQTT_PORT=1883
MQTT_USERNAME=mqtt_user
MQTT_PASSWORD=mqtt_password

# Only track your kid's bus
BUS_FILTER=BUS 042
```

### 4. Run

```bash
node index.js
```

Expected output:
```
╔══════════════════════════════════════════════════╗
║     MyRide K-12 → Home Assistant MQTT Bridge    ║
╚══════════════════════════════════════════════════╝

[Auth] Mode: refresh token (auto-renewing)
[Auth] Refreshing access token via Cognito...
[Auth] Token refreshed, expires at 3:38:09 PM
[MQTT] Connected to broker
[MyRide] Connecting to LiveVehicleHub...
[MyRide]   Tenant: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
[MyRide]   Bus filter: BUS 042
[MyRide] Connected! State: Connected
[MQTT] Published HA discovery for BUS 042
[Bus] BUS 042 @ 40.6892,-74.0445 speed=26mph
```

### 5. Run as a Service

**systemd** — create `/etc/systemd/system/myride-bridge.service`:

```ini
[Unit]
Description=MyRide K-12 MQTT Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=homeassistant
WorkingDirectory=/opt/myride-ha-bridge
ExecStart=/usr/bin/node index.js
Restart=always
RestartSec=30
EnvironmentFile=/opt/myride-ha-bridge/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now myride-bridge
sudo journalctl -u myride-bridge -f
```

**Docker:**

```dockerfile
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY *.js ./
CMD ["node", "index.js"]
```

```bash
docker build -t myride-bridge .
docker run -d --name myride-bridge --restart unless-stopped \
  --env-file .env \
  -v myride_data:/data \
  -p 8099:8099 \
  myride-bridge
```

The `/data` volume persists your refresh token across container recreates. Port
`8099` exposes the API server so you can update your token without restarting.

## Home Assistant Automations

### "Bus is nearby" — push notification

```yaml
automation:
  - alias: "School Bus Approaching"
    trigger:
      - platform: state
        entity_id: binary_sensor.myride_bus_042_moving
        to: "on"
    condition:
      - condition: template
        value_template: >
          {% set bus_lat = state_attr('device_tracker.myride_bus_042', 'latitude') %}
          {% set bus_lng = state_attr('device_tracker.myride_bus_042', 'longitude') %}
          {{ distance(bus_lat, bus_lng, 'zone.home') | float < 1.5 }}
    action:
      - service: notify.mobile_app_your_phone
        data:
          title: "🚌 Bus Approaching!"
          message: >
            Bus is nearby at {{ states('sensor.myride_bus_042_speed') }} mph.
          data:
            ttl: 0
            priority: high
```

### "Bus has departed school" — afternoon get-ready routine

```yaml
automation:
  - alias: "Bus Left School - Get Ready"
    trigger:
      - platform: state
        entity_id: binary_sensor.myride_bus_042_moving
        from: "off"
        to: "on"
    condition:
      - condition: time
        after: "14:00:00"
        before: "16:30:00"
        weekday: [mon, tue, wed, thu, fri]
    action:
      - service: notify.mobile_app_your_phone
        data:
          title: "🏫 Bus is rolling!"
          message: "The school bus just started moving. Time to head to the stop!"
```

### Live bus map dashboard card

```yaml
type: map
entities:
  - entity: device_tracker.myride_bus_042
    name: School Bus
  - entity: zone.home
default_zoom: 14
hours_to_show: 0
```

### "Token expired" — push notification to re-authenticate

```yaml
automation:
  - alias: "MyRide Token Expired"
    trigger:
      - platform: state
        entity_id: binary_sensor.myride_bridge_credentials
        to: "on"
    action:
      - service: notify.mobile_app_your_phone
        data:
          title: "MyRide Bridge: Token Expired"
          message: >
            Your MyRide refresh token has expired. Re-run capture-tokens.js
            in the browser and POST the new token to the bridge.
```

## Token Lifecycle

| Token | Lifetime | Auto-renewed? |
|-------|----------|---------------|
| Access token | 60 minutes | Yes, via refresh token |
| Refresh token | ~30 days (Cognito default) | No — re-capture from browser |

The bridge refreshes the access token every 50 minutes automatically. When the
refresh token itself expires (~30 days), the bridge **does not crash**. Instead it:

1. Logs a prominent error banner to the console
2. Stops the SignalR data stream
3. Sets `binary_sensor.myride_bridge_credentials` to **ON** (problem) in Home Assistant
4. Keeps MQTT and the API server running so you can recover without restarting

### Updating an Expired Token

**Option A — `curl` (fastest, no restart needed):**

```bash
curl -X POST http://YOUR_BRIDGE_HOST:8099/token -d 'PASTE_NEW_REFRESH_TOKEN'
```

The bridge validates the token, persists it to `/data/refresh_token`, reconnects
SignalR, and clears the HA credential alert — all within seconds.

**Option B — `.env` + restart:**

Update `MYRIDE_REFRESH_TOKEN` in your `.env` and restart the container.

The `capture-tokens.js` browser script prints a ready-to-use `curl` command with
your token pre-filled.

## Troubleshooting

### "REFRESH_TOKEN_AUTH failed: NotAuthorizedException"
Your refresh token has expired. The bridge enters idle mode automatically and sets
the HA credential sensor to alert you. To recover:

1. Log in to the MyRide web app and re-run `capture-tokens.js`
2. Send the new token: `curl -X POST http://YOUR_BRIDGE_HOST:8099/token -d 'TOKEN'`

Or update `.env` and restart the container.

### "Connection closed with an error" + reconnect
Normal — the SignalR server has an idle timeout. The client auto-reconnects with
exponential backoff (1s, 2s, 4s... up to 60s).

### No location updates
Bus GPS only reports during active routes (school days, pickup/dropoff windows).
Remove `BUS_FILTER` temporarily to see if any district buses are reporting.

### Token capture script finds nothing
Make sure you are fully logged in before running the script — the `oidc.user`
sessionStorage key is only populated after authentication completes. If it still
finds nothing, use the Network tab method described in the setup section.

## Files

```
myride-ha-bridge/
├── index.js            # Main entry point & token lifecycle
├── cognito-auth.js     # Cognito REFRESH_TOKEN_AUTH via HTTP API
├── signalr-client.js   # SignalR LiveVehicleHub client
├── mqtt-bridge.js      # MQTT publisher with HA auto-discovery
├── api-server.js       # HTTP API for runtime token updates & health
├── capture-tokens.js   # Browser console snippet for token capture
├── .env.example        # Configuration template
├── .env                # Your config (git-ignored)
├── .gitignore
├── package.json
└── README.md
```
