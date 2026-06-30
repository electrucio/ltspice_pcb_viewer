/**
 * Read-only nets/components sidebar for the exported viewer — mirrors the main app's
 * lists (Nets/Components tabs, filter, value column, mapped `→` indicator) but does not
 * edit anything. Plain DOM + plain CSS so it runs on old iOS Safari.
 */

export type Kind = "net" | "component";

export interface SidebarData {
  nets: { id: string; power: boolean }[];
  comps: { id: string; value: string }[];
}

export interface SidebarOpts {
  /** counterpart id on the other side, or undefined if unmapped */
  counterpart: (kind: Kind, id: string) => string | undefined;
  /** row clicked */
  onSelect: (kind: Kind, id: string) => void;
}

export interface Sidebar {
  el: HTMLElement;
  /** reflect the current cross-probe selection (switches tab + highlights the row) */
  setSelected: (kind: Kind | null, id: string | null) => void;
}

function h(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function createSidebar(data: SidebarData, opts: SidebarOpts): Sidebar {
  let tab: Kind = "net";
  let term = "";
  let sel: { kind: Kind; id: string } | null = null;

  const wrap = h("div", "lists");
  const tabs = h("div", "tabs");
  const netTab = h("button", "tab active", "Nets") as HTMLButtonElement;
  const compTab = h("button", "tab", "Components") as HTMLButtonElement;
  tabs.append(netTab, compTab);
  const filter = h("input", "filter") as HTMLInputElement;
  filter.placeholder = "Filter…";
  const list = h("div", "list");
  wrap.append(tabs, filter, list);

  function render(): void {
    netTab.classList.toggle("active", tab === "net");
    compTab.classList.toggle("active", tab === "component");
    const t = term.trim().toLowerCase();
    const rows = tab === "net"
      ? data.nets.map((n) => ({ id: n.id, value: "", power: n.power }))
      : data.comps.map((c) => ({ id: c.id, value: c.value, power: false }));
    list.replaceChildren();
    const filtered = rows
      .filter((r) => r.id.toLowerCase().indexOf(t) >= 0 || r.value.toLowerCase().indexOf(t) >= 0)
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    for (const r of filtered) {
      const mappedTo = opts.counterpart(tab, r.id);
      const row = h("div", "row");
      if (mappedTo) row.classList.add("mapped");
      if (sel && sel.kind === tab && sel.id === r.id) row.classList.add("sel");
      const name = h("span", "name" + (r.power ? " pow" : ""), r.id);
      row.append(name);
      if (tab === "component") row.append(h("span", "val", r.value));
      const meta = h("span", "meta" + (mappedTo ? " ok" : ""), mappedTo ? "→ " + mappedTo : (r.power ? "power" : ""));
      row.append(meta);
      const id = r.id;
      row.addEventListener("click", () => opts.onSelect(tab, id));
      list.appendChild(row);
    }
    const selRow = list.querySelector(".row.sel") as HTMLElement | null;
    if (selRow) selRow.scrollIntoView({ block: "nearest" });
  }

  netTab.addEventListener("click", () => { tab = "net"; render(); });
  compTab.addEventListener("click", () => { tab = "component"; render(); });
  filter.addEventListener("input", () => { term = filter.value; render(); });

  render();

  return {
    el: wrap,
    setSelected(kind, id) {
      sel = kind && id ? { kind, id } : null;
      if (kind && kind !== tab) tab = kind; // surface the selected row's kind
      render();
    },
  };
}
