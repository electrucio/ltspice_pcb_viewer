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
import { shortestTrackPath, type PathStep } from "./estimate.js";
import {
  microstrip,
  microstripLoss,
  stripline,
  striplineLoss,
  type LossResult,
} from "../../analytic_models/src/index.js";

type Track = Pcb["tracks"][number];

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

/** Shared per-track classifier used by the whole-net and the pad-to-pad analyses. */
function makeClassifier(pcb: Pcb, options?: RlgcOptions): (t: Track) => RlgcSegment {
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

  return (t: Track): RlgcSegment => {
    const lengthMm = Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
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
      return base;
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
    return {
      ...base,
      z0, epsEff, delaySPerM,
      alphaDbPerM: loss.alphaDbPerM,
      rPerM: 2 * alphaCNp * z0, // α_c = R/(2Z0)
      lPerM,
      gPerM: (2 * alphaDNp) / z0, // α_d = G·Z0/2
      cPerM,
      skinDepthM: loss.skinDepthM,
      thickCopper: loss.thickCopper,
    };
  };
}

function totalsOf(segments: RlgcSegment[]): RlgcResult["totals"] {
  const kinds: Record<string, number> = {};
  let lengthMm = 0, modeledLengthMm = 0, delayS = 0;
  let z0Min: number | undefined, z0Max: number | undefined;
  for (const s of segments) {
    lengthMm += s.lengthMm;
    kinds[s.kind] = (kinds[s.kind] ?? 0) + s.lengthMm;
    if (s.kind === "unmodeled") continue;
    modeledLengthMm += s.lengthMm;
    delayS += (s.delaySPerM ?? 0) * s.lengthMm * 1e-3;
    if (s.z0 !== undefined) {
      z0Min = z0Min === undefined ? s.z0 : Math.min(z0Min, s.z0);
      z0Max = z0Max === undefined ? s.z0 : Math.max(z0Max, s.z0);
    }
  }
  return { lengthMm, modeledLengthMm, delayS, z0Min, z0Max, kinds };
}

export function analyzeNetRlgc(pcb: Pcb, net: string, options?: RlgcOptions): RlgcResult {
  const classify = makeClassifier(pcb, options);
  const segments: RlgcSegment[] = [];
  for (const t of pcb.tracks) {
    if (t.net !== net || !(t.width > 0)) continue;
    if (!(Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y) > 0)) continue;
    segments.push(classify(t));
  }
  return { segments, totals: totalsOf(segments) };
}

// ---- pad-to-pad profile (the SI view: ordered Z0 along the signal's route) ----

export type ProfileStep =
  | ({ type: "segment"; /** distance from padA to the START of this piece, mm */ atMm: number } & RlgcSegment)
  | { type: "via"; atMm: number; x: number; y: number; fromLayer: string; toLayer: string; /** THT pad barrel, not a via */ padBarrel: boolean };

export interface RlgcPathResult {
  steps: ProfileStep[];
  /** branches hanging off the path — stubs (reflections on fast edges) */
  stubs: Array<{ atMm: number; lengthMm: number }>;
  totals: RlgcResult["totals"] & { viaCount: number };
}

/**
 * Transmission-line profile along the shortest track path padA → padB: the ordered
 * Z0/RLGC sequence a launched edge actually sees, with via crossings as events and
 * off-path branches reported as stubs. null when no pure track path exists.
 */
export function analyzePathRlgc(pcb: Pcb, net: string, padA: string, padB: string, options?: RlgcOptions): RlgcPathResult | null {
  const path = shortestTrackPath(pcb, net, padA, padB);
  if (!path) return null;
  const classify = makeClassifier(pcb, options);

  const steps: ProfileStep[] = [];
  const segments: RlgcSegment[] = [];
  let atMm = 0;
  let viaCount = 0;
  for (const s of path.steps as PathStep[]) {
    if (s.kind === "track") {
      const seg = classify(s.track);
      // orient the reported segment in travel direction
      if (s.reversed) { const tmp = seg.start; seg.start = seg.end; seg.end = tmp; }
      segments.push(seg);
      steps.push({ type: "segment", atMm, ...seg });
      atMm += s.lengthMm;
    } else {
      viaCount += s.padBarrel ? 0 : 1;
      steps.push({ type: "via", atMm, x: s.x, y: s.y, fromLayer: s.fromLayer, toLayer: s.toLayer, padBarrel: s.padBarrel });
    }
  }

  // stubs: net tracks NOT on the path, reachable from path nodes (via endpoints,
  // through off-path vias too) — report total hanging length per attachment point
  const key = (layer: string, x: number, y: number): string => `${layer}|${Math.round(x * 1000)},${Math.round(y * 1000)}`;
  const pathTracks = new Set<Track>(path.steps.filter((s): s is Extract<PathStep, { kind: "track" }> => s.kind === "track").map((s) => s.track));
  const netTracks = pcb.tracks.filter((t) => t.net === net && t.width > 0 && !pathTracks.has(t));
  // endpoint index of off-path tracks + layer bridges at net vias
  const byKey = new Map<string, Track[]>();
  const push = (k: string, t: Track) => (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(t);
  for (const t of netTracks) {
    push(key(t.layer, t.start.x, t.start.y), t);
    push(key(t.layer, t.end.x, t.end.y), t);
  }
  const viaAliases = new Map<string, string[]>(); // key → sibling keys on other layers
  for (const v of pcb.vias) {
    if (v.net !== net) continue;
    const ks = (v.layers.length ? v.layers : pcb.copperStack).map((l) => key(l, v.pos.x, v.pos.y));
    for (const k of ks) viaAliases.set(k, ks);
  }
  const visited = new Set<Track>();
  const stubLengthFrom = (startKey: string): number => {
    let total = 0;
    const queue = [startKey];
    const seenKeys = new Set<string>(queue);
    while (queue.length) {
      const k = queue.pop()!;
      for (const alias of viaAliases.get(k) ?? []) if (!seenKeys.has(alias)) { seenKeys.add(alias); queue.push(alias); }
      for (const t of byKey.get(k) ?? []) {
        if (visited.has(t)) continue;
        visited.add(t);
        total += Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
        for (const p of [t.start, t.end]) {
          const nk = key(t.layer, p.x, p.y);
          if (!seenKeys.has(nk)) { seenKeys.add(nk); queue.push(nk); }
        }
      }
    }
    return total;
  };
  const stubs: Array<{ atMm: number; lengthMm: number }> = [];
  let cursor = 0;
  for (const s of path.steps as PathStep[]) {
    if (s.kind === "track") {
      const from = s.reversed ? s.track.end : s.track.start;
      const to = s.reversed ? s.track.start : s.track.end;
      for (const [pt, at] of [[from, cursor], [to, cursor + s.lengthMm]] as const) {
        const l = stubLengthFrom(key(s.track.layer, pt.x, pt.y));
        if (l > 0) stubs.push({ atMm: at, lengthMm: l });
      }
      cursor += s.lengthMm;
    } else {
      const l = stubLengthFrom(key(s.fromLayer, s.x, s.y)) + stubLengthFrom(key(s.toLayer, s.x, s.y));
      if (l > 0) stubs.push({ atMm: cursor, lengthMm: l });
    }
  }

  return { steps, stubs, totals: { ...totalsOf(segments), viaCount } };
}
