/**
 * "Arrange linked panels by next step" (docs/anchored-relayout.md, "Next
 * step"): what comes after a click that links panels.
 *
 * Code builds the clicked record in words and the linked records Jev may
 * pick from. Jev reads the clicked record and picks the linked record the
 * user needs next (link-next) and what the record asks the user to do
 * (link-action). Code orders the linked panels, decides when Jev is sure
 * enough to say "Next", and builds the step that Up next and the suggestion
 * bar offer, then the follow-up that checks off a matching to-do item.
 * Nothing here performs anything, and nothing shows when Jev is not sure.
 *
 * Pure: no DOM, no store, no clock except `now`.
 */
import { PANEL_IDS, type ActionId, type PanelId } from "../../shared/catalog.ts";
import { CLIENTS, type Task } from "../../shared/fixtures.ts";
import type { AnchorRef, ChoiceJudgment, ClickedRecord, ItemKind, LinkRequest, RecordCandidate, RelatedRecord, SignalEvent, Suggestion } from "../../shared/types.ts";
import { clockTime, dayWord, formatMoney, invoiceDueText, PROJECT_STATUS_LABEL, taskDueText } from "../ui/format.ts";
import type { AppData, PanelViewState } from "./contract.ts";
import { makeCandidate, PANEL_OF_KIND, parseRecordKey, rankedRecords, recordKey } from "./nextUp.ts";
import { makeSuggestion, suggestionBlocked } from "./policy.ts";
import { findLinked, invoiceIdsIn, linkWhy } from "./relations.ts";

// ---------------------------------------------------------------------------
// Constants. Demo defaults; tune them here.
// ---------------------------------------------------------------------------

/** Clicked records the link questions read: the kinds whose words say what they ask for (a client or a person row does not). */
export const LINK_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>(["message", "invoice", "task", "project", "event"]);
/** A clicked message's text is clipped to this many characters: a request fits, and the two questions stay small. */
export const CLICKED_TEXT_MAX = 300;
/** Linked records offered to Jev: one per linked panel fits well under it, and the Choice stays sharp. */
export const LINK_CANDIDATES_MAX = 8;
/**
 * The gate on Jev's link-next for the "Next" emphasis, the Up next pick, and
 * the step, in the shape of the Up next gate (UP_NEXT_JEV_MIN_P in
 * ./nextUp.ts): a pick this likely shows on its own, since Jev puts more on
 * it than on everything else together...
 */
export const LINK_NEXT_MIN_P = 0.5;
/** ...or a pick this likely... */
export const LINK_NEXT_LEAN_P = 0.4;
/** ...that leads the next linked record by at least this much (a near tie is a guess)... */
export const LINK_NEXT_MARGIN = 0.15;
/** ...while Jev gives "none" (the clicked record needs none of them) less than this. */
export const LINK_NEXT_NONE_MAX = 0.2;
/** The step names its action ("resend") only when link-action is this likely: more on it than on every other action together. */
export const LINK_ACTION_MIN_P = 0.5;
/** A step not taken in this long is stale: Up next, the tag, and the suggestion stop offering it. Long enough to read and act. */
export const LINK_STEP_MS = 5 * 60_000;
/** The check-off follow-up stays this long after the step, as long as a dismissed suggestion stays away (SUGGESTION_DISMISS_HOLD_MS). */
export const FOLLOW_UP_MS = 2 * 60_000;

/** Record kinds in the words the activity lines use. */
const KIND_WORD: Record<ItemKind, string> = {
  invoice: "invoice",
  message: "message",
  client: "client",
  project: "project",
  task: "task",
  event: "calendar event",
  person: "team member",
  note: "note",
};

// ---------------------------------------------------------------------------
// What the request carries
// ---------------------------------------------------------------------------

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * The clicked record in words, field by field, from the app data: a message's
 * sender, client, subject, and text (clipped to CLICKED_TEXT_MAX); an
 * invoice's id, client, status, amount, and due words; a task's title and due
 * words; a project's name and status; an event's title and time words. Null
 * for other kinds, or a record that does not exist.
 */
export function clickedRecordWords(anchor: Pick<AnchorRef, "itemKind" | "itemId">, data: AppData, now: number): ClickedRecord | null {
  const kind = anchor.itemKind;
  const id = anchor.itemId;
  if (!kind || !id || !LINK_KINDS.has(kind)) return null;
  const words = (fields: Record<string, string>): ClickedRecord => ({ id: recordKey(kind, id), kind, fields });
  switch (kind) {
    case "message": {
      const m = data.messages.find((x) => x.id === id);
      return m ? words({ from: m.from, client: m.client ?? "No client company", subject: m.subject, text: clip(m.preview, CLICKED_TEXT_MAX) }) : null;
    }
    case "invoice": {
      const inv = data.invoices.find((x) => x.id === id);
      return inv ? words({ id: inv.id, client: inv.client, status: inv.status, amount: formatMoney(inv.amount), due: invoiceDueText(inv, now) }) : null;
    }
    case "task": {
      const t = data.tasks.find((x) => x.id === id);
      return t ? words({ title: t.title, due: taskDueText(t, now) }) : null;
    }
    case "project": {
      const p = data.projects.find((x) => x.id === id);
      return p ? words({ name: p.name, status: PROJECT_STATUS_LABEL[p.status].toLowerCase() }) : null;
    }
    case "event": {
      const e = data.events.find((x) => x.id === id);
      return e ? words({ title: e.title, time: `${clockTime(e.start)} ${dayWord(e.start, now)}` }) : null;
    }
    default:
      return null;
  }
}

/**
 * The linked records Jev may pick from: the first (most useful) record of
 * each panel that holds records linked to the click and shows them now
 * (findLinked with the view), in a kind that has a panel to open it in,
 * each with why it is linked (linkWhy). The closest links come first, at
 * most LINK_CANDIDATES_MAX.
 */
export function linkCandidates(anchor: AnchorRef, data: AppData, view: PanelViewState, now: number): RecordCandidate[] {
  const linked = findLinked(anchor, data, { view, now });
  const found: { c: RecordCandidate; strength: number; order: number }[] = [];
  PANEL_IDS.forEach((panel, order) => {
    const first = linked[panel]?.find((r) => PANEL_OF_KIND[r.itemKind] !== undefined);
    if (!first) return;
    const why = linkWhy(anchor, first, data);
    const c = makeCandidate(first.itemKind, first.itemId, why.why, data, now);
    if (c) found.push({ c, strength: why.strength, order });
  });
  return found
    .sort((a, b) => a.strength - b.strength || a.order - b.order)
    .slice(0, LINK_CANDIDATES_MAX)
    .map((x) => x.c);
}

/** The request's link fields for a click, or null when the clicked record is of another kind or nothing is linked to it. */
export function linkRequestFor(anchor: AnchorRef, data: AppData, view: PanelViewState, now: number): LinkRequest | null {
  const clicked = clickedRecordWords(anchor, data, now);
  if (!clicked) return null;
  const records = linkCandidates(anchor, data, view, now).filter((r) => r.id !== clicked.id);
  return records.length > 0 ? { clicked, records } : null;
}

// ---------------------------------------------------------------------------
// Reading Jev's answer
// ---------------------------------------------------------------------------

function probabilityOf(j: ChoiceJudgment<string>, id: string): number {
  const p = j.probabilities?.[id];
  if (typeof p === "number" && Number.isFinite(p)) return p;
  return id === j.choice ? (j.confidence ?? 0) : 0;
}

/**
 * Jev's link-next when Jev is sure enough to say "Next": LINK_NEXT_MIN_P or
 * more, or LINK_NEXT_LEAN_P or more with a lead of LINK_NEXT_MARGIN over the
 * next record and "none" under LINK_NEXT_NONE_MAX. Null for "none" or an
 * unsure answer; then the panels gather in code's order, with no emphasis.
 */
export function confidentLinkNext(j: ChoiceJudgment<string> | undefined): { id: string; p: number } | null {
  if (!j || j.choice === "none") return null;
  const p = probabilityOf(j, j.choice);
  if (p >= LINK_NEXT_MIN_P) return { id: j.choice, p };
  if (p < LINK_NEXT_LEAN_P) return null;
  const runnerUp = rankedRecords(j).find((x) => x.id !== j.choice)?.p ?? 0;
  return p - runnerUp >= LINK_NEXT_MARGIN && probabilityOf(j, "none") < LINK_NEXT_NONE_MAX ? { id: j.choice, p } : null;
}

/** One linked panel as the order sees it: its linked records and its plan priority. */
export interface LinkedPanel {
  id: PanelId;
  records: RelatedRecord[];
  priority: number;
}

/**
 * The linked panels in next-step order. When Jev is sure (confidentLinkNext),
 * by link-next's probability for the panel's records, highest first; else, or
 * for ties, code's order: the same record id first, then the same project,
 * then the same client (linkWhy), then the higher plan priority, then the
 * catalog order.
 */
export function linkPanelOrder(anchor: AnchorRef, panels: LinkedPanel[], data: AppData, linkNext?: ChoiceJudgment<string>): { order: PanelId[]; source: "jev" | "code" } {
  const strength = new Map(panels.map((p) => [p.id, Math.min(4, ...p.records.map((r) => linkWhy(anchor, r, data).strength))]));
  const code = (a: LinkedPanel, b: LinkedPanel) =>
    (strength.get(a.id) ?? 4) - (strength.get(b.id) ?? 4) || b.priority - a.priority || PANEL_IDS.indexOf(a.id) - PANEL_IDS.indexOf(b.id);
  const sure = confidentLinkNext(linkNext);
  if (!sure || !linkNext) return { order: [...panels].sort(code).map((p) => p.id), source: "code" };
  const p = new Map(panels.map((x) => [x.id, Math.max(0, ...x.records.map((r) => probabilityOf(linkNext, recordKey(r.itemKind, r.itemId))))]));
  return { order: [...panels].sort((a, b) => (p.get(b.id) ?? 0) - (p.get(a.id) ?? 0) || code(a, b)).map((x) => x.id), source: "jev" };
}

// ---------------------------------------------------------------------------
// The step
// ---------------------------------------------------------------------------

/** The next step Jev read from a click: the linked record the user needs next, and what to do with it once it is open. */
export interface LinkStep {
  /** The click it came from (AnchorRef.at): its link set shows the "Next" tag. */
  at: number;
  /** The clicked record ("message:m-1"). */
  from: string;
  /** The clicked record in a few words, for reasons: "Priya Nair's message". */
  fromLabel: string;
  /** The record the user needs next. */
  record: RecordCandidate;
  /** What to do there (link-action), when it fits that record and Jev is sure of it; null: only open it. */
  action: ActionId | null;
  /** Jev's link-next probability for the record. */
  probability: number;
  /** Jev's link-action probability for the action (0 without one). */
  actionProbability: number;
  /** The tag on the record's panel: "Next: resend INV-1042". */
  tag: string;
  /** What the Up next card adds: "to resend it". Absent without an action. */
  phrase?: string;
  /** "Jev", or "Heuristic" when the fallback answered. */
  judge: string;
  /** Epoch ms when it was made (LINK_STEP_MS). */
  since: number;
}

/** Whether an action can act on one record: resend or remind a sent or overdue invoice, reply to a message, and so on. */
export function actionFits(action: ActionId, kind: ItemKind, id: string, data: AppData): boolean {
  switch (action) {
    case "resend_invoice":
    case "send_payment_reminder": {
      const status = kind === "invoice" ? data.invoices.find((i) => i.id === id)?.status : undefined;
      return status === "overdue" || status === "sent";
    }
    case "mark_invoice_paid": {
      const status = kind === "invoice" ? data.invoices.find((i) => i.id === id)?.status : undefined;
      return status !== undefined && status !== "paid";
    }
    case "reply_to_message":
      return kind === "message" && data.messages.some((m) => m.id === id);
    case "update_project_status": {
      const status = kind === "project" ? data.projects.find((p) => p.id === id)?.status : undefined;
      return status === "at_risk" || status === "blocked";
    }
    case "view_client":
      return kind === "client";
    case "schedule_meeting":
      return kind === "client" || kind === "event";
    case "create_task":
      return kind === "task";
    default:
      return false;
  }
}

/** The shortest name for a record in a tag or a card: an invoice id, "Priya Nair's message", a title or a name. */
export function recordShortName(key: string, data: AppData): string {
  const r = parseRecordKey(key);
  if (!r) return key;
  switch (r.kind) {
    case "invoice":
      return r.id;
    case "message": {
      const m = data.messages.find((x) => x.id === r.id);
      return m ? `${m.from}'s message` : r.id;
    }
    case "task":
      return data.tasks.find((x) => x.id === r.id)?.title ?? r.id;
    case "event":
      return data.events.find((x) => x.id === r.id)?.title ?? r.id;
    case "project":
      return data.projects.find((x) => x.id === r.id)?.name ?? r.id;
    case "client":
      return CLIENTS.find((x) => x.id === r.id)?.name ?? r.id;
    default:
      return r.id;
  }
}

/** The tag's verb for an action on a record: "resend INV-1042", "reply to Priya Nair". */
function actionWords(action: ActionId, kind: ItemKind, id: string, data: AppData): string | null {
  const name = recordShortName(recordKey(kind, id), data);
  switch (action) {
    case "resend_invoice":
      return `resend ${name}`;
    case "send_payment_reminder":
      return `send a reminder for ${name}`;
    case "mark_invoice_paid":
      return `mark ${name} paid`;
    case "reply_to_message": {
      const m = data.messages.find((x) => x.id === id);
      return m ? `reply to ${m.from}` : null;
    }
    case "schedule_meeting":
      return "schedule a meeting";
    case "update_project_status":
      return `update ${name}`;
    case "view_client":
      return `open ${name}`;
    case "create_task":
      return "add a task";
    default:
      return null;
  }
}

/** What the Up next card says the record is for: "to resend it". */
const STEP_PHRASE: Partial<Record<ActionId, string>> = {
  resend_invoice: "to resend it",
  send_payment_reminder: "to send a reminder",
  mark_invoice_paid: "to mark it paid",
  reply_to_message: "to reply",
  schedule_meeting: "to schedule a meeting",
  update_project_status: "to update its status",
  create_task: "to add a task",
};

/**
 * The step from one round's link answer, or null when Jev is not sure which
 * linked record comes next (confidentLinkNext) or picked one that was not
 * offered. The action rides along only when link-action is at least
 * LINK_ACTION_MIN_P and fits that record (actionFits).
 */
export function linkStepFrom(args: {
  at: number;
  clicked: ClickedRecord;
  records: RecordCandidate[];
  linkNext?: ChoiceJudgment<string>;
  linkAction?: ChoiceJudgment<ActionId>;
  data: AppData;
  now: number;
  judge?: string;
}): LinkStep | null {
  const sure = confidentLinkNext(args.linkNext);
  const record = sure ? args.records.find((r) => r.id === sure.id) : undefined;
  const r = record ? parseRecordKey(record.id) : null;
  if (!sure || !record || !r) return null;
  const a = args.linkAction;
  const ap = a && a.choice !== "none" ? probabilityOf(a, a.choice) : 0;
  const action = a && a.choice !== "none" && ap >= LINK_ACTION_MIN_P && actionFits(a.choice, r.kind, r.id, args.data) ? a.choice : null;
  const verb = action ? actionWords(action, r.kind, r.id, args.data) : null;
  const phrase = action ? STEP_PHRASE[action] : undefined;
  return {
    at: args.at,
    from: args.clicked.id,
    fromLabel: clickedLabel(args.clicked),
    record,
    action: verb ? action : null,
    probability: sure.p,
    actionProbability: verb ? ap : 0,
    tag: `Next: ${verb ?? `open ${recordShortName(record.id, args.data)}`}`,
    ...(verb && phrase ? { phrase } : {}),
    judge: args.judge ?? "Jev",
    since: args.now,
  };
}

/** "Priya Nair's message", "INV-1042", a task's or an event's title. */
function clickedLabel(c: ClickedRecord): string {
  const f = c.fields;
  switch (c.kind) {
    case "message":
      return f.from ? `${f.from}'s message` : "the message";
    case "invoice":
      return f.id ?? "the invoice";
    case "project":
      return f.name ?? "the project";
    default:
      return f.title ?? `the ${KIND_WORD[c.kind]}`;
  }
}

/** A step is still worth offering: not older than LINK_STEP_MS, and its action still fits its record. */
export function stepLive(step: LinkStep, data: AppData, now: number): boolean {
  if (now - step.since > LINK_STEP_MS) return false;
  const r = parseRecordKey(step.record.id);
  return r !== null && (step.action === null || actionFits(step.action, r.kind, r.id, data));
}

/**
 * The step's action as the primary suggestion, once its record is open
 * (`current` is that record's key): "Resend INV-1042 to Harbor Coffee Co.".
 * It acts on exactly that record, and pressing "." is the only way it runs.
 * Null without an action, on another record, or when the action was just
 * dismissed or done there (suggestionBlocked).
 */
export function stepSuggestion(step: LinkStep, ctx: { current: string | null; data: AppData; view: PanelViewState; events: SignalEvent[]; now: number }): Suggestion | null {
  const r = parseRecordKey(step.record.id);
  if (!step.action || !r || ctx.current !== step.record.id) return null;
  const s = makeSuggestion(step.action, "primary", step.actionProbability, step.record.client, `The next step for ${step.fromLabel}`, {
    invoices: ctx.data.invoices,
    messages: ctx.data.messages,
    projects: ctx.data.projects,
    view: ctx.view,
    ...(r.kind === "invoice" ? { invoiceId: r.id } : {}),
  });
  const acts = s.args.invoiceId ?? s.args.messageId ?? s.args.projectId;
  if (acts !== undefined && acts !== r.id) return null;
  const out: Suggestion = { ...s, nextStep: true };
  return suggestionBlocked(out, ctx.events, ctx.now) ? null : out;
}

// ---------------------------------------------------------------------------
// The follow-up
// ---------------------------------------------------------------------------

/** Words in a to-do item's title that say it is the same work as an action. Actions with none have no follow-up. */
export const ACTION_TASK_WORDS: Partial<Record<ActionId, string[]>> = {
  resend_invoice: ["resend", "re-send", "send again"],
  send_payment_reminder: ["remind", "chase"],
  mark_invoice_paid: ["paid", "payment"],
  reply_to_message: ["reply", "respond", "answer", "write back"],
  schedule_meeting: ["meeting", "call", "schedule", "book"],
  update_project_status: ["status", "update"],
};

/** The names a to-do item may use for a record (an invoice id, a sender, a title), and its client. */
function recordNames(kind: ItemKind, id: string, data: AppData): { names: string[]; client: string | null } {
  switch (kind) {
    case "invoice": {
      const inv = data.invoices.find((x) => x.id === id);
      return { names: [id], client: inv?.client ?? null };
    }
    case "message": {
      const m = data.messages.find((x) => x.id === id);
      return m ? { names: invoiceIdsIn(`${m.subject} ${m.preview}`), client: m.client } : { names: [], client: null };
    }
    case "project": {
      const p = data.projects.find((x) => x.id === id);
      return p ? { names: [p.name], client: p.client } : { names: [], client: null };
    }
    case "event": {
      const e = data.events.find((x) => x.id === id);
      return e ? { names: [e.title], client: e.client } : { names: [], client: null };
    }
    case "client": {
      const c = CLIENTS.find((x) => x.id === id);
      return { names: [], client: c?.name ?? null };
    }
    default:
      return { names: [], client: null };
  }
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(text);
}

/**
 * The open to-do item that is the work just done, or null: its title says
 * the same kind of work (ACTION_TASK_WORDS) and names the record, or belongs
 * to the same client. One that names the record wins, then the soonest due.
 * "Resend INV-1042 to Harbor accounts team" for resending INV-1042.
 */
export function followUpTask(action: ActionId, kind: ItemKind, id: string, data: AppData): Task | null {
  const words = ACTION_TASK_WORDS[action];
  if (!words?.length) return null;
  const { names, client } = recordNames(kind, id, data);
  const namesIt = (title: string) => names.some((n) => title.toLowerCase().includes(n.toLowerCase()));
  const hits = data.tasks.filter((t) => !t.done && words.some((w) => hasWord(t.title, w)) && (namesIt(t.title) || (client !== null && t.client === client)));
  return hits.sort((a, b) => Number(namesIt(b.title)) - Number(namesIt(a.title)) || a.due.localeCompare(b.due) || a.id.localeCompare(b.id))[0] ?? null;
}

/** The follow-up suggestion for a matching to-do item: "Check off: Resend INV-1042 to Harbor accounts team". Accepting it checks off that task only. */
export function followUpSuggestion(task: Task, reason: string): Suggestion {
  return {
    actionId: "none",
    label: `Check off: ${task.title}`,
    prominence: "primary",
    confidence: 1,
    args: { taskId: task.id, ...(task.client ? { client: task.client } : {}) },
    reason,
    task: { id: task.id, title: task.title },
  };
}
