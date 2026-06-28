import { defineConfig } from "vite";
import { resolve } from "node:path";
import { viteSingleFile } from "vite-plugin-singlefile";
import { defaultBoard } from "./vite.default-board.js";

// Builds the demo into ONE self-contained index.html (JS + CSS + default
// board all inlined) so it can be dropped on any static host (GitHub Pages,
// *.github.io) — or even opened from file://. Output: dist-demo/index.html.
export default defineConfig({
  root: resolve(__dirname, "demo"),
  base: "./",
  plugins: [defaultBoard(), viteSingleFile()],
  build: {
    outDir: resolve(__dirname, "dist-demo"),
    emptyOutDir: true,
  },
});
