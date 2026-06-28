import "../src/index.js";
import type { KicadPcbElement, PcbComponentInfo } from "../src/index.js";
// Default board inlined at build time so the demo is self-contained (no runtime
// fetch, works as a single static .html). Override which board is baked in with
//   BOARD=/path/to/your.kicad_pcb npm run build:demo
import { text as defaultPcb, name as defaultName } from "virtual:default-board";

const pcb = document.getElementById("pcb") as KicadPcbElement;
const layersEl = document.getElementById("layers")!;
const listEl = document.getElementById("list")!;
const statusEl = document.getElementById("status")!;
const q = document.getElementById("q") as HTMLInputElement;

const LAYER_LABELS: Record<string, string> = {
  "B.Cu": "Bottom copper", "F.Cu": "Top copper", pads: "Pads", vias: "Vias",
  "B.SilkS": "Bottom silk", "F.SilkS": "Top silk", "Edge.Cuts": "Board outline", refs: "References",
};

let tab: "nets" | "comps" = "nets";
let nets: string[] = [];
let comps: PcbComponentInfo[] = [];
let selected: string | null = null;

function setStatus(html: string): void { statusEl.innerHTML = html; }

pcb.addEventListener("ready", () => {
  nets = pcb.getNets();
  comps = pcb.getComponents();
  setStatus(`<b>${nets.length}</b> nets · <b>${comps.length}</b> parts — drag to pan, scroll to zoom`);
  // layer checkboxes
  layersEl.replaceChildren();
  for (const id of pcb.getLayers()) {
    const lbl = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox"; cb.checked = true;
    cb.onchange = () => pcb.setLayer(id, cb.checked);
    lbl.append(cb, document.createTextNode(LAYER_LABELS[id] ?? id));
    layersEl.appendChild(lbl);
  }
  render();
});
pcb.addEventListener("netselect", (e) => {
  const d = (e as CustomEvent).detail as { name: string } | null;
  selected = d ? `net:${d.name}` : null;
  setStatus(d ? `net <b>${d.name}</b>` : "cleared");
  render();
});
pcb.addEventListener("componentselect", (e) => {
  const d = (e as CustomEvent).detail as PcbComponentInfo | null;
  if (d) { selected = `comp:${d.ref}`; setStatus(`part <b>${d.ref}</b> — ${d.value}`); tab = "comps"; syncTabs(); render(); }
});

function render(): void {
  const term = q.value.trim().toLowerCase();
  listEl.replaceChildren();
  if (tab === "nets") {
    for (const n of nets.filter((n) => n.toLowerCase().includes(term))) listEl.appendChild(row(n, "", `net:${n}`));
  } else {
    for (const c of comps.filter((c) => c.ref.toLowerCase().includes(term) || c.value.toLowerCase().includes(term)).sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true })))
      listEl.appendChild(row(c.ref, c.value, `comp:${c.ref}`));
  }
}
function row(name: string, meta: string, id: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "row" + (selected === id ? " sel" : "");
  el.innerHTML = `<span>${name}</span><span class="meta">${meta}</span>`;
  el.onclick = () => {
    selected = id;
    if (id.startsWith("net:")) { pcb.highlightNet(id.slice(4)); setStatus(`net <b>${id.slice(4)}</b>`); }
    else { pcb.highlightComponent(id.slice(5)); setStatus(`part <b>${id.slice(5)}</b>`); }
    render();
  };
  return el;
}
function syncTabs(): void {
  document.getElementById("tab-nets")!.classList.toggle("active", tab === "nets");
  document.getElementById("tab-comps")!.classList.toggle("active", tab === "comps");
}
document.getElementById("tab-nets")!.onclick = () => { tab = "nets"; syncTabs(); render(); };
document.getElementById("tab-comps")!.onclick = () => { tab = "comps"; syncTabs(); render(); };
q.oninput = render;
document.getElementById("fit")!.onclick = () => pcb.fit();
document.getElementById("mirror")!.onclick = () => pcb.toggleMirror();
document.getElementById("clear")!.onclick = () => { pcb.clearHighlights(); selected = null; render(); };

// open any .kicad_pcb for testing
const fileInput = document.getElementById("open") as HTMLInputElement;
fileInput.onchange = async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  selected = null;
  document.getElementById("fname")!.textContent = f.name;
  setStatus(`loading <b>${f.name}</b>…`);
  try {
    pcb.loadFromString(await f.text()); // fires "ready" -> rebuilds layers + lists
  } catch (e) {
    setStatus(`failed to load: ${(e as Error).message}`);
  }
  fileInput.value = "";
};

// load the inlined default board
document.getElementById("fname")!.textContent = defaultName;
pcb.loadFromString(defaultPcb);
