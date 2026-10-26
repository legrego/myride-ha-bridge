# MyRide Bus Bridge

Streams live MyRide K-12 school bus GPS into Home Assistant over MQTT. It creates
the same student-centric entities as the standalone Docker deployment.

## Setup

1. Install and start the **Mosquitto broker** add-on. The bridge picks up its
   credentials automatically, so you don't need any MQTT settings.
2. Run `capture-tokens.js` in your browser while logged in to MyRide (see the
   [project README](https://github.com/legrego/myride-ha-bridge#2-capture-your-refresh-token)).
   It prints your **tenant ID** and **refresh token**.
3. On the **Configuration** tab, fill in the tenant ID, then start the add-on.
4. Open the status page (**Open Web UI**) and paste the refresh token under
   **Token Management**. The bridge starts streaming right away and saves the
   token in its own storage, so it survives restarts and updates.

The add-on won't start until the tenant ID is set. You can put the refresh token
in the `refresh_token` option instead of step 4; the bridge reads the option at
every start and doesn't save a copy of it, so leave it set. With no token at all,
the bridge waits on the status page for one.

When the token expires, paste a new one on the status page (no restart needed).
The bridge saves that token in its own storage and uses it from then on, ahead of
the option, so later changes to the `refresh_token` option have no effect.

> If you're moving from a Portainer/Docker deployment, stop that container
> first. Two bridges would publish to the same MQTT topics. Entity IDs stay the
> same.

## Status page

Select **Open Web UI**, or turn on **Show in sidebar** to get a **School Bus**
entry. The page shows the connection state and tracked buses, and has the form for
updating an expired refresh token. It's served through Home Assistant's ingress,
so it's behind your Home Assistant login and isn't exposed on your network.

## Options

| Option | Description |
|--------|-------------|
| `tenant_id` | District UUID from `capture-tokens.js` (required) |
| `refresh_token` | Optional Cognito refresh token, instead of pasting one on the status page. Keep it set; a token pasted on the status page replaces it |
| `timezone` | District IANA time zone, used for AM/PM run selection. Leave empty to use your Home Assistant time zone |
| `approach_radius_meters` | Distance at which "Approaching Stop" turns on (default 500) |
| `bus_filter` | Optional: track only this bus (for example `BUS 042`) |
| `log_level` | `debug`, `info`, `warn`, or `error` |

## Logs and health

Every log line carries a timestamp, on the **Log** tab. The Supervisor's watchdog
checks the status page and restarts the bridge if it stops responding. For that
to happen, turn on **Watchdog** on the add-on's **Info** tab.

## Security

The add-on asks for no extra privileges and has no open ports. It runs with its
own AppArmor profile. In this release that profile is in *complain* mode: it logs
what it would block without blocking anything, so it can be checked against a
full school day and then enforced in a later release.

## Help and license

Questions and bug reports go to
[GitHub issues](https://github.com/legrego/myride-ha-bridge/issues). The project
is MIT-licensed. It isn't affiliated with Tyler Technologies.
