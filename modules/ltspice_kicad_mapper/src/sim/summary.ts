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

/** Mains-hum analysis base frequency (Hz) and harmonic count — single source of truth,
 *  imported by the summary builder so the computed bins and the tooltip labels agree. */
export const MAINS_F0 = 50;
export const MAINS_N = 5;
/** Number of signal harmonics (k·f₀) listed in the spectrum. */
export const HARM_N = 10;

export interface NetSim {
  v: Stat;
  dc: number | null; // DC operating-point bias (from .op.raw), else null
  a1?: number; // fundamental amplitude
  thdPct?: number;
  thdDb?: number;
  /** Peak amplitudes (V) at k·f₀ for k=1..HARM_N (index 0 = fundamental); set only when f₀ known. */
  harm?: number[];
  /** Peak amplitudes (V) at m·MAINS_F0 for m=1..MAINS_N (mains hum/ripple); always set. */
  mains?: number[];
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
  mainsF0?: number; // mains-hum base frequency (Hz) used for the hum spectrum
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
  /** `f0` (Hz) labels the signal harmonics with their absolute frequencies (k·f₀);
   *  `mainsF0` (Hz) labels the ripple spectrum (defaults to MAINS_F0). */
  showNet(name: string, s: NetSim, ctx?: { f0?: number | null; mainsF0?: number }): void;
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

function subHeader(text: string): HTMLElement {
  const h = document.createElement("div");
  h.textContent = text;
  h.style.margin = "6px 0 1px";
  h.style.fontSize = "9px";
  h.style.letterSpacing = "0.04em";
  h.style.textTransform = "uppercase";
  h.style.opacity = "0.55";
  return h;
}

const dbStr = (db: number): string => (isFinite(db) ? (db >= 0 ? "+" : "") + db.toFixed(1) : "–");
/** dBV / dBc reference floor: treat sub-atto amplitudes as silence to avoid −∞ noise. */
const dbOf = (amp: number, ref: number): number => 20 * Math.log10(Math.max(amp, 1e-18) / ref);

const COLS = ["46px", "60px", "56px", "52px"]; // freq · V · dBV · dBc

/** One spectral line as four columns: freq · linear V · absolute dBV · dBc (re f₀). */
function specRow(cells: [string, string, string, string], header = false): HTMLElement {
  const r = document.createElement("div");
  r.style.display = "flex"; r.style.gap = "7px"; r.style.fontSize = "10px"; r.style.lineHeight = "1.5";
  if (header) r.style.opacity = "0.45";
  cells.forEach((text, i) => {
    const s = document.createElement("span");
    s.textContent = text;
    s.style.flex = "0 0 auto"; s.style.width = COLS[i]!; s.style.whiteSpace = "nowrap";
    s.style.textAlign = i === 0 ? "left" : "right";
    if (i === 0 && !header) s.style.opacity = "0.7";
    if (i > 0) s.style.fontVariantNumeric = "tabular-nums";
    r.appendChild(s);
  });
  return r;
}

/** Signal-harmonic spectrum at k·f₀ — linear V, absolute dBV, and dBc (re fundamental). */
function harmonicRows(box: HTMLElement, harm: number[], f0: number | null): void {
  const a1 = harm[0] ?? 0;
  if (!(a1 > 0)) return;
  box.appendChild(subHeader("signal harmonics"));
  box.appendChild(specRow(["freq", "V", "dBV", "dBc"], true));
  for (let k = 0; k < harm.length; k++) {
    const amp = harm[k]!;
    const freq = f0 ? formatEng((k + 1) * f0, "Hz") : "h" + (k + 1);
    box.appendChild(specRow([freq, formatEng(amp, "V"), dbStr(dbOf(amp, 1)), k === 0 ? "0.0" : dbStr(dbOf(amp, a1))]));
  }
}

/** Mains-hum spectrum at m·baseF — linear V, absolute dBV, and dBc (re the net's f₀ fundamental). */
function mainsRows(box: HTMLElement, mains: number[], baseF: number, a1: number): void {
  box.appendChild(subHeader("mains hum · ×" + baseF + " Hz"));
  box.appendChild(specRow(["freq", "V", "dBV", "dBc"], true));
  for (let m = 0; m < mains.length; m++) {
    const amp = mains[m]!;
    box.appendChild(specRow([
      formatEng((m + 1) * baseF, "Hz"), formatEng(amp, "V"),
      dbStr(dbOf(amp, 1)), a1 > 0 ? dbStr(dbOf(amp, a1)) : "–",
    ]));
  }
}

/** Create one reusable tooltip element appended to `host` (shadow root or document body). */
export function createSimTooltip(host: HTMLElement | ShadowRoot): SimTooltip {
  const el = document.createElement("div");
  const st = el.style;
  st.position = "fixed";
  st.zIndex = "9999";
  st.pointerEvents = "none";
  st.display = "none";
  st.maxWidth = "340px";
  st.padding = "8px 10px";
  st.borderRadius = "8px";
  st.background = "rgba(17, 22, 28, 0.96)";
  st.color = "#e6e8ea";
  st.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  st.lineHeight = "1.4";
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
    showNet(name, s, ctx) {
      show("net " + name, (box) => {
        statRows(box, "V", s.v, "V");
        if (s.dc != null) box.appendChild(rowEl("V DC bias", formatEng(s.dc, "V")));
        if (s.thdPct != null && isFinite(s.thdPct)) {
          box.appendChild(rowEl("THD", s.thdPct.toPrecision(3) + " % (" + (s.thdDb ?? 0).toFixed(1) + " dB)"));
        }
        if (s.harm && s.harm.length) harmonicRows(box, s.harm, ctx?.f0 ?? null);
        if (s.mains && s.mains.length) mainsRows(box, s.mains, ctx?.mainsF0 ?? MAINS_F0, s.harm?.[0] ?? s.a1 ?? 0);
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
