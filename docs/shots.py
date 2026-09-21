#!/usr/bin/env python3
"""Photograph the card, page by page, from screenshot-harness.html.

The harness loads the real card with a frozen snapshot of the TAO network in
Orléans (see data/). Chrome opens each page and writes a PNG into images/.

    python docs/shots.py                 every page, light and dark
    python docs/shots.py hero selected   only those pages
    python docs/shots.py --lang en       in another language
    python docs/shots.py --stock --out /tmp/stock   as on a stock gtfs2

The card fetches its translations as ES modules, which a file:// page is not
allowed to do, so the script serves the repository over HTTP on a free port
for the duration of the run. The base map is MapLibre drawing VersaTiles
styles, both fetched from their CDN by the card itself: Chrome needs the
internet, and the script drives it through the DevTools protocol (one
Chrome for the run, one tab per image) because the base map only settles in
real time, which Chrome's one-shot --screenshot cannot wait for.

Requires the websocket-client package:  pip install websocket-client
"""

import argparse
import base64
import functools
import http.server
import json
import re
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

try:
    import websocket
except ImportError:  # pragma: no cover
    raise SystemExit("shots.py drives Chrome over DevTools: pip install websocket-client")

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
IMAGES = ROOT / "images"

# The width each page is laid out at, and a starting height. The height is
# only a first guess: the harness measures what it actually drew and the
# screenshot is taken at that size, so a page that grows is not cropped.
PAGES = {
    "hero":       (560, 920),   # the three lines together, departures and map
    "selected":   (540, 900),   # one line picked from its badge in the Lines view
    "journey":    (560, 920),   # a line and a two-leg journey: one board by departure, the change on its timeline
    "destinations": (470, 900), # the header: three departures, the arrival from one, ways to leave, a forced colour
    "struck":     (470, 1100),  # a cancelled run, one not stopping, alerts on their rows; a skipped stop on a timeline
    "boarding":   (540, 900),   # runs that take nobody on or set nobody down where the journey needs them
    "board":      (680, 470),   # the departures pane as a table (Lines view)
    "popup":      (520, 640),   # one vehicle tracked, its bubble open
    "editor":     (460, 900),   # the visual editor, sections open
    "pips":       (2264, 120),  # the chip's marks in a row, cut into one file each
}

# The pips page lays the chip's marks in one row, each alone and centred in
# its tile: the line plate (its mode on the band) and the three state marks
# in 88 px tiles, then
# four whole chips in 280 px tiles as corner-position schematics. The sheet
# is cut into one small file per tile (pip-<name>-<mode>.png), which is what
# the README's legend table embeds. Each entry is (tile width, crop width,
# crop height) in CSS px: 48 holds the 26 x 34 px plate, 30 a 22 px mark, and
# 236 x 84 a chip with its marks overhanging. The names follow the tiles left
# to right: the order is the harness's.
PIPS = {"bus": (88, 48, 48), "tram": (88, 48, 48), "metro": (88, 48, 48), "train": (88, 48, 48),
        "trolleybus": (88, 48, 48), "ferry": (88, 48, 48),
        "mute": (88, 30, 30), "alert": (88, 30, 30), "works": (88, 30, 30), "incident": (88, 30, 30),
        "tomorrow": (88, 30, 30), "days": (88, 30, 30), "never": (88, 30, 30),
        "pos-mode": (280, 236, 84), "pos-tl": (280, 236, 84), "pos-tr": (280, 236, 84), "pos-bl": (280, 236, 84)}

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

READY_TIMEOUT = 60      # seconds a page gets to declare itself ready


def find_chrome():
    for c in CHROME_CANDIDATES:
        if Path(c).exists():
            return c
    for name in ("google-chrome", "chromium", "chrome"):
        found = shutil.which(name)
        if found:
            return found
    raise SystemExit(
        "Chrome not found. Install it, or add its path to CHROME_CANDIDATES.\n"
        "Edge will not do: its headless mode writes no file on Windows.")


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class Handler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a, **k):
        pass


def serve(root: Path):
    """Serve `root` on a free port, in a thread, for the run."""
    # `directory` is an __init__ argument, not a class attribute: without the
    # partial the handler serves the current directory, which is only right
    # when the script is run from the repository root.
    handler = functools.partial(Handler, directory=str(root))
    port = free_port()
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", port), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


class Chrome:
    """One headless Chrome for the run, driven over the DevTools protocol.

    A throwaway profile keeps the user's own Chrome out of it, and software
    WebGL (SwiftShader) lets MapLibre draw where headless has no GPU.
    """

    def __init__(self, exe):
        self.profile = tempfile.mkdtemp(prefix="gtfs2-shots-")
        self.port = free_port()
        self.proc = subprocess.Popen(
            [exe, "--headless=new", "--no-sandbox", "--hide-scrollbars",
             "--enable-unsafe-swiftshader", "--disable-extensions",
             f"--remote-debugging-port={self.port}",
             "--remote-allow-origins=*",    # the DevTools socket takes our loopback client
             f"--user-data-dir={self.profile}",
             "--window-size=1200,900", "about:blank"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(100):
            try:
                self._http("/json/version")
                return
            except (urllib.error.URLError, OSError):
                time.sleep(0.1)
        self.close()
        raise SystemExit("Chrome did not open its DevTools port")

    def _http(self, path, method="GET"):
        req = urllib.request.Request(f"http://127.0.0.1:{self.port}{path}", method=method)
        with urllib.request.urlopen(req, timeout=5) as r:
            body = r.read()
        # /json/close answers a plain "Target is closing"
        return json.loads(body) if body.startswith(b"{") else body.decode(errors="replace")

    def tab(self):
        # a new target opens on about:blank: the viewport is set before the
        # page is navigated, so the harness lays out at the right width from
        # the first frame
        info = self._http("/json/new?about:blank", method="PUT")
        return Tab(self, info)

    def close(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)


class Tab:
    def __init__(self, chrome, info):
        self.chrome = chrome
        self.id = info["id"]
        self.ws = websocket.create_connection(info["webSocketDebuggerUrl"], timeout=30)
        self.seq = 0

    def call(self, method, **params):
        self.seq += 1
        self.ws.send(json.dumps({"id": self.seq, "method": method, "params": params}))
        while True:
            msg = json.loads(self.ws.recv())
            if msg.get("id") == self.seq:
                if "error" in msg:
                    raise RuntimeError(f"{method}: {msg['error']}")
                return msg.get("result", {})

    def eval(self, expression):
        r = self.call("Runtime.evaluate", expression=expression, returnByValue=True)
        return r.get("result", {}).get("value")

    def viewport(self, w, h, scale):
        self.call("Emulation.setDeviceMetricsOverride", width=w, height=h,
                  deviceScaleFactor=scale, mobile=False)

    def close(self):
        try:
            self.ws.close()
        finally:
            try:
                self.chrome._http(f"/json/close/{self.id}")
            except (urllib.error.URLError, OSError):
                pass


# What --stock reports of each page once drawn: the harness's own error box,
# and what the cards show, so a page that renders "fine" but empty is seen.
STOCK_REPORT = """(() => {
  const cards = [...document.querySelectorAll("gtfs2-live-card")].map((c) => c.shadowRoot);
  const n = (sel) => cards.reduce((s, r) => s + (r ? r.querySelectorAll(sel).length : 0), 0);
  return JSON.stringify({ errors: (document.getElementById("fatal").textContent || "").trim(),
    rows: n(".row"), journeys: n(".jseg"), broken: n(".jbroken"), stops: n(".stop"),
    routes: n("path.route, polyline, path") });
})()"""


def shoot(chrome, port, page, mode, lang, size, scale, out, stock=False):
    """Open the page, wait for its own ready signal, photograph at its height.

    A window too short crops the last card and nothing says so, so the harness
    reports the height it needs in document.title once it has drawn (and once
    the base map is at rest), and the screenshot is taken at that height rather
    than at a number kept by hand.
    """
    w, h = size
    url = (f"http://127.0.0.1:{port}/docs/screenshot-harness.html"
           f"?page={page}&mode={mode}&lang={lang}" + ("&stock=1" if stock else ""))
    tab = chrome.tab()
    try:
        tab.viewport(w, h, scale)
        tab.call("Page.navigate", url=url)
        deadline = time.time() + READY_TIMEOUT
        m = None
        while time.time() < deadline:
            m = re.match(r"(ready|late) (\d+)x(\d+) ", tab.eval("document.title") or "")
            if m:
                break
            time.sleep(0.2)
        # "late": the harness gave up waiting for what the page must show (a
        # destination chip, the base map at rest...). A picture of that is
        # wrong and looks almost right, so the run stops here
        if m and m.group(1) == "late":
            raise SystemExit(f"{page}/{mode}: the page never showed what it is for "
                             f"(the harness's ready() check); nothing written")
        if not m:
            raise SystemExit(f"{page}/{mode}: the harness never said ready "
                             f"(title: {tab.eval('document.title')!r})")
        # only the height is measured: the width stays as configured, since a
        # fluid page stretches to its window and measuring it would be circular
        hh = int(m.group(3))
        if hh != h:
            tab.viewport(w, hh, scale)
            time.sleep(0.4)   # one layout pass at the new height
        data = tab.call("Page.captureScreenshot", format="png")["data"]
        out.write_bytes(base64.b64decode(data))
        report = json.loads(tab.eval(STOCK_REPORT))
    finally:
        tab.close()
    return (w, hh), out.stat().st_size, report


def crop_pips(sheet, mode, scale):
    """Cut the pips sheet into one image per round mark.

    The tiles come from the sheet's own width (the stage centres its fixed
    row), and each mark's centre from its own ink: the crop looks for the
    pixels that differ from the page background inside the tile rather than
    trusting a hand-derived offset, so a CSS nudge cannot silently cut a
    mark in half.
    """
    from PIL import Image, ImageChops
    img = Image.open(sheet).convert("RGB")
    row = sum(tile for tile, _, _ in PIPS.values()) * scale
    x0 = (img.width - row) // 2
    bg = Image.new("RGB", img.size, img.getpixel((0, 0)))
    diff = ImageChops.difference(img, bg).convert("L")
    # > 24 keeps antialiasing and the page background out of a mark's bbox;
    # a whole chip is centred on its own box, whose grey is only some 15
    # levels off the page: at 24 the crop saw the plate and the words alone,
    # all on the left, and cut the chip's right end off
    ink = diff.point(lambda v: v > 24 and 255)
    box_ink = diff.point(lambda v: v > 6 and 255)
    total = 0
    tx = x0
    for i, (name, (tile, cw, ch)) in enumerate(PIPS.items()):
        box = (box_ink if name.startswith("pos-") else ink).crop((tx, 0, tx + tile * scale, img.height)).getbbox()
        if not box:
            raise SystemExit(f"pips/{mode}: tile {i} ({name}) holds no mark")
        cx = tx + (box[0] + box[2]) // 2
        cy = (box[1] + box[3]) // 2
        hw, hh = cw * scale // 2, ch * scale // 2
        out = IMAGES / f"pip-{name}-{mode}.png"
        img.crop((cx - hw, cy - hh, cx + hw, cy + hh)).save(out)
        total += out.stat().st_size
        tx += tile * scale
    return total


def main():
    global IMAGES
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("pages", nargs="*", help=f"pages to shoot (default: all of {', '.join(PAGES)})")
    ap.add_argument("--lang", default="en", help="card language (default en)")
    ap.add_argument("--mode", choices=["light", "dark", "both"], default="both")
    ap.add_argument("--scale", type=int, default=2, help="device pixel ratio (default 2)")
    ap.add_argument("--out", type=Path, default=IMAGES,
                    help="folder for the PNGs (default images/, the documentation's)")
    ap.add_argument("--stock", action="store_true",
                    help="play a stock gtfs2 (no fork attribute, upstream route file, no leg or "
                         "timetable file) and report each page; needs --out, never images/")
    args = ap.parse_args()
    if args.stock and args.out == IMAGES:
        raise SystemExit("--stock draws what the documentation must not show: give --out")

    pages = args.pages or list(PAGES)
    unknown = [p for p in pages if p not in PAGES]
    if unknown:
        raise SystemExit(f"unknown page(s): {', '.join(unknown)}. "
                         f"Known: {', '.join(PAGES)}")

    snap = ROOT / "docs" / "data" / "snapshot.json"
    if not snap.exists():
        raise SystemExit("docs/data/snapshot.json is missing: run "
                         "`python docs/data/snapshot.py` first.")

    IMAGES = args.out
    IMAGES.mkdir(parents=True, exist_ok=True)
    httpd, port = serve(ROOT)
    chrome = Chrome(find_chrome())
    print(f"chrome: devtools on 127.0.0.1:{chrome.port}")
    print(f"serving {ROOT} on 127.0.0.1:{port}\n")

    modes = ["light", "dark"] if args.mode == "both" else [args.mode]
    total = 0
    try:
        for page in pages:
            for mode in modes:
                out = IMAGES / f"{page}-{mode}.png"
                out.unlink(missing_ok=True)
                size, written, report = shoot(chrome, port, page, mode, args.lang,
                                              PAGES[page], args.scale, out, args.stock)
                if args.stock:
                    print(f"  {out.name:26} stock: " + ", ".join(f"{k} {v}" for k, v in report.items() if k != "errors")
                          + (f"\n    ERRORS: {report['errors']}" if report["errors"] else ""))
                # a stock gtfs2 draws no rest or alert mark: its sheet is
                # kept whole, to be looked at, not cut into the legend's files
                if page == "pips" and not args.stock:
                    # the sheet is scaffolding: what ships is one small file
                    # per round mark, cut out of it
                    written = crop_pips(out, mode, args.scale)
                    out.unlink()
                    total += written
                    print(f"  pip-*-{mode}.png           {written / 1024:6.0f} kB  "
                          f"{len(PIPS)} marks")
                    continue
                total += written
                print(f"  {out.name:26} {written / 1024:6.0f} kB  "
                      f"{size[0]}×{size[1]}")
    finally:
        chrome.close()
        httpd.shutdown()
    print(f"\n{len(pages) * len(modes)} images, {total / 1024:.0f} kB in {IMAGES}/")


if __name__ == "__main__":
    main()
