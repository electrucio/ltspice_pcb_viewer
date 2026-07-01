import { defineConfig } from "vite";
import { resolve } from "node:path";

// The application itself runs in MODERN browsers only (no compat constraints).
// It embeds the sibling viewer/mapper modules by relative source import, so the dev
// server must be allowed to read files from the repo root.
// `VITE_BASE` lets a deploy target it at a subpath (e.g. GitHub Pages project folder)
// without affecting local dev/preview, which stay at the default "/".
export default defineConfig({
  root: resolve(__dirname),
  base: process.env.VITE_BASE || "/",
  server: { fs: { allow: [resolve(__dirname, "..", "..")] } },
  build: { outDir: resolve(__dirname, "dist-app"), emptyOutDir: true },
});
