// The right-hand column and the inspector, as components.
//
// These replace the innerHTML string building the program used to do. Each one
// mounts into the container the markup already provides, so the page shell
// stays plain HTML and only the parts that actually change are componentised.

import { render } from "preact";
import {
  vitals, coverage, census, standing, ticker, discoveries,
  tally, logFilter, readout, tree, colophon,
} from "../store.js";

const LEVELS = ["Components", "Level 1", "Level 2", "Level 3", "Level 4", "Level 5+"];
const pct = (n, d) => (n ? Math.max((n / d) * 100, 0.5) : 0) + "%";
const num = n => n.toLocaleString();

/* ---------------------------------------------------------------- gauges */
function Gauge({ id, label, n, d, split }) {
  return (
    <div class="gauge" title={GAUGE_HELP[id]}>
      <div class="row">
        <span class="k">{label}</span>
        <span class="v">{num(n)} <small>/ {num(d)}</small></span>
      </div>
      <div class="bar">
        {split
          ? <>
              <i id="gb-ch" style={{ width: pct(split[0], d) }} />
              <i id="gb-ch2" style={{ width: pct(split[1], d) }} />
            </>
          : <i id={"gb-" + id} style={{ width: pct(n, d) }} />}
      </div>
    </div>
  );
}

const GAUGE_HELP = {
  rx: "How much of the reaction table this run has used. Every character has exactly one recipe, so this number is the same as Characters found in the header.",
  ch: "Every distinct character that has ever occupied a cell. That is the ones built by bonding plus the raw components, which is why it runs ahead of Characters found.",
  co: "Distinct seed components this run has drawn. Nothing in the writing system builds a component, so it can be seen but never found.",
};

function Gauges() {
  const c = coverage.value, t = c.totals;
  return (
    <>
      <Gauge id="rx" label="Reaction table" n={c.rx} d={t.reactions} />
      <Gauge
        id="ch"
        label={<><b>Built</b> + <em>components</em> seen</>}
        n={c.seen} d={t.characters} split={[c.built, c.comp]}
      />
      <Gauge id="co" label="Components used" n={c.comp} d={t.atoms} />
    </>
  );
}

/* ---------------------------------------------------------------- census */
function Census() {
  const { pop, levels, synth } = census.value;
  const total = Math.max(1, pop);
  return (
    <>
      <div class="census">
        {levels.map((n, l) => (
          <i key={l} style={{ width: (n / total) * 100 + "%", background: `var(--lv${l})` }} />
        ))}
        <i style={{ width: (synth / total) * 100 + "%", background: "var(--synth)" }} />
      </div>
      <div class="legend">
        {levels.map((n, l) => (
          <div class="leg" key={l}>
            <span class="sw" style={{ background: `var(--lv${l})` }} />
            {LEVELS[l]}<span class="n">{n}</span>
          </div>
        ))}
        <div class="leg">
          <span class="sw" style={{ background: "var(--synth)" }} />
          Non-existent<span class="n">{synth}</span>
        </div>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- ticker */
function Ticker() {
  const { items } = ticker.value;
  if (!items.length) return <span class="idle">Nothing has bonded yet.</span>;
  return items.map((r, i) => (
    <span key={i} class={"t " + r.cls + (r.fresh ? " fresh" : "")} data-c={r.ch} title={r.title}>
      <span class="han">{r.shown}</span>
      <small>{r.fresh ? "NEW" : "×" + r.n}</small>
    </span>
  ));
}

/* ------------------------------------------------------- standing species */
function Standing() {
  const items = standing.value;
  if (!items.length)
    return <span class="empty-log">Nothing above component level is alive right now.</span>;
  return items.map(s => (
    <span class="s" key={s.ch} data-c={s.ch}>
      <span class={"han " + s.cls} title={s.title}>{s.shown}</span>
      <small>{s.n}</small>
    </span>
  ));
}

/* ----------------------------------------------------------- discoveries */
function Tally() {
  const t = tally.value;
  return (
    <>
      <div><b>{num(t.real)}</b><span>Real characters</span></div>
      <div><b>{num(t.repeats)}</b><span>Duplicate builds</span></div>
      <div><b class="syn">{num(t.novel)}</b><span>Non-existent</span></div>
    </>
  );
}

function Entry({ e }) {
  return (
    <div class="entry" data-c={e.ch}>
      <span class="t mono">t{String(e.first).padStart(4, "0")}</span>
      <span class="body">
        <span class="f han">
          <span class={"lv" + e.la}>{e.a}</span>
          <span class="sep mono">+</span>
          <span class={"lv" + e.lb}>{e.b}</span>
          <span class="sep mono">→</span>
          <span class={e.cls}>{e.shown}</span>
          <span class="sep mono">{e.arrangement}</span>
        </span>
        <span class="g">
          {e.synth
            ? <><b>no such character</b> · {e.arrangement} arrangement of {e.a} and {e.b}</>
            : <><b>{e.pinyin || "—"}</b>{e.gloss ? " · " + e.gloss : ""}</>}
        </span>
      </span>
      {e.count > 1 && <span class="n">×{e.count}</span>}
    </div>
  );
}

function Discoveries() {
  const f = logFilter.value;
  const rows = discoveries.value.filter(e => f === "all" || (f === "novel") === !!e.synth);
  if (!rows.length)
    return (
      <div class="empty-log">
        {vitals.value.tick === 0
          ? "Press play. Every first appearance of a character gets logged here with the two parts that made it."
          : "No entries under this filter yet."}
      </div>
    );
  return rows.slice(0, 160).map(e => <Entry key={e.ch} e={e} />);
}

/* ------------------------------------------------------------- inspector */
function Readout() {
  const r = readout.value;
  if (!r || r.empty)
    return (
      <>
        <div class="ident">
          <div class="glyph han">字</div>
          <div class="who">
            <span class="pinyin mono">—</span>
            <div class="tags" />
          </div>
        </div>
        <div class="gloss">
          {(r && r.hint) || "Hover any cell in the dish to read its specimen card."}
        </div>
        <div class="eq han" />
      </>
    );
  return (
    <>
      <div class="ident">
        <div class={"glyph han " + r.cls}>{r.shown}</div>
        <div class="who">
          <span class="pinyin mono">{r.pinyin}</span>
          <div class="tags">
            {r.tags.map((t, i) => (
              <span class={"tag " + (t.cls || "")} key={i}>{t.text}</span>
            ))}
          </div>
        </div>
      </div>
      <div class="gloss">{r.gloss}</div>
      <div class="eq han">
        {r.from
          ? <>
              {r.from[0]}<span class="arrow mono">+</span>{r.from[1]}
              <span class="arrow mono">makes</span>{r.shown}
              <span class="op mono">{r.arrangement}</span>
            </>
          : <span class="op mono">irreducible — this one has to be seeded</span>}
      </div>
      {r.meter && (
        <div class="decay">
          <div class="dl"><small>{r.meter.label}</small><small>{r.meter.value}</small></div>
          {r.meter.width !== null && (
            <div class="bar"><i style={{ width: r.meter.width + "%" }} /></div>
          )}
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------- genealogy */
function Tree() {
  const t = tree.value;
  const head = meta => (
    <div class="top">
      <h3>Genealogy</h3>
      <span class="cn han">系譜</span>
      {meta && <span class="meta">{meta}</span>}
    </div>
  );
  if (!t) return <>{head("")}<p class="say">
    Hover a character — in the dish, on the map, or anywhere in the log — to see
    how the writing system builds it. The tree grows one generation per level.
  </p></>;
  if (t.bare) return <>{head("irreducible")}<p class="say">
    <b class="lv0" style="font-size:15px">{t.shown}</b> is a component. Nothing in
    the writing system builds it — it has to be seeded.
  </p></>;
  return (
    <>
      {head(t.meta)}
      <svg width={t.w} height={t.h} viewBox={`0 0 ${t.w} ${t.h}`} role="img"
           aria-label={"decomposition tree of " + t.shown}>
        {t.edges.map((d, i) => <path key={i} d={d} />)}
        {t.nodes.map((n, i) => (
          <text key={i} x={n.x} y={n.y} text-anchor="middle" dominant-baseline="central"
                font-size={n.size} class={"lv" + n.lv} font-weight={n.leaf ? undefined : 500}
                fill="currentColor">
            <title>{n.title}</title>{n.ch}
          </text>
        ))}
      </svg>
    </>
  );
}

/* ------------------------------------------------------------- mounting */
function Vitals() {
  const v = vitals.value;
  return (
    <>
      <div class="vital"><b>{num(v.tick)}</b><span>Tick</span></div>
      <div class="vital"><b>{num(v.real)}</b><span>Characters found</span></div>
    </>
  );
}

function Colophon() {
  return (
    <>
      <span>{colophon.value}</span><br />
      Nothing builds a component, so a component is seen but never <i>found</i>:
      characters seen = characters found + components used.<br />
      No combination rule is hand-written. Reactions from <b>makemeahanzi</b>,
      frequency from <b>CC-CEDICT</b>.
    </>
  );
}

/** Mount each component into the container the shell already provides. */
export function mountPanel() {
  const at = (id, node) => {
    const el = document.getElementById(id);
    if (el) render(node, el);
  };
  at("vitals", <Vitals />);
  at("subhead", <Gauges />);
  at("census-block", <Census />);
  at("recent", <Ticker />);
  at("species", <Standing />);
  at("tally", <Tally />);
  at("log", <Discoveries />);
  at("specimen", <Readout />);
  at("tree", <Tree />);
  at("colophon-text", <Colophon />);
}
