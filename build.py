#!/usr/bin/env python3
"""Garde-fous du dépôt : la parité des fichiers de langue, et MapLibre.

dist/ est la source, servie telle quelle par HACS ; ce qui peut dériver,
ce sont les fichiers de langue et la copie de MapLibre livrée avec la
carte.

Langues : une clé ajoutée en anglais et oubliée ailleurs s'affiche brute
dans l'interface ("add_return"), une clé en trop est du poids mort. Le
contrôle compare, section par section, les clés de chaque langue à celles
de l'anglais, et échoue à la moindre différence.

MapLibre : la carte le charge depuis dist/maplibre-gl-<version>/, la
version étant celle de MAPLIBRE_VERSION dans la carte, seule source de
vérité. Le contrôle télécharge le paquet npm de cette version, vérifie son
empreinte sha512 publiée par npm, et exige que chaque fichier livré lui
soit identique, à la ligne sourceMappingURL près (les .map ne sont pas
livrés). La version est dans le nom du dossier : les imports internes de
MapLibre (shared, worker) n'ont pas de paramètre, et un changement de
version doit changer leurs adresses, sinon le navigateur garde l'ancienne.

    python build.py --check       les deux contrôles (la CI)
    python build.py --maplibre    remplit dist/maplibre-gl-<version>/
"""

import base64
import hashlib
import io
import json
import re
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent
DIST = ROOT / "dist"
LANG_DIR = DIST / "lang"
CARD = DIST / "gtfs2-live-card.js"
REFERENCE = "en"

SECTION = re.compile(r"^    (\w+): \{")
KEY = re.compile(r"^        (\w+):")

# ce que la carte charge de MapLibre : le module, ce qu'il importe, son
# worker, sa feuille de style, et sa licence à côté d'eux
MAPLIBRE_FILES = {
    "maplibre-gl.mjs": "package/dist/maplibre-gl.mjs",
    "maplibre-gl-shared.mjs": "package/dist/maplibre-gl-shared.mjs",
    "maplibre-gl-worker.mjs": "package/dist/maplibre-gl-worker.mjs",
    "maplibre-gl.css": "package/dist/maplibre-gl.css",
    "LICENSE.txt": "package/LICENSE.txt",
}
VERSION = re.compile(r'^const MAPLIBRE_VERSION = "([^"]+)";', re.M)
SOURCE_MAP = re.compile(rb"\n?//# sourceMappingURL=\S+\s*$")


def keys_of(path):
    """Les clés du fichier, groupées par section de premier niveau."""
    sections = {}
    current = None
    for line in path.read_text(encoding="utf-8").splitlines():
        m = SECTION.match(line)
        if m:
            current = m.group(1)
            sections.setdefault(current, set())
            continue
        m = KEY.match(line)
        if m and current:
            sections[current].add(m.group(1))
    return sections


def check_langs():
    ref_file = LANG_DIR / f"{REFERENCE}.js"
    ref = keys_of(ref_file)
    if not ref:
        print(f"impossible de lire des sections dans {ref_file}")
        return False
    total = sum(len(v) for v in ref.values())
    failed = False
    for path in sorted(LANG_DIR.glob("*.js")):
        lang = path.stem
        if lang == REFERENCE:
            continue
        got = keys_of(path)
        for section in sorted(set(ref) | set(got)):
            missing = ref.get(section, set()) - got.get(section, set())
            extra = got.get(section, set()) - ref.get(section, set())
            for k in sorted(missing):
                print(f"{lang}.js: clé manquante {section}.{k}")
                failed = True
            for k in sorted(extra):
                print(f"{lang}.js: clé en trop {section}.{k}")
                failed = True
    if failed:
        return False
    langs = len(list(LANG_DIR.glob("*.js"))) - 1
    print(f"parité OK: {langs} langues alignées sur {REFERENCE} "
          f"({total} clés, {len(ref)} sections)")
    return True


def maplibre_version():
    m = VERSION.search(CARD.read_text(encoding="utf-8"))
    if not m:
        raise SystemExit(f"MAPLIBRE_VERSION introuvable dans {CARD}")
    return m.group(1)


def maplibre_reference(version):
    """Les fichiers du paquet npm de cette version, tels que la carte les
    livre : l'archive vérifiée contre l'empreinte que npm publie, la ligne
    sourceMappingURL retirée."""
    with urllib.request.urlopen(f"https://registry.npmjs.org/maplibre-gl/{version}") as r:
        meta = json.load(r)["dist"]
    with urllib.request.urlopen(meta["tarball"]) as r:
        tgz = r.read()
    algo, _, expected = meta["integrity"].partition("-")
    if algo != "sha512" or base64.b64encode(hashlib.sha512(tgz).digest()).decode() != expected:
        raise SystemExit(f"maplibre-gl {version} : l'archive ne correspond pas à l'empreinte npm")
    out = {}
    with tarfile.open(fileobj=io.BytesIO(tgz), mode="r:gz") as tar:
        for name, member in MAPLIBRE_FILES.items():
            data = tar.extractfile(member).read()
            out[name] = SOURCE_MAP.sub(b"\n", data) if name.endswith(".mjs") else data
    return out


def check_maplibre():
    version = maplibre_version()
    folder = DIST / f"maplibre-gl-{version}"
    others = [p.name for p in DIST.glob("maplibre-gl-*") if p != folder]
    ok = True
    if others:
        print(f"MapLibre : dossiers d'une autre version dans dist/ : {', '.join(others)}")
        ok = False
    ref = maplibre_reference(version)
    for name, data in ref.items():
        path = folder / name
        if not path.exists():
            print(f"MapLibre {version} : {path.relative_to(ROOT)} manquant")
            ok = False
        elif path.read_bytes() != data:
            print(f"MapLibre {version} : {path.relative_to(ROOT)} diffère du paquet npm")
            ok = False
    extra = sorted(p.name for p in folder.iterdir() if p.name not in ref) if folder.exists() else []
    if extra:
        print(f"MapLibre {version} : fichiers en trop dans {folder.relative_to(ROOT)} : {', '.join(extra)}")
        ok = False
    if ok:
        print(f"MapLibre OK: {len(ref)} fichiers identiques au paquet npm maplibre-gl@{version}")
    return ok


def write_maplibre():
    version = maplibre_version()
    ref = maplibre_reference(version)
    for old in DIST.glob("maplibre-gl-*"):
        shutil.rmtree(old)
    folder = DIST / f"maplibre-gl-{version}"
    folder.mkdir()
    for name, data in ref.items():
        (folder / name).write_bytes(data)
    print(f"MapLibre {version} : {len(ref)} fichiers écrits dans {folder.relative_to(ROOT)}")


def main():
    if "--maplibre" in sys.argv[1:]:
        write_maplibre()
        return 0
    langs = check_langs()
    maplibre = check_maplibre()
    return 0 if langs and maplibre else 1


if __name__ == "__main__":
    sys.exit(main())
