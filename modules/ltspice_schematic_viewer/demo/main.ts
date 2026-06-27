import "../src/index.js";
import type { LtspiceSchematicElement, NetInfo, ComponentInfo } from "../src/index.js";

const sch = document.getElementById("sch") as LtspiceSchematicElement;
const list = document.getElementById("list")!;
const status = document.getElementById("status")!;
const q = document.getElementById("q") as HTMLInputElement;

let tab: "nets" | "comps" = "nets";
let nets: NetInfo[] = [];
let comps: ComponentInfo[] = [];
let selected: string | null = null;

async function boot(): Promise<void> {
  // register the project's custom potentiometer symbols before loading
  for (const name of ["lin_pot", "log_pot", "revlog_pot"]) {
    try {
      const asy = await fetch(`./${name}.asy`).then((r) => (r.ok ? r.text() : ""));
      if (asy) sch.registerSymbol(name, asy);
    } catch { /* optional */ }
  }
  await sch.loadFromUrl("./AudioAmpCompl-40W.asc");
}

function render(): void {
  const term = q.value.trim().toLowerCase();
  list.replaceChildren();
  if (tab === "nets") {
    for (const n of nets.filter((n) => n.name.toLowerCase().includes(term)).sort((a, b) => b.pins.length - a.pins.length)) {
      list.appendChild(row(n.name, `${n.pins.length} pins`, n.isPower, `net:${n.name}`));
    }
  } else {
    for (const c of comps.filter((c) => c.ref.toLowerCase().includes(term) || c.value.toLowerCase().includes(term)).sort((a, b) => a.ref.localeCompare(b.ref, undefined, { numeric: true }))) {
      list.appendChild(row(c.ref, c.value, false, `comp:${c.ref}`));
    }
  }
  list.querySelector(".row.sel")?.scrollIntoView({ block: "nearest" });
}

function row(name: string, meta: string, power: boolean, id: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "row" + (selected === id ? " sel" : "");
  el.innerHTML = `<span class="name ${power ? "pow" : ""}">${name}</span><span class="meta">${meta}</span>`;
  el.onclick = () => {
    selected = id;
    if (id.startsWith("net:")) { const nm = id.slice(4); sch.highlightNet(nm); sch.zoomToNet(nm); setStatus(`net <b>${nm}</b>`); }
    else { const ref = id.slice(5); sch.highlightComponent(ref); setStatus(`component <b>${ref}</b>`); }
    render();
  };
  return el;
}

function setStatus(html: string): void { status.innerHTML = html; }
function setTab(name: "nets" | "comps"): void {
  tab = name;
  for (const b of document.querySelectorAll<HTMLElement>(".tabs button")) b.classList.remove("active");
  document.getElementById(name === "nets" ? "tab-nets" : "tab-comps")!.classList.add("active");
}

sch.addEventListener("ready", () => {
  nets = sch.getNets();
  comps = sch.getComponents();
  setStatus(`<b>${nets.length}</b> nets · <b>${comps.length}</b> components — drag to pan, scroll to zoom`);
  render();
});
sch.addEventListener("netselect", (e: Event) => {
  const d = (e as CustomEvent).detail as NetInfo | null;
  selected = d ? `net:${d.name}` : null;
  setStatus(d ? `net <b>${d.name}</b> (${d.pins.length} pins)` : "cleared");
  if (d) setTab("nets");
  render();
});
sch.addEventListener("componentselect", (e: Event) => {
  const d = (e as CustomEvent).detail as ComponentInfo | null;
  if (d) { selected = `comp:${d.ref}`; setStatus(`component <b>${d.ref}</b> — ${d.value}`); setTab("comps"); render(); }
});

document.getElementById("tab-nets")!.onclick = () => { setTab("nets"); render(); };
document.getElementById("tab-comps")!.onclick = () => { setTab("comps"); render(); };
q.oninput = render;
document.getElementById("fit")!.onclick = () => sch.fit();
document.getElementById("clear")!.onclick = () => { sch.clearHighlights(); selected = null; render(); };
document.getElementById("theme")!.onclick = () => sch.setAttribute("theme", sch.getAttribute("theme") === "dark" ? "light" : "dark");

void boot();
