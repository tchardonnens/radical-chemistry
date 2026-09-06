#!/usr/bin/env python3
"""Parameter sweeps, driven by the native simulator.

    python3 sweep.py --ticks 600            # one factor at a time
    python3 sweep.py --ticks 600 --only starve,rain,recall
    python3 sweep.py --combo --ticks 6000   # the tuned configuration
"""
import argparse, os, subprocess
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
SIM = os.path.join(HERE, "sim")

BASE = dict(cols=60, rows=38, density=.32, starve=6, pressure=6, mobility=.45,
            mutation=0, rain=3, recall=0, birth=3, lonely=1, crowd=6, moore=1)

# what the sweep found, combined
TUNED = dict(cols=180, rows=113, density=.7, starve=24, pressure=5, mobility=1.0,
             mutation=0, rain=16, recall=32, birth=4, lonely=0, crowd=8, moore=1)

AXES = {
    "grid":     [{"cols": c, "rows": int(c * .63)} for c in (44, 60, 90, 130)],
    "starve":   [{"starve": v} for v in (2, 6, 12, 24, 40)],
    "rain":     [{"rain": v} for v in (0, 1, 3, 8, 16, 32)],
    "recall":   [{"recall": v} for v in (0, 2, 8, 16, 32)],
    "mobility": [{"mobility": v} for v in (.1, .45, .8, 1.0)],
    "pressure": [{"pressure": v} for v in (3, 5, 6, 8, 12)],
    "birth":    [{"birth": v} for v in (0, 2, 3, 4)],
    "crowd":    [{"crowd": v} for v in (3, 5, 6, 8)],
    "lonely":   [{"lonely": v} for v in (0, 1, 2)],
    "density":  [{"density": v} for v in (.15, .32, .5, .7)],
    "bias":     [{"bias": v} for v in (0, .35, .7, 1.0)],
    "moore":    [{"moore": v} for v in (0, 1)],
}


def run(cfg, ticks, reps):
    cmd = [SIM, "--ticks", str(ticks), "--reps", str(reps), "--threads", "1", "--tsv"]
    for k, v in cfg.items():
        cmd += ["--" + k, str(v)]
    rows = subprocess.run(cmd, capture_output=True, text=True, check=True).stdout.splitlines()[1:]
    n = len(rows) or 1
    cols = [list(map(float, r.split("\t"))) for r in rows]
    return [sum(c[i] for c in cols) / n for i in range(6)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ticks", type=int, default=600)
    ap.add_argument("--reps", type=int, default=3)
    ap.add_argument("--only", default=None)
    ap.add_argument("--combo", action="store_true")
    a = ap.parse_args()
    if not os.path.exists(SIM):
        raise SystemExit("build first:  rustc -C opt-level=3 sim.rs -o sim")

    if a.combo:
        jobs = [("tuned", TUNED)]
    else:
        axes = AXES if not a.only else {k: AXES[k] for k in a.only.split(",")}
        jobs = [("baseline", dict(BASE))]
        for axis, variants in axes.items():
            for over in variants:
                label = axis + " " + ", ".join(f"{k}={v}" for k, v in over.items())
                jobs.append((label, {**BASE, **over}))

    with ThreadPoolExecutor(max_workers=os.cpu_count()) as pool:
        out = list(pool.map(lambda j: (j[0], run(j[1], a.ticks, a.reps)), jobs))

    print(f"\n{a.ticks} ticks, {a.reps} reps\n")
    print(f"{'variant':<28}{'found':>8}{'producible':>12}{'pop':>9}")
    print("-" * 57)
    for label, r in out:
        print(f"{label:<28}{r[1]:>8.0f}{r[5]:>11.2f}%{r[4]:>9.0f}")


if __name__ == "__main__":
    main()
