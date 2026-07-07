/**
 * Mesh fixture serialization: plain-JSON, versioned, diffable. Used to freeze meshes
 * as contract-test fixtures (tier 2 of the verification plan) so a mesher change that
 * shifts solver results is diagnosable — was it the mesh or the solver?
 *
 * Typed arrays are stored as plain number arrays: bigger than base64, but readable in
 * diffs and stable across platforms. Freeze fixtures at coarse settings.
 */

import type { BoardMesh, MeshQuality, RegionMesh, SanitationReport } from "./types.js";

export interface SerializedRegionMesh {
  layer: string;
  net: string;
  islands: number;
  holes: number;
  degenerateTriangles: number;
  vertices: number[];
  triangles: number[];
  outlineArea: number;
  meshArea: number;
  quality: MeshQuality;
}

export interface SerializedBoardMesh {
  format: "pcb_mesh/board-mesh";
  version: 1;
  layers: string[];
  report: SanitationReport;
  regions: SerializedRegionMesh[];
}

export function boardMeshToJSON(mesh: BoardMesh): string {
  const out: SerializedBoardMesh = {
    format: "pcb_mesh/board-mesh",
    version: 1,
    layers: mesh.layers,
    report: mesh.report,
    regions: mesh.regions.map((r) => ({
      layer: r.layer,
      net: r.net,
      islands: r.islands,
      holes: r.holes,
      degenerateTriangles: r.degenerateTriangles,
      vertices: Array.from(r.vertices),
      triangles: Array.from(r.triangles),
      outlineArea: r.outlineArea,
      meshArea: r.meshArea,
      quality: r.quality,
    })),
  };
  return JSON.stringify(out);
}

export function boardMeshFromJSON(text: string): BoardMesh {
  const data = JSON.parse(text) as SerializedBoardMesh;
  if (data.format !== "pcb_mesh/board-mesh") throw new Error("not a pcb_mesh board-mesh JSON");
  if (data.version !== 1) throw new Error(`unsupported board-mesh version ${data.version}`);
  const regions: RegionMesh[] = data.regions.map((r) => ({
    layer: r.layer,
    net: r.net,
    islands: r.islands,
    holes: r.holes,
    degenerateTriangles: r.degenerateTriangles,
    vertices: Float64Array.from(r.vertices),
    triangles: Uint32Array.from(r.triangles),
    outlineArea: r.outlineArea,
    meshArea: r.meshArea,
    quality: r.quality,
  }));
  return { layers: data.layers, regions, report: data.report };
}
