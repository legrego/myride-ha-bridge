# Changelog

## 1.2.0

### Changed

- The tenant ID is now optional. The bridge reads it from your MyRide sign-in
  token, so setup only needs the refresh token, pasted on the status page.
- On a fresh install the status page opens the token instructions and snippet
  right away, and the snippet copies the refresh token to your clipboard.

## 1.1.1

### Fixed

- A fresh install with no refresh token no longer exits at startup. The status
  page loads and waits for a token, and submitting one starts the bridge.
- A saved token that had already expired at startup left the bridge idle even
  after a new token was submitted. The new token now starts it.

## 1.1.0

### Added

- First release as a Home Assistant add-on.
- Status page and token update in the Home Assistant sidebar, through ingress.
- MQTT broker details are taken from the Mosquitto broker add-on automatically.
- Watchdog: the Supervisor restarts the bridge if its status page stops responding.
- AppArmor profile, in complain mode for this release. It logs what it would
  block, so it can be tightened and enforced in a later release.
