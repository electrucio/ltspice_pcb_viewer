/// <reference types="vite/client" />
/**
 * pcb_mesh demo: parse a .kicad_pcb, extract + triangulate the copper of one layer,
 * and draw every triangle as SVG — the visual check that regions land exactly where
 * the viewer draws copper, that unions merged what touches, and that drills are holes.
 */
import defaultBoard from "../../kicad_pcb_viewer/demo/poweramp.kicad_pcb?raw";
import { wheelZoomFactor } from "../../kicad_pcb_viewer/src/interaction/controller.js";
import { parsePcb, type Pcb } from "../../kicad_pcb_viewer/src/parser/pcb.js";
import { buildBoardMesh } from "../src/build.js";
import { analyzeRegion } from "../src/verify.js";
import { initRuppert, ruppertReady } from "../src/mesh/ruppert.js";
import { solveNetResistance } from "../../solver_rdc/src/solve.js";
import { estimateResistance } from "../../solver_rdc/src/estimate.js";
import type { BoardMesh, RegionMesh } from "../src/types.js";

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

function rebuildMesh(): void {
  // let the browser paint the progress state before the (main-thread) meshing work
  statsEl.innerHTML = '<b>⏳ meshing…</b>';
  setTimeout(rebuildMeshNow, 30);
}

function rebuildMeshNow(): void {
  const maxEdge = maxEdgeSel.value ? Number(maxEdgeSel.value) : undefined;
  const refinement = refineSel.value as Refinement;
  const t0 = performance.now();
  mesh = buildBoardMesh(pcb, { layers: activeLayers(), maxEdgeLength: maxEdge, refinement, arcSegments: 24 });
  const ms = performance.now() - t0;
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
  ].filter(Boolean);
  statsEl.textContent =
    `${regions.length} net regions · ${tris.toLocaleString()} triangles\n` +
    `copper: ${area.toFixed(1)} mm²\n` +
    `area drift (mesh vs outline): ${worstDrift.toExponential(1)}\n` +
    `slivers (<20°): ${slivers.toLocaleString()} · built in ${ms.toFixed(0)} ms\n` +
    `multi-island nets on this layer: ${multiIsland.length ? multiIsland.map((r) => `${r.net || "(unconnected)"}×${r.islands}`).join(", ") : "none"}` +
    (repParts.length ? `\nsanitation: ${repParts.join(", ")}` : "");
  render();
  renderNetList();
  renderInfo();
  renderOpacitySliders();
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
  // per-layer groups so the opacity sliders act on whole layers (B.Cu at the bottom)
  const layerGroups = new Map<string, SVGGElement>();
  for (const layer of [...activeLayers()].reverse()) {
    const lg = document.createElementNS(SVGNS, "g");
    lg.dataset.meshlayer = layer;
    lg.setAttribute("opacity", String(layerOpacity.get(layer) ?? 1));
    layerGroups.set(layer, lg);
    svg.appendChild(lg);
  }
  for (const r of mesh.regions) {
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("class", "region");
    g.dataset.net = r.net;
    const active = islandsOnlyEl.checked ? r.islands > 1 : selectedNet === null || selectedNet === r.net;
    const c = color(r.net);
    for (const d of trianglePaths(r)) {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", d);
      p.setAttribute("fill", c);
      p.setAttribute("fill-opacity", active ? "0.35" : "0.05");
      p.setAttribute("stroke", c);
      p.setAttribute("stroke-opacity", active ? "0.9" : "0.1");
      g.appendChild(p);
    }
    g.addEventListener("mousemove", () => {
      hoverEl.hidden = false;
      hoverEl.textContent =
        `${r.net || "(unconnected)"} — ${r.meshArea.toFixed(2)} mm², ${r.quality.triangleCount} tris, min ∠ ${r.quality.minAngleDeg.toFixed(1)}°` +
        (r.islands > 1 ? ` — ${r.islands} islands on this layer` : "");
    });
    g.addEventListener("mouseleave", () => (hoverEl.hidden = true));
    g.addEventListener("click", () => selectNet(selectedNet === r.net ? null : r.net));
    (layerGroups.get(r.layer) ?? svg).appendChild(g);
  }
}

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
  render();
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
}

function renderFlow(field: NonNullable<ReturnType<typeof solveNetResistance>["field"]>): void {
  clearFlow();
  const g = document.createElementNS(SVGNS, "g");
  g.id = "flow";
  g.setAttribute("pointer-events", "none");
  // robust scale: 98th percentile of nonzero |J|
  const all = field.flatMap((f) => [...f.currentDensity].filter((j) => j > 0)).sort((a, b) => a - b);
  const jMax = all[Math.min(all.length - 1, Math.floor(all.length * 0.98))] || 1;
  for (const f of field) {
    for (let t = 0; t < f.triangles.length; t += 3) {
      const j = f.currentDensity[t / 3]!;
      const rel = Math.min(1, j / jMax);
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
}

solveBtn.addEventListener("click", () => {
  if (!selectedNet) return;
  const [a, b] = [padASel.value, padBSel.value];
  if (a === b) { rresEl.textContent = "pick two different pads"; return; }
  rresEl.textContent = "solving…";
  setTimeout(() => {
    try {
      const t0 = performance.now();
      const r = solveNetResistance(pcb, selectedNet!, a, b, {
        maxEdgeLength: 0.5,
        refinement: ruppertReady() ? "ruppert" : "delaunay",
        returnField: true,
      });
      const ms = performance.now() - t0;
      const fmt = (ohm: number) => (ohm >= 0.1 ? ohm.toFixed(3) + " Ω" : (ohm * 1000).toFixed(2) + " mΩ");
      const est = estimateResistance(pcb, selectedNet!, a, b);
      const estLine = est
        ? `M0 estimate (shortest track path, ${est.pathLengthMm.toFixed(1)} mm, ${est.viaHops} via hops): ${fmt(est.resistance)} · Δ ${(100 * (est.resistance - r.resistance) / r.resistance).toFixed(0)}%`
        : "M0 estimate: no pure track path (net uses pours/graphics)";
      rresEl.innerHTML =
        `<b>R(${a} ↔ ${b}) = ${fmt(r.resistance)}</b>\n` +
        `${estLine}\n` +
        `layers ${r.layers.join("+")} · ${r.dofs.toLocaleString()} DOFs · ${ms.toFixed(0)} ms\n` +
        `residual ${r.relResidual.toExponential(1)} · conservation ${r.conservationError.toExponential(1)}` +
        (r.skippedTerminals.length ? `\n⚠ skipped terminals: ${r.skippedTerminals.join(", ")}` : "");
      if (r.field) renderFlow(r.field);
    } catch (e) {
      rresEl.textContent = String(e instanceof Error ? e.message : e);
      clearFlow();
    }
  }, 10);
});

function loadBoard(text: string): void {
  try {
    pcb = parsePcb(text);
    selectedNet = null;
    vbInitialized = false; // new board → fit view
    const layers = [...new Set([...pcb.tracks.map((t) => t.layer), ...pcb.zones.map((z) => z.layer), ...pcb.footprints.flatMap((f) => f.pads.flatMap((p) => p.layers)), ...pcb.graphics.map((g) => g.layer)])]
      .filter((l) => l.endsWith(".Cu") && !l.startsWith("*") && l !== "F&B.Cu")
      .sort((a, b) => (a === "F.Cu" ? -1 : b === "F.Cu" ? 1 : a === "B.Cu" ? 1 : b === "B.Cu" ? -1 : a.localeCompare(b)));
    layerSel.replaceChildren(...layers.map((l) => new Option(l, l)), new Option("All layers", "*"));
    rebuildMesh();
  } catch (e) {
    // never fail silently — the board didn't load, say so where the user looks
    statsEl.textContent = `⚠ failed to load board: ${e instanceof Error ? e.message : e}`;
    console.error(e);
  }
}

layerSel.addEventListener("change", rebuildMesh);
maxEdgeSel.addEventListener("change", rebuildMesh);
refineSel.addEventListener("change", rebuildMesh);
islandsOnlyEl.addEventListener("change", render);
fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  if (f) loadBoard(await f.text());
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
