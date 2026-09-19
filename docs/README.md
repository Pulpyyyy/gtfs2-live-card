# Screenshots

Generated, not exported by hand. See [CAPTURES.md](CAPTURES.md) for the whole
procedure; in short:

```bash
python docs/shots.py             # every page, light and dark
```

The files land in `../images/`, named `<page>-<mode>.png`, one pair per page,
except `pips`, whose sheet is cut into one `pip-<name>-<mode>.png` per round
mark. Every image is used by the main README.

| Page | What it shows |
|---|---|
| `hero` | the three lines together, Lines view: badges, departures board and map |
| `selected` | tram A picked from its badge: board, shape and vehicles narrowed to it |
| `journey` | two trips on one board: L'Indien → Halmagrand found on trams A then B, the change open on its timeline, and bus 40 |
| `destinations` | the Journeys header: three departures, an arrival reached two ways, the return under its own departure, an alert, a forced colour |
| `struck` | a cancelled run, one not stopping, alerts on their rows; a skipped stop on the timeline of a trip |
| `boarding` | a trip boarded and left part way along tram A: runs that take nobody on or set nobody down there |
| `board` | the departures as a timetable (Lines view) |
| `popup` | one vehicle tracked, its popup open |
| `editor` | the visual editor, sections open |
| `pips` | the round marks of chips and badges, one small image per mark, plus four whole-chip position schematics |

The harness has more pages than these (`lines`, `departures`, `map`,
`noposition`, `entete12`, `narrow`, `combos`, `paris`): they are test pages,
opened in a browser with `?page=<name>`, and are not photographed.

No personal information is visible: the data is a frozen snapshot of the public
TAO feed, kept under `data/`.
