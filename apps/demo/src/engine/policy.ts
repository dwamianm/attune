/**
 * The layout policy: Jev's judgments in, a LayoutPlan out.
 *
 * Jev supplies typed judgments with probabilities (goal, per-panel relevance,
 * layout mode, struggling, expertise, next step, client). Everything that
 * decides what actually moves lives here as plain code with named thresholds,
 * so a person can read, test, and tune why the canvas changed. Pure: no DOM,
 * no store, no clock except `input.now`.
 */
import {
  ACTIONS,
  GOALS,
  GOAL_IDS,
  GOAL_PANEL_AFFINITY,
  LAYOUT_MODES,
  LAYOUT_MODE_DEFS,
  PANEL_IDS,
  PANELS,
  panelTitle,
  type ActionId,
  type GoalId,
  type LayoutMode,
  type PanelId,
} from "../../shared/catalog.ts";
import { CLIENTS, INVOICES, MESSAGES, PROJECTS, oldestOverdueInvoice, type Invoice, type Message, type Project } from "../../shared/fixtures.ts";
import type {
  AnchorRef,
  ChoiceJudgment,
  Decision,
  Density,
  GridCell,
  ItemKind,
  Judgments,
  LayoutPlan,
  PanelPlacement,
  PanelRelation,
  PanelSize,
  RelatedRecord,
  ScoreJudgment,
  SignalEvent,
  Suggestion,
} from "../../shared/types.ts";
import type { HabitHints, PanelViewState, PolicyInput } from "./contract.ts";
import { lockedPanels, startsBefore } from "@attune/core";
import { HABIT_WEIGHT, habitActionReason, habitReason } from "./habits.ts";
import { QUIET_BELOW, QUIET_SIZE, quietReason } from "./quiet.ts";
import { LINKED_PANELS_MAX, relationFor } from "./relations.ts";
import { panelUsage } from "./usage.ts";
import { lowerFirst, matchesQuery, p2, possessive, timesWord } from "@attune/core";

// ---------------------------------------------------------------------------
// Thresholds. Demo defaults; tune them here.
// ---------------------------------------------------------------------------

/** Added to a pinned panel's priority so it always sorts first. */
export const PIN_BOOST = 1;
/** A panel the user sent to the dock stays there this long unless pinned. */
export const DISMISS_HOLD_MS = 3 * 60_000;
/** A panel the user opened from the dock stays on the canvas at least this long. */
export const OPEN_HOLD_MS = 60_000;
/** A panel with any event this recent cannot be docked or shrunk. */
export const PROTECT_RECENT_MS = 4_000;
/**
 * The focused panel keeps its size only while its newest event is this
 * recent. It keeps its seat on the canvas for as long as it stays focused,
 * but a panel clicked ten minutes ago must not stay a hero in every later
 * layout (three heroes in Compare). 15 s covers reading a record after a click.
 */
export const FOCUSED_SIZE_HOLD_MS = 15_000;
/** Switch layout mode at once when Jev's layout confidence reaches this. */
export const MODE_SWITCH_CONFIDENCE = 0.8;
/** Or switch at this confidence when recent rounds agree (see MODE_STREAK_LENGTH). */
export const MODE_STREAK_CONFIDENCE = 0.55;
/** How many of the newest recentModes must equal the new mode for the streak rule. */
export const MODE_STREAK_LENGTH = 2;
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
/** Most panels on the canvas per density. */
export const DENSITY_CAPS: Record<Density, number> = { guided: 5, standard: 7, dense: 9 };
/** Expertise (score / max) below this means guided density. */
export const GUIDED_BELOW = 0.33;
/** Expertise (score / max) above this means dense density. */
export const DENSE_ABOVE = 0.66;
/** Change density only when Jev's expertise confidence reaches this. */
export const DENSITY_CONFIDENCE = 0.6;
/** And only after this many events (pointer rests excluded), so one click cannot shrink the canvas. */
export const DENSITY_MIN_EVENTS = 5;
/**
 * And only when this many rounds in a row judged the same density. One read of
 * a slow, careful stretch flipped the canvas to guided mid-task, and a few
 * commands later to dense.
 */
export const DENSITY_STREAK_LENGTH = 2;
/** Struggling (Noul) at or above this opens the Guide panel. */
export const HELP_PANEL_AT = 0.7;
/** Struggling (Noul) at or above this shows a help hint. */
export const HELP_HINT_AT = 0.55;
/**
 * Where the Guide goes when the policy opens it: the second slot (after any
 * pins), at standard size. Last on the canvas, a struggling user never saw it;
 * as the hero it would push aside the work they are stuck on.
 */
export const HELP_PANEL_SLOT = 1;
/** Next-step confidence for a primary suggestion. */
export const SUGGEST_PRIMARY_AT = 0.7;
/** Next-step confidence for a subtle suggestion. */
export const SUGGEST_SUBTLE_AT = 0.45;
/** Runner-up next step probability needed to show it as a second, subtle suggestion. */
export const RUNNER_UP_MIN_P = 0.25;
/** Target-client confidence needed to fill a suggestion's client. */
export const CLIENT_ARG_CONFIDENCE = 0.5;
/**
 * Focus aid 3: the usual action after opening a record of this kind is
 * offered (subtle) only while Jev offers no step of its own and gives "no
 * next step" less than this: Jev is unsure, not sure that nothing comes next.
 */
export const HABIT_SUGGEST_NONE_BELOW = 0.5;
/** Do not re-suggest an action the user dismissed this recently. */
export const SUGGESTION_DISMISS_HOLD_MS = 2 * 60_000;
/** Do not re-suggest an action (for the same client) the user just performed. */
export const SUGGESTION_DONE_HOLD_MS = 2 * 60_000;
/** A client record opened this recently counts as on screen, so "Open <client>" is not suggested for it. */
export const SHOWN_WINDOW_MS = 3 * 60_000;
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

/** Panel sizes by position for each layout mode. Positions past the end are compact. */
export const SLOTS: Record<LayoutMode, PanelSize[]> = {
  focus: ["hero", "standard", "standard", "compact", "compact", "compact"],
  compare: ["hero", "hero", "compact", "compact", "compact", "compact"],
  overview: ["standard", "standard", "standard", "standard", "standard", "standard", "standard", "standard"],
};

export const SIZE_RANK: Record<PanelSize, number> = { compact: 0, standard: 1, large: 2, hero: 3 };

/**
 * Live app state the store can pass, so a suggestion names the record the user
 * is looking at (and never an invoice that was already paid). Every field is
 * optional; without them the policy falls back to the fixtures.
 */
export interface PolicyLiveData {
  invoices?: Invoice[];
  messages?: Message[];
  projects?: Project[];
  view?: PanelViewState;
  focusedPanel?: PanelId | null;
  /** A record the user named (for example "INV-1047" in a command). Wins over every other pick. */
  invoiceId?: string;
}

// ---------------------------------------------------------------------------
// Default and traditional plans
// ---------------------------------------------------------------------------

export interface TraditionalOptions {
  pinned?: PanelId[];
  dismissed?: Partial<Record<PanelId, number>>;
  /** Panels the user opened from the dock by hand. */
  opened?: PanelId[];
  /** Panels the user made bigger: on the canvas at BIGGER_SIZE. */
  bigger?: PanelId[];
  /** The front group, newest first (PolicyInput.front): its pinned and bigger panels lead, in this order. Absent: pins first, in pin order. */
  front?: PanelId[];
}

/**
 * The fixed, non-adaptive layout: default panels in catalog order, all
 * standard size, plus the user's own manual changes (pins first, docked
 * panels removed, opened panels added). With no manual changes this is
 * exactly defaultPlan().
 */
export function traditionalPlan(opts: TraditionalOptions = {}): LayoutPlan {
  const pinned = unique((opts.pinned ?? []).filter(isPanelId));
  const dismissed = new Set(Object.keys(opts.dismissed ?? {}).filter(isPanelId));
  const base = PANEL_IDS.filter((p) => PANELS[p].defaultVisible);
  const opened = (opts.opened ?? []).filter(isPanelId);
  const bigger = new Set((opts.bigger ?? []).filter(isPanelId));
  const lead = (opts.front ?? []).filter((p) => isPanelId(p) && (pinned.includes(p) || bigger.has(p)));
  const order = unique([...lead, ...pinned, ...base, ...opened, ...bigger]).filter((p) => pinned.includes(p) || !dismissed.has(p));
  const placements: PanelPlacement[] = order.map((id) => ({
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
    docked: PANEL_IDS.filter((p) => !order.includes(p)),
    density: "standard",
    suggestions: [],
    help: "none",
    decisions: [],
    basedOnVersion: 0,
  };
}

/** Overview mode, default panels in catalog order as standard, the rest docked. Also the layout when adaptive is off. */
export function defaultPlan(): LayoutPlan {
  return traditionalPlan();
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export interface PanelScore {
  id: PanelId;
  /** Blended priority including the pin boost (and the habit part, focus aid 3). */
  priority: number;
  /** Weighted parts; they sum to priority. `habit` is 0 without PolicyInput.habit. */
  parts: { relevance: number; usage: number; goal: number; pin: number; habit: number };
  /** Unweighted inputs, 0..1, for reasons. `habit` is the learned chance of this panel being next. */
  raw: { relevance: number; usage: number; goal: number; habit: number };
  /** The goal that contributes most to this panel's goal affinity. */
  topGoal: GoalId | null;
}

/** The habit weight: the slider's value, else HABIT_WEIGHT. Not part of the blend's total (focus aid 3). */
export function habitWeight(weights: PolicyInput["weights"]): number {
  return weights.habit === undefined ? HABIT_WEIGHT : clean(weights.habit);
}

export function scorePanels(input: Pick<PolicyInput, "judgments" | "events" | "now" | "weights" | "pinned" | "habit">): Record<PanelId, PanelScore> {
  const { judgments, weights } = input;
  let wR = clean(weights.relevance);
  let wU = clean(weights.usage);
  let wG = clean(weights.goal);
  let total = wR + wU + wG;
  // All sliders at zero would make every priority zero; treat it as equal weights instead.
  if (total <= 0) {
    wR = wU = wG = 1;
    total = 3;
  }
  const usage = panelUsage(input.events, input.now);
  const goalProbs = (judgments.goal?.probabilities ?? {}) as Partial<Record<GoalId, number>>;
  const pinned = new Set(input.pinned);
  // Focus aid 3: the habit part is added on top of the blend, so without a habit every priority is exactly as before.
  const habitNext = input.habit?.next ?? {};
  const wH = input.habit ? habitWeight(weights) : 0;
  const out = {} as Record<PanelId, PanelScore>;
  for (const id of PANEL_IDS) {
    const r = judgments.relevance?.[id];
    const rel = r && r.max > 0 ? clamp01(r.score / r.max) : 0;
    let goal = 0;
    let topGoal: GoalId | null = null;
    let topContribution = 0;
    for (const g of GOAL_IDS) {
      const c = clean(goalProbs[g] ?? 0) * (GOAL_PANEL_AFFINITY[g][id] ?? 0);
      goal += c;
      if (c > topContribution) {
        topContribution = c;
        topGoal = g;
      }
    }
    goal = clamp01(goal);
    const chance = clamp01(habitNext[id] ?? 0);
    const parts = {
      relevance: (wR * rel) / total,
      usage: (wU * (usage[id] ?? 0)) / total,
      goal: (wG * goal) / total,
      pin: pinned.has(id) ? PIN_BOOST : 0,
      habit: wH * chance,
    };
    out[id] = {
      id,
      priority: parts.relevance + parts.usage + parts.goal + parts.pin + parts.habit,
      parts,
      raw: { relevance: rel, usage: usage[id] ?? 0, goal, habit: chance },
      topGoal,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------

export function helpLevel(struggling: number): LayoutPlan["help"] {
  if (struggling >= HELP_PANEL_AT) return "panel";
  if (struggling >= HELP_HINT_AT) return "hint";
  return "none";
}

/** The density one round's expertise judgment points to, or null when it is too unsure or too early to say. */
export function judgedDensity(expertise: ScoreJudgment | undefined, eventCount = DENSITY_MIN_EVENTS): Density | null {
  if (eventCount < DENSITY_MIN_EVENTS) return null;
  if (!expertise || !(expertise.max > 0) || (expertise.confidence ?? 0) < DENSITY_CONFIDENCE) return null;
  const x = expertise.score / expertise.max;
  if (x < GUIDED_BELOW) return "guided";
  if (x > DENSE_ABOVE) return "dense";
  return "standard";
}

/**
 * `recent` is the confidently judged densities of the last rounds, newest
 * last, including this one. When given, a change needs DENSITY_STREAK_LENGTH
 * of them to agree.
 */
export function pickDensity(previous: Density, expertise: ScoreJudgment | undefined, eventCount = DENSITY_MIN_EVENTS, recent?: Density[]): Density {
  const judged = judgedDensity(expertise, eventCount);
  if (!judged || judged === previous) return previous;
  if (recent) {
    const tail = recent.slice(-DENSITY_STREAK_LENGTH);
    if (tail.length < DENSITY_STREAK_LENGTH || !tail.every((d) => d === judged)) return previous;
  }
  return judged;
}

export function pickMode(
  previous: LayoutMode,
  layout: ChoiceJudgment<LayoutMode> | undefined,
  recentModes: LayoutMode[],
): { mode: LayoutMode; decision: Decision | null } {
  const judged = layout?.choice;
  if (!layout || !judged || !(LAYOUT_MODES as readonly string[]).includes(judged) || judged === previous) {
    return { mode: previous, decision: null };
  }
  const conf = layout.confidence ?? 0;
  const p = layout.probabilities?.[judged] ?? 0;
  const tail = recentModes.slice(-MODE_STREAK_LENGTH);
  const streak = tail.length === MODE_STREAK_LENGTH && tail.every((m) => m === judged);
  if (conf >= MODE_SWITCH_CONFIDENCE || (streak && conf >= MODE_STREAK_CONFIDENCE)) {
    return {
      mode: judged,
      decision: {
        kind: "mode",
        text: `Switched to the ${LAYOUT_MODE_DEFS[judged].label} layout`,
        evidence: `layout ${judged} p=${p2(p)}, confidence ${p2(conf)}${conf < MODE_SWITCH_CONFIDENCE ? `, judged ${timesWord(MODE_STREAK_LENGTH)} in a row` : ""}`,
      },
    };
  }
  return {
    mode: previous,
    decision: {
      kind: "hold",
      text: `Kept the ${LAYOUT_MODE_DEFS[previous].label} layout for now`,
      evidence: `layout ${judged} p=${p2(p)}, confidence ${p2(conf)} is below ${p2(streak ? MODE_STREAK_CONFIDENCE : MODE_SWITCH_CONFIDENCE)}`,
    },
  };
}

/**
 * Panels the user is using right now: the focused panel and any panel with a
 * very recent event. A panel whose latest event is a dismissal is not
 * protected: the user just sent it away, and that must win.
 */
export function protectedPanels(events: SignalEvent[], now: number, focused: PanelId | null): Set<PanelId> {
  const out = new Set<PanelId>();
  const lastType = new Map<PanelId, SignalEvent["type"]>();
  for (const e of events) {
    if (!e.panel) continue;
    lastType.set(e.panel, e.type);
    if (e.type === "panel_dismiss") out.delete(e.panel);
    else if (now - e.t <= PROTECT_RECENT_MS) out.add(e.panel);
  }
  if (focused && isPanelId(focused) && lastType.get(focused) !== "panel_dismiss") out.add(focused);
  return out;
}

/**
 * Panels whose size must not shrink right now: any panel with an event in the
 * last PROTECT_RECENT_MS, and the focused panel while its newest event is
 * within FOCUSED_SIZE_HOLD_MS. Unlike protectedPanels, focus alone does not
 * protect a size forever.
 */
export function sizeHeldPanels(events: SignalEvent[], now: number, focused: PanelId | null): Set<PanelId> {
  const out = new Set<PanelId>();
  const lastAt = new Map<PanelId, number>();
  const lastType = new Map<PanelId, SignalEvent["type"]>();
  for (const e of events) {
    if (!e.panel) continue;
    lastAt.set(e.panel, e.t);
    lastType.set(e.panel, e.type);
  }
  for (const [id, t] of lastAt) {
    if (lastType.get(id) === "panel_dismiss") continue;
    if (now - t <= PROTECT_RECENT_MS || (id === focused && now - t <= FOCUSED_SIZE_HOLD_MS)) out.add(id);
  }
  return out;
}

/**
 * Panels the user made bigger or smaller by hand in the event log. A quiet
 * one is faded but never shrunk: the user chose its size (docs/focus-aids.md).
 */
export function userResizedPanels(events: SignalEvent[]): Set<PanelId> {
  const out = new Set<PanelId>();
  for (const e of events) if (e.panel && (e.type === "panel_maximize" || e.type === "panel_restore")) out.add(e.panel);
  return out;
}

/** Panels opened from the dock in the last OPEN_HOLD_MS and not dismissed since. */
export function openHeldPanels(events: SignalEvent[], now: number): Set<PanelId> {
  const lastOpen = new Map<PanelId, number>();
  const lastDismiss = new Map<PanelId, number>();
  for (const e of events) {
    if (!e.panel) continue;
    if (e.type === "panel_open") lastOpen.set(e.panel, e.t);
    if (e.type === "panel_dismiss") lastDismiss.set(e.panel, e.t);
  }
  const out = new Set<PanelId>();
  for (const [id, t] of lastOpen) {
    const d = lastDismiss.get(id);
    if (now - t <= OPEN_HOLD_MS && (d == null || d < t)) out.add(id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

/** Labels for actions whose catalog label needs a client that we do not know. */
const GENERIC_LABELS: Partial<Record<ActionId, string>> = {
  send_payment_reminder: "Send a payment reminder",
  mark_invoice_paid: "Mark an invoice as paid",
  resend_invoice: "Resend an invoice",
  reply_to_message: "Reply to the latest message",
  schedule_meeting: "Schedule a meeting",
  view_client: "Open Clients",
};

export function actionLabel(actionId: ActionId, client?: string): string {
  // "{invoice}" names the invoice when makeSuggestion knows it; here it is not known.
  const label = (ACTIONS[actionId]?.label ?? "").replace("{invoice}", "the invoice");
  if (!label.includes("{client}")) return label;
  if (!client) return GENERIC_LABELS[actionId] ?? label.replace(/\s*\{client\}('s)?/g, "").trim();
  return label.replace("{client}'s", possessive(client)).replace("{client}", client);
}

function overdueFor(client: string | undefined, invoices: Invoice[] | undefined): Invoice | undefined {
  if (!invoices) return oldestOverdueInvoice(client);
  return invoices
    .filter((inv) => inv.status === "overdue" && (!client || inv.client === client))
    .sort((a, b) => a.due.localeCompare(b.due))[0];
}

function unpaidFor(client: string, invoices: Invoice[]): Invoice | undefined {
  return invoices
    .filter((inv) => inv.status === "sent" && inv.client === client)
    .sort((a, b) => a.due.localeCompare(b.due))[0];
}

/**
 * Which invoice an invoice action should act on: the client's oldest overdue
 * invoice, then the client's oldest unpaid one, then (with no client) the
 * oldest overdue invoice overall.
 */
export function pickInvoice(client: string | undefined, invoices?: Invoice[]): Invoice | undefined {
  if (client) return overdueFor(client, invoices) ?? unpaidFor(client, invoices ?? INVOICES);
  return overdueFor(undefined, invoices);
}

const isOpen = (inv: Invoice) => inv.status === "overdue" || inv.status === "sent" || inv.status === "draft";
const needsWork = (p: Project) => p.status === "at_risk" || p.status === "blocked";

/**
 * The record an action will act on. A record the user named wins, then the
 * one selected in its panel (when it fits the client), then the default pick.
 * The store's perform() acts on exactly this record, so the label never names
 * one record while the action changes another.
 */
function targetInvoice(actionId: ActionId, client: string | undefined, live: PolicyLiveData): Invoice | undefined {
  const invoices = live.invoices ?? INVOICES;
  const usable = (inv: Invoice | undefined) =>
    inv && (actionId === "mark_invoice_paid" ? isOpen(inv) : inv.status === "overdue" || inv.status === "sent") ? inv : undefined;
  const named = usable(live.invoiceId ? invoices.find((i) => i.id === live.invoiceId) : undefined);
  if (named) return named;
  const sel = live.view?.invoices.selectedId;
  const selected = usable(sel ? invoices.find((i) => i.id === sel) : undefined);
  if (selected && (!client || selected.client === client)) return selected;
  return pickInvoice(client, live.invoices);
}

function targetMessage(client: string | undefined, live: PolicyLiveData): Message | undefined {
  const messages = live.messages ?? MESSAGES;
  const inbox = live.view?.inbox;
  const sel = inbox?.selectedId;
  const selected = sel ? messages.find((m) => m.id === sel) : undefined;
  if (selected && (!client || selected.client === client)) return selected;
  const byNewest = [...messages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  if (client) return byNewest.find((m) => m.client === client);
  // A search or client filter in the Inbox: the message it shows first (the one in its detail pane).
  if (inbox && (inbox.query.trim() || inbox.client)) {
    const shown = byNewest.find((m) => (!inbox.client || m.client === inbox.client) && matchesQuery([m.from, m.subject, m.preview, m.client], inbox.query));
    if (shown) return shown;
  }
  return byNewest.find((m) => m.unread) ?? byNewest[0];
}

function targetProject(client: string | undefined, live: PolicyLiveData): Project | undefined {
  const projects = live.projects ?? PROJECTS;
  const sel = live.view?.projects.selectedId;
  const selected = sel ? projects.find((p) => p.id === sel) : undefined;
  if (selected && needsWork(selected) && (!client || selected.client === client)) return selected;
  return projects.find((p) => needsWork(p) && (!client || p.client === client));
}

/**
 * Build a suggestion with its target record filled in and named in the label.
 * Shared with command.ts so both label actions the same way. The last
 * argument may be the live invoices (the old form) or all live data.
 */
export function makeSuggestion(
  actionId: ActionId,
  prominence: Suggestion["prominence"],
  confidence: number,
  client: string | undefined,
  reason: string,
  liveOrInvoices: PolicyLiveData | Invoice[] = {},
): Suggestion {
  const live: PolicyLiveData = Array.isArray(liveOrInvoices) ? { invoices: liveOrInvoices } : liveOrInvoices;
  const args: Suggestion["args"] = {};
  let who = client;
  let label: string | null = null;
  if (actionId === "send_payment_reminder" || actionId === "mark_invoice_paid" || actionId === "resend_invoice") {
    const inv = targetInvoice(actionId, who, live);
    if (inv) {
      args.invoiceId = inv.id;
      who = inv.client;
      if (actionId === "resend_invoice") {
        // A resend always says which invoice goes out again.
        label = `Resend ${inv.id} to ${inv.client}`;
      } else if (inv.id !== pickInvoice(inv.client, live.invoices)?.id) {
        // Name the invoice when it is not the client's default pick, so the label says which one.
        label = actionId === "mark_invoice_paid" ? `Mark ${inv.id} as paid` : `Send a payment reminder for ${inv.id}`;
      }
    }
  } else if (actionId === "reply_to_message") {
    const m = targetMessage(who, live);
    if (m) {
      args.messageId = m.id;
      if (m.client) who = m.client;
      label = `Reply to ${m.from}`;
    }
  } else if (actionId === "update_project_status") {
    const p = targetProject(who, live);
    if (p) {
      args.projectId = p.id;
      who = p.client;
      label = `Mark ${p.name} on track`;
    }
  }
  if (who) args.client = who;
  return { actionId, label: label ?? actionLabel(actionId, who), prominence, confidence, args, reason };
}

/** The record a suggestion acts on, for matching it against actions already done. */
export function suggestionRecord(s: Suggestion): string | undefined {
  return s.args.invoiceId ?? s.args.messageId ?? s.args.projectId ?? s.args.taskId;
}

function blockedSuggestions(events: SignalEvent[], now: number): { dismissed: Set<ActionId>; done: Set<string> } {
  const dismissed = new Set<ActionId>();
  const done = new Set<string>();
  for (const e of events) {
    const id = e.detail?.actionId;
    if (!id) continue;
    if (e.type === "suggestion_dismiss" && now - e.t < SUGGESTION_DISMISS_HOLD_MS) dismissed.add(id);
    if (e.type === "action" && now - e.t < SUGGESTION_DONE_HOLD_MS) {
      done.add(`${id}|${e.detail?.client ?? ""}`);
      // Any client: blocks a suggestion whose client came from code, not from Jev.
      done.add(`${id}|*`);
      if (e.detail?.itemId) done.add(`${id}#${e.detail.itemId}`);
    }
  }
  return { dismissed, done };
}

/**
 * True when a suggestion would repeat what the user just turned down or did:
 * its action was dismissed in the last SUGGESTION_DISMISS_HOLD_MS, or done on
 * the same record in the last SUGGESTION_DONE_HOLD_MS. For suggestions built
 * outside buildSuggestions (the next step in ./linkFlow.ts).
 */
export function suggestionBlocked(s: Suggestion, events: SignalEvent[], now: number): boolean {
  const blocked = blockedSuggestions(events, now);
  const record = suggestionRecord(s);
  return blocked.dismissed.has(s.actionId) || (record !== undefined && blocked.done.has(`${s.actionId}#${record}`));
}

function clientMatches(value: string | null | undefined, client: string): boolean {
  if (!value) return false;
  return value === client || CLIENTS.some((c) => c.id === value && c.name === client);
}

/**
 * True when the suggestion's result is already on screen, so accepting it
 * would do nothing: opening the client the user is looking at, or writing a
 * note while in Notes.
 */
function alreadyShown(s: Suggestion, events: SignalEvent[], now: number, live: PolicyLiveData): boolean {
  if (s.actionId === "write_note") return live.focusedPanel === "notes";
  if (s.actionId !== "view_client") return false;
  const client = s.args.client;
  if (!client) return live.focusedPanel === "clients";
  if (clientMatches(live.view?.clients.selected, client)) return true;
  // Without view state (a replay), the newest client record opened recently says what is shown.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (now - e.t > SHOWN_WINDOW_MS) break;
    if (e.type === "item_open" && e.panel === "clients") return e.detail?.client === client;
  }
  return false;
}

/** The record kind an action works on; the other actions act on a client or on nothing. */
const ACTION_RECORD_KIND: Partial<Record<ActionId, ItemKind>> = {
  send_payment_reminder: "invoice",
  mark_invoice_paid: "invoice",
  resend_invoice: "invoice",
  reply_to_message: "message",
  update_project_status: "project",
};

/**
 * Focus aid 3: the usual action after opening a record of this kind, as a
 * subtle suggestion, while Jev's "no next step" is under
 * HABIT_SUGGEST_NONE_BELOW. An action on a kind of record is offered only
 * for the open record itself (never another invoice of the client); the
 * others go to the record's client. Null when it does not fit.
 */
function habitSuggestion(habit: NonNullable<HabitHints["action"]>, na: ChoiceJudgment<ActionId> | undefined, live: PolicyLiveData): Suggestion | null {
  if (habit.actionId === "none" || !ACTIONS[habit.actionId]) return null;
  const none = na ? (na.probabilities?.none ?? (na.choice === "none" ? (na.confidence ?? 0) : 0)) : 0;
  if (none >= HABIT_SUGGEST_NONE_BELOW) return null;
  const s = makeSuggestion(habit.actionId, "subtle", habit.share, habit.client, habitActionReason(habit.kind), live);
  const onKind = ACTION_RECORD_KIND[habit.actionId];
  if (onKind && (onKind !== habit.kind || suggestionRecord(s) !== habit.recordId)) return null;
  return { ...s, habit: true };
}

/**
 * The suggestions from Jev's next step: primary at SUGGEST_PRIMARY_AT,
 * subtle at SUGGEST_SUBTLE_AT with a runner-up. With `habit` (focus aid 3),
 * when Jev offers none, the usual action after the open record's kind may be
 * offered, always subtle (habitSuggestion). None repeats what the user just
 * turned down or did.
 */
export function buildSuggestions(
  judgments: Judgments,
  events: SignalEvent[],
  now: number,
  liveOrInvoices: PolicyLiveData | Invoice[] = {},
  habit?: HabitHints["action"],
): Suggestion[] {
  const live: PolicyLiveData = Array.isArray(liveOrInvoices) ? { invoices: liveOrInvoices } : liveOrInvoices;
  const na = judgments.nextAction;
  const jevStep = na !== undefined && na.choice !== "none" && Boolean(ACTIONS[na.choice]);
  if (!jevStep && !habit) return [];
  const tc = judgments.targetClient;
  const client = tc && tc.choice && tc.choice !== "none" && (tc.confidence ?? 0) >= CLIENT_ARG_CONFIDENCE ? tc.choice : undefined;
  const goal = judgments.goal?.choice;
  const goalText = goal && goal !== "unclear" && GOALS[goal] ? ` while ${lowerFirst(GOALS[goal].label)}` : "";

  const out: Suggestion[] = [];
  const conf = na?.confidence ?? 0;
  if (na && jevStep && conf >= SUGGEST_PRIMARY_AT) {
    out.push(makeSuggestion(na.choice, "primary", conf, client, `Likely next step${goalText}`, live));
  } else if (na && jevStep && conf >= SUGGEST_SUBTLE_AT) {
    out.push(makeSuggestion(na.choice, "subtle", conf, client, `A possible next step${goalText}`, live));
    const runnerUp = (Object.entries(na.probabilities ?? {}) as [ActionId, number][])
      .filter(([id]) => id !== na.choice && id !== "none" && ACTIONS[id])
      .sort((a, b) => b[1] - a[1])[0];
    if (runnerUp && runnerUp[1] >= RUNNER_UP_MIN_P) {
      out.push(makeSuggestion(runnerUp[0], "subtle", runnerUp[1], client, "Another possible next step", live));
    }
  }
  // Jev is unsure of the next step: the user's habit after this kind of record may be offered, subtle only.
  const fromHabit = out.length === 0 && habit ? habitSuggestion(habit, na, live) : null;
  if (fromHabit) out.push(fromHabit);
  const blocked = blockedSuggestions(events, now);
  const isDone = (s: Suggestion) => {
    // With a client from Jev, only that client's action blocks it. Without one,
    // the client was filled in by code, so the action for any client blocks it:
    // otherwise "Reply to the latest message" came back at once and the next
    // click acted on a different message.
    const record = suggestionRecord(s);
    // A habit suggestion names its record (or its client) exactly, so only that one done blocks it: a reminder just sent for another invoice does not.
    if (s.habit) return record !== undefined ? blocked.done.has(`${s.actionId}#${record}`) : blocked.done.has(`${s.actionId}|${s.args.client ?? ""}`);
    const byClient = client ? `${s.actionId}|${s.args.client ?? ""}` : `${s.actionId}|*`;
    return blocked.done.has(byClient) || (record !== undefined && blocked.done.has(`${s.actionId}#${record}`));
  };
  return out.filter((s) => !blocked.dismissed.has(s.actionId) && !isDone(s) && !alreadyShown(s, events, now, live));
}

// ---------------------------------------------------------------------------
// Ordering and sizing
// ---------------------------------------------------------------------------

/**
 * Keep the previous order unless a lower panel beats the one above it by
 * more than ORDER_SWAP_MARGIN. New panels enter at their priority position.
 */
export function orderWithHysteresis(ids: PanelId[], previousOrder: PanelId[], priority: (id: PanelId) => number): PanelId[] {
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

// ---------------------------------------------------------------------------
// Diff against the previous plan
// ---------------------------------------------------------------------------

interface Evidence {
  panel?: (id: PanelId) => string | undefined;
  density?: string;
  help?: string;
  suggestion?: (s: Suggestion) => string | undefined;
}

type Draft = Omit<LayoutPlan, "decisions">;

function suggestionKey(s: Suggestion): string {
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

const HELP_TEXT: Record<LayoutPlan["help"], string> = {
  panel: `Opened the ${panelTitle("help")} because you may be stuck`,
  hint: "Showed a tip because you may be stuck",
  none: "Put help away",
};

/**
 * Panels that changed place relative to the others. The longest run of
 * panels that kept their relative order stayed put; everything else moved.
 * So a panel entering or leaving, which shifts everything after it, reports
 * no moves, while a swap of two neighbors reports the one that went up.
 */
function movedPanels(previousOrder: PanelId[], nextOrder: PanelId[]): Map<PanelId, "up" | "down"> {
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
  const out = new Map<PanelId, "up" | "down">();
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
function cellMoves(previous: Partial<Record<PanelId, GridCell>>, next: Partial<Record<PanelId, GridCell>>): Map<PanelId, "up" | "down"> {
  const out = new Map<PanelId, "up" | "down">();
  for (const [id, c] of Object.entries(next) as [PanelId, GridCell][]) {
    const p = previous[id];
    if (!p || (p.col === c.col && p.row === c.row)) continue;
    out.set(id, startsBefore(c, p) ? "up" : "down");
  }
  return out;
}

interface PanelMarks {
  placements: PanelPlacement[];
  docks: Decision[];
  shrinks: Decision[];
  adds: Decision[];
  grows: Decision[];
  moved: Decision[];
}

/** placement.change and the per-panel decisions, from sizes, membership, and `moves`. */
function markPanels(previous: LayoutPlan, placements: PanelPlacement[], moves: Map<PanelId, "up" | "down">, evidence: Evidence): PanelMarks {
  const prevSize = new Map(previous.placements.map((p) => [p.id, p.size]));
  const adds: Decision[] = [];
  const grows: Decision[] = [];
  const shrinks: Decision[] = [];
  const moved: Decision[] = [];
  const marked = placements.map((p): PanelPlacement => {
    const title = panelTitle(p.id);
    const oldSize = prevSize.get(p.id);
    let change: PanelPlacement["change"] = null;
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
  const docks: Decision[] = previous.placements
    .filter((p) => !onCanvas.has(p.id))
    .map((p) => ({ kind: "dock", panel: p.id, text: `Moved ${panelTitle(p.id)} to the dock`, evidence: evidence.panel?.(p.id) }));
  return { placements: marked, docks, shrinks, adds, grows, moved };
}

/** Set placement.change on changed panels and list what changed and why. */
function finalize(previous: LayoutPlan, draft: Draft, leading: Decision[], evidence: Evidence): LayoutPlan {
  const decisions: Decision[] = [...leading];

  if (draft.mode !== previous.mode && !leading.some((d) => d.kind === "mode")) {
    decisions.push({ kind: "mode", text: `Switched to the ${LAYOUT_MODE_DEFS[draft.mode].label} layout` });
  }
  if (draft.density !== previous.density) {
    decisions.push({ kind: "density", text: densityText(draft.density, previous.placements.length, draft.placements.length), evidence: evidence.density });
  }
  // Only claim the Guide opened when it is actually on the canvas.
  const guideShown = draft.placements.some((p) => p.id === "help");
  if (draft.help !== previous.help && (draft.help !== "panel" || guideShown)) {
    decisions.push({ kind: "help", panel: draft.help === "panel" ? "help" : undefined, text: HELP_TEXT[draft.help], evidence: evidence.help });
  }

  const moves = movedPanels(
    previous.placements.map((p) => p.id),
    draft.placements.map((p) => p.id),
  );
  const { placements, docks, shrinks, adds, grows, moved } = markPanels(previous, draft.placements, moves, evidence);

  const prevSuggestions = new Set(previous.suggestions.map(suggestionKey));
  const suggests: Decision[] = draft.suggestions
    .filter((s) => !prevSuggestions.has(suggestionKey(s)))
    .map((s) => ({ kind: "suggest", text: `Suggested: ${s.label}`, evidence: evidence.suggestion?.(s) }));

  // What left or shrank comes first: the change feed shows only the first few
  // lines, and a panel that disappears is the change people miss most.
  decisions.push(...docks, ...shrinks, ...adds, ...grows, ...moved, ...suggests);
  return { ...draft, placements, decisions: decisions.map(stripUndefined) };
}

/** Decision kinds finalize lists before the per-panel ones (and the store's holds and commands). */
const LEADING_KINDS: ReadonlySet<Decision["kind"]> = new Set<Decision["kind"]>(["mode", "density", "help", "hold", "command"]);

/**
 * Re-mark the per-panel changes after the store packed a plan into cells.
 * The packer can keep a size the policy asked to change (an anchor with no
 * room to grow) and keeps cards in their cells while the order changes, so
 * the badges and change-feed lines must describe the cells, not the order.
 * With `decisions` false only the badges change (undo keeps its own line).
 */
export function remarkPanels(
  previous: LayoutPlan,
  next: LayoutPlan,
  opts: { previousCells: Partial<Record<PanelId, GridCell>> | null; decisions: boolean },
): LayoutPlan {
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
export function markChanges(previous: LayoutPlan, next: LayoutPlan): LayoutPlan {
  const { decisions: _decisions, ...draft } = next;
  void _decisions;
  return finalize(previous, { ...draft, placements: next.placements.map((p) => ({ ...p, change: null })) }, [], {});
}

// ---------------------------------------------------------------------------
// computePlan
// ---------------------------------------------------------------------------

type PartKind = "relevance" | "usage" | "goal" | "habit";

/** The largest weighted part. The habit part (focus aid 3) wins only when strictly larger: the older parts come first on a tie. */
function strongestPart(sc: PanelScore): { kind: PartKind; value: number } {
  const entries: { kind: PartKind; value: number }[] = [
    { kind: "relevance", value: sc.parts.relevance },
    { kind: "usage", value: sc.parts.usage },
    { kind: "goal", value: sc.parts.goal },
    { kind: "habit", value: sc.parts.habit },
  ];
  return entries.sort((a, b) => b.value - a.value)[0];
}

function reasonFor(sc: PanelScore, ctx: { forcedHelp: boolean; working: boolean; opened: boolean; habit?: HabitHints }): string {
  if (sc.parts.pin > 0) return "Pinned by you";
  if (sc.id === "help" && ctx.forcedHelp) return "Shown because you may need help";
  const top = strongestPart(sc);
  if (top.value < 0.02) {
    if (ctx.working) return "You are working in it";
    if (ctx.opened) return "You opened it";
    return "Part of your workspace";
  }
  if (top.kind === "habit" && ctx.habit) return habitReason(ctx.habit, sc.id);
  if (top.kind === "relevance") {
    return sc.raw.relevance >= CENTRAL_RELEVANCE ? "Jev rates it central to your current work" : "Jev rates it useful for your current work";
  }
  if (top.kind === "usage") return sc.raw.usage >= HEAVY_USAGE ? "You used it a lot in the last minutes" : "You used it recently";
  return `Fits the goal: ${sc.topGoal ? GOALS[sc.topGoal].label : GOALS.unclear.label}`;
}

function panelEvidence(sc: PanelScore, j: Judgments, habit?: HabitHints): string {
  if (sc.parts.pin > 0) return `pinned, priority ${p2(sc.priority)}`;
  const top = strongestPart(sc);
  // Focus aid 3: the habit's share of the part, when it had one ("habit: after inbox in the morning p=0.82").
  const usual = habit && sc.parts.habit > 0 ? `habit ${habit.from ?? "session start"} to ${sc.id} in the ${habit.bucket} p=${p2(sc.raw.habit)}` : "";
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
export function computePlan(input: PolicyInput, live: PolicyLiveData = {}): LayoutPlan {
  const { judgments: j, previous, events, now } = input;
  const pinned = unique(input.pinned.filter(isPanelId));
  const pinnedSet = new Set(pinned);
  const scores = scorePanels({ ...input, pinned });
  const avoid = input.avoid ?? {};

  const docked = (id: PanelId) => {
    const t = input.dismissed[id];
    return !pinnedSet.has(id) && t != null && now - t < DISMISS_HOLD_MS;
  };

  let help = helpLevel(typeof j.struggling === "number" ? j.struggling : 0);
  // The user sent the Guide to the dock a moment ago. Honor that, but still
  // show the lighter tip banner instead of no help at all.
  if (help === "panel" && docked("help")) help = "hint";

  let { mode, decision: modeDecision } = pickMode(previous.mode, j.layout, input.recentModes);
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
  const density = pickDensity(
    previous.density,
    j.expertise,
    events.filter((e) => e.type !== "panel_dwell" && e.type !== "context_save" && e.type !== "task_done" && e.type !== "prep_offer").length,
    input.recentDensities,
  );

  const working = protectedPanels(events, now, input.focusedPanel);
  const sizeHeld = sizeHeldPanels(events, now, input.focusedPanel);
  const opened = openHeldPanels(events, now);

  const wasVisible = new Set(previous.placements.map((p) => p.id));
  const prevAddedAt = new Map(previous.placements.filter((p) => p.addedAt != null).map((p) => [p.id, p.addedAt as number]));
  const autoDocked = previous.autoDockedAt ?? {};
  const avoidAdd = new Set(avoid.add ?? []);
  const avoidDock = new Set(avoid.dock ?? []);
  // Minimum stay: a panel the policy added recently, or one whose docking the user undid, keeps its seat.
  const sticky = (id: PanelId) => {
    if (!wasVisible.has(id)) return false;
    const t = prevAddedAt.get(id);
    return (t != null && now - t < MEMBERSHIP_HOLD_MS) || avoidDock.has(id);
  };
  // And the reverse: a panel the policy docked recently, or one whose adding the user undid, waits in the dock.
  const heldInDock = (id: PanelId) => {
    if (wasVisible.has(id)) return false;
    const t = autoDocked[id];
    return (t != null && now - t < MEMBERSHIP_HOLD_MS) || avoidAdd.has(id);
  };

  // Anchored round (docs/anchored-relayout.md): the panel the user just worked
  // in stays, and so does everything before it on screen.
  const anchor = input.anchor ?? null;
  const prevOrder = previous.placements.map((p) => p.id);
  const prevCells = previous.grid?.cells ?? {};
  const workAnchor =
    anchor && anchor.source !== "command" && isPanelId(anchor.panel) && wasVisible.has(anchor.panel) && prevCells[anchor.panel] && !docked(anchor.panel)
      ? anchor.panel
      : null;
  const locked = new Set(workAnchor ? lockedPanels(prevOrder, prevCells, workAnchor).filter((id) => wasVisible.has(id) && !docked(id)) : []);
  // The pointer's panel waits to leave (the store passes it while the pointer rests on it).
  const hold = (input.hold ?? []).filter((id) => isPanelId(id) && wasVisible.has(id) && !docked(id));
  // Panels the user made bigger: the user decides, so they stay, at BIGGER_SIZE, like a size pin.
  const bigger = new Set(unique((input.bigger ?? []).filter(isPanelId)).filter((id) => !docked(id)));

  // Linked panels: the top few by priority get a small boost, so Jev still decides.
  const boosted = new Set(anchor ? boostedPanels(anchor, input.linked, (id) => scores[id].priority, (id) => !docked(id) && !heldInDock(id)) : []);
  const priority = (id: PanelId) => scores[id].priority + (boosted.has(id) ? LINK_PRIORITY_BOOST : 0);

  // A panel already on the canvas that shows a record linked to the work
  // anchor stays this round, tagged or not: docking Kite's bill while other
  // panels say "Linked to Kite & Co." takes away what the user is looking for.
  const linkedShown = workAnchor
    ? PANEL_IDS.filter((id) => id !== workAnchor && wasVisible.has(id) && (input.linked?.[id]?.length ?? 0) > 0)
    : [];
  // The link cues on screen outlive the anchor: their source and linked
  // panels stay until the user clears the links (they may still move).
  const linkHeld = new Set(
    input.linkHold ? [input.linkHold.source, ...input.linkHold.linked].filter((id) => isPanelId(id) && wasVisible.has(id) && !docked(id)) : [],
  );

  // Panels that must be on the canvas regardless of priority.
  const required = unique([
    ...pinned,
    ...(help === "panel" ? (["help"] as PanelId[]) : []),
    ...(workAnchor ? [workAnchor] : []),
    ...locked,
    ...hold,
    ...linkedShown,
    ...linkHeld,
    ...bigger,
    ...PANEL_IDS.filter((id) => working.has(id) || opened.has(id)),
  ]).filter((id) => !docked(id));
  const selected = [...required];

  const cap = Math.min(SLOTS[mode].length, DENSITY_CAPS[density]);
  const seatScore = (id: PanelId) => priority(id) + (wasVisible.has(id) ? INCUMBENT_BONUS : 0);
  // Hysteresis band around the dock threshold.
  const threshold = (id: PanelId) => (wasVisible.has(id) ? DOCK_BELOW_PRIORITY - DOCK_MARGIN : DOCK_BELOW_PRIORITY + DOCK_MARGIN);
  // The Guide only joins through `required` (help === "panel", pinned, or in use).
  const candidates = PANEL_IDS.filter((id) => !selected.includes(id) && !docked(id) && id !== "help");
  const byScore = (a: PanelId, b: PanelId) => seatScore(b) - seatScore(a) || catalogIndex(a) - catalogIndex(b);
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
  const forcedGuide = help === "panel" && normalOrder.includes("help") && !leadSet.has("help");
  if (forcedGuide) {
    const at = Math.min(Math.max(HELP_PANEL_SLOT, lead.length), normalOrder.length - 1);
    normalOrder.splice(normalOrder.indexOf("help"), 1);
    normalOrder.splice(at, 0, "help");
  }
  let order = normalOrder;
  if (workAnchor) {
    // Pins (or the front group) first (they keep their cells; the packer
    // holds them), then the locked panels in their old order around the
    // anchor, then everything else after it. A forced Guide leads the newcomers.
    const at = prevOrder.indexOf(workAnchor);
    const keep = (id: PanelId) => locked.has(id) && selected.includes(id) && !leadSet.has(id);
    const before = prevOrder.slice(0, at).filter(keep);
    const after = prevOrder.slice(at + 1).filter(keep);
    const placed = new Set<PanelId>([...lead, ...before, workAnchor, ...after]);
    let others = orderWithHysteresis(
      selected.filter((id) => !placed.has(id)),
      prevOrder,
      priority,
    );
    if (forcedGuide && others.includes("help")) others = ["help", ...others.filter((id) => id !== "help")];
    order = unique([...lead, ...before, workAnchor, ...after, ...others]);
  }

  const relations = relationsOnCanvas(anchor, input.linked, order, (id) => !wasVisible.has(id), priority);

  // Focus aid 1 (docs/focus-aids.md): the panels the store judged quiet. The
  // policy checks its own exemptions again (the anchor, a panel it tags as
  // linked this round or the link cues hold, pins, bigger panels, the Guide
  // it opened, the pointer's card).
  const quietIn = new Set((input.quiet ?? []).filter(isPanelId));
  const resized = quietIn.size > 0 ? userResizedPanels(events) : new Set<PanelId>();

  const prevSize = new Map(previous.placements.map((p) => [p.id, p.size]));
  const slots = SLOTS[mode];
  // With the front group, the panels after it take the mode's slots as if they led (the Focus hero is the policy's own).
  const slotOf = (i: number): PanelSize => slots[input.front && i >= lead.length ? i - lead.length : i] ?? "compact";
  const placements: PanelPlacement[] = order.map((id, i) => {
    let size: PanelSize = slotOf(i);
    if (id === "help" && forcedGuide) size = "standard";
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
      !(id === "help" && forcedGuide) &&
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
      ? quietReason(j.goal?.choice)
      : reasonFor(sc, { forcedHelp: help === "panel", working: working.has(id), opened: opened.has(id), ...(input.habit ? { habit: input.habit } : {}) });
    return {
      id,
      size,
      priority: round3(priority(id)),
      pinned: pinnedSet.has(id),
      // A panel that joined for the link says so; one that was already here keeps Jev's reason.
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
  const autoDockedAt: Partial<Record<PanelId, number>> = {};
  for (const [id, t] of Object.entries(autoDocked) as [PanelId, number][]) {
    if (now - t < MEMBERSHIP_HOLD_MS && !order.includes(id)) autoDockedAt[id] = t;
  }
  for (const p of previous.placements) if (!order.includes(p.id) && !docked(p.id)) autoDockedAt[p.id] = now;

  const suggestions = buildSuggestions(j, events, now, { ...live, focusedPanel: live.focusedPanel ?? input.focusedPanel }, input.habit?.action);
  const draft: Draft = {
    mode,
    placements,
    docked: PANEL_IDS.filter((id) => !order.includes(id)),
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
      if (id === "help" && help !== "panel" && !order.includes(id)) return `struggling p=${p2(j.struggling ?? 0)}`;
      if (!order.includes(id)) {
        if (heldInDock(id)) return avoidAdd.has(id) ? "you undid adding it" : "sent to the dock less than 30 s ago";
        return priority(id) < threshold(id)
          ? `priority ${p2(priority(id))} is below ${p2(threshold(id))}`
          : `priority ${p2(priority(id))}, no room for more than ${cap} panels`;
      }
      if (id === "help" && help === "panel" && !pinnedSet.has(id)) return `struggling p=${p2(j.struggling ?? 0)}`;
      const link = boosted.has(id) && anchor ? `, linked to ${anchor.label ?? anchor.client ?? panelTitle(anchor.panel)} +${p2(LINK_PRIORITY_BOOST)}` : "";
      const mine = bigger.has(id) ? ", made bigger by you" : "";
      const hushed = quietShown.has(id) ? `, quiet: relevance below ${p2(QUIET_BELOW)} for a while` : "";
      if (id === workAnchor) return `${panelEvidence(scores[id], j, input.habit)}${mine}, you are working in it`;
      return `${panelEvidence(scores[id], j, input.habit)}${link}${mine}${hushed}`;
    },
    density: exp ? `expertise ${p2(exp.score)} of ${exp.max}, confidence ${p2(exp.confidence)}` : undefined,
    help: `struggling p=${p2(typeof j.struggling === "number" ? j.struggling : 0)}`,
    suggestion: (s) => {
      if (s.habit) return `habit after opening a ${input.habit?.action?.kind ?? "record"}: ${s.actionId} ${p2(s.confidence)} of the time, Jev unsure (next step ${j.nextAction?.choice ?? "none"} p=${p2(j.nextAction?.confidence ?? 0)})`;
      const tc = j.targetClient;
      const clientPart = s.args.client && tc?.choice === s.args.client ? `, client ${s.args.client} p=${p2(tc.probabilities?.[s.args.client] ?? tc.confidence)}` : "";
      return `next step ${s.actionId} p=${p2(j.nextAction?.probabilities?.[s.actionId] ?? s.confidence)}${clientPart}`;
    },
  });
}

// ---------------------------------------------------------------------------
// Plan edits that do not come from judgments
// ---------------------------------------------------------------------------

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
export function applyPromotion(args: {
  plan: LayoutPlan;
  previous: LayoutPlan;
  panel: PanelId;
  pinned: PanelId[];
  decision?: Decision;
  anchor?: AnchorRef | null;
  linked?: Partial<Record<PanelId, RelatedRecord[]>>;
  linkHold?: PolicyInput["linkHold"];
  /** Panels the user made bigger: kept past the cap, at BIGGER_SIZE. */
  bigger?: PanelId[];
  /** The front group, newest first (PolicyInput.front): right after the hero, in this order, a pin at its own size. Absent: the pins follow the hero. */
  front?: PanelId[];
}): LayoutPlan {
  const { plan, previous, panel } = args;
  const anchor = args.anchor !== undefined ? args.anchor : (plan.anchor ?? null);
  const pinnedSet = new Set(args.pinned);
  const existing = new Map(plan.placements.map((p) => [p.id, p]));
  let relations = new Map<PanelId, PanelRelation>();
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
  const placements: PanelPlacement[] = kept.map((id, i) => {
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
    docked: PANEL_IDS.filter((id) => !kept.includes(id)),
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

export interface PlanEdit {
  /**
   * "bigger" and "smaller": the user's "Make bigger" and "Make smaller".
   * "unquiet": the user clicked into or used a quiet panel, so it is a
   * normal panel again, at the size it had before it went quiet.
   */
  kind: "open" | "dismiss" | "pin" | "unpin" | "bigger" | "smaller" | "unquiet";
  panel: PanelId;
  /** "smaller" only: the size to go back to (see restoredSize). Default RESTORE_FALLBACK_SIZE. */
  size?: PanelSize;
}

/**
 * The size a panel goes back to when the user makes it smaller: the size it
 * had before they made it bigger when known, else its slot's size, and never
 * the hero (RESTORE_FALLBACK_SIZE instead), so it always gets smaller. The
 * policy decides its size again from the next round on.
 */
export function restoredSize(plan: LayoutPlan, id: PanelId, before?: PanelSize): PanelSize {
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
export function editPlan(plan: LayoutPlan, edit: PlanEdit, opts: { pinsFirst?: boolean; front?: PanelId[] } = {}): LayoutPlan {
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
      const q: PanelPlacement = {
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
  const draft: Draft = { ...plan, placements, docked: PANEL_IDS.filter((id) => !ids.has(id)) };
  const by: Record<PlanEdit["kind"], string> = {
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
export function planSignature(plan: LayoutPlan): string {
  // Cells count: with explicit cells a card can move while order and size stay the same.
  const cells = plan.grid?.cells ?? {};
  const cellText = (id: PanelId) => {
    const c = cells[id];
    return c ? `@${c.col},${c.row}` : "";
  };
  const panels = plan.placements.map((p) => `${p.id}:${p.size}:${p.pinned ? 1 : 0}${cellText(p.id)}`).join(",");
  const sugg = plan.suggestions.map((s) => `${s.actionId}:${s.prominence}:${s.label}:${s.args.invoiceId ?? ""}`).join(",");
  return `${plan.mode}|${plan.density}|${plan.help}|${panels}|${sugg}`;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * The panels that get the link boost: the top LINKED_PANELS_MAX of those
 * holding linked records, by priority, among panels that may join at all
 * (not dismissed, not held in the dock). Relations are picked after
 * selection (relationsOnCanvas).
 */
function boostedPanels(
  anchor: AnchorRef,
  linked: Partial<Record<PanelId, RelatedRecord[]>> | undefined,
  priority: (id: PanelId) => number,
  eligible: (id: PanelId) => boolean,
): PanelId[] {
  if (!linked) return [];
  return (Object.keys(linked) as PanelId[])
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
  anchor: AnchorRef | null,
  linked: Partial<Record<PanelId, RelatedRecord[]>> | undefined,
  onCanvas: PanelId[],
  isNew: (id: PanelId) => boolean,
  priority: (id: PanelId) => number,
): Map<PanelId, PanelRelation> {
  const out = new Map<PanelId, PanelRelation>();
  if (!anchor || !linked) return out;
  const ids = onCanvas
    .filter((id) => id !== anchor.panel && (linked[id]?.length ?? 0) > 0)
    .sort((a, b) => Number(isNew(b)) - Number(isNew(a)) || priority(b) - priority(a) || catalogIndex(a) - catalogIndex(b))
    .slice(0, LINKED_PANELS_MAX);
  for (const id of ids) out.set(id, relationFor(anchor, id, linked[id]!));
  return out;
}

/** A placement without the quiet marks (the user chose it, or the aid is off). */
export function withoutQuiet(p: PanelPlacement): PanelPlacement {
  if (!p.quiet && !p.unquietSize) return p;
  const q = { ...p };
  delete q.quiet;
  delete q.unquietSize;
  return q;
}

/** The largest of the given sizes. */
function largest(...sizes: PanelSize[]): PanelSize {
  return sizes.reduce((a, b) => (SIZE_RANK[b] > SIZE_RANK[a] ? b : a));
}

function carryEvidence(decisions: Decision[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of decisions) {
    if (!d.evidence) continue;
    if (d.panel && d.kind !== "help") out.set(`panel:${d.panel}`, d.evidence);
    if (d.kind === "density" || d.kind === "help") out.set(d.kind, d.evidence);
    if (d.kind === "suggest") out.set(`suggest:${d.text.replace(/^Suggested: /, "")}`, d.evidence);
  }
  return out;
}

function stripUndefined(d: Decision): Decision {
  const out: Decision = { kind: d.kind, text: d.text };
  if (d.panel) out.panel = d.panel;
  if (d.evidence) out.evidence = d.evidence;
  return out;
}

export function isPanelId(value: unknown): value is PanelId {
  return typeof value === "string" && (PANEL_IDS as readonly string[]).includes(value);
}

function catalogIndex(id: PanelId): number {
  return PANEL_IDS.indexOf(id);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function clean(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
