export const STYLESHEET = `
:host {
  --bg: #ffffff; --panel: #f3f5f8; --line: #c9d1da; --fg: #11161c; --muted: #5b6673;
  --accent: #b35c00; --ok: #1a8f3c; --pow: #0a55c8; --primary: #1f6feb;
  display: block; height: 100%; color: var(--fg); background: var(--bg);
  font-family: ui-sans-serif, system-ui, sans-serif; font-size: 13px;
}
:host([data-theme="dark"]) {
  --bg: #0e1116; --panel: #161a20; --line: #2b333d; --fg: #e6e8ea; --muted: #8b949e;
  --accent: #ff8c00; --ok: #39d353; --pow: #4aa3ff; --primary: #4493f8;
}
* { box-sizing: border-box; }
.wrap { display: flex; flex-direction: column; height: 100%; }

.toolbar { flex: 0 0 auto; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;
  padding: 8px 10px; background: var(--panel); border-bottom: 1px solid var(--line); }
.toolbar .title { font-weight: 700; margin-right: 6px; }
.toolbar button { position: relative; padding: 6px 11px; background: var(--bg); color: var(--fg);
  border: 1px solid var(--line); border-radius: 6px; cursor: pointer; font: inherit; font-weight: 600; }
.toolbar button:hover { border-color: var(--accent); }
.toolbar button.primary { background: var(--primary); border-color: var(--primary); color: #fff; }
.toolbar button.primary:hover { filter: brightness(1.08); }
.counts { color: var(--muted); margin-left: auto; font-weight: 600; }
.status { color: var(--accent); flex-basis: 100%; min-height: 1em; font-weight: 600; }

.panes { flex: 1 1 auto; display: flex; min-height: 0; }
.pane { flex: 1 1 0; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.pane-divider { flex: 0 0 6px; align-self: stretch; cursor: col-resize; background: var(--line); position: relative; }
.pane-divider:hover, .pane-divider.drag { background: var(--accent); }
/* widen the hit area without widening the bar */
.pane-divider::before { content: ""; position: absolute; left: -5px; right: -5px; top: 0; bottom: 0; z-index: 1; }
.pane > header { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: baseline;
  padding: 6px 10px; background: var(--panel); border-bottom: 1px solid var(--line); }
.pane-title { font-weight: 700; }
.fname { color: var(--muted); font-size: 12px; }
.viewer { flex: 1 1 60%; min-height: 0; display: block; }
.viewer.hidden { display: none; }

/* KiCad schematic/PCB segmented toggle */
.viewseg { display: inline-flex; border: 1px solid var(--line); border-radius: 6px; overflow: hidden; }
.viewseg button { padding: 3px 10px; background: var(--bg); color: var(--muted); border: none;
  border-left: 1px solid var(--line); cursor: pointer; font: inherit; font-weight: 600; }
.viewseg button:first-child { border-left: none; }
.viewseg button.active { background: var(--primary); color: #fff; }
.hdrbtn { padding: 3px 10px; background: var(--bg); color: var(--fg); border: 1px solid var(--line);
  border-radius: 6px; cursor: pointer; font: inherit; font-weight: 600; }
.hdrbtn:hover { border-color: var(--accent); }

.lists { flex: 0 0 40%; display: flex; flex-direction: column; min-height: 0; border-top: 1px solid var(--line); background: var(--panel); }
.lists.collapsed { flex: 0 0 auto; }
.lists.collapsed .filter, .lists.collapsed .list { display: none; }
.tabs .fold { flex: 0 0 auto; margin-left: auto; padding: 5px 8px; background: transparent;
  border: none; cursor: pointer; color: var(--muted); font: inherit; }
.tabs .fold:hover { color: var(--fg); }
.tabs { display: flex; gap: 2px; padding: 6px 8px 0; flex: 0 0 auto; }
.tab { flex: 1; padding: 5px; background: transparent; border: none; border-bottom: 2px solid transparent;
  color: var(--muted); cursor: pointer; font: inherit; font-weight: 600; }
.tab.active { color: var(--fg); border-bottom-color: var(--accent); }
.filter { margin: 8px; padding: 6px 8px; background: var(--bg); border: 1px solid var(--line); border-radius: 6px; color: var(--fg); flex: 0 0 auto; }
.list { flex: 1 1 auto; overflow: auto; padding: 4px 6px; min-height: 0; }
.row { display: flex; justify-content: space-between; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; }
.row:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.row.sel { outline: 2px solid var(--accent); }
.row.mapped { background: color-mix(in srgb, var(--ok) 14%, transparent); }
.row.mapped.sel { outline: 2px solid var(--ok); }
.row .name { font-variant-numeric: tabular-nums; font-weight: 600; }
.row .name.pow { color: var(--pow); }
.row .val { color: var(--muted); font-size: 12px; margin-left: 10px; margin-right: auto; }
.row .meta { color: var(--muted); font-size: 12px; }
.row .meta.ok { color: var(--ok); font-weight: 700; }
`;
