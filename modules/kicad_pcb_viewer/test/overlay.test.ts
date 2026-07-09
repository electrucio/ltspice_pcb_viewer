// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { parsePcb } from "../src/parser/pcb.js";
import { renderPcb } from "../src/render/svg.js";

// tiny synthetic board (happy-dom patches URL, so no fs fixture here)
const text = `(kicad_pcb (version 20241229) (generator "pcbnew")
  (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
  (net 0 "") (net 1 "N1")
  (segment (start 0 0) (end 10 0) (width 0.3) (layer "F.Cu") (net 1))
  (gr_line (start 0 0) (end 10 0) (stroke (width 0.1) (type solid)) (layer "Edge.Cuts"))
)`;

describe("overlay group (external annotations)", () => {
  it("renderPcb ends the content group with an empty pcb-overlay group", () => {
    const { content } = renderPcb(parsePcb(text));
    const overlay = content.querySelector("g.pcb-overlay")!;
    expect(overlay).not.toBeNull();
    expect(content.lastElementChild).toBe(overlay); // topmost = drawn last
    expect(overlay.childElementCount).toBe(0);
    // inside `content` so pan/zoom/mirror/rotation transforms apply to annotations
    expect(overlay.parentElement).toBe(content);
  });

  it("hosts can fill and clear it", () => {
    const { content } = renderPcb(parsePcb(text));
    const overlay = content.querySelector("g.pcb-overlay")!;
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    overlay.appendChild(dot);
    expect(overlay.childElementCount).toBe(1);
    overlay.replaceChildren(); // what KicadPcbElement.clearOverlay() does
    expect(overlay.childElementCount).toBe(0);
  });
});
