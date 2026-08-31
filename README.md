# GTFS2 Live Card

A Lovelace card for the [gtfs2](https://github.com/vingerha/gtfs2) Home Assistant integration: a departures board and a live vehicle map for one or several transit lines, in two collapsible panes.

![Departures board and line map: trams A and B and bus 40 at Gare d'Orléans](images/hero-light.png)

*Trams A and B and bus 40 at Gare d'Orléans, on the TAO network. Real lines, real shapes, real vehicles: the screenshots are taken from a frozen snapshot of the live feed (see [docs/CAPTURES.md](docs/CAPTURES.md)).*

## Features

- **Departures board**: scheduled and realtime times merged from one or several gtfs2 start/stop sensors, delay chips (on time, +n min), day tags for departures beyond today, stop alerts, colored line badges with destination on every row, and an optional arrival-and-journey-time line per departure (`show_duration`).
- **Line map**: CARTO/OSM tiles following the HA theme (light/dark), route shapes with direction arrows, ordered stops that name themselves once the view is tight enough, origin station pin, and realtime vehicle positions carrying their transport-mode icon with a heading arrow orbiting the marker. Marker size follows the zoom, so a whole-network view stays readable where a dozen vehicles would otherwise clot together. Hovering or tapping a stop names it and lists the other configured lines calling there, and stays quiet when the map already shows the name in full.
- **Vehicle tracking**: click a vehicle to follow it: animated zoom, passed route dashed in grey, upcoming route in the line color, named next stop, estimated speed in a popup anchored to the marker. The view glides with the vehicle on every refresh and returns to the fitted view with a hint when the vehicle leaves the feed.
- **Line highlight**: click a line badge to raise that line above the others, filter the departures board and show its origin pin; the header shows the full direction (origin → destination).
- **Minimal YAML**: a list of gtfs2 sensors is enough. Everything else (positions file, route file, official line name, official route color, transport mode and its icon, origin station) derives from the sensor attributes, and is remembered across page reloads so an out-of-service line keeps its identity at night. Any explicit YAML value always wins over a derived one.
- **Visual editor**: pick your gtfs2 sensors in a single multi-entity field and the lines build themselves; everything else (map appearance, per line overrides, explicit station coordinates) sits in collapsible sections, each line showing what the card derived from its sensor. Covers the whole configuration, in **five languages** (en, fr, de, es, pt: the gtfs2 project languages), resolved from the HA locale with a `language:` override.
- Resilient by design: requests shared between card instances, polling paused when the tab is hidden and slowed 5x when the map pane is collapsed, and ghost vehicles hidden after the end of service. Freshness is read from the positions file's own `Last-Modified` date, so a vehicle parked at its terminus no longer keeps a dead feed alive; a line whose file has not been rewritten for 8 minutes drops off the map, and a warning replaces the vehicle count when that line is the selected one.

![One line picked from its header badge](images/selected-light.png)

*Tram B picked from its badge: the board keeps only its departures, the map raises its shape and names its vehicles.*

![Vehicle tracking with popup](images/popup-light.png)

*Tracking tram 58: the view follows it, the route behind it turns dashed, and the popup names its terminus, its next stop and its speed.*

## Requirements

- Home Assistant with the [gtfs2](https://github.com/vingerha/gtfs2) integration, at least one start/stop route with a GTFS-RT source configured, and the `vehicle_positions > local file` output enabled: gtfs2 writes the vehicle positions GeoJSON under `www/gtfs2/`.
- The full route shape and ordered stops need the gtfs2 route export (PR [vingerha/gtfs2#174](https://github.com/vingerha/gtfs2/pull/174), or the [Pulpyyyy/gtfs2](https://github.com/Pulpyyyy/gtfs2) fork until it is merged). Without it the card degrades gracefully to dashed per-vehicle traces.

## Installation

### HACS (recommended)

1. HACS, three-dot menu, **Custom repositories**: add `https://github.com/Pulpyyyy/gtfs2-live-card`, category **Dashboard**.
2. Search for **GTFS2 Live Card**, install, and reload when prompted.

### Manual

1. Copy `dist/gtfs2-live-card.js` into `config/www/`.
2. Settings, Dashboards, **Resources**: add `/local/gtfs2-live-card.js` as a *JavaScript module*.

## Configuration

Minimal configuration, everything derived from the sensors:

```yaml
type: custom:gtfs2-live-card
lines:
  - sensor.station_line_40_outbound
  - sensor.station_line_40_inbound
  - sensor.station_line_a_outbound
```

Every entry can also be an object to override any derived value:

```yaml
type: custom:gtfs2-live-card
title: "Central station"
lines:
  - entity: sensor.station_line_40_outbound
    line: "40"
    color: "#0072bc"
    positions_url: /local/gtfs2/NETWORK:Line:40_1.json
    route_url: /local/gtfs2/NETWORK:Line:40_1_route.json
  - sensor.station_line_a_outbound
```

![Visual editor](images/editor-light.png)

*The visual editor, sections open: the lines are picked in one field, and each shows what the card derived from its sensor.*

### Options

| Option | Required | Description |
|---|---|---|
| `lines` | yes* | List of lines: either plain entity ids (`- sensor.xxx`) or objects `{entity?, positions_url?, route_url?, line?, color?}` overriding the derived values. |
| `entity` | yes* | Legacy single-sensor form (equivalent to a one-entry `lines`). *Either `lines` or `entity` is required. |
| `title` | no | Extra title line. Omitted: no title (badges only). `title: ""` also hides it. |
| `max_departures` | no | Rows on the departures board (default 4). |
| `refresh` | no | Map polling period in seconds (min 15, default 60). |
| `mode_icons` | no | Transport-mode chip (mdi icon from the sensor) on the line badges (default `true`). |
| `show_duration` | no | Arrival time and journey duration on each departure row (“Théorique 06:03 → 07:07 (1 h 04)”), from the gtfs2 duration attribute or derived from the paired arrival times (default `false`). |
| `show_departures` | no | The departures pane, header included (default `true`): `false` makes a map-only card. |
| `show_map` | no | The map pane, header included (default `true`): `false` makes a departures-only card. |
| `language` | no | `auto` (HA locale), or `en`, `fr`, `de`, `es`, `pt`. |
| `map_style` | no | `auto` (HA theme), `light`, `dark`, or a custom `{z}/{x}/{y}` tile URL template. |
| `map_aspect` | no | Map aspect ratio, e.g. `"4/3"` (default `2/1`, switching to `4/3` under 380 px). |
| `station_color` | no | Origin station marker color (default: the HA accent color). |
| `line`, `line_color` | no | Badge label and color in the legacy single-sensor form. |
| `positions_url` | no | Vehicle positions GeoJSON (default: derived from `vehicle_positions_file`, or from `route_id` + `direction_id`). |
| `route_url` | no | Route GeoJSON (default: `positions_url` with `_route.json`). |
| `latitude`, `longitude` | no | Explicit station position (default: located on the route via `origin_station_stop_id`). |

Every option above is reachable from the visual editor: the sensors in the entity picker, the common settings in plain sight, and the rest under the "Map appearance", "Per line overrides" and "Advanced" sections. The editor never rewrites a value you did not touch, so a hand-written YAML keeps its shape.

The collapsed/expanded state of each pane is remembered per card (localStorage).

## Map interactions

- **Mouse**: drag to pan. **Ctrl + wheel** zooms on the cursor (plain wheel keeps scrolling the page). Double-click recenters and zooms in.
- **Touch**: two fingers pan and pinch (one finger keeps scrolling the page).
- **Buttons**: zoom in/out, recenter (shown after a manual pan/zoom), and a back-to-line-view button while tracking.
- Click a vehicle to track it, click a line badge to highlight the line. Badges, section headers and vehicle markers are keyboard operable (Tab + Enter).
- **Leaving tracking**: the popup cross, `Escape` or a tap on the map background release the vehicle and leave the map where it is. Clicking a line badge, or the "Overview" button, resets the view to the fitted one.

Tiles © OpenStreetMap © CARTO (the same basemaps as the native HA map), loaded directly by the browser. The tile layer is only rebuilt when the visible area changes, requests are shared between cards showing the same line, polling pauses when the tab is hidden and slows down while the map pane is collapsed.

## Translating

The card ships one file, `dist/gtfs2-live-card.js`, which is the file HACS
serves. That file is generated: the sources are `src/card.js` plus one file per
language under `src/lang/`, each holding the strings of the card *and* of the
visual editor.

To fix or add a translation, edit `src/lang/<code>.js` and rebuild:

```bash
python build.py           # write dist/gtfs2-live-card.js
python build.py --check   # verify dist/ matches src/, changing nothing (CI)
```

Adding a language means adding `src/lang/<code>.js` (copy `en.js`, translate the
values) and its code to `LANGS` in `src/card.js`. The build refuses to run when
a language is missing a key that English has, or carries one English does not,
so a half-translated file fails in CI rather than falling back to English on a
user's dashboard.

Edits made straight to `dist/` are lost at the next build.

## Limitations

- Without the gtfs2 route export (see Requirements) there is no shape, no ordered stops and no planned-route split: the card falls back on each vehicle's recent trace, dashed.
- Delays larger than 10 minutes can show twice: the realtime/schedule pairing window is deliberately strict (10 min) so the card never claims a wrong delay. Beyond it, the run appears once as realtime (no scheduled time) and once as schedule only ("no realtime yet").
- gtfs2 does not export `speed`, `bearing` or a per-vehicle timestamp in its GeoJSON: heading and speed are estimated from successive positions, so the speed needs the card to have seen at least two distinct positions. For the same reason the card infers how fresh a feed is from the file's `Last-Modified` date rather than from the data itself, which means freshness is known per file, not per vehicle.

## License

[MIT](LICENSE)
