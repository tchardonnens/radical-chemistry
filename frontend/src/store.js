// Everything the panel draws, as signals.
//
// The simulation owns the grid and writes here at the panel's refresh rate;
// the components below re-render from it. Nothing reads the simulation's
// internals directly, which is what lets the panel be declarative while the
// canvas loop stays imperative.

import { signal } from "@preact/signals";

export const vitals = signal({ tick: 0, real: 0 });

export const coverage = signal({
  rx: 0, seen: 0, comp: 0, built: 0,
  totals: { reactions: 1, characters: 1, atoms: 1 },
});

export const census = signal({ pop: 0, levels: [0, 0, 0, 0, 0, 0], synth: 0 });

/** [{ ch, n, cls, title }] — characters above component level that are alive */
export const standing = signal([]);

/** [{ ch, shown, fresh, n, cls, title }] — the last bonds, newest first */
export const ticker = signal({ items: [], bonds: 0 });

/** [{ ch, shown, a, b, op, cls, first, count, synth, pinyin, gloss }] */
export const discoveries = signal([]);

export const tally = signal({ real: 0, repeats: 0, novel: 0 });

export const logFilter = signal("all");

/** The specimen card: null, or the character under the pointer. */
export const readout = signal(null);

/** The decomposition tree: null, a bare component, or a laid-out dendrogram. */
export const tree = signal(null);

export const colophon = signal("");
