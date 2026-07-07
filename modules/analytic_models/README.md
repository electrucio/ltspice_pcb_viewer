# analytic_models

M0 of the parasitic-extraction engine: closed-form/empirical PCB formulas as pure,
zero-dependency TypeScript, **SI units only** (m, Ω, °C). Three roles: (a) test oracle
for the field solvers (M4–M7), (b) instant UI estimates, (c) runtime sanity monitor.

Built **just-in-time, in solver order** — each slice lands right before the solver it
checks, with source-verified fixtures (project rule: no formulas or constants from
memory).

## Implemented: DC-resistance slice (oracle for M4)

- `copperResistivity(tempC)` — IACS ρ₂₀ = 1.724e-8 Ω·m, α = 0.00393 /K, linear model
  referenced at 20 °C.
- `sheetResistance(t)`, `traceResistance({length,width,thickness,tempC})` — ρL/(W·t).
- `pathSquares(segments, corners90)` / `resistanceFromSquares` — counting-squares
  method with **0.56 squares per 90° corner** (Jaeger; the M4 FEM acceptance tests
  will re-derive this number — closing the loop is the point).
- `viaBarrelResistance({finishedHoleDiameter, platingThickness, length, tempC})` —
  plated annulus ρL/(π·t·(d+t)); the hole diameter convention matches the
  `.kicad_pcb` `drill` field.

## Verification (14 tests)

- **Independent-implementation fixtures**: outputs of `~/git/pcb-toolkit`
  (reverse-engineered Saturn PCB Toolkit v8.44, validated against Saturn's help-PDF
  vectors) transcribed with their exact CLI invocations; agreement to 1e-4 rel
  (Saturn's ohm-mil factor is rounded).
- Formula-family agreement with circuitcalculator.com's trace-resistance calculator
  (same R = ρL/(W·t)·[1+αΔT]; note it references 25 °C where Saturn/IACS use 20 °C —
  our API takes the temperature explicitly).
- Hand-derived fixtures (incl. the project-spec 10 cm/0.2 mm/35 µm ≈ 0.246 Ω example),
  the published ~0.5 mΩ/sq 1-oz rule of thumb, temperature linearity, uniform-scaling
  invariance (sheet-resistance law), input validation.

## Future slices (land with their solver)

M5: Hammerstad–Jensen 1980 + Wheeler microstrip/stripline Z₀, ε_eff. M6:
parallel-plate + fringing capacitance. M7: Grover loop inductances, via barrel L/C,
round-wire Bessel skin effect. pcb-toolkit also covers most of these (decompiled
Saturn formulas + test vectors) and will serve as the cross-check again.
