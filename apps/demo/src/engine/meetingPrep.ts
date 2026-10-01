/**
 * Focus aid 4, "Prepare for meetings" (docs/focus-aids.md, "Aid 4").
 *
 * Before a meeting or call with a client starts, a chip offers to prepare
 * for it. Code finds the meeting (upcomingMeeting), builds the client's
 * records that may matter in words (buildPrepRecords), and turns Jev's
 * ranking of them into the prep view: which panels link, in which order
 * they gather next to Calendar, which rows are tinted (prepPanels), and
 * the one thing to handle first when Jev says something is urgent
 * (urgentLine). Jev only scores the records, in its own request
 * (POST /api/prep). Nothing here performs an action or writes a note.
 *
 * Pure: no DOM, no store, no clock except `now`.
 */
import { PANEL_IDS, type PanelId } from "../../shared/catalog.ts";
import { CLIENTS, MESSAGES, type CalendarEvent, type Invoice, type Message, type Project, type Task } from "../../shared/fixtures.ts";
import type { AnchorRef, ItemKind, LayoutPlan, PanelPlacement, PanelRelation, PrepJudgments, PrepMeetingWords, PrepRecord, RelatedRecord, SignalEvent } from "../../shared/types.ts";
import { clockTime, dayOffset, daysUntil, formatMoney, invoiceDueText, PROJECT_STATUS_LABEL, projectDeadlineText, taskDueText } from "../ui/format.ts";
import type { AppData, PanelViewState, PrepRanking } from "./contract.ts";
import { recordKey, type RevealPatch } from "./nextUp.ts";
import { LINKED_MIN_SIZE, SIZE_RANK, withoutQuiet } from "./policy.ts";
import { invoiceIdsIn } from "./relations.ts";
import { matchesQuery } from "@attune/core";

// ---------------------------------------------------------------------------
// Constants. Demo defaults; tune them here.
// ---------------------------------------------------------------------------

/** Lead times the user can pick, in minutes: from a quick look to time for a real read and one small fix. */
export const PREP_LEAD_OPTIONS = [5, 10, 15, 30] as const;
export type PrepLeadMinutes = (typeof PREP_LEAD_OPTIONS)[number];
/** The default lead: enough to read a few records and handle one small thing before the meeting. */
export const PREP_LEAD_DEFAULT: PrepLeadMinutes = 15;
/** A meeting that started up to this long ago is still offered: the user may be joining late, and the records still help. */
export const PREP_STARTED_GRACE_MS = 5 * 60_000;
/** How often the store looks for an upcoming meeting: twice a minute keeps the minute countdown right and costs nothing. */
export const PREP_RECHECK_MS = 30_000;
/** Events worth preparing for: meetings and calls. Focus time and internal meetings have no client records to bring up. */
export const PREP_KINDS: ReadonlySet<CalendarEvent["kind"]> = new Set<CalendarEvent["kind"]>(["meeting", "call"]);
/** The most records Jev ranks: each is one Score in one request, and ten cover a client's open business. */
export const PREP_RECORDS_MAX = 10;
/** Messages from the client this recent count; older ones are settled or already answered. */
export const PREP_MESSAGE_DAYS = 14;
/** At most this many of the client's messages, newest first: the latest state of the thread. */
export const PREP_MESSAGES_MAX = 3;
/** At most this many open invoices, most overdue first: what the client owes now. */
export const PREP_INVOICES_MAX = 3;
/** At most this many of the client's open projects, soonest deadline first: a studio client rarely has more. */
export const PREP_PROJECTS_MAX = 2;
/** At most this many open tasks for the client, soonest due first: the work still owed to them. */
export const PREP_TASKS_MAX = 3;
/** A message's text is clipped to about this many characters: a request fits, and ten Scores stay small. */
export const PREP_TEXT_MAX = 200;
/** A record at or above this share of Jev's scale ("Useful background" of three levels) is tinted in its panel. */
export const PREP_TINT_AT = 0.5;
/** The Clients panel has no scored record; it ranks as "Useful background", since the contact and notes help in any meeting. */
export const PREP_CLIENT_SCORE = 0.5;
/**
 * Jev's anything-urgent Noul at or above this names one thing to handle
 * first. Past the unsure middle; the heuristic's cap, so offline an overdue
 * bill or an unread message still shows.
 */
export const PREP_URGENT_AT = 0.6;
/** The tag on every panel a prep view links. */
export const PREP_TAG = "For the meeting";
/** The suggestion after Prepare; pressing it is the only way the notes change. */
export const PREP_NOTES_LABEL = "Start meeting notes";
/** The reason on Calendar, the anchor of a prep view. */
export const PREP_ANCHOR_REASON = "The meeting you are preparing for";
/** The record kinds Jev ranks (a client row is not scored; it always links). */
export const PREP_RECORD_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>(["message", "invoice", "project", "task"]);
/** A simulated meeting starts this far ahead: inside the default lead, so the chip shows at once. */
export const SIMULATED_MEETING_IN_MS = 10 * 60_000;
/** ...and lasts this long, like the studio's usual check-ins. */
export const SIMULATED_MEETING_LENGTH_MS = 30 * 60_000;
/** The id prefix of a simulated meeting, so the Calendar and the tests can tell it from real events. */
export const SIMULATED_MEETING_PREFIX = "e-sim-";

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// The upcoming meeting
// ---------------------------------------------------------------------------

/** A saved lead time is one of the listed options. */
export function isPrepLead(value: unknown): value is PrepLeadMinutes {
  return typeof value === "number" && (PREP_LEAD_OPTIONS as readonly number[]).includes(value);
}

/** The lead time in milliseconds for a saved setting: a listed option, else PREP_LEAD_DEFAULT. */
export function prepLeadMs(minutes: number | undefined): number {
  return (isPrepLead(minutes) ? minutes : PREP_LEAD_DEFAULT) * MINUTE;
}

export interface UpcomingInput {
  events: readonly CalendarEvent[];
  now: number;
  leadMs: number;
  /** Meetings the user already prepared for this session. */
  prepared: ReadonlySet<string>;
  /** Meetings the user said "Not now" to. */
  dismissed: ReadonlySet<string>;
}

/**
 * The meeting to offer: a meeting or call (not focus time) with a client,
 * that starts within `leadMs` and started no more than PREP_STARTED_GRACE_MS
 * ago, not prepared for or dismissed this session. The soonest start wins.
 * Null when there is none.
 */
export function upcomingMeeting(input: UpcomingInput): CalendarEvent | null {
  let best: { e: CalendarEvent; start: number } | null = null;
  for (const e of input.events) {
    if (!PREP_KINDS.has(e.kind) || !e.client || input.prepared.has(e.id) || input.dismissed.has(e.id)) continue;
    const start = Date.parse(e.start);
    if (!Number.isFinite(start)) continue;
    const until = start - input.now;
    if (until > input.leadMs || -until > PREP_STARTED_GRACE_MS) continue;
    if (!best || start < best.start) best = { e, start };
  }
  return best?.e ?? null;
}

/** True once a meeting started more than PREP_STARTED_GRACE_MS ago: its chip or card goes. */
export function meetingUnderway(start: string, now: number): boolean {
  const t = Date.parse(start);
  return Number.isFinite(t) && now - t > PREP_STARTED_GRACE_MS;
}

/** The chip's countdown: "in 12 min", "now", or "started 3 min ago". Whole minutes, rounded up before the start. */
export function startsInText(start: string, now: number): string {
  const ms = Date.parse(start) - now;
  if (!Number.isFinite(ms)) return "";
  if (ms > 0) return `in ${Math.ceil(ms / MINUTE)} min`;
  const ago = Math.floor(-ms / MINUTE);
  return ago < 1 ? "now" : `started ${ago} min ago`;
}

function minutesWord(n: number): string {
  return `${n} ${n === 1 ? "minute" : "minutes"}`;
}

/** The meeting in words for Jev: "starts in 12 minutes, at 11:00 today". Code does the clock math. */
export function prepMeetingWords(e: CalendarEvent, now: number): PrepMeetingWords {
  const ms = Date.parse(e.start) - now;
  const at = `at ${clockTime(e.start)} ${dayOffset(e.start, now) === 0 ? "today" : dayOffset(e.start, now) === 1 ? "tomorrow" : "yesterday"}`;
  let time: string;
  if (ms > 0) time = `starts in ${minutesWord(Math.ceil(ms / MINUTE))}, ${at}`;
  else if (-ms < MINUTE) time = `starts now, ${at}`;
  else time = `started ${minutesWord(Math.floor(-ms / MINUTE))} ago, ${at}`;
  return { title: e.title, client: e.client ?? "No client company", time, kind: e.kind === "call" ? "call" : "meeting" };
}

// ---------------------------------------------------------------------------
// The records Jev ranks
// ---------------------------------------------------------------------------

/** One record that may matter for the meeting: what Jev reads, and what code needs to show it. */
export interface PrepCandidate {
  /** What the request carries. */
  record: PrepRecord;
  /** The row to tint in its panel. */
  related: RelatedRecord;
  /** An action due before a meeting, in the card's words, when code sees one: "INV-1042 is 14 days overdue". */
  fact?: string;
  /** The invoice ids it names (itself for an invoice), so records about one invoice count as one thing to handle. */
  about: string[];
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/** "today at 8:12", "yesterday", "3 days ago": when a message arrived, in words. */
function receivedWords(iso: string, now: number): string {
  const days = -dayOffset(iso, now);
  if (days <= 0) return `today at ${clockTime(iso)}`;
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

function remindersWords(n: number): string {
  return n === 0 ? "no reminder sent yet" : `${n} ${n === 1 ? "reminder" : "reminders"} sent`;
}

function messageRecord(m: Message, now: number): PrepCandidate {
  const text = `${m.subject} ${m.preview}`;
  return {
    record: {
      id: recordKey("message", m.id),
      kind: "message",
      panel: "inbox",
      fields: {
        from: m.from,
        client: m.client ?? "No client company",
        subject: m.subject,
        text: clip(m.preview, PREP_TEXT_MAX),
        received: receivedWords(m.receivedAt, now),
        status: m.unread ? "unread" : "read",
      },
    },
    related: { itemKind: "message", itemId: m.id, label: `${m.from}: ${m.subject}` },
    ...(m.unread ? { fact: `${m.from}'s message is unread` } : {}),
    about: invoiceIdsIn(text),
  };
}

function invoiceRecord(inv: Invoice, now: number): PrepCandidate {
  const due = invoiceDueText(inv, now);
  return {
    record: {
      id: recordKey("invoice", inv.id),
      kind: "invoice",
      panel: "invoices",
      fields: { id: inv.id, client: inv.client, status: inv.status, due, amount: formatMoney(inv.amount), project: inv.project, reminders: remindersWords(inv.remindersSent) },
    },
    related: { itemKind: "invoice", itemId: inv.id, label: `${inv.id}, ${inv.status}` },
    ...(inv.status === "overdue" ? { fact: `${inv.id} is ${due}` } : {}),
    about: [inv.id],
  };
}

function projectRecord(p: Project, now: number): PrepCandidate {
  return {
    record: {
      id: recordKey("project", p.id),
      kind: "project",
      panel: "projects",
      fields: {
        name: p.name,
        client: p.client,
        status: PROJECT_STATUS_LABEL[p.status].toLowerCase(),
        progress: `${Math.round(p.progress * 100)}% done`,
        deadline: projectDeadlineText(p, now),
        lead: p.lead,
      },
    },
    related: { itemKind: "project", itemId: p.id, label: p.name },
    about: [],
  };
}

function taskRecord(t: Task, now: number): PrepCandidate {
  const due = taskDueText(t, now);
  const late = !t.done && daysUntil(t.due, now) <= 0;
  return {
    record: { id: recordKey("task", t.id), kind: "task", panel: "tasks", fields: { title: t.title, client: t.client ?? "No client company", due, assignee: t.assignee } },
    related: { itemKind: "task", itemId: t.id, label: t.title },
    ...(late ? { fact: `"${t.title}" is ${due}` } : {}),
    about: invoiceIdsIn(t.title),
  };
}

/**
 * One record in the words /api/prep reads, or null when it does not exist or
 * is not a kind Jev ranks. The eval uses it to add a record the app would not
 * pick (a message from someone else), in the app's own words.
 */
export function prepRecordWords(kind: ItemKind, id: string, data: AppData, now: number): PrepCandidate | null {
  switch (kind) {
    case "message": {
      const m = data.messages.find((x) => x.id === id);
      return m ? messageRecord(m, now) : null;
    }
    case "invoice": {
      const inv = data.invoices.find((x) => x.id === id);
      return inv ? invoiceRecord(inv, now) : null;
    }
    case "project": {
      const p = data.projects.find((x) => x.id === id);
      return p ? projectRecord(p, now) : null;
    }
    case "task": {
      const t = data.tasks.find((x) => x.id === id);
      return t ? taskRecord(t, now) : null;
    }
    default:
      return null;
  }
}

const STATUS_ORDER: Record<Invoice["status"], number> = { overdue: 0, sent: 1, draft: 2, paid: 3 };
const PROJECT_ORDER: Record<Project["status"], number> = { blocked: 0, at_risk: 1, on_track: 2, done: 3 };

/**
 * The client's records that may matter for the meeting, at most
 * PREP_RECORDS_MAX, in code's order: the ones with an action due first
 * (overdue invoices, unread messages, tasks due today or late), then the
 * projects, then the rest (read messages, sent invoices, later tasks). That
 * order is the fallback when Jev has not answered. Recent messages from the
 * client (PREP_MESSAGE_DAYS), open invoices (sent or overdue), open
 * projects, and open tasks, each capped.
 */
export function buildPrepRecords(meeting: Pick<CalendarEvent, "client">, data: AppData, now: number): PrepCandidate[] {
  const client = meeting.client;
  if (!client) return [];
  const messages = data.messages
    .filter((m) => m.client === client && -dayOffset(m.receivedAt, now) <= PREP_MESSAGE_DAYS)
    .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
    .slice(0, PREP_MESSAGES_MAX)
    .map((m) => messageRecord(m, now));
  const invoices = data.invoices
    .filter((inv) => inv.client === client && (inv.status === "overdue" || inv.status === "sent"))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.due.localeCompare(b.due))
    .slice(0, PREP_INVOICES_MAX)
    .map((inv) => invoiceRecord(inv, now));
  const projects = data.projects
    .filter((p) => p.client === client && p.status !== "done")
    .sort((a, b) => PROJECT_ORDER[a.status] - PROJECT_ORDER[b.status] || a.deadline.localeCompare(b.deadline))
    .slice(0, PREP_PROJECTS_MAX)
    .map((p) => projectRecord(p, now));
  const tasks = data.tasks
    .filter((t) => t.client === client && !t.done)
    .sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id))
    .slice(0, PREP_TASKS_MAX)
    .map((t) => taskRecord(t, now));
  const due = (list: PrepCandidate[]) => list.filter((c) => c.fact);
  const rest = (list: PrepCandidate[]) => list.filter((c) => !c.fact);
  return [
    ...due(invoices),
    ...due(messages),
    ...due(tasks),
    ...projects,
    ...rest(messages),
    ...rest(invoices),
    ...rest(tasks),
  ].slice(0, PREP_RECORDS_MAX);
}

/** A key that changes only when the records Jev would read change, so an answer is reused until then. */
export function prepSignature(candidates: readonly PrepCandidate[]): string {
  return JSON.stringify(candidates.map((c) => [c.record.id, c.record.fields]));
}

/** Jev's (or the heuristic's) answer as shares of each record's scale, for the records that were sent. */
export function rankingFrom(records: readonly PrepRecord[], judgments: PrepJudgments, source: PrepRanking["source"]): PrepRanking {
  const scores: Record<string, number> = {};
  for (const r of records) {
    const s = judgments.scores[r.id];
    if (s && s.max > 0) scores[r.id] = Math.min(1, Math.max(0, s.score / s.max));
  }
  return { scores, urgent: Math.min(1, Math.max(0, judgments.anythingUrgent)), source };
}

// ---------------------------------------------------------------------------
// The prep view
// ---------------------------------------------------------------------------

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export interface PrepPanels {
  /** The linked panels, the most useful first: the order they gather next to Calendar. */
  order: PanelId[];
  /** One relation per linked panel: the "For the meeting" tag, its reason, and the rows to tint. */
  relations: Partial<Record<PanelId, PanelRelation>>;
  /** "jev" or "heuristic" when a ranking ordered them, "code" when none had answered. */
  source: PrepRanking["source"] | "code";
}

/**
 * The prep view's links. Each panel that holds a record is linked, and so is
 * Clients (the client row). With a ranking, the panels go by the best score
 * of their records, highest first (Clients at PREP_CLIENT_SCORE), ties in
 * code's order; each panel tints its records at or above PREP_TINT_AT, best
 * first, or its best one when none is. Without a ranking, code's order (the
 * order of buildPrepRecords) and every record tinted.
 */
export function prepPanels(candidates: readonly PrepCandidate[], ranking: PrepRanking | null, client: string): PrepPanels {
  const byPanel = new Map<PanelId, PrepCandidate[]>();
  for (const c of candidates) byPanel.set(c.record.panel, [...(byPanel.get(c.record.panel) ?? []), c]);
  const codeOrder = [...byPanel.keys()];
  const clientRow = CLIENTS.find((c) => c.name === client);
  if (clientRow) codeOrder.push("clients");
  const score = (c: PrepCandidate) => ranking?.scores[c.record.id] ?? 0;
  const panelScore = (id: PanelId) => (id === "clients" ? PREP_CLIENT_SCORE : Math.max(0, ...(byPanel.get(id) ?? []).map(score)));
  const order = ranking ? [...codeOrder].sort((a, b) => panelScore(b) - panelScore(a) || codeOrder.indexOf(a) - codeOrder.indexOf(b)) : codeOrder;
  const relations: Partial<Record<PanelId, PanelRelation>> = {};
  for (const id of order) {
    let records: RelatedRecord[];
    if (id === "clients") {
      records = clientRow ? [{ itemKind: "client", itemId: clientRow.id, label: clientRow.name }] : [];
    } else {
      const list = byPanel.get(id) ?? [];
      const ranked = ranking ? [...list].sort((a, b) => score(b) - score(a) || list.indexOf(a) - list.indexOf(b)) : list;
      const top = ranking ? ranked.filter((c) => score(c) >= PREP_TINT_AT) : ranked;
      records = (top.length > 0 ? top : ranked.slice(0, 1)).map((c) => c.related);
    }
    if (records.length === 0) continue;
    relations[id] = { anchorPanel: "calendar", tag: PREP_TAG, reason: prepReason(id, records, client, candidates), records };
  }
  return { order: order.filter((id) => relations[id]), relations, source: ranking ? ranking.source : "code" };
}

/** The tag's hover text: "2 messages from Harbor Coffee Co.", "Harbor rebrand is the project". */
function prepReason(panel: PanelId, records: RelatedRecord[], client: string, candidates: readonly PrepCandidate[]): string {
  const n = records.length;
  switch (panel) {
    case "clients":
      return `${client} is the client`;
    case "inbox":
      return `${counted(n, "message", "messages")} from ${client}`;
    case "invoices":
      return `${counted(n, "open invoice", "open invoices")} for ${client}`;
    case "projects": {
      const projects = candidates.filter((c) => c.record.kind === "project");
      return projects.length === 1 && n === 1 ? `${records[0].label} is the project` : `${counted(n, "open project", "open projects")} for ${client}`;
    }
    case "tasks":
      return `${counted(n, "open task", "open tasks")} for ${client}`;
    default:
      return counted(n, "record", "records");
  }
}

/** The shortest name for a record on the card: "INV-1042", "Priya Nair's message", a title. */
function shortName(c: PrepCandidate): string {
  const f = c.record.fields;
  switch (c.record.kind) {
    case "invoice":
      return f.id ?? c.related.label;
    case "message":
      return f.from ? `${f.from}'s message` : c.related.label;
    case "project":
      return f.name ?? c.related.label;
    default:
      return f.title ? `"${f.title}"` : c.related.label;
  }
}

/**
 * What to handle before the meeting, when Jev's anything-urgent is at least
 * PREP_URGENT_AT: the records with an action due that code can see (an
 * overdue invoice, an unread message, a task due today or late), grouped by
 * the invoice they are about (a message asking to resend INV-1042 and
 * INV-1042 itself are one thing), the groups Jev scores best first. Only
 * groups Jev rates at least useful count, unless none is. Jev sure, code
 * sees nothing: its top record. "1 thing to handle first: INV-1042 is 14
 * days overdue". Null when Jev says nothing is urgent, or has not answered.
 */
export function urgentLine(candidates: readonly PrepCandidate[], ranking: PrepRanking | null): { count: number; text: string; record: string } | null {
  if (!ranking || ranking.urgent < PREP_URGENT_AT || candidates.length === 0) return null;
  const score = (c: PrepCandidate) => ranking.scores[c.record.id] ?? 0;
  const groups = new Map<string, PrepCandidate[]>();
  for (const c of candidates) {
    if (!c.fact) continue;
    const key = c.about[0] ?? c.record.id;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const best = (list: PrepCandidate[]) => Math.max(...list.map(score));
  const all = [...groups.values()].sort((a, b) => best(b) - best(a) || candidates.indexOf(a[0]) - candidates.indexOf(b[0]));
  const useful = all.filter((g) => best(g) >= PREP_TINT_AT);
  const things = useful.length > 0 ? useful : all;
  const words = (n: number) => `${n} ${n === 1 ? "thing" : "things"} to handle first`;
  if (things.length === 0) {
    const top = [...candidates].sort((a, b) => score(b) - score(a) || candidates.indexOf(a) - candidates.indexOf(b))[0];
    return { count: 1, text: `${words(1)}: ${shortName(top)}`, record: top.record.id };
  }
  const lead = things[0];
  const shown = lead.find((c) => c.record.kind === "invoice") ?? [...lead].sort((a, b) => score(b) - score(a))[0];
  return { count: things.length, text: `${words(things.length)}: ${shown.fact}`, record: shown.record.id };
}

/**
 * The view changes a prep view makes, the way the user would: Calendar
 * shows the meeting's day and selects it; Inbox, Invoices (open ones), and
 * Tasks (open ones) show only the client's records; Projects and Clients
 * clear a filter or search only when it would hide the client's rows. A
 * panel with no record for the meeting is left alone.
 */
export function prepViewPatches(meeting: CalendarEvent, candidates: readonly PrepCandidate[], view: PanelViewState, now: number): RevealPatch[] {
  const client = meeting.client;
  const has = (kind: ItemKind) => candidates.some((c) => c.record.kind === kind);
  const out: RevealPatch[] = [{ panel: "calendar", patch: { selectedId: meeting.id, range: dayOffset(meeting.start, now) === 0 ? "today" : "this_week" } }];
  if (!client) return out;
  if (has("message")) out.push({ panel: "inbox", patch: { client, query: "" } });
  if (has("invoice")) out.push({ panel: "invoices", patch: { client, status: "unpaid" } });
  if (has("task")) out.push({ panel: "tasks", patch: { client, showDone: false } });
  const projects = candidates.filter((c) => c.record.kind === "project");
  if (projects.length > 0 && view.projects.status !== "all") out.push({ panel: "projects", patch: { status: "all" } });
  const row = CLIENTS.find((c) => c.name === client);
  if (row && view.clients.query && !matchesQuery([row.name, row.contact, row.industry, row.email], view.clients.query)) out.push({ panel: "clients", patch: { query: "" } });
  return out;
}

/**
 * The prep view as a plan: Calendar is the anchor (at least standard, not
 * quiet), every linked panel carries its relation (at least LINKED_MIN_SIZE,
 * so its tinted rows show, and not quiet), linked panels that were docked
 * join after the rest in `order`, and no other panel keeps an older
 * relation. Nothing is docked. The store packs it, holding Calendar still
 * and gathering the linked panels next to it in `order`.
 */
export function buildPrepPlan(current: LayoutPlan, args: { anchor: AnchorRef; order: readonly PanelId[]; relations: Partial<Record<PanelId, PanelRelation>>; title: string }): LayoutPlan {
  const { anchor, relations } = args;
  const atLeast = (p: PanelPlacement, size: PanelPlacement["size"]): PanelPlacement["size"] => (p.bigger || SIZE_RANK[p.size] >= SIZE_RANK[size] ? p.size : size);
  const placements: PanelPlacement[] = current.placements.map((p) => {
    const relation = relations[p.id];
    if (p.id === anchor.panel) {
      const q: PanelPlacement = { ...withoutQuiet(p), size: atLeast(p, "standard"), anchor: true, reason: p.bigger || p.pinned ? p.reason : PREP_ANCHOR_REASON };
      delete q.relation;
      return q;
    }
    const q: PanelPlacement = { ...p };
    delete q.anchor;
    if (relation) return { ...withoutQuiet(q), size: atLeast(q, LINKED_MIN_SIZE), relation };
    delete q.relation;
    return q;
  });
  const on = new Set(placements.map((p) => p.id));
  for (const id of args.order) {
    const relation = relations[id];
    if (on.has(id) || !relation) continue;
    placements.push({ id, size: LINKED_MIN_SIZE, priority: 0, pinned: false, reason: `${relation.tag}: ${relation.reason}`, change: null, relation });
    on.add(id);
  }
  return {
    ...current,
    placements,
    docked: PANEL_IDS.filter((id) => !on.has(id)),
    anchor,
    decisions: [{ kind: "command", text: `Prepared for ${args.title}` }],
  };
}

// ---------------------------------------------------------------------------
// Meeting notes and the simulated meeting
// ---------------------------------------------------------------------------

/** The heading "Start meeting notes" appends: "Harbor rebrand review, 11:00, notes:". */
export function notesHeading(e: Pick<CalendarEvent, "title" | "start">): string {
  return `${e.title}, ${clockTime(e.start)}, notes:`;
}

/** The notes with the heading appended on a new line, a blank line after any text already there. */
export function withNotesHeading(notes: string, heading: string): string {
  const kept = notes.replace(/\s+$/, "");
  return kept ? `${kept}\n\n${heading}\n` : `${heading}\n`;
}

/**
 * The client of the newest thing the user did about a client (a record
 * opened, an action, a filter), else the client with the newest message,
 * so the simulated meeting has records to bring up.
 */
export function recentClient(events: readonly SignalEvent[], data: AppData): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    const client = e.detail?.client ?? (e.type === "filter" ? e.detail?.filter?.client : undefined);
    if (client && CLIENTS.some((c) => c.name === client)) return client;
  }
  const newest = [...(data.messages.length ? data.messages : MESSAGES)].filter((m) => m.client).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))[0];
  return newest?.client ?? CLIENTS[0]?.name ?? null;
}

/**
 * A test meeting: SIMULATED_MEETING_IN_MS from now, with the client who has
 * recent activity, named after their open project ("Harbor rebrand
 * check-in"). Null when there is no client at all.
 */
export function simulatedMeeting(events: readonly SignalEvent[], data: AppData, now: number, seq: number): CalendarEvent | null {
  const client = recentClient(events, data);
  if (!client) return null;
  const project = data.projects.find((p) => p.client === client && p.status !== "done");
  const start = now + SIMULATED_MEETING_IN_MS;
  return {
    id: `${SIMULATED_MEETING_PREFIX}${seq}`,
    title: project ? `${project.name} check-in` : `Check-in with ${client}`,
    start: new Date(start).toISOString(),
    end: new Date(start + SIMULATED_MEETING_LENGTH_MS).toISOString(),
    client,
    kind: "meeting",
  };
}
