/**
 * The place step: every plan goes through it before the canvas shows it.
 * It packs explicit cells with the anchor held still (packGrid in grid.ts),
 * keeps the card under the pointer from moving for a while, shows the old
 * size of any card whose cell was kept, re-marks what changed from the
 * cells, and counts the round so the UI plays one staged relayout per round
 * (choreography.ts). Pure: the app passes the state and its clocks in.
 *
 * Why a separate step: the policy decides membership, order, and sizes;
 * this step decides cells, which depend on what is on screen right now
 * (the column count, the pointer, the anchor's current cell). The demo's
 * store calls it for every plan (apps/demo/src/engine/store.ts, place()).
 */
import { emptySummary, packGrid, summarizeChanges, type GridCell, type GridColumns, type PackItem, type PackResult } from "./grid.ts";
import type { AnchorRef, CoreSuggestion, LayoutPlan } from "./plan.ts";

type Plan<P extends string, S extends CoreSuggestion, K extends string> = LayoutPlan<P, S, K>;

/** The packer's items for a plan: its placements in order, the anchor marked, linked and bigger panels flagged. */
export function packItems<P extends string, S extends CoreSuggestion, K extends string>(plan: Plan<P, S, K>, anchorPanel: P | null): PackItem<P>[] {
  return plan.placements.map((p) => ({
    id: p.id,
    size: p.size,
    priority: p.priority,
    pinned: p.pinned,
    anchor: p.id === anchorPanel,
    linked: Boolean(p.relation),
    ...(p.bigger ? { bigger: true } : {}),
  }));
}

/** Dense flow in plan order: exactly what the CSS shows for a plan without cells. */
export function reflowCells<P extends string, S extends CoreSuggestion, K extends string>(plan: Plan<P, S, K>, columns: GridColumns): PackResult<P> {
  return packGrid({ items: packItems(plan, null), columns, previous: null, hold: [] });
}

/**
 * The cells the canvas shows now, for `columns`: the plan's own, or the
 * dense flow for a plan without cells (the first plan, a reset, adaptive
 * just turned on). Null right after a column change.
 */
export function shownCells<P extends string, S extends CoreSuggestion, K extends string>(plan: Plan<P, S, K>, columns: GridColumns): Partial<Record<P, GridCell>> | null {
  if (plan.grid) return plan.grid.columns === columns ? plan.grid.cells : null;
  return reflowCells(plan, columns).cells;
}

/** The plan with the cells it shows for `columns`, so the policy can tell what is before the anchor. */
export function withGrid<P extends string, S extends CoreSuggestion, K extends string>(plan: Plan<P, S, K>, columns: GridColumns): Plan<P, S, K> {
  if (plan.grid?.columns === columns) return plan;
  const r = reflowCells(plan, columns);
  return { ...plan, grid: { columns, cells: r.cells, rows: r.rows, anchored: false } };
}

/** True when two cells are the same rectangle (and both exist). */
export function cellsEqual(a: GridCell | undefined, b: GridCell | undefined): boolean {
  return !!a && !!b && a.col === b.col && a.row === b.row && a.w === b.w && a.h === b.h;
}

/** Membership, a size, a cell, a relation, or the anchor changed: the UI plays a new round. */
export function roundChanged<P extends string, S extends CoreSuggestion, K extends string>(current: Plan<P, S, K>, prevCells: Partial<Record<P, GridCell>> | null, next: Plan<P, S, K>): boolean {
  if ((current.anchor?.at ?? null) !== (next.anchor?.at ?? null)) return true;
  if (current.placements.length !== next.placements.length) return true;
  const before = new Map(current.placements.map((p) => [p.id, p]));
  return next.placements.some((p) => {
    const old = before.get(p.id);
    return !old || old.size !== p.size || Boolean(old.relation) !== Boolean(p.relation) || !cellsEqual(prevCells?.[p.id], next.grid?.cells[p.id]);
  });
}

export interface PlaceOptions<P extends string = string> {
  /** A manual edit: every card already on the canvas keeps its cell, so only the edited one changes. */
  holdAll?: boolean;
  /** An automatic round: the card under the pointer waits to move. Commands, undo, and switches skip this. */
  pointerHolds?: boolean;
  /** Undo: reuse the plan's own cells when they were packed for this column count. */
  keepGrid?: boolean;
  /** Ignore the anchor and reflow: a pin moves to the front, where the user asked for it. */
  reflow?: boolean;
  /** Re-mark the per-panel decisions too (default), or only the card badges (undo keeps its own line). */
  decisions?: boolean;
  /** The panel the user just made bigger or smaller: it keeps its top edge and the cards in its way move. */
  userResized?: P;
}

export interface PlaceInput<P extends string, S extends CoreSuggestion, K extends string> extends PlaceOptions<P> {
  /** The plan on screen. */
  current: Plan<P, S, K>;
  /** The plan to place. */
  next: Plan<P, S, K>;
  columns: GridColumns;
  /** Pack explicit cells. False: the plan keeps the CSS flow, and a plan that had cells drops them. */
  packed: boolean;
  /** The live anchor. A work anchor holds still; a command anchor's round reflows from the top. */
  anchor: AnchorRef<P, K> | null;
  /** The card under the pointer when pointer holds may apply: on the canvas and not the anchor. */
  pointerPanel: P | null;
  /** Whether a move hold may still apply to that card now (its cap has not run out). Called only when it matters. */
  pointerMoveOpen: (panel: P) => boolean;
  /** The linked panels in next-step order, to gather next to the work anchor. Called only for an anchored, automatic round. */
  gather?: (anchor: AnchorRef<P, K>) => P[] | undefined;
  /** The highest round issued so far, so rounds keep counting up after a reset. */
  roundSeq: number;
  /** Re-marks the per-panel changes from the cells (Policy.remarkPanels). */
  remark: (previous: Plan<P, S, K>, next: Plan<P, S, K>, opts: { previousCells: Partial<Record<P, GridCell>> | null; decisions: boolean }) => Plan<P, S, K>;
}

/** Place `next` on the canvas. `heldMove` is the pointer's card when this plan kept it from moving. */
export function placePlan<P extends string, S extends CoreSuggestion, K extends string>(input: PlaceInput<P, S, K>): { plan: Plan<P, S, K>; heldMove: P | null } {
  const { current, next, columns } = input;
  if (!input.packed) {
    if (!next.grid) return { plan: next, heldMove: null };
    // An edit of a packed plan going back to the CSS flow: drop its old
    // cells, in a round with nothing to stage.
    const { grid: _grid, ...flow } = next;
    void _grid;
    return { plan: { ...flow, changeSummary: emptySummary<P>(), round: Math.max(current.round ?? 0, input.roundSeq) + 1 }, heldMove: null };
  }
  const prevCells = shownCells(current, columns);
  const live = input.anchor;
  const anchor = input.reflow ? null : live && live.source !== "command" ? live : null;
  const anchorPanel = anchor && next.placements.some((p) => p.id === anchor.panel) ? anchor.panel : null;
  const items = packItems(next, anchorPanel);
  const hold = input.holdAll ? next.placements.map((p) => p.id).filter((id) => prevCells?.[id]) : [];
  // Without a work anchor, an automatic round settles cards in place; a
  // command's hero and a pin still go to the front, where the user asked.
  const unanchored = input.reflow || live?.source === "command" ? "reflow" : "settle";
  // A round that links panels to the click gathers them next to it, the next step first (not a manual edit).
  const gather = anchor && anchorPanel && !input.holdAll && !input.userResized ? input.gather?.(anchor) : undefined;
  const pack = (h: P[]): PackResult<P> =>
    packGrid({
      items,
      columns,
      previous: prevCells,
      hold: h,
      unanchored,
      ...(input.userResized ? { userResized: input.userResized } : {}),
      ...(gather ? { gather } : {}),
    });
  let result: PackResult<P>;
  let heldMove: P | null = null;
  const ownGrid = next.grid;
  if (input.keepGrid && ownGrid?.columns === columns && next.placements.every((p) => ownGrid.cells[p.id])) {
    result = { cells: ownGrid.cells, keptSize: [], rows: ownGrid.rows, anchored: false };
  } else {
    result = pack(hold);
    const ptr = input.pointerHolds ? input.pointerPanel : null;
    if (ptr && !hold.includes(ptr) && prevCells?.[ptr] && result.cells[ptr] && input.pointerMoveOpen(ptr)) {
      const wasSize = current.placements.find((p) => p.id === ptr)?.size;
      const newSize = next.placements.find((p) => p.id === ptr)?.size;
      if (!cellsEqual(prevCells[ptr], result.cells[ptr]) || wasSize !== newSize) {
        hold.push(ptr);
        result = pack(hold);
        heldMove = ptr;
      }
    }
  }
  // A card that kept its cell shows the size that fits it.
  const oldSize = new Map(current.placements.map((p) => [p.id, p.size]));
  const kept = new Set([...result.keptSize, ...hold]);
  const placements = next.placements.map((p) => {
    const was = oldSize.get(p.id);
    return kept.has(p.id) && was && was !== p.size ? { ...p, size: was } : p;
  });
  let plan: Plan<P, S, K> = { ...next, placements, grid: { columns, cells: result.cells, rows: result.rows, anchored: result.anchored } };
  plan = input.remark(current, plan, { previousCells: prevCells, decisions: input.decisions !== false });
  const changed = roundChanged(current, prevCells, plan);
  const shown: Plan<P, S, K> = prevCells ? { ...current, grid: { columns, cells: prevCells, rows: 0, anchored: false } } : current;
  plan = {
    ...plan,
    changeSummary: changed ? summarizeChanges(shown, plan) : (current.changeSummary ?? emptySummary<P>()),
    round: changed ? Math.max(current.round ?? 0, input.roundSeq) + 1 : (current.round ?? 0),
  };
  return { plan, heldMove };
}
