/**
 * Physical constants for the analytic models. **All SI** (Ω·m, m, K) — this module
 * never sees board millimetres; convert at the caller's boundary.
 *
 * Source discipline (project rule: no constants from memory): every value below is
 * cross-checked against at least one independent implementation —
 * `~/git/pcb-toolkit` (reverse-engineered Saturn PCB Toolkit v8.44,
 * crates/pcb-toolkit/src/constants.rs) and circuitcalculator.com's trace-resistance
 * calculator — and matches the IACS standard values.
 */

/**
 * Resistivity of annealed copper at 20 °C, Ω·m (International Annealed Copper
 * Standard). pcb-toolkit: 1.724e-6 Ω·cm (constants.rs:17) ≡ 1.724e-8 Ω·m; Saturn
 * uses the same via its 6.787e-4 Ω·mil factor (= 1.724e-8 / 2.54e-5 exactly).
 */
export const RHO_COPPER_20C = 1.724e-8;

/**
 * Temperature coefficient of copper resistivity, 1/K, referenced at 20 °C.
 * pcb-toolkit constants.rs:20 (0.00393); circuitcalculator.com quotes 0.0039.
 */
export const ALPHA_COPPER = 0.00393;

/** Reference temperature (°C) for RHO_COPPER_20C / ALPHA_COPPER. */
export const COPPER_REF_TEMP_C = 20;

/**
 * Speed of light in vacuum, m/s (SI exact, by definition of the metre).
 */
export const C0 = 299792458;

/**
 * Extra squares contributed by a 90° corner in a uniform-width trace, beyond the
 * straight centerline count. Jaeger's classical result (≈0.56 sq — the corner square
 * conducts better than a full square because current crowds the inside edge); see
 * EDN, "Counting squares: a method to quickly estimate PWB trace resistance".
 * To be re-derived numerically by the M4 FEM solver (planned acceptance test).
 */
export const CORNER_SQUARES = 0.56;
