/**
 * DC resistance of a net between two terminals, solved on the real copper geometry.
 *
 * Model: each copper layer of the net is a 2D sheet-conductance FEM domain (mesh from
 * pcb_mesh's buildTerminalMesh — pads/vias are equipotential terminal holes). Layers
 * couple through supernodes: every terminal MEMBER id that appears on several layers
 * (THT pads, vias — including a via-in-pad merged into its pad's terminal on one
 * layer) has its vertex sets SHORTED across layers. Via barrel resistance
 * (~1 mΩ, see analytic_models) is neglected in v1 — flagged as an upgrade, not hidden.
 *
 * Every result carries the achieved CG residual; the caller must not trust a
 * stagnated solve (spec: "the tool knows when it doesn't know").
 */

import { copperThicknessMm, type Pcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { copperLayers } from "../../pcb_mesh/src/outline/copper.js";
import { buildTerminalMesh, type TerminalMeshOptions } from "../../pcb_mesh/src/mesh/terminals.js";
import { sheetResistance } from "../../analytic_models/src/index.js";
import { assembleStiffness, conjugateGradient, UnionFind, type SparseRows } from "./fem.js";

export interface SolveOptions extends TerminalMeshOptions {
  /**
   * copper thickness override, METERS, applied to ALL layers. Default: each layer's
   * thickness from the board's `(setup (stackup …))`, falling back to 35e-6 (1 oz)
   * when the file predates stackups.
   */
  copperThicknessM?: number;
  /** °C for the resistivity model (default 20) */
  tempC?: number;
  /** CG relative-residual tolerance (default 1e-12) */
  tolerance?: number;
  /** also return the solved field (per-layer potentials + current density) */
  returnField?: boolean;
}

export interface LayerField {
  layer: string;
  /** interleaved x,y (mm) — the solver mesh geometry */
  vertices: Float64Array;
  triangles: Uint32Array;
  /** V at each vertex (V(A)=1, V(B)=0) */
  potential: Float64Array;
  /** |J| per triangle, A per mm of sheet width at 1 V drive (σt·|∇V|) */
  currentDensity: Float64Array;
}

export interface SolveResult {
  /** Ω between the two terminals */
  resistance: number;
  /** achieved relative residual of the CG solve — check it! */
  relResidual: number;
  iterations: number;
  /** free DOFs actually solved */
  dofs: number;
  /** terminal ids in the connected system (after cross-layer merging) */
  terminals: string[];
  layers: string[];
  /** terminals pcb_mesh could not constrain safely (from its report) */
  skippedTerminals: string[];
  /** |I_A + I_B| / |I_A| — current conservation check */
  conservationError: number;
  /** present when options.returnField was set */
  field?: LayerField[];
}

interface LayerBlock {
  layer: string;
  vertices: Float64Array;
  triangles: Uint32Array;
  offset: number;
  /** sheet conductance σ·t of THIS layer (stackups can differ per layer) */
  gSheet: number;
  terminals: Array<{ id: string; refs: string[]; members: string[]; vertexIndices: number[] }>;
}

/** Does `query` name this terminal? Accepts the merged id or any member ref. */
function matches(t: { id: string; refs: string[] }, query: string): boolean {
  return t.id === query || t.refs.includes(query);
}

export function solveNetResistance(
  pcb: Pcb,
  net: string,
  terminalA: string,
  terminalB: string,
  options?: SolveOptions,
): SolveResult {
  // thickness per layer: explicit option → board stackup → 35 µm (1 oz)
  const thicknessOf = (layer: string): number =>
    options?.copperThicknessM ?? (copperThicknessMm(pcb, layer) ?? 0.035) * 1e-3;

  // 1) terminal meshes per layer
  const blocks: LayerBlock[] = [];
  const skippedTerminals: string[] = [];
  let offset = 0;
  const layers = options?.layers ?? copperLayers(pcb);
  for (const layer of layers) {
    const tm = buildTerminalMesh(pcb, layer, net, { ...options, layers: undefined });
    if (!tm) continue;
    skippedTerminals.push(...tm.skipped.map((id) => `${layer}/${id}`));
    blocks.push({
      layer,
      vertices: tm.mesh.vertices,
      triangles: tm.mesh.triangles,
      offset,
      gSheet: 1 / sheetResistance(thicknessOf(layer), options?.tempC),
      terminals: tm.terminals,
    });
    offset += tm.mesh.vertices.length / 2;
  }
  const total = offset;
  if (!blocks.length) throw new Error(`net "${net}" has no copper on ${layers.join(", ")}`);

  // 2) supernodes: terminal vertices merge within a layer; the same MEMBER id merges
  //    across layers. Never match by the merged display id: a via-in-pad terminal is
  //    "PAD+via@x,y" on the pad's layer but plain "via@x,y" everywhere else.
  const uf = new UnionFind(total);
  const rootByTerminalId = new Map<string, number>();
  const rootByMemberId = new Map<string, number>();
  const terminalInfo = new Map<string, { refs: string[] }>();
  for (const b of blocks) {
    for (const t of b.terminals) {
      if (!t.vertexIndices.length) continue;
      const first = b.offset + t.vertexIndices[0]!;
      for (const vi of t.vertexIndices) uf.union(b.offset + vi, first);
      for (const m of t.members) {
        const existing = rootByMemberId.get(m);
        if (existing !== undefined) uf.union(first, existing);
        else rootByMemberId.set(m, first);
      }
      if (!rootByTerminalId.has(t.id)) rootByTerminalId.set(t.id, first);
      const info = terminalInfo.get(t.id) ?? { refs: [] };
      info.refs.push(...t.refs, ...t.members);
      terminalInfo.set(t.id, info);
    }
  }

  // 3) locate the requested terminals (by merged id or member ref)
  const findTerminal = (q: string): number => {
    for (const [id, root] of rootByTerminalId) {
      if (matches({ id, refs: terminalInfo.get(id)!.refs }, q)) return uf.find(root);
    }
    throw new Error(`terminal "${q}" not found on net "${net}" (have: ${[...rootByTerminalId.keys()].join(", ")})`);
  };
  const rootA = findTerminal(terminalA);
  const rootB = findTerminal(terminalB);
  if (rootA === rootB) throw new Error(`terminals "${terminalA}" and "${terminalB}" are the same node`);

  // 4) assemble the merged stiffness
  const rows: SparseRows = Array.from({ length: total }, () => new Map());
  for (const b of blocks) {
    assembleStiffness(rows, b.vertices, b.triangles, b.gSheet, (v) => uf.find(b.offset + v));
  }

  // 5) restrict to the connected component containing A (drop other islands so the
  //    reduced system stays SPD); B must live in it
  const component = new Int32Array(total).fill(-1);
  const queue = [rootA];
  component[rootA] = 0;
  while (queue.length) {
    const v = queue.pop()!;
    for (const c of rows[v]!.keys()) {
      if (component[c]! < 0) {
        component[c] = 0;
        queue.push(c);
      }
    }
  }
  if (component[rootB]! < 0) {
    throw new Error(
      `terminals "${terminalA}" and "${terminalB}" are not connected on net "${net}" (check layer set / via stitching)`,
    );
  }

  // 6) Dirichlet reduction: V(A)=1, V(B)=0, everything else free
  const freeIndex = new Int32Array(total).fill(-1);
  let nFree = 0;
  for (let i = 0; i < total; i++) {
    if (component[i]! === 0 && i !== rootA && i !== rootB && uf.find(i) === i) freeIndex[i] = nFree++;
  }
  const reduced: SparseRows = Array.from({ length: nFree }, () => new Map());
  const rhs = new Float64Array(nFree);
  for (let i = 0; i < total; i++) {
    const fi = freeIndex[i]!;
    if (fi < 0) continue;
    for (const [c, v] of rows[i]!) {
      if (c === rootA) rhs[fi] = rhs[fi]! - v; // move V(A)=1 to the RHS
      else if (c === rootB) continue; // V(B)=0
      else {
        const fc = freeIndex[c]!;
        if (fc >= 0) reduced[fi]!.set(fc, (reduced[fi]!.get(fc) ?? 0) + v);
      }
    }
  }
  const { x, iterations, relResidual } = conjugateGradient(reduced, rhs, options?.tolerance ?? 1e-12);

  // 7) terminal currents from the full stiffness rows: I_A = Σ K[A,j]·V_j
  const potential = (i: number): number => {
    const r = uf.find(i);
    if (r === rootA) return 1;
    if (r === rootB) return 0;
    const fi = freeIndex[r]!;
    return fi >= 0 ? x[fi]! : 0;
  };
  const currentAt = (root: number): number => {
    let s = 0;
    for (const [c, v] of rows[root]!) s += v * potential(c);
    return s;
  };
  const iA = currentAt(rootA);
  const iB = currentAt(rootB);

  let field: LayerField[] | undefined;
  if (options?.returnField) {
    field = blocks.map((b) => {
      const nLocal = b.vertices.length / 2;
      const pot = new Float64Array(nLocal);
      for (let i = 0; i < nLocal; i++) pot[i] = potential(b.offset + i);
      const currentDensity = new Float64Array(b.triangles.length / 3);
      for (let t = 0; t < b.triangles.length; t += 3) {
        const i = b.triangles[t]!, j = b.triangles[t + 1]!, k = b.triangles[t + 2]!;
        const x1 = b.vertices[2 * i]!, y1 = b.vertices[2 * i + 1]!;
        const x2 = b.vertices[2 * j]!, y2 = b.vertices[2 * j + 1]!;
        const x3 = b.vertices[2 * k]!, y3 = b.vertices[2 * k + 1]!;
        const area2 = x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2);
        if (Math.abs(area2) < 1e-18) continue;
        const v1 = pot[i]!, v2 = pot[j]!, v3 = pot[k]!;
        const gx = (v1 * (y2 - y3) + v2 * (y3 - y1) + v3 * (y1 - y2)) / area2;
        const gy = (v1 * (x3 - x2) + v2 * (x1 - x3) + v3 * (x2 - x1)) / area2;
        currentDensity[t / 3] = b.gSheet * Math.hypot(gx, gy);
      }
      return { layer: b.layer, vertices: b.vertices, triangles: b.triangles, potential: pot, currentDensity };
    });
  }

  return {
    field,
    resistance: 1 / iA,
    relResidual,
    iterations,
    dofs: nFree,
    terminals: [...rootByTerminalId.keys()],
    layers: blocks.map((b) => b.layer),
    skippedTerminals,
    conservationError: Math.abs(iA + iB) / Math.abs(iA),
  };
}
