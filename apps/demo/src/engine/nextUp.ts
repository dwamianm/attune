/**
 * What the user will likely work on next, and whether they are working
 * through a list of similar records (docs/predictive-flow.md).
 *
 * Code builds the candidates: records the user might open next, from the
 * data, the view state, the current record, the links, and the recent
 * events. Jev only selects among them (its nextRecord Choice): select, do
 * not generate. Code also measures list work, and chooses what the "Up
 * next" card shows: Jev's pick when Jev is sure enough, otherwise, in queue
 * mode, the next record in the current list, otherwise nothing. While the
 * user repeats one action, only records it still applies to show, and the
 * card says so when none is left.
 *
 * Pure: no DOM, no store, no clock except `now`. Labels use the same
 * formatters as the panels' item_open labels, so Jev reads one wording.
 */
import type { PanelId } from "../../shared/catalog.ts";
import { CLIENTS, type CalendarEvent, type Invoice, type Message, type Project, type Task } from "../../shared/fixtures.ts";
import type { AnchorRef, ChoiceJudgment, ItemKind, RecordCandidate, SignalEvent, SignalType } from "../../shared/types.ts";
import {
  clockTime,
  dayOffset,
  daysUntil,
  eventLabel,
  invoiceDueText,
  invoiceLabel,
  messageLabel,
  PROJECT_STATUS_LABEL,
  projectLabel,
  taskDueText,
} from "../ui/format.ts";
import type { AppData, LinkSet, PanelViewState, UpNextDone, UpNextPick } from "./contract.ts";
import { findLinked, kindOfId } from "./relations.ts";
import { matchesQuery, numberWord } from "@attuneui/core";

// ---------------------------------------------------------------------------
// Constants. Demo defaults; tune them here.
// ---------------------------------------------------------------------------

/** Most candidates sent to Jev (the contract's cap): the list and the day's loose ends fit, and the Choice stays sharp. */
export const RECORD_CANDIDATES_MAX = 12;
/** Records after the current one in its list: the next few are what "next" means; further down is guessing. */
export const LIST_NEXT_MAX = 3;
/** Records linked to the anchor: the link cues already point at them, and three matches the three link lines. */
export const LINKED_CANDIDATES_MAX = 3;
/** Unread client messages: each is a likely reply, but a full inbox must not crowd out the rest. */
export const UNREAD_CANDIDATES_MAX = 3;
/** Tasks due today (or late): the ones the day is about. */
export const TASK_CANDIDATES_MAX = 2;
/** Overdue invoices without a reminder today: the money at risk. */
export const OVERDUE_CANDIDATES_MAX = 3;
/** "The last few minutes" for list work: a few records at reading pace fit, and this morning's batch does not count. */
export const LIST_WORK_WINDOW_MS = 3 * 60_000;
/** The same action on this many records of one kind is working through a list: once is a task, twice is a pattern. */
export const LIST_WORK_SAME_ACTION_MIN = 2;
/** Or this many records of one kind opened in a row: two is comparing, three is going down the list. */
export const LIST_WORK_OPEN_RUN_MIN = 3;
/** Jev's listWork (Noul) at or above this turns queue mode on; near 0.5 means unsure, so it needs a clear lean. */
export const QUEUE_LISTWORK_AT = 0.6;
/**
 * The gate on Jev's nextRecord for the card. Jev spreads probability over
 * a dozen candidates, so a correct pick often sits just under 0.5. From the
 * September 30 eval (eval-results/latest.json): correct picks at 0.44 to
 * 0.46 (morning, reply_queue, task_checkoff) led the next record by 0.17 to
 * 0.28 with "none" at 0.16 or less; sessions with no clear next record
 * stayed under the lean (scattered 0.34 to 0.39, leading by 0.01 to 0.05)
 * or gave "none" a real share (stuck_reopen: 0.48, with "none" at 0.23).
 * So: UP_NEXT_JEV_MIN_P on its own, or UP_NEXT_JEV_LEAN_P with a clear lead
 * and little weight on "none". Below that Jev is not sure: nothing shows.
 */
/** A pick this likely shows on its own: Jev puts more on it than on everything else together. */
export const UP_NEXT_JEV_MIN_P = 0.5;
/** Or a pick this likely... */
export const UP_NEXT_JEV_LEAN_P = 0.4;
/** ...that leads the next most likely record by at least this much (a near tie is a guess)... */
export const UP_NEXT_JEV_MARGIN = 0.15;
/** ...while Jev gives "none" (no clear next record) less than this. */
export const UP_NEXT_JEV_NONE_MAX = 0.2;
/** Other records shown as chips beside the pick: more would be a list to scan, which the card is meant to save. */
export const UP_NEXT_ALTERNATIVES_MAX = 2;
/** A chip from Jev needs at least this probability, so an alternative is never a long shot. */
export const UP_NEXT_ALT_MIN_P = 0.1;
/** Dismissing the card hides that record this long, as long as a dismissed suggestion stays away (SUGGESTION_DISMISS_HOLD_MS). */
export const UP_NEXT_DISMISS_MS = 2 * 60_000;
/**
 * Focus aid 3: a candidate in the panel the user usually goes to next moves
 * up this many places in code's order (never ahead of the next records in
 * the list the user is in): small, about one group of the day's loose ends,
 * and it can bring such a record back inside RECORD_CANDIDATES_MAX.
 */
export const UP_NEXT_HABIT_LIFT = 3;
/**
 * Focus aid 3: an alternative chip in the usual next panel ranks as if Jev
 * gave it this much more. It only orders near ties among the chips; Jev
 * still picks, and the gates use Jev's own probability.
 */
export const UP_NEXT_HABIT_CHIP_BOOST = 0.05;

/** The panel that lists each kind of record. Team members have no selection in the view state, so they are never candidates. */
export const PANEL_OF_KIND: Partial<Record<ItemKind, PanelId>> = {
  invoice: "invoices",
  message: "inbox",
  client: "clients",
  project: "projects",
  task: "tasks",
  event: "calendar",
};

/** Events that open one record. Starting the next task from the Done card opens its first record; preparing for a meeting selects it. */
const OPEN_TYPES: ReadonlySet<SignalType> = new Set<SignalType>(["item_open", "up_next_open", "task_start", "prep_start"]);

const KIND_PLURAL: Record<ItemKind, string> = {
  invoice: "invoices",
  message: "messages",
  client: "clients",
  project: "projects",
  task: "tasks",
  event: "events",
  person: "people",
  note: "notes",
};

// ---------------------------------------------------------------------------
// Record ids and the current record
// ---------------------------------------------------------------------------

/** "invoice:INV-1038": the RecordCandidate id of one record. */
export function recordKey(kind: ItemKind, id: string): string {
  return `${kind}:${id}`;
}

/** The kind and record id in a RecordCandidate id, or null when it is not one. */
export function parseRecordKey(key: string): { kind: ItemKind; id: string } | null {
  const i = key.indexOf(":");
  if (i <= 0 || i === key.length - 1) return null;
  const kind = key.slice(0, i) as ItemKind;
  return PANEL_OF_KIND[kind] ? { kind, id: key.slice(i + 1) } : null;
}

/** The record an event is about, when it names one of a kind that has a panel. */
function eventRecord(e: SignalEvent): { kind: ItemKind; id: string } | null {
  const id = e.detail?.itemId;
  if (!id) return null;
  const kind = e.detail?.itemKind ?? kindOfId(id);
  return kind && PANEL_OF_KIND[kind] ? { kind, id } : null;
}

/** The record the user is on. */
export interface CurrentRecord {
  kind: ItemKind;
  id: string;
  panel: PanelId;
  /** When the user got to it (event time or anchor time). */
  at: number;
}

/**
 * The record the user is on: the newest record opened or acted on, or the
 * anchor's record when the anchor is newer (a command that named an invoice).
 */
export function currentRecord(events: SignalEvent[], anchor: AnchorRef | null): CurrentRecord | null {
  let found: CurrentRecord | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!OPEN_TYPES.has(e.type) && e.type !== "action") continue;
    const r = eventRecord(e);
    if (!r) continue;
    found = { ...r, panel: PANEL_OF_KIND[r.kind]!, at: e.t };
    break;
  }
  if (anchor?.itemId && (!found || anchor.at > found.at)) {
    const kind = anchor.itemKind ?? kindOfId(anchor.itemId);
    const panel = kind ? PANEL_OF_KIND[kind] : undefined;
    if (kind && panel) return { kind, id: anchor.itemId, panel, at: anchor.at };
  }
  return found;
}

/**
 * Records the user already handled this session: a reminder sent, a reply
 * drafted, a task checked off, an invoice marked paid, a project updated
 * (any action on a record). Reopening a task takes it back off the list.
 */
export function handledRecords(events: SignalEvent[]): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    if (e.type !== "action") continue;
    const r = eventRecord(e);
    if (!r) continue;
    const key = recordKey(r.kind, r.id);
    if (r.kind === "task" && /^Reopened/i.test(e.detail?.label ?? "")) out.delete(key);
    else out.add(key);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Panel lists (the same filters and order as each panel shows)
// ---------------------------------------------------------------------------

/** Overdue first, then by due date, as the Invoices panel sorts. */
const INVOICE_ORDER: Record<Invoice["status"], number> = { overdue: 0, sent: 1, draft: 2, paid: 3 };
/** The Calendar panel's "This week": today and the next six days. */
const CALENDAR_WEEK_DAYS = 7;

function invoiceShown(inv: Invoice, v: PanelViewState["invoices"]): boolean {
  const st = v.status;
  const inTab = st === "all" || st === "not_mentioned" || (st === "unpaid" ? inv.status === "sent" || inv.status === "overdue" : inv.status === st);
  return inTab && (!v.client || inv.client === v.client);
}

function messageShown(m: Message, v: PanelViewState["inbox"]): boolean {
  return (!v.client || m.client === v.client) && matchesQuery([m.from, m.subject, m.preview, m.client], v.query);
}

function taskShown(t: Task, v: PanelViewState["tasks"]): boolean {
  return (v.showDone || !t.done) && (!v.client || t.client === v.client);
}

function eventShown(e: CalendarEvent, v: PanelViewState["calendar"], now: number): boolean {
  const d = dayOffset(e.start, now);
  return v.range === "today" ? d === 0 : d >= 0 && d < CALENDAR_WEEK_DAYS;
}

function projectShown(p: Project, v: PanelViewState["projects"]): boolean {
  return v.status === "all" || p.status === v.status;
}

function clientShown(c: (typeof CLIENTS)[number], v: PanelViewState["clients"]): boolean {
  return matchesQuery([c.name, c.contact, c.industry, c.email], v.query);
}

/** The records a panel lists under its current filter, search, and range, in its order. */
export function panelList(panel: PanelId, data: AppData, view: PanelViewState, now: number): { kind: ItemKind; id: string }[] {
  switch (panel) {
    case "invoices":
      return data.invoices
        .filter((inv) => invoiceShown(inv, view.invoices))
        .sort((a, b) => INVOICE_ORDER[a.status] - INVOICE_ORDER[b.status] || a.due.localeCompare(b.due))
        .map((inv) => ({ kind: "invoice", id: inv.id }));
    case "inbox":
      return data.messages
        .filter((m) => messageShown(m, view.inbox))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
        .map((m) => ({ kind: "message", id: m.id }));
    case "clients":
      return CLIENTS.filter((c) => clientShown(c, view.clients)).map((c) => ({ kind: "client", id: c.id }));
    case "projects":
      return data.projects
        .filter((p) => projectShown(p, view.projects))
        .sort((a, b) => a.deadline.localeCompare(b.deadline))
        .map((p) => ({ kind: "project", id: p.id }));
    case "tasks":
      return data.tasks
        .filter((t) => taskShown(t, view.tasks))
        .sort((a, b) => Number(a.done) - Number(b.done) || a.due.localeCompare(b.due))
        .map((t) => ({ kind: "task", id: t.id }));
    case "calendar":
      return data.events
        .filter((e) => eventShown(e, view.calendar, now))
        .sort((a, b) => a.start.localeCompare(b.start))
        .map((e) => ({ kind: "event", id: e.id }));
    default:
      return [];
  }
}

/** Records that need no more work, so walking a list skips them: a paid invoice, a done task or project, an event that ended. */
function settled(kind: ItemKind, id: string, data: AppData, now: number): boolean {
  switch (kind) {
    case "invoice":
      return data.invoices.find((i) => i.id === id)?.status === "paid";
    case "task":
      return data.tasks.find((t) => t.id === id)?.done === true;
    case "project":
      return data.projects.find((p) => p.id === id)?.status === "done";
    case "event": {
      const e = data.events.find((x) => x.id === id);
      return e !== undefined && new Date(e.end).getTime() < now;
    }
    default:
      return false;
  }
}

/**
 * The records after the current one in its panel's list, in order, then
 * from the top of the list (so the ones skipped earlier still come up),
 * without the current record, settled records, and `skip` (see listSkip).
 * Keys, best first.
 */
export function nextInList(
  current: CurrentRecord,
  data: AppData,
  view: PanelViewState,
  now: number,
  skip: (key: string) => boolean = () => false,
  max = LIST_NEXT_MAX,
): string[] {
  const list = panelList(current.panel, data, view, now);
  const i = list.findIndex((r) => r.kind === current.kind && r.id === current.id);
  const ordered = i === -1 ? list : [...list.slice(i + 1), ...list.slice(0, i)];
  const out: string[] = [];
  for (const r of ordered) {
    if (out.length >= max) break;
    const key = recordKey(r.kind, r.id);
    if ((r.kind === current.kind && r.id === current.id) || settled(r.kind, r.id, data, now) || skip(key)) continue;
    out.push(key);
  }
  return out;
}

/** The label key of checking off a task, which has no action id (the tasks panel logs "Checked off task: <title>"). */
export const CHECK_OFF_TASK = "Checked off task";

/**
 * Whether the action the user is repeating through a list still applies to
 * a record, so "Next in list" offers only records the user can do it to: a
 * reminder about a bill that is not due yet makes no sense.
 * - send_payment_reminder: an overdue invoice with no reminder sent this
 *   session (a reminder makes the invoice handled);
 * - mark_invoice_paid: a sent or overdue invoice;
 * - resend_invoice: a sent or overdue invoice not resent (or otherwise handled) this session;
 * - reply_to_message: an unread message;
 * - update_project_status: a project at risk or blocked;
 * - checking off tasks (CHECK_OFF_TASK): a task not done.
 * Any other action, no action, or a record of another kind than the one
 * the action works on keeps the plain list walk: true.
 */
export function actionApplies(action: string | undefined, kind: ItemKind, id: string, data: AppData, handled: ReadonlySet<string>): boolean {
  switch (action) {
    case "send_payment_reminder":
      return kind !== "invoice" || (data.invoices.find((i) => i.id === id)?.status === "overdue" && !handled.has(recordKey(kind, id)));
    case "mark_invoice_paid": {
      const status = data.invoices.find((i) => i.id === id)?.status;
      return kind !== "invoice" || status === "sent" || status === "overdue";
    }
    case "resend_invoice": {
      const status = data.invoices.find((i) => i.id === id)?.status;
      return kind !== "invoice" || ((status === "sent" || status === "overdue") && !handled.has(recordKey(kind, id)));
    }
    case "reply_to_message":
      return kind !== "message" || data.messages.find((m) => m.id === id)?.unread === true;
    case "update_project_status": {
      const status = data.projects.find((p) => p.id === id)?.status;
      return kind !== "project" || status === "at_risk" || status === "blocked";
    }
    case CHECK_OFF_TASK:
      return kind !== "task" || data.tasks.find((t) => t.id === id)?.done === false;
    default:
      return true;
  }
}

/** The Up next card's line when a repeated action has no record left (queueDone). Only these actions have a completion state. */
export const QUEUE_DONE_TEXT: Readonly<Record<string, string>> = {
  send_payment_reminder: "All overdue invoices have a reminder.",
  mark_invoice_paid: "No sent or overdue invoices left to mark paid.",
  reply_to_message: "No unread messages left.",
  update_project_status: "No projects at risk or blocked.",
  [CHECK_OFF_TASK]: "All tasks are checked off.",
};

/** The list walk's skip: records handled this session, and records the repeated `action` no longer applies to (actionApplies). */
export function listSkip(handled: ReadonlySet<string>, action: string | undefined, data: AppData): (key: string) => boolean {
  return (key) => {
    if (handled.has(key)) return true;
    const r = parseRecordKey(key);
    return r !== null && !actionApplies(action, r.kind, r.id, data, handled);
  };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const HEALTH_WORD: Record<(typeof CLIENTS)[number]["health"], string> = { good: "good", watch: "watch", at_risk: "at risk" };

/** A record's label and client in the panels' item_open wording, or null when the record does not exist. */
function describeRecord(kind: ItemKind, id: string, data: AppData, now: number): { label: string; client?: string } | null {
  const withClient = (label: string, client: string | null | undefined) => (client ? { label, client } : { label });
  switch (kind) {
    case "invoice": {
      const inv = data.invoices.find((i) => i.id === id);
      return inv ? withClient(invoiceLabel(inv, now), inv.client) : null;
    }
    case "message": {
      const m = data.messages.find((x) => x.id === id);
      return m ? withClient(messageLabel(m), m.client) : null;
    }
    case "client": {
      const c = CLIENTS.find((x) => x.id === id);
      return c ? withClient(`${c.name}, contact ${c.contact}, health ${HEALTH_WORD[c.health]}`, c.name) : null;
    }
    case "project": {
      const p = data.projects.find((x) => x.id === id);
      return p ? withClient(projectLabel(p), p.client) : null;
    }
    case "task": {
      const t = data.tasks.find((x) => x.id === id);
      return t ? withClient(`${t.title} (${taskDueText(t, now)})`, t.client) : null;
    }
    case "event": {
      const e = data.events.find((x) => x.id === id);
      return e ? withClient(eventLabel(e, now), e.client) : null;
    }
    default:
      return null;
  }
}

/** One candidate, or null for a record that does not exist or has no panel. */
export function makeCandidate(kind: ItemKind, id: string, why: string, data: AppData, now: number): RecordCandidate | null {
  const panel = PANEL_OF_KIND[kind];
  const d = panel ? describeRecord(kind, id, data, now) : null;
  if (!panel || !d) return null;
  return { id: recordKey(kind, id), kind, panel, label: d.label, ...(d.client ? { client: d.client } : {}), why };
}

/**
 * The card's text for a record, shorter than the label: "Meridian Hotels ·
 * INV-1038 · 36 days overdue". Falls back to the label.
 */
export function recordCardText(c: RecordCandidate, data: AppData, now: number): string {
  const r = parseRecordKey(c.id);
  if (!r) return c.label;
  switch (r.kind) {
    case "invoice": {
      const inv = data.invoices.find((i) => i.id === r.id);
      return inv ? `${inv.client} · ${inv.id} · ${invoiceDueText(inv, now)}` : c.label;
    }
    case "message": {
      const m = data.messages.find((x) => x.id === r.id);
      return m ? `${m.from} · ${m.subject}` : c.label;
    }
    case "task": {
      const t = data.tasks.find((x) => x.id === r.id);
      return t ? `${t.title} · ${taskDueText(t, now)}` : c.label;
    }
    case "event": {
      const e = data.events.find((x) => x.id === r.id);
      return e ? `${e.title} · ${clockTime(e.start)}` : c.label;
    }
    case "project": {
      const p = data.projects.find((x) => x.id === r.id);
      return p ? `${p.name} · ${PROJECT_STATUS_LABEL[p.status].toLowerCase()}` : c.label;
    }
    case "client":
      return CLIENTS.find((x) => x.id === r.id)?.name ?? c.label;
    default:
      return c.label;
  }
}

/** The shortest name for an alternative chip: "INV-1047 · Kite & Co.", a sender, a title. */
export function recordChipText(c: RecordCandidate, data: AppData): string {
  const r = parseRecordKey(c.id);
  if (!r) return c.label;
  switch (r.kind) {
    case "invoice": {
      const inv = data.invoices.find((i) => i.id === r.id);
      return inv ? `${inv.id} · ${inv.client}` : c.label;
    }
    case "message":
      return data.messages.find((x) => x.id === r.id)?.from ?? c.label;
    case "task":
      return data.tasks.find((x) => x.id === r.id)?.title ?? c.label;
    case "event":
      return data.events.find((x) => x.id === r.id)?.title ?? c.label;
    case "project":
      return data.projects.find((x) => x.id === r.id)?.name ?? c.label;
    case "client":
      return CLIENTS.find((x) => x.id === r.id)?.name ?? c.label;
    default:
      return c.label;
  }
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

export interface CandidateInput {
  data: AppData;
  view: PanelViewState;
  /** The live anchor, or null. */
  anchor: AnchorRef | null;
  /** The link cues on screen, or null. */
  links: LinkSet | null;
  events: SignalEvent[];
  now: number;
  /** Focus aid 3: the panel the user usually goes to next (topNextPanel in ./habits.ts). Its records move up UP_NEXT_HABIT_LIFT places. Absent: code's order as before. */
  habitPanel?: PanelId;
}

/**
 * Code's order with the habit lift: each candidate in `panel` moves up
 * UP_NEXT_HABIT_LIFT places, never ahead of the first `keep` (the next
 * records in the current list). Stable otherwise.
 */
function liftHabitPanel(list: RecordCandidate[], keep: number, panel: PanelId | undefined): RecordCandidate[] {
  if (!panel) return list;
  return list
    .map((c, i) => ({ c, key: i < keep || c.panel !== panel ? i : Math.max(keep, i - UP_NEXT_HABIT_LIFT) - 0.5 }))
    .sort((a, b) => a.key - b.key)
    .map(({ c }) => c);
}

/**
 * At most RECORD_CANDIDATES_MAX records the user might work on next, in a
 * fixed order: the next records in the current list, records linked to the
 * anchor (the link cues on screen, else the live anchor's joins), unread
 * client messages, tasks due today or late, the next event today, and
 * overdue invoices without a reminder today. The current record and records
 * already handled this session are left out; each record appears once,
 * with the first reason that found it. While the user repeats one action
 * through a list, the next records in the list are only those it still
 * applies to (actionApplies). With `habitPanel` (focus aid 3), records in
 * the panel the user usually goes to next move up a few places first.
 */
export function buildRecordCandidates(input: CandidateInput): RecordCandidate[] {
  const { data, view, now } = input;
  const handled = handledRecords(input.events);
  const current = currentRecord(input.events, input.anchor);
  const out: RecordCandidate[] = [];
  const seen = new Set<string>();
  if (current) seen.add(recordKey(current.kind, current.id));
  // Collected in full, then ordered and cut to RECORD_CANDIDATES_MAX: without the habit lift, the same first ones as a cap while adding.
  const add = (kind: ItemKind, id: string, why: string): boolean => {
    const key = recordKey(kind, id);
    if (seen.has(key) || handled.has(key)) return false;
    const c = makeCandidate(kind, id, why, data, now);
    if (!c) return false;
    seen.add(key);
    out.push(c);
    return true;
  };

  // 1. The next records in the list the user is working in, that the action they repeat still applies to.
  if (current) {
    const action = detectListWork(input.events, now).action;
    for (const key of nextInList(current, data, view, now, listSkip(handled, action, data))) {
      const r = parseRecordKey(key);
      if (r) add(r.kind, r.id, "next in the list");
    }
  }
  const inList = out.length;

  // 2. Records linked to what the user clicked: the link cues on screen, else the live anchor's joins.
  const source = input.links?.source ?? input.anchor;
  if (source) {
    const perPanel = input.links
      ? (Object.values(input.links.relations).map((rel) => rel?.records ?? []) as { itemKind: ItemKind; itemId: string }[][])
      : Object.values(findLinked(source, data, { view, now })).map((records) => records ?? []);
    const name = source.label ?? source.client;
    const why = name ? `linked to ${name}` : "linked to the record you opened";
    let taken = 0;
    // One record per linked panel at a time, so one panel does not take every place.
    for (let depth = 0; taken < LINKED_CANDIDATES_MAX && perPanel.some((list) => list.length > depth); depth++) {
      for (const list of perPanel) {
        const r = list[depth];
        if (!r || taken >= LINKED_CANDIDATES_MAX) continue;
        if (add(r.itemKind, r.itemId, why)) taken++;
      }
    }
  }

  // 3. Unread messages from clients, newest first.
  let n = 0;
  for (const m of [...data.messages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))) {
    if (n >= UNREAD_CANDIDATES_MAX) break;
    if (m.unread && m.client && add("message", m.id, `unread message from ${m.client}`)) n++;
  }

  // 4. Open tasks due today, or already late, soonest first.
  n = 0;
  for (const t of [...data.tasks].sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id))) {
    if (n >= TASK_CANDIDATES_MAX) break;
    if (t.done) continue;
    const d = daysUntil(t.due, now);
    if (d > 0) continue;
    if (add("task", t.id, d === 0 ? "task due today" : "late task")) n++;
  }

  // 5. The next calendar event today that has not ended.
  const nextEvent = [...data.events]
    .sort((a, b) => a.start.localeCompare(b.start))
    .find((e) => dayOffset(e.start, now) === 0 && new Date(e.end).getTime() > now);
  if (nextEvent) add("event", nextEvent.id, "next event today");

  // 6. Overdue invoices without a reminder today (handled ones are already out), oldest due first.
  n = 0;
  for (const inv of [...data.invoices].sort((a, b) => a.due.localeCompare(b.due))) {
    if (n >= OVERDUE_CANDIDATES_MAX) break;
    if (inv.status === "overdue" && add("invoice", inv.id, "overdue, no reminder today")) n++;
  }
  return liftHabitPanel(out, inList, input.habitPanel).slice(0, RECORD_CANDIDATES_MAX);
}

// ---------------------------------------------------------------------------
// List work and queue mode
// ---------------------------------------------------------------------------

export interface ListWork {
  on: boolean;
  /** The kind of record being worked through, when on. */
  kind?: ItemKind;
  /** The action being repeated (actionKey), when list work comes from the same action on several records. */
  action?: string;
  /** Why, in words, for the inspector. Empty when off. */
  reason: string;
}

/** Which action an action event is: its action id, or for actions without one (checking off a task) its wording before the colon. */
export function actionKey(e: SignalEvent): string {
  return e.detail?.actionId && e.detail.actionId !== "none" ? e.detail.actionId : (e.detail?.label ?? "").split(":")[0].trim();
}

/**
 * True when the user did the same kind of action on LIST_WORK_SAME_ACTION_MIN
 * or more records of the same kind in the last LIST_WORK_WINDOW_MS, or
 * opened LIST_WORK_OPEN_RUN_MIN or more different records of the same kind
 * in a row (an open of another kind breaks the run).
 */
export function detectListWork(events: SignalEvent[], now: number): ListWork {
  const recent = events.filter((e) => now - e.t <= LIST_WORK_WINDOW_MS && e.t <= now);

  // The same action on several records of one kind. The newest such group wins.
  const groups = new Map<string, { what: string; kind: ItemKind; ids: Set<string>; last: number }>();
  for (const e of recent) {
    if (e.type !== "action") continue;
    const r = eventRecord(e);
    if (!r) continue;
    const what = actionKey(e);
    if (!what) continue;
    const key = `${what}|${r.kind}`;
    const g = groups.get(key) ?? { what, kind: r.kind, ids: new Set<string>(), last: 0 };
    g.ids.add(r.id);
    g.last = e.t;
    groups.set(key, g);
  }
  const best = [...groups.values()].filter((g) => g.ids.size >= LIST_WORK_SAME_ACTION_MIN).sort((a, b) => b.last - a.last)[0];
  if (best) {
    return {
      on: true,
      kind: best.kind,
      action: best.what,
      reason: `Did the same thing to ${numberWord(best.ids.size)} ${KIND_PLURAL[best.kind]} in the last few minutes`,
    };
  }

  // Different records of one kind opened in a row, newest first.
  const opens = recent.filter((e) => OPEN_TYPES.has(e.type)).map(eventRecord);
  let kind: ItemKind | undefined;
  const ids = new Set<string>();
  for (let i = opens.length - 1; i >= 0; i--) {
    const r = opens[i];
    if (!r) continue;
    kind ??= r.kind;
    if (r.kind !== kind) break;
    ids.add(r.id);
  }
  if (kind && ids.size >= LIST_WORK_OPEN_RUN_MIN) {
    return { on: true, kind, reason: `Opened ${numberWord(ids.size)} ${KIND_PLURAL[kind]} in a row` };
  }
  return { on: false, reason: "" };
}

/** Queue mode: code's list-work signal, or Jev's listWork at QUEUE_LISTWORK_AT or more. */
export function queueModeOn(listWork: ListWork, jevListWork: number | undefined): boolean {
  return listWork.on || (typeof jevListWork === "number" && Number.isFinite(jevListWork) && jevListWork >= QUEUE_LISTWORK_AT);
}

/** New work, as ends a "Back to" hold: after the list's last action, any of these but that action again ends the completion state. */
const MOVED_ON_TYPES: ReadonlySet<SignalType> = new Set<SignalType>(["item_open", "up_next_open", "task_start", "prep_start", "filter", "search", "action", "suggestion_accept", "command"]);

/** Every record of one kind in the data, for asking whether an action still applies to any of them. */
function recordIds(kind: ItemKind, data: AppData): string[] {
  switch (kind) {
    case "invoice":
      return data.invoices.map((i) => i.id);
    case "message":
      return data.messages.map((m) => m.id);
    case "project":
      return data.projects.map((p) => p.id);
    case "task":
      return data.tasks.map((t) => t.id);
    default:
      return [];
  }
}

/**
 * The Up next card's completion state ("All overdue invoices have a
 * reminder."): the user repeats an action that has a completion line
 * (QUEUE_DONE_TEXT) through a list, no record of that kind is left that it
 * applies to (actionApplies, over all the data, not only the filtered list,
 * so "All" is true), and the user has done nothing else since the last such
 * action (MOVED_ON_TYPES). Null otherwise. Never an action: it only says the list is done.
 */
export function queueDone(listWork: ListWork, events: SignalEvent[], data: AppData): UpNextDone | null {
  const { action, kind } = listWork;
  const text = action ? QUEUE_DONE_TEXT[action] : undefined;
  if (!listWork.on || !action || !kind || !text) return null;
  let last: SignalEvent | undefined;
  for (let i = events.length - 1; i >= 0 && !last; i--) if (MOVED_ON_TYPES.has(events[i].type)) last = events[i];
  if (!last || last.type !== "action" || actionKey(last) !== action) return null;
  const handled = handledRecords(events);
  if (recordIds(kind, data).some((id) => actionApplies(action, kind, id, data, handled))) return null;
  return { text, eventId: last.id };
}

// ---------------------------------------------------------------------------
// The Up next choice
// ---------------------------------------------------------------------------

export interface UpNextInput {
  /** Fresh candidates (buildRecordCandidates): the current record and handled ones are already out. */
  candidates: RecordCandidate[];
  /** Jev's nextRecord from the last applied round, if any. */
  nextRecord?: ChoiceJudgment<string>;
  /** Epoch ms when those judgments arrived, to tell whether an action came after them. */
  judgedAt: number | null;
  /** Epoch ms of the newest performed action, or null. */
  lastActionAt: number | null;
  queue: boolean;
  /** The kind code's list-work signal saw; the list fallback only walks that kind. Absent: any kind (Jev's listWork). */
  queueKind?: ItemKind;
  /**
   * While the user repeats one action through a list: whether it still
   * applies to a record, by RecordCandidate id (actionApplies). Records it
   * does not apply to never show, not even as Jev's pick. Absent: every record.
   */
  applies?: (id: string) => boolean;
  current: CurrentRecord | null;
  /** Code's next records in the current list, best first (nextInList). */
  listNext: string[];
  /** Record id -> epoch ms when the user dismissed it from the card. */
  dismissed: Record<string, number>;
  now: number;
  /** "Jev", or "Heuristic" when the server's fallback answered. */
  judge?: string;
  /**
   * The next step Jev read from the record the user clicked ("Arrange linked
   * panels by next step", ./linkFlow.ts), already past its gate: the record
   * it needs, Jev's probability, and the step's words ("to resend it").
   * Absent: none.
   */
  link?: { candidate: RecordCandidate; p: number; step?: string };
  /** Focus aid 3: the panel the user usually goes to next. Its chips rank UP_NEXT_HABIT_CHIP_BOOST higher among the alternatives. Absent: Jev's order. */
  habitPanel?: PanelId;
}

/** The judge's probability for one option. */
function probabilityOf(j: ChoiceJudgment<string>, id: string): number {
  const p = j.probabilities?.[id];
  if (typeof p === "number" && Number.isFinite(p)) return p;
  return id === j.choice ? (j.confidence ?? 0) : 0;
}

/** The judge's options, most likely first, without "none". */
export function rankedRecords(j: ChoiceJudgment<string> | undefined): { id: string; p: number }[] {
  if (!j) return [];
  const ids = new Set([j.choice, ...Object.keys(j.probabilities ?? {})]);
  ids.delete("none");
  return [...ids].map((id) => ({ id, p: probabilityOf(j, id) })).sort((a, b) => b.p - a.p || a.id.localeCompare(b.id));
}

/**
 * Jev's pick when Jev is sure enough to show it (see UP_NEXT_JEV_MIN_P):
 * probability UP_NEXT_JEV_MIN_P or more, or UP_NEXT_JEV_LEAN_P or more with
 * a lead of UP_NEXT_JEV_MARGIN over the next record and "none" under
 * UP_NEXT_JEV_NONE_MAX. Null for "none" or an unsure answer.
 */
export function confidentRecord(j: ChoiceJudgment<string> | undefined): { id: string; p: number } | null {
  if (!j || j.choice === "none") return null;
  const p = probabilityOf(j, j.choice);
  if (p >= UP_NEXT_JEV_MIN_P) return { id: j.choice, p };
  if (p < UP_NEXT_JEV_LEAN_P) return null;
  const runnerUp = rankedRecords(j).find((x) => x.id !== j.choice)?.p ?? 0;
  const none = probabilityOf(j, "none");
  return p - runnerUp >= UP_NEXT_JEV_MARGIN && none < UP_NEXT_JEV_NONE_MAX ? { id: j.choice, p } : null;
}

/**
 * What the Up next card shows. The next step of the click (`link`) when
 * there is one, then Jev's nextRecord when it is one of the
 * candidates and Jev is sure enough (confidentRecord); otherwise, in queue mode, code's next record in the current list ("Next
 * in list"); otherwise nothing. In queue mode, right after the user acts on
 * a record (an action newer than the judgments), code's next record comes
 * first, so "act, then n" walks the list; the next Jev round refines it.
 * Handled, dismissed, and current records are never shown, nor records the
 * action the user repeats no longer applies to (`applies`).
 */
export function chooseUpNext(input: UpNextInput): UpNextPick | null {
  const byId = new Map(input.candidates.map((c) => [c.id, c]));
  // The step's record is offered even when the candidate list left it out (it holds at most a few linked records).
  if (input.link && !byId.has(input.link.candidate.id)) byId.set(input.link.candidate.id, input.link.candidate);
  const currentKey = input.current ? recordKey(input.current.kind, input.current.id) : null;
  const dismissedNow = (id: string) => {
    const t = input.dismissed[id];
    return t !== undefined && input.now - t < UP_NEXT_DISMISS_MS;
  };
  const ok = (id: string) => byId.has(id) && id !== currentKey && !dismissedNow(id) && (input.applies?.(id) ?? true);
  const judge = input.judge ?? "Jev";

  const nr = input.nextRecord;
  const sure = confidentRecord(nr);
  const jev = sure && ok(sure.id) ? sure : null;
  const walksKind = !input.queueKind || input.current?.kind === input.queueKind;
  const listId = input.queue && walksKind ? input.listNext.find(ok) : undefined;
  const actedSince = input.lastActionAt !== null && (input.judgedAt === null || input.lastActionAt > input.judgedAt);

  // A chip in the usual next panel ranks a little higher (focus aid 3); the chip's own bar stays Jev's probability.
  const chipRank = (x: { id: string; p: number }) => x.p + (input.habitPanel && byId.get(x.id)?.panel === input.habitPanel ? UP_NEXT_HABIT_CHIP_BOOST : 0);
  const jevAlternatives = (skip: string) =>
    rankedRecords(nr)
      .filter((x) => x.id !== skip && x.p >= UP_NEXT_ALT_MIN_P && ok(x.id))
      .map((x, i) => ({ id: x.id, rank: chipRank(x), i }))
      .sort((a, b) => b.rank - a.rank || a.i - b.i)
      .map((x) => x.id);
  const alternativesFrom = (ids: string[]) =>
    [...new Set(ids)]
      .slice(0, UP_NEXT_ALTERNATIVES_MAX)
      .map((id) => byId.get(id))
      .filter((c): c is RecordCandidate => c !== undefined);

  // The next step of the click comes first, unless the user has acted since in a list they work through.
  const link = input.link && ok(input.link.candidate.id) ? input.link : null;
  if (link && !(listId && actedSince)) {
    return {
      candidate: byId.get(link.candidate.id)!,
      source: "link",
      why: `${judge} ${Math.round(link.p * 100)}%`,
      probability: link.p,
      ...(link.step ? { step: link.step } : {}),
      alternatives: alternativesFrom([...(jev && jev.id !== link.candidate.id ? [jev.id] : []), ...jevAlternatives(link.candidate.id)]),
    };
  }
  if (listId && (!jev || actedSince)) {
    return {
      candidate: byId.get(listId)!,
      source: "list",
      why: "Next in list",
      alternatives: alternativesFrom([...input.listNext.filter((id) => id !== listId && ok(id)), ...jevAlternatives(listId)]),
    };
  }
  if (jev) {
    return {
      candidate: byId.get(jev.id)!,
      source: "jev",
      why: `${judge} ${Math.round(jev.p * 100)}%`,
      probability: jev.p,
      alternatives: alternativesFrom([...jevAlternatives(jev.id), ...(input.queue ? input.listNext.filter((id) => id !== jev.id && ok(id)) : [])]),
    };
  }
  return null;
}

/** A string that changes only when what the card shows changes, so the store skips no-op updates. */
export function upNextKey(pick: UpNextPick | null): string {
  if (!pick) return "";
  return [pick.candidate.id, pick.candidate.label, pick.why, ...pick.alternatives.map((a) => a.id)].join("|");
}

// ---------------------------------------------------------------------------
// Opening a record
// ---------------------------------------------------------------------------

/** One panel's view patch. */
export type RevealPatch =
  | { panel: "invoices"; patch: Partial<PanelViewState["invoices"]> }
  | { panel: "inbox"; patch: Partial<PanelViewState["inbox"]> }
  | { panel: "clients"; patch: Partial<PanelViewState["clients"]> }
  | { panel: "projects"; patch: Partial<PanelViewState["projects"]> }
  | { panel: "tasks"; patch: Partial<PanelViewState["tasks"]> }
  | { panel: "calendar"; patch: Partial<PanelViewState["calendar"]> };

/**
 * The view change that selects a record in its panel, as a click there
 * would, and clears only the filter, search, or range that would hide it.
 * Null when the record does not exist.
 */
export function revealPatch(kind: ItemKind, id: string, data: AppData, view: PanelViewState, now: number): RevealPatch | null {
  switch (kind) {
    case "invoice": {
      const inv = data.invoices.find((i) => i.id === id);
      if (!inv) return null;
      const v = view.invoices;
      const patch: Partial<PanelViewState["invoices"]> = { selectedId: id };
      if (v.client && v.client !== inv.client) patch.client = null;
      if (!invoiceShown(inv, { ...v, client: null })) patch.status = "all";
      return { panel: "invoices", patch };
    }
    case "message": {
      const m = data.messages.find((x) => x.id === id);
      if (!m) return null;
      const v = view.inbox;
      const patch: Partial<PanelViewState["inbox"]> = { selectedId: id };
      if (v.client && v.client !== m.client) patch.client = null;
      if (!matchesQuery([m.from, m.subject, m.preview, m.client], v.query)) patch.query = "";
      return { panel: "inbox", patch };
    }
    case "client": {
      const c = CLIENTS.find((x) => x.id === id);
      if (!c) return null;
      return { panel: "clients", patch: { selected: c.name, ...(clientShown(c, view.clients) ? {} : { query: "" }) } };
    }
    case "project": {
      const p = data.projects.find((x) => x.id === id);
      if (!p) return null;
      return { panel: "projects", patch: { selectedId: id, ...(projectShown(p, view.projects) ? {} : { status: "all" as const }) } };
    }
    case "task": {
      const t = data.tasks.find((x) => x.id === id);
      if (!t) return null;
      const v = view.tasks;
      const patch: Partial<PanelViewState["tasks"]> = { selectedId: id };
      if (v.client && v.client !== t.client) patch.client = null;
      if (t.done && !v.showDone) patch.showDone = true;
      return { panel: "tasks", patch };
    }
    case "event": {
      const e = data.events.find((x) => x.id === id);
      if (!e) return null;
      return { panel: "calendar", patch: { selectedId: id, ...(eventShown(e, view.calendar, now) ? {} : { range: "this_week" as const }) } };
    }
    default:
      return null;
  }
}
