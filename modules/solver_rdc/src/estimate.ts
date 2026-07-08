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

export function estimateResistance(pcb: Pcb, net: string, padA: string, padB: string, options?: EstimateOptions): EstimateResult | null {
  const rsOf = (layer: string): number =>
    sheetResistance(options?.copperThicknessM ?? (copperThicknessMm(pcb, layer) ?? 0.035) * 1e-3, options?.tempC);
  const barrelLength = options?.boardThicknessM ?? ((boardThicknessMm(pcb) ?? 1.6) * 1e-3);
  const layers = copperLayers(pcb);

  const ids = new Map<string, number>();
  const adj: Array<Array<{ to: number; r: number; via: boolean; len: number }>> = [];
  const node = (key: string): number => {
    let id = ids.get(key);
    if (id === undefined) {
      id = adj.length;
      ids.set(key, id);
      adj.push([]);
    }
    return id;
  };
  const link = (a: number, b: number, r: number, via = false, len = 0) => {
    adj[a]!.push({ to: b, r, via, len });
    adj[b]!.push({ to: a, r, via, len });
  };

  for (const t of pcb.tracks) {
    if (t.net !== net || !(t.width > 0)) continue;
    const len = Math.hypot(t.end.x - t.start.x, t.end.y - t.start.y);
    link(node(`${t.layer}|${q(t.start.x)},${q(t.start.y)}`), node(`${t.layer}|${q(t.end.x)},${q(t.end.y)}`), rsOf(t.layer) * (len / t.width), false, len);
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
      link(node(`${span[i - 1]}|${q(v.pos.x)},${q(v.pos.y)}`), node(`${span[i]}|${q(v.pos.x)},${q(v.pos.y)}`), rVia, true);
    }
  }
  for (const f of pcb.footprints)
    for (const p of f.pads) {
      if (p.net !== net) continue;
      const padNode = node(`pad|${p.ref}.${p.number}`);
      const on = layers.filter((l) => padOnLayer(p, l));
      for (const l of on) link(padNode, node(`${l}|${q(p.pos.x)},${q(p.pos.y)}`), 0);
      // THT pads bridge layers through their barrel (treated as free, like the FEM's supernodes)
      for (let i = 1; i < on.length; i++)
        link(node(`${on[i - 1]}|${q(p.pos.x)},${q(p.pos.y)}`), node(`${on[i]}|${q(p.pos.x)},${q(p.pos.y)}`), 0, true);
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

  let trackSegments = 0, viaHops = 0, pathLengthMm = 0;
  for (let v = dst; prev[v]! >= 0; v = prev[v]!) {
    const u = prev[v]!;
    const e = adj[u]!.find((e) => e.to === v && Math.abs(dist[u]! + e.r - dist[v]!) < 1e-15) ?? adj[u]!.find((e) => e.to === v)!;
    if (e.via) viaHops++;
    else if (e.len > 0) { trackSegments++; pathLengthMm += e.len; }
  }
  return { resistance: dist[dst]!, trackSegments, viaHops, pathLengthMm };
}
