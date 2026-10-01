import { describe, expect, it } from "vitest";
import {
  cellFits,
  cellsOverlap,
  lockedPanels,
  packGrid,
  spanOf,
  startsBefore,
  summarizeChanges,
  type GridCell,
  type GridColumns,
  type PackedPlan,
  type PackItem as GenericPackItem,
  type PackResult as GenericPackResult,
  type PanelSize,
} from "./grid.ts";

/** Ten panel ids, the same as the demo app's, so these cases read like real canvases. */
const PANEL_IDS = ["inbox", "calendar", "tasks", "invoices", "clients", "projects", "analytics", "team", "notes", "help"] as const;
type PanelId = (typeof PANEL_IDS)[number];
type PackItem = GenericPackItem<PanelId>;
type PackResult = GenericPackResult<PanelId>;

const SIZES: PanelSize[] = ["hero", "large", "standard", "compact"];

function item(id: PanelId, size: PanelSize = "standard", extra: Partial<PackItem> = {}): PackItem {
  return { id, size, priority: 0.5, pinned: false, anchor: false, linked: false, ...extra };
}

function reflow(items: PackItem[], columns: GridColumns): PackResult {
  return packGrid({ items, columns, previous: null, hold: [] });
}

/** Deterministic PRNG (mulberry32), so a failing case can be replayed from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, list: readonly T[]): T {
  return list[Math.floor(r() * list.length)];
}

function shuffle<T>(r: () => number, list: T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Every item exactly once, inside the columns, no two cells sharing a track. */
function expectValid(result: PackResult, items: PackItem[], columns: GridColumns): void {
  const ids = Object.keys(result.cells).sort();
  expect(ids).toEqual(items.map((i) => i.id).sort());
  const cells = Object.values(result.cells) as GridCell[];
  for (const c of cells) expect(cellFits(c, columns)).toBe(true);
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) expect(cellsOverlap(cells[i], cells[j])).toBe(false);
  }
  expect(result.rows).toBe(cells.reduce((m, c) => Math.max(m, c.row + c.h), 0));
  // A card shows its requested span unless the packer kept its old one.
  for (const it of items) {
    if (result.keptSize.includes(it.id)) continue;
    const span = spanOf(it.size, columns);
    expect({ w: result.cells[it.id]!.w, h: result.cells[it.id]!.h }).toEqual({ w: Math.min(span.w, columns), h: span.h });
  }
}

const at = (r: PackResult, id: PanelId) => r.cells[id]!;
const topLeft = (c: GridCell) => ({ col: c.col, row: c.row });

/**
 * The backfill rule: no empty spot that a card later in reading order would
 * fit into, unless that card stays put (`held`: the anchor, held, pinned, and
 * bigger cards, a card the user just resized, and in a gathering round the
 * gathered linked panels). A spot no later card fits may stay.
 */
function fillableHoles(result: PackResult, items: PackItem[], columns: GridColumns, held: ReadonlySet<PanelId>): string[] {
  const all = Object.entries(result.cells) as [PanelId, GridCell][];
  const free = (c: GridCell, except?: PanelId) => all.every(([id, o]) => id === except || !cellsOverlap(o, c));
  const out: string[] = [];
  for (let row = 0; row < result.rows; row++) {
    for (let col = 0; col < columns; col++) {
      if (!free({ col, row, w: 1, h: 1 })) continue;
      for (const it of items) {
        const c = result.cells[it.id];
        if (!c || held.has(it.id)) continue;
        const spot = { col, row, w: c.w, h: c.h };
        if (startsBefore(spot, c) && cellFits(spot, columns) && free(spot, it.id)) out.push(`${it.id} fits the hole at ${col},${row}`);
      }
    }
  }
  return out;
}

/** The cards the passes never move: the anchor, held, pinned, and bigger cards. */
function heldOf(items: PackItem[], hold: PanelId[] = [], extra: PanelId[] = []): Set<PanelId> {
  return new Set([...items.filter((it) => it.anchor || it.pinned || it.bigger).map((it) => it.id), ...hold, ...extra]);
}

describe("packGrid: properties over random sessions", () => {
  for (const columns of [1, 2, 4] as GridColumns[]) {
    it(`never overlaps, stays in bounds, and holds the anchor still (${columns} columns)`, () => {
      for (let seed = 1; seed <= 250; seed++) {
        const r = rng(seed * 7919 + columns);
        let items = shuffle(r, [...PANEL_IDS])
          .slice(0, 2 + Math.floor(r() * 8))
          .map((id) => item(id, pick(r, SIZES), { priority: r() }));
        let previous = reflow(items, columns);
        expectValid(previous, items, columns);
        // Several rounds in a row, each packed against the last, the way a session runs.
        for (let round = 0; round < 6; round++) {
          const kept = items.filter(() => r() < 0.8);
          const fresh = shuffle(
            r,
            PANEL_IDS.filter((id) => !items.some((it) => it.id === id)),
          ).slice(0, Math.floor(r() * 3));
          const nextIds = [...kept.map((it) => it.id), ...fresh];
          if (nextIds.length === 0) nextIds.push(items[0]?.id ?? "inbox");
          const anchorId = kept.length && r() < 0.8 ? pick(r, kept).id : null;
          const next: PackItem[] = nextIds.map((id) => {
            const old = items.find((it) => it.id === id);
            return item(id, old && r() < 0.7 ? old.size : pick(r, SIZES), {
              priority: r(),
              pinned: r() < 0.15,
              linked: r() < 0.35,
              anchor: id === anchorId,
            });
          });
          const holdable = kept.filter((it) => it.id !== anchorId);
          const hold = holdable.length && r() < 0.4 ? [pick(r, holdable).id] : [];
          const settle = !anchorId && r() < 0.5;
          // Some anchored rounds gather their linked panels ("Arrange linked panels by next step").
          const gather = anchorId && r() < 0.5 ? shuffle(r, next.filter((it) => it.linked).map((it) => it.id)) : [];
          const result = packGrid({
            items: next,
            columns,
            previous: previous.cells,
            hold,
            ...(settle ? { unanchored: "settle" as const } : {}),
            ...(gather.length ? { gather } : {}),
          });
          expectValid(result, next, columns);
          // No orphaned holes; the gathered panels (standard or smaller) stay where the gathering put them.
          const std = spanOf("standard", columns);
          const gathered = gather.filter((id) => {
            const c = at(result, id);
            return c.w * c.h <= Math.min(std.w, columns) * std.h;
          });
          expect(fillableHoles(result, next, columns, heldOf(next, hold, gathered)), `seed ${seed} round ${round}`).toEqual([]);

          for (const id of hold) expect(at(result, id)).toEqual(previous.cells[id]);
          if (anchorId) {
            const before = previous.cells[anchorId]!;
            const a = at(result, anchorId);
            expect(result.anchored).toBe(true);
            expect(topLeft(a)).toEqual(topLeft(before));
            expect(a.w).toBeGreaterThanOrEqual(before.w);
            expect(a.h).toBeGreaterThanOrEqual(before.h);
            // It grows only into free or vacated cells (a list on one column pushes the rest down).
            const grew = a.w > before.w || a.h > before.h;
            if (grew && columns > 1) {
              for (const it of next) {
                const prev = previous.cells[it.id];
                if (it.id !== anchorId && prev) expect(cellsOverlap(prev, a)).toBe(false);
              }
            }
            for (const it of next) {
              const prev = previous.cells[it.id];
              // Pinned cards never move. (Other cards may: backfill closes holes, even before the anchor.)
              if (it.pinned && prev && it.id !== anchorId) expect(at(result, it.id)).toEqual(prev);
            }
          } else {
            expect(result.anchored).toBe(false);
          }
          previous = result;
          items = next.map((it) => ({ ...it, anchor: false }));
          // The next round's items carry the sizes the packer actually showed.
          items = items.map((it) => (result.keptSize.includes(it.id) ? { ...it, size: sizeFor(result.cells[it.id]!, columns) } : it));
        }
      }
    });
  }

  it("is deterministic", () => {
    const items = [item("inbox"), item("calendar", "hero", { anchor: true }), item("team", "standard", { linked: true }), item("tasks", "compact")];
    const previous = reflow([item("inbox"), item("calendar"), item("tasks"), item("projects")], 4).cells;
    const a = packGrid({ items, columns: 4, previous, hold: [] });
    const b = packGrid({ items, columns: 4, previous, hold: [] });
    expect(a).toEqual(b);
  });
});

/** The size whose span is this cell (for carrying kept sizes forward in the property test). */
function sizeFor(cell: GridCell, columns: GridColumns): PanelSize {
  return SIZES.find((s) => spanOf(s, columns).h === cell.h && Math.min(spanOf(s, columns).w, columns) === cell.w) ?? "standard";
}

const OVERVIEW: PanelId[] = ["inbox", "calendar", "tasks", "invoices", "clients", "projects"];

describe("packGrid: unanchored rounds", () => {
  it("packs in plan order the way the CSS dense flow does", () => {
    const r = reflow(OVERVIEW.map((id) => item(id)), 4);
    expect(OVERVIEW.map((id) => topLeft(at(r, id)))).toEqual([
      { col: 0, row: 0 },
      { col: 1, row: 0 },
      { col: 2, row: 0 },
      { col: 3, row: 0 },
      { col: 0, row: 2 },
      { col: 1, row: 2 },
    ]);
    expect(r.rows).toBe(4);
    expect(r.anchored).toBe(false);
  });

  it("lets a compact tile fill a hole beside a hero", () => {
    const r = reflow([item("invoices", "hero"), item("clients"), item("inbox"), item("tasks", "compact"), item("team", "compact")], 4);
    expect(at(r, "invoices")).toEqual({ col: 0, row: 0, w: 2, h: 4 });
    expect(topLeft(at(r, "tasks"))).toEqual({ col: 2, row: 2 });
    expect(topLeft(at(r, "team"))).toEqual({ col: 3, row: 2 });
  });

  it("keeps a held card in its cell and flows the rest around it", () => {
    const previous = reflow(OVERVIEW.map((id) => item(id)), 4).cells;
    const next = [item("invoices", "hero"), item("calendar"), item("clients"), item("tasks")];
    const r = packGrid({ items: next, columns: 4, previous, hold: ["calendar"] });
    expect(at(r, "calendar")).toEqual(previous.calendar);
    expect(topLeft(at(r, "invoices"))).not.toEqual({ col: 0, row: 0 }); // The held card is in the way at (1, 0).
    expectValid(r, next, 4);
  });

  it("settles: cards keep their cells when their order holds, and a newcomer fills the hole", () => {
    const previous = reflow(OVERVIEW.map((id) => item(id)), 4).cells;
    const next = [...OVERVIEW.filter((id) => id !== "calendar").map((id) => item(id)), item("team")];
    const r = packGrid({ items: next, columns: 4, previous, hold: [], unanchored: "settle" });
    expect(at(r, "team")).toEqual(previous.calendar);
    for (const id of OVERVIEW.filter((id) => id !== "calendar")) expect(at(r, id)).toEqual(previous[id]);
    expect(r.anchored).toBe(false);
  });

  it("settles: a card floats up into a hole nothing filled", () => {
    const previous = reflow(OVERVIEW.map((id) => item(id)), 4).cells;
    const next = OVERVIEW.filter((id) => id !== "calendar").map((id) => item(id));
    const r = packGrid({ items: next, columns: 4, previous, hold: [], unanchored: "settle" });
    expect(topLeft(at(r, "projects"))).toEqual({ col: 1, row: 0 });
    for (const id of ["inbox", "tasks", "invoices", "clients"] as PanelId[]) expect(at(r, id)).toEqual(previous[id]);
  });

  it("settles by reflow when the cards that stay changed order", () => {
    const previous = reflow(OVERVIEW.map((id) => item(id)), 4).cells;
    const order: PanelId[] = ["invoices", "inbox", "calendar", "tasks", "clients", "projects"];
    const r = packGrid({ items: order.map((id) => item(id)), columns: 4, previous, hold: [], unanchored: "settle" });
    expect(r).toEqual(reflow(order.map((id) => item(id)), 4));
  });

  it("does not anchor a panel with no previous cell (first render or a column change)", () => {
    const r = packGrid({ items: [item("inbox", "standard", { anchor: true }), item("tasks")], columns: 2, previous: null, hold: [] });
    expect(r.anchored).toBe(false);
    expect(topLeft(at(r, "inbox"))).toEqual({ col: 0, row: 0 });
  });
});

describe("packGrid: the anchor holds still (4 columns)", () => {
  const previous = reflow(OVERVIEW.map((id) => item(id)), 4).cells;

  it("keeps an anchor in the last column at its size when it wants to be the hero", () => {
    const next = OVERVIEW.map((id) => item(id, id === "invoices" ? "hero" : "standard", { anchor: id === "invoices" }));
    const r = packGrid({ items: next, columns: 4, previous, hold: [] });
    expect(at(r, "invoices")).toEqual(previous.invoices);
    expect(r.keptSize).toEqual(["invoices"]);
    for (const id of OVERVIEW) expect(at(r, id)).toEqual(previous[id]); // Nothing else had a reason to move.
  });

  it("keeps the anchor's size instead of growing over cards that stay", () => {
    const next = OVERVIEW.map((id) => item(id, id === "inbox" ? "hero" : "standard", { anchor: id === "inbox" }));
    const r = packGrid({ items: next, columns: 4, previous, hold: [] });
    expect(at(r, "inbox")).toEqual(previous.inbox);
    expect(r.keptSize).toEqual(["inbox"]);
    for (const id of OVERVIEW) expect(at(r, id)).toEqual(previous[id]); // Nothing is pushed out of the way.
  });

  it("grows the anchor in place into cells that cards leaving this round vacated", () => {
    const next = OVERVIEW.filter((id) => !["calendar", "clients", "projects"].includes(id)).map((id) =>
      item(id, id === "inbox" ? "hero" : "standard", { anchor: id === "inbox" }),
    );
    const r = packGrid({ items: next, columns: 4, previous, hold: [] });
    expect(at(r, "inbox")).toEqual({ col: 0, row: 0, w: 2, h: 4 });
    expect(r.keptSize).toEqual([]);
    expect(at(r, "tasks")).toEqual(previous.tasks);
    expect(at(r, "invoices")).toEqual(previous.invoices);
  });

  it("puts a linked newcomer into the cell a leaving card vacated near the anchor", () => {
    // Calendar at (1, 0) is the anchor; Invoices leaves the top-right corner.
    const next = [...OVERVIEW.filter((id) => id !== "invoices").map((id) => item(id, "standard", { anchor: id === "calendar" })), item("team", "standard", { linked: true })];
    const r = packGrid({ items: next, columns: 4, previous, hold: [] });
    expect(at(r, "team")).toEqual(previous.invoices);
    for (const id of OVERVIEW.filter((id) => id !== "invoices")) expect(at(r, id)).toEqual(previous[id]);
  });

  it("puts any other newcomer into a vacated cell before the end of the canvas", () => {
    const next = [...OVERVIEW.filter((id) => id !== "invoices").map((id) => item(id, "standard", { anchor: id === "calendar" })), item("notes")];
    const r = packGrid({ items: next, columns: 4, previous, hold: [] });
    expect(at(r, "notes")).toEqual(previous.invoices);
  });

  it("closes the holes cards leave: later cards slide left or move up into them, even past the anchor", () => {
    // Calendar and Projects leave column 1: Tasks and Invoices slide left, and Clients moves up into the last spot of the row.
    const next = OVERVIEW.filter((id) => id !== "calendar" && id !== "projects").map((id) => item(id, "standard", { anchor: id === "inbox" }));
    const r = packGrid({ items: next, columns: 4, previous, hold: [] });
    expect(at(r, "inbox")).toEqual(previous.inbox);
    expect(topLeft(at(r, "tasks"))).toEqual({ col: 1, row: 0 });
    expect(topLeft(at(r, "invoices"))).toEqual({ col: 2, row: 0 });
    expect(topLeft(at(r, "clients"))).toEqual({ col: 3, row: 0 });
    // With the anchor at (2, 0), it stays; the next card after the hole (Invoices) takes it, across the anchor.
    const pastItems = OVERVIEW.filter((id) => id !== "calendar" && id !== "projects").map((id) => item(id, "standard", { anchor: id === "tasks" }));
    const past = packGrid({ items: pastItems, columns: 4, previous, hold: [] });
    expect(at(past, "tasks")).toEqual(previous.tasks);
    expect(topLeft(at(past, "invoices"))).toEqual({ col: 1, row: 0 });
    expect(topLeft(at(past, "clients"))).toEqual({ col: 3, row: 0 });
    expect(fillableHoles(past, pastItems, 4, heldOf(pastItems))).toEqual([]);
  });

  it("does not grow over a pinned card, and keeps its size instead", () => {
    const next = OVERVIEW.map((id) => item(id, id === "inbox" ? "hero" : "standard", { anchor: id === "inbox", pinned: id === "calendar" }));
    const r = packGrid({ items: next, columns: 4, previous, hold: [] });
    expect(at(r, "inbox")).toEqual(previous.inbox);
    expect(at(r, "calendar")).toEqual(previous.calendar);
    expect(r.keptSize).toEqual(["inbox"]);
  });

  it("never shrinks the anchor, even when asked", () => {
    const next = OVERVIEW.map((id) => item(id, id === "clients" ? "compact" : "standard", { anchor: id === "clients" }));
    const r = packGrid({ items: next, columns: 4, previous, hold: [] });
    expect(at(r, "clients")).toEqual(previous.clients);
    expect(r.keptSize).toEqual(["clients"]);
  });

  it("puts linked newcomers next to the anchor: right first, then below", () => {
    // Clients at (0, 2) is the anchor and Projects sits right beside it. Right
    // under the anchor is closer on screen than two columns over.
    const next = [...OVERVIEW.map((id) => item(id, "standard", { anchor: id === "clients" })), item("team", "standard", { linked: true, priority: 0.9 })];
    // Right under the anchor first; then the backfill closes the gap left in the anchor's row, so it ends there.
    const under = packGrid({ items: next, columns: 4, previous, hold: [] });
    expect(topLeft(at(under, "team"))).toEqual({ col: 2, row: 2 });
    // Gathering it swaps it with Projects, right beside the anchor.
    const gathered = packGrid({ items: next, columns: 4, previous, hold: [], gather: ["team"] });
    expect(topLeft(at(gathered, "team"))).toEqual({ col: 1, row: 2 });
    expect(topLeft(at(gathered, "projects"))).toEqual({ col: 2, row: 2 });

    // With Projects gone, the spot right beside the anchor is free.
    const noProjects = next.filter((it) => it.id !== "projects");
    const beside = packGrid({ items: noProjects, columns: 4, previous, hold: [] });
    expect(topLeft(at(beside, "team"))).toEqual({ col: 1, row: 2 });

    // With the whole row taken, the linked card goes right under the anchor.
    const full = [...next.filter((it) => it.id !== "team"), item("analytics"), item("notes")];
    const fullPrev = reflow(full.map((it) => ({ ...it, anchor: false })), 4).cells;
    const below = packGrid({ items: [...full, item("team", "standard", { linked: true })], columns: 4, previous: fullPrev, hold: [] });
    expect(topLeft(at(below, "team"))).toEqual({ col: 0, row: 4 });
  });

  it("puts the highest-priority linked card nearest", () => {
    const next = [
      ...OVERVIEW.filter((id) => id !== "projects").map((id) => item(id, "standard", { anchor: id === "clients" })),
      item("team", "standard", { linked: true, priority: 0.3 }),
      item("analytics", "standard", { linked: true, priority: 0.8 }),
    ];
    const r = packGrid({ items: next, columns: 4, previous, hold: [] });
    expect(topLeft(at(r, "analytics"))).toEqual({ col: 1, row: 2 });
    // Team went right under the anchor, and the backfill brought it up into the anchor's row.
    expect(topLeft(at(r, "team"))).toEqual({ col: 2, row: 2 });
  });

  it("fills a hole before the anchor with the next card, and the anchor stays", () => {
    // Inbox left the top-left corner; Tasks is the anchor at (2, 0). Clients
    // floats up beside the hole first (half a row), so it is the next card
    // after the hole and takes it; the canvas closes up around the anchor.
    const next = [item("calendar"), item("tasks", "standard", { anchor: true }), item("invoices"), item("clients"), item("projects"), item("team")];
    const r = packGrid({ items: next, columns: 4, previous, hold: [] });
    expect(at(r, "tasks")).toEqual(previous.tasks);
    expect(at(r, "calendar")).toEqual(previous.calendar);
    expect(topLeft(at(r, "clients"))).toEqual({ col: 0, row: 0 });
    expect(r.rows).toBe(4);
    expect(fillableHoles(r, next, 4, heldOf(next))).toEqual([]);
  });

  it("keeps a held card still even when the anchor would grow over it", () => {
    const next = OVERVIEW.map((id) => item(id, id === "inbox" ? "hero" : "standard", { anchor: id === "inbox" }));
    const r = packGrid({ items: next, columns: 4, previous, hold: ["calendar"] });
    expect(at(r, "calendar")).toEqual(previous.calendar);
    expect(at(r, "inbox")).toEqual(previous.inbox);
  });

  it("floats a card up into a hole left beside the anchor", () => {
    // Calendar at (1, 0) leaves; Projects below it at (1, 2) slides up into the hole.
    const next = OVERVIEW.filter((id) => id !== "calendar").map((id) => item(id, "standard", { anchor: id === "inbox" }));
    const r = packGrid({ items: next, columns: 4, previous, hold: [] });
    expect(topLeft(at(r, "projects"))).toEqual({ col: 1, row: 0 });
    expect(at(r, "clients")).toEqual(previous.clients);
  });
});

describe("packGrid: the anchor holds still (2 columns)", () => {
  const previous = reflow(OVERVIEW.map((id) => item(id)), 2).cells;

  it("packs the overview two across", () => {
    expect(topLeft(previous.invoices!)).toEqual({ col: 1, row: 2 });
    expect(topLeft(previous.clients!)).toEqual({ col: 0, row: 4 });
  });

  it("keeps a right-column anchor at its size when it wants to be the hero", () => {
    const next = OVERVIEW.map((id) => item(id, id === "invoices" ? "hero" : "standard", { anchor: id === "invoices" }));
    const r = packGrid({ items: next, columns: 2, previous, hold: [] });
    expect(at(r, "invoices")).toEqual(previous.invoices);
    expect(r.keptSize).toEqual(["invoices"]);
  });

  it("grows a left-column anchor into a wide card only when its neighbor leaves", () => {
    const next = OVERVIEW.map((id) => item(id, id === "tasks" ? "large" : "standard", { anchor: id === "tasks" }));
    const stays = packGrid({ items: next, columns: 2, previous, hold: [] });
    expect(at(stays, "tasks")).toEqual(previous.tasks);
    expect(at(stays, "invoices")).toEqual(previous.invoices);
    expect(stays.keptSize).toEqual(["tasks"]);

    const leaves = next.filter((it) => it.id !== "invoices");
    const r = packGrid({ items: leaves, columns: 2, previous, hold: [] });
    expect(at(r, "tasks")).toEqual({ col: 0, row: 2, w: 2, h: 2 });
    expect(at(r, "inbox")).toEqual(previous.inbox);
    expect(at(r, "calendar")).toEqual(previous.calendar);
    expectValid(r, leaves, 2);
  });
});

describe("packGrid: the anchor holds still (1 column)", () => {
  const previous = reflow(OVERVIEW.map((id) => item(id)), 1).cells;

  it("stacks the overview one per row", () => {
    expect(OVERVIEW.map((id) => previous[id]!.row)).toEqual([0, 3, 6, 9, 12, 15]);
  });

  it("grows the anchor downward and moves the cards after it down", () => {
    const next = OVERVIEW.map((id) => item(id, id === "tasks" ? "hero" : "standard", { anchor: id === "tasks" }));
    const r = packGrid({ items: next, columns: 1, previous, hold: [] });
    expect(at(r, "tasks")).toEqual({ col: 0, row: 6, w: 1, h: 5 });
    expect(at(r, "calendar")).toEqual(previous.calendar);
    expect(at(r, "invoices").row).toBe(11);
  });

  it("puts a linked newcomer right under the anchor", () => {
    const next = [...OVERVIEW.map((id) => item(id, "standard", { anchor: id === "calendar" })), item("team", "standard", { linked: true })];
    const r = packGrid({ items: next, columns: 1, previous, hold: [] });
    expect(at(r, "calendar")).toEqual(previous.calendar);
    expect(at(r, "team").row).toBe(6);
    expect(at(r, "tasks").row).toBe(9);
    expect(at(r, "inbox")).toEqual(previous.inbox);
  });
});

describe("lockedPanels", () => {
  const previous = reflow(OVERVIEW.map((id) => item(id)), 4).cells;

  it("locks panels before the anchor in order and on screen", () => {
    expect(lockedPanels(OVERVIEW, previous, "clients").sort()).toEqual(["calendar", "inbox", "invoices", "tasks"]);
    expect(lockedPanels(OVERVIEW, previous, "inbox")).toEqual([]);
  });

  it("locks a card on the anchor's row to its left even when it comes later in order", () => {
    expect(lockedPanels(["tasks", "invoices", "inbox"], previous, "tasks")).toContain("inbox");
  });

  it("locks nothing when the anchor has no cell", () => {
    expect(lockedPanels(OVERVIEW, previous, "team")).toEqual([]);
  });
});

describe("summarizeChanges", () => {
  function plan(entries: [PanelId, PanelSize][], columns?: GridColumns): PackedPlan<PanelId> {
    const base: PackedPlan<PanelId> = { placements: entries.map(([id, size]) => ({ id, size })) };
    if (!columns) return base;
    const r = reflow(entries.map(([id, size]) => item(id, size)), columns);
    return { ...base, grid: { columns, cells: r.cells } };
  }

  it("lists each change once, in the documented order", () => {
    const before = plan([["inbox", "standard"], ["calendar", "standard"], ["tasks", "standard"], ["invoices", "standard"]], 4);
    const after = plan([["calendar", "standard"], ["inbox", "hero"], ["invoices", "compact"], ["team", "standard"]], 4);
    expect(summarizeChanges(before, after)).toEqual({ added: ["team"], docked: ["tasks"], moved: ["calendar"], grew: ["inbox"], shrank: ["invoices"] });
  });

  it("does not call a resize a move", () => {
    const before = plan([["inbox", "standard"], ["calendar", "standard"]], 4);
    const after = plan([["calendar", "standard"], ["inbox", "standard"]], 2);
    expect(summarizeChanges(before, after)).toEqual({ added: [], docked: [], moved: [], grew: [], shrank: [] });
  });

  it("compares membership and size only without a grid", () => {
    const before = plan([["inbox", "standard"], ["calendar", "standard"]]);
    const after = plan([["calendar", "standard"], ["inbox", "large"]]);
    expect(summarizeChanges(before, after)).toEqual({ added: [], docked: [], moved: [], grew: ["inbox"], shrank: [] });
  });
});

describe("packGrid: a panel the user made bigger (userResized)", () => {
  const NINE: PanelId[] = ["inbox", "calendar", "tasks", "invoices", "clients", "projects", "analytics", "team", "notes"];
  /** The canvas after `id` is made bigger: every card standard, `id` the hero. */
  function grow(ids: PanelId[], id: PanelId, columns: GridColumns, extra: (p: PanelId) => Partial<PackItem> = () => ({})) {
    const previous = reflow(
      ids.map((p) => item(p, "standard", extra(p))),
      columns,
    ).cells;
    const items = ids.map((p) => item(p, p === id ? "hero" : "standard", extra(p)));
    const result = packGrid({ items, columns, previous, hold: [], userResized: id });
    return { previous, items, result };
  }

  /**
   * The rule: top edge fixed, the new cell contains the old one, nothing
   * overlaps or leaves, a card before it and not in its way never moves
   * later (it keeps its cell, or moves up into a hole), and no orphaned hole
   * is left.
   */
  function expectGrowth(previous: Partial<Record<PanelId, GridCell>>, items: PackItem[], result: PackResult, id: PanelId, columns: GridColumns): void {
    expectValid(result, items, columns);
    const before = previous[id]!;
    const now = at(result, id);
    expect({ w: now.w, h: now.h }).toEqual(spanOf("hero", columns));
    expect(now.row).toBe(before.row);
    expect(now.col).toBeLessThanOrEqual(before.col);
    expect(now.col + now.w).toBeGreaterThanOrEqual(before.col + before.w);
    expect(now.row + now.h).toBeGreaterThanOrEqual(before.row + before.h);
    for (const it of items) {
      const prev = previous[it.id];
      if (it.id === id || !prev) continue;
      // Before it and not in its way: it keeps its cell, or moves up into a hole, never later. (Cards after it may move down with it.)
      if (startsBefore(prev, now) && !cellsOverlap(prev, now)) expect(startsBefore(prev, at(result, it.id)), it.id).toBe(false);
    }
    expect(fillableHoles(result, items, columns, heldOf(items, [], [id]))).toEqual([]);
  }

  it("4 columns, first column: grows right and down, and the cards in its way glide to the next free cells", () => {
    const { previous, items, result } = grow(NINE, "inbox", 4);
    expectGrowth(previous, items, result, "inbox", 4);
    expect(at(result, "inbox")).toEqual({ col: 0, row: 0, w: 2, h: 4 });
    // Not in its way: they keep their cells.
    for (const id of ["tasks", "invoices", "analytics", "team", "notes"] as PanelId[]) expect(at(result, id)).toEqual(previous[id]);
    // In its way: the next free cells after it, no hole left.
    expect(topLeft(at(result, "calendar"))).toEqual({ col: 1, row: 4 });
    expect(topLeft(at(result, "clients"))).toEqual({ col: 2, row: 4 });
    expect(topLeft(at(result, "projects"))).toEqual({ col: 3, row: 4 });
    expect(result.rows).toBe(6);
    expect(result.anchored).toBe(true);
  });

  it("4 columns, last column: grows one column left instead, keeping its top edge", () => {
    const { previous, items, result } = grow(NINE, "invoices", 4);
    expectGrowth(previous, items, result, "invoices", 4);
    expect(at(result, "invoices")).toEqual({ col: 2, row: 0, w: 2, h: 4 });
    // Before it and not in its way.
    expect(at(result, "inbox")).toEqual(previous.inbox);
    expect(at(result, "calendar")).toEqual(previous.calendar);
    // Tasks starts before it but is in its way, so it moves after it.
    expect(topLeft(at(result, "tasks"))).toEqual({ col: 1, row: 4 });
    expect(topLeft(at(result, "analytics"))).toEqual({ col: 2, row: 4 });
    expect(topLeft(at(result, "team"))).toEqual({ col: 3, row: 4 });
  });

  it("4 columns, middle: grows right and down around the cards before it", () => {
    const { previous, items, result } = grow(NINE, "calendar", 4);
    expectGrowth(previous, items, result, "calendar", 4);
    expect(at(result, "calendar")).toEqual({ col: 1, row: 0, w: 2, h: 4 });
    expect(at(result, "inbox")).toEqual(previous.inbox);
    for (const id of ["invoices", "clients", "team", "notes"] as PanelId[]) expect(at(result, id)).toEqual(previous[id]);
  });

  it("4 columns: a compact tile grows too, wherever it is in the plan order, and a pinned card in its way still moves", () => {
    const previous = reflow([item("invoices", "hero"), item("clients"), item("inbox"), item("tasks", "compact"), item("team", "compact"), item("notes", "compact")], 4).cells;
    // The plan order is not the screen order (the policy ranks Tasks first now).
    const items = [item("tasks", "hero"), item("invoices", "hero"), item("clients"), item("inbox"), item("team", "compact", { pinned: true }), item("notes", "compact")];
    const result = packGrid({ items, columns: 4, previous, hold: [], userResized: "tasks" });
    expectGrowth(previous, items, result, "tasks", 4);
    expect(at(result, "tasks")).toEqual({ col: 2, row: 2, w: 2, h: 4 });
    // Team is pinned but in its way, so it moves after it; the cards above stay.
    expect(startsBefore(at(result, "team"), at(result, "tasks"))).toBe(false);
    for (const id of ["invoices", "clients", "inbox"] as PanelId[]) expect(at(result, id)).toEqual(previous[id]);
  });

  it("2 columns, left column: grows across and down; nothing is docked, the canvas grows", () => {
    const { previous, items, result } = grow(OVERVIEW, "inbox", 2);
    expectGrowth(previous, items, result, "inbox", 2);
    expect(at(result, "inbox")).toEqual({ col: 0, row: 0, w: 2, h: 4 });
    expect(at(result, "clients")).toEqual(previous.clients);
    expect(at(result, "projects")).toEqual(previous.projects);
    expect(Object.keys(result.cells)).toHaveLength(OVERVIEW.length);
  });

  it("2 columns, right column: grows one column left, keeping its top edge", () => {
    const { previous, items, result } = grow(OVERVIEW, "calendar", 2);
    expectGrowth(previous, items, result, "calendar", 2);
    expect(at(result, "calendar")).toEqual({ col: 0, row: 0, w: 2, h: 4 });
    const second = grow(OVERVIEW, "invoices", 2);
    expectGrowth(second.previous, second.items, second.result, "invoices", 2);
    expect(at(second.result, "invoices")).toEqual({ col: 0, row: 2, w: 2, h: 4 });
    expect(at(second.result, "inbox")).toEqual(second.previous.inbox);
    expect(at(second.result, "calendar")).toEqual(second.previous.calendar);
  });

  it("1 column: simply gets taller, and the cards after it move down in their order", () => {
    const previous = reflow(OVERVIEW.map((p) => item(p)), 1).cells;
    // The plan order is not the list order (Tasks ranks first now); the list keeps its order anyway.
    const items = [item("tasks", "hero"), ...OVERVIEW.filter((p) => p !== "tasks").map((p) => item(p))];
    const result = packGrid({ items, columns: 1, previous, hold: [], userResized: "tasks" });
    expectGrowth(previous, items, result, "tasks", 1);
    expect(at(result, "tasks")).toEqual({ col: 0, row: 6, w: 1, h: 5 });
    expect(at(result, "inbox")).toEqual(previous.inbox);
    expect(at(result, "calendar")).toEqual(previous.calendar);
    const rows = (["invoices", "clients", "projects"] as PanelId[]).map((id) => at(result, id).row);
    expect(rows).toEqual([11, 14, 17]);
  });

  it("made smaller again: keeps its top-left, and the cards that moved for it slide back up with no hole left", () => {
    const { result: grown } = grow(NINE, "inbox", 4);
    // Whatever the plan order says, it keeps its top-left.
    const items = [...NINE.filter((p) => p !== "inbox"), "inbox" as const].map((p) => item(p));
    const r = packGrid({ items, columns: 4, previous: grown.cells, hold: [], userResized: "inbox" });
    expectValid(r, items, 4);
    expect(at(r, "inbox")).toEqual({ col: 0, row: 0, w: 1, h: 2 });
    // Two full rows of four, then one card: no hole before the last card.
    expect(r.rows).toBe(6);
    const taken = (Object.values(r.cells) as GridCell[]).filter((c) => c.row < 4).reduce((n, c) => n + c.w * Math.min(c.h, 4 - c.row), 0);
    expect(taken).toBe(16);
  });

  it("follows the rule over random canvases at 1, 2, and 4 columns", () => {
    for (const columns of [1, 2, 4] as GridColumns[]) {
      for (let seed = 1; seed <= 200; seed++) {
        const r = rng(seed * 104729 + columns);
        const items = shuffle(r, [...PANEL_IDS])
          .slice(0, 2 + Math.floor(r() * 8))
          .map((id) => item(id, pick(r, SIZES), { pinned: r() < 0.2 }));
        const previous = reflow(items, columns).cells;
        const target = pick(r, items).id;
        const next = items.map((it) => (it.id === target ? { ...it, size: "hero" as const } : it));
        const result = packGrid({ items: next, columns, previous, hold: [], userResized: target });
        expectGrowth(previous, next, result, target, columns);
        // And back: the top-left stays and the cell fits inside the big one.
        const back = items.map((it) => (it.id === target ? { ...it, size: "standard" as const } : it));
        const shrunk = packGrid({ items: back, columns, previous: result.cells, hold: [], userResized: target });
        expectValid(shrunk, back, columns);
        expect(topLeft(at(shrunk, target))).toEqual(topLeft(at(result, target)));
      }
    }
  });
});

describe("packGrid: no orphaned holes (the reported layout)", () => {
  // After working in Calendar, the user opened Marcus Webb's "Annual report
  // numbers" in Inbox, at 4 columns. The older packer left Calendar a hero
  // at the top left, Invoices alone at (3, 0), Projects at (2, 2), Inbox (the
  // anchor) at (0, 4), Tasks at (1, 4), and Clients at (0, 6), with holes at
  // (2, 0), (3, 2), (2..3, 4), and (1..3, 6), and kept them in the next round.
  const reported: Partial<Record<PanelId, GridCell>> = {
    calendar: { col: 0, row: 0, w: 2, h: 4 },
    invoices: { col: 3, row: 0, w: 1, h: 2 },
    projects: { col: 2, row: 2, w: 1, h: 2 },
    inbox: { col: 0, row: 4, w: 1, h: 2 },
    tasks: { col: 1, row: 4, w: 1, h: 2 },
    clients: { col: 0, row: 6, w: 1, h: 2 },
  };
  const items = [
    item("calendar", "hero", { linked: true, priority: 0.9 }),
    item("inbox", "standard", { anchor: true, priority: 0.8 }),
    item("tasks", "standard", { linked: true, priority: 0.5 }),
    item("clients", "standard", { linked: true, priority: 0.4 }),
    item("invoices", "standard", { priority: 0.3 }),
    item("projects", "standard", { priority: 0.3 }),
  ];

  it("closes every hole a later card fits, and keeps the anchor still", () => {
    const r = packGrid({ items, columns: 4, previous: reported, hold: [] });
    expectValid(r, items, 4);
    expect(at(r, "inbox")).toEqual(reported.inbox);
    expect(at(r, "calendar")).toEqual(reported.calendar);
    expect(fillableHoles(r, items, 4, heldOf(items))).toEqual([]);
    // Four standard cards fill columns 2 and 3 beside the hero; Inbox is the last card.
    for (const id of ["invoices", "projects", "tasks", "clients"] as PanelId[]) expect(at(r, id).col).toBeGreaterThanOrEqual(2);
    expect(r.rows).toBe(6);
  });

  it("with gathering, the linked panels take the free slots nearest the anchor in that closed-up layout", () => {
    const r = packGrid({ items, columns: 4, previous: reported, hold: [], gather: ["calendar", "tasks", "clients"] });
    expectValid(r, items, 4);
    expect(at(r, "inbox")).toEqual(reported.inbox);
    // The hero is too big to gather; it stays, right above the anchor.
    expect(at(r, "calendar")).toEqual(reported.calendar);
    expect(topLeft(at(r, "tasks"))).toEqual({ col: 2, row: 2 });
    expect(topLeft(at(r, "clients"))).toEqual({ col: 2, row: 0 });
    expect(fillableHoles(r, items, 4, heldOf(items, [], ["tasks", "clients"]))).toEqual([]);
    expect(r.rows).toBe(6);
  });
});

describe("packGrid: gathering linked panels next to the anchor (Arrange linked panels by next step)", () => {
  // The user's case: Priya Nair's message in Inbox links Invoices, Tasks, and Clients, in that next-step order.
  const order: PanelId[] = ["invoices", "tasks", "clients"];
  function round(columns: GridColumns, anchor: PanelId, gather: PanelId[], extra: (id: PanelId) => Partial<PackItem> = () => ({})) {
    const previous = reflow(OVERVIEW.map((id) => item(id)), columns).cells;
    const items = OVERVIEW.map((id) => item(id, "standard", { anchor: id === anchor, linked: gather.includes(id), ...extra(id) }));
    const result = packGrid({ items, columns, previous, hold: [], gather });
    expectValid(result, items, columns);
    expect(at(result, anchor)).toEqual(previous[anchor]);
    return { previous, items, result };
  }

  it("4 columns: the next step right beside the anchor, then directly below, then the nearest other cell; the cards in the way take the cells left", () => {
    const { result } = round(4, "inbox", order);
    expect(topLeft(at(result, "invoices"))).toEqual({ col: 1, row: 0 });
    expect(topLeft(at(result, "tasks"))).toEqual({ col: 0, row: 2 });
    expect(topLeft(at(result, "clients"))).toEqual({ col: 1, row: 2 });
    expect(topLeft(at(result, "calendar"))).toEqual({ col: 3, row: 0 });
    expect(topLeft(at(result, "projects"))).toEqual({ col: 2, row: 0 });
    expect(result.rows).toBe(4);
  });

  it("4 columns: another order puts another panel first", () => {
    const { result } = round(4, "inbox", ["tasks", "invoices", "clients"]);
    expect(topLeft(at(result, "tasks"))).toEqual({ col: 1, row: 0 });
    expect(topLeft(at(result, "invoices"))).toEqual({ col: 0, row: 2 });
  });

  it("4 columns, anchor in the last column: the linked panels close in from the left, and no hole opens", () => {
    const { items, result } = round(4, "invoices", ["inbox", "tasks", "clients"]);
    // Right of it is the edge; below it would leave a hole, so the next step takes the cell to its left.
    expect(topLeft(at(result, "inbox"))).toEqual({ col: 2, row: 0 });
    expect(topLeft(at(result, "tasks"))).toEqual({ col: 1, row: 0 });
    expect(fillableHoles(result, items, 4, heldOf(items, [], ["inbox", "tasks", "clients"]))).toEqual([]);
  });

  it("2 columns: beside, below, then diagonal", () => {
    const { result } = round(2, "inbox", order);
    expect(topLeft(at(result, "invoices"))).toEqual({ col: 1, row: 0 });
    expect(topLeft(at(result, "tasks"))).toEqual({ col: 0, row: 2 });
    expect(topLeft(at(result, "clients"))).toEqual({ col: 1, row: 2 });
  });

  it("1 column: right under the anchor, in order, the rest after them", () => {
    const { result } = round(1, "inbox", order);
    expect((["inbox", "invoices", "tasks", "clients", "calendar", "projects"] as PanelId[]).map((id) => at(result, id).row)).toEqual([0, 3, 6, 9, 12, 15]);
  });

  it("never moves a pinned, held, or bigger card for it, and moves nothing when the panels are already gathered", () => {
    // Calendar holds the cell right beside Inbox and stays put, so the next step takes the next best cell: directly below.
    const pinned = round(4, "inbox", order, (id) => ({ pinned: id === "calendar" }));
    expect(at(pinned.result, "calendar")).toEqual(pinned.previous.calendar);
    expect(topLeft(at(pinned.result, "invoices"))).toEqual({ col: 0, row: 2 });
    const bigger = round(4, "inbox", order, (id) => ({ bigger: id === "calendar" }));
    expect(at(bigger.result, "calendar")).toEqual(bigger.previous.calendar);
    expect(topLeft(at(bigger.result, "invoices"))).toEqual({ col: 0, row: 2 });
    const previous = reflow(OVERVIEW.map((id) => item(id)), 4).cells;
    const items = OVERVIEW.map((id) => item(id, "standard", { anchor: id === "inbox", linked: order.includes(id) }));
    const held = packGrid({ items, columns: 4, previous, hold: ["calendar"], gather: order });
    expect(at(held, "calendar")).toEqual(previous.calendar);
    expect(topLeft(at(held, "invoices"))).toEqual({ col: 0, row: 2 });
    // Gathered once, the next round with the same order changes nothing.
    const first = round(4, "inbox", order).result;
    expect(topLeft(at(first, "invoices"))).toEqual({ col: 1, row: 0 });
    const again = packGrid({ items, columns: 4, previous: first.cells, hold: [], gather: order });
    expect(again.cells).toEqual(first.cells);
  });

  it("gathers only when asked: without gather it is the older packing exactly", () => {
    const previous = reflow(OVERVIEW.map((id) => item(id)), 4).cells;
    const items = OVERVIEW.map((id) => item(id, "standard", { anchor: id === "inbox", linked: order.includes(id) }));
    expect(packGrid({ items, columns: 4, previous, hold: [], gather: order }).cells).not.toEqual(previous);
    expect(packGrid({ items, columns: 4, previous, hold: [] }).cells).toEqual(previous);
  });

  it("keeps the next-step order over random canvases: an earlier linked panel of the same shape is never farther from the anchor than a later one", () => {
    for (const columns of [1, 2, 4] as GridColumns[]) {
      for (let seed = 1; seed <= 200; seed++) {
        const r = rng(seed * 7_907 + columns);
        const ids = shuffle(r, [...PANEL_IDS]).slice(0, 4 + Math.floor(r() * 6));
        const previous = reflow(ids.map((id) => item(id, r() < 0.2 ? "compact" : "standard")), columns).cells;
        const anchor = pick(r, ids);
        const linked = shuffle(r, ids.filter((id) => id !== anchor)).slice(0, 1 + Math.floor(r() * 3));
        const items = ids.map((id) => item(id, previous[id]!.h === 1 ? "compact" : "standard", { anchor: id === anchor, linked: linked.includes(id), pinned: !linked.includes(id) && id !== anchor && r() < 0.1 }));
        const result = packGrid({ items, columns, previous, hold: [], gather: linked });
        expectValid(result, items, columns);
        expect(topLeft(at(result, anchor))).toEqual(topLeft(previous[anchor]!));
        expect(fillableHoles(result, items, columns, heldOf(items, [], linked))).toEqual([]);
        for (const it of items) if (it.pinned) expect(at(result, it.id)).toEqual(previous[it.id]);
        // Gap to the anchor, screen-weighted as the packer weighs it (a column counts as 3 row tracks).
        const a = at(result, anchor);
        const gap = (c: GridCell) =>
          Math.max(0, c.col - (a.col + a.w), a.col - (c.col + c.w)) * 3 + Math.max(0, c.row - (a.row + a.h), a.row - (c.row + c.h));
        // In next-step order, an earlier linked panel is never farther than a later one of the same shape.
        for (let i = 0; i < linked.length; i++) {
          for (let j = i + 1; j < linked.length; j++) {
            const ci = at(result, linked[i]);
            const cj = at(result, linked[j]);
            if (ci.w === cj.w && ci.h === cj.h) expect(gap(ci), `seed ${seed} ${linked[i]} before ${linked[j]}`).toBeLessThanOrEqual(gap(cj));
          }
        }
      }
    }
  });
});
