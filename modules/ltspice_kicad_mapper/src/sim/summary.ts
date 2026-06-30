/**
 * Shared simulation-summary model + a hover tooltip, used by the live app (via the
 * mapper) and by the downloadable read-only viewer. All ids are keyed on **LTspice**
 * names (the .raw is an LTspice output); the KiCad sides resolve through the mapping.
 *
 * DOM-free types + a small tooltip controller (plain inline styles, no external CSS and
 * no modern-only APIs — safe in old iOS Safari and inside shadow roots).
 */

export interface Stat {
  min: number;
  max: number;
  avg: number;
  rms: number;
  pp: number;
}

export interface NetSim {
  v: Stat;
  dc: number | null; // DC operating-point bias (from .op.raw), else null
  a1?: number; // fundamental amplitude
  thdPct?: number;
  thdDb?: number;
}

export interface CompSim {
  type: string; // R | C | L | D | Q | V | …
  // 2-terminal / generic:
  i?: Stat;
  vdrop?: Stat;
  pAvg?: number; // mean instantaneous power
  dcI?: number;
  dcVdrop?: number;
  dcP?: number;
  // transistor terminal currents:
  ic?: Stat;
  ib?: Stat;
  ie?: Stat;
  dcIc?: number;
  dcIb?: number;
  dcIe?: number;
  betaDc?: number;
}

export interface SimSummary {
  f0: number | null; // fundamental used for THD (Hz)
  window: number; // analysis window length T (s)
  nPoints: number;
  source: string; // .raw filename
  directives: string[]; // SPICE directives from the .asc
  nets: Record<string, NetSim>; // keyed by LTspice net name
  comps: Record<string, CompSim>; // keyed by LTspice component ref
}

const PREFIX: [number, string][] = [
  [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""],
  [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"],
];

/** Trim trailing zeros only within the fractional part: "140"→"140", "3.30"→"3.3". */
function trim(s: string): string {
  return s.indexOf(".") >= 0 ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Engineering notation, e.g. 0.038 → "38 mA", 0.2 → "200 mA". */
export function formatEng(v: number | null | undefined, unit: string): string {
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a < 1e-12) return "0 " + unit; // treat sub-pico as zero (numerical noise)
  for (const [f, p] of PREFIX) {
    if (a >= f) return trim((v / f).toPrecision(3)) + " " + p + unit;
  }
  return trim((v / 1e-12).toPrecision(3)) + " p" + unit;
}

// ---- tooltip ------------------------------------------------------------

export interface SimTooltip {
  el: HTMLElement;
  showNet(name: string, s: NetSim): void;
  showComp(ref: string, s: CompSim): void;
  move(clientX: number, clientY: number): void;
  hide(): void;
}

function rowEl(label: string, value: string): HTMLElement {
  const r = document.createElement("div");
  r.style.display = "flex";
  r.style.justifyContent = "space-between";
  r.style.gap = "14px";
  const l = document.createElement("span"); l.textContent = label; l.style.opacity = "0.7";
  const v = document.createElement("span"); v.textContent = value; v.style.fontVariantNumeric = "tabular-nums";
  r.append(l, v);
  return r;
}

function statRows(box: HTMLElement, label: string, s: Stat, unit: string): void {
  box.appendChild(rowEl(label + " avg / rms", formatEng(s.avg, unit) + " / " + formatEng(s.rms, unit)));
  box.appendChild(rowEl(label + " min … max", formatEng(s.min, unit) + " … " + formatEng(s.max, unit)));
  box.appendChild(rowEl(label + " pp", formatEng(s.pp, unit)));
}

/** Create one reusable tooltip element appended to `host` (shadow root or document body). */
export function createSimTooltip(host: HTMLElement | ShadowRoot): SimTooltip {
  const el = document.createElement("div");
  const st = el.style;
  st.position = "fixed";
  st.zIndex = "9999";
  st.pointerEvents = "none";
  st.display = "none";
  st.maxWidth = "260px";
  st.padding = "8px 10px";
  st.borderRadius = "8px";
  st.background = "rgba(17, 22, 28, 0.96)";
  st.color = "#e6e8ea";
  st.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
  st.lineHeight = "1.45";
  st.boxShadow = "0 4px 16px rgba(0,0,0,0.4)";
  host.appendChild(el);

  const titleEl = document.createElement("div");
  titleEl.style.fontWeight = "700";
  titleEl.style.marginBottom = "4px";
  const body = document.createElement("div");
  el.append(titleEl, body);

  const show = (title: string, build: (box: HTMLElement) => void): void => {
    titleEl.textContent = title;
    body.replaceChildren();
    build(body);
    st.display = "block";
  };

  return {
    el,
    showNet(name, s) {
      show("net " + name, (box) => {
        statRows(box, "V", s.v, "V");
        if (s.dc != null) box.appendChild(rowEl("V DC bias", formatEng(s.dc, "V")));
        if (s.thdPct != null) {
          box.appendChild(rowEl("THD", s.thdPct.toPrecision(3) + " % (" + (s.thdDb ?? 0).toFixed(1) + " dB)"));
        }
      });
    },
    showComp(ref, s) {
      show(ref + (s.type ? "  (" + s.type + ")" : ""), (box) => {
        if (s.i) statRows(box, "I", s.i, "A");
        if (s.vdrop) statRows(box, "Vdrop", s.vdrop, "V");
        if (s.pAvg != null) box.appendChild(rowEl("P avg", formatEng(s.pAvg, "W")));
        if (s.ic) box.appendChild(rowEl("Ic avg/rms", formatEng(s.ic.avg, "A") + " / " + formatEng(s.ic.rms, "A")));
        if (s.ib) box.appendChild(rowEl("Ib avg", formatEng(s.ib.avg, "A")));
        if (s.ie) box.appendChild(rowEl("Ie avg", formatEng(s.ie.avg, "A")));
        if (s.betaDc != null) box.appendChild(rowEl("β (DC)", s.betaDc.toPrecision(3)));
        if (s.dcI != null) box.appendChild(rowEl("I DC", formatEng(s.dcI, "A")));
        if (s.dcVdrop != null) box.appendChild(rowEl("Vdrop DC", formatEng(s.dcVdrop, "V")));
      });
    },
    move(clientX, clientY) {
      // keep within the viewport; offset from the cursor
      const w = el.offsetWidth || 200, h = el.offsetHeight || 80;
      let x = clientX + 14, y = clientY + 14;
      if (x + w > window.innerWidth) x = clientX - w - 14;
      if (y + h > window.innerHeight) y = clientY - h - 14;
      st.left = Math.max(4, x) + "px";
      st.top = Math.max(4, y) + "px";
    },
    hide() { st.display = "none"; },
  };
}
