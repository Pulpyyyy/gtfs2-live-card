#!/usr/bin/env python3
"""Extract the fixed part of the network from the TAO GTFS: the line shapes,
their ordered stops, and the stop each screenshot watches from.

This is the half of the data that does not move, so it is pulled once and
committed. The vehicles that ride these lines are a different matter, and are
photographed separately: see snapshot.py.

    python docs/data/routes.py

Writes docs/data/stops.json. The GTFS archive is ~20 MB and is downloaded to a
temporary file rather than kept.
"""

import csv
import io
import json
import tempfile
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
GTFS = "https://chouette.enroute.mobi/api/v1/datas/keolis_orleans/gtfs.zip"

# One representative trip shape per line, picked as the most frequent one in
# each direction: the shape a rider actually sees most of the day.
LINES = {
    "ORLEANS:Line:A":  {"file": "tram-a", "short": "A",  "shape": "HOP1-HAC1-BOL1-VER2"},
    "ORLEANS:Line:B":  {"file": "tram-b", "short": "B",  "shape": "POM2-TFN2-MLK2-HAM1"},
    "ORLEANS:Line:40": {"file": "bus-40", "short": "40", "shape": "GARE-GARMB-EUV-PME"},
}

# The stop each line is watched from, matched on its name: TAO gives each
# platform of a stop its own id, and which one a trip calls at depends on the
# direction, so an id would break every time the chosen shape changes.
#
# Orléans station for the bus and for tram A, which stops there. Tram B does
# not reach the station, so it is watched from Halmagrand, its nearest stop,
# 373 m away.
REFERENCE = {
    "ORLEANS:Line:A":  "Gare d'Orléans",
    "ORLEANS:Line:B":  "Halmagrand",
    "ORLEANS:Line:40": "Gare d'Orléans",
}


def rows(z, name):
    with z.open(name) as f:
        yield from csv.DictReader(io.TextIOWrapper(f, encoding="utf-8-sig"))


def main():
    print(f"downloading {GTFS} …")
    with tempfile.NamedTemporaryFile(suffix=".zip", delete=False) as tmp:
        with urllib.request.urlopen(GTFS, timeout=180) as r:
            tmp.write(r.read())
        path = tmp.name
    z = zipfile.ZipFile(path)
    print(f"  {sum(i.file_size for i in z.infolist()) / 1e6:.0f} MB uncompressed")

    routes = {r["route_id"]: r for r in rows(z, "routes.txt") if r["route_id"] in LINES}
    for rid, r in routes.items():
        print(f"  {r['route_short_name']:>2}  {r['route_long_name']}  "
              f"#{r['route_color']}  type={r['route_type']}")

    # the first trip riding each chosen shape stands for the whole line
    rep = {}
    for t in rows(z, "trips.txt"):
        meta = LINES.get(t["route_id"])
        if meta and t["shape_id"] == meta["shape"] and t["route_id"] not in rep:
            rep[t["route_id"]] = t
    if len(rep) != len(LINES):
        missing = sorted(set(LINES) - set(rep))
        raise SystemExit(f"no trip found for {missing}: the shape ids in LINES "
                         "are stale, re-pick them from trips.txt")

    wanted_shapes = {m["shape"] for m in LINES.values()}
    shapes = defaultdict(list)
    for s in rows(z, "shapes.txt"):
        if s["shape_id"] in wanted_shapes:
            shapes[s["shape_id"]].append(
                (int(s["shape_pt_sequence"]), float(s["shape_pt_lon"]), float(s["shape_pt_lat"])))

    stops = {s["stop_id"]: s for s in rows(z, "stops.txt")}

    # stop_times.txt is ~330 MB: read it once, keeping only our three trips
    trip_of = {t["trip_id"]: rid for rid, t in rep.items()}
    ordered = defaultdict(list)
    with z.open("stop_times.txt") as f:
        rd = csv.reader(io.TextIOWrapper(f, encoding="utf-8-sig"))
        head = next(rd)
        i_trip, i_stop = head.index("trip_id"), head.index("stop_id")
        i_seq = head.index("stop_sequence")
        for row in rd:
            rid = trip_of.get(row[i_trip])
            if rid:
                ordered[rid].append((int(row[i_seq]), row[i_stop]))

    out = {}
    for rid, meta in LINES.items():
        seq = sorted(ordered[rid])
        line_stops = []
        for n, sid in seq:
            s = stops.get(sid)
            if not s or not s.get("stop_lat"):
                continue
            line_stops.append({
                "stop_id": sid,
                "stop_name": s["stop_name"],
                "stop_sequence": n,
                "lat": float(s["stop_lat"]),
                "lon": float(s["stop_lon"]),
            })
        want = REFERENCE[rid]
        # a platform is named "<stop> - Quai E", so match on the prefix
        ref = next((s for s in line_stops
                    if s["stop_name"] == want or s["stop_name"].startswith(want + " -")), None)
        if ref is None:
            raise SystemExit(f"{meta['short']}: no stop named {want!r} on the "
                             f"{meta['shape']} trip any more")
        r = routes[rid]
        out[meta["file"]] = {
            "short_name": r["route_short_name"],
            "long_name": r["route_long_name"],
            "color": "#" + r["route_color"],
            "route_type": int(r["route_type"]),
            "route_id": rid,
            "direction_id": int(rep[rid]["direction_id"]),
            "reference": ref,
            "origin": line_stops[0]["stop_name"],
            "terminus": line_stops[-1]["stop_name"],
            "shape": [[lon, lat] for _, lon, lat in sorted(shapes[meta["shape"]])],
            "stops": line_stops,
        }
        print(f"  {meta['short']:>2}: {len(line_stops)} stops, "
              f"{len(out[meta['file']]['shape'])} shape points, "
              f"watched at {ref['stop_name']}")

    dest = HERE / "stops.json"
    dest.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")),
                    encoding="utf-8")
    print(f"\nwrote {dest.name} ({dest.stat().st_size / 1024:.0f} kB)")
    Path(path).unlink(missing_ok=True)


if __name__ == "__main__":
    main()
