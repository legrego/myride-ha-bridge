# Changelog

## 1.1.0

### Added

- First release as a Home Assistant add-on.
- Status page and token update in the Home Assistant sidebar, through ingress.
- MQTT broker details are taken from the Mosquitto broker add-on automatically.
- Watchdog: the Supervisor restarts the bridge if its status page stops responding.
- AppArmor profile, in complain mode for this release. It logs what it would
  block, so it can be tightened and enforced in a later release.
