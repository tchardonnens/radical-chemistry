#!/usr/bin/env python3
"""
Give every character a place in a semantic space, derived from the same two
dictionaries the chemistry comes from - no downloaded embeddings.

For each character we gather a bag of words:

  * its own English gloss from makemeahanzi
  * the English glosses of every CC-CEDICT word it appears in
  * the other characters it shares those words with (distributional signal)

TF-IDF over that, truncated SVD to 64 dimensions, then t-SNE to the plane.
Characters with no gloss at all (bare components like the water radical) are
placed at the centre of mass of the characters they help build, which is
exactly where they belong. Writes x/y back into data/hanzi.json.
"""

import json
import os
import re
from collections import Counter, defaultdict

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.cluster import KMeans
from sklearn.decomposition import TruncatedSVD
from sklearn.feature_extraction.text import TfidfTransformer
from sklearn.manifold import TSNE

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = HERE

STOP = set("""a an the of to in on at by for with from and or but not is are was were be been
being as it its this that these those he she they them his her their you your we our i me my
which who whom what when where how why all any both each few more most other some such no nor
only own same so than too very can will just don should now if then also used use using one two
see cf variant form old kind sort thing things person esp especially etc name given
abbr sth sb sbs fig onom lit usu off var trad simp arch dial classifier measure word phrase
surname something someone place made make makes making have has had do does did""".split())

MAX_ENTRIES_PER_CHAR = 400
SVD_DIMS = 64
CLUSTERS = 26


def tokens(text):
    for t in re.split(r"[^a-z]+", text.lower()):
        if len(t) > 2 and t not in STOP:
            yield t


def main():
    path = os.path.join(DATA, "hanzi.json")
    D = json.load(open(path, encoding="utf-8"))
    chars = D["chars"]
    universe = list(chars)
    index = {c: i for i, c in enumerate(universe)}
    print("characters to place :", len(universe))

    bags = [Counter() for _ in universe]

    # 1 - the character's own gloss, weighted up: the most direct evidence
    for c, e in chars.items():
        for t in tokens(e.get("d") or ""):
            bags[index[c]][t] += 4

    # 2 - every CC-CEDICT word the character appears in
    seen = Counter()
    with open(os.path.join(DATA, "cedict.txt"), encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("#"):
                continue
            m = re.match(r"^(\S+)\s+(\S+)\s+\[[^\]]*\]\s+/(.*)/\s*$", line)
            if not m:
                continue
            toks = list(tokens(m.group(3).replace("/", " ")))
            if not toks:
                continue
            for word in {m.group(1), m.group(2)}:
                members = [ch for ch in set(word) if ch in index]
                if not members:
                    continue
                # a short word says much more about its characters than a long one
                w = 3.0 / (1.0 + len(word))
                for ch in members:
                    i = index[ch]
                    if seen[ch] > MAX_ENTRIES_PER_CHAR:
                        continue
                    seen[ch] += 1
                    for t in toks:
                        bags[i][t] += w
                    for other in members:
                        if other != ch:
                            bags[i][" " + other] += w

    # 3 - sparse TF-IDF matrix
    df = Counter()
    for b in bags:
        df.update(b.keys())
    vocab = {t: j for j, t in enumerate(
        t for t, n in df.items() if 3 <= n <= len(universe) * 0.4)}
    print("vocabulary          :", len(vocab))

    rows, cols, vals = [], [], []
    for i, b in enumerate(bags):
        for t, v in b.items():
            j = vocab.get(t)
            if j is not None:
                rows.append(i)
                cols.append(j)
                vals.append(v)
    X = csr_matrix((vals, (rows, cols)),
                   shape=(len(universe), len(vocab)), dtype=np.float32)
    described = np.asarray((X != 0).sum(axis=1)).ravel() > 0
    print("with any evidence   : %d  (%d bare components)"
          % (int(described.sum()), len(universe) - int(described.sum())))

    X = TfidfTransformer(sublinear_tf=True).fit_transform(X)

    # 4 - reduce, then lay out
    print("reducing ...")
    svd = TruncatedSVD(n_components=SVD_DIMS, random_state=0)
    V = svd.fit_transform(X)
    V /= (np.linalg.norm(V, axis=1, keepdims=True) + 1e-9)
    print("explained variance  : %.3f" % svd.explained_variance_ratio_.sum())

    sub = np.where(described)[0]
    print("projecting %d points with t-SNE (takes a minute) ..." % len(sub))
    ts = TSNE(n_components=2, init="pca", perplexity=32, learning_rate="auto",
              max_iter=1000, random_state=0)
    P2 = ts.fit_transform(V[sub])

    xy = np.full((len(universe), 2), np.nan, dtype=np.float64)
    xy[sub] = P2

    # 5 - place bare components among the characters they build
    builds = defaultdict(list)
    for key, results in D["recipes"].items():
        a, b = key.split("|")
        for r, _ in results:
            if r in index:
                builds[a].append(index[r])
                builds[b].append(index[r])
    for _ in range(3):
        missing = [i for i in range(len(universe)) if np.isnan(xy[i, 0])]
        if not missing:
            break
        for i in missing:
            kids = [k for k in builds.get(universe[i], []) if not np.isnan(xy[k, 0])]
            if kids:
                xy[i] = np.mean(xy[kids], axis=0)
    still = np.isnan(xy[:, 0])
    if still.any():
        xy[still] = np.nanmean(xy, axis=0)
        print("fell back to centre :", int(still.sum()))

    # 6 - normalise into a 0..4000 integer grid
    lo, hi = xy.min(axis=0), xy.max(axis=0)
    norm = (xy - lo) / np.maximum(hi - lo, 1e-9)
    q = np.clip(np.round(norm * 4000), 0, 4000).astype(int)

    # 7 - name the regions by their most distinctive gloss word
    km = KMeans(n_clusters=CLUSTERS, n_init=10, random_state=0).fit(norm)
    inv = {j: t for t, j in vocab.items()}
    total = Counter()
    per = [Counter() for _ in range(CLUSTERS)]
    Xc = X.tocsr()
    for i in range(len(universe)):
        lab = km.labels_[i]
        for j in Xc.indices[Xc.indptr[i]:Xc.indptr[i + 1]]:
            t = inv[j]
            if not t.startswith(" "):
                per[lab][t] += 1
                total[t] += 1
    sizes = Counter(km.labels_.tolist())
    regions, used = [], set()
    for k in range(CLUSTERS):
        n = max(1, sizes[k])
        best, score = None, 0.0
        for t, c in per[k].items():
            # a good region name covers much of the cluster AND is rare outside it
            cover = c / n
            if cover < 0.10 or c < 8 or t in used:
                continue
            s = cover * cover / (total[t] / len(universe))
            if s > score:
                best, score = t, s
        if best:
            used.add(best)
            cx, cy = km.cluster_centers_[k]
            regions.append({"x": int(cx * 4000), "y": int(cy * 4000),
                            "t": best, "n": n})
    regions.sort(key=lambda r: -r["n"])
    print("\nregions found:")
    for r in regions:
        print("  %-16s %5d characters" % (r["t"], r["n"]))

    for c, i in index.items():
        chars[c]["x"] = int(q[i, 0])
        chars[c]["y"] = int(q[i, 1])
    D["regions"] = regions
    D["meta"]["semantics"] = ("tf-idf over makemeahanzi glosses and CC-CEDICT "
                              "word definitions, SVD-64, t-SNE")

    json.dump(D, open(path, "w", encoding="utf-8"),
              ensure_ascii=False, separators=(",", ":"))
    print("\nwrote %s (%.0f KB)" % (path, os.path.getsize(path) / 1024))

    print("\nnearest neighbours in the map:")
    for probe in ["海", "母", "馬", "怒", "銀"]:
        if probe not in index:
            continue
        d = np.linalg.norm(q - q[index[probe]], axis=1)
        near = np.argsort(d)[1:10]
        print("  %s %-26s -> %s" % (probe, (chars[probe].get("d") or "")[:24],
                                    " ".join(universe[i] for i in near)))


if __name__ == "__main__":
    main()
