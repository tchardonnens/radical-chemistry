// Turn Vite's single-file output into the two things we ship:
//
//   radical-chemistry.html  a complete document, works opened straight off disk
//   dist/artifact.html      the same page as a body fragment, for publishing
//
// The artifact host supplies its own <!doctype>, charset and viewport, so the
// fragment carries only the title, the font link, the styles and the markup.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const built = readFileSync(resolve(root, "dist-web/index.html"), "utf8");

writeFileSync(resolve(root, "radical-chemistry.html"), built);

const head = built.slice(built.indexOf("<head>") + 6, built.indexOf("</head>"));
const body = built.slice(built.indexOf("<body>") + 6, built.lastIndexOf("</body>"));

// everything from the head except the two tags the host already provides
const carried = head
  .split("\n")
  .filter(l => !/<meta\s+charset|name="viewport"/.test(l))
  .join("\n")
  .trim();

mkdirSync(resolve(root, "dist"), { recursive: true });
writeFileSync(resolve(root, "dist/artifact.html"), carried + "\n" + body.trim() + "\n");

const kb = p => (readFileSync(resolve(root, p)).length / 1024).toFixed(0).padStart(6);
for (const p of ["radical-chemistry.html", "dist/artifact.html"]) {
  console.log(`${p.padEnd(26)} ${kb(p)} KB`);
}
