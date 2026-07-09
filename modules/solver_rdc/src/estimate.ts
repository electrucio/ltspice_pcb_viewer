/**
 * M0-based instant estimate: DC resistance of the SHORTEST TRACK PATH between two
 * pads, by counting squares (Dijkstra over the net's track graph, vias/THT pads as
 * inter-layer bridges with the analytic barrel resistance).
 *
 * This is the closed-form double-check shown next to the FEM result — and its honest
 * limits are part of the contract: it sees only tracks (no pours, no copper
 * graphics), a single path (no parallel branches), and no corner/spreading
 * corrections. For a plain routed trace it lands within ~10 %; through a pour it can
 * be badly pessimistic; when no track path exists it returns null instead of a guess.
 */

import { boardThicknessMm, copperThicknessMm, type Pcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { padOnLayer, copperLayers } from "../../pcb_mesh/src/outline/copper.js";
import { sheetResistance, viaBarrelResistance } from "../../analytic_models/src/index.js";

export interface EstimateOptions {
  /** copper thickness override, METERS, all layers (default: stackup per layer → 35e-6) */
  copperThicknessM?: number;
  tempC?: number;
  /** board thickness for via barrels, METERS (default: stackup Σ → 1.6e-3) */
  boardThicknessM?: number;
  /** via plating wall, METERS (default 25e-6) */
  viaPlatingM?: number;
}

export interface EstimateResult {
  /** Ω along the cheapest track path */
  resistance: number;
  trackSegments: number;
  viaHops: number;
  /** total centerline length of the path, mm */
  pathLengthMm: number;
}

const q = (v: number) => Math.round(v * 1000);

/** One hop of the pad-to-pad track path, in travel order. */
export type PathStep =
  | { kind: "track"; track: Pcb["tracks"][number]; lengthMm: number; /** true when traversed end→start */ reversed: boolean }
  | { kind: "via"; x: number; y: number; fromLayer: string; toLayer: string; /** THT pad barrel, not a via */ padBarrel: boolean };

export interface TrackPath {
  steps: PathStep[];
  pathLengthMm: number;
  /** Σ resistance of the path edges — what estimateResistance reports */
  resistance: number;
}

/**
 * The (resistance-)shortest pure-track path between two pads: ordered steps from
 * padA to padB. null when no track path exists (pour-only connectivity).
 */
export function shortestTrackPath(pcb: Pcb, net: string, padA: string, padB: string, options?: EstimateOptions): TrackPath | null {
  const rsOf = (layer: string): number =>
    sheetResistance(options?.copperThicknessM ?? (copperThicknessMm(pcb, layer) ?? 0.035) * 1e-3, options?.tempC);
  const barrelLength = options?.boardThicknessM ?? ((boardThicknessMm(pcb) ?? 1.6) * 1e-3);
  const layers = copperLayers(pcb);

  type Meta =
    | { kind: "track"; track: Pcb["tracks"][number]; fromStart: boolean }
    | { kind: "via"; x: number; y: number; fromLayer: string; toLayer: string; padBarrel: boolean }
    | { kind: "pad" };
  const ids = new Map<string, number>();
  const adj: Array<Array<{ to: number; r: number; via: boolean; len: number; meta: Meta }>> = [];
  const node = (key: string): number => {
    let id = ids.get(key);
    if (id === undefined) {
      id = adj.length;
      ids.set(key, id);
      adj.push([]);
    }
    return id;
  };
  const link = (a: number, b: number, r: number, via: boolean, len: number, metaAB: Meta, metaBA: Meta) => {
    adj[a]!.push({ to: b, r, via, len, meta: metaAB });
    adj[b]!.push({ to: a, r, via, len, meta: metaBA });
  };

  for (const t of pcb.tracks) {
    if (t.net !== net || !(t.width > 0)) continue;
    const len = Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
    link(
      node(`${t.layer}|${q(t.start.x)},${q(t.start.y)}`), node(`${t.layer}|${q(t.end.x)},${q(t.end.y)}`),
      rsOf(t.layer) * (len / t.width), false, len,
      { kind: "track", track: t, fromStart: true }, { kind: "track", track: t, fromStart: false },
    );
  }
  for (const v of pcb.vias) {
    if (v.net !== net) continue;
    const span = v.layers.length ? v.layers : layers;
    const rVia = viaBarrelResistance({
      finishedHoleDiameter: v.drill * 1e-3,
      platingThickness: options?.viaPlatingM ?? 25e-6,
      length: barrelLength,
      tempC: options?.tempC,
    });
    for (let i = 1; i < span.length; i++) {
      link(
        node(`${span[i - 1]}|${q(v.pos.x)},${q(v.pos.y)}`), node(`${span[i]}|${q(v.pos.x)},${q(v.pos.y)}`), rVia, true, 0,
        { kind: "via", x: v.pos.x, y: v.pos.y, fromLayer: span[i - 1]!, toLayer: span[i]!, padBarrel: false },
        { kind: "via", x: v.pos.x, y: v.pos.y, fromLayer: span[i]!, toLayer: span[i - 1]!, padBarrel: false },
      );
    }
  }
  for (const f of pcb.footprints)
    for (const p of f.pads) {
      if (p.net !== net) continue;
      const padNode = node(`pad|${p.ref}.${p.number}`);
      const on = layers.filter((l) => padOnLayer(p, l));
      for (const l of on) link(padNode, node(`${l}|${q(p.pos.x)},${q(p.pos.y)}`), 0, false, 0, { kind: "pad" }, { kind: "pad" });
      // THT pads bridge layers through their barrel (treated as free, like the FEM's supernodes)
      for (let i = 1; i < on.length; i++)
        link(
          node(`${on[i - 1]}|${q(p.pos.x)},${q(p.pos.y)}`), node(`${on[i]}|${q(p.pos.x)},${q(p.pos.y)}`), 0, true, 0,
          { kind: "via", x: p.pos.x, y: p.pos.y, fromLayer: on[i - 1]!, toLayer: on[i]!, padBarrel: true },
          { kind: "via", x: p.pos.x, y: p.pos.y, fromLayer: on[i]!, toLayer: on[i - 1]!, padBarrel: true },
        );
    }

  const src = ids.get(`pad|${padA}`);
  const dst = ids.get(`pad|${padB}`);
  if (src === undefined || dst === undefined) return null;

  // Dijkstra (graphs are tiny — linear extract-min is fine)
  const n = adj.length;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  dist[src] = 0;
  for (;;) {
    let u = -1, best = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && dist[i]! < best) { best = dist[i]!; u = i; }
    if (u < 0) break;
    if (u === dst) break;
    done[u] = 1;
    for (const e of adj[u]!) {
      const d = dist[u]! + e.r;
      if (d < dist[e.to]!) { dist[e.to] = d; prev[e.to] = u; }
    }
  }
  if (!Number.isFinite(dist[dst]!)) return null;

  // reconstruct dst→src, then reverse into travel order A→B
  const steps: PathStep[] = [];
  let pathLengthMm = 0;
  for (let v = dst; prev[v]! >= 0; v = prev[v]!) {
    const u = prev[v]!;
    const e = adj[u]!.find((e) => e.to === v && Math.abs(dist[u]! + e.r - dist[v]!) < 1e-15) ?? adj[u]!.find((e) => e.to === v)!;
    if (e.meta.kind === "track" && e.len > 0) {
      pathLengthMm += e.len;
      steps.push({ kind: "track", track: e.meta.track, lengthMm: e.len, reversed: !e.meta.fromStart });
    } else if (e.meta.kind === "via") {
      // reconstructing backwards: the traversal direction is u→v, so meta is correct
      steps.push({ kind: "via", x: e.meta.x, y: e.meta.y, fromLayer: e.meta.fromLayer, toLayer: e.meta.toLayer, padBarrel: e.meta.padBarrel });
    }
  }
  steps.reverse();
  return { steps, pathLengthMm, resistance: dist[dst]! };
}

export function estimateResistance(pcb: Pcb, net: string, padA: string, padB: string, options?: EstimateOptions): EstimateResult | null {
  const path = shortestTrackPath(pcb, net, padA, padB, options);
  if (!path) return null;
  return {
    resistance: path.resistance,
    trackSegments: path.steps.filter((s) => s.kind === "track").length,
    viaHops: path.steps.filter((s) => s.kind === "via").length,
    pathLengthMm: path.pathLengthMm,
  };
}
