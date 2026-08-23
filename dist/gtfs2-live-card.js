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
    positions_url: null,
    route_url: null,          // default: positions_url with ".json" → "_route.json"
    lines: null,              // list of entity_ids and/or {entity?, positions_url?, route_url?, line?, color?}
    mode_icons: true,         // mode chip (mdi) on the line badges
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
const STALE_FEED = 8 * 60000;  // a feed not refreshed this long = ghost buses (end of service)
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
        if (n === 2 || (n >= 100 && n < 300)) return "train";
        if (n === 3 || (n >= 700 && n < 800)) return "bus";
        if (n === 4 || n === 1200) return "ferry";
        if (n === 11 || n === 800) return "trolleybus";
        if (n === 6 || n === 1300) return "cable";
        if (n === 7 || n === 1400) return "funicular";
        if (n === 12) return "monorail";
        return "bus";
    }
    const s = String(rt || "").toLowerCase();
    for (const k of ["tram", "metro", "train", "ferry", "trolleybus", "funicular", "monorail"]) if (s.includes(k)) return k;
    if (s.includes("métro")) return "metro";
    if (s.includes("rail")) return "train";
    return "bus";
};


// mdi glyph outlines (24x24 grid) for the map markers: ha-icon is an HTML
// element and cannot live inside the map SVG, so the modes we know about
// carry their path here. An unknown mode falls back to the plain arrow.
// One glyph table for the whole card: these are the official mdi outlines
// (24x24 grid) behind mdi:bus, mdi:tram and friends. The map SVG cannot host
// an <ha-icon> HTML element, so the badges draw from this same table rather
// than from ha-icon, and a mode looks identical wherever it shows up.
const MDI_PATHS = {
    bus: "M18,11H6V6H18M16.5,17A1.5,1.5 0 0,1 15,15.5A1.5,1.5 0 0,1 16.5,14A1.5,1.5 0 0,1 18,15.5A1.5,1.5 0 0,1 16.5,17M7.5,17A1.5,1.5 0 0,1 6,15.5A1.5,1.5 0 0,1 7.5,14A1.5,1.5 0 0,1 9,15.5A1.5,1.5 0 0,1 7.5,17M4,16C4,16.88 4.39,17.67 5,18.22V20A1,1 0 0,0 6,21H7A1,1 0 0,0 8,20V19H16V20A1,1 0 0,0 17,21H18A1,1 0 0,0 19,20V18.22C19.61,17.67 20,16.88 20,16V6C20,2.5 16.42,2 12,2C7.58,2 4,2.5 4,6V16Z",
    trolleybus: "M18 8H6V4H18M16.5 14C15.7 14 15 13.3 15 12.5C15 11.7 15.7 11 16.5 11C17.3 11 18 11.7 18 12.5C18 13.3 17.3 14 16.5 14M7.5 14C6.7 14 6 13.3 6 12.5C6 11.7 6.7 11 7.5 11S9 11.7 9 12.5C9 13.3 8.3 14 7.5 14M4 13C4 13.9 4.4 14.7 5 15.2V17C5 17.6 5.4 18 6 18H7C7.6 18 8 17.6 8 17V16H16V17C16 17.6 16.4 18 17 18H18C18.6 18 19 17.6 19 17V15.2C19.6 14.7 20 13.9 20 13V4C20 .5 16.4 0 12 0S4 .5 4 4V13M7 21H11V19L17 22H13V24L7 21Z",
    tram: "M19,16.94V8.5C19,5.71 16.39,5.1 13,5L13.75,3.5H17V2H7V3.5H11.75L11,5C7.86,5.11 5,5.73 5,8.5V16.94C5,18.39 6.19,19.6 7.59,19.91L6,21.5V22H8.23L10.23,20H14L16,22H18V21.5L16.5,20H16.42C18.11,20 19,18.63 19,16.94M12,18.5A1.5,1.5 0 0,1 10.5,17A1.5,1.5 0 0,1 12,15.5A1.5,1.5 0 0,1 13.5,17A1.5,1.5 0 0,1 12,18.5M17,14H7V9H17V14Z",
    metro: "M18,11H13V6H18M16.5,17A1.5,1.5 0 0,1 15,15.5A1.5,1.5 0 0,1 16.5,14A1.5,1.5 0 0,1 18,15.5A1.5,1.5 0 0,1 16.5,17M11,11H6V6H11M7.5,17A1.5,1.5 0 0,1 6,15.5A1.5,1.5 0 0,1 7.5,14A1.5,1.5 0 0,1 9,15.5A1.5,1.5 0 0,1 7.5,17M12,2C7.58,2 4,2.5 4,6V15.5A3.5,3.5 0 0,0 7.5,19L6,20.5V21H18V20.5L16.5,19A3.5,3.5 0 0,0 20,15.5V6C20,2.5 16.42,2 12,2Z",
    train: "M12,2C8,2 4,2.5 4,6V15.5A3.5,3.5 0 0,0 7.5,19L6,20.5V21H8.23L10.23,19H14L16,21H18V20.5L16.5,19A3.5,3.5 0 0,0 20,15.5V6C20,2.5 16.42,2 12,2M7.5,17A1.5,1.5 0 0,1 6,15.5A1.5,1.5 0 0,1 7.5,14A1.5,1.5 0 0,1 9,15.5A1.5,1.5 0 0,1 7.5,17M11,10H6V6H11V10M13,10V6H18V10H13M16.5,17A1.5,1.5 0 0,1 15,15.5A1.5,1.5 0 0,1 16.5,14A1.5,1.5 0 0,1 18,15.5A1.5,1.5 0 0,1 16.5,17Z",
    ferry: "M6,6H18V9.96L12,8L6,9.96M3.94,19H4C5.6,19 7,18.12 8,17C9,18.12 10.4,19 12,19C13.6,19 15,18.12 16,17C17,18.12 18.4,19 20,19H20.05L21.95,12.31C22.03,12.06 22,11.78 21.89,11.54C21.76,11.3 21.55,11.12 21.29,11.04L20,10.62V6C20,4.89 19.1,4 18,4H15V1H9V4H6A2,2 0 0,0 4,6V10.62L2.71,11.04C2.45,11.12 2.24,11.3 2.11,11.54C2,11.78 1.97,12.06 2.05,12.31M20,21C18.61,21 17.22,20.53 16,19.67C13.56,21.38 10.44,21.38 8,19.67C6.78,20.53 5.39,21 4,21H2V23H4C5.37,23 6.74,22.65 8,22C10.5,23.3 13.5,23.3 16,22C17.26,22.65 18.62,23 20,23H22V21H20Z",
    cable: "M18,10H13V7.59L22.12,6.07L21.88,4.59L16.41,5.5C16.46,5.35 16.5,5.18 16.5,5A1.5,1.5 0 0,0 15,3.5A1.5,1.5 0 0,0 13.5,5C13.5,5.35 13.63,5.68 13.84,5.93L13,6.07V5H11V6.41L10.41,6.5C10.46,6.35 10.5,6.18 10.5,6A1.5,1.5 0 0,0 9,4.5A1.5,1.5 0 0,0 7.5,6C7.5,6.36 7.63,6.68 7.83,6.93L1.88,7.93L2.12,9.41L11,7.93V10H6C4.89,10 4,10.9 4,12V18A2,2 0 0,0 6,20H18A2,2 0 0,0 20,18V12A2,2 0 0,0 18,10M6,12H8.25V16H6V12M9.75,16V12H14.25V16H9.75M18,16H15.75V12H18V16Z",
    funicular: "M15 6H22V9H18V13H14V17H10V21H3V18H7V14H11V10H15V6M10.17 6.66L4.66 12.17L2.83 10.34L8.34 4.83L6.5 3H12V8.5L10.17 6.66Z",
    monorail: "M18,10H6V5H18M12,17C10.89,17 10,16.1 10,15C10,13.89 10.89,13 12,13A2,2 0 0,1 14,15A2,2 0 0,1 12,17M4,15.5A3.5,3.5 0 0,0 7.5,19L6,20.5V21H18V20.5L16.5,19A3.5,3.5 0 0,0 20,15.5V5C20,1.5 16.42,1 12,1C7.58,1 4,1.5 4,5V15.5Z",
    vehicle: "M18,11H6V6H18M16.5,17A1.5,1.5 0 0,1 15,15.5A1.5,1.5 0 0,1 16.5,14A1.5,1.5 0 0,1 18,15.5A1.5,1.5 0 0,1 16.5,17M7.5,17A1.5,1.5 0 0,1 6,15.5A1.5,1.5 0 0,1 7.5,14A1.5,1.5 0 0,1 9,15.5A1.5,1.5 0 0,1 7.5,17M4,16C4,16.88 4.39,17.67 5,18.22V20A1,1 0 0,0 6,21H7A1,1 0 0,0 8,20V19H16V20A1,1 0 0,0 17,21H18A1,1 0 0,0 19,20V18.22C19.61,17.67 20,16.88 20,16V6C20,2.5 16.42,2 12,2C7.58,2 4,2.5 4,6V16Z",
};

// the icon name each mode is known by, kept in step with MDI_PATHS so the
// badge and the map marker of one mode can never drift apart
const MDI_BY_MODE = {
    bus: "mdi:bus", tram: "mdi:tram", metro: "mdi:subway-variant", train: "mdi:train",
    ferry: "mdi:ferry", trolleybus: "mdi:bus-electric", cable: "mdi:gondola",
    funicular: "mdi:stairs-up", monorail: "mdi:train-variant", vehicle: "mdi:bus",
};

// ink box of each outline inside the 24-unit grid, as [x, y, w, h], measured
// with getBBox. mdi outlines leave up to a third of the grid empty, so scaling
// the grid makes every glyph look a size too small and the modes look uneven.
const MDI_BOX = {
    bus: [4, 2, 16, 19], trolleybus: [4, 0, 16, 24], tram: [5, 2, 14, 20],
    metro: [4, 2, 16, 19], train: [4, 2, 16, 19], ferry: [2, 1, 20, 22],
    cable: [1.88, 3.5, 20.24, 16.5], funicular: [2.83, 3, 19.17, 18],
    monorail: [4, 1, 16, 20], vehicle: [4, 2, 16, 19],
};

// mode glyph as a plain SVG path, centred on 0,0 and scaled so its INK spans
// about 2r. Returns null for a mode we carry no outline for.
const modeGlyph = (mode, r, fill) => {
    const d = MDI_PATHS[mode];
    if (!d) return null;
    const [bx, by, bw, bh] = MDI_BOX[mode] || [0, 0, 24, 24];
    const sc = (r * 2) / Math.max(bw, bh);
    const cx = (bx + bw / 2) * sc, cy = (by + bh / 2) * sc;
    return `<path d="${d}" fill="${fill}" transform="translate(${(-cx).toFixed(2)} ${(-cy).toFixed(2)}) scale(${sc.toFixed(4)})"></path>`;
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
            // no positions_url configured: derive it from the sensor,
            // vehicle_positions_file when the integration exposes it, else the
            // route/direction attributes a stock gtfs2 already carries.
            if (!purl && entity && this._hass) {
                const at = this._hass.states?.[entity]?.attributes || {};
                const file = attrVal(at, "vehicle_positions_file");
                const rid = attrVal(at, "route_route_id", "route_id");
                const dir = attrVal(at, "trip_direction_id", "direction_id");
                if (file) purl = "/local/gtfs2/" + file;
                else if (rid != null && dir != null) purl = `/local/gtfs2/${rid}_${dir}.json`;
                if (purl) this._remember(entity, { purl });
                else purl = this._emeta.get(entity)?.purl || null;
            }
            return {
                idx: i,
                entity,
                positions_url: purl,
                route_url: l.route_url || (purl ? purl.replace(/\.json$/, "_route.json") : null),
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
            d.icon = mdi || cached?.icon || MDI_BY_MODE[d.mode] || "mdi:bus";
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
        if (this._popAnim) { cancelAnimationFrame(this._popAnim); this._popAnim = null; }
    }

    _startPolling() {
        this._stopPolling();
        // an entity without positions_url may expose its attributes later:
        // keep polling armed as long as a source is possible
        if (!this._config || !this._lineDefs().some((d) => d.positions_url || d.entity)) return;
        this._fetchAll(true);
        this._timer = setInterval(() => this._fetchAll(), Math.max(15, this._config.refresh) * 1000);
    }

    _stopPolling() {
        if (this._timer) { clearInterval(this._timer); this._timer = null; }
    }

    _fetchAll(force) {
        if (document.hidden && !force) return;
        const period = Math.max(15, this._config.refresh) * 1000;
        for (const def of this._lineDefs()) {
            if (!def.positions_url) continue;
            const slot = this._ld[def.idx];
            // collapsed map only needs the count: poll five times slower
            if (!force && this._collapsed.map && slot && Date.now() - (slot.geoAt || 0) < period * 5) continue;
            this._fetchPositions(def);
            if (Date.now() - (slot?.routeAt || 0) > 60 * 60000) this._fetchRoute(def);
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
        const at = this.shadowRoot.querySelector(".map-attrib");
        if (at) {
            const newestAt = Math.max(0, ...this._ld.map((s) => s.sigAt || 0));
            at.textContent = this._t("map_updated", { t: newestAt ? fmtAgo(this._lang(), Date.now() - newestAt) : "…" });
        }
    }

    /* ── LOVELACE API ───────────────────────────────────────────────────── */

    getCardSize() { return 1 + (this._collapsed.dep ? 1 : 3) + (this._collapsed.map ? 1 : 4); }

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
        this._renderHeader();
        this._renderDepartures();
        this._renderMapSection();
        this._renderFooter();
        this._observeResize();
    }

    _activate(t) {
        this._act(t.dataset.action, t.dataset);
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
                    const own = d.icon && d.icon !== MDI_BY_MODE[d.mode || "bus"] ? d.icon : null;
                    const g = own ? null : modeGlyph(d.mode || "bus", 9.3, "currentColor");
                    chipInner = g
                        ? `<svg class="badge-glyph" viewBox="-11.5 -11.5 23 23" aria-hidden="true">${g}</svg>`
                        : `<ha-icon icon="${esc(own || d.icon || "mdi:bus")}"></ha-icon>`;
                }
                const chip = chipInner ? `<span class="badge-mode">${chipInner}</span>` : "";
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
                // -1 means the feed has no service left for this journey at all,
                // which deserves the mark as much as a long rest does
                const resting = Number.isFinite(nIn) && nIn !== 0;
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
                }
                // the label reads against its own line colour, the same rule
                // the map markers follow: a light line colour takes dark text
                const bg = d.color || this._config.line_color;
                const bink = inkOn(bg);
                // the mode chip's disc goes the other way round from the ink,
                // so the glyph keeps its contrast on light and dark lines alike
                // mixed INTO the line colour rather than left translucent: the
                // chip now overflows the badge, and a see-through disc would
                // pick up the card behind it and read as a cut-off half moon
                const chipBg = `color-mix(in srgb, ${bink === "#ffffff" ? "#000" : "#fff"} 40%, ${esc(bg)})`;
                // the resting note joins the destination in the tooltip, which
                // is the only place a badge can carry a sentence
                const restTitle = resting
                    ? (nIn < 0 ? this._t("resting_never")
                        : nIn === 1 ? this._t("resting_tomorrow")
                        : this._t("resting_days", { n: nIn }))
                    : "";
                const btitle = [bdest, restTitle].filter(Boolean).join(" · ");
                // the halo takes the ink the other way round, so it separates
                // the stroke from the badge whichever way the contrast runs
                const opp = bink === "#ffffff" ? "#1b1b1b" : "#ffffff";
                // the stroke says it visually and title says it on hover, but
                // neither reaches a screen reader: state it in the text layer
                const restSr = restTitle ? `<span class="sr-only">${esc(restTitle)}</span>` : "";
                return `<div class="badge ${many ? "clickable" : ""} ${sel ? "sel" : ""} ${dim ? "dim" : ""} ${resting ? "resting" : ""}" style="background:${esc(bg)};color:${bink};--chip-bg:${chipBg};--opp-ink:${opp}"${a11y} title="${esc(btitle)}"><span class="badge-num">${esc(this._lineLabelOf(d))}</span>${restSr}${chip}${rest}</div>`;
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
            const theo = (Array.isArray(a.next_departures) ? a.next_departures : []).map(parseTs).filter(Boolean);
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
                rows.push({ time: t, theo: theoT, rt: true, delayMin, def: src.def });
            });
            theo.forEach((th, j) => {
                if (!usedTheo.has(j)) rows.push({ time: th, theo: null, rt: false, delayMin: null, def: src.def });
            });
        }
        const cutoff = Date.now() - 60000;
        const upcoming = rows.filter((r) => r.time.getTime() > cutoff);
        upcoming.sort((x, y) => x.time - y.time);
        return { rows: upcoming.slice(0, this._config.max_departures), multi: sources.length > 1 };
    }

    _renderDepartures() {
        if (!this._built) return;   // no shell yet: see _renderHeader
        const head = this.shadowRoot.getElementById("dep-head");
        const body = this.shadowRoot.getElementById("dep-body");
        // map-only card (no departure sensor anywhere): hide the pane entirely
        if (!this._depSources().length) {
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

        const rowsHtml = rows.map((r) => {
            const strike = r.rt && r.theo && Math.abs(r.time - r.theo) >= 60000;
            const sub = r.rt
                ? (r.theo ? `<span class="sub ${strike ? "strike" : ""}">${this._t("scheduled_at", { t: fmtHM(r.theo) })}</span>` : `<span class="sub">${this._t("realtime")}</span>`)
                : `<span class="sub">${this._t("no_rt_yet")}</span>`;
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
                    ${sub}
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
        const emptyMsg = hiDef && !hiDef.entity ? this._t("no_dep_sensor")
            : (hiSt && hiSt.state === "unavailable" ? this._t("sensor_unavailable") : this._t("none_upcoming"));
        body.innerHTML = (rowsHtml || `<div class="empty">${emptyMsg}</div>`)
            + (chips.length ? `<div class="info-strip">${chips.join("")}</div>` : "");
    }

    /* ── PANE 2: MAP data ───────────────────────────────────────────────── */

    async _fetchPositions(def) {
        const slot = this._ld[def.idx];
        if (!slot) return;
        try {
            const maxAge = Math.max(15, this._config.refresh) * 500;
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
            }
        }
        this._scheduleRerender();
        this._renderFooter();
    }

    async _fetchRoute(def) {
        const slot = this._ld[def.idx];
        if (!slot || !def.route_url) return;
        slot.routeAt = Date.now();
        try {
            const gj = await fetchJsonShared(def.route_url, 5 * 60000);
            const lineFeat = (gj.features || []).find((f) => f.geometry?.type === "LineString");
            const stopFeats = (gj.features || []).filter((f) => f.geometry?.type === "Point");
            if (!lineFeat || !Array.isArray(lineFeat.geometry.coordinates)) { slot.route = null; return; }
            const line = lineFeat.geometry.coordinates.map(([lon, lat]) => this._world(lat, lon));
            const mPerU = this._mPerU(lineFeat.geometry.coordinates[0][1]);
            const cum = [0];
            for (let i = 1; i < line.length; i++) {
                cum.push(cum[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y) * mPerU);
            }
            const stops = stopFeats.map((f) => {
                const [lon, lat] = f.geometry.coordinates;
                const w = this._world(lat, lon);
                return {
                    ...w,
                    id: String(f.properties?.stop_id || ""),
                    name: String(f.properties?.stop_name || ""),
                    seq: f.properties?.stop_sequence,
                    cum: this._projectOnPolyline(w, line, cum).cum,
                };
            }).sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
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

    _projectOnPolyline(pt, line, cum) {
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
        return best;
    }

    // heading (degrees, 0 = north, clockwise) of the route at the point's
    // projection: the LineString follows the travel direction of the trip,
    // so this is the correct arrow orientation by construction. Returns null
    // when the point is too far from the route to trust it.
    _routeAngleAt(route, w) {
        const prj = this._projectOnPolyline(w, route.line, route.cum);
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
        head.setAttribute("aria-expanded", String(!this._collapsed.map));
        if (this._collapsed.map) {
            const count = this._liveBusCount();
            const stale = this._feedStaleAge();
            const summary = stale
                ? `<span class="summary warn">${this._t("feed_stale", { t: fmtAgo(this._lang(), stale) })}</span>`
                : `<span class="summary">${count ? this._busCountText(count) : "…"}</span>`;
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
        if (!this._lineDefs().some((d) => d.positions_url)) {
            this._renderMapHead();
            body.innerHTML = `<div class="empty">${this._t("no_source")}</div>`;
            this._mapDomReady = false;
            return;
        }
        this._renderMap(false);
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
                <span class="map-attrib"></span>
                <div class="map-scale"><i></i><span></span></div>
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
            const errSlot = this._ld.find((s) => s.err);
            const anyData = this._ld.some((s) => s.geoAt);
            const msg = errSlot ? this._t("unreachable") : (anyData ? this._t("no_bus") : this._t("loading"));
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
                    const prj = this._projectOnPolyline(busW, route.line, route.cum);
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
                if (route) angle = this._routeAngleAt(route, wpt);
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
                    && modeGlyph(def.mode || "bus", R * 0.52, ink))
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
                : `<span class="summary">${count ? this._busCountText(count) : "…"}</span>`;
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
        if (e.type === "pointerup" && this._moved <= 5 && this._pointers.size === 0) {
            if (t) {
                this._suppressClick = true; // the retargeted/native click must not re-activate
                this._activate(t);
            } else if (this._focus) {
                // a tap on the background closes the popup, view unchanged
                this._suppressClick = true;
                this._act("untrack", {});
            }
        }
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
        ha-card { overflow: hidden; font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
        .header { display: flex; align-items: center; gap: 12px; padding: 14px 16px 10px 16px; }
        .badges { display: flex; gap: 9px; flex-wrap: wrap; }
        .badge { position: relative; min-width: 60px; height: 60px; border-radius: 13px; color: #fff; display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 700; padding: 0 10px; box-sizing: border-box; }
        /* the mode chip rides on the badge itself: no disc, no outline, just
           the glyph in the badge's own ink, so it reads as part of the badge */
        /* a faint disc behind the glyph, tinted OPPOSITE to the ink: tinting it
           in the ink itself would put a white veil under a white glyph and
           swallow it. Set per badge as --chip-bg, since the ink depends on the
           line colour. */
        .badge-mode { position: absolute; right: -4px; bottom: -5px; width: 29px; height: 29px; border-radius: 50%; background: var(--chip-bg, color-mix(in srgb, #000 40%, transparent)); display: flex; align-items: center; justify-content: center; color: inherit; pointer-events: none; --mdc-icon-size: 24px; }
        .badge-mode ha-icon { display: flex; }
        /* a line with no service is struck through by a single diagonal, at
           65% so it stays a note rather than a warning: the number underneath
           must remain readable. The halo below the stroke carries the opposite
           ink, which is what keeps the stroke visible on a mid green or grey
           line, where 65% ink alone measures barely 2.2:1. */
        /* the number sits above the stroke, so the diagonal crosses the badge
           without burying the digits */
        .badge-num { position: relative; z-index: 3; line-height: 1; }
        /* read out, never drawn: the diagonal is the visual half of this */
        .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
        .badge-slash { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 2; pointer-events: none; opacity: 0.65; border-radius: 13px; }
        .slash-halo { stroke: var(--opp-ink, #000); stroke-width: 5.5; opacity: 0.55; }
        /* the number keeps its full ink: a line still shows its number when it
           is not running. Only the badge as a whole steps back a little. */
        .badge.resting { opacity: 0.92; }
        .badge.resting.sel { opacity: 1; }
        .badge-glyph { width: 24px; height: 24px; display: block; }
        .badge.clickable { cursor: pointer; }
        .badge.sel { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .badge.dim { opacity: 0.45; }
        .badge:focus-visible, .sect-head:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
        .titles { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .title { font-size: 16px; font-weight: 500; color: var(--primary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .subtitle, .sub, .summary { font-size: 13px; color: var(--secondary-text-color); }
        .subtitle { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
        .time-line { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
        .time { font-size: 20px; font-weight: 700; color: var(--primary-text-color); font-variant-numeric: tabular-nums; }
        .day-tag { font-size: 11px; color: var(--secondary-text-color); border: 1px solid var(--divider-color); border-radius: 6px; padding: 0 5px; align-self: center; flex: none; }
        .dest-inline { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .rt-icon { color: #4caf50; display: inline-flex; flex: none; }
        .sub.strike { text-decoration: line-through; }
        .sub { font-size: 12px; }
        .right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex: none; }
        .countdown { font-size: 14px; font-weight: 600; color: var(--primary-text-color); }
        .chip { display: inline-flex; padding: 2px 8px; border-radius: 12px; font-size: 12px; font-weight: 500; }
        .chip-late { background: rgba(230,81,0,.14); color: var(--gtfs2-late-color, #e65100); }
        .chip-early { background: rgba(3,105,161,.14); color: #0369a1; }
        .chip-ok { background: rgba(46,125,50,.14); color: var(--gtfs2-ontime-color, #2e7d32); }
        .chip-theo { background: rgba(127,127,127,.14); color: var(--secondary-text-color); }
        .info-strip { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--divider-color); }
        .info-chip { display: inline-flex; align-items: center; gap: 5px; padding: 3px 8px; border-radius: 8px; font-size: 11px; background: rgba(127,127,127,.12); color: var(--secondary-text-color); }
        .info-chip svg { flex: none; }
        .info-alert { background: rgba(230,81,0,.12); color: #e65100; }
        .empty { padding: 14px 16px; font-size: 13px; color: var(--secondary-text-color); }
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
        .map-btn { position: absolute; top: 8px; left: 8px; border: none; border-radius: 12px; padding: 7px 12px; font-size: 12px; font-weight: 500; font-family: inherit; background: var(--card-background-color, #fff); color: var(--primary-text-color); cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.2); }
        .map-ctrl { position: absolute; top: 8px; right: 8px; display: flex; flex-direction: column; gap: 6px; }
        .map-ctrl-btn { width: 36px; height: 36px; border: none; border-radius: 9px; background: var(--card-background-color, #fff); color: var(--primary-text-color); font-size: 18px; font-weight: 600; font-family: inherit; cursor: pointer; box-shadow: 0 1px 3px rgba(0,0,0,.2); display: flex; align-items: center; justify-content: center; padding: 0; }
        .map-scale { position: absolute; left: 8px; bottom: 6px; display: flex; align-items: center; gap: 5px; font-size: 9px; color: var(--secondary-text-color); background: color-mix(in srgb, var(--card-background-color, #fff) 75%, transparent); padding: 1px 5px; border-radius: 6px; pointer-events: none; }
        .map-scale i { display: block; height: 4px; border: 1px solid currentColor; border-top: none; box-sizing: border-box; }
        .map-attrib { position: absolute; right: 8px; bottom: 6px; font-size: 9px; color: var(--secondary-text-color); background: color-mix(in srgb, var(--card-background-color, #fff) 75%, transparent); padding: 1px 5px; border-radius: 6px; }
        .map-hint { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); background: rgba(0,0,0,.65); color: #fff; font-size: 12px; padding: 6px 12px; border-radius: 14px; pointer-events: none; opacity: 0; transition: opacity .25s; white-space: nowrap; }
        .map-hint.show { opacity: 1; }
        @media (prefers-reduced-motion: reduce) { .live-dot { animation: none; } .stop .dot, .map-hint, .bus, .bus .hd { transition: none; } }
        .map-pop { position: absolute; transform: translate(-50%, -100%); min-width: 150px; max-width: min(230px, calc(100% - 16px)); background: var(--card-background-color, #fff); color: var(--primary-text-color); border-radius: 10px; box-shadow: 0 2px 12px rgba(0,0,0,.35); padding: 8px 10px; font-size: 12px; }
        .pop-head { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; font-size: 13px; }
        .pop-dest { color: var(--primary-text-color); font-weight: 500; line-height: 1.5; }
        .pop-row { color: var(--secondary-text-color); line-height: 1.5; }
        .pop-row::first-letter { text-transform: uppercase; }
        .pop-close { border: none; background: none; color: var(--secondary-text-color); cursor: pointer; font-size: 13px; font-family: inherit; min-width: 28px; min-height: 28px; padding: 0; margin: -6px -8px -6px 0; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; }
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

    _globalSchema() {
        return [
            { name: "title", selector: { text: {} } },
            { name: "max_departures", selector: { number: { min: 1, max: 20, mode: "box" } } },
            { name: "refresh", selector: { number: { min: 15, max: 600, mode: "box", unit_of_measurement: "s" } } },
            { name: "mode_icons", selector: { boolean: {} } },
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
        this._globalForm.hass = this._hass;
        this._globalForm.schema = this._globalSchema();
        this._globalForm.computeLabel = (s) => L[s.name] ?? s.name;
        const gdata = {
            title: this._config.title ?? "",
            max_departures: this._config.max_departures ?? DEFAULTS.max_departures,
            refresh: this._config.refresh ?? DEFAULTS.refresh,
            mode_icons: this._config.mode_icons !== false,
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
    _entitiesChanged(ev) {
        ev.stopPropagation();
        const picked = ev.detail?.value?.entities;
        if (!Array.isArray(picked)) return;
        const prev = new Map(this._lines.filter((l) => l.entity).map((l) => [l.entity, l]));
        this._lines = picked.map((e) => prev.get(e) || { entity: e });
        this._lastEnts = null;
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
        if (has("mode_icons")) { if (v.mode_icons === false) c.mode_icons = false; else delete c.mode_icons; }
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
