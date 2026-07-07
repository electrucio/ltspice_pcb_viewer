# solver_rdc

M4 of the parasitic-extraction engine: **DC resistance of real board copper**.

Linear-triangle FEM for ∇·(σt∇V)=0 on `pcb_mesh`'s terminal-tagged quality meshes
(Ruppert/WASM): pads and vias are equipotential terminal holes; every terminal id
present on several layers (THT pads, vias) is shorted into a cross-layer supernode
(the ~1 mΩ via-barrel lumped R from `analytic_models` is the flagged v2 refinement).
Dirichlet solve between two terminals, Jacobi-preconditioned CG, and every result
carries its **achieved residual** and a **current-conservation error** — numbers ship
with their checks.

```ts
await initRuppert(); // pcb_mesh's WASM mesher, once
const r = solveNetResistance(pcb, "/POW1", "R2.1", "R9.1", { maxEdgeLength: 0.5, refinement: "ruppert" });
// r.resistance = 3.80 mΩ · r.relResidual < 1e-10 · r.conservationError < 1e-6
```

## Acceptance tests (8, all against the M0 oracle)

- **Straight strip → ρL/(W·t) within 0.5 %** (the field between full-width terminals
  is exactly 1-D, so the closed form is exact up to the terminal inset).
- **L-bend → 18.2 squares including 0.56 for the corner** — the FEM re-derives
  Jaeger's corner value that `analytic_models` carries as a constant; M0 and M4
  now check each other.
- Refinement stability (<1 % between h and h/2), reciprocity R(A→B)=R(B→A),
  temperature scaling inherited from M0, loud errors on disconnected terminals.
- Poweramp board: plausible R vs counting-squares; and the killer integration test —
  a pad pair on **different B.Cu islands** (throws when solved on B.Cu alone) becomes
  finite through the F.Cu path + THT/via supernodes.

## Known v1 limits

- Via barrels are shorts, not 1 mΩ lumps (upgrade path in `analytic_models`).
- Copper thickness is an option (`copperThicknessM`, default 35 µm) — stackup parsing
  is future work.
- Pair solve only; the full terminal R-matrix and Richardson error bars come with the
  M3 harness.
