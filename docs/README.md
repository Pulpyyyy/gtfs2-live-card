# Screenshots

Generated, not exported by hand. See [CAPTURES.md](CAPTURES.md) for the whole
procedure; in short:

```bash
python docs/shots.py             # every page, light and dark
```

The files land in `../images/`, named `<page>-<mode>.png`, one pair per page —
except `pips`, whose sheet is cut into one `pip-<name>-<mode>.png` per round
mark:

| Page | What it shows |
|---|---|
| `hero` | the three lines together, departures board and map |
| `lines` | one card per line, side by side |
| `departures` | the board alone, map collapsed |
| `map` | the map alone, vehicles on their shapes |
| `noposition` | a source with no realtime: the route and its stops, no vehicle |
| `entete12` | the header at three sizes: badge rows born from the content |
| `pips` | the round badge marks, one small image per mark, plus four whole-badge position schematics: the README's legend |
| `selected` | one line picked from its header badge |
| `popup` | one vehicle tracked, its bubble open |
| `narrow` | a sidebar-width column |
| `editor` | the visual editor, sections open |

The main README uses `hero-light`, `selected-light`, `popup-light`,
`editor-light`, and every `pip-*` pair (light and dark, switched by the
reader's theme).

No personal information is visible: the data is a frozen snapshot of the public
TAO feed, kept under `data/`.
