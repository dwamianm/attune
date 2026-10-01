import type { LayoutPlan } from "@attune/core";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AdaptiveCanvas, ChangeLine, Dock, PanelCard, usePanelCard, type PanelCardProps } from "./canvas.tsx";

type P = "drafts" | "sources" | "notes";

const plan: LayoutPlan<P> = {
  mode: "focus",
  placements: [
    { id: "drafts", size: "hero", priority: 1, pinned: false, reason: "Central", change: null, anchor: true },
    { id: "sources", size: "standard", priority: 0.5, pinned: false, reason: "Useful", change: "added", relation: { anchorPanel: "drafts", tag: "Linked to Bees", reason: "1 linked record", records: [] } },
  ],
  docked: ["notes"],
  density: "standard",
  suggestions: [],
  help: "none",
  decisions: [{ kind: "add", panel: "sources", text: "Brought Sources onto the canvas" }, { kind: "mode", text: "Switched to the Focus layout" }, { kind: "dock", panel: "notes", text: "Moved Notes to the dock" }],
  basedOnVersion: 1,
  round: 2,
  grid: { columns: 4, cells: { drafts: { col: 0, row: 0, w: 2, h: 4 }, sources: { col: 2, row: 0, w: 1, h: 2 } }, rows: 4, anchored: true },
};

describe("AdaptiveCanvas", () => {
  it("puts each card in its cell and marks the anchor, links, and changes", () => {
    const html = renderToString(createElement(AdaptiveCanvas<P, never, string>, { plan: plan as never, columns: 4, renderCard: (p) => createElement("h2", null, p.id) }));
    expect(html).toContain('data-canvas=""');
    expect(html).toContain("grid-template-rows:repeat(4, 104px)");
    expect(html).toMatch(/data-panel="drafts"[^>]*data-anchor="true"/);
    expect(html).toContain("grid-column:1 / span 2;grid-row:1 / span 4");
    expect(html).toMatch(/data-panel="sources"[^>]*data-linked=""[^>]*data-change="added"/);
  });

  it("puts the cards in cell order, shows quiet cards faded, and marks the live anchor from the app", () => {
    // Sources is first in the plan but sits right of Drafts in the grid, so Drafts comes first in the DOM (Tab order).
    const swapped = { ...plan, placements: [plan.placements[1], plan.placements[0]] };
    const html = renderToString(
      createElement(AdaptiveCanvas<P, never, string>, {
        plan: swapped as never,
        columns: 4,
        renderCard: (p) => createElement("h2", null, p.id),
        quiet: (p) => p.id === "sources",
        anchorPanel: null,
        holdStill: "drafts",
      }),
    );
    expect(html.indexOf('data-panel="drafts"')).toBeLessThan(html.indexOf('data-panel="sources"'));
    expect(html).toMatch(/data-panel="sources"[^>]*data-quiet="faded"/);
    expect(html).toMatch(/style="[^"]*opacity:0.55/);
    // anchorPanel null: the plan's anchor is not the live one, so no card is on top.
    expect(html).not.toContain("data-anchor");
    expect(html).toContain("overflow-anchor:none");
  });

  it("lets the app draw each card around PanelCard, with the card's motion in context", () => {
    function Card(props: PanelCardProps<P, string>) {
      return createElement(PanelCard<P, string>, { ...props, className: "mine", radius: 14 }, createElement(Motion), props.children);
    }
    function Motion() {
      const m = usePanelCard();
      return createElement("i", null, `${m?.id} round ${m?.round}`);
    }
    const html = renderToString(createElement(AdaptiveCanvas<P, never, string>, { plan: plan as never, columns: 4, card: Card, renderCard: (p) => createElement("h2", null, p.id) }));
    expect(html).toMatch(/class="mine"[^>]*border-radius:14px/);
    expect(html).toContain("<i>drafts round 2</i><h2>drafts</h2>");
  });

  it("lets cards flow by size when the plan was packed for other columns", () => {
    const html = renderToString(createElement(AdaptiveCanvas<P, never, string>, { plan: plan as never, columns: 2, renderCard: () => null }));
    expect(html).toContain("grid-column:span 2;grid-row:span 4");
    expect(html).not.toContain("grid-template-rows");
  });
});

describe("Dock and ChangeLine", () => {
  it("lists docked panels for the cards to fly into, and the round's changes with Undo", () => {
    const dock = renderToString(createElement(Dock<P>, { docked: ["notes"], label: () => "Notes", onOpen: () => {} }));
    expect(dock).toContain('data-dock-id="notes"');
    expect(dock).toContain("Bring back Notes");
    const line = renderToString(createElement(ChangeLine<P>, { decisions: plan.decisions, onUndo: () => {} }));
    expect(line).toContain("Brought Sources onto the canvas; Switched to the Focus layout");
    expect(line).toContain(" +1 more");
    expect(line).toContain("Undo");
  });
});
