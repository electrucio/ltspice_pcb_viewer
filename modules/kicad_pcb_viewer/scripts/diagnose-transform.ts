import { readFileSync } from "node:fs";
import { parsePcb } from "../src/parser/pcb.js";
import { key } from "../src/geometry/transform.js";

const text = readFileSync(new URL("../test/fixtures/poweramp.kicad_pcb", import.meta.url), "utf8");

// reference points pads should land on: track endpoints + via centers (per net)
for (const sign of [1, -1]) {
  const pcb = parsePcb(text, sign);
  const targets = new Map<string, Set<string>>(); // net -> set of point keys
  const add = (net: string, k: string) => (targets.get(net) ?? targets.set(net, new Set()).get(net)!).add(k);
  for (const t of pcb.tracks) { add(t.net, key(t.start)); add(t.net, key(t.end)); }
  for (const v of pcb.vias) add(v.net, key(v.pos));

  let hit = 0, total = 0;
  for (const f of pcb.footprints) for (const p of f.pads) {
    if (!p.net) continue;
    total++;
    if (targets.get(p.net)?.has(key(p.pos))) hit++;
  }
  console.log(`ROT_SIGN=${sign}: ${hit}/${total} pads coincide with a same-net track endpoint/via`);
}

const pcb = parsePcb(text);
console.log(`\nfootprints=${pcb.footprints.length} tracks=${pcb.tracks.length} vias=${pcb.vias.length} zones=${pcb.zones.length} nets=${pcb.nets.length}`);
console.log("board bbox:", pcb.bbox);
