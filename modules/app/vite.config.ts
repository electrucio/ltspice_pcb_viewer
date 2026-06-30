import { defineConfig } from "vite";
import { resolve } from "node:path";

// The application itself runs in MODERN browsers only (no compat constraints).
// It embeds the sibling viewer/mapper modules by relative source import, so the dev
// server must be allowed to read files from the repo root.
export default defineConfig({
  root: resolve(__dirname),
  server: { fs: { allow: [resolve(__dirname, "..", "..")] } },
  build: { outDir: resolve(__dirname, "dist-app"), emptyOutDir: true },
});
