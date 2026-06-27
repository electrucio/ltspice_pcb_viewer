import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // dev/preview serve the demo (see package.json scripts: `vite demo`).
  server: {
    fs: { allow: [resolve(__dirname)] },
  },
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "LtspiceSchematicViewer",
      fileName: "ltspice_schematic_viewer",
      formats: ["es"],
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
