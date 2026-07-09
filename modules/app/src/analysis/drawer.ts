/**
 * The ⚡ Analysis drawer: PCB analysis composed AROUND the mapper, not inside it.
 * Listens to the `netselect`/`ready` events that bubble (composed) out of the
 * mapper's <kicad-pcb>, reads the parsed board via pcbElement.getPcb(), and calls
 * the same tested library functions the pcb_mesh demo uses. The FEM solve runs in
 * a Web Worker (solve.worker.ts) so ground-pour solves never freeze the UI.
 *
 * Formatting mirrors the demo's (thin presentation over tested libraries) — kept
 * separate on purpose so the demo stays standalone.
 */

import type { Pcb } from "../../../kicad_pcb_viewer/src/parser/pcb.js";
import { copperThicknessMm, boardThicknessMm } from "../../../kicad_pcb_viewer/src/parser/pcb.js";
import { sheetResistance } from "../../../analytic_models/src/index.js";
import { analyzeNetRlgc, analyzePathRlgc } from "../../../solver_rdc/src/rlgc.js";
import type { SolveSuccess } from "./solve-core.js";
import type { WorkerReply } from "./solve.worker.js";
import { drawFieldOverlay, clearFieldOverlay, drawPadMarkers, updatePadMarkers, type OverlayMode, type PadMarker } from "./overlay.js";

/** the viewer surface the drawer needs (structural — the mapper returns the real element) */
interface PcbEl extends HTMLElement {
  getPcb(): Pcb | null;
  overlayGroup(): SVGGElement | null;
  clearOverlay(): void;
  highlightNet(name: string): void;
}
interface MapperEl extends HTMLElement {
  pcbElement: PcbEl | null;
}

const fmtOhm = (ohm: number): string => (ohm >= 0.1 ? `${ohm.toFixed(3)} Ω` : `${(ohm * 1000).toFixed(2)} mΩ`);

export function initAnalysis(mapper: MapperEl, aside: HTMLElement): void {
  aside.innerHTML = `
    <h2>⚡ PCB analysis</h2>
    <div class="net-line">
      net <select id="an-net"><option value="">— click a net on the PCB —</option></select>
      <div id="an-nethint" class="hint"></div>
    </div>
    <details id="an-p2p" open>
      <summary>Pad-to-pad</summary>
      <label>from <select id="an-padA"></select> to <select id="an-padB"></select></label>
      <div id="an-profile" class="out mono"></div>
      <label><button id="an-solve">Solve R (FEM)</button>
        <button id="an-cancel" hidden>Cancel</button>
        <span id="an-status" class="hint"></span></label>
      <div id="an-rres" class="out"></div>
      <label>current (A) <input id="an-current" type="number" value="1" min="0" step="0.1" style="width:64px" />
        overlay <select id="an-overlaymode">
          <option value="off">off</option>
          <option value="J" selected>|J|</option>
          <option value="P">J²·Rs</option>
        </select></label>
    </details>
    <details id="an-tl">
      <summary>Transmission line (whole net)</summary>
      <label>reference nets (planes — pick the pours)
        <select id="an-refnets" multiple size="4"></select></label>
      <label>f (GHz) <input id="an-freq" type="number" value="1" min="0.01" step="0.5" style="width:64px" /></label>
      <div id="an-tlout" class="out"></div>
    </details>
    <details id="an-stackup">
      <summary>Stackup (used by the solver)</summary>
      <div id="an-stackupout" class="out mono"></div>
    </details>
  `;
  const $ = <T extends HTMLElement>(id: string): T => aside.querySelector<T>(`#${id}`)!;
  const netSel = $<HTMLSelectElement>("an-net");
  const netHint = $("an-nethint");
  const padASel = $<HTMLSelectElement>("an-padA");
  const padBSel = $<HTMLSelectElement>("an-padB");
  const profileEl = $("an-profile");
  const solveBtn = $<HTMLButtonElement>("an-solve");
  const cancelBtn = $<HTMLButtonElement>("an-cancel");
  const statusEl = $("an-status");
  const rresEl = $("an-rres");
  const currentEl = $<HTMLInputElement>("an-current");
  const overlayModeSel = $<HTMLSelectElement>("an-overlaymode");
  const refNetsSel = $<HTMLSelectElement>("an-refnets");
  const freqEl = $<HTMLInputElement>("an-freq");
  const tlOutEl = $("an-tlout");
  const stackupOutEl = $("an-stackupout");

  // ---- state -----------------------------------------------------------------
  let pcb: Pcb | null = null;
  let boardGen = 0;
  let selNet: string | null = null;
  let pickSlot: "from" | "to" = "from";
  let chosenRefNets = new Set<string>();
  const solveCache = new Map<string, SolveSuccess>();
  let lastSolve: SolveSuccess | null = null;
  let worker: Worker | null = null;
  let solveSeq = 0;
  let busyId: number | null = null;

  const pcbEl = (): PcbEl | null => mapper.pcbElement;
  const rsOfLayer = (layer: string): number => sheetResistance((copperThicknessMm(pcb!, layer) ?? 0.035) * 1e-3);

  // ---- board / net wiring ------------------------------------------------------
  function refreshBoard(): void {
    pcb = pcbEl()?.getPcb() ?? null;
    boardGen++;
    solveCache.clear();
    lastSolve = null;
    chosenRefNets.clear();
    setNet(null);
    // routed nets only (analysis needs tracks)
    const routed = pcb ? [...new Set(pcb.tracks.map((t) => t.net).filter(Boolean))].sort() : [];
    netSel.replaceChildren(new Option("— click a net on the PCB —", ""), ...routed.map((n) => new Option(n, n)));
    renderStackup();
  }

  function setNet(net: string | null): void {
    selNet = net;
    netSel.value = net ?? "";
    netHint.textContent = net ? "" : "click a net on the PCB, or pick one above";
    rresEl.textContent = "";
    statusEl.textContent = "";
    lastSolve = null;
    pcbEl()?.clearOverlay();
    const pads = net && pcb ? netPads(net) : [];
    const opts = pads.map((p) => new Option(p.id, p.id));
    padASel.replaceChildren(...opts.map((o) => o.cloneNode(true) as HTMLOptionElement));
    padBSel.replaceChildren(...opts);
    if (pads.length > 1) padBSel.selectedIndex = 1;
    pickSlot = "from";
    renderRefNets();
    renderMarkers();
    renderProfile();
    renderTl();
  }

  function netPads(net: string): PadMarker[] {
    const seen = new Map<string, PadMarker>();
    for (const f of pcb!.footprints)
      for (const p of f.pads)
        if (p.net === net && !seen.has(`${p.ref}.${p.number}`))
          seen.set(`${p.ref}.${p.number}`, { id: `${p.ref}.${p.number}`, x: p.pos.x, y: p.pos.y });
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  // net selection: follow PCB clicks (composed events bubble out of the mapper)
  document.addEventListener("netselect", (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName !== "KICAD-PCB" || aside.hidden) return;
    const name = (e as CustomEvent<{ name: string } | null>).detail?.name ?? null;
    if (name !== selNet) setNet(name);
  });
  document.addEventListener("ready", (e) => {
    if ((e.target as HTMLElement).tagName === "KICAD-PCB") refreshBoard();
  });
  netSel.addEventListener("change", () => {
    setNet(netSel.value || null);
    if (netSel.value) pcbEl()?.highlightNet(netSel.value);
  });

  // ---- stackup -----------------------------------------------------------------
  function renderStackup(): void {
    if (!pcb) { stackupOutEl.textContent = "no board loaded"; return; }
    const s = pcb.stackup;
    if (!s) {
      stackupOutEl.textContent = "no stackup in this file — solver assumes 35 µm copper and a 1.6 mm board";
      return;
    }
    const phys = s.filter((l) => l.type === "copper" || l.type === "core" || l.type === "prepreg");
    const lines = phys.map((l) => {
      const name = l.name.padEnd(12);
      if (l.type === "copper") {
        return l.thicknessMm !== undefined ? `${name}${(l.thicknessMm * 1000).toFixed(0).padStart(4)} µm copper` : `${name}  ?? copper — 35 µm assumed`;
      }
      return `${name}${l.thicknessMm !== undefined ? l.thicknessMm.toFixed(3).padStart(6) + " mm" : "    ??"} ${l.type}${l.epsilonR !== undefined ? ` · εr ${l.epsilonR}` : ""}${l.lossTangent !== undefined ? ` · tanδ ${l.lossTangent}` : ""}`;
    });
    const total = boardThicknessMm(pcb);
    if (total !== undefined) lines.push(`${"total".padEnd(12)}${total.toFixed(3).padStart(6)} mm`);
    stackupOutEl.textContent = lines.join("\n");
  }

  // ---- pad markers + overlay -----------------------------------------------------
  function renderMarkers(): void {
    const group = pcbEl()?.overlayGroup();
    if (!group) return;
    if (!selNet || aside.hidden) { pcbEl()!.clearOverlay(); return; }
    drawPadMarkers(group, netPads(selNet), () => ({ from: padASel.value, to: padBSel.value }), (id) => {
      if (pickSlot === "from") {
        padASel.value = id;
        if (padBSel.value === id) padBSel.selectedIndex = padASel.selectedIndex === 0 ? 1 : 0;
        pickSlot = "to";
      } else {
        if (id !== padASel.value) padBSel.value = id;
        pickSlot = "from";
      }
      updatePadMarkers(group, { from: padASel.value, to: padBSel.value });
      renderProfile();
    });
  }

  function renderOverlay(): void {
    const group = pcbEl()?.overlayGroup();
    if (!group) return;
    const mode = overlayModeSel.value;
    if (mode === "off" || !lastSolve?.field || !pcb) { clearFieldOverlay(group); return; }
    drawFieldOverlay(group, lastSolve.field, mode as OverlayMode, rsOfLayer);
  }

  // ---- transmission line ---------------------------------------------------------
  function renderRefNets(): void {
    if (!pcb || !selNet) { refNetsSel.replaceChildren(); return; }
    const areas = new Map<string, number>();
    for (const z of pcb.zones) {
      if (!z.net || z.net === selNet || z.pts.length < 3) continue;
      let a = 0;
      for (let i = 0, j = z.pts.length - 1; i < z.pts.length; j = i++) a += z.pts[j]!.x * z.pts[i]!.y - z.pts[i]!.x * z.pts[j]!.y;
      areas.set(z.net, (areas.get(z.net) ?? 0) + Math.abs(a / 2));
    }
    const cands = [...areas.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
    refNetsSel.replaceChildren(
      ...cands.map(([n, a]) => {
        const o = new Option(`${n} (${a.toFixed(0)} mm² pour)`, n);
        o.selected = chosenRefNets.has(n);
        return o;
      }),
    );
  }

  const freqHz = (): number => Math.max(0.01, Number(freqEl.value) || 1) * 1e9;

  function renderTl(): void {
    if (!pcb || !selNet) { tlOutEl.textContent = ""; tlOutEl.className = "out hint"; tlOutEl.textContent = selNet ? "" : "select a net first"; return; }
    tlOutEl.className = "out";
    chosenRefNets = new Set([...refNetsSel.selectedOptions].map((o) => o.value));
    const r = analyzeNetRlgc(pcb, selNet, { referenceNets: [...chosenRefNets], frequencyHz: freqHz() });
    const groups = new Map<string, { lengthMm: number; z0Min: number; z0Max: number; alpha: number }>();
    const assumed = new Set<string>();
    const reasons = new Set<string>();
    for (const s of r.segments) {
      s.assumed.forEach((a) => assumed.add(a));
      if (s.kind === "unmodeled") { if (s.reason) reasons.add(s.reason); continue; }
      const key = `${s.layer} ${s.kind} w=${s.widthMm.toFixed(2)}`;
      const g = groups.get(key) ?? { lengthMm: 0, z0Min: Infinity, z0Max: -Infinity, alpha: 0 };
      g.lengthMm += s.lengthMm;
      g.z0Min = Math.min(g.z0Min, s.z0!);
      g.z0Max = Math.max(g.z0Max, s.z0!);
      g.alpha = s.alphaDbPerM!;
      groups.set(key, g);
    }
    const lines: string[] = [];
    for (const [key, g] of [...groups.entries()].sort((a, b) => b[1].lengthMm - a[1].lengthMm)) {
      const z = g.z0Min === g.z0Max ? `${g.z0Min.toFixed(1)} Ω` : `${g.z0Min.toFixed(1)}–${g.z0Max.toFixed(1)} Ω`;
      lines.push(`${key} mm: ${g.lengthMm.toFixed(1)} mm · Z0 ${z} · ${g.alpha.toFixed(2)} dB/m`);
    }
    const t = r.totals;
    if (t.modeledLengthMm > 0) {
      lines.push(
        `total ${t.modeledLengthMm.toFixed(1)}/${t.lengthMm.toFixed(1)} mm modeled · delay ${(t.delayS * 1e12).toFixed(0)} ps` +
        (t.z0Min !== undefined && t.z0Max! - t.z0Min > 5 ? ` · ⚠ Z0 spans ${t.z0Min.toFixed(0)}–${t.z0Max!.toFixed(0)} Ω` : ""),
      );
    }
    if (t.kinds["unmodeled"]) lines.push(`⚠ ${t.kinds["unmodeled"].toFixed(1)} mm unmodeled: ${[...reasons].join("; ")}`);
    for (const a of assumed) lines.push(`· ${a}`);
    tlOutEl.textContent = lines.join("\n") || "no track segments on this net";
    renderProfile();
  }

  // ---- pad-to-pad profile -----------------------------------------------------------
  function renderProfile(): void {
    if (!pcb || !selNet) { profileEl.textContent = ""; return; }
    const [a, b] = [padASel.value, padBSel.value];
    if (!a || !b || a === b) { profileEl.textContent = "pick two different pads"; return; }
    const r = analyzePathRlgc(pcb, selNet, a, b, { referenceNets: [...chosenRefNets], frequencyHz: freqHz() });
    if (!r) { profileEl.textContent = "no pure track path between these pads (connection runs through pours)"; return; }
    type Row = { atMm: number; lengthMm: number; label: string };
    const rows: Row[] = [];
    let last: { key: string; row: Row } | null = null;
    for (const s of r.steps) {
      if (s.type === "via") {
        rows.push({ atMm: s.atMm, lengthMm: 0, label: `${s.padBarrel ? "pad barrel" : "via"} ${s.fromLayer}→${s.toLayer}` });
        last = null;
        continue;
      }
      const key = s.kind === "unmodeled" ? `u|${s.layer}|${s.reason}` : `${s.layer}|${s.kind}|${s.widthMm.toFixed(3)}|${s.z0!.toFixed(1)}`;
      if (last && last.key === key) { last.row.lengthMm += s.lengthMm; continue; }
      const label = s.kind === "unmodeled"
        ? `${s.layer} — unmodeled (${s.reason ?? "?"})`
        : `${s.layer} ${s.kind} w${s.widthMm.toFixed(2)}  Z0 ${s.z0!.toFixed(1)} Ω`;
      const row = { atMm: s.atMm, lengthMm: s.lengthMm, label };
      rows.push(row);
      last = { key, row };
    }
    const lines = rows.map((r2) => `${r2.atMm.toFixed(1).padStart(6)} mm  ${r2.label}${r2.lengthMm > 0 ? ` × ${r2.lengthMm.toFixed(1)} mm` : ""}`);
    const t = r.totals;
    lines.push(
      `path ${t.lengthMm.toFixed(1)} mm (${t.modeledLengthMm.toFixed(1)} modeled) · delay ${(t.delayS * 1e12).toFixed(0)} ps · ` +
      `${t.viaCount} via${t.viaCount === 1 ? "" : "s"}` +
      (t.z0Min !== undefined ? ` · Z0 ${t.z0Min.toFixed(0)}–${t.z0Max!.toFixed(0)} Ω` : ""),
    );
    for (const st of r.stubs) lines.push(`⚠ stub ${st.lengthMm.toFixed(1)} mm hanging at ${st.atMm.toFixed(1)} mm`);
    profileEl.textContent = lines.join("\n");
  }

  // ---- FEM solve (worker) --------------------------------------------------------------
  function ensureWorker(): Worker {
    if (!worker) {
      worker = new Worker(new URL("./solve.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (e: MessageEvent<WorkerReply>) => {
        const msg = e.data;
        if (msg.id !== busyId) return; // stale
        if (msg.kind === "progress") { statusEl.textContent = `⏳ ${msg.stage}…`; return; }
        busyId = null;
        solveBtn.disabled = false;
        cancelBtn.hidden = true;
        if (msg.kind === "error") {
          statusEl.textContent = "";
          rresEl.innerHTML = `<span class="err">${msg.message}</span>`;
          return;
        }
        statusEl.textContent = "";
        solveCache.set(solveKey(), msg);
        lastSolve = msg;
        showSolve(msg, false);
      };
    }
    return worker;
  }

  const solveKey = (): string => `${boardGen}|${selNet}|${[padASel.value, padBSel.value].sort().join("↔")}`;

  function showSolve(r: SolveSuccess, cached: boolean): void {
    const errPct = (100 * r.relError).toFixed(r.relError < 0.01 ? 2 : 1);
    const rLine = r.converged
      ? `<b>R = ${fmtOhm(r.resistance)} ± ${errPct}%</b>`
      : `<b class="warn">R ≈ ${fmtOhm(r.resistance)} ± ${errPct}% — UNCONVERGED</b>`;
    const I = Math.max(0, Number(currentEl.value) || 0);
    const P = I * I * r.resistance;
    const est = r.estimate
      ? `M0 estimate: ${fmtOhm(r.estimate.resistance)} (${r.estimate.pathLengthMm.toFixed(1)} mm, ${r.estimate.viaHops} vias)`
      : "M0 estimate: no pure track path";
    const vias = r.viaCurrents?.length
      ? `via share: ${r.viaCurrents.slice(0, 3).map((v) => `${(Math.abs(v.current) * r.resistance * 100).toFixed(0)}% ${v.id}`).join(", ")}${r.viaCurrents.length > 3 ? ` (+${r.viaCurrents.length - 3})` : ""}`
      : "";
    rresEl.innerHTML = [
      rLine,
      est,
      `layers ${r.layers.join("+")} · ${r.dofs.toLocaleString()} DOFs · ${r.ms.toFixed(0)} ms${cached ? " (cached)" : ""}`,
      `at ${I} A: P = ${P >= 1 ? `${P.toFixed(2)} W` : `${(P * 1000).toFixed(2)} mW`}`,
      vias,
    ].filter(Boolean).join("\n");
    renderOverlay();
  }

  solveBtn.addEventListener("click", () => {
    if (!pcb || !selNet) return;
    const [a, b] = [padASel.value, padBSel.value];
    if (!a || !b || a === b) { rresEl.textContent = "pick two different pads"; return; }
    const hit = solveCache.get(solveKey());
    if (hit) { lastSolve = hit; showSolve(hit, true); return; }
    const id = ++solveSeq;
    busyId = id;
    solveBtn.disabled = true;
    cancelBtn.hidden = false;
    rresEl.textContent = "";
    statusEl.textContent = "⏳ starting…";
    ensureWorker().postMessage({
      id,
      pcbText: (mapper as unknown as { getSources(): { kicadPcb: string } }).getSources().kicadPcb,
      net: selNet,
      padA: a,
      padB: b,
      maxEdgeLength: 0.8,
      wantField: true,
    });
  });

  cancelBtn.addEventListener("click", () => {
    worker?.terminate();
    worker = null;
    busyId = null;
    solveBtn.disabled = false;
    cancelBtn.hidden = true;
    statusEl.textContent = "cancelled";
  });

  padASel.addEventListener("change", () => { renderProfile(); const g = pcbEl()?.overlayGroup(); if (g) updatePadMarkers(g, { from: padASel.value, to: padBSel.value }); });
  padBSel.addEventListener("change", () => { renderProfile(); const g = pcbEl()?.overlayGroup(); if (g) updatePadMarkers(g, { from: padASel.value, to: padBSel.value }); });
  refNetsSel.addEventListener("change", renderTl);
  freqEl.addEventListener("change", renderTl);
  currentEl.addEventListener("input", () => { if (lastSolve) showSolve(lastSolve, true); });
  overlayModeSel.addEventListener("change", renderOverlay);

  // drawer visibility drives the markers (don't paint on the PCB while closed)
  new MutationObserver(() => { renderMarkers(); renderOverlay(); }).observe(aside, { attributes: true, attributeFilter: ["hidden"] });

  refreshBoard();
}
