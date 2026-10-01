/**
 * The grid packer: placements in plan order in, explicit cells out, with the
 * anchor's top-left held still. Code, not CSS auto-flow, decides where every
 * card goes, so a relayout can promise that the panel the user just worked in
 * does not move. Pure: no DOM, no store, no clock.
 *
 * The algorithm and the reasons for these numbers are in
 * docs/anchored-relayout.md ("Grid packer").
 */
import type { PanelId } from "../../shared/catalog.ts";
import type { ChangeSummary, GridCell, GridColumns, LayoutPlan, PanelSize } from "../../shared/types.ts";
import type { PackInput, PackItem, PackResult } from "./contract.ts";

export type { GridCell, GridColumns } from "../../shared/types.ts";
export type { PackInput, PackItem, PackResult } from "./contract.ts";

/**
 * Viewport widths where the canvas gets 2 and 4 columns. Must match the
 * min-width media queries on .fl-grid in src/index.css, or the engine packs
 * for a column count the CSS does not show.
 */
export const GRID_BREAKPOINTS = { twoColumns: 768, fourColumns: 1280 } as const;

/**
 * Span per size and column count, in tracks. One row track is the 104 px
 * --row unit (half a standard cell), the same spans the CSS uses today, so a
 * compact tile stays one short row and can stack beside a taller card. In
 * whole cells that is hero 2x2, large 2x1, standard 1x1, compact half of 1x1;
 * on one column every panel is one track wide and hero is the tallest.
 */
export const CELL_SPANS: Record<GridColumns, Record<PanelSize, { w: number; h: number }>> = {
  4: { hero: { w: 2, h: 4 }, large: { w: 2, h: 2 }, standard: { w: 1, h: 2 }, compact: { w: 1, h: 1 } },
  2: { hero: { w: 2, h: 4 }, large: { w: 2, h: 2 }, standard: { w: 1, h: 2 }, compact: { w: 1, h: 1 } },
  1: { hero: { w: 1, h: 5 }, large: { w: 1, h: 3 }, standard: { w: 1, h: 3 }, compact: { w: 1, h: 1 } },
};

export function spanOf(size: PanelSize, columns: GridColumns): { w: number; h: number } {
  return CELL_SPANS[columns][size];
}

/** Column count for a viewport width in CSS px (the UI can also use matchMedia with GRID_BREAKPOINTS). */
export function columnsForWidth(width: number): GridColumns {
  if (width >= GRID_BREAKPOINTS.fourColumns) return 4;
  if (width >= GRID_BREAKPOINTS.twoColumns) return 2;
  return 1;
}

/** True when two cells share at least one track. */
export function cellsOverlap(a: GridCell, b: GridCell): boolean {
  return a.col < b.col + b.w && b.col < a.col + a.w && a.row < b.row + b.h && b.row < a.row + a.h;
}

/** True when a cell lies inside a grid of `columns` tracks (rows are unbounded downward). */
export function cellFits(cell: GridCell, columns: GridColumns): boolean {
  return (
    Number.isInteger(cell.col) &&
    Number.isInteger(cell.row) &&
    cell.w >= 1 &&
    cell.h >= 1 &&
    cell.col >= 0 &&
    cell.row >= 0 &&
    cell.col + cell.w <= columns
  );
}


/**
 * How many row tracks one column track counts as when the packer looks for
 * the free spot nearest the anchor. A column is 330 to 480 px wide on the 2
 * and 4 column canvas and a row track is 104 px, so without this a card two
 * columns away would count as closer than one a short row below.
 */
export const COLUMN_TRACK_WEIGHT = 3;

/** Size order for summarizeChanges (the same order as SIZE_RANK in policy.ts, kept here to avoid an import cycle). */
const SIZE_ORDER: Record<PanelSize, number> = { compact: 0, standard: 1, large: 2, hero: 3 };

/** True when `c` starts before `a` in reading order: on an earlier row, or on the same row to its left. */
export function startsBefore(c: Pick<GridCell, "col" | "row">, a: Pick<GridCell, "col" | "row">): boolean {
  return c.row < a.row || (c.row === a.row && c.col < a.col);
}

function sameCell(a: GridCell | undefined, b: GridCell | undefined): boolean {
  return !!a && !!b && a.col === b.col && a.row === b.row && a.w === b.w && a.h === b.h;
}

/** A span that fits the column count (a hero is one track wide on phones). */
function spanFor(size: PanelSize, columns: GridColumns): { w: number; h: number } {
  const s = spanOf(size, columns);
  return { w: Math.min(s.w, columns), h: s.h };
}

/**
 * The cell of a panel the user resized by hand (PackInput.userResized): the
 * same top edge, from its old left edge to the right when the new span fits
 * there, else shifted left just enough (one column for a one-wide card in
 * the last column, or in a 2-column grid's right column); never upward. So
 * a panel made bigger contains its old cell, and one made smaller keeps its
 * top-left.
 */
function userResizedCell(prev: GridCell, span: { w: number; h: number }, columns: GridColumns): GridCell {
  return { col: Math.max(0, Math.min(prev.col, columns - span.w)), row: prev.row, w: span.w, h: span.h };
}

/** The cells placed so far in one packGrid call. */
class Occupancy {
  private readonly cells: GridCell[] = [];

  /** True when `cell` overlaps nothing placed, ignoring `except` (a card testing its own new spot). */
  free(cell: GridCell, except?: GridCell): boolean {
    return this.cells.every((c) => c === except || !cellsOverlap(c, cell));
  }

  add(cell: GridCell): void {
    this.cells.push(cell);
  }

  replace(old: GridCell, next: GridCell): void {
    const i = this.cells.indexOf(old);
    if (i >= 0) this.cells[i] = next;
    else this.cells.push(next);
  }

  remove(cell: GridCell): void {
    const i = this.cells.indexOf(cell);
    if (i >= 0) this.cells.splice(i, 1);
  }

  /** First row below every placed cell (0 when empty). */
  bottom(): number {
    return this.cells.reduce((m, c) => Math.max(m, c.row + c.h), 0);
  }
}

/**
 * The first spot in reading order, from `fromRow` down, where a card of
 * `span` fits and `allowed` agrees. Rows are unbounded, so every search ends:
 * below the last placed card every row is free.
 */
function firstFree(occ: Occupancy, span: { w: number; h: number }, columns: GridColumns, fromRow: number, allowed: (c: GridCell) => boolean): GridCell {
  const last = Math.max(occ.bottom(), fromRow) + 1;
  for (let row = Math.max(0, fromRow); row <= last; row++) {
    for (let col = 0; col + span.w <= columns; col++) {
      const cell = { col, row, w: span.w, h: span.h };
      if (allowed(cell) && occ.free(cell)) return cell;
    }
  }
  return { col: 0, row: last, w: span.w, h: span.h };
}

/** Screen-weighted gap between two rectangles, 0 when they touch or overlap. */
function gapBetween(a: GridCell, b: GridCell): number {
  const dx = Math.max(0, b.col - (a.col + a.w), a.col - (b.col + b.w));
  const dy = Math.max(0, b.row - (a.row + a.h), a.row - (b.row + b.h));
  return dx * COLUMN_TRACK_WEIGHT + dy;
}

/** Where `b` sits from the anchor `a`: 0 right, 1 below, 2 left, 3 diagonal. The brief's order for linked cards. */
function sideOf(a: GridCell, b: GridCell): number {
  const rowsOverlap = b.row < a.row + a.h && a.row < b.row + b.h;
  const colsOverlap = b.col < a.col + a.w && a.col < b.col + b.w;
  if (b.col >= a.col + a.w && rowsOverlap) return 0;
  if (b.row >= a.row + a.h && colsOverlap) return 1;
  if (b.col + b.w <= a.col && rowsOverlap) return 2;
  return 3;
}

/**
 * The free spot nearest the anchor for a linked card: smallest gap, then
 * right, below, left, diagonal, then lower row, then lower column. Cells
 * below the last placed card only get farther, so the search stops there.
 */
function nearestTo(anchor: GridCell, occ: Occupancy, span: { w: number; h: number }, columns: GridColumns, allowed: (c: GridCell) => boolean): GridCell {
  const last = Math.max(occ.bottom(), anchor.row + 1);
  let best: GridCell | null = null;
  let bestKey: number[] = [];
  for (let row = anchor.row; row <= last; row++) {
    for (let col = 0; col + span.w <= columns; col++) {
      const cell = { col, row, w: span.w, h: span.h };
      if (!allowed(cell) || !occ.free(cell)) continue;
      const key = [gapBetween(anchor, cell), sideOf(anchor, cell), row, col];
      if (!best || lexLess(key, bestKey)) {
        best = cell;
        bestKey = key;
      }
    }
  }
  return best ?? firstFree(occ, span, columns, anchor.row, allowed);
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

/**
 * Where `c` sits from the anchor `a` when gathering linked panels
 * (PackInput.gather): 0 on its rows to its right, 1 directly below, 2 on its
 * rows to its left, 3 directly above, 4 anywhere else. The order the user
 * asked for: the same row right beside the anchor first, then below, then
 * left, then above.
 */
function gatherSide(a: GridCell, c: GridCell): number {
  const rowsOverlap = c.row < a.row + a.h && a.row < c.row + c.h;
  const colsOverlap = c.col < a.col + a.w && a.col < c.col + c.w;
  if (c.col >= a.col + a.w && rowsOverlap) return 0;
  if (c.row >= a.row + a.h && colsOverlap) return 1;
  if (c.col + c.w <= a.col && rowsOverlap) return 2;
  if (c.row + c.h <= a.row && colsOverlap) return 3;
  return 4;
}

/**
 * How good a cell is for a linked panel, smaller first: the gap to the
 * anchor (screen-weighted), then the side (gatherSide), then how well it
 * lines up with the anchor's top (right and left) or left edge (below and
 * above), then row, then column.
 */
function gatherKey(a: GridCell, c: GridCell): number[] {
  const side = gatherSide(a, c);
  const align = side === 0 || side === 2 ? Math.abs(c.row - a.row) : side === 1 || side === 3 ? Math.abs(c.col - a.col) : Math.abs(c.row - a.row) + Math.abs(c.col - a.col);
  return [gapBetween(a, c), side, align, c.row, c.col];
}

/**
 * Panels an anchored round must not change: every panel before the anchor in
 * `order`, plus every panel whose previous cell starts before the anchor's
 * top-left in reading order (on a row above it, or on its top row to its
 * left). The policy keeps their membership, order, and size; packGrid keeps
 * their cells. Returns [] when the anchor has no previous cell.
 */
export function lockedPanels(order: PanelId[], previous: Partial<Record<PanelId, GridCell>>, anchor: PanelId): PanelId[] {
  const a = previous[anchor];
  if (!a) return [];
  const at = order.indexOf(anchor);
  const ids = [...new Set([...order, ...(Object.keys(previous) as PanelId[])])];
  return ids.filter((id) => {
    if (id === anchor) return false;
    const i = order.indexOf(id);
    const c = previous[id];
    return (at >= 0 && i >= 0 && i < at) || (!!c && startsBefore(c, a));
  });
}

/**
 * Pack placements into explicit cells. See docs/anchored-relayout.md ("Grid packer").
 *
 * Anchored round (a work anchor with a usable previous cell):
 *   1. Held, locked, and pinned panels keep their previous cells.
 *   2. The anchor keeps its top-left. It takes its new span only when that
 *      covers the old one, fits, and covers only free or vacated cells (no
 *      fixed card and no card that stays); else it keeps its span.
 *   3. Other panels on the canvas before (stayers) keep their top-left with
 *      their new span when that is free.
 *   4. Linked newcomers take a cell a leaving card vacated, nearest the
 *      anchor, else the free spot nearest the anchor.
 *   5. Stayers whose spot was taken (a neighbor grew) flow forward to the
 *      first free spot from their previous row.
 *   6. Other newcomers take the first vacated cell, else the first free spot
 *      after the anchor.
 *   7. Stayers float up in their column into holes that departures left.
 *   8. Stayers slide left in their row into holes that are still open.
 * Nothing new lands before the anchor in reading order. On one column the
 * canvas is a list, so linked newcomers go right under the anchor and the
 * cards after them move down, instead of landing at the far end of the page;
 * the anchor may grow there too, pushing the cards after it down.
 * Locked cards that are not held or pinned may shrink in place (a quiet
 * panel before the anchor): its top-left stays, so the anchor cannot move.
 *
 * Every call then ends with two passes (see finish()):
 *   - Backfill: no orphaned holes. While an empty spot has a card later in
 *     reading order that fits it, the next such card moves there, unless it
 *     stays put (the anchor, held, pinned or bigger cards, a card the user
 *     just resized). A spot next to the anchor takes a linked panel first.
 *   - Gathering (PackInput.gather, "Arrange linked panels by next step"):
 *     the linked panels, in next-step order, trade cells with the block of
 *     cards nearest the anchor that has exactly their shape, so the filled
 *     area stays the same and no hole opens (see gatherSwaps).
 * Both may change cards before the anchor: every card has an explicit
 * cell, so a card that moves before it cannot push it (on one column the
 * rows are explicit too).
 *
 * Unanchored round: held panels keep their cells. "reflow" packs everything
 * else from the top in plan order (the CSS "row dense" rule); "settle" keeps
 * cards in place when their order did not change (see settle()).
 *
 * A panel the user made bigger or smaller (PackInput.userResized) replaces
 * both: it keeps its top edge and the cards in its way move (see userResized()).
 */
export function packGrid(input: PackInput): PackResult {
  const { columns } = input;
  const seen = new Set<PanelId>();
  const items = input.items.filter((it) => !seen.has(it.id) && seen.add(it.id));
  const index = new Map(items.map((it, i) => [it.id, i]));
  const usable = (id: PanelId): GridCell | undefined => {
    const c = input.previous?.[id];
    return c && cellFits(c, columns) ? c : undefined;
  };
  const hold = new Set(input.hold);
  const cells: Partial<Record<PanelId, GridCell>> = {};
  const keptSize: PanelId[] = [];
  const occ = new Occupancy();
  const put = (id: PanelId, cell: GridCell) => {
    cells[id] = cell;
    occ.add(cell);
  };
  /** Keep a previous cell exactly. The caller shows the previous size when the span changed. */
  const keep = (it: PackItem, prev: GridCell): boolean => {
    if (!occ.free(prev)) return false;
    put(it.id, { ...prev });
    const span = spanFor(it.size, columns);
    if (span.w !== prev.w || span.h !== prev.h) keptSize.push(it.id);
    return true;
  };
  const byId = new Map(items.map((it) => [it.id, it]));
  /**
   * Cards the last passes (backfill, gathering) never move: the anchor, held
   * cards (the pointer's, or every card after a manual edit under it),
   * pinned and bigger panels (the front group), and a panel the user just resized.
   */
  const staysPut = (id: PanelId): boolean => {
    const it = byId.get(id);
    return !it || it.anchor || hold.has(id) || it.pinned || it.bigger === true || id === input.userResized;
  };
  /** The result, after the last passes: backfill, and in an anchored round that links panels, gathering then backfill again. */
  const finish = (anchored: boolean, gathers = false): PackResult => {
    backfill(new Set(), gathers);
    if (gathers && input.gather?.length) backfill(gatherSwaps(), false);
    return { cells, keptSize, rows: occ.bottom(), anchored };
  };
  const byPlan = (a: PackItem, b: PackItem) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0);
  const byPrevCell = (a: PackItem, b: PackItem) => {
    const ca = usable(a.id)!;
    const cb = usable(b.id)!;
    return ca.row - cb.row || ca.col - cb.col || byPlan(a, b);
  };
  /** A stayer's cell at its previous top-left with its new span, shifted left if it would pass the last column. */
  const inPlace = (it: PackItem): GridCell => {
    const prev = usable(it.id)!;
    const span = spanFor(it.size, columns);
    return { col: Math.min(prev.col, columns - span.w), row: prev.row, w: span.w, h: span.h };
  };
  /** Previous cells of cards that left this round: the first place a newcomer may go. */
  const onNext = new Set(items.map((it) => it.id));
  const vacated = (Object.entries(input.previous ?? {}) as [PanelId, GridCell | undefined][])
    .filter(([id, c]) => !onNext.has(id) && c && cellFits(c, columns))
    .map(([, c]) => c!)
    .sort((a, b) => a.row - b.row || a.col - b.col);
  /** Stayers slide into holes: up in their column, then (with `left`) left in their row, never past `allowed` (gravity, not a jump). */
  const slide = (ids: PanelId[], allowed: (c: GridCell) => boolean, minRow: number, left = true) => {
    const byCell = (a: PanelId, b: PanelId) => cells[a]!.row - cells[b]!.row || cells[a]!.col - cells[b]!.col;
    const move = (id: PanelId, step: (c: GridCell) => GridCell | null) => {
      const c = cells[id]!;
      let best = c;
      for (let next = step(c); next && allowed(next) && occ.free(next, c); next = step(next)) best = next;
      if (best !== c) {
        occ.replace(c, best);
        cells[id] = best;
      }
    };
    for (const id of [...ids].sort(byCell)) move(id, (c) => (c.row - 1 >= minRow ? { ...c, row: c.row - 1 } : null));
    if (left) for (const id of [...ids].sort(byCell)) move(id, (c) => (c.col > 0 ? { ...c, col: c.col - 1 } : null));
  };

  // A panel the user made bigger or smaller takes the place of the anchor rules.
  const resizedItem = input.userResized ? items.find((it) => it.id === input.userResized) : undefined;
  const resizedPrev = resizedItem ? usable(resizedItem.id) : undefined;
  if (resizedItem && resizedPrev) return userResized(resizedItem, resizedPrev);

  const anchorItem = items.find((it) => it.anchor);
  const anchorPrev = anchorItem ? usable(anchorItem.id) : undefined;

  if (!anchorItem || !anchorPrev) {
    for (const it of items) {
      const prev = hold.has(it.id) ? usable(it.id) : undefined;
      if (prev) keep(it, prev);
    }
    if (input.unanchored === "settle" && settle()) return finish(false);
    for (const it of items) {
      if (!cells[it.id]) put(it.id, firstFree(occ, spanFor(it.size, columns), columns, 0, () => true));
    }
    return finish(false);
  }

  /**
   * An automatic round without an anchor: when the cards that stay are in
   * the same reading order as before, each keeps its top-left, newcomers
   * fill holes (vacated cells first), and stayers float into what is left.
   * Returns false, having placed nothing, when the order changed: then the
   * round rebalances by reflow.
   */
  function settle(): boolean {
    const stayers = items.filter((it) => !cells[it.id] && usable(it.id));
    const byPrev = [...stayers].sort(byPrevCell);
    if (stayers.some((it, i) => it.id !== byPrev[i].id)) return false;
    const displaced: PackItem[] = [];
    for (const it of stayers) {
      const cell = inPlace(it);
      if (occ.free(cell)) put(it.id, cell);
      else displaced.push(it);
    }
    for (const it of displaced) put(it.id, firstFree(occ, spanFor(it.size, columns), columns, usable(it.id)!.row, () => true));
    for (const it of items) {
      if (cells[it.id]) continue;
      const span = spanFor(it.size, columns);
      put(it.id, firstVacated(span, () => true) ?? firstFree(occ, span, columns, 0, () => true));
    }
    slide(
      stayers.filter((it) => !hold.has(it.id)).map((it) => it.id),
      () => true,
      0,
    );
    return true;
  }

  /**
   * A panel the user made bigger or smaller (PackInput.userResized). It takes
   * userResizedCell. Cards before it in reading order that are not in its
   * way keep their cells, and so do pinned cards not in its way (on 2 and 4
   * columns); other cards not in its way keep their top-left; cards in its
   * way flow forward to the first free spot after it, from their old row;
   * then the cards that may move float up into holes, and a hole still open
   * before the last card takes the last card that fits it (one card moves,
   * nothing cascades), never a spot before it. On one column the canvas is
   * a list, so the cards after it follow it in their old order (down when it
   * grew, up when it shrank). Every card gets a cell: the canvas grows
   * instead of docking anything.
   */
  function userResized(it: PackItem, prev: GridCell): PackResult {
    const R = userResizedCell(prev, spanFor(it.size, columns), columns);
    put(it.id, R);
    const after = (c: GridCell) => !startsBefore(c, R);
    const others = items.filter((x) => x !== it);
    const withCell = others.filter((x) => usable(x.id)).sort(byPrevCell);
    const inWay = (x: PackItem) => cellsOverlap(usable(x.id)!, R);
    const stays = (x: PackItem) => !inWay(x) && (startsBefore(usable(x.id)!, R) || (x.pinned && columns > 1));
    for (const x of withCell) if (stays(x)) keep(x, usable(x.id)!);
    const movable = withCell.filter((x) => !stays(x));
    const newcomers = others.filter((x) => !usable(x.id));
    if (columns === 1) {
      let row = R.row + R.h;
      for (const x of [...movable, ...newcomers]) {
        const cell = firstFree(occ, spanFor(x.size, columns), columns, row, after);
        put(x.id, cell);
        row = cell.row + cell.h;
      }
      return finish(true);
    }
    const displaced: PackItem[] = [];
    for (const x of movable) {
      const cell = inPlace(x);
      if (!inWay(x) && after(cell) && occ.free(cell)) put(x.id, cell);
      else displaced.push(x);
    }
    for (const x of displaced) put(x.id, firstFree(occ, spanFor(x.size, columns), columns, usable(x.id)!.row, after));
    for (const x of newcomers) put(x.id, firstFree(occ, spanFor(x.size, columns), columns, R.row, after));
    // Float up (gravity), so a card that moved for it comes back when it shrinks.
    slide(
      movable.map((x) => x.id),
      after,
      R.row,
      false,
    );
    // No avoidable hole: the last card that fits a hole before it moves there.
    // Every move goes earlier in reading order, so this ends.
    const earlier = (c: GridCell): GridCell | null => {
      for (let row = R.row; row <= c.row; row++) {
        for (let col = 0; col + c.w <= columns; col++) {
          const cell = { col, row, w: c.w, h: c.h };
          if (!startsBefore(cell, c)) return null;
          if (after(cell) && occ.free(cell, c)) return cell;
        }
      }
      return null;
    };
    const last = (a: PackItem, b: PackItem) => cells[b.id]!.row - cells[a.id]!.row || cells[b.id]!.col - cells[a.id]!.col;
    for (let moved = true; moved; ) {
      moved = false;
      for (const x of [...movable].sort(last)) {
        const c = cells[x.id]!;
        const spot = earlier(c);
        if (!spot) continue;
        occ.replace(c, spot);
        cells[x.id] = spot;
        moved = true;
        break;
      }
    }
    return finish(true);
  }

  /** The first vacated cell (in reading order) where a card of `span` fits now. */
  function firstVacated(span: { w: number; h: number }, allowed: (c: GridCell) => boolean): GridCell | null {
    for (const v of vacated) {
      const cell = { col: Math.min(v.col, columns - span.w), row: v.row, w: span.w, h: span.h };
      if (allowed(cell) && occ.free(cell)) return cell;
    }
    return null;
  }

  // 1. Fixed: held, locked (before the anchor in order or on screen), and pinned.
  const anchorIndex = index.get(anchorItem.id) ?? 0;
  const fixed: { it: PackItem; cell: GridCell }[] = [];
  for (const [i, it] of items.entries()) {
    if (it === anchorItem) continue;
    const prev = usable(it.id);
    if (prev && (hold.has(it.id) || it.pinned || i < anchorIndex || startsBefore(prev, anchorPrev))) fixed.push({ it, cell: prev });
  }
  const fixedIds = new Set(fixed.map((f) => f.it.id));
  const stayers = items.filter((it) => it !== anchorItem && !fixedIds.has(it.id) && usable(it.id)).sort(byPrevCell);

  // 2. The anchor: same top-left, grows only right and down, and only into
  // free or vacated cells, so no card is pushed out of the way. On one
  // column the canvas is a list and growing pushes the cards after it down.
  const want = spanFor(anchorItem.size, columns);
  const grown: GridCell = { col: anchorPrev.col, row: anchorPrev.row, w: want.w, h: want.h };
  const clear = (c: GridCell) => !cellsOverlap(c, grown);
  const canGrow =
    want.w >= anchorPrev.w &&
    want.h >= anchorPrev.h &&
    cellFits(grown, columns) &&
    fixed.every((f) => clear(f.cell)) &&
    (columns === 1 || stayers.every((it) => clear(usable(it.id)!) && clear(inPlace(it))));
  const A: GridCell = canGrow ? grown : { ...anchorPrev };
  put(anchorItem.id, A);
  if (!canGrow && (want.w !== anchorPrev.w || want.h !== anchorPrev.h)) keptSize.push(anchorItem.id);
  for (const f of fixed) {
    // A locked card (not held, not pinned) may shrink in place, a quiet one before the anchor: its top-left stays.
    const span = spanFor(f.it.size, columns);
    const shrinks = !hold.has(f.it.id) && !f.it.pinned && span.w <= f.cell.w && span.h <= f.cell.h && (span.w < f.cell.w || span.h < f.cell.h);
    if (shrinks && occ.free(f.cell)) put(f.it.id, { col: f.cell.col, row: f.cell.row, w: span.w, h: span.h });
    else keep(f.it, f.cell);
  }

  /** Nothing new may start before the anchor in reading order. */
  const after = (c: GridCell) => !startsBefore(c, A);
  const newcomers = items.filter((it) => !cells[it.id] && !usable(it.id));
  const linked = newcomers.filter((it) => it.linked).sort((a, b) => b.priority - a.priority || byPlan(a, b));
  const others = newcomers.filter((it) => !it.linked);

  if (columns === 1) {
    // A list: linked cards right under the anchor, then everything else in its old order.
    let row = A.row + A.h;
    for (const it of [...linked, ...stayers, ...others]) {
      const cell = firstFree(occ, spanFor(it.size, columns), columns, row, after);
      put(it.id, cell);
      row = cell.row + cell.h;
    }
    return finish(true, true);
  }

  // 3. Stayers keep their top-left when it is still free.
  const displaced: PackItem[] = [];
  for (const it of stayers) {
    const cell = inPlace(it);
    if (after(cell) && occ.free(cell)) put(it.id, cell);
    else displaced.push(it);
  }
  // 4. Linked newcomers next to the anchor, in a cell a leaving card vacated when one is near.
  const nearKey = (c: GridCell) => [gapBetween(A, c), sideOf(A, c), c.row, c.col];
  for (const it of linked) {
    const span = spanFor(it.size, columns);
    let best: GridCell | null = null;
    for (const v of vacated) {
      const cell = { col: Math.min(v.col, columns - span.w), row: v.row, w: span.w, h: span.h };
      if (after(cell) && occ.free(cell) && (!best || lexLess(nearKey(cell), nearKey(best)))) best = cell;
    }
    put(it.id, best ?? nearestTo(A, occ, span, columns, after));
  }
  // 5. Displaced stayers flow forward from where they were.
  for (const it of displaced) put(it.id, firstFree(occ, spanFor(it.size, columns), columns, usable(it.id)!.row, after));
  // 6. Everything else after the anchor, into a vacated cell first.
  for (const it of others) {
    const span = spanFor(it.size, columns);
    put(it.id, firstVacated(span, after) ?? firstFree(occ, span, columns, A.row, after));
  }
  // 7 and 8. Stayers slide into holes that are still open: up, then left, never before the anchor.
  slide(
    stayers.map((it) => it.id),
    after,
    A.row,
  );
  return finish(true, true);

  /**
   * No orphaned holes. While an empty spot has a card later in reading order
   * that fits it and may move (not staysPut, not in `keep`), the next such
   * card moves there. With `linkedFirst`, a spot next to the anchor takes a
   * linked panel (PackInput.gather, in its order) first. Every move goes
   * earlier in reading order, so this ends. A spot no later card fits (a
   * half-row gap under a compact tile) stays.
   */
  function backfill(keep: ReadonlySet<PanelId>, linkedFirst: boolean): void {
    const anchorId = items.find((it) => it.anchor)?.id;
    const A = anchorId ? cells[anchorId] : undefined;
    const linked = linkedFirst ? [...new Set(input.gather ?? [])] : [];
    const byCell = (a: PanelId, b: PanelId) => cells[a]!.row - cells[b]!.row || cells[a]!.col - cells[b]!.col;
    for (let moved = true; moved; ) {
      moved = false;
      const movers = (Object.keys(cells) as PanelId[]).filter((id) => !staysPut(id) && !keep.has(id)).sort(byCell);
      const bottom = occ.bottom();
      scan: for (let row = 0; row < bottom; row++) {
        for (let col = 0; col < columns; col++) {
          if (!occ.free({ col, row, w: 1, h: 1 })) continue;
          const spotFor = (id: PanelId): GridCell => ({ col, row, w: cells[id]!.w, h: cells[id]!.h });
          const fits = movers.filter((id) => {
            const spot = spotFor(id);
            return startsBefore(spot, cells[id]!) && cellFits(spot, columns) && occ.free(spot, cells[id]);
          });
          if (fits.length === 0) continue;
          const near = A ? linked.find((id) => fits.includes(id) && gapBetween(A, spotFor(id)) === 0) : undefined;
          const pick = near ?? fits[0];
          const spot = spotFor(pick);
          occ.replace(cells[pick]!, spot);
          cells[pick] = spot;
          moved = true;
          break scan;
        }
      }
    }
  }

  /**
   * Gathering (PackInput.gather): each linked panel, in next-step order,
   * trades cells with the block nearest the anchor (gatherKey) that has
   * exactly its shape: every card in the block lies inside it and together
   * they cover it, so the cards swap places and the filled area stays the
   * same (backfill has closed the holes; this opens none). It keeps its cell
   * when that is at least as good, so a round that finds the panels gathered
   * moves nothing. The anchor, cards that stay put, panels already gathered,
   * and linked panels bigger than a standard card (a hero would move half
   * the canvas) never move for it. Returns the gathered panels, which the
   * backfill after it leaves where they are.
   */
  function gatherSwaps(): Set<PanelId> {
    const done = new Set<PanelId>();
    const anchorId = items.find((it) => it.anchor)?.id;
    const A = anchorId ? cells[anchorId] : undefined;
    if (!A) return done;
    const area = (c: GridCell) => c.w * c.h;
    const std = area({ col: 0, row: 0, ...spanFor("standard", columns) });
    const inside = (c: GridCell, t: GridCell) => c.col >= t.col && c.col + c.w <= t.col + t.w && c.row >= t.row && c.row + c.h <= t.row + t.h;
    const ids = () => Object.keys(cells) as PanelId[];
    for (const id of new Set(input.gather ?? [])) {
      const from = cells[id];
      if (!from || staysPut(id) || area(from) > std) continue;
      done.add(id);
      let best: { cell: GridCell; block: PanelId[] } | null = null;
      let bestKey = gatherKey(A, from);
      const bottom = occ.bottom();
      for (let row = 0; row + from.h <= bottom; row++) {
        for (let col = 0; col + from.w <= columns; col++) {
          const t = { col, row, w: from.w, h: from.h };
          if (cellsOverlap(t, A) || cellsOverlap(t, from)) continue;
          const key = gatherKey(A, t);
          if (!lexLess(key, bestKey)) continue;
          const block = ids().filter((o) => cellsOverlap(cells[o]!, t));
          if (block.length === 0 || block.some((o) => staysPut(o) || done.has(o) || !inside(cells[o]!, t))) continue;
          if (block.reduce((sum, o) => sum + area(cells[o]!), 0) !== area(t)) continue;
          best = { cell: t, block };
          bestKey = key;
        }
      }
      if (!best) continue;
      const dx = from.col - best.cell.col;
      const dy = from.row - best.cell.row;
      occ.remove(from);
      for (const o of best.block) occ.remove(cells[o]!);
      put(id, best.cell);
      for (const o of best.block) {
        const c = cells[o]!;
        put(o, { col: c.col + dx, row: c.row + dy, w: c.w, h: c.h });
      }
    }
    return done;
  }
}

/**
 * What happened to each panel's cell between two packed plans (see
 * ChangeSummary for the order of the checks). Plans without a grid compare
 * membership and size only, and so does a pair packed for different column
 * counts (a resize is not a move).
 */
export function summarizeChanges(previous: LayoutPlan, next: LayoutPlan): ChangeSummary {
  const out: ChangeSummary = { added: [], docked: [], moved: [], grew: [], shrank: [] };
  const before = new Map(previous.placements.map((p) => [p.id, p]));
  const onNext = new Set(next.placements.map((p) => p.id));
  const sameColumns = !!previous.grid && !!next.grid && previous.grid.columns === next.grid.columns;
  for (const p of next.placements) {
    const old = before.get(p.id);
    if (!old) out.added.push(p.id);
    else if (SIZE_ORDER[p.size] > SIZE_ORDER[old.size]) out.grew.push(p.id);
    else if (SIZE_ORDER[p.size] < SIZE_ORDER[old.size]) out.shrank.push(p.id);
    else if (sameColumns && !sameCell(previous.grid!.cells[p.id], next.grid!.cells[p.id])) out.moved.push(p.id);
  }
  for (const p of previous.placements) if (!onNext.has(p.id)) out.docked.push(p.id);
  return out;
}

/** A summary that lists nothing: a resize, or a round whose cells did not change. */
export function emptySummary(): ChangeSummary {
  return { added: [], docked: [], moved: [], grew: [], shrank: [] };
}
