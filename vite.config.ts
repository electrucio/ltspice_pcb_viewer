import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // dev/preview serve the demo (see package.json scripts: `vite demo`).
  server: {
    // the demo imports from ../src, outside the demo root
    fs: { allow: [resolve(__dirname)] },
  },
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "KicadSchematicViewer",
      fileName: "kicad-schematic-viewer",
      formats: ["es"],
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
