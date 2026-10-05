# Changelog

## 2.3.0

### Added

- A train sensor that gathers several stations at one end, such as Orléans and Les Aubrais to Paris, is read station by station. Each departure leaves from its own station. A trip boarded at Orléans only offers the trains that call there, and one boarded at Les Aubrais offers them all, timed at Les Aubrais. The stretch of line the card searches on starts at the first of those stations, not at the one the next train leaves from, as long as the route shape gtfs2 exports calls there (see Limitations in the README). The editor reads the sensor the same way. This needs `origin_stations` and `destination_stations` from gtfs2 `refactor/architecture`.
- A sensor that rides several lines shows each of them. In the Lines view the sensor gets one square per line (K8+, P8, K6+), and any of them picks the whole sensor. The destination chips carry one plate per line, and each departure carries its own line's badge. Each line keeps the colour its feed gives it (K8+ purple, P8 green), even when the next train is on another line. The lines come from gtfs2's `lines`, and from the lines the departures ride when it is missing. The colours come from `line_colors`, and from the colours seen on the sensor's departures when it is missing.
- A place where a way changes is an arrival of its own. Going from Orléans to Mairie de Montrouge by way of Paris Austerlitz, Austerlitz is offered as an arrival without a trip of its own, with the trains of that way.

### Changed

- A line keeps its colour when only its vehicle positions file has gone quiet: its timetable and realtime still stand, and its mark and tooltip say what happened. It is greyed only when its sensor is gone from Home Assistant or unavailable, when nothing it shows is current.
- A line whose feed gives no colour takes one of the card's own colours per line, not per sensor. Its two directions now share the same colour.

### Fixed

- A train that never calls where a trip ends is no longer offered for that trip. A K6+ to Tours, which passes Les Aubrais but never Orléans, was listed for Paris to Orléans with an arrival time worked out from the line's shape. A run that calls there with no drop-off allowed, or that the feed says skips the stop today, is still listed without an arrival, as before.
- One station filed under several records, as SNCF does with one record per kind of train sharing the same UIC code, is recognised as one place when the card matches a run to a station.
- The editor no longer offers, for a line, a sensor that another line of the card already uses. Picked twice, the sensor drew its line twice: two badges and every departure listed twice.

## 2.2.0

### Added

- A console trace of the map's moves, for a bug report: `localStorage.setItem("gtfs2-live-card:debug", "1")`, then reload. Every move of the view logs where the card thinks it is, where the base map is, and the pixels between the two.

### Fixed

- The map's drawing stays on its base map at any zoom. Zoomed far out, the base map curled into a globe under a flat drawing; it stays flat. On a card whose lines span two continents, Chrome's cap on SVG lengths pinned stops and vehicles thousands of kilometres from where they belong (Chartres in Minnesota); the overlay is drawn in units that never reach the cap.
- The view no longer leaves the lines it is zoomed onto. A double-click zooms around the pointer instead of recentring, so a few of them no longer push a line off the map; a refresh during a pinch no longer throws the view away; a double-click on a vehicle tracks it and stays tracking; the first zoom out of a two-continent card zooms out; and the view stops where the base map does, at the antimeridian and the poles.
- A line a feed names only in full (TriMet's "MAX Blue Line", no short name) shows its initials on its badge, MBL, instead of a dot.

## 2.1.4

### Fixed

- A line picked from its badge in the Lines view brings the map onto it. On a card with lines only, the badge lit the line and the view stayed on the whole network; it now frames the line between its two ends, as the Journeys view already did.

## 2.1.3

### Fixed

- The departures table reads on a phone. Narrow, it kept all its columns and the stops on the way and the destination were squeezed into a ribbon a few letters wide, or pushed past the card's edge. Under 640 px of card, they leave their columns for a row of their own under each departure's times, at full width: the destination, then the stops on the way with their clocks. Wider, the table is unchanged.

## 2.1.2

### Fixed

- An operator's alert is said only while it applies: one of its periods covers the span from now to the next departure, or it has none. Networks publish works weeks ahead, and metro 6 read "Trafic interrompu", badge red, on quiet days for a closure four days off. An alert to come or over now gives no chip, no red badge, and no mark on a stop or a run. The periods come from gtfs2 `refactor/architecture`; on a gtfs2 that does not publish them every alert counts as current, as before.

## 2.1.1

### Fixed

- The README names the gtfs2 branch the fork features run on: `refactor/architecture`. It named `ext/rt-per-source`, which never wrote the timetable files the journeys read past a sensor's ten runs. The card itself is unchanged.

## 2.1.0

### Added

- What an operator says of a stop is read where that stop is: a mark beside it on the journey timeline and in the board's Via column, a disc over it on the map, and the sentence itself in the map's tooltip. An alert whose words do not name the place is prefixed with the stops it lists, and an alert published on both ends of a sensor is said once.

### Fixed

- The base map is back. VersaTiles renamed the two styles the card draws: `graybeard` is `gray`, `shadow` is `gray-dark`. The old names still answer, with a redirect; the card asks for the names as they stand.
- A line picked from its badge is drawn whole, between its sensor's two ends, with every stop the card's trips get on it or off it. It was drawn only as far as the first change of the first way found riding it.
- The map's stop tooltip closes. It never has: `.map-tip` sets a display of its own, which beats the browser's rule for `[hidden]`, and closing the tooltip is setting that attribute. It closes now, and on the three occasions it also missed: the map dragged under it, the cursor leaving the map, and a refresh replacing the stop the cursor was over. Where it does not fit over the stop it goes under it, instead of drawing itself onto the board above.
- The mark of an alert on the map follows the marker it sits on, and is never smaller than a station's disc.

## 2.0.0

### Breaking

- `journey:`, its `margin` and the card-level `journey_margin` are gone. `lines` lists the sensors you ride, each once, with the settings of its line; where you go is `trips: [[from, to], ...]`, and the card finds the ways itself. See [Lines and journeys](README.md#lines-and-journeys).
- `departures_view` is gone: the Lines view is always a table, the Journeys view always a list. A `departures_view:` left in a YAML is ignored.
- `language` and its selector in the editor are gone: the card and its editor speak the language of the Home Assistant user profile, English when it is not one of theirs. A `language:` left in a YAML is ignored.

### Added

- **Trips**: say where you go, from a place to another, and the card finds the ways on its lines, changes included, both ways round. The stops come from the route shapes gtfs2 exports; a change is made where two lines call at the same place, directly at the same stop, on foot between two stops of one place, timed on the distance. No way passes a place twice, rides a sensor twice, gets off a vehicle that goes on to where the next one is left, or boards a vehicle after it went through a place the way has already been; where two lines share a stretch, every station of it is a change and the board keeps the one that arrives first. `max_changes` (5) caps the changes, `max_transfer_wait` (120 min) the wait at one. A trip may end part way along a line (`[Les Aubrais, Paris Austerlitz]`).
- **Journeys header**: a Departure row and an Arrival row, and the ways to leave for the arrival picked, each a filter of the board. Trips sharing a `name` are one arrival, the return files itself under its own departure, `places` merges platforms the feed keeps apart, and `destination_color` sets an arrival's colour. The choices are remembered per browser.
- **Lines / Journeys** toggle in the header, remembered per browser. In the Lines view, each departure gives its time at the stops where the trips get on or off its line.
- **Runs past the sensor's list**: when gtfs2 names a timetable file (`timetable_file`), a change is looked for past the ten runs the sensor lists, on schedule, up to two days ahead. A leg with no run left says when its next one is, or that none is published up to the feed's last day; without the file, the note says how far the sensor's list reaches.
- **What the feed strikes out**: cancelled runs and runs not stopping stay on the board, struck through, for five minutes past their time; a stop a run skips says so on the journey's timeline.
- **Alerts on runs**: an operator alert naming departures marks those rows, with its sentence in the tooltip and under the board.
- **Boarding rules**: a way never boards a line where no run takes anybody on, nor leaves it where none sets anybody down; a run that takes nobody on where you board is not offered, and one that sets nobody down where you get off has no arrival.
- A replacement coach on a train line is shown with its own mode, and realtime times are paired with their own trip when gtfs2 names it, whatever the delay.
- **Visual editor**: Lines, Trips and Places sections. Every line, trip and place is folded to a summary and built when it is opened, three or fewer open; a trip's ends are picked among the places and stops of the lines, and its summary counts the ways the card finds for it, in red when it finds none.

### Changed

- The table spreads its columns over a wide card instead of packing them on the left, and on a narrow card the destination and the stops on the way wrap instead of scrolling sideways.
- The README states which features need attributes that stock gtfs2 does not publish yet (branch `ext/rt-per-source` of Pulpyyyy/gtfs2), and every screenshot is retaken.

### Performance

- A burst of sensor updates is drawn once instead of once per sensor: 60 sensors updating together went from 3.3 s of blocked page to about 0.15 s.
- The realtime dot's pulse runs on the compositor: an idle card no longer restyles itself 60 times a second.
- The Journeys header reads each sensor and chains each journey once per drawing instead of once per chip.
- The editor no longer redraws its fields each time a sensor updates, and switches to YAML and back without freezing on a card of forty lines. Its preview waits for a pause in the typing before drawing the card again, reads its files once instead of polling them, and shows no vehicles.
