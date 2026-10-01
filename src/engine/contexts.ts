/**
 * "Back to" working contexts (docs/predictive-flow.md): what the user was
 * doing before the work changed, so one click brings back that layout, its
 * filters and selections, the panels made bigger, and the link cues.
 *
 * The rules live here as pure functions: when the goal really changed (Jev
 * sure for two rounds in a row, or a command to another area), the label,
 * the deduplicated list, and the plan a restore puts back. The store
 * captures and restores the state. Pure: no DOM, no store, no clock.
 */
import { GOALS, GOAL_IDS, GOAL_PANEL_AFFINITY, PANEL_IDS, type GoalId, type PanelId } from "../../shared/catalog.ts";
import type { ChoiceJudgment, LayoutPlan, PanelPlacement, SignalEvent, SignalType } from "../../shared/types.ts";
import type { WorkingContext } from "./contract.ts";
import { CLIENT_ARG_CONFIDENCE } from "./policy.ts";

/** Jev's goal must differ from the current context's with at least this confidence to count; below it the goal read is still settling. */
export const CONTEXT_SWITCH_CONFIDENCE = 0.7;
/** ...for this many rounds in a row, so one stray click never files the work away. */
export const CONTEXT_SWITCH_ROUNDS = 2;
/** Most saved contexts: three chips fit the canvas caption and cover a morning's threads; older ones are rarely wanted. */
export const CONTEXTS_MAX = 3;
/**
 * A command to a panel below this affinity with the current goal switches
 * areas. Each goal's own panels are 0.5 or more in GOAL_PANEL_AFFINITY, so
 * "Harbor Coffee Co." while collecting payments stays in the same work.
 */
export const CONTEXT_AREA_AFFINITY = 0.5;
/** Jev's target client names a context at the same confidence that fills a suggestion's client. */
export const CONTEXT_CLIENT_CONFIDENCE = CLIENT_ARG_CONFIDENCE;
/** Label of a context whose goal is not known (not expected: a context is saved only with a goal). */
export const UNKNOWN_CONTEXT_LABEL = "Earlier work";

/** Events that say which client the work is about. */
const CLIENT_TYPES: ReadonlySet<SignalType> = new Set<SignalType>(["item_open", "up_next_open", "task_start", "prep_start", "action", "filter"]);

/** "Collecting payments · Harbor Coffee Co.". */
export function contextLabel(goal: GoalId, client?: string): string {
  const name = goal === "unclear" ? UNKNOWN_CONTEXT_LABEL : GOALS[goal].label;
  return client ? `${name} · ${client}` : name;
}

/** The goal a panel stands for: the goal with the highest affinity for it (catalog order breaks ties), or undefined (the Guide). */
export function panelGoal(panel: PanelId): GoalId | undefined {
  let best: GoalId | undefined;
  let bestValue = 0;
  for (const g of GOAL_IDS) {
    const v = GOAL_PANEL_AFFINITY[g][panel] ?? 0;
    if (v > bestValue) {
      best = g;
      bestValue = v;
    }
  }
  return best;
}

/**
 * The goal a command to `panel` switches to, or null when it stays in the
 * current work: the panel is one of the current goal's own panels
 * (CONTEXT_AREA_AFFINITY or more), or it stands for no goal.
 */
export function commandSwitchesArea(current: GoalId, panel: PanelId): GoalId | null {
  if ((GOAL_PANEL_AFFINITY[current][panel] ?? 0) >= CONTEXT_AREA_AFFINITY) return null;
  const to = panelGoal(panel);
  return to && to !== current ? to : null;
}

/** A goal switch that has started but is not confirmed yet. */
export interface PendingSwitch {
  goal: GoalId;
  /** Rounds in a row that judged it. */
  rounds: number;
}

export type SwitchStep =
  /** Nothing to do; any pending switch is dropped (the streak broke). */
  | { kind: "none" }
  /** No context yet: this confident goal starts the first one. Nothing is saved. */
  | { kind: "adopt"; goal: GoalId }
  /** A different goal, not confirmed yet. On the first round, the store captures the context as it is now. */
  | { kind: "pending"; pending: PendingSwitch }
  /** Confirmed: save the context captured on the first round and start a new one. */
  | { kind: "switch"; goal: GoalId };

/**
 * One round's goal judgment against the current context. The goal really
 * changed when Jev judged another goal (not "unclear") with confidence
 * CONTEXT_SWITCH_CONFIDENCE or more for CONTEXT_SWITCH_ROUNDS rounds in a
 * row; a round that judged the current goal, "unclear", or was less sure
 * breaks the streak.
 */
export function judgeSwitch(current: GoalId | null, pending: PendingSwitch | null, judged: ChoiceJudgment<GoalId> | undefined): SwitchStep {
  if (!judged || judged.choice === "unclear" || !GOALS[judged.choice] || (judged.confidence ?? 0) < CONTEXT_SWITCH_CONFIDENCE) return { kind: "none" };
  if (current === null) return { kind: "adopt", goal: judged.choice };
  if (judged.choice === current) return { kind: "none" };
  const rounds = pending?.goal === judged.choice ? pending.rounds + 1 : 1;
  if (rounds >= CONTEXT_SWITCH_ROUNDS) return { kind: "switch", goal: judged.choice };
  return { kind: "pending", pending: { goal: judged.choice, rounds } };
}

/**
 * The client the work toward `goal` is about: the newest client named by a
 * record opened, acted on, or filtered in one of the goal's own panels
 * (CONTEXT_AREA_AFFINITY or more), else Jev's target client when it is sure
 * enough, else none. Only the goal's own panels count, because the clicks
 * that started the next piece of work (a meeting with another client) come
 * before the context is saved.
 */
export function contextClient(events: SignalEvent[], goal: GoalId, targetClient?: ChoiceJudgment<string>): string | undefined {
  const own = GOAL_PANEL_AFFINITY[goal];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!CLIENT_TYPES.has(e.type) || !e.panel || (own[e.panel] ?? 0) < CONTEXT_AREA_AFFINITY) continue;
    const client = e.detail?.client ?? (e.type === "filter" ? e.detail?.filter?.client : undefined);
    if (client && client !== "all") return client;
  }
  if (targetClient && targetClient.choice !== "none" && (targetClient.confidence ?? 0) >= CONTEXT_CLIENT_CONFIDENCE) return targetClient.choice;
  return undefined;
}

/** `ctx` first, without an older context for the same goal and client, at most CONTEXTS_MAX. */
export function addContext(list: WorkingContext[], ctx: WorkingContext): WorkingContext[] {
  const same = (c: WorkingContext) => c.goal === ctx.goal && (c.client ?? "") === (ctx.client ?? "");
  return [ctx, ...list.filter((c) => !same(c))].slice(0, CONTEXTS_MAX);
}

/**
 * The contexts the "Back to" chips offer: every saved one for another goal
 * than the current work, most recent first. With `client` (the current work
 * names its client, as after Prepare, focus aid 4), a context for the same
 * goal and another client is offered too.
 */
export function backToList(contexts: WorkingContext[], current: GoalId | null, client?: string): WorkingContext[] {
  return contexts.filter((c) => c.goal !== current || (client !== undefined && (c.client ?? "") !== client));
}

/**
 * The plan a restore puts on screen: the saved placements, sizes, cells,
 * mode, and density, with the pins as they are now (pins are global: a
 * panel pinned since is added at the front, one unpinned since is no longer
 * pinned), bigger flags from the context, no anchor or relations (the link
 * cues are restored on their own), and one decision that says why. The
 * saved cells are dropped when a pin was added, so the place step reflows.
 * The suggestions start empty: the ones on screen were about the work being left.
 */
export function restoredPlan(ctx: WorkingContext, current: LayoutPlan, pinned: PanelId[]): LayoutPlan {
  const pins = new Set(pinned);
  const bigger = new Set(ctx.bigger);
  const placements: PanelPlacement[] = ctx.plan.placements.map((p) => {
    const q: PanelPlacement = { ...p, change: null, pinned: pins.has(p.id) };
    delete q.anchor;
    delete q.relation;
    if (bigger.has(p.id)) q.bigger = true;
    else delete q.bigger;
    if (!q.bigger) {
      if (q.pinned && !p.pinned) q.reason = "Pinned by you";
      else if (!q.pinned && p.reason === "Pinned by you") q.reason = "Part of your workspace";
    }
    return q;
  });
  const missing = pinned.filter((id) => !placements.some((p) => p.id === id));
  const added: PanelPlacement[] = missing.map((id) => ({ id, size: "standard", priority: 0, pinned: true, reason: "Pinned by you", change: null }));
  const all = [...added, ...placements];
  const on = new Set(all.map((p) => p.id));
  const plan: LayoutPlan = {
    mode: ctx.plan.mode,
    placements: all,
    docked: PANEL_IDS.filter((id) => !on.has(id)),
    density: ctx.plan.density,
    suggestions: [],
    help: ctx.plan.help === "panel" && !on.has("help") ? "hint" : ctx.plan.help,
    decisions: [{ kind: "command", text: `Went back to ${ctx.label}` }],
    basedOnVersion: current.basedOnVersion,
    anchor: null,
    ...(current.round !== undefined ? { round: current.round } : {}),
  };
  if (missing.length === 0 && ctx.plan.grid) plan.grid = ctx.plan.grid;
  return plan;
}
