const CARD_VERSION = "1.0.0";

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
 *   2. a slippy map (CARTO/OSM tiles, Web-Mercator) of one or several lines:
 *      route shapes with direction arrows, stops, origin stations, realtime
 *      vehicles; per-bus focus and per-line highlight from the header badges
 *
 * Minimal config: a list of gtfs2 sensors; everything else (positions file,
 * route file, official line name and color, origin station) derives from the
 * sensor attributes, with explicit YAML values always overriding.
 *
 * i18n: all user-facing strings exist in en, fr, de, es and pt (the gtfs2
 * project languages), picked from the HA locale (config `language:` to
 * force). A visual editor is provided for the simple, sensors-list
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
    departures_view: "list",  // list | table: rows, or columns (departure,
                              // arrival, duration, mode, status, line) sorted
                              // by departure time
    // A pane can be COLLAPSED, which the card remembers per user, or hidden
    // outright, which is the dashboard's decision and sticks for everyone:
    // a departures-only card in a column, a map-only card next to it.
    show_departures: true,    // the departures pane, its header included
    show_map: true,           // the map pane, its header included
    map_style: "auto",        // auto | light | dark | custom template with {z}/{x}/{y}
    map_aspect: null,         // e.g. "4/3", overrides the responsive default
    language: "auto",         // auto (HA locale) | en | fr | de | es | pt
    latitude: null,           // optional station marker fallback
    longitude: null,
    refresh: 60,
    max_departures: 4,
};

const WORLD = 1 << 28;        // Web-Mercator world size, in "world units"
const EARTH_CIRC = 40075016.686;
const HIST_MAX = 30;
const HIST_TTL = 15 * 60000;  // forget vehicles gone from the feed this long
const STALE_FEED = 8 * 60000;  // a positions file not rewritten this long = the source has gone quiet

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
const PIP_GAP = 14;            // between badges, = 2 x the 7px overhang
// the narrowest the header's text zone is allowed to get before it stops
// sharing a row with the badges and takes one of its own
const TITLES_MIN = 96;

const BADGE_W = 60, BADGE_PAD = 10, BADGE_FS = 28;
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
const TILE_LIGHT = "https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png";
const TILE_DARK = "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png";

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

// glyph as a plain SVG path, centred on 0,0 and scaled so its ink reaches
// exactly r and no further. Returns null for a key we carry no outline for.
const modeGlyph = (mode, r, fill) => {
    const d = GLYPH_PATHS[mode];
    if (!d) return null;
    const [cx, cy, ri] = GLYPH_FIT[mode] || [12, 12, 12];
    const sc = r / ri;
    return `<path d="${d}" fill="${fill}" transform="scale(${sc.toFixed(4)}) translate(${(-cx).toFixed(2)} ${(-cy).toFixed(2)})"></path>`;
};


const resolveLang = (config, hass) => {
    const c = config?.language;
    if (LANGS.includes(c)) return c;
    const two = String(hass?.locale?.language || hass?.language || "en").toLowerCase().slice(0, 2);
    return LANGS.includes(two) ? two : "en";
};

/* ── helpers ────────────────────────────────────────────────────────────── */

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const parseTs = (v) => {
    if (v == null || v === "-" || v === "") return null;
    const d = new Date(String(v).replace(" ", "T"));
    return isNaN(d.getTime()) ? null : d;
};

const fmtHM = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// journey time, the way a timetable prints it: "1 h 04", "12 min"
const fmtDur = (min) => {
    if (!Number.isFinite(min) || min < 0) return "";
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h} h ${String(m).padStart(2, "0")}` : `${m} min`;
};

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
    return tr(lang, "ago_min", { n: Math.round(s / 60) });
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
};

class Gtfs2LiveCard extends HTMLElement {

    /* ── SETUP & CONFIG ─────────────────────────────────────────────────── */

    constructor() {
        super();
        this.attachShadow({ mode: "open" });
        this._hass = null;
        this._config = null;
        this._collapsed = { dep: false, map: false };
        this._focus = null;               // {li, vid} of the tracked vehicle, or null
        this._hiLine = null;              // line idx highlighted from its header badge
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
        this._mPerUNow = 1;
        this._mapDomReady = false;
        this._tileKey = null;
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
        this._timer = null;
        this._anim = null;
        this._lastEntityState = null;
        this._defsCache = null;
        this._hintCounts = {};
        this._built = false;
    }

    setConfig(config) {
        const hasLines = Array.isArray(config?.lines) && config.lines.length > 0;
        if (!config || (!config.entity && !hasLines)) {
            throw new Error("gtfs2-live-card : « entity » ou une liste « lines » est requis / set “entity” or a “lines” list");
        }
        this._config = { ...DEFAULTS, ...config };
        this._ld = this._lineDefs().map(() => ({ geo: null, geoAt: 0, err: null, route: null, routeAt: 0, sig: null, sigAt: 0 }));
        try {
            const saved = JSON.parse(localStorage.getItem(this._storageKey()) || "{}");
            if (typeof saved.dep === "boolean") this._collapsed.dep = saved.dep;
            if (typeof saved.map === "boolean") this._collapsed.map = saved.map;
        } catch (e) { /* localStorage unavailable: keep defaults */ }
        this._built = false;
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
            if (themeFlip) { this._tileKey = null; this._scheduleRerender(); }
            if (langFlip) this._lastEntityState = null;
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
        return resolveLang(this._config, this._hass);
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

    _persistCollapsed() {
        try { localStorage.setItem(this._storageKey(), JSON.stringify(this._collapsed)); } catch (e) { /* ignore */ }
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
            // nothing configured: derive from the sensor, from the file names
            // the integration exposes when it has them, else from the
            // route/direction attributes a stock gtfs2 already carries. The
            // two files are derived apart: realtime positions are optional,
            // the route shape is exported from the schedule alone.
            if ((!purl || !rurl) && entity && this._hass) {
                const at = this._hass.states?.[entity]?.attributes || {};
                const file = attrVal(at, "vehicle_positions_file");
                const rfile = attrVal(at, "route_geojson_file");
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
                if (purl || rurl) this._remember(entity, patch);
            }
            return {
                idx: i,
                entity,
                positions_url: purl,
                route_url: rurl || (purl ? purl.replace(/\.json$/, "_route.json") : null),
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
        // repeats are lightened to stay tellable apart.
        const colorUse = new Map();
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
                    d.color = n === 0 ? rc : lighten(rc, 0.35 * n);
                } else {
                    d.color = c.line_color || DEFAULTS.line_color;
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

    /* ── DOM LIFECYCLE ──────────────────────────────────────────────────── */

    connectedCallback() {
        this._startPolling();
        if (!this._tick30) this._tick30 = setInterval(() => this._tickRelative(), 30000);
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
        this._stopPolling();
        if (this._tick30) { clearInterval(this._tick30); this._tick30 = null; }
        if (this._visHandler) { document.removeEventListener("visibilitychange", this._visHandler); this._visHandler = null; }
        if (this._keyHandler) { document.removeEventListener("keydown", this._keyHandler); this._keyHandler = null; }
        if (this._ro) { this._ro.disconnect(); this._ro = null; }
        if (this._anim) cancelAnimationFrame(this._anim);
        if (this._rerenderTimer) { clearTimeout(this._rerenderTimer); this._rerenderTimer = null; }
        if (this._hintT) { clearTimeout(this._hintT); this._hintT = null; }
        if (this._tipT) { clearTimeout(this._tipT); this._tipT = null; }
        if (this._badgeTipT) { clearTimeout(this._badgeTipT); this._badgeTipT = null; }
        if (this._popAnim) { cancelAnimationFrame(this._popAnim); this._popAnim = null; }
    }

    _startPolling() {
        this._stopPolling();
        // an entity without url may expose its attributes later: keep polling
        // armed as long as a source is possible, positions or route alone
        if (!this._config || !this._lineDefs().some((d) => d.positions_url || d.route_url || d.entity)) return;
        this._fetchAll(true);
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
            if (!def.positions_url) continue;
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
        const spans = this._collapsed.dep ? [] : [...this.shadowRoot.querySelectorAll(".countdown[data-ts]")];
        let expired = false;
        for (const el of spans) {
            const t = new Date(Number(el.dataset.ts));
            if (t.getTime() < now.getTime() - 60000) expired = true;
            else el.textContent = fmtCountdown(lang, t, now);
        }
        if (expired || !spans.length) this._renderDepartures();
        this._renderFooter();
        // a line crosses the 8-minute line without any fetch happening: the
        // file is still answering, its date simply stopped moving
        this._repaintHeaderIfMuteChanged();
        const at = this.shadowRoot.querySelector(".map-attrib");
        if (at) {
            const newestAt = Math.max(0, ...this._ld.map((s) => s.sigAt || 0));
            at.textContent = this._t("map_updated", { t: newestAt ? fmtAgo(this._lang(), Date.now() - newestAt) : "…" });
        }
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

    static getStubConfig(hass) {
        const entity = Object.keys(hass?.states || {}).find(
            (id) => id.startsWith("sensor.") && hass.states[id].attributes?.next_departures !== undefined
        );
        return entity ? { lines: [entity] } : { entity: "sensor.gtfs2_start_stop" };
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
            this._startPolling();
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
        this.shadowRoot.innerHTML = `
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
            this._renderMap(false);
        } else if (action === "unfocus") {
            // the overview button is the full reset: tracking released, line
            // badge deselected, manual pan/zoom forgotten, fitted view
            this._focus = null;
            this._manual = false;
            if (this._hiLine != null) {
                this._hiLine = null;
                this._renderHeader();
                this._renderDepartures();
            }
            this._renderMap(true);
        } else if (action === "recenter") {
            this._manual = false;
            this._renderMap(true);
        } else if (action === "line") {
            const li = Number(ds.li);
            this._hiLine = this._hiLine === li ? null : li;
            // a badge click (select or deselect) always resets the map: the
            // tracking is released, a manual pan/zoom is forgotten, and the
            // view glides back to the fitted one. Closing the popup (cross,
            // Escape, tap on the background) keeps the map where it is.
            this._focus = null;
            this._manual = false;
            this._renderHeader();
            this._renderDepartures();
            if (!this._collapsed.map) this._renderMap(true);
        } else if (action === "stop") {
            // tap on a stop: name and connections for two seconds
            this._showTip(ds, 2000);
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

    _alertOf(d) {
        const at = d.entity ? this._hass?.states?.[d.entity]?.attributes : null;
        if (!at) return null;
        const text = ["origin_stop_alert", "destination_stop_alert"]
            .map((k) => attrVal(at, k))
            .find((v) => v && v !== "no info") || "";
        const cause = attrVal(at, "alert_cause") || "";
        const effect = attrVal(at, "alert_effect") || "";
        if (!text && !cause && !effect) return null;
        const kind = ALERT_WORKS.includes(cause) ? "works"
            : (ALERT_INCIDENT.includes(cause) || effect === "NO_SERVICE") ? "incident"
            : "alert";
        return { kind, text };
    }

    _renderHeader() {
        // the shell only exists once the strings are in: a fetch that lands
        // first must not draw anything
        if (!this._built) return;
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
                const sel = this._hiLine === d.idx;
                const dim = this._hiLine != null && !sel;
                const bdest = d.entity ? (this._hass?.states?.[d.entity]?.attributes?.destination_station_stop_name || "") : "";
                const a11y = many ? ` data-action="line" data-li="${d.idx}" role="button" tabindex="0" aria-pressed="${sel}"` : "";
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
                    : this._t("mute_since", { t: fmtAgo(this._lang(), Date.now() - slot.sigAt) });
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
                    // The stroke ends under this pip - it runs to 10,50 and
                    // the pip's disc is centred on 7,53 with a radius of 14 -
                    // so it emerges from beneath it rather than crossing it.
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
                return `<div class="badge ${many ? "clickable" : ""} ${sel ? "sel" : ""} ${dim ? "dim" : ""} ${resting ? "resting" : ""} ${mute ? "mute" : ""}" style="background:${esc(bg)};color:${bink};--chip-bg:${chipBg};--opp-ink:${opp}${bfs !== BADGE_FS ? `;font-size:${bfs}px` : ""}"${a11y} title="${esc(btitle)}"${btitle ? ` data-tip="${esc(btitle)}"` : ""}><span class="badge-num">${esc(blabel)}</span>${restSr}${chip}${mutePip}${alertPip}${rest}</div>`;
            })
            .join("");
        const titles = (title || dest)
            ? `<div class="titles">${title ? `<span class="title">${esc(title)}</span>` : ""}${dest ? `<span class="subtitle">${esc(dest)}</span>` : ""}</div>`
            : "";
        this.shadowRoot.getElementById("header").innerHTML = `<div class="badges">${badges}</div>${titles}`;
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
        // a badge-selected line filters the board to that line's departures
        if (this._hiLine != null) sources = sources.filter((s) => s.def && s.def.idx === this._hiLine);
        const rows = [];
        for (const src of sources) {
            const a = src.st.attributes || {};
            const theoRaw = Array.isArray(a.next_departures) ? a.next_departures : [];
            const dursRaw = Array.isArray(a.next_departures_durations) ? a.next_departures_durations : [];
            const arrsRaw = Array.isArray(a.next_departures_destination_arrival_times) ? a.next_departures_destination_arrival_times : [];
            // one entry per parsable departure, its journey time riding along
            // so the pairing survives the filter and the multi-line sort:
            // served ready-made by gtfs2 when the attribute exists, else
            // derived from the paired arrivals list
            const theoAll = theoRaw.map((v, j) => {
                const t = parseTs(v);
                if (!t) return null;
                let dur = typeof dursRaw[j] === "number" ? dursRaw[j] : null;
                if (dur == null) {
                    const arr = parseTs(arrsRaw[j]);
                    if (arr) dur = Math.round((arr.getTime() - t.getTime()) / 60000);
                }
                return { t, dur };
            }).filter(Boolean);
            const theo = theoAll.map((x) => x.t);
            const rt = (Array.isArray(a.next_departures_realtime) ? a.next_departures_realtime : []).map(parseTs).filter(Boolean);
            const delays = Array.isArray(a.next_delays_realtime) ? a.next_delays_realtime : [];
            const usedTheo = new Set();
            rt.forEach((t, i) => {
                let best = -1, bd = Infinity;
                theo.forEach((th, j) => {
                    if (usedTheo.has(j)) return;
                    const d = Math.abs(th.getTime() - t.getTime());
                    if (d < bd) { bd = d; best = j; }
                });
                // tight pairing window: a 16-min-away schedule slot is another
                // bus, not this one's theoretical time
                let theoT = null;
                if (best >= 0 && bd <= 10 * 60000) { theoT = theo[best]; usedTheo.add(best); }
                // feeds like TAO publish no delay field (0 = unknown): trust
                // the matched schedule first, a nonzero feed delay second
                const rawDelay = typeof delays[i] === "number" && delays[i] !== 0 ? delays[i] : null;
                const delayMin = theoT
                    ? Math.round((t.getTime() - theoT.getTime()) / 60000)
                    : (rawDelay != null ? Math.round(rawDelay / 60) : null);
                rows.push({ time: t, theo: theoT, rt: true, delayMin, durMin: theoT && best >= 0 ? theoAll[best].dur : null, def: src.def });
            });
            theo.forEach((th, j) => {
                if (!usedTheo.has(j)) rows.push({ time: th, theo: null, rt: false, delayMin: null, durMin: theoAll[j].dur, def: src.def });
            });
        }
        // a row leaves the board only once BOTH of its clocks are behind us:
        // a late bus keeps its future realtime, an early bus keeps its future
        // schedule slot. Filtering on the realtime alone dropped an early bus
        // before the hour printed at the stop had even come.
        const cutoff = Date.now() - 60000;
        const upcoming = rows.filter((r) =>
            Math.max(r.time.getTime(), r.theo ? r.theo.getTime() : 0) > cutoff);
        upcoming.sort((x, y) => x.time - y.time);
        return { rows: upcoming.slice(0, this._config.max_departures), multi: sources.length > 1 };
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
        const { rows, multi } = this._departureRows();
        const now = new Date();
        const hasRt = rows.some((r) => r.rt);
        const nextRow = rows[0];
        const hiDef = this._hiLine != null ? this._lineDefs().find((d) => d.idx === this._hiLine) : null;
        const filterBadge = hiDef ? ` <span class="mini-badge" style="background:${esc(hiDef.color)}">${esc(this._lineLabelOf(hiDef))}</span>` : "";

        if (this._collapsed.dep) {
            const nextLine = multi && nextRow?.def ? ` <span class="mini-badge" style="background:${esc(nextRow.def.color)}">${esc(this._lineLabelOf(nextRow.def))}</span>` : "";
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

        const rowsHtml = this._config.departures_view === "table"
            ? this._departuresTableHtml(rows, multi, nextRow, lang, now)
            : rows.map((r) => {
            const strike = r.rt && r.theo && Math.abs(r.time - r.theo) >= 60000;
            // the sub-line says only what the big line does not: the schedule
            // slot when it MOVED (struck through), and the arrival with the
            // journey time when durations are on. Provenance takes no
            // sentence - the realtime icon and the right-hand chip already
            // carry it - so a row with nothing exceptional is a single line.
            const bits = [];
            if (strike) bits.push(`<span class="sub strike">${this._t("scheduled_at", { t: fmtHM(r.theo) })}</span>`);
            if (this._config.show_duration && r.durMin != null) {
                bits.push(`<span class="sub dur">→ ${fmtHM(new Date(r.time.getTime() + r.durMin * 60000))} · ${fmtDur(r.durMin)}</span>`);
            }
            const subLine = bits.length ? `<span class="sub-line">${bits.join("")}</span>` : "";
            let chip;
            if (!r.rt) chip = `<span class="chip chip-theo">${this._t("scheduled")}</span>`;
            else if (r.delayMin == null) chip = "";   // realtime with no known schedule: no claim
            else if (Math.abs(r.delayMin) < 1) chip = `<span class="chip chip-ok">${this._t("on_time")}</span>`;
            else if (r.delayMin > 0) chip = `<span class="chip chip-late">+${r.delayMin} min</span>`;
            else chip = `<span class="chip chip-early">${r.delayMin} min</span>`;
            const badge = multi && r.def
                ? `<span class="row-badge" style="background:${esc(r.def.color)}">${esc(this._lineLabelOf(r.def))}</span>`
                : "";
            const destSub = multi && r.def
                ? this._hass?.states?.[r.def.entity]?.attributes?.destination_station_stop_name || ""
                : "";
            const tag = dayTag(lang, r.time, now);
            return `
            <div class="row">
                ${badge}
                <div class="times">
                    <div class="time-line">
                        <span class="time">${fmtHM(r.time)}</span>
                        ${tag ? `<span class="day-tag">${esc(tag)}</span>` : ""}
                        ${r.rt ? `<span class="rt-icon">${ICONS.live}</span>` : ""}
                        ${destSub ? `<span class="sub dest-inline">${esc(destSub)}</span>` : ""}
                    </div>
                    ${subLine}
                </div>
                <span class="spacer"></span>
                <div class="right">
                    <span class="countdown" data-ts="${r.time.getTime()}">${fmtCountdown(lang, r.time, now)}</span>
                    ${chip}
                </div>
            </div>`;
        }).join("");

        const chips = [];
        const a = (hiDef && hiDef.entity ? this._hass?.states?.[hiDef.entity]?.attributes : this._entity()?.attributes) || {};
        if (a.origin_station_stop_id) {
            chips.push(`<span class="info-chip">${ICONS.pin}${esc(String(a.origin_station_stop_id).split(": ")[0])}</span>`);
        }
        const seenAlerts = new Set();
        const alertSrcs = hiDef ? this._depSources().filter((s) => s.def && s.def.idx === this._hiLine) : this._depSources();
        for (const src of alertSrcs) {
            const prefix = src.def && this._depSources().length > 1 ? this._t("line_prefix", { l: this._lineLabelOf(src.def) }) : "";
            if (src.st.state === "unavailable") {
                chips.push(`<span class="info-chip info-alert">${ICONS.alert}${esc(prefix + this._t("chip_unavailable"))}</span>`);
                continue;
            }
            const alert = src.st.attributes?.origin_stop_alert;
            if (alert && alert !== "None" && alert !== "no info" && !seenAlerts.has(alert)) {
                seenAlerts.add(alert);
                chips.push(`<span class="info-chip info-alert">${ICONS.alert}${esc(prefix + alert)}</span>`);
            }
        }

        const hiSt = hiDef?.entity ? this._hass?.states?.[hiDef.entity] : null;
        // "No upcoming departure" is a dead end: it is true, and it leaves the
        // user with nowhere to go. When the line is at rest the card already
        // knows when it runs again - it is on the badge, in a tooltip a finger
        // can barely reach. The board is where they are looking, so it says the
        // date instead. Only the lines shown here are asked: with a line
        // selected the board is that line's, and its rest is the whole answer.
        const restDefs = hiDef ? [hiDef] : this._depSources().map((s) => s.def).filter(Boolean);
        const notes = restDefs.map((d) => [d, this._restingNote(d)]).filter(([, n]) => n);
        const uniq = [...new Set(notes.map(([, n]) => n))];
        // one date for every line at rest: say it once, unprefixed
        const restMsg = !notes.length ? ""
            : uniq.length === 1 ? uniq[0]
            : notes.map(([d, n]) => this._t("line_prefix", { l: this._lineLabelOf(d) }) + n).join(" · ");
        const emptyMsg = hiDef && !hiDef.entity ? this._t("no_dep_sensor")
            : (hiSt && hiSt.state === "unavailable" ? this._t("sensor_unavailable")
                : (restMsg || this._t("none_upcoming")));
        body.innerHTML = (rowsHtml || `<div class="empty${restMsg && !(hiDef && !hiDef.entity) ? " rest" : ""}">${emptyMsg}</div>`)
            + (chips.length ? `<div class="info-strip">${chips.join("")}</div>` : "");
    }

    /* The same rows laid out as a timetable: departure, arrival, duration,
     * mode, status and - when several lines share the board - line. The sort
     * is the departure time's and only its own: columns are read, not
     * clicked. A "next departure" line stands in for the per-row countdowns,
     * and its span joins the 30 s tick like any other. */
    _departuresTableHtml(rows, multi, nextRow, lang, now) {
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
        const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
        const cells = rows.map((r) => {
            const tag = dayTag(lang, r.time, now);
            // the realtime icon sits LEFT of the time: the right edge belongs
            // to the digits, so times align whether a row carries it or not
            const dep = (r.rt ? `<span class="rt-icon">${ICONS.live}</span>` : "")
                + `${tag ? `<span class="day-tag">${esc(tag)}</span> ` : ""}${fmtHM(r.time)}`;
            // the moved schedule slot has no sub-line here: it rides the tooltip
            const depTitle = r.rt && r.theo && Math.abs(r.time - r.theo) >= 60000
                ? ` title="${esc(this._t("scheduled_at", { t: fmtHM(r.theo) }))}"` : "";
            let arr = "—", dur = "—";
            if (r.durMin != null) {
                const at = new Date(r.time.getTime() + r.durMin * 60000);
                // the arrival names its day only when it differs from the
                // DEPARTURE's: a night run does not repeat its own date
                const atag = dayTag(lang, at, r.time);
                arr = `${atag ? `<span class="day-tag">${esc(atag)}</span> ` : ""}${fmtHM(at)}`;
                const b = best.get(keyOf(r)) ?? r.durMin;
                // three frank steps rather than a smooth gradient: a hue that
                // slides a few degrees reads as noise. Green rides within a
                // couple of minutes or 15% of the line's best time, orange is
                // notably slower, red half again as long.
                const slack = r.durMin - b;
                const cls = slack <= Math.max(2, b * 0.15) ? "dur-ok"
                    : r.durMin >= b * 1.5 ? "dur-slow" : "dur-mid";
                dur = `<b class="${cls}">${fmtDur(r.durMin)}</b>`;
            }
            const mode = r.def ? cap(modeWord(lang, r.def.mode || "bus", false)) : "—";
            let status;
            if (r.rt && r.delayMin != null && Math.abs(r.delayMin) >= 1) {
                status = `<b class="${r.delayMin > 0 ? "st-late" : "st-early"}">${r.delayMin > 0 ? "+" : ""}${r.delayMin} min</b>`;
            } else if (r.rt) {
                // a realtime run with no matched schedule makes no on-time
                // claim: the same doctrine as the list's chips, said quietly
                status = r.delayMin == null
                    ? `<span class="st-none" title="${esc(this._t("realtime"))}">—</span>`
                    : `<b class="st-ok" title="${esc(this._t("on_time"))}">—</b>`;
            } else {
                status = `<span class="st-none" title="${esc(this._t("no_rt_yet"))}">—</span>`;
            }
            const line = multi
                ? `<td class="fit">${r.def ? `<span class="row-badge" style="background:${esc(r.def.color)}">${esc(this._lineLabelOf(r.def))}</span>` : "—"}</td>`
                : "";
            return `<tr><td class="num dep fit"${depTitle}>${dep}</td><td class="num fit">${arr}</td>`
                + `<td class="num fit">${dur}</td><td>${esc(mode)}</td><td class="st fit">${status}</td>${line}</tr>`;
        }).join("");
        const summary = `<div class="board-next">${this._t("next_dep_in", {
            c: `<span class="countdown" data-ts="${nextRow.time.getTime()}">${fmtCountdown(lang, nextRow.time, now)}</span>`,
            t: `<b>${fmtHM(nextRow.time)}</b>`,
        })}</div>`;
        return summary
            + `<div class="board-wrap"><table class="board"><thead><tr>`
            + `<th class="num fit">${this._t("col_departure")}</th><th class="num fit">${this._t("col_arrival")}</th>`
            + `<th class="num fit">${this._t("col_duration")}</th><th>${this._t("col_mode")}</th>`
            + `<th class="st fit">${this._t("col_status")}</th>${multi ? `<th class="fit">${this._t("col_line")}</th>` : ""}`
            + `</tr></thead><tbody>${cells}</tbody></table></div>`;
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
                    };
                });
            slot.route = { line, cum, stops, mPerU };
        } catch (e) {
            // route export absent (older gtfs2): the card degrades to traces
            slot.route = null;
        }
        this._scheduleRerender();
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

    // heading (degrees, 0 = north, clockwise) of the route at the point's
    // projection: the LineString follows the travel direction of the trip,
    // so this is the correct arrow orientation by construction. Returns null
    // when the point is too far from the route to trust it.
    _routeAngleAt(route, w, prj) {
        prj = prj || this._projectOnPolyline(w, route.line, route.cum);
        if (Math.sqrt(prj.d2) * route.mPerU > 150) return null;
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

    // origin-stop pins, shown only for the selected/tracked line (topLi);
    // the neutral view stays minimal. An explicit latitude/longitude in the
    // config is intentional and always shows.
    _stationPoints(topLi) {
        const pts = [];
        const seen = new Set();
        if (topLi != null) {
            for (const src of this._depSources()) {
                if (!src.def || src.def.idx !== topLi) continue;
                // an unavailable sensor loses its attributes: fall back on the
                // last origin id seen, so the pin survives end of service
                let originId = String(src.st.attributes?.origin_station_stop_id || "").split(": ")[0];
                if (originId) this._remember(src.st.entity_id, { origin: originId });
                else originId = this._emeta.get(src.st.entity_id)?.origin || "";
                if (!originId || seen.has(originId)) continue;
                const own = this._ld[src.def.idx]?.route;
                const pools = [own, ...this._ld.map((s) => s.route)].filter(Boolean);
                let hit = null;
                for (const route of pools) {
                    hit = route.stops?.find((s) => s.id === originId || s.id.includes(originId) || originId.includes(s.id)) || null;
                    if (hit) break;
                }
                if (hit) { seen.add(originId); pts.push(hit); }
            }
        }
        if (this._config.latitude != null && this._config.longitude != null) {
            pts.push(this._world(Number(this._config.latitude), Number(this._config.longitude)));
        }
        return pts;
    }

    _tileTemplate() {
        const style = this._config.map_style;
        if (style && style !== "auto" && style !== "light" && style !== "dark") return style;
        const dark = style === "dark" || (style !== "light" && !!this._hass?.themes?.darkMode);
        return dark ? TILE_DARK : TILE_LIGHT;
    }

    _liveBusCount() {
        const now = Date.now();
        return this._ld.reduce((n, s) => n + ((s.sigAt && now - s.sigAt > STALE_FEED) ? 0 : (s.geo?.features?.length || 0)), 0);
    }

    // "16 trams running" when every line shares a mode, "22 vehicles" otherwise
    _busCountText(count) {
        const lang = this._lang();
        const modes = new Set(this._lineDefs().map((d) => d.mode || "bus"));
        const mk = modes.size === 1 ? [...modes][0] : "vehicle";
        return count === 1
            ? this._t("bus_running", { m: modeWord(lang, mk, false) })
            : this._t("buses_running", { n: count, m: modeWord(lang, mk, true) });
    }

    /* ── PANE 2: MAP rendering ──────────────────────────────────────────── */

    _renderMapSection() {
        if (!this._built) return;   // no shell yet: see _renderHeader
        const head = this.shadowRoot.getElementById("map-head");
        const body = this.shadowRoot.getElementById("map-body");
        if (this._config.show_map === false) {
            head.style.display = "none";
            body.innerHTML = "";
            this._mapDomReady = false;
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
            body.innerHTML = "";
            this._mapDomReady = false;
            this.shadowRoot.getElementById("focus-panel").innerHTML = "";
            return;
        }
        // positions are optional: a line that only knows its route shape
        // still has a map worth drawing
        if (!this._lineDefs().some((d) => d.positions_url || d.route_url)) {
            this._renderMapHead();
            body.innerHTML = `<div class="empty">${this._t("no_source")}</div>`;
            this._mapDomReady = false;
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
        return "…";
    }

    _ensureMapDom(body) {
        if (this._mapDomReady && body.querySelector(".map-wrap")) return;
        const aspect = this._config.map_aspect && /^[\d\s./]+$/.test(String(this._config.map_aspect))
            ? ` style="aspect-ratio: ${esc(String(this._config.map_aspect))};"` : "";
        body.innerHTML = `
            <div class="map-wrap">
                <svg preserveAspectRatio="xMidYMid slice" tabindex="0"${aspect}>
                    <g class="l-tiles"></g>
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
        this._tileKey = null;
        this._scaleW = 0;
        this._scaleH = 0;
        this._popSize = null;
        this._vehEls.clear();
        this._attachMapEvents();
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

        let focusEntry = this._focus ? all.find((e) => e.def.idx === this._focus.li && this._vid(e.f) === this._focus.vid) : null;
        if (this._focus && !focusEntry) {
            // tracked vehicle left the feed (end of trip): glide back to the
            // fitted view and say why, instead of jumping silently
            this._focus = null;
            this._manual = false;
            animate = true;
            this._showHint(this._t("tracking_ended"));
        }
        this._renderMapHead();

        // the "top" line: the focused bus's line, else the badge-highlighted one
        const topLi = focusEntry ? focusEntry.def.idx : this._hiLine;
        const stations = this._stationPoints(topLi);
        const anyRoute = this._ld.some((s) => s.route);
        if (!all.length && !anyRoute && !stations.length) {
            // nothing to draw at all: name the half that is missing. A route
            // fetch already attempted and empty is the useful thing to say
            // when the line publishes no positions to begin with.
            const posErr = this._ld.some((s) => s.err);
            const posData = this._ld.some((s) => s.geoAt);
            const routeTried = this._ld.some((s) => s.routeAt);
            const msg = posErr ? this._t("unreachable")
                : posData ? this._t("no_bus")
                : routeTried ? this._t("route_unreachable")
                : this._t("loading");
            body.innerHTML = `<div class="empty">${msg}</div>`;
            this._mapDomReady = false;
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
            const c = this._world(focusEntry.f.geometry.coordinates[1], focusEntry.f.geometry.coordinates[0]);
            const w = 900 / mPerU, h = w * frameAspect;
            target = [c.x - w / 2, c.y - h * 0.6, w, h];
        } else {
            const pts = all.map((e) => this._world(e.f.geometry.coordinates[1], e.f.geometry.coordinates[0]));
            pts.push(...stations);
            for (const s of this._ld) if (s.route) pts.push(...s.route.line);
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
            this._tileKey = null;
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

        // ── tiles (rebuilt only when the visible tile set changes)
        const zRaw = Math.log2((WORLD * clientW) / (256 * vb[2]));
        const z = Math.max(1, Math.min(19, Math.round(zRaw)));
        const tileU = WORLD / Math.pow(2, z);
        const r = (window.devicePixelRatio || 1) > 1.5 ? "@2x" : "";
        const tpl = this._tileTemplate();
        // one extra ring of tiles around the view, so a pan shows no gaps
        // before the deferred re-render (tiles stay in the browser cache)
        const tx0 = Math.floor((O.x + vb[0]) / tileU) - 1, tx1 = Math.floor((O.x + vb[0] + vb[2]) / tileU) + 1;
        const ty0 = Math.floor((O.y + vb[1]) / tileU) - 1, ty1 = Math.floor((O.y + vb[1] + vb[3]) / tileU) + 1;
        const tileKey = `${tpl}|${z}|${tx0}:${tx1}|${ty0}:${ty1}|${O.x}:${O.y}`;
        if (tileKey !== this._tileKey) {
            const nTiles = Math.pow(2, z);
            let tiles = "", count = 0;
            for (let tx = tx0; tx <= tx1 && count < 64; tx++) {
                for (let ty = ty0; ty <= ty1 && count < 64; ty++, count++) {
                    if (ty < 0 || ty >= nTiles) continue;
                    const wx = ((tx % nTiles) + nTiles) % nTiles;
                    const url = tpl.replace("{z}", z).replace("{x}", wx).replace("{y}", ty).replace("{r}", r);
                    tiles += `<image href="${esc(url)}" x="${(tx * tileU - O.x).toFixed(1)}" y="${(ty * tileU - O.y).toFixed(1)}" width="${tileU.toFixed(1)}" height="${tileU.toFixed(1)}"></image>`;
                }
            }
            svg.querySelector(".l-tiles").innerHTML = tiles;
            this._tileKey = tileKey;
        }

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
            const bc = rel(this._world(focusEntry.f.geometry.coordinates[1], focusEntry.f.geometry.coordinates[0]));
            placed.push({ x: bc.x - (pw / 2) * u, y: bc.y - (24 + ph) * u, w: pw * u, h: ph * u });
        }
        const routeDefs = topLi == null ? defs
            : [...defs].sort((a, b) => (a.idx === topLi ? 1 : 0) - (b.idx === topLi ? 1 : 0));
        for (const def of routeDefs) {
            const route = this._ld[def.idx]?.route;
            const color = def.color;
            const isFocusLine = focusEntry && focusEntry.def.idx === def.idx;
            const dimLine = topLi != null && def.idx !== topLi;
            if (route) {
                let dAll;
                if (route._dCache && route._dCache.ox === O.x && route._dCache.oy === O.y) {
                    dAll = route._dCache.d;
                } else {
                    dAll = route.line.map((p, i) => `${i ? "L" : "M"}${(p.x - O.x).toFixed(1)} ${(p.y - O.y).toFixed(1)}`).join(" ");
                    route._dCache = { ox: O.x, oy: O.y, d: dAll };
                }
                if (isFocusLine) {
                    const lineRel = route.line.map(rel);
                    const busW = this._world(focusEntry.f.geometry.coordinates[1], focusEntry.f.geometry.coordinates[0]);
                    const prj = this._projectVeh(def.idx, this._vid(focusEntry.f), busW, route);
                    // the split runs through the vehicle's real position, not its
                    // projection: on a coarse shape (straight segment between two
                    // stops) the bus becomes an intermediate vertex, so both
                    // half-routes stay attached to the marker
                    const pr = rel(busW);
                    const passed = lineRel.slice(0, prj.idx + 1).map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ") + ` L${pr.x.toFixed(1)} ${pr.y.toFixed(1)}`;
                    const ahead = `M${pr.x.toFixed(1)} ${pr.y.toFixed(1)} ` + lineRel.slice(prj.idx + 1).map((p) => `L${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ");
                    routeSvg += `<path d="${passed}" fill="none" stroke="#8a9096" stroke-width="${3.5 * u}" stroke-dasharray="${7 * u} ${7 * u}" opacity="0.7" stroke-linecap="round"></path>`;
                    routeSvg += `<path d="${ahead}" fill="none" stroke="${esc(color)}" stroke-width="${5 * u}" opacity="0.92" stroke-linecap="round"></path>`;
                    const next = route.stops.find((s) => s.cum > prj.cum + 15);
                    nextStopName = next?.name || null;
                    for (const s of route.stops) {
                        const p = rel(s);
                        const ahead2 = s.cum > prj.cum;
                        routeSvg += this._stopMarker(s, p, u, ahead2 ? esc(color) : "#8a9096", 4, hasLinks(s, def), def.idx);
                    }
                    if (next) {
                        const p = rel(next);
                        const labelW = (next.name.length * 6.2 + 16) * u;
                        const nbox = { x: p.x - labelW / 2, y: p.y - 24 * u, w: labelW, h: 17 * u };
                        const underPop = placed.some((b) => nbox.x < b.x + b.w && nbox.x + nbox.w > b.x && nbox.y < b.y + b.h && nbox.y + nbox.h > b.y);
                        placed.push(nbox);
                        if (!underPop) {
                            routeSvg += `<g><rect x="${nbox.x.toFixed(1)}" y="${nbox.y.toFixed(1)}" width="${labelW.toFixed(1)}" height="${(17 * u).toFixed(1)}" rx="${(8.5 * u).toFixed(1)}" fill="var(--card-background-color, #fff)" opacity="0.95"></rect>
                            <text x="${p.x.toFixed(1)}" y="${(p.y - 12 * u).toFixed(1)}" font-size="${(10 * u).toFixed(2)}" font-weight="500" fill="var(--primary-text-color, #212121)" text-anchor="middle">${esc(next.name)}</text></g>`;
                        }
                    }
                    if (labelsOn) routeSvg += this._stopLabels(route.stops, rel, u, placed, next);
                } else {
                    routeSvg += `<path d="${dAll}" fill="none" stroke="${esc(color)}" stroke-width="${4.5 * u}" opacity="${dimLine ? 0.18 : 0.9}" stroke-linecap="round"></path>`;
                    if (!dimLine) {
                        routeSvg += this._routeArrows(route, rel, u, spanM);
                        for (const s of route.stops) {
                            const p = rel(s);
                            routeSvg += this._stopMarker(s, p, u, esc(color), 3.5, hasLinks(s, def), def.idx);
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

        // ── origin stations (one per departure sensor), in their own color
        let stationSvg = "";
        const sc = this._stationColor();
        for (const station of stations) {
            const s = rel(station);
            stationSvg += `<circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${13 * u}" fill="${esc(sc)}" opacity="0.2"></circle>
                          <circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${9 * u}" fill="var(--card-background-color, #fff)" stroke="${esc(sc)}" stroke-width="${3.5 * u}"></circle>
                          <circle cx="${s.x.toFixed(1)}" cy="${s.y.toFixed(1)}" r="${3.2 * u}" fill="${esc(sc)}"></circle>`;
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
            const wpt = this._world(e.f.geometry.coordinates[1], e.f.geometry.coordinates[0]);
            const c = rel(wpt);
            // heading: route tangent first (correct by construction), then history
            const angKey = `${def.idx}:${vid}`;
            const angPos = `${Math.round(wpt.x)},${Math.round(wpt.y)}`;
            const angHit = this._angCache.get(angKey);
            let angle;
            if (angHit && angHit.pos === angPos) angle = angHit.a;
            else {
                angle = null;
                const route = this._ld[def.idx]?.route;
                if (route) angle = this._routeAngleAt(route, wpt, this._projectVeh(def.idx, vid, wpt, route));
                if (angle == null) {
                    const h = this._hist.get(angKey) || [];
                    if (h.length > 1) {
                        const a1 = this._world(h[h.length - 2].lat, h[h.length - 2].lon);
                        angle = (Math.atan2(wpt.x - a1.x, -(wpt.y - a1.y)) * 180) / Math.PI;
                    }
                }
                this._angCache.set(angKey, { pos: angPos, a: angle });
            }
            const focused = focusEntry === e;
            const dim = !focused && topLi != null && def.idx !== topLi;
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
                <text x="0" y="${29.5 * u}" font-size="${10 * u}" font-weight="600" fill="var(--primary-text-color, #212121)" text-anchor="middle">${esc(vid)}</text>` : ""}`;
            vehicles.push({ key: `${def.idx}:${vid}`, li: def.idx, vid, x: c.x, y: c.y, angle: angle || 0, dim, inner,
                aria: `${modeWord(lang, def.mode || "bus", false)} ${vid}` });
        }

        svg.setAttribute("viewBox", vb.map((v) => v.toFixed(1)).join(" "));
        svg.querySelector(".l-overlay").innerHTML = routeSvg + stationSvg;
        this._syncVehicles(svg.querySelector(".l-veh"), vehicles);

        const btnUnfocus = body.querySelector('.map-btn[data-action="unfocus"]');
        if (btnUnfocus) btnUnfocus.hidden = !this._focus;
        const btnRecenter = body.querySelector('.map-ctrl-btn[data-action="recenter"]');
        if (btnRecenter) btnRecenter.hidden = !this._manual;
        const attrib = body.querySelector(".map-attrib");
        if (attrib) {
            const newestAt = Math.max(0, ...this._ld.map((s) => s.sigAt || 0));
            attrib.textContent = this._t("map_updated", { t: newestAt ? fmtAgo(lang, Date.now() - newestAt) : "…" });
        }

        // vehicle popup anchored on the tracked marker (replaces the old
        // bottom panel)
        const pop = body.querySelector(".map-pop");
        if (pop) {
            if (focusEntry) {
                const popKey = `${focusEntry.def.idx}:${this._vid(focusEntry.f)}`;
                const popW = this._world(focusEntry.f.geometry.coordinates[1], focusEntry.f.geometry.coordinates[0]);
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
                <span class="mini-badge" style="background:${esc(entry.def.color)}">${esc(this._lineLabelOf(entry.def))}</span>
                <b>${veh} ${esc(vid)}</b>
                <span class="spacer"></span>
                <button class="pop-close" data-action="untrack" aria-label="${esc(this._t("close"))}">✕</button>
            </div>
            ${terminus ? `<div class="pop-dest">→ ${esc(terminus)}</div>` : ""}
            ${showNext ? `<div class="pop-row">${this._t("next_stop", { s: esc(nextStopName) })}</div>` : ""}
            ${tele ? `<div class="pop-row">${tele}</div>` : ""}`;
    }

    // a stop: wide transparent hit area, the dot itself; connection stops
    // (served by another configured line) drawn bigger with a thicker ring
    _stopMarker(s, p, u, stroke, baseR, hub, li) {
        const r = (hub ? baseR + 1.6 : baseR) * u;
        return `<g class="stop" data-action="stop" data-li="${li}" data-name="${esc(s.name)}" data-x="${p.x.toFixed(1)}" data-y="${p.y.toFixed(1)}">`
            + `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${11 * u}" fill="transparent"></circle>`
            + `<circle class="dot" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r.toFixed(2)}" fill="var(--card-background-color, #fff)" stroke="${stroke}" stroke-width="${(hub ? 2.6 : 2) * u}"></circle></g>`;
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
                + `<text x="${(box.x + 5 * u).toFixed(1)}" y="${(p.y + 3.3 * u).toFixed(1)}" font-size="${(9 * u).toFixed(2)}" fill="var(--primary-text-color, #212121)">${esc(name)}</text></g>`;
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
        tip.innerHTML = `<b>${esc(ds.name)}</b>`
            + (others.length ? `<span class="tip-links">${others.map(([l, c]) => `<span class="mini-badge" style="background:${esc(c)}">${esc(l)}</span>`).join("")}</span>` : "");
        const vb = this._viewBox, w = svg.clientWidth || 408, h = svg.clientHeight || 204;
        const sx = ((Number(ds.x) - vb[0]) / vb[2]) * w, sy = ((Number(ds.y) - vb[1]) / vb[3]) * h;
        tip.hidden = false;
        const mx = Math.max(8, Math.min(70, (w - 16) / 2));
        tip.style.left = `${Math.max(mx, Math.min(w - mx, sx))}px`;
        tip.style.top = `${Math.max(8, Math.min(h - 4, sy - 10))}px`;
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
        this._setViewBox(this._clampVB(this._viewBox));
        svg.setAttribute("viewBox", this._viewBox.map((v) => v.toFixed(1)).join(" "));
        this._positionPop();
        this._updateScale();
    }

    _scheduleRerender() {
        if (this._rerenderTimer) clearTimeout(this._rerenderTimer);
        this._rerenderTimer = setTimeout(() => { this._rerenderTimer = null; this._renderMapSection(); }, 180);
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
        // the tip is anchored in screen pixels: a zoom moves its stop away
        this._hideTip();
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
        /* at most four badges per row, but ONLY while a text zone needs the
           rest of the frame: without it flex would let a crowded header
           push the text into a sliver. 282 = 4 x 60 + 3 x 14; a narrower
           card still shrinks the zone below it on its own. No title and no
           selection means no titles element at all, the badges are alone
           in the header, and they take the whole width back */
        .badges:not(:only-child) { max-width: ${4 * BADGE_W + 3 * PIP_GAP}px; }
        /* a fixed square, never a box that grows with its label: two lines
           side by side have to be the same size, so it is the number that
           shrinks to fit the 40px between the paddings. See badgeFontSize. */
        .badge { position: relative; width: 60px; height: 60px; flex: none; border-radius: 13px; color: #fff; display: flex; align-items: center; justify-content: center; font-size: ${BADGE_FS}px; font-weight: 700; padding: 0 ${BADGE_PAD}px; box-sizing: border-box; }
        /* the mode chip rides on the badge itself: no disc, no outline, just
           the glyph in the badge's own ink, so it reads as part of the badge */
        /* a faint disc behind the glyph, tinted OPPOSITE to the ink: tinting it
           in the ink itself would put a white veil under a white glyph and
           swallow it. Set per badge as --chip-bg, since the ink depends on the
           line colour. */
        /* one size, one overhang, four possible corners: a mark is told apart
           by what it holds and by where it sits, never by how big it is */
        .badge-pip { position: absolute; width: ${PIP}px; height: ${PIP}px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: inherit; pointer-events: none; z-index: 3; --mdc-icon-size: 26px; }
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
        .badge-slash { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 2; pointer-events: none; opacity: 0.65; border-radius: 13px; }
        .slash-halo { stroke: var(--opp-ink, #000); stroke-width: 5.5; opacity: 0.55; }
        /* the number keeps its full ink: a line still shows its number when it
           is not running. Only the badge as a whole steps back a little. */
        .badge.resting { opacity: 0.92; }
        .badge.resting.sel { opacity: 1; }
        /* A quiet source is drained, not dimmed. The colour itself is replaced
           by its desaturated twin (see drain), so nothing here fades the number
           or the mark: an opacity on the badge would take the mark down with
           it, and a veil over the colour cost the number its contrast. */
        .badge-glyph { width: ${PIP}px; height: ${PIP}px; display: block; }
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
        .spacer { flex-grow: 1; }
        .sect-head { display: flex; align-items: center; gap: 8px; min-height: 44px; padding: 0 16px; border-top: 1px solid var(--divider-color); cursor: pointer; user-select: none; }
        .sect-title { font-size: 14px; font-weight: 500; color: var(--primary-text-color); }
        .chev { color: var(--secondary-text-color); display: inline-flex; }
        .summary b { color: var(--primary-text-color); font-weight: 600; }
        .summary.accent { color: var(--primary-color); font-weight: 500; }
        .summary.warn { color: var(--warning-color, #e65100); }
        .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #4caf50; animation: pulse 2s infinite; }
        @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(76,175,80,.5); } 70% { box-shadow: 0 0 0 6px rgba(76,175,80,0); } 100% { box-shadow: 0 0 0 0 rgba(76,175,80,0); } }
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
        .rt-icon { color: #4caf50; display: inline-flex; flex: none; }
        .sub.strike { text-decoration: line-through; }
        .sub { font-size: 12px; }
        .sub-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 6px; min-width: 0; }
        /* the merged line reads as a sentence: capital on its first letter,
           whatever the language, without touching the strings used elsewhere */
        .sub-line > .sub:first-child::first-letter { text-transform: uppercase; }
        .dur { white-space: nowrap; }
        .right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: none; }
        .countdown { font-size: 14px; font-weight: 600; color: var(--primary-text-color); }
        .chip { display: inline-flex; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
        .chip-late { background: rgba(230,81,0,.14); color: var(--gtfs2-late-color, #e65100); }
        .chip-early { background: rgba(3,105,161,.14); color: #0369a1; }
        .chip-ok { background: rgba(46,125,50,.14); color: var(--gtfs2-ontime-color, #2e7d32); }
        .chip-theo { background: rgba(127,127,127,.14); color: var(--secondary-text-color); }
        /* the table layout of the board: numbers right, the sort fixed */
        .board-next { padding: 10px 16px 4px; font-size: 13px; color: var(--secondary-text-color); }
        .board-next b { color: var(--primary-text-color); }
        .board-next .countdown { font-size: 13px; }
        .board-wrap { overflow-x: auto; }
        .board { width: 100%; border-collapse: collapse; font-size: 13px; }
        .board th { text-align: left; font-size: 12px; font-weight: 600; color: var(--secondary-text-color); padding: 8px 12px 6px; }
        .board td { padding: 7px 12px; border-top: 1px solid var(--divider-color); white-space: nowrap; }
        /* a display board, not a spreadsheet: every column hugs its content
           (width 1% + nowrap is the shrink-to-fit idiom) and the one elastic
           column - the mode - absorbs ALL the surplus width. On a wide card
           the times stay grouped and scannable at the left, status and line
           stay pinned at the right, instead of the browser smearing the
           slack a little into every column. */
        .board .fit { width: 1%; }
        .board th:first-child, .board td:first-child { padding-left: 16px; }
        .board th:last-child, .board td:last-child { padding-right: 16px; }
        .board .num { text-align: right; }
        .board .st { text-align: center; }
        .board td.dep { font-weight: 700; }
        .board td .rt-icon { margin-right: 4px; }
        .board .dur-ok { color: var(--gtfs2-ontime-color, #2e7d32); }
        .board .dur-mid { color: var(--gtfs2-late-color, #e65100); }
        .board .dur-slow { color: var(--error-color, #b3261e); }
        .board .st-late { color: var(--gtfs2-late-color, #e65100); }
        .board .st-early { color: #0369a1; }
        .board .st-ok { color: var(--gtfs2-ontime-color, #2e7d32); }
        .board .st-none { color: var(--secondary-text-color); }
        .info-strip { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--divider-color); }
        .info-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 8px; font-size: 11px; background: rgba(127,127,127,.12); color: var(--secondary-text-color); }
        .info-chip svg { flex: none; }
        .info-alert { background: rgba(230,81,0,.12); color: #e65100; }
        .empty { padding: 14px 16px; font-size: 13px; color: var(--secondary-text-color); }
        /* the resting note is written for a tooltip, where it follows the
           destination in lower case; standing alone on the board it is a
           sentence and starts like one */
        .empty.rest::first-letter { text-transform: uppercase; }
        .empty code { font-size: 12px; }
        .map-body { border-top: 0; container-type: inline-size; }
        .map-wrap { position: relative; background: var(--gtfs2-map-background, rgba(127,127,127,.1)); user-select: none; }
        .map-wrap svg { display: block; width: 100%; aspect-ratio: 2 / 1; touch-action: pan-y; cursor: grab; }
        .map-wrap svg:active { cursor: grabbing; }
        @container (max-width: 380px) { .map-wrap svg { aspect-ratio: 4 / 3; } }
        .tiles image { image-rendering: auto; }
        .bus { cursor: pointer; transition: transform .7s ease-out; }
        .bus .hd { transition: transform .7s ease-out; transform-origin: 0 0; }
        .bus.dim { opacity: 0.35; }
        .bus:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .stop { cursor: pointer; }
        .stop .dot { transition: transform .12s; transform-box: fill-box; transform-origin: center; }
        .stop:hover .dot { transform: scale(1.35); }
        .map-tip { position: absolute; transform: translate(-50%, -100%); pointer-events: none; display: flex; align-items: center; gap: 6px; background: var(--card-background-color, #fff); color: var(--primary-text-color); font-size: 11px; padding: 3px 8px; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.3); white-space: nowrap; }
        .tip-links { display: inline-flex; gap: 3px; }
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
        @media (prefers-reduced-motion: reduce) { .live-dot { animation: none; } .stop .dot, .map-hint, .bus, .bus .hd { transition: none; } }
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
        // working copy: every entry as an object, top-level source keys folded
        // into line 1 so the editor exposes a single, uniform lines list
        const l = this._config.lines;
        if (Array.isArray(l) && l.length) {
            this._lines = l.map((e) => (typeof e === "string" ? { entity: e } : { ...e }));
        } else if (this._config.entity || this._config.positions_url) {
            this._lines = [{
                entity: this._config.entity,
                positions_url: this._config.positions_url,
                route_url: this._config.route_url,
                line: this._config.line,
            }];
        } else {
            this._lines = [];
        }
        this._render();
    }

    set hass(hass) {
        this._hass = hass;
        this._render();
    }

    _entitiesSchema() {
        return [{ name: "entities", selector: { entity: { multiple: true, filter: [{ integration: "gtfs2", domain: "sensor" }] } } }];
    }

    // Grouped, and in hierarchical order: what the whole card shows first,
    // then each pane's switch IMMEDIATELY followed by the options that only
    // matter while that pane is shown - nothing about a pane appears above
    // the toggle that brings the pane into existence.
    _globalSchema(L) {
        return [
            { name: "title", selector: { text: {} } },
            { name: "mode_icons", selector: { boolean: {} } },
            { name: "show_departures", selector: { boolean: {} } },
            { name: "departures_view", selector: { select: { mode: "dropdown", options: [
                { value: "list", label: L?.view_list ?? "list" },
                { value: "table", label: L?.view_table ?? "table" }] } } },
            { name: "max_departures", selector: { number: { min: 1, max: 20, mode: "box" } } },
            { name: "show_duration", selector: { boolean: {} } },
            { name: "show_map", selector: { boolean: {} } },
            { name: "refresh", selector: { number: { min: 15, max: 600, mode: "box", unit_of_measurement: "s" } } },
        ];
    }

    // everything that changes how the map looks, rarely touched
    _lookSchema(lang) {
        return [
            { name: "map_style", selector: { select: { mode: "dropdown", custom_value: true, options: [
                { value: "auto", label: "auto" }, { value: "light", label: "light" }, { value: "dark", label: "dark" }] } } },
            { name: "map_aspect", selector: { text: {} } },
            { name: "station_color", selector: { text: {} } },
            { name: "language", selector: { select: { mode: "dropdown", options: [
                { value: "auto", label: "auto" }, ...LANGS.map((l) => ({ value: l, label: l }))] } } },
        ];
    }

    _advSchema() {
        return [
            { name: "latitude", selector: { text: {} } },
            { name: "longitude", selector: { text: {} } },
        ];
    }

    _lineSchema() {
        return [
            { name: "line", selector: { text: {} } },
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
        const lang = resolveLang(this._config, this._hass);
        // like the card: nothing is drawn until the strings are in, or the
        // form would come up labelled with its own field names
        if (!LANG[lang]) { LANG_WAITING.add(this); loadLang(lang); return; }
        if (!this._built) {
            this.innerHTML = "";
            // the lines ARE the entities: one multi picker replaces the
            // add-a-line dance, and the per line overrides move out of the way
            this._entForm = document.createElement("ha-form");
            this._entForm.addEventListener("value-changed", (ev) => this._entitiesChanged(ev));
            this.appendChild(this._entForm);
            // entities Home Assistant no longer knows, with a way out
            this._orphanBox = document.createElement("div");
            this.appendChild(this._orphanBox);
            this._globalForm = document.createElement("ha-form");
            this._globalForm.addEventListener("value-changed", (ev) => this._globalChanged(ev));
            this.appendChild(this._globalForm);

            this._lookSec = this._section("");
            this._lookForm = document.createElement("ha-form");
            this._lookForm.addEventListener("value-changed", (ev) => this._globalChanged(ev));
            this._lookSec.appendChild(this._lookForm);
            this.appendChild(this._lookSec);

            this._overSec = this._section("");
            this._linesBox = document.createElement("div");
            this._overSec.appendChild(this._linesBox);
            this.appendChild(this._overSec);

            this._advSec = this._section("");
            this._advForm = document.createElement("ha-form");
            this._advForm.addEventListener("value-changed", (ev) => this._globalChanged(ev));
            this._advSec.appendChild(this._advForm);
            this.appendChild(this._advSec);

            this._built = true;
            this._linesCount = -1;
        }
        const L = editorLabels(lang);
        this._lookSec.querySelector("summary").textContent = L.sec_look;
        this._overSec.querySelector("summary").textContent = L.sec_over;
        this._advSec.querySelector("summary").textContent = L.sec_adv;

        this._entForm.hass = this._hass;
        this._entForm.schema = this._entitiesSchema();
        this._entForm.computeLabel = () => L.entities;
        const ents = this._lines.map((l) => l.entity).filter(Boolean);
        const ejson = JSON.stringify(ents);
        if (ejson !== this._lastEnts) { this._lastEnts = ejson; this._entForm.data = { entities: ents }; }
        this._renderOrphans(L);
        this._globalForm.hass = this._hass;
        this._globalForm.schema = this._globalSchema(L);
        this._globalForm.computeLabel = (s) => L[s.name] ?? s.name;
        const gdata = {
            title: this._config.title ?? "",
            max_departures: this._config.max_departures ?? DEFAULTS.max_departures,
            refresh: this._config.refresh ?? DEFAULTS.refresh,
            mode_icons: this._config.mode_icons !== false,
            show_departures: this._config.show_departures !== false,
            show_map: this._config.show_map !== false,
            show_duration: this._config.show_duration === true,
            departures_view: this._config.departures_view === "table" ? "table" : "list",
        };
        // reassigning .data re-renders ha-form (and can steal the caret while
        // typing): only push it when a value actually changed
        const gjson = JSON.stringify(gdata);
        if (gjson !== this._lastGlobalData) { this._lastGlobalData = gjson; this._globalForm.data = gdata; }

        this._lookForm.hass = this._hass;
        this._lookForm.schema = this._lookSchema(lang);
        this._lookForm.computeLabel = (f) => L[f.name] ?? f.name;
        const ldata = {
            map_style: this._config.map_style ?? "auto",
            map_aspect: this._config.map_aspect ?? "",
            station_color: this._config.station_color ?? "",
            language: this._config.language ?? "auto",
        };
        const ljson = JSON.stringify(ldata);
        if (ljson !== this._lastLookData) { this._lastLookData = ljson; this._lookForm.data = ldata; }

        this._advForm.hass = this._hass;
        this._advForm.schema = this._advSchema();
        this._advForm.computeLabel = (f) => L[f.name] ?? f.name;
        const adata = {
            latitude: this._config.latitude != null ? String(this._config.latitude) : "",
            longitude: this._config.longitude != null ? String(this._config.longitude) : "",
        };
        const ajson = JSON.stringify(adata);
        if (ajson !== this._lastAdvData) { this._lastAdvData = ajson; this._advForm.data = adata; }
        if (this._linesCount !== this._lines.length) this._buildLines();
        else (this._lineForms || []).forEach((f) => { f.hass = this._hass; });
    }

    _langArrived(code) {
        if (code !== resolveLang(this._config, this._hass)) return;
        LANG_WAITING.delete(this);
        this._render();
    }

    disconnectedCallback() {
        LANG_WAITING.delete(this);
    }

    // the entity picker is the source of truth for which lines exist: keep
    // the overrides of the entities that stay, drop those of the ones removed
    // A configured entity that Home Assistant no longer has - renamed, or its
    // integration removed - still shows in the picker above, but as its whole
    // entity_id rather than a friendly name. A gtfs2 entity_id is long enough
    // to push that row's clear cross out of the dialog, and then the entity
    // cannot be removed at all. This strip lists those, in the editor's own
    // markup, where the name wraps and the button stays reachable.
    _renderOrphans(L) {
        const box = this._orphanBox;
        if (!box) return;
        const bad = this._lines.map((l) => l.entity)
            .filter((e) => e && this._hass && !this._hass.states[e]);
        const key = bad.join("|");
        if (key === this._lastOrphans) return;
        this._lastOrphans = key;
        box.innerHTML = "";
        if (!bad.length) return;
        box.style.cssText = "border: 1px solid var(--error-color, #b3261e); border-radius: 10px;"
            + " padding: 8px 10px; margin-top: 8px;";
        const hint = document.createElement("div");
        hint.style.cssText = "color: var(--secondary-text-color); font-size: 12px; margin-bottom: 6px;";
        hint.textContent = L.orphan_hint || "";
        box.appendChild(hint);
        for (const id of bad) {
            const row = document.createElement("div");
            row.style.cssText = "display: flex; align-items: center; gap: 8px; padding: 3px 0;";
            const name = document.createElement("code");
            // break-all, not break-word: an entity_id is one long token and
            // break-word would leave it hanging over the edge unbroken
            name.style.cssText = "flex: 1; min-width: 0; font-size: 12px; word-break: break-all;"
                + " color: var(--primary-text-color);";
            name.textContent = id;
            const btn = document.createElement("button");
            btn.type = "button";
            btn.textContent = L.orphan_remove || "x";
            btn.style.cssText = "flex: none; min-height: 32px; padding: 0 12px; border-radius: 8px;"
                + " border: 1px solid var(--error-color, #b3261e); background: none; cursor: pointer;"
                + " font-family: inherit; font-size: 13px; color: var(--error-color, #b3261e);";
            btn.addEventListener("click", () => this._dropEntity(id));
            row.append(name, btn);
            box.appendChild(row);
        }
    }

    _dropEntity(id) {
        this._lines = this._lines.filter((l) => l.entity !== id);
        this._lastEnts = null;
        this._lastOrphans = null;
        this._buildLines();
        this._emit();
        this._render();
    }

    _entitiesChanged(ev) {
        ev.stopPropagation();
        const picked = ev.detail?.value?.entities;
        if (!Array.isArray(picked)) return;
        const prev = new Map(this._lines.filter((l) => l.entity).map((l) => [l.entity, l]));
        this._lines = picked.map((e) => prev.get(e) || { entity: e });
        this._lastEnts = null;
        this._lastOrphans = null;
        this._buildLines();
        this._emit();
    }

    _buildLines() {
        const lang = resolveLang(this._config, this._hass);
        const L = editorLabels(lang);
        this._linesBox.innerHTML = "";
        this._lineForms = [];
        if (!this._lines.length) {
            const hint = document.createElement("div");
            hint.style.cssText = "color: var(--secondary-text-color); padding: 6px 0; font-size: 13px;";
            hint.textContent = L.no_line;
            this._linesBox.appendChild(hint);
            this._linesCount = 0;
            return;
        }
        this._lines.forEach((l, i) => {
            const box = document.createElement("div");
            box.style.cssText = "border: 1px solid var(--divider-color); border-radius: 10px; padding: 10px 12px; margin-top: 10px;";
            const title = document.createElement("div");
            title.style.cssText = "font-weight: 500; color: var(--primary-text-color);";
            title.textContent = l.entity || `${L.line_n} ${i + 1}`;
            box.appendChild(title);
            // what the card derived, so an empty field reads as "automatic"
            const derived = l.entity ? this._derivedText(l.entity, lang) : "";
            if (derived) {
                const sub = document.createElement("div");
                sub.style.cssText = "color: var(--secondary-text-color); font-size: 12px; margin: 2px 0 6px;";
                sub.textContent = `${L.derived}: ${derived}`;
                box.appendChild(sub);
            }
            const form = document.createElement("ha-form");
            form.hass = this._hass;
            form.schema = this._lineSchema();
            form.computeLabel = (f) => L["l_" + f.name] ?? f.name;
            form.data = {
                line: l.line ?? "",
                positions_url: l.positions_url ?? "",
                route_url: l.route_url ?? "",
            };
            form.addEventListener("value-changed", (ev) => {
                ev.stopPropagation();
                this._lines[i] = { ...this._lines[i], ...(ev.detail.value || {}) };
                this._emit();
            });
            box.appendChild(form);
            this._linesBox.appendChild(box);
            this._lineForms.push(form);
        });
        this._linesCount = this._lines.length;
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
            if (val === undefined || val === "" || val === null || (autoDeletes && val === "auto")) delete c[key];
            else c[key] = val;
        };
        assign("max_departures", false);
        assign("refresh", false);
        assign("map_style", true);
        assign("map_aspect", false);
        assign("station_color", false);
        assign("language", true);
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
        // list is the default: only the table layout earns a line of YAML
        if (has("departures_view")) {
            if (v.departures_view === "table") c.departures_view = "table"; else delete c.departures_view;
        }
        this._emit();
    }

    _emit() {
        const config = { ...this._config };
        config.lines = this._lines.map((l) => {
            const o = {};
            for (const k of ["entity", "positions_url", "route_url", "line", "color"]) {
                if (l[k] != null && l[k] !== "") o[k] = l[k];
            }
            // an entry reduced to its sensor collapses to the minimal string form
            return Object.keys(o).length === 1 && o.entity ? o.entity : o;
        });
        // the lines list absorbs the legacy top-level source keys
        delete config.entity;
        delete config.positions_url;
        delete config.route_url;
        delete config.line;
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
});
