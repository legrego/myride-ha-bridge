# 🚌 MyRide K-12 for Home Assistant

See where your kid's school bus is, right in Home Assistant. This bridge takes the live
GPS feed behind Tyler Technologies' MyRide K-12 app and turns it into Home Assistant
entities: the bus on your map, how many stops away it is, when it will reach your stop,
and an "approaching" sensor you can use in automations.

![Screenshot of the status page](./status-page-screenshot.png)

## Install

You need:

- **Home Assistant OS** or **Supervised** (on amd64 or aarch64). On Home Assistant
  Container or Core, which can't run apps, see [Other ways to run](#other-ways-to-run).
- A **MyRide K-12 account**, the one you use on
  [myridek12.tylerapp.com](https://myridek12.tylerapp.com).
- A **computer** with Chrome, Edge or Firefox, used once to copy a sign-in token out
  of MyRide. A phone won't work for this step.

### Step 1: Install the MQTT broker

Skip this step if you already use the **Mosquitto broker** app.

[![Open the Mosquitto broker app in your Home Assistant.](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=core_mosquitto)

1. Select the button above, then **Install**, then **Start**.
2. Go to **Settings → Devices & services**. Home Assistant shows the **MQTT**
   integration as discovered. Select **Add** (or **Configure**) and then **Submit**.

The bridge finds the broker by itself, so you never type any MQTT settings.

### Step 2: Install and start the MyRide Bus Bridge app

[![Open the MyRide Bus Bridge app in your Home Assistant.](https://my.home-assistant.io/badges/supervisor_addon.svg)](https://my.home-assistant.io/redirect/supervisor_addon/?addon=ae2231fb_myride_bridge&repository_url=https%3A%2F%2Fgithub.com%2Flegrego%2Fmyride-ha-bridge)

1. Select the button above. If Home Assistant asks to add the repository, select
   **Add**.
2. Select **Install**.
3. Turn on **Show in sidebar** and **Watchdog**, then select **Start**.

There's nothing to configure.

<details>
<summary>Adding the app by hand instead</summary>

1. Go to **Settings → Apps → Install app**.
2. Open the **⋮** menu (top right), then **Repositories**.
3. Paste `https://github.com/legrego/myride-ha-bridge`, then select **Add** and close
   the dialog.
4. Find **MyRide Bus Bridge** in the list (you may need to refresh the page) and select
   it.

</details>

### Step 3: Connect your MyRide account

MyRide doesn't let other programs sign in with your email and password, so you copy a
sign-in token from your browser once. It takes about a minute, on your computer.

1. In Home Assistant, open **School Bus** in the sidebar. It asks for a refresh token
   and shows a snippet under **How do I get a refresh token?**. Select
   **Copy to clipboard**.
2. In a new tab, sign in at [myridek12.tylerapp.com](https://myridek12.tylerapp.com).
3. Press **F12** (on a Mac, **⌥⌘J** in Chrome or Edge, **⌥⌘K** in Firefox) to open the
   developer tools, and select the **Console** tab.
4. Paste the snippet and press **Enter**. If the browser says pasting isn't allowed,
   type `allow pasting`, press **Enter**, and paste again.
5. The snippet prints your **refresh token** (a long string starting with `eyJ`) and
   copies it to your clipboard.
6. Go back to the **School Bus** page, paste the token into the box and select
   **Submit Token**.

> The refresh token is a sign-in credential for your MyRide account. Don't share it.
> It lasts about 30 days; see [When the token expires](#when-the-token-expires).

### Step 4: Check that it works

- On the **School Bus** page, **MyRide K-12**, **MQTT** and **Credentials** should all
  show green within a few seconds.
- Go to **Settings → Devices & services → MQTT**. Each student linked to your MyRide
  account is now a device, named after the student.

That's it. The bus only reports its position during runs, so outside school hours
the map pin stays where the bus last parked.

### When the token expires

The refresh token lasts about 30 days. When it expires the bridge keeps running, and
`binary_sensor.myride_bridge_credentials` turns **on** (you can
[get a notification](#token-expired)). To fix it, repeat
[step 3](#step-3-connect-your-myride-account). The snippet is under **Token
Management → How do I get a refresh token?**. The bridge starts streaming again
within seconds, with no restart.

## What you get

Each student is one device. Its entities follow whichever bus the student rides
_today_, including substitute buses, so entity IDs never change when the bus number
does.

For a student with ID `1234567` you get:

| Entity | Type | Description |
|--------|------|-------------|
| `device_tracker.myride_student_1234567` | Device Tracker | Map pin with lat/lng (follows today's bus) |
| `sensor.myride_student_1234567_speed` | Sensor | Speed in mph |
| `sensor.myride_student_1234567_heading` | Sensor | Compass heading (degrees) |
| `binary_sensor.myride_student_1234567_moving` | Binary Sensor | Is the bus in motion? |
| `sensor.myride_student_1234567_bus` | Sensor | Which bus the student is on today |
| `binary_sensor.myride_student_1234567_substitute` | Binary Sensor | Is today's bus a substitute? (ON = yes) |
| `sensor.myride_student_1234567_my_stop` | Sensor | The student's own stop name |
| `sensor.myride_student_1234567_scheduled_time` | Sensor | Scheduled stop time (district-local HH:MM) |
| `sensor.myride_student_1234567_stops_away` | Sensor | Route-derived count of stops still ahead |
| `sensor.myride_student_1234567_distance_to_stop` | Sensor | Distance to the student's stop |
| `sensor.myride_student_1234567_eta` | Sensor | Speed-based ETA to the student's stop |
| `sensor.myride_student_1234567_delay` | Sensor | Minutes behind/ahead of schedule |
| `sensor.myride_student_1234567_predicted_arrival` | Sensor | Schedule-anchored predicted arrival timestamp |
| `binary_sensor.myride_student_1234567_approaching` | Binary Sensor | Is the bus within the approach radius of the stop? |
| `binary_sensor.myride_student_1234567_route_snap_ok` | Binary Sensor | Is stop-progress currently using trusted route mode? |
| `sensor.myride_student_1234567_last_fix` | Sensor | GPS time of the latest fix for the student's bus (diagnostic timestamp) |
| `binary_sensor.myride_student_1234567_feed_live` | Binary Sensor | Has a fix arrived in the last 2 minutes? (diagnostic; OFF = tracking lost) |
| `binary_sensor.myride_bridge_credentials` | Binary Sensor | Credential problem alert (ON = expired) |
| `binary_sensor.myride_bridge_position_stream` | Binary Sensor | Is MyRide streaming positions for today's bus(es) to the bridge? (diagnostic; OFF = stream silent on a run day, unknown = no runs today; attributes carry connection/reconnect details) |
| `sensor.myride_bridge_last_frame_received` | Sensor | When the bridge last received any position frame, any bus (diagnostic timestamp, updated at most once a minute) |

> Raw per-bus entities (`device_tracker.myride_bus_*`) are no longer published. On
> upgrade the bridge clears the old retained discovery configs so those entities
> disappear from Home Assistant automatically.

### App options

None are needed for a normal setup.

| Option | Description |
|--------|-------------|
| Tenant ID | Your district's MyRide ID. Read from your token; set it only if the log says it couldn't find one |
| Refresh token | Another way to give the bridge your token. Once you submit a token on the status page, that one is used instead |
| District time zone | Used to tell the AM run from the PM run. Leave empty to use your Home Assistant time zone |
| Approach radius | Distance in meters at which "Approaching Stop" turns on (default 500) |
| Bus filter | Track only this bus, such as `BUS 042`. Leave empty to follow each student's bus automatically |
| Log level | `debug`, `info`, `warn` or `error` |

## Automation ideas

To use one, go to **Settings → Automations & scenes → Create automation → Create new
automation**, open the **⋮** menu, select **Edit in YAML**, and paste it. Replace
`1234567` with your student's ID and `notify.mobile_app_your_phone` with your phone's
notify action.

### Bus is almost at your stop

```yaml
alias: School bus approaching
triggers:
  - trigger: state
    entity_id: binary_sensor.myride_student_1234567_approaching
    to: "on"
actions:
  - action: notify.mobile_app_your_phone
    data:
      title: "🚌 Bus approaching!"
      message: >
        The bus is {{ states('sensor.myride_student_1234567_stops_away') }} stops away.
      data:
        ttl: 0
        priority: high
```

### Bus has left school

```yaml
alias: Bus left school
triggers:
  - trigger: state
    entity_id: binary_sensor.myride_student_1234567_moving
    from: "off"
    to: "on"
conditions:
  - condition: time
    after: "14:00:00"
    before: "16:30:00"
    weekday: [mon, tue, wed, thu, fri]
actions:
  - action: notify.mobile_app_your_phone
    data:
      title: "🏫 Bus is rolling!"
      message: "The school bus just started moving. Time to head to the stop!"
```

### Token expired

```yaml
alias: MyRide token expired
triggers:
  - trigger: state
    entity_id: binary_sensor.myride_bridge_credentials
    to: "on"
actions:
  - action: notify.mobile_app_your_phone
    data:
      title: "MyRide Bridge: token expired"
      message: >
        Get a new MyRide refresh token and paste it on the School Bus page.
```

### Live bus map card

```yaml
type: map
entities:
  - entity: device_tracker.myride_student_1234567
    name: School Bus
  - entity: zone.home
default_zoom: 14
hours_to_show: 0
```

## Troubleshooting

Start with the app's **Log** tab. Every line has a timestamp.

### The app won't start
Check that the Mosquitto broker app is installed and running.

### "Couldn't find your district's tenant ID"
The bridge normally reads your district's ID from your MyRide token. If it can't, set
**Tenant ID** on the app's **Configuration** tab. To find it, sign in to MyRide with
the developer tools open on the **Network** tab: requests to
`myridek12.tylerapi.com` carry it in an `x-tenant-id` header.

### Credentials show "Expired" or "Missing"
The refresh token has expired, or none was set. Follow
[When the token expires](#when-the-token-expires).

### No devices in Home Assistant
Make sure the **MQTT** integration is set up (step 1). The devices are listed under
**Settings → Devices & services → MQTT**.

### The snippet finds no refresh token
Make sure you're fully signed in to MyRide before you run it. If it still finds
nothing:

1. In the developer tools, open the **Network** tab and turn on **Preserve log**.
2. Sign out of MyRide, then sign back in.
3. Type `token` in the Network filter box.
4. Look through the responses for one containing `refresh_token`, and copy its value.

### No location updates
The bus only reports its position during its runs on school days. To check whether any
bus in your district is reporting, clear **Bus filter** if you set one.

MyRide decides which buses a connection receives **when the connection is made**,
from that day's runs; a connection made on a no-run day (weekend, holiday) receives
nothing, even after runs return. The bridge handles this itself: it reconnects as
soon as a roster poll shows a bus it isn't yet watching (`[Stream] reconnect
reason=runs-changed`), and on a run day it reconnects whenever today's bus has sent
no frame for `STREAM_SILENCE_SECONDS` (default 300), backing off to one attempt per
15 minutes while the stream stays silent (`reason=watchdog`). A tracked connection
receives a repeat of the latest fix about every 5 seconds even while the bus is
parked, so silence really means "not tracked". `binary_sensor.myride_bridge_position_stream`
shows the result in Home Assistant, and `GET /status` includes a `stream` section.

### Tracking the wrong bus (e.g. regular bus instead of today's substitute)
On days with both a morning and afternoon run, the bridge picks the run whose
stop-time window matches the current time of day. Those stop times are in the
**district's local time**, so a wrong time zone can push "now" outside the right
window and select the wrong run. Set **District time zone** (or `TZ` outside the app)
to your district's time zone and restart. The `sensor.myride_student_<id>_bus`
entity's `todays_runs` attribute lists every run and which one is currently active
(`current`), with each run's `window_start`/`window_end` and the student's own
`my_stop_time`/`my_stop_action`.

### "Connection closed with an error" + reconnect
Normal. The MyRide server has an idle timeout, and the bridge reconnects with
exponential backoff (1s, 2s, 4s... up to 60s).

### Moving from Docker or Portainer to the app
Stop the old container first, or two bridges publish to the same topics. Entity IDs
stay the same.

## Other ways to run

The app is the easiest way to run the bridge. If your Home Assistant can't run apps
(Container or Core installs), run the bridge yourself and point it at any MQTT broker
that Home Assistant uses.

### Docker Compose

1. Download [`docker-compose.yml`](./docker-compose.yml) and
   [`.env.example`](./.env.example) into a folder, and rename `.env.example` to `.env`.
2. In `.env`, set your broker's `MQTT_BROKER`, `MQTT_USERNAME` and `MQTT_PASSWORD`.
3. Run `docker compose up -d`.
4. Open the status page at `http://YOUR_HOST:8099` and follow
   [step 3](#step-3-connect-your-myride-account) to submit your refresh token.

The `/data` volume keeps the token you submitted across container recreates. You can also submit a new token with
`curl -X POST http://YOUR_HOST:8099/token -d 'NEW_REFRESH_TOKEN'`.

### Node.js

Needs Node.js 22 or later.

```bash
git clone https://github.com/legrego/myride-ha-bridge.git
cd myride-ha-bridge
npm install
cp .env.example .env
npm start
```

In `.env`, set your MQTT broker as for Docker Compose, and change `TOKEN_FILE` to
`./data/refresh_token`: the default `/data` is the Docker volume, which a normal user
usually can't write to, and the token you submit on the status page is saved there.
Then submit your token at `http://localhost:8099` ([step 3](#step-3-connect-your-myride-account)).

<details>
<summary>Run it as a systemd service</summary>

Create `/etc/systemd/system/myride-bridge.service`:

```ini
[Unit]
Description=MyRide K-12 MQTT Bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=homeassistant
WorkingDirectory=/opt/myride-ha-bridge
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=30
EnvironmentFile=/opt/myride-ha-bridge/.env

[Install]
WantedBy=multi-user.target
```

With `TOKEN_FILE=./data/refresh_token`, the token is saved in
`/opt/myride-ha-bridge/data`, so give the service user that folder:

```bash
sudo install -d -o homeassistant /opt/myride-ha-bridge/data
sudo systemctl enable --now myride-bridge
sudo journalctl -u myride-bridge -f
```

</details>

### Settings

Outside the app, the bridge is configured with environment variables (or `.env`):

| Variable | Description |
|----------|-------------|
| `MYRIDE_REFRESH_TOKEN` | Refresh token, from step 3 (or submit it on the status page) |
| `MYRIDE_TENANT_ID` | District ID. Optional: read from the token when unset |
| `MQTT_BROKER`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD` | Your MQTT broker |
| `TZ` | District time zone (default `America/New_York`) |
| `BUS_FILTER` | Track only this bus, such as `BUS 042` |
| `APPROACH_RADIUS_METERS` | Distance for "Approaching Stop" (default `500`) |
| `STREAM_SILENCE_SECONDS` | Silence on a run day before the position stream is reconnected (default `300`) |
| `API_PORT` | Status page port (default `8099`) |
| `TOKEN_FILE` | Where a submitted token is saved (default `/data/refresh_token`) |

If you can't get a refresh token at all, you can set `MYRIDE_ACCESS_TOKEN` to the
`access_token=` value from any SignalR WebSocket URL in the browser's Network tab. It
expires after 60 minutes, so it's only good for a quick test.

The status page also serves `GET /status` (JSON health check), `GET /version` (build
metadata) and `GET /snippet` (the token snippet as plain text).

## How it works

```
┌────────────-───────────┐
│  myridek12.tylerapp    │  ← You log in here once in a browser
│  (Tyler IdentityServer)│    to capture your Cognito refresh token
└───────────┬───────-────┘
            │ refresh_token
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
│                 │                         │  Mosquitto app        │
└─────────────────┘                         └───────────────────────┘

┌─────────────────┐
│  api-server     │  ← POST /token  — submit new refresh token
│  (port 8099)    │  ← GET  /status — JSON health check
│                 │  ← GET  /       — browser status UI
└─────────────────┘
```

### Why not just use email and password?

Tyler Technologies doesn't allow direct Cognito authentication (SRP and
USER_PASSWORD_AUTH are both disabled on their Cognito client). Login goes through
Tyler's own IdentityServer at `myridek12.tylerapp.com/login/core/connect/authorize`,
which handles the web login form and issues Cognito tokens server-side.

The workaround: capture your Cognito **refresh token** once from the browser, then
this bridge uses Cognito's `REFRESH_TOKEN_AUTH` flow to get fresh access tokens
automatically.

### Token lifecycle

| Token | Lifetime | Auto-renewed? |
|-------|----------|---------------|
| Access token | 60 minutes | Yes, via refresh token |
| Refresh token | ~30 days (Cognito default) | No — re-capture from browser |

The bridge refreshes the access token every 50 minutes automatically. When the
refresh token itself expires, the bridge **does not crash**. Instead it:

1. Logs a prominent error banner
2. Stops the SignalR data stream
3. Sets `binary_sensor.myride_bridge_credentials` to **ON** (problem) in Home Assistant
4. Keeps MQTT and the status page running so you can recover without restarting

With no token configured at all, the bridge likewise starts only the status page and
waits for a token.

## Development

### Simulation mode

Run the full bridge without a MyRide account or MQTT broker:

```bash
npm run simulate
```

Four fake buses (BUS 001, BUS 002, BUS 042, BUS 099) do a random walk around a
suburb, sending a location every 5 seconds. The status page runs normally at
`http://localhost:8099` with a blue **SIMULATION MODE** banner; a submitted token is
accepted but ignored. If `MQTT_BROKER` is set, the fake locations are published to
MQTT so you can test Home Assistant automations.

### Tests

```bash
npm test
```

### Releasing the app

The app image is built by `.github/workflows/addon-image.yaml` with Home Assistant's
builder actions. It publishes only when `version` in `myride_bridge/config.yaml` (kept
equal to `package.json`) is new; an existing version is never overwritten. The first
release creates three GHCR packages, `myride-ha-bridge-addon` plus `amd64-` and
`aarch64-myride-ha-bridge-addon`. Make all three **public**, or the Supervisor can't
pull them.
