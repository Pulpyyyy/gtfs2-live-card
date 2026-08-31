#!/usr/bin/env python3
"""Garde-fou du dépôt : la parité des cinq fichiers de langue.

dist/ est la source, servie telle quelle par HACS ; ce qui peut dériver,
ce sont les fichiers de langue. Une clé ajoutée en anglais et oubliée
ailleurs s'affiche brute dans l'interface ("add_return"), une clé en trop
est du poids mort. Le contrôle compare donc, section par section, les
clés de chaque langue à celles de l'anglais, et échoue à la moindre
différence.

    python build.py --check
"""

import re
import sys
from pathlib import Path

LANG_DIR = Path(__file__).parent / "dist" / "lang"
REFERENCE = "en"

SECTION = re.compile(r"^    (\w+): \{")
KEY = re.compile(r"^        (\w+):")


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


def main():
    ref_file = LANG_DIR / f"{REFERENCE}.js"
    ref = keys_of(ref_file)
    if not ref:
        print(f"impossible de lire des sections dans {ref_file}")
        return 1
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
        return 1
    langs = len(list(LANG_DIR.glob("*.js"))) - 1
    print(f"parité OK: {langs} langues alignées sur {REFERENCE} "
          f"({total} clés, {len(ref)} sections)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
