#!/usr/bin/env python3
"""
Build the "linguistic chemistry" table for the Chinese Game of Life.

Nothing about which components combine into which characters is hard-coded:
every reaction is derived from real data.

  * makemeahanzi dictionary.txt -> IDS decompositions, pinyin, definitions
  * CC-CEDICT                   -> how common each character actually is

Emits data/hanzi.json.
"""

import json
import os
import re
import sys
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = HERE

# Ideographic Description Characters and how many operands each one takes.
IDC = {
    "⿰": 2,  # left to right
    "⿱": 2,  # above to below
    "⿲": 3,  # left to middle to right
    "⿳": 3,  # above to middle to below
    "⿴": 2,  # full surround
    "⿵": 2,  # surround from above
    "⿶": 2,  # surround from below
    "⿷": 2,  # surround from left
    "⿸": 2,  # surround from upper left
    "⿹": 2,  # surround from upper right
    "⿺": 2,  # surround from lower left
    "⿻": 2,  # overlaid
}

# Blocks a normal system CJK font can actually draw. Anything outside these
# (mostly Extension B and up) is dropped so the grid never shows tofu boxes.
RENDERABLE = (
    (0x2E80, 0x2EFF),  # CJK Radicals Supplement
    (0x2F00, 0x2FDF),  # Kangxi Radicals
    (0x3105, 0x312F),  # Bopomofo (a few appear as components)
    (0x31C0, 0x31EF),  # CJK Strokes
    (0x3400, 0x4DBF),  # Extension A
    (0x4E00, 0x9FFF),  # CJK Unified Ideographs
    (0xF900, 0xFAFF),  # Compatibility Ideographs
)


def renderable(ch):
    return len(ch) == 1 and any(lo <= ord(ch) <= hi for lo, hi in RENDERABLE)


class Node:
    """A parsed IDS subtree."""

    __slots__ = ("op", "kids", "text")

    def __init__(self, op, kids, text):
        self.op = op          # None for a leaf
        self.kids = kids      # list of Node
        self.text = text      # the IDS substring this node spans


def parse_ids(s):
    """Parse an IDS string into a tree. Returns None if malformed."""
    pos = 0

    def node():
        nonlocal pos
        if pos >= len(s):
            return None
        ch = s[pos]
        start = pos
        pos += 1
        arity = IDC.get(ch)
        if arity is None:
            return Node(None, [], ch)
        kids = []
        for _ in range(arity):
            k = node()
            if k is None:
                return None
            kids.append(k)
        return Node(ch, kids, s[start:pos])

    tree = node()
    return tree if tree is not None and pos == len(s) else None


def load_dictionary():
    entries = {}
    path = os.path.join(DATA, "dictionary.txt")
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            e = json.loads(line)
            entries[e["character"]] = e
    return entries


def load_frequency():
    """Commonness proxy: how many CC-CEDICT headwords contain the character."""
    freq = defaultdict(int)
    path = os.path.join(DATA, "cedict.txt")
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("#"):
                continue
            m = re.match(r"^(\S+)\s+(\S+)\s+\[", line)
            if not m:
                continue
            for word in (m.group(1), m.group(2)):
                for ch in set(word):
                    if renderable(ch):
                        freq[ch] += 1
    return freq


def clean_definition(d):
    if not d:
        return ""
    d = d.replace("\n", " ").strip()
    # Keep the first couple of senses only; definitions get long and repetitive.
    parts = [p.strip() for p in d.split(";")]
    out = "; ".join(parts[:2])
    return out[:52].rstrip(" ,;")


def main():
    entries = load_dictionary()
    freq = load_frequency()
    print(f"dictionary entries : {len(entries)}")
    print(f"characters with a CC-CEDICT footprint : {len(freq)}")

    # --- index every character by the IDS string it decomposes into ----------
    trees = {}
    by_ids = {}
    for ch, e in entries.items():
        if not renderable(ch):
            continue
        ids = e.get("decomposition") or ""
        # "？" marks a component the source data could not identify. A partial
        # decomposition would invent reactions that are not real, so drop it.
        if not ids or "？" in ids:
            continue
        t = parse_ids(ids)
        if t is None or t.op is None:
            continue
        trees[ch] = t
        # Prefer the most common character for an ambiguous IDS string.
        prev = by_ids.get(ids)
        if prev is None or freq.get(ch, 0) > freq.get(prev, 0):
            by_ids[ids] = ch

    def resolve(nd):
        """A subtree is usable as a game piece if it is a single renderable
        character, or if some real character is written exactly that way."""
        if "？" in nd.text:
            return None
        if nd.op is None:
            return nd.text if renderable(nd.text) else None
        ch = by_ids.get(nd.text)
        return ch if ch and renderable(ch) else None

    # --- derive the reaction table ------------------------------------------
    recipes = defaultdict(list)   # "a|b" (sorted) -> [[result, operator], ...]
    decomp = {}                   # result -> [a, b, operator]

    def register(a, b, op, result):
        if a is None or b is None or result in (a, b):
            return False
        key = "|".join(sorted((a, b)))
        for r, _ in recipes[key]:
            if r == result:
                return False
        recipes[key].append([result, op])
        if result not in decomp:
            decomp[result] = [a, b, op]
        return True

    ternary_folded = 0
    for ch, t in trees.items():
        if len(t.kids) == 2:
            register(resolve(t.kids[0]), resolve(t.kids[1]), t.op, ch)
        elif len(t.kids) == 3:
            # ⿲ABC / ⿳ABC: fold into a two-step reaction if either half is
            # itself a real character, so three-part characters stay reachable.
            pair_op = "⿰" if t.op == "⿲" else "⿱"
            a, b, c = t.kids
            left = by_ids.get(pair_op + a.text + b.text)
            right = by_ids.get(pair_op + b.text + c.text)
            if "？" in t.text:
                continue
            if right and register(resolve(a), right, t.op, ch):
                ternary_folded += 1
            elif left and register(left, resolve(c), t.op, ch):
                ternary_folded += 1

    print(f"reactions : {sum(len(v) for v in recipes.values())} "
          f"over {len(recipes)} component pairs ({ternary_folded} folded from 3-part)")

    # --- complexity levels ---------------------------------------------------
    # level 0 = an atom nothing in the table can build; otherwise 1 + the
    # deepest parent. Computed with a cycle guard, since IDS data has a few.
    level_cache = {}

    def level(ch, seen=None):
        if ch in level_cache:
            return level_cache[ch]
        if seen is None:
            seen = set()
        if ch in seen or ch not in decomp:
            return 0
        seen.add(ch)
        a, b, _ = decomp[ch]
        lv = 1 + max(level(a, seen), level(b, seen))
        seen.discard(ch)
        level_cache[ch] = lv
        return lv

    # --- the universe of pieces ---------------------------------------------
    universe = set(decomp)
    for key in recipes:
        universe.update(key.split("|"))

    chars = {}
    for ch in universe:
        e = entries.get(ch, {})
        pin = e.get("pinyin") or []
        chars[ch] = {
            "p": pin[0] if pin else "",
            "d": clean_definition(e.get("definition")),
            "l": level(ch),
            "f": freq.get(ch, 0),
        }

    # --- seed pool -----------------------------------------------------------
    # Atoms weighted by how productive they are (how many reactions they can
    # take part in) and how common the characters they build are.
    productivity = defaultdict(int)
    for key, results in recipes.items():
        a, b = key.split("|")
        w = sum(1 + freq.get(r, 0) for r, _ in results)
        productivity[a] += w
        productivity[b] += w

    atoms = []
    for ch in universe:
        if chars[ch]["l"] != 0:
            continue
        w = productivity.get(ch, 0)
        if w <= 0:
            continue
        atoms.append([ch, w])
    atoms.sort(key=lambda x: -x[1])

    # Compress weights into a sane range so the soup is varied but still
    # dominated by the components that really do build most of the language.
    top = atoms[0][1]
    for a in atoms:
        a[1] = max(1, round(80 * (a[1] / top) ** 0.45))

    out = {
        "chars": chars,
        "recipes": {k: v for k, v in recipes.items()},
        "decomp": decomp,
        "atoms": atoms,
        "meta": {
            "source": "makemeahanzi (IDS decompositions) + CC-CEDICT (frequency)",
            "characters": len(chars),
            "reactions": sum(len(v) for v in recipes.values()),
            "pairs": len(recipes),
            "atoms": len(atoms),
            "maxLevel": max(c["l"] for c in chars.values()),
        },
    }

    path = os.path.join(DATA, "hanzi.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, ensure_ascii=False, separators=(",", ":"))

    size = os.path.getsize(path)
    print(f"pieces : {len(chars)}   atoms : {len(atoms)}   "
          f"max level : {out['meta']['maxLevel']}")
    print(f"wrote {path} ({size/1024:.0f} KB)")
    print("\ntop 25 atoms by productivity:")
    print("  " + "  ".join(f"{c}({w})" for c, w in atoms[:25]))
    print("\nlevel histogram:")
    hist = defaultdict(int)
    for c in chars.values():
        hist[c["l"]] += 1
    for lv in sorted(hist):
        print(f"  level {lv}: {hist[lv]}")


if __name__ == "__main__":
    main()
