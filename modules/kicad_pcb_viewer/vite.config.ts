import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  server: { fs: { allow: [resolve(__dirname)] } },
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "KicadPcbViewer",
      fileName: "kicad_pcb_viewer",
      formats: ["es"],
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
