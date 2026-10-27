# MyRide Bus Bridge

Live MyRide K-12 school bus tracking in Home Assistant. Each student linked to your
MyRide account becomes a device with the bus on the map, stops away, predicted
arrival and an "approaching" sensor.

## Setup

### 1. Install the MQTT broker

If you don't already use it, install and start the **Mosquitto broker** app. Then, in
**Settings → Devices & services**, add the **MQTT** integration that Home Assistant
discovers. The bridge finds the broker by itself, so it needs no MQTT settings.

### 2. Start the app

On the **Info** tab, turn on **Show in sidebar** and **Watchdog**, then select
**Start**. There's nothing to configure.

### 3. Connect your MyRide account

Do this on a computer with Chrome, Edge or Firefox. A phone won't work.

1. Open **School Bus** in the sidebar. It asks for a refresh token and shows a
   snippet under **How do I get a refresh token?**. Select **Copy to clipboard**.
2. In a new tab, sign in at [myridek12.tylerapp.com](https://myridek12.tylerapp.com).
3. Press **F12** (on a Mac, **⌥⌘J** in Chrome or Edge, **⌥⌘K** in Firefox) and select
   the **Console** tab.
4. Paste the snippet and press **Enter**. If the browser says pasting isn't allowed,
   type `allow pasting`, press **Enter**, and paste again.
5. The snippet prints your refresh token and copies it to your clipboard. Go back to
   **School Bus**, paste it into the box and select **Submit Token**.

Within a few seconds **MyRide K-12**, **MQTT** and **Credentials** show green, and
each student appears as a device under **Settings → Devices & services → MQTT**. The
bus only reports its position during runs, so outside school hours the map pin stays
where the bus last parked.

The refresh token is a sign-in credential for your MyRide account, so don't share
it. The bridge saves it in its own storage, so it survives restarts and updates.

## When the token expires

The refresh token lasts about 30 days. When it expires, the bridge keeps running and
`binary_sensor.myride_bridge_credentials` turns on. To fix it, repeat step 3; the
snippet is under **Token Management → How do I get a refresh token?**. The bridge
starts streaming again within seconds, with no restart.

## Options

None are needed for a normal setup.

| Option | Description |
|--------|-------------|
| Tenant ID | Your district's MyRide ID. Read from your token; set it only if the log says it couldn't find one |
| Refresh token | Another way to give the bridge your token (the bridge reads it at every start and doesn't save it). Once you submit a token on the status page, that one is used instead |
| District time zone | Used to tell the AM run from the PM run. Leave empty to use your Home Assistant time zone |
| Approach radius | Distance in meters at which "Approaching Stop" turns on (default 500) |
| Bus filter | Optional: track only this bus (for example `BUS 042`) |
| Log level | `debug`, `info`, `warn`, or `error` |

## Troubleshooting

- **The app won't start:** check that the Mosquitto broker app is running.
- **"Couldn't find your district's tenant ID":** set **Tenant ID** on the
  **Configuration** tab. Requests to `myridek12.tylerapi.com` in the browser's
  **Network** tab carry it in an `x-tenant-id` header.
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
