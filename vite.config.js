import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import { readFileSync } from "node:fs";

// The page must stay one self-contained file: the artifact sandbox blocks
// external requests, and it has to work opened straight off disk.
export default defineConfig({
  root: "web",
  plugins: [
    preact(),
    {
      // sim.wasm, compiled from sim.rs, inlined as base64
      name: "inline-wasm",
      resolveId: id => (id === "virtual:sim-wasm" ? "\0virtual:sim-wasm" : null),
      load(id) {
        if (id !== "\0virtual:sim-wasm") return null;
        const b64 = readFileSync("sim.wasm").toString("base64");
        return `export default "${b64}";`;
      },
    },
    viteSingleFile({ removeViteModuleLoader: true }),
  ],
  build: {
    outDir: "../dist-web",
    emptyOutDir: true,
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    reportCompressedSize: false,
  },
});
