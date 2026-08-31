#!/usr/bin/env python3
"""Photograph the card, page by page, from screenshot-harness.html.

The harness loads the real card with a frozen snapshot of the TAO network in
Orléans (see data/). Chrome opens each page and writes a PNG into images/.

    python docs/shots.py                 every page, light and dark
    python docs/shots.py hero lines      only those pages
    python docs/shots.py --lang en       in another language

The card fetches its translations as ES modules, which a file:// page is not
allowed to do, so the script serves the repository over HTTP on a free port
for the duration of the run.
"""

import argparse
import http.server
import re
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
IMAGES = ROOT / "images"

# The width each page is laid out at, and a starting height. The height is
# only a first guess: the harness measures what it actually drew and the
# screenshot is taken at that size, so a page that grows is not cropped.
PAGES = {
    "hero":       (560, 920),   # the three lines together, departures and map
    "lines":      (740, 560),   # one card per line, side by side
    "departures": (470, 780),   # the board alone, map collapsed
    "map":        (520, 620),   # the map alone, vehicles on their shapes
    "noposition": (520, 620),   # a source with no realtime: route drawn anyway
    "entete12":   (560, 760),   # twelve badges, one selected: the full-height text zone
    "badges":     (620, 320),   # the badge marks, one per state, README legend
    "selected":   (540, 900),   # one line picked from its header badge
    "popup":      (520, 640),   # one vehicle tracked, its bubble open
    # Chrome headless will not open a window narrower than ~500 px, so the
    # narrow page asks for that and the harness sizes the card inside it.
    "narrow":     (500, 700),   # a sidebar-width column
    "editor":     (460, 900),   # the visual editor, sections open
}

CHROME_CANDIDATES = [
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]


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


def serve(root: Path):
    """Serve `root` on a free port, in a thread, for the run."""
    handler = type("Quiet", (http.server.SimpleHTTPRequestHandler,), {
        "log_message": lambda *a, **k: None,
        "directory": str(root),
    })
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    httpd = socketserver.TCPServer(("127.0.0.1", port), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def measure(chrome, port, page, mode, lang, size):
    """Ask the page how tall it actually is.

    A window too short crops the last card and nothing says so, so the harness
    reports the height it needs in document.title once it has drawn, and the
    screenshot is taken at that height rather than at a number kept by hand.
    """
    w, h = size
    url = (f"http://127.0.0.1:{port}/docs/screenshot-harness.html"
           f"?page={page}&mode={mode}&lang={lang}")
    r = subprocess.run(
        [chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
         "--virtual-time-budget=20000", f"--window-size={w},{h}",
         "--dump-dom", url],
        capture_output=True, text=True, timeout=120)
    m = re.search(r"<title>ready (\d+)x(\d+) ", r.stdout)
    if not m:
        # the page never finished: keep the configured size and let the
        # screenshot show whatever went wrong
        return size
    # only the height is measured: the width stays as configured, since a
    # fluid page stretches to its window and measuring it would be circular
    return w, int(m.group(2))


def shoot(chrome, port, page, mode, lang, size, scale, out):
    w, h = size
    url = (f"http://127.0.0.1:{port}/docs/screenshot-harness.html"
           f"?page={page}&mode={mode}&lang={lang}")
    # --virtual-time-budget lets the page's timers run at full speed and holds
    # the screenshot until they are done: the card fetches its language, its
    # positions and its map tiles before it has anything to show.
    cmd = [
        chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--hide-scrollbars", "--force-device-scale-factor=" + str(scale),
        "--virtual-time-budget=20000",
        f"--window-size={w},{h}",
        f"--screenshot={out}",
        url,
    ]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if not out.exists():
        raise SystemExit(f"{page}/{mode}: Chrome wrote nothing.\n"
                         f"{r.stderr.strip()[:800]}")
    return out.stat().st_size


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("pages", nargs="*", help=f"pages to shoot (default: all of {', '.join(PAGES)})")
    ap.add_argument("--lang", default="fr", help="card language (default fr)")
    ap.add_argument("--mode", choices=["light", "dark", "both"], default="both")
    ap.add_argument("--scale", type=int, default=2, help="device pixel ratio (default 2)")
    args = ap.parse_args()

    pages = args.pages or list(PAGES)
    unknown = [p for p in pages if p not in PAGES]
    if unknown:
        raise SystemExit(f"unknown page(s): {', '.join(unknown)}. "
                         f"Known: {', '.join(PAGES)}")

    snap = ROOT / "docs" / "data" / "snapshot.json"
    if not snap.exists():
        raise SystemExit("docs/data/snapshot.json is missing: run "
                         "`python docs/data/snapshot.py` first.")

    chrome = find_chrome()
    IMAGES.mkdir(exist_ok=True)
    httpd, port = serve(ROOT)
    print(f"chrome: {chrome}")
    print(f"serving {ROOT} on 127.0.0.1:{port}\n")

    modes = ["light", "dark"] if args.mode == "both" else [args.mode]
    total = 0
    try:
        for page in pages:
            for mode in modes:
                out = IMAGES / f"{page}-{mode}.png"
                out.unlink(missing_ok=True)
                size = measure(chrome, port, page, mode, args.lang, PAGES[page])
                written = shoot(chrome, port, page, mode, args.lang, size,
                                args.scale, out)
                total += written
                print(f"  {out.name:26} {written / 1024:6.0f} kB  "
                      f"{size[0]}×{size[1]}")
    finally:
        httpd.shutdown()
    print(f"\n{len(pages) * len(modes)} images, {total / 1024:.0f} kB in {IMAGES.name}/")


if __name__ == "__main__":
    main()
