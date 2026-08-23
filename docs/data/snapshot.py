#!/usr/bin/env python3
"""Fige un instant du réseau TAO d'Orléans pour la documentation.

Les captures d'écran ont besoin de vrais véhicules à de vraies positions, mais
un flux temps réel ne se rejoue pas: il faut donc en garder une photo. Ce
script prend celle-ci et n'en conserve que les lignes de la documentation
(tram A, tram B, bus 40), le reste du réseau n'ayant rien à faire dans le
dépôt.

    python docs/data/snapshot.py            photographie l'instant présent
    python docs/data/snapshot.py --keep 6   garde au plus 6 véhicules par ligne

Écrit dans docs/data/ un GeoJSON de positions par ligne, plus departures.json
(les prochains passages à l'arrêt de référence, tels qu'annoncés au moment de
la photo). Les tracés et les arrêts, eux, viennent du GTFS et ne bougent pas:
voir routes.py.
"""

import argparse
import json
import struct
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
RT_VEHICLES = "https://ara-api.enroute.mobi/tao/gtfs/vehicle-positions"
RT_TRIPS = "https://ara-api.enroute.mobi/tao/gtfs/trip-updates"

# The three lines the documentation shows, and the file each one is saved as.
# Everything else in the feed is dropped: a snapshot of the whole network would
# be megabytes of vehicles no screenshot ever displays.
LINES = {
    "ORLEANS:Line:A": {"file": "tram-a", "short": "A"},
    "ORLEANS:Line:B": {"file": "tram-b", "short": "B"},
    "ORLEANS:Line:40": {"file": "bus-40", "short": "40"},
}


# ── minimal protobuf reader ──────────────────────────────────────────────
# GTFS-RT is protobuf, and the official bindings are a compiled dependency
# this repository has no other use for. The wire format is simple enough to
# read directly: a field is a varint key (number << 3 | type) then a payload.

def _varint(b, i):
    r = s = 0
    while True:
        x = b[i]
        i += 1
        r |= (x & 0x7F) << s
        if not x & 0x80:
            return r, i
        s += 7


def fields(b, start=0, end=None):
    """Yield (field number, wire type, value) for one protobuf message."""
    i, end = start, len(b) if end is None else end
    while i < end:
        key, i = _varint(b, i)
        num, wt = key >> 3, key & 7
        if wt == 0:
            v, i = _varint(b, i)
        elif wt == 1:
            v = struct.unpack_from("<d", b, i)[0]
            i += 8
        elif wt == 2:
            n, i = _varint(b, i)
            v = b[i:i + n]
            i += n
        elif wt == 5:
            v = struct.unpack_from("<f", b, i)[0]
            i += 4
        else:
            raise ValueError(f"unsupported wire type {wt}")
        yield num, wt, v


def one(msg, num):
    """The first field `num` of a message, or None."""
    for n, _, v in fields(msg):
        if n == num:
            return v
    return None


def text(v):
    return v.decode("utf-8", "replace") if isinstance(v, bytes) else v


def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "gtfs2-live-card-docs"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read()


# ── the feed, as this project reads it ───────────────────────────────────
# Field numbers come from gtfs-realtime.proto: FeedEntity.vehicle = 4,
# VehiclePosition.trip = 1 / position = 2 / timestamp = 5 / vehicle = 8,
# TripDescriptor.trip_id = 1 / route_id = 5 / direction_id = 6,
# Position.latitude = 1 / longitude = 2 / bearing = 3.

def vehicles(pb):
    """Every vehicle in the feed, as plain dicts."""
    out = []
    for n, _, entity in fields(pb):
        if n != 2:          # FeedMessage.entity
            continue
        veh = one(entity, 4)
        if veh is None:     # a trip update, not a position
            continue
        trip, pos, vid, stamp = one(veh, 1), one(veh, 2), one(veh, 8), None
        for a, _, b in fields(veh):
            if a == 5:
                stamp = b
        if pos is None:
            continue
        p = dict((a, b) for a, _, b in fields(pos))
        t = dict((a, b) for a, _, b in fields(trip)) if trip else {}
        out.append({
            "id": text(one(vid, 1)) if vid else "",
            "route_id": text(t.get(5, b"")),
            "trip_id": text(t.get(1, b"")),
            "direction_id": t.get(6),
            "lat": p.get(1),
            "lon": p.get(2),
            "bearing": p.get(3),
            "timestamp": stamp,
        })
    return out


def departures(pb, stop_ids, routes):
    """Upcoming departures at the reference stops, per route.

    Only the stops the documentation actually shows are kept, and only for the
    three lines: a trip update carries every stop of every trip, which is where
    the feed's two megabytes come from.
    """
    found = {}
    for n, _, entity in fields(pb):
        if n != 2:
            continue
        upd = one(entity, 3)        # FeedEntity.trip_update
        if upd is None:
            continue
        trip = one(upd, 1)
        t = dict((a, b) for a, _, b in fields(trip)) if trip else {}
        route = text(t.get(5, b""))
        if route not in routes:
            continue
        for a, _, stu in fields(upd):
            if a != 2:              # TripUpdate.stop_time_update
                continue
            s = dict((x, z) for x, _, z in fields(stu))
            sid = text(s.get(4, b""))   # stop_id
            if sid not in stop_ids:
                continue
            dep = s.get(3)              # StopTimeEvent departure
            if not isinstance(dep, bytes):
                continue
            d = dict((x, z) for x, _, z in fields(dep))
            when, delay = d.get(2), d.get(1)    # time, delay
            if when is None:
                continue
            found.setdefault(route, []).append({
                "stop_id": sid,
                "time": int(when),
                "delay": int(delay) if delay is not None else None,
                "trip_id": text(t.get(1, b"")),
            })
    for route in found:
        found[route].sort(key=lambda x: x["time"])
    return found


# ── writing the snapshot ─────────────────────────────────────────────────

def geojson(vehs, short):
    """The positions file the card fetches, in the shape gtfs2 exports it."""
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [round(v["lon"], 6), round(v["lat"], 6)]},
                "properties": {
                    "vehicle_id": v["id"],
                    "route_id": v["route_id"],
                    "route_short_name": short,
                    "trip_id": v["trip_id"],
                    "bearing": v["bearing"],
                },
            }
            for v in vehs
        ],
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--keep", type=int, default=8,
                    help="most vehicles to keep per line (default 8)")
    ap.add_argument("--force", action="store_true",
                    help="write the snapshot even if a line has no vehicle")
    args = ap.parse_args()

    stops = json.loads((HERE / "stops.json").read_text(encoding="utf-8"))
    # the stop each line is watched from, in the screenshots
    ref = {r: v["stop_id"] for r, v in
           ((r, stops[LINES[r]["file"]]["reference"]) for r in LINES)}

    print("fetching vehicle positions…")
    vpb = get(RT_VEHICLES)
    allv = vehicles(vpb)
    print(f"  {len(allv)} vehicles in the feed")

    # A line with no vehicle is almost always the hour, not a bug: TAO buses
    # start around 6 am and the trams a little earlier, so a snapshot taken at
    # night photographs an empty network and the screenshots come out bare.
    empty = [m["short"] for r, m in LINES.items()
             if not any(v["route_id"] == r for v in allv)]
    if empty and not args.force:
        raise SystemExit(
            f"no vehicle running on line {', '.join(empty)} right now.\n"
            "Take the snapshot during service hours, or pass --force to keep "
            "an empty line anyway.")

    snapshot = {
        "taken_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        "source": "Orléans Métropole / Keolis, GTFS-RT du réseau TAO",
        "lines": {},
    }

    for route, meta in LINES.items():
        mine = [v for v in allv if v["route_id"] == route][:args.keep]
        path = HERE / f"{meta['file']}.json"
        path.write_text(json.dumps(geojson(mine, meta["short"]),
                                   ensure_ascii=False, separators=(",", ":")),
                        encoding="utf-8")
        snapshot["lines"][meta["file"]] = {"vehicles": len(mine)}
        print(f"  {meta['short']:>2}: {len(mine)} vehicles -> {path.name}")

    print("fetching trip updates…")
    tpb = get(RT_TRIPS)
    deps = departures(tpb, set(ref.values()), set(LINES))
    out = {}
    for route, meta in LINES.items():
        rows = deps.get(route, [])[:6]
        out[meta["file"]] = rows
        snapshot["lines"][meta["file"]]["departures"] = len(rows)
        print(f"  {meta['short']:>2}: {len(rows)} departures at {ref[route]}")

    (HERE / "departures.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    (HERE / "snapshot.json").write_text(
        json.dumps(snapshot, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"\nsnapshot taken at {snapshot['taken_at']}")


if __name__ == "__main__":
    main()
