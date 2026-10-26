# MyRide Bus Bridge

Streams live MyRide K-12 school bus GPS into Home Assistant over MQTT. It creates
the same student-centric entities as the standalone Docker deployment.

## Setup

1. Install and start the **Mosquitto broker** add-on. The bridge picks up its
   credentials automatically, so you don't need any MQTT settings.
2. Run `capture-tokens.js` in your browser while logged in to MyRide (see the
   project README). It prints your **tenant ID** and **refresh token**.
3. Fill in `tenant_id` and `refresh_token` below, then start the add-on.

The refresh token is only used on the first start. After that the bridge keeps
its own copy in the add-on's `/data`. When it expires, submit a new one on the
status page at `http://homeassistant.local:8099` (no restart needed).

> If you're moving from a Portainer/Docker deployment, stop that container
> first. Two bridges would publish to the same MQTT topics.

## Options

| Option | Description |
|--------|-------------|
| `tenant_id` | District UUID from `capture-tokens.js` (required) |
| `refresh_token` | Cognito refresh token, used to bootstrap the first start |
| `timezone` | District IANA timezone, used for run selection |
| `approach_radius_meters` | Distance at which "Approaching Stop" turns on |
| `bus_filter` | Optional: track only this bus (for example `BUS 042`) |
| `log_level` | `debug`, `info`, `warn`, or `error` |
