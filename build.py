#!/usr/bin/env python3
"""Inline the reaction data into the page. Emits a standalone HTML file you can
double-click, plus a body-only fragment for publishing as an Artifact."""
import base64, json, os

HERE = os.path.dirname(os.path.abspath(__file__))
tpl = open(os.path.join(HERE, "src/app.html"), encoding="utf-8").read()
raw = open(os.path.join(HERE, "data/hanzi.json"), encoding="utf-8").read()

# "</" inside a string literal would close the <script> element early.
page = tpl.replace("/*__HANZI_DATA__*/ null", raw.replace("</", "<\\/"))

# The simulation engine, compiled from sim.rs. Inlined as base64 rather than
# fetched: the artifact sandbox blocks external requests, and a page that can
# be opened straight off disk cannot fetch a sibling file either.
wasm_path = os.path.join(HERE, "sim.wasm")
if os.path.exists(wasm_path):
    b64 = base64.b64encode(open(wasm_path, "rb").read()).decode("ascii")
    page = page.replace('"/*__WASM_B64__*/"', '"' + b64 + '"')
    print(f"{'sim.wasm (inlined)':28} {len(b64)/1024:7.0f} KB base64")
else:
    print("sim.wasm not found - the page will fall back to the JavaScript engine")

os.makedirs(os.path.join(HERE, "dist"), exist_ok=True)
frag = os.path.join(HERE, "dist/artifact.html")
open(frag, "w", encoding="utf-8").write(page)

standalone = (
    '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
    '<meta name="viewport" content="width=device-width,initial-scale=1">\n'
    "</head>\n<body>\n" + page + "\n</body>\n</html>\n"
)
out = os.path.join(HERE, "radical-chemistry.html")
open(out, "w", encoding="utf-8").write(standalone)

for f in (out, frag):
    print(f"{os.path.relpath(f, HERE):28} {os.path.getsize(f)/1024:7.0f} KB")
