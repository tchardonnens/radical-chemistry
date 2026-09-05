# Radical Chemistry — a Game of Life made of Chinese characters

A cellular automaton whose reaction table *is* the Chinese writing system.
Components (氵, 亻, 艹, 辶 …) drift across a grid, bond into real characters
when the script says they combine that way, get born and die by Conway's
neighbour counts, break apart under crowding, and starve when they cannot make
meaning. Nothing about which parts combine into which character is hand-written.

    氵 + 木 → 沐    十 + 八 → 木    木 + 木 → 林    日 + 月 → 明

## Run it

    open radical-chemistry.html          # the interactive dish, one self-contained file

The terminal simulator is Rust, with no crates to fetch:

    python3 export_data.py                       # data/hanzi.json -> data/world.tsv
    rustc -C opt-level=3 -C target-cpu=native sim.rs -o sim

    ./sim --ticks 6000 --cols 180 --rows 113 --recall 32
    ./sim --ticks 800 --reps 8 --threads 8 --quiet
    ./sim --help

It runs about **32x faster** than the Python version it replaced: a 6,000-tick
run on a 180x113 dish went from ~7 minutes to 12.6 seconds, which is what made
the coverage experiments below possible.

## The rules

| Phase | What happens |
| --- | --- |
| **Synthesis** | Adjacent pieces whose pair appears in the reaction table fuse into the character they actually build. Where a pair builds several characters, the commoner one is likelier. |
| **Starvation** | A piece that fails to bond ticks toward death. Its patience is `S × (level + 1)`, so compounds outlive loose components. Characters that don't exist get no level bonus — they can't hold together. |
| **Life** | Conway's layer: an empty square with exactly *b* live neighbours comes alive, inheriting a component from one of them; too few or too many neighbours kills. This is what makes discovered characters *colonise*. |
| **Crowding** | A hemmed-in character breaks back into the two parts it is written from. Both halves recoil for three ticks so they don't instantly re-bond. |
| **Diffusion** | Pieces drift into empty neighbours at a rate divided by their level — heavy compounds barely move. |
| **Rain** | Fresh components seed each tick, drawn by how productive they are in the real script. |
| **Character rain** | Optional, off by default. Seeds characters the run has already discovered back into the dish, so deep compounds need not be rebuilt from components every time. |

Levels are derived, not assigned: level 0 is a component nothing in the table
can build, and anything else is one deeper than its deepest parent. Runs reach
level 5–6 — e.g. `丰 + 阝 → 邦`, then `纟 + 邦 → 绑`.

## Two views

**Dish** is the automaton itself. **Semantic map** is the same run seen from
above: every one of the 9,142 characters is a dot placed by what it *means*, the
unlit writing system as a faint atlas. Characters the run has built light up,
sized by how many times they were re-invented and ringed while they are still
alive, and short lines trace the last bonds from their two parents to the child
— so you watch the simulation wander across meaning. Zoom in far enough and the
dots become readable characters.

Hovering anything that names a character — a cell in the dish, a dot on the map,
a chip in the discovery log — draws its **genealogy**: the full decomposition
tree, leaves on the left, the character itself on the right. The tree's depth is
the character's level, exactly, for all 8,572 of them. So a level-6 character
really does draw a bigger tree than a level-2 one:

    糧  level 6, 15 components
        一 丨 → 十 ┐
        八        ├→ 木 → 米 ┐
        ...             ...  ├→ 糧
        田 → 里 → 量 ────────┘

The coordinates are derived, not downloaded. Each character gets a bag of words
— its own English gloss, plus the glosses of every CC-CEDICT word it appears in,
plus the characters it shares those words with — then TF-IDF, SVD to 64
dimensions, and t-SNE to the plane. Bare components with no gloss of their own
are placed at the centre of mass of the characters they build.

It recovers the semantic radical families on its own: the regions it names are
`water`, `meat`, `tree`, `bird`, `silk`, `bamboo`, `door`, `horse`, `river`,
`fear`. 怒 lands beside 忿 憤 愾 悻; 母 beside 父 妻 甥 嫡; 海 beside 港 澳 洲.

## Where the data comes from

    python3 build_data.py       # dictionary.txt + cedict.txt -> data/hanzi.json
    python3 build_semantics.py  # adds x/y and region names  (needs numpy, scikit-learn)
    python3 build.py            # src/app.html + data/hanzi.json -> radical-chemistry.html

* **[makemeahanzi](https://github.com/skishore/makemeahanzi)** — ideographic
  description sequences (`林` = `⿰木木`), pinyin and glosses. Every top-level
  binary decomposition becomes one reaction; three-part characters are folded
  into two steps when an intermediate half is itself a real character.
  Decompositions containing the unknown-component marker `？` are dropped, since
  a partial decomposition would invent reactions that aren't real.
* **[CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cc-cedict)** — how
  many headwords each character appears in, used to weight the seed pool and to
  pick between characters that share a component pair.

That yields **8,572 reactions over 8,446 component pairs, 9,142 characters and
570 seed components**.

## How far can it get?

Almost all of it: **98.5% of the 8,572 producible characters** (8,439 of them),
which is 92% of every character in the data.

The thing that governs coverage is not area and not time. It is **how full the
dish is**. A dish at 99% occupancy is mechanically jammed: diffusion needs an
empty neighbour, births need an empty cell, a crowding-split needs somewhere to
put the loose half, and component rain only lands if one of its probes finds a
gap. Turn overcrowding death off and the dish saturates, mixing stops, and
coverage stalls near 80% no matter how large the grid or how long the run.

Leave overcrowding death on at 7, and the population settles near **74% fill**,
which is loose enough to keep mixing and dense enough to keep reacting:

    crowd 7  (74% fill)     crowd 8 = off  (99.9% fill)
      tick 10000   89.6%      tick 10000   77.2%
      tick 20000   94.5%      tick 20000   79.1%
      tick 35000   97.2%      tick 35000   80.1%
      tick 60000   98.5%      tick 60000   80.9%

Killing harder than that is worse, not better - at crowd 3 the dish drops to 32%
fill and coverage halves. The window is narrow and it is about occupancy.

    ./sim --ticks 60000 --cols 180 --rows 113 --density 0.7 --starve 24 \
          --pressure 5 --mobility 1.0 --mutation 0 --rain 16 --recall 40 \
          --birth 4 --lonely 0 --crowd 7

Three other findings from the sweep (`sweep.py`):

* **Character rain is what makes the ladder work.** With it off, the curve is
  flat by tick 1500 - deep characters die faster than they can be rebuilt, and
  coverage stops near 39%.
* **Crowding limit 5 beats 6 in the jammed regime**, nearly doubling coverage:
  breaking compounds back into parts recycles intermediates.
* **Flattening the seed pool makes things three times worse.** Letting rare
  components appear as often as common ones sounds like it should help rare
  characters; it just crowds out the reactions that work.

Area, incidentally, stops mattering once the dish is unjammed - a 340x214 grid
and a 180x113 one reach the same coverage.

## Files

    build_data.py            derives the reaction table from the two dictionaries
    build_semantics.py       derives the semantic map coordinates from the same two
    export_data.py           flattens data/hanzi.json -> data/world.tsv for the simulator
    sim.rs                   the native simulator (rustc, no crates)
    sweep.py                 parameter sweeps, driving ./sim
    src/app.html             the page (data injected at build time)
    build.py                 inlines the data -> radical-chemistry.html + dist/artifact.html
    radical-chemistry.html   the built, self-contained simulation
