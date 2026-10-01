/**
 * Which records in other panels belong to what the user just clicked. Code
 * joins the app data on client name, invoice id, project name, and assignee,
 * so no model call is needed: Jev still decides which panels are useful, and
 * this file only says how they relate to the anchor. Pure: no DOM, no store.
 *
 * Joins and wording are in docs/anchored-relayout.md ("Relations").
 */
import { panelTitle, type PanelId } from "../../shared/catalog.ts";
import { CLIENTS, EVENTS, INVOICES, MESSAGES, PROJECTS, TASKS, TEAM, type CalendarEvent, type Client, type Invoice, type Message, type Project, type Task } from "../../shared/fixtures.ts";
import type { AnchorRef, ItemKind, PanelRelation, RelatedRecord } from "../../shared/types.ts";
import type { AppData, PanelViewState } from "./contract.ts";
import { matchesQuery } from "@attune/core";

/**
 * Most panels that get a relation (tag, tint, link line, and the priority
 * boost) per anchor. Three lines are easy to follow; more read as noise, and
 * one click must not flood the canvas.
 */
export const LINKED_PANELS_MAX = 3;

/**
 * Most panels one link set holds. A click links at most LINKED_PANELS_MAX;
 * a meeting prep view (focus aid 4) links every record kind of one client,
 * which is five panels.
 */
export const LINK_SET_MAX = 5;

/** Most records tinted per linked panel, so the tint stays a cue and not a wall of color. */
export const RELATED_RECORDS_MAX = 5;

/** Panels that never link: Revenue shows client rows only at hero size, so a tint could not show; Notes and the Guide hold no records. */
const NEVER_LINKED: ReadonlySet<PanelId> = new Set<PanelId>(["analytics", "notes", "help"]);

/** The Calendar panel's "This week" range: today and the next six days. */
const CALENDAR_WEEK_DAYS = 7;
const DAY_MS = 86_400_000;

/** Invoice ids written in free text, for example a message subject "Re: Invoice INV-1042". */
const INVOICE_ID_RE = /\bINV-\d{3,6}\b/gi;

/** Invoice ids mentioned in `text`, upper-cased. */
export function invoiceIdsIn(text: string): string[] {
  return [...new Set((text.match(INVOICE_ID_RE) ?? []).map((m) => m.toUpperCase()))];
}

/** The kind of record an id names, from its prefix, for events that carry an id but no kind (actions). */
export function kindOfId(id: string | undefined): ItemKind | undefined {
  if (!id) return undefined;
  if (/^INV-/i.test(id)) return "invoice";
  const prefix = id.split("-")[0];
  const kinds: Record<string, ItemKind> = { m: "message", c: "client", p: "project", t: "task", e: "event", u: "person" };
  return kinds[prefix];
}

/** What the anchor is about: its own record, plus that record's client and project. */
interface Subject {
  /** The anchor's record id and the invoice ids it mentions: the strongest link. */
  ids: Set<string>;
  invoiceIds: Set<string>;
  /** Project names. */
  projects: Set<string>;
  /** Client names for client-wide joins (messages, invoices, events, open projects, tasks). */
  clients: Set<string>;
  /** A team member the anchor is about. */
  person?: string;
  /** The client the reason names, when there is one. */
  client?: string;
  /** The project the reason names, when the anchor is about one project. */
  project?: string;
  /** The anchor is a project, task, or person: say "for Harbor rebrand" rather than "for Harbor Coffee Co.". */
  preferProject: boolean;
}

/** The anchor's record in live data, falling back to the fixtures (names and ids never change). */
function subjectOf(anchor: Pick<AnchorRef, "itemKind" | "itemId" | "client">, data?: Partial<AppData>): Subject {
  const s: Subject = { ids: new Set(), invoiceIds: new Set(), projects: new Set(), clients: new Set(), preferProject: false };
  const id = anchor.itemId;
  const kind = anchor.itemKind ?? kindOfId(id);
  const invoices = data?.invoices ?? INVOICES;
  const projects = data?.projects ?? PROJECTS;
  const mention = (text: string) => {
    for (const inv of invoiceIdsIn(text)) {
      s.invoiceIds.add(inv);
      s.ids.add(inv);
    }
    for (const p of projects) if (text.toLowerCase().includes(p.name.toLowerCase())) s.projects.add(p.name);
  };
  let client: string | null | undefined;
  let project: string | null | undefined;
  if (id) {
    switch (kind) {
      case "invoice": {
        const inv = invoices.find((i) => i.id === id) ?? INVOICES.find((i) => i.id === id);
        s.ids.add(id);
        s.invoiceIds.add(id);
        client = inv?.client;
        project = inv?.project;
        break;
      }
      case "message": {
        const m = (data?.messages ?? MESSAGES).find((x) => x.id === id);
        s.ids.add(id);
        if (m) mention(`${m.subject} ${m.preview}`);
        client = m?.client;
        break;
      }
      case "client": {
        const c = CLIENTS.find((x) => x.id === id || x.name === id);
        if (c) s.ids.add(c.id);
        client = c?.name;
        break;
      }
      case "project": {
        const p = projects.find((x) => x.id === id);
        s.ids.add(id);
        client = p?.client;
        project = p?.name;
        s.preferProject = true;
        break;
      }
      case "task": {
        const t = (data?.tasks ?? TASKS).find((x) => x.id === id);
        s.ids.add(id);
        if (t) mention(t.title);
        client = t?.client;
        project = t?.project;
        s.preferProject = true;
        break;
      }
      case "event": {
        const e = (data?.events ?? EVENTS).find((x) => x.id === id);
        s.ids.add(id);
        if (e) mention(e.title);
        client = e?.client;
        break;
      }
      case "person": {
        const member = TEAM.find((m) => m.id === id || m.name === id);
        if (member) {
          s.ids.add(member.id);
          s.person = member.name;
          s.projects.add(member.workingOn);
          for (const p of projects) if (p.lead === member.name) s.projects.add(p.name);
        }
        s.preferProject = true;
        break;
      }
      default:
        break;
    }
  }
  client = client ?? anchor.client;
  if (client) {
    s.clients.add(client);
    s.client = client;
  }
  if (project) {
    s.projects.add(project);
    s.project = project;
  } else if (s.projects.size === 1) {
    s.project = [...s.projects][0];
  }
  return s;
}

/** The projects whose people count as linked: the subject's own, else its client's open projects. */
function projectsForTeam(s: Subject, projects: AppData["projects"]): Set<string> {
  if (s.projects.size) return s.projects;
  return new Set(projects.filter((p) => s.clients.has(p.client) && p.status !== "done").map((p) => p.name));
}

/** Shortest first word of a client name that a search may match, so "co" or "and" never names a client. */
const CLIENT_WORD_MIN = 4;

/**
 * The one client a search names by the first word of its name ("harbor
 * invoice" names Harbor Coffee Co.), so a search can anchor on a client.
 * Undefined when none or more than one match.
 */
export function clientNamedIn(text: string): string | undefined {
  const words = new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const hits = CLIENTS.filter((c) => {
    const first = c.name.toLowerCase().split(/[^a-z0-9]+/)[0] ?? "";
    return first.length >= CLIENT_WORD_MIN && words.has(first);
  });
  return hits.length === 1 ? hits[0].name : undefined;
}

/** A sort key per record: 0 names the record or an invoice it mentions, 1 the project or person, 2 only the client. */
type Strength = 0 | 1 | 2;

function ranked<T>(rows: T[], strength: (row: T) => Strength | null, tie: (a: T, b: T) => number): T[] {
  return rows
    .map((row) => ({ row, s: strength(row) }))
    .filter((x): x is { row: T; s: Strength } => x.s !== null)
    .sort((a, b) => a.s - b.s || tie(a.row, b.row))
    .map((x) => x.row);
}

const INVOICE_STATUS_ORDER: Record<Invoice["status"], number> = { overdue: 0, sent: 1, draft: 2, paid: 3 };
const INVOICE_STATUS_WORD: Record<Invoice["status"], string> = { overdue: "overdue", sent: "sent", draft: "draft", paid: "paid" };

function includesName(text: string, names: Set<string>): boolean {
  const t = text.toLowerCase();
  for (const n of names) if (t.includes(n.toLowerCase())) return true;
  return false;
}

function mentionsInvoice(text: string, ids: Set<string>): boolean {
  return invoiceIdsIn(text).some((id) => ids.has(id));
}

/**
 * What the panels show right now. A record that a panel's filter, search, or
 * date range hides cannot be tinted, so it does not link that panel: a
 * "Linked to" tag over a panel that shows no linked record explains nothing.
 */
export interface ShownView {
  view: PanelViewState;
  now: number;
}

/** Calendar days from `now` to `iso`, in local time, the way the Calendar panel counts them. */
function daysFrom(iso: string, now: number): number {
  const a = new Date(iso);
  a.setHours(0, 0, 0, 0);
  const b = new Date(now);
  b.setHours(0, 0, 0, 0);
  return Math.round((a.getTime() - b.getTime()) / DAY_MS);
}

/** Per record kind, whether its panel shows it under `shown` (the same rules as each panel's list). Everything when absent. */
function shownBy(shown: ShownView | undefined) {
  const v = shown?.view;
  const now = shown?.now ?? 0;
  return {
    message: (m: Message) => !v || ((!v.inbox.client || m.client === v.inbox.client) && matchesQuery([m.from, m.subject, m.preview, m.client], v.inbox.query)),
    invoice: (inv: Invoice) => {
      if (!v) return true;
      const st = v.invoices.status;
      const inTab = st === "all" || st === "not_mentioned" || (st === "unpaid" ? inv.status === "sent" || inv.status === "overdue" : inv.status === st);
      return inTab && (!v.invoices.client || inv.client === v.invoices.client);
    },
    client: (c: Client) => !v || matchesQuery([c.name, c.contact, c.industry, c.email], v.clients.query),
    project: (p: Project) => !v || v.projects.status === "all" || p.status === v.projects.status,
    task: (t: Task) => (v ? v.tasks.showDone || !t.done : !t.done) && (!v?.tasks.client || t.client === v.tasks.client),
    event: (e: CalendarEvent) => {
      if (!v) return true;
      const d = daysFrom(e.start, now);
      return v.calendar.range === "today" ? d === 0 : d >= 0 && d < CALENDAR_WEEK_DAYS;
    },
  };
}

/**
 * Records in other panels linked to the anchor, most useful first, at most
 * RELATED_RECORDS_MAX per panel. Excludes the anchor's own panel, Revenue,
 * Notes, and the Guide; omits panels with no linked record. An anchor with
 * neither a record nor a client links nothing. With `shown`, only records
 * the panel shows under its current filter, search, or range count.
 */
export function findLinked(anchor: AnchorRef, data: AppData, shown?: ShownView): Partial<Record<PanelId, RelatedRecord[]>> {
  const s = subjectOf(anchor, data);
  const visible = shownBy(shown);
  const out: Partial<Record<PanelId, RelatedRecord[]>> = {};
  if (!s.ids.size && !s.clients.size && !s.projects.size) return out;
  const add = (panel: PanelId, records: RelatedRecord[]) => {
    if (panel === anchor.panel || NEVER_LINKED.has(panel) || !records.length) return;
    out[panel] = records.slice(0, RELATED_RECORDS_MAX);
  };
  const projectClients = new Set(data.projects.filter((p) => s.projects.has(p.name)).map((p) => p.client));

  // Inbox: naming the invoice or project first, then unread, then newest.
  add(
    "inbox",
    ranked(
      data.messages.filter(visible.message),
      (m) => {
        const text = `${m.subject} ${m.preview}`;
        if (s.ids.has(m.id) || mentionsInvoice(text, s.invoiceIds)) return 0;
        if (s.projects.size && includesName(text, s.projects)) return 1;
        return m.client && s.clients.has(m.client) ? 2 : null;
      },
      (a, b) => Number(b.unread) - Number(a.unread) || b.receivedAt.localeCompare(a.receivedAt),
    ).map((m) => ({ itemKind: "message", itemId: m.id, label: `${m.from}: ${m.subject}` })),
  );

  // Invoices: the named ones, then the project's, then the client's; overdue first, then by due date.
  add(
    "invoices",
    ranked(
      data.invoices.filter(visible.invoice),
      (inv) => (s.invoiceIds.has(inv.id) ? 0 : s.projects.has(inv.project) ? 1 : s.clients.has(inv.client) ? 2 : null),
      (a, b) => INVOICE_STATUS_ORDER[a.status] - INVOICE_STATUS_ORDER[b.status] || a.due.localeCompare(b.due),
    ).map((inv) => ({ itemKind: "invoice", itemId: inv.id, label: `${inv.id}, ${INVOICE_STATUS_WORD[inv.status]}` })),
  );

  // Clients: the client row itself (for a person, the clients of their projects).
  const clientNames = new Set([...s.clients, ...projectClients]);
  add(
    "clients",
    ranked(
      CLIENTS.filter(visible.client),
      (c) => (s.ids.has(c.id) || c.name === s.client ? 0 : clientNames.has(c.name) ? 2 : null),
      (a, b) => a.name.localeCompare(b.name),
    ).map((c) => ({ itemKind: "client", itemId: c.id, label: c.name })),
  );

  // Projects: the named project, else the client's open projects.
  add(
    "projects",
    ranked(
      data.projects.filter(visible.project),
      (p) => (s.ids.has(p.id) || s.projects.has(p.name) ? 0 : s.clients.has(p.client) && p.status !== "done" ? 2 : null),
      (a, b) => a.deadline.localeCompare(b.deadline),
    ).map((p) => ({ itemKind: "project", itemId: p.id, label: p.name })),
  );

  // Tasks: open ones only unless the panel shows done ones (hidden by default, so a tint could not show).
  add(
    "tasks",
    ranked(
      data.tasks.filter(visible.task),
      (t) => {
        if (s.ids.has(t.id) || mentionsInvoice(t.title, s.invoiceIds)) return 0;
        if ((t.project && s.projects.has(t.project)) || (s.person && t.assignee === s.person)) return 1;
        return t.client && s.clients.has(t.client) ? 2 : null;
      },
      (a, b) => a.due.localeCompare(b.due),
    ).map((t) => ({ itemKind: "task", itemId: t.id, label: t.title })),
  );

  // Calendar: the client's events in the shown range, soonest first.
  add(
    "calendar",
    ranked(
      data.events.filter(visible.event),
      (e) => (s.ids.has(e.id) ? 0 : s.projects.size && includesName(e.title, s.projects) ? 1 : e.client && s.clients.has(e.client) ? 2 : null),
      (a, b) => a.start.localeCompare(b.start),
    ).map((e) => ({ itemKind: "event", itemId: e.id, label: e.title })),
  );

  // Team: people on the subject's projects (the named one, else the client's open ones), leads first.
  const teamProjects = projectsForTeam(s, data.projects);
  const leads = new Set(data.projects.filter((p) => teamProjects.has(p.name)).map((p) => p.lead));
  add(
    "team",
    ranked(
      TEAM,
      (m) => (s.ids.has(m.id) ? 0 : leads.has(m.name) ? 1 : teamProjects.has(m.workingOn) ? 2 : null),
      () => 0,
    ).map((m) => ({ itemKind: "person", itemId: m.id, label: m.name })),
  );
  return out;
}

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

/** How one linked record relates to the anchor ("Arrange linked panels by next step"). */
export interface LinkWhy {
  /**
   * Smaller is closer: 0 the anchor names this record (the invoice a message
   * is about), 1 this record names the anchor's record or an invoice the
   * anchor names, 2 the same project or person, 3 only the same client.
   */
  strength: 0 | 1 | 2 | 3;
  /** Why it is linked, in words for Jev, for example "the clicked message names this invoice". */
  why: string;
}

/**
 * How a record in another panel is linked to the anchor, for code's
 * fallback order of the linked panels (the same record id first, then the
 * same project, then the same client) and for the words Jev reads. Uses the
 * same joins as findLinked.
 */
export function linkWhy(anchor: AnchorRef, record: Pick<RelatedRecord, "itemKind" | "itemId">, data: AppData): LinkWhy {
  const s = subjectOf(anchor, data);
  const clicked = `the clicked ${KIND_WORD[anchor.itemKind ?? kindOfId(anchor.itemId) ?? "client"]}`;
  const own = anchor.itemId;
  const id = record.itemId;
  const named = [...s.invoiceIds].filter((inv) => inv !== own);
  const mentions = (text: string) => invoiceIdsIn(text).find((inv) => s.invoiceIds.has(inv));
  const byProject = (name: string | null | undefined): LinkWhy | null => (name && s.projects.has(name) ? { strength: 2, why: `same project: ${name}` } : null);
  const byClient = (client: string | null | undefined): LinkWhy | null =>
    client && s.clients.has(client) ? { strength: 3, why: `same client: ${client}` } : null;
  const mentioned = (text: string, word: string): LinkWhy | null => {
    const inv = mentions(text);
    if (!inv) return null;
    return { strength: 1, why: inv === own ? `this ${word} names ${clicked}` : `this ${word} names ${inv}, which ${clicked} names` };
  };
  const fallback: LinkWhy = { strength: 3, why: `linked to ${clicked}` };
  switch (record.itemKind) {
    case "invoice": {
      if (named.includes(id)) return { strength: 0, why: `${clicked} names this invoice` };
      const inv = data.invoices.find((i) => i.id === id);
      return (inv && (byProject(inv.project) ?? byClient(inv.client))) ?? fallback;
    }
    case "message": {
      const m = data.messages.find((x) => x.id === id);
      if (!m) return fallback;
      return mentioned(`${m.subject} ${m.preview}`, "message") ?? byClient(m.client) ?? fallback;
    }
    case "task": {
      const t = data.tasks.find((x) => x.id === id);
      if (!t) return fallback;
      return mentioned(t.title, "task") ?? byProject(t.project) ?? (s.person && t.assignee === s.person ? { strength: 2, why: `assigned to ${s.person}` } : null) ?? byClient(t.client) ?? fallback;
    }
    case "event": {
      const e = data.events.find((x) => x.id === id);
      if (!e) return fallback;
      const project = [...s.projects].find((p) => e.title.toLowerCase().includes(p.toLowerCase()));
      return mentioned(e.title, "calendar event") ?? byProject(project) ?? byClient(e.client) ?? fallback;
    }
    case "project": {
      const p = data.projects.find((x) => x.id === id);
      if (!p) return fallback;
      return byProject(p.name) ?? byClient(p.client) ?? fallback;
    }
    case "client": {
      const c = CLIENTS.find((x) => x.id === id);
      return c && s.clients.has(c.name) ? { strength: 3, why: `the client of ${clicked}` } : fallback;
    }
    default:
      return fallback;
  }
}

/**
 * Short name for an anchor's tag: the invoice id, the sender of a message,
 * the client, project, or person name, or for a task or an event its client
 * (its title when it has none). Undefined when the record is unknown and there is no client.
 */
export function anchorLabel(ref: Pick<AnchorRef, "itemKind" | "itemId" | "client">, data: AppData): string | undefined {
  const id = ref.itemId;
  const kind = ref.itemKind ?? kindOfId(id);
  if (id) {
    switch (kind) {
      case "invoice": {
        const inv = data.invoices.find((i) => i.id === id);
        if (inv) return inv.id;
        break;
      }
      case "message": {
        const m = data.messages.find((x) => x.id === id);
        if (m) return m.from;
        break;
      }
      case "client": {
        const c = CLIENTS.find((x) => x.id === id || x.name === id);
        if (c) return c.name;
        break;
      }
      case "project": {
        const p = data.projects.find((x) => x.id === id);
        if (p) return p.name;
        break;
      }
      case "task": {
        const t = data.tasks.find((x) => x.id === id);
        if (t) return t.client ?? t.project ?? ref.client ?? t.title;
        break;
      }
      case "event": {
        // The client, as for a task: event titles are long ("Focus: Vantage report layout") and truncate in a tag.
        const e = data.events.find((x) => x.id === id);
        if (e) return e.client ?? ref.client ?? e.title;
        break;
      }
      case "person": {
        const member = TEAM.find((m) => m.id === id || m.name === id);
        if (member) return member.name;
        break;
      }
      default:
        break;
    }
  }
  return ref.client || undefined;
}

function counted(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Tag and reason for one linked panel, for example tag "Linked to INV-1042"
 * and reason "2 messages from Harbor Coffee Co.". `records` must be non-empty.
 * `data` is optional: names come from the fixtures, which never rename a
 * record, and live data only adds records made during the session.
 */
export function relationFor(anchor: AnchorRef, panel: PanelId, records: RelatedRecord[], data?: Partial<AppData>): PanelRelation {
  const s = subjectOf(anchor, data);
  const n = records.length;
  const name = anchor.label ?? anchor.client ?? panelTitle(anchor.panel);
  // "for Harbor rebrand" when the anchor is one project's work, else "for Harbor Coffee Co.".
  const topic = (s.preferProject ? (s.project ?? s.client) : (s.client ?? s.project)) ?? s.person ?? name;
  let reason: string;
  switch (panel) {
    case "inbox":
      reason = s.client ? `${counted(n, "message", "messages")} from ${s.client}` : `${counted(n, "message", "messages")} about ${topic}`;
      break;
    case "invoices":
      reason = `${counted(n, "invoice", "invoices")} for ${topic}`;
      break;
    case "clients":
      reason = n === 1 ? `${records[0].label} is the client` : `${counted(n, "client", "clients")} for ${topic}`;
      break;
    case "projects":
      reason =
        n === 1 && records[0].label === s.project
          ? `${records[0].label} is the project`
          : `${counted(n, "open project", "open projects")} for ${s.person ?? s.client ?? topic}`;
      break;
    case "tasks":
      reason = `${counted(n, "open task", "open tasks")} for ${s.person && !s.project ? s.person : topic}`;
      break;
    case "calendar":
      reason = s.client ? `${counted(n, "event", "events")} with ${s.client}` : `${counted(n, "event", "events")} about ${topic}`;
      break;
    case "team": {
      const team = projectsForTeam(s, data?.projects ?? PROJECTS);
      const on = s.project ?? (team.size === 1 ? [...team][0] : s.client ? `${s.client} projects` : topic);
      reason = `${counted(n, "person", "people")} on ${on}`;
      break;
    }
    default:
      reason = counted(n, "linked record", "linked records");
      break;
  }
  return { anchorPanel: anchor.panel, tag: `Linked to ${name}`, reason, records };
}
