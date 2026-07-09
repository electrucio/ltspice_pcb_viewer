/**
 * M5 — per-segment transmission-line parameters of a routed net (the FOSDEM-shaped
 * contract: Z0, ε_eff, delay, R/L/G/C, attenuation, skin depth per segment).
 *
 * Reference-plane discovery is EXPLICIT, not guessed from net names: the caller
 * passes `referenceNets` (the user marks GND/PWR/... in the UI), and a copper layer
 * counts as a reference plane for a segment when a zone fill of one of those nets
 * covers the segment midpoint on that layer. The only automatic case: layers whose
 * `(layers …)` table type is "power" — a declared plane — always count.
 *
 * Classification per segment (nearest qualifying plane above / below in the
 * physical stack): planes on both sides → stripline; one side → microstrip (a
 * buried strip with only one plane is treated as plain microstrip and flagged —
 * the model assumes air above, so ε_eff is somewhat underestimated); none →
 * `unmodeled`, with the reason spelled out.
 *
 * Every fallback the analysis takes (no stackup, unknown εr/tanδ/thickness,
 * embedded-as-microstrip) is listed in `assumed` — never silent.
 */

import { boardThicknessMm, copperThicknessMm, type Pcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { copperOrderOf } from "../../pcb_mesh/src/outline/copper.js";
import {
  microstrip,
  microstripLoss,
  stripline,
  striplineLoss,
  type LossResult,
} from "../../analytic_models/src/index.js";

const NP_PER_DB = Math.LN10 / 20;

export interface RlgcOptions {
  /** nets whose zone fills are reference planes — the USER's choice, no name guessing */
  referenceNets?: string[];
  /** evaluation frequency, Hz (default 1e9) */
  frequencyHz?: number;
  /** loss tangent override; default: stackup value (thickness-weighted), else 0.02 flagged */
  tanDelta?: number;
  /** conductor resistivity, Ω·m (default copper) */
  rhoOhmM?: number;
  /** rms copper roughness, m (default 0) */
  roughnessRmsM?: number;
}

export interface RlgcSegment {
  start: { x: number; y: number };
  end: { x: number; y: number };
  layer: string;
  widthMm: number;
  lengthMm: number;
  kind: "microstrip" | "stripline" | "unmodeled";
  /** why the segment could not be modeled */
  reason?: string;
  refAbove?: string;
  refBelow?: string;
  z0?: number;
  epsEff?: number;
  delaySPerM?: number;
  /** total attenuation at f, dB/m */
  alphaDbPerM?: number;
  /** RLGC at f: Ω/m, H/m, S/m, F/m */
  rPerM?: number;
  lPerM?: number;
  gPerM?: number;
  cPerM?: number;
  skinDepthM?: number;
  thickCopper?: boolean;
  /** every default/approximation applied — never silent */
  assumed: string[];
}

export interface RlgcResult {
  segments: RlgcSegment[];
  totals: {
    lengthMm: number;
    modeledLengthMm: number;
    /** total propagation delay over modeled length, s */
    delayS: number;
    z0Min?: number;
    z0Max?: number;
    /** mm per kind */
    kinds: Record<string, number>;
  };
}

function pointInPts(x: number, y: number, pts: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i]!, b = pts[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Thickness-weighted mean of a dielectric property between two copper layers. */
function dielectricBetween(pcb: Pcb, a: string, b: string): { epsilonR?: number; tanDelta?: number } {
  const s = pcb.stackup;
  if (!s) return {};
  const ia = s.findIndex((l) => l.type === "copper" && l.name === a);
  const ib = s.findIndex((l) => l.type === "copper" && l.name === b);
  if (ia < 0 || ib < 0 || ia === ib) return {};
  const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia];
  let wSum = 0, erSum = 0, tanSum = 0, erSeen = false, tanSeen = false;
  for (let i = lo + 1; i < hi; i++) {
    const l = s[i]!;
    if (l.type !== "core" && l.type !== "prepreg") continue;
    const w = l.thicknessMm ?? 0;
    if (!(w > 0)) continue;
    wSum += w;
    if (l.epsilonR !== undefined) { erSum += w * l.epsilonR; erSeen = true; }
    if (l.lossTangent !== undefined) { tanSum += w * l.lossTangent; tanSeen = true; }
  }
  if (!(wSum > 0)) return {};
  return { epsilonR: erSeen ? erSum / wSum : undefined, tanDelta: tanSeen ? tanSum / wSum : undefined };
}

export function analyzeNetRlgc(pcb: Pcb, net: string, options?: RlgcOptions): RlgcResult {
  const f = options?.frequencyHz ?? 1e9;
  const refNets = new Set(options?.referenceNets ?? []);
  const order = copperOrderOf(pcb);
  const MM = 1e-3;

  // gap between adjacent copper layers, mm (stackup; else even share of 1.6 mm)
  const noStackup = !pcb.stackup;
  const gapMm = (a: string, b: string): number => {
    const s = pcb.stackup;
    if (s) {
      const ia = s.findIndex((l) => l.type === "copper" && l.name === a);
      const ib = s.findIndex((l) => l.type === "copper" && l.name === b);
      if (ia >= 0 && ib >= 0 && ia !== ib) {
        const [lo, hi] = ia < ib ? [ia, ib] : [ib, ia];
        let mm = 0;
        for (let i = lo + 1; i < hi; i++) mm += s[i]!.thicknessMm ?? 0;
        if (mm > 0) return mm;
      }
    }
    const gaps = Math.max(1, order.length - 1);
    const steps = Math.max(1, Math.abs(order.indexOf(a) - order.indexOf(b)));
    return ((boardThicknessMm(pcb) ?? 1.6) * steps) / gaps;
  };

  /** Is `layer` a reference plane under (x, y)? */
  const isPlaneAt = (layer: string, x: number, y: number): boolean => {
    if (pcb.copperLayerTypes[layer] === "power") return true; // declared plane
    for (const z of pcb.zones) {
      if (z.layer !== layer || !refNets.has(z.net)) continue;
      if (pointInPts(x, y, z.pts)) return true;
    }
    return false;
  };

  const segments: RlgcSegment[] = [];
  for (const t of pcb.tracks) {
    if (t.net !== net || !(t.width > 0)) continue;
    const lengthMm = Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
    if (!(lengthMm > 0)) continue;
    const midX = (t.start.x + t.end.x) / 2, midY = (t.start.y + t.end.y) / 2;
    const li = order.indexOf(t.layer);
    const assumed: string[] = [];

    // nearest qualifying plane above / below in the physical stack
    let refAbove: string | undefined, refBelow: string | undefined;
    for (let i = li - 1; i >= 0; i--) if (isPlaneAt(order[i]!, midX, midY)) { refAbove = order[i]; break; }
    for (let i = li + 1; i < order.length; i++) if (isPlaneAt(order[i]!, midX, midY)) { refBelow = order[i]; break; }

    const base: RlgcSegment = {
      start: { ...t.start }, end: { ...t.end }, layer: t.layer,
      widthMm: t.width, lengthMm, kind: "unmodeled", refAbove, refBelow, assumed,
    };

    if (!refAbove && !refBelow) {
      base.reason = refNets.size || Object.values(pcb.copperLayerTypes).includes("power")
        ? "no reference plane covers this segment"
        : "no reference nets specified (pick the plane nets) and no power-type layers";
      segments.push(base);
      continue;
    }

    if (noStackup) assumed.push("no stackup: 1.6 mm board, 35 µm copper assumed");
    const tCu = (copperThicknessMm(pcb, t.layer) ?? 0.035) * MM;
    if (!noStackup && copperThicknessMm(pcb, t.layer) === undefined) assumed.push("copper thickness unknown: 35 µm assumed");

    const dielProps = (ref: string) => dielectricBetween(pcb, t.layer, ref);
    const lossCommon = { frequencyHz: f, rhoOhmM: options?.rhoOhmM, roughnessRmsM: options?.roughnessRmsM };

    let z0: number, epsEff: number, delaySPerM: number, lPerM: number, cPerM: number;
    let loss: LossResult;

    if (refAbove && refBelow) {
      base.kind = "stripline";
      const gapUp = gapMm(t.layer, refAbove), gapDown = gapMm(t.layer, refBelow);
      const up = dielProps(refAbove), down = dielProps(refBelow);
      let er = up.epsilonR !== undefined && down.epsilonR !== undefined
        ? (up.epsilonR * gapUp + down.epsilonR * gapDown) / (gapUp + gapDown)
        : up.epsilonR ?? down.epsilonR;
      if (er === undefined) { er = 4.5; assumed.push("εr unknown: 4.5 assumed"); }
      let tanD = options?.tanDelta ?? (up.tanDelta ?? down.tanDelta);
      if (tanD === undefined) { tanD = 0.02; assumed.push("tanδ unknown: 0.02 assumed"); }
      const g = {
        widthM: t.width * MM,
        planeSpacingM: (gapUp + gapDown) * MM + tCu,
        thicknessM: tCu,
        offsetM: gapDown * MM,
        epsilonR: er,
      };
      ({ z0, epsEff, delaySPerM, inductanceHPerM: lPerM, capacitanceFPerM: cPerM } = stripline(g));
      loss = striplineLoss({ ...g, ...lossCommon, tanDelta: tanD });
    } else {
      base.kind = "microstrip";
      const ref = (refAbove ?? refBelow)!;
      const gap = gapMm(t.layer, ref);
      const props = dielProps(ref);
      let er = props.epsilonR;
      if (er === undefined) { er = 4.5; assumed.push("εr unknown: 4.5 assumed"); }
      let tanD = options?.tanDelta ?? props.tanDelta;
      if (tanD === undefined) { tanD = 0.02; assumed.push("tanδ unknown: 0.02 assumed"); }
      const buried = t.layer !== order[0] && t.layer !== order[order.length - 1];
      if (buried) assumed.push("buried strip with one plane: treated as microstrip (ε_eff underestimated)");
      const g = { widthM: t.width * MM, heightM: gap * MM, epsilonR: er, thicknessM: tCu, frequencyHz: f };
      ({ z0, epsEff, delaySPerM, inductanceHPerM: lPerM, capacitanceFPerM: cPerM } = microstrip(g));
      loss = microstripLoss({ ...g, ...lossCommon, tanDelta: tanD });
    }

    const alphaCNp = loss.alphaConductorDbPerM * NP_PER_DB;
    const alphaDNp = loss.alphaDielectricDbPerM * NP_PER_DB;
    segments.push({
      ...base,
      z0, epsEff, delaySPerM,
      alphaDbPerM: loss.alphaDbPerM,
      rPerM: 2 * alphaCNp * z0, // α_c = R/(2Z0)
      lPerM,
      gPerM: (2 * alphaDNp) / z0, // α_d = G·Z0/2
      cPerM,
      skinDepthM: loss.skinDepthM,
      thickCopper: loss.thickCopper,
    });
  }

  const kinds: Record<string, number> = {};
  let lengthMm = 0, modeledLengthMm = 0, delayS = 0;
  let z0Min: number | undefined, z0Max: number | undefined;
  for (const s of segments) {
    lengthMm += s.lengthMm;
    kinds[s.kind] = (kinds[s.kind] ?? 0) + s.lengthMm;
    if (s.kind === "unmodeled") continue;
    modeledLengthMm += s.lengthMm;
    delayS += (s.delaySPerM ?? 0) * s.lengthMm * MM;
    if (s.z0 !== undefined) {
      z0Min = z0Min === undefined ? s.z0 : Math.min(z0Min, s.z0);
      z0Max = z0Max === undefined ? s.z0 : Math.max(z0Max, s.z0);
    }
  }
  return { segments, totals: { lengthMm, modeledLengthMm, delayS, z0Min, z0Max, kinds } };
}
