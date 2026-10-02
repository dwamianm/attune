/**
 * The fixed vocabulary of the prototype.
 *
 * Everything the UI can show (panels), every goal Jev can infer, and every
 * next step Jev can suggest is listed here. The server turns these lists into
 * Jev question criteria, and the client uses the same ids to lay out panels,
 * so the two sides can never disagree about what an id means.
 *
 * CATALOG at the end is the same vocabulary as one value, checked by
 * defineCatalog from @attuneui/core when this module loads. It is what the
 * library reads as library modules move out of this app
 * (docs/library-roadmap.md at the repo root). The layout modes belong to the
 * library and are re-exported here.
 *
 * Descriptions are written for Jev as much as for people: they are sent as
 * question context, so keep them concrete and literal (see the Jev 1.13
 * "literal reading" note in the TypeSafe docs).
 */

import { defineCatalog, type ActionDef as LibActionDef, type Catalog, type GoalDef, type PanelDef as LibPanelDef } from "@attuneui/core";

export { LAYOUT_MODE_DEFS, LAYOUT_MODES, type LayoutMode } from "@attuneui/core";

export const PANEL_IDS = [
  "inbox",
  "calendar",
  "tasks",
  "invoices",
  "clients",
  "projects",
  "analytics",
  "team",
  "notes",
  "help",
] as const;
export type PanelId = (typeof PANEL_IDS)[number];

/** One panel. `icon` is a lucide-react icon name (src/ui/icons.ts). */
export type PanelDef = LibPanelDef<PanelId>;

/**
 * `commandExamples` are example commands per panel, as in the
 * function-calling cookbook's spec, for the command panel question. They are
 * written to differ from the eval's COMMAND_CASES so the eval stays honest.
 */
export const PANELS: Record<PanelId, PanelDef> = {
  inbox: {
    id: "inbox",
    title: "Inbox",
    description:
      "Email messages from clients and teammates. The user reads, searches, and replies to messages here.",
    icon: "Inbox",
    defaultVisible: true,
    commandExamples: ["find the email from Priya", "any new messages from clients"],
  },
  calendar: {
    id: "calendar",
    title: "Calendar",
    description:
      "Today's and this week's meetings and calls. The user checks their schedule and books meetings here.",
    icon: "CalendarDays",
    defaultVisible: true,
    commandExamples: ["what meetings do I have tomorrow", "book a call with Juniper"],
  },
  tasks: {
    id: "tasks",
    title: "Tasks",
    description:
      "The user's to-do list with due dates, linked to projects. The user adds, checks off, and reorders tasks here.",
    icon: "ListChecks",
    defaultVisible: true,
    commandExamples: ["what do I need to finish this week", "add a to-do to send the files"],
  },
  invoices: {
    id: "invoices",
    title: "Invoices",
    description:
      "Bills sent to clients, with amount, due date, and status (draft, sent, overdue, paid). The user sends payment reminders and marks invoices paid here.",
    icon: "Receipt",
    defaultVisible: true,
    commandExamples: ["which bills are still unpaid", "show late invoices", "send Kite a payment reminder"],
  },
  clients: {
    id: "clients",
    title: "Clients",
    description:
      "The list of client companies with contact person, email, and a summary of their projects and invoices.",
    icon: "Building2",
    defaultVisible: true,
    commandExamples: ["open Pinecrest Clinic", "contact details for Kite & Co."],
  },
  projects: {
    id: "projects",
    title: "Projects",
    description:
      "Client projects with progress, deadline, and status (on track, at risk, blocked, done).",
    icon: "KanbanSquare",
    defaultVisible: true,
    commandExamples: ["which projects are behind schedule", "how is the signage project going"],
  },
  analytics: {
    id: "analytics",
    title: "Revenue",
    description:
      "Charts of monthly revenue, money still owed by clients, and totals for the year.",
    icon: "ChartColumn",
    defaultVisible: false,
    commandExamples: ["how much did we earn this year", "show the revenue chart"],
  },
  team: {
    id: "team",
    title: "Team",
    description:
      "The studio's team members, what each person is working on, and who is available or away today.",
    icon: "Users",
    defaultVisible: false,
    commandExamples: ["who is out of the office", "what is Riley working on"],
  },
  notes: {
    id: "notes",
    title: "Notes",
    description: "A scratch pad where the user writes quick notes and ideas.",
    icon: "NotebookPen",
    defaultVisible: false,
    commandExamples: ["write down an idea", "open my scratch pad"],
  },
  help: {
    id: "help",
    title: "Guide",
    description:
      "Tips on how to use this workspace: the command bar, shortcuts, and how panels move. Useful when the user seems lost.",
    icon: "LifeBuoy",
    defaultVisible: false,
    commandExamples: ["how does this workspace work", "what keyboard shortcuts are there"],
  },
};

/** Goals Jev chooses between. `unclear` is the explicit no-match outcome. */
export const GOAL_IDS = [
  "triage_inbox",
  "plan_day",
  "collect_payments",
  "manage_client",
  "track_projects",
  "review_business",
  "coordinate_team",
  "capture_notes",
  "unclear",
] as const;
export type GoalId = (typeof GOAL_IDS)[number];

/**
 * `notFor` says what each goal is not, for the pairs Jev confused in live
 * runs (an inbox search for an invoice read as inbox triage). Every goal has
 * one, so the options compare directly, per the Choice docs.
 */
export const GOALS: Record<GoalId, GoalDef> = {
  triage_inbox: {
    label: "Working through the inbox",
    description: "Reading, sorting, and replying to email messages.",
    notFor: "Searching the inbox for one bill, project, or client while working on that.",
  },
  plan_day: {
    label: "Planning the day",
    description: "Looking at today's meetings and tasks to decide what to do and when.",
    notFor: "Working through one client's or one project's details.",
  },
  collect_payments: {
    label: "Collecting payments",
    description:
      "Checking unpaid or overdue invoices and getting clients to pay them.",
    notFor: "Looking at revenue charts or totals for the year.",
  },
  manage_client: {
    label: "Working on one client",
    description:
      "Focusing on a single client company: its contact details, messages, projects, and invoices.",
    notFor: "Mainly chasing overdue or unpaid invoices.",
  },
  track_projects: {
    label: "Tracking projects",
    description: "Checking project progress, deadlines, blockers, and related tasks.",
    notFor: "Only checking who on the team is free.",
  },
  review_business: {
    label: "Reviewing the business",
    description: "Looking at revenue, money owed, and how the business is doing overall.",
    notFor: "Chasing one specific unpaid invoice.",
  },
  coordinate_team: {
    label: "Coordinating the team",
    description: "Checking who on the team is available and who is working on what.",
    notFor: "Only checking a project's progress or deadline.",
  },
  capture_notes: {
    label: "Writing notes",
    description: "Writing down notes, ideas, or meeting minutes.",
    notFor: "Adding an item to the to-do list.",
  },
  unclear: {
    label: "Not sure yet",
    description:
      "There is too little activity, or the activity is too mixed, to tell what the user is working on.",
    notFor: "Activity that clearly fits one of the other goals.",
  },
};

/** Next steps Jev can suggest. `none` is the explicit no-match outcome. */
export const ACTION_IDS = [
  "send_payment_reminder",
  "mark_invoice_paid",
  "resend_invoice",
  "reply_to_message",
  "schedule_meeting",
  "create_task",
  "update_project_status",
  "view_client",
  "write_note",
  "none",
] as const;
export type ActionId = (typeof ACTION_IDS)[number];

/** One next step. Its label may contain {client} and {invoice}, which code fills in. */
export type ActionDef = LibActionDef<PanelId, ActionId>;

export const ACTIONS: Record<ActionId, ActionDef> = {
  send_payment_reminder: {
    id: "send_payment_reminder",
    label: "Send payment reminder to {client}",
    description: "Send a client a reminder to pay an overdue invoice.",
    panel: "invoices",
  },
  mark_invoice_paid: {
    id: "mark_invoice_paid",
    label: "Mark {client}'s invoice as paid",
    description: "Record that a client has paid an invoice.",
    panel: "invoices",
  },
  resend_invoice: {
    id: "resend_invoice",
    label: "Resend {invoice} to {client}",
    description: "Send an invoice to the client again, for example to a new address after an email bounced.",
    panel: "invoices",
  },
  reply_to_message: {
    id: "reply_to_message",
    label: "Reply to {client}",
    description: "Write a reply to an email message in the inbox.",
    panel: "inbox",
  },
  schedule_meeting: {
    id: "schedule_meeting",
    label: "Schedule a meeting with {client}",
    description: "Book a meeting or call on the calendar.",
    panel: "calendar",
  },
  create_task: {
    id: "create_task",
    label: "Add a task",
    description: "Add a new item to the to-do list so it is not forgotten.",
    panel: "tasks",
  },
  update_project_status: {
    id: "update_project_status",
    label: "Update project status",
    description: "Change a project's progress or status, for example from at risk to on track.",
    panel: "projects",
  },
  view_client: {
    id: "view_client",
    label: "Open {client}",
    description: "Open one client's details to see everything about them in one place.",
    panel: "clients",
  },
  write_note: {
    id: "write_note",
    label: "Write a note",
    description: "Write down a note or idea in the scratch pad.",
    panel: "notes",
  },
  none: {
    id: "none",
    label: "",
    description: "There is no clear next step to suggest right now.",
    panel: null,
  },
};

/**
 * Hand-written rule: how strongly each goal implies each panel (0 to 1).
 * This is deliberately code, not a model call. The layout policy blends it
 * with Jev's per-panel relevance scores using weights the user can change.
 */
export const GOAL_PANEL_AFFINITY: Record<GoalId, Partial<Record<PanelId, number>>> = {
  triage_inbox: { inbox: 1, tasks: 0.5, calendar: 0.4, clients: 0.3 },
  plan_day: { calendar: 1, tasks: 0.9, inbox: 0.4, team: 0.3, projects: 0.3 },
  collect_payments: { invoices: 1, clients: 0.7, inbox: 0.5, analytics: 0.4 },
  manage_client: { clients: 1, inbox: 0.6, projects: 0.6, invoices: 0.6, calendar: 0.3 },
  track_projects: { projects: 1, tasks: 0.8, team: 0.5, calendar: 0.3 },
  review_business: { analytics: 1, invoices: 0.6, clients: 0.4, projects: 0.3 },
  coordinate_team: { team: 1, projects: 0.6, calendar: 0.5, tasks: 0.4 },
  capture_notes: { notes: 1, tasks: 0.4, calendar: 0.2 },
  unclear: {},
};

/** The whole vocabulary as one checked value, for the library (see the note at the top). */
export const CATALOG: Catalog<PanelId, GoalId, ActionId> = defineCatalog({
  panelIds: PANEL_IDS,
  panels: PANELS,
  goalIds: GOAL_IDS,
  goals: GOALS,
  actionIds: ACTION_IDS,
  actions: ACTIONS,
  goalPanelAffinity: GOAL_PANEL_AFFINITY,
});

export function panelTitle(id: PanelId): string {
  return PANELS[id].title;
}
