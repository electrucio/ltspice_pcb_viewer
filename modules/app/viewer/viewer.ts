/**
 * Read-only cross-probe viewer — the entry compiled into the downloadable single-file
 * HTML (see vite.viewer.config.ts). Reads its data from an inlined <script> block, loads
 * the three viewers, reconstructs the mapping, and wires click-to-highlight. No editing.
 */

import "./compat.js";
import "../../ltspice_schematic_viewer/src/index.js";
import "../../kicad_schematic_viewer/src/index.js";
import "../../kicad_pcb_viewer/src/index.js";

import { MappingStore } from "../../ltspice_kicad_mapper/src/mapping/store.js";
import { reconcileKicadNets, reconcileKicadComponents, type KicadNetAlias } from "../../ltspice_kicad_mapper/src/mapping/kicad-nets.js";
import type { AvailableIds } from "../../ltspice_kicad_mapper/src/mapping/store.js";
import { setupCrossProbe } from "./cross-probe.js";
import { createSidebar } from "./lists.js";
import { createSimTooltip } from "../../ltspice_kicad_mapper/src/sim/summary.js";
import type { ExportPayload } from "./payload.js";

const HIGHLIGHT = "#1a8f3c";

interface NetInfo { name: string; isPower: boolean; pins: { ref: string }[] }
interface SchCompInfo { ref: string; value: string; nets: string[]; uuid: string }
interface PcbCompInfo { ref: string; nets: string[]; symbolUuid: string }

interface SchViewer extends HTMLElement {
  registerSymbol?(name: string, asy: string): void;
  loadFromString(text: string | ArrayBuffer | Uint8Array): void;
  getNets(): NetInfo[];
  getComponents(): SchCompInfo[];
}
interface PcbViewer extends HTMLElement {
  loadFromString(text: string): void;
  getNets(): string[];
  getComponents(): PcbCompInfo[];
  fit(): void;
  toggleMirror(): void;
  rotate90(): number;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function ready(el: HTMLElement): Promise<void> {
  return new Promise((res) => el.addEventListener("ready", () => res(), { once: true }));
}

function realRefs(pins: { ref: string }[]): string[] {
  return Array.from(new Set(pins.map((p) => p.ref).filter((r) => r && r[0] !== "#")));
}

function availableIds(lt: SchViewer, ksch: SchViewer): AvailableIds {
  const ids = (v: SchViewer) => ({
    nets: new Set(v.getNets().map((n) => n.name)),
    components: new Set(v.getComponents().map((c) => c.ref)),
  });
  return { ltspice: ids(lt), kicad: ids(ksch) };
}

async function boot(): Promise<void> {
  const payload = JSON.parse(document.getElementById("lk-data")!.textContent!) as ExportPayload;

  const lt = document.getElementById("lt") as SchViewer;
  const ksch = document.getElementById("ksch") as SchViewer;
  const kpcb = document.getElementById("kpcb") as PcbViewer;
  const hasPcb = !!payload.kicadPcb;

  for (const v of [lt, ksch, kpcb] as HTMLElement[]) {
    v.style.setProperty("--ksv-highlight", HIGHLIGHT);
    v.style.setProperty("--ksv-select", HIGHLIGHT);
  }

  for (const name of Object.keys(payload.symbols)) lt.registerSymbol?.(name, payload.symbols[name]!);

  const waits: Promise<void>[] = [];
  const ltR = ready(lt); lt.loadFromString(base64ToBytes(payload.ltspice)); waits.push(ltR);
  const kR = ready(ksch); ksch.loadFromString(payload.kicadSch); waits.push(kR);
  if (hasPcb) { const r = ready(kpcb); kpcb.loadFromString(payload.kicadPcb); waits.push(r); }
  await Promise.all(waits);

  let alias: KicadNetAlias = { schToPcb: new Map(), pcbToSch: new Map() };
  let compAlias = { schToPcb: new Map<string, string>(), pcbToSch: new Map<string, string>() };
  if (hasPcb) {
    const pcbComps = kpcb.getComponents();
    // component alias by stable schematic symbol UUID
    compAlias = reconcileKicadComponents(ksch.getComponents(), pcbComps);
    // net alias — PCB ref-sets translated into schematic-ref space
    const schNets = ksch.getNets().map((n) => ({ name: n.name, refs: realRefs(n.pins) }));
    const pcbNetRefs = new Map<string, string[]>();
    for (const c of pcbComps) {
      if (c.ref[0] === "#") continue;
      const ref = compAlias.pcbToSch.get(c.ref) ?? c.ref;
      for (const net of c.nets) (pcbNetRefs.get(net) ?? pcbNetRefs.set(net, []).get(net)!).push(ref);
    }
    alias = reconcileKicadNets(schNets, kpcb.getNets(), pcbNetRefs);
  }

  const store = new MappingStore();
  store.fromFile(payload.mapping, availableIds(lt, ksch));

  const probe = setupCrossProbe({ lt: lt as never, ksch: ksch as never, kpcb: hasPcb ? (kpcb as never) : null, store, alias, compAlias });

  // read-only sidebars (nets/components lists) under each pane, clickable for cross-probe
  const ltSide = createSidebar(
    { nets: lt.getNets().map((n) => ({ id: n.name, power: n.isPower })), comps: lt.getComponents().map((c) => ({ id: c.ref, value: c.value })) },
    { counterpart: (kind, id) => store.counterpart(kind, "ltspice", id), onSelect: (kind, id) => probe.select("lt", kind, id) },
  );
  const kiSide = createSidebar(
    { nets: ksch.getNets().map((n) => ({ id: n.name, power: n.isPower })), comps: ksch.getComponents().map((c) => ({ id: c.ref, value: c.value })) },
    { counterpart: (kind, id) => store.counterpart(kind, "kicad", id), onSelect: (kind, id) => probe.select("ksch", kind, id) },
  );
  lt.closest(".pane")!.appendChild(ltSide.el);
  ksch.closest(".pane")!.appendChild(kiSide.el);
  probe.onChange((sel) => {
    ltSide.setSelected(sel ? sel.kind : null, sel?.ltId ?? null);
    kiSide.setSelected(sel ? sel.kind : null, sel?.kschId ?? null);
  });

  // KiCad schematic/PCB toggle + PCB mirror
  const bSch = document.getElementById("b-sch")!;
  const bPcb = document.getElementById("b-pcb")!;
  const bMirror = document.getElementById("b-mirror")!;
  const bRot = document.getElementById("b-rot")!;
  if (!hasPcb) { bPcb.style.display = "none"; bMirror.style.display = "none"; bRot.style.display = "none"; }
  let pcbFitted = false;
  const setView = (pcb: boolean): void => {
    ksch.classList.toggle("hidden", pcb);
    kpcb.classList.toggle("hidden", !pcb);
    bSch.classList.toggle("active", !pcb);
    bPcb.classList.toggle("active", pcb);
    bMirror.classList.toggle("hidden", !pcb); // mirror + rotate only apply to the PCB
    bRot.classList.toggle("hidden", !pcb);
    if (pcb && !pcbFitted) { kpcb.fit(); pcbFitted = true; }
  };
  bSch.addEventListener("click", () => setView(false));
  bPcb.addEventListener("click", () => setView(true));
  bMirror.addEventListener("click", () => { kpcb.toggleMirror(); bMirror.classList.toggle("active"); });
  bRot.addEventListener("click", () => { bRot.textContent = "⟳ " + kpcb.rotate90() + "°"; });

  const c = store.counts();
  document.getElementById("lt-name")!.textContent = payload.ltspiceSource;
  document.getElementById("ki-name")!.textContent = payload.kicadSource;
  document.getElementById("meta")!.textContent =
    `${c.nets} nets · ${c.components} components mapped — click to cross-probe`;

  // ---- simulation hover (read-only) ----
  const sim = payload.simulation;
  if (sim) {
    const tip = createSimTooltip(document.body);
    let mx = 0, my = 0;
    window.addEventListener("mousemove", (e) => { mx = e.clientX; my = e.clientY; tip.move(mx, my); });
    const hoverNet = (origin: "lt" | "ksch" | "kpcb", name: string | null): void => {
      if (!name) return tip.hide();
      const ltName = origin === "lt" ? name
        : origin === "kpcb" ? store.counterpart("net", "kicad", alias.pcbToSch.get(name) ?? name)
        : store.counterpart("net", "kicad", name);
      const s = ltName ? sim.nets[ltName] : undefined;
      if (s) { tip.showNet(ltName!, s); tip.move(mx, my); } else tip.hide();
    };
    const hoverComp = (origin: "lt" | "ksch", ref: string | null): void => {
      if (!ref) return tip.hide();
      const ltRef = origin === "lt" ? ref : store.counterpart("component", "kicad", ref);
      const s = ltRef ? sim.comps[ltRef] : undefined;
      if (s) { tip.showComp(ltRef!, s); tip.move(mx, my); } else tip.hide();
    };
    const netName = (e: Event): string | null => ((e as CustomEvent).detail as { name: string } | null)?.name ?? null;
    const compRef = (e: Event): string | null => ((e as CustomEvent).detail as { ref: string } | null)?.ref ?? null;
    lt.addEventListener("nethover", (e) => hoverNet("lt", netName(e)));
    lt.addEventListener("componenthover", (e) => hoverComp("lt", compRef(e)));
    ksch.addEventListener("nethover", (e) => hoverNet("ksch", netName(e)));
    ksch.addEventListener("componenthover", (e) => hoverComp("ksch", compRef(e)));
    kpcb.addEventListener("nethover", (e) => hoverNet("kpcb", netName(e)));
  }

  // ---- SPICE directives panel ----
  const dirs = sim?.directives ?? [];
  if (dirs.length) {
    const bDir = document.getElementById("b-dir")!;
    const panel = document.getElementById("dir-panel")!;
    panel.textContent = dirs.join("\n");
    bDir.classList.remove("hidden");
    bDir.addEventListener("click", () => panel.classList.toggle("show"));
  }
}

void boot();
