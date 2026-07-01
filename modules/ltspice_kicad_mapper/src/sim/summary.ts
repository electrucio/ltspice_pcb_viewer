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

// ---- LTspice `.log` results (exact — parsed from the log, not recomputed) ------------

/** One harmonic line from a `.four` Fourier block. */
export interface FourHarmonic {
  n: number; // harmonic number (1 = fundamental)
  freq: number; // Hz
  amp: number; // Fourier component magnitude (V)
  norm: number; // normalized to the fundamental (dimensionless; dBc = 20·log10(norm))
}
/** A `.four` Fourier analysis block from the `.log` (signal at ~f₀ or mains at ~50 Hz). */
export interface FourBlock {
  f0: number; // fundamental (h1) frequency, Hz
  nPeriods?: number; // N-Period used by LTspice, if reported
  thdPct?: number; // Total Harmonic Distortion (%)
  harmonics: FourHarmonic[];
}
/** A single `.meas` result. */
export interface LogMeas {
  name: string;
  value: number;
  unit?: string; // "V" | "A" | "" (inferred from the measured expression)
}
export interface NetLog {
  four?: FourBlock; // signal `.four` (fundamental near the test tone)
  mains?: FourBlock; // 50 Hz `.four` (mains hum / ripple)
  meas?: LogMeas[]; // `.meas` results referencing V(this net)
}
export interface CompLog {
  meas?: LogMeas[]; // `.meas` results referencing I(this ref)
}

export interface NetSim {
  v: Stat;
  dc: number | null; // DC operating-point bias (from .op.raw), else null
  log?: NetLog; // exact LTspice `.log` results attached to this net (if a .log was loaded)
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
  log?: CompLog;
}

export interface SimSummary {
  window: number; // analysis window length T (s)
  nPoints: number;
  source: string; // .raw filename
  directives: string[]; // SPICE directives from the .asc
  nets: Record<string, NetSim>; // keyed by LTspice net name
  comps: Record<string, CompSim>; // keyed by LTspice component ref
  logSource?: string; // .log filename, once attached
  logGlobals?: LogMeas[]; // `.meas` results not tied to a specific net/component (PARAM etc.)
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

/** A `.four` Fourier table from the `.log`: freq · linear V · absolute dBV · dBc (re fundamental). */
function fourRows(box: HTMLElement, title: string, block: FourBlock, showThd: boolean): void {
  box.appendChild(subHeader(title));
  box.appendChild(specRow(["freq", "V", "dBV", "dBc"], true));
  for (const h of block.harmonics) {
    box.appendChild(specRow([
      formatEng(h.freq, "Hz"), formatEng(h.amp, "V"),
      dbStr(dbOf(h.amp, 1)), h.n === 1 ? "0.0" : dbStr(dbOf(h.norm, 1)),
    ]));
  }
  if (showThd && block.thdPct != null && isFinite(block.thdPct)) {
    box.appendChild(rowEl("THD", block.thdPct.toPrecision(4) + " %"));
  }
}

/** A list of `.meas` results (name = value, unit inferred from the measured expression). */
function measRows(box: HTMLElement, meas: LogMeas[]): void {
  box.appendChild(subHeader(".meas"));
  for (const m of meas) {
    const val = m.unit ? formatEng(m.value, m.unit) : String(+m.value.toPrecision(5));
    box.appendChild(rowEl(m.name, val));
  }
}

/** Render the "LTspice .log" section (exact Fourier / ripple / meas), if present. */
function logSection(box: HTMLElement, log: NetLog | CompLog): void {
  const h = subHeader("— from LTspice .log —");
  h.style.opacity = "0.75"; h.style.marginTop = "8px";
  box.appendChild(h);
  const net = log as NetLog;
  if (net.four) fourRows(box, "harmonics · .four @ " + formatEng(net.four.f0, "Hz"), net.four, true);
  if (net.mains) fourRows(box, "mains ripple · .four @ " + formatEng(net.mains.f0, "Hz"), net.mains, false);
  if (log.meas && log.meas.length) measRows(box, log.meas);
}

const hasLog = (log?: NetLog | CompLog): boolean =>
  !!log && (!!(log as NetLog).four || !!(log as NetLog).mains || !!(log.meas && log.meas.length));

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
    showNet(name, s) {
      show("net " + name, (box) => {
        statRows(box, "V", s.v, "V");
        if (s.dc != null) box.appendChild(rowEl("V DC bias", formatEng(s.dc, "V")));
        if (hasLog(s.log)) logSection(box, s.log!);
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
        if (hasLog(s.log)) logSection(box, s.log!);
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
