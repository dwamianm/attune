/**
 * The layout policy: judgments in, a layout plan out. Pure: no DOM, no
 * store, no clock except `input.now`.
 *
 * createPolicy binds the policy to an app once: its catalog, how it counts
 * recent use, its suggestions and the words for them, how it names linked
 * records, its help panel, and its habit words. It returns computePlan (the
 * full round) and the plan edits that do not come from judgments (a command
 * that asks for a panel, a pin, "Make bigger", undo marks).
 *
 * The rules, in the order computePlan applies them: help and mode and
 * density (policy.ts), the panels that must stay (pins, the help panel, the
 * anchor and the panels locked before it, the pointer's card, linked panels,
 * the link cues, bigger panels, panels in use), then the rest by priority
 * with a dock threshold and its band, an incumbent bonus, and minimum stays,
 * then the order with hysteresis (the front group first, the anchor's
 * neighbors kept), then sizes from the mode's slots (never shrinking the
 * panel under the user's hands, the anchor only growing, linked panels at
 * least LINKED_MIN_SIZE, bigger panels at BIGGER_SIZE, quiet panels as the
 * summary tile where the calm relayout allows), then the decisions in
 * words. The numbers were tuned in the demo app (apps/demo/README.md,
 * "Policy rules").
 */
import { UNCLEAR_GOAL, type Catalog } from "./catalog.ts";
import { lockedPanels, startsBefore, type GridCell, type PanelSize } from "./grid.ts";
import type { CoreJudgments } from "./judgments.ts";
import { LAYOUT_MODE_DEFS, type LayoutMode } from "./layoutModes.ts";
import type { AnchorRef, CoreSuggestion, LayoutPlan, PanelPlacement, PanelRelation, RelatedRecord } from "./plan.ts";
import {
  DENSITY_CAPS,
  helpLevel,
  openHeldPanels,
  pickDensity,
  pickMode,
  protectedPanels,
  scorePanels,
  SIZE_RANK,
  sizeHeldPanels,
  SLOTS,
  userResizedPanels,
  type BlendWeights,
  type Decision,
  type Density,
  type PanelScore,
} from "./policy.ts";
import { QUIET_BELOW, QUIET_SIZE, quietReason } from "./quiet.ts";
import type { SignalEventLike } from "./signals.ts";
import { p2 } from "./words.ts";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** A panel the user sent to the dock stays there this long unless pinned. */
export const DISMISS_HOLD_MS = 3 * 60_000;
/** Unpinned panels below this priority go to the dock. */
export const DOCK_BELOW_PRIORITY = 0.18;
/**
 * Hysteresis around the dock threshold: a panel on the canvas stays until it
 * falls below 0.18 - 0.04, and a docked one needs 0.18 + 0.04 to come back.
 * Jev's run-to-run drift on relevance moves priority by a few hundredths, and
 * without a band Team came and went seven times in a minute.
 */
export const DOCK_MARGIN = 0.04;
/**
 * A panel the policy brought onto the canvas stays at least this long, and a
 * panel the policy sent to the dock stays there at least this long, unless the
 * user uses it, opens it, or a command asks for it. 30 s is about the time a
 * person needs to notice a new card and decide whether they want it.
 */
export const MEMBERSHIP_HOLD_MS = 30_000;
/** A lower panel must beat the panel above it by more than this to swap places. */
export const ORDER_SWAP_MARGIN = 0.08;
/** A panel already on the canvas keeps its seat unless a newcomer beats it by this much. */
export const INCUMBENT_BONUS = 0.08;
/** Never leave fewer panels than this on the canvas. */
export const MIN_CANVAS_PANELS = 2;
/**
 * Where the Guide goes when the policy opens it: the second slot (after any
 * pins), at standard size. Last on the canvas, a struggling user never saw it;
 * as the hero it would push aside the work they are stuck on.
 */
export const HELP_PANEL_SLOT = 1;
/**
 * Moving this many places, relative to the panels around it, counts as
 * promoted or demoted in the change feed. 1, because in the dense grid a
 * one-slot move already puts a card in another row or column. Moves are found
 * against the longest run of panels that kept their order, so a panel entering
 * or leaving does not report every panel after it as moved.
 */
export const MOVE_PLACES = 1;
/** Relevance (score / max) at or above this reads as "central" in reasons. */
export const CENTRAL_RELEVANCE = 0.6;
/** Usage at or above this reads as "a lot" in reasons. */
export const HEAVY_USAGE = 0.5;
/**
 * Added to the priority of the top LINKED_PANELS_MAX panels that hold records
 * linked to the anchor. It lifts a panel Jev rates a little useful past the
 * 0.22 join line; a panel Jev rates useless stays below it, so Jev decides.
 */
export const LINK_PRIORITY_BOOST = 0.12;
/** A linked panel is shown at least this big: compact tiles show no rows, so a tint could not show. */
export const LINKED_MIN_SIZE: PanelSize = "standard";
/** "Make bigger" means the hero size (2 by 2 cells, taller on one column), the biggest card there is, not full screen. */
export const BIGGER_SIZE: PanelSize = "hero";
/** The placement reason of a panel the user made bigger: the user decided its size, not Jev. */
export const BIGGER_REASON = "Made bigger by you";
/**
 * Where "Make smaller" goes when the panel was already the hero before the
 * user made it bigger (and its slot is a hero too): the usual card, so
 * "Make smaller" always makes it smaller.
 */
export const RESTORE_FALLBACK_SIZE: PanelSize = "standard";
/** The reason of a quiet panel the user clicked into: it is back because they chose it, not because Jev rates it. */
export const UNQUIET_REASON = "Brought back by you";

/**
 * Most panels that get a relation (tag, tint, link line, and the priority
 * boost) per anchor. Three lines are easy to follow; more read as noise, and
 * one click must not flood the canvas.
 */
export const LINKED_PANELS_MAX = 3;

// ---------------------------------------------------------------------------
// Input and configuration
// ---------------------------------------------------------------------------

/** A learned habit, as the policy reads it: the chance of going to each panel next. An app's habit type adds its own fields. */
export interface HabitLike<P extends string = string> {
  next: Partial<Record<P, number>>;
}

export interface PolicyInput<
  P extends string = string,
  G extends string = string,
  A extends string = string,
  S extends CoreSuggestion<A> = CoreSuggestion<A>,
  K extends string = string,
  H extends HabitLike<P> = HabitLike<P>,
> {
  judgments: CoreJudgments<P, G, A>;
  version: number;
  previous: LayoutPlan<P, S, K>;
  events: readonly SignalEventLike<string, P>[];
  now: number;
  weights: BlendWeights;
  pinned: P[];
  dismissed: Partial<Record<P, number>>;
  focusedPanel: P | null;
  /** Layout modes judged in the last few rounds, newest last (for hysteresis). */
  recentModes: LayoutMode[];
  /**
   * Densities judged confidently in the last few rounds, newest last,
   * including this round. When given, density changes only after two rounds
   * agree. Omitted: the one-round rule.
   */
  recentDensities?: Density[];
  /** An explicit user preference takes precedence over inferred expertise. */
  density?: Density;
  /** Changes the user undid. Not repeated while the judgments stay the same. */
  avoid?: { mode?: LayoutMode; add?: P[]; dock?: P[] };
  /**
   * The live anchor. With a work anchor on the canvas, the policy keeps the
   * anchor and every locked panel (lockedPanels in grid.ts, read from
   * previous.grid) on the canvas at their size and order, never shrinks the
   * anchor, and puts every newcomer after the anchor. Absent: no anchor rules.
   */
  anchor?: AnchorRef<P, K> | null;
  /** Records linked to the anchor, per panel (the app joins its data). */
  linked?: Partial<Record<P, RelatedRecord<K>[]>>;
  /** Panels that must stay on the canvas this round, for example the one under the pointer. */
  hold?: P[];
  /**
   * The link set on screen: its source panel and linked panels are never
   * docked by the policy, and are at least LINKED_MIN_SIZE so the clicked row
   * and the tinted rows still show. They may move once the anchor is released.
   */
  linkHold?: { source: P; linked: P[] };
  /** Panels the user made bigger: always on the canvas and always BIGGER_SIZE, like a size pin. */
  bigger?: P[];
  /**
   * Panels the quiet rule judged quiet (quietPanels in quiet.ts). The policy
   * marks them `quiet` and shows them compact where that keeps the calm
   * relayout rules: never a locked panel in an anchored round, never a panel
   * the user resized. Absent or empty: no quiet panels.
   */
  quiet?: P[];
  /**
   * The front group: every panel the user pinned or made bigger, newest
   * first. They lead the order in exactly this order in every round, a
   * pinned one keeps its size, and the other panels take the mode's slots
   * after them. Absent: pins first in pin order, sized by their slots.
   */
  front?: P[];
  /** The habits with enough evidence this round: a habit part on top of each panel's priority. Absent: none. */
  habit?: H;
}

/** What an app binds the policy to. Every hook is pure. */
export interface PolicyConfig<P extends string, G extends string, A extends string, S extends CoreSuggestion<A>, K extends string, H extends HabitLike<P>, I extends PolicyInput<P, G, A, S, K, H>, X> {
  catalog: Catalog<P, G, A>;
  /** Recent use per panel, 0..1 (panelUsage in usage.ts, with the app's event weights). */
  usage: (events: I["events"], now: number) => Partial<Record<P, number>>;
  /** The round's suggestions, built by the app from its judgments and data. `extra` is what computePlan was given. */
  suggest: (input: I, extra: X | undefined) => S[];
  /** The tag and reason of one linked panel, in the app's words. */
  relationFor: (anchor: AnchorRef<P, K>, panel: P, records: RelatedRecord<K>[]) => PanelRelation<P, K>;
  /** The app's help panel, which the policy opens when the user seems stuck. Absent: a hint only. */
  helpPanel?: P;
  /** The model's name in panel reasons ("Jev rates it central..."). Default: "The model". */
  modelName?: string;
  /** App event types that do not count toward the density's event minimum (pointer rests never do). */
  densityIgnores?: ReadonlySet<string>;
  /** The habit part's weight. Absent: 0 (habits change nothing). */
  habitWeight?: (weights: I["weights"]) => number;
  /** A panel's reason when its habit part is the strongest. Default: "You often go here next". */
  habitReason?: (habit: H, panel: P) => string;
  /** The habit's words in a panel's evidence. Absent: none. */
  habitEvidence?: (habit: H, panel: P, chance: number) => string;
  /** The evidence of a suggestion in the decisions. */
  suggestionEvidence?: (s: S, input: I) => string | undefined;
  /** What makes two suggestions look different on screen, for planSignature. Default: action, prominence, and label. */
  suggestionSignature?: (s: S) => string;
}

export interface TraditionalOptions<P extends string = string> {
  pinned?: P[];
  dismissed?: Partial<Record<P, number>>;
  /** Panels the user opened from the dock by hand. */
  opened?: P[];
  /** Panels the user made bigger: on the canvas at BIGGER_SIZE. */
  bigger?: P[];
  /** The front group, newest first (I.front): its pinned and bigger panels lead, in this order. Absent: pins first, in pin order. */
  front?: P[];
}

export interface PlanEdit<P extends string = string> {
  /**
   * "bigger" and "smaller": the user's "Make bigger" and "Make smaller".
   * "unquiet": the user clicked into or used a quiet panel, so it is a
   * normal panel again, at the size it had before it went quiet.
   */
  kind: "open" | "dismiss" | "pin" | "unpin" | "bigger" | "smaller" | "unquiet";
  panel: P;
  /** "smaller" only: the size to go back to (see restoredSize). Default RESTORE_FALLBACK_SIZE. */
  size?: PanelSize;
}

/** The policy bound to one app (createPolicy). */
export interface Policy<P extends string, S extends CoreSuggestion, K extends string, I, X> {
  /** Turn judgments into a layout plan. */
  computePlan(input: I, extra?: X): LayoutPlan<P, S, K>;
  /** Overview mode, default panels in catalog order as standard, the rest docked. */
  defaultPlan(): LayoutPlan<P, S, K>;
  /** The fixed, non-adaptive layout plus the user's own manual changes. */
  traditionalPlan(opts?: TraditionalOptions<P>): LayoutPlan<P, S, K>;
  applyPromotion(args: {
    plan: LayoutPlan<P, S, K>;
    previous: LayoutPlan<P, S, K>;
    panel: P;
    pinned: P[];
    decision?: Decision<P>;
    anchor?: AnchorRef<P, K> | null;
    linked?: Partial<Record<P, RelatedRecord<K>[]>>;
    linkHold?: { source: P; linked: P[] };
    bigger?: P[];
    front?: P[];
  }): LayoutPlan<P, S, K>;
  editPlan(plan: LayoutPlan<P, S, K>, edit: PlanEdit<P>, opts?: { pinsFirst?: boolean; front?: P[] }): LayoutPlan<P, S, K>;
  restoredSize(plan: LayoutPlan<P, S, K>, id: P, before?: PanelSize): PanelSize;
  planSignature(plan: LayoutPlan<P, S, K>): string;
  remarkPanels(previous: LayoutPlan<P, S, K>, next: LayoutPlan<P, S, K>, opts: { previousCells: Partial<Record<P, GridCell>> | null; decisions: boolean }): LayoutPlan<P, S, K>;
  markChanges(previous: LayoutPlan<P, S, K>, next: LayoutPlan<P, S, K>): LayoutPlan<P, S, K>;
  orderWithHysteresis(ids: P[], previousOrder: P[], priority: (id: P) => number): P[];
  isPanelId(value: unknown): value is P;
}

/** A placement without the quiet marks (the user chose it, or the quiet rule is off). */
export function withoutQuiet<T extends { quiet?: boolean; unquietSize?: PanelSize }>(p: T): T {
  if (!p.quiet && !p.unquietSize) return p;
  const q = { ...p };
  delete q.quiet;
  delete q.unquietSize;
  return q;
}

export function createPolicy<
  P extends string,
  G extends string,
  A extends string,
  S extends CoreSuggestion<A>,
  K extends string,
  H extends HabitLike<P>,
  I extends PolicyInput<P, G, A, S, K, H>,
  X = undefined,
>(config: PolicyConfig<P, G, A, S, K, H, I, X>): Policy<P, S, K, I, X> {
  type Plan = LayoutPlan<P, S, K>;
  type Placement = PanelPlacement<P, K>;
  type Dec = Decision<P>;
  const { catalog } = config;
  const HELP = config.helpPanel;
  const MODEL = config.modelName ?? "The model";
  const panelTitle = (id: P): string => catalog.panels[id].title;
  const isPanelId = (value: unknown): value is P => typeof value === "string" && (catalog.panelIds as readonly string[]).includes(value);
  const catalogIndex = (id: P): number => catalog.panelIds.indexOf(id);
  const unique = <T,>(items: T[]): T[] => [...new Set(items)];
  const round3 = (n: number): number => Math.round(n * 1000) / 1000;
  const score = (input: Pick<I, "judgments" | "events" | "now" | "weights" | "pinned" | "habit">): Record<P, PanelScore<P, G>> =>
    scorePanels(catalog, {
      judgments: input.judgments,
      usage: config.usage(input.events, input.now),
      weights: input.weights,
      pinned: input.pinned,
      ...(input.habit ? { habit: { next: input.habit.next, weight: config.habitWeight ? config.habitWeight(input.weights) : 0 } } : {}),
    });


  /**
   * The fixed, non-adaptive layout: default panels in catalog order, all
   * standard size, plus the user's own manual changes (pins first, docked
   * panels removed, opened panels added). With no manual changes this is
   * exactly defaultPlan().
   */
  function traditionalPlan(opts: TraditionalOptions<P> = {}): Plan {
    const pinned = unique((opts.pinned ?? []).filter(isPanelId));
    const dismissed = new Set(Object.keys(opts.dismissed ?? {}).filter(isPanelId));
    const base = catalog.panelIds.filter((p) => catalog.panels[p].defaultVisible);
    const opened = (opts.opened ?? []).filter(isPanelId);
    const bigger = new Set((opts.bigger ?? []).filter(isPanelId));
    const lead = (opts.front ?? []).filter((p) => isPanelId(p) && (pinned.includes(p) || bigger.has(p)));
    const order = unique([...lead, ...pinned, ...base, ...opened, ...bigger]).filter((p) => pinned.includes(p) || !dismissed.has(p));
    const placements: Placement[] = order.map((id) => ({
      id,
      size: bigger.has(id) ? BIGGER_SIZE : "standard",
      priority: 0,
      pinned: pinned.includes(id),
      reason: bigger.has(id) ? BIGGER_REASON : pinned.includes(id) ? "Pinned by you" : base.includes(id) ? "Part of the standard layout" : "You opened it",
      change: null,
      ...(bigger.has(id) ? { bigger: true } : {}),
    }));
    return {
      mode: "overview",
      placements,
      docked: catalog.panelIds.filter((p) => !order.includes(p)),
      density: "standard",
      suggestions: [],
      help: "none",
      decisions: [],
      basedOnVersion: 0,
    };
  }

  /** Overview mode, default panels in catalog order as standard, the rest docked. Also the layout when adaptive is off. */
  function defaultPlan(): Plan {
    return traditionalPlan();
  }


  function orderWithHysteresis(ids: P[], previousOrder: P[], priority: (id: P) => number): P[] {
    const set = new Set(ids);
    const order = previousOrder.filter((id) => set.has(id));
    const newcomers = ids.filter((id) => !order.includes(id)).sort((a, b) => priority(b) - priority(a) || catalogIndex(a) - catalogIndex(b));
    for (const id of newcomers) {
      const at = order.findIndex((other) => priority(other) < priority(id));
      if (at === -1) order.push(id);
      else order.splice(at, 0, id);
    }
    // Adjacent swaps with a margin. Terminates: every swap removes one inversion.
    let swapped = true;
    for (let pass = 0; swapped && pass <= order.length; pass++) {
      swapped = false;
      for (let i = 0; i < order.length - 1; i++) {
        if (priority(order[i + 1]) > priority(order[i]) + ORDER_SWAP_MARGIN) {
          [order[i], order[i + 1]] = [order[i + 1], order[i]];
          swapped = true;
        }
      }
    }
    return order;
  }


  interface Evidence {
    panel?: (id: P) => string | undefined;
    density?: string;
    help?: string;
    suggestion?: (s: S) => string | undefined;
  }

  type Draft = Omit<Plan, "decisions">;

  function suggestionKey(s: S): string {
    return `${s.actionId}|${s.prominence}|${s.label}`;
  }

  /**
   * The density line, worded from what actually happened to the panel count:
   * the cap can rise while the count falls (the dock threshold or the mode's
   * slots decide that), and "Showing more panels" over a shrinking canvas was false.
   */
  function densityText(density: Density, before: number, after: number): string {
    switch (density) {
      case "guided":
        return after < before ? "Showing fewer panels with more guidance" : "Guided view: at most 5 panels, with example commands";
      case "standard":
        return after > before ? "Back to the usual number of panels" : "Back to the usual panel limit";
      case "dense":
        return after > before ? "Showing more panels for a fast, experienced user" : "Room for more panels for a fast, experienced user";
    }
  }

  const HELP_TEXT: Record<Plan["help"], string> = {
    panel: `Opened the ${HELP !== undefined ? panelTitle(HELP) : "help panel"} because you may be stuck`,
    hint: "Showed a tip because you may be stuck",
    none: "Put help away",
  };

  /**
   * Panels that changed place relative to the others. The longest run of
   * panels that kept their relative order stayed put; everything else moved.
   * So a panel entering or leaving, which shifts everything after it, reports
   * no moves, while a swap of two neighbors reports the one that went up.
   */
  function movedPanels(previousOrder: P[], nextOrder: P[]): Map<P, "up" | "down"> {
    const inBoth = new Set(nextOrder.filter((id) => previousOrder.includes(id)));
    const before = previousOrder.filter((id) => inBoth.has(id));
    const after = nextOrder.filter((id) => inBoth.has(id));
    const rank = new Map(before.map((id, i) => [id, i]));
    const seq = after.map((id) => rank.get(id) ?? 0);
    // Longest increasing subsequence with back links (patience sorting).
    const tails: number[] = [];
    const prev: number[] = new Array(seq.length).fill(-1);
    for (let i = 0; i < seq.length; i++) {
      let lo = 0;
      let hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (seq[tails[mid]] < seq[i]) lo = mid + 1;
        else hi = mid;
      }
      if (lo > 0) prev[i] = tails[lo - 1];
      tails[lo] = i;
    }
    const kept = new Set<number>();
    for (let i = tails.length ? tails[tails.length - 1] : -1; i !== -1; i = prev[i]) kept.add(i);
    const out = new Map<P, "up" | "down">();
    after.forEach((id, i) => {
      if (kept.has(i)) return;
      const from = rank.get(id) ?? i;
      if (Math.abs(i - from) >= MOVE_PLACES) out.set(id, i < from ? "up" : "down");
    });
    return out;
  }

  /**
   * Moves read from explicit cells: a card whose top-left changed moved up when
   * it now starts earlier in reading order, else down. A size change is not a
   * move (it is reported as bigger or smaller).
   */
  function cellMoves(previous: Partial<Record<P, GridCell>>, next: Partial<Record<P, GridCell>>): Map<P, "up" | "down"> {
    const out = new Map<P, "up" | "down">();
    for (const [id, c] of Object.entries(next) as [P, GridCell][]) {
      const p = previous[id];
      if (!p || (p.col === c.col && p.row === c.row)) continue;
      out.set(id, startsBefore(c, p) ? "up" : "down");
    }
    return out;
  }

  interface PanelMarks {
    placements: Placement[];
    docks: Dec[];
    shrinks: Dec[];
    adds: Dec[];
    grows: Dec[];
    moved: Dec[];
  }

  /** placement.change and the per-panel decisions, from sizes, membership, and `moves`. */
  function markPanels(previous: Plan, placements: Placement[], moves: Map<P, "up" | "down">, evidence: Evidence): PanelMarks {
    const prevSize = new Map(previous.placements.map((p) => [p.id, p.size]));
    const adds: Dec[] = [];
    const grows: Dec[] = [];
    const shrinks: Dec[] = [];
    const moved: Dec[] = [];
    const marked = placements.map((p): Placement => {
      const title = panelTitle(p.id);
      const oldSize = prevSize.get(p.id);
      let change: Placement["change"] = null;
      if (oldSize === undefined) {
        change = "added";
        adds.push({ kind: "add", panel: p.id, text: `Brought ${title} onto the canvas`, evidence: evidence.panel?.(p.id) });
      } else if (SIZE_RANK[p.size] > SIZE_RANK[oldSize]) {
        change = "promoted";
        grows.push({ kind: "promote", panel: p.id, text: `Made ${title} bigger`, evidence: evidence.panel?.(p.id) });
      } else if (SIZE_RANK[p.size] < SIZE_RANK[oldSize]) {
        change = "demoted";
        shrinks.push({ kind: "demote", panel: p.id, text: `Made ${title} smaller`, evidence: evidence.panel?.(p.id) });
      } else if (moves.get(p.id) === "up") {
        change = "promoted";
        moved.push({ kind: "promote", panel: p.id, text: `Moved ${title} up`, evidence: evidence.panel?.(p.id) });
      } else if (moves.get(p.id) === "down") {
        change = "demoted";
        moved.push({ kind: "demote", panel: p.id, text: `Moved ${title} down`, evidence: evidence.panel?.(p.id) });
      }
      return { ...p, change };
    });
    const onCanvas = new Set(marked.map((p) => p.id));
    const docks: Dec[] = previous.placements
      .filter((p) => !onCanvas.has(p.id))
      .map((p) => ({ kind: "dock", panel: p.id, text: `Moved ${panelTitle(p.id)} to the dock`, evidence: evidence.panel?.(p.id) }));
    return { placements: marked, docks, shrinks, adds, grows, moved };
  }

  /** Set placement.change on changed panels and list what changed and why. */
  function finalize(previous: Plan, draft: Draft, leading: Dec[], evidence: Evidence): Plan {
    const decisions: Dec[] = [...leading];

    if (draft.mode !== previous.mode && !leading.some((d) => d.kind === "mode")) {
      decisions.push({ kind: "mode", text: `Switched to the ${LAYOUT_MODE_DEFS[draft.mode].label} layout` });
    }
    if (draft.density !== previous.density) {
      decisions.push({ kind: "density", text: densityText(draft.density, previous.placements.length, draft.placements.length), evidence: evidence.density });
    }
    // Only claim the Guide opened when it is actually on the canvas.
    const guideShown = HELP !== undefined && draft.placements.some((p) => p.id === HELP);
    if (draft.help !== previous.help && (draft.help !== "panel" || guideShown)) {
      decisions.push({ kind: "help", panel: draft.help === "panel" ? HELP : undefined, text: HELP_TEXT[draft.help], evidence: evidence.help });
    }

    const moves = movedPanels(
      previous.placements.map((p) => p.id),
      draft.placements.map((p) => p.id),
    );
    const { placements, docks, shrinks, adds, grows, moved } = markPanels(previous, draft.placements, moves, evidence);

    const prevSuggestions = new Set(previous.suggestions.map(suggestionKey));
    const suggests: Dec[] = draft.suggestions
      .filter((s) => !prevSuggestions.has(suggestionKey(s)))
      .map((s) => ({ kind: "suggest", text: `Suggested: ${s.label}`, evidence: evidence.suggestion?.(s) }));

    // What left or shrank comes first: the change feed shows only the first few
    // lines, and a panel that disappears is the change people miss most.
    decisions.push(...docks, ...shrinks, ...adds, ...grows, ...moved, ...suggests);
    return { ...draft, placements, decisions: decisions.map(stripUndefined) };
  }

  /** Dec kinds finalize lists before the per-panel ones (and the store's holds and commands). */
  const LEADING_KINDS: ReadonlySet<Dec["kind"]> = new Set<Dec["kind"]>(["mode", "density", "help", "hold", "command"]);

  /**
   * Re-mark the per-panel changes after the store packed a plan into cells.
   * The packer can keep a size the policy asked to change (an anchor with no
   * room to grow) and keeps cards in their cells while the order changes, so
   * the badges and change-feed lines must describe the cells, not the order.
   * With `decisions` false only the badges change (undo keeps its own line).
   */
  function remarkPanels(
    previous: Plan,
    next: Plan,
    opts: { previousCells: Partial<Record<P, GridCell>> | null; decisions: boolean },
  ): Plan {
    const cells = next.grid?.cells;
    const moves =
      opts.previousCells && cells
        ? cellMoves(opts.previousCells, cells)
        : movedPanels(
            previous.placements.map((p) => p.id),
            next.placements.map((p) => p.id),
          );
    const carried = carryEvidence(next.decisions);
    const marks = markPanels(
      previous,
      next.placements.map((p) => ({ ...p, change: null })),
      moves,
      { panel: (id) => carried.get(`panel:${id}`) },
    );
    if (!opts.decisions) return { ...next, placements: marks.placements };
    const lead = next.decisions.filter((d) => LEADING_KINDS.has(d.kind));
    const tail = next.decisions.filter((d) => d.kind === "suggest");
    const decisions = [...lead, ...marks.docks, ...marks.shrinks, ...marks.adds, ...marks.grows, ...marks.moved, ...tail].map(stripUndefined);
    return { ...next, placements: marks.placements, decisions };
  }

  /**
   * Mark what differs between two plans (placement.change and decisions)
   * without running the policy. Undo uses it so the badges describe the undo,
   * not the change that was undone.
   */
  function markChanges(previous: Plan, next: Plan): Plan {
    const { decisions: _decisions, ...draft } = next;
    void _decisions;
    return finalize(previous, { ...draft, placements: next.placements.map((p) => ({ ...p, change: null })) }, [], {});
  }


  type PartKind = "relevance" | "usage" | "goal" | "habit";

  /** The largest weighted part. The habit part (focus aid 3) wins only when strictly larger: the older parts come first on a tie. */
  function strongestPart(sc: PanelScore<P, G>): { kind: PartKind; value: number } {
    const entries: { kind: PartKind; value: number }[] = [
      { kind: "relevance", value: sc.parts.relevance },
      { kind: "usage", value: sc.parts.usage },
      { kind: "goal", value: sc.parts.goal },
      { kind: "habit", value: sc.parts.habit },
    ];
    return entries.sort((a, b) => b.value - a.value)[0];
  }

  function reasonFor(sc: PanelScore<P, G>, ctx: { forcedHelp: boolean; working: boolean; opened: boolean; habit?: H }): string {
    if (sc.parts.pin > 0) return "Pinned by you";
    if (sc.id === HELP && ctx.forcedHelp) return "Shown because you may need help";
    const top = strongestPart(sc);
    if (top.value < 0.02) {
      if (ctx.working) return "You are working in it";
      if (ctx.opened) return "You opened it";
      return "Part of your workspace";
    }
    if (top.kind === "habit" && ctx.habit) return config.habitReason ? config.habitReason(ctx.habit, sc.id) : "You often go here next";
    if (top.kind === "relevance") {
      return sc.raw.relevance >= CENTRAL_RELEVANCE ? `${MODEL} rates it central to your current work` : `${MODEL} rates it useful for your current work`;
    }
    if (top.kind === "usage") return sc.raw.usage >= HEAVY_USAGE ? "You used it a lot in the last minutes" : "You used it recently";
    return `Fits the goal: ${sc.topGoal ? catalog.goals[sc.topGoal].label : catalog.goals[UNCLEAR_GOAL as G].label}`;
  }

  function panelEvidence(sc: PanelScore<P, G>, j: I["judgments"], habit?: H): string {
    if (sc.parts.pin > 0) return `pinned, priority ${p2(sc.priority)}`;
    const top = strongestPart(sc);
    // Focus aid 3: the habit's share of the part, when it had one ("habit: after inbox in the morning p=0.82").
    const usual = habit && sc.parts.habit > 0 && config.habitEvidence ? config.habitEvidence(habit, sc.id, sc.raw.habit) : "";
    let head: string;
    if (top.kind === "habit" && usual) {
      head = usual;
    } else if (top.kind === "relevance") {
      const r = j.relevance?.[sc.id];
      head = r ? `relevance ${p2(r.score)} of ${r.max}, confidence ${p2(r.confidence)}` : "relevance 0";
    } else if (top.kind === "usage") {
      head = `recent use ${p2(sc.raw.usage)}`;
    } else {
      const g = sc.topGoal;
      head = g ? `goal ${g} p=${p2(j.goal?.probabilities?.[g] ?? 0)}` : "goal none";
    }
    const extra = usual && top.kind !== "habit" ? `, ${usual} +${p2(sc.parts.habit)}` : "";
    return `${head}${extra}, priority ${p2(sc.priority)}`;
  }

  /** Turn judgments into a layout plan. Pure. See the thresholds at the top of this file. */
  function computePlan(input: I, extra?: X): Plan {
    const { judgments: j, previous, events, now } = input;
    const pinned = unique(input.pinned.filter(isPanelId));
    const pinnedSet = new Set(pinned);
    const scores = score({ ...input, pinned });
    const avoid = input.avoid ?? {};

    const docked = (id: P) => {
      const t = input.dismissed[id];
      return !pinnedSet.has(id) && t != null && now - t < DISMISS_HOLD_MS;
    };

    let help = helpLevel(typeof j.struggling === "number" ? j.struggling : 0);
    // The user sent the Guide to the dock a moment ago. Honor that, but still
    // show the lighter tip banner instead of no help at all.
    if (help === "panel" && HELP !== undefined && docked(HELP)) help = "hint";

    let { mode, decision: modeDecision } = pickMode<P>(previous.mode, j.layout, input.recentModes);
    if (avoid.mode && mode === avoid.mode && mode !== previous.mode) {
      // The user undid this switch, and the judgments behind it have not changed.
      mode = previous.mode;
      modeDecision = {
        kind: "hold",
        text: `Kept the ${LAYOUT_MODE_DEFS[previous.mode].label} layout because you undid that change`,
        evidence: `layout ${j.layout?.choice ?? "none"} p=${p2(j.layout?.confidence ?? 0)}, same judgments as before the undo`,
      };
    }
    // Pointer rests are passive, and a saved working context, a task marked done, or a prep offer is the engine's own note, not the user's.
    const density = input.density ?? pickDensity(
      previous.density,
      j.expertise,
      events.filter((e) => e.type !== "panel_dwell" && !(config.densityIgnores?.has(e.type) ?? false)).length,
      input.recentDensities,
    );

    const working = protectedPanels(events, now, input.focusedPanel && isPanelId(input.focusedPanel) ? input.focusedPanel : null);
    const sizeHeld = sizeHeldPanels(events, now, input.focusedPanel);
    const opened = openHeldPanels(events, now);

    const wasVisible = new Set(previous.placements.map((p) => p.id));
    const prevAddedAt = new Map(previous.placements.filter((p) => p.addedAt != null).map((p) => [p.id, p.addedAt as number]));
    const autoDocked: Partial<Record<P, number>> = previous.autoDockedAt ?? {};
    const avoidAdd = new Set(avoid.add ?? []);
    const avoidDock = new Set(avoid.dock ?? []);
    // Minimum stay: a panel the policy added recently, or one whose docking the user undid, keeps its seat.
    const sticky = (id: P) => {
      if (!wasVisible.has(id)) return false;
      const t = prevAddedAt.get(id);
      return (t != null && now - t < MEMBERSHIP_HOLD_MS) || avoidDock.has(id);
    };
    // And the reverse: a panel the policy docked recently, or one whose adding the user undid, waits in the dock.
    const heldInDock = (id: P) => {
      if (wasVisible.has(id)) return false;
      const t = autoDocked[id];
      return (t != null && now - t < MEMBERSHIP_HOLD_MS) || avoidAdd.has(id);
    };

    // Anchored round (docs/anchored-relayout.md): the panel the user just worked
    // in stays, and so does everything before it on screen.
    const anchor = input.anchor ?? null;
    const prevOrder = previous.placements.map((p) => p.id);
    const prevCells: Partial<Record<P, GridCell>> = previous.grid?.cells ?? {};
    const workAnchor =
      anchor && anchor.source !== "command" && isPanelId(anchor.panel) && wasVisible.has(anchor.panel) && prevCells[anchor.panel] && !docked(anchor.panel)
        ? anchor.panel
        : null;
    const locked = new Set(workAnchor ? lockedPanels(prevOrder, prevCells, workAnchor).filter((id) => wasVisible.has(id) && !docked(id)) : []);
    // The pointer's panel waits to leave (the store passes it while the pointer rests on it).
    const hold = (input.hold ?? []).filter((id) => isPanelId(id) && wasVisible.has(id) && !docked(id));
    // Panels the user made bigger: the user decides, so they stay, at BIGGER_SIZE, like a size pin.
    const bigger = new Set(unique((input.bigger ?? []).filter(isPanelId)).filter((id) => !docked(id)));

    // Linked panels: the top few by priority get a small boost, so the model still decides.
    const boosted = new Set(anchor ? boostedPanels(anchor, input.linked, (id) => scores[id].priority, (id) => !docked(id) && !heldInDock(id)) : []);
    const priority = (id: P) => scores[id].priority + (boosted.has(id) ? LINK_PRIORITY_BOOST : 0);

    // A panel already on the canvas that shows a record linked to the work
    // anchor stays this round, tagged or not: docking Kite's bill while other
    // panels say "Linked to Kite & Co." takes away what the user is looking for.
    const linkedShown = workAnchor
      ? catalog.panelIds.filter((id) => id !== workAnchor && wasVisible.has(id) && (input.linked?.[id]?.length ?? 0) > 0)
      : [];
    // The link cues on screen outlive the anchor: their source and linked
    // panels stay until the user clears the links (they may still move).
    const linkHeld = new Set(
      input.linkHold ? [input.linkHold.source, ...input.linkHold.linked].filter((id) => isPanelId(id) && wasVisible.has(id) && !docked(id)) : [],
    );

    // Panels that must be on the canvas regardless of priority.
    const required = unique([
      ...pinned,
      ...(help === "panel" && HELP !== undefined ? [HELP] : []),
      ...(workAnchor ? [workAnchor] : []),
      ...locked,
      ...hold,
      ...linkedShown,
      ...linkHeld,
      ...bigger,
      ...catalog.panelIds.filter((id) => working.has(id) || opened.has(id)),
    ]).filter((id) => !docked(id));
    const selected = [...required];

    const cap = Math.min(SLOTS[mode].length, DENSITY_CAPS[density]);
    const seatScore = (id: P) => priority(id) + (wasVisible.has(id) ? INCUMBENT_BONUS : 0);
    // Hysteresis band around the dock threshold.
    const threshold = (id: P) => (wasVisible.has(id) ? DOCK_BELOW_PRIORITY - DOCK_MARGIN : DOCK_BELOW_PRIORITY + DOCK_MARGIN);
    // The Guide only joins through `required` (help === "panel", pinned, or in use).
    const candidates = catalog.panelIds.filter((id) => !selected.includes(id) && !docked(id) && id !== HELP);
    const byScore = (a: P, b: P) => seatScore(b) - seatScore(a) || catalogIndex(a) - catalogIndex(b);
    const ranked = candidates.filter((id) => !heldInDock(id)).sort((a, b) => Number(sticky(b)) - Number(sticky(a)) || byScore(a, b));
    for (const id of ranked) {
      if (selected.length >= cap) break;
      if (sticky(id) || priority(id) >= threshold(id)) selected.push(id);
    }
    for (const id of [...candidates].sort(byScore)) {
      if (selected.length >= MIN_CANVAS_PANELS) break;
      if (!selected.includes(id)) selected.push(id);
    }

    // The panels that lead: the pins, in pin order, or with the front group
    // ("Move pinned and bigger panels to the front") every pinned and bigger
    // panel, newest first, in exactly the store's order, so no round reshuffles them.
    const lead = (input.front ? unique([...input.front.filter(isPanelId), ...pinned]) : pinned).filter((id) => selected.includes(id));
    const leadSet = new Set(lead);
    const rest = selected.filter((id) => !leadSet.has(id));
    const normalOrder = [...lead, ...orderWithHysteresis(rest, prevOrder, priority)];
    const forcedGuide = HELP !== undefined && help === "panel" && normalOrder.includes(HELP) && !leadSet.has(HELP);
    if (forcedGuide && HELP !== undefined) {
      const at = Math.min(Math.max(HELP_PANEL_SLOT, lead.length), normalOrder.length - 1);
      normalOrder.splice(normalOrder.indexOf(HELP), 1);
      normalOrder.splice(at, 0, HELP);
    }
    let order = normalOrder;
    if (workAnchor) {
      // Pins (or the front group) first (they keep their cells; the packer
      // holds them), then the locked panels in their old order around the
      // anchor, then everything else after it. A forced Guide leads the newcomers.
      const at = prevOrder.indexOf(workAnchor);
      const keep = (id: P) => locked.has(id) && selected.includes(id) && !leadSet.has(id);
      const before = prevOrder.slice(0, at).filter(keep);
      const after = prevOrder.slice(at + 1).filter(keep);
      const placed = new Set<P>([...lead, ...before, workAnchor, ...after]);
      let others = orderWithHysteresis(
        selected.filter((id) => !placed.has(id)),
        prevOrder,
        priority,
      );
      if (forcedGuide && HELP !== undefined && others.includes(HELP)) others = [HELP, ...others.filter((id) => id !== HELP)];
      order = unique([...lead, ...before, workAnchor, ...after, ...others]);
    }

    const relations = relationsOnCanvas(anchor, input.linked, order, (id) => !wasVisible.has(id), priority);

    // Focus aid 1 (docs/focus-aids.md): the panels the store judged quiet. The
    // policy checks its own exemptions again (the anchor, a panel it tags as
    // linked this round or the link cues hold, pins, bigger panels, the Guide
    // it opened, the pointer's card).
    const quietIn = new Set((input.quiet ?? []).filter(isPanelId));
    const resized = quietIn.size > 0 ? userResizedPanels(events) : new Set<P>();

    const prevSize = new Map(previous.placements.map((p) => [p.id, p.size]));
    const slots = SLOTS[mode];
    // With the front group, the panels after it take the mode's slots as if they led (the Focus hero is the policy's own).
    const slotOf = (i: number): PanelSize => slots[input.front && i >= lead.length ? i - lead.length : i] ?? "compact";
    const placements: Placement[] = order.map((id, i) => {
      let size: PanelSize = slotOf(i);
      if (id === HELP && forcedGuide) size = "standard";
      const old = prevSize.get(id);
      // Never shrink the panel under the user's hands.
      if (old && sizeHeld.has(id) && SIZE_RANK[old] > SIZE_RANK[size]) size = old;
      // Anchored: locked and pinned cards keep their size; the anchor may only
      // grow, to the size it would get in the order it would have had.
      const fixedSize = workAnchor !== null && old !== undefined && id !== workAnchor && (locked.has(id) || pinnedSet.has(id));
      // With the front group a pin keeps its size in every round, so the front holds still.
      const frontPin = input.front !== undefined && old !== undefined && pinnedSet.has(id);
      if (fixedSize || frontPin) size = old;
      if (id === workAnchor && !frontPin) size = largest(old ?? size, size, slotOf(normalOrder.indexOf(id)));
      const relation = relations.get(id);
      // A linked panel (and the source of the links on screen) keeps its rows, so the tint and the clicked row show.
      if ((relation || linkHeld.has(id)) && !fixedSize && !frontPin) size = largest(size, LINKED_MIN_SIZE);
      // The user made it bigger: that wins over every rule above until they make it smaller.
      if (bigger.has(id)) size = BIGGER_SIZE;
      const quiet =
        quietIn.has(id) &&
        wasVisible.has(id) &&
        id !== anchor?.panel &&
        !relation &&
        !linkHeld.has(id) &&
        !bigger.has(id) &&
        !pinnedSet.has(id) &&
        !(id === HELP && forcedGuide) &&
        !hold.includes(id);
      // A quiet panel shrinks only where the calm relayout allows: never one
      // the user resized, and never one whose size is held by a recent event
      // (unless it is already the summary tile: a pointer rest or keyboard
      // focus on a quiet panel must not change the layout). A locked card
      // before the anchor may shrink too: the packer keeps its top-left, and
      // every card has an explicit cell, so the anchor cannot move.
      const normalSize = size;
      const held = sizeHeld.has(id) && old !== QUIET_SIZE;
      if (quiet && !resized.has(id) && !held && SIZE_RANK[size] > SIZE_RANK[QUIET_SIZE]) size = QUIET_SIZE;
      const sc = scores[id];
      const addedAt = wasVisible.has(id) ? prevAddedAt.get(id) : now;
      const baseReason = quiet
        ? quietReason(catalog, j.goal?.choice)
        : reasonFor(sc, { forcedHelp: help === "panel", working: working.has(id), opened: opened.has(id), ...(input.habit ? { habit: input.habit } : {}) });
      return {
        id,
        size,
        priority: round3(priority(id)),
        pinned: pinnedSet.has(id),
        // A panel that joined for the link says so; one that was already here keeps the model's reason.
        reason: bigger.has(id) ? BIGGER_REASON : relation && !wasVisible.has(id) ? `${relation.tag}: ${relation.reason}` : baseReason,
        change: null,
        breakdown: {
          relevance: round3(sc.parts.relevance),
          usage: round3(sc.parts.usage),
          goal: round3(sc.parts.goal),
          pin: sc.parts.pin,
          // Focus aid 3: only in a round that used a habit, so plans without one are exactly as before.
          ...(input.habit ? { habit: round3(sc.parts.habit) } : {}),
        },
        ...(addedAt != null ? { addedAt } : {}),
        ...(anchor && id === anchor.panel ? { anchor: true } : {}),
        ...(relation ? { relation } : {}),
        ...(bigger.has(id) ? { bigger: true } : {}),
        ...(quiet ? { quiet: true } : {}),
        ...(quiet && size !== normalSize ? { unquietSize: normalSize } : {}),
      };
    });
    const quietShown = new Set(placements.filter((p) => p.quiet).map((p) => p.id));

    // Remember what the policy itself docked, for the minimum stay in the dock.
    const autoDockedAt: Partial<Record<P, number>> = {};
    for (const [id, t] of Object.entries(autoDocked) as [P, number][]) {
      if (now - t < MEMBERSHIP_HOLD_MS && !order.includes(id)) autoDockedAt[id] = t;
    }
    for (const p of previous.placements) if (!order.includes(p.id) && !docked(p.id)) autoDockedAt[p.id] = now;

    const suggestions = config.suggest(input, extra);
    const draft: Draft = {
      mode,
      placements,
      docked: catalog.panelIds.filter((id) => !order.includes(id)),
      density,
      suggestions,
      help,
      basedOnVersion: input.version,
      ...(Object.keys(autoDockedAt).length ? { autoDockedAt } : {}),
      ...(anchor ? { anchor } : {}),
    };

    const exp = j.expertise;
    return finalize(previous, draft, modeDecision ? [modeDecision] : [], {
      panel: (id) => {
        if (docked(id)) return "dismissed by you";
        if (id === HELP && help !== "panel" && !order.includes(id)) return `struggling p=${p2(j.struggling ?? 0)}`;
        if (!order.includes(id)) {
          if (heldInDock(id)) return avoidAdd.has(id) ? "you undid adding it" : "sent to the dock less than 30 s ago";
          return priority(id) < threshold(id)
            ? `priority ${p2(priority(id))} is below ${p2(threshold(id))}`
            : `priority ${p2(priority(id))}, no room for more than ${cap} panels`;
        }
        if (id === HELP && help === "panel" && !pinnedSet.has(id)) return `struggling p=${p2(j.struggling ?? 0)}`;
        const link = boosted.has(id) && anchor ? `, linked to ${anchor.label ?? anchor.client ?? panelTitle(anchor.panel)} +${p2(LINK_PRIORITY_BOOST)}` : "";
        const mine = bigger.has(id) ? ", made bigger by you" : "";
        const hushed = quietShown.has(id) ? `, quiet: relevance below ${p2(QUIET_BELOW)} for a while` : "";
        if (id === workAnchor) return `${panelEvidence(scores[id], j, input.habit)}${mine}, you are working in it`;
        return `${panelEvidence(scores[id], j, input.habit)}${link}${mine}${hushed}`;
      },
      density: exp ? `expertise ${p2(exp.score)} of ${exp.max}, confidence ${p2(exp.confidence)}` : undefined,
      help: `struggling p=${p2(typeof j.struggling === "number" ? j.struggling : 0)}`,
      suggestion: (s) => config.suggestionEvidence?.(s, input),
    });
  }


  /**
   * Make one panel the hero in focus mode because the user asked for it in the
   * command bar. Skips order hysteresis on purpose: the user asked.
   *
   * With an anchor (a command that names a record or client), panels holding
   * linked records come right after the hero and pins, at least standard size,
   * so the link color has rows to show. Relations come from the plan, or from
   * `linked` when the plan was not built for this anchor (a "Did you mean" pick).
   * The panels of the link cues on screen (`linkHold`) are never docked past
   * the cap and keep their rows, as in computePlan.
   */
  function applyPromotion(args: {
    plan: Plan;
    previous: Plan;
    panel: P;
    pinned: P[];
    decision?: Dec;
    anchor?: AnchorRef<P, K> | null;
    linked?: Partial<Record<P, RelatedRecord<K>[]>>;
    linkHold?: I["linkHold"];
    /** Panels the user made bigger: kept past the cap, at BIGGER_SIZE. */
    bigger?: P[];
    /** The front group, newest first (I.front): right after the hero, in this order, a pin at its own size. Absent: the pins follow the hero. */
    front?: P[];
  }): Plan {
    const { plan, previous, panel } = args;
    const anchor = args.anchor !== undefined ? args.anchor : (plan.anchor ?? null);
    const pinnedSet = new Set(args.pinned);
    const existing = new Map(plan.placements.map((p) => [p.id, p]));
    let relations = new Map<P, PanelRelation<P, K>>();
    if (anchor && args.linked) {
      const wasShown = new Set(previous.placements.map((p) => p.id));
      relations = relationsOnCanvas(anchor, args.linked, [...existing.keys()], (id) => !wasShown.has(id), (id) => existing.get(id)?.priority ?? 0);
    } else if (anchor && plan.anchor?.at === anchor.at) {
      for (const p of plan.placements) if (p.relation) relations.set(p.id, p.relation);
    }
    const others = plan.placements.map((p) => p.id).filter((id) => id !== panel);
    // The pins, or the whole front group in its order, come right after the hero.
    const lead = args.front ? unique([...args.front, ...args.pinned]).filter((id) => others.includes(id)) : others.filter((id) => pinnedSet.has(id));
    const leadSet = new Set(lead);
    const order = [
      panel,
      ...lead,
      ...others.filter((id) => !leadSet.has(id) && relations.has(id)),
      ...others.filter((id) => !leadSet.has(id) && !relations.has(id)),
    ];
    const cap = Math.min(SLOTS.focus.length, DENSITY_CAPS[plan.density]);
    // A panel the user is working in (a work anchor) is never docked, even past the cap, and neither are the panels of the links on screen.
    const working = anchor && anchor.source !== "command" ? anchor.panel : null;
    const linkHeld = new Set(args.linkHold ? [args.linkHold.source, ...args.linkHold.linked] : []);
    // A panel the user made bigger is never docked or shrunk by a command either.
    const bigger = new Set(args.bigger ?? []);
    const kept = order.filter((id, i) => i < cap || pinnedSet.has(id) || id === working || linkHeld.has(id) || bigger.has(id));
    const placements: Placement[] = kept.map((id, i) => {
      const base = existing.get(id);
      const relation = relations.get(id);
      // With the front group, the cards after it take the slots from the second on, as they would right after the hero.
      const slot = SLOTS.focus[args.front && i > lead.length ? i - lead.length : i] ?? "compact";
      // A pin in the front group keeps its size here too, as in computePlan.
      const frontPin = args.front !== undefined && base !== undefined && pinnedSet.has(id) && id !== panel;
      // A quiet panel stays faded through the command's reflow; the sizes here are the slots', so it is not shrunk.
      const quiet = Boolean(base?.quiet) && id !== panel && id !== working && !relation && !linkHeld.has(id) && !bigger.has(id) && !pinnedSet.has(id);
      const baseReason = base?.quiet && !quiet ? "Part of your workspace" : base?.reason;
      return {
        id,
        size: bigger.has(id) ? BIGGER_SIZE : frontPin ? base.size : relation || linkHeld.has(id) ? largest(slot, LINKED_MIN_SIZE) : slot,
        priority: base?.priority ?? 0,
        pinned: pinnedSet.has(id),
        reason: id === panel ? "You asked for it in the command bar" : bigger.has(id) ? BIGGER_REASON : (baseReason ?? "Part of your workspace"),
        change: null,
        ...(base?.breakdown ? { breakdown: base.breakdown } : {}),
        ...(base?.addedAt != null ? { addedAt: base.addedAt } : {}),
        ...(anchor && id === anchor.panel ? { anchor: true } : {}),
        ...(relation ? { relation } : {}),
        ...(bigger.has(id) ? { bigger: true } : {}),
        ...(quiet ? { quiet: true } : {}),
      };
    });
    const carried = carryEvidence(plan.decisions);
    const draft: Draft = {
      mode: "focus",
      placements,
      docked: catalog.panelIds.filter((id) => !kept.includes(id)),
      density: plan.density,
      suggestions: plan.suggestions,
      help: plan.help,
      basedOnVersion: plan.basedOnVersion,
      ...(plan.autoDockedAt ? { autoDockedAt: plan.autoDockedAt } : {}),
      ...(anchor ? { anchor } : {}),
    };
    return finalize(previous, draft, args.decision ? [args.decision] : [], {
      panel: (id) => carried.get(`panel:${id}`),
      density: carried.get("density"),
      help: carried.get("help"),
      suggestion: (s) => carried.get(`suggest:${s.label}`),
    });
  }


  /**
   * The size a panel goes back to when the user makes it smaller: the size it
   * had before they made it bigger when known, else its slot's size, and never
   * the hero (RESTORE_FALLBACK_SIZE instead), so it always gets smaller. The
   * policy decides its size again from the next round on.
   */
  function restoredSize(plan: Plan, id: P, before?: PanelSize): PanelSize {
    const i = plan.placements.findIndex((p) => p.id === id);
    const slot = SLOTS[plan.mode][i] ?? (plan.mode === "overview" ? "standard" : "compact");
    const size = before ?? slot;
    return SIZE_RANK[size] < SIZE_RANK[BIGGER_SIZE] ? size : RESTORE_FALLBACK_SIZE;
  }

  /**
   * A manual edit to the current plan without re-running the policy. Used when
   * the layout is frozen or there are no judgments yet, so user actions still
   * work, and for manual edits in the adaptive layout so one click moves only
   * that panel. `pinsFirst` moves pinned panels to the front the way
   * computePlan orders them (not for frozen layouts, which must not move).
   * `front` (a pin or "Make bigger" with "Move pinned and bigger panels to the
   * front" on) puts the front group first in that order instead, newest
   * first, and changes no size: a pin keeps its own, a bigger panel is the hero.
   */
  function editPlan(plan: Plan, edit: PlanEdit<P>, opts: { pinsFirst?: boolean; front?: P[] } = {}): Plan {
    const { panel } = edit;
    let placements = plan.placements.map((p) => ({ ...p }));
    const onCanvas = placements.some((p) => p.id === panel);
    if (edit.kind === "dismiss") {
      placements = placements.filter((p) => p.id !== panel);
    } else if ((edit.kind === "open" || edit.kind === "pin") && !onCanvas) {
      const size = SLOTS[plan.mode][placements.length] ?? (plan.mode === "overview" ? "standard" : "compact");
      placements.push({
        id: panel,
        size,
        priority: 0,
        pinned: edit.kind === "pin",
        reason: edit.kind === "pin" ? "Pinned by you" : "You opened it",
        change: null,
      });
    } else if (edit.kind === "pin" || edit.kind === "unpin") {
      placements = placements.map((p) =>
        p.id === panel
          ? {
              ...p,
              pinned: edit.kind === "pin",
              reason: p.bigger ? p.reason : edit.kind === "pin" ? "Pinned by you" : p.reason === "Pinned by you" ? "Part of your workspace" : p.reason,
            }
          : p,
      );
    } else if (edit.kind === "bigger") {
      placements = placements.map((p) => (p.id === panel ? { ...p, size: BIGGER_SIZE, bigger: true, reason: BIGGER_REASON } : p));
    } else if (edit.kind === "smaller") {
      placements = placements.map((p) => {
        if (p.id !== panel) return p;
        const q: Placement = {
          ...p,
          size: edit.size ?? RESTORE_FALLBACK_SIZE,
          reason: p.reason === BIGGER_REASON ? (p.pinned ? "Pinned by you" : "Part of your workspace") : p.reason,
        };
        delete q.bigger;
        return q;
      });
    } else if (edit.kind === "unquiet") {
      placements = placements.map((p) => (p.id === panel && p.quiet ? { ...p, size: p.unquietSize ?? p.size, reason: UNQUIET_REASON } : p));
    }
    // Any edit of a panel is the user choosing it: it is not quiet any more.
    placements = placements.map((p) => (p.id === panel ? withoutQuiet(p) : p));
    if (opts.front) {
      const byId = new Map(placements.map((p) => [p.id, p]));
      const lead = unique(opts.front).filter((id) => byId.has(id));
      placements = [...lead.map((id) => byId.get(id)!), ...placements.filter((p) => !lead.includes(p.id))];
    } else if (opts.pinsFirst) {
      const before = placements.map((p) => p.id);
      placements = [...placements.filter((p) => p.pinned), ...placements.filter((p) => !p.pinned)];
      // Only panels that changed position take their new slot's size; a panel the user made bigger keeps it.
      placements = placements.map((p, i) => (before[i] === p.id || p.bigger ? p : { ...p, size: SLOTS[plan.mode][i] ?? "compact" }));
    }
    const ids = new Set(placements.map((p) => p.id));
    const draft: Draft = { ...plan, placements, docked: catalog.panelIds.filter((id) => !ids.has(id)) };
    const by: Record<PlanEdit<P>["kind"], string> = {
      open: "opened by you",
      dismiss: "dismissed by you",
      pin: "opened by you",
      unpin: "opened by you",
      bigger: "made bigger by you",
      smaller: "made smaller by you",
      unquiet: "brought back by you",
    };
    return finalize(plan, draft, [], { panel: () => by[edit.kind] });
  }

  /** A string that changes only when something visible changes. The store uses it to skip no-op re-plans. */
  function planSignature(plan: Plan): string {
    // Cells count: with explicit cells a card can move while order and size stay the same.
    const cells: Partial<Record<P, GridCell>> = plan.grid?.cells ?? {};
    const cellText = (id: P) => {
      const c = cells[id];
      return c ? `@${c.col},${c.row}` : "";
    };
    const panels = plan.placements.map((p) => `${p.id}:${p.size}:${p.pinned ? 1 : 0}${cellText(p.id)}`).join(",");
    const sugg = plan.suggestions.map((s) => (config.suggestionSignature ? config.suggestionSignature(s) : `${s.actionId}:${s.prominence}:${s.label}`)).join(",");
    return `${plan.mode}|${plan.density}|${plan.help}|${panels}|${sugg}`;
  }


  /**
   * The panels that get the link boost: the top LINKED_PANELS_MAX of those
   * holding linked records, by priority, among panels that may join at all
   * (not dismissed, not held in the dock). Relations are picked after
   * selection (relationsOnCanvas).
   */
  function boostedPanels(
    anchor: AnchorRef<P, K>,
    linked: Partial<Record<P, RelatedRecord<K>[]>> | undefined,
    priority: (id: P) => number,
    eligible: (id: P) => boolean,
  ): P[] {
    if (!linked) return [];
    return (Object.keys(linked) as P[])
      .filter((id) => isPanelId(id) && id !== anchor.panel && (linked[id]?.length ?? 0) > 0 && eligible(id))
      .sort((a, b) => priority(b) - priority(a) || catalogIndex(a) - catalogIndex(b))
      .slice(0, LINKED_PANELS_MAX);
  }

  /**
   * Relations for panels on the canvas that hold linked records, at most
   * LINKED_PANELS_MAX: panels this round added first (they are the ones a user
   * asks "why is this here?" about), then the most useful ones already shown.
   */
  function relationsOnCanvas(
    anchor: AnchorRef<P, K> | null,
    linked: Partial<Record<P, RelatedRecord<K>[]>> | undefined,
    onCanvas: P[],
    isNew: (id: P) => boolean,
    priority: (id: P) => number,
  ): Map<P, PanelRelation<P, K>> {
    const out = new Map<P, PanelRelation<P, K>>();
    if (!anchor || !linked) return out;
    const ids = onCanvas
      .filter((id) => id !== anchor.panel && (linked[id]?.length ?? 0) > 0)
      .sort((a, b) => Number(isNew(b)) - Number(isNew(a)) || priority(b) - priority(a) || catalogIndex(a) - catalogIndex(b))
      .slice(0, LINKED_PANELS_MAX);
    for (const id of ids) out.set(id, config.relationFor(anchor, id, linked[id]!));
    return out;
  }


  /** The largest of the given sizes. */
  function largest(...sizes: PanelSize[]): PanelSize {
    return sizes.reduce((a, b) => (SIZE_RANK[b] > SIZE_RANK[a] ? b : a));
  }

  function carryEvidence(decisions: Dec[]): Map<string, string> {
    const out = new Map<string, string>();
    for (const d of decisions) {
      if (!d.evidence) continue;
      if (d.panel && d.kind !== "help") out.set(`panel:${d.panel}`, d.evidence);
      if (d.kind === "density" || d.kind === "help") out.set(d.kind, d.evidence);
      if (d.kind === "suggest") out.set(`suggest:${d.text.replace(/^Suggested: /, "")}`, d.evidence);
    }
    return out;
  }

  function stripUndefined(d: Dec): Dec {
    const out: Dec = { kind: d.kind, text: d.text };
    if (d.panel) out.panel = d.panel;
    if (d.evidence) out.evidence = d.evidence;
    return out;
  }


  return { computePlan, defaultPlan, traditionalPlan, applyPromotion, editPlan, restoredSize, planSignature, remarkPanels, markChanges, orderWithHysteresis, isPanelId };
}
