import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // dev/preview serve the demo; the demo + component import the two sibling
  // viewer modules by relative path, so allow the whole modules/ tree.
  server: {
    fs: { allow: [resolve(__dirname, "..")] },
  },
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "LtspiceKicadMapper",
      fileName: "ltspice_kicad_mapper",
      formats: ["es"],
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
