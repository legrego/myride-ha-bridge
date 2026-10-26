# MyRide Bus Bridge

Live MyRide K-12 school bus tracking in Home Assistant. Each student linked to your
MyRide account becomes a device with the bus on the map, stops away, predicted
arrival and an "approaching" sensor.

## Setup

### 1. Install the MQTT broker

If you don't already use it, install and start the **Mosquitto broker** app. Then, in
**Settings → Devices & services**, add the **MQTT** integration that Home Assistant
discovers. The bridge finds the broker by itself, so it needs no MQTT settings.

### 2. Get your tenant ID and refresh token

You need a computer with Chrome, Edge or Firefox for this. A phone won't work.

1. Sign in at [myridek12.tylerapp.com](https://myridek12.tylerapp.com).
2. Open the [token snippet](https://raw.githubusercontent.com/legrego/myride-ha-bridge/main/src/capture-tokens.js)
   in a new tab, select all of it and copy it.
3. Go back to the MyRide tab, press **F12** (on a Mac, **⌥⌘J** in Chrome or Edge,
   **⌥⌘K** in Firefox) and select the **Console** tab.
4. Paste the snippet and press **Enter**. If the browser says pasting isn't allowed,
   type `allow pasting`, press **Enter**, and paste again.

The console prints your **Tenant ID** and **Refresh token**. The refresh token is a
sign-in credential for your MyRide account, so don't share it.

### 3. Configure and start

1. On the **Configuration** tab, paste the **Tenant ID** and **Refresh token**, then
   select **Save**.
2. On the **Info** tab, turn on **Show in sidebar** and **Watchdog**, then select
   **Start**.
3. Open **School Bus** in the sidebar. **MyRide K-12**, **MQTT** and **Credentials**
   should show green within a few seconds. The students appear as devices under
   **Settings → Devices & services → MQTT**.

The bus only reports its position during runs, so outside school hours the map pin
stays where the bus last parked.

## When the token expires

The refresh token lasts about 30 days. When it expires, the bridge keeps running and
`binary_sensor.myride_bridge_credentials` turns on. To fix it:

1. Repeat step 2 to get a new refresh token. The tenant ID doesn't change.
2. Open **School Bus** in the sidebar, expand **Token Management**, paste the token
   and select **Submit Token**.

The bridge starts streaming again within seconds, with no restart. It saves that
token in its own storage and uses it from then on, ahead of the **Refresh token**
option, so later changes to the option have no effect.

## Options

| Option | Description |
|--------|-------------|
| Tenant ID | Your district's ID, from step 2 (required) |
| Refresh token | Your MyRide sign-in token, from step 2. Keep it set until you have submitted a token on the status page, which then replaces it. If you leave it empty, the bridge waits on the status page for a token |
| District time zone | Used to tell the AM run from the PM run. Leave empty to use your Home Assistant time zone |
| Approach radius | Distance in meters at which "Approaching Stop" turns on (default 500) |
| Bus filter | Optional: track only this bus (for example `BUS 042`) |
| Log level | `debug`, `info`, `warn`, or `error` |

## Troubleshooting

- **The app won't start:** fill in **Tenant ID**, and check that the Mosquitto
  broker app is running.
- **No devices:** set up the **MQTT** integration (step 1).
- **Credentials show "Expired" or "Missing":** see
  [When the token expires](#when-the-token-expires).
- **Moving from Docker or Portainer:** stop that container first, or two bridges
  publish to the same MQTT topics. Entity IDs stay the same.

Every log line on the **Log** tab carries a timestamp. More help, the full entity
list and automation examples are in the
[project README](https://github.com/legrego/myride-ha-bridge#readme).

## Status page

Select **Open Web UI**, or use **School Bus** in the sidebar. The page shows the
connection state and tracked buses, and has the form for updating an expired refresh
token. It's served through Home Assistant's ingress, so it's behind your Home
Assistant login and isn't exposed on your network. With **Watchdog** on, the
Supervisor restarts the bridge if the page stops responding.

## Security

The app asks for no extra privileges and has no open ports. It runs with its own
AppArmor profile. In this release that profile is in *complain* mode: it logs what it
would block without blocking anything, so it can be checked against a full school day
and then enforced in a later release.

## Help and license

Questions and bug reports go to
[GitHub issues](https://github.com/legrego/myride-ha-bridge/issues). The project is
MIT-licensed. It isn't affiliated with Tyler Technologies.
