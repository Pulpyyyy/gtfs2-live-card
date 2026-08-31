# Screenshots

Generated, not exported by hand. See [CAPTURES.md](CAPTURES.md) for the whole
procedure; in short:

```bash
python docs/shots.py             # every page, light and dark
```

The files land in `../images/`, named `<page>-<mode>.png`, one pair per page:

| Page | What it shows |
|---|---|
| `hero` | the three lines together, departures board and map |
| `lines` | one card per line, side by side |
| `departures` | the board alone, map collapsed |
| `map` | the map alone, vehicles on their shapes |
| `noposition` | a source with no realtime: the route and its stops, no vehicle |
| `selected` | one line picked from its header badge |
| `popup` | one vehicle tracked, its bubble open |
| `narrow` | a sidebar-width column |
| `editor` | the visual editor, sections open |
| `badges` | the badge marks, one per state: the README's legend |

The main README uses `hero-light`, `selected-light`, `popup-light` and
`badges-light`.

No personal information is visible: the data is a frozen snapshot of the public
TAO feed, kept under `data/`.
