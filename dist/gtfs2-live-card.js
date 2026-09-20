const CARD_VERSION = "2.1.0";

console.info(
    `%c 🧭 GTFS2 Live Card %c v${CARD_VERSION} %c`,
    "background:#2196F3;color:white;padding:2px 8px;border-radius:3px 0 0 3px;font-weight:bold",
    "background:#4CAF50;color:white;padding:2px 8px;border-radius:0 3px 3px 0",
    "background:none"
);

/* ═══════════════════════════════════════════════════════════════════════════
 * GTFS2 Live Card: two collapsible panes,
 *   1. departures merged from one or several gtfs2 start/stop sensors
 *      (schedule + realtime + delays, line badges, alerts)
 *   2. a slippy map (OpenStreetMap tiles, Web-Mercator) of one or several lines:
 *      route shapes with direction arrows, stops, origin stations, realtime
 *      vehicles; per-bus focus and per-line highlight from the header badges
 *
 * Minimal config: a list of gtfs2 sensors; everything else (positions file,
 * route file, official line name and color, origin station) derives from the
 * sensor attributes, with explicit YAML values always overriding.
 *
 * i18n: all user-facing strings exist in en, fr, de, es and pt (the gtfs2
 * project languages), in the language of the user's Home Assistant
 * profile. A visual editor is provided for the simple, sensors-list
 * configuration.
 *
 * LAYOUT: this file plus one module per language in ./lang/, card and editor
 * strings together, loaded at runtime from wherever this file was installed.
 * There is no build step: edit either and reload.
 * ═══════════════════════════════════════════════════════════════════════════ */

const DEFAULTS = {
    title: null,
    line: null,
    line_color: "#0072bc",
    station_color: null,      // default: HA accent color
    positions_url: null,      // optional: realtime is not required for the map
    route_url: null,          // default: route_geojson_file, else positions_url with "_route.json"
    lines: null,              // list of entity_ids and/or {entity?, positions_url?, route_url?, line?, color?}
    mode_icons: true,         // mode chip (mdi) on the line badges
    show_duration: false,     // theoretical journey time on each departure row
    // A pane can be COLLAPSED, which the card remembers per user, or hidden
    // outright, which is the dashboard's decision and sticks for everyone:
    // a departures-only card in a column, a map-only card next to it.
    show_departures: true,    // the departures pane, its header included
    show_map: true,           // the map pane, its header included
    map_style: "auto",        // auto | light | dark | custom template with {z}/{x}/{y}
    map_aspect: null,         // e.g. "4/3", overrides the responsive default
    latitude: null,           // optional station marker fallback
    longitude: null,
    refresh: 60,
    max_departures: 4,
    max_transfer_wait: 120,   // minutes: a change waiting longer is no run to offer
    max_changes: 5,           // changes on a way the card finds for a trip (see planTrips)
};

// The keys a line entry takes for its overrides, which a journey leg takes
// too: a sensor ridden in the journey is declared there, once
const LINE_KEYS = ["line", "color", "line_color", "positions_url", "route_url"];

// the colours of lines their feed gives none, taken in turn: two such lines
// never share one. Dark enough for white text, far from the usual red
const FALLBACK_COLORS = ["#0072bc", "#7b3fa0", "#00897b", "#c2185b", "#6d4c41", "#455a64"];

// A gtfs2 sensor that follows a trip - the departures from one stop towards
// another, which a line of the card is drawn from. The integration also
// makes a sensor per stop around a tracked device, its departures keyed by
// line, and one for its realtime feed: neither is a trip.
const isTripSensor = (id, st) => String(id).startsWith("sensor.") && !!st?.attributes
    && ("origin_station_stop_id" in st.attributes || "next_departures" in st.attributes)
    && !("device_tracker_id" in st.attributes);

// Every line of a card, [{legs: [{entity, via, getOn, getOff, over}]}], in
// the order given: a gtfs2 sensor, or an object naming one with the
// settings of its line (LINE_KEYS), or a line with no sensor, its vehicles
// from a positions file alone. A card of one sensor, entity:, is a list of
// one. Each is one leg ridden from the sensor's origin to its destination:
// the shape the journeys found for the trips are read in too.
const cardEntries = (config) => {
    const out = [];
    const lines = Array.isArray(config?.lines) && config.lines.length ? config.lines
        : config?.entity || config?.positions_url
            ? [{ entity: config.entity, positions_url: config.positions_url, route_url: config.route_url, line: config.line }]
            : [];
    for (const e of lines) {
        const o = typeof e === "string" ? { entity: e } : e && typeof e === "object" ? e : null;
        if (!o) continue;
        const over = {};
        for (const k of LINE_KEYS) if (o[k] != null && o[k] !== "") over[k] = o[k];
        if (!o.entity && !Object.keys(over).length) continue;
        out.push({ legs: [{ entity: o.entity ? String(o.entity) : null, via: [], getOn: null, getOff: null, over }] });
    }
    return out;
};

// The journeys of a card, [{name, legs, destColor}]: the ways its trips are
// ridden, as planTrips found them on the route shapes. A card without trips
// has none: its lines share one departures board.
const journeysOf = (config, planned) => (tripsOf(config).length && planned ? planned : []);

// The trips of a card, [{from, to, name, destColor}]: where the rider goes,
// written [from, to] or {from, to, name, destination_color}. The card finds
// the ways itself (planTrips), both ways round.
const tripsOf = (config) => (Array.isArray(config?.trips) ? config.trips : []).map((t) => {
    const o = Array.isArray(t) ? { from: t[0], to: t[1] } : t && typeof t === "object" ? t : null;
    if (!o || o.from == null || o.to == null || !String(o.from).trim() || !String(o.to).trim()) return null;
    const txt = (v) => (v != null && String(v).trim() !== "" ? String(v) : null);
    return { from: String(o.from).trim(), to: String(o.to).trim(), name: txt(o.name), destColor: txt(o.destination_color) };
}).filter(Boolean);

// How many changes a way may have, unless the card says otherwise: enough
// for a bus, a tram, a train and three metros
const MAX_CHANGES = DEFAULTS.max_changes;

// The ways a card's trips can be ridden, as journeys the rest of the card
// reads like any other: [{name, legs: [{entity, getOn, getOff, via, over}],
// destColor, planned}].
//
// rides are the card's sensors, each with its stops in riding order from
// its origin to its destination, [{entity, stops: [{name, key, board,
// alight}]}]: the stops its route shape draws between the two, or its two
// ends alone when it has none. key is the place a stop reads as (see
// placeResolver). A way is a chain of rides, each boarded where the one
// before is left - the same place - from the trip's start to its end. Each
// trip is searched both ways round: the return comes with it.
//
// What is never offered: a place passed twice, ridden through or changed
// at - but where two lines share a stretch (the 6 and the 4 share
// Denfert-Rochereau and Raspail), the second may ride back over it: each
// station of it is a change, and the board keeps whichever arrives first
// (see _journeySections); a sensor ridden twice; a stop where the line takes nobody on or sets
// nobody down; more than maxChanges changes; a change off a vehicle that
// goes on to where the next one is left - staying on is the same way,
// without the change; and a vehicle boarded after it went through a place
// the way has already been - it could have been boarded there, the same
// run, and the ride before it was a detour.
const planTrips = (trips, rides, placeOf, maxChanges = MAX_CHANGES) => {
    const boardAt = new Map();
    for (const r of rides) {
        r.stops.forEach((st, i) => {
            if (i === r.stops.length - 1 || !st.board || !st.key) return;
            if (!boardAt.has(st.key)) boardAt.set(st.key, []);
            boardAt.get(st.key).push({ r, i });
        });
    }
    // whether a ride, past where it is left, reaches a place
    const goesOn = (ride, key) => ride.r.stops.slice(ride.j + 1).some((st) => st.key === key);
    const ways = (fromKey, toKey) => {
        const found = [];
        const walk = (key, path, seen, used) => {
            for (const { r, i } of boardAt.get(key) || []) {
                if (used.has(r.entity)) continue;
                if (r.stops.slice(0, i).some((st) => seen.has(st.key))) continue;
                const prev = path[path.length - 1];
                // the stretch the previous ride shares with this one, which
                // this one may ride back over, never leave it on - short of
                // where the previous one was boarded: going back there is
                // going back, not changing
                const shared = new Set(prev ? prev.r.stops.slice(prev.i + 1, prev.j + 1).map((st) => st.key) : []);
                const passed = new Set(seen);
                for (let j = i + 1; j < r.stops.length; j++) {
                    const st = r.stops[j];
                    if (!st.key) break;
                    if (passed.has(st.key)) {
                        if (shared.has(st.key)) continue;
                        // a place already behind: the ride cannot go through it
                        break;
                    }
                    passed.add(st.key);
                    if (!st.alight) continue;
                    if (prev && goesOn(prev, st.key)) continue;
                    const next = [...path, { r, i, j }];
                    // the end: a way goes no further than where it is going
                    if (st.key === toKey) { found.push(next); break; }
                    if (next.length <= maxChanges) walk(st.key, next, new Set(passed), new Set([...used, r.entity]));
                }
            }
        };
        walk(fromKey, [], new Set([fromKey]), new Set());
        return found;
    };
    const out = [];
    const sig = new Set();
    for (const t of trips) {
        const a = placeOf(t.from).key, b = placeOf(t.to).key;
        if (!a || !b || a === b) continue;
        for (const [from, to] of [[a, b], [b, a]]) {
            for (const way of ways(from, to)) {
                const legs = way.map(({ r, i, j }) => ({
                    entity: r.entity, via: [], over: {},
                    getOn: i === 0 ? null : r.stops[i].name,
                    getOff: j === r.stops.length - 1 ? null : r.stops[j].name,
                }));
                const k = legs.map((l) => `${l.entity}|${l.getOn}|${l.getOff}`).join(">");
                if (sig.has(k)) continue;
                sig.add(k);
                out.push({ name: t.name, legs, destColor: t.destColor, planned: true });
            }
        }
    }
    return out;
};

// A name as the header reads it: the place of `places` that holds it, else
// its own placeKey. {key, name}
const placeResolver = (places) => {
    const pmap = new Map();
    if (places && typeof places === "object" && !Array.isArray(places)) {
        for (const [name, stops] of Object.entries(places)) {
            const at = { key: `p:${placeKey(name)}`, name: String(name) };
            for (const st of [name, ...(Array.isArray(stops) ? stops : [stops])]) {
                const k = placeKey(st);
                if (k && !pmap.has(k)) pmap.set(k, at);
            }
        }
    }
    return (n) => pmap.get(placeKey(n)) || { key: placeKey(n), name: n };
};

// Where a sensor's route shape is served, by the card's own rule minus its
// memory of past states: the override, the file the integration names, the
// companion of the positions file it names, else the route and direction
// ids spelled the way gtfs2 spells its file names. What the editor reads a
// line's stops from.
const routeUrlOf = (hass, entity, over = {}) => {
    if (over.route_url) return over.route_url;
    const at = hass?.states?.[entity]?.attributes || {};
    const rfile = attrVal(at, "route_geojson_file");
    if (rfile) return "/local/gtfs2/" + rfile;
    const file = attrVal(at, "vehicle_positions_file");
    if (file) return "/local/gtfs2/" + String(file).replace(/\.json$/, "_route.json");
    const rid = attrVal(at, "route_route_id", "route_id");
    const dir = attrVal(at, "trip_direction_id", "direction_id");
    if (rid != null && dir != null) return `/local/gtfs2/${safeFilePart(rid)}_${safeFilePart(dir)}_route.json`;
    return over.positions_url ? String(over.positions_url).replace(/\.json$/, "_route.json") : null;
};

// a GTFS clock ("HH:MM:SS", past 24:00 after midnight) as seconds since the
// service day's midnight, or null
const gtfsSecs = (v) => {
    if (v == null) return null;
    const m = String(v).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0) : null;
};

// The index of a stop in a shape's ordered stops, at or after `from`, by
// the surest clue first: its stop_sequence, its exact id, an id one side
// contains (a platform under its station), its exact name, a name one side
// contains. -1 when nothing matches.
const findStopIdx = (stops, seq, id, name, from) => {
    const sid = id ? String(id).trim() : "";
    const lname = name ? String(name).trim().toLowerCase() : "";
    const nm = (s) => (s.name || "").trim().toLowerCase();
    const tests = [
        seq != null && seq !== "" && Number.isFinite(Number(seq)) ? (s) => Number(s.seq) === Number(seq) : null,
        sid ? (s) => s.id === sid : null,
        sid ? (s) => s.id && (s.id.includes(sid) || sid.includes(s.id)) : null,
        lname ? (s) => nm(s) === lname : null,
        lname ? (s) => nm(s).includes(lname) || (nm(s) && lname.includes(nm(s))) : null,
    ].filter(Boolean);
    for (const t of tests) {
        for (let i = Math.max(0, from || 0); i < stops.length; i++) if (t(stops[i])) return i;
    }
    return -1;
};

// A place name as two feeds, or two platforms of one station, may spell it:
// no case, no accents, punctuation and runs of spaces as one space. What an
// outbound journey and its return are matched on - the names of their ends,
// never their stop ids, which a station keeps one per platform.
const placeKey = (v) => String(v ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

const WORLD = 1 << 28;        // Web-Mercator world size, in "world units"
const EARTH_CIRC = 40075016.686;
const HIST_MAX = 30;
const HIST_TTL = 15 * 60000;  // forget vehicles gone from the feed this long
const STALE_FEED = 8 * 60000;  // a positions file not rewritten this long = the source has gone quiet
// realtime a sensor has not refreshed this long is no longer live: three of
// gtfs2's default quarter hours missed
const RT_STALE = 45 * 60000;
// a run the feed struck out stays on the board this long past its time,
// struck through: the rider who came for the 17:42 reads why it is not there
const STRUCK_KEEP = 5 * 60000;

// One geometry for every corner mark a badge can carry, because a badge can
// carry four of them and marks of different sizes in different corners would
// read as an accident. Only the contents and the colour change.
//
// 28 / 7 / 14 is the largest that clears the number. The dimensioning label is
// NOT the longest one: the badge is a fixed 60 square and the number shrinks to
// fit its 40 usable pixels, so "999B" drops to 17px and its short ink clears
// the corners easily. "40" keeps its full 28px and decides, with 0.7px to
// spare. The gap has to be twice the overhang: with four corners in use, one
// badge's right-hand pip faces the next badge's left-hand pip.
const PIP = 28;                // diameter
// Ink radius: the disc less an optical ring. 1px was the geometric maximum and
// looked wrong - a glyph whose furthest point is a long edge rather than a
// spike (the cable bar, the funicular diagonal, the tram body) reads as
// bursting out of its disc. 2.5px is where every glyph in the set stops
// touching; past 3px they start looking a size too small again.
const PIP_INK = PIP / 2 - 2.5;
// The badge's own corner mark. Kept apart from PIP, which is also the unit
// the glyph viewBox is drawn in: shrinking PIP would take a few per cent off
// every glyph of the card, medallions and plates included, for a change that
// only concerns the badge.
const BADGE_PIP = 22;
const PIP_GAP = 11;            // between badges, = 2 x the 5.5px overhang
// the narrowest the header's text zone is allowed to get before it stops
// sharing a row with the badges and takes one of its own
const TITLES_MIN = 96;

// A badge is a fixed square, and the number shrinks to fit it (badgeFontSize).
// 44 is the smallest square that still answers a finger, and it puts seven
// lines on one row of a 470px card where 60 put six. The padding goes down
// with it, to 6, so the number keeps the 32px of room it had at 60/10 - the
// square shrinks, the digits do not.
const BADGE_W = 44, BADGE_PAD = 6, BADGE_FS = 21;
// Plates a destination chip shows before saying "+N". Two, measured rather
// than guessed: three plates leave some 75px of a 165px column to the place
// name, and "Halmagrand" then breaks mid-word - the name loses more than the
// third plate gains.
const DEST_PLATES = 2;

// The two readings a card offers, drawn rather than named: four plates for
// the lines, two points and a dotted run for the journeys. Small enough to
// sit in a 26px button beside its word.
const MODE_ICON_LINES = `<svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">`
    + `<rect x="2" y="4" width="8" height="7" rx="2" fill="currentColor"/>`
    + `<rect x="2" y="13" width="8" height="7" rx="2" fill="currentColor"/>`
    + `<rect x="13" y="4" width="9" height="7" rx="2" fill="currentColor" opacity=".45"/>`
    + `<rect x="13" y="13" width="9" height="7" rx="2" fill="currentColor" opacity=".45"/></svg>`;
const MODE_ICON_TRIPS = `<svg width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">`
    + `<circle cx="5" cy="19" r="2.6" fill="currentColor"/>`
    + `<circle cx="19" cy="5" r="2.6" fill="currentColor"/>`
    + `<path d="M5.5 16.5 Q 6 9 12 9 T 18.5 7.5" stroke="currentColor" stroke-width="2" fill="none" stroke-dasharray="2.5 2.5"/></svg>`;

// Which reading a card opens on, from what its configuration declares. A
// journey named, cut, chained or given stops to get off at is a journey the
// user described, and the card opens on them; bare sensors are a board of
// lines and open as one. Whatever the user then picks outlives this.
const autoMode = (config) => (tripsOf(config).length ? "trips" : "lines");
// Map text sized in world units: Chrome caps a computed font-size at
// 10000px, which a view a hundred kilometres wide reaches (a 10 px label is
// then some 60000 units), and the label shrinks to a dash. The text is set
// at its pixel size and scaled by the units per pixel instead.
const svgText = (x, y, px, u, attrs, body) =>
    `<text transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) scale(${u})" font-size="${px}" ${attrs}>${body}</text>`;
const BADGE_FS_MIN = 11;

// Font size the number takes so it fits the badge without the badge moving.
// Measured against the real family rather than counted in characters: a per
// character estimate holds for digits, which all share one advance, and comes
// apart on letters - "WWW" is half again as wide as "111" at the same size.
// Falls back on the full size if the canvas is unavailable, in which case the
// badge clips rather than growing, which is still the lesser wrong.
const _fitCtx = (() => {
    try { return document.createElement("canvas").getContext("2d"); }
    catch (e) { return null; }
})();
const badgeFontSize = (label, family) => {
    const usable = BADGE_W - 2 * BADGE_PAD;
    if (!_fitCtx || !label) return BADGE_FS;
    _fitCtx.font = `700 ${BADGE_FS}px ${family || "Roboto, sans-serif"}`;
    const w = _fitCtx.measureText(String(label)).width;
    if (!w || w <= usable) return BADGE_FS;
    return Math.max(BADGE_FS_MIN, Math.floor(BADGE_FS * usable / w * 10) / 10);
};
const LABEL_SPAN = 3000;      // stop names label themselves under this map width (metres)
const MARKER_SPAN_MIN = 600;  // at or under this map width, vehicle markers are full size
const MARKER_SPAN_MAX = 12000;// at or over it, they sit at their smallest
const FOLLOW_MS = 700;        // vehicle glide: CSS transition of .bus, popup glide and camera follow

// cubic-bezier easing, the same curve as the CSS timing functions, so a JS
// animation can run in lockstep with a CSS transition
const bezier = (x1, y1, x2, y2) => {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (t) => ((ax * t + bx) * t + cx) * t;
    const sy = (t) => ((ay * t + by) * t + cy) * t;
    const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
        if (x <= 0) return 0;
        if (x >= 1) return 1;
        let t = x;
        for (let i = 0; i < 8; i++) {
            const d = dx(t);
            if (Math.abs(d) < 1e-6) break;
            t -= (sx(t) - x) / d;
        }
        return sy(Math.max(0, Math.min(1, t)));
    };
};
const EASE_OUT = bezier(0, 0, 0.58, 1);   // CSS "ease-out"
// The base map is MapLibre GL, loaded once per page from a CDN, drawing the
// VersaTiles styles on their public vector tiles (Shortbread schema,
// OpenStreetMap data, CORS open, no key): gray in the light theme,
// gray-dark in the dark one. The card keeps its own camera (the SVG viewBox)
// and MapLibre follows it, so the overlay's geometry, gestures and
// animations are untouched: the canvas only replaced the raster tiles.
const MAPLIBRE_VERSION = "6.9.0";
const MAPLIBRE_JS = `https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.mjs`;
const MAPLIBRE_CSS = `https://cdn.jsdelivr.net/npm/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.css`;
const MAP_STYLES = {
    light: "https://tiles.versatiles.org/assets/styles/gray/style.json",
    dark: "https://tiles.versatiles.org/assets/styles/gray-dark/style.json",
};
const MAP_CREDIT = "© OpenStreetMap contributors";
// source layers left out of the styles: building footprints load the picture
// at street zooms without helping to read a line
const MAP_HIDE_LAYERS = new Set(["buildings"]);
let MAPLIBRE = null;          // promise of the module namespace, shared by every card on the page
function loadMapLibre() {
    if (!MAPLIBRE) {
        MAPLIBRE = import(MAPLIBRE_JS).then((m) => m.default || m);
        // a failed load (offline, blocked CDN) is retried by the next map build
        MAPLIBRE.catch(() => { MAPLIBRE = null; });
    }
    return MAPLIBRE;
}

/* ── i18n ───────────────────────────────────────────────────────────────── */

/* Every language is a file of its own in ./lang/, edited straight there and
 * fetched the first time it is needed. There is no build step and no language
 * baked into this file: en.js is simply the one to copy when adding a new one.
 *
 * `tr()` stays synchronous because every render path calls it, the 30-second
 * countdown tick included, and none of them can await. What makes that safe is
 * that the card does not render at all until its language has landed: see the
 * `_langReady()` guard in _update(). So by the time anything calls `tr()`, the
 * strings are already in.
 *
 * Adding a language: copy ./lang/en.js, translate the values, and add its code
 * to LANGS below. */

const LANGS = ["en", "fr", "de", "es", "pt"];   // the gtfs2 project languages

const LANG = {};

/* Resolved against this file's own URL, so the same code works under
 * /hacsfiles/gtfs2-live-card/ (HACS) and /local/ (manual install) without
 * having to know which one it is. */
const LANG_URL = (code) => new URL(`./lang/${code}.js`, import.meta.url).href;

const LANG_PENDING = new Map();   // code → promise, so five cards fetch once
const LANG_WAITING = new Set();   // elements to notify when a language lands

/* Fetches one language, then tells everything that asked for it to render.
 *
 * A failure is recorded rather than retried: `LANG[code]` is filled with an
 * empty set of tables, which makes `tr()` fall back to the keys themselves. A
 * card showing "departures" is poor, but it is on screen and it says why in
 * the console, where a card blocked forever on a missing file would just be
 * blank. */
const loadLang = (code) => {
    if (LANG[code] || !LANGS.includes(code) || LANG_PENDING.has(code)) return;
    LANG_PENDING.set(code, import(LANG_URL(code))
        .then((mod) => {
            const data = mod?.default;
            if (!data?.strings) throw new Error("no default export with strings");
            LANG[code] = data;
        })
        .catch((err) => {
            console.error(`gtfs2-live-card: could not load ${LANG_URL(code)}, the card `
                + `will show its string keys instead of ${code} text`, err);
            LANG[code] = { strings: {}, modes: {}, editor: {} };
        })
        .finally(() => {
            for (const el of [...LANG_WAITING]) el._langArrived(code);
        }));
};

const tr = (lang, key, vars) => {
    let s = LANG[lang]?.strings?.[key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
    return s;
};

const modeWords = (lang) => LANG[lang]?.modes || {};

const editorLabels = (lang) => LANG[lang]?.editor || {};

const modeWord = (lang, key, plural) => {
    const w = modeWords(lang);
    return (w[key] || w.vehicle || [key, key])[plural ? 1 : 0];
};

// GTFS route_type (incl. extended codes) → mode key
const modeKey = (rt) => {
    const n = parseInt(rt, 10);
    if (!isNaN(n)) {
        if (n === 0 || n === 5 || (n >= 900 && n < 1000)) return "tram";
        if (n === 1 || (n >= 400 && n < 500)) return "metro";
        if (n === 2 || (n >= 100 && n < 200)) return "train";
        // 200 to 209 is Coach Service in the GTFS extended types: a long
        // distance bus, not a train. It rode along as a train for as long as
        // the two glyphs were the same rounded box.
        if (n === 3 || (n >= 200 && n < 300) || (n >= 700 && n < 800)) return "bus";
        if (n === 4 || n === 1000 || n === 1200 || n === 1502) return "ferry";   // 1000 is water transport, 1502 a water taxi
        if (n === 11 || n === 800) return "trolleybus";
        if (n === 6 || n === 1300) return "cable";
        if (n === 7 || n === 1400) return "funicular";
        if (n === 12) return "monorail";
        if (n === 1100) return "air";
        if (n >= 1500 && n < 1600) return "taxi";
        if (n >= 1700 && n < 1800) return "vehicle";   // "miscellaneous", the codes that name nothing
        return "bus";
    }
    const s = String(rt || "").toLowerCase();
    for (const k of ["tram", "metro", "train", "ferry", "trolleybus", "funicular", "monorail", "taxi"]) if (s.includes(k)) return k;
    if (s.includes("métro")) return "metro";
    if (s.includes("rail")) return "train";
    return "bus";
};


// One glyph table for the whole card, drawn for this card rather than taken
// from mdi. mdi draws bus, metro, train and monorail as the same rounded box
// with two windows: legible at 24px, a single blob at the 10px an unfocused
// map marker gets. Here each mode carries its signature on its silhouette,
// where low resolution cannot rub it out: a pantograph over the tram, a beam
// under the monorail, a tunnel arch for the metro, two coupled cars for the
// train. No glyph has a counter either. Window bands are gaps of at least two
// grid units between solid masses, so they close cleanly as the glyph shrinks
// instead of filling in and turning the whole thing grey.
//
// Rendered at 10px, the closest pair of the set sits at 0.21 of average pixel
// distance; the mdi outlines it replaces sat at 0.06 (metro against train),
// and mdi:bus was byte for byte the same path as the fallback vehicle.
//
// The map SVG cannot host an <ha-icon> HTML element, so the badges draw from
// this same table rather than from ha-icon, and a mode looks identical
// wherever it shows up.
const GLYPH_PATHS = {
    bus: "M4.6 6H19.4A1.6 1.6 0 0 1 21 7.6V9.4H3V7.6A1.6 1.6 0 0 1 4.6 6ZM3 11.4H21V15.6A1.6 1.6 0 0 1 19.4 17.2H4.6A1.6 1.6 0 0 1 3 15.6ZM5 17.4A2.4 2.4 0 0 0 9.8 17.4A2.4 2.4 0 0 0 5 17.4ZM14.2 17.4A2.4 2.4 0 0 0 19 17.4A2.4 2.4 0 0 0 14.2 17.4Z",
    trolleybus: "M3.2 1.6H20.8A1.2 1.2 0 0 1 20.8 4H3.2A1.2 1.2 0 0 1 3.2 1.6ZM13.4 8.2H16L9.4 4H6.8ZM4.6 8H19.4A1.6 1.6 0 0 1 21 9.6V11.4H3V9.6A1.6 1.6 0 0 1 4.6 8ZM3 13.4H21V17.4A1.6 1.6 0 0 1 19.4 19H4.6A1.6 1.6 0 0 1 3 17.4ZM5.2 19.2A2.2 2.2 0 0 0 9.6 19.2A2.2 2.2 0 0 0 5.2 19.2ZM14.4 19.2A2.2 2.2 0 0 0 18.8 19.2A2.2 2.2 0 0 0 14.4 19.2Z",
    tram: "M12 2.4L16.6 5.2L12 7.4L7.4 5.2ZM8.2 6.6H15.8A1.6 1.6 0 0 1 17.4 8.2V10.4H6.6V8.2A1.6 1.6 0 0 1 8.2 6.6ZM6.6 12.4H17.4V17.4A1.4 1.4 0 0 1 16 18.8H8A1.4 1.4 0 0 1 6.6 17.4Z",
    metro: "M3 21V13A9 9 0 0 1 21 13V21H17V13A5 5 0 0 0 7 13V21ZM10.6 14H13.4A1.6 1.6 0 0 1 15 15.6V21H9V15.6A1.6 1.6 0 0 1 10.6 14Z",
    train: "M3.2 7.6H11V10.4H2V8.8A1.2 1.2 0 0 1 3.2 7.6ZM2 12.4H11V16.4H3.2A1.2 1.2 0 0 1 2 15.2ZM12.4 7.6H18.8L21.2 10.4H12.4ZM12.4 12.4H22V15.2A1.2 1.2 0 0 1 20.8 16.4H12.4Z",
    monorail: "M9 3.6H15A3.6 3.6 0 0 1 18.6 7.2V7.6H5.4V7.2A3.6 3.6 0 0 1 9 3.6ZM5.4 9.6H18.6V14.4A1.2 1.2 0 0 1 17.4 15.6H6.6A1.2 1.2 0 0 1 5.4 14.4ZM3.2 16.8H20.8A1.4 1.4 0 0 1 22.2 18.2V18.8A1.4 1.4 0 0 1 20.8 20.2H3.2A1.4 1.4 0 0 1 1.8 18.8V18.2A1.4 1.4 0 0 1 3.2 16.8Z",
    ferry: "M2.4 13.6H21.6L18.8 20.4H5.2ZM9 7.6H15A1.4 1.4 0 0 1 16.4 9V11.6H7.6V9A1.4 1.4 0 0 1 9 7.6ZM11.2 3.8H12.8V7.6H11.2Z",
    cable: "M1.8 3.6L22.2 7.8L21.8 9.6L1.4 5.4ZM11.2 6.2H12.8V11.6H11.2ZM9.6 10.6H14.4A3.6 3.6 0 0 1 18 14.2V16.8A3.6 3.6 0 0 1 14.4 20.4H9.6A3.6 3.6 0 0 1 6 16.8V14.2A3.6 3.6 0 0 1 9.6 10.6Z",
    funicular: "M2.4 19.6L20.4 6.4V9.2L2.4 22.4ZM7.1 14.8L14.4 9.5L10.8 4.6L3.6 9.9Z",
    vehicle: "M12 3.2L20.6 21.6L12 18L3.4 21.6Z",
    taxi: "M8.2 3H15.8A1.2 1.2 0 0 1 17 4.2V6.6H7V4.2A1.2 1.2 0 0 1 8.2 3ZM8.4 8.6H15.6L19 12.8H5ZM3.4 12.8H20.6A1.4 1.4 0 0 1 22 14.2V16.6A1.4 1.4 0 0 1 20.6 18H3.4A1.4 1.4 0 0 1 2 16.6V14.2A1.4 1.4 0 0 1 3.4 12.8ZM4.9 18.2A2.2 2.2 0 0 0 9.3 18.2A2.2 2.2 0 0 0 4.9 18.2ZM14.7 18.2A2.2 2.2 0 0 0 19.1 18.2A2.2 2.2 0 0 0 14.7 18.2Z",
    air: "M12 2A2 2 0 0 1 14 4V9.2L22 14V16.6L14 14.2V19.2L16.8 21.2V22.8L12 21.4L7.2 22.8V21.2L10 19.2V14.2L2 16.6V14L10 9.2V4A2 2 0 0 1 12 2Z",
    // Not a mode: the state of a source that has stopped reporting. Drawn to
    // the same rules as the modes so it can share their geometry - two solid
    // masses, no counter, a 4.5 unit gap that stays open as the glyph shrinks.
    // On the axis opposite the resting stroke, which runs "/": two marks that
    // mean different things must not rhyme.
    mute: "M2.97 6.23 L8.77 12.03 L12.03 8.77 L6.23 2.97ZM11.97 15.23 L17.77 21.03 L21.03 17.77 L15.23 11.97Z",
    // Not modes either: when a line that is not running today runs again.
    // Three silhouettes, round / square with tabs / cross, because a
    // silhouette is what survives shrinking - counting masses does not.
    //
    // tomorrow: a filled dial with an open quadrant. Hands would be thin
    // strokes and a rim would be a counter; both close up at this size.
    // days: page, header band and tabs. The 2.6 unit gap between band and
    // page is what holds it away from the vehicle glyphs, which are rounded
    // rectangles too and whose masses touch.
    // never: solid at the centre, which is what separates it from `mute`
    // (two masses with a gap) and from the resting stroke (one thin diagonal
    // across the whole badge).
    tomorrow: "M12 12L12 2.4A9.6 9.6 0 1 0 18.79 18.79Z",
    days: "M7 2.2H9.4V6.8H7ZM14.6 2.2H17V6.8H14.6ZM5.2 5.2H18.8A1.6 1.6 0 0 1 20.4 6.8V9H3.6V6.8A1.6 1.6 0 0 1 5.2 5.2ZM3.6 11.6H20.4V19.8A1.6 1.6 0 0 1 18.8 21.4H5.2A1.6 1.6 0 0 1 3.6 19.8Z",
    never: "M2.8 5.2L18.8 21.2L21.2 18.8L5.2 2.8ZM18.8 2.8L2.8 18.8L5.2 21.2L21.2 5.2Z",
    // Nor are these: what the operator says is going on, top-right corner.
    // Only `alert` is drawn from a sentence; the other two need gtfs2 to
    // publish the alert's GTFS-RT cause, so a network that never fills it in
    // always gets the generic mark and never a cone that would be a lie.
    //
    // alert: an exclamation, upright, no diagonal anywhere, so it cannot rhyme
    // with the quiet-source bars or the resting stroke.
    // incident: a bolt, one mass.
    // works: a cone, its stripe left as an open gap rather than a counter, and
    // its foot merged into the body so the shape survives at 23 px.
    alert: "M9.7 2.8H14.3L13.5 15.6H10.5ZM9.5 19.4A2.5 2.5 0 1 0 14.5 19.4A2.5 2.5 0 1 0 9.5 19.4Z",
    incident: "M13.8 2.2L5.2 13.6H10.4L9.2 21.8L18.6 10.0H13.0Z",
    works: "M10.4 3.0H13.6L15.6 10.2H8.4ZM7.7 13.4H16.3L17.6 18.0H19.6V21.6H4.4V18.0H6.4Z",
};

// the mdi icons that merely restate a mode, first one canonical. The card
// does not draw from these any more, but it still needs to tell an icon the
// integration picked for a route_type from one a user really chose: only the
// second is a decision, and only it deserves to override the mode glyph. One
// name per mode was not enough: the integration emits up to four of them for
// a single mode, which is how 34 route types out of 82 kept rendering an mdi
// outline instead of the glyph they were entitled to.
const MDI_DEFAULTS = {
    bus: ["mdi:bus", "mdi:bus-school"],
    trolleybus: ["mdi:bus-electric", "mdi:bus"],
    tram: ["mdi:tram", "mdi:train-variant"],
    metro: ["mdi:subway-variant", "mdi:subway"],
    train: ["mdi:train", "mdi:train-car", "mdi:train-variant"],
    monorail: ["mdi:train-variant"],
    ferry: ["mdi:ferry"],
    cable: ["mdi:gondola"],
    funicular: ["mdi:stairs-up", "mdi:stairs"],
    taxi: ["mdi:taxi", "mdi:train-variant", "mdi:bicycle-basket", "mdi:car-multiple"],
    air: ["mdi:airplane"],
    vehicle: ["mdi:bus", "mdi:train-car", "mdi:horse-variant"],
};

// Centre of the ink and the distance from it to the furthest painted point,
// per glyph, in the 24-unit grid: [cx, cy, r].
//
// A box was the wrong shape to measure with. Fitting the longest SIDE of the
// box to the disc inscribes the glyph in a square, and a square inside a
// circle leaves the four corners of the disc unused - measured on this set,
// between nothing and 27% of the glyph's size thrown away, the flatter the
// glyph the more. A radius says how far the drawing actually reaches, so the
// glyph can be grown until it touches the disc and no further.
//
// The centre stays the centre of the ink box, exactly where it was: only the
// scale changes, so no glyph shifts inside its pip. Measured by flattening
// each path, arcs included, and taking the extreme point - not by eye.
const GLYPH_FIT = {
    bus: [12.00, 12.90, 10.70],
    trolleybus: [12.00, 11.50, 13.57],
    tram: [12.00, 10.60, 9.29],
    metro: [12.00, 12.50, 12.38],
    train: [12.00, 12.00, 10.56],
    monorail: [12.00, 11.90, 12.58],
    ferry: [12.00, 12.10, 10.73],
    cable: [11.80, 12.00, 13.06],
    funicular: [11.40, 13.50, 12.66],
    vehicle: [12.00, 12.40, 12.59],
    taxi: [12.00, 11.70, 11.30],
    air: [12.00, 12.40, 11.45],
    mute: [12.00, 12.00, 10.72],
    // The one glyph whose centre is NOT its ink box: a slice of disc has lost
    // ink on one side, so the box centre sits at 10.6 and the dial would be
    // pushed off inside its pip - the very thing the rule exists to prevent.
    // Centred on the disc instead, and the reach from there is the radius.
    // Measured either way; this is the one where the rule had to be argued
    // with, and doing so also took the set's floor from 0.445 to 0.509.
    tomorrow: [12.00, 12.00, 9.60],
    days: [12.00, 11.80, 12.10],
    never: [12.00, 12.00, 11.44],
    alert: [12.00, 12.35, 9.82],
    incident: [11.90, 12.00, 10.17],
    works: [12.00, 12.30, 12.01],
};

// Which mark the top-right corner carries, from the alert's own cause and
// effect (gtfs2 publishes them as their GTFS-RT names). Anything unlisted,
// and anything with no cause at all, falls to the generic mark: a cone shown
// for a strike would be worse than a shrug.
const ALERT_WORKS = ["CONSTRUCTION", "MAINTENANCE"];
const ALERT_INCIDENT = ["ACCIDENT", "TECHNICAL_PROBLEM", "POLICE_ACTIVITY", "MEDICAL_EMERGENCY"];
const alertKind = (cause, effect) => (ALERT_WORKS.includes(cause) ? "works"
    : (ALERT_INCIDENT.includes(cause) || effect === "NO_SERVICE") ? "incident"
    : "alert");

// glyph as a plain SVG path, centred on 0,0 and scaled so its ink reaches
// exactly r and no further. Returns null for a key we carry no outline for.
const modeGlyph = (mode, r, fill) => {
    const d = GLYPH_PATHS[mode];
    if (!d) return null;
    const [cx, cy, ri] = GLYPH_FIT[mode] || [12, 12, 12];
    const sc = r / ri;
    return `<path d="${d}" fill="${fill}" transform="scale(${sc.toFixed(4)}) translate(${(-cx).toFixed(2)} ${(-cy).toFixed(2)})"></path>`;
};


// the language of the user's Home Assistant profile, English when the card
// does not speak it: a dashboard is read in its reader's language, never in
// one its author picked
const resolveLang = (hass) => {
    const two = String(hass?.locale?.language || hass?.language || "en").toLowerCase().slice(0, 2);
    return LANGS.includes(two) ? two : "en";
};

/* ── helpers ────────────────────────────────────────────────────────────── */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// the text back from esc, for a message built as HTML and read again as words
const unesc = (s) => String(s ?? "").replace(/&(amp|lt|gt|quot|#39);/g, (m, k) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" }[k]));

// a board reads the same clocks over and over - every chip, every leg file
// stop, every run of a chain - and parsing a date string is not free: kept
// by their text, the Date shared (nothing here ever sets one)
const TS_CACHE = new Map();
const parseTs = (v) => {
    if (v == null || v === "-" || v === "") return null;
    const k = String(v);
    let d = TS_CACHE.get(k);
    if (d === undefined) {
        if (TS_CACHE.size > 20000) TS_CACHE.clear();
        d = new Date(k.replace(" ", "T"));
        if (isNaN(d.getTime())) d = null;
        TS_CACHE.set(k, d);
    }
    return d;
};

// one formatter for the page: toLocaleTimeString builds a new one at each
// call, and a board prints a clock some forty times
const HM_FMT = new Intl.DateTimeFormat([], { hour: "2-digit", minute: "2-digit" });
const fmtHM = (d) => HM_FMT.format(d);

// journey time, the way a timetable prints it: "1 h 04", "12 min"
const fmtDur = (min) => {
    if (!Number.isFinite(min) || min < 0) return "";
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
};

// minutes between two clocks as the board prints them, to the minute with
// the seconds dropped: "20:58 → 21:38" reads 40 min, never 41
const clockMins = (a, b) => Math.floor(b.getTime() / 60000) - Math.floor(a.getTime() / 60000);

const fmtCountdown = (lang, d, now) => {
    const mins = Math.round((d.getTime() - now.getTime()) / 60000);
    if (mins <= 0) return tr(lang, "due");
    if (mins < 60) return tr(lang, "in_min", { n: mins });
    const h = Math.floor(mins / 60), m = mins % 60;
    return m ? tr(lang, "in_h_min", { h, m: String(m).padStart(2, "0") }) : tr(lang, "in_h", { h });
};

const fmtAgo = (lang, ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return tr(lang, "ago_s", { n: s });
    const min = Math.round(s / 60);
    // "9 h 12 ago" reads where "552 min ago" has to be worked out
    return min < 60 ? tr(lang, "ago_min", { n: min }) : tr(lang, "ago_dur", { t: fmtDur(min) });
};

// read the first usable value among several attribute spellings; gtfs2
// slugifies its Route/Trip table dumps ("route_route_id"), stringifies
// missing values to "None", and the fork may add unprefixed attributes
const attrVal = (at, ...names) => {
    for (const n of names) {
        const v = at?.[n];
        if (v != null && v !== "" && v !== "None") return v;
    }
    return null;
};

// a route or direction id, spelled the way gtfs2 spells it in a file name.
// Both geojson files are named after ids that come out of the datasource, so
// the integration keeps letters, digits, dot, dash and underscore, replaces
// every run of the rest with a single underscore and lowercases the result
// (safe_file_part, gtfs2 0.5.9.8). A url derived here has to follow the same
// rule or it 404s on any feed whose route_id carries a colon: "ORLEANS:Line:A"
// direction 0 is served as "orleans_line_a_0.json".
const safeFilePart = (v) => String(v).toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/\.\.+/g, "_");

// lighten a #rrggbb color towards white (used to tell the two directions
// of a line apart when both derive the same GTFS route_color)
const lighten = (hex, f) => {
    const n = parseInt(hex.slice(1), 16);
    const mix = (x) => Math.round(x + (255 - x) * Math.min(0.7, f));
    const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
};

// ink that stays readable on a given background: dark glyph on a light line
// colour, light glyph on a dark one. Picked from the disc's own colour, since
// the theme background says nothing about what the marker is filled with.
const inkOn = (hex) => (/^#[0-9a-fA-F]{6}$/.test(hex || "") && luminance(hex) > 0.62 ? "#1b1b1b" : "#ffffff");

// Drain a colour of its chroma while holding its lightness, for a line whose
// source has gone quiet. Veiling it towards the card background was the first
// attempt and it broke the badge: on TAO's grey line the number fell to 1.3:1,
// unreadable, because lightening a dark colour under white ink destroys the
// contrast the ink was chosen for. Taking the saturation out instead leaves
// the lightness alone, so inkOn still answers correctly for the result, and a
// drained colour reads as "no longer live" just as well.
// Towards the grey of the SAME luminance, the one inkOn measures, not towards
// a neutral of the same HSL lightness. HSL lightness is a poor stand-in for how
// light a colour looks: desaturating TAO's yellow that way flipped it from dark
// ink to light ink and landed it at 2.97:1, worse than where it started. Held
// at constant luminance the ink can never flip, and every line keeps very
// nearly the contrast it had.
const drain = (hex, amount = 0.75) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(hex || "")) return hex;
    const n = parseInt(hex.slice(1), 16);
    const g = Math.round(luminance(hex) * 255);
    return "#" + [(n >> 16) & 255, (n >> 8) & 255, n & 255]
        .map((v) => Math.round(v * (1 - amount) + g * amount).toString(16).padStart(2, "0"))
        .join("");
};

const luminance = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
};

// "tomorrow" / weekday tag for departures beyond today (include_tomorrow)
const dayTag = (lang, d, now) => {
    const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(d) - day(now)) / 86400000);
    if (diff <= 0) return "";
    if (diff === 1) return tr(lang, "tomorrow");
    return d.toLocaleDateString(lang, { weekday: "long" });
};

const haversine = (a, b) => {
    const rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.sqrt(s));
};

// shared fetch de-duplication: several card instances polling the same URL
// within maxAge share one request and one payload
const FETCH_SHARED = new Map(); // url → {at, promise}
// A forced read still de-duplicates, but only across the burst that a mount
// produces: three cards appearing together share one request, while anything
// the tab has been holding since an earlier view is read again. Without this
// window a dashboard with several cards would fire one request per card.
const FETCH_BURST_MS = 1000;
// the editor's preview draws again once the typing has paused this long
const CONFIG_SETTLE_MS = 600;
function fetchJsonShared(url, maxAgeMs) {
    const cached = FETCH_SHARED.get(url);
    const now = Date.now();
    if (cached && now - cached.at < maxAgeMs) return cached.promise;
    // entries hold a parsed GeoJSON body; without this sweep a url nobody
    // fetches any more (a view the user navigated away from) is retained for
    // the lifetime of the tab
    if (FETCH_SHARED.size > 24) {
        for (const [k, v] of FETCH_SHARED) if (now - v.at > 30 * 60000) FETCH_SHARED.delete(k);
    }
    // no-cache (not no-store): the browser revalidates with If-Modified-Since
    // / ETag and HA answers 304 when the file has not changed, so route
    // shapes and unchanged position files cost nothing on the wire
    const promise = fetch(url, { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const lm = Date.parse(r.headers.get("last-modified") || "");
        return r.json().then((j) => {
            // non-enumerable: the body is handed to JSON-agnostic code and
            // spread in places, this must not show up as a feature
            if (j && typeof j === "object" && Number.isFinite(lm)) {
                Object.defineProperty(j, "__lastModified", { value: lm, enumerable: false, configurable: true });
            }
            return j;
        });
    });
    FETCH_SHARED.set(url, { at: now, promise });
    promise.catch(() => {
        const cur = FETCH_SHARED.get(url);
        if (cur && cur.promise === promise) FETCH_SHARED.delete(url);
    });
    return promise;
}

const ICONS = {
    chevronDown: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"></path></svg>`,
    chevronRight: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"></path></svg>`,
    live: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M4 11a9 9 0 0 1 9 9"></path><path d="M4 4a16 16 0 0 1 16 16"></path><circle cx="5" cy="19" r="1.8" fill="currentColor" stroke="none"></circle></svg>`,
    pin: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.3-6-10a6 6 0 1 1 12 0c0 4.7-6 10-6 10z"></path><circle cx="12" cy="11" r="2.2"></circle></svg>`,
    alert: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l10 18H2L12 3z"></path><path d="M12 10v5"></path><circle cx="12" cy="17.6" r="0.4" fill="currentColor"></circle></svg>`,
    // mdi:walk
    walk: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M14.12,10H19V8.2H15.38L13.38,4.87C13.08,4.37 12.54,4.03 11.92,4.03C11.74,4.03 11.58,4.06 11.42,4.11L6,5.8V11H7.8V7.33L9.91,6.67L6,22H7.8L10.67,13.89L13,17V22H14.8V15.59L12.31,11.05L13.04,8.18M14,3.8C15,3.8 15.8,3 15.8,2C15.8,1 15,0.2 14,0.2C13,0.2 12.2,1 12.2,2C12.2,3 13,3.8 14,3.8Z"></path></svg>`,
};

class Gtfs2LiveCard extends HTMLElement {

    /* ── SETUP & CONFIG ─────────────────────────────────────────────────── */

    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        // the shadow root outlives every shell a new config builds in it:
        // listened to once, or each edit in the card editor's preview would
        // add a handler, and an even number of them cancels a toggle out
        this.shadowRoot.addEventListener("click", (ev) => {
            if (this._suppressClick) { this._suppressClick = false; return; }
            const t = ev.composedPath().find((n) => n.dataset && n.dataset.action);
            if (t) this._activate(t);
        });
        this.shadowRoot.addEventListener("keydown", (ev) => {
            if (ev.key !== "Enter" && ev.key !== " ") return;
            const t = ev.composedPath().find((n) => n.dataset && n.dataset.action);
            if (t) { ev.preventDefault(); this._activate(t); }
        });
        // a title opens on hover and a finger cannot hover: on touch, the tap
        // that selects a line also prints that badge's sentence under it
        this.shadowRoot.addEventListener("pointerup", (ev) => {
            if (ev.pointerType === "mouse") return;
            const b = ev.composedPath().find((n) => n.dataset && n.dataset.tip);
            if (b) this._showBadgeTip(b); else this._hideBadgeTip();
        });
        this._hass = null;
        this._config = null;
        this._collapsed = { dep: false, map: false };
        this._focus = null;               // {li, vid} of the tracked vehicle, or null
        this._hiLine = null;              // line idx highlighted from its header badge
        // the destination header of a card of journeys: the departure picked
        // (its placeKey), the arrival picked (its group key) and the way to
        // leave picked (a sensor, or "direct:" and a sensor), remembered per
        // user with the collapsed panes
        this._from = null;
        this._dest = null;
        this._way = null;
        this._ld = [];                    // per-line runtime: {geo, geoAt, err, route, routeAt, sig, sigAt}
        this._hist = new Map();           // "li:vid" → [{lat, lon, ts}]
        this._histSeen = new Map();       // "li:vid" → last time seen in the feed
        this._vehCum = new Map();         // "li:vid" → last abscissa along the route (loop disambiguation)
        // per-entity derived metadata (positions file, label, color, origin
        // stop), persisted in localStorage: a line out of service loses its
        // Route/Trip attributes (sensor.remove_keys), and a page reload at
        // night must still know everything the sensor taught us earlier
        this._emeta = new Map();
        try {
            const saved = JSON.parse(localStorage.getItem("gtfs2-live-card:meta") || "{}");
            for (const [k, v] of Object.entries(saved)) this._emeta.set(k, v);
        } catch (e) { /* localStorage unavailable */ }
        this._viewBox = null;             // [x, y, w, h] in world units (origin-shifted)
        this._origin = null;              // world-unit offset subtracted before rendering
        this._manual = false;             // user panned/zoomed: auto-fit stops overriding
        this._pointers = new Map();       // active pointers on the map (pan/pinch)
        this._pinch = null;               // {dist, mid, vb} at pinch start
        this._multi = false;              // two fingers touched the map: the release is not a tap
        this._moved = 0;
        this._suppressClick = false;
        this._downAction = null;         // [data-action] element under the last pointerdown
        this._rerenderTimer = null;
        this._updateFrame = null;         // a hass waiting for the next frame (see set hass)
        this._boardTimer = null;          // the journey board, redrawn when a shape or a leg file lands
        this._seenTrips = new Map();      // "li|trip_id" → when that run reaches its leg's end (ms)
        this._seenRows = new Map();       // "entity|trip_id|ms" → the scheduled row the sensor listed, kept while ahead (see _sourceRows)
        this._rowsCache = new WeakMap();  // sensor state → its rows, read a few seconds ago (see _sourceRows)
        this._destPass = null;            // journey index → its runs, while the destination header draws
        this._mPerUNow = 1;
        this._mapDomReady = false;
        this._map = null;                 // the MapLibre instance under the SVG, while the pane is built
        this._mapGen = 0;                 // bumped at every teardown: a module that lands late builds nothing
        this._mapStyleKey = null;         // style MapLibre was last asked to draw (theme, or the custom value)
        this._mapCredit = null;           // attribution read from the loaded style's sources
        this._mapError = null;            // why there is no base map, for the footer
        this._lastW = 0;
        this._scaleW = 0;                 // cached svg box (avoids a layout read on every animation frame)
        this._scaleH = 0;
        this._scalePx = null;             // last scale bar width written
        this._scaleTxt = null;            // last scale bar label written
        this._popSize = null;             // cached popup box, measured when its content changes
        this._ro = null;
        this._tick30 = null;
        this._visHandler = null;
        this._keyHandler = null;          // document-level Escape while tracking
        this._hintT = null;
        this._tipT = null;                // stop tooltip auto-hide timer
        this._badgeTipT = null;           // badge tooltip auto-hide timer (touch)
        this._vehEls = new Map();         // "li:vid" → persistent vehicle <g> node
        this._angCache = new Map();       // "li:vid" → {pos, angle}, spares a polyline walk per render
        this._popKey = null;              // vehicle the popup is attached to
        this._popAnim = null;             // popup glide animation frame
        this._stopLinks = new Map();      // stop name -> Map(line label -> color), rebuilt per render
        this._shownLabels = new Set();    // stop names drawn in full on the map, rebuilt per render
        this._panHover = false;           // a view change just closed the tip: hover waits for a real move
        this._timer = null;
        this._anim = null;
        this._lastEntityState = null;
        this._defsCache = null;
        this._hintCounts = {};
        this._built = false;
        this._preview = false;            // shown in the card editor (see set preview)
        this._pendingConfig = null;       // the editor's last config, waiting for a pause in the typing
        this._configTimer = null;
        this._configJson = null;          // the config drawn, as the editor handed it
    }

    // Home Assistant says so on the card it shows beside the editor. That
    // one is only there to show what the settings give: it reads its files
    // once and never polls, has no vehicles, and waits for the typing to
    // stop before drawing again
    set preview(v) {
        this._preview = !!v;
        if (this._preview && this._timer) this._stopPolling();
    }

    get preview() {
        return this._preview;
    }

    setConfig(config) {
        const hasLines = Array.isArray(config?.lines) && config.lines.length > 0;
        if (!config || (!config.entity && !hasLines)) {
            throw new Error("gtfs2-live-card : « entity » ou une liste « lines » est requis / set “entity” or a “lines” list");
        }
        // the editor hands its config over at every key typed, and each one
        // drew the whole card again, map included. The same config twice
        // draws nothing; in the preview, only the last one of a burst does
        const json = JSON.stringify(config);
        if (this._configTimer) { clearTimeout(this._configTimer); this._configTimer = null; }
        if (json === this._configJson) { this._pendingConfig = null; return; }
        if (this._preview && this._config) {
            this._pendingConfig = config;
            this._configTimer = setTimeout(() => {
                this._configTimer = null;
                const c = this._pendingConfig;
                this._pendingConfig = null;
                if (c) this._applyConfig(c, JSON.stringify(c));
            }, CONFIG_SETTLE_MS);
            return;
        }
        this._applyConfig(config, json);
    }

    _applyConfig(config, json) {
        this._configJson = json;
        this._rawConfig = config;
        this._jCache = null;
        // a card already on screen given a new config - every edit in the
        // card editor's preview - keeps what it has read of the lines it
        // still shows, and reads nothing again before its own pace says so
        const oldDefs = this._config ? this._lineDefs() : [];
        const oldLd = this._ld;
        this._rebuilt = !!this._built;
        this._config = { ...DEFAULTS, ...config };
        this._modeAuto = autoMode(config);
        const srcKey = (d) => [d.entity, d.positions_url, d.route_url, d.leg_url].join("|");
        const kept = new Map(oldDefs.map((d) => [srcKey(d), oldLd[d.idx]]));
        this._ld = this._lineDefs().map((d) => {
            const k = srcKey(d);
            const slot = kept.get(k);
            kept.delete(k);
            return slot || { geo: null, geoAt: 0, err: null, route: null, routeAt: 0, leg: null, legAt: 0, sig: null, sigAt: 0 };
        });
        this._from = null;
        this._dest = null;
        this._way = null;
        try {
            const saved = JSON.parse(localStorage.getItem(this._storageKey()) || "{}");
            if (typeof saved.dep === "boolean") this._collapsed.dep = saved.dep;
            if (typeof saved.map === "boolean") this._collapsed.map = saved.map;
            // what the destination header showed last: checked against the
            // journeys when drawn (_destView), a pick that no longer exists
            // simply shows nothing picked
            if (typeof saved.from === "string") this._from = saved.from;
            if (typeof saved.dest === "string") this._dest = saved.dest;
            if (typeof saved.way === "string") this._way = saved.way;
            if (saved.mode === "lines" || saved.mode === "trips") this._modePick = saved.mode;
        } catch (e) { /* localStorage unavailable: keep defaults */ }
        this._built = false;
        // the new shell starts empty: the board is drawn again even though
        // no sensor moved
        this._lastEntityState = null;
        this._dropBasemap();
        this._mapDomReady = false;
        if (this._hass) this._update();
    }

    set hass(hass) {
        const prev = this._hass;
        this._hass = hass;
        // hass is reassigned on every state change in the whole HA instance:
        // skip all work unless one of our entities, the theme or the locale
        // actually changed
        if (prev && this._built && this._config) {
            const themeFlip = !!prev.themes?.darkMode !== !!hass.themes?.darkMode;
            const langFlip = (prev.locale?.language || "") !== (hass.locale?.language || "");
            if (!themeFlip && !langFlip
                && this._watchedEntities().every((id) => prev.states?.[id] === hass.states?.[id])) {
                // nothing we derive from has changed: carry the memoized line
                // defs over to the new hass object rather than dropping them
                if (this._defsCache) this._defsCache.hass = hass;
                return;
            }
            if (themeFlip) this._scheduleRerender();
            if (langFlip) this._lastEntityState = null;
            // gtfs2 refreshes its sensors together, and Home Assistant hands
            // each one over in a hass of its own: drawn one by one, a card of
            // sixty sensors drew its board sixty times in a row, seconds of
            // a frozen page. One drawing per frame, with the last hass.
            if (!this._updateFrame) {
                this._updateFrame = requestAnimationFrame(() => { this._updateFrame = null; this._update(); });
            }
            return;
        }
        this._update();
    }

    // entity ids this card depends on, straight from the config. Memoized:
    // this runs on the hass hot path, which fires on any state change in the
    // whole instance.
    _watchedEntities() {
        if (this._watchCache && this._watchCache.config === this._config) return this._watchCache.ids;
        const out = new Set();
        const c = this._config || {};
        if (c.entity) out.add(c.entity);
        if (Array.isArray(c.lines)) {
            for (const l of c.lines) {
                const e = typeof l === "string" ? l : l?.entity;
                if (e) out.add(e);
            }
        }
        const ids = [...out];
        this._watchCache = { config: this._config, ids };
        return ids;
    }

    _t(key, vars) {
        return tr(this._lang(), key, vars);
    }

    _lang() {
        return resolveLang(this._hass);
    }

    /* True once this card's strings are in, and the gate every render waits
     * behind. On a miss it starts the fetch and registers for the callback,
     * so asking is also what gets the language moving. */
    _langReady() {
        const lang = this._lang();
        if (LANG[lang]) return true;
        LANG_WAITING.add(this);
        loadLang(lang);
        return false;
    }

    /* Called by loadLang() once the strings are in (or have failed). Nothing
     * has been drawn yet, so this is the first real render. */
    _langArrived(code) {
        if (code !== this._lang()) return;   // a different card's language
        LANG_WAITING.delete(this);
        this._update();
    }

    _storageKey() {
        const id = this._config.entity
            || this._lineDefs().map((d) => d.entity || d.positions_url || "").join(",")
            || "default";
        return `gtfs2-live-card:${id}`;
    }

    // the collapsed panes and the destination header's picks, per user
    _persistCollapsed() {
        const view = { ...this._collapsed, from: this._from, dest: this._dest, way: this._way,
                       mode: this._modePick };
        try { localStorage.setItem(this._storageKey(), JSON.stringify(view)); } catch (e) { /* ignore */ }
    }

    _remember(entity, patch) {
        const cur = this._emeta.get(entity) || {};
        const next = { ...cur, ...patch };
        if (JSON.stringify(cur) === JSON.stringify(next)) return;
        this._emeta.set(entity, next);
        try { localStorage.setItem("gtfs2-live-card:meta", JSON.stringify(Object.fromEntries(this._emeta))); } catch (e) { /* ignore */ }
    }

    _lineDefs() {
        // memoized per (hass, config) pair: this sits on hot paths and is
        // called several times per render pass
        const mc = this._defsCache;
        if (mc && mc.hass === this._hass && mc.config === this._config) return mc.defs;
        const defs = this._computeLineDefs();
        this._defsCache = { hass: this._hass, config: this._config, defs };
        return defs;
    }

    _computeLineDefs() {
        const c = this._config;
        const norm = (l, i) => {
            // a bare string entry is shorthand for {entity: "..."}
            if (typeof l === "string") l = { entity: l };
            const entity = l.entity || (i === 0 ? c.entity || null : null);
            let purl = l.positions_url || null;
            let rurl = l.route_url || null;
            let lurl = null;
            // the timetable, every run of the next service days: named by a
            // gtfs2 that writes it, never guessed, remembered like the leg
            // file for a sensor that went out of service
            let turl = null;
            if (entity && this._hass) {
                const tfile = attrVal(this._hass.states?.[entity]?.attributes || {}, "timetable_file");
                turl = tfile ? "/local/gtfs2/" + tfile : (this._emeta.get(entity)?.turl || null);
                if (tfile && this._emeta.get(entity)?.turl !== turl) this._remember(entity, { turl });
            }
            // nothing configured: derive from the sensor, from the file names
            // the integration exposes when it has them, else from the
            // route/direction attributes a stock gtfs2 already carries. The
            // two files are derived apart: realtime positions are optional,
            // the route shape is exported from the schedule alone.
            if ((!purl || !rurl) && entity && this._hass) {
                const at = this._hass.states?.[entity]?.attributes || {};
                const file = attrVal(at, "vehicle_positions_file");
                const rfile = attrVal(at, "route_geojson_file");
                // the leg file times the ride the sensor follows, stop by
                // stop and run by run: only ever named by the integration,
                // never guessed, and its absence is not an error
                const lfile = attrVal(at, "leg_geojson_file");
                lurl = lfile ? "/local/gtfs2/" + lfile : (this._emeta.get(entity)?.lurl || null);
                const rid = attrVal(at, "route_route_id", "route_id");
                const dir = attrVal(at, "trip_direction_id", "direction_id");
                const cached = this._emeta.get(entity);
                if (!purl) {
                    if (file) purl = "/local/gtfs2/" + file;
                    // a gtfs2 that names its route export names its positions
                    // file too when it writes one, so no vehicle_positions_file
                    // means the entry publishes no positions at all: guessing a
                    // name would only buy a 404 every refresh. A file this
                    // sensor did name once is still honoured - it stops naming
                    // it after the last departure of the day, which is exactly
                    // when a card wants to say the feed has gone quiet.
                    else if (rfile) purl = cached?.pnamed ? cached.purl : null;
                    // no file named either way: an older gtfs2, where the
                    // route and direction attributes are all there is to go on
                    else if (rid != null && dir != null) purl = `/local/gtfs2/${safeFilePart(rid)}_${safeFilePart(dir)}.json`;
                    else purl = cached?.purl || null;
                }
                if (!rurl) {
                    if (rfile) rurl = "/local/gtfs2/" + rfile;
                    // a named positions file names its companion: that beats
                    // the route/direction guess, which only has to serve a
                    // source publishing no positions at all
                    else if (file) rurl = "/local/gtfs2/" + file.replace(/\.json$/, "_route.json");
                    else if (rid != null && dir != null) rurl = `/local/gtfs2/${safeFilePart(rid)}_${safeFilePart(dir)}_route.json`;
                    else rurl = cached?.rurl || null;
                }
                const patch = {};
                if (purl) patch.purl = purl;
                if (file) patch.pnamed = true;   // named by the integration, not guessed
                if (rurl) patch.rurl = rurl;
                if (lfile) patch.lurl = lurl;
                if (purl || rurl || lfile) this._remember(entity, patch);
            }
            return {
                idx: i,
                entity,
                positions_url: purl,
                route_url: rurl || (purl ? purl.replace(/\.json$/, "_route.json") : null),
                leg_url: lurl,
                tt_url: turl,
                label: l.line != null ? String(l.line) : null,
                color: l.color || l.line_color || null,
            };
        };
        let defs;
        if (Array.isArray(c.lines) && c.lines.length) defs = c.lines.map(norm);
        else if (c.positions_url || c.entity) defs = [norm({ positions_url: c.positions_url, route_url: c.route_url, line: c.line, color: c.line_color !== DEFAULTS.line_color ? c.line_color : null }, 0)];
        else return [];
        // label and color derive from the sensor's Route metadata
        // (route_short_name / route_color) when not configured; explicit YAML
        // values always win. Both directions of a line share route_color, so
        // on a card of badges repeats were lightened to stay tellable apart.
        // A card with a destination header has no line badge: a line's
        // outbound and its return are one line, in that line's own colour,
        // and the direction shown is what tells them apart.
        // (a card of trips always has one, and its journeys are found on
        // these very lines: not asked, or the two would ask each other)
        const lightenRepeats = !tripsOf(this._rawConfig).length && !this._destEntries().length;
        const colorUse = new Map();
        let fallbacks = 0;
        for (const d of defs) {
            const at = d.entity && this._hass ? this._hass.states?.[d.entity]?.attributes : null;
            const cached = d.entity ? this._emeta.get(d.entity) : null;
            const short = attrVal(at, "route_route_short_name", "route_short_name") ?? cached?.short;
            const rcRaw = attrVal(at, "route_route_color", "route_color");
            let rc = rcRaw ? String(rcRaw).replace(/^#?/, "#") : (cached?.rc || null);
            if (rc && (!/^#[0-9a-fA-F]{6}$/.test(rc) || luminance(rc) > 0.82)) rc = null;
            const rtype = attrVal(at, "route_route_type", "route_type");
            d.mode = rtype != null ? modeKey(rtype) : (cached?.mode || "bus");
            // a line with no departure at all today: the integration says when
            // it runs next, which may be days away (a weekend, a night bus out
            // of season). Kept per line so the badge can mark it.
            d.nextIn = at ? attrVal(at, "next_service_in_days") : null;
            d.nextDate = at ? attrVal(at, "next_service_date") : null;
            // the sensor already carries the right mdi icon for its route_type
            const mdi = attrVal(at, "icon");
            d.icon = mdi || cached?.icon || MDI_DEFAULTS[d.mode]?.[0] || "mdi:bus";
            if (d.entity) {
                const patch = {};
                if (short != null) patch.short = short;
                if (rc) patch.rc = rc;
                if (rtype != null) patch.mode = d.mode;
                if (mdi) patch.icon = mdi;
                if (Object.keys(patch).length) this._remember(d.entity, patch);
            }
            if (d.label == null && short != null && short !== "") d.label = String(short);
            if (!d.color) {
                if (rc) {
                    const n = colorUse.get(rc) || 0;
                    colorUse.set(rc, n + 1);
                    d.color = n === 0 || !lightenRepeats ? rc : lighten(rc, 0.35 * n);
                } else if (c.line_color && c.line_color !== DEFAULTS.line_color) {
                    d.color = c.line_color;
                } else {
                    d.color = FALLBACK_COLORS[fallbacks++ % FALLBACK_COLORS.length];
                }
            }
        }
        return defs;
    }

    // the family the badges actually render in, so the fitting measures what
    // the user sees rather than a guess. Read once: it cannot change without
    // the whole theme changing, which re-renders the card anyway.
    _badgeFamily() {
        if (this._bFamily) return this._bFamily;
        try {
            const card = this.shadowRoot?.querySelector("ha-card");
            const f = card && getComputedStyle(card).fontFamily;
            if (f) this._bFamily = f;
        } catch (e) { /* rendu hors document */ }
        return this._bFamily || "Roboto, sans-serif";
    }

    _lineLabelOf(def) {
        if (def.label) return def.label;
        const routeId = this._ld[def.idx]?.geo?.features?.[0]?.properties?.route_id;
        return routeId ? String(routeId).split(":").pop() : "•";
    }

    _stationColor() {
        return this._config.station_color || "var(--gtfs2-station-color, var(--accent-color, #ff9800))";
    }

    // the longest wait a change may take, in minutes (max_transfer_wait)
    _maxWait() {
        const mw = Number(this._config.max_transfer_wait);
        return mw > 0 ? Math.max(5, mw) : DEFAULTS.max_transfer_wait;
    }

    // the line filter a tracking put in place goes with it: the board the
    // user had comes back
    _restoreTrackedLine() {
        if (this._trackPrev === undefined) return;
        const prev = this._trackPrev;
        this._trackPrev = undefined;
        if (this._hiLine === prev) return;
        this._hiLine = prev;
        this._renderHeader();
        this._renderDepartures();
    }

    /* ── DOM LIFECYCLE ──────────────────────────────────────────────────── */

    connectedCallback() {
        if (this._pendingConfig) {
            const c = this._pendingConfig;
            this._pendingConfig = null;
            this._applyConfig(c, JSON.stringify(c));
        }
        // the base map was released when the view went away (see below):
        // a pane still standing in the cached DOM gets it back
        if (this._mapDomReady && !this._map) this._buildBasemap();
        this._startPolling();
        if (!this._tick30) this._tick30 = setInterval(() => this._tickRelative(), 30000);
        // Home Assistant re-attaches a view's elements as they were left, and
        // the hass setter redraws nothing unless the sensor changed meanwhile:
        // the countdowns, expired rows and footer catch up now, not 30 s later
        if (this._built) this._tickRelative();
        if (!this._visHandler) {
            this._visHandler = () => { if (!document.hidden) this._fetchAll(); };
            document.addEventListener("visibilitychange", this._visHandler);
        }
        if (!this._keyHandler) {
            // Escape ends the tracking wherever the focus is: a click on a
            // marker re-renders the overlay and drops the focus to the page
            this._keyHandler = (ev) => { if (ev.key === "Escape" && this._focus) this._act("untrack", {}); };
            document.addEventListener("keydown", this._keyHandler);
        }
        this._observeResize();
    }

    disconnectedCallback() {
        LANG_WAITING.delete(this);
        // a config still waiting is drawn when the card is back, not off screen
        if (this._configTimer) { clearTimeout(this._configTimer); this._configTimer = null; }
        // a WebGL context is a scarce thing (a browser holds a dozen or so):
        // a view Home Assistant keeps cached off-screen must not sit on one
        this._dropBasemap();
        this._stopPolling();
        if (this._tick30) { clearInterval(this._tick30); this._tick30 = null; }
        if (this._visHandler) { document.removeEventListener("visibilitychange", this._visHandler); this._visHandler = null; }
        if (this._keyHandler) { document.removeEventListener("keydown", this._keyHandler); this._keyHandler = null; }
        if (this._ro) { this._ro.disconnect(); this._ro = null; }
        if (this._anim) cancelAnimationFrame(this._anim);
        if (this._rerenderTimer) { clearTimeout(this._rerenderTimer); this._rerenderTimer = null; }
        if (this._boardTimer) { clearTimeout(this._boardTimer); this._boardTimer = null; }
        if (this._hintT) { clearTimeout(this._hintT); this._hintT = null; }
        if (this._tipT) { clearTimeout(this._tipT); this._tipT = null; }
        if (this._badgeTipT) { clearTimeout(this._badgeTipT); this._badgeTipT = null; }
        if (this._popAnim) { cancelAnimationFrame(this._popAnim); this._popAnim = null; }
    }

    _startPolling(force = true) {
        this._stopPolling();
        // an entity without url may expose its attributes later: keep polling
        // armed as long as a source is possible, positions or route alone
        if (!this._config || !this._lineDefs().some((d) => d.positions_url || d.route_url || d.entity)) return;
        this._fetchAll(force);
        // the editor's preview reads once: nothing on it needs to keep up
        if (this._preview) return;
        this._timer = setInterval(() => this._fetchAll(), Math.max(15, this._config.refresh) * 1000);
    }

    _stopPolling() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    // force means the card has just been put on screen. Home Assistant is a
    // single page app: coming back to a view reuses the element and the tab
    // still holds the payloads read the last time, so without this the first
    // thing the user sees can be an hour old. A forced read goes past every
    // cache, its own and the shared one, and reads the files again.
    _fetchAll(force) {
        if (document.hidden && !force) return;
        const period = Math.max(15, this._config.refresh) * 1000;
        for (const def of this._lineDefs()) {
            const slot = this._ld[def.idx];
            // the route shape is the slow half and does not need the feed:
            // fetch it on its own schedule, even for a line with no positions
            if (def.route_url && (force || Date.now() - (slot?.routeAt || 0) > 60 * 60000)) {
                this._fetchRoute(def, force);
            }
            // the leg file moves with every realtime refresh of the sensor:
            // read at the card's own pace, only when the sensor names one and
            // a journey is there to time - a board of lines never reads it
            if (def.leg_url && this._journeys?.length && (force || Date.now() - (slot?.legAt || 0) > period)) {
                this._fetchLeg(def, force);
            }
            // no vehicles in the editor's preview: it shows the settings,
            // not the traffic
            if (!def.positions_url || this._preview) continue;
            // collapsed map only needs the count: poll five times slower
            const mapOff = this._collapsed.map || this._config.show_map === false;
            if (!force && mapOff && slot && Date.now() - (slot.geoAt || 0) < period * 5) continue;
            this._fetchPositions(def, force);
        }
    }

    _observeResize() {
        if (!("ResizeObserver" in window)) return;
        if (this._ro) this._ro.disconnect();
        const body = this.shadowRoot.getElementById("map-body");
        if (!body) return;
        this._ro = new ResizeObserver(() => {
            const w = body.clientWidth;
            if (w && Math.abs(w - this._lastW) > 4) {
                this._lastW = w;
                this._scaleW = 0;              // cached map box, re-measured on the next render
                this._scaleH = 0;
                if (!this._collapsed.map && this._mapDomReady) this._scheduleRerender();
            }
        });
        this._ro.observe(body);
    }

    // 30 s heartbeat keeping relative texts honest between data refreshes
    _tickRelative() {
        if (document.hidden || !this._built) return;
        // expanded board: refresh the countdown texts in place; a full
        // re-render only when a row expired (or the board is collapsed and
        // its one-line summary is cheap to rebuild)
        const now = new Date(), lang = this._lang();
        const spans = [...this.shadowRoot.querySelectorAll(this._collapsed.dep ? "#header .countdown[data-ts]" : ".countdown[data-ts]")];
        let expired = false, headExpired = false, board = 0;
        for (const el of spans) {
            const inHead = !!el.closest("#header");
            if (!inHead) board++;
            const t = new Date(Number(el.dataset.ts));
            if (t.getTime() < now.getTime() - 60000) {
                if (inHead) headExpired = true; else expired = true;
            } else el.textContent = fmtCountdown(lang, t, now);
        }
        if (headExpired) this._renderHeader();
        if (expired || !board) this._renderDepartures();
        this._renderFooter();
        // a line crosses the 8-minute line without any fetch happening: the
        // file is still answering, its date simply stopped moving
        this._repaintHeaderIfMuteChanged();
        this._updateAttrib();
    }

    // the map's credit line: what the loaded style's sources ask for (OSM's
    // due, by default), or why there is no base map at all
    _attribText(newestAt) {
        const upd = this._t("map_updated", { t: newestAt ? fmtAgo(this._lang(), Date.now() - newestAt) : "…" });
        if (this._mapError) return `${this._t("map_no_base")} · ${upd}`;
        const credit = this._mapCredit ?? (this._mapStyleSpec().own ? MAP_CREDIT : "");
        return credit ? `${credit} · ${upd}` : upd;
    }

    /* ── LOVELACE API ───────────────────────────────────────────────────── */

    getCardSize() {
        return 1
            + (this._config.show_departures === false ? 0 : (this._collapsed.dep ? 1 : 3))
            + (this._config.show_map === false ? 0 : (this._collapsed.map ? 1 : 4));
    }

    static getConfigElement() {
        return document.createElement("gtfs2-live-card-editor");
    }

    // Home Assistant hands over the entities picked before the card, in the
    // order they were picked: those are the lines wanted, and taking the
    // first trip sensor of the house instead would build someone else's card.
    // Only when nothing usable was picked do we look for one ourselves.
    static getStubConfig(hass, entities, entitiesFallback) {
        const states = hass?.states || {};
        const trip = (id) => isTripSensor(id, states[id]);
        const picked = [...(entities || []), ...(entitiesFallback || [])].filter(trip);
        const lines = picked.length ? [...new Set(picked)] : Object.keys(states).filter(trip).slice(0, 1);
        return lines.length ? { lines } : { entity: "sensor.gtfs2_start_stop" };
    }

    /* ── UPDATE PIPELINE ────────────────────────────────────────────────── */

    _entity() {
        return this._hass?.states?.[this._config?.entity] || null;
    }

    // departure sources: one per line def carrying its own gtfs2 sensor
    // (line 0 inherits the card's top-level entity). Falls back on the
    // top-level entity alone when no line def carries one.
    _depSources() {
        const seen = new Set();
        const out = [];
        for (const def of this._lineDefs()) {
            if (!def.entity || seen.has(def.entity)) continue;
            seen.add(def.entity);
            const st = this._hass?.states?.[def.entity];
            if (st) out.push({ def, st });
        }
        if (!out.length) {
            const st = this._entity();
            if (st) out.push({ def: null, st });
        }
        return out;
    }

    _update() {
        if (!this._config || !this._hass) return;
        // Nothing is drawn in a language the card does not have yet: rendering
        // now would put string keys on screen and swap them a moment later.
        if (!this._langReady()) return;
        if (!this._built) {
            this._buildShell();
            this._built = true;
            this._startPolling(!this._rebuilt);
            this._rebuilt = false;
        }
        const stamp = this._depSources()
            .map((s) => `${s.st.entity_id}|${s.st.state}|${s.st.last_updated}`)
            .join(";") || "missing";
        if (stamp !== this._lastEntityState) {
            this._lastEntityState = stamp;
            this._renderHeader();
            this._renderDepartures();
            this._renderFooter();
        }
    }

    /* ── SHELL ──────────────────────────────────────────────────────────── */

    _buildShell() {
        this._dropBasemap();              // its container goes with the old shell
        this.shadowRoot.innerHTML = `
        <link rel="stylesheet" href="${MAPLIBRE_CSS}">
        <style>${this._styles()}</style>
        <ha-card>
            <div id="header" class="header"></div>
            <div id="dep-head" class="sect-head" data-action="toggle-dep" role="button" tabindex="0"></div>
            <div id="dep-body"></div>
            <div id="map-head" class="sect-head" data-action="toggle-map" role="button" tabindex="0"></div>
            <div id="map-body" class="map-body"></div>
            <div id="focus-panel"></div>
            <div id="footer" class="footer"></div>
            <div class="badge-tip" hidden></div>
        </ha-card>`;
        this._footerHtml = null;          // the shell above just emptied it
        this._renderHeader();
        this._renderDepartures();
        this._renderMapSection();
        this._renderFooter();
        this._observeResize();
    }

    _activate(t) {
        this._act(t.dataset.action, t.dataset);
    }

    // A badge carries a sentence in its title: the destination, why it is
    // struck through, what the operator is reporting, how long its source has
    // been quiet. A title only opens on hover, and a phone has none - so on
    // touch the tap prints it under the badge for a few seconds instead. It
    // hangs off the card, not off the header, because selecting a line
    // re-renders the header and would take the bubble with it.
    _showBadgeTip(el) {
        const card = this.shadowRoot.querySelector("ha-card");
        const tip = this.shadowRoot.querySelector(".badge-tip");
        if (!card || !tip || !el.dataset.tip) return;
        tip.textContent = el.dataset.tip;
        tip.hidden = false;
        const c = card.getBoundingClientRect(), r = el.getBoundingClientRect();
        const w = tip.offsetWidth;
        // centred under the badge, then pushed back inside the card
        tip.style.left = `${Math.max(8, Math.min(c.width - w - 8, r.left - c.left + r.width / 2 - w / 2))}px`;
        // clear of the corner pips, which overhang the badge by half a gap,
        // and never past the bottom of the card, which clips its overflow:
        // both sections collapsed leaves the header barely a card tall
        tip.style.top = `${Math.max(4, Math.min(c.height - tip.offsetHeight - 6, r.bottom - c.top + 8))}px`;
        if (this._badgeTipT) clearTimeout(this._badgeTipT);
        this._badgeTipT = setTimeout(() => this._hideBadgeTip(), 4000);
    }

    _hideBadgeTip() {
        const tip = this.shadowRoot.querySelector(".badge-tip");
        if (tip) tip.hidden = true;
        if (this._badgeTipT) { clearTimeout(this._badgeTipT); this._badgeTipT = null; }
    }

    _act(action, ds) {
        if (action === "toggle-dep") {
            this._collapsed.dep = !this._collapsed.dep;
            this._persistCollapsed();
            this._renderDepartures();
        } else if (action === "toggle-journey") {
            // one journey open on the card; the open one closes on its own
            // tap. The map numbers the points of the journey last opened
            this._jOpen = this._jOpenNow === ds.key ? "" : ds.key;
            const ji = Number(String(ds.key).split(":")[0]);
            if (Number.isFinite(ji)) this._activeJourney = ji;
            this._renderDepartures();
            this._scheduleRerender();
        } else if (action === "toggle-map") {
            this._collapsed.map = !this._collapsed.map;
            this._persistCollapsed();
            this._renderMapSection();
            if (!this._collapsed.map) this._fetchAll(true);
        } else if (action === "bus") {
            const li = Number(ds.li);
            this._focus = { li, vid: ds.vid || "" };
            this._manual = false;
            // tracking a vehicle selects its line everywhere: header badge,
            // departures filter and map, one consistent context
            if (this._hiLine !== li) {
                // the filter the tracking replaces, given back when it ends
                if (this._trackPrev === undefined) this._trackPrev = this._hiLine;
                this._hiLine = li;
                this._renderHeader();
                this._renderDepartures();
            }
            this._renderMap(true);
            const svg = this.shadowRoot.querySelector(".map-wrap svg");
            if (svg) svg.focus({ preventScroll: true });
        } else if (action === "untrack") {
            // popup closed: stop tracking but keep the current view where it
            // is (the recenter button brings the fitted view back)
            this._focus = null;
            this._manual = true;
            this._restoreTrackedLine();
            this._renderMap(false);
        } else if (action === "unfocus") {
            // the overview button is the full reset: tracking released, the
            // destination and the way picked dropped (the direction is kept:
            // it is where the rider is going), manual pan/zoom forgotten,
            // fitted view
            this._focus = null;
            this._manual = false;
            this._trackPrev = undefined;
            const picked = this._dest != null || this._way != null;
            if (this._hiLine != null || picked) {
                this._hiLine = null;
                if (picked) {
                    this._dest = null;
                    this._way = null;
                    this._persistCollapsed();
                }
                this._renderHeader();
                this._renderDepartures();
            }
            this._renderMap(true);
        } else if (action === "recenter") {
            this._manual = false;
            this._renderMap(true);
        } else if (action === "mode") {
            // changing the reading drops what the other reading had picked:
            // a destination means nothing on a board of lines, and a line
            // picked means nothing among journeys
            const m = ds.mode === "lines" ? "lines" : "trips";
            if (m === this._modeOf()) return;
            this._modePick = m;
            this._hiLine = null;
            this._dest = null;
            this._way = null;
            this._activeJourney = null;
            this._trackPrev = undefined;
            this._focus = null;
            this._manual = false;
            this._persistCollapsed();
            this._renderHeader();
            this._renderDepartures();
            if (!this._collapsed.map) this._renderMap(true);
        } else if (action === "line") {
            const li = Number(ds.li);
            this._hiLine = this._hiLine === li ? null : li;
            this._trackPrev = undefined;   // the user's own pick now
            // a badge click (select or deselect) always resets the map: the
            // tracking is released, a manual pan/zoom is forgotten, and the
            // view glides back to the fitted one. Closing the popup (cross,
            // Escape, tap on the background) keeps the map where it is.
            this._focus = null;
            this._manual = false;
            this._renderHeader();
            this._renderDepartures();
            if (!this._collapsed.map) this._renderMap(true);
        } else if (action === "dest-from" || action === "dest" || action === "dest-way" || action === "dest-clear") {
            // the destination header: the departure, an arrival, a way to
            // leave. Each is the user's own choice, the last two toggles, each
            // narrows the board and the map the way a line's badge did, and
            // all three are remembered
            const v = this._destView();
            if (!v) return;
            if (action === "dest-from") {
                // the lit departure tapped again drops the pick
                this._from = ds.from === v.from ? "" : ds.from;
                this._dest = null;
                this._way = null;
            } else if (action === "dest") {
                if (!v.solo) this._dest = v.dest === ds.key ? null : ds.key;
                this._way = null;
            } else if (action === "dest-way") {
                this._way = v.way === ds.way ? null : ds.way;
            } else if (v.way) {
                this._way = null;
            } else {
                this._dest = null;
            }
            this._persistCollapsed();
            this._hiLine = null;
            this._trackPrev = undefined;
            this._focus = null;
            this._manual = false;
            this._activeJourney = null;
            this._renderHeader();
            this._renderDepartures();
            if (!this._collapsed.map) this._renderMap(true);
        } else if (action === "stop") {
            // tap on a stop: name and connections for two seconds, unless the
            // map already says it all - the tip would print the same words
            // twice, one above the other
            if (!this._labelIsRedundant(ds)) this._showTip(ds, 2000);
        } else if (action === "zoom-in") {
            this._zoomBy(1 / 1.5);
        } else if (action === "zoom-out") {
            this._zoomBy(1.5);
        }
    }

    /* ── HEADER & FOOTER ────────────────────────────────────────────────── */

    // What the operator is reporting on this line, or null. gtfs2 writes
    // "no info" both when its alerts feed says nothing about this journey and
    // when no alerts feed is configured at all, so there is nothing to tell
    // apart: either way there is no alert, and no mark. An alert with a cause
    // but no readable sentence still counts - the feed said something.
    // A realtime departure of TODAY still ahead of us. After the last scheduled
    // departure the sensor already says "resumes tomorrow", but as long as a
    // late bus of today is still coming the line is not at rest.
    _rtToday(d) {
        const rta = d.entity ? this._hass?.states?.[d.entity]?.attributes?.next_departures_realtime : null;
        const nowMs = Date.now();
        return Array.isArray(rta) && rta.some((v) => {
            const t = parseTs(v);
            return t && t.getTime() > nowMs - 60000
                && t.toDateString() === new Date(nowMs).toDateString();
        });
    }

    // "Nothing today, and nothing until then", in words. The badge says it in
    // marks - a diagonal stroke and a corner pip - and the empty board says it
    // as a sentence. One reading behind all three, so they cannot disagree.
    _restingNote(d) {
        const nIn = d.nextIn;
        if (!Number.isFinite(nIn) || nIn === 0 || this._rtToday(d)) return "";
        return nIn < 0 ? this._t("resting_never")
            : nIn === 1 ? this._t("resting_tomorrow")
            : this._t("resting_days", { n: nIn });
    }

    // An alert's sentence as the card prints it: the stops gtfs2 says it is
    // addressed to (stops, their stations' names) first, unless the
    // sentence names them already. IDFM closes a station under the header
    // "Travaux" and says which one only there, and the rider cannot tell
    // whether it is a stop they use or one their train only passes.
    _alertSay(it) {
        const raw = String(it?.text ?? "").trim();
        const text = raw === "None" || raw === "no info" ? "" : raw;
        const low = text.toLowerCase();
        const stops = (Array.isArray(it?.stops) ? it.stops : [])
            .map((x) => String(x).trim()).filter((x) => x && !low.includes(x.toLowerCase()));
        if (!stops.length) return text;
        return text ? this._t("line_prefix", { l: stops.join(", ") }) + text : stops.join(", ");
    }

    // The stops gtfs2 names on its alerts, by the line that publishes them:
    // {line idx -> {stop name -> [items]}}. An alert with no stops is the
    // line's own and is already said under the board; one with stops is
    // about a place, and a place is somewhere the card can point at.
    _stopAlerts() {
        if (this._saAt === this._hass) return this._saMap;
        const byLine = new Map();
        for (const src of this._depSources()) {
            if (!src.def) continue;
            const at = src.st?.attributes || {};
            for (const k of ["origin_stop_alerts", "destination_stop_alerts"]) {
                for (const it of Array.isArray(at[k]) ? at[k] : []) {
                    for (const nm of Array.isArray(it?.stops) ? it.stops : []) {
                        const key = String(nm).trim().toLowerCase();
                        if (!key) continue;
                        if (!byLine.has(src.def.idx)) byLine.set(src.def.idx, new Map());
                        const m = byLine.get(src.def.idx);
                        if (!m.has(key)) m.set(key, []);
                        // the same alert is published on both ends of a
                        // sensor, as two objects of the same words: told
                        // apart by identity, it was kept twice and every
                        // tooltip and mark said it twice over
                        const said = (x) => `${x?.cause}|${x?.effect}|${String(x?.text ?? "").trim()}`;
                        if (!m.get(key).some((x) => said(x) === said(it))) m.get(key).push(it);
                    }
                }
            }
        }
        this._saAt = this._hass;
        this._saMap = byLine;
        return byLine;
    }

    // What is said of this stop of this line, if anything. The name gtfs2
    // puts on an alert is the station's, the one on a shape is the platform's:
    // where they are not the same word, one holding the other is close enough
    // ("Saint-Michel Notre-Dame" against "Saint-Michel").
    _stopAlertsAt(li, name) {
        const byLine = this._stopAlerts();
        if (!byLine.size || li == null) return null;
        const m = byLine.get(Number(li));
        if (!m) return null;
        const nm = String(name ?? "").trim().toLowerCase();
        if (!nm) return null;
        const hit = m.get(nm);
        if (hit) return hit;
        if (nm.length < 4) return null;
        for (const [other, v] of m) {
            if (other.length >= 4 && (other.includes(nm) || nm.includes(other))) return v;
        }
        return null;
    }

    // a list of alerts as the mark the card prints beside a time or a name:
    // the glyph of the worst kind, the sentences in the tooltip
    _alertMarkHtml(items) {
        if (!items?.length) return "";
        const kind = alertKind(items[0].cause, items[0].effect);
        const say = items.map((x) => this._alertSay(x)).filter(Boolean).join(" · ")
            || this._t("alert_" + kind);
        return `<span class="row-alert" role="img" title="${esc(say)}" data-tip="${esc(say)}" aria-label="${esc(say)}">`
            + `<svg viewBox="${-PIP / 2} ${-PIP / 2} ${PIP} ${PIP}" aria-hidden="true">${modeGlyph(kind, PIP_INK, "currentColor")}</svg></span>`;
    }

    // the same mark on the map: a small disc over the stop's own, up and to
    // the right of it, where it covers neither the dot nor its label
    // base is the radius of the marker the mark sits on, in the same units
    // the marker is drawn with: a stop's dot (4), a station's disc (10).
    // The mark is read before the marker under it - it is why the eye was
    // sent there - so it is drawn a station's size whatever it sits on, and
    // follows the marker where that is bigger still. Half of a station, it
    // was lost on one and hard to see on a stop at any zoom.
    _alertPipSvg(items, x, y, u, base = 10) {
        if (!items?.length) return "";
        const kind = alertKind(items[0].cause, items[0].effect);
        const r = Math.max(9.5, base) * u;
        return `<g pointer-events="none" transform="translate(${(x + r).toFixed(1)} ${(y - r).toFixed(1)})">`
            + `<circle r="${r.toFixed(2)}" fill="var(--gtfs2-late-color, #e65100)" stroke="var(--card-background-color, #fff)" stroke-width="${(1.4 * u).toFixed(2)}"></circle>`
            + modeGlyph(kind, r * (PIP_INK / (PIP / 2)), "var(--card-background-color, #fff)") + `</g>`;
    }

    _alertOf(d) {
        const at = d.entity ? this._hass?.states?.[d.entity]?.attributes : null;
        if (!at) return null;
        // the head of the stack is the sentence of the string, with the
        // stops it names; the string alone on a gtfs2 without the stack
        const head = ["origin_stop_alerts", "destination_stop_alerts"]
            .map((k) => (Array.isArray(at[k]) ? at[k][0] : null)).find(Boolean);
        const text = head ? this._alertSay(head) : ["origin_stop_alert", "destination_stop_alert"]
            .map((k) => attrVal(at, k))
            .find((v) => v && v !== "no info") || "";
        const cause = attrVal(at, "alert_cause") || "";
        const effect = attrVal(at, "alert_effect") || "";
        if (!text && !cause && !effect) return null;
        return { kind: alertKind(cause, effect), text };
    }

    _renderHeader() {
        // the shell only exists once the strings are in: a fetch that lands
        // first must not draw anything
        if (!this._built) return;
        // a redraw replaces the control under a keyboard user's focus: the
        // one focused is found again by its key
        const fk = this.shadowRoot.activeElement?.dataset?.fk;
        if (this._modeOf() === "trips" && this._destView()) this._renderDestHeader();
        else this._renderBadgeHeader();
        if (fk) {
            const again = [...this.shadowRoot.querySelectorAll("[data-fk]")].find((n) => n.dataset.fk === fk);
            if (again) again.focus({ preventScroll: true });
        }
    }

    // The lines of the card, one badge each, the picked one filtering the
    // board and raising its shape on the map. Same frame as the destination
    // header - title above, content, caption row - so switching between the
    // two moves nothing but the middle.
    _renderBadgeHeader() {
        const srcs = this._depSources();
        const defs = this._lineDefs();
        const many = defs.length > 1;
        // no auto-derived title: with nothing selected the header is badges
        // only. An explicit title: in the config still shows.
        const title = this._config.title != null ? String(this._config.title) : "";
        const hsrc = this._hiLine != null ? srcs.filter((s) => s.def && s.def.idx === this._hiLine) : srcs;
        let dest;
        if (this._hiLine != null && hsrc.length) {
            // selected line: show its full direction, origin stop → destination
            const at = hsrc[0].st.attributes || {};
            const org = at.origin_station_stop_name || "";
            const dst = at.destination_station_stop_name || "";
            dest = org && dst ? `${org} → ${dst}` : (dst ? this._t("to", { d: dst }) : org);
        } else if (!many) {
            // single-line card (no selectable badges): keep its destination
            const dests = [...new Set(hsrc.map((s) => s.st.attributes?.destination_station_stop_name).filter(Boolean))];
            dest = dests.length === 1 ? this._t("to", { d: dests[0] }) : "";
        } else {
            dest = "";
        }
        const badges = (defs.length ? defs : [{ idx: 0, color: this._config.line_color, label: this._config.line }])
            .map((d) => {
                const s = this._badgeState(d);
                const sel = this._hiLine === d.idx;
                const dim = this._hiLine != null && !sel;
                const a11y = many ? ` data-action="line" data-li="${d.idx}" data-fk="line:${d.idx}" role="button" tabindex="0" aria-pressed="${sel}"` : "";
                return `<div class="badge ${many ? "clickable" : ""} ${sel ? "sel" : ""} ${dim ? "dim" : ""} ${s.resting ? "resting" : ""} ${s.mute ? "mute" : ""}" style="background:${esc(s.bg)};color:${s.bink};--chip-bg:${s.chipBg};--opp-ink:${s.opp}${s.bfs !== BADGE_FS ? `;font-size:${s.bfs}px` : ""}"${a11y} title="${esc(s.btitle)}"${s.btitle ? ` data-tip="${esc(s.btitle)}"` : ""}><span class="badge-num">${esc(s.blabel)}</span>${s.restSr}${s.chip}${s.mutePip}${s.alertPip}${s.rest}</div>`;
            })
            .join("");
        // the line picked, named under its badges rather than beside them:
        // the plate, then where that line runs. Nothing at all while
        // nothing is picked, so the row costs its height only when it pays
        let cap = "";
        // (the ringed badge above says which line: no plate here)
        if (dest) cap = esc(dest);
        this.shadowRoot.getElementById("header").innerHTML = `<div class="dhead">`
            + (title ? `<div class="dtitle">${esc(title)}</div>` : "")
            + `<div class="badges">${badges}</div>`
            + this._capRow(cap) + `</div>`;
    }

    // Everything a line's badge says, worked out once for its own badge and
    // for its half of a journey's double badge: the colour (drained when
    // its source has gone quiet) and the ink on it, the mode glyph, the
    // operator's alert, the rest - and the sentence of the tooltip.
    _badgeState(d) {
        const bdest = d.entity ? (this._hass?.states?.[d.entity]?.attributes?.destination_station_stop_name || "") : "";
        // same table as the map markers: a mode draws the identical
        // shape on the badge and on the vehicle. A sensor naming an
        // icon of its own (not its mode's) keeps that one, via ha-icon.
        let chipInner = "";
        if (this._config.mode_icons !== false) {
            const own = d.icon && !(MDI_DEFAULTS[d.mode || "bus"] || []).includes(d.icon) ? d.icon : null;
            const g = own ? null : modeGlyph(d.mode || "bus", PIP_INK, "currentColor");
            chipInner = g
                ? `<svg class="badge-glyph" viewBox="${-PIP / 2} ${-PIP / 2} ${PIP} ${PIP}" aria-hidden="true">${g}</svg>`
                : `<ha-icon icon="${esc(own || d.icon || "mdi:bus")}"></ha-icon>`;
        }
        const chip = chipInner ? `<span class="badge-pip mode br">${chipInner}</span>` : "";
        // A source that has stopped reporting and a line with nothing
        // out look identical: no marker either way, and a plain badge
        // in the header. The card already holds the difference - the
        // positions file carries a Last-Modified, and the integration
        // rewrites it on every cycle whether it found a vehicle or not,
        // so its date only ages when nobody is writing any more. That
        // signal was used to DROP the vehicles of a stale line, in
        // silence. Here it gets said.
        //
        // Three ways to fall quiet, one mark: the entity is gone from
        // Home Assistant, it is there but unavailable, or it is fine
        // and the positions file has frozen. The user does not have to
        // tell them apart on a badge; the tooltip says which, and how
        // long it has been.
        // Nothing runs on this line right now. Mark it on the badge
        // itself, opposite the mode chip, so a line resting for the
        // weekend is told apart at a glance from one that is simply
        // between two buses. The date goes in the title, where the
        // destination already is.
        // How far off the next service is, in days. 0 means the line
        // did run today and its departures are simply behind us, which
        // is not the same thing as a line resting: it starts again
        // tomorrow morning, so the badge is left alone. The stroke is
        // for a line with nothing today AND nothing until later.
        const nIn = d.nextIn;
        // A late bus still on its way outranks the timetable: after
        // the last scheduled departure the sensor already says
        // "resumes tomorrow", but as long as a realtime departure of
        // TODAY is still ahead, the line is not at rest and the
        // stroke waits. Same window as the board's own filter, so
        // the badge and the rows change together, not one by one.
        const rtToday = this._rtToday(d);
        // -1 means the feed has no service left for this journey at all,
        // which deserves the mark as much as a long rest does
        const restTitle = this._restingNote(d);
        const resting = !!restTitle;
        const slot = this._ld[d.idx];
        const st = d.entity ? this._hass?.states?.[d.entity] : null;
        const gone = !!d.entity && !st;
        // "unknown" is the NORMAL state of a line with no departure to
        // show: on a resting line, or one whose late realtime is still
        // on the board, it must not read as a fault. Only
        // "unavailable", or "unknown" outside those two, says the
        // source itself has a problem.
        const down = !!st && (st.state === "unavailable" || (st.state === "unknown" && !resting && !rtToday));
        // a source that has already spoken gets the benefit of the
        // doubt until it has been silent a full STALE_FEED: one failed
        // request is a hiccup, not an outage, and a mark that blinks on
        // and off teaches the user to ignore it. One that has never
        // spoken and errors has nothing to wait for.
        // a resting line's positions file is legitimately silent for
        // days: that silence is explained by the rest, not news
        const frozen = !!d.positions_url && !!slot && !resting
            && (slot.sigAt ? Date.now() - slot.sigAt > STALE_FEED : !!slot.err);
        const mute = gone || down || frozen;
        const muteTitle = !mute ? ""
            : gone ? this._t("mute_gone")
            : down ? this._t("mute_unavailable")
            : slot.err ? this._t("mute_unreachable")
            : this._t("mute_since", { t: fmtDur(Math.round((Date.now() - slot.sigAt) / 60000)) });
        // opposite corner from the mode, and drawn on the opposite
        // diagonal from the resting stroke: three marks can share one
        // badge without any two being taken for each other
        // top-right: the operator's own word on this line. It is the
        // only mark that comes from outside the card's own reading of
        // the data, so it sits opposite the mode and keeps its own ink.
        const alert = this._alertOf(d);
        const alertTitle = alert ? (alert.text || this._t("alert_" + alert.kind)) : "";
        const alertPip = alert
            ? `<span class="badge-pip alert tr"><svg class="badge-glyph" `
              + `viewBox="${-PIP / 2} ${-PIP / 2} ${PIP} ${PIP}" aria-hidden="true">`
              + `${modeGlyph(alert.kind, PIP_INK, "currentColor")}</svg></span>`
            : "";
        const mutePip = mute
            ? `<span class="badge-pip mute tl"><svg class="badge-glyph" `
              + `viewBox="${-PIP / 2} ${-PIP / 2} ${PIP} ${PIP}" aria-hidden="true">`
              + `${modeGlyph("mute", PIP_INK, "currentColor")}</svg></span>`
            : "";
        let rest = "";
        if (resting) {
            // A single diagonal, not a cross: one stroke leaves the
            // number far more readable, and a line must still show its
            // number when it is not running.
            //
            // The stroke is the badge's own ink at 65%, which alone
            // measures as low as 2.2:1 on a mid green or a grey line.
            // The halo underneath is the opposite ink, which lifts it
            // past 10:1 on every line colour without making the stroke
            // any heavier. Drawn in SVG because a gradient cannot take
            // a halo.
            rest = `<svg class="badge-slash" viewBox="0 0 60 60" preserveAspectRatio="none" aria-hidden="true">`
                + `<path class="slash-halo" d="M10 50 L50 10" fill="none" stroke-linecap="round"/>`
                + `<path d="M10 50 L50 10" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round"/>`
                + `</svg>`;
            // The stroke says "not today" and says it for all three
            // cases. Which of the three is the bottom-left corner's
            // job: a dial for tomorrow, a calendar for a rest of
            // several days, a cross for a line with no service left
            // at all. Until this pip, only the tooltip told them
            // apart, and a tooltip is not hovered on a phone.
            //
            // The stroke ends under this pip. The slash is drawn in a
            // 60-unit box stretched to the badge, so both scale together:
            // at BADGE_W 44 the disc lands on 7.5,52.5 with a radius of
            // 15 in that box, and the stroke's end at 10,50 still falls
            // inside it - it emerges from beneath the pip rather than
            // crossing it.
            rest += `<span class="badge-pip svc bl"><svg class="badge-glyph" `
                + `viewBox="${-PIP / 2} ${-PIP / 2} ${PIP} ${PIP}" aria-hidden="true">`
                + `${modeGlyph(nIn < 0 ? "never" : nIn === 1 ? "tomorrow" : "days", PIP_INK, "currentColor")}`
                + `</svg></span>`;
        }
        // the label reads against its own line colour, the same rule
        // the map markers follow: a light line colour takes dark text
        // a quiet line keeps its lightness and loses its chroma, so the
        // ink rule below still holds and the number stays readable
        const bg = mute ? drain(d.color || this._config.line_color)
                        : (d.color || this._config.line_color);
        const bink = inkOn(bg);
        // the mode chip's disc goes the other way round from the ink,
        // so the glyph keeps its contrast on light and dark lines alike
        // mixed INTO the line colour rather than left translucent: the
        // chip now overflows the badge, and a see-through disc would
        // pick up the card behind it and read as a cut-off half moon
        const chipBg = `color-mix(in srgb, ${bink === "#ffffff" ? "#000" : "#fff"} 40%, ${esc(bg)})`;
        const btitle = [bdest, restTitle, alertTitle, muteTitle].filter(Boolean).join(" · ");
        // the halo takes the ink the other way round, so it separates
        // the stroke from the badge whichever way the contrast runs
        const opp = bink === "#ffffff" ? "#1b1b1b" : "#ffffff";
        // the stroke says it visually and title says it on hover, but
        // neither reaches a screen reader: state it in the text layer
        const restSr = [restTitle, alertTitle, muteTitle].filter(Boolean)
            .map((s) => `<span class="sr-only">${esc(s)}</span>`).join("");
        const blabel = this._lineLabelOf(d);
        const bfs = badgeFontSize(blabel, this._badgeFamily());
        // the stroke alone, for a half of a double badge: its rest pip has
        // no corner there, the stroke on its half says it
        const slash = resting ? rest.slice(0, rest.indexOf('<span class="badge-pip svc')) : "";
        const alertGlyph = alert ? alertPip.replace(/^<span class="badge-pip alert tr">/, "").replace(/<\/span>$/, "") : "";
        return { bg, bink, chipBg, opp, mute, muteTitle, resting, restTitle, btitle, restSr, blabel, bfs, chip, chipInner, mutePip, alertPip, alertGlyph, rest, slash, bdest };
    }

    /* ── The destination header ──────────────────────────────────────────
     * A card of journeys says where, not how: a chip per destination, the
     * ways to leave for the one picked, and the direction shown, which is
     * the user's choice and never the clock's. The board below says how,
     * run by run. */

    // The card's journeys (see journeysOf). Those its links make depend on
    // where the sensors start and end, which hass tells: the list is read
    // again when one of those ends changes, and only then - everything
    // else keeps the same list, and its indexes
    get _journeys() {
        const raw = this._rawConfig;
        if (!raw) return [];
        const m = this._jCache;
        const gen = this._routesGen || 0;
        if (m && m.raw === raw && (!m.trips || (m.hass === this._hass && m.gen === gen))) return m.list;
        if (!tripsOf(raw).length) {
            this._jCache = { raw, trips: false, list: journeysOf(raw) };
            return this._jCache.list;
        }
        // the rides the trips are searched on, and what they depend on: the
        // stops of each shape between the sensor's two ends
        const rides = this._tripRides();
        const sig = `${gen}:` + rides.map((r) => `${r.entity}=${r.stops.map((st) => `${st.key}${st.board ? "" : "-"}${st.alight ? "" : "_"}`).join(",")}`).join("/");
        if (m && m.raw === raw && m.sig === sig) { m.hass = this._hass; m.gen = gen; return m.list; }
        const max = Number.isFinite(Number(raw.max_changes)) ? Math.max(0, Number(raw.max_changes)) : MAX_CHANGES;
        const planned = planTrips(tripsOf(raw), rides, placeResolver(raw.places), max);
        this._jCache = { raw, trips: true, sig, gen, hass: this._hass, list: journeysOf(raw, planned) };
        return this._jCache.list;
    }

    // The card's sensors as the trips are searched on (see planTrips): each
    // with its stops from its origin to its destination, as its route shape
    // draws them, or its two ends alone while it has none
    _tripRides() {
        const placeOf = placeResolver(this._rawConfig?.places);
        const out = [];
        const seen = new Set();
        for (const def of this._lineDefs()) {
            if (!def.entity || seen.has(def.entity)) continue;
            seen.add(def.entity);
            const st = this._hass?.states?.[def.entity] || null;
            const sl = this._legSlice(def, st);
            const stop = (name, board = true, alight = true) => ({ name, key: name ? placeOf(name).key : "", board, alight });
            let stops;
            if (sl.route && sl.di > sl.oi) {
                stops = sl.route.stops.slice(sl.oi, sl.di + 1).map((x) => stop(x.name, !x.noBoard, !x.noAlight));
            } else {
                stops = [stop(sl.oname), stop(sl.dname)];
            }
            if (stops.length >= 2 && stops[0].key && stops[stops.length - 1].key) out.push({ entity: def.entity, stops });
        }
        return out;
    }

    // What the destination header is built from: the card's journeys, or on
    // a card of lines its entries, each a line between its sensor's two ends
    // - the line's terminus is its destination, and its other direction its
    // return. A line with no sensor has no ends: a card of those alone keeps
    // its badges.
    _destEntries() {
        if (this._journeys?.length) return this._journeys;
        const c = this._destEntryCache;
        if (c && c.config === this._config) return c.entries;
        const entries = cardEntries(this._config).filter((e) => e.legs[0]?.entity);
        this._destEntryCache = { config: this._config, entries };
        return entries;
    }

    // The card's entries read as destinations, memoized per (hass, config)
    // like the line defs: {entries, groups, jmeta, origins}
    _destModel() {
        const mc = this._destCache;
        // the journeys too: a card of trips finds more of them as the route
        // shapes land, under the same hass and config, and a model kept
        // from the shorter list files them under the wrong indexes
        const list = this._journeys;
        if (mc && mc.hass === this._hass && mc.config === this._config && mc.list === list) return mc.model;
        const model = this._computeDestModel();
        this._destCache = { hass: this._hass, config: this._config, list, model };
        return model;
    }

    // Every journey gets a departure, an arrival and a way. The departure is
    // where its first leg starts, the arrival where its last leg ends, both
    // compared on the names of the places (placeKey), since a station often
    // keeps one stop id per platform. A group is an arrival from one
    // departure. Its name is the entry's own name, if the entry goes the way
    // the first entry of that name goes; if the ends are swapped, it is the
    // name of the far end: "Paris Austerlitz" out of Saint-Euverte, but
    // "Saint-Euverte" out of Paris. The way is how a run gets there, told
    // by the leg where the group's journeys differ: the first ("Via 40"),
    // or the last when they all start on the same line ("Then 40"). A
    // single leg is direct. The medallion's line is the one serving the
    // arrival most often; a second mode is drawn when it serves a quarter of
    // them. destination_color overrides the colour. The departures are
    // listed most used first, and the first one is the default.
    _computeDestModel() {
        const defs = this._lineDefs();
        const defOf = (ent) => defs.find((d) => d.entity === ent) || null;
        const endOf = (leg, side) => {
            const def = defOf(leg.entity);
            const sl = def ? this._legSlice(def, this._hass?.states?.[leg.entity] || null) : null;
            return side === "o" ? (leg.getOn ?? sl?.oname ?? "") : (leg.getOff ?? sl?.dname ?? "");
        };
        // places: names the stops the user holds for one place, the quays of
        // a bus station the feed files apart: each of them reads as the place
        const placeOf = placeResolver(this._config.places);
        const entries = this._destEntries();
        const groups = [], jmeta = [], named = new Map(), origins = new Map();
        entries.forEach((jr, ji) => {
            const O = placeOf(endOf(jr.legs[0], "o")), D = placeOf(endOf(jr.legs[jr.legs.length - 1], "d"));
            const o = O.name, d = D.name, ok = O.key, dk = D.key;
            let own = jr.name != null;
            if (own) {
                const ref = named.get(jr.name);
                if (!ref) named.set(jr.name, { ok, dk });
                else {
                    const same = Number(!!ok && ok === ref.ok) + Number(!!dk && dk === ref.dk);
                    const swap = Number(!!ok && ok === ref.dk) + Number(!!dk && dk === ref.ok);
                    if (swap > same) own = false;
                }
            }
            const key = `${ok}>` + (own ? `n:${jr.name}` : `e:${dk}`);
            let g = groups.find((x) => x.key === key);
            if (!g) {
                g = { key, from: ok, place: own ? jr.name : d, color: null, jis: [] };
                groups.push(g);
            }
            if (!g.color && jr.destColor) g.color = jr.destColor;
            g.jis.push(ji);
            jmeta[ji] = { g, own, o, ok, cut: !!jr.cut };
            // an end not read yet (a sensor still loading) is no departure
            // to offer: its journeys show whichever departure is picked
            if (ok) {
                const h = origins.get(ok) || { key: ok, name: o, n: 0, at: ji, real: false };
                h.n++;
                if (!jr.cut) h.real = true;
                origins.set(ok, h);
            }
        });
        for (const g of groups) {
            const multi = g.jis.map((ji) => entries[ji].legs).filter((l) => l.length > 1);
            const firsts = new Set(multi.map((l) => l[0].entity));
            const lasts = new Set(multi.map((l) => l[l.length - 1].entity));
            g.wayAt = firsts.size < 2 && lasts.size > 1 ? "last" : "first";
            for (const ji of g.jis) {
                const legs = entries[ji].legs;
                // a direct sensor is a way of its own: two lines going
                // straight to one place (its quays grouped by places:) are
                // two ways, told apart by their plates
                jmeta[ji].way = legs.length === 1 ? `direct:${legs[0].entity}`
                    : (g.wayAt === "last" ? legs[legs.length - 1] : legs[0]).entity;
            }
            // counted per line, not per sensor
            const count = new Map();
            const add = (ent) => {
                const def = defOf(ent);
                if (!def) return;
                const k = `${this._lineLabelOf(def)}|${def.color}`;
                const c = count.get(k) || { def, n: 0 };
                c.n++;
                count.set(k, c);
            };
            for (const ji of g.jis) { const l = entries[ji].legs; add(l[l.length - 1].entity); }
            // strictly more: a tie keeps the line listed first
            let best = null;
            for (const c of count.values()) if (!best || c.n > best.n) best = c;
            const byMode = new Map();
            let total = 0;
            for (const c of count.values()) {
                const md = c.def.mode || "bus";
                byMode.set(md, (byMode.get(md) || 0) + c.n);
                total += c.n;
            }
            const main = best?.def.mode || "bus";
            let second = null;
            for (const [md, n] of byMode) if (md !== main && n >= total / 4 && (!second || n > byMode.get(second))) second = md;
            g.def = best?.def || null;
            g.modes = second ? [main, second] : [main];
        }
        const from = [...origins.values()].sort((a, b) => b.n - a.n || a.at - b.at);
        return { entries, groups, jmeta, origins: from };
    }

    // Whether this card can show journeys at all: a card of positions files
    // with no sensor has no end to read, so it is a board of lines and the
    // toggle has nothing to offer.
    _canTrips() {
        return !!this._destEntries().length;
    }

    // The reading in force: what the user picked, else what the configuration
    // declared. A pick for journeys on a card that cannot show them is
    // ignored rather than honoured into an empty header.
    // The board's layout, fixed by the reading: the lines as a timetable,
    // the journeys as a list
    _isTable() {
        return this._modeOf() !== "trips";
    }

    _modeOf() {
        const m = this._modePick || this._modeAuto || "trips";
        return m === "trips" && this._canTrips() ? "trips" : "lines";
    }

    // The two-button toggle, in the bottom right of the header. It rides the
    // caption row - the one that is empty until a line is picked - because
    // that row is the only one every card has: a card without title: has no
    // title row to share.
    _modeSwap() {
        if (!this._canTrips()) return "";
        const on = this._modeOf();
        const one = (m, label, glyph) =>
            `<button type="button" class="${on === m ? "on" : ""}" data-action="mode" data-mode="${m}"`
            + ` data-fk="mode:${m}" aria-pressed="${on === m}">${glyph}<span>${esc(label)}</span></button>`;
        return `<div class="swap" role="group" aria-label="${esc(this._t("mode_group"))}">`
            + one("lines", this._t("mode_lines"), MODE_ICON_LINES)
            + one("trips", this._t("mode_trips"), MODE_ICON_TRIPS) + `</div>`;
    }

    // The caption row: whatever the header has left to say on the left, the
    // reading toggle on the right. Drawn when either has something in it.
    _capRow(inner) {
        const sw = this._modeSwap();
        if (!inner && !sw) return "";
        return `<div class="caprow"><span class="capleft">${inner || ""}</span>${sw}</div>`;
    }

    // What the destination header shows, from the picks remembered: the
    // departure (the most used one until another is picked), the arrivals
    // from it, and the arrival and the way picked while they still exist
    // from there. A departure going to one place has that place picked for
    // good (solo): its ways are the choice. Null on a card with no sensor
    // to read ends from, and on the board of lines: the header is not drawn
    // there, and what it picked must not narrow what the user cannot see.
    _destView() {
        if (!this._destEntries().length || this._modeOf() !== "trips") return null;
        const model = this._destModel();
        // "" is no departure picked, the lit one tapped again: every
        // arrival from everywhere, as a line picked and dropped gives back
        // every line
        const none = this._from === "" && model.origins.length > 1;
        const from = none ? null : (model.origins.find((o) => o.key === this._from) || model.origins[0])?.key ?? null;
        // a journey whose start is not read yet stays under every departure.
        // With none picked, the stretches cut at a via stay out: they ride
        // the runs of the journeys listed already
        const groups = none ? model.groups.filter((g) => g.jis.some((ji) => !model.jmeta[ji].cut))
            : model.groups.filter((g) => !g.from || g.from === from);
        let group = this._dest != null ? groups.find((g) => g.key === this._dest) || null : null;
        const solo = groups.length === 1;
        if (solo) group = groups[0];
        const way = group && this._way != null && group.jis.some((ji) => model.jmeta[ji].way === this._way) ? this._way : null;
        // anything that leaves a journey of the card out of the board
        const narrowed = (!none && model.origins.length > 1) || (!!group && !solo) || !!way;
        return { model, from, none, groups, group, dest: group?.key ?? null, way, solo, narrowed };
    }

    // Whether the header leaves journey ji on the board. A stretch cut at
    // a via rides the runs of the journey it is cut from: it is shown when
    // its own arrival is picked, or from a place only such stretches leave,
    // never beside that journey, where each run would be listed twice.
    _destKeeps(v, ji) {
        const m = v.model.jmeta[ji];
        if (!m || !v.groups.includes(m.g) || (v.group && m.g !== v.group) || (v.way && m.way !== v.way)) return false;
        return !m.cut || m.g === v.group || (!v.none && !v.model.origins.find((o) => o.key === v.from)?.real);
    }

    // On a card of lines, the lines the destination header leaves on the
    // board and on the map, a Set of their indexes, or null when nothing is
    // narrowed. A card of journeys narrows its journeys instead
    // (_visibleJourneys).
    _destLines() {
        if (this._journeys?.length) return null;
        const v = this._destView();
        if (!v?.narrowed) return null;
        const defs = this._lineDefs();
        const set = new Set();
        v.model.jmeta.forEach((m, ji) => {
            if (!this._destKeeps(v, ji)) return;
            for (const leg of v.model.entries[ji].legs) {
                const d = defs.find((x) => x.entity === leg.entity);
                if (d) set.add(d.idx);
            }
        });
        return set;
    }

    // the one line the header leaves, raised on the map the way a line picked
    // from its badge was: its shape on top, its ends pinned, its vehicles named
    _destTopLi() {
        const set = this._destLines();
        return set && set.size === 1 ? [...set][0] : null;
    }

    // The runs of some journeys, first to leave first, struck ones left out
    // A journey sits under its departure chip, its arrival chip and its way:
    // while the header draws, its runs are chained once (_destPass) and read
    // from there by every chip that shows it
    _destRuns(jis) {
        const entries = this._destModel().entries;
        const pass = this._destPass;
        return jis.flatMap((ji) => {
            if (pass?.has(ji)) return pass.get(ji);
            const plan = this._journeyPlan(ji, entries[ji]);
            const runs = plan ? this._journeyRuns(plan) : [];
            pass?.set(ji, runs);
            return runs;
        }).filter((j) => !j.struck).sort((a, b) => a.dep.getTime() - b.dep.getTime());
    }

    // What the operator reports on some journeys: the alert of a line they
    // ride, and any alert naming one of their runs, the worst kind first.
    // {kind, texts} or null
    // legsOf keeps the legs whose lines the chip is about - a departure
    // speaks of the lines boarded there only. As a list, [{kind, text}],
    // for the ways to drop what they all share (_destAlertSum sums it up)
    _destAlerts(jis, runs, legsOf = (legs) => legs) {
        const out = [];
        const take = (k, text) => {
            const t = String(text || "").trim();
            const x = { kind: k, text: t && t !== "None" && t !== "no info" ? t : "" };
            if (!out.some((o) => o.kind === x.kind && o.text === x.text)) out.push(x);
        };
        const defs = this._lineDefs();
        const entries = this._destModel().entries;
        const ents = new Set();
        for (const ji of jis) {
            for (const leg of legsOf(entries[ji].legs)) {
                ents.add(leg.entity);
                const def = defs.find((d) => d.entity === leg.entity);
                const a = def ? this._alertOf(def) : null;
                if (a) take(a.kind, a.text);
            }
        }
        for (const j of runs) for (const ride of j.rides) {
            if (!ents.has(ride.leg.def.entity)) continue;
            for (const it of ride.row?.alerts || []) take(alertKind(it.cause, it.effect), this._alertSay(it));
        }
        return out;
    }

    // a list of alerts as a chip shows it: the worst kind, the sentences.
    // Null when empty
    _destAlertSum(list) {
        const rank = { incident: 3, works: 2, alert: 1 };
        if (!list.length) return null;
        const kind = list.reduce((k, x) => (!k || rank[x.kind] > rank[k] ? x.kind : k), null);
        return { kind, texts: [...new Set(list.map((x) => x.text).filter(Boolean))] };
    }

    _renderDestHeader() {
        this._destPass = new Map();
        try { this._drawDestHeader(); } finally { this._destPass = null; }
    }

    _drawDestHeader() {
        const v = this._destView(), m = v.model, lang = this._lang(), now = new Date();
        const svg = (mode, px) => `<svg width="${px}" height="${px}" viewBox="${-PIP / 2} ${-PIP / 2} ${PIP} ${PIP}" aria-hidden="true">`
            + `${modeGlyph(mode, PIP_INK, "currentColor") || modeGlyph("bus", PIP_INK, "currentColor")}</svg>`;
        const alertSay = (a) => a.texts.join(" · ") || this._t("alert_" + a.kind);
        const title = this._config.title != null && String(this._config.title) !== ""
            ? `<div class="dtitle">${esc(this._config.title)}</div>` : "";

        // A chip, for a departure or an arrival alike: the lines it is
        // about as plates, its name, a note when nothing runs from it any
        // more, and the lines' marks. legsOf picks the legs whose
        // lines it shows: every leg on an arrival, the first one on a
        // departure, the line boarded there. {body, aria, tip}
        const modeText = (modes) => modes.map((md) => modeWord(lang, md, false)).join(" / ");
        const defs = this._lineDefs();
        const chip = (place, jis, color, modes, legsOf) => {
            // The lines of the chip, in the order they are ridden. They are
            // its identity: a number and a colour say which line it is, where
            // a mode only says what it runs on - two buses of the same stop
            // are told apart by "40" and "41", never by the fact that both
            // are buses. So the plates take the front of the chip, and the
            // mode rides the foot of each one.
            const shownLines = [...new Set(jis.flatMap((ji) => legsOf(m.entries[ji].legs))
                .map((l) => defs.find((d) => d.entity === l.entity)).filter(Boolean))];
            // two sensors of one line, a direction each, are one plate
            const plateKey = (d) => `${this._lineLabelOf(d)}|${d.color}`;
            const plateLines = shownLines.filter((d, i) => shownLines.findIndex((x) => plateKey(x) === plateKey(d)) === i);
            const plates = (lit) => {
                const keep = plateLines.slice(0, DEST_PLATES);
                const rest = plateLines.length - keep.length;
                if (!keep.length) return "";
                const one = (d) => {
                    // destination_color named this place, and the medallion it
                    // used to paint is gone: it paints the plates instead. It
                    // costs the per line colours on that chip, which is the
                    // user asking for it - the numbers still tell them apart.
                    // A quiet source drains its plate as it drained the badge:
                    // its lightness kept, its chroma gone.
                    const own = color || d.color;
                    const col = !lit ? null : (this._badgeState(d).mute ? drain(own) : own);
                    const label = this._lineLabelOf(d);
                    const style = col ? ` style="background:${esc(col)};color:${inkOn(col)}"` : "";
                    // mode_icons: false drops the band, not the plate: the
                    // option is about mode glyphs, and the number is the point
                    const band = this._config.mode_icons === false ? ""
                        : `<span class="band">${svg(d.mode || "bus", 11)}</span>`;
                    // a line the feed never named keeps its colour and shows
                    // its mode full height rather than an empty square
                    return `<span class="dplate big"${style}>` + (label
                        ? `<span class="n">${esc(label)}</span>${band}`
                        : `<span class="n">${svg(d.mode || "bus", 18)}</span>`) + `</span>`;
                };
                return `<span class="dplates">` + keep.map(one).join("")
                    + (rest ? `<span class="dmore">+${rest}</span>` : "") + `</span>`;
            };
            const med = (lit) => plates(lit);
            const runs = this._destRuns(jis);
            const first = runs[0];
            const alerts = this._destAlertSum(this._destAlerts(jis, runs, legsOf));
            // the badge's other two marks, for the lines of the chip: a source gone quiet (top left), and, with nothing left
            // to run, when service resumes (bottom left)
            const gdefs = shownLines;
            const gstates = gdefs.map((d) => this._badgeState(d));
            const muted = gstates.find((st) => st.mute);
            const resting = first ? [] : gdefs.filter((d, i) => gstates[i].resting).map((d) => d.nextIn);
            const restKind = !resting.length ? "" : resting.some((x) => x < 0) ? "never" : Math.max(...resting) === 1 ? "tomorrow" : "days";
            // said, not drawn twice: the plates at the front carry the lines,
            // and a screen reader gets them here in the same order
            const gnums = plateLines.map((d) => this._lineLabelOf(d)).filter(Boolean);
            // no clock: the journey is not chosen yet, a time on a place
            // would be the time of a journey nobody picked. The chip says
            // only when there is nothing left to take from it
            let next = "";
            let aria = `${place}, ${modeText(modes)}`;
            if (gnums.length) aria += `, ${gnums.map((l) => this._t("line_label", { l })).join(", ")}`;
            if (!first) {
                const rest = gdefs.map((d) => this._restingNote(d)).find(Boolean);
                const say = rest || this._t("none_upcoming");
                next = `<span class="dmuted">${esc(say)}</span>`;
                aria += `, ${say}`;
            }
            if (alerts) aria += `, ${this._t("alert_is", { a: alertSay(alerts) })}`;
            if (muted) aria += `, ${muted.muteTitle}`;
            const say = [alerts ? alertSay(alerts) : "", muted ? muted.muteTitle : ""].filter(Boolean).join(" · ");
            const tip = say ? ` title="${esc(say)}" data-tip="${esc(say)}"` : "";
            // the badge's corners, the badge's glyphs: the operator's alert
            // top right, the quiet source top left, the rest bottom left
            const mark = (cls, key) => `<span class="dmark ${cls}" aria-hidden="true">${svg(key, 22)}</span>`;
            const marks = (alerts ? mark("alert", alerts.kind) : "") + (muted ? mark("mute", "mute") : "")
                + (restKind ? mark("rest", restKind) : "");
            const body = med(true) + `<span class="dtxt"><b>${esc(place)}</b>${next}</span>${marks}`;
            return { body, aria, tip };
        };

        // the departures, as chips like the arrivals, the picked one lit:
        // shown as soon as the journeys start from more than one place. The
        // arrivals below are the ones reached from it. A departure's lines
        // are the ones boarded there, its modes theirs.
        const span = m.origins.length > 1;
        let fromRow = "";
        if (span) {
            const one = (o) => {
                const jis = m.groups.filter((g) => g.from === o.key).flatMap((g) => g.jis);
                const firstDefs = [...new Set(jis.map((ji) => defs.find((d) => d.entity === m.entries[ji].legs[0].entity)).filter(Boolean))];
                const modes = [...new Set(firstDefs.map((d) => d.mode || "bus"))];
                const c = chip(String(o.name || ""), jis, null, modes.length ? modes : ["bus"], (legs) => legs.slice(0, 1));
                const on = v.from === o.key;
                return `<button type="button" class="dest${on ? " on" : ""}" data-action="dest-from" data-from="${esc(o.key)}" data-fk="from:${esc(o.key)}"`
                    + ` aria-pressed="${on}" aria-label="${esc(c.aria)}"${c.tip}>${c.body}</button>`;
            };
            fromRow = `<div class="drow" role="group" aria-labelledby="dfrom-cap">${m.origins.map(one).join("")}</div>`;
        }

        // a chip per arrival from the departure picked
        // with no departure picked, an arrival reached from two places names
        // the one each chip leaves from
        const seenPlace = new Map();
        for (const g of v.groups) seenPlace.set(placeKey(g.place), (seenPlace.get(placeKey(g.place)) || 0) + 1);
        const originName = (k) => m.origins.find((o) => o.key === k)?.name || "";
        const chips = v.groups.map((g) => {
            const twice = v.none && g.from && seenPlace.get(placeKey(g.place)) > 1;
            const place = twice ? `${originName(g.from)} → ${g.place || ""}` : String(g.place || "");
            const { body, aria, tip } = chip(place, g.jis, g.color, g.modes, (legs) => legs);
            // the one destination of a card is no choice to make
            if (v.solo) return `<div class="dest solo" role="group" aria-label="${esc(aria)}"${tip}>${body}</div>`;
            const on = v.dest === g.key;
            return `<button type="button" class="dest${on ? " on" : ""}" data-action="dest" data-key="${esc(g.key)}" data-fk="dest:${esc(g.key)}"`
                + ` aria-pressed="${on}" aria-label="${esc(aria)}"${tip}>${body}</button>`;
        }).join("");

        // the ways to leave for the destination picked, soonest first: a
        // filter of the board, said as one, each on its line's plate
        let ways = "";
        if (v.group) {
            const byWay = new Map();
            for (const ji of v.group.jis) {
                const w = m.jmeta[ji].way;
                if (!byWay.has(w)) byWay.set(w, []);
                byWay.get(w).push(ji);
            }
            // a single way is no choice: nothing to filter the board by
            if (byWay.size < 2) byWay.clear();
            const soon = (x) => (x.runs[0] ? x.runs[0].dep.getTime() : Infinity);
            const list = [...byWay].map(([w, wj]) => ({ w, wj, runs: this._destRuns(wj) }))
                .sort((a, b) => (soon(a) > soon(b)) - (soon(a) < soon(b)));
            // an alert every way carries is the arrival's: its chip shows
            // it, the ways show only what tells them apart
            for (const x of list) x.al = this._destAlerts(x.wj, x.runs);
            const shared = (a) => list.every((x) => x.al.some((o) => o.kind === a.kind && o.text === a.text));
            for (const x of list) x.al = x.al.filter((a) => !shared(a));
            ways = !list.length ? "" : `<div class="dwcap">${esc(this._t("ways_caption"))}</div><div class="dways">` + list.map(({ w, wj, runs, al }) => {
                const direct = w.startsWith("direct:");
                const ents = [direct ? w.slice(7) : w];
                const lds = ents.map((e) => defs.find((d) => d.entity === e)).filter(Boolean);
                const labels = lds.map((d) => this._lineLabelOf(d));
                const label = direct ? this._t("way_direct")
                    : this._t(v.group.wayAt === "first" ? "way_via" : "way_then", { l: labels[0] || "" });
                const plates = lds.map((d) => `<span class="dplate" style="background:${esc(d.color)};color:${inkOn(d.color)}">`
                    + `<span class="n">${esc(this._lineLabelOf(d))}</span><span class="band">${svg(d.mode || "bus", 13)}</span></span>`).join("");
                const first = runs[0];
                const tag = first ? dayTag(lang, first.dep, now) : "";
                const clock = first ? `${tag ? tag + " " : ""}${fmtHM(first.dep)}` : "";
                // no run: why, as the board says it - a line resting until
                // Monday, a change waiting too long - rather than a dash
                const why = first ? "" : this._journeyIdle({ plans: wj.map((ji) => this._journeyPlan(ji, m.entries[ji])).filter(Boolean) }).msg;
                const alerts = this._destAlertSum(al);
                const on = v.way === w;
                const aria = [label, labels.map((l) => this._t("line_label", { l })).join(", "),
                    first ? this._t("next_dep_at", { t: clock }) : unesc(why),
                    alerts ? this._t("alert_is", { a: alertSay(alerts) }) : "",
                    on ? this._t("filter_on") : ""].filter(Boolean).join(", ");
                return `<button type="button" class="dway${on ? " on" : ""}" data-action="dest-way" data-way="${esc(w)}" data-fk="way:${esc(w)}"`
                    + ` aria-pressed="${on}" aria-label="${esc(aria)}"${alerts ? ` title="${esc(alertSay(alerts))}"` : ""}>`
                    + `<span class="dplates">${plates}</span><span class="dwtxt"><span class="lbl">${esc(label)}</span>${first ? `<span class="t">${esc(clock)}</span>` : `<span class="why">${why}</span>`}</span>`
                    + (alerts ? `<span class="dwal" aria-hidden="true">${svg(alerts.kind, 17)}</span>` : "")
                    + (on ? `<span class="x" aria-hidden="true">×</span>` : "") + `</button>`;
            }).join("") + `</div>`;
        }
        // under a departure row, the two rows hang on a rail like the
        // points of a journey's timeline: D beside the departures, A beside
        // the arrivals, the same discs as the timeline and the map
        const disc = (letter, cls, id, cap) => `<span class="jnode ${cls}"><span class="jnum">${esc(letter)}</span></span>`
            + `<span class="dwcap"${id ? ` id="${id}"` : ""}>${esc(cap)}</span>`;
        const route = !span ? "" : `<div class="droute">`
            + disc(this._t("pt_start"), "first", "dfrom-cap", this._t("from_caption"))
            + `<span class="jnode"></span>${fromRow}`
            + disc(this._t("pt_end"), "last", "", this._t("to_caption"))
            + `<span></span><div class="drow">${chips}</div></div>`;
        this.shadowRoot.getElementById("header").innerHTML =
            `<div class="dhead">${title}${span ? route : `<div class="drow">${chips}</div>`}${ways}`
            + this._capRow("") + `</div>`;
    }

    // the destination or the way picked, in the board's head, which drops
    // it: the way first, then the destination - never the one place of a
    // card going nowhere else
    _destFilterChip(clear) {
        const v = this._destView();
        if (!v?.group || (v.solo && !v.way)) return "";
        let text = String(v.group.place || "");
        if (v.way) {
            const direct = v.way.startsWith("direct:");
            const d = this._lineDefs().find((x) => x.entity === (direct ? v.way.slice(7) : v.way));
            const l = d ? this._lineLabelOf(d) : "";
            text = direct ? `${this._t("way_direct")}${l ? ` · ${l}` : ""}`
                : this._t(v.group.wayAt === "first" ? "way_via" : "way_then", { l });
        }
        return ` <span class="dfilter" data-action="dest-clear" data-fk="dest-clear" role="button" tabindex="0" title="${clear}" aria-label="${clear}: ${esc(text)}">`
            + `<span class="dfl">${esc(text)}</span><span class="x" aria-hidden="true">×</span></span>`;
    }

    _renderFooter() {
        if (!this._built) return;   // no shell yet: see _renderHeader
        // consider every departure sensor, not just the primary one: one line
        // ending its service must not relabel the whole card as schedule-only
        const lang = this._lang();
        const srcs = this._depSources();
        const rtTimes = srcs.map((s) => parseTs(s.st.attributes?.gtfs_rt_updated_at)).filter(Boolean).map((d) => d.getTime());
        const newest = rtTimes.length ? Math.max(...rtTimes) : 0;
        const unavailable = srcs.filter((s) => s.st.state === "unavailable").length;
        let left = srcs.length
            ? (newest ? this._t("updated", { t: fmtAgo(lang, Date.now() - newest) }) : this._t("schedule_only"))
            : this._t("rt_positions");
        if (unavailable) left += ` · ${this._t("sensors_unavailable", { n: unavailable })}`;
        const html = `<span>${esc(left)}</span><span>gtfs2</span>`;
        if (this._footerHtml !== html) {
            this.shadowRoot.getElementById("footer").innerHTML = html;
            this._footerHtml = html;
        }
    }

    /* ── PANE 1: DEPARTURES ─────────────────────────────────────────────── */

    _departureRows() {
        let sources = this._depSources();
        // a line picked by tracking its vehicle filters the board to that
        // line's departures, and the destination header to its lines
        if (this._hiLine != null) sources = sources.filter((s) => s.def && s.def.idx === this._hiLine);
        const dlines = this._destLines();
        if (dlines) sources = sources.filter((s) => s.def && dlines.has(s.def.idx));
        const rows = [];
        for (const src of sources) rows.push(...this._sourceRows(src));
        // a row leaves the board only once BOTH of its clocks are behind us:
        // a late bus keeps its future realtime, an early bus keeps its future
        // schedule slot. Filtering on the realtime alone dropped an early bus
        // before the hour printed at the stop had even come.
        // A struck run stays a few minutes past its time: the rider who
        // came for it reads why it is not there.
        const now = Date.now(), cutoff = now - 60000;
        const upcoming = rows.filter((r) => (r.struck
            ? r.time.getTime() + STRUCK_KEEP > now
            : Math.max(r.time.getTime(), r.theo ? r.theo.getTime() : 0) > cutoff));
        upcoming.sort((x, y) => x.time.getTime() - y.time.getTime());
        return { rows: upcoming.slice(0, this._config.max_departures), multi: sources.length > 1 };
    }

    // A departure ridden by another mode than its line's, a replacement
    // coach listed by a train line: its glyph beside the time, the same one
    // the badge draws for a bus. Nothing when the modes agree, so a board of
    // one mode reads as it always did.
    _rowModeHtml(r) {
        if (r.rtype == null || !r.def || this._config.mode_icons === false) return "";
        const mode = modeKey(r.rtype);
        if (mode === (r.def.mode || "bus")) return "";
        const word = modeWord(this._lang(), mode, false);
        return `<span class="row-mode" title="${esc(word)}" aria-label="${esc(word)}">`
            + `<svg viewBox="${-PIP / 2} ${-PIP / 2} ${PIP} ${PIP}" aria-hidden="true">${modeGlyph(mode, PIP_INK, "currentColor")}</svg></span>`;
    }

    // one sensor's departures as rows {time, theo, rt, delayMin, durMin,
    // rtype, tripId, def}, realtime paired with its schedule slot; after
    // them the runs the feed struck out (struck: "cancelled", or "skipped"
    // when the run does not call at the origin), timed as the sensor last
    // listed them; an alert naming a run rides on its row (alerts). Neither
    // filtered nor sorted, the board and the journey chain do that their
    // own way
    // The header asks for the same sensor's rows once per chip and the board
    // once more: on a card of sixty sensors that was two hundred readings of
    // the same lists for one drawing. Kept per state object, which Home
    // Assistant replaces whenever the sensor changes, for a few seconds (the
    // rows lean on the clock: a feed going stale, a struck run expiring).
    // Handed out as copies, the board trims the alerts of its own rows.
    _sourceRows(src) {
        const now = Date.now();
        const hit = this._rowsCache.get(src.st);
        if (hit && now - hit.at < 5000) return hit.rows.map((r) => ({ ...r, def: src.def }));
        const rows = this._readSourceRows(src);
        this._rowsCache.set(src.st, { at: now, rows });
        return rows.map((r) => ({ ...r }));
    }

    _readSourceRows(src) {
        const rows = [];
        const a = src.st.attributes || {};
        const theoRaw = Array.isArray(a.next_departures) ? a.next_departures : [];
        const dursRaw = Array.isArray(a.next_departures_durations) ? a.next_departures_durations : [];
        const arrsRaw = Array.isArray(a.next_departures_destination_arrival_times) ? a.next_departures_destination_arrival_times : [];
        // one entry per parsable departure, its journey time riding along
        // so the pairing survives the filter and the multi-line sort:
        // served ready-made by gtfs2 when the attribute exists, else
        // derived from the paired arrivals list
        // the trip each departure rides, when the sensor says (gtfs2 lists
        // them beside the departures, cut to the same ten): what the leg
        // file is keyed by
        const tripsRaw = Array.isArray(a.next_departures_trips) ? a.next_departures_trips : [];
        // what rides each departure, when the sensor says: gtfs2 marks a
        // coach listed by a train line 714, a rail replacement bus
        const typesRaw = Array.isArray(a.next_departures_route_types) ? a.next_departures_route_types : [];
        const theoAll = theoRaw.map((v, j) => {
            const t = parseTs(v);
            if (!t) return null;
            let dur = typeof dursRaw[j] === "number" ? dursRaw[j] : null;
            if (dur == null) {
                const arr = parseTs(arrsRaw[j]);
                if (arr) dur = Math.round((arr.getTime() - t.getTime()) / 60000);
            }
            return { t, dur, tripId: tripsRaw[j] != null ? String(tripsRaw[j]) : null,
                rtype: typesRaw[j] != null ? typesRaw[j] : null };
        }).filter(Boolean);
        // a feed gone quiet leaves its last predictions behind: past
        // RT_STALE they are not live any more, and the schedule stands in
        const rtAt = parseTs(a.gtfs_rt_updated_at);
        const rtStale = !!rtAt && Date.now() - rtAt.getTime() > RT_STALE;
        const rtRaw = rtStale ? [] : (Array.isArray(a.next_departures_realtime) ? a.next_departures_realtime : []);
        const delays = Array.isArray(a.next_delays_realtime) ? a.next_delays_realtime : [];
        // the trip behind each realtime time, when gtfs2 names them (in the
        // order of the times): the schedule slot is then that trip's own,
        // however far the feed moved it. Without ids, the nearest slot
        // within ten minutes: a 16-min-away slot is another bus, not this
        // one's theoretical time
        const rtTrips = Array.isArray(a.next_departures_realtime_trips) ? a.next_departures_realtime_trips : [];
        const byId = rtTrips.length === rtRaw.length && theoAll.some((x) => x.tripId);
        const usedTheo = new Set();
        rtRaw.forEach((v, i) => {
            const t = parseTs(v);
            if (!t) return;
            const tid = byId && rtTrips[i] != null ? String(rtTrips[i]) : null;
            let best = -1, bd = Infinity;
            theoAll.forEach((x, j) => {
                // the nearest slot of that trip: a line running a few times
                // a day lists the same trip id two days running
                if (usedTheo.has(j) || (byId && x.tripId !== tid)) return;
                const d = Math.abs(x.t.getTime() - t.getTime());
                if (d < bd) { bd = d; best = j; }
            });
            if (best >= 0 && !byId && bd > 10 * 60000) best = -1;
            const theoT = best >= 0 ? theoAll[best].t : null;
            if (best >= 0) usedTheo.add(best);
            // feeds like TAO publish no delay field (0 = unknown): trust
            // the matched schedule first, a nonzero feed delay second
            const rawDelay = typeof delays[i] === "number" && delays[i] !== 0 ? delays[i] : null;
            const delayMin = theoT
                ? Math.round((t.getTime() - theoT.getTime()) / 60000)
                : (rawDelay != null ? Math.round(rawDelay / 60) : null);
            rows.push({ time: t, theo: theoT, rt: true, delayMin, durMin: theoT ? theoAll[best].dur : null,
                tripId: theoT ? theoAll[best].tripId : tid,
                rtype: theoT ? theoAll[best].rtype : null, def: src.def });
        });
        theoAll.forEach((x, j) => {
            if (!usedTheo.has(j)) rows.push({ time: x.t, theo: null, rt: false, delayMin: null, durMin: x.dur, tripId: x.tripId, rtype: x.rtype, def: src.def });
        });
        // The runs the sensor lists, remembered while they are ahead. A run
        // the feed strikes out leaves the sensor's lists at once (gtfs2
        // moves the board on to the next one that runs) and the leg file
        // with them; only its id stays, in cancelled_trips_realtime or
        // skipped_trips_realtime. A board where the 17:42 simply vanished
        // would tell the rider waiting for it nothing, so its row is kept
        // from here, timed as last listed, and struck. A run the card never
        // listed cannot be shown: there is no time to strike.
        const now = Date.now();
        for (const [k, m] of this._seenRows) if (m.t.getTime() + STRUCK_KEEP < now) this._seenRows.delete(k);
        const ent = src.st.entity_id || src.def?.entity || "";
        const listed = new Set();
        for (const x of theoAll) {
            if (!x.tripId) continue;
            const key = `${ent}|${x.tripId}|${x.t.getTime()}`;
            listed.add(key);
            if (!this._seenRows.has(key)) this._seenRows.set(key, { t: x.t, dur: x.dur, rtype: x.rtype, tripId: x.tripId });
        }
        const struckOf = (ids, kind) => {
            const want = new Set((Array.isArray(ids) ? ids : []).map(String));
            if (!want.size) return;
            for (const [key, m] of this._seenRows) {
                // still listed: the feed struck it on another day
                if (!key.startsWith(ent + "|") || !want.has(m.tripId) || listed.has(key)) continue;
                rows.push({ time: m.t, theo: m.t, rt: true, delayMin: null, durMin: m.dur, tripId: m.tripId, rtype: m.rtype, def: src.def, struck: kind });
            }
        };
        struckOf(a.cancelled_trips_realtime, "cancelled");
        struckOf(a.skipped_trips_realtime, "skipped");
        // the alerts naming a run of the board, on its row
        const alerts = this._tripAlerts(a);
        if (alerts.size) for (const r of rows) if (r.tripId && alerts.has(r.tripId)) r.alerts = alerts.get(r.tripId);
        return rows;
    }

    // The operator's alerts that name departures of the board, by the trip
    // they name: {trip id → [items]}, each worst first as gtfs2 ranks them.
    // gtfs2 lists on every item of the stack the trips it names (trips),
    // head first; an alert on the second train of the board is there too,
    // with later_only, where the one sentence of origin_stop_alert never
    // takes it.
    _tripAlerts(a) {
        const out = new Map();
        for (const it of Array.isArray(a.origin_stop_alerts) ? a.origin_stop_alerts : []) {
            for (const t of Array.isArray(it?.trips) ? it.trips : []) {
                const k = String(t);
                if (!out.has(k)) out.set(k, []);
                out.get(k).push(it);
            }
        }
        return out;
    }

    // What the operator says of this run, when an alert names it: the mark
    // of its kind beside the time, the badge's own glyph, the sentence in
    // the tooltip - printed under the mark on a tap, a finger cannot hover
    _rowAlertHtml(r) {
        return this._alertMarkHtml(r?.alerts);
    }

    /* ── JOURNEY: legs chained on the board, slices numbered on the map ── */

    // Where a leg starts and ends on its route shape: indexes into
    // route.stops, or null while the shape is not read yet. The sensor names
    // its two ends three ways, tried from the surest to the loosest: the
    // stop_sequence (only trains carry it today), the stop id (the record
    // the user picked, which on a grouped stop is not always the platform
    // the trip serves), then the name. The destination is looked for AFTER
    // the origin: a loop line calls at a stop twice. An end not found falls
    // back on the shape's own end, so the slice still draws.
    _legSlice(def, st) {
        const route = this._ld[def.idx]?.route || null;
        const at = st?.attributes || {};
        const meta = this._emeta.get(def.entity) || {};
        const idOf = (v) => (v == null ? "" : String(v).split(": ")[0]);
        const ends = {
            oid: idOf(at.origin_station_stop_id) || meta.origin || "",
            oname: at.origin_station_stop_name ?? meta.oname ?? "",
            oseq: at.origin_station_stop_sequence,
            did: idOf(at.destination_station_stop_id) || meta.dest || "",
            dname: at.destination_station_stop_name ?? meta.dname ?? "",
            dseq: at.destination_station_stop_sequence,
        };
        // an unavailable sensor loses its attributes: keep the ends it named
        if (def.entity && (at.origin_station_stop_id || at.destination_station_stop_id)) {
            const patch = {};
            if (ends.oid) patch.origin = ends.oid;
            if (ends.oname) patch.oname = ends.oname;
            if (ends.did) patch.dest = ends.did;
            if (ends.dname) patch.dname = ends.dname;
            this._remember(def.entity, patch);
        }
        if (!route?.stops?.length) return { route: null, oi: null, di: null, oFound: false, dFound: false, ...ends };
        const stops = route.stops;
        let oi = findStopIdx(stops, ends.oseq, ends.oid, ends.oname, 0);
        const oFound = oi >= 0;
        if (oi < 0) oi = 0;
        let di = findStopIdx(stops, ends.dseq, ends.did, ends.dname, oi + 1);
        const dFound = di >= 0;
        if (di < 0) di = stops.length - 1;
        return { route, oi, di, oFound, dFound, ...ends };
    }

    // One journey resolved against the lines and the shapes read so far:
    // its legs, and its numbered points in riding order - 0 at the first
    // sensor's origin, one per via, one where each leg ends (a change, or
    // the arrival). Every leg runs from its sensor's origin to its
    // destination; a later one is boarded at its own origin, the change
    // being direct or on foot (see _walkOf). A leg whose sensor is not among
    // the lines is skipped; a via naming one of the sensor's ends says
    // nothing more and is dropped, and one not found between them keeps its
    // number and its name, and is reported. Null without a leg.
    _journeyPlan(ji, jr = this._journeys?.[ji]) {
        if (!jr) return null;
        const defs = this._lineDefs();
        const groups = jr.legs.map((leg) => ({ leg, def: defs.find((d) => d.entity === leg.entity) })).filter((g) => g.def);
        if (!groups.length) return null;
        const lc = (x) => String(x ?? "").trim().toLowerCase();
        const legs = [], points = [], missing = [];
        let n = 0;
        groups.forEach((g, k) => {
            const st = this._hass?.states?.[g.leg.entity] || null;
            const leg = { idx: k, def: g.def, st, slice: this._legSlice(g.def, st) };
            const s = leg.slice;
            const lg = this._ld[g.def.idx]?.leg;
            // where the leg is boarded: get_on when it names a stop between
            // the sensor's ends, else the sensor's origin. A stop the runs
            // call at that the shape does not carry rides as the leg's own
            // (onAlt, offAlt): its name, its place, its clocks
            let si = s.oi, sname = s.oname || null;
            const on = g.leg.getOn;
            leg.onAlt = leg.offAlt = null;
            // the sensor's own end, where the shape's stop there is another
            // record - a coach station under a rail line's shape: the stop
            // its runs call at, from the leg file, when it says where
            const own = (i, id) => {
                if (i == null || !id || s.route?.stops[i]?.id === id) return null;
                const pl = lg?.places?.get(String(id));
                // the shape's clock there still times a run the leg file
                // does not list
                return pl ? { ...this._world(pl.lat, pl.lon), id: pl.id, name: pl.name, time: s.route?.stops[i]?.time } : null;
            };
            if (on != null && ![lc(s.oname), lc(s.oid)].includes(lc(on))) {
                if (s.route) {
                    const r = this._stopOnLeg(s.route, lg, on, 0);
                    if (r && (s.di == null || r.i < s.di)) { si = r.i; leg.onAlt = r.alt || null; sname = r.alt?.name || s.route.stops[r.i].name; }
                    else missing.push(on);
                } else sname = on;
            }
            if (si === s.oi && !leg.onAlt) leg.onAlt = own(si, s.oid);
            leg.si = si;
            // where the leg is left: get_off when it names a stop between
            // where it is boarded and the sensor's destination, else that
            let ei = s.di, ename = s.dname || null, cut = false;
            const off = g.leg.getOff;
            if (off != null && ![lc(s.dname), lc(s.did)].includes(lc(off))) {
                if (s.route) {
                    const r = this._stopOnLeg(s.route, lg, off, (si ?? -1) + 1);
                    if (r && (s.di == null || r.i < s.di)) { ei = r.i; leg.offAlt = r.alt || null; ename = r.alt?.name || s.route.stops[r.i].name; cut = true; }
                    else missing.push(off);
                } else ename = off;
            }
            if (ei === s.di && !leg.offAlt) leg.offAlt = own(ei, s.did);
            leg.ei = ei;
            const stopAt = (i) => (i != null ? s.route?.stops[i] || null : null);
            if (k === 0) points.push({ n, kind: "start", leg, at: si, alt: leg.onAlt, name: sname });
            else {
                // a later leg is boarded at its sensor's origin: the stop the
                // previous leg is left at makes a direct change, one number
                // for one place; any other stop is a walk away, and its far
                // end has a number of its own
                const prev = legs[k - 1];
                leg.walk = this._walkOf(prev, leg);
                leg.board = { kind: "board", at: si, stop: leg.onAlt || stopAt(si), name: leg.onAlt?.name || stopAt(si)?.name || sname || "", n: leg.walk.direct ? prev.end.n : ++n };
            }
            // the stops on the way, in riding order, strictly between where
            // the leg is boarded and where it is left; one past a get_off is
            // not the journey's and says nothing
            let cursor = si ?? -1;
            for (const ref of g.leg.via) {
                if ([lc(s.oname), lc(s.dname), lc(s.oid), lc(s.did), lc(sname), lc(ename)].includes(lc(ref))) continue;
                let at = null, alt = null;
                if (s.route) {
                    const r = this._stopOnLeg(s.route, lg, ref, cursor + 1);
                    const i = r ? r.i : -1;
                    if (i >= 0 && (ei == null || i < ei)) { at = i; cursor = i; alt = r.alt || null; }
                    else if (i >= 0 && cut) continue;
                    else missing.push(ref);
                }
                points.push({ n: ++n, kind: "via", leg, at, alt, name: alt?.name || (at != null ? s.route.stops[at].name : ref) });
            }
            leg.end = { n: ++n, kind: k === groups.length - 1 ? "end" : "transfer", leg, at: ei, alt: leg.offAlt, name: ename || stopAt(ei)?.name || "" };
            points.push(leg.end);
            legs.push(leg);
        });
        // a change closes one leg and opens the next at its sensor's origin
        legs.forEach((leg, k) => {
            if (leg.end.kind !== "transfer") return;
            leg.end.to = legs[k + 1];
            leg.end.toAt = legs[k + 1].si;
        });
        for (const p of points) {
            const stop = p.at != null ? (p.alt || p.leg.slice.route?.stops[p.at]) : null;
            if (stop) { p.stop = stop; if (!p.name) p.name = stop.name; }
            if (p.kind === "transfer" && p.toAt != null) p.toStop = p.to.onAlt || p.to.slice.route?.stops[p.toAt] || null;
        }
        return { ji, name: jr.name, legs, points, missing };
    }

    // The journeys shown, with their indexes. All of them among the trips,
    // none on the board of lines while no line is picked.
    // A line picked from its badge shows as one journey of its own, under
    // an index below zero: the line read as a line, between its sensor's
    // two ends, with every stop the trips get on it or off it on the way
    // (_lineViaNames). The trips riding it say where those stops are, never
    // how far the line goes: a line is its whole length, terminus to
    // terminus, whatever a rider does with it.
    _visibleJourneys(li) {
        let all = (this._journeys || []).map((jr, ji) => ({ jr, ji }));
        // the stretches cut at a via are places for the destination header:
        // the board of lines shows the journeys as written, via included
        if (this._modeOf() !== "trips") all = all.filter(({ jr }) => !jr.cut);
        // the destination header narrows them first: the departure, then
        // the arrival and the way picked
        const v = this._destView();
        if (v) all = all.filter(({ ji }) => this._destKeeps(v, ji));
        // the board of lines with no badge picked is about every line alike:
        // no journey numbered, framed or filtering the vehicles, since the
        // header shows nothing that picked one
        if (li == null) return this._modeOf() === "trips" ? all : [];
        const def = this._lineDefs().find((d) => d.idx === li);
        if (!def?.entity) return [];
        return [{ jr: { name: null, legs: [{ entity: def.entity, via: this._lineViaNames(def), getOn: null, getOff: null, over: {} }] }, ji: -1 - li }];
    }

    // Where a stop the config names sits on a leg: the shape's own stop when
    // one is that stop exactly - its id, or its name. Else the stop the
    // sensor's runs call at under that id or name, from the leg file, the
    // shape's stop nearest to it standing in where the slice is cut: a
    // shape drawn from a run of another mode - a rail line's substitute
    // coach - calls at other stops, even under names alike, and a train
    // never calls at a coach station. Else the shape's loosest match, as
    // before. {i, alt?} or null
    _stopOnLeg(route, lg, ref, from) {
        const stops = route.stops;
        const want = String(ref).trim(), lw = want.toLowerCase();
        for (let i = Math.max(0, from); i < stops.length; i++) {
            if (stops[i].id === want || stops[i].name.trim().toLowerCase() === lw) return { i };
        }
        const place = lg?.places?.get(want) || [...(lg?.places?.values() || [])].find((q) => q.name.toLowerCase() === lw);
        if (place) {
            const w = this._world(place.lat, place.lon);
            let best = -1, bd = Infinity;
            for (let i = Math.max(0, from); i < stops.length; i++) {
                const d = Math.hypot(stops[i].x - w.x, stops[i].y - w.y);
                if (d < bd) { bd = d; best = i; }
            }
            if (best >= 0) return { i: best, alt: { ...w, id: place.id, name: place.name, time: stops[best].time } };
        }
        const i = findStopIdx(stops, null, ref, ref, from);
        return i >= 0 ? { i } : null;
    }

    // The stops on the way of a line: where the card's trips get on it or
    // off it between the sensor's two ends - Les Aubrais on a train from
    // Orléans a trip boards there - in riding order. The names alone,
    // whichever trip rides them, which is what makes them the line's own
    // and not one journey's. [] for a line no trip leaves or joins.
    _lineViaNames(def) {
        if (!def?.entity) return [];
        const names = new Set();
        for (const jr of this._journeys || []) {
            for (const l of jr.legs) {
                if (l.entity !== def.entity) continue;
                if (l.getOn) names.add(l.getOn);
                if (l.getOff) names.add(l.getOff);
            }
        }
        if (!names.size) return [];
        const stops = this._legSlice(def, this._hass?.states?.[def.entity] || null).route?.stops || [];
        const at = (n) => { const i = stops.findIndex((x) => x.name === n); return i < 0 ? Infinity : i; };
        return [...names].sort((a, b) => at(a) - at(b));
    }

    // Those stops as the board prints them, on the line's own plan: the
    // whole line, so a stop is numbered where it sits on it.
    // [{p, leg}], empty for a line no trip leaves or joins on its way
    _lineVias(def) {
        const via = this._lineViaNames(def);
        if (!via.length) return [];
        const plan = this._journeyPlan(-1 - def.idx, { name: null, legs: [{ entity: def.entity, via, getOn: null, getOff: null, over: {} }] });
        return plan ? plan.points.filter((p) => p.kind === "via").map((p) => ({ p, leg: p.leg })) : [];
    }

    // a departure's times at its line's stops on the way: [{name, when}]
    // (see _rideTime), from vias built once per board
    _rowVias(r, vias) {
        if (!r.def || r.struck) return [];
        const list = vias.get(r.def.idx) || [];
        return list.map(({ p, leg }) => ({ name: p.name || "", when: this._rideTime(p, { leg, row: r }), li: leg.def.idx }));
    }

    // one departure's stops on the way, as the board prints them: the
    // name, then the clock, or why the run does not call there. A stop the
    // operator says something about wears the mark of what is said, so a
    // closed station is read where the rider reads their stops, not only in
    // the strip of alerts under the board.
    _viasHtml(list) {
        return list.map((v) => `<span class="via-t">${this._alertMarkHtml(this._stopAlertsAt(v.li, v.name))}`
            + `${esc(v.name)} ${this._clockHtml(v.when) || "—"}</span>`).join(" · ");
    }

    // the plans of the journeys shown (see _visibleJourneys)
    _visiblePlans() {
        return this._visibleJourneys(this._hiLine).map(({ jr, ji }) => this._journeyPlan(ji, jr)).filter(Boolean);
    }

    // The change between two legs: direct when the next sensor departs from
    // the stop the previous one arrives at (the same record, or two records
    // a few metres apart), else a walk between the two, timed at 4.2 km/h
    // over the straight line lengthened by a third for the streets. Either
    // way a minute to reach the platform. Stops not placed on their shapes
    // fall back on their names, and on 3 minutes for a walk.
    _walkOf(prev, next) {
        const a = prev.offAlt || prev.slice.route?.stops[prev.ei], b = next.onAlt || next.slice.route?.stops[next.si];
        if (a && b) {
            const m = Math.hypot(b.x - a.x, b.y - a.y) * (prev.slice.route.mPerU || 1);
            if (a.id === b.id || m <= 20) return { direct: true, m: 0, min: 1 };
            return { direct: false, m: Math.round(m), min: Math.ceil(1 + (m * 1.3) / 70) };
        }
        const same = String(prev.end?.name || prev.slice.dname || "").trim().toLowerCase() === String(next.slice.oname || "").trim().toLowerCase();
        return same ? { direct: true, m: 0, min: 1 } : { direct: false, m: null, min: 3 };
    }

    // The next runs of one journey: one per upcoming departure of its first
    // sensor, each later leg taken on the first departure of its sensor at
    // or after the previous arrival plus the change. A run whose chain
    // breaks - no such departure among the ten the sensor lists, no time
    // for an arrival, or a change waiting longer than max_transfer_wait, the
    // night spent on a platform - is not one anyone can take from the
    // board, and is not shown. Every other run is returned and shown: the
    // first run the rider can take is the answer, even when a later one
    // would arrive sooner.
    _journeyRuns(plan) {
        const cutoff = Date.now() - 60000;
        const maxWait = this._maxWait();
        // why chains broke, for the board to say when none is left: a stop
        // the runs were not found calling at, or a change waiting too long
        plan.cut = { wait: false, unserved: null, untimed: null, later: null };
        // the first stop a chain broke at, and why: the runs do not call
        // there, or call with the door shut on the side the rider needs
        const cutAt = (leg, name, r) => {
            if (!plan.cut.unserved) plan.cut.unserved = { leg, name, why: r.noBoard ? "board" : r.noAlight ? "alight" : null };
        };
        // when a ride reaches where the leg is left; a run that does not
        // set down there has no arrival, and the chain says so when no
        // run is left to show
        const arrOf = (leg, ride) => {
            const r = this._rideTime(leg.end, ride);
            if (r?.unserved) cutAt(leg, leg.end.name, r);
            return r?.t || null;
        };
        // the first leg's runs are the sensor's; a later leg's reach past
        // them into the timetable when the chain needs them (see _legRows)
        const rowsOf = plan.legs.map((leg) => (leg.st ? this._sourceRows({ def: leg.def, st: leg.st }) : []).sort((a, b) => a.time.getTime() - b.time.getTime()));
        const widened = new Set();
        const out = [];
        const l0 = plan.legs[0];
        const atOrigin = l0.si === l0.slice.oi;
        for (const r0 of rowsOf[0]) {
            // a run the feed struck out is said on the board when the
            // journey boards it at the sensor's origin, the one place its
            // time is known; it is never chained
            if (r0.struck) {
                if (atOrigin && r0.time.getTime() + STRUCK_KEEP > Date.now()) {
                    out.push({ plan, key: `${plan.ji}:${r0.tripId || r0.time.getTime()}`, struck: r0.struck,
                        rides: [{ leg: l0, row: r0, wait: null, dep: r0.time, depRt: true, arr: null }],
                        rt: true, delay: null, dep: r0.time, depRt: true, arr: null });
                }
                continue;
            }
            const ride0 = { leg: l0, row: r0, wait: null };
            // boarded at the sensor's origin, the sensor's departure; at a
            // get_on, the run's time there - a run already past it, or not
            // calling there, is not one to board
            const t0 = atOrigin ? { t: r0.time, rt: !!r0.rt } : this._rideTime(plan.points[0], ride0);
            if (!t0?.t) {
                if (t0?.unserved) cutAt(l0, plan.points[0].name, t0);
                continue;
            }
            const theo0 = atOrigin && r0.theo ? r0.theo.getTime() : 0;
            if (Math.max(t0.t.getTime(), theo0) <= cutoff) continue;
            ride0.dep = t0.t;
            ride0.depRt = !!t0.rt;
            ride0.arr = arrOf(l0, ride0);
            const rides = [ride0];
            let broken = false;
            for (let k = 1; k < plan.legs.length; k++) {
                const prev = rides[k - 1];
                const leg = plan.legs[k];
                if (!prev.arr) {
                    // An arrival nothing can date. A leg is timed at its own
                    // origin by the sensor and anywhere else by its shape or
                    // its leg file; with neither, the card knows when the
                    // rider boards and never when they get off, so no chain
                    // can be built and the board would say "nothing upcoming"
                    // as if the service were over. Recorded once per plan:
                    // it is a property of the source, not of this run.
                    if (!plan.cut.untimed && !prev.leg.slice.route && !this._ld[prev.leg.def.idx]?.leg) {
                        plan.cut.untimed = prev.leg;
                    }
                    broken = true;
                    break;
                }
                const earliest = prev.arr.getTime() + (leg.walk?.min ?? 1) * 60000;
                if (!widened.has(k)) {
                    const listed = rowsOf[k];
                    // the list may run out before the wait allowed does:
                    // the runs past it, and the timetables of the legs after
                    // this one asked for together, so they land in one go
                    // rather than one leg per drawing
                    if (!listed.length || listed[listed.length - 1].time.getTime() < earliest + maxWait * 60000) {
                        for (let n = k; n < plan.legs.length; n++) {
                            if (widened.has(n)) continue;
                            rowsOf[n] = this._legRows(plan.legs[n].def, plan.legs[n].st);
                            widened.add(n);
                        }
                    }
                }
                // the run is picked by when it reaches the stop the leg is
                // boarded at: the sensor's origin, or its get_on
                const atO = leg.si === leg.slice.oi;
                // gone: a run left out as past before it was timed, which
                // says nothing of whether it calls at the stop
                let ride = null, served = false, unserved = null, gone = false;
                for (const row of rowsOf[k]) {
                    if (row.struck) continue;
                    // the runs are in order of leaving the sensor's origin,
                    // and a run is at the boarding stop after it leaves:
                    // none later can beat the one found, and one that
                    // reached the sensor's end before the rider came
                    // cannot board them. What keeps a timetable's
                    // hundreds of runs from being timed one by one
                    if (ride && row.time.getTime() >= ride.dep.getTime()) break;
                    if (row.time.getTime() + (Number.isFinite(row.durMin) ? row.durMin : 240) * 60000 < earliest) { gone = true; continue; }
                    const cand = { leg, row };
                    const tb = atO ? { t: row.time, rt: !!row.rt } : this._rideTime(leg.board, cand);
                    if (tb?.t) served = true; else if (tb?.unserved) unserved = unserved || tb;
                    if (!tb?.t || tb.t.getTime() < earliest || (ride && tb.t >= ride.dep)) continue;
                    ride = Object.assign(cand, { dep: tb.t, depRt: !!tb.rt });
                }
                if (!ride) {
                    if (unserved && !served && !gone) cutAt(leg, leg.board.name, unserved);
                    // runs there, all gone by the time the rider gets
                    // there: the sensor lists none later
                    else if ((served || gone) && !plan.cut.later) {
                        const listed = rowsOf[k].filter((r) => !r.tt);
                        plan.cut.later = { leg, at: new Date(earliest), tt: this._timetable(leg.def),
                            last: listed.length ? listed[listed.length - 1].time : null };
                    }
                    broken = true;
                    break;
                }
                ride.wait = clockMins(prev.arr, ride.dep);
                if (ride.wait > maxWait) { plan.cut.wait = true; broken = true; break; }
                ride.arr = arrOf(leg, ride);
                rides.push(ride);
            }
            if (broken) continue;
            const last = rides[rides.length - 1];
            // the status of the run is the one of its arrival: the delay
            // there when the feed times it, else the worst delay of a leg
            // ridden, so a late tram is never hidden behind an on-time bus -
            // and on time only when the feed times every leg: a train it
            // says nothing of may be late
            const endT = this._rideTime(last.leg.end, last);
            const rt = rides.some((r) => r.row.rt);
            let delay = null;
            if (endT?.rt && endT.sch) delay = Math.round((endT.t.getTime() - endT.sch.getTime()) / 60000);
            else {
                const ds = rides.filter((r) => r.row.rt && r.row.delayMin != null).map((r) => r.row.delayMin);
                const worst = ds.length ? Math.max(...ds) : null;
                if (worst != null && (worst > 0 || rides.every((r) => r.row.rt))) delay = worst;
            }
            out.push({ plan, key: `${plan.ji}:${r0.tripId || r0.time.getTime()}`, rides, rt, delay,
                dep: ride0.dep, depRt: ride0.depRt, arr: last.arr });
        }
        return out;
    }

    // The journeys of the board: one section per name - the journeys
    // sharing it are itineraries to the same place - and one per unnamed
    // journey, titled by its ends. Each keeps its runs by departure, as
    // many as the card allows (all): the list merges them all into one
    // column; the table stacks the sections, which share those rows, two
    // at the least each (runs). Null without a journey.
    _journeySections() {
        const plans = this._visiblePlans();
        if (!plans.length) return null;
        const secs = [];
        for (const plan of plans) {
            const sec = plan.name != null ? secs.find((s) => s.name === plan.name) : null;
            if (sec) sec.plans.push(plan);
            else secs.push({ name: plan.name, plans: [plan] });
        }
        const max = this._config.max_departures;
        const limit = secs.length > 1 ? Math.max(2, Math.ceil(max / secs.length)) : max;
        for (const sec of secs) {
            const p0 = sec.plans[0];
            sec.key = `s${p0.ji}`;
            // a journey's name says where it goes; one with its ends the other
            // way round says its own ends
            sec.title = (this._destModel().jmeta[p0.ji]?.own !== false && sec.name)
                || `${p0.points[0]?.name || ""} → ${p0.points[p0.points.length - 1]?.name || ""}`;
            // every run of every journey in it, first to leave first
            sec.all = sec.plans.flatMap((p) => this._journeyRuns(p)).sort((a, b) => a.dep.getTime() - b.dep.getTime());
            for (const j of sec.all) j.sec = sec;
        }
        // Two ways by the same lines that differ only in where they change
        // (the 6 and the 4 share Denfert-Rochereau and Raspail) are one way
        // to the rider: of the runs that leave on the same departure, the
        // one that arrives first is kept, the one that walks least when
        // they tie. Across the sections, which an unnamed journey has of
        // its own
        const best = new Map();
        const walkOf = (run) => run.plan.legs.reduce((m, l) => m + (l.walk?.m || 0), 0);
        const keyOf = (run) => `${run.plan.legs.map((l) => l.def.entity).join(">")}|${run.rides[0].row.tripId || run.dep.getTime()}`;
        const arrOf = (run) => run.rides[run.rides.length - 1].arr?.getTime() ?? Infinity;
        for (const sec of secs) {
            for (const run of sec.all) {
                if (run.struck) continue;
                const k = keyOf(run), b = best.get(k);
                if (!b || arrOf(run) < arrOf(b) || (arrOf(run) === arrOf(b) && walkOf(run) < walkOf(b))) best.set(k, run);
            }
        }
        // a section emptied here is a way another one beats on every run:
        // gone, where one that had no run at all keeps saying why
        const had = new Set(secs.filter((sec) => sec.all.length));
        for (const sec of secs) {
            sec.all = sec.all.filter((run) => run.struck || best.get(keyOf(run)) === run);
            sec.runs = sec.all.slice(0, limit);
        }
        return secs.filter((sec) => sec.all.length || !had.has(sec));
    }

    // Why a journey has no run to show: a leg whose sensor is down or whose
    // line rests, named when the journey rides several lines; else changes
    // that all wait too long; else nothing left to run. {msg, rest}
    _journeyIdle(sec) {
        const legs = [...new Map(sec.plans.flatMap((p) => p.legs).map((l) => [l.def.entity, l])).values()];
        const who = (l) => (legs.length > 1 ? this._t("line_prefix", { l: esc(this._lineLabelOf(l.def)) }) : "");
        const down = legs.find((l) => l.st?.state === "unavailable");
        const ahead = (l) => !!l.st && this._sourceRows({ def: l.def, st: l.st }).some((r) => !r.struck && r.time.getTime() > Date.now());
        // a line resting today is the cause only when it lists nothing
        // ahead: one whose runs of tomorrow are listed is not why
        const rest = down ? null : legs.filter((l) => !ahead(l)).map((l) => [l, this._restingNote(l.def)]).find(([, n]) => n);
        const later = sec.plans.map((p) => p.cut?.later).find(Boolean);
        // a stop the runs never call at is said before a wait: it is the
        // cause, and no limit on waiting would bring a run back
        const cut = sec.plans.map((p) => p.cut?.unserved).find(Boolean);
        // a leg with nothing to time it by is said before anything else: no
        // waiting limit and no timetable can mend it, and without the words
        // the board is indistinguishable from an end of service
        const untimed = sec.plans.map((p) => p.cut?.untimed).find(Boolean);
        const msg = down ? who(down) + this._t("sensor_unavailable")
            : rest ? who(rest[0]) + rest[1]
            : untimed ? this._t("no_shape", { l: esc(this._lineLabelOf(untimed.def)) })
            : cut ? this._t(cut.why === "board" ? "no_board" : cut.why === "alight" ? "no_alight" : "no_call", { l: esc(this._lineLabelOf(cut.leg.def)), s: esc(cut.name) })
            : sec.plans.some((p) => p.cut?.wait) && legs.every(ahead) ? this._t("no_chain", { n: this._maxWait() })
            : later ? this._laterNote(later)
            : this._t("none_upcoming");
        return { msg, rest: !!rest };
    }

    // Why a leg has no run for the rider past a given time. With a
    // timetable: its next run past the window, or nothing published up to
    // the feed's last day. Without one (a gtfs2 that writes none): how far
    // the sensor's list reaches, since that - not the service - is the limit
    _laterNote(later) {
        const l = esc(this._lineLabelOf(later.leg.def));
        const tt = later.tt;
        if (tt && tt.next) return this._t("tt_next", { l, d: this._fmtDay(tt.next) });
        if (tt && tt.until) return this._t("tt_until", { l, d: this._fmtDay(new Date(`${tt.until}T12:00:00`), true) });
        if (tt) return this._t("tt_none", { l });
        return this._t("no_later", { l, t: fmtHM(later.last || later.at) });
    }

    // a day and a clock as the notes say them, "lun. 22 sept. 05:57", the
    // clock left out for a day alone
    _fmtDay(d, dayOnly) {
        let f;
        try { f = new Intl.DateTimeFormat(this._lang(), { weekday: "short", day: "numeric", month: "short" }); } catch (e) { f = null; }
        const day = f ? f.format(d) : d.toDateString();
        return dayOnly ? day : `${day} ${fmtHM(d)}`;
    }

    // When a ride reaches a point. At the sensor's own origin, the sensor's
    // departure: it is the truth the rest hangs on. Elsewhere, the leg file
    // first when the sensor names one and it knows the run: the expected
    // time where the feed gave one, the scheduled time else. Then the
    // sensor's arrival at its own destination. Then the shape's clocks laid
    // on the departure: the run drawn is the line's fullest, but the run
    // time between two stops barely moves from one run to the next. {t, rt}
    // with rt when the time is the feed's; {unserved: true} when the run is
    // known not to call there, or calls with its door shut where the
    // journey boards or leaves it (noBoard, noAlight); null when nothing
    // says. At the sensor's own ends the integration already lists only
    // the runs that open there.
    _rideTime(p, ride) {
        if (!ride || !p) return null;
        const s = ride.leg.slice;
        const row = ride.row;
        // the schedule the time is measured against, when the sensor has it
        const sch0 = row.rt ? row.theo : row.time;
        if (p.at != null && p.at === s.oi && s.oFound) return { t: row.time, rt: !!row.rt, sch: sch0 };
        // what the rider does at this point: gets on at the start and at a
        // change's second half, gets off at the end and at its first half,
        // only passes a via
        const role = p.kind === "start" || p.kind === "board" ? "on" : p.kind === "end" || p.kind === "transfer" ? "off" : null;
        // the sensor's destination is looked up in the leg file by the id the
        // sensor names first: the shape is drawn from one run - on a rail
        // line, a substitute coach calling at the coach station - and its
        // stop there may be another record, one the timed runs never call at
        let known = null;
        if (p.at != null && p.at === s.di && s.did) {
            const byEnd = this._legStopTime(ride.leg.def, row, { id: s.did, name: s.dname }, role);
            if (byEnd && !byEnd.unserved) known = byEnd;
        }
        if (!known) {
            // the point's own record first - the stop the runs call at - then
            // the shape's stop there: a terminus served from two platforms
            // times one run at each, and "not served" only when neither
            // knows the run
            let miss = null;
            for (const c of [p.stop, p.at != null ? s.route?.stops[p.at] : null]) {
                if (!c) continue;
                const r = this._legStopTime(ride.leg.def, row, c, role);
                if (r?.unserved) miss = miss || r;
                else if (r) { known = r; break; }
            }
            if (!known && miss) return miss;
        }
        if (known) return known;
        if (p.at != null && p.at === s.di && s.dFound && row.durMin != null) {
            return { t: new Date(row.time.getTime() + row.durMin * 60000), rt: !!row.rt,
                sch: sch0 ? new Date(sch0.getTime() + row.durMin * 60000) : null };
        }
        const t0 = s.route?.stops[s.oi]?.time, t1 = p.stop?.time;
        if (t0 == null || t1 == null) return null;
        return { t: new Date(row.time.getTime() + (t1 - t0) * 1000), rt: false, proxy: true };
    }

    // What the map draws of the journeys, from the shapes read so far: the
    // ridden slices of every journey (a cut of the polyline and the stops on
    // it), per line; and for one journey - the one last opened on the board,
    // the first by default - its numbered points and the walks of its
    // changes. Numbers restart with each journey: one set at a time, or two
    // "1" would mean two places. The view fits it all. Null without a
    // journey; a leg whose shape is not read yet contributes nothing until
    // it is.
    _journeyGeometry(bent) {
        const plans = this._visiblePlans();
        if (!plans.length) return null;
        const act = this._activeJourney ?? this._activeDefault;
        const plan = plans.find((p) => p.ji === act) || plans[0];
        const byLine = new Map();
        const fit = [];
        const drawn = new Set();
        // the journey numbered first, so a slice it shares with another is
        // counted as its own in the ground the view fits: that journey's
        for (const pl of [plan, ...plans.filter((p) => p !== plan)]) {
            for (const leg of pl.legs) {
                const s = leg.slice;
                const a = leg.si ?? s.oi, b = leg.ei ?? s.di;
                if (!s.route || a == null || b == null || b <= a) continue;
                // a sensor ridden by two journeys is drawn once
                const key = `${leg.def.idx}:${a}:${b}`;
                if (drawn.has(key)) continue;
                drawn.add(key);
                const stops = s.route.stops.slice(a, b + 1);
                // cut from the shape bent through the line's vehicles, so the
                // slice runs through those riding it
                const sub = this._subRoute(bent?.get(leg.def.idx) || s.route, stops[0].cum, stops[stops.length - 1].cum);
                if (!byLine.has(leg.def.idx)) byLine.set(leg.def.idx, []);
                byLine.get(leg.def.idx).push({ leg, sub, stops });
                if (pl === plan) fit.push(...sub.line);
            }
        }
        const points = [], walks = [];
        for (const p of plan.points) {
            if (!p.stop) continue;
            points.push({ n: p.n, kind: p.kind, name: p.name || "", pos: p.stop, li: p.leg.def.idx });
            fit.push(p.stop);
            // a change on foot: the walk between the two stops, and a second
            // disc at the far end wearing the same number, since it is one
            // point of the journey in two places
            if (p.kind === "transfer" && p.toStop && !p.to.walk?.direct) {
                walks.push({ from: p.stop, to: p.toStop });
                points.push({ n: p.to.board?.n ?? p.n, kind: "transfer_to", name: p.toStop.name || "", pos: p.toStop, li: p.to.def.idx });
                fit.push(p.toStop);
            }
        }
        // the other journeys' remarkable points on the map as well - their
        // departure, their stops to get off at, their changes and the walks
        // between, their arrival: the same orange disc, without its number -
        // numbers restart with each journey, and two "1" in two places would
        // say nothing. Every other stop of their lines stays a plain stop; a
        // place the numbered journey already marks is left to it
        const others = [];
        const taken = new Set(points.map((p) => `${p.pos.x},${p.pos.y}`));
        const other = (kind, name, pos, li) => {
            const k = `${pos.x},${pos.y}`;
            if (taken.has(k)) return;
            taken.add(k);
            others.push({ kind, name: name || "", pos, li });
        };
        for (const pl of plans) {
            if (pl === plan) continue;
            for (const p of pl.points) {
                if (!p.stop) continue;
                other(p.kind, p.name, p.stop, p.leg.def.idx);
                if (p.kind === "transfer" && p.toStop && !p.to.walk?.direct) {
                    walks.push({ from: p.stop, to: p.toStop });
                    other("transfer_to", p.toStop.name, p.toStop, p.to.def.idx);
                }
            }
        }
        return { plan, byLine, points, others, walks, fit };
    }

    // the polyline between two abscissae, cut at both ends, shaped like a
    // route ({line, cum, mPerU}) so the arrow helper can walk it
    _subRoute(route, cumA, cumB) {
        const at = (c) => {
            let i = 1;
            while (i < route.cum.length && route.cum[i] < c) i++;
            if (i >= route.line.length) return route.line[route.line.length - 1];
            const a = route.line[i - 1], b = route.line[i];
            const seg = route.cum[i] - route.cum[i - 1] || 1;
            const t = Math.max(0, Math.min(1, (c - route.cum[i - 1]) / seg));
            return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        };
        const line = [at(cumA)], cum = [0];
        for (let i = 0; i < route.line.length; i++) {
            if (route.cum[i] > cumA && route.cum[i] < cumB) { line.push(route.line[i]); cum.push(route.cum[i] - cumA); }
        }
        line.push(at(cumB));
        cum.push(cumB - cumA);
        return { line, cum, mPerU: route.mPerU };
    }

    _renderDepartures() {
        if (!this._built) return;   // no shell yet: see _renderHeader
        const head = this.shadowRoot.getElementById("dep-head");
        const body = this.shadowRoot.getElementById("dep-body");
        // hidden by configuration, or a map-only card with no departure
        // sensor anywhere: no pane, no header, not even its divider
        if (this._config.show_departures === false || !this._depSources().length) {
            head.style.display = "none";
            body.innerHTML = "";
            return;
        }
        head.style.display = "";
        head.setAttribute("aria-expanded", String(!this._collapsed.dep));
        const lang = this._lang();
        const now = new Date();
        const hiDef = this._hiLine != null ? this._lineDefs().find((d) => d.idx === this._hiLine) : null;
        // the lines the destination header leaves, and the one line it
        // leaves when it leaves one: what the pin, the alerts and the rest
        // notes under the board speak of
        const dlines = this._destLines();
        const dtop = this._destTopLi();
        const focusDef = hiDef || (dtop != null ? this._lineDefs().find((d) => d.idx === dtop) : null);
        // the picked line in the section head is also how to drop the pick:
        // a second tap on the header badge was the only way back, unsaid
        const clear = esc(this._t("clear_filter"));
        const filterBadge = hiDef ? ` <span class="mini-badge filter" style="background:${esc(hiDef.color)};color:${inkOn(hiDef.color)}" data-action="line" data-li="${hiDef.idx}"`
            + ` role="button" tabindex="0" title="${clear}" aria-label="${clear}">${esc(this._lineLabelOf(hiDef))}<span class="x" aria-hidden="true">×</span></span>`
            : this._destFilterChip(clear);
        // the collapsed head of the journeys: the next run of them all,
        // arrival and delay included
        const nextSummary = (first) => (first
            ? `${this._t("next")} <b>${dayTag(lang, first.dep, now) ? esc(dayTag(lang, first.dep, now)) + " " : ""}${fmtHM(first.dep)}</b>${first.arr ? ` → ${fmtHM(first.arr)}` : ""}${first.rt && first.delay ? ` · ${first.delay > 0 ? "+" : ""}${first.delay} min` : ""}`
            : this._t("no_departure"));
        // the journey board: its sections stacked, each with its journeys'
        // next runs; a picked line keeps the journeys of that line alone
        // (see _visibleJourneys)
        // the board reads the card the way the header does: chained runs
        // among journeys, plain departures on a board of lines. Without this
        // a line picked in line mode would filter journey rows and leave
        // them without an arrival
        const secs = this._journeys?.length && this._modeOf() === "trips" ? this._journeySections() : null;
        if (secs) {
            const table = this._isTable();
            const byDep = (a, b) => a.dep.getTime() - b.dep.getTime();
            // the list: every journey's runs in one column by departure, as
            // many as the card allows; the table keeps a table per journey
            const all = table ? secs.flatMap((s) => s.runs).sort(byDep)
                : secs.flatMap((s) => s.all).sort(byDep).slice(0, this._config.max_departures);
            const hasRtJ = all.some((j) => j.rt);
            if (this._collapsed.dep) {
                head.innerHTML = `
                    <span class="chev">${ICONS.chevronRight}</span>
                    <span class="sect-title">${this._t("journey")}</span>${filterBadge}
                    <span class="spacer"></span>
                    ${hasRtJ ? `<span class="live-dot"></span>` : ""}
                    <span class="summary">${nextSummary(all.find((j) => !j.struck))}</span>`;
                body.innerHTML = "";
                return;
            }
            head.innerHTML = `
                <span class="chev">${ICONS.chevronDown}</span>
                <span class="sect-title">${this._t("journey")}</span>${filterBadge}
                <span class="spacer"></span>
                ${hasRtJ ? `<span class="live-dot"></span><span class="summary">${this._t("realtime")}</span>` : `<span class="summary">${this._t("scheduled")}</span>`}`;
            const many = secs.length > 1;
            // one journey open on the whole card: the one tapped while it is
            // still listed, else the first that has more than its head to
            // show. The map numbers the points of that one
            const openable = (plan) => plan.legs.length > 1 || plan.points.length > 2;
            const open = this._jOpen === "" ? ""
                : all.some((j) => j.key === this._jOpen) ? this._jOpen
                : (all.find((j) => openable(j.plan))?.key || "");
            this._jOpenNow = open;
            // the map is drawn again when the journey open changes: the runs
            // of a journey often land after the map was first drawn
            const act = open ? Number(open.split(":")[0]) : null;
            if (act !== this._activeDefault) {
                this._activeDefault = act;
                this._scheduleRerender();
            }
            let html = "";
            if (table) {
                for (const sec of secs) {
                    const mixed = sec.plans.length > 1;
                    let inner = sec.plans.map((p) => this._journeyTableHtml(p, sec.runs.filter((j) => j.plan === p), lang, now, mixed || many)).join("");
                    if (!inner) {
                        const why = this._journeyIdle(sec);
                        inner = `<div class="empty${why.rest ? " rest" : ""}">${why.msg}</div>`;
                    }
                    html += (many ? `<div class="jsec">${esc(sec.title)}</div>` : "") + inner;
                }
            } else {
                html = this._journeyRowsHtml(all, lang, now, open, many || secs.some((s) => s.plans.length > 1));
                // a journey with no run to list says why, under the list -
                // or as the whole board when none has one. Not when another
                // way to the same place has runs listed: that one answers,
                // and a failed alternative is noise. Said once, however
                // many alternatives fail the same way
                const going = new Set(secs.filter((s) => s.all.length).map((s) => s.title));
                const idle = secs.filter((s) => !s.all.length && !going.has(s.title));
                const why = (s) => (many ? this._t("line_prefix", { l: esc(s.title) }) : "") + this._journeyIdle(s).msg;
                const notes = [...new Set(idle.map(why))];
                if (!html) html = `<div class="empty${!many && this._journeyIdle(secs[0]).rest ? " rest" : ""}">${notes.join("<br>")}</div>`;
                else if (notes.length) html += notes.map((n) => `<div class="jnote">${n}</div>`).join("");
            }
            // a via the line's shape does not carry between the sensor's
            // ends: said once, under the board
            const missing = [...new Set(secs.flatMap((s) => s.plans.flatMap((p) => p.missing)))];
            body.innerHTML = html + (missing.length ? `<div class="jnote">${this._t("stop_not_found", { s: esc(missing.join(", ")) })}</div>` : "");
            return;
        }
        const { rows, multi } = this._departureRows();
        // an alert naming every run of its line on the board singles none
        // out: the strip under the board says it, the rows carry no mark.
        // One naming some of them marks those, and the marks say which
        const runsOf = new Map();
        for (const r of rows) if (!r.struck) runsOf.set(r.def, [...(runsOf.get(r.def) || []), r]);
        for (const [, rs] of runsOf) {
            const all = new Set(rs.flatMap((r) => r.alerts || []).filter((it) => rs.every((r) => r.alerts?.includes(it))));
            if (!all.size) continue;
            for (const r of rs) {
                const left = r.alerts.filter((it) => !all.has(it));
                if (left.length) r.alerts = left; else delete r.alerts;
            }
        }
        const hasRt = rows.some((r) => r.rt);
        // the next departure is the next one that runs
        const nextRow = rows.find((r) => !r.struck);

        if (this._collapsed.dep) {
            const nextLine = multi && nextRow?.def ? ` <span class="mini-badge" style="background:${esc(nextRow.def.color)};color:${inkOn(nextRow.def.color)}">${esc(this._lineLabelOf(nextRow.def))}</span>` : "";
            const nextDay = nextRow ? dayTag(lang, nextRow.time, now) : "";
            const summary = nextRow
                ? `${this._t("next")}${nextLine} <b>${nextDay ? esc(nextDay) + " " : ""}${fmtHM(nextRow.time)}</b>${nextRow.rt && nextRow.delayMin ? ` · ${nextRow.delayMin > 0 ? "+" : ""}${nextRow.delayMin} min` : ""}`
                : this._t("no_departure");
            head.innerHTML = `
                <span class="chev">${ICONS.chevronRight}</span>
                <span class="sect-title">${this._t("departures")}</span>${filterBadge}
                <span class="spacer"></span>
                ${hasRt ? `<span class="live-dot"></span>` : ""}
                <span class="summary">${summary}</span>`;
            body.innerHTML = "";
            return;
        }

        head.innerHTML = `
            <span class="chev">${ICONS.chevronDown}</span>
            <span class="sect-title">${this._t("departures")}</span>${filterBadge}
            <span class="spacer"></span>
            ${hasRt ? `<span class="live-dot"></span><span class="summary">${this._t("realtime")}</span>` : `<span class="summary">${this._t("scheduled")}</span>`}`;

        // the stops on the way the journeys name, each line's own, timed per
        // departure: the board of lines says when a run reaches them too
        const vias = new Map();
        for (const d of new Set(rows.map((r) => r.def).filter(Boolean))) vias.set(d.idx, this._lineVias(d));
        const rowsHtml = this._isTable()
            ? this._departuresTableHtml(rows, multi, nextRow, lang, now, vias)
            : rows.map((r) => {
            const strike = r.rt && r.theo && Math.abs(r.time - r.theo) >= 60000;
            // the sub-line says only what the big line does not: the schedule
            // slot when it MOVED (struck through), and the arrival with the
            // journey time when durations are on. Provenance takes no
            // sentence - the realtime icon and the right-hand chip already
            // carry it - so a row with nothing exceptional is a single line.
            const bits = [];
            if (strike) bits.push(`<span class="sub strike">${this._t("scheduled_at", { t: fmtHM(r.theo) })}</span>`);
            if (this._config.show_duration && r.durMin != null && !r.struck) {
                bits.push(`<span class="sub dur">→ ${fmtHM(new Date(r.time.getTime() + r.durMin * 60000))} · ${fmtDur(r.durMin)}</span>`);
            }
            const rv = this._rowVias(r, vias);
            if (rv.length) bits.push(`<span class="sub vias">${this._viasHtml(rv)}</span>`);
            const subLine = bits.length ? `<span class="sub-line">${bits.join("")}</span>` : "";
            const chip = this._statusChip(r.rt, r.delayMin, r.struck);
            const badge = multi && r.def
                ? `<span class="row-badge" style="background:${esc(r.def.color)};color:${inkOn(r.def.color)}">${esc(this._lineLabelOf(r.def))}</span>`
                : "";
            const destSub = multi && r.def
                ? this._hass?.states?.[r.def.entity]?.attributes?.destination_station_stop_name || ""
                : "";
            const tag = dayTag(lang, r.time, now);
            // a struck run: its time struck through, no countdown to a bus
            // that does not come, the chip saying which of the two it is
            return `
            <div class="row${r.struck ? " struck" : ""}">
                ${badge}
                <div class="times">
                    <div class="time-line">
                        <span class="time${r.struck ? " struck" : ""}">${fmtHM(r.time)}</span>
                        ${this._rowModeHtml(r)}
                        ${tag ? `<span class="day-tag">${esc(tag)}</span>` : ""}
                        ${r.rt ? `<span class="rt-icon">${ICONS.live}</span>` : ""}
                        ${this._rowAlertHtml(r)}
                        ${destSub ? `<span class="sub dest-inline">${esc(destSub)}</span>` : ""}
                    </div>
                    ${subLine}
                </div>
                <span class="spacer"></span>
                <div class="right">
                    ${r.struck ? "" : `<span class="countdown" data-ts="${r.time.getTime()}">${fmtCountdown(lang, r.time, now)}</span>`}
                    ${chip}
                </div>
            </div>`;
        }).join("");

        const chips = [];
        const a = (focusDef && focusDef.entity ? this._hass?.states?.[focusDef.entity]?.attributes : this._entity()?.attributes) || {};
        // where the board is read from, by its name - an id says nothing to
        // a rider. A line picked already names its ends under its badge
        const stopName = a.origin_station_stop_name || "";
        if (stopName && !hiDef) {
            chips.push(`<span class="info-chip">${ICONS.pin}${esc(stopName)}</span>`);
        }
        const seenAlerts = new Set();
        const alertSrcs = focusDef ? this._depSources().filter((s) => s.def && s.def.idx === focusDef.idx)
            : dlines ? this._depSources().filter((s) => s.def && dlines.has(s.def.idx)) : this._depSources();
        for (const src of alertSrcs) {
            // the line picked needs no naming: the board is its alone
            const prefix = src.def && !focusDef && this._depSources().length > 1 ? this._t("line_prefix", { l: this._lineLabelOf(src.def) }) : "";
            if (src.st.state === "unavailable") {
                chips.push(`<span class="info-chip info-alert">${ICONS.alert}${esc(prefix + this._t("chip_unavailable"))}</span>`);
                continue;
            }
            // the operator's alerts: the whole stack when gtfs2 publishes it
            // (worst first, one naming a later departure only after the
            // rest), its one sentence else. An alert naming departures of
            // the board says which, by their times: the rows carry its mark
            const at = src.st.attributes || {};
            const stack = Array.isArray(at.origin_stop_alerts) ? at.origin_stop_alerts : [{ text: at.origin_stop_alert }];
            for (const it of stack) {
                const text = this._alertSay(it);
                if (!text) continue;
                const label = prefix + text;
                if (seenAlerts.has(label)) continue;
                seenAlerts.add(label);
                chips.push(`<span class="info-chip info-alert">${ICONS.alert}${esc(label)}</span>`);
            }
        }

        const hiSt = focusDef?.entity ? this._hass?.states?.[focusDef.entity] : null;
        // "No upcoming departure" is a dead end: it is true, and it leaves the
        // user with nowhere to go. When the line is at rest the card already
        // knows when it runs again - it is on the badge, in a tooltip a finger
        // can barely reach. The board is where they are looking, so it says the
        // date instead. Only the lines shown here are asked: with a line
        // selected the board is that line's, and its rest is the whole answer.
        const restDefs = focusDef ? [focusDef] : this._depSources().map((s) => s.def).filter((d) => d && (!dlines || dlines.has(d.idx)));
        const notes = restDefs.map((d) => [d, this._restingNote(d)]).filter(([, n]) => n);
        const uniq = [...new Set(notes.map(([, n]) => n))];
        // one date for every line at rest: say it once, unprefixed
        const restMsg = !notes.length ? ""
            : uniq.length === 1 ? uniq[0]
            : notes.map(([d, n]) => this._t("line_prefix", { l: esc(this._lineLabelOf(d)) }) + n).join(" · ");
        const emptyMsg = focusDef && !focusDef.entity ? this._t("no_dep_sensor")
            : (hiSt && hiSt.state === "unavailable" ? this._t("sensor_unavailable")
                : (restMsg || this._t("none_upcoming")));
        body.innerHTML = (rowsHtml || `<div class="empty${restMsg && !(focusDef && !focusDef.entity) ? " rest" : ""}">${emptyMsg}</div>`)
            + (chips.length ? `<div class="info-strip">${chips.join("")}</div>` : "");
    }

    // The status right of a countdown: what the feed struck out, else
    // scheduled when no realtime rides the run, else its delay; nothing
    // when the feed gives no schedule to measure against.
    _statusChip(rt, delay, struck) {
        if (struck) return `<span class="chip chip-struck">${this._t(struck === "cancelled" ? "cancelled" : "not_stopping")}</span>`;
        if (!rt) return `<span class="chip chip-theo">${this._t("scheduled")}</span>`;
        if (delay == null) return "";
        if (Math.abs(delay) < 1) return `<span class="chip chip-ok">${this._t("on_time")}</span>`;
        if (delay > 0) return `<span class="chip chip-late">+${delay} min</span>`;
        return `<span class="chip chip-early">${delay} min</span>`;
    }

    // One section's rows, one per journey run, as dense as the journey asks.
    // Every row has a head line: departure and arrival at the same size,
    // since door to door both are the answer, the total time beside them,
    // the countdown and the status of the arrival at the right. A journey of
    // one sensor and no via has nothing more to say: the head is the row.
    // One with vias or changes opens into a timeline - one line per point,
    // each leg a stretch of rail in its line's colour with its badge at the
    // top, the points ringed in that colour with the numbers of the map,
    // their clocks in one column, a feed time in bold; a change says its
    // wait, or its walk and its wait. Closed, a journey with changes keeps
    // one line of its legs, badges and times. The next openable run is open
    // until another is tapped. The runs of every journey share one list, by
    // departure; where the card holds several journeys (labelled), each row
    // says which under its head: a lone line's badge, the journey's title.
    _journeyRowsHtml(runs, lang, now, open, labelled) {
        const clockOf = (when) => this._clockHtml(when);
        const badgeOf = (leg) => `<span class="mini-badge" style="background:${esc(leg.def.color)};color:${inkOn(leg.def.color)}">${esc(this._lineLabelOf(leg.def))}</span>`;
        const openable = (plan) => plan.legs.length > 1 || plan.points.length > 2;
        // a row with nothing to open keeps the chevron's room when others
        // have one, so the countdowns line up
        const anyOpen = runs.some((j) => openable(j.plan));
        // "scheduled" said only where it tells rows apart: on a board that
        // mixes realtime runs and scheduled ones
        const mixedRt = runs.some((j) => j.rt) && runs.some((j) => !j.rt);
        // a change says its wait; one made on foot, its walk and its wait
        const change = (leg, ride) => (leg.walk && !leg.walk.direct
            ? this._t("walk_wait", { w: leg.walk.min, n: Math.max(0, ride.wait - leg.walk.min) })
            : this._t("transfer_wait", { n: ride.wait }));
        let lastTag = "";
        return runs.map((j) => {
            const plan = j.plan;
            const r0 = j.rides[0].row;
            const canOpen = openable(plan) && !j.struck;
            const isOpen = canOpen && j.key === open;
            // the moved schedule is the sensor's, at its origin: said only
            // when the journey is boarded there
            const strike = plan.legs[0].si === plan.legs[0].slice.oi && r0.rt && r0.theo && Math.abs(r0.time - r0.theo) >= 60000;
            const chip = !j.rt && !mixedRt ? "" : this._statusChip(j.rt, j.delay, j.struck);
            // a day said once, over the first run it applies to
            const tag = dayTag(lang, j.dep, now);
            const sep = tag && tag !== lastTag ? `<div class="jday"><span class="day-tag">${esc(tag)}</span></div>` : "";
            lastTag = tag;
            const total = j.arr ? clockMins(j.dep, j.arr) : null;
            // the arrival names its day when it is not the departure's
            const atag = j.arr ? dayTag(lang, j.arr, j.dep) : "";
            let body = "";
            if (isOpen) {
                for (const leg of plan.legs) {
                    const ride = j.rides[leg.idx];
                    const pts = [];
                    if (leg.board) {
                        pts.push({ n: esc(String(leg.board.n)), name: leg.board.name, clock: clockOf({ t: ride.dep, rt: ride.depRt }) });
                    }
                    for (const p of plan.points) {
                        if (p.leg === leg) pts.push({ n: esc(this._ptLabel(p)), name: p.name || "", clock: clockOf(this._rideTime(p, ride)) });
                    }
                    const li = leg.def.idx;
                    const color = esc(leg.def.color);
                    pts.forEach((q, i) => {
                        const cls = (i === 0 ? " first" : "") + (i === pts.length - 1 ? " last" : "");
                        body += `<span class="jl">${i === 0 ? badgeOf(leg) : ""}</span>`
                            + `<span class="jnode${cls}" style="--lc:${color}"><span class="jnum">${q.n}</span></span>`
                            + `<span class="jname">${this._alertMarkHtml(this._stopAlertsAt(li, q.name))}${esc(q.name)}</span><span class="jclock">${q.clock}</span>`;
                    });
                    if (leg.end.kind !== "transfer") break;
                    const next = plan.legs[leg.idx + 1];
                    body += `<span class="jl"></span><span class="jnode walk${next.walk?.direct ? " direct" : ""}"></span>`
                        + `<span class="jname"><span class="jmuted">${esc(change(next, j.rides[leg.idx + 1]))}</span></span><span class="jclock"></span>`;
                }
                body = `<div class="jtl">${body}</div>`;
            } else if (plan.legs.length > 1 && !j.struck) {
                // the legs in a row: badge, departure and arrival times; each
                // change between them a stretch of its own - a walker between
                // two arrows, the wait beside it - its sentence in the tooltip
                const segs = [];
                for (const ride of j.rides) {
                    if (ride.wait != null) {
                        const say = esc(change(ride.leg, ride));
                        segs.push(`<span class="jchg" role="img" title="${say}" aria-label="${say}"><span>→</span>${ICONS.walk}<span>${ride.wait} min</span><span>→</span></span>`);
                    }
                    const end = ride.arr ? ` → ${clockOf(this._rideTime(ride.leg.end, ride))}` : "";
                    segs.push(`<span class="jseg">${badgeOf(ride.leg)}${clockOf({ t: ride.dep, rt: ride.depRt })}${end}</span>`);
                }
                body = `<div class="jsum">${segs.join("")}</div>`;
            }
            const act = canOpen ? ` data-action="toggle-journey" data-sec="${esc(j.sec.key)}" data-key="${esc(j.key)}"` : "";
            // which journey the row is: a lone line's badge and the journey's
            // title (a journey with a change names its lines in its body)
            const where = labelled
                ? `<div class="jwhere">${plan.legs.length === 1 ? badgeOf(plan.legs[0]) : ""}<span class="jwt">${esc(j.sec.title)}</span></div>` : "";
            return sep + `
            <div class="row jrow${isOpen ? " open" : ""}${canOpen ? "" : " flat"}${j.struck ? " struck" : ""}"${act}>
                <div class="jhead"${canOpen ? ` role="button" tabindex="0" aria-expanded="${isOpen}"${act}` : ""}>
                    <span class="time${j.struck ? " struck" : ""}">${fmtHM(j.dep)}</span>
                    ${j.depRt ? `<span class="rt-icon">${ICONS.live}</span>` : ""}
                    ${this._rowAlertHtml(r0)}
                    ${j.arr ? `<span class="jarrow">→</span><span class="time">${fmtHM(j.arr)}</span>${atag ? `<span class="day-tag">${esc(atag)}</span>` : ""}` : ""}
                    ${total != null ? `<span class="jtotal">${fmtDur(total)}</span>` : ""}
                    ${strike ? `<span class="sub strike">${this._t("scheduled_at", { t: fmtHM(r0.theo) })}</span>` : ""}
                    <span class="jright"><span class="jwhen">${j.struck ? "" : `<span class="countdown" data-ts="${j.dep.getTime()}">${fmtCountdown(lang, j.dep, now)}</span>`}${chip}</span>${canOpen ? `<span class="chev">${isOpen ? ICONS.chevronDown : ICONS.chevronRight}</span>` : anyOpen ? `<span class="chev ph" aria-hidden="true">${ICONS.chevronRight}</span>` : ""}</span>
                </div>
                ${where}
                ${body}
            </div>`;
        }).join("");
    }

    /* The same rows laid out as a timetable: line (when several share the
     * board), departure, arrival, duration and - when the lines do not all
     * go to the same place - destination, sorted by departure time and only
     * by it: columns are read, not clicked. The line comes first: it is what
     * tells two rows apart, and what explains a slow one. The status rides
     * the departure - its realtime mark on the left, a delay after the time,
     * the moved schedule in the tooltip - where a column of dashes said
     * less. A day is said once, on a row of its own. A "next departure" line
     * stands in for the per-row countdowns, and its span joins the 30 s
     * tick like any other. */
    _departuresTableHtml(rows, multi, nextRow, lang, now, vias = new Map()) {
        if (!rows.length) return "";
        // journeys are comparable when they end at the same place: durations
        // are graded against the fastest run TO THE SAME DESTINATION, so two
        // lines to Paris rate each other (the slow one reads warm even at its
        // own usual pace) while lines to different places never do. A sensor
        // naming no destination falls back to its own line's best.
        const keyOf = (r) => {
            const dest = r.def?.entity && this._hass?.states?.[r.def.entity]?.attributes?.destination_station_stop_name;
            return dest ? "d:" + String(dest).trim().toLowerCase() : "l:" + (r.def ? r.def.idx : -1);
        };
        const best = new Map();
        for (const r of rows) {
            if (!Number.isFinite(r.durMin)) continue;
            const k = keyOf(r);
            if (!best.has(k) || r.durMin < best.get(k)) best.set(k, r.durMin);
        }
        // a destination column only when it tells rows apart
        const destOf = (r) => String((r.def?.entity && this._hass?.states?.[r.def.entity]?.attributes?.destination_station_stop_name) || "");
        const showDest = multi && new Set(rows.map(destOf).filter(Boolean)).size > 1;
        // a via column only when a line of the board has stops on the way
        const showVia = rows.some((r) => (vias.get(r.def?.idx) || []).length);
        const ncol = 5 + (multi ? 1 : 0) + (showVia ? 1 : 0);
        let lastTag = "";
        const cells = rows.map((r) => {
            const tag = dayTag(lang, r.time, now);
            const sep = tag && tag !== lastTag ? `<tr class="day-sep"><td colspan="${ncol}"><span class="day-tag">${esc(tag)}</span></td></tr>` : "";
            lastTag = tag;
            // the realtime icon sits LEFT of the time: the right edge belongs
            // to the digits, so times align whether a row carries it or not.
            // The delay follows the time it moves; the tooltip says the rest
            // in a narrow column of its own, so the times stay aligned
            // a struck run takes the delay column for its word, its time
            // struck through, and no arrival
            const dly = r.struck ? this._statusChip(true, null, r.struck)
                : r.rt && r.delayMin != null && Math.abs(r.delayMin) >= 1
                ? `<span class="dly ${r.delayMin > 0 ? "st-late" : "st-early"}">${r.delayMin > 0 ? "+" : ""}${r.delayMin} min</span>` : "";
            // a coach on a train line says so on the same left side, for the
            // same reason, and so does the operator's alert on the run
            const dep = (r.rt ? `<span class="rt-icon">${ICONS.live}</span>` : "") + this._rowModeHtml(r) + this._rowAlertHtml(r)
                + (r.struck ? `<span class="struck">${fmtHM(r.time)}</span>` : fmtHM(r.time));
            const depTitle = r.struck ? this._t(r.struck === "cancelled" ? "cancelled" : "not_stopping")
                : r.rt && r.theo && Math.abs(r.time - r.theo) >= 60000
                ? this._t("scheduled_at", { t: fmtHM(r.theo) })
                : this._t(r.rt ? "realtime" : "no_rt_yet");
            let arr = "—", dur = "—";
            if (r.durMin != null && !r.struck) {
                const at = new Date(r.time.getTime() + r.durMin * 60000);
                // the arrival names its day only when it differs from the
                // DEPARTURE's: a night run does not repeat its own date
                const atag = dayTag(lang, at, r.time);
                arr = `${atag ? `<span class="day-tag">${esc(atag)}</span> ` : ""}${fmtHM(at)}`;
                const b = best.get(keyOf(r)) ?? r.durMin;
                // only the fast runs are marked, green within a couple of
                // minutes or 15% of the best time to the same place: a slower
                // line is not late, and red says late everywhere else
                const fast = r.durMin - b <= Math.max(2, b * 0.15);
                dur = `<b${fast ? ` class="dur-ok"` : ""}>${fmtDur(r.durMin)}</b>`;
            }
            const line = multi
                ? `<td class="fit">${r.def ? `<span class="row-badge" style="background:${esc(r.def.color)};color:${inkOn(r.def.color)}">${esc(this._lineLabelOf(r.def))}</span>` : "—"}</td>`
                : "";
            // the last column takes the slack: the destination, or nothing
            const last = showDest ? `<td>${esc(destOf(r)) || "—"}</td>` : `<td></td>`;
            const rv = this._rowVias(r, vias);
            const via = showVia ? `<td class="fit vias">${rv.length ? this._viasHtml(rv) : "—"}</td>` : "";
            return sep + `<tr>${line}<td class="num dep fit" title="${esc(depTitle)}">${dep}</td><td class="dly-c fit">${dly}</td>${via}<td class="num fit">${arr}</td>`
                + `<td class="num fit">${dur}</td>${last}</tr>`;
        }).join("");
        const summary = nextRow ? `<div class="board-next">${this._t("next_dep_in", {
            c: `<span class="countdown" data-ts="${nextRow.time.getTime()}">${fmtCountdown(lang, nextRow.time, now)}</span>`,
            t: `<b>${fmtHM(nextRow.time)}</b>`,
        })}</div>` : "";
        return summary
            + `<div class="board-wrap"><table class="board"><thead><tr>`
            + (multi ? `<th class="fit">${this._t("col_line")}</th>` : "")
            + `<th class="num fit">${this._t("col_departure")}</th><th class="fit"></th>`
            + (showVia ? `<th class="fit vias">${this._t("col_via")}</th>` : "") + `<th class="num fit">${this._t("col_arrival")}</th>`
            + `<th class="num fit">${this._t("col_duration")}</th><th>${showDest ? this._t("col_destination") : ""}</th>`
            + `</tr></thead><tbody>${cells}</tbody></table></div>`;
    }

    /* A journey board laid out as a timetable, the departures table's own
     * shape: one row per journey sorted by departure, and one column per
     * point in riding order - the start, each stop listed on the way, where
     * each leg is left and, after the wait of the change, where the next one
     * is boarded - then the door-to-door time. The lines ride a header row
     * of their own, each badge over its leg's columns, which says where the
     * changes are and makes a line column needless. The departure column
     * stays in place when a long journey scrolls sideways; a day is said
     * once, on a row of its own; the delay at the arrival follows the
     * arrival's time. */
    _journeyTableHtml(plan, journeys, lang, now, labelled) {
        if (!journeys.length) return "";
        const cols = [], groups = [];
        plan.legs.forEach((leg, k) => {
            if (k > 0) { cols.push({ kind: "wait", k }); groups.push({ span: 1 }); }
            const mine = [];
            if (leg.board) mine.push({ kind: "board", leg, n: esc(String(leg.board.n)), name: leg.board.name });
            for (const p of plan.points) if (p.leg === leg) mine.push({ kind: "pt", leg, p, n: esc(this._ptLabel(p)), name: p.name || "" });
            cols.push(...mine);
            groups.push({ leg, span: mine.length });
        });
        const ncol = cols.length + 3;
        // one leg alone on the card: its badge is the card's own, a row saying
        // it again is noise. Among other sections it is what names the line
        const head1 = plan.legs.length < 2 && !labelled ? "" : groups.map((g) => (g.leg
            ? `<th class="leg" colspan="${g.span}" style="--lc:${esc(g.leg.def.color)}"><span class="mini-badge" style="background:${esc(g.leg.def.color)};color:${inkOn(g.leg.def.color)}">${esc(this._lineLabelOf(g.leg.def))}</span></th>`
            : `<th></th>`)).join("") + `<th></th><th></th><th></th>`;
        const waitT = esc(this._t("col_wait"));
        const head2 = cols.map((c, i) => (c.kind === "wait"
            ? `<th class="num fit" title="${waitT}">⋯</th>`
            : `<th class="fit${i === 0 ? " stick" : ""}" title="${esc(c.name)}"><span class="jnum" style="--lc:${esc(c.leg.def.color)}">${c.n}</span><span class="jcn">${esc(c.name)}</span></th>`)).join("")
            + `<th class="fit"></th><th class="num fit">${this._t("col_duration")}</th><th></th>`;
        let lastTag = "";
        const body = journeys.map((j) => {
            const tag = dayTag(lang, j.dep, now);
            const sep = tag && tag !== lastTag ? `<tr class="day-sep"><td colspan="${ncol}"><span class="day-tag">${esc(tag)}</span></td></tr>` : "";
            lastTag = tag;
            const tds = cols.map((c, i) => {
                // a struck run has its departure and nothing after it
                if (j.struck) {
                    return i === 0 ? `<td class="dep fit stick"><span class="rt-icon">${ICONS.live}</span><span class="struck">${fmtHM(j.dep)}</span></td>` : `<td class="fit"></td>`;
                }
                if (c.kind === "wait") {
                    const w = plan.legs[c.k].walk, ride = j.rides[c.k];
                    const tip = w && !w.direct ? this._t("walk_wait", { w: w.min, n: Math.max(0, ride.wait - w.min) })
                        : this._t("transfer_wait", { n: ride.wait });
                    return `<td class="num fit jw" title="${esc(tip)}">${ride.wait} min</td>`;
                }
                const ride = j.rides[c.leg.idx];
                if (i === 0) return `<td class="dep fit stick">${j.depRt ? `<span class="rt-icon">${ICONS.live}</span>` : ""}${fmtHM(j.dep)}</td>`;
                return `<td class="fit">${this._clockHtml(c.kind === "board" ? { t: ride.dep, rt: ride.depRt } : this._rideTime(c.p, ride))}</td>`;
            }).join("");
            // the delay at the arrival, beside it in a column of its own
            const dly = j.struck ? this._statusChip(true, null, j.struck)
                : j.rt && j.delay != null && Math.abs(j.delay) >= 1
                ? `<span class="dly ${j.delay > 0 ? "st-late" : "st-early"}">${j.delay > 0 ? "+" : ""}${j.delay} min</span>` : "";
            return sep + `<tr>${tds}<td class="dly-c fit">${dly}</td>`
                + `<td class="num fit">${j.arr ? `<b>${fmtDur(clockMins(j.dep, j.arr))}</b>` : "—"}</td><td></td></tr>`;
        }).join("");
        const first = journeys[0];
        const summary = `<div class="board-next">${this._t("next_dep_in", {
            c: `<span class="countdown" data-ts="${first.dep.getTime()}">${fmtCountdown(lang, first.dep, now)}</span>`,
            t: `<b>${fmtHM(first.dep)}</b>`,
        })}</div>`;
        return summary + `<div class="board-wrap"><table class="board jboard"><thead>${head1 ? `<tr class="legs">${head1}</tr>` : ""}<tr>${head2}</tr></thead>`
            + `<tbody>${body}</tbody></table></div>`;
    }

    // what a point's disc says: the initial of the departure and of the
    // arrival in the card's language, two letters that differ in every one
    // of them (German says Start and Ziel for it), a number for the points
    // between - the same on the map, the timeline and the timetable
    _ptLabel(p) {
        return p.kind === "start" ? this._t("pt_start") : p.kind === "end" ? this._t("pt_end") : String(p.n);
    }

    // a point's clock: a feed time in bold, a scheduled or derived one
    // plain, each saying which in its tooltip; a run that skips the place
    // said so, in bold when it is the feed's word for today, and a run that
    // calls with its door shut where the rider gets on, or off, said so too
    _clockHtml(when) {
        if (when?.unserved) {
            return when.skipped ? `<b class="jbroken" title="${esc(this._t("realtime"))}">${this._t("not_stopping")}</b>`
                : `<span class="jbroken">${this._t(when.noBoard ? "no_boarding" : when.noAlight ? "no_alighting" : "not_served")}</span>`;
        }
        if (!when?.t) return "";
        return when.rt ? `<b title="${esc(this._t("realtime"))}">${fmtHM(when.t)}</b>`
            : `<span title="${esc(this._t("scheduled"))}">${fmtHM(when.t)}</span>`;
    }

    /* ── PANE 2: MAP data ───────────────────────────────────────────────── */

    // Which lines currently read as quiet, as one comparable string. The badge
    // carries that mark, and nothing else would redraw the header for it:
    // hassChanged only fires when a sensor moves, and a frozen positions file
    // is precisely the case where the sensor may be the only thing still
    // moving - or, for a deleted entity, where nothing moves at all.
    _muteKey() {
        const now = Date.now();
        return this._ld.map((s) => !s ? "-"
            : (s.err ? "e" : "") + (s.sigAt ? (now - s.sigAt > STALE_FEED ? "s" : "f") : "n")).join("");
    }

    _repaintHeaderIfMuteChanged() {
        const key = this._muteKey();
        if (key === this._lastMuteKey) return;
        this._lastMuteKey = key;
        if (this._built) this._renderHeader();
    }

    async _fetchPositions(def, force) {
        const slot = this._ld[def.idx];
        if (!slot) return;
        try {
            const maxAge = force ? FETCH_BURST_MS : Math.max(15, this._config.refresh) * 500;
            slot.geo = await fetchJsonShared(def.positions_url, maxAge);
            slot.geoAt = Date.now();
            slot.err = null;
            const now = Date.now();
            // Freshness comes from the file's own Last-Modified when the server
            // sends one: the integration rewrites the positions file on every
            // update, so its date ages even while a parked vehicle keeps the
            // contents identical. The position signature is the fallback for
            // servers that send no date; on its own it cannot tell "no update
            // since end of service" from "everyone is standing still".
            const lm = slot.geo && slot.geo.__lastModified;
            const sig = (slot.geo.features || []).map((f) => `${this._vid(f)}@${f.geometry?.coordinates}`).join("|");
            if (Number.isFinite(lm)) {
                slot.sig = sig;
                slot.sigAt = Math.min(now, lm);
            } else if (sig !== slot.sig) { slot.sig = sig; slot.sigAt = now; }
            // entity-less cards derive badge labels from the feed: refresh them
            if (!this._depSources().length) this._renderHeader();
            for (const f of slot.geo.features || []) {
                const key = `${def.idx}:${this._vid(f)}`;
                const [lon, lat] = f.geometry?.coordinates || [];
                if (lat == null || lon == null) continue;
                this._histSeen.set(key, now);
                const h = this._hist.get(key) || [];
                const last = h[h.length - 1];
                if (!last || last.lat !== lat || last.lon !== lon) {
                    h.push({ lat, lon, ts: now });
                    if (h.length > HIST_MAX) h.shift();
                    this._hist.set(key, h);
                }
            }
        } catch (e) {
            slot.geo = slot.geo || { features: [] };
            if (slot.err !== String(e)) console.warn(`gtfs2-live-card: positions fetch failed (${def.positions_url})`, e);
            slot.err = String(e);
        }
        // forget vehicles gone from this line's feed for a while. Outside the
        // try: a line whose feed stays unreachable must release its history
        // too, otherwise it is retained for as long as the card lives.
        const cutoff = Date.now() - HIST_TTL;
        for (const key of [...this._hist.keys()]) {
            if (key.startsWith(`${def.idx}:`) && (this._histSeen.get(key) || 0) < cutoff) {
                this._hist.delete(key);
                this._histSeen.delete(key);
                this._vehCum.delete(key);
            }
        }
        this._scheduleRerender();
        this._renderFooter();
        this._repaintHeaderIfMuteChanged();
    }

    async _fetchRoute(def, force) {
        const slot = this._ld[def.idx];
        if (!slot || !def.route_url) return;
        slot.routeAt = Date.now();
        try {
            const gj = await fetchJsonShared(def.route_url, force ? FETCH_BURST_MS : 5 * 60000);
            const lineFeat = (gj.features || []).find((f) => f.geometry?.type === "LineString");
            const stopFeats = (gj.features || []).filter((f) => f.geometry?.type === "Point");
            // Newer gtfs2 exports carry the ordered stops alone, the polyline
            // is ours to rebuild, stop_sequence giving the order. A LineString
            // written by an older export stays honoured as is.
            const lineCoords = lineFeat && Array.isArray(lineFeat.geometry.coordinates)
                ? lineFeat.geometry.coordinates
                : stopFeats
                    .slice()
                    .sort((a, b) => (a.properties?.stop_sequence ?? 0) - (b.properties?.stop_sequence ?? 0))
                    .map((f) => f.geometry.coordinates);
            if (lineCoords.length < 2) { slot.route = null; return; }
            const line = lineCoords.map(([lon, lat]) => this._world(lat, lon));
            const mPerU = this._mPerU(lineCoords[0][1]);
            const cum = [0];
            for (let i = 1; i < line.length; i++) {
                cum.push(cum[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y) * mPerU);
            }
            let minCum = 0;
            const stops = stopFeats
                .sort((a, b) => (a.properties?.stop_sequence ?? 0) - (b.properties?.stop_sequence ?? 0))
                .map((f) => {
                    const [lon, lat] = f.geometry.coordinates;
                    const w = this._world(lat, lon);
                    // in stop order, never backwards: a loop serves the same
                    // stop twice, and both visits used to land on whichever
                    // leg was nearest, one of them wrong. The 30 m floor is
                    // what pushes the second visit PAST the first - two real
                    // stops are never that close, two visits of one are at 0
                    const c = this._projectOnPolyline(w, line, cum, { prevCum: minCum + 30 / mPerU, tolU: 60 / mPerU }).cum;
                    minCum = Math.max(minCum, c);
                    return {
                        ...w,
                        id: String(f.properties?.stop_id || ""),
                        name: String(f.properties?.stop_name || ""),
                        seq: f.properties?.stop_sequence,
                        cum: c,
                        // the drawn trip's clock at this stop: what a journey
                        // needs to time a point between two of its stops
                        time: gtfsSecs(f.properties?.departure_time),
                        // the line's word, over every run: no run ever takes
                        // riders on here, or sets them down, when a gtfs2
                        // that writes boards / alights says false. The drawn
                        // run's own pickup_type says nothing of the others
                        // and is not read; an older export says nothing at
                        // all, and a stop it names stays a way on and off
                        noBoard: f.properties?.boards === false,
                        noAlight: f.properties?.alights === false,
                    };
                });
            slot.route = { line, cum, stops, mPerU };
            // a card of trips finds its ways on the stops of the shapes
            this._routesGen = (this._routesGen || 0) + 1;
        } catch (e) {
            // route export absent (older gtfs2): the card degrades to traces
            slot.route = null;
        }
        this._scheduleRerender();
        this._scheduleBoard();
    }

    // The leg file: for every run the sensor lists, when its trip calls at
    // every stop, scheduled and, where the feed says, expected. Kept as the
    // integration wrote it, keyed by trip id; a file that is missing or
    // unreadable leaves the slot empty and the card on the shape's clocks,
    // which is not an error: a stock gtfs2 writes none.
    // The timetable of a line (see gtfs2's write_timetable_file): read only
    // when a journey needs a run past the ones its sensor lists, then kept
    // for the day - it changes with the service day, not with the minute.
    // {rows: runs as the board reads them, next, until, days: last service
    // date}, or null until it lands, false when there is none to read
    _timetable(def) {
        const slot = this._ld[def.idx];
        if (!slot || !def.tt_url) return false;
        if (slot.tt && slot.tt.url === def.tt_url && Date.now() - slot.tt.at < 30 * 60000) return slot.tt.doc;
        if (slot.ttLoading === def.tt_url) return slot.tt?.url === def.tt_url ? slot.tt.doc : null;
        slot.ttLoading = def.tt_url;
        fetchJsonShared(def.tt_url, 30 * 60000)
            .then((doc) => {
                const rows = [];
                for (const day of Array.isArray(doc?.days) ? doc.days : []) {
                    for (const x of Array.isArray(day?.departures) ? day.departures : []) {
                        const t = parseTs(x?.dep);
                        if (!t) continue;
                        const arr = parseTs(x?.arr);
                        rows.push({ time: t, theo: null, rt: false, delayMin: null, tt: true,
                            durMin: arr ? Math.round((arr.getTime() - t.getTime()) / 60000) : null,
                            tripId: x?.trip_id != null ? String(x.trip_id) : null, rtype: null, def });
                    }
                }
                rows.sort((a, b) => a.time.getTime() - b.time.getTime());
                const days = (doc?.days || []).map((d) => d?.service_date).filter(Boolean);
                slot.tt = { url: def.tt_url, at: Date.now(), doc: { rows,
                    next: parseTs(doc?.next) || null, until: doc?.until || null, last: days[days.length - 1] || null } };
            })
            .catch(() => { slot.tt = { url: def.tt_url, at: Date.now(), doc: false }; })
            .finally(() => { slot.ttLoading = null; this._scheduleBoard(); });
        return null;
    }

    // The runs of a leg a journey can take: the ones its sensor lists,
    // realtime and all, then past the last of them the timetable's, on
    // schedule. Past the list only: a run the sensor lists is its own
    _legRows(def, st) {
        const listed = (st ? this._sourceRows({ def, st }) : []).sort((a, b) => a.time.getTime() - b.time.getTime());
        const last = listed.length ? listed[listed.length - 1].time.getTime() : -Infinity;
        const tt = this._timetable(def);
        if (!tt) return listed;
        return listed.concat(tt.rows.filter((r) => r.time.getTime() > last).map((r) => ({ ...r })));
    }

    async _fetchLeg(def, force) {
        const slot = this._ld[def.idx];
        if (!slot || !def.leg_url) return;
        slot.legAt = Date.now();
        // the runs remembered below are forgotten once past, here where they
        // are added: a journey card whose map is never drawn keeps no list
        for (const [k, end] of this._seenTrips) if (end + 5 * 60000 < slot.legAt) this._seenTrips.delete(k);
        try {
            const gj = await fetchJsonShared(def.leg_url, force ? FETCH_BURST_MS : 30000);
            const trips = gj && typeof gj.trips === "object" && gj.trips ? gj.trips : {};
            // the names of the stops the file draws, by id: what matches a
            // stop of the shape that one run serves from another platform
            // and where they stand: the stops the runs call at, which a shape
            // drawn from another run may not carry (see _stopOnLeg)
            const names = new Map(), places = new Map();
            for (const f of gj?.features || []) {
                const p = f?.properties;
                if (!p?.stop_id) continue;
                const id = String(p.stop_id), name = String(p.stop_name || "").trim();
                names.set(id, name.toLowerCase());
                const c = f.geometry?.type === "Point" ? f.geometry.coordinates : null;
                if (Array.isArray(c) && Number.isFinite(c[0]) && Number.isFinite(c[1])) places.set(id, { id, name, lat: c[1], lon: c[0] });
            }
            slot.leg = { trips, names, places, tripId: gj?.properties?.trip_id || null, realtime: !!gj?.properties?.realtime };
            // the runs this file times, remembered until they reach the
            // sensor's destination: the vehicles a journey map keeps
            const dest = gj?.properties?.destination_stop_id;
            for (const [tid, trip] of Object.entries(trips)) {
                const at = dest ? trip?.stops?.[dest] : null;
                let end = at ? parseTs(at.expected) || parseTs(at.scheduled) : null;
                if (!end) {
                    for (const v of Object.values(trip?.stops || {})) {
                        const t = parseTs(v?.expected) || parseTs(v?.scheduled);
                        if (t && (!end || t > end)) end = t;
                    }
                }
                if (end) this._seenTrips.set(`${def.idx}|${tid}`, end.getTime());
            }
        } catch (e) {
            slot.leg = null;
        }
        this._scheduleRerender();
        this._scheduleBoard();
    }

    // When a listed run reaches a stop, from the leg file: the expected time
    // where the feed gave one, the scheduled time else. Null when the file,
    // the run or the stop is unknown to it; {unserved: true} when the file
    // knows the run and the run does not call there (a short turn, an express).
    // The shape is drawn from one run and the file times every run, so a stop
    // missing by id is looked for by name - a terminus is often served from
    // another platform - and the run is said not to call only when the file
    // names every stop of it and none is this one.
    // With a role - "on" where the journey boards the run, "off" where it
    // leaves it - the call must be one the rider can make: the file says per
    // run how it calls (pickup_type, drop_off_type: 1 is no way on, or off;
    // 2 and 3, a phone call or a word to the driver, still are). A run
    // calling there with its door shut is {unserved, noBoard} or {unserved,
    // noAlight}, as much a run not to take as one not calling at all. A
    // value the file does not carry is a regular call.
    _legStopTime(def, row, stop, role = null) {
        const lg = this._ld[def.idx]?.leg;
        if (!lg || !row?.tripId || !stop?.id) return null;
        const trip = lg.trips[row.tripId];
        if (!trip?.stops) return null;
        let s = trip.stops[stop.id];
        if (!s) {
            const want = (stop.name || "").trim().toLowerCase();
            let unnamed = false;
            for (const [id, v] of Object.entries(trip.stops)) {
                const nm = lg.names.get(id);
                if (nm == null) unnamed = true;
                else if (want && nm === want) { s = v; break; }
            }
            if (!s) return unnamed || !want ? null : { unserved: true };
        }
        // the feed says the vehicle does not call here today
        if (s.skipped) return { unserved: true, skipped: true };
        if (role === "on" && Number(s.pickup_type) === 1) return { unserved: true, noBoard: true };
        if (role === "off" && Number(s.drop_off_type) === 1) return { unserved: true, noAlight: true };
        const expected = parseTs(s.expected);
        const sch = parseTs(s.scheduled);
        const t = expected || sch;
        return t ? { t, rt: !!expected, sch } : null;
    }

    _vid(feature) {
        const p = feature.properties || {};
        return String(p.vehicle_id || p.vehicle_label || p.id || "").trim() || "bus";
    }

    /* ── PANE 2: MAP projection helpers ─────────────────────────────────── */

    _world(lat, lon) {
        const x = ((lon + 180) / 360) * WORLD;
        const s = Math.sin((lat * Math.PI) / 180);
        const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * WORLD;
        return { x, y };
    }

    // latitude of anything the card already knows how to place, so the scale
    // bar is right from the first paint anywhere on the globe, not just in
    // the latitude band the card was first written for
    _refLatFromStops() {
        for (const slot of this._ld || []) {
            const p = slot?.route?.stops?.[0] || slot?.route?.line?.[0];
            if (p && Number.isFinite(p.y)) return this._latOf(p.y);
        }
        return null;
    }

    // inverse Web-Mercator on the y axis: world units back to a latitude
    _latOf(y) {
        return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / WORLD))) * 180) / Math.PI;
    }

    _mPerU(lat) {
        return (EARTH_CIRC * Math.cos((lat * Math.PI) / 180)) / WORLD;
    }

    _projectOnPolyline(pt, line, cum, opts) {
        let best = { d2: Infinity, cum: 0, point: line[0] || pt, idx: 0, t: 0 };
        for (let i = 1; i < line.length; i++) {
            const ax = line[i - 1].x, ay = line[i - 1].y;
            const bx = line[i].x, by = line[i].y;
            const dx = bx - ax, dy = by - ay;
            const len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, ((pt.x - ax) * dx + (pt.y - ay) * dy) / len2)) : 0;
            const px = ax + t * dx, py = ay + t * dy;
            const d2 = (pt.x - px) ** 2 + (pt.y - py) ** 2;
            if (d2 < best.d2) {
                best = { d2, cum: cum[i - 1] + (cum[i] - cum[i - 1]) * t, point: { x: px, y: py }, idx: i - 1, t };
            }
        }
        if (!opts || !line.length) return best;
        // A loop line runs out and back along the same streets, so the shape
        // passes a point TWICE and "nearest" is a coin toss between the legs.
        // Picking the return leg for an outbound bus painted the whole route
        // as already ridden, the user's own stop included. Collect every
        // passage that comes close (one candidate per contiguous stretch of
        // segments), then let what the caller knows decide: the vehicle's
        // heading first - the two legs run opposite ways, so it settles them
        // outright - then its previous progress along the route.
        const lim = (Math.sqrt(best.d2) + (opts.tolU || 0)) ** 2;
        const cands = [];
        let cur = null;
        for (let i = 1; i < line.length; i++) {
            const ax = line[i - 1].x, ay = line[i - 1].y;
            const bx = line[i].x, by = line[i].y;
            const dx = bx - ax, dy = by - ay;
            const len2 = dx * dx + dy * dy;
            const t = len2 ? Math.max(0, Math.min(1, ((pt.x - ax) * dx + (pt.y - ay) * dy) / len2)) : 0;
            const px = ax + t * dx, py = ay + t * dy;
            const d2 = (pt.x - px) ** 2 + (pt.y - py) ** 2;
            if (d2 > lim) continue;
            if (cur && cur.end === i - 1) {
                cur.end = i;
                if (d2 < cur.d2) Object.assign(cur, { d2, cum: cum[i - 1] + (cum[i] - cum[i - 1]) * t, point: { x: px, y: py }, idx: i - 1, t });
            } else {
                cur = { d2, cum: cum[i - 1] + (cum[i] - cum[i - 1]) * t, point: { x: px, y: py }, idx: i - 1, t, end: i };
                cands.push(cur);
            }
        }
        let pool = cands;
        if (opts.dir) {
            const ahead = pool.filter((c) => {
                const a = line[c.idx], b = line[c.idx + 1];
                return (b.x - a.x) * opts.dir.x + (b.y - a.y) * opts.dir.y > 0;
            });
            if (ahead.length) pool = ahead;
        }
        if (opts.prevCum != null) {
            const onward = pool.filter((c) => c.cum >= opts.prevCum - (opts.backU || 0));
            if (onward.length) pool = onward;
        }
        let pick = pool[0] || best;
        if (opts.prevCum != null && pool.length > 1) {
            // several passages still in play: a vehicle advances, so the
            // credible one is the SMALLEST step forward from where it was,
            // not the geometrically nearest - nearest is the coin toss this
            // whole branch exists to avoid
            for (const c of pool) {
                const jc = c.cum - opts.prevCum, jp = pick.cum - opts.prevCum;
                if ((jc >= 0 && (jp < 0 || jc < jp)) || (jc < 0 && jp < 0 && jc > jp)) pick = c;
            }
        } else {
            for (const c of pool) if (c.d2 < pick.d2) pick = c;
        }
        return pick;
    }

    // what the card knows about a vehicle, packaged for the projection: its
    // heading over the last two positions (only once it has really moved -
    // GPS jitter at a stop is not a heading), and how far along the route it
    // was last time. Progress is remembered per vehicle so the split cannot
    // leap between legs from one refresh to the next.
    _projectVeh(li, vid, w, route) {
        const key = `${li}:${vid}`;
        const h = this._hist.get(key) || [];
        let dir = null;
        if (h.length > 1) {
            const a = this._world(h[h.length - 2].lat, h[h.length - 2].lon);
            const b = this._world(h[h.length - 1].lat, h[h.length - 1].lon);
            const dx = b.x - a.x, dy = b.y - a.y;
            const m = Math.hypot(dx, dy);
            if (m * route.mPerU > 15) dir = { x: dx / m, y: dy / m };
        }
        const prev = this._vehCum.get(key);
        const prj = this._projectOnPolyline(w, route.line, route.cum, {
            dir,
            prevCum: Number.isFinite(prev) ? prev : null,
            tolU: 60 / route.mPerU,
            backU: 250 / route.mPerU,
        });
        this._vehCum.set(key, prj.cum);
        return prj;
    }

    // Where a vehicle is drawn, and which way it heads: at its fix, always -
    // the fix is where the vehicle is. What it is on is its line's trip, so
    // it heads the way its line does at its projection (the loop-aware one
    // the progress already uses), and that projection is kept for the shape
    // to bend through it (see _bentRoute). A line with no shape heads from
    // the last two fixes. All of it kept per vehicle while its fix does not
    // move.
    _placeVeh(e) {
        const vid = this._vid(e.f);
        const raw = this._world(e.f.geometry.coordinates[1], e.f.geometry.coordinates[0]);
        const key = `${e.def.idx}:${vid}`;
        e.key = key;
        e.w = raw;
        const pos = `${Math.round(raw.x)},${Math.round(raw.y)}`;
        const hit = this._angCache.get(key);
        if (hit && hit.pos === pos) { e.angle = hit.a; e.prj = hit.prj; return; }
        let angle = null, prj = null;
        const route = this._ld[e.def.idx]?.route;
        if (route) {
            prj = this._projectVeh(e.def.idx, vid, raw, route);
            angle = this._routeAngleAt(route, raw, prj, true);
        }
        if (angle == null) {
            const h = this._hist.get(key) || [];
            if (h.length > 1) {
                const a1 = this._world(h[h.length - 2].lat, h[h.length - 2].lon);
                angle = (Math.atan2(raw.x - a1.x, -(raw.y - a1.y)) * 180) / Math.PI;
            }
        }
        this._angCache.set(key, { pos, a: angle, prj });
        e.angle = angle;
        e.prj = prj;
    }

    // The vehicles a journey card shows: those running one of its runs - a
    // trip listed for a leg by its sensor or its leg file, remembered until
    // it reaches that leg's arrival, so the vehicle a rider is on does not
    // vanish once it has left the stop - since a vehicle elsewhere on the
    // line is not one anyone on the journey will ride. A leg whose sensor
    // gives no trip ids falls back on position: the vehicles still short of
    // its arrival. Lines outside the journeys are left alone. Null without
    // a journey.
    _journeyVehicleFilter() {
        const plans = this._visiblePlans();
        if (!plans.length) return null;
        const now = Date.now();
        for (const [k, end] of this._seenTrips) if (end + 5 * 60000 < now) this._seenTrips.delete(k);
        const legsOf = new Map();
        for (const pl of plans) {
            for (const leg of pl.legs) {
                if (!legsOf.has(leg.def.idx)) legsOf.set(leg.def.idx, []);
                legsOf.get(leg.def.idx).push(leg);
                // the runs the sensor lists now, kept until they arrive
                for (const r of leg.st ? this._sourceRows({ def: leg.def, st: leg.st }) : []) {
                    const key = r.tripId ? `${leg.def.idx}|${r.tripId}` : null;
                    if (key && !this._seenTrips.has(key)) this._seenTrips.set(key, r.time.getTime() + (r.durMin ?? 120) * 60000);
                }
            }
        }
        const withTrips = new Set([...this._seenTrips.keys()].map((k) => Number(k.split("|")[0])));
        return (e) => {
            const legs = legsOf.get(e.def.idx);
            // a line no journey shown rides: left alone, unless a line is
            // picked - then only the journeys of that line are on the map
            if (!legs) return this._hiLine == null && !this._destView()?.narrowed;
            if (withTrips.has(e.def.idx)) {
                const tid = e.f.properties?.trip_id;
                return tid != null && this._seenTrips.has(`${e.def.idx}|${tid}`);
            }
            return !!e.prj && legs.some((leg) => {
                const d = leg.slice.route?.stops[leg.ei];
                return !!d && e.prj.cum <= d.cum + 50;
            });
        };
    }

    // A line's shape bent through its vehicles. The shape is the stops
    // joined in riding order, straight across the blocks the streets go
    // around; a vehicle between two stops is on the street the line really
    // takes, so where the two disagree it is the shape that is wrong, not
    // the fix. Each vehicle becomes a vertex of the polyline at its
    // projection's abscissa - the line runs through the marker instead of
    // beside it, and is still cut by abscissa, stops and slices unchanged.
    // Returns a route-like {line, cum, mPerU, stops, pins}, pins giving the
    // vertex index of each vehicle; the shape itself when no vehicle rides.
    _bentRoute(route, vehs) {
        const pins = vehs.filter((v) => v.prj).map((v) => ({ key: v.key, w: v.w, idx: v.prj.idx, t: v.prj.t, cum: v.prj.cum }))
            .sort((a, b) => a.idx - b.idx || a.t - b.t);
        if (!pins.length) return route;
        const line = [], cum = [], at = new Map();
        let p = 0;
        for (let i = 0; i < route.line.length; i++) {
            line.push(route.line[i]);
            cum.push(route.cum[i]);
            while (p < pins.length && pins[p].idx === i) {
                at.set(pins[p].key, line.length);
                line.push(pins[p].w);
                cum.push(Math.max(cum[cum.length - 1], pins[p].cum));
                p++;
            }
        }
        return { line, cum, mPerU: route.mPerU, stops: route.stops, pins: at };
    }

    // heading (degrees, 0 = north, clockwise) of the route at the point's
    // projection: the LineString follows the travel direction of the trip,
    // so this is the correct arrow orientation by construction. Returns null
    // when the point is too far from the route to trust it, unless onLine
    // says the point belongs to the route whatever the distance.
    _routeAngleAt(route, w, prj, onLine) {
        prj = prj || this._projectOnPolyline(w, route.line, route.cum);
        if (!onLine && Math.sqrt(prj.d2) * route.mPerU > 150) return null;
        let i0 = prj.idx, i1 = Math.min(prj.idx + 1, route.line.length - 1);
        let a = route.line[i0], b = route.line[i1];
        let dx = b.x - a.x, dy = b.y - a.y;
        if (!dx && !dy) {
            if (i1 + 1 < route.line.length) { b = route.line[i1 + 1]; dx = b.x - a.x; dy = b.y - a.y; }
            if (!dx && !dy) return null;
        }
        return (Math.atan2(dx, -dy) * 180) / Math.PI;
    }

    // small white arrowheads along a route, oriented in the travel direction
    // (the shape follows the trip's stop order); this is what tells the two
    // directions of a line apart at a glance
    _routeArrows(route, relFn, u, spanM) {
        const total = route.cum[route.cum.length - 1] || 0;
        const step = Math.max(300, Math.min(3000, spanM / 10));
        let svg = "", target = step / 2, i = 1, count = 0;
        while (target < total && count < 60) {
            while (i < route.line.length && route.cum[i] < target) i++;
            if (i >= route.line.length) break;
            const a = route.line[i - 1], b = route.line[i];
            const segLen = route.cum[i] - route.cum[i - 1] || 1;
            const t = (target - route.cum[i - 1]) / segLen;
            const p = relFn({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
            const ang = (Math.atan2(b.x - a.x, -(b.y - a.y)) * 180) / Math.PI;
            svg += `<path d="M0 ${-4 * u} L${3.2 * u} ${3 * u} L0 ${1.4 * u} L${-3.2 * u} ${3 * u} Z" fill="var(--card-background-color, #fff)" opacity="0.9" transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)}) rotate(${ang.toFixed(1)})"></path>`;
            target += step;
            count++;
        }
        return svg;
    }

    // The two ends of the selected/tracked line (topLi), each a stop of a
    // shape tagged end: "start" or "end"; the neutral view stays minimal.
    // The origin is looked for on the line's own shape, else on any other
    // shape calling there, so its pin survives a shape not read yet; the
    // destination only on its own shape, after the origin. An explicit
    // latitude/longitude in the config is intentional and always shows.
    _stationPoints(topLi) {
        const pts = [];
        const seen = new Set();
        if (topLi != null) {
            for (const src of this._depSources()) {
                if (!src.def || src.def.idx !== topLi) continue;
                // the sensor's ends, remembered so an unavailable sensor
                // (end of service) keeps them
                const slice = this._legSlice(src.def, src.st);
                const stops = slice.route?.stops || [];
                let origin = slice.oFound ? stops[slice.oi] : null;
                if (!origin && slice.oid) {
                    for (const route of this._ld.map((s) => s.route).filter(Boolean)) {
                        origin = route.stops?.find((s) => s.id === slice.oid || s.id.includes(slice.oid) || slice.oid.includes(s.id)) || null;
                        if (origin) break;
                    }
                }
                if (origin && !seen.has("o" + origin.id)) { seen.add("o" + origin.id); pts.push({ ...origin, end: "start" }); }
                const dest = slice.dFound ? stops[slice.di] : null;
                if (dest && !seen.has("d" + dest.id)) { seen.add("d" + dest.id); pts.push({ ...dest, end: "end" }); }
            }
        }
        if (this._config.latitude != null && this._config.longitude != null) {
            pts.push({ ...this._world(Number(this._config.latitude), Number(this._config.longitude)), end: "start" });
        }
        return pts;
    }

    /* ── PANE 2: MAP base map (MapLibre under the SVG) ──────────────────── */

    // what MapLibre is asked to draw: the theme's style, or the user's own -
    // a MapLibre style URL, or a raster {z}/{x}/{y} template wrapped into a
    // one-layer style (shown as it comes: no theme, no credit of ours)
    _mapStyleSpec() {
        const style = this._config.map_style;
        if (!style || style === "auto" || style === "light" || style === "dark") {
            const dark = style === "dark" || (style !== "light" && !!this._hass?.themes?.darkMode);
            return { key: dark ? "dark" : "light", style: dark ? MAP_STYLES.dark : MAP_STYLES.light, own: true };
        }
        if (/\{z\}/.test(style)) {
            const tiles = [style.replace("{r}", "")];
            return { key: style, own: false, style: { version: 8, sources: { raster: { type: "raster", tiles, tileSize: 256 } }, layers: [{ id: "raster", type: "raster", source: "raster" }] } };
        }
        return { key: style, own: false, style };
    }

    // the MapLibre canvas under the SVG. Built once the module is in (a
    // moment on a cold cache), and only if the pane still stands by then.
    _buildBasemap() {
        const wrap = this.shadowRoot.querySelector(".map-wrap");
        const host = wrap?.querySelector(".map-gl");
        if (!host || this._map) return;
        const gen = ++this._mapGen;
        loadMapLibre().then((ML) => {
            if (gen !== this._mapGen || !host.isConnected || this._map) return;
            const spec = this._mapStyleSpec();
            let map;
            try {
                map = new ML.Map({
                    container: host, style: spec.style, interactive: false, attributionControl: false,
                    renderWorldCopies: false, fadeDuration: 150,
                });
            } catch (e) {
                // no WebGL: a browser flag, or an exhausted context pool
                this._mapError = e?.message || "webgl";
                this._updateAttrib();
                return;
            }
            this._map = map;
            this._mapStyleKey = spec.key;
            this._mapError = null;
            this._mapCredit = null;
            wrap.dataset.basemap = "loading";
            map.on("style.load", () => this._basemapStyled(map));
            map.on("error", (e) => {
                // a tile missing here or there is MapLibre's business; a
                // style that never comes is what leaves the map blank
                if (!map.isStyleLoaded() && !this._mapError) {
                    this._mapError = e?.error?.message || "style";
                    this._updateAttrib();
                }
            });
            map.on("dataloading", () => { wrap.dataset.basemap = "loading"; });
            map.on("idle", () => { wrap.dataset.basemap = "idle"; });
            this._syncBasemap();
        }).catch((e) => {
            if (gen !== this._mapGen) return;
            this._mapError = e?.message || "import";
            this._updateAttrib();
        });
    }

    // a style just landed (first one, or a theme flip): drop the layers the
    // card does without, and read the credit its sources ask for
    _basemapStyled(map) {
        const st = map.getStyle();
        for (const l of st?.layers || []) if (MAP_HIDE_LAYERS.has(l["source-layer"])) map.removeLayer(l.id);
        const credits = [];
        for (const [id, src] of Object.entries(st?.sources || {})) {
            const a = String(map.getSource(id)?.attribution ?? src.attribution ?? "").replace(/<[^>]*>/g, "").trim();
            if (a && !credits.includes(a)) credits.push(a);
        }
        this._mapCredit = credits.join(" · ");
        this._mapError = null;
        this._updateAttrib();
    }

    _dropBasemap() {
        this._mapGen++;
        if (this._map) {
            try { this._map.remove(); } catch (e) { /* its container is already gone */ }
            this._map = null;
        }
        this._mapStyleKey = null;
        this._mapCredit = null;
    }

    // the pane's body replaced by something that is not a map
    _clearMap(body, html) {
        this._dropBasemap();
        body.innerHTML = html;
        this._mapDomReady = false;
    }

    // theme flips and an edited map_style land here on the next render
    _applyBasemapStyle() {
        const map = this._map;
        if (!map) return;
        const spec = this._mapStyleSpec();
        if (spec.key === this._mapStyleKey) return;
        this._mapStyleKey = spec.key;
        this._mapCredit = null;
        map.setStyle(spec.style);
    }

    // MapLibre follows the SVG camera: the viewBox, sliced to the element's
    // box (preserveAspectRatio xMidYMid slice), is a centre and a zoom.
    // MapLibre counts 512 px tiles: the world is 512 * 2^zoom css px wide.
    _syncBasemap() {
        const map = this._map;
        const vb = this._viewBox, O = this._origin;
        if (!map || !vb || !O) return;
        if (!this._scaleW || !this._scaleH) {
            const svg = this.shadowRoot.querySelector(".map-wrap svg");
            this._scaleW = svg?.clientWidth || 408;
            this._scaleH = svg?.clientHeight || 204;
        }
        const s = Math.max(this._scaleW / vb[2], this._scaleH / vb[3]);   // css px per world unit
        const cx = O.x + vb[0] + vb[2] / 2, cy = O.y + vb[1] + vb[3] / 2;
        const center = [(cx / WORLD) * 360 - 180, this._latOf(cy)], zoom = Math.log2((s * WORLD) / 512);
        // MapLibre cannot invert a camera handed a zoom that is not a number,
        // and throws on every frame after: better a base map left where it was
        if (!Number.isFinite(zoom) || !center.every(Number.isFinite)) return;
        map.jumpTo({ center, zoom });
    }

    _updateAttrib() {
        const at = this.shadowRoot.querySelector(".map-attrib");
        if (!at) return;
        const newestAt = Math.max(0, ...this._ld.map((s) => s.sigAt || 0));
        at.textContent = this._attribText(newestAt);
    }

    _liveBusCount() {
        // a journey map counts the vehicles it keeps, as drawn last
        if (this._shownBus != null && !this._focus) return this._shownBus;
        const now = Date.now();
        return this._ld.reduce((n, s) => n + ((s.sigAt && now - s.sigAt > STALE_FEED) ? 0 : (s.geo?.features?.length || 0)), 0);
    }

    // "16 trams running" when every line shares a mode, "22 vehicles" otherwise
    _busCountText(count) {
        const lang = this._lang();
        const mk = this._shownMode();
        // {m} the mode's singular, {mp} its plural: each language takes the one it says it with
        if (!count) return this._t("no_vehicle", { m: modeWord(lang, mk, false), mp: modeWord(lang, mk, true) });
        return count === 1
            ? this._t("bus_running", { m: modeWord(lang, mk, false) })
            : this._t("buses_running", { n: count, m: modeWord(lang, mk, true) });
    }

    // the mode of the lines the map is about: the line picked, else the
    // one every line shares, else "vehicle"
    _shownMode() {
        const defs = this._lineDefs();
        const top = this._hiLine != null ? this._hiLine : this._destTopLi();
        const d = top != null ? defs.find((x) => x.idx === top) : null;
        if (d) return d.mode || "bus";
        const modes = new Set(defs.map((x) => x.mode || "bus"));
        return modes.size === 1 ? [...modes][0] : "vehicle";
    }

    /* ── PANE 2: MAP rendering ──────────────────────────────────────────── */

    _renderMapSection() {
        if (!this._built) return;   // no shell yet: see _renderHeader
        const head = this.shadowRoot.getElementById("map-head");
        const body = this.shadowRoot.getElementById("map-body");
        if (this._config.show_map === false) {
            head.style.display = "none";
            this._clearMap(body, "");
            this.shadowRoot.getElementById("focus-panel").innerHTML = "";
            return;
        }
        head.style.display = "";
        head.setAttribute("aria-expanded", String(!this._collapsed.map));
        if (this._collapsed.map) {
            const count = this._liveBusCount();
            const stale = this._feedStaleAge();
            const summary = stale
                ? `<span class="summary warn">${this._t("feed_stale", { t: fmtAgo(this._lang(), stale) })}</span>`
                : `<span class="summary">${this._mapSummary(count)}</span>`;
            head.innerHTML = `
                <span class="chev">${ICONS.chevronRight}</span>
                <span class="sect-title">${this._t("line_map")}</span>
                <span class="spacer"></span>
                ${summary}`;
            this._clearMap(body, "");
            this.shadowRoot.getElementById("focus-panel").innerHTML = "";
            return;
        }
        // positions are optional: a line that only knows its route shape
        // still has a map worth drawing
        if (!this._lineDefs().some((d) => d.positions_url || d.route_url)) {
            this._renderMapHead();
            this._clearMap(body, `<div class="empty">${this._t("no_source")}</div>`);
            return;
        }
        this._renderMap(false);
    }

    // collapsed pane, no vehicle to count: an endless ellipsis is the wrong
    // answer for a line that simply publishes no positions and is showing
    // its route below
    _mapSummary(count) {
        if (count) return this._busCountText(count);
        const posOk = this._ld.some((s) => s.geoAt && !s.err);
        if (!posOk && this._ld.some((s) => s.route)) return this._t("route_only");
        // positions read and none to draw - a quiet night, or a journey map
        // keeping none of its lines' vehicles: said, not left as the dots of
        // a wait
        if (posOk) return this._busCountText(0);
        return "…";
    }

    _ensureMapDom(body) {
        if (this._mapDomReady && body.querySelector(".map-wrap")) return;
        const aspect = this._config.map_aspect && /^[\d\s./]+$/.test(String(this._config.map_aspect))
            ? ` style="aspect-ratio: ${esc(String(this._config.map_aspect))};"` : "";
        body.innerHTML = `
            <div class="map-wrap">
                <div class="map-gl"></div>
                <svg preserveAspectRatio="xMidYMid slice" tabindex="0"${aspect}>
                    <g class="l-overlay"></g>
                    <g class="l-veh"></g>
                </svg>
                <button class="map-btn" data-action="unfocus" hidden>${this._t("line_view")}</button>
                <div class="map-ctrl">
                    <button class="map-ctrl-btn" data-action="zoom-in" aria-label="${esc(this._t("zoom_in"))}">+</button>
                    <button class="map-ctrl-btn" data-action="zoom-out" aria-label="${esc(this._t("zoom_out"))}">−</button>
                    <button class="map-ctrl-btn" data-action="recenter" aria-label="${esc(this._t("recenter"))}" title="${esc(this._t("recenter"))}" hidden>⌖</button>
                </div>
                <div class="map-foot">
                    <div class="map-scale"><i></i><span></span></div>
                    <span class="map-attrib"></span>
                </div>
                <div class="map-hint"></div>
                <div class="map-pop" hidden></div>
                <div class="map-tip" hidden></div>
            </div>`;
        this._mapDomReady = true;
        this._scaleW = 0;
        this._scaleH = 0;
        this._popSize = null;
        this._vehEls.clear();
        this._attachMapEvents();
        this._buildBasemap();
    }

    _renderMap(animate) {
        if (this._config.show_map === false) return;
        const body = this.shadowRoot.getElementById("map-body");
        const panel = this.shadowRoot.getElementById("focus-panel");
        const defs = this._lineDefs();
        const lang = this._lang();

        // flatten features with their line def; a feed frozen for a while
        // means the buses are ghosts (end of service): hide them
        const all = [];
        const nowMs = Date.now();
        for (const def of defs) {
            const slot = this._ld[def.idx];
            if (slot?.sigAt && nowMs - slot.sigAt > STALE_FEED) continue;
            for (const f of slot?.geo?.features || []) {
                if (Array.isArray(f.geometry?.coordinates)) all.push({ f, def });
            }
        }
        // where each vehicle is drawn, and which way it heads: see _placeVeh.
        // Everything below reads e.w - the view, the label boxes, the marker,
        // the tracking - so the vehicle is in one place for all of them
        for (const e of all) this._placeVeh(e);

        let focusEntry = this._focus ? all.find((e) => e.def.idx === this._focus.li && this._vid(e.f) === this._focus.vid) : null;
        if (this._focus && !focusEntry) {
            // tracked vehicle left the feed (end of trip): glide back to the
            // fitted view and say why, instead of jumping silently
            this._focus = null;
            this._manual = false;
            this._restoreTrackedLine();
            animate = true;
            this._showHint(this._t("tracking_ended"));
        }

        // the "top" line: the focused bus's line, else the line picked by
        // tracking, else the one line the destination header leaves; the
        // lines it leaves out step back
        const topLi = focusEntry ? focusEntry.def.idx : (this._hiLine ?? this._destTopLi());
        const dset = this._destLines();
        // a journey card shows the vehicles its journeys ride and no other of
        // their lines (see _journeyVehicleFilter), the journeys of a picked
        // line only when one is; a tracked vehicle shows its line whole, as
        // it always did
        this._shownBus = null;
        if (!focusEntry) {
            const keep = this._journeyVehicleFilter();
            if (keep) {
                all.splice(0, all.length, ...all.filter(keep));
                this._shownBus = all.length;
            }
        }
        // the count in the head is the vehicles drawn
        this._renderMapHead();
        // each line's shape bent through the vehicles shown (see _bentRoute):
        // what every stroke of a line is drawn from, its slices included
        const bent = new Map();
        for (const def of defs) {
            const route = this._ld[def.idx]?.route;
            if (route) bent.set(def.idx, this._bentRoute(route, all.filter((e) => e.def.idx === def.idx)));
        }
        let stations = this._stationPoints(topLi);
        // the journey, drawn in the neutral view only: a line picked from its
        // badge or a tracked vehicle shows that line whole, as it always did
        const jGeo = !focusEntry && (topLi == null || this._journeys?.length) ? this._journeyGeometry(bent) : null;
        // A line picked from its badge is picked whole. The journeys riding
        // it keep their discs and their numbers, but a journey rides a
        // stretch of the line, and fitting the view to that stretch alone
        // left the rest of the line off screen - a line picked to be looked
        // at, shown in part. So the ground the view must cover is the line's
        // own, end to end, whatever the journeys on it ask for.
        const pickedFit = [];
        if (!focusEntry && this._hiLine != null) {
            for (const src of this._depSources()) {
                if (!src.def || src.def.idx !== this._hiLine) continue;
                const s = this._legSlice(src.def, src.st);
                const stops = s.route?.stops;
                if (!stops || s.oi == null || s.di == null || s.di <= s.oi) continue;
                pickedFit.push(...this._subRoute(bent.get(this._hiLine) || s.route,
                    stops[s.oi].cum, stops[s.di].cum).line);
            }
        }
        // a journey's own ends carry the words of departure and arrival: no
        // station marker saying them a second time
        if (jGeo) stations = [];
        const anyRoute = this._ld.some((s) => s.route);
        if (!all.length && !anyRoute && !stations.length) {
            // nothing to draw at all: name the half that is missing. A route
            // fetch already attempted and empty is the useful thing to say
            // when the line publishes no positions to begin with.
            const posErr = this._ld.some((s) => s.err);
            const posData = this._ld.some((s) => s.geoAt);
            const routeTried = this._ld.some((s) => s.routeAt);
            const msg = posErr ? this._t("unreachable")
                : posData ? this._busCountText(0)
                : routeTried ? this._t("route_unreachable")
                : this._t("loading");
            this._clearMap(body, `<div class="empty">${msg}</div>`);
            panel.innerHTML = "";
            return;
        }

        this._ensureMapDom(body);
        const svg = body.querySelector(".map-wrap svg");
        // one layout read for the whole render: the element cannot resize
        // between these statements, and re-reading it after a DOM write is
        // what forces a synchronous re-layout
        const svgW = svg.clientWidth, svgH = svg.clientHeight;
        const frameAspect = svgW ? Math.max(0.3, Math.min(1.4, svgH / svgW)) : 0.5;

        const refLat = all.length ? all[0].f.geometry.coordinates[1]
            : this._config.latitude != null ? Number(this._config.latitude)
            : this._refLatFromStops() ?? 47;
        const mPerU = this._ld.find((s) => s.route)?.route.mPerU || this._mPerU(refLat);
        this._mPerUNow = mPerU;

        // target viewBox in ABSOLUTE world units; a manual pan/zoom wins
        // over auto-fit until the recenter button
        let target;
        if (this._manual && this._viewBox && this._origin) {
            target = [this._viewBox[0] + this._origin.x, this._viewBox[1] + this._origin.y, this._viewBox[2], this._viewBox[3]];
        } else if (focusEntry) {
            const c = focusEntry.w;
            const w = 900 / mPerU, h = w * frameAspect;
            target = [c.x - w / 2, c.y - h * 0.6, w, h];
        } else {
            let pts;
            if (jGeo?.fit.length) {
                // a journey fits its own ground: the ridden slices, the
                // numbered points and the walks between them. Vehicles at the
                // far end of a line are still drawn, off screen until the
                // user pans there, rather than stretching the view to them
                pts = [...jGeo.fit, ...stations, ...pickedFit];
            } else {
                pts = all.map((e) => e.w);
                pts.push(...stations);
                for (const s of this._ld) if (s.route) pts.push(...s.route.line);
            }
            let minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x));
            let minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y));
            const padX = Math.max((maxX - minX) * 0.12, 300 / mPerU);
            const padY = Math.max((maxY - minY) * 0.15, 250 / mPerU);
            minX -= padX; maxX += padX; minY -= padY; maxY += padY;
            let w = maxX - minX, h = maxY - minY;
            if (h < w * frameAspect) { const g = (w * frameAspect - h) / 2; minY -= g; h = w * frameAspect; }
            else if (w < h / frameAspect) { const g = (h / frameAspect - w) / 2; minX -= g; w = h / frameAspect; }
            target = [minX, minY, w, h];
        }

        // stable origin keeps SVG coordinates small (float precision) without
        // invalidating cached geometry on every pan
        if (!this._origin || Math.abs(target[0] - this._origin.x) > 2e6 || Math.abs(target[1] - this._origin.y) > 2e6) {
            this._origin = { x: Math.floor(target[0]), y: Math.floor(target[1]) };
            // new origin: every relative coordinate changes, the vehicle
            // nodes must reappear in place rather than glide across the map
            this._vehEls.clear();
            const vl = svg.querySelector(".l-veh");
            if (vl) vl.innerHTML = "";
        }
        const O = this._origin;
        const rel = (p) => ({ x: p.x - O.x, y: p.y - O.y });
        const targetRel = [target[0] - O.x, target[1] - O.y, target[2], target[3]];

        // animate explicit transitions, and follow the tracked vehicle
        // smoothly on data refreshes too; skip imperceptible moves (which
        // also breaks the animate → final render → animate recursion)
        if (this._viewBox && (animate || focusEntry)) {
            const vb0 = this._viewBox;
            const dMax = Math.max(Math.abs(vb0[0] - targetRel[0]), Math.abs(vb0[1] - targetRel[1]),
                Math.abs(vb0[2] - targetRel[2]), Math.abs(vb0[3] - targetRel[3]));
            // a follow move (data refresh while tracking) shares the duration
            // and the curve of the marker transition: the tracked vehicle and
            // its popup stay pinned on screen, the map slides underneath
            if (dMax > targetRel[2] * 0.004) this._animateViewBox(vb0, targetRel, animate ? 280 : FOLLOW_MS, animate ? null : EASE_OUT);
            else this._setViewBox(targetRel);
        } else this._setViewBox(targetRel);
        const vb = this._viewBox;

        const clientW = svgW || body.clientWidth || 408;
        this._lastW = body.clientWidth || this._lastW;
        const u = vb[2] / clientW;                     // world units per css px
        const spanM = vb[2] * mPerU;                   // map span in metres
        // vehicle disc radius, in css px, eased between a close-up view where
        // the mode glyph must read and a whole-network view where markers
        // would otherwise pile onto each other
        const markerR = 14 - 5 * Math.max(0, Math.min(1,
            (Math.log(Math.max(1, spanM)) - Math.log(MARKER_SPAN_MIN)) /
            (Math.log(MARKER_SPAN_MAX) - Math.log(MARKER_SPAN_MIN))));

        // ── base map: a theme flip or an edited map_style lands here
        this._applyBasemapStyle();

        // ── routes (per line; passed/ahead split on the focused bus's line).
        // SVG stacks in paint order: draw the "top" line LAST.
        let routeSvg = "";
        let nextStopName = null;
        // connections: for each stop name, the configured lines serving it
        // (keyed by badge label so both directions of a line count once)
        const labelOf = new Map(defs.map((d) => [d.idx, this._lineLabelOf(d)]));
        const links = new Map();
        for (const def of defs) {
            const r = this._ld[def.idx]?.route;
            if (!r) continue;
            for (const s of r.stops) {
                if (!s.name) continue;
                const k = s.name.trim().toLowerCase();
                let m = links.get(k);
                if (!m) { m = new Map(); links.set(k, m); }
                if (!m.has(labelOf.get(def.idx))) m.set(labelOf.get(def.idx), def.color);
            }
        }
        this._stopLinks = links;
        const hasLinks = (s, def) => {
            const m = links.get((s.name || "").trim().toLowerCase());
            return !!m && [...m.keys()].some((l) => l !== labelOf.get(def.idx));
        };
        // stop names show themselves when the map is zoomed in enough; one
        // shared collision list across lines so shared stops label once
        const labelsOn = spanM < LABEL_SPAN;
        const placed = [];
        this._shownLabels.clear();
        if (focusEntry) {
            // the vehicle popup is an HTML box above the marker: reserve its
            // footprint so no stop label gets drawn underneath it
            const pw = this._popSize?.w || 200;
            const ph = this._popSize?.h || 64;
            const bc = rel(focusEntry.w);
            placed.push({ x: bc.x - (pw / 2) * u, y: bc.y - (24 + ph) * u, w: pw * u, h: ph * u });
        }
        // the ends of the line shown, or of the journey, say what they are
        // at every zoom: a word beside the marker, the stop's name with it
        // once the view is tight. Reserved first, so no stop label sits
        // where the word goes; drawn last, above the overlay (further down)
        const endLabels = [];
        // vehicles sit above the overlay: the word goes to the side of the
        // marker least covered by them at this refresh - right, left,
        // above, below, the first clear one winning
        const overlap = (b, list) => list.reduce((sum, o) => sum
            + Math.max(0, Math.min(b.x + b.w, o.x + o.w) - Math.max(b.x, o.x))
            * Math.max(0, Math.min(b.y + b.h, o.y + o.h) - Math.max(b.y, o.y)), 0);
        const vehBoxes = all.map((e) => {
            const q = rel(e.w);
            const r = (markerR + 3) * u;
            return { x: q.x - r, y: q.y - r, w: 2 * r, h: 2 * r };
        });
        // a journey's ends wear D and A on their discs: their label is the
        // stop's name alone, the word only while the name is unknown
        const endLabel = (pos, kind, name, lettered) => {
            const c = rel(pos);
            const word = this._t(kind === "end" ? "map_end" : "map_start");
            const nm = name ? String(name).trim() : "";
            const both = (labelsOn || lettered) && !!nm;
            let text = !both ? word : lettered ? nm : `${word} · ${nm}`;
            const full = text.length <= 30;
            if (!full) text = text.slice(0, 29).trimEnd() + "…";
            const w = (text.length * 5.6 + 12) * u, h = 15 * u, gap = 13 * u;
            const sides = [
                { x: c.x + gap, y: c.y - h / 2, w, h },
                { x: c.x - gap - w, y: c.y - h / 2, w, h },
                { x: c.x - w / 2, y: c.y - gap - h, w, h },
                { x: c.x - w / 2, y: c.y + gap, w, h },
            ];
            let box = sides[0], least = Infinity;
            for (const b of sides) {
                const pen = overlap(b, placed) + overlap(b, vehBoxes);
                if (pen < least) { least = pen; box = b; }
                if (!pen) break;
            }
            placed.push(box);
            if (both && full) this._shownLabels.add(nm.toLowerCase());
            endLabels.push({ box, text });
        };
        for (const st of stations) endLabel(st, st.end, st.name);
        if (jGeo) for (const p of jGeo.points) if (p.kind === "start" || p.kind === "end") endLabel(p.pos, p.kind, p.name, true);
        const routeDefs = topLi == null ? defs
            : [...defs].sort((a, b) => (a.idx === topLi ? 1 : 0) - (b.idx === topLi ? 1 : 0));
        for (const def of routeDefs) {
            const route = this._ld[def.idx]?.route;
            const color = def.color;
            const isFocusLine = focusEntry && focusEntry.def.idx === def.idx;
            // a picked line, or a picked journey, dims the lines it leaves out
            const dimLine = (topLi != null && def.idx !== topLi) || (!!dset && !dset.has(def.idx))
                || (!!jGeo && !!this._destView()?.narrowed && !jGeo.byLine.has(def.idx));
            if (route) {
                // the stroke follows the shape bent through the vehicles; the
                // shape alone, with no vehicle on it, keeps its cached path
                const shape = bent.get(def.idx) || route;
                let dAll;
                if (shape !== route) {
                    dAll = shape.line.map((p, i) => `${i ? "L" : "M"}${(p.x - O.x).toFixed(1)} ${(p.y - O.y).toFixed(1)}`).join(" ");
                } else if (route._dCache && route._dCache.ox === O.x && route._dCache.oy === O.y) {
                    dAll = route._dCache.d;
                } else {
                    dAll = route.line.map((p, i) => `${i ? "L" : "M"}${(p.x - O.x).toFixed(1)} ${(p.y - O.y).toFixed(1)}`).join(" ");
                    route._dCache = { ox: O.x, oy: O.y, d: dAll };
                }
                if (isFocusLine) {
                    const busW = focusEntry.w;
                    const prj = focusEntry.prj || this._projectVeh(def.idx, this._vid(focusEntry.f), busW, route);
                    // the split runs through the marker: the tracked vehicle
                    // is a vertex of the bent shape, both halves meet on it
                    const lineRel = shape.line.map(rel);
                    const k = shape.pins?.get(focusEntry.key);
                    const pr = rel(busW);
                    const passed = lineRel.slice(0, k ?? prj.idx + 1).map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") + ` L${pr.x.toFixed(1)} ${pr.y.toFixed(1)}`;
                    const ahead = `M${pr.x.toFixed(1)} ${pr.y.toFixed(1)} ` + lineRel.slice(k != null ? k + 1 : prj.idx + 1).map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
                    routeSvg += `<path d="${passed}" fill="none" stroke="#8a9096" stroke-width="${3.5 * u}" stroke-dasharray="${7 * u} ${7 * u}" opacity="0.7" stroke-linecap="round"></path>`;
                    routeSvg += `<path d="${ahead}" fill="none" stroke="${esc(color)}" stroke-width="${5 * u}" opacity="0.92" stroke-linecap="round"></path>`;
                    const next = route.stops.find((s) => s.cum > prj.cum + 15);
                    nextStopName = next?.name || null;
                    for (const s of route.stops) {
                        const p = rel(s);
                        const ahead2 = s.cum > prj.cum;
                        routeSvg += this._stopMarker(s, p, u, ahead2 ? esc(color) : "#8a9096", 4, hasLinks(s, def), def.idx, route);
                    }
                    if (next) {
                        const p = rel(next);
                        const labelW = (next.name.length * 6.2 + 16) * u;
                        const nbox = { x: p.x - labelW / 2, y: p.y - 24 * u, w: labelW, h: 17 * u };
                        const underPop = placed.some((b) => nbox.x < b.x + b.w && nbox.x + nbox.w > b.x && nbox.y < b.y + b.h && nbox.y + nbox.h > b.y);
                        placed.push(nbox);
                        if (!underPop) {
                            routeSvg += `<g><rect x="${nbox.x.toFixed(1)}" y="${nbox.y.toFixed(1)}" width="${labelW.toFixed(1)}" height="${(17 * u).toFixed(1)}" rx="${(8.5 * u).toFixed(1)}" fill="var(--card-background-color, #fff)" opacity="0.95"></rect>
                            ${svgText(p.x, p.y - 12 * u, 10, u, 'font-weight="500" fill="var(--primary-text-color, #212121)" text-anchor="middle"', esc(next.name))}</g>`;
                        }
                    }
                    if (labelsOn) routeSvg += this._stopLabels(route.stops, rel, u, placed, next);
                } else if (jGeo?.byLine.has(def.idx)) {
                    // a journey line: the whole shape faint for context, the
                    // ridden slice full, with its arrows, its stops and their
                    // names; the points get their numbers further down
                    routeSvg += `<path d="${dAll}" fill="none" stroke="${esc(color)}" stroke-width="${4.5 * u}" opacity="0.18" stroke-linecap="round"></path>`;
                    for (const g of jGeo.byLine.get(def.idx)) {
                        const d = g.sub.line.map((p, i) => `${i ? "L" : "M"}${(p.x - O.x).toFixed(1)} ${(p.y - O.y).toFixed(1)}`).join(" ");
                        routeSvg += `<path d="${d}" fill="none" stroke="${esc(color)}" stroke-width="${5 * u}" opacity="0.92" stroke-linecap="round"></path>`;
                        routeSvg += this._routeArrows(g.sub, rel, u, spanM);
                        for (const s of g.stops) {
                            const p = rel(s);
                            routeSvg += this._stopMarker(s, p, u, esc(color), 3.5, hasLinks(s, def), def.idx, route);
                        }
                        if (labelsOn) routeSvg += this._stopLabels(g.stops, rel, u, placed, null);
                    }
                } else {
                    routeSvg += `<path d="${dAll}" fill="none" stroke="${esc(color)}" stroke-width="${4.5 * u}" opacity="${dimLine ? 0.18 : 0.9}" stroke-linecap="round"></path>`;
                    if (!dimLine) {
                        routeSvg += this._routeArrows(shape, rel, u, spanM);
                        for (const s of route.stops) {
                            const p = rel(s);
                            routeSvg += this._stopMarker(s, p, u, esc(color), 3.5, hasLinks(s, def), def.idx, route);
                        }
                        if (labelsOn) routeSvg += this._stopLabels(route.stops, rel, u, placed, null);
                    }
                }
            } else {
                // no route export yet for this line: draw per-bus recent traces
                for (const e of all) {
                    if (e.def.idx !== def.idx) continue;
                    const key = `${def.idx}:${this._vid(e.f)}`;
                    const h = this._hist.get(key) || [];
                    if (h.length > 1) {
                        const d = h.map((p, i) => {
                            const q = rel(this._world(p.lat, p.lon));
                            return `${i ? "L" : "M"}${q.x.toFixed(1)} ${q.y.toFixed(1)}`;
                        }).join(" ");
                        const active = focusEntry
                            ? (focusEntry.def.idx === def.idx && this._vid(focusEntry.f) === this._vid(e.f))
                            : (topLi == null || def.idx === topLi);
                        routeSvg += `<path d="${d}" fill="none" stroke="${esc(color)}" stroke-width="${3 * u}" stroke-dasharray="${6 * u} ${6 * u}" opacity="${active ? 0.45 : 0.15}" stroke-linecap="round"></path>`;
                    }
                }
            }
        }

        // ── the line's ends (one pair per departure sensor), in the station
        // colour: the start a hollow ring with a dot, the arrival a solid
        // disc with a square inside, the way a terminus is drawn
        let stationSvg = "";
        const sc = this._stationColor();
        for (const station of stations) {
            const s = rel(station);
            stationSvg += `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${13 * u}" fill="${esc(sc)}" opacity="0.2"></circle>`;
            if (station.end === "end") {
                stationSvg += `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${9 * u}" fill="${esc(sc)}" stroke="var(--card-background-color, #fff)" stroke-width="${2 * u}"></circle>
                          <rect x="${(s.x - 3 * u).toFixed(1)}" y="${(s.y - 3 * u).toFixed(1)}" width="${6 * u}" height="${6 * u}" rx="${0.8 * u}" fill="var(--card-background-color, #fff)"></rect>`;
            } else {
                stationSvg += `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${9 * u}" fill="var(--card-background-color, #fff)" stroke="${esc(sc)}" stroke-width="${3.5 * u}"></circle>
                          <circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${3.2 * u}" fill="${esc(sc)}"></circle>`;
            }
        }
        // ── journey points: the walk of a change first (dotted, under the
        // discs), then one numbered disc per point in the station colour
        if (jGeo) {
            const ink = inkOn(sc);
            for (const w of jGeo.walks) {
                const a = rel(w.from), b = rel(w.to);
                stationSvg += `<path d="M${a.x.toFixed(1)} ${a.y.toFixed(1)} L${b.x.toFixed(1)} ${b.y.toFixed(1)}" fill="none" stroke="${esc(sc)}" stroke-width="${3 * u}" stroke-dasharray="${1 * u} ${6 * u}" stroke-linecap="round" opacity="0.9"></path>`;
            }
            // the other journeys' points first, so the numbered ones sit on top
            for (const p of jGeo.others) {
                const c = rel(p.pos);
                stationSvg += `<g class="stop jpt" data-action="stop" data-li="${p.li}" data-name="${esc(p.name)}" data-x="${c.x.toFixed(1)}" data-y="${c.y.toFixed(1)}">
                    <circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${14 * u}" fill="${esc(sc)}" opacity="0.2"></circle>
                    <circle class="dot" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${10 * u}" fill="${esc(sc)}" stroke="var(--card-background-color, #fff)" stroke-width="${2.5 * u}"></circle>
                    ${this._alertPipSvg(this._stopAlertsAt(p.li, p.name), c.x + 4 * u, c.y - 4 * u, u, 10)}</g>`;
            }
            // points closer than a disc are one mark - a start next to the
            // first stop, a change seen from afar - or the second hides the
            // first: a pill saying the first number and the last
            const groups = [];
            for (const p of jGeo.points) {
                const c = rel(p.pos);
                const g = groups.find((q) => Math.hypot(q.c.x - c.x, q.c.y - c.y) < 20 * u);
                if (g) g.pts.push(p); else groups.push({ c, pts: [p] });
            }
            for (const { c, pts } of groups) {
                const p = pts[0];
                const text = pts.length > 1 ? `${this._ptLabel(p)}–${this._ptLabel(pts[pts.length - 1])}` : this._ptLabel(p);
                const name = [...new Set(pts.map((q) => q.name).filter(Boolean))].join(" / ");
                const w = Math.max(20, 7 * text.length + 8) * u;
                const halo = pts.length > 1
                    ? `<rect x="${(c.x - w / 2 - 4 * u).toFixed(1)}" y="${(c.y - 14 * u).toFixed(1)}" width="${(w + 8 * u).toFixed(1)}" height="${(28 * u).toFixed(1)}" rx="${(14 * u).toFixed(1)}" fill="${esc(sc)}" opacity="0.2"></rect>`
                        + `<rect class="dot" x="${(c.x - w / 2).toFixed(1)}" y="${(c.y - 10 * u).toFixed(1)}" width="${w.toFixed(1)}" height="${(20 * u).toFixed(1)}" rx="${(10 * u).toFixed(1)}" fill="${esc(sc)}" stroke="var(--card-background-color, #fff)" stroke-width="${2.5 * u}"></rect>`
                    : `<circle cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${14 * u}" fill="${esc(sc)}" opacity="0.2"></circle>`
                        + `<circle class="dot" cx="${c.x.toFixed(1)}" cy="${c.y.toFixed(1)}" r="${10 * u}" fill="${esc(sc)}" stroke="var(--card-background-color, #fff)" stroke-width="${2.5 * u}"></circle>`;
                const pal = pts.map((q) => this._stopAlertsAt(q.li, q.name)).find(Boolean);
                stationSvg += `<g class="stop jpt" data-action="stop" data-li="${p.li}" data-name="${esc(name)}" data-x="${c.x.toFixed(1)}" data-y="${c.y.toFixed(1)}">
                    ${halo}
                    ${svgText(c.x, c.y + 3.8 * u, 11, u, `font-weight="700" fill="${ink}" text-anchor="middle" pointer-events="none"`, esc(text))}
                    ${this._alertPipSvg(pal, c.x + (pts.length > 1 ? w / 2 - 2 * u : 4 * u), c.y - 4 * u, u, 10)}</g>`;
            }
        }
        // ── the ends' words, ringed in the station colour, above the markers
        for (const l of endLabels) {
            stationSvg += `<g pointer-events="none"><rect x="${l.box.x.toFixed(1)}" y="${l.box.y.toFixed(1)}" width="${l.box.w.toFixed(1)}" height="${l.box.h.toFixed(1)}" rx="${(7.5 * u).toFixed(1)}" fill="var(--card-background-color, #fff)" stroke="${esc(sc)}" stroke-width="${(1.2 * u).toFixed(2)}" opacity="0.95"></rect>`
                + svgText(l.box.x + 6 * u, l.box.y + l.box.h / 2 + 3.4 * u, 9.5, u, 'font-weight="700" fill="var(--primary-text-color, #212121)"', esc(l.text)) + "</g>";
        }

        // ── buses: top line's buses above the others, focused bus on top.
        // Vehicles live in persistent SVG nodes keyed by line + vehicle id
        // (see _syncVehicles): position and heading changes glide through a
        // CSS transition instead of jumping at every refresh
        const busOrder = topLi == null ? all
            : [...all].sort((a, b) =>
                ((a.def.idx === topLi ? 1 : 0) + (a === focusEntry ? 1 : 0)) -
                ((b.def.idx === topLi ? 1 : 0) + (b === focusEntry ? 1 : 0)));
        const vehicles = [];
        for (const e of busOrder) {
            const def = e.def;
            const vid = this._vid(e.f);
            const c = rel(e.w);
            const angle = e.angle;
            const focused = focusEntry === e;
            const dim = !focused && ((topLi != null && def.idx !== topLi) || (!!dset && !dset.has(def.idx)));
            // labels only where they stay readable: tracked bus, highlighted
            // line, or an overview span tight enough not to turn into soup
            const showLabel = focused || (topLi != null ? def.idx === topLi : spanM < 6000);
            // the disc carries an upright mode glyph, the heading rides on a
            // separate arrow orbiting its rim: a rotating glyph would read
            // upside down as soon as the vehicle runs southwards.
            // Its radius follows the visible span: full size when tracking one
            // vehicle a few hundred metres across, smaller on a whole-network
            // view where a dozen markers would otherwise clot together. The
            // tracked vehicle keeps the full size, it is the one being read.
            const R = (focused ? 16 : markerR) * u;
            const ink = inkOn(def.color);
            const body = (this._config.mode_icons !== false
                    // r is now the ink radius, not half the longest side: 0.638
                    // is the factor that leaves the marker glyphs the average
                    // size they had under the old rule, so the map does not
                    // silently resize when the badges gain their pixels
                    && modeGlyph(def.mode || "bus", R * 0.638, ink))
                || `<path d="M0 ${-5 * u} L${4.2 * u} ${3.5 * u} L0 ${1.6 * u} L${-4.2 * u} ${3.5 * u} Z" fill="${ink}"></path>`;
            // heading arrow: only when a heading is known, and only on the
            // markers big enough to carry it without turning into a blob
            const beak = angle != null && (focused || !dim)
                ? `<g class="hd"><path d="M0 ${(-R - 10 * u).toFixed(1)} L${(6.6 * u).toFixed(1)} ${(-R + 1.4 * u).toFixed(1)} L${(-6.6 * u).toFixed(1)} ${(-R + 1.4 * u).toFixed(1)} Z" fill="${esc(def.color)}" stroke="var(--card-background-color, #fff)" stroke-width="${(1.6 * u).toFixed(2)}" stroke-linejoin="round"></path></g>`
                : "";
            const inner = `
                <circle r="${Math.max(22, R / u + 9) * u}" fill="transparent" stroke="none"></circle>
                ${focused ? `<circle r="${23 * u}" fill="${esc(def.color)}" opacity="0.15"></circle>` : ""}
                ${beak}
                <g>
                    <circle r="${R}" fill="${esc(def.color)}" stroke="var(--card-background-color, #fff)" stroke-width="${2.5 * u}"></circle>
                    ${body}
                </g>
                ${showLabel ? `<rect x="${-20 * u}" y="${18 * u}" width="${40 * u}" height="${16 * u}" rx="${8 * u}" fill="var(--card-background-color, #fff)" opacity="0.95"></rect>
                ${svgText(0, 29.5 * u, 10, u, 'font-weight="600" fill="var(--primary-text-color, #212121)" text-anchor="middle"', esc(vid))}` : ""}`;
            vehicles.push({ key: `${def.idx}:${vid}`, li: def.idx, vid, x: c.x, y: c.y, angle: angle || 0, dim, inner,
                aria: `${modeWord(lang, def.mode || "bus", false)} ${vid}` });
        }

        svg.setAttribute("viewBox", vb.map((v) => v.toFixed(1)).join(" "));
        this._syncBasemap();
        svg.querySelector(".l-overlay").innerHTML = routeSvg + stationSvg;
        this._syncVehicles(svg.querySelector(".l-veh"), vehicles);

        const btnUnfocus = body.querySelector('.map-btn[data-action="unfocus"]');
        if (btnUnfocus) btnUnfocus.hidden = !this._focus;
        const btnRecenter = body.querySelector('.map-ctrl-btn[data-action="recenter"]');
        if (btnRecenter) btnRecenter.hidden = !this._manual;
        const attrib = body.querySelector(".map-attrib");
        if (attrib) {
            const newestAt = Math.max(0, ...this._ld.map((s) => s.sigAt || 0));
            attrib.textContent = this._attribText(newestAt);
        }

        // vehicle popup anchored on the tracked marker (replaces the old
        // bottom panel)
        const pop = body.querySelector(".map-pop");
        if (pop) {
            if (focusEntry) {
                const popKey = `${focusEntry.def.idx}:${this._vid(focusEntry.f)}`;
                const popW = focusEntry.w;
                const html = this._popHtml(focusEntry, nextStopName);
                if (pop.innerHTML !== html) { pop.innerHTML = html; this._popSize = null; }
                pop.hidden = false;
                // measured once per content change and reused by the label
                // collision list, which runs before this point on the next
                // render: reading it there forced a layout mid-render
                if (!this._popSize && pop.offsetWidth) {
                    this._popSize = { w: pop.offsetWidth, h: pop.offsetHeight };
                }
                this._popGlide(popW, popKey);
            } else {
                pop.hidden = true;
                this._popWorld = null;
                this._popKey = null;
                if (this._popAnim) { cancelAnimationFrame(this._popAnim); this._popAnim = null; }
            }
        }
        panel.innerHTML = "";
        this._updateScale();
    }

    // graphic scale, bottom left: the largest round length under ~90 px
    _updateScale() {
        const body = this.shadowRoot.getElementById("map-body");
        const el = body?.querySelector(".map-scale");
        const svg = body?.querySelector(".map-wrap svg");
        if (!el || !svg || !this._viewBox) return;
        if (!this._scaleW) this._scaleW = svg.clientWidth || 408;
        const mPerPx = (this._viewBox[2] * this._mPerUNow) / this._scaleW;
        const nice = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000];
        let len = nice[0];
        for (const v of nice) if (v / mPerPx <= 90) len = v;
        // skip the DOM write when nothing changed: this runs on every frame
        const px = `${Math.round(len / mPerPx)}px`;
        const txt = len >= 1000 ? `${len / 1000} km` : `${len} m`;
        if (this._scalePx !== px) { el.querySelector("i").style.width = px; this._scalePx = px; }
        if (this._scaleTxt !== txt) { el.querySelector("span").textContent = txt; this._scaleTxt = txt; }
    }

    // keyed reconciliation of the vehicle nodes: an existing node keeps its
    // identity (so the CSS transition animates its move), a new one appears
    // in place, a gone one is removed, paint order follows the list
    _syncVehicles(layer, vehicles) {
        if (!layer) return;
        const seen = new Set();
        let idx = 0;
        for (const v of vehicles) {
            seen.add(v.key);
            let g = this._vehEls.get(v.key);
            const fresh = !g || g.parentNode !== layer;
            if (fresh) {
                g = document.createElementNS("http://www.w3.org/2000/svg", "g");
                g.setAttribute("data-action", "bus");
                g.setAttribute("data-li", String(v.li));
                g.setAttribute("data-vid", v.vid);
                g.setAttribute("role", "button");
                g.setAttribute("tabindex", "0");
                g.style.transform = `translate(${v.x.toFixed(1)}px, ${v.y.toFixed(1)}px)`;
                g._inner = null;
                g._ang = null;
                this._vehEls.set(v.key, g);
            }
            g.setAttribute("class", `bus${v.dim ? " dim" : ""}`);
            g.setAttribute("aria-label", v.aria);
            if (g._inner !== v.inner) { g.innerHTML = v.inner; g._inner = v.inner; g._ang = null; }
            // heading unwrapped so the arrow always turns the short way round
            let a = v.angle;
            if (g._ang != null) {
                while (a - g._ang > 180) a -= 360;
                while (a - g._ang < -180) a += 360;
            }
            const hd = g.querySelector(".hd");
            if (hd) { g._ang = a; hd.style.transform = `rotate(${a.toFixed(1)}deg)`; }
            else g._ang = null;
            if (!fresh) g.style.transform = `translate(${v.x.toFixed(1)}px, ${v.y.toFixed(1)}px)`;
            const at = layer.children[idx];
            if (at !== g) layer.insertBefore(g, at || null);
            idx++;
        }
        for (const [key, g] of this._vehEls) {
            if (!seen.has(key)) { g.remove(); this._vehEls.delete(key); this._angCache.delete(key); }
        }
    }

    // the popup follows its marker with the same glide as the CSS transition
    _popGlide(w, key) {
        const from = this._popWorld;
        const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (this._popAnim) { cancelAnimationFrame(this._popAnim); this._popAnim = null; }
        if (!from || key !== this._popKey || reduced || (from.x === w.x && from.y === w.y)) {
            this._popKey = key;
            this._popWorld = w;
            this._positionPop();
            return;
        }
        const start = performance.now(), dur = FOLLOW_MS;
        const step = (now) => {
            const t = Math.min(1, (now - start) / dur);
            const e = EASE_OUT(t);
            this._popWorld = { x: from.x + (w.x - from.x) * e, y: from.y + (w.y - from.y) * e };
            this._positionPop();
            if (t < 1) this._popAnim = requestAnimationFrame(step); else this._popAnim = null;
        };
        this._popAnim = requestAnimationFrame(step);
    }

    _positionPop() {
        const body = this.shadowRoot.getElementById("map-body");
        const pop = body?.querySelector(".map-pop");
        const svg = body?.querySelector(".map-wrap svg");
        if (!pop || pop.hidden || !svg || !this._popWorld || !this._viewBox || !this._origin) return;
        const vb = this._viewBox;
        // cached box: re-measured by the resize observer and on a map rebuild
        if (!this._scaleW) this._scaleW = svg.clientWidth || 408;
        if (!this._scaleH) this._scaleH = svg.clientHeight || 204;
        const w = this._scaleW, h = this._scaleH;
        const sx = ((this._popWorld.x - this._origin.x) - vb[0]) / vb[2] * w;
        const sy = ((this._popWorld.y - this._origin.y) - vb[1]) / vb[3] * h;
        // clamp inside the map even on very narrow cards, top and bottom too
        const mx = Math.max(8, Math.min(80, (w - 16) / 2));
        pop.style.left = `${Math.max(mx, Math.min(w - mx, sx))}px`;
        pop.style.top = `${Math.max(10, Math.min(h - 6, sy - 24))}px`;
    }

    // ms since the newest feed change once every line with data has frozen
    // (end of service), else 0
    _feedStaleAge() {
        const now = Date.now();
        // scoped to the selected line when there is one: with several lines on
        // the card, one ending its service is real news, and waiting for the
        // last one to stop would hide it behind the others
        const hi = this._hiLine;
        const withData = this._ld.filter((s, i) => s.sigAt && (hi == null || i === hi));
        if (!withData.length || withData.some((s) => now - s.sigAt <= STALE_FEED)) return 0;
        return now - Math.max(...withData.map((s) => s.sigAt));
    }

    _renderMapHead() {
        const head = this.shadowRoot.getElementById("map-head");
        head.setAttribute("aria-expanded", "true");
        const count = this._liveBusCount();
        let summary;
        if (this._focus) {
            const def = this._lineDefs()[this._focus.li];
            const mw = modeWord(this._lang(), def?.mode || "bus", false);
            summary = `<span class="summary accent">${this._t("tracking", { m: mw, v: esc(this._focus.vid) })}${def ? ` · ${this._t("line_label", { l: esc(this._lineLabelOf(def)) })}` : ""}</span>`;
        } else {
            const stale = this._feedStaleAge();
            summary = stale
                ? `<span class="summary warn">${this._t("feed_stale", { t: fmtAgo(this._lang(), stale) })}</span>`
                : `<span class="summary">${this._mapSummary(count)}</span>`;
        }
        head.innerHTML = `
            <span class="chev">${ICONS.chevronDown}</span>
            <span class="sect-title">${this._t("line_map")}</span>
            <span class="spacer"></span>
            ${summary}`;
    }

    _popHtml(entry, nextStopName) {
        const vid = this._vid(entry.f);
        const h = this._hist.get(`${entry.def.idx}:${vid}`) || [];
        let speed = null;
        if (h.length > 1) {
            const a = h[h.length - 2], b = h[h.length - 1];
            const dt = (b.ts - a.ts) / 1000;
            if (dt > 5) speed = Math.round((haversine(a, b) / dt) * 3.6);
        }
        const mw = modeWord(this._lang(), entry.def.mode || "bus", false);
        const veh = mw.charAt(0).toUpperCase() + mw.slice(1);
        const sigAt = this._ld[entry.def.idx]?.sigAt || 0;
        const upd = sigAt ? fmtAgo(this._lang(), Date.now() - sigAt) : "";
        // terminus: last stop of the exported trip shape, else the sensor's
        // destination; the next-stop row is dropped when it is the terminus
        const route = this._ld[entry.def.idx]?.route;
        let terminus = route?.stops?.length ? route.stops[route.stops.length - 1].name : "";
        if (!terminus && entry.def.entity) terminus = this._hass?.states?.[entry.def.entity]?.attributes?.destination_station_stop_name || "";
        const showNext = nextStopName && nextStopName !== terminus;
        // speed only once measured (two positions seen): no placeholder
        const tele = [speed != null ? `${speed} km/h` : null, upd ? esc(upd) : null].filter(Boolean).join(" · ");
        return `
            <div class="pop-head">
                <span class="mini-badge" style="background:${esc(entry.def.color)};color:${inkOn(entry.def.color)}">${esc(this._lineLabelOf(entry.def))}</span>
                <b>${veh} ${esc(vid)}</b>
                <span class="spacer"></span>
                <button class="pop-close" data-action="untrack" aria-label="${esc(this._t("close"))}">✕</button>
            </div>
            ${terminus ? `<div class="pop-dest">→ ${esc(terminus)}</div>` : ""}
            ${showNext ? `<div class="pop-row">${this._t("next_stop", { s: esc(nextStopName) })}</div>` : ""}
            ${tele ? `<div class="pop-row">${tele}</div>` : ""}`;
    }

    // a stop: wide transparent hit area, the dot itself; connection stops
    // (served by another configured line) drawn bigger with a thicker ring.
    // The line's real ends - first and last stop of the shape, not where a
    // journey gets on or off - are squares instead of rings
    _stopMarker(s, p, u, stroke, baseR, hub, li, route) {
        const r = (hub ? baseR + 1.6 : baseR) * u;
        const sw = (hub ? 2.6 : 2) * u;
        const st = route?.stops;
        const term = !!st?.length && (s === st[0] || s === st[st.length - 1]);
        const dot = term
            ? `<rect class="dot" x="${(p.x - r).toFixed(1)}" y="${(p.y - r).toFixed(1)}" width="${(2 * r).toFixed(2)}" height="${(2 * r).toFixed(2)}" rx="${(0.6 * u).toFixed(2)}" fill="var(--card-background-color, #fff)" stroke="${stroke}" stroke-width="${sw}"></rect>`
            : `<circle class="dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(2)}" fill="var(--card-background-color, #fff)" stroke="${stroke}" stroke-width="${sw}"></circle>`;
        return `<g class="stop" data-action="stop" data-li="${li}" data-name="${esc(s.name)}" data-x="${p.x.toFixed(1)}" data-y="${p.y.toFixed(1)}">`
            + `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${11 * u}" fill="transparent"></circle>`
            + dot + this._alertPipSvg(this._stopAlertsAt(li, s.name), p.x, p.y, u, hub ? baseR + 1.6 : baseR) + `</g>`;
    }

    // automatic stop labels (zoomed-in views): right of the dot, skipped on
    // collision with an already placed label
    _stopLabels(stops, rel, u, placed, skip) {
        let svg = "";
        for (const s of stops) {
            if (!s.name || s === skip) continue;
            const p = rel(s);
            const full = s.name.length <= 24;
            const name = full ? s.name : s.name.slice(0, 23).trimEnd() + "…";
            const w = (name.length * 5.4 + 10) * u, h = 14 * u;
            const box = { x: p.x + 7 * u, y: p.y - h / 2, w, h };
            if (placed.some((b) => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) continue;
            placed.push(box);
            if (full) this._shownLabels.add(String(s.name).trim().toLowerCase());
            svg += `<g pointer-events="none"><rect x="${box.x.toFixed(1)}" y="${box.y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="${(7 * u).toFixed(1)}" fill="var(--card-background-color, #fff)" opacity="0.88"></rect>`
                + svgText(box.x + 5 * u, p.y + 3.3 * u, 9, u, 'fill="var(--primary-text-color, #212121)"', esc(name)) + "</g>";
        }
        return svg;
    }

    _stopHover(e, on) {
        const g = e.composedPath().find((n) => n.classList && n.classList.contains("stop"));
        if (!g) return;
        if (!on && g.contains(e.relatedTarget)) return;   // moving between the stop's own circles
        if (on) {
            // a pressed pointer means a pan, not a visit: stops sliding under
            // the cursor mid-drag must not resurrect the tip that pointerdown
            // just hid - THAT tip would then sit still while the map moves
            if (this._pointers.size) return;
            // and the pan is not over at pointerup: releasing the capture, and
            // the deferred re-render, both replay pointerover on the stop still
            // under the cursor - it travelled with the drag. The tip the move
            // had just closed came straight back, as if nothing had moved.
            if (this._panHover) return;
            // the map already names this stop in full and it serves no other
            // line: a tooltip would just print the same words twice over
            if (this._labelIsRedundant(g.dataset)) return;
            this._showTip(g.dataset, 0);
        } else this._hideTip();
    }

    // true when the tooltip would add nothing to what the map already shows
    _labelIsRedundant(ds) {
        if (!ds.name) return true;
        const key = String(ds.name).trim().toLowerCase();
        // the mark says there is something to read here, and the tooltip is
        // where it is written: never mute it
        if (this._stopAlertsAt(Number(ds.li), ds.name)) return false;
        if (!this._shownLabels.has(key)) return false;    // name not drawn, or truncated
        const own = this._lineDefs()[Number(ds.li)];
        const ownLabel = own ? this._lineLabelOf(own) : null;
        const m = this._stopLinks.get(key);
        const others = m ? [...m].filter(([l]) => l !== ownLabel) : [];
        return others.length === 0;                       // no connections to add either
    }

    // stop tooltip: name plus the other configured lines serving it
    _showTip(ds, ms) {
        const body = this.shadowRoot.getElementById("map-body");
        const tip = body?.querySelector(".map-tip");
        const svg = body?.querySelector(".map-wrap svg");
        if (!tip || !svg || !this._viewBox || !ds.name) return;
        const own = this._lineDefs()[Number(ds.li)];
        const ownLabel = own ? this._lineLabelOf(own) : null;
        const m = this._stopLinks.get(String(ds.name).trim().toLowerCase());
        const others = m ? [...m].filter(([l]) => l !== ownLabel) : [];
        // what the line never does here, on any run: said only from the
        // line's word (the route file's boards / alights), never from the
        // drawn run's own call, which another run may make otherwise
        const stop = own ? this._ld[own.idx]?.route?.stops.find((s) => s.name.trim().toLowerCase() === String(ds.name).trim().toLowerCase()) : null;
        // said only where it matters: a line's first stop, or where a
        // journey boards it, is no place to get off anyway; its last, or
        // where a journey leaves it, no place to get on
        const lc = (x) => String(x || "").trim().toLowerCase();
        const nm = lc(ds.name), stops = own ? this._ld[own.idx]?.route?.stops || [] : [];
        let on = stops.length > 0 && lc(stops[0].name) === nm, off = stops.length > 0 && lc(stops[stops.length - 1].name) === nm;
        for (const pl of stop ? this._visiblePlans() : []) {
            pl.legs.forEach((leg, k) => {
                if (leg.def.idx !== own.idx) return;
                if (lc(k === 0 ? pl.points[0]?.name : leg.board?.name) === nm) on = true;
                if (lc(leg.end?.name) === nm) off = true;
            });
        }
        const never = [stop?.noBoard && !off ? this._t("tip_no_board") : "", stop?.noAlight && !on ? this._t("tip_no_alight") : ""].filter(Boolean);
        // what the operator says of this stop, under the name and the rest:
        // the sentence itself, wrapped, since it is the reason the mark is
        // there and a tooltip that only repeated the name would say nothing
        const said = this._stopAlertsAt(Number(ds.li), ds.name);
        const sayAl = said ? said.map((x) => this._alertSay(x)).filter(Boolean).join(" · ") : "";
        tip.innerHTML = `<b>${esc(ds.name)}</b>`
            + (others.length ? `<span class="tip-links">${others.map(([l, c]) => `<span class="mini-badge" style="background:${esc(c)};color:${inkOn(c)}">${esc(l)}</span>`).join("")}</span>` : "")
            + (never.length ? `<span class="tip-note">${never.map(esc).join(", ")}</span>` : "")
            + (sayAl ? `<span class="tip-alert">${esc(sayAl)}</span>` : "");
        tip.classList.toggle("tip-wrap", !!sayAl);
        const vb = this._viewBox, w = svg.clientWidth || 408, h = svg.clientHeight || 204;
        const sx = ((Number(ds.x) - vb[0]) / vb[2]) * w, sy = ((Number(ds.y) - vb[1]) / vb[3]) * h;
        tip.hidden = false;
        // Placed from its own size: an alert's sentence makes it tall, and a
        // tall tip over a stop near the top drew itself clean out of the
        // map, over the board above. It goes under the stop instead, and its
        // sides are held by its width, not by a margin guessed at.
        // Twice, because the first size a tip just opened gives is the one
        // it had before its words were wrapped: a line short, and the tip
        // placed as if it fitted. The second pass reads the size it has and
        // costs nothing once it stops changing.
        const place = () => {
            const tw = tip.offsetWidth, th = tip.offsetHeight;
            const below = sy - 10 - th < 4;
            tip.classList.toggle("below", below);
            const half = Math.min(tw / 2 + 4, w / 2);
            tip.style.left = `${Math.max(half, Math.min(w - half, sx))}px`;
            tip.style.top = below
                ? `${Math.max(4, Math.min(sy + 14, h - th - 4))}px`
                : `${Math.max(th + 4, Math.min(h - 4, sy - 10))}px`;
            return th;
        };
        if (place() !== tip.offsetHeight) place();
        if (this._tipT) clearTimeout(this._tipT);
        this._tipT = ms ? setTimeout(() => this._hideTip(), ms) : null;
    }

    _hideTip() {
        const tip = this.shadowRoot.querySelector(".map-tip");
        if (tip) tip.hidden = true;
        if (this._tipT) { clearTimeout(this._tipT); this._tipT = null; }
    }

    // any direct write wins over a running animation: leaving it alive would
    // let it keep interpolating towards a target captured in another origin
    _setViewBox(vb) {
        if (this._anim) { cancelAnimationFrame(this._anim); this._anim = null; }
        this._viewBox = vb;
    }

    _animateViewBox(from, to, dur = 280, ease = null) {
        if (this._anim) cancelAnimationFrame(this._anim);
        // every animated view change (zoom buttons, recenter, overview,
        // tracking glide) strands a screen-anchored tip: close it up front
        this._hideTip();
        // a degenerate box would be rejected by the SVG and strand the map:
        // jump rather than animate through invalid geometry
        if (!(from?.[2] > 0) || !(from[3] > 0) || !(to?.[2] > 0) || !(to[3] > 0)) {
            this._anim = null;
            this._viewBox = to;
            return;
        }
        // reduced motion: jump straight to the target (the caller renders it)
        if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            this._anim = null;
            this._viewBox = to;
            return;
        }
        const start = performance.now();
        const step = (now) => {
            const t = Math.min(1, (now - start) / dur);
            const e = ease ? ease(t) : 1 - Math.pow(1 - t, 3);
            this._viewBox = from.map((v, i) => v + (to[i] - v) * e);
            const svg = this.shadowRoot.querySelector(".map-wrap svg");
            if (svg) svg.setAttribute("viewBox", this._viewBox.map((v) => v.toFixed(1)).join(" "));
            this._syncBasemap();
            this._positionPop();
            this._updateScale();
            if (t < 1) this._anim = requestAnimationFrame(step);
            else { this._anim = null; this._viewBox = to; this._renderMap(false); }
        };
        this._anim = requestAnimationFrame(step);
    }

    /* ── PANE 2: MAP pan & zoom ─────────────────────────────────────────── */

    _attachMapEvents() {
        const svg = this.shadowRoot.querySelector(".map-wrap svg");
        if (!svg) return;
        svg.addEventListener("pointerdown", (e) => this._mapDown(e, svg));
        svg.addEventListener("pointermove", (e) => this._mapMove(e, svg));
        svg.addEventListener("pointerup", (e) => this._mapUp(e, svg));
        svg.addEventListener("pointercancel", (e) => this._mapUp(e, svg));
        svg.addEventListener("wheel", (e) => this._mapWheel(e, svg), { passive: false });
        // touch-action: pan-y hands ONE finger to the page, which is what the
        // card wants. It has no way to say "and two fingers are mine": the
        // browser reads a two-finger vertical drag as a page scroll as well,
        // takes it, and cancels the pointers mid-gesture - the dashboard
        // scrolled and the map never moved. Refusing the touch stream as soon
        // as a second finger lands is what keeps the gesture on the map.
        const holdMulti = (e) => { if (e.touches.length >= 2) e.preventDefault(); };
        svg.addEventListener("touchstart", holdMulti, { passive: false });
        svg.addEventListener("touchmove", holdMulti, { passive: false });
        svg.addEventListener("dblclick", (e) => this._mapDblClick(e, svg));
        // instant stop tooltip on mouse hover (touch uses the tap action)
        svg.addEventListener("pointerover", (e) => { if (e.pointerType === "mouse") this._stopHover(e, true); });
        svg.addEventListener("pointerout", (e) => { if (e.pointerType === "mouse") this._stopHover(e, false); });
        // a mouse that moves on its own ends the hover blackout a view change
        // opened; pointerover will not fire again inside the stop it never
        // left, so the visit is read from the move itself
        svg.addEventListener("pointermove", (e) => {
            if (e.pointerType !== "mouse") return;
            // the tip is placed from the view it was opened in and does not
            // travel: a map moving under it leaves it pointing at nothing
            if (this._pointers.size) { this._hideTip(); return; }
            // every render replaces the overlay, the stop under the cursor
            // with it: the node that would have fired pointerout is gone,
            // and the tip it opened would sit there for good. The move says
            // where the cursor really is, which is the only word left
            if (!e.composedPath().some((n) => n.classList && n.classList.contains("stop"))) this._hideTip();
            if (!this._panHover) return;
            this._panHover = false;
            this._stopHover(e, true);
        });
        // and a cursor that leaves the map without passing over a stop on
        // its way out never says so either
        svg.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") this._hideTip(); });
    }

    _showHint(text, teachKind) {
        // teaching hints (wheel/touch) stop nagging after a few showings
        if (teachKind) {
            if ((this._hintCounts[teachKind] || 0) >= 3) return;
            this._hintCounts[teachKind] = (this._hintCounts[teachKind] || 0) + 1;
        }
        const hint = this.shadowRoot.querySelector(".map-hint");
        if (!hint) return;
        hint.textContent = text;
        hint.classList.add("show");
        if (this._hintT) clearTimeout(this._hintT);
        this._hintT = setTimeout(() => hint.classList.remove("show"), 1600);
    }

    _clampVB(vb) {
        const minW = 100 / this._mPerUNow, maxW = WORLD / 4;
        if (vb[2] < minW || vb[2] > maxW) {
            const w = Math.max(minW, Math.min(maxW, vb[2]));
            const f = w / vb[2];
            const cx = vb[0] + vb[2] / 2, cy = vb[1] + vb[3] / 2;
            return [cx - (vb[2] * f) / 2, cy - (vb[3] * f) / 2, vb[2] * f, vb[3] * f];
        }
        return vb;
    }

    _applyVB(svg) {
        // the tip is anchored in screen pixels, not in the map: any view
        // change strands it over the wrong stop, so every direct view write
        // dismisses it - as _animateViewBox does for the animated ones
        this._hideTip();
        this._panHover = true;
        this._setViewBox(this._clampVB(this._viewBox));
        svg.setAttribute("viewBox", this._viewBox.map((v) => v.toFixed(1)).join(" "));
        this._syncBasemap();
        this._positionPop();
        this._updateScale();
    }

    _scheduleRerender() {
        if (this._rerenderTimer) clearTimeout(this._rerenderTimer);
        this._rerenderTimer = setTimeout(() => { this._rerenderTimer = null; this._renderMapSection(); }, 180);
    }

    // The journey board hangs on the shapes and the leg files as much as on
    // the sensors: where a leg is boarded, when a run reaches each point.
    // When one of them lands the board is drawn again; left to the sensors,
    // it kept the chain it could make without them until the next update of
    // a state, minutes later - boarding at a terminus miles from the change.
    _scheduleBoard() {
        if (!this._journeys?.length) return;
        if (this._boardTimer) clearTimeout(this._boardTimer);
        // the destination chips carry the next departure, which the same
        // files time
        this._boardTimer = setTimeout(() => { this._boardTimer = null; this._renderHeader(); this._renderDepartures(); }, 180);
    }

    _mapDown(e, svg) {
        if (this._anim) { cancelAnimationFrame(this._anim); this._anim = null; }
        this._hideTip();
        svg.setPointerCapture(e.pointerId);
        // with the pointer captured, recent Chromium delivers the ensuing
        // click to the svg instead of the marker under the finger, so the
        // [data-action] target is grabbed here and activated on pointerup
        this._downAction = this._pointers.size === 0
            ? (e.composedPath ? e.composedPath() : []).find((n) => n.dataset && n.dataset.action) || null
            : null;
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        this._moved = 0;
        if (this._pointers.size >= 2) this._multi = true;
        if (this._pointers.size === 2 && this._viewBox) {
            const [a, b] = [...this._pointers.values()];
            const rect = svg.getBoundingClientRect();
            this._pinch = {
                dist: Math.hypot(b.x - a.x, b.y - a.y),
                mid: { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top },
                vb: [...this._viewBox],
            };
        }
    }

    _mapMove(e, svg) {
        const p = this._pointers.get(e.pointerId);
        if (!p || !this._viewBox) return;
        const u = this._viewBox[2] / (svg.clientWidth || 408);
        if (this._pointers.size === 1) {
            const dx = e.clientX - p.x, dy = e.clientY - p.y;
            this._moved += Math.abs(dx) + Math.abs(dy);
            if (e.pointerType === "touch") {
                // one finger scrolls the page; the map moves with two fingers
                if (this._moved > 12) this._showHint(this._t("hint_touch"), "touch");
            } else if (this._moved > 5) {
                this._manual = true;
                this._suppressClick = true;
                this._viewBox[0] -= dx * u;
                this._viewBox[1] -= dy * u;
                this._applyVB(svg);
            }
        }
        this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this._pointers.size === 2 && this._pinch) {
            const [a, b] = [...this._pointers.values()];
            const dist = Math.hypot(b.x - a.x, b.y - a.y);
            if (dist > 10) {
                const rect = svg.getBoundingClientRect();
                const mid = { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top };
                const f = this._pinch.dist / dist;
                const vb0 = this._pinch.vb;
                const u0 = vb0[2] / (rect.width || 408);
                const wx = vb0[0] + this._pinch.mid.x * u0;
                const wy = vb0[1] + this._pinch.mid.y * u0;
                const u1 = u0 * f;
                this._manual = true;
                this._suppressClick = true;
                this._setViewBox([wx - mid.x * u1, wy - mid.y * u1, vb0[2] * f, vb0[3] * f]);
                this._applyVB(svg);
            }
        }
    }

    _mapUp(e, svg) {
        if (!this._pointers.has(e.pointerId)) return;
        this._pointers.delete(e.pointerId);
        this._pinch = null;
        const t = this._downAction;
        this._downAction = null;
        // lifting off a two-finger pan is not a tap: without this it closed
        // the tracking popup every time the map was moved with two fingers
        if (e.type === "pointerup" && this._moved <= 5 && !this._multi && this._pointers.size === 0) {
            if (t) {
                this._suppressClick = true; // the retargeted/native click must not re-activate
                this._activate(t);
            } else if (this._focus) {
                // a tap on the background closes the popup, view unchanged
                this._suppressClick = true;
                this._act("untrack", {});
            }
        }
        if (this._pointers.size === 0) this._multi = false;
        if (this._manual) this._scheduleRerender();
        setTimeout(() => { this._suppressClick = false; }, 250);
    }

    _mapWheel(e, svg) {
        if (!this._viewBox) return;
        if (!e.ctrlKey && !e.metaKey) {
            // let the page scroll; teach the gesture
            this._showHint(this._t("hint_wheel"), "wheel");
            return;
        }
        e.preventDefault();
        const f = e.deltaY > 0 ? 1.25 : 0.8;
        const rect = svg.getBoundingClientRect();
        const u = this._viewBox[2] / (rect.width || 408);
        const wx = this._viewBox[0] + (e.clientX - rect.left) * u;
        const wy = this._viewBox[1] + (e.clientY - rect.top) * u;
        this._manual = true;
        this._setViewBox([wx - (wx - this._viewBox[0]) * f, wy - (wy - this._viewBox[1]) * f, this._viewBox[2] * f, this._viewBox[3] * f]);
        this._applyVB(svg);
        this._scheduleRerender();
    }

    // double-click: recentre on the clicked point and zoom in one step.
    // Not on a bus: a single click there already focuses it.
    _mapDblClick(e, svg) {
        if (!this._viewBox) return;
        if (e.composedPath().some((n) => n.dataset && n.dataset.action === "bus")) return;
        e.preventDefault();
        const rect = svg.getBoundingClientRect();
        const u = this._viewBox[2] / (rect.width || 408);
        const wx = this._viewBox[0] + (e.clientX - rect.left) * u;
        const wy = this._viewBox[1] + (e.clientY - rect.top) * u;
        const w = this._viewBox[2] * 0.5, h = this._viewBox[3] * 0.5;
        this._manual = true;
        this._setViewBox(this._clampVB([wx - w / 2, wy - h / 2, w, h]));
        this._applyVB(svg);
        this._scheduleRerender();
    }

    _zoomBy(f) {
        if (!this._viewBox) return;
        // the zoom buttons sit outside the svg: no pointerdown reaches the
        // map, so this is the only place left to close the tip
        this._hideTip();
        this._panHover = true;
        const vb = this._viewBox;
        const cx = vb[0] + vb[2] / 2, cy = vb[1] + vb[3] / 2;
        this._manual = true;
        this._setViewBox(this._clampVB([cx - (vb[2] * f) / 2, cy - (vb[3] * f) / 2, vb[2] * f, vb[3] * f]));
        this._renderMap(false);
    }

    /* ── STYLES ─────────────────────────────────────────────────────────── */

    _styles() {
        return `
        :host { display: block; }
        ha-card { overflow: hidden; position: relative; font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
        /* The badges and the text zone sit side by side until the text zone
           would be squeezed under TITLES_MIN; then it takes a row of its own.
           Without the wrap a crowded header shrank the zone to nothing and the
           station name spilled past the card, which clips it. */
        .header { display: flex; align-items: center; gap: 12px; padding: 14px 16px 10px 16px; flex-wrap: wrap; }
        /* a floor of one badge: without it the block's max-content (every badge
           on one row) set the card's minimum width, and the card then refused
           to fit a column narrower than that */
        .badges { display: flex; gap: ${PIP_GAP}px; flex-wrap: wrap; min-width: ${BADGE_W}px; }
        /* a fixed square, never a box that grows with its label: two lines
           side by side have to be the same size, so it is the number that
           shrinks to fit the 40px between the paddings. See badgeFontSize. */
        .badge { position: relative; width: ${BADGE_W}px; height: ${BADGE_W}px; flex: none; border-radius: 10px; color: #fff; display: flex; align-items: center; justify-content: center; font-size: ${BADGE_FS}px; font-weight: 700; padding: 0 ${BADGE_PAD}px; box-sizing: border-box; }
        /* the mode chip rides on the badge itself: no disc, no outline, just
           the glyph in the badge's own ink, so it reads as part of the badge */
        /* a faint disc behind the glyph, tinted OPPOSITE to the ink: tinting it
           in the ink itself would put a white veil under a white glyph and
           swallow it. Set per badge as --chip-bg, since the ink depends on the
           line colour. */
        /* one size, one overhang, four possible corners: a mark is told apart
           by what it holds and by where it sits, never by how big it is */
        .badge-pip { position: absolute; width: ${BADGE_PIP}px; height: ${BADGE_PIP}px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: inherit; pointer-events: none; z-index: 3; --mdc-icon-size: 26px; }
        .badge-pip.br { right: ${-PIP_GAP / 2}px; bottom: ${-PIP_GAP / 2}px; }
        .badge-pip.tl { left: ${-PIP_GAP / 2}px; top: ${-PIP_GAP / 2}px; }
        .badge-pip.tr { right: ${-PIP_GAP / 2}px; top: ${-PIP_GAP / 2}px; }
        .badge-pip.bl { left: ${-PIP_GAP / 2}px; bottom: ${-PIP_GAP / 2}px; }
        .badge-pip.mode { background: var(--chip-bg, color-mix(in srgb, #000 40%, transparent)); }
        /* the state mark reads against the card, not against the line colour,
           so it says the same thing whatever line it sits on */
        .badge-pip.mute { background: var(--card-background-color, #fff); color: var(--warning-color, #b26a00); box-shadow: inset 0 0 0 1.5px currentColor; z-index: 5; }
        /* same treatment, deliberately not the same colour: a line resting
           for the weekend is not a fault, so it stays neutral and leaves the
           warning ink to the source that has gone quiet */
        .badge-pip.svc { background: var(--card-background-color, #fff); color: var(--secondary-text-color, #727272); box-shadow: inset 0 0 0 1.5px currentColor; z-index: 5; }
        /* the operator reporting a disruption outranks a stale file: this one
           takes the error ink, the quiet source keeps the warning ink, and the
           line at rest stays neutral. Three corners, three levels, one geometry */
        .badge-pip.alert { background: var(--card-background-color, #fff); color: var(--error-color, #b3261e); box-shadow: inset 0 0 0 1.5px currentColor; z-index: 5; }
        .badge-pip ha-icon { display: flex; }
        /* a line with no service is struck through by a single diagonal, at
           65% so it stays a note rather than a warning: the number underneath
           must remain readable. The halo below the stroke carries the opposite
           ink, which is what keeps the stroke visible on a mid green or grey
           line, where 65% ink alone measures barely 2.2:1. */
        /* the number sits above the stroke, so the diagonal crosses the badge
           without burying the digits */
        .badge-num { position: relative; z-index: 4; line-height: 1; }
        /* read out, never drawn: the diagonal is the visual half of this */
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
        .badge-slash { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 2; pointer-events: none; opacity: 0.65; border-radius: 10px; }
        .slash-halo { stroke: var(--opp-ink, #000); stroke-width: 5.5; opacity: 0.55; }
        /* the number keeps its full ink: a line still shows its number when it
           is not running. Only the badge as a whole steps back a little. */
        .badge.resting { opacity: 0.92; }
        .badge.resting.sel { opacity: 1; }
        /* A quiet source is drained, not dimmed. The colour itself is replaced
           by its desaturated twin (see drain), so nothing here fades the number
           or the mark: an opacity on the badge would take the mark down with
           it, and a veil over the colour cost the number its contrast. */
        .badge-glyph { width: ${BADGE_PIP}px; height: ${BADGE_PIP}px; display: block; }
        .badge.clickable { cursor: pointer; }
        .badge.sel { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .badge.dim { opacity: 0.45; }
        /* the hover title, said out loud for a finger. Same ink and shadow as
           the map tooltip, but it wraps: a badge's sentence can run to a
           destination, a rest and an alert at once. */
        .badge-tip { position: absolute; z-index: 6; max-width: min(280px, calc(100% - 16px)); background: var(--card-background-color, #fff); color: var(--primary-text-color); font-size: 12px; line-height: 1.35; padding: 6px 10px; border-radius: 8px; box-shadow: 0 1px 6px rgba(0,0,0,.35); pointer-events: none; }
        .badge:focus-visible, .sect-head:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        /* the whole frame left of the badges, however tall they stack; the
           header centres it vertically, and the text wraps instead of being
           cut - the journey name is the only thing this zone says */
        .titles { display: flex; flex-direction: column; gap: 2px; min-width: ${TITLES_MIN}px; flex: 1;
            align-items: center; text-align: center; }
        /* anywhere, not break-word: break-word leaves the min-content width at
           the longest word, so a word wider than the zone was never broken at
           all - it just hung out over the card's edge */
        .title { font-size: 16px; font-weight: 500; color: var(--primary-text-color); overflow-wrap: anywhere; }
        .subtitle, .sub, .summary { font-size: 13px; color: var(--secondary-text-color); }
        .subtitle { overflow-wrap: anywhere; }
        /* ── the destination header of a card of journeys ──
           A chip per destination opens on a 42 px medallion: the mode it is
           reached by at 26 px of ink, more than a badge's corner pip ever
           held and covered by nothing. The direction is a full-width control
           of 44 px, the ways are plates, every target a finger's size. */
        .dhead { flex: 1 1 100%; min-width: 0; display: flex; flex-direction: column; gap: 9px; }
        .dtitle { font-size: 16px; font-weight: 500; color: var(--primary-text-color); text-align: center; overflow-wrap: anywhere; }
        /* departures above arrivals on a rail: a disc and its caption, then
           the chips beside the rail, as a journey's timeline draws its points */
        .droute { display: grid; grid-template-columns: 18px minmax(0, 1fr); column-gap: 10px; row-gap: 6px; --lc: var(--secondary-text-color); }
        .droute .jnode::before { width: 2px; margin-left: -1px; top: -6px; bottom: -6px; }
        .droute .jnode.first::before { top: 50%; }
        .droute .jnode.last::before { bottom: 50%; }
        .droute .dwcap { margin: 0; align-self: center; font-weight: 600; }
        /* an even grid: two chips never stretch unevenly, a lone last one
           keeps its column */
        .drow { display: grid; grid-template-columns: repeat(auto-fit, minmax(165px, 1fr)); gap: 8px; }
        .dest { position: relative; display: flex; align-items: center; gap: 10px; min-width: 0; box-sizing: border-box; min-height: 58px;
            padding: 8px 12px 8px 8px; border-radius: 14px; border: 0; background: rgba(127,127,127,.12); color: var(--primary-text-color);
            text-align: left; cursor: pointer; font: inherit; }
        .dest.on { background: rgba(3,169,244,.14); background: color-mix(in srgb, var(--primary-color) 14%, transparent); box-shadow: inset 0 0 0 2px var(--primary-color); }
        .dest.solo { cursor: default; }
        .dest:focus-visible, .dway:focus-visible, .dfilter:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        /* The chip's identity: one plate per line it is reached by, the number
           full height and the mode on a band at the foot. Sized so two plates
           cost no more than the medallion they replaced. */
        .dplate.big { width: 26px; height: 34px; border-radius: 7px; }
        .dplate.big .n { font-size: 13px; letter-spacing: -0.02em; }
        .dplate.big .band { height: 12px; }
        .dmore { font-size: 11px; font-weight: 700; color: var(--secondary-text-color); align-self: center; }
        .dest .dplates { flex: none; align-items: center; gap: 3px; }
        .dtxt { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .dtxt > b { font-size: 14.5px; font-weight: 600; line-height: 1.15; overflow-wrap: anywhere; }
        .dmuted { font-size: 11.5px; color: var(--secondary-text-color); }
        /* the line plates, ahead of the clock on the same line: small enough
           that the clock stays what the eye lands on, and they wrap with it
           rather than push it out of a narrow chip */
        .dnums { display: inline-flex; gap: 3px; align-items: center; flex: none; }
        .dnum { display: inline-flex; align-items: center; justify-content: center; flex: none;
            min-width: 17px; height: 15px; padding: 0 4px; border-radius: 4px;
            font-size: 10.5px; font-weight: 700; line-height: 1; }
        /* the badge's marks, in the badge's corners and inks: the operator's
           alert top right in the error ink, the quiet source top left in the
           warning ink, the rest bottom left, neutral - one size, one overhang */
        .dmark { position: absolute; width: 22px; height: 22px; border-radius: 50%; background: var(--card-background-color, #fff);
            box-shadow: inset 0 0 0 1.5px currentColor; display: flex; align-items: center; justify-content: center; pointer-events: none; z-index: 2; }
        .dmark.alert { top: -7px; right: -7px; color: var(--error-color, #b3261e); }
        .dmark.mute { top: -7px; left: -7px; color: var(--warning-color, #b26a00); }
        .dmark.rest { bottom: -7px; left: -7px; color: var(--secondary-text-color, #727272); }
        .dmark svg, .dwal svg, .dplate .band svg { display: block; }
        /* The caption row closes both headers: what is left to say on the
           left, the toggle on the right. It is the only row every card has -
           a card without title: has no title row - which is why the toggle
           lives here rather than beside the title. */
        .caprow { display: flex; align-items: center; gap: 8px; min-height: 26px; }
        .caprow .capleft { flex: 1; display: flex; align-items: center; gap: 7px; min-width: 0;
            font-size: 13px; color: var(--secondary-text-color); overflow-wrap: anywhere; }
        .swap { display: inline-flex; flex: none; border: 1px solid var(--divider-color);
            border-radius: 8px; overflow: hidden; background: var(--card-background-color); }
        .swap button { border: 0; background: transparent; cursor: pointer; font: inherit;
            font-size: 10.5px; font-weight: 600; color: var(--secondary-text-color);
            padding: 4px 8px; min-height: 26px; display: inline-flex; align-items: center; gap: 4px; }
        .swap button + button { border-left: 1px solid var(--divider-color); }
        .swap button.on { background: var(--primary-text-color); color: var(--card-background-color, #fff); }
        .swap button:focus-visible { outline: 2px solid var(--primary-color); outline-offset: -3px; }
        .swap svg { display: block; }
        .dwcap { font-size: 11px; color: var(--secondary-text-color); margin-bottom: -3px; }
        .dways { display: flex; gap: 6px; flex-wrap: wrap; }
        .dway { position: relative; display: inline-flex; align-items: center; gap: 8px; min-height: 44px; box-sizing: border-box; padding: 4px 10px 4px 4px;
            border-radius: 10px; border: 0; background: rgba(127,127,127,.12); color: var(--primary-text-color); cursor: pointer; font: inherit; }
        .dway.on { background: rgba(3,169,244,.14); background: color-mix(in srgb, var(--primary-color) 14%, transparent); box-shadow: inset 0 0 0 2px var(--primary-color); }
        .dplates { display: flex; gap: 2px; }
        .dplate { width: 24px; height: 34px; border-radius: 6px; overflow: hidden; display: flex; flex-direction: column; font-weight: 700; flex: none; }
        .dplate .n { flex: 1; display: flex; align-items: center; justify-content: center; font-size: 10px; line-height: 1; }
        .dplate .band { height: 13px; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,.3); }
        .dwtxt { display: flex; flex-direction: column; line-height: 1.2; text-align: left; }
        .dwtxt .lbl { font-size: 11px; color: var(--secondary-text-color); }
        .dway.on .dwtxt .lbl { color: var(--primary-text-color); }
        .dwtxt .t { font-size: 13.5px; font-weight: 700; font-variant-numeric: tabular-nums; }
        .dwtxt .why { font-size: 12px; color: var(--secondary-text-color); max-width: 190px; }
        .dwal { width: 17px; height: 17px; border-radius: 50%; background: var(--card-background-color, #fff); color: var(--error-color, #b3261e);
            box-shadow: inset 0 0 0 1.5px currentColor; display: inline-flex; align-items: center; justify-content: center; flex: none; }
        .dway .x { font-size: 16px; line-height: 1; color: var(--secondary-text-color); }
        /* the destination or way picked, in the board's head, which drops it */
        .dfilter { display: inline-flex; align-items: center; gap: 4px; height: 20px; max-width: 50%; padding: 0 7px; border-radius: 6px; cursor: pointer;
            font-size: 11.5px; font-weight: 600; color: #fff; background: var(--primary-color); vertical-align: middle; white-space: nowrap; }
        /* the cut is on the text, not on the chip: a chip that clips its own
           overflow cannot carry the touch overlay below, which sits outside it */
        .dfilter .dfl { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
        .dfilter .x { font-weight: 400; opacity: .85; flex: none; }
        /* Both filter chips are small on purpose: they sit in a section head,
           they are not the head. But a finger aims at the row, not at 18px of
           it, and these chips are the only way back from a filter. The chip
           keeps its size and an invisible overlay gives it the head's full
           44px, reaching 6px to each side - inside the head's 8px gap, so it
           never swallows a tap meant for the title next to it. */
        .mini-badge.filter, .dfilter { position: relative; }
        .mini-badge.filter::after, .dfilter::after {
            content: ""; position: absolute; left: -6px; right: -6px;
            top: 50%; height: 44px; transform: translateY(-50%); }
        .spacer { flex-grow: 1; }
        .sect-head { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px; border-top: 1px solid var(--divider-color); cursor: pointer; user-select: none; }
        .sect-title { font-size: 14px; font-weight: 500; color: var(--primary-text-color); white-space: nowrap; }
        /* a narrow card cuts the summary short rather than wrapping the head */
        .sect-head .summary { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        @media (hover: hover) {
            .sect-head:hover, .row.jrow:not(.flat):hover { background: rgba(127,127,127,.06); }
        }
        .chev { color: var(--secondary-text-color); display: inline-flex; }
        .summary b { color: var(--primary-text-color); font-weight: 600; }
        .summary.accent { color: var(--primary-color); font-weight: 500; }
        .summary.warn { color: var(--warning-color, #e65100); }
        /* the ring grows by transform and fades by opacity, which the
           compositor plays alone: a box-shadow pulse restyled and repainted
           the card on the main thread every frame, for as long as it showed */
        .live-dot { position: relative; width: 8px; height: 8px; border-radius: 50%; background: #4caf50; }
        .live-dot::after { content: ""; position: absolute; inset: 0; border-radius: 50%; background: rgba(76,175,80,.5); animation: pulse 2s infinite; will-change: transform, opacity; }
        @keyframes pulse { 0% { transform: scale(1); opacity: 1; } 70% { transform: scale(2.5); opacity: 0; } 100% { transform: scale(2.5); opacity: 0; } }
        .row { display: flex; align-items: center; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--divider-color); }
        .row:first-child { border-top: none; }
        .row-badge { min-width: 26px; height: 24px; border-radius: 6px; color: #fff; display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; padding: 0 5px; box-sizing: border-box; flex: none; }
        .mini-badge { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 16px; border-radius: 4px; color: #fff; font-size: 10px; font-weight: 700; padding: 0 3px; vertical-align: middle; }
        .times { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        /* wrap, so a narrow card drops the destination onto its own line
           instead of ellipsising it down to a single letter: the row grows by
           one line rather than saying "C..." where a name belongs */
        .time-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; flex-wrap: wrap; }
        .time { font-size: 20px; font-weight: 700; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
        .day-tag { font-size: 11px; color: var(--secondary-text-color); border: 1px solid var(--divider-color); border-radius: 6px; padding: 0 5px; align-self: center; flex: none; }
        .dest-inline { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        /* journey rows: the head line over the timeline, a four-column grid -
           badge, rail, name, clock - so the names and the clocks line up down
           the whole journey whatever the legs. The rail is the node column's
           own line, in the leg's colour, cut at the first and last disc of a
           leg; a change is the same column dotted. */
        .row.jrow { flex-direction: column; align-items: stretch; gap: 6px; cursor: pointer; }
        .jhead { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 8px; min-width: 0; }
        .jhead:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; border-radius: 4px; }
        .jarrow { font-size: 16px; color: var(--secondary-text-color); }
        .jtotal { font-size: 13px; color: var(--secondary-text-color); white-space: nowrap; }
        /* a closed journey: its legs in a row, wrapping between legs only */
        .jsum { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 10px; font-size: 13px; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
        .jseg { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
        .jseg b { font-weight: 700; }
        /* a change in the row of legs: → walker wait → */
        .jchg { display: inline-flex; align-items: center; gap: 3px; font-size: 12px; color: var(--secondary-text-color); white-space: nowrap; }
        .jchg svg { flex: none; }
        /* a picked leg's runs: the head line alone, nothing to open */
        .row.jrow.flat { cursor: default; }
        /* stacked journeys: each under its title */
        .jsec { padding: 10px 16px 2px; font-size: 12px; font-weight: 600; letter-spacing: .02em; color: var(--secondary-text-color); border-top: 1px solid var(--divider-color); }
        .jsec:first-child { border-top: none; }
        .jsec + .row { border-top: none; }
        .jbadges { display: inline-flex; gap: 3px; }
        /* which journey a row is, under its head: badge and title */
        .jwhere { display: flex; align-items: center; gap: 6px; min-width: 0; margin-top: -3px; font-size: 12px; color: var(--secondary-text-color); }
        .jwt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        /* countdown over status, then the chevron, kept to the right: the
           classic rows' stack, so a chip never makes one row taller alone */
        .jright { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; white-space: nowrap; }
        .jwhen { display: inline-flex; flex-direction: column; align-items: flex-end; gap: 4px; }
        .chev.ph { visibility: hidden; }
        /* a day said once, over the first run it applies to, and ruled off
           from the day before */
        .jday { padding: 8px 16px 0; border-top: 1px solid var(--divider-color); }
        .jday:first-child, .jsec + .jday { border-top: none; }
        .jday + .row { border-top: none; }
        /* a direct change: no walk to draw, a thin rail across the wait */
        .jnode.walk.direct::before { border-left: 2px solid var(--divider-color); }
        /* the picked line in the section head, which is also how to drop it */
        .mini-badge.filter { gap: 3px; height: 18px; padding: 0 5px; cursor: pointer; }
        .mini-badge.filter .x { font-weight: 400; opacity: .85; }
        .mini-badge.filter:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .jtl { display: grid; grid-template-columns: auto 18px minmax(0, 1fr) auto; column-gap: 8px; font-size: 13px; line-height: 22px; color: var(--primary-text-color); }
        .jl { display: flex; align-items: center; justify-content: flex-end; }
        .jnode { position: relative; display: flex; align-items: center; justify-content: center; }
        .jnode::before { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 4px; margin-left: -2px; background: var(--lc); }
        .jnode.first::before { top: 50%; }
        .jnode.last::before { bottom: 50%; }
        .jnode.first.last::before { display: none; }
        .jnode.walk::before { width: 0; margin-left: -1px; background: none; border-left: 2px dotted var(--secondary-text-color); }
        /* the disc of a point: ringed in its leg's colour on the card's own
           ground, the number in the text colour - legible on any line
           colour, which a number on the station colour was not */
        .jnum { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; box-sizing: border-box; border-radius: 50%; border: 2px solid var(--lc); background: var(--card-background-color, #fff); color: var(--primary-text-color); font-size: 11px; font-weight: 700; line-height: 1; flex: none; }
        .jname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .jclock { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
        .jclock b { font-weight: 700; }
        .jnote { font-size: 11px; color: var(--secondary-text-color); padding: 2px 16px 8px; }
        .jmuted, .jbroken { font-size: 12px; white-space: nowrap; }
        .jmuted { color: var(--secondary-text-color); }
        /* status colours pulled a quarter towards the text colour: darker on
           a light card, lighter on a dark one, AA on both (the plain colour
           first, for a browser without color-mix) */
        .jbroken { color: var(--gtfs2-late-color, #e65100); color: color-mix(in srgb, var(--gtfs2-late-color, #e65100) 75%, var(--primary-text-color, #212121)); }
        .rt-icon { color: #4caf50; color: color-mix(in srgb, #4caf50 80%, var(--primary-text-color, #212121)); display: inline-flex; flex: none; }
        .row-mode { display: inline-flex; flex: none; align-self: center; width: 16px; height: 16px; color: var(--secondary-text-color); }
        .row-mode svg { width: 100%; height: 100%; }
        .board td .row-mode { margin-right: 4px; vertical-align: -3px; }
        .sub.strike { text-decoration: line-through; }
        .sub { font-size: 12px; }
        .via-t { white-space: nowrap; }
        .vias .jbroken { font-size: inherit; }
        .sub-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; min-width: 0; }
        /* the merged line reads as a sentence: capital on its first letter,
           whatever the language, without touching the strings used elsewhere */
        .sub-line > .sub:first-child::first-letter { text-transform: uppercase; }
        .dur { white-space: nowrap; }
        .right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: none; }
        .countdown { font-size: 14px; font-weight: 600; color: var(--primary-text-color); }
        .chip { display: inline-flex; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
        .chip-late { background: rgba(230,81,0,.14); color: var(--gtfs2-late-color, #e65100); color: color-mix(in srgb, var(--gtfs2-late-color, #e65100) 75%, var(--primary-text-color, #212121)); }
        .chip-early { background: rgba(3,105,161,.14); color: var(--gtfs2-early-color, #0369a1); color: color-mix(in srgb, var(--gtfs2-early-color, #0369a1) 70%, var(--primary-text-color, #212121)); }
        .chip-ok { background: rgba(46,125,50,.14); color: var(--gtfs2-ontime-color, #2e7d32); color: color-mix(in srgb, var(--gtfs2-ontime-color, #2e7d32) 75%, var(--primary-text-color, #212121)); }
        .chip-theo { background: rgba(127,127,127,.14); color: var(--secondary-text-color); }
        .chip-struck { background: rgba(179,38,30,.14); color: var(--error-color, #b3261e); color: color-mix(in srgb, var(--error-color, #b3261e) 80%, var(--primary-text-color, #212121)); }
        .time.struck, .board .struck { text-decoration: line-through; color: var(--secondary-text-color); }
        .row.struck .dest-inline { color: var(--secondary-text-color); }
        .row-alert { display: inline-flex; flex: none; align-self: center; width: 16px; height: 16px; color: var(--error-color, #b3261e); }
        .row-alert svg { width: 100%; height: 100%; }
        .board td .row-alert { margin-right: 4px; vertical-align: -3px; }
        /* the table layout of the board: numbers right, the sort fixed */
        .board-next { padding: 10px 16px 4px; font-size: 13px; color: var(--secondary-text-color); }
        .board-next b { color: var(--primary-text-color); }
        .board-next .countdown { font-size: 13px; }
        .board-wrap { overflow-x: auto; container-type: inline-size; }
        .board { width: 100%; border-collapse: collapse; font-size: 13px; }
        .board th { text-align: left; font-size: 12px; font-weight: 600; color: var(--secondary-text-color); padding: 8px 12px 6px; }
        .board td { padding: 7px 12px; border-top: 1px solid var(--divider-color); white-space: nowrap; }
        /* narrow, every column hugs its content (width 1% + nowrap is the
           shrink-to-fit idiom) and the last one - the destination, or an
           empty cell - takes what is left. Wide, the columns share the
           card's width in proportion to what they hold: hugged, they sat
           in a clump on the left of a half-empty card */
        .board .fit { width: 1%; }
        @container (min-width: 560px) {
            /* spread, a column right-aligned leaves its time far from
               the one before it: every column reads from its left edge,
               and the departure hugs its time so the delay stays against it */
            .board:not(.jboard) .fit:not(.dep) { width: auto; }
            .board:not(.jboard) .num { text-align: left; }
        }
        .board th:first-child, .board td:first-child { padding-left: 16px; }
        .board th:last-child, .board td:last-child { padding-right: 16px; }
        .board .num { text-align: right; }
        /* a day said once, on a row of its own */
        .board tr.day-sep td { padding: 8px 12px 2px; border-top: none; }
        /* the delay follows the time it moves */
        .board .dly { font-size: 11px; font-weight: 600; }
        .board .dly-c { padding-left: 0; }
        .board .dest { display: inline-block; max-width: 12em; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; }
        .board td.dep { font-weight: 700; }
        .board td .rt-icon { margin-right: 4px; }
        .board .dur-ok { color: var(--gtfs2-ontime-color, #2e7d32); color: color-mix(in srgb, var(--gtfs2-ontime-color, #2e7d32) 75%, var(--primary-text-color, #212121)); }
        .board .st-late { color: var(--gtfs2-late-color, #e65100); color: color-mix(in srgb, var(--gtfs2-late-color, #e65100) 75%, var(--primary-text-color, #212121)); }
        .board .st-early { color: var(--gtfs2-early-color, #0369a1); color: color-mix(in srgb, var(--gtfs2-early-color, #0369a1) 70%, var(--primary-text-color, #212121)); }
        /* the journey timetable: the lines over their columns, the
           departure column kept in place when a long journey scrolls */
        .jboard td { font-variant-numeric: tabular-nums; }
        .jboard .stick { position: sticky; left: 0; z-index: 1; background: var(--card-background-color, #fff); }
        .jboard tr.legs th { padding-bottom: 3px; }
        .jboard th.leg { border-bottom: 2px solid var(--lc); }
        .jboard th, .jboard td { padding-left: 6px; padding-right: 6px; }
        /* a stop's head: its disc over its name, the name wrapping on two
           or three lines rather than widening the column */
        .jboard th .jnum { display: flex; width: 16px; height: 16px; font-size: 10px; margin-bottom: 3px; }
        .jboard .jcn { display: block; max-width: 6.5em; white-space: normal; font-size: 11px; line-height: 1.25; }
        /* the discs of a row of stop heads on one line, whatever the lines
           of their names; a wide card lets the names breathe */
        .jboard thead th { vertical-align: bottom; }
        @container (min-width: 560px) {
            .jboard .jcn { max-width: 10em; }
        }
        .jboard td.jw { color: var(--secondary-text-color); font-size: 12px; }
        /* A board in a sections column has no width to spare, and a single
           arrival crossing midnight is enough to spend it: that row alone
           carries a "tomorrow" chip, every column is sized on its widest
           cell, and the line badge ends up behind a scrollbar. Narrow, the
           padding gives its slack back to the columns rather than to the
           reader's mouse. Wide, nothing changes. */
        @container (max-width: 480px) {
            .board th { padding-left: 8px; padding-right: 8px; }
            .board td { padding-left: 8px; padding-right: 8px; }
            .board th:first-child, .board td:first-child { padding-left: 12px; }
            .board th:last-child, .board td:last-child { padding-right: 12px; }
            /* no sideways scrolling on a phone: the words give way - the
               destination and the stops on the way wrap, the times never.
               They wrap on their spaces, and a word too long for the column
               breaks inside itself; overflow-wrap: anywhere broke every word
               letter by letter, and - a letter being all the column then had
               to be - squeezed the stops on the way into a ribbon one
               character wide. Those stops are the only prose of the board,
               so narrow they stop hugging their content and take the room
               the times leave instead. */
            .board:not(.jboard) td:last-child { white-space: normal; overflow-wrap: break-word; }
            .board:not(.jboard) th.vias, .board:not(.jboard) td.vias { width: auto; white-space: normal; overflow-wrap: break-word; }
            .board:not(.jboard) td.vias .via-t { white-space: normal; }
            .board:not(.jboard) td.dly-c { padding-right: 4px; }
        }
        .info-strip { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--divider-color); }
        .info-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 8px; font-size: 11px; background: rgba(127,127,127,.12); color: var(--secondary-text-color); }
        .info-chip svg { flex: none; }
        .info-alert { background: rgba(230,81,0,.12); color: var(--gtfs2-late-color, #e65100); color: color-mix(in srgb, var(--gtfs2-late-color, #e65100) 75%, var(--primary-text-color, #212121)); }
        .empty { padding: 14px 16px; font-size: 13px; color: var(--secondary-text-color); }
        /* the resting note is written for a tooltip, where it follows the
           destination in lower case; standing alone on the board it is a
           sentence and starts like one */
        .empty.rest::first-letter { text-transform: uppercase; }
        .empty code { font-size: 12px; }
        .map-body { border-top: 0; container-type: inline-size; }
        .map-wrap { position: relative; background: var(--gtfs2-map-background, rgba(127,127,127,.1)); user-select: none; }
        /* the base map canvas fills the frame under the SVG, which keeps
           every pointer: MapLibre is not interactive, the card's gestures are */
        .map-gl { position: absolute; inset: 0; }
        .map-gl canvas { outline: none; }
        .map-wrap svg { position: relative; display: block; width: 100%; aspect-ratio: 2 / 1; touch-action: pan-y; cursor: grab; }
        .map-wrap svg:active { cursor: grabbing; }
        @container (max-width: 380px) { .map-wrap svg { aspect-ratio: 4 / 3; } }
        .bus { cursor: pointer; transition: transform .7s ease-out; }
        .bus .hd { transition: transform .7s ease-out; transform-origin: 0 0; }
        .bus.dim { opacity: 0.35; }
        .bus:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .stop { cursor: pointer; }
        .stop .dot { transition: transform .12s; transform-box: fill-box; transform-origin: center; }
        .stop:hover .dot { transform: scale(1.35); }
        .map-tip { position: absolute; transform: translate(-50%, -100%); pointer-events: none; display: flex; align-items: center; gap: 6px; background: var(--card-background-color, #fff); color: var(--primary-text-color); font-size: 11px; padding: 3px 8px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.3); white-space: nowrap; }
        .tip-links { display: inline-flex; gap: 3px; }
        .tip-note { color: var(--secondary-text-color); }
        /* the alert's own sentence: a full sentence, so the tooltip stops
           being one line and wraps like a note */
        .tip-alert { color: var(--gtfs2-late-color, #e65100); color: color-mix(in srgb, var(--gtfs2-late-color, #e65100) 75%, var(--primary-text-color, #212121)); white-space: normal; max-width: 16em; }
        /* a class, not :has(.tip-alert): the tip measures itself the moment
           it opens, to know whether it fits over the stop, and Chrome had
           not applied the :has() rule by then - it read the height of a tip
           as wide as its words, then drew the wrapped one, taller, over the
           board above */
        .map-tip.tip-wrap { white-space: normal; max-width: 19em; align-items: flex-start; }
        /* under the stop when there is no room over it */
        .map-tip.below { transform: translate(-50%, 0); }
        /* the class sets display, which beats the browser's own rule for
           [hidden]: without this the tip never closed, since closing it is
           setting that attribute. It also gives the height read at the next
           opening a layout of its own, instead of the one left behind */
        .map-tip[hidden] { display: none; }
        .map-btn { position: absolute; top: 8px; left: 8px; border: none; border-radius: 12px; min-height: 36px; padding: 7px 12px; font-size: 12px; font-weight: 500; font-family: inherit; background: var(--card-background-color, #fff); color: var(--primary-text-color); cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
        .map-ctrl { position: absolute; top: 8px; right: 8px; display: flex; flex-direction: column; gap: 6px; }
        .map-ctrl-btn { width: 36px; height: 36px; border: none; border-radius: 9px; background: var(--card-background-color, #fff); color: var(--primary-text-color); font-size: 18px; font-weight: 600; font-family: inherit; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.2); display: flex; align-items: center; justify-content: center; padding: 0; }
        .map-foot { position: absolute; left: 8px; right: 8px; bottom: 6px; display: flex; flex-wrap: wrap;
            align-items: flex-end; justify-content: space-between; gap: 4px 8px; pointer-events: none; }
        .map-scale { display: flex; align-items: center; gap: 5px; font-size: 9px; color: var(--secondary-text-color); background: color-mix(in srgb, var(--card-background-color, #fff) 75%, transparent); padding: 1px 5px; border-radius: 6px; pointer-events: none; }
        .map-scale i { display: block; height: 4px; border: 1px solid currentColor; border-top: none; box-sizing: border-box; }
        .map-attrib { margin-left: auto; font-size: 9px; color: var(--secondary-text-color); background: color-mix(in srgb, var(--card-background-color, #fff) 75%, transparent); padding: 1px 5px; border-radius: 6px; }
        .map-hint { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,.65); color: #fff; font-size: 12px; padding: 6px 12px; border-radius: 14px; pointer-events: none; opacity: 0; transition: opacity .25s; white-space: nowrap; }
        .map-hint.show { opacity: 1; }
        @media (prefers-reduced-motion: reduce) { .live-dot::after { animation: none; opacity: 0; } .stop .dot, .map-hint, .bus, .bus .hd { transition: none; } }
        .map-pop { position: absolute; transform: translate(-50%, -100%); min-width: 150px; max-width: min(230px, calc(100% - 16px)); background: var(--card-background-color, #fff); color: var(--primary-text-color); border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,.35); padding: 8px 10px; font-size: 12px; }
        .pop-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 13px; }
        .pop-dest { color: var(--primary-text-color); font-weight: 500; line-height: 1.5; }
        .pop-row { color: var(--secondary-text-color); line-height: 1.5; }
        .pop-row::first-letter { text-transform: uppercase; }
        .pop-close { border: none; background: none; color: var(--secondary-text-color); cursor: pointer; font-size: 13px; font-family: inherit; min-width: 32px; min-height: 32px; padding: 0; margin: -6px -8px -6px 0; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; }
        .pop-close:hover { background: rgba(127,127,127,.15); }
        .footer { display: flex; align-items: center; justify-content: space-between; padding: 8px 16px 10px 16px; border-top: 1px solid var(--divider-color); font-size: 11px; color: var(--secondary-text-color); }
        `;
    }
}

customElements.define("gtfs2-live-card", Gtfs2LiveCard);

/* ── VISUAL EDITOR ──────────────────────────────────────────────────────── */

class Gtfs2LiveCardEditor extends HTMLElement {
    setConfig(config) {
        this._config = { ...(config || {}) };
        // the lines the way the card reads them, each one sensor and its line
        // settings. Written back as one lines list only once touched; a card
        // of one sensor in the top-level form is folded into the list at the
        // first change
        this._jrn = cardEntries(this._config).map((e) => ({ legs: e.legs.map((l) => ({ entity: l.entity || undefined, ...l.over })) }));
        this._jDirty = !Array.isArray(this._config.lines) && !!(this._config.entity || this._config.positions_url);
        // the places as rows, name and stops. What the editor wrote itself
        // comes back here: the rows are kept then, a place still being
        // typed in with them
        const pl = this._config.places;
        if (JSON.stringify(pl ?? null) !== this._placesOut) {
            this._places = pl && typeof pl === "object" && !Array.isArray(pl)
                ? Object.entries(pl).map(([name, stops]) => ({ name, stops: (Array.isArray(stops) ? stops : [stops]).map(String) }))
                : [];
            this._placesOut = JSON.stringify(pl ?? null);
        }
        // the trips as rows, the same way
        const tr0 = this._config.trips;
        if (JSON.stringify(tr0 ?? null) !== this._tripsOut) {
            this._trips = tripsOf(this._config).map((t) => ({ from: t.from, to: t.to, name: t.name, destination_color: t.destColor }));
            this._tripsOut = JSON.stringify(tr0 ?? null);
        }
        this._render();
    }

    // HA hands the editor a new hass on every state change of the whole
    // house, several a second. Redrawing on each one re-rendered every
    // form, every leg's sensor picker searching the entity registry, and
    // the dialog - its YAML toggle included - waited behind them. Only what
    // the editor shows is watched: the language, the registry, which trip
    // sensors exist. Not their updates: a card of twenty sensors had one
    // every few seconds, and nothing the editor shows moves with them
    set hass(hass) {
        const sig = this._hassSig(hass);
        this._hass = hass;
        if (sig === this._lastHassSig) return;
        this._lastHassSig = sig;
        this._render();
    }

    _hassSig(hass) {
        const st = hass?.states || {};
        const ids = Object.keys(st).filter((id) => isTripSensor(id, st[id]));
        return [resolveLang(hass), Object.keys(hass?.entities || {}).length, ...ids.sort()].join("|");
    }

    // the sensors the pickers offer: gtfs2's trips alone, not its stop or
    // realtime sensors - and those the card already names, known or not, so
    // a picked one never vanishes from its own field
    _tripEntities() {
        const st = this._hass?.states || {};
        return [...new Set([...Object.keys(st).filter((id) => isTripSensor(id, st[id])), ...this._allEntities()])];
    }

    // The settings in blocks, in the order a card is read: the whole card
    // (its title, its badges), then the lines and journeys
    // and their places, then each pane, its switch first and its options
    // after it, shown only while the pane is: an option of a hidden pane
    // changes nothing on the card. Each block carries its own fields
    _formSchema(id, L) {
        const c = this._config;
        if (id === "gen") return [
            { name: "title", selector: { text: {} } },
            { name: "mode_icons", selector: { boolean: {} } },
        ];
        if (id === "dep") return [
            { name: "show_departures", selector: { boolean: {} } },
            ...(c.show_departures === false ? [] : [
                { name: "max_departures", selector: { number: { min: 1, max: 20, mode: "box" } } },
                { name: "show_duration", selector: { boolean: {} } },
                { name: "max_transfer_wait", selector: { number: { min: 5, mode: "box", unit_of_measurement: "min" } } },
                ...(this._trips?.length ? [{ name: "max_changes", selector: { number: { min: 0, max: 8, mode: "box" } } }] : []),
            ]),
        ];
        return [
            { name: "show_map", selector: { boolean: {} } },
            ...(c.show_map === false ? [] : [
                { name: "map_style", selector: { select: { mode: "dropdown", custom_value: true, options: [
                    { value: "auto", label: "auto" }, { value: "light", label: "light" }, { value: "dark", label: "dark" }] } } },
                { name: "map_aspect", selector: { text: {} } },
                { name: "station_color", selector: { text: {} } },
                { name: "refresh", selector: { number: { min: 15, max: 600, mode: "box", unit_of_measurement: "s" } } },
                { name: "latitude", selector: { text: {} } },
                { name: "longitude", selector: { text: {} } },
            ]),
        ];
    }

    // what each block's fields read from the config, defaults filled in
    _formData(id) {
        const c = this._config;
        if (id === "gen") return {
            title: c.title ?? "",
            mode_icons: c.mode_icons !== false,
        };
        if (id === "dep") return {
            show_departures: c.show_departures !== false,
            max_departures: c.max_departures ?? DEFAULTS.max_departures,
            show_duration: c.show_duration === true,
            max_transfer_wait: c.max_transfer_wait ?? DEFAULTS.max_transfer_wait,
            ...(this._trips?.length ? { max_changes: c.max_changes ?? DEFAULTS.max_changes } : {}),
        };
        return {
            show_map: c.show_map !== false,
            map_style: c.map_style ?? "auto",
            map_aspect: c.map_aspect ?? "",
            station_color: c.station_color ?? "",
            refresh: c.refresh ?? DEFAULTS.refresh,
            latitude: c.latitude != null ? String(c.latitude) : "",
            longitude: c.longitude != null ? String(c.longitude) : "",
        };
    }

    _lineSchema() {
        return [
            { name: "line", selector: { text: {} } },
            { name: "color", selector: { text: {} } },
            { name: "positions_url", selector: { text: {} } },
            { name: "route_url", selector: { text: {} } },
        ];
    }

    // what the card actually derived for one entity, shown so the user can
    // see why a field can be left empty
    _derivedText(entity, lang) {
        const at = this._hass?.states?.[entity]?.attributes || {};
        const bits = [];
        const short = attrVal(at, "route_route_short_name", "route_short_name");
        if (short) bits.push(String(short));
        const type = attrVal(at, "route_route_type", "route_type");
        if (type != null) bits.push(modeWord(lang, modeKey(type), false));
        const color = attrVal(at, "route_route_color", "route_color");
        if (color) bits.push(String(color).startsWith("#") ? String(color) : "#" + color);
        return bits.join(" · ");
    }

    // a labelled <details> block, reused for every collapsible section
    _section(label) {
        const d = document.createElement("details");
        d.style.cssText = "margin-top: 12px; border: 1px solid var(--divider-color); border-radius: 10px; padding: 8px 12px;";
        const sum = document.createElement("summary");
        sum.textContent = label;
        sum.style.cssText = "cursor: pointer; font-weight: 500; color: var(--primary-text-color); padding: 4px 0;";
        d.appendChild(sum);
        return d;
    }

    _render() {
        if (!this._hass || !this._config) return;
        const lang = resolveLang(this._hass);
        // like the card: nothing is drawn until the strings are in, or the
        // form would come up labelled with its own field names
        if (!LANG[lang]) { LANG_WAITING.add(this); loadLang(lang); return; }
        if (!this._built) {
            this.innerHTML = "";
            // one block of fields, its form writing through _globalChanged
            this._forms = {};
            const block = (id, open) => {
                const sec = this._section("");
                sec.open = open;
                const form = document.createElement("ha-form");
                form.addEventListener("value-changed", (ev) => this._globalChanged(ev));
                sec.appendChild(form);
                this._forms[id] = { sec, form, data: null, schema: null };
                return sec;
            };
            // the whole card first: its title is the first thing it shows
            this.appendChild(block("gen", true));

            // the lines and journeys, the card's content: open from the start
            this._jSec = this._section("");
            this._jSec.open = true;
            this._jBox = document.createElement("div");
            this._jSec.appendChild(this._jBox);
            this.appendChild(this._jSec);

            // the trips, where the card goes: open from the start too
            this._tSec = this._section("");
            this._tSec.open = true;
            this._tBox = document.createElement("div");
            this._tSec.appendChild(this._tBox);
            this.appendChild(this._tSec);

            // the places: open when the card has some
            this._pSec = this._section("");
            this._pSec.open = !!this._places.length;
            this._pBox = document.createElement("div");
            this._pSec.appendChild(this._pBox);
            this.appendChild(this._pSec);

            // then the two panes, in the order the card stacks them
            this.appendChild(block("dep", false));
            this.appendChild(block("map", false));

            this._built = true;
            this._jKey = null;
            this._tKey = null;
        }
        const L = editorLabels(lang);
        this._jSec.querySelector("summary").textContent = L.sec_journey;
        this._pSec.querySelector("summary").textContent = L.sec_places;
        this._tSec.querySelector("summary").textContent = L.sec_trips;
        const titles = { gen: L.sec_general, dep: L.sec_departures, map: L.sec_map };
        for (const [id, f] of Object.entries(this._forms)) {
            f.sec.querySelector("summary").textContent = titles[id];
            f.form.hass = this._hass;
            f.form.computeLabel = (x) => L[x.name] ?? x.name;
            // schema and data pushed only when they changed: reassigning
            // them re-renders ha-form, and can steal the caret while typing
            const schema = this._formSchema(id, L);
            const sjson = JSON.stringify(schema);
            if (sjson !== f.schema) { f.schema = sjson; f.form.schema = schema; }
            const data = this._formData(id);
            const djson = JSON.stringify(data);
            if (djson !== f.data) { f.data = djson; f.form.data = data; }
        }
        if (this._journeyKey() !== this._jKey) this._buildJourney();
        else (this._jForms || []).forEach((f) => { f.hass = this._hass; });
        if (this._tripsKey() !== this._tKey) this._buildTrips();
        else (this._tForms || []).forEach((f) => { f.hass = this._hass; });
        if (this._placesKey() !== this._pKey) this._buildPlaces();
        else (this._pForms || []).forEach((f) => { f.hass = this._hass; });
    }

    // the stops a place can group: where the card's sensors start and end,
    // where its journeys are boarded, left or cut at - the names the
    // Departure and Arrival header lists - and those already grouped
    _placeStops() {
        const st = this._hass?.states || {};
        const out = new Set();
        const add = (v) => { if (v != null && String(v).trim()) out.add(String(v).trim()); };
        for (const l of this._legs) {
            const at = st[l.entity]?.attributes || {};
            add(at.origin_station_stop_name);
            add(at.destination_station_stop_name);
        }
        for (const p of this._places) p.stops.forEach(add);
        for (const t of this._trips || []) { add(t.from); add(t.to); }
        return [...out].sort((a, b) => a.localeCompare(b));
    }

    // what the places section is drawn from: its rows and the stops offered,
    // not the names typed in
    _placesKey() {
        return `${this._places.length}#${this._placeStops().join("|")}`;
    }

    // The places section: one box per place, its name and the stops it
    // groups, a button to take it out, one to add a place. A stop the
    // offered list does not carry can be typed in
    _buildPlaces() {
        if (!this._pBox) return;
        const L = editorLabels(resolveLang(this._hass));
        const box = this._pBox;
        box.innerHTML = "";
        this._pForms = [];
        const hint = document.createElement("div");
        hint.style.cssText = "color: var(--secondary-text-color); font-size: 12px; padding: 4px 0 2px;";
        hint.textContent = L.p_hint;
        box.appendChild(hint);
        const opts = this._placeStops().map((n) => ({ value: n, label: n }));
        const button = (text, label, onClick) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = text;
            b.title = label;
            b.setAttribute("aria-label", label);
            b.style.cssText = "min-width: 32px; min-height: 32px; padding: 0 10px; border-radius: 8px;"
                + " border: 1px solid var(--divider-color); background: none; color: var(--primary-text-color);"
                + " font: inherit; font-size: 13px; cursor: pointer;";
            // inside a place's summary the click would also open or close it
            b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); onClick(); });
            return b;
        };
        // like the entries: a place is one line until it is opened, its
        // fields built then, and a short list opens them all. Which ones
        // are open survives a place added or taken out
        if (!this._pOpen) this._pOpen = new Set(this._places.length <= 3 ? this._places.keys() : []);
        const cut = " overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
        this._places.forEach((p, i) => {
            const card = document.createElement("details");
            card.style.cssText = "border: 1px solid var(--divider-color); border-radius: 10px; padding: 10px 12px; margin-top: 10px;";
            const sum = document.createElement("summary");
            sum.style.cssText = "cursor: pointer; list-style-position: inside;";
            const head = document.createElement("div");
            head.style.cssText = "display: inline-flex; align-items: center; gap: 6px; width: calc(100% - 20px); vertical-align: middle;";
            const t = document.createElement("div");
            t.style.cssText = "flex: 1; min-width: 0; font-weight: 500; color: var(--primary-text-color);";
            const title = document.createElement("div");
            title.style.cssText = cut;
            const sub = document.createElement("div");
            sub.style.cssText = "font-weight: 400; font-size: 12px; color: var(--secondary-text-color); margin-top: 2px;" + cut;
            t.append(title, sub);
            // the folded line: the place's name, then the stops it groups
            const summarize = (row) => {
                title.textContent = title.title = row.name || L.sec_places;
                sub.textContent = sub.title = row.stops.join(", ");
                sub.hidden = !row.stops.length;
            };
            summarize(p);
            head.append(t, button("✕", L.p_remove, () => {
                this._places.splice(i, 1);
                this._pOpen = new Set([...this._pOpen].filter((x) => x !== i).map((x) => (x > i ? x - 1 : x)));
                this._placesChanged();
                this._buildPlaces();
            }));
            sum.appendChild(head);
            card.appendChild(sum);
            let built = false;
            const build = () => {
                if (built) return;
                built = true;
                this._placeBody(card, i, p, opts, L, summarize);
            };
            card.open = this._pOpen.has(i);
            if (card.open) build();
            card.addEventListener("toggle", () => {
                if (card.open) { this._pOpen.add(i); build(); } else this._pOpen.delete(i);
            });
            box.appendChild(card);
        });
        const add = button(`+ ${L.p_add}`, L.p_add, () => {
            this._places.push({ name: "", stops: [] });
            this._pOpen.add(this._places.length - 1);
            this._pSec.open = true;
            this._buildPlaces();
        });
        add.style.marginTop = "10px";
        box.appendChild(add);
        this._pKey = this._placesKey();
    }

    // a place's fields, built when it is opened: its name and its stops
    _placeBody(card, i, p, opts, L, summarize) {
        const form = document.createElement("ha-form");
        form.hass = this._hass;
        form.schema = [
            { name: "name", selector: { text: {} } },
            { name: "stops", selector: { select: { mode: "dropdown", multiple: true, custom_value: true, options: opts } } },
        ];
        form.computeLabel = (f) => (f.name === "name" ? L.p_name : L.p_stops);
        form.data = { name: p.name || "", stops: p.stops };
        form.addEventListener("value-changed", (ev) => {
            ev.stopPropagation();
            const row = this._places[i];
            if (!row) return;
            const v = ev.detail.value || {};
            row.name = String(v.name ?? "").trim();
            row.stops = (Array.isArray(v.stops) ? v.stops : []).map(String).filter(Boolean);
            summarize(row);
            this._placesChanged();
        });
        this._pForms.push(form);
        card.appendChild(form);
    }

    // The trips section: one box per trip, folded to where it goes and how
    // many ways the card finds for it, its fields - from, to, and like any
    // entry a name and a destination colour - built when it is opened. A
    // short list opens them all; which ones are open survives a trip added
    // or taken out
    _tripsKey() {
        return `${(this._trips || []).length}#${this._tripPlaces().join("|")}`;
    }

    // the places a trip can go from or to: the places the card names, then
    // every stop its lines call at, each once and under its place's name
    _tripPlaces() {
        const placeOf = placeResolver(this._config.places);
        const out = new Map();
        const add = (n) => {
            if (n == null || !String(n).trim()) return;
            const p = placeOf(String(n).trim());
            if (p.key && !out.has(p.key)) out.set(p.key, String(p.name));
        };
        for (const p of this._places) add(p.name);
        for (const r of this._editorRides()) r.stops.forEach((st) => add(st.name));
        for (const t of this._trips || []) { add(t.from); add(t.to); }
        return [...out.values()].sort((a, b) => a.localeCompare(b));
    }

    // the card's sensors as the card searches trips on them (see
    // _tripRides): the stops of each line between the sensor's two ends, as
    // the route shape lists them, with where the line takes nobody on or
    // sets nobody down; its two ends alone while the list is not in
    _editorRides() {
        const st = this._hass?.states || {};
        const placeOf = placeResolver(this._config.places);
        const out = [];
        for (const e of this._allEntities()) {
            const at = st[e]?.attributes || {};
            const names = this._stopsOf(e) || [];
            const lc = (v) => String(v || "").trim().toLowerCase();
            const o = names.findIndex((n) => lc(n) === lc(at.origin_station_stop_name));
            const d = names.findIndex((n, i) => i > o && lc(n) === lc(at.destination_station_stop_name));
            const rules = this._stopRules?.get(e);
            const stop = (n) => ({ name: n, key: n ? placeOf(n).key : "",
                board: !rules?.noBoard?.has(lc(n)), alight: !rules?.noAlight?.has(lc(n)) });
            const stops = o >= 0 && d > o ? names.slice(o, d + 1).map(stop)
                : [stop(at.origin_station_stop_name), stop(at.destination_station_stop_name)];
            if (stops.length >= 2 && stops[0].key && stops[stops.length - 1].key) out.push({ entity: e, stops });
        }
        return out;
    }

    _buildTrips() {
        if (!this._tBox) return;
        const lang = resolveLang(this._hass);
        const L = editorLabels(lang);
        const box = this._tBox;
        box.innerHTML = "";
        this._tForms = [];
        const hint = document.createElement("div");
        hint.style.cssText = "color: var(--secondary-text-color); font-size: 12px; padding: 4px 0 2px;";
        hint.textContent = L.t_hint;
        box.appendChild(hint);
        const button = (text, label, onClick) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = text;
            b.title = label;
            b.setAttribute("aria-label", label);
            b.style.cssText = "min-width: 32px; min-height: 32px; padding: 0 10px; border-radius: 8px;"
                + " border: 1px solid var(--divider-color); background: none; color: var(--primary-text-color);"
                + " font: inherit; font-size: 13px; cursor: pointer;";
            b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); onClick(); });
            return b;
        };
        const trips = this._trips || (this._trips = []);
        if (!this._tOpen) this._tOpen = new Set(trips.length <= 3 ? trips.keys() : []);
        const opts = this._tripPlaces().map((n) => ({ value: n, label: n }));
        const cut = " overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
        trips.forEach((t, i) => {
            const card = document.createElement("details");
            card.dataset.trip = i;
            card.style.cssText = "border: 1px solid var(--divider-color); border-radius: 10px; padding: 10px 12px; margin-top: 10px;";
            const sum = document.createElement("summary");
            sum.style.cssText = "cursor: pointer; list-style-position: inside;";
            const head = document.createElement("div");
            head.style.cssText = "display: inline-flex; align-items: center; gap: 6px; width: calc(100% - 20px); vertical-align: middle;";
            const txt = document.createElement("div");
            txt.style.cssText = "flex: 1; min-width: 0; font-weight: 500; color: var(--primary-text-color);";
            const title = document.createElement("div");
            title.style.cssText = cut;
            const sub = document.createElement("div");
            sub.style.cssText = "font-weight: 400; font-size: 12px; color: var(--secondary-text-color); margin-top: 2px;" + cut;
            txt.append(title, sub);
            head.append(txt, button("✕", L.t_remove, () => {
                trips.splice(i, 1);
                this._tOpen = new Set([...this._tOpen].filter((x) => x !== i).map((x) => (x > i ? x - 1 : x)));
                this._tripsChanged();
                this._buildTrips();
            }));
            sum.appendChild(head);
            card.appendChild(sum);
            this._summarizeTrip(card, t, L);
            let built = false;
            const build = () => {
                if (built) return;
                built = true;
                const form = document.createElement("ha-form");
                form.hass = this._hass;
                form.schema = [
                    { name: "from", selector: { select: { mode: "dropdown", custom_value: true, options: opts } } },
                    { name: "to", selector: { select: { mode: "dropdown", custom_value: true, options: opts } } },
                    { name: "name", selector: { text: {} } },
                    { name: "destination_color", selector: { text: {} } },
                ];
                form.computeLabel = (sc) => ({ from: L.t_from, to: L.t_to, destination_color: L.j_dest_color })[sc.name] || L.j_name;
                form.data = { from: t.from || "", to: t.to || "", name: t.name || "", destination_color: t.destination_color || "" };
                form.addEventListener("value-changed", (ev) => {
                    ev.stopPropagation();
                    const row = this._trips[i];
                    if (!row) return;
                    const v = ev.detail.value || {};
                    const txt1 = (x) => (x == null || String(x).trim() === "" ? null : String(x).trim());
                    row.from = txt1(v.from);
                    row.to = txt1(v.to);
                    row.name = txt1(v.name);
                    row.destination_color = txt1(v.destination_color);
                    this._summarizeTrip(card, row, L);
                    this._tripsChanged();
                });
                this._tForms.push(form);
                card.appendChild(form);
            };
            card.open = this._tOpen.has(i);
            if (card.open) build();
            card.addEventListener("toggle", () => {
                if (card.open) { this._tOpen.add(i); build(); } else this._tOpen.delete(i);
            });
            box.appendChild(card);
        });
        const add = button(`+ ${L.t_add}`, L.t_add, () => {
            trips.push({ from: null, to: null, name: null, destination_color: null });
            this._tOpen.add(trips.length - 1);
            this._tSec.open = true;
            this._buildTrips();
        });
        add.style.marginTop = "10px";
        box.appendChild(add);
        this._tKey = this._tripsKey();
    }

    // a trip folded to where it goes, then how many ways the card finds for
    // it, both directions, or in red that it finds none
    _summarizeTrip(card, t, L) {
        const [title, sub] = card.querySelector("summary > div > div").children;
        title.textContent = title.title = [t.name, t.from && t.to ? `${t.from} → ${t.to}` : t.from || t.to].filter(Boolean).join(" · ") || L.t_add;
        let text = "", bad = false;
        if (t.from && t.to) {
            const max = Number.isFinite(Number(this._config.max_changes)) ? Number(this._config.max_changes) : MAX_CHANGES;
            const n = planTrips([{ from: t.from, to: t.to }], this._editorRides(), placeResolver(this._config.places), max).length;
            text = n === 1 ? L.t_way : n ? L.t_ways.replace("{n}", n) : L.t_none;
            bad = !n;
        }
        sub.textContent = sub.title = text;
        sub.hidden = !text;
        sub.style.color = bad ? "var(--error-color, #b3261e)" : "";
    }

    // the trips' folded lines, after a line changed under them
    _resummarizeTrips() {
        const L = editorLabels(resolveLang(this._hass));
        (this._trips || []).forEach((t, i) => {
            const card = this._tBox?.querySelector(`details[data-trip="${i}"]`);
            if (card) this._summarizeTrip(card, t, L);
        });
    }

    // the trips written back: those with both ends, as [from, to] when
    // that is all they say; none left takes the key out
    _tripsChanged() {
        const out = [];
        for (const t of this._trips || []) {
            if (!t.from || !t.to) continue;
            out.push(t.name || t.destination_color
                ? { from: t.from, to: t.to, ...(t.name ? { name: t.name } : {}), ...(t.destination_color ? { destination_color: t.destination_color } : {}) }
                : [t.from, t.to]);
        }
        if (out.length) this._config.trips = out;
        else delete this._config.trips;
        this._tripsOut = JSON.stringify(this._config.trips ?? null);
        this._emit();
    }

    // the places written back: those with a name and a stop, in order; none
    // left takes the key out
    _placesChanged() {
        const out = {};
        for (const p of this._places) if (p.name && p.stops.length) out[p.name] = p.stops;
        if (Object.keys(out).length) this._config.places = out;
        else delete this._config.places;
        this._placesOut = JSON.stringify(this._config.places ?? null);
        this._emit();
    }

    _langArrived(code) {
        if (code !== resolveLang(this._hass)) return;
        LANG_WAITING.delete(this);
        this._render();
    }

    disconnectedCallback() {
        LANG_WAITING.delete(this);
    }

    // a line's settings folded away under the leg that declares it: its
    // badge label, its colour, its files - an empty field reads as derived,
    // and says from what
    _lineSettings(ji, k, lang, L) {
        const leg = this._jrn[ji].legs[k];
        const d = document.createElement("details");
        d.style.cssText = "margin-top: 6px;";
        const sum = document.createElement("summary");
        sum.textContent = L.j_over;
        sum.style.cssText = "cursor: pointer; color: var(--secondary-text-color); font-size: 13px; padding: 2px 0;";
        d.appendChild(sum);
        const derived = leg.entity ? this._derivedText(leg.entity, lang) : "";
        if (derived) {
            const sub = document.createElement("div");
            sub.style.cssText = "color: var(--secondary-text-color); font-size: 12px; margin: 2px 0 6px;";
            sub.textContent = `${L.derived}: ${derived}`;
            d.appendChild(sub);
        }
        const form = document.createElement("ha-form");
        form.hass = this._hass;
        form.schema = this._lineSchema();
        form.computeLabel = (f) => L["l_" + f.name] ?? f.name;
        form.data = { line: leg.line ?? "", color: leg.color ?? "", positions_url: leg.positions_url ?? "", route_url: leg.route_url ?? "" };
        form.addEventListener("value-changed", (ev) => {
            ev.stopPropagation();
            const l = this._jrn[ji]?.legs[k];
            if (!l) return;
            Object.assign(l, ev.detail.value || {});
            this._jDirty = true;
            this._emit();
            // a badge label is the entries' titles
            this._jrn.forEach((_, i) => this._resummarize(i));
        });
        this._jForms.push(form);
        d.appendChild(form);
        return d;
    }

    // every leg of every journey, in riding order: what most of the editor
    // reads, the journeys being only their grouping
    get _legs() {
        return (this._jrn || []).flatMap((j) => j.legs);
    }

    // every sensor of the card, in the order its entries first ride it
    _allEntities() {
        return [...new Set(this._legs.map((l) => l.entity).filter(Boolean))];
    }


    // The stops of a sensor's line in riding order, read from the route
    // shape the card draws: what the via field offers, so a name cannot be
    // mistyped. Null while loading, an empty list when no shape can be had -
    // the field then takes free text.
    _stopsOf(entity) {
        if (!entity) return [];
        const cache = this._stopCache || (this._stopCache = new Map());
        if (cache.has(entity)) return cache.get(entity);
        const over = this._legs.find((l) => l.entity === entity) || {};
        const url = routeUrlOf(this._hass, entity, over);
        if (!url) { cache.set(entity, []); return []; }
        cache.set(entity, null);
        this._stopWait = (this._stopWait || 0) + 1;
        fetchJsonShared(url, 5 * 60000)
            .then((gj) => {
                const names = [];
                // the places the line never takes riders on at, or never
                // sets them down at, on any run: what a gtfs2 that writes
                // boards / alights says, and nothing else. A name the file
                // carries twice (a loop) is shut out only when every point
                // of it is. The drawn run's own pickup_type is not read:
                // another run may board where it does not, and a list
                // filtered on it would shut out a journey that works
                const noBoard = new Set(), noAlight = new Set();
                const pts = (gj?.features || []).filter((f) => f.geometry?.type === "Point")
                    .sort((a, b) => (a.properties?.stop_sequence ?? 0) - (b.properties?.stop_sequence ?? 0));
                for (const f of pts) {
                    const nm = String(f.properties?.stop_name || "").trim();
                    if (!nm) continue;
                    const key = nm.toLowerCase();
                    if (!names.includes(nm)) {
                        names.push(nm);
                        if (f.properties?.boards === false) noBoard.add(key);
                        if (f.properties?.alights === false) noAlight.add(key);
                    } else {
                        if (f.properties?.boards !== false) noBoard.delete(key);
                        if (f.properties?.alights !== false) noAlight.delete(key);
                    }
                }
                (this._stopRules || (this._stopRules = new Map())).set(entity, { noBoard, noAlight });
                cache.set(entity, names);
            })
            .catch(() => cache.set(entity, []))
            // every sensor's list lands on its own, and each one rebuilt the
            // section: it is rebuilt once, when the last one asked for is in
            .finally(() => {
                if (--this._stopWait > 0 || this._jRebuild) return;
                this._jRebuild = requestAnimationFrame(() => {
                    this._jRebuild = null;
                    if (this._built) { this._buildJourney(); this._buildTrips(); }
                });
            });
        return null;
    }


    // what the journeys section is drawn from: the legs' sensors and whether
    // their stop lists are in - not the names, typed in without a redraw
    _journeyKey() {
        const peek = (e) => {
            const v = this._stopCache?.get(e);
            return v === undefined ? "u" : v === null ? "l" : v.length;
        };
        return this._jrn.map((j) => j.legs.map((l) => `${l.entity || ""}:${peek(l.entity)}`).join("|")).join("/") + `#${this._jrn.length}`;
    }

    // The lines section: one box per sensor of the lines list, folded to its
    // line and where it runs; opened, it holds the sensor, and folded away
    // the settings of its line. Buttons reorder and remove the lines and add
    // one. Rebuilt when the sensors or their stop lists change, never while
    // a field is typed in: every handler finds its line by index at the
    // time of the change.
    _buildJourney() {
        if (!this._jBox) return;
        const lang = resolveLang(this._hass);
        const L = editorLabels(lang);
        const box = this._jBox;
        box.innerHTML = "";
        this._jForms = [];
        const note = (text, css) => {
            const d = document.createElement("div");
            d.style.cssText = "color: var(--secondary-text-color); font-size: 12px;" + (css || "");
            d.textContent = text || "";
            return d;
        };
        box.appendChild(note(L.j_hint, " padding: 4px 0 2px;"));
        // a new card opens on a first entry waiting for its sensor: the
        // section is the one way to pick sensors, so it never shows empty.
        // Nothing is written until the sensor is picked (see _emit)
        if (!this._jrn.length) this._jrn.push({ legs: [{}] });
        // A card of forty entries built every field of every one of them -
        // over a hundred forms, seventy sensor pickers - and drew them all
        // again at every click. An entry is one line until it is opened,
        // its fields built then. A short card opens them all
        if (!this._jOpen) this._jOpen = new Set(this._jrn.length <= 3 ? this._jrn.keys() : []);
        const trips = this._tripEntities();
        const button = (text, label, onClick, disabled) => {
            const b = document.createElement("button");
            b.type = "button";
            b.textContent = text;
            b.title = label;
            b.setAttribute("aria-label", label);
            b.disabled = !!disabled;
            b.style.cssText = "min-width: 32px; min-height: 32px; padding: 0 10px; border-radius: 8px;"
                + " border: 1px solid var(--divider-color); background: none; color: var(--primary-text-color);"
                + " font: inherit; font-size: 13px; cursor: pointer;" + (disabled ? " opacity: .35; cursor: default;" : "");
            // inside an entry's summary the click would also open or close it
            b.addEventListener("click", (ev) => { ev.preventDefault(); ev.stopPropagation(); if (!b.disabled) onClick(); });
            return b;
        };
        const headOf = (text, ...buttons) => {
            const h = document.createElement("div");
            h.style.cssText = "display: flex; align-items: center; gap: 6px;";
            const t = document.createElement("div");
            t.style.cssText = "flex: 1; font-weight: 500; color: var(--primary-text-color);";
            t.textContent = text;
            h.append(t, ...buttons);
            return h;
        };
        const frame = (css, tag) => {
            const d = document.createElement(tag || "div");
            d.style.cssText = "border: 1px solid var(--divider-color); border-radius: 10px; padding: 10px 12px;" + css;
            return d;
        };
        const ctx = { lang, L, trips, note };
        this._jrn.forEach((jr, ji) => {
            const card = frame(" margin-top: 10px;", "details");
            const sum = document.createElement("summary");
            sum.style.cssText = "cursor: pointer; list-style-position: inside;";
            const head = headOf("",
                button("↑", L.j_up, () => this._moveJourney(ji, -1), ji === 0),
                button("↓", L.j_down, () => this._moveJourney(ji, 1), ji === this._jrn.length - 1),
                button("✕", L.j_remove_itin, () => this._removeJourney(ji)));
            head.style.display = "inline-flex";
            head.style.width = "calc(100% - 20px)";
            head.style.verticalAlign = "middle";
            // the editor is a narrow column: each line of the fold is cut
            // short with an ellipsis, the whole of it in its tooltip
            const t = head.firstChild;
            const cut = " overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
            t.style.minWidth = "0";
            t.append(document.createElement("div"), document.createElement("div"), document.createElement("div"));
            t.children[0].style.cssText = cut;
            for (const d of [t.children[1], t.children[2]]) d.style.cssText = "font-weight: 400; font-size: 12px; color: var(--secondary-text-color); margin-top: 2px;" + cut;
            card.dataset.entry = ji;
            sum.appendChild(head);
            card.appendChild(sum);
            this._summarize(card, jr, ji, lang, L);
            let built = false;
            const build = () => {
                if (built) return;
                built = true;
                this._journeyBody(card, jr, ji, ctx);
            };
            card.open = this._jOpen.has(ji);
            if (card.open) build();
            card.addEventListener("toggle", () => {
                if (card.open) { this._jOpen.add(ji); build(); } else this._jOpen.delete(ji);
            });
            box.appendChild(card);
        });
        const addJ = button(`+ ${L.j_add_itin}`, L.j_add_itin, () => this._addJourney());
        addJ.style.marginTop = "10px";
        box.appendChild(addJ);
        this._jKey = this._journeyKey();
    }

    // a line folded to its summary: its badge label, then where the sensor
    // runs from and to - first, so a narrow editor cuts nothing that tells
    // two lines apart. Written again when its fields change
    _summarize(card, jr, ji, lang, L) {
        const t = card?.querySelector("summary > div > div");
        if (!t) return;
        const leg = jr.legs[0] || {};
        const at = this._hass?.states?.[leg.entity]?.attributes || {};
        const [head, ends, more] = t.children;
        const say = (el, text) => { el.textContent = el.title = text; el.hidden = !text; };
        say(head, leg.line || attrVal(at, "route_route_short_name", "route_short_name") || at.friendly_name || leg.entity || `${L.itin_n} ${ji + 1}`);
        say(ends, [at.origin_station_stop_name, at.destination_station_stop_name].filter(Boolean).join(" → "));
        say(more, "");
    }

    // the folded line of entry ji, after one of its fields changed
    _resummarize(ji) {
        const card = this._jBox?.querySelector(`details[data-entry="${ji}"]`);
        const jr = this._jrn[ji];
        if (!card || !jr) return;
        const lang = resolveLang(this._hass);
        this._summarize(card, jr, ji, lang, editorLabels(lang));
    }

    // a line's fields, built when it is opened: the sensor, then folded
    // away the settings of its line
    _journeyBody(card, jr, ji, { lang, L, trips, note }) {
        const leg = jr.legs[0];
        const form = document.createElement("ha-form");
        form.hass = this._hass;
        form.schema = [{ name: "entity", selector: { entity: { include_entities: trips, filter: [{ integration: "gtfs2", domain: "sensor" }] } } }];
        form.computeLabel = () => L.j_entity;
        form.data = { entity: leg.entity || "" };
        form.addEventListener("value-changed", (ev) => this._legChanged(ev, ji));
        // an entity_id too long for the picker widens the row inside the
        // picker's own shadow DOM, which we cannot make wrap: clip it here
        // so the dialog stops scrolling sideways
        form.style.cssText = "display: block; overflow: hidden;";
        card.appendChild(form);
        this._jForms.push(form);
        // a sensor Home Assistant no longer has - renamed, or its
        // integration removed - said on its own line, the id wrapped in
        // full: the picker shows the bare id, and the cross takes it out
        if (leg.entity && this._hass && !this._hass.states[leg.entity]) {
            const lost = note("", " margin-top: 4px; color: var(--error-color, #b3261e); word-break: break-all;");
            lost.textContent = L.j_unknown.replace("{e}", leg.entity);
            card.appendChild(lost);
        }
        card.appendChild(this._lineSettings(ji, 0, lang, L));
    }

    _legChanged(ev, ji) {
        ev.stopPropagation();
        const leg = this._jrn[ji]?.legs[0];
        if (!leg) return;
        const entity = ev.detail.value?.entity || null;
        if (entity === (leg.entity || null)) return;
        leg.entity = entity || undefined;
        this._jDirty = true;
        this._emit();
        // another sensor: its summary, its line settings and the trips'
        // ways change with it
        this._render();
        this._resummarizeTrips();
    }



    _moveJourney(ji, d) {
        const j = ji + d;
        if (j < 0 || j >= this._jrn.length) return;
        [this._jrn[ji], this._jrn[j]] = [this._jrn[j], this._jrn[ji]];
        // the entry opened goes where it went
        const o = this._jOpen;
        if (o && o.has(ji) !== o.has(j)) {
            if (o.has(ji)) { o.delete(ji); o.add(j); } else { o.delete(j); o.add(ji); }
        }
        this._journeyEdited();
    }

    _removeJourney(ji) {
        this._jrn.splice(ji, 1);
        this._shiftOpen(ji);
        this._journeyEdited();
    }

    // entry ji gone: those after it move up one, open or folded as they were
    _shiftOpen(ji) {
        if (!this._jOpen) return;
        this._jOpen = new Set([...this._jOpen].filter((i) => i !== ji).map((i) => (i > ji ? i - 1 : i)));
    }

    // a change of shape: written, and the overrides and the section drawn
    // again
    _journeyEdited() {
        this._jDirty = true;
        this._emit();
        this._render();
    }


    // a new line has no sensor yet: nothing to save until one is picked
    _addJourney() {
        this._jrn.push({ legs: [{}] });
        this._jOpen?.add(this._jrn.length - 1);
        this._jSec.open = true;
        this._buildJourney();
    }


    // shared by the three global forms, and each of them only carries its own
    // fields: a key absent from the event must be left alone, not deleted,
    // otherwise editing the title would wipe the map settings
    _globalChanged(ev) {
        ev.stopPropagation();
        const v = ev.detail.value || {};
        const c = this._config;
        const has = (k) => Object.prototype.hasOwnProperty.call(v, k);
        // title: an empty string is meaningful (hidden title line)
        if (has("title")) { if (v.title === undefined) delete c.title; else c.title = v.title; }
        const assign = (key, autoDeletes) => {
            if (!has(key)) return;
            const val = v[key];
            // a form sends all its fields: a default the YAML never named
            // stays unwritten
            if (c[key] === undefined && val === DEFAULTS[key]) return;
            if (val === undefined || val === "" || val === null || (autoDeletes && val === "auto")) delete c[key];
            else c[key] = val;
        };
        assign("max_departures", false);
        assign("max_transfer_wait", false);
        assign("max_changes", false);
        assign("refresh", false);
        assign("map_style", true);
        assign("map_aspect", false);
        assign("station_color", false);
        for (const k of ["latitude", "longitude"]) {
            if (!has(k)) continue;
            const num = Number(v[k]);
            if (v[k] === "" || v[k] == null || !Number.isFinite(num)) delete c[k];
            else c[k] = num;
        }
        // true is the default: written out it would only be noise in the YAML
        for (const k of ["mode_icons", "show_departures", "show_map"]) {
            if (!has(k)) continue;
            if (v[k] === false) c[k] = false; else delete c[k];
        }
        // the mirror case: false is this one's default, only true is worth
        // a line of YAML
        if (has("show_duration")) {
            if (v.show_duration === true) c.show_duration = true; else delete c.show_duration;
        }
        this._emit();
        // a pane switched on or off shows or hides its options
        if (has("show_departures") || has("show_map")) this._render();
    }

    _emit() {
        const config = { ...this._config };
        const keep = (v) => v != null && v !== "" && !(Array.isArray(v) && !v.length);
        if (this._jDirty) {
            // one list, lines:, a sensor each: its bare id, or an object
            // with the settings of its line. A line with no sensor yet has
            // nothing to say, unless it is drawn from a positions file alone
            const lines = this._jrn.map((j) => {
                const l = j.legs[0] || {};
                const o = l.entity ? { entity: l.entity } : {};
                for (const k of LINE_KEYS) if (keep(l[k])) o[k] = l[k];
                if (!Object.keys(o).length) return null;
                return Object.keys(o).length === 1 && o.entity ? o.entity : o;
            }).filter(Boolean);
            if (lines.length) config.lines = lines;
            else delete config.lines;
            // the single-sensor form, folded into the list
            for (const k of ["entity", "positions_url", "route_url", "line"]) delete config[k];
            this._jDirty = false;
        }
        this._config = config;
        this.dispatchEvent(new CustomEvent("config-changed", { detail: { config }, bubbles: true, composed: true }));
    }
}

customElements.define("gtfs2-live-card-editor", Gtfs2LiveCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
    type: "gtfs2-live-card",
    name: "GTFS2 Live Card",
    description: "Departures board and live vehicle map for gtfs2 lines · Départs et carte temps réel des lignes gtfs2.",
    documentationURL: "https://github.com/Pulpyyyy/gtfs2-live-card",
    preview: false,
    // Home Assistant 2026.6 and up: what the card picker offers once an
    // entity is chosen, under Community. A gtfs2 trip sensor makes a card of
    // one line, terminus to terminus - anything else is not ours, and a card
    // proposed for every entity is a picker nobody reads.
    getEntitySuggestion: (hass, entityId) => (
        isTripSensor(entityId, hass?.states?.[entityId])
            ? { config: { type: "custom:gtfs2-live-card", lines: [entityId] } }
            : null
    ),
});
