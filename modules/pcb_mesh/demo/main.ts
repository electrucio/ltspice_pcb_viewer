/// <reference types="vite/client" />
/**
 * pcb_mesh demo: parse a .kicad_pcb, extract + triangulate the copper of one layer,
 * and draw every triangle as SVG — the visual check that regions land exactly where
 * the viewer draws copper, that unions merged what touches, and that drills are holes.
 */
import defaultBoard from "../../kicad_pcb_viewer/demo/poweramp.kicad_pcb?raw";
import { wheelZoomFactor } from "../../kicad_pcb_viewer/src/interaction/controller.js";
import { boardThicknessMm, copperThicknessMm, parsePcb, type Pcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { extractCopper } from "../src/outline/copper.js";
import { meshRegion } from "../src/mesh/triangulate.js";
import { emptySanitationReport, resolveOptions } from "../src/types.js";
import { analyzeRegion } from "../src/verify.js";
import { initRuppert, ruppertReady } from "../src/mesh/ruppert.js";
import type { LayerField } from "../../solver_rdc/src/solve.js";
import { solveWithErrorEstimate } from "../../solver_rdc/src/richardson.js";
import { sheetResistance } from "../../analytic_models/src/index.js";
import { estimateResistance } from "../../solver_rdc/src/estimate.js";
import type { BoardMesh, RegionMesh, SanitationReport } from "../src/types.js";

type Refinement = "ruppert" | "delaunay" | "bisect";

const svg = document.getElementById("view") as unknown as SVGSVGElement;
const layerSel = document.getElementById("layer") as HTMLSelectElement;
const maxEdgeSel = document.getElementById("maxedge") as HTMLSelectElement;
const refineSel = document.getElementById("refine") as HTMLSelectElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
const islandsOnlyEl = document.getElementById("islandsOnly") as HTMLInputElement;
const statsEl = document.getElementById("stats")!;
const infoEl = document.getElementById("info") as HTMLPreElement;
const solveEl = document.getElementById("solve") as HTMLDivElement;
const padASel = document.getElementById("padA") as HTMLSelectElement;
const padBSel = document.getElementById("padB") as HTMLSelectElement;
const solveBtn = document.getElementById("solveBtn") as HTMLButtonElement;
const rresEl = document.getElementById("rres")!;
const currentAEl = document.getElementById("currentA") as HTMLInputElement;
const overlayModeEl = document.getElementById("overlayMode") as HTMLSelectElement;
const powerEl = document.getElementById("power")!;
const flowLegendEl = document.getElementById("flowlegend")!;
const netsEl = document.getElementById("nets")!;
const hoverEl = document.getElementById("hover")!;
const SVGNS = "http://www.w3.org/2000/svg";

let pcb: Pcb = parsePcb(defaultBoard);
let mesh: BoardMesh;
let selectedNet: string | null = null;

const color = (net: string): string => {
  let h = 0;
  for (let i = 0; i < net.length; i++) h = (h * 31 + net.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 60%)`;
};

/** Path data in chunks of 50k triangles so huge refined zones can't blow the string/DOM. */
function trianglePaths(r: RegionMesh): string[] {
  const v = r.vertices, t = r.triangles;
  const chunks: string[] = [];
  let parts: string[] = [];
  for (let i = 0; i < t.length; i += 3) {
    const a = t[i]! * 2, b = t[i + 1]! * 2, c = t[i + 2]! * 2;
    parts.push(`M${v[a]} ${v[a + 1]}L${v[b]} ${v[b + 1]}L${v[c]} ${v[c + 1]}Z`);
    if (parts.length === 50_000) { chunks.push(parts.join("")); parts = []; }
  }
  if (parts.length) chunks.push(parts.join(""));
  return chunks;
}

const layerOpacity = new Map<string, number>(); // 0..1, per copper layer (all-layers mode)

function activeLayers(): string[] {
  if (layerSel.value !== "*") return [layerSel.value];
  return [...layerSel.options].map((o) => o.value).filter((v) => v !== "*");
}

// ---- progress / logging / error surfacing ------------------------------------

/** Yield to the browser so the just-set progress state actually paints. */
const paint = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

function showProgress(msg: string, fraction?: number, detail?: string): void {
  statsEl.replaceChildren();
  const b = document.createElement("b");
  b.textContent = `⏳ ${msg}`;
  statsEl.appendChild(b);
  if (fraction !== undefined) {
    const bar = document.createElement("progress");
    bar.max = 1;
    bar.value = fraction;
    statsEl.appendChild(bar);
  }
  if (detail) statsEl.appendChild(document.createTextNode(`\n${detail}`));
}

function showError(title: string, err: unknown): void {
  console.error(`[pcb_mesh] ${title}:`, err);
  const msg = err instanceof Error ? `${err.message}${err.stack ? `\n\n${err.stack}` : ""}` : String(err);
  statsEl.textContent = `⚠ ${title} — see popup / console`;
  (document.getElementById("errtitle")!).textContent = title;
  (document.getElementById("errmsg")!).textContent = msg;
  (document.getElementById("errbox") as HTMLDivElement).hidden = false;
}
document.getElementById("errclose")!.addEventListener("click", () => {
  (document.getElementById("errbox") as HTMLDivElement).hidden = true;
});

// ---- mesh rebuild (incremental: progress per region, cancellable) -------------

let buildSeq = 0;

function rebuildMesh(): void {
  void rebuildMeshAsync();
}

// per-(board, layer, options) mesh cache: switching layers (or back to a layer
// already built) must not re-extract or re-mesh anything
let boardGen = 0; // bumped on every board load — invalidates the cache wholesale
const meshCache = new Map<string, { regions: RegionMesh[]; report: SanitationReport }>();
let renderedKey = ""; // what the SVG currently shows — identical key ⇒ skip repaint

async function rebuildMeshAsync(): Promise<void> {
  const seq = ++buildSeq;
  try {
    const maxEdge = maxEdgeSel.value ? Number(maxEdgeSel.value) : undefined;
    const refinement = refineSel.value as Refinement;
    const layers = activeLayers();
    const t0 = performance.now();

    const perLayer: Array<{ regions: RegionMesh[]; report: SanitationReport }> = [];
    const keys: string[] = [];
    for (let li = 0; li < layers.length; li++) {
      const layer = layers[li]!;
      const key = `${boardGen}|${layer}|${maxEdge ?? "∞"}|${refinement}`;
      keys.push(key);
      const cached = meshCache.get(key);
      if (cached) {
        console.log(`[pcb_mesh] ${layer}: mesh cache hit`);
        perLayer.push(cached);
        continue;
      }
      showProgress(`extracting copper on ${layer}…`);
      await paint();
      if (seq !== buildSeq) return; // superseded by a newer rebuild — abandon quietly
      const tl = performance.now();
      const opts = { layers: [layer], maxEdgeLength: maxEdge, refinement, arcSegments: 24 };
      const { regions: copper, report } = extractCopper(pcb, opts);
      const tExtract = performance.now() - tl;
      const o = resolveOptions(opts);
      const regions: RegionMesh[] = [];
      let slowest = { ms: 0, label: "" };
      let lastPaint = performance.now();
      for (let i = 0; i < copper.length; i++) {
        if (seq !== buildSeq) return;
        const r = copper[i]!;
        const tr = performance.now();
        regions.push(meshRegion(r, o.maxEdgeLength, o.refinement));
        const trMs = performance.now() - tr;
        if (trMs > slowest.ms) slowest = { ms: trMs, label: r.net || "(no net)" };
        if (performance.now() - lastPaint > 100) {
          showProgress(`meshing ${layer}… ${i + 1}/${copper.length} regions`, (i + 1) / copper.length, `${r.net || "(unconnected)"}${layers.length > 1 ? ` · layer ${li + 1}/${layers.length}` : ""}`);
          await paint();
          lastPaint = performance.now();
        }
      }
      report.degenerateTriangles = regions.reduce((s, r) => s + r.degenerateTriangles, 0);
      report.refinementFallbacks = regions.reduce((s, r) => s + (r.refinementFellBack ? 1 : 0), 0);
      console.log(`[pcb_mesh] ${layer}: extracted ${copper.length} regions in ${tExtract.toFixed(0)} ms, meshed in ${(performance.now() - tl - tExtract).toFixed(0)} ms (slowest: ${slowest.label} ${slowest.ms.toFixed(0)} ms)`);
      meshCache.set(key, { regions, report });
      while (meshCache.size > 12) meshCache.delete(meshCache.keys().next().value!); // bound memory
      perLayer.push({ regions, report });
    }
    if (seq !== buildSeq) return;

    const report = emptySanitationReport();
    for (const pl of perLayer)
      for (const k of Object.keys(report) as Array<keyof SanitationReport>) report[k] += pl.report[k];
    mesh = { layers, regions: perLayer.flatMap((pl) => pl.regions), report };
    finishRebuild(performance.now() - t0, keys.join(" "));
  } catch (e) {
    if (seq === buildSeq) showError("Meshing failed", e);
  }
}

let statsOpen = false; // the details fold state survives rebuilds

function finishRebuild(ms: number, key: string): void {
  const regions = mesh.regions;
  const tris = regions.reduce((s, r) => s + r.quality.triangleCount, 0);
  const slivers = regions.reduce((s, r) => s + r.quality.sliverCount, 0);
  const area = regions.reduce((s, r) => s + r.meshArea, 0);
  const worstDrift = Math.max(0, ...regions.map((r) => Math.abs(r.meshArea - r.outlineArea) / r.outlineArea));
  const multiIsland = regions.filter((r) => r.islands > 1);
  const rep = mesh.report;
  const repParts = [
    rep.zeroLengthTracks && `${rep.zeroLengthTracks} zero-len tracks`,
    rep.padShapeFallbacks && `${rep.padShapeFallbacks} pad-shape fallbacks`,
    rep.degenerateRings && `${rep.degenerateRings} degenerate rings`,
    rep.emptyRegions && `${rep.emptyRegions} vanished regions (NPTH)`,
    rep.degenerateTriangles && `${rep.degenerateTriangles} zero-area tris dropped`,
    rep.copperTextIgnored && `⚠ ${rep.copperTextIgnored} copper text(s) not meshed`,
    rep.booleanFallbacks && `${rep.booleanFallbacks} boolean fallbacks`,
    rep.droppedPrimitives && `⚠ ${rep.droppedPrimitives} primitives DROPPED`,
    rep.refinementFallbacks && `⚠ ${rep.refinementFallbacks} region(s) fell back to unguaranteed mesh`,
  ].filter(Boolean);

  // one always-visible summary line; everything else folds away (it gets huge)
  statsEl.replaceChildren();
  const summaryLine = document.createElement("div");
  summaryLine.textContent = `${regions.length} net regions · ${tris.toLocaleString()} triangles · ${ms.toFixed(0)} ms`;
  const det = document.createElement("details");
  det.open = statsOpen;
  det.addEventListener("toggle", () => (statsOpen = det.open));
  const sum = document.createElement("summary");
  sum.textContent = "details";
  const body = document.createElement("div");
  body.textContent =
    `copper: ${area.toFixed(1)} mm²\n` +
    `area drift (mesh vs outline): ${worstDrift.toExponential(1)}\n` +
    `slivers (<20°): ${slivers.toLocaleString()}\n` +
    `multi-island nets: ${multiIsland.length ? multiIsland.map((r) => `${r.net || "(unconnected)"}×${r.islands}`).join(", ") : "none"}` +
    (repParts.length ? `\nsanitation: ${repParts.join(", ")}` : "");
  det.append(sum, body);
  statsEl.append(summaryLine, det);

  if (key !== renderedKey) {
    renderedKey = key;
    render();
    renderNetList();
    renderInfo();
    renderOpacitySliders();
  }
}

function renderOpacitySliders(): void {
  const box = document.getElementById("opacities")!;
  box.replaceChildren();
  const layers = activeLayers();
  if (layers.length < 2) { box.hidden = true; return; }
  box.hidden = false;
  layers.forEach((layer, i) => {
    if (!layerOpacity.has(layer)) layerOpacity.set(layer, i === 0 ? 0.9 : Math.max(0.25, 0.7 - 0.15 * (i - 1)));
    const row = document.createElement("label");
    row.style.display = "flex";
    row.style.gap = "6px";
    const name = document.createElement("span");
    name.textContent = layer;
    name.style.minWidth = "52px";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(Math.round(layerOpacity.get(layer)! * 100));
    slider.addEventListener("input", () => {
      layerOpacity.set(layer, Number(slider.value) / 100);
      const g = svg.querySelector<SVGGElement>(`g[data-meshlayer="${layer}"]`);
      if (g) g.setAttribute("opacity", String(layerOpacity.get(layer)));
    });
    row.append(name, slider);
    box.appendChild(row);
  });
}

const fmt = (v: number, digits = 4): string => v.toFixed(digits);

function renderInfo(): void {
  if (!selectedNet && selectedNet !== "") { infoEl.hidden = true; return; }
  const maxEdge = maxEdgeSel.value ? Number(maxEdgeSel.value) : undefined;
  const r = analyzeRegion(pcb, layerSel.value, selectedNet!, {
    maxEdgeLength: maxEdge,
    refinement: refineSel.value as Refinement,
    mcSamples: 150_000,
    seed: 1,
  });
  if (!r) { infoEl.hidden = true; return; }
  const a = r.areas, mc = a.monteCarlo;
  const ok = (cond: boolean) => (cond ? `<span class="ok">✓</span>` : `<span class="bad">✗ CHECK</span>`);
  const driftOk = a.meshVsOutlineRel < 1e-9;
  const mcOk = Math.abs(mc.value - a.outline) < Math.max(4 * mc.stdError, 0.02 * a.outline);
  const width = r.trackWidth ? (r.trackWidth.min === r.trackWidth.max ? `${r.trackWidth.min}` : `${r.trackWidth.min}–${r.trackWidth.max}`) : "—";
  const pads = r.padRefs.slice(0, 10).join(" ") + (r.padRefs.length > 10 ? ` +${r.padRefs.length - 10}` : "");
  infoEl.hidden = false;
  infoEl.innerHTML =
    `<b>${r.net || "(unconnected)"}</b> — ${r.layer}\n` +
    `${r.counts.tracks} tracks (Σ ${r.trackLength.toFixed(1)} mm, w ${width}) · ${r.counts.pads} pads · ${r.counts.vias} vias · ${r.counts.zoneFills} zone fills\n` +
    `islands ${r.counts.islands}${r.counts.islands > 1 ? ' <span class="bad">⚠</span> (per-layer — may join through vias on other layers)' : ""} · holes ${r.counts.holes} · perimeter ${r.perimeter.toFixed(1)} mm\n` +
    (pads ? `pads: ${pads}\n` : "") +
    `\n<b>areas (mm²) — independent cross-checks</b>\n` +
    `outline (boolean union)   ${fmt(a.outline)}\n` +
    `mesh (Σ triangles)        ${fmt(a.mesh)}   drift ${a.meshVsOutlineRel.toExponential(1)} ${ok(driftOk)}\n` +
    `Σ primitives (closed form) ${fmt(a.primitiveSum)}   overlap ${fmt(a.overlapArea, 2)}\n` +
    `Monte Carlo (analytic)    ${fmt(mc.value, 2)} ± ${fmt(mc.stdError, 2)}   Δ ${a.mcVsOutlineSigmas >= 0 ? "+" : ""}${a.mcVsOutlineSigmas.toFixed(1)}σ ${ok(mcOk)}\n` +
    `\n<b>mesh</b>: ${r.meshQuality.triangleCount.toLocaleString()} tris · min ∠ ${r.meshQuality.minAngleDeg.toFixed(1)}° · ` +
    `slivers ${r.meshQuality.sliverCount} · worst aspect ${r.meshQuality.worstAspect > 1e6 ? "∞" : r.meshQuality.worstAspect.toFixed(0)}`;
}

// ---- pan / zoom (viewBox-based, wheel math shared with the viewer module) ----
const vb = { x: 0, y: 0, w: 100, h: 100 };
let vbInitialized = false;

function applyViewBox(): void {
  svg.setAttribute("viewBox", `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
}

function fitViewBox(): void {
  const b = pcb.bbox, pad = 2;
  vb.x = b.minX - pad;
  vb.y = b.minY - pad;
  vb.w = b.maxX - b.minX + 2 * pad;
  vb.h = b.maxY - b.minY + 2 * pad;
  vbInitialized = true;
  applyViewBox();
}

svg.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = svg.getBoundingClientRect();
  const px = vb.x + ((e.clientX - rect.left) / rect.width) * vb.w;
  const py = vb.y + ((e.clientY - rect.top) / rect.height) * vb.h;
  const k = wheelZoomFactor(e.deltaY);
  vb.x = px - (px - vb.x) * k;
  vb.y = py - (py - vb.y) * k;
  vb.w *= k;
  vb.h *= k;
  applyViewBox();
}, { passive: false });

// NOTE: no setPointerCapture here — capturing retargets the resulting click to the
// svg element itself, which silently kills net/pad click selection
let panning = false, panMoved = false, lastX = 0, lastY = 0;
svg.addEventListener("pointerdown", (e) => {
  panning = true;
  panMoved = false;
  lastX = e.clientX;
  lastY = e.clientY;
});
window.addEventListener("pointermove", (e) => {
  if (!panning) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  if (Math.abs(dx) + Math.abs(dy) > 3) panMoved = true;
  if (!panMoved) return;
  const rect = svg.getBoundingClientRect();
  vb.x -= (dx / rect.width) * vb.w;
  vb.y -= (dy / rect.height) * vb.h;
  lastX = e.clientX;
  lastY = e.clientY;
  applyViewBox();
});
window.addEventListener("pointerup", () => {
  panning = false;
});
// a drag must not count as a net/pad click
svg.addEventListener("click", (e) => {
  if (panMoved) e.stopPropagation();
}, true);
svg.addEventListener("dblclick", () => fitViewBox());

function render(): void {
  svg.replaceChildren();
  if (!vbInitialized) fitViewBox();
  else applyViewBox();
  // board outline for context
  for (const g of pcb.graphics) {
    if (g.layer !== "Edge.Cuts" || g.kind !== "line") continue;
    const l = document.createElementNS(SVGNS, "line");
    l.setAttribute("x1", String(g.a.x)); l.setAttribute("y1", String(g.a.y));
    l.setAttribute("x2", String(g.b.x)); l.setAttribute("y2", String(g.b.y));
    l.setAttribute("class", "outline");
    svg.appendChild(l);
  }
  // per-layer groups so the opacity sliders act on whole layers (B.Cu at the bottom);
  // the sliders only apply in all-layers mode — a single layer always shows full-on
  const layers = [...activeLayers()].reverse();
  const layerGroups = new Map<string, SVGGElement>();
  for (const layer of layers) {
    const lg = document.createElementNS(SVGNS, "g");
    lg.dataset.meshlayer = layer;
    lg.setAttribute("opacity", layers.length > 1 ? String(layerOpacity.get(layer) ?? 1) : "1");
    layerGroups.set(layer, lg);
    svg.appendChild(lg);
  }
  for (const r of mesh.regions) {
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "region");
    g.dataset.net = r.net;
    g.dataset.islands = String(r.islands);
    const c = color(r.net);
    for (const d of trianglePaths(r)) {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", d);
      p.setAttribute("fill", c);
      p.setAttribute("stroke", c);
      g.appendChild(p);
    }
    g.addEventListener("mousemove", () => {
      hoverEl.hidden = false;
      hoverEl.textContent =
        `${r.net || "(unconnected)"} — ${r.meshArea.toFixed(2)} mm², ${r.quality.triangleCount} tris, min ∠ ${r.quality.minAngleDeg.toFixed(1)}°` +
        (r.islands > 1 ? ` — ${r.islands} islands on this layer` : "");
    });
    g.addEventListener("mouseleave", () => (hoverEl.hidden = true));
    (layerGroups.get(r.layer) ?? svg).appendChild(g);
  }
  applySelection();
}

/** Dim/undim in place — no SVG rebuild on selection (281k-triangle boards repaint slowly). */
function applySelection(): void {
  for (const g of svg.querySelectorAll<SVGGElement>("g.region")) {
    const net = g.dataset.net ?? "";
    const islands = Number(g.dataset.islands ?? "1");
    const active = islandsOnlyEl.checked ? islands > 1 : selectedNet === null || selectedNet === net;
    for (const p of g.children) {
      p.setAttribute("fill-opacity", active ? "0.35" : "0.05");
      p.setAttribute("stroke-opacity", active ? "0.9" : "0.1");
    }
  }
}

// net selection by click: of ALL regions under the cursor (stacked layers in
// all-layers mode), pick the one on the layer with the HIGHEST opacity slider —
// what you see brightest is what you select
svg.addEventListener("click", (e) => {
  const hits = document.elementsFromPoint(e.clientX, e.clientY);
  const cands: Array<{ net: string; layer: string }> = [];
  for (const el of hits) {
    const g = el.closest?.("g.region") as SVGGElement | null;
    if (!g || g.dataset.net === undefined) continue;
    const layer = (g.parentElement as SVGGElement | null)?.dataset?.meshlayer ?? "";
    if (!cands.some((c) => c.net === g.dataset.net && c.layer === layer)) cands.push({ net: g.dataset.net!, layer });
  }
  if (!cands.length) return;
  cands.sort((a, b) => (layerOpacity.get(b.layer) ?? 1) - (layerOpacity.get(a.layer) ?? 1));
  const net = cands[0]!.net;
  selectNet(selectedNet === net ? null : net);
});

function renderNetList(): void {
  netsEl.replaceChildren();
  for (const r of [...mesh.regions].sort((a, b) => b.meshArea - a.meshArea)) {
    const li = document.createElement("li");
    li.className = selectedNet === r.net ? "sel" : "";
    const label = document.createElement("span");
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = color(r.net);
    label.append(swatch, r.net || "(unconnected)");
    const areaEl = document.createElement("span");
    areaEl.textContent = `${r.meshArea.toFixed(1)} mm²`;
    li.append(label, areaEl);
    li.addEventListener("click", () => selectNet(selectedNet === r.net ? null : r.net));
    netsEl.appendChild(li);
  }
}

function selectNet(net: string | null): void {
  selectedNet = net;
  applySelection();
  renderNetList();
  renderInfo();
  renderSolvePanel();
}

function netPads(net: string): Array<{ id: string; x: number; y: number }> {
  const seen = new Map<string, { id: string; x: number; y: number }>();
  for (const f of pcb.footprints)
    for (const p of f.pads)
      if (p.net === net && !seen.has(`${p.ref}.${p.number}`))
        seen.set(`${p.ref}.${p.number}`, { id: `${p.ref}.${p.number}`, x: p.pos.x, y: p.pos.y });
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function renderSolvePanel(): void {
  rresEl.textContent = "";
  clearFlow();
  const pads = selectedNet ? netPads(selectedNet) : [];
  if (!selectedNet || pads.length < 2) { solveEl.hidden = true; renderPadMarkers([]); return; }
  solveEl.hidden = false;
  padASel.replaceChildren(...pads.map((p) => new Option(p.id, p.id)));
  padBSel.replaceChildren(...pads.map((p) => new Option(p.id, p.id)));
  padBSel.selectedIndex = 1;
  pickSlot = "from";
  renderPadMarkers(pads);
}

// ---- clickable pad markers (from = green, to = red) -------------------------

function renderPadMarkers(pads: Array<{ id: string; x: number; y: number }>): void {
  svg.querySelector("#padmarkers")?.remove();
  if (!pads.length) return;
  const g = document.createElementNS(SVGNS, "g");
  g.id = "padmarkers";
  for (const p of pads) {
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("cx", String(p.x));
    c.setAttribute("cy", String(p.y));
    c.setAttribute("r", "1.1");
    c.setAttribute("fill", "none");
    c.setAttribute("stroke-width", "0.25");
    c.dataset.pad = p.id;
    c.style.cursor = "pointer";
    c.addEventListener("click", (ev) => { ev.stopPropagation(); pickPad(p.id); });
    const label = document.createElementNS(SVGNS, "text");
    label.textContent = p.id;
    label.setAttribute("x", String(p.x + 1.3));
    label.setAttribute("y", String(p.y - 1.3));
    label.setAttribute("font-size", "1.1");
    label.setAttribute("fill", "#ccc");
    label.setAttribute("pointer-events", "none");
    g.append(c, label);
  }
  svg.appendChild(g);
  updatePadMarkers();
}

let pickSlot: "from" | "to" = "from";

function pickPad(id: string): void {
  // alternate: 1st click sets "from" (green), 2nd sets "to" (red), then repeat
  if (pickSlot === "from") {
    padASel.value = id;
    if (padBSel.value === id) padBSel.selectedIndex = padASel.selectedIndex === 0 ? 1 : 0;
    pickSlot = "to";
  } else {
    if (id !== padASel.value) padBSel.value = id;
    pickSlot = "from";
  }
  updatePadMarkers();
}

function updatePadMarkers(): void {
  for (const c of svg.querySelectorAll<SVGCircleElement>("#padmarkers circle")) {
    const id = c.dataset.pad!;
    const stroke = id === padASel.value ? "#2e9e44" : id === padBSel.value ? "#d33" : "#999";
    c.setAttribute("stroke", stroke);
    c.setAttribute("stroke-width", id === padASel.value || id === padBSel.value ? "0.45" : "0.25");
  }
}

padASel.addEventListener("change", updatePadMarkers);
padBSel.addEventListener("change", updatePadMarkers);

// ---- current-flow overlay (the "path" between the terminals) ----------------

function clearFlow(): void {
  svg.querySelector("#flow")?.remove();
  lastSolve = null;
  powerEl.textContent = "";
  flowLegendEl.textContent = "";
}

let lastSolve: { field: LayerField[]; resistance: number } | null = null;
// 98th-percentile overlay maxima at 1 V drive: |J| in A/mm and areal power J²·Rs in W/mm²
let overlayMax1V = { J: 0, P: 0 };

const layerRs = (layer: string): number => sheetResistance((copperThicknessMm(pcb, layer) ?? 0.035) * 1e-3);

function renderFlow(field: LayerField[], resistance: number): void {
  svg.querySelector("#flow")?.remove();
  lastSolve = { field, resistance };
  const mode = overlayModeEl.value as "J" | "P";
  const g = document.createElementNS(SVGNS, "g");
  g.id = "flow";
  g.setAttribute("pointer-events", "none");
  // robust scale: 98th percentile of the nonzero overlay quantity (heat ∝ J², so the
  // power mode squares before scaling — an honest picture of where dissipation lives)
  const valOf = (j: number, rs: number): number => (mode === "P" ? j * j * rs : j);
  const pct98 = (vals: number[]): number => {
    vals.sort((a, b) => a - b);
    return vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.98))] || 1;
  };
  overlayMax1V = {
    J: pct98(field.flatMap((f) => [...f.currentDensity].filter((j) => j > 0))),
    P: pct98(field.flatMap((f) => { const rs = layerRs(f.layer); return [...f.currentDensity].filter((j) => j > 0).map((j) => j * j * rs); })),
  };
  const vMax = mode === "P" ? overlayMax1V.P : overlayMax1V.J;
  for (const f of field) {
    const rs = layerRs(f.layer);
    for (let t = 0; t < f.triangles.length; t += 3) {
      const rel = Math.min(1, valOf(f.currentDensity[t / 3]!, rs) / vMax);
      if (rel < 0.03) continue;
      const [a, b, c] = [f.triangles[t]! * 2, f.triangles[t + 1]! * 2, f.triangles[t + 2]! * 2];
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", `M${f.vertices[a]} ${f.vertices[a + 1]}L${f.vertices[b]} ${f.vertices[b + 1]}L${f.vertices[c]} ${f.vertices[c + 1]}Z`);
      // cold→hot: yellow → red, opacity with intensity
      p.setAttribute("fill", `hsl(${60 - 60 * rel} 100% 55%)`);
      p.setAttribute("fill-opacity", String(0.15 + 0.75 * rel));
      g.appendChild(p);
    }
  }
  svg.appendChild(g);
  // keep markers on top
  const markers = svg.querySelector("#padmarkers");
  if (markers) svg.appendChild(markers);
  updatePowerUI();
}

/** P = I²R and the overlay legend in real units at the entered current (linear → scale by I, I²). */
function updatePowerUI(): void {
  if (!lastSolve) return;
  const I = Math.max(0, Number(currentAEl.value) || 0);
  const R = lastSolve.resistance;
  const s = I * R; // 1 V-drive → I amps scale factor for J
  const P = I * I * R;
  const fmtP = (w: number) => (w >= 1 ? `${w.toFixed(2)} W` : `${(w * 1000).toFixed(2)} mW`);
  powerEl.textContent = `at ${I} A: P = ${fmtP(P)} · peak ${(overlayMax1V.P * s * s * 1000).toFixed(2)} mW/mm² (98th pct)`;
  flowLegendEl.textContent =
    overlayModeEl.value === "P"
      ? `overlay: 0 → ${(overlayMax1V.P * s * s * 1000).toFixed(2)} mW/mm² (J²·Rs at ${I} A)`
      : `overlay: 0 → ${(overlayMax1V.J * s).toFixed(2)} A/mm (|J| at ${I} A)`;
}

overlayModeEl.addEventListener("change", () => { if (lastSolve) renderFlow(lastSolve.field, lastSolve.resistance); });
currentAEl.addEventListener("input", updatePowerUI);

// solved results are cached per (board, net, pad pair) — R is reciprocal and the
// |J| overlay is drive-direction-invariant, so the pair is stored unordered
const solveCache = new Map<string, { r: ReturnType<typeof solveWithErrorEstimate>; ms: number }>();

function showSolveResult(a: string, b: string, r: ReturnType<typeof solveWithErrorEstimate>, ms: number, cached: boolean): void {
  const fmt = (ohm: number) => (ohm >= 0.1 ? ohm.toFixed(3) + " Ω" : (ohm * 1000).toFixed(2) + " mΩ");
  const errPct = (100 * r.relError).toFixed(r.relError < 0.01 ? 2 : 1);
  const rLine = r.converged
    ? `R(${a} ↔ ${b}) = ${fmt(r.resistance)} ± ${errPct}%`
    : `⚠ R(${a} ↔ ${b}) ≈ ${fmt(r.resistance)} ± ${errPct}% — UNCONVERGED, refine the mesh`;
  const est = estimateResistance(pcb, selectedNet!, a, b);
  const estLine = est
    ? `M0 estimate (shortest track path, ${est.pathLengthMm.toFixed(1)} mm, ${est.viaHops} via hops): ${fmt(est.resistance)} · Δ ${(100 * (est.resistance - r.resistance) / r.resistance).toFixed(0)}%`
    : "M0 estimate: no pure track path (net uses pours/graphics)";
  rresEl.innerHTML =
    `<b>${rLine}</b>\n` +
    `${estLine}\n` +
    `layers ${r.layers.join("+")} · copper ${[...new Set(r.layers.map((l) => ((copperThicknessMm(pcb, l) ?? 0.035) * 1000).toFixed(0)))].join("/")} µm ${pcb.stackup ? "(stackup)" : "(default)"} · ${r.dofs.toLocaleString()} DOFs · ${cached ? `${ms.toFixed(0)} ms (cached)` : `${ms.toFixed(0)} ms`}\n` +
    `residual ${r.relResidual.toExponential(1)} · conservation ${r.conservationError.toExponential(1)}` +
    (r.viaCurrents?.length
      ? `\nvia share: ${r.viaCurrents.slice(0, 3).map((v) => `${(Math.abs(v.current) * r.resistance * 100).toFixed(0)}% ${v.id} ${v.fromLayer}↔${v.toLayer}`).join(", ")}${r.viaCurrents.length > 3 ? ` (+${r.viaCurrents.length - 3} more)` : ""}`
      : "") +
    (r.skippedTerminals.length ? `\n⚠ skipped terminals: ${r.skippedTerminals.join(", ")}` : "");
  if (r.field) renderFlow(r.field, r.resistance);
}

solveBtn.addEventListener("click", () => {
  if (!selectedNet) return;
  const [a, b] = [padASel.value, padBSel.value];
  if (a === b) { rresEl.textContent = "pick two different pads"; return; }
  const key = `${boardGen}|${selectedNet}|${[a, b].sort().join("↔")}`;
  const hit = solveCache.get(key);
  if (hit) {
    console.log(`[solver_rdc] solve cache hit for ${key}`);
    showSolveResult(a, b, hit.r, hit.ms, true);
    return;
  }
  rresEl.textContent = "solving…";
  setTimeout(() => {
    try {
      const t0 = performance.now();
      const r = solveWithErrorEstimate(pcb, selectedNet!, a, b, {
        maxEdgeLength: 0.8, // fine pass solves at 0.4
        refinement: ruppertReady() ? "ruppert" : "delaunay",
        returnField: true,
      });
      const ms = performance.now() - t0;
      solveCache.set(key, { r, ms });
      while (solveCache.size > 20) solveCache.delete(solveCache.keys().next().value!); // bound memory (fields are big)
      showSolveResult(a, b, r, ms, false);
    } catch (e) {
      rresEl.textContent = String(e instanceof Error ? e.message : e);
      clearFlow();
    }
  }, 10);
});

/** What the solver will actually use: per-layer copper thickness, dielectrics, totals. */
function renderStackup(): void {
  const box = document.getElementById("stackupinfo")!;
  const s = pcb.stackup;
  if (!s) {
    box.textContent = "no (setup (stackup …)) in this file — the solver assumes 35 µm (1 oz) copper on every layer and a 1.6 mm board for via-barrel lengths";
    return;
  }
  const phys = s.filter((l) => l.type === "copper" || l.type === "core" || l.type === "prepreg");
  const lines = phys.map((l) => {
    const name = l.name.padEnd(12);
    if (l.type === "copper") {
      return l.thicknessMm !== undefined
        ? `${name}${(l.thicknessMm * 1000).toFixed(0).padStart(4)} µm copper`
        : `${name}  ?? copper — 35 µm assumed`;
    }
    return `${name}${l.thicknessMm !== undefined ? l.thicknessMm.toFixed(3).padStart(6) + " mm" : "    ??"} ${l.type}${l.material ? ` ${l.material}` : ""}${l.epsilonR !== undefined ? ` · εr ${l.epsilonR}` : ""}${l.lossTangent !== undefined ? ` · tanδ ${l.lossTangent}` : ""}`;
  });
  const total = boardThicknessMm(pcb);
  if (total !== undefined) lines.push(`${"total".padEnd(12)}${total.toFixed(3).padStart(6)} mm (via-barrel lengths from the dielectric spans)`);
  box.textContent = lines.join("\n");
}

function loadBoard(text: string, name = "board"): void {
  try {
    const t0 = performance.now();
    pcb = parsePcb(text);
    console.log(`[pcb_mesh] parsed ${name} (${(text.length / 1e6).toFixed(1)} MB) in ${(performance.now() - t0).toFixed(0)} ms — ${pcb.footprints.length} footprints, ${pcb.tracks.length} tracks, ${pcb.vias.length} vias, ${pcb.zones.length} zone fills, ${pcb.nets.length} nets`);
    selectedNet = null;
    vbInitialized = false; // new board → fit view
    boardGen++; // invalidate the per-layer mesh cache
    meshCache.clear();
    renderedKey = "";
    const layers = [...new Set([...pcb.tracks.map((t) => t.layer), ...pcb.zones.map((z) => z.layer), ...pcb.footprints.flatMap((f) => f.pads.flatMap((p) => p.layers)), ...pcb.graphics.map((g) => g.layer)])]
      .filter((l) => l.endsWith(".Cu") && !l.startsWith("*") && l !== "F&B.Cu")
      .sort((a, b) => (a === "F.Cu" ? -1 : b === "F.Cu" ? 1 : a === "B.Cu" ? 1 : b === "B.Cu" ? -1 : a.localeCompare(b)));
    layerSel.replaceChildren(...layers.map((l) => new Option(l, l)), new Option("All layers", "*"));
    renderStackup();
    rebuildMesh();
  } catch (e) {
    // never fail silently — the board didn't load, say so where the user looks
    showError(`Failed to load ${name}`, e);
  }
}

layerSel.addEventListener("change", rebuildMesh);
maxEdgeSel.addEventListener("change", rebuildMesh);
refineSel.addEventListener("change", rebuildMesh);
islandsOnlyEl.addEventListener("change", applySelection);
fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  try {
    showProgress(`reading ${f.name}…`);
    loadBoard(await f.text(), f.name);
  } catch (e) {
    showError(`Failed to read ${f.name}`, e);
  }
});

// load the WASM quality mesher; fall back to cdt2d if the pkg isn't built
try {
  await initRuppert();
} catch (e) {
  console.warn("geometry_core WASM unavailable (run `wasm-pack build --release --target web` in modules/geometry_core):", e);
  (refineSel.querySelector('option[value="ruppert"]') as HTMLOptionElement).disabled = true;
  refineSel.value = "delaunay";
}
loadBoard(defaultBoard);
