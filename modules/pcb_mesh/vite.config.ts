import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  // the demo imports the sibling viewer's demo board via ?raw
  server: { fs: { allow: [resolve(__dirname, "..")] } },
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "PcbMesh",
      fileName: "pcb_mesh",
      formats: ["es"],
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
