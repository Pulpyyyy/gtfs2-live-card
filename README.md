# GTFS2 Live Card

A Lovelace card for the [gtfs2](https://github.com/vingerha/gtfs2) Home Assistant integration: a departures board and a live vehicle map for one or several transit lines, in two collapsible panes.

![Departures board and line map: trams A and B and bus 40 at Gare d'Orléans](images/hero-light.png)

*Trams A and B and bus 40 at Gare d'Orléans, on the TAO network. Real lines, real shapes, real vehicles: the screenshots are taken from a frozen snapshot of the live feed (see [docs/CAPTURES.md](docs/CAPTURES.md)).*

## Features

- **Departures board**: scheduled and realtime times merged from one or several gtfs2 start/stop sensors, delay chips (on time, +n min), day tags for departures beyond today, stop alerts, colored line badges with destination on every row, and an optional arrival-and-journey-time line per departure (`show_duration`). The whole pane can switch to a timetable layout (`departures_view: table`): departure, arrival, duration, mode, status and line columns, sorted by departure time.
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

![Departures as a table](images/board-light.png)

*The same departures laid out as a timetable (`departures_view: table`): arrival, duration, mode and status per run, each duration colored in three steps against the fastest journey to the same destination.*

## Badge marks

The header shows one badge per line, in the line's official color and label — and the badge is also the line's status display: each corner has a fixed meaning, marked by a small round disc, and every mark carries a tooltip with the exact wording. The discs below are photographed from the card itself, in states produced by real data (a resting sensor, a positions file that does not exist), never redrawn.

| Position | Marks | Meaning |
|---|---|---|
| Bottom right<br><picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-pos-br-dark.png"><img src="images/pip-pos-br-light.png" width="48" alt="a badge, its mode chip bottom right"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-bus-dark.png"><img src="images/pip-bus-light.png" width="44" alt="bus"></picture> <picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-tram-dark.png"><img src="images/pip-tram-light.png" width="44" alt="tram"></picture> <picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-metro-dark.png"><img src="images/pip-metro-light.png" width="44" alt="metro"></picture> <picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-train-dark.png"><img src="images/pip-train-light.png" width="44" alt="train"></picture> <picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-trolleybus-dark.png"><img src="images/pip-trolleybus-light.png" width="44" alt="trolleybus"></picture> <picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-ferry-dark.png"><img src="images/pip-ferry-light.png" width="44" alt="ferry"></picture> | **Transport mode.** The mode glyph derived from the sensor's route type, on a disc in the line's own color — here a bus, a tram under its pantograph, a metro in its tunnel arch, a train of two coupled cars, a trolleybus under its poles, a ferry. Gondola, funicular, monorail, taxi, plane and a generic vehicle complete the set, and an mdi icon you chose yourself always wins over the glyph. Hidden with `mode_icons: false`. |
| Top left<br><picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-pos-tl-dark.png"><img src="images/pip-pos-tl-light.png" width="48" alt="a desaturated badge, the quiet-source mark top left"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-mute-dark.png"><img src="images/pip-mute-light.png" width="44" alt="quiet source"></picture> | **Quiet source.** The realtime source has stopped answering: the entity is gone from Home Assistant, is unavailable, or the positions file is unreachable or has not been rewritten for 8 minutes. The badge loses its saturation while it lasts; the tooltip says which of the three it is, and for how long. |
| Top right<br><picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-pos-tr-dark.png"><img src="images/pip-pos-tr-light.png" width="48" alt="a badge, the alert mark top right"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-alert-dark.png"><img src="images/pip-alert-light.png" width="44" alt="disruption"></picture> <picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-works-dark.png"><img src="images/pip-works-light.png" width="44" alt="engineering works"></picture> <picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-incident-dark.png"><img src="images/pip-incident-light.png" width="44" alt="incident"></picture> | **Operator alert.** What the operator publishes about the line (GTFS-RT alert): an exclamation mark for a disruption, a cone for engineering works, a bolt for an incident. The cone and the bolt need gtfs2 to expose the alert cause; without one the generic mark shows — never a cone that would lie about a strike. |
| Bottom left<br><picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-pos-bl-dark.png"><img src="images/pip-pos-bl-light.png" width="48" alt="a struck-through badge, the rest mark bottom left"></picture> | <picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-tomorrow-dark.png"><img src="images/pip-tomorrow-light.png" width="44" alt="resumes tomorrow"></picture> <picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-days-dark.png"><img src="images/pip-days-light.png" width="44" alt="resumes in n days"></picture> <picture><source media="(prefers-color-scheme: dark)" srcset="images/pip-never-dark.png"><img src="images/pip-never-light.png" width="44" alt="no service scheduled"></picture> | **Resting line.** Always paired with the diagonal stroke across the badge: nothing runs on this line today. The mark says when it is back: a dial (resumes tomorrow), a calendar (resumes in *n* days), a cross (no service scheduled at all). |

## Requirements

- Home Assistant with the [gtfs2](https://github.com/vingerha/gtfs2) integration and at least one start/stop route. Live vehicles need a GTFS-RT source with the `vehicle_positions > local file` output enabled: gtfs2 writes the vehicle positions GeoJSON under `www/gtfs2/`. Without realtime the card still draws the departures board, the route shape and its ordered stops.
- The full route shape and ordered stops need the gtfs2 route export, merged in [vingerha/gtfs2#174](https://github.com/vingerha/gtfs2/pull/174) and shipped since gtfs2 **0.5.9.8**. On older gtfs2 the card degrades gracefully to dashed per-vehicle traces.

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
    positions_url: /local/gtfs2/network_line_40_1.json
    route_url: /local/gtfs2/network_line_40_1_route.json
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
| `mode_icons` | no | Transport-mode chip on the line badges: the card's own glyph for the sensor's route type, or the mdi icon you chose yourself (default `true`). |
| `show_departures` | no | The departures pane, header included (default `true`): `false` makes a map-only card. |
| `departures_view` | no | Departures pane layout: `list` (default), or `table` — departure, arrival, duration, mode, status and line columns, sorted by departure time, a "next departure" line above. Durations are colored in three steps against the fastest journey to the same destination (lines sharing a terminus grade each other). |
| `max_departures` | no | Rows on the departures board (default 4). |
| `show_duration` | no | Arrival time and journey duration on each departure row (“→ 07:07 · 1 h 04”), from the gtfs2 duration attribute or derived from the paired arrival times (default `false`). The table layout always carries them. |
| `show_map` | no | The map pane, header included (default `true`): `false` makes a departures-only card. |
| `refresh` | no | Map polling period in seconds (min 15, default 60). |
| `language` | no | `auto` (HA locale), or `en`, `fr`, `de`, `es`, `pt`. |
| `map_style` | no | `auto` (HA theme), `light`, `dark`, or a custom `{z}/{x}/{y}` tile URL template. |
| `map_aspect` | no | Map aspect ratio, e.g. `"4/3"` (default `2/1`, switching to `4/3` under 380 px). |
| `station_color` | no | Origin station marker color (default: the HA accent color). |
| `line`, `line_color` | no | Badge label and color in the legacy single-sensor form. |
| `positions_url` | no | Vehicle positions GeoJSON (default: derived from `vehicle_positions_file`, or from `route_id` + `direction_id`). |
| `route_url` | no | Route GeoJSON (default: derived from `route_geojson_file`, else `positions_url` with `_route.json`). |
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

The card is served exactly as it sits in `dist/`: `gtfs2-live-card.js` plus
one file per language under `dist/lang/`, each holding the strings of the card
*and* of the visual editor. There is no build step — the language files are
fetched at runtime from wherever the card was installed.

To fix a translation, edit `dist/lang/<code>.js` and reload the dashboard.
Then let the parity check confirm nothing drifted:

```bash
python build.py --check   # every language carries exactly the keys English has
```

Adding a language means copying `dist/lang/en.js`, translating the values, and
adding its code to `LANGS` in `dist/gtfs2-live-card.js`. CI runs the same
check, so a language missing a key that English has, or carrying one English
does not, fails there rather than showing raw string keys on a user's
dashboard.

## Limitations

- Without the gtfs2 route export (see Requirements) there is no shape, no ordered stops and no planned-route split: the card falls back on each vehicle's recent trace, dashed.
- Delays larger than 10 minutes can show twice: the realtime/schedule pairing window is deliberately strict (10 min) so the card never claims a wrong delay. Beyond it, the run appears once as realtime (no scheduled time) and once as schedule only (the grey "scheduled" chip).
- gtfs2 does not export `speed`, `bearing` or a per-vehicle timestamp in its GeoJSON: heading and speed are estimated from successive positions, so the speed needs the card to have seen at least two distinct positions. For the same reason the card infers how fresh a feed is from the file's `Last-Modified` date rather than from the data itself, which means freshness is known per file, not per vehicle.

## License

[MIT](LICENSE)
