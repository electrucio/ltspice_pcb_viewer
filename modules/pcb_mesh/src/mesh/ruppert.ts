/**
 * Quality-guaranteed meshing via the Rust/WASM `geometry_core` kernel: constrained
 * Delaunay + Ruppert/Chew refinement (spade), minimum-angle bound 25° (accept ≥ 20°)
 * plus a max-area constraint derived from the target edge length.
 *
 * The guarantee holds wherever the INPUT allows it: constraint edges meeting at
 * small angles (e.g. near-tangent circle intersections in the boolean union) force a
 * few local slivers no algorithm can remove — `quality.sliverCount` reports them.
 *
 * The WASM module must be initialized once (async) before use:
 *   await initRuppert();            // browser: fetches the .wasm next to the pkg JS
 *   await initRuppert({ module_or_path: bytes });  // node/tests: pass the bytes
 */

import initWasm, { refine_region } from "../../../geometry_core/pkg/geometry_core.js";
import type { MultiPolygon } from "../types.js";
import type { RawMesh } from "./triangulate.js";

let ready = false;

export async function initRuppert(wasm?: Parameters<typeof initWasm>[0]): Promise<void> {
  if (ready) return;
  await initWasm(wasm);
  ready = true;
}

export function ruppertReady(): boolean {
  return ready;
}

/** Default Ruppert angle target (deg). ≤ 30 guarantees termination; 25 is safe. */
export const RUPPERT_MIN_ANGLE_DEG = 25;

export function triangulateRuppert(
  mp: MultiPolygon,
  targetEdge: number,
  minAngleDeg = RUPPERT_MIN_ANGLE_DEG,
  /**
   * refinement floor as a fraction of maxArea; 0 (default) disables. Measured on the
   * poweramp pour: with outline simplification on (the default) the floor saves no
   * triangles and only reintroduces slivers — use it only on unsimplified geometry.
   */
  minAreaFraction = 0,
): RawMesh {
  if (!ready) {
    throw new Error('pcb_mesh: refinement "ruppert" needs `await initRuppert()` before meshing');
  }
  // equilateral triangle of edge h has area (√3/4)h² — the max-area constraint
  const maxArea = Number.isFinite(targetEdge) && targetEdge > 0 ? (Math.sqrt(3) / 4) * targetEdge * targetEdge : 0;
  const minArea = maxArea * minAreaFraction;
  const vertices: number[] = [];
  const triangles: number[] = [];
  for (const poly of mp) {
    const coords: number[] = [];
    const lens: number[] = [];
    for (const ring of poly) {
      lens.push(ring.length);
      for (const [x, y] of ring) coords.push(x, y);
    }
    const out = refine_region(Float64Array.from(coords), Uint32Array.from(lens), minAngleDeg, maxArea, minArea, 0);
    const vs = out.vertices, ts = out.triangles;
    const offset = vertices.length / 2;
    for (let i = 0; i < vs.length; i++) vertices.push(vs[i]!);
    for (let i = 0; i < ts.length; i++) triangles.push(offset + ts[i]!);
    out.free();
  }
  return { vertices, triangles };
}
