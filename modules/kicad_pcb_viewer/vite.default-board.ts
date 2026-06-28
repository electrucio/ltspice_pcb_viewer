import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

// Exposes the demo's default board as a virtual module so the build can bake in
// ANY .kicad_pcb without renaming files:  BOARD=/path/to/mine.kicad_pcb npm run build:demo
// Falls back to the bundled poweramp board. Used by both vite.config.ts (dev) and
// vite.demo.config.ts (static export).
const VID = "virtual:default-board";

export function defaultBoard(): Plugin {
  const file = process.env.BOARD
    ? resolve(process.env.BOARD)
    : resolve(__dirname, "demo/poweramp.kicad_pcb");
  const name = file.split("/").pop() ?? "board.kicad_pcb";
  return {
    name: "default-board",
    resolveId(id) {
      if (id === VID) return "\0" + VID;
    },
    load(id) {
      if (id === "\0" + VID) {
        const text = readFileSync(file, "utf8");
        return `export const text = ${JSON.stringify(text)};\nexport const name = ${JSON.stringify(name)};`;
      }
    },
  };
}
