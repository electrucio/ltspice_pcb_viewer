/**
 * pcb_mesh — copper geometry extraction + triangular meshing for KiCad PCBs.
 *
 * Turns a `.kicad_pcb` into per-layer, per-net copper regions (boolean union of
 * tracks, pads, vias and zone fills, minus drill holes) and triangulates each region
 * into an FEM-ready mesh. All coordinates are board millimetres, Y down.
 *
 *   import { buildBoardMeshFromString } from "pcb_mesh";
 *   const mesh = buildBoardMeshFromString(text, { maxEdgeLength: 0.5 });
 *
 * First building block (M2 seed) of the 2.5D parasitic-extraction engine.
 */

export { buildBoardMesh, buildBoardMeshFromString } from "./build.js";
export { extractCopper, extractCopperRegions, copperLayers, padOnLayer } from "./outline/copper.js";
export type { ExtractResult } from "./outline/copper.js";
export { analyzeRegion } from "./verify.js";
export type { RegionReport, AreaReport, MonteCarloArea, AnalyzeOptions } from "./verify.js";
export { boardMeshToJSON, boardMeshFromJSON } from "./serialize.js";
export type { SerializedBoardMesh } from "./serialize.js";
export {
  circleOutline,
  stadiumOutline,
  trackOutline,
  padOutline,
  padDrillOutline,
  viaOutline,
  viaDrillOutline,
  segmentsForRadius,
  padArcRadius,
} from "./outline/primitives.js";
export {
  triangulateMultiPolygon,
  refineToEdgeLength,
  meshRegion,
  meshArea,
  measureQuality,
} from "./mesh/triangulate.js";
export { triangulateQuality } from "./mesh/delaunay.js";
export { initRuppert, ruppertReady, triangulateRuppert, RUPPERT_MIN_ANGLE_DEG } from "./mesh/ruppert.js";
export type { RawMesh } from "./mesh/triangulate.js";
export { ringArea, multiPolygonArea } from "./types.js";
export type {
  Vec2,
  Ring,
  Polygon,
  MultiPolygon,
  CopperRegion,
  RegionMesh,
  BoardMesh,
  MeshOptions,
  MeshQuality,
  SanitationReport,
} from "./types.js";
