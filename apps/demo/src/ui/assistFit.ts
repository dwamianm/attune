/**
 * The row under the command bar (AssistRow.tsx) holds the meeting prep card,
 * the Done card or Up next, and the suggested next steps on one line of a
 * fixed height. This file is its pure part: the priority order, and which
 * cards show in full, as compact pills, or in the "+N" list when they do not
 * all fit.
 *
 * Why a fixed line that collapses rather than one that wraps: the row sits
 * above the canvas, and a second line would push the panel the user just
 * clicked down (the calm relayout keeps it still, docs/anchored-relayout.md).
 * So lower cards shrink to a pill (icon, short label, key hint, and a
 * dismiss) first; then the "Next step" label goes; then the most
 * time-sensitive card, always first and never a pill, takes its shorter form
 * (the prep card shows the count of things to handle instead of the whole
 * line); and what still has no room waits one click away in "+N", in full.
 * Every card stays in sight as long as a pill can hold it, and the keys work
 * in every state.
 */

/** What a slot on the row holds. "label" is "Next step" before the suggestions; "hint" is the empty state in its place. */
export type AssistKind = "prep" | "taskDone" | "upNext" | "upNextDone" | "suggestion" | "label" | "hint";

export interface AssistSlot {
  id: string;
  kind: AssistKind;
}

export interface AssistSlotInput {
  prep: boolean;
  /** Focus aid 2's Done card. It takes the Up next slot. */
  taskDone: boolean;
  upNext: boolean;
  /** Up next's completion line ("All overdue invoices have a reminder."). */
  upNextDone: boolean;
  /** The suggestions in plan order. */
  suggestions: { id: string; primary: boolean }[];
  /** An empty state to show when there are no suggestions (the examples, or "Suggestions show up here"). */
  hint: boolean;
}

/**
 * The slots in priority order, highest first: a meeting starting soon, then
 * the Done card (or Up next, or its completion line: one card shares that
 * slot), then the primary suggestion, then the subtle ones in plan order,
 * then the "Next step" label (or the empty state), which is only decoration.
 */
export function assistSlots(input: AssistSlotInput): AssistSlot[] {
  const out: AssistSlot[] = [];
  if (input.prep) out.push({ id: "prep", kind: "prep" });
  if (input.taskDone) out.push({ id: "task-done", kind: "taskDone" });
  else if (input.upNext) out.push({ id: "up-next", kind: "upNext" });
  else if (input.upNextDone) out.push({ id: "up-next-done", kind: "upNextDone" });
  const primary = input.suggestions.filter((s) => s.primary);
  const subtle = input.suggestions.filter((s) => !s.primary);
  for (const s of [...primary, ...subtle]) out.push({ id: s.id, kind: "suggestion" });
  if (input.suggestions.length > 0) out.push({ id: "label", kind: "label" });
  else if (input.hint) out.push({ id: "hint", kind: "hint" });
  return out;
}

export type FitMode = "full" | "compact" | "more";

export interface FitItem {
  id: string;
  /** Natural width of the full card, in px. */
  full: number;
  /** Width of the compact form (a pill; for the first item, its shorter card), or null when there is none: it goes from full straight to "+N". */
  compact: number | null;
  /** Decoration (the label, the empty state): hidden instead of listed in "+N", and not counted there. */
  decor?: boolean;
}

export interface FitOptions {
  /** The row's width. */
  available: number;
  /** The space between two things on the row. */
  gap: number;
  /** The "+N" button's width. */
  more: number;
  /** Extra room a less collapsed state needs before the row goes back to it, so a pixel's change never flips it back and forth. */
  slack?: number;
}

export interface RowFit {
  /** What the collapse steps were built from (the ids and which have a pill), to tell whether `step` of an earlier fit means the same thing. */
  key: string;
  /** How far down the collapse steps this is: 0 is everything in full. */
  step: number;
  modes: Record<string, FitMode>;
  /** The ids listed in "+N", highest priority first (decoration left out). */
  more: string[];
  /**
   * The first item is "compact" but has well over its shorter form's width to
   * spare, so it shows its full card cut short instead (its last words give
   * way), rather than leave the room empty.
   */
  cut: boolean;
}

/** Extra room the row needs before it shows a card in fuller form again. */
export const FIT_SLACK_PX = 16;
/** The first card shows in full, cut short, instead of its shorter form when the row leaves it at least this much more than the shorter form. */
export const FIRST_CUT_MIN_PX = 120;

function hasPill(item: FitItem): boolean {
  return item.compact !== null && item.compact < item.full;
}

/**
 * The collapse steps, from everything in full to only the first item: the
 * lowest priority item takes its pill first, then the next lowest, and so on
 * up to the second; then decoration goes; then the first item takes its
 * shorter form; then the lowest goes into "+N", then the next lowest, and so
 * on. The first item never goes into "+N": in the last step it gives up
 * words (truncates) instead.
 */
export function collapseSteps(items: FitItem[]): FitMode[][] {
  const modes: FitMode[] = items.map(() => "full");
  const steps: FitMode[][] = [modes.slice()];
  const push = (i: number, mode: FitMode) => {
    modes[i] = mode;
    steps.push(modes.slice());
  };
  for (let i = items.length - 1; i >= 1; i--) if (hasPill(items[i])) push(i, "compact");
  for (let i = items.length - 1; i >= 1; i--) if (items[i].decor) push(i, "more");
  if (items.length > 0 && hasPill(items[0])) push(0, "compact");
  for (let i = items.length - 1; i >= 1; i--) if (!items[i].decor) push(i, "more");
  return steps;
}

/** The width a step takes on the row, gaps and the "+N" button included. */
export function stepWidth(items: FitItem[], modes: FitMode[], opts: Pick<FitOptions, "gap" | "more">): number {
  let width = 0;
  let parts = 0;
  let listed = false;
  items.forEach((item, i) => {
    const mode = modes[i];
    if (mode === "more") {
      if (!item.decor) listed = true;
      return;
    }
    width += mode === "compact" && item.compact !== null ? item.compact : item.full;
    parts++;
  });
  if (listed) {
    width += opts.more;
    parts++;
  }
  return width + Math.max(0, parts - 1) * opts.gap;
}

function fitKey(items: FitItem[]): string {
  return items.map((i) => `${i.id}${hasPill(i) ? "+" : ""}${i.decor ? "~" : ""}`).join("|");
}

/**
 * The fullest step that fits the row. With `previous` (the fit on screen, for
 * the same items), the row keeps its step while it still fits and only goes
 * back to a fuller one once that fits with `slack` to spare.
 */
export function fitRow(items: FitItem[], opts: FitOptions, previous?: RowFit | null): RowFit {
  const steps = collapseSteps(items);
  const last = steps.length - 1;
  // The last step always fits: the first item truncates.
  const fits = (s: number, room: number): boolean => s === last || stepWidth(items, steps[s], opts) <= room;
  const fullest = (room: number): number => {
    for (let s = 0; s < last; s++) if (fits(s, room)) return s;
    return last;
  };
  const key = fitKey(items);
  const loose = fullest(opts.available);
  let step = loose;
  if (previous && previous.key === key && previous.step > loose && previous.step <= last) {
    // A fuller step fits, but only just: stay until it fits with slack to spare.
    const strict = fullest(opts.available - (opts.slack ?? 0));
    step = strict < previous.step ? strict : fits(previous.step, opts.available) ? previous.step : loose;
  }
  const modes: Record<string, FitMode> = {};
  const more: string[] = [];
  items.forEach((item, i) => {
    const mode = steps[step][i];
    modes[item.id] = mode;
    if (mode === "more" && !item.decor) more.push(item.id);
  });
  let cut = false;
  const first = items[0];
  if (first && first.compact !== null && steps[step][0] === "compact") {
    // The room the first item has: the row less everything else on it.
    const room = opts.available - (stepWidth(items, steps[step], opts) - first.compact);
    cut = room >= first.compact + FIRST_CUT_MIN_PX;
  }
  return { key, step, modes, more, cut };
}
