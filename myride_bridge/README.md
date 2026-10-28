# MyRide Bus Bridge

Live school bus tracking from Tyler Technologies' MyRide K-12, in Home Assistant.

Each student gets a device with the bus location on the map, speed and heading,
today's bus (including substitutes), and stop tracking: distance and stops away,
an "approaching" sensor for automations, and a schedule-based predicted arrival.
Everything arrives over MQTT with auto-discovery, through the Mosquitto broker
add-on.

Setup takes about five minutes: install, enter your MyRide email and password, and
start. The **Documentation** tab walks you through it.
