/**
 * The module's public entry point ("endpoint"): a parsed board (or raw .kicad_pcb
 * text) in, a triangulated per-layer/per-net copper mesh out.
 */

import { parsePcb, type Pcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import type { BoardMesh, MeshOptions } from "./types.js";
import { resolveOptions } from "./types.js";
import { copperLayers, extractCopper } from "./outline/copper.js";
import { meshRegion } from "./mesh/triangulate.js";

export function buildBoardMesh(pcb: Pcb, options?: MeshOptions): BoardMesh {
  const o = resolveOptions(options);
  const { regions: copper, report } = extractCopper(pcb, options);
  const regions = copper.map((r) => meshRegion(r, o.maxEdgeLength, o.refinement));
  report.degenerateTriangles = regions.reduce((s, r) => s + r.degenerateTriangles, 0);
  return { layers: o.layers ?? copperLayers(pcb), regions, report };
}

export function buildBoardMeshFromString(text: string, options?: MeshOptions): BoardMesh {
  return buildBoardMesh(parsePcb(text), options);
}
