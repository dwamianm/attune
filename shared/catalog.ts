/**
 * The fixed vocabulary of the prototype.
 *
 * Everything the UI can show (panels), every goal Jev can infer, and every
 * next step Jev can suggest is listed here. The server turns these lists into
 * Jev question criteria, and the client uses the same ids to lay out panels,
 * so the two sides can never disagree about what an id means.
 *
 * Descriptions are written for Jev as much as for people: they are sent as
 * question context, so keep them concrete and literal (see the Jev 1.13
 * "literal reading" note in the TypeSafe docs).
 */

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

export interface PanelDef {
  id: PanelId;
  title: string;
  /** What the panel shows and what the user can do in it. Sent to Jev. */
  description: string;
  /** lucide-react icon name used by the UI. */
  icon: string;
  /** Shown on first load, before there is any activity to adapt to. */
  defaultVisible: boolean;
}

export const PANELS: Record<PanelId, PanelDef> = {
  inbox: {
    id: "inbox",
    title: "Inbox",
    description:
      "Email messages from clients and teammates. The user reads, searches, and replies to messages here.",
    icon: "Inbox",
    defaultVisible: true,
  },
  calendar: {
    id: "calendar",
    title: "Calendar",
    description:
      "Today's and this week's meetings and calls. The user checks their schedule and books meetings here.",
    icon: "CalendarDays",
    defaultVisible: true,
  },
  tasks: {
    id: "tasks",
    title: "Tasks",
    description:
      "The user's to-do list with due dates, linked to projects. The user adds, checks off, and reorders tasks here.",
    icon: "ListChecks",
    defaultVisible: true,
  },
  invoices: {
    id: "invoices",
    title: "Invoices",
    description:
      "Bills sent to clients, with amount, due date, and status (draft, sent, overdue, paid). The user sends payment reminders and marks invoices paid here.",
    icon: "Receipt",
    defaultVisible: true,
  },
  clients: {
    id: "clients",
    title: "Clients",
    description:
      "The list of client companies with contact person, email, and a summary of their projects and invoices.",
    icon: "Building2",
    defaultVisible: true,
  },
  projects: {
    id: "projects",
    title: "Projects",
    description:
      "Client projects with progress, deadline, and status (on track, at risk, blocked, done).",
    icon: "KanbanSquare",
    defaultVisible: true,
  },
  analytics: {
    id: "analytics",
    title: "Revenue",
    description:
      "Charts of monthly revenue, money still owed by clients, and totals for the year.",
    icon: "ChartColumn",
    defaultVisible: false,
  },
  team: {
    id: "team",
    title: "Team",
    description:
      "The studio's team members, what each person is working on, and who is available or away today.",
    icon: "Users",
    defaultVisible: false,
  },
  notes: {
    id: "notes",
    title: "Notes",
    description: "A scratch pad where the user writes quick notes and ideas.",
    icon: "NotebookPen",
    defaultVisible: false,
  },
  help: {
    id: "help",
    title: "Guide",
    description:
      "Tips on how to use this workspace: the command bar, shortcuts, and how panels move. Useful when the user seems lost.",
    icon: "LifeBuoy",
    defaultVisible: false,
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

export const GOALS: Record<GoalId, { label: string; description: string }> = {
  triage_inbox: {
    label: "Working through the inbox",
    description: "Reading, sorting, and replying to email messages.",
  },
  plan_day: {
    label: "Planning the day",
    description: "Looking at today's meetings and tasks to decide what to do and when.",
  },
  collect_payments: {
    label: "Collecting payments",
    description:
      "Checking unpaid or overdue invoices and getting clients to pay them.",
  },
  manage_client: {
    label: "Working on one client",
    description:
      "Focusing on a single client company: its contact details, messages, projects, and invoices.",
  },
  track_projects: {
    label: "Tracking projects",
    description: "Checking project progress, deadlines, blockers, and related tasks.",
  },
  review_business: {
    label: "Reviewing the business",
    description: "Looking at revenue, money owed, and how the business is doing overall.",
  },
  coordinate_team: {
    label: "Coordinating the team",
    description: "Checking who on the team is available and who is working on what.",
  },
  capture_notes: {
    label: "Writing notes",
    description: "Writing down notes, ideas, or meeting minutes.",
  },
  unclear: {
    label: "Not sure yet",
    description:
      "There is too little activity, or the activity is too mixed, to tell what the user is working on.",
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

export interface ActionDef {
  id: ActionId;
  /** Short button label. May contain {client} and {invoice}, which code fills in. */
  label: string;
  /** Sent to Jev as the option description. */
  description: string;
  /** Panel that performs the action. */
  panel: PanelId | null;
}

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

export const LAYOUT_MODES = ["focus", "compare", "overview"] as const;
export type LayoutMode = (typeof LAYOUT_MODES)[number];

export const LAYOUT_MODE_DEFS: Record<LayoutMode, { label: string; description: string }> = {
  focus: {
    label: "Focus",
    description:
      "The user is working deeply on one thing. Show one large panel with a few small helpers.",
  },
  compare: {
    label: "Compare",
    description:
      "The user is moving back and forth between two related things. Show two large panels side by side.",
  },
  overview: {
    label: "Overview",
    description:
      "The user is scanning or switching between many areas. Show many medium panels at once.",
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

export function panelTitle(id: PanelId): string {
  return PANELS[id].title;
}
