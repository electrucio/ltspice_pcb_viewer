import { defineConfig } from "vite";
import { resolve } from "node:path";
import { defaultBoard } from "./vite.default-board.js";

export default defineConfig({
  plugins: [defaultBoard()],
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
