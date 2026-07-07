/**
 * Linear-triangle FEM for the 2D conductance (Laplace) problem ∇·(σt ∇V) = 0.
 *
 * Element stiffness for a triangle (p1,p2,p3) with area A and sheet conductance
 * g = σ·t (S per square):  K_ij = g/(4A) · (b_i b_j + c_i c_j),
 * with b_i = y_j − y_k, c_i = x_k − x_j (standard hat-function gradients).
 * The b·b/A ratio is dimensionless, so the mesh can stay in board millimetres —
 * K is in siemens either way.
 */

export type SparseRows = Array<Map<number, number>>;

/** Accumulate one layer's triangles into the global stiffness (rows as maps). */
export function assembleStiffness(
  rows: SparseRows,
  vertices: Float64Array, // mm, interleaved
  triangles: Uint32Array,
  sheetConductance: number, // S per square (= thickness/ρ)
  globalIndex: (localVertex: number) => number,
): void {
  const add = (r: number, c: number, v: number) => {
    const row = rows[r]!;
    row.set(c, (row.get(c) ?? 0) + v);
  };
  for (let t = 0; t < triangles.length; t += 3) {
    const i = triangles[t]!, j = triangles[t + 1]!, k = triangles[t + 2]!;
    const x1 = vertices[2 * i]!, y1 = vertices[2 * i + 1]!;
    const x2 = vertices[2 * j]!, y2 = vertices[2 * j + 1]!;
    const x3 = vertices[2 * k]!, y3 = vertices[2 * k + 1]!;
    const b = [y2 - y3, y3 - y1, y1 - y2];
    const c = [x3 - x2, x1 - x3, x2 - x1];
    const area2 = x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2); // 2A signed
    const A = Math.abs(area2) / 2;
    if (A <= 0) continue;
    const g = [globalIndex(i), globalIndex(j), globalIndex(k)];
    const f = sheetConductance / (4 * A);
    for (let a = 0; a < 3; a++)
      for (let bIdx = 0; bIdx < 3; bIdx++)
        add(g[a]!, g[bIdx]!, f * (b[a]! * b[bIdx]! + c[a]! * c[bIdx]!));
  }
}

export interface CgResult {
  x: Float64Array;
  iterations: number;
  /** ‖Ax−b‖/‖b‖ actually achieved — reported, never trusted implicitly */
  relResidual: number;
}

/** Jacobi-preconditioned conjugate gradients on rows-as-maps (SPD system). */
export function conjugateGradient(rows: SparseRows, b: Float64Array, tol = 1e-12, maxIter = 0): CgResult {
  const n = b.length;
  const x = new Float64Array(n);
  const r = Float64Array.from(b);
  const invDiag = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = rows[i]!.get(i) ?? 0;
    invDiag[i] = d > 0 ? 1 / d : 1;
  }
  const z = new Float64Array(n);
  const p = new Float64Array(n);
  const Ap = new Float64Array(n);
  const bNorm = Math.sqrt(b.reduce((s, v) => s + v * v, 0)) || 1;
  let rz = 0;
  for (let i = 0; i < n; i++) {
    z[i] = r[i]! * invDiag[i]!;
    p[i] = z[i]!;
    rz += r[i]! * z[i]!;
  }
  const max = maxIter || Math.max(1000, 20 * n);
  let it = 0;
  for (; it < max; it++) {
    let rNorm = 0;
    for (let i = 0; i < n; i++) rNorm += r[i]! * r[i]!;
    if (Math.sqrt(rNorm) / bNorm < tol) break;
    Ap.fill(0);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const [c, v] of rows[i]!) s += v * p[c]!;
      Ap[i] = s;
    }
    let pAp = 0;
    for (let i = 0; i < n; i++) pAp += p[i]! * Ap[i]!;
    if (pAp <= 0) break; // lost positive-definiteness → report achieved residual
    const alpha = rz / pAp;
    for (let i = 0; i < n; i++) {
      x[i] = x[i]! + alpha * p[i]!;
      r[i] = r[i]! - alpha * Ap[i]!;
    }
    let rzNew = 0;
    for (let i = 0; i < n; i++) {
      z[i] = r[i]! * invDiag[i]!;
      rzNew += r[i]! * z[i]!;
    }
    const beta = rzNew / rz;
    rz = rzNew;
    for (let i = 0; i < n; i++) p[i] = z[i]! + beta * p[i]!;
  }
  let rNorm = 0;
  for (let i = 0; i < n; i++) rNorm += r[i]! * r[i]!;
  return { x, iterations: it, relResidual: Math.sqrt(rNorm) / bNorm };
}

/** Union-find with path compression (for supernodes). */
export class UnionFind {
  private parent: Int32Array;
  constructor(n: number) {
    this.parent = new Int32Array(n);
    for (let i = 0; i < n; i++) this.parent[i] = i;
  }
  find(i: number): number {
    let root = i;
    while (this.parent[root]! !== root) root = this.parent[root]!;
    while (this.parent[i]! !== root) {
      const next = this.parent[i]!;
      this.parent[i] = root;
      i = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent[ra] = rb;
  }
}
