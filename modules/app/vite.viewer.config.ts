import { defineConfig } from "vite";
import { resolve } from "node:path";
import { viteSingleFile } from "vite-plugin-singlefile";

// Builds the READ-ONLY cross-probe viewer into ONE self-contained HTML *template*
// (JS + CSS inlined), targeted at old iOS Safari (12.x). esbuild downlevels modern
// syntax (?., ??, etc.); viewer/compat.ts shims the few method-level gaps.
//
// The output (src/generated/viewer-template.html) contains a `__LK_DATA__` placeholder
// inside a <script type="application/json"> block; the app fills it at download time.
export default defineConfig({
  root: resolve(__dirname, "viewer"),
  base: "./",
  plugins: [viteSingleFile()],
  build: {
    target: "safari12",
    outDir: resolve(__dirname, "src/generated"),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, "viewer/viewer.html") },
  },
});
