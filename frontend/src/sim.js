// The simulation, its renderers and the panel wiring.
//
// This is the original single-file program, split out of the HTML and turned
// into a module. The panel is being moved to Preact components one section at
// a time; everything else stays imperative, because a 60 fps canvas loop and a
// wasm engine get nothing from a virtual DOM.

import DATA from "../../data/hanzi.json";
import WASM_B64 from "virtual:sim-wasm";
import * as STORE from "./store.js";
import { mountPanel } from "./ui/Panel.jsx";

export function boot() {
  const CH = DATA.chars, RX = DATA.recipes, DC = DATA.decomp, ATOMS = DATA.atoms;
  const OPS = ["⿰","⿱","⿴","⿵","⿸","⿺","⿻"];
  /* index order shared with the wasm engine; never reorder */
  const OPS_ALL = ["⿰","⿱","⿲","⿳","⿴","⿵","⿶","⿷","⿸","⿹","⿺","⿻"];
  const OPNAME = {"⿰":"side by side","⿱":"one above the other","⿲":"three columns","⿳":"three rows",
    "⿴":"one enclosing the other","⿵":"capped","⿶":"based","⿷":"framed on the left",
    "⿸":"upper left","⿹":"upper right","⿺":"lower left","⿻":"overlaid"};
  /* The ideographic description characters themselves are missing from plenty of
     system fonts, so an arrangement is always named in words instead. */
  const disp = c => (c && c.length === 3 && OPNAME[c[0]]) ? c.slice(1) : c;

  /* ---------- weighted atom sampling ---------- */
  const CUM = []; let TOT = 0;
  for (const a of ATOMS){ TOT += a[1]; CUM.push(TOT); }
  function randAtom(){
    let r = Math.random()*TOT, lo = 0, hi = CUM.length-1;
    while (lo < hi){ const m = (lo+hi)>>1; if (CUM[m] < r) lo = m+1; else hi = m; }
    return ATOMS[lo][0];
  }

  /* ---------- the semantic map ----------
     Every character carries an x/y derived offline from tf-idf over its English
     glosses and the glosses of every CC-CEDICT word it appears in, reduced by SVD
     and projected with t-SNE. Nearby dots mean related meanings. */
  const REGIONS = DATA.regions || [];
  const MCH = [];
  for (const c in CH) if (CH[c].x !== undefined) MCH.push(c);
  const MX = new Float32Array(MCH.length), MY = new Float32Array(MCH.length);
  for (let i=0; i<MCH.length; i++){
    MX[i] = CH[MCH[i]].x / 4000; MY[i] = CH[MCH[i]].y / 4000;
  }
  let standingSet = new Set();

  /* ---------- parameters ---------- */
  const S_MAX = 40, P_MAX = 12;
  const P = { speed:9, starve:6, pressure:6, mobility:.45, mutation:.0015, rain:3,
              birth:3, lonely:1, crowd:7, recall:0,
              density:.32, moore:true, cols:44, rows:28 };

  const PRESETS = [
    { key:"soup",    en:"Primordial soup", cn:"原湯",
      p:{starve:6,  pressure:6,  mobility:.45, mutation:.0015, rain:3, density:.32,
         birth:3, lonely:1, crowd:7, recall:0} },
    { key:"conway",  en:"Conway's rules",  cn:"康威",
      p:{starve:S_MAX, pressure:P_MAX, mobility:.10, mutation:.001, rain:1, density:.34,
         birth:3, lonely:2, crowd:3, recall:0} },
    { key:"desert",  en:"Harsh desert",    cn:"荒漠",
      p:{starve:2,  pressure:5,  mobility:.75, mutation:.001, rain:2,  density:.20,
         birth:3, lonely:1, crowd:7, recall:0} },
    { key:"jungle",  en:"Dense jungle",    cn:"密林",
      p:{starve:18, pressure:5,  mobility:.30, mutation:.004, rain:7,  density:.55,
         birth:2, lonely:0, crowd:8, recall:0} }
  ];

  const CONTROLS = [
    { k:"starve",   label:"Patience", min:1, max:S_MAX, step:1,
      fmt:v => v>=S_MAX ? "∞" : v + " ticks",
      note:"Ticks without bonding before starving, multiplied by level." },
    { k:"pressure", label:"Crowding limit", min:2, max:P_MAX, step:1,
      fmt:v => v>=P_MAX ? "never" : v + " neighbours",
      note:"A character this hemmed in breaks back into its two parts." },
    { k:"mobility", label:"Mobility", min:0, max:1, step:.05,
      fmt:v => Math.round(v*100)+"%",
      note:"Chance of drifting into an empty neighbour, divided by level." },
    { k:"mutation", label:"Mis-bonding", min:0, max:.02, step:.0005,
      fmt:v => (v*100).toFixed(2)+"%",
      note:"Chance an invalid pair fuses into a character that does not exist." },
    { k:"birth",    label:"Birth", min:2, max:5, step:1,
      fmt:v => "exactly " + v,
      note:"An empty square with this many neighbours comes alive, inheriting from one." },
    { k:"lonely",   label:"Death by isolation", min:0, max:4, step:1,
      fmt:v => v === 0 ? "off" : "under " + v,
      note:"Too few neighbours and a piece dies out." },
    { k:"crowd",    label:"Death by overcrowding", min:3, max:8, step:1,
      fmt:v => v >= 8 ? "off" : "over " + v,
      note:"Keeping this on matters: a dish that fills up completely stops mixing. Classic Conway is 3 · under 2 · over 3." },
    { k:"rain",     label:"Component rain", min:0, max:40, step:1,
      fmt:v => v + "/tick",
      note:"New components seeded each tick." },
    { k:"recall",   label:"Character rain", min:0, max:40, step:1,
      fmt:v => v === 0 ? "off" : v + "/tick",
      note:"Seeds characters this run has already discovered back into the dish, so deep compounds need not be rebuilt from components every time." },
    { k:"speed",    label:"Speed", min:1, max:60, step:1,
      fmt:v => v + " ticks/s", note:"" }
  ];

  /* ---------- state ---------- */
  let W = P.cols, H = P.rows, N = W*H;
  let cells = new Array(N).fill(null);
  let NB = null;
  const S = { tick:0, bonds:0, splits:0, deaths:0, births:0, repeats:0,
              real:0, novel:0, running:true };
  let recent = [], found = [];
  /* how much of the writing system this run has touched */
  let seenChars = new Set(), seenComp = new Set(), seenRx = new Set();
  let species = new Map();
  let log = [];
  let hovered = -1, lastFormed = null, logDirty = true, panelDirty = true;
  let pinnedChar = null;   /* a character hovered in the panel, not the canvas */

  const cv = document.getElementById("grid"), ctx = cv.getContext("2d", { alpha:false });
  let cs = 20, ox = 0, oy = 0, cw = 0, chh = 0, fitCS = 20, unit = 20;
  let paper = null, paperKey = "";
  let mode = "dish", hoverChar = null;
  const views = { dish:{ zoom:1, px:0, py:0 }, map:{ zoom:1, px:0, py:0 } };
  let view = views.dish;
  const ZOOM = { dish:[.4, 6], map:[.6, 14] };
  const mapFit = () => Math.min(cw, chh) * .92;

  /* ---------- theme-aware colours ---------- */
  let COL = {};
  function readColors(){
    const s = getComputedStyle(document.documentElement);
    const get = n => s.getPropertyValue(n).trim();
    COL = {
      lv:[get("--lv0"),get("--lv1"),get("--lv2"),get("--lv3"),get("--lv4"),get("--lv5")].map(hex2rgb),
      synth:hex2rgb(get("--synth")), alarm:hex2rgb(get("--alarm")),
      dish:get("--dish"), dot:get("--dot"),
      fibreA:get("--fibre-a"), fibreB:get("--fibre-b")
    };
    paper = null;   /* the sheet is tinted by the theme, so redraw it */
  }
  function hex2rgb(h){
    h = h.replace("#","");
    if (h.length === 3) h = h.split("").map(c=>c+c).join("");
    return [parseInt(h.slice(0,2),16), parseInt(h.slice(2,4),16), parseInt(h.slice(4,6),16)];
  }
  function rgba(c,a){ return "rgba("+c[0]+","+c[1]+","+c[2]+","+a+")"; }
  function mix(a,b,t){ return [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t].map(Math.round); }
  readColors();
  if (window.matchMedia) matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readColors);

  /* ---------- helpers ---------- */
  const lvOf = c => CH[c] ? CH[c].l : 0;
  const lvClamp = l => Math.min(5, l);
  function patienceOf(c){
    if (P.starve >= S_MAX) return Infinity;
    return c.synth ? P.starve : P.starve * (c.lv + 1);
  }
  const patience = lv => P.starve >= S_MAX ? Infinity : P.starve * (lv+1);
  function mk(c, lv, from, synth){
    if (!synth && CH[c]){
      seenChars.add(c);
      if (CH[c].l === 0) seenComp.add(c);
    }
    return { c:c, lv:lv, t:0, cool:0, glow:1, born:S.tick, from:from||null, synth:!!synth };
  }
  function shuffle(a){
    for (let i=a.length-1; i>0; i--){ const j = (Math.random()*(i+1))|0; const t=a[i]; a[i]=a[j]; a[j]=t; }
    return a;
  }
  function buildNB(){
    const o8 = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
    const o4 = [[0,-1],[-1,0],[1,0],[0,1]];
    const off = P.moore ? o8 : o4;
    NB = new Array(N);
    for (let y=0; y<H; y++) for (let x=0; x<W; x++){
      const a = new Int32Array(off.length);
      for (let k=0; k<off.length; k++){
        a[k] = ((y+off[k][1]+H)%H)*W + ((x+off[k][0]+W)%W);
      }
      NB[y*W+x] = a;
    }
  }
  function pickRecipe(rs){
    if (rs.length === 1) return rs[0];
    let tw = 0; const w = [];
    for (const r of rs){ const f = (CH[r[0]] ? CH[r[0]].f : 0) + 1; w.push(f); tw += f; }
    let x = Math.random()*tw;
    for (let k=0; k<rs.length; k++){ x -= w[k]; if (x <= 0) return rs[k]; }
    return rs[rs.length-1];
  }

  /* ---------- the tick, in JavaScript (the fallback engine) ---------- */
  function jsTick(){
    S.tick++;
    const acted = new Uint8Array(N), gone = new Uint8Array(N);
    const occ = [];
    for (let i=0; i<N; i++) if (cells[i]) occ.push(i);
    shuffle(occ);

    /* 1 — synthesis */
    for (const i of occ){
      if (gone[i] || acted[i]) continue;
      const a = cells[i]; if (!a || a.cool > 0) continue;
      const nb = NB[i], off = (Math.random()*nb.length)|0;
      /* one roll per piece per tick, so the slider means what it says */
      const misbond = P.mutation > 0 && Math.random() < P.mutation;
      for (let k=0; k<nb.length; k++){
        const j = nb[(k+off) % nb.length];
        if (gone[j] || acted[j]) continue;
        const b = cells[j]; if (!b || b.cool > 0) continue;
        const rs = RX[a.c < b.c ? a.c+"|"+b.c : b.c+"|"+a.c];
        let res = null, op = null, synth = false;
        if (rs){ const p = pickRecipe(rs); res = p[0]; op = p[1]; }
        else if (misbond && a.c.length === 1 && b.c.length === 1){
          op = OPS[(Math.random()*OPS.length)|0]; res = op + a.c + b.c; synth = true;
        }
        if (!res) continue;
        const lv = synth ? 1 + Math.max(a.lv, b.lv) : lvOf(res);
        cells[i] = mk(res, lv, [a.c, b.c, op], synth);
        cells[j] = null; gone[j] = 1; acted[i] = 1;
        record(res, synth, [a.c, b.c, op], lv);
        break;
      }
    }

    /* 2 — starvation */
    for (let i=0; i<N; i++){
      const c = cells[i]; if (!c) continue;
      if (c.cool > 0) c.cool--;
      if (acted[i]){ c.t = 0; continue; }
      c.t++;
      if (c.t > patienceOf(c)){ cells[i] = null; S.deaths++; }
    }

    /* 3 — the life layer: birth by inheritance, death by isolation or crowding */
    {
      const cnt = new Int16Array(N);
      for (let i=0; i<N; i++) if (cells[i]) for (const j of NB[i]) cnt[j]++;
      const born = [], died = [];
      for (let i=0; i<N; i++){
        const c = cells[i];
        if (c){
          if ((P.lonely > 0 && cnt[i] < P.lonely) || (P.crowd < 8 && cnt[i] > P.crowd)) died.push(i);
        } else if (cnt[i] === P.birth){
          const par = [];
          for (const j of NB[i]) if (cells[j] && !cells[j].synth) par.push(cells[j]);
          if (par.length) born.push([i, par[(Math.random()*par.length)|0]]);
        }
      }
      for (const i of died){ cells[i] = null; S.deaths++; }
      for (const b of born){
        if (cells[b[0]]) continue;
        const par = b[1];
        const c = mk(par.c, par.lv, par.from, par.synth);
        c.glow = .55; c.t = Math.min(par.t, 1);
        cells[b[0]] = c;
        S.births++;
        if (par.lv > 0) countAgain(par.c);
      }
    }

    /* 4 — crowding breaks characters back apart */
    if (P.pressure < P_MAX){
      for (const i of occ){
        const c = cells[i];
        /* a bond that just formed gets a moment to settle */
        if (!c || acted[i] || c.lv === 0 || S.tick - c.born < 3) continue;
        const d = DC[c.c] || c.from;
        if (!d) continue;
        let cnt = 0; const empties = [];
        for (const j of NB[i]){ if (cells[j]) cnt++; else empties.push(j); }
        if (cnt >= P.pressure + Math.min(2, c.lv - 1) && empties.length){
          const j = empties[(Math.random()*empties.length)|0];
          cells[i] = mk(d[0], lvOf(d[0])); cells[i].cool = 3;
          cells[j] = mk(d[1], lvOf(d[1])); cells[j].cool = 3;
          S.splits++;
        }
      }
    }

    /* 5 — diffusion */
    const move = [];
    for (let i=0; i<N; i++) if (cells[i]) move.push(i);
    shuffle(move);
    for (const i of move){
      const c = cells[i]; if (!c) continue;
      if (Math.random() >= P.mobility / (c.lv + 1)) continue;
      const nb = NB[i], j = nb[(Math.random()*nb.length)|0];
      if (!cells[j]){ cells[j] = c; cells[i] = null; }
    }

    /* 6 — component rain */
    for (let k=0; k<P.rain; k++){
      for (let a=0; a<14; a++){
        const i = (Math.random()*N)|0;
        if (!cells[i]){ const c = mk(randAtom(), 0); c.glow = .35; cells[i] = c; break; }
      }
    }

    /* 7 — character rain: hand back something the run already worked out */
    if (P.recall > 0 && found.length){
      for (let k=0; k<P.recall; k++){
        for (let a=0; a<14; a++){
          const i = (Math.random()*N)|0;
          if (!cells[i]){
            const ch = found[(Math.random()*found.length)|0];
            const c = mk(ch, lvOf(ch));
            c.glow = .5;
            cells[i] = c;
            break;
          }
        }
      }
    }
    panelDirty = true;
  }

  function record(c, synth, from, lv){
    S.bonds++;
    if (!synth){
      const a = from[0], b = from[1];
      seenRx.add((a < b ? a + "|" + b : b + "|" + a) + ">" + c);
    }
    let s = species.get(c), fresh = false;
    if (!s){
      fresh = true;
      s = { c:c, first:S.tick, count:0, copies:0, synth:synth, from:from, lv:lv };
      species.set(c, s);
      if (synth) S.novel++; else { S.real++; found.push(c); }
      log.unshift(s);
      if (log.length > 260) log.pop();
    } else {
      S.repeats++;
    }
    s.count++;
    lastFormed = s;
    recent.unshift({ c:c, tick:S.tick, fresh:fresh, synth:synth, n:s.count, from:from });
    if (recent.length > 40) recent.pop();
    logDirty = true;
  }

  /* a piece copied into an empty square by the birth rule, not built from parts */
  function countAgain(c){
    const s = species.get(c);
    if (s) s.copies++;
  }

  /* ================= the engine =================
     The rules live in sim.rs and are compiled to WebAssembly. The JavaScript
     below is a complete second implementation, kept as a fallback for anywhere
     the wasm module will not instantiate (a strict Content-Security-Policy, for
     instance). Whichever engine runs, it produces the same `cells` array and
     feeds the same record(), so nothing downstream knows the difference. */
  let ENGINE = null, WX = null, wStats = null;

  /* Index tables, built once from the data the page already carries, so no
     second copy of the dictionary is shipped for the engine's benefit. */
  const NAMES = Object.keys(CH).sort();
  const CIDX = new Map(NAMES.map((c, i) => [c, i]));

  function marshal(X){
    const n = NAMES.length;
    const put = (arr, Ctor) => {
      const p = X.alloc(Math.max(1, arr.length * Ctor.BYTES_PER_ELEMENT));
      if (arr.length) new Ctor(X.memory.buffer, p, arr.length).set(arr);
      return p;
    };
    const levels = new Uint8Array(n), freq = new Uint32Array(n);
    for (let i = 0; i < n; i++){ levels[i] = CH[NAMES[i]].l; freq[i] = CH[NAMES[i]].f || 0; }

    const ra = [], rb = [], rr = [], rop = [];
    for (const key in RX){
      const parts = key.split("|");
      if (!CIDX.has(parts[0]) || !CIDX.has(parts[1])) continue;
      for (const e of RX[key]){
        if (!CIDX.has(e[0])) continue;
        ra.push(CIDX.get(parts[0])); rb.push(CIDX.get(parts[1]));
        rr.push(CIDX.get(e[0])); rop.push(Math.max(0, OPS_ALL.indexOf(e[1])));
      }
    }
    const da = new Int32Array(n).fill(-1), db = new Int32Array(n).fill(-1), dop = new Uint8Array(n);
    for (const c in DC){
      const d = DC[c];
      if (!CIDX.has(c) || !CIDX.has(d[0]) || !CIDX.has(d[1])) continue;
      const i = CIDX.get(c);
      da[i] = CIDX.get(d[0]); db[i] = CIDX.get(d[1]); dop[i] = Math.max(0, OPS_ALL.indexOf(d[2]));
    }
    const av = new Int32Array(ATOMS.length), aw = new Float64Array(ATOMS.length);
    for (let i = 0; i < ATOMS.length; i++){ av[i] = CIDX.get(ATOMS[i][0]); aw[i] = ATOMS[i][1]; }

    X.init_tables(n, put(levels, Uint8Array), put(freq, Uint32Array),
      ra.length, put(Int32Array.from(ra), Int32Array), put(Int32Array.from(rb), Int32Array),
      put(Int32Array.from(rr), Int32Array), put(Uint8Array.from(rop), Uint8Array),
      put(da, Int32Array), put(db, Int32Array), put(dop, Uint8Array),
      av.length, put(av, Int32Array), put(aw, Float64Array));
  }

  function wasmPush(){
    WX.set_params(P.starve, P.pressure, P.mobility, P.mutation, P.rain, P.recall,
                  P.birth, P.lonely, P.crowd, P.moore ? 1 : 0);
  }

  /* Copy the grid out of wasm memory into the cell objects the page renders.
     Views are rebuilt each time because wasm memory can move when it grows. */
  function wasmPull(){
    WX.sync();
    const buf = WX.memory.buffer, n = W*H;
    const vCh = new Int32Array(buf, WX.ptr_ch(), n);
    const vLv = new Uint8Array(buf, WX.ptr_lv(), n);
    const vT  = new Uint16Array(buf, WX.ptr_t(), n);
    const vSy = new Uint8Array(buf, WX.ptr_syn(), n);
    const vSa = new Int32Array(buf, WX.ptr_sa(), n);
    const vSb = new Int32Array(buf, WX.ptr_sb(), n);
    const vBo = new Int32Array(buf, WX.ptr_born(), n);
    wStats = new Float64Array(buf, WX.ptr_stats(), 10);

    for (let i = 0; i < n; i++){
      const code = vCh[i];
      if (code === -1){ cells[i] = null; continue; }
      const synth = vSy[i] > 0;
      const op = synth ? OPS_ALL[vSy[i] - 1] : null;
      const a = vSa[i], b = vSb[i];
      const name = synth ? op + NAMES[a] + NAMES[b] : NAMES[code];
      let c = cells[i];
      if (!c) c = cells[i] = { c:name, lv:0, t:0, cool:0, glow:0, born:0, from:null, synth:false };
      else if (c.c !== name) c.glow = 1;
      c.c = name; c.lv = vLv[i]; c.t = vT[i]; c.synth = synth; c.born = vBo[i];
      c.from = (a >= 0 && b >= 0) ? [NAMES[a], NAMES[b], op || (DC[name] ? DC[name][2] : "")] : null;
      if (S.tick - c.born < 1) c.glow = 1;
    }
    S.births = wStats[3]; S.deaths = wStats[4]; S.splits = wStats[5];
  }

  function wasmTick(){
    wasmPush();
    WX.tick();
    S.tick++;
    const ev = new Int32Array(WX.memory.buffer, WX.ptr_events(), WX.len_events());
    for (let k = 0; k < ev.length; k += 5){
      const synth = ev[k+4] !== 0, a = NAMES[ev[k+1]], b = NAMES[ev[k+2]], op = OPS_ALL[ev[k+3]];
      const name = synth ? op + a + b : NAMES[ev[k]];
      const lv = synth ? 1 + Math.max(lvOf(a), lvOf(b)) : lvOf(name);
      record(name, synth, [a, b, op], lv);
    }
    wasmPull();
    panelDirty = true;
  }

  function wasmReseed(){
    WX.init_world(W, H, P.moore ? 1 : 0, P.density, (Math.random() * 4294967296) >>> 0);
    wasmPush();
    cells = new Array(W*H).fill(null);
    wasmPull();
  }
  function wasmResize(cols, rows){
    W = cols; H = rows; N = W*H;
    WX.resize_world(cols, rows, P.density);
    cells = new Array(N).fill(null);
    wasmPull();
  }
  function wasmClear(){ WX.clear_dish(); wasmPull(); panelDirty = true; }
  function wasmSow(i){ WX.sow(i); wasmPull(); }

  const JS_ENGINE = { name:"JavaScript", wasm:false, tick:jsTick, seed:jsReseed,
                      clear:jsClear, resize:jsResize, sow:jsSow };

  function startEngine(){
    ENGINE = JS_ENGINE;
    if (!WASM_B64 || WASM_B64.indexOf("__WASM") === 0) return;   /* not built in */
    try {
      const bin = Uint8Array.from(atob(WASM_B64), ch => ch.charCodeAt(0));
      const inst = new WebAssembly.Instance(new WebAssembly.Module(bin), {});
      WX = inst.exports;
      marshal(WX);
      ENGINE = { name:"WebAssembly", wasm:true, tick:wasmTick, seed:wasmReseed,
                 clear:wasmClear, resize:wasmResize, sow:wasmSow };
    } catch (err){
      /* a strict CSP, or no wasm at all: the JavaScript engine is complete */
      WX = null;
      ENGINE = JS_ENGINE;
    }
  }

  /* one entry point each, whichever engine is live */
  function tick(){ ENGINE.tick(); }
  function clearDish(){ ENGINE.clear(); }
  function reseed(){
    S.tick = 0; S.bonds = 0; S.splits = 0; S.deaths = 0; S.births = 0;
    S.repeats = 0; S.real = 0; S.novel = 0;
    species = new Map(); log = []; recent = []; found = []; lastFormed = null;
    seenChars = new Set(); seenComp = new Set(); seenRx = new Set();
    treePlaceholder();
    ENGINE.seed();
    logDirty = panelDirty = true;
  }

  /* ---------- seeding ---------- */
  function jsReseed(){
    cells = new Array(N).fill(null);
    for (let i=0; i<N; i++) if (Math.random() < P.density) cells[i] = mk(randAtom(), 0);
  }
  function jsClear(){
    cells = new Array(N).fill(null);
    panelDirty = true;
  }

  /* ---------- rendering ---------- */
  function resize(){
    const r = cv.parentElement.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    cw = Math.max(1, Math.floor(r.width)); chh = Math.max(1, Math.floor(r.height));
    cv.width = cw*dpr; cv.height = chh*dpr;
    cv.style.width = cw+"px"; cv.style.height = chh+"px";
    ctx.setTransform(dpr,0,0,dpr,0,0);
    layout();
  }

  /* Zoom 1 fits the whole world in the dish; beyond that the view pans.
     The map uses the same machinery, with the unit square in place of the grid. */
  function unitFor(z){
    return mode === "dish" ? Math.max(2, Math.min(cw/W, chh/H) * z)
                           : Math.max(120, mapFit() * z);
  }
  function layout(){
    fitCS = Math.min(cw/W, chh/H);
    unit = unitFor(view.zoom);
    cs = unit;
    const gw = mode === "dish" ? cs*W : unit, gh = mode === "dish" ? cs*H : unit;
    if (gw <= cw){ ox = Math.round((cw-gw)/2); view.px = ox; }
    else { view.px = Math.min(0, Math.max(cw-gw, view.px)); ox = Math.round(view.px); }
    if (gh <= chh){ oy = Math.round((chh-gh)/2); view.py = oy; }
    else { view.py = Math.min(0, Math.max(chh-gh, view.py)); oy = Math.round(view.py); }
    cv.classList.toggle("pannable", gw > cw || gh > chh);
  }
  function zoomAt(mult, mx, my){
    const gx = (mx - ox)/unit, gy = (my - oy)/unit;
    const lim = ZOOM[mode];
    const z = Math.max(lim[0], Math.min(lim[1], view.zoom * mult));
    if (z === view.zoom) return;
    view.zoom = z;
    const nu = unitFor(z);
    view.px = mx - gx*nu; view.py = my - gy*nu;
    layout(); syncView();
  }
  function fitView(){ view.zoom = 1; view.px = view.py = 0; layout(); syncView(); }
  function setMode(m){
    if (mode === m) return;
    mode = m; view = views[m]; hoverChar = null; hovered = -1;
    $("m-dish").classList.toggle("on", m === "dish");
    $("m-map").classList.toggle("on", m === "map");
    $("hint").textContent = hintFor(m);
    layout(); syncView(); paintReadout();
  }

  /* Growing the world keeps everything already alive and seeds only the new ground. */
  function jsResize(cols, rows){
    const oW = W, oH = H, old = cells;
    W = cols; H = rows; N = W*H;
    const next = new Array(N).fill(null);
    for (let y=0; y<Math.min(H,oH); y++)
      for (let x=0; x<Math.min(W,oW); x++) next[y*W+x] = old[y*oW+x];
    for (let y=0; y<H; y++) for (let x=0; x<W; x++){
      if ((y < oH && x < oW) || Math.random() >= P.density) continue;
      next[y*W+x] = mk(randAtom(), 0);
    }
    cells = next;
    buildNB();
  }
  function jsSow(i){ if (!cells[i]) cells[i] = mk(randAtom(), 0); }

  function setWorld(cols){
    cols = Math.max(14, Math.min(180, Math.round(cols)));
    const rows = Math.max(8, Math.round(cols * (chh && cw ? chh/cw : .62)));
    if (cols === W && rows === H) return;
    P.cols = cols; P.rows = rows;
    ENGINE.resize(cols, rows);
    layout(); syncView(); panelDirty = true;
  }
  const HANFONT = '"Songti SC","Source Han Serif SC","Noto Serif CJK SC","Noto Serif SC","Hiragino Mincho ProN","Yu Mincho","SimSun","MS Mincho",serif';

  /* A sheet of paper, drawn once per size and theme: loose fibres and a few soft
     blooms where the sizing takes ink differently. Reused every frame. */
  function makePaper(){
    const key = cw + "x" + chh + "|" + COL.dish;
    if (paper && paperKey === key) return;
    const c = document.createElement("canvas");
    c.width = Math.max(1, cw); c.height = Math.max(1, chh);
    const g = c.getContext("2d");
    g.fillStyle = COL.dish;
    g.fillRect(0, 0, c.width, c.height);
    g.lineWidth = 1;
    const fibres = Math.min(9000, Math.round(cw * chh / 700));
    for (let i = 0; i < fibres; i++){
      const x = Math.random()*cw, y = Math.random()*chh;
      const len = 5 + Math.random()*26, a = Math.random()*Math.PI;
      g.strokeStyle = Math.random() < .5 ? COL.fibreA : COL.fibreB;
      g.globalAlpha = .022 + Math.random()*.04;
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a)*len, y + Math.sin(a)*len); g.stroke();
    }
    for (let i = 0; i < 12; i++){
      const x = Math.random()*cw, y = Math.random()*chh, r = 70 + Math.random()*170;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, COL.fibreA);
      grd.addColorStop(1, "rgba(0,0,0,0)");
      g.globalAlpha = .05; g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, r, 0, 6.2832); g.fill();
    }
    g.globalAlpha = 1;
    paper = c; paperKey = key;
  }

  function draw(dt){
    /* fade every flash, on screen or not, so nothing pops when panned into view */
    const decay = Math.pow(.86, dt*60);
    for (let i=0; i<N; i++){
      const c = cells[i];
      if (c && c.glow > .02) c.glow *= decay; else if (c) c.glow = 0;
    }
    makePaper();
    if (paper) ctx.drawImage(paper, 0, 0);
    else { ctx.fillStyle = COL.dish; ctx.fillRect(0,0,cw,chh); }
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    if (mode === "dish") drawDish(); else drawMap();
  }

  function drawDish(){

    const x0 = Math.max(0, Math.floor(-ox/cs)), x1 = Math.min(W-1, Math.ceil((cw-ox)/cs));
    const y0 = Math.max(0, Math.floor(-oy/cs)), y1 = Math.min(H-1, Math.ceil((chh-oy)/cs));

    /* the dish floor */
    if (cs >= 7){
      ctx.fillStyle = COL.dot;
      for (let y=y0; y<=y1; y++) for (let x=x0; x<=x1; x++){
        if (cells[y*W+x]) continue;
        ctx.fillRect(ox + x*cs + cs/2 - .5, oy + y*cs + cs/2 - .5, 1, 1);
      }
    }

    for (let gy=y0; gy<=y1; gy++) for (let gx=x0; gx<=x1; gx++){
      const i = gy*W + gx;
      const c = cells[i]; if (!c) continue;
      const x = ox + gx*cs + cs/2, y = oy + gy*cs + cs/2;
      const pat = patienceOf(c);
      const wear = pat === Infinity ? 0 : Math.min(1, c.t/pat);
      const col = c.synth ? COL.synth : COL.lv[lvClamp(c.lv)];
      /* a starving piece pales the way ink dries, rather than changing colour */
      const alpha = 1 - .6*wear;
      const glyphs = disp(c.c).length;
      const size = glyphs > 1 ? cs*.30 : cs*(.60 + Math.min(c.lv,5)*.035);
      ctx.font = (c.lv >= 4 ? "600 " : "400 ") + size.toFixed(1) + "px " + HANFONT;
      if (c.glow > .02){
        ctx.shadowColor = rgba(col, Math.min(.9, c.glow));
        ctx.shadowBlur = cs * .85 * c.glow;
      } else ctx.shadowBlur = 0;
      ctx.fillStyle = rgba(col, alpha);
      ctx.fillText(disp(c.c), x, y);
    }
    ctx.shadowBlur = 0;

    if (hovered >= 0 && cells[hovered]){
      const x = ox + (hovered % W)*cs, y = oy + ((hovered/W)|0)*cs;
      ctx.strokeStyle = rgba(COL.lv[0], .85); ctx.lineWidth = 1;
      ctx.strokeRect(Math.round(x)+.5, Math.round(y)+.5, Math.round(cs)-1, Math.round(cs)-1);
    }
  }

  function drawMap(){
    const u = unit, R = 4000;
    const px = v => ox + v*u;

    /* region names, drawn under everything */
    if (u < 14000){
      ctx.font = "500 " + Math.max(9, Math.min(16, u*.013)).toFixed(0)
        + 'px "IBM Plex Mono", ui-monospace, monospace';
      ctx.fillStyle = rgba(COL.lv[0], .45);
      for (const r of REGIONS){
        const x = px(r.x/R), y = oy + r.y/R*u;
        if (x < -90 || x > cw+90 || y < -30 || y > chh+30) continue;
        ctx.fillText(r.t.toUpperCase(), x, y);
      }
    }

    /* the whole writing system, unlit */
    const glyphs = u > 2200;
    ctx.fillStyle = rgba(COL.lv[0], .28);
    for (let i=0; i<MCH.length; i++){
      if (species.has(MCH[i])) continue;
      const x = px(MX[i]), y = oy + MY[i]*u;
      if (x < -6 || x > cw+6 || y < -6 || y > chh+6) continue;
      ctx.fillRect(x-.7, y-.7, 1.4, 1.4);
    }
    if (u > 5200){
      ctx.fillStyle = rgba(COL.lv[0], .3);
      ctx.font = "400 12px " + HANFONT;
      for (let i=0; i<MCH.length; i++){
        if (species.has(MCH[i])) continue;
        const x = px(MX[i]), y = oy + MY[i]*u;
        if (x < -14 || x > cw+14 || y < -14 || y > chh+14) continue;
        ctx.fillText(MCH[i], x, y);
      }
    }

    /* where the last bonds travelled: parents to child */
    ctx.lineWidth = 1;
    for (let k=0; k<Math.min(14, recent.length); k++){
      const r = recent[k];
      const kid = CH[r.c];
      if (!kid || kid.x === undefined || !r.from) continue;
      const a = (1 - k/20) * .2;
      for (let q=0; q<2; q++){
        const pe = CH[r.from[q]];
        if (!pe || pe.x === undefined) continue;
        ctx.strokeStyle = rgba(COL.lv[lvClamp(lvOf(r.c))], a);
        ctx.beginPath();
        ctx.moveTo(px(pe.x/R), oy + pe.y/R*u);
        ctx.lineTo(px(kid.x/R), oy + kid.y/R*u);
        ctx.stroke();
      }
    }

    /* everything the run has discovered */
    ctx.font = "500 " + Math.max(12, Math.min(30, u*.006)).toFixed(0) + "px " + HANFONT;
    for (const s of species.values()){
      if (s.synth) continue;
      const e = CH[s.c];
      if (!e || e.x === undefined) continue;
      const x = px(e.x/R), y = oy + e.y/R*u;
      if (x < -24 || x > cw+24 || y < -24 || y > chh+24) continue;
      const col = COL.lv[lvClamp(s.lv)];
      const alive = standingSet.has(s.c);
      if (glyphs){
        ctx.fillStyle = rgba(col, alive ? 1 : .5);
        ctx.fillText(s.c, x, y);
      } else {
        const r = 1.7 + Math.min(5.5, Math.log2(1 + s.count) * 1.15);
        ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832);
        ctx.fillStyle = rgba(col, alive ? .95 : .45); ctx.fill();
        if (alive){
          ctx.beginPath(); ctx.arc(x, y, r + 2.5, 0, 6.2832);
          ctx.strokeStyle = rgba(col, .35); ctx.stroke();
        }
      }
    }

    if (hoverChar && CH[hoverChar] && CH[hoverChar].x !== undefined){
      const e = CH[hoverChar];
      const x = px(e.x/R), y = oy + e.y/R*u;
      ctx.beginPath(); ctx.arc(x, y, 9, 0, 6.2832);
      ctx.strokeStyle = rgba(COL.lv[0], .9); ctx.lineWidth = 1; ctx.stroke();
    }
  }

  function nearestChar(mx, my){
    let best = -1, bd = Infinity;
    for (let i=0; i<MCH.length; i++){
      const dx = ox + MX[i]*unit - mx, dy = oy + MY[i]*unit - my;
      let d = dx*dx + dy*dy;
      if (species.has(MCH[i])) d *= .3;   /* discovered dots are easier to grab */
      if (d < bd){ bd = d; best = i; }
    }
    return bd <= 22*22 ? MCH[best] : null;
  }

  /* ---------- genealogy ----------
     A character's decomposition tree. Its depth is its level by construction, so
     deeper characters really do draw bigger trees. */
  function buildTree(ch, path, rootFrom){
    const d = (path.length === 0 && rootFrom) ? rootFrom : DC[ch];
    if (!d || path.indexOf(ch) >= 0 || path.length > 8) return { c:ch, kids:null, h:0 };
    const p = path.concat(ch);
    const kids = [buildTree(d[0], p), buildTree(d[1], p)];
    return { c:ch, op:d[2], kids:kids, h:1 + Math.max(kids[0].h, kids[1].h) };
  }

  /* Sized from the column's actual width, with a legible floor: widen the
     inspector and the tree grows with it. */
  function treeMetrics(depth){
    const avail = Math.max(150, ($("tree").clientWidth || 170) - 8);
    /* Column width is set by how deep the tree is; glyph size is set by how much
       room each node has. They are not the same thing, so a deep tree gets tight
       columns rather than tiny characters. */
    const col = Math.max(24, Math.min(64, Math.floor((avail - 20) / (depth + 0.55))));
    const row = Math.max(20, Math.min(34, Math.round(col * 0.82)));
    const glyph = Math.max(14, Math.min(23, Math.round(Math.min(col * 0.66, row * 0.74))));
    return { col: col, row: row, pad: 6, r: Math.round(glyph * 0.62),
             leaf: glyph, node: Math.min(26, glyph + 2) };
  }
  let treeFor = null;



  /* ---------- panel rendering ---------- */
  const $ = id => document.getElementById(id);
  const LVNAME = ["Components","Level 1","Level 2","Level 3","Level 4","Level 5+"];




  function esc(s){ return String(s).replace(/[&<>"]/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[m])); }
  function cardTitle(c){
    const e = CH[c];
    return e ? (c + " " + (e.p||"") + (e.d ? " — " + e.d : "")) : disp(c) + " (not a character)";
  }




  /* ---------- publishing to the panel ----------
     These used to build HTML strings. They now write plain data into signals
     and the components in ui/Panel.jsx render it. */

  function treePlaceholder(){ treeFor = null; STORE.tree.value = null; }

  function showTree(ch){
    if (!ch || ch === treeFor) return;
    treeFor = ch;
    const sp = species.get(ch);
    const root = buildTree(ch, [], sp && sp.synth ? sp.from : null);
    if (!root.kids){ STORE.tree.value = { bare:true, shown: disp(ch) }; return; }

    let rows = 0;
    const flat = [];
    (function place(n){
      if (!n.kids) n.row = rows++;
      else { place(n.kids[0]); place(n.kids[1]); n.row = (n.kids[0].row + n.kids[1].row)/2; }
      flat.push(n);
    })(root);

    const M = treeMetrics(root.h);
    const X = n => M.pad + n.h * M.col;
    const Y = n => M.pad + n.row * M.row + M.row/2;
    const edges = [], nodes = [];
    for (const n of flat){
      if (n.kids){
        const jx = X(n) - M.col*.45;
        for (const k of n.kids) edges.push('M' + (X(k)+M.r) + ',' + Y(k) + ' H' + jx + ' V' + Y(n));
        edges.push('M' + jx + ',' + Y(n) + ' H' + (X(n)-M.r));
      }
      const leaf = !n.kids;
      nodes.push({ x:X(n), y:Y(n), ch:disp(n.c), size: leaf ? M.leaf : M.node,
                   lv: leaf ? 0 : lvClamp(lvOf(n.c)), leaf, title: cardTitle(n.c) });
    }
    STORE.tree.value = {
      shown: disp(ch),
      meta: (sp && sp.synth ? "invented" : "level " + root.h) + " · " + rows + " components",
      w: M.pad*2 + root.h * M.col + Math.round(M.node * 0.8),
      h: M.pad*2 + rows * M.row,
      edges, nodes,
    };
  }

  function paintPanel(){
    let pop = 0; const levels = [0,0,0,0,0,0]; let synth = 0;
    const alive = new Map();
    standingSet = new Set();
    for (let i=0; i<N; i++){
      const c = cells[i]; if (!c) continue;
      pop++;
      standingSet.add(c.c);
      if (c.synth) synth++; else levels[lvClamp(c.lv)]++;
      if (c.lv > 0) alive.set(c.c, (alive.get(c.c)||0) + 1);
    }
    const cSeen = (ENGINE.wasm && wStats) ? wStats[6] : seenChars.size;
    const cComp = (ENGINE.wasm && wStats) ? wStats[7] : seenComp.size;

    STORE.vitals.value = { tick: S.tick, real: S.real };
    STORE.census.value = { pop, levels, synth };
    STORE.coverage.value = {
      rx: seenRx.size, seen: cSeen, comp: cComp, built: S.real,
      totals: { reactions: DATA.meta.reactions, characters: DATA.meta.characters,
                atoms: DATA.meta.atoms },
    };
    STORE.tally.value = { real: S.real, repeats: S.repeats, novel: S.novel };
    STORE.standing.value = [...alive.entries()]
      .sort((a,b) => b[1]-a[1]).slice(0,14)
      .map(([c,n]) => {
        const sp = species.get(c);
        return { ch:c, shown: disp(c), n,
                 cls: sp && sp.synth ? "syn" : "lv" + lvClamp(CH[c] ? CH[c].l : 1),
                 title: cardTitle(c) };
      });
    STORE.colophon.value = ENGINE.name + " engine · this run: "
      + S.bonds.toLocaleString() + " bonds · " + S.births.toLocaleString() + " births · "
      + S.splits.toLocaleString() + " breaks · " + S.deaths.toLocaleString() + " deaths.";

    $("census-n").textContent = pop + " standing";
  }

  function paintRecent(){
    STORE.ticker.value = {
      bonds: S.bonds,
      items: recent.slice(0,22).map(r => {
        const sp = species.get(r.c);
        return { ch:r.c, shown: disp(r.c), fresh: r.fresh, n: r.n,
                 cls: r.synth ? "syn" : "lv" + lvClamp(sp ? sp.lv : 1),
                 title: cardTitle(r.c) + (r.fresh ? " — first appearance" : "") };
      }),
    };
    $("recent-n").textContent = S.bonds ? S.bonds.toLocaleString() + " bonds" : "";
  }

  function paintLog(){
    STORE.discoveries.value = log.map(s => {
      const e = CH[s.c] || null;
      const op = s.from && s.from[2] ? s.from[2] : "";
      return {
        ch: s.c, shown: disp(s.c), a: s.from[0], b: s.from[1],
        la: lvClamp(lvOf(s.from[0])), lb: lvClamp(lvOf(s.from[1])),
        cls: s.synth ? "syn" : "lv" + lvClamp(s.lv),
        first: s.first, count: s.count, synth: !!s.synth,
        arrangement: OPNAME[op] || "",
        pinyin: e ? e.p : "", gloss: e ? e.d : "",
      };
    });
  }

  function paintReadout(){
    const c = (mode === "dish" && hovered >= 0 && cells[hovered]) ? cells[hovered] : null;
    let sp = null, ch = null, onMap = false;
    if (c) ch = c.c;
    else if (mode === "map" && hoverChar){ ch = hoverChar; sp = species.get(ch) || null; onMap = true; }
    else if (pinnedChar){ ch = pinnedChar; sp = species.get(ch) || null; onMap = true; }

    /* Nothing under the pointer: hand the column back to the rules. */
    if (!ch){
      STORE.readout.value = null;
      STORE.tree.value = null;
      treeFor = null;
      return;
    }

    const e = CH[ch], synth = c ? c.synth : (sp ? sp.synth : false);
    const lv = c ? c.lv : (sp ? sp.lv : lvOf(ch));
    const tags = [{ text: synth ? "Non-existent" : (lv === 0 ? "Component" : "Level " + lv),
                    cls: synth ? "on syn" : "on lv" + lvClamp(lv) }];
    if (e && e.f) tags.push({ text: "in " + e.f.toLocaleString() + " words" });
    if (onMap && !sp) tags.push({ text: "not built yet" });
    else if (onMap && sp) tags.push({ text: "found at t" + sp.first + " · " + sp.count + "×" });
    else if (!c && sp) tags.push({ text: "last formed · t" + sp.first });

    let meter = null;
    if (onMap){
      meter = { label: sp ? "Times built" : "Status", width: null,
                value: sp ? sp.count.toLocaleString() + "× · "
                            + (standingSet.has(ch) ? "alive now" : "gone")
                          : "never formed in this run" };
    } else if (c){
      const pat = patienceOf(c);
      meter = { label: "Starvation",
                width: pat === Infinity ? 0 : Math.min(1, c.t/pat)*100,
                value: pat === Infinity ? "immortal" : c.t + " / " + pat + " ticks idle" };
    } else if (sp){
      meter = { label: "Occurrences", width: null, value: sp.count.toLocaleString() + "× formed" };
    }

    const from = (c && c.from) || (sp && sp.from) || DC[ch];
    STORE.readout.value = {
      shown: disp(ch),
      cls: synth ? "syn small" : "lv" + lvClamp(lv),
      pinyin: e && e.p ? e.p : (synth ? "no reading" : "—"),
      gloss: e && e.d ? e.d
        : (synth ? "A well-formed arrangement that no character actually uses."
                 : "A structural component."),
      tags,
      from: from ? [from[0], from[1]] : null,
      arrangement: from ? (OPNAME[from[2]] || "") : "",
      meter,
    };
  }

  /* ---------- controls ---------- */
  function buildControls(){
    const wrap = $("controls");
    wrap.innerHTML = CONTROLS.map(c =>
      '<div class="ctrl"><label for="c-'+c.k+'">'+c.label+'</label>'
      + '<output id="o-'+c.k+'"></output>'
      + '<input type="range" id="c-'+c.k+'" min="'+c.min+'" max="'+c.max+'" step="'+c.step+'">'
      + (c.note ? '<span class="note">'+c.note+'</span>' : '') + '</div>'
    ).join("")
    + '<div class="ctrl"><label>Neighbourhood</label><span class="row" style="gap:5px">'
    + '<button class="ghost" id="n8">8 way</button><button class="ghost" id="n4">4 way</button></span>'
    + '</div>';

    for (const c of CONTROLS){
      const el = $("c-"+c.k);
      el.value = P[c.k];
      el.addEventListener("input", () => {
        P[c.k] = parseFloat(el.value);
        syncControls();
      });
    }
    $("c-world").addEventListener("input", ev => setWorld(parseInt(ev.target.value, 10)));
    $("c-zoom").addEventListener("input", ev => {
      const mult = parseFloat(ev.target.value) / view.zoom;
      zoomAt(mult, cw/2, chh/2);
    });
    $("b-fit").addEventListener("click", fitView);
    $("m-dish").addEventListener("click", () => setMode("dish"));
    $("m-map").addEventListener("click", () => setMode("map"));

    $("n8").addEventListener("click", () => { P.moore = true; buildNB(); syncControls(); });
    $("n4").addEventListener("click", () => { P.moore = false; buildNB(); syncControls(); });

    $("presets").innerHTML = PRESETS.map(p =>
      '<button data-preset="'+p.key+'"><span class="cn han">'+p.cn+'</span>'+p.en+'</button>').join("");
    $("presets").addEventListener("click", ev => {
      const b = ev.target.closest("[data-preset]"); if (!b) return;
      const p = PRESETS.find(x => x.key === b.dataset.preset);
      Object.assign(P, p.p);
      for (const c of CONTROLS) $("c-"+c.k).value = P[c.k];
      reseed(); syncControls();
    });
  }
  function syncView(){
    const map = mode === "map";
    $("c-world").value = W;
    $("c-world").disabled = map;
    $("c-world").parentElement.style.opacity = map ? .4 : 1;
    $("c-zoom").min = ZOOM[mode][0]; $("c-zoom").max = ZOOM[mode][1];
    $("c-zoom").value = view.zoom;
    $("o-world").textContent = W + " × " + H;
    $("o-zoom").textContent = "×" + view.zoom.toFixed(view.zoom < 10 ? 1 : 0);
    $("o-scale").textContent = map
      ? MCH.length.toLocaleString() + " characters placed · " + S.real.toLocaleString() + " lit"
      : (W*H).toLocaleString() + " cells · " + cs.toFixed(cs < 10 ? 1 : 0) + "px each";
  }

  function syncControls(){
    for (const c of CONTROLS) $("o-"+c.k).textContent = c.fmt(P[c.k]);
    $("n8").classList.toggle("on", P.moore);
    $("n4").classList.toggle("on", !P.moore);
    $("rate").textContent = P.speed + "/s";
    paintReadout();
  }

  $("b-play").addEventListener("click", () => {
    S.running = !S.running;
    $("b-play").textContent = S.running ? "Pause" : "Play";
  });
  $("b-step").addEventListener("click", () => { tick(); paintLog(); paintRecent(); paintPanel(); paintReadout(); });
  $("b-reset").addEventListener("click", () => { reseed(); paintLog(); paintRecent(); paintPanel(); paintReadout(); });
  $("b-clear").addEventListener("click", () => { clearDish(); paintPanel(); });
  $("b-copy").addEventListener("click", async ev => {
    const lines = log.filter(s => !s.synth).map(s =>
      s.from[0] + " + " + s.from[1] + " -> " + disp(s.c)
      + (CH[s.c] ? "  " + (CH[s.c].p||"") + "  " + (CH[s.c].d||"") : "")
      + "   [t" + s.first + ", ×" + s.count + "]");
    try {
      await navigator.clipboard.writeText(
        "Radical Chemistry — " + lines.length + " characters discovered in " + S.tick + " ticks\n\n" + lines.join("\n"));
      ev.target.textContent = "Copied " + lines.length + " entries";
      setTimeout(() => { ev.target.textContent = "Copy discovery list"; }, 1800);
    } catch (err){
      ev.target.textContent = "Clipboard unavailable";
      setTimeout(() => { ev.target.textContent = "Copy discovery list"; }, 1800);
    }
  });
  document.querySelector(".panel").addEventListener("mouseover", ev => {
    const el = ev.target.closest("[data-c]");
    if (el){
      pinnedChar = el.dataset.c;
      showTree(pinnedChar);
      paintReadout();
    } else if (pinnedChar){
      pinnedChar = null;
      paintReadout();
    }
  });
  document.querySelector(".panel").addEventListener("mouseleave", () => {
    if (pinnedChar){ pinnedChar = null; paintReadout(); }
  });
  document.querySelectorAll("[data-filter]").forEach(b => b.addEventListener("click", () => {
    STORE.logFilter.value = b.dataset.filter;
    document.querySelectorAll("[data-filter]").forEach(x => x.classList.toggle("on", x === b));
  }));

  /* ---------- resizable columns ---------- */
  const COLS = { "--insp":{ def:196, min:132, max:560 }, "--aside":{ def:376, min:280, max:560 } };
  const root = document.documentElement;
  const colWidth = v => parseFloat(getComputedStyle(root).getPropertyValue(v)) || COLS[v].def;

  function setCol(v, px){
    const c = COLS[v];
    const n = Math.max(c.min, Math.min(c.max, Math.round(px)));
    root.style.setProperty(v, n + "px");
    try { localStorage.setItem("rc" + v, n); } catch (err) { /* private window */ }
    resize(); syncView();
    if (v === "--insp" && treeFor){ const t = treeFor; treeFor = null; showTree(t); }
  }
  for (const v in COLS){
    try {
      const saved = parseFloat(localStorage.getItem("rc" + v));
      if (saved >= COLS[v].min && saved <= COLS[v].max) root.style.setProperty(v, saved + "px");
    } catch (err) { /* private window */ }
  }

  function makeGrip(el, v, sign){
    let from = 0, was = 0;
    el.addEventListener("pointerdown", ev => {
      el.setPointerCapture(ev.pointerId); el.classList.add("on");
      from = ev.clientX; was = colWidth(v);
      ev.preventDefault();
    });
    el.addEventListener("pointermove", ev => {
      if (el.hasPointerCapture(ev.pointerId)) setCol(v, was + sign*(ev.clientX - from));
    });
    const done = () => el.classList.remove("on");
    el.addEventListener("pointerup", done);
    el.addEventListener("pointercancel", done);
    el.addEventListener("dblclick", () => setCol(v, COLS[v].def));
    el.addEventListener("keydown", ev => {
      const d = ev.key === "ArrowLeft" ? -16 : ev.key === "ArrowRight" ? 16 : 0;
      if (!d) return;
      ev.preventDefault();
      setCol(v, colWidth(v) + sign*d);
    });
  }
  makeGrip($("grip-l"), "--insp", 1);
  makeGrip($("grip-r"), "--aside", -1);

  /* ---------- pointer ---------- */
  function cellAt(ev){
    const r = cv.getBoundingClientRect();
    const x = Math.floor((ev.clientX - r.left - ox)/cs), y = Math.floor((ev.clientY - r.top - oy)/cs);
    return (x >= 0 && y >= 0 && x < W && y < H) ? y*W + x : -1;
  }
  const TOUCH = typeof matchMedia === "function" && matchMedia("(pointer:coarse)").matches;
  const hintFor = m => m === "map"
    ? (TOUCH ? "Tap a dot to read it · pinch to zoom"
             : "Every character placed by meaning · scroll to zoom in and read them")
    : (TOUCH ? "Tap to inspect · drag sideways to sow"
             : "Drag to sow · scroll to zoom · shift-drag to pan");

  let sowing = false, panning = false, panX = 0, panY = 0;
  cv.addEventListener("pointermove", ev => {
    if (mode === "map" && !panning){
      const r = cv.getBoundingClientRect();
      hoverChar = nearestChar(ev.clientX - r.left, ev.clientY - r.top);
      if (hoverChar) showTree(hoverChar);
      paintReadout();
      return;
    }
    if (panning){
      view.px += ev.clientX - panX; view.py += ev.clientY - panY;
      panX = ev.clientX; panY = ev.clientY;
      layout(); syncView();
      return;
    }
    hovered = cellAt(ev);
    if (sowing && hovered >= 0 && !cells[hovered]) ENGINE.sow(hovered);
    if (hovered >= 0 && cells[hovered]) showTree(cells[hovered].c);
    paintReadout();
  });
  cv.addEventListener("pointerdown", ev => {
    cv.setPointerCapture(ev.pointerId);
    if (ev.shiftKey || ev.button === 1){
      panning = true; panX = ev.clientX; panY = ev.clientY;
      cv.classList.add("panning");
      ev.preventDefault();
      return;
    }
    const r = cv.getBoundingClientRect();
    if (mode === "map"){
      hoverChar = nearestChar(ev.clientX - r.left, ev.clientY - r.top);
      if (hoverChar) showTree(hoverChar);
      paintReadout();
      return;
    }
    sowing = true;
    const i = cellAt(ev);
    if (i >= 0){
      if (!cells[i]) ENGINE.sow(i);
      hovered = i;                        /* a tap inspects, as a hover would */
      if (cells[i]) showTree(cells[i].c);
      paintReadout();
    }
  });
  function endDrag(){ sowing = panning = false; cv.classList.remove("panning"); }
  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);
  cv.addEventListener("pointerleave", () => {
    endDrag(); hovered = -1; hoverChar = null; paintReadout();
  });
  cv.addEventListener("wheel", ev => {
    ev.preventDefault();
    const r = cv.getBoundingClientRect();
    zoomAt(Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? .02 : .0016)),
           ev.clientX - r.left, ev.clientY - r.top);
  }, { passive:false });

  /* ---------- loop ---------- */
  let last = performance.now(), acc = 0, uiAcc = 0;
  function frame(now){
    const dt = Math.min(.1, (now - last)/1000); last = now;
    if (S.running){
      acc += dt;
      const interval = 1/P.speed;
      let guard = 0;
      while (acc >= interval && guard < 8){ tick(); acc -= interval; guard++; }
      if (acc > interval) acc = 0;
    }
    draw(dt);
    uiAcc += dt;
    if (uiAcc > .2){
      uiAcc = 0;
      if (logDirty){ paintLog(); paintRecent(); logDirty = false; }
      if (panelDirty){ paintPanel(); paintReadout(); panelDirty = false;
                       if (mode === "map") syncView(); }
    }
    requestAnimationFrame(frame);
  }

  /* ---------- boot ---------- */
  mountPanel();
  buildNB();
  buildControls();
  startEngine();
  reseed();
  resize();
  setWorld(P.cols);          /* square up the rows against the real dish aspect */
  new ResizeObserver(() => { resize(); syncView(); }).observe(cv.parentElement);
  syncControls(); syncView();
  $("hint").textContent = hintFor(mode);
  treePlaceholder();
  paintLog(); paintRecent(); paintPanel(); paintReadout();
  for (let i=0; i<14; i++) tick();   /* open on a dish that is already reacting */
  paintLog(); paintRecent(); paintPanel(); paintReadout();
  /* A handle for tooling: the screenshot and parity scripts drive a fixed
     number of ticks and repaint, rather than racing the animation loop. */
  window.__rc = {
    run(n){
      S.running = false;
      for (let i = 0; i < n; i++) tick();
      paintPanel(); paintLog(); paintRecent(); paintReadout();
    },
    stats: () => ({ tick: S.tick, found: S.real, bonds: S.bonds, engine: ENGINE.name }),
  };

  requestAnimationFrame(frame);
}
