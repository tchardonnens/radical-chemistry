#!/usr/bin/env python3
"""
Flatten data/hanzi.json into data/world.tsv, a table of integer indices that the
Rust simulator reads without needing a JSON parser.

    CHARS n / idx  char  level  freq  pinyin  gloss
    RECIPES n / a  b  result  op
    DECOMP n / char  a  b  op
    ATOMS n / idx  weight
"""

import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OPS = ["⿰", "⿱", "⿲", "⿳", "⿴", "⿵", "⿶", "⿷", "⿸", "⿹", "⿺", "⿻"]


def clean(s):
    return (s or "").replace("\t", " ").replace("\n", " ").strip() or "-"


def main():
    D = json.load(open(os.path.join(DATA, "hanzi.json"), encoding="utf-8"))
    chars = D["chars"]
    order = sorted(chars)
    idx = {c: i for i, c in enumerate(order)}
    op_idx = {o: i for i, o in enumerate(OPS)}

    out = []
    out.append("CHARS %d" % len(order))
    for i, c in enumerate(order):
        e = chars[c]
        out.append("%d\t%s\t%d\t%d\t%s\t%s"
                   % (i, c, e["l"], e.get("f", 0), clean(e.get("p")), clean(e.get("d"))))

    rec = []
    for key, results in D["recipes"].items():
        a, b = key.split("|")
        if a not in idx or b not in idx:
            continue
        for r, op in results:
            if r in idx:
                rec.append((idx[a], idx[b], idx[r], op_idx.get(op, 0)))
    out.append("RECIPES %d" % len(rec))
    out += ["%d\t%d\t%d\t%d" % r for r in rec]

    dec = [(idx[c], idx[d[0]], idx[d[1]], op_idx.get(d[2], 0))
           for c, d in D["decomp"].items()
           if c in idx and d[0] in idx and d[1] in idx]
    out.append("DECOMP %d" % len(dec))
    out += ["%d\t%d\t%d\t%d" % d for d in dec]

    atoms = [(idx[c], w) for c, w in D["atoms"] if c in idx]
    out.append("ATOMS %d" % len(atoms))
    out += ["%d\t%d" % a for a in atoms]

    path = os.path.join(DATA, "world.tsv")
    open(path, "w", encoding="utf-8").write("\n".join(out) + "\n")
    print("chars %d  recipes %d  decomp %d  atoms %d"
          % (len(order), len(rec), len(dec), len(atoms)))
    print("wrote %s (%.0f KB)" % (path, os.path.getsize(path) / 1024))


if __name__ == "__main__":
    main()
