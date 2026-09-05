// Radical Chemistry - native simulator.
//
// Same world as the page: components bond into real characters when the writing
// system says they do, are born and die by Conway's neighbour counts, break
// apart under crowding, starve when they cannot make meaning.
//
//   rustc -C opt-level=3 -C target-cpu=native sim.rs -o sim
//   ./sim --ticks 6000 --cols 180 --rows 113 --recall 32
//
// Reads data/world.tsv, produced by export_data.py. No external crates.

use std::collections::HashMap;
use std::env;
use std::fs;
use std::process;

const EMPTY: i32 = i32::MIN;
const OPS: [&str; 12] = ["side by side", "one above the other", "three columns",
    "three rows", "one enclosing the other", "capped", "based", "framed on the left",
    "upper left", "upper right", "lower left", "overlaid"];

// ---------------------------------------------------------------- rng
struct Rng(u64);
impl Rng {
    fn new(seed: u64) -> Rng {
        let s = seed.wrapping_mul(0x9E3779B97F4A7C15).wrapping_add(0x2545F4914F6CDD1D);
        Rng(if s == 0 { 0x853C49E6748FEA9B } else { s })
    }
    #[inline]
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }
    #[inline]
    fn below(&mut self, n: usize) -> usize {
        ((self.next() >> 32) as usize * n) >> 32
    }
    #[inline]
    fn unit(&mut self) -> f64 {
        (self.next() >> 11) as f64 * (1.0 / 9007199254740992.0)
    }
}

fn shuffle(v: &mut Vec<u32>, rng: &mut Rng) {
    let mut i = v.len();
    while i > 1 {
        i -= 1;
        let j = rng.below(i + 1);
        v.swap(i, j);
    }
}

// ---------------------------------------------------------------- pair table
// Open addressing keyed on the ordered component pair; this is the hot path.
struct PairMap { keys: Vec<u64>, vals: Vec<u32>, mask: usize }

impl PairMap {
    fn new(cap: usize) -> PairMap {
        let mut n = 16usize;
        while n < cap * 3 { n <<= 1; }
        PairMap { keys: vec![0; n], vals: vec![u32::MAX; n], mask: n - 1 }
    }
    #[inline]
    fn mix(k: u64) -> usize {
        let mut x = k;
        x ^= x >> 33;
        x = x.wrapping_mul(0xff51afd7ed558ccd);
        x ^= x >> 33;
        x = x.wrapping_mul(0xc4ceb9fe1a85ec53);
        x ^= x >> 33;
        x as usize
    }
    fn insert(&mut self, k: u64, v: u32) {
        let mut i = PairMap::mix(k) & self.mask;
        loop {
            if self.vals[i] == u32::MAX { self.keys[i] = k; self.vals[i] = v; return; }
            if self.keys[i] == k { self.vals[i] = v; return; }
            i = (i + 1) & self.mask;
        }
    }
    #[inline]
    fn get(&self, k: u64) -> Option<u32> {
        let mut i = PairMap::mix(k) & self.mask;
        loop {
            let v = self.vals[i];
            if v == u32::MAX { return None; }
            if self.keys[i] == k { return Some(v); }
            i = (i + 1) & self.mask;
        }
    }
}

#[inline]
fn pair_key(a: i32, b: i32) -> u64 {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    ((lo as u64) << 32) | (hi as u64)
}

// ---------------------------------------------------------------- data
struct Table {
    n: usize,
    name: Vec<String>,
    level: Vec<u8>,
    freq: Vec<u32>,
    pinyin: Vec<String>,
    gloss: Vec<String>,
    pairs: PairMap,
    span: Vec<(u32, u32)>,
    res: Vec<(i32, u8)>,
    decomp: Vec<(i32, i32, u8)>,
    atoms: Vec<i32>,
    weights: Vec<f64>,
    producible: usize,
}

fn load(path: &str) -> Table {
    let text = fs::read_to_string(path).unwrap_or_else(|e| {
        eprintln!("cannot read {} ({}). Run: python3 export_data.py", path, e);
        process::exit(1);
    });
    let mut lines = text.lines();
    let header = |lines: &mut std::str::Lines, tag: &str| -> usize {
        let l = lines.next().expect("truncated table");
        let mut it = l.split(' ');
        assert_eq!(it.next().unwrap(), tag, "unexpected section");
        it.next().unwrap().parse().unwrap()
    };

    let nc = header(&mut lines, "CHARS");
    let mut t = Table {
        n: nc,
        name: vec![String::new(); nc],
        level: vec![0; nc],
        freq: vec![0; nc],
        pinyin: vec![String::new(); nc],
        gloss: vec![String::new(); nc],
        pairs: PairMap::new(1),
        span: Vec::new(),
        res: Vec::new(),
        decomp: vec![(-1, -1, 0); nc],
        atoms: Vec::new(),
        weights: Vec::new(),
        producible: 0,
    };
    for _ in 0..nc {
        let l = lines.next().unwrap();
        let f: Vec<&str> = l.split('\t').collect();
        let i: usize = f[0].parse().unwrap();
        t.name[i] = f[1].to_string();
        t.level[i] = f[2].parse().unwrap();
        t.freq[i] = f[3].parse().unwrap();
        t.pinyin[i] = f[4].to_string();
        t.gloss[i] = f[5].to_string();
    }

    let nr = header(&mut lines, "RECIPES");
    let mut grouped: HashMap<u64, Vec<(i32, u8)>> = HashMap::with_capacity(nr);
    for _ in 0..nr {
        let l = lines.next().unwrap();
        let f: Vec<&str> = l.split('\t').collect();
        let a: i32 = f[0].parse().unwrap();
        let b: i32 = f[1].parse().unwrap();
        let r: i32 = f[2].parse().unwrap();
        let op: u8 = f[3].parse().unwrap();
        grouped.entry(pair_key(a, b)).or_default().push((r, op));
    }
    t.pairs = PairMap::new(grouped.len());
    for (k, v) in grouped {
        let start = t.res.len() as u32;
        t.res.extend_from_slice(&v);
        t.pairs.insert(k, t.span.len() as u32);
        t.span.push((start, v.len() as u32));
    }

    let nd = header(&mut lines, "DECOMP");
    for _ in 0..nd {
        let l = lines.next().unwrap();
        let f: Vec<&str> = l.split('\t').collect();
        let c: usize = f[0].parse().unwrap();
        t.decomp[c] = (f[1].parse().unwrap(), f[2].parse().unwrap(), f[3].parse().unwrap());
    }
    t.producible = nd;

    let na = header(&mut lines, "ATOMS");
    for _ in 0..na {
        let l = lines.next().unwrap();
        let f: Vec<&str> = l.split('\t').collect();
        t.atoms.push(f[0].parse().unwrap());
        t.weights.push(f[1].parse::<f64>().unwrap());
    }
    t
}

// ---------------------------------------------------------------- params
#[derive(Clone)]
struct P {
    ticks: u32, cols: usize, rows: usize, density: f64,
    starve: u32, pressure: i32, mobility: f64, mutation: f64,
    rain: u32, recall: u32, birth: i32, lonely: i32, crowd: i32,
    moore: bool, bias: f64, seed: u64, reps: usize, threads: usize,
    marks: Vec<u32>, quiet: bool, tsv: bool,
}

impl Default for P {
    fn default() -> P {
        P { ticks: 400, cols: 44, rows: 28, density: 0.32, starve: 6, pressure: 6,
            mobility: 0.45, mutation: 0.0015, rain: 3, recall: 0, birth: 3,
            lonely: 1, crowd: 6, moore: true, bias: 0.0, seed: 1, reps: 1,
            threads: 1, marks: Vec::new(), quiet: false, tsv: false }
    }
}

#[derive(Clone, Copy)]
struct Cell { ch: i32, lv: u8, t: u16, cool: u8, born: u32, synth: bool, sa: i32, sb: i32 }

const VOID: Cell = Cell { ch: EMPTY, lv: 0, t: 0, cool: 0, born: 0, synth: false, sa: -1, sb: -1 };

struct Sample { tick: u32, found: usize, seen: usize, comps: usize, pop: usize }

struct World<'a> {
    t: &'a Table,
    p: P,
    n: usize, nbc: usize,
    cells: Vec<Cell>,
    nb: Vec<u32>,
    acted: Vec<bool>,
    cnt: Vec<i32>,
    occ: Vec<u32>,
    mv: Vec<u32>,
    count: Vec<u32>,
    first: Vec<u32>,
    src: Vec<(i32, i32)>,
    found: Vec<i32>,
    seen: Vec<bool>, seen_ct: usize,
    comp: Vec<bool>, comp_ct: usize,
    novel: HashMap<u64, u32>,
    tick: u32,
    bonds: u64, repeats: u64, births: u64, deaths: u64, splits: u64,
    cum: Vec<f64>, total_w: f64,
    rng: Rng,
}

impl<'a> World<'a> {
    fn new(t: &'a Table, p: P, seed: u64) -> World<'a> {
        let (w, h) = (p.cols, p.rows);
        let n = w * h;
        let nbc = if p.moore { 8 } else { 4 };
        let off: &[(i32, i32)] = if p.moore {
            &[(-1, -1), (0, -1), (1, -1), (-1, 0), (1, 0), (-1, 1), (0, 1), (1, 1)]
        } else {
            &[(0, -1), (-1, 0), (1, 0), (0, 1)]
        };
        let mut nb = vec![0u32; n * nbc];
        for y in 0..h {
            for x in 0..w {
                for (k, (dx, dy)) in off.iter().enumerate() {
                    let nx = (x as i32 + dx).rem_euclid(w as i32) as usize;
                    let ny = (y as i32 + dy).rem_euclid(h as i32) as usize;
                    nb[(y * w + x) * nbc + k] = (ny * w + nx) as u32;
                }
            }
        }
        let mut cum = Vec::with_capacity(t.atoms.len());
        let mut acc = 0.0;
        for wt in &t.weights {
            acc += wt.powf(1.0 - p.bias);
            cum.push(acc);
        }
        let mut world = World {
            t, p, n, nbc,
            cells: vec![VOID; n],
            nb,
            acted: vec![false; n],
            cnt: vec![0; n],
            occ: Vec::with_capacity(n),
            mv: Vec::with_capacity(n),
            count: vec![0; t.n],
            first: vec![0; t.n],
            src: vec![(-1, -1); t.n],
            found: Vec::new(),
            seen: vec![false; t.n], seen_ct: 0,
            comp: vec![false; t.n], comp_ct: 0,
            novel: HashMap::new(),
            tick: 0,
            bonds: 0, repeats: 0, births: 0, deaths: 0, splits: 0,
            cum, total_w: acc,
            rng: Rng::new(seed),
        };
        for i in 0..n {
            if world.rng.unit() < world.p.density {
                let a = world.atom();
                world.place(i, Cell { ch: a, lv: t.level[a as usize], t: 0, cool: 0,
                                      born: 0, synth: false, sa: -1, sb: -1 });
            }
        }
        world
    }

    #[inline]
    fn atom(&mut self) -> i32 {
        let r = self.rng.unit() * self.total_w;
        let (mut lo, mut hi) = (0usize, self.cum.len() - 1);
        while lo < hi {
            let m = (lo + hi) / 2;
            if self.cum[m] < r { lo = m + 1; } else { hi = m; }
        }
        self.t.atoms[lo]
    }

    /// Every route a piece can enter a cell goes through here, so coverage of
    /// the character set is counted in exactly one place.
    #[inline]
    fn place(&mut self, i: usize, c: Cell) {
        if c.ch >= 0 {
            let k = c.ch as usize;
            if !self.seen[k] { self.seen[k] = true; self.seen_ct += 1; }
            if self.t.level[k] == 0 && !self.comp[k] {
                self.comp[k] = true;
                self.comp_ct += 1;
            }
        }
        self.cells[i] = c;
    }

    #[inline]
    fn patience(&self, c: &Cell) -> u32 {
        if self.p.starve >= 40 { return u32::MAX; }
        if c.synth { self.p.starve } else { self.p.starve * (c.lv as u32 + 1) }
    }

    fn record(&mut self, res: i32, synth: bool, a: i32, b: i32, op: u8) {
        self.bonds += 1;
        if !synth {
            let k = res as usize;
            if self.count[k] == 0 {
                self.count[k] = 1;
                self.first[k] = self.tick;
                self.src[k] = (a, b);
                self.found.push(res);
            } else {
                self.count[k] += 1;
                self.repeats += 1;
            }
        } else {
            let key = ((a as u64) << 40) | ((b as u64) << 8) | op as u64;
            let e = self.novel.entry(key).or_insert(0);
            *e += 1;
            if *e > 1 { self.repeats += 1; }
        }
    }

    fn step(&mut self) {
        self.tick += 1;
        for v in self.acted.iter_mut() { *v = false; }

        self.occ.clear();
        for i in 0..self.n {
            if self.cells[i].ch != EMPTY { self.occ.push(i as u32); }
        }
        let mut occ = std::mem::take(&mut self.occ);
        shuffle(&mut occ, &mut self.rng);

        // 1 - synthesis
        let mut order = [0u32; 8];
        for oi in 0..occ.len() {
            let i = occ[oi] as usize;
            if self.acted[i] || self.cells[i].ch == EMPTY || self.cells[i].cool > 0 { continue; }
            let misbond = self.p.mutation > 0.0 && self.rng.unit() < self.p.mutation;
            for k in 0..self.nbc { order[k] = self.nb[i * self.nbc + k]; }
            for k in (1..self.nbc).rev() {
                let j = self.rng.below(k + 1);
                order.swap(k, j);
            }
            for k in 0..self.nbc {
                let j = order[k] as usize;
                if self.acted[j] || self.cells[j].ch == EMPTY || self.cells[j].cool > 0 { continue; }
                let (a, b) = (self.cells[i].ch, self.cells[j].ch);
                if a < 0 || b < 0 { continue; }
                let mut res = -1i32;
                let mut op = 0u8;
                let mut synth = false;
                if let Some(si) = self.t.pairs.get(pair_key(a, b)) {
                    let (start, len) = self.t.span[si as usize];
                    let (s, l) = (start as usize, len as usize);
                    let pick = if l == 1 {
                        self.t.res[s]
                    } else {
                        let mut tot = 0f64;
                        for q in 0..l { tot += self.t.freq[self.t.res[s + q].0 as usize] as f64 + 1.0; }
                        let mut x = self.rng.unit() * tot;
                        let mut chosen = self.t.res[s + l - 1];
                        for q in 0..l {
                            x -= self.t.freq[self.t.res[s + q].0 as usize] as f64 + 1.0;
                            if x <= 0.0 { chosen = self.t.res[s + q]; break; }
                        }
                        chosen
                    };
                    res = pick.0;
                    op = pick.1;
                } else if misbond {
                    op = (self.rng.below(12)) as u8;
                    synth = true;
                    let key = ((a as u64) << 40) | ((b as u64) << 8) | op as u64;
                    res = -((self.novel.len() as i32) + 1);
                    let _ = key;
                }
                if res == -1 && !synth { continue; }
                let lv = if synth {
                    1 + self.cells[i].lv.max(self.cells[j].lv)
                } else {
                    self.t.level[res as usize]
                };
                let cell = Cell { ch: res, lv, t: 0, cool: 0, born: self.tick,
                                  synth, sa: a, sb: b };
                self.place(i, cell);
                self.cells[j] = VOID;
                self.acted[i] = true;
                self.record(res, synth, a, b, op);
                break;
            }
        }

        // 2 - starvation
        for i in 0..self.n {
            if self.cells[i].ch == EMPTY { continue; }
            if self.cells[i].cool > 0 { self.cells[i].cool -= 1; }
            if self.acted[i] { self.cells[i].t = 0; continue; }
            self.cells[i].t += 1;
            let pat = self.patience(&self.cells[i]);
            if pat != u32::MAX && self.cells[i].t as u32 > pat {
                self.cells[i] = VOID;
                self.deaths += 1;
            }
        }

        // 3 - the life layer
        for v in self.cnt.iter_mut() { *v = 0; }
        for i in 0..self.n {
            if self.cells[i].ch != EMPTY {
                for k in 0..self.nbc { self.cnt[self.nb[i * self.nbc + k] as usize] += 1; }
            }
        }
        let mut died: Vec<u32> = Vec::new();
        let mut born: Vec<(u32, Cell)> = Vec::new();
        let mut par = [0u32; 8];
        for i in 0..self.n {
            if self.cells[i].ch != EMPTY {
                if (self.p.lonely > 0 && self.cnt[i] < self.p.lonely)
                    || (self.p.crowd < 8 && self.cnt[i] > self.p.crowd) {
                    died.push(i as u32);
                }
            } else if self.cnt[i] == self.p.birth {
                let mut np = 0;
                for k in 0..self.nbc {
                    let j = self.nb[i * self.nbc + k] as usize;
                    if self.cells[j].ch != EMPTY && !self.cells[j].synth {
                        par[np] = j as u32;
                        np += 1;
                    }
                }
                if np > 0 {
                    let pj = par[self.rng.below(np)] as usize;
                    let s = self.cells[pj];
                    born.push((i as u32, Cell { ch: s.ch, lv: s.lv, t: 0, cool: 0,
                                                born: self.tick, synth: s.synth,
                                                sa: s.sa, sb: s.sb }));
                }
            }
        }
        for &i in &died { self.cells[i as usize] = VOID; self.deaths += 1; }
        for &(i, c) in &born {
            if self.cells[i as usize].ch != EMPTY { continue; }
            self.place(i as usize, c);
            self.births += 1;
        }

        // 4 - crowding breaks characters apart
        if self.p.pressure < 12 {
            let mut empties = [0u32; 8];
            for oi in 0..occ.len() {
                let i = occ[oi] as usize;
                let c = self.cells[i];
                if c.ch == EMPTY || self.acted[i] || c.lv == 0 { continue; }
                if self.tick - c.born < 3 { continue; }
                let d = if c.ch >= 0 && self.t.decomp[c.ch as usize].0 >= 0 {
                    let dd = self.t.decomp[c.ch as usize];
                    (dd.0, dd.1)
                } else if c.sa >= 0 && c.sb >= 0 {
                    (c.sa, c.sb)
                } else { continue };
                let mut ne = 0;
                let mut occupied = 0;
                for k in 0..self.nbc {
                    let j = self.nb[i * self.nbc + k];
                    if self.cells[j as usize].ch == EMPTY { empties[ne] = j; ne += 1; }
                    else { occupied += 1; }
                }
                let need = self.p.pressure + (c.lv as i32 - 1).min(2);
                if occupied >= need && ne > 0 {
                    let j = empties[self.rng.below(ne)] as usize;
                    let la = self.t.level[d.0 as usize];
                    let lb = self.t.level[d.1 as usize];
                    self.place(i, Cell { ch: d.0, lv: la, t: 0, cool: 3, born: self.tick,
                                         synth: false, sa: -1, sb: -1 });
                    self.place(j, Cell { ch: d.1, lv: lb, t: 0, cool: 3, born: self.tick,
                                         synth: false, sa: -1, sb: -1 });
                    self.splits += 1;
                }
            }
        }
        self.occ = occ;

        // 5 - diffusion
        self.mv.clear();
        for i in 0..self.n {
            if self.cells[i].ch != EMPTY { self.mv.push(i as u32); }
        }
        let mut mv = std::mem::take(&mut self.mv);
        shuffle(&mut mv, &mut self.rng);
        for mi in 0..mv.len() {
            let i = mv[mi] as usize;
            if self.cells[i].ch == EMPTY { continue; }
            let lv = self.cells[i].lv as f64;
            if self.rng.unit() >= self.p.mobility / (lv + 1.0) { continue; }
            let k = self.rng.below(self.nbc);
            let j = self.nb[i * self.nbc + k] as usize;
            if self.cells[j].ch == EMPTY {
                self.cells[j] = self.cells[i];
                self.cells[i] = VOID;
            }
        }
        self.mv = mv;

        // 6 - component rain
        for _ in 0..self.p.rain {
            for _ in 0..14 {
                let i = self.rng.below(self.n);
                if self.cells[i].ch == EMPTY {
                    let a = self.atom();
                    let lv = self.t.level[a as usize];
                    self.place(i, Cell { ch: a, lv, t: 0, cool: 0, born: self.tick,
                                         synth: false, sa: -1, sb: -1 });
                    break;
                }
            }
        }

        // 7 - character rain: hand back something the run already worked out
        if self.p.recall > 0 && !self.found.is_empty() {
            for _ in 0..self.p.recall {
                for _ in 0..14 {
                    let i = self.rng.below(self.n);
                    if self.cells[i].ch == EMPTY {
                        let ch = self.found[self.rng.below(self.found.len())];
                        let lv = self.t.level[ch as usize];
                        self.place(i, Cell { ch, lv, t: 0, cool: 0, born: self.tick,
                                             synth: false, sa: -1, sb: -1 });
                        break;
                    }
                }
            }
        }
    }

    fn sample(&self) -> Sample {
        Sample {
            tick: self.tick,
            found: self.found.len(),
            seen: self.seen_ct,
            comps: self.comp_ct,
            pop: self.cells.iter().filter(|c| c.ch != EMPTY).count(),
        }
    }
}

// ---------------------------------------------------------------- cli
fn parse() -> P {
    let mut p = P::default();
    let args: Vec<String> = env::args().skip(1).collect();
    let mut i = 0;
    while i < args.len() {
        let k = args[i].trim_start_matches("--").to_string();
        let val = |i: &mut usize| -> String {
            *i += 1;
            args.get(*i).cloned().unwrap_or_else(|| {
                eprintln!("--{} needs a value", k);
                process::exit(2);
            })
        };
        match args[i].as_str() {
            "--quiet" => p.quiet = true,
            "--tsv" => { p.tsv = true; p.quiet = true; }
            "--help" | "-h" => { println!("{}", HELP); process::exit(0); }
            "--ticks" => p.ticks = val(&mut i).parse().unwrap(),
            "--cols" => p.cols = val(&mut i).parse().unwrap(),
            "--rows" => p.rows = val(&mut i).parse().unwrap(),
            "--density" => p.density = val(&mut i).parse().unwrap(),
            "--starve" => p.starve = val(&mut i).parse().unwrap(),
            "--pressure" => p.pressure = val(&mut i).parse().unwrap(),
            "--mobility" => p.mobility = val(&mut i).parse().unwrap(),
            "--mutation" => p.mutation = val(&mut i).parse().unwrap(),
            "--rain" => p.rain = val(&mut i).parse().unwrap(),
            "--recall" => p.recall = val(&mut i).parse().unwrap(),
            "--birth" => p.birth = val(&mut i).parse().unwrap(),
            "--lonely" => p.lonely = val(&mut i).parse().unwrap(),
            "--crowd" => p.crowd = val(&mut i).parse().unwrap(),
            "--moore" => p.moore = val(&mut i).parse::<i32>().unwrap() != 0,
            "--bias" => p.bias = val(&mut i).parse().unwrap(),
            "--seed" => p.seed = val(&mut i).parse().unwrap(),
            "--reps" => p.reps = val(&mut i).parse().unwrap(),
            "--threads" => p.threads = val(&mut i).parse().unwrap(),
            "--marks" => p.marks = val(&mut i).split(',').map(|s| s.parse().unwrap()).collect(),
            other => { eprintln!("unknown flag {}", other); process::exit(2); }
        }
        i += 1;
    }
    if p.marks.is_empty() { p.marks = vec![p.ticks]; }
    p.marks.sort();
    if p.threads == 0 {
        p.threads = std::thread::available_parallelism().map(|v| v.get()).unwrap_or(4);
    }
    p
}

const HELP: &str = "\
Radical Chemistry - native simulator

  ./sim --ticks 6000 --cols 180 --rows 113 --recall 32
  ./sim --ticks 800 --reps 8 --threads 8 --tsv

  --ticks --cols --rows --density --starve --pressure --mobility --mutation
  --rain --recall --birth --lonely --crowd --moore --bias --seed
  --reps N --threads N   independent runs, in parallel
  --marks 300,800,1500   report at these ticks
  --quiet                summary only        --tsv  machine-readable rows";

fn main() {
    let p = parse();
    let dir = env::current_exe().ok()
        .and_then(|e| e.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default();
    let mut path = dir.join("data/world.tsv");
    if !path.exists() { path = std::path::PathBuf::from("data/world.tsv"); }
    let table = load(path.to_str().unwrap());

    let reps = p.reps.max(1);
    let threads = p.threads.min(reps).max(1);
    let mut results: Vec<Vec<Sample>> = Vec::new();
    let mut last: Option<Vec<(u32, u32, i32, i32, u8)>> = None;
    let mut totals = (0u64, 0u64, 0u64, 0u64, 0u64);

    let chunks: Vec<Vec<usize>> = (0..threads)
        .map(|t| (0..reps).filter(|r| r % threads == t).collect())
        .collect();

    std::thread::scope(|scope| {
        let mut handles = Vec::new();
        for chunk in &chunks {
            let table = &table;
            let p = p.clone();
            handles.push(scope.spawn(move || {
                let mut out = Vec::new();
                for &r in chunk {
                    let mut w = World::new(table, p.clone(), p.seed + r as u64);
                    let mut curve = Vec::new();
                    let mut mi = 0;
                    for _ in 0..p.ticks {
                        w.step();
                        while mi < p.marks.len() && p.marks[mi] == w.tick {
                            curve.push(w.sample());
                            mi += 1;
                        }
                    }
                    let top: Vec<(u32, u32, i32, i32, u8)> = w.found.iter()
                        .map(|&c| (w.count[c as usize], c as u32, w.src[c as usize].0,
                                   w.src[c as usize].1, table.level[c as usize]))
                        .collect();
                    out.push((curve, top, (w.bonds, w.repeats, w.births, w.deaths, w.splits),
                              w.novel.len()));
                }
                out
            }));
        }
        for h in handles {
            for (curve, top, tot, novel) in h.join().unwrap() {
                results.push(curve);
                last = Some(top);
                totals = (totals.0 + tot.0, totals.1 + tot.1, totals.2 + tot.2,
                          totals.3 + tot.3, totals.4 + tot.4);
                let _ = novel;
            }
        }
    });

    if p.tsv {
        println!("tick\tfound\tseen\tcomponents\tpop\tproducible_pct");
        for curve in &results {
            for s in curve {
                println!("{}\t{}\t{}\t{}\t{}\t{:.2}", s.tick, s.found, s.seen, s.comps,
                         s.pop, 100.0 * s.found as f64 / table.producible as f64);
            }
        }
        return;
    }

    let reps_f = results.len() as f64;
    println!("\n{} ticks on a {}x{} dish, {} run(s)", p.ticks, p.cols, p.rows, results.len());
    println!("{:>8}{:>10}{:>12}{:>11}{:>13}{:>10}", "tick", "found", "producible",
             "seen/all", "components", "pop");
    println!("{}", "-".repeat(63));
    for mi in 0..p.marks.len() {
        let mut f = 0.0; let mut s = 0.0; let mut c = 0.0; let mut o = 0.0;
        for curve in &results {
            if let Some(x) = curve.get(mi) {
                f += x.found as f64; s += x.seen as f64; c += x.comps as f64; o += x.pop as f64;
            }
        }
        println!("{:>8}{:>10.0}{:>11.1}%{:>10.1}%{:>9.0}/{:<3}{:>10.0}",
                 p.marks[mi], f / reps_f,
                 100.0 * (f / reps_f) / table.producible as f64,
                 100.0 * (s / reps_f) / table.n as f64,
                 c / reps_f, table.atoms.len(), o / reps_f);
    }

    if !p.quiet {
        if let Some(mut top) = last {
            top.sort_by(|a, b| b.0.cmp(&a.0));
            println!("\n  most re-invented:");
            for &(n, c, _, _, _) in top.iter().take(12) {
                let i = c as usize;
                println!("    {} x{:<5} {}  {}", table.name[i], n, table.pinyin[i], table.gloss[i]);
            }
            top.sort_by(|a, b| b.4.cmp(&a.4));
            println!("\n  deepest characters reached:");
            for &(_, c, a, b, lv) in top.iter().take(8) {
                let i = c as usize;
                if a < 0 { continue; }
                println!("    L{} {}  <- {} + {}   {}", lv, table.name[i],
                         table.name[a as usize], table.name[b as usize], table.gloss[i]);
            }
        }
        println!("\n  bonds {} - repeats {} - births {} - breaks {} - deaths {}",
                 totals.0, totals.1, totals.2, totals.4, totals.3);
        let _ = OPS;
    }
}
