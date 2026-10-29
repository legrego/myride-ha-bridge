# Changelog

## 1.5.0

### Changed

- The **School Bus** page is rebuilt around four tabs:
  - **Overview** says whether everything works and, if not, which step is broken:
    MyRide sign-in, students and runs, the position stream, MQTT, or Home
    Assistant discovery. Select a step for its details and what to do.
  - **Today** lists every run of every student, with substitutes, stop times and
    live progress.
  - **Events** draws today on a timeline (runs, when the position stream was
    live or silent, frames received, reconnects and sign-ins) above a log of
    what the bridge did, with a **Download diagnostics** button.
  - **Setup** shows how the bridge signs in, the settings in effect and where to
    change them. Pasting a refresh token moved here, under **Advanced**.
- The page follows your browser's dark mode.

### Added

- The app checks with Home Assistant that the entities it published exist, and
  shows the result on the page. For this it now requests access to Home
  Assistant's API (`homeassistant_api`), which it uses only for that read-only
  query.

## 1.4.0

### Added

- Sign in with your MyRide email and password: set the new **MyRide email** and
  **MyRide password** options and the app signs in itself, with no token to copy
  out of the browser. When the sign-in expires (about every 30 days) it signs in
  again on its own.
- If MyRide rejects the email and password, the app stops trying them (so it
  can't lock your account), turns on the credentials problem sensor, and waits
  for corrected settings or a pasted refresh token.

## 1.3.0

### Added

- The bus sensor's `todays_runs` attribute now lists each run's time window, the
  student's own stop time and action (`Pickup`/`Dropoff`), and which run is
  current. A changed schedule, like a half day's early dropoff, now shows as soon
  as MyRide publishes it, not only once that run becomes the current one.

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
