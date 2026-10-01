/**
 * The demo's layout policy: Jev's judgments in, a LayoutPlan out.
 *
 * The rules (membership, docking with its band, order with hysteresis,
 * sizes, anchors and links, quiet panels, the decisions in words) are
 * createPolicy in @attune/core. This file binds them to the demo: its
 * catalog, its recent use, its suggestions with their record arguments (an
 * invoice, a message, a project), its link words, its Guide as the help
 * panel, its habit words (focus aid 3), and the engine notes that do not
 * count toward density. Pure: no DOM, no store, no clock except `input.now`.
 */
import * as Lib from "@attune/core";
import {
  createPolicy,
  lowerFirst,
  matchesQuery,
  p2,
  possessive,
  RUNNER_UP_MIN_P,
  SUGGEST_PRIMARY_AT,
  SUGGEST_SUBTLE_AT,
  type PlanEdit as LibPlanEdit,
} from "@attune/core";
import { ACTIONS, CATALOG, GOALS, type ActionId, type GoalId, type PanelId } from "../../shared/catalog.ts";
import { CLIENTS, INVOICES, MESSAGES, PROJECTS, oldestOverdueInvoice, type Invoice, type Message, type Project } from "../../shared/fixtures.ts";
import type { ChoiceJudgment, ItemKind, Judgments, LayoutPlan, SignalEvent, Suggestion } from "../../shared/types.ts";
import type { HabitHints, PanelViewState, PolicyInput } from "./contract.ts";
import { HABIT_WEIGHT, habitActionReason, habitReason } from "./habits.ts";
import { relationFor } from "./relations.ts";
import { panelUsage } from "./usage.ts";

// ---------------------------------------------------------------------------
// Suggestion thresholds. The layout thresholds, and the next-step
// thresholds (SUGGEST_PRIMARY_AT, SUGGEST_SUBTLE_AT, RUNNER_UP_MIN_P), are
// in @attune/core.
// ---------------------------------------------------------------------------

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
// Scoring
// ---------------------------------------------------------------------------

/** A panel's priority and its parts (PanelScore in @attune/core), for the demo's panels and goals. */
export type PanelScore = Lib.PanelScore<PanelId, GoalId>;

/** The habit weight: the slider's value, else HABIT_WEIGHT. Not part of the blend's total (focus aid 3). */
export function habitWeight(weights: PolicyInput["weights"]): number {
  return weights.habit === undefined ? HABIT_WEIGHT : clean(weights.habit);
}

/** scorePanels in @attune/core, with the demo's catalog, its recent use, and its habit weight (focus aid 3). */
export function scorePanels(input: Pick<PolicyInput, "judgments" | "events" | "now" | "weights" | "pinned" | "habit">): Record<PanelId, PanelScore> {
  return Lib.scorePanels(CATALOG, {
    judgments: input.judgments,
    usage: panelUsage(input.events, input.now),
    weights: input.weights,
    pinned: input.pinned,
    ...(input.habit ? { habit: { next: input.habit.next, weight: habitWeight(input.weights) } } : {}),
  });
}

// ---------------------------------------------------------------------------
// Individual rules
// ---------------------------------------------------------------------------


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
function clean(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// The policy, bound to the demo
// ---------------------------------------------------------------------------

/** A manual edit to the plan (PlanEdit in @attune/core), for the demo's panels. */
export type PlanEdit = LibPlanEdit<PanelId>;

const POLICY = createPolicy<PanelId, GoalId, ActionId, Suggestion, ItemKind, HabitHints, PolicyInput, PolicyLiveData>({
  catalog: CATALOG,
  usage: (events, now) => panelUsage(events, now),
  suggest: (input, live = {}) =>
    buildSuggestions(input.judgments, input.events, input.now, { ...live, focusedPanel: live.focusedPanel ?? input.focusedPanel }, input.habit?.action),
  relationFor: (anchor, panel, records) => relationFor(anchor, panel, records),
  helpPanel: "help",
  modelName: "Jev",
  // Pointer rests are passive, and a saved working context, a task marked done, or a prep offer is the engine's own note, not the user's.
  densityIgnores: new Set(["context_save", "task_done", "prep_offer"]),
  habitWeight,
  habitReason,
  habitEvidence: (habit, panel, chance) => `habit ${habit.from ?? "session start"} to ${panel} in the ${habit.bucket} p=${p2(chance)}`,
  suggestionEvidence: (s, input) => {
    const j = input.judgments;
    if (s.habit) return `habit after opening a ${input.habit?.action?.kind ?? "record"}: ${s.actionId} ${p2(s.confidence)} of the time, Jev unsure (next step ${j.nextAction?.choice ?? "none"} p=${p2(j.nextAction?.confidence ?? 0)})`;
    const tc = j.targetClient;
    const clientPart = s.args.client && tc?.choice === s.args.client ? `, client ${s.args.client} p=${p2(tc.probabilities?.[s.args.client] ?? tc.confidence)}` : "";
    return `next step ${s.actionId} p=${p2(j.nextAction?.probabilities?.[s.actionId] ?? s.confidence)}${clientPart}`;
  },
  suggestionSignature: (s) => `${s.actionId}:${s.prominence}:${s.label}:${s.args.invoiceId ?? ""}`,
});

/** Turn judgments into a layout plan. `live` lets a suggestion name the record on screen. */
export function computePlan(input: PolicyInput, live: PolicyLiveData = {}): LayoutPlan {
  return POLICY.computePlan(input, live);
}

export const {
  defaultPlan,
  traditionalPlan,
  applyPromotion,
  editPlan,
  restoredSize,
  planSignature,
  remarkPanels,
  markChanges,
  orderWithHysteresis,
  isPanelId,
} = POLICY;
