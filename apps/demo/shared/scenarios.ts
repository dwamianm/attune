/**
 * Scripted user sessions. Used in two places:
 *   - the inspector's "Replay" buttons, to demo the adaptive layout without clicking;
 *   - scripts/eval.ts, to check Jev's judgments against what a person would expect.
 *
 * Expectations are deliberately loose ("any of"): several answers can be fine,
 * and the eval reports probabilities so a near miss is visible.
 */
import type { ActionId, GoalId, LayoutMode, PanelId } from "./catalog.ts";
import type { ClickedRecord, ItemKind, RecordCandidate, TaskCandidate, TrackInput } from "./types.ts";

export interface ScenarioStep extends TrackInput {
  /** Milliseconds to wait before this step when replaying in the UI. */
  delayMs?: number;
}

export interface Scenario {
  id: string;
  name: string;
  description: string;
  steps: ScenarioStep[];
  /** Panel the user is focused on at the end. */
  finalFocus: PanelId | null;
  /**
   * Records the client would offer at the end of the session (sent as
   * AdaptRequest.candidates.records). Without them the request has no
   * next-record questions, the same as the app with nothing to offer.
   */
  candidates?: RecordCandidate[];
  /**
   * The working goal at the end (focus aid 2), sent as
   * AdaptRequest.workingGoal in its catalog words. Adds the goal-done question.
   */
  workingGoal?: GoalId;
  /**
   * Next-task candidates the client would send at the end (sent as
   * AdaptRequest.candidates.tasks). The app sends them only when the working
   * goal might be done, so only such sessions list them.
   */
  tasks?: TaskCandidate[];
  /**
   * The record clicked last, for the link questions ("Arrange linked panels
   * by next step"), sent as AdaptRequest.link. With only `kind` and `id`, the
   * eval builds its words and linked records with the app's own code from
   * the fixtures (linkRequestFor in src/engine/linkFlow.ts); `words` and
   * `records` stand in for a record the fixtures do not have.
   */
  link?: { kind: ItemKind; id: string; client?: string; words?: ClickedRecord; records?: RecordCandidate[] };
  expect: {
    goal?: GoalId[];
    /** At least one of these must be in the top 3 by relevance score. */
    topPanels?: PanelId[];
    /** None of these may be in the top 3. */
    notTopPanels?: PanelId[];
    layout?: LayoutMode[];
    nextAction?: ActionId[];
    targetClient?: string[];
    /** true: noul >= 0.55 (the policy's help hint threshold). false: noul <= 0.4. */
    struggling?: boolean;
    /** "low": score <= 0.8. "high": score >= 1.2. */
    expertise?: "low" | "high";
    /** Accepted candidate ids: the most probable next record must be one of these. */
    nextRecord?: string[];
    /** true: noul >= 0.6 (working through similar records one by one). false: noul <= 0.4. */
    listWork?: boolean;
    /** true: goal-done noul >= 0.6 (the working goal's work is finished). false: noul <= 0.4. Needs workingGoal. */
    goalDone?: boolean;
    /** Accepted task ids: the most probable next task must be one of these. Needs tasks. */
    nextTask?: string[];
    /** Accepted linked record ids: the most probable link-next must be one of these. Needs link. */
    linkNext?: string[];
    /** Accepted actions: the most probable link-action must be one of these ("none" for a record that asks for nothing). Needs link. */
    linkAction?: ActionId[];
  };
}

/**
 * Candidate records, labeled in the same style as the scenario steps. Each
 * scenario adds the code hint (`why`) the client would attach in that context.
 * Built from shared/fixtures.ts data.
 */
const REC = {
  inv1038: { id: "invoice:INV-1038", kind: "invoice", panel: "invoices", client: "Meridian Hotels", label: "INV-1038 · Meridian Hotels · overdue 36 days · $12,800" },
  inv1042: { id: "invoice:INV-1042", kind: "invoice", panel: "invoices", client: "Harbor Coffee Co.", label: "INV-1042 · Harbor Coffee Co. · overdue 14 days · $4,200" },
  inv1047: { id: "invoice:INV-1047", kind: "invoice", panel: "invoices", client: "Kite & Co.", label: "INV-1047 · Kite & Co. · overdue 5 days · $2,650" },
  inv1049: { id: "invoice:INV-1049", kind: "invoice", panel: "invoices", client: "Pinecrest Clinic", label: "INV-1049 · Pinecrest Clinic · due in 20 days · $5,400" },
  inv1050: { id: "invoice:INV-1050", kind: "invoice", panel: "invoices", client: "Juniper Books", label: "INV-1050 · Juniper Books · due in 27 days · $1,800" },
  m1: { id: "message:m-1", kind: "message", panel: "inbox", client: "Harbor Coffee Co.", label: "\"Re: Invoice INV-1042\" from Priya Nair at Harbor Coffee Co." },
  m2: { id: "message:m-2", kind: "message", panel: "inbox", client: "Meridian Hotels", label: "\"Signage install date\" from Hannah Brooks at Meridian Hotels" },
  m3: { id: "message:m-3", kind: "message", panel: "inbox", client: "Atlas Robotics", label: "\"Product photos\" from Mei Tanaka at Atlas Robotics" },
  m4: { id: "message:m-4", kind: "message", panel: "inbox", label: "\"Out Thursday\" from Jordan Lee" },
  m5: { id: "message:m-5", kind: "message", panel: "inbox", client: "Kite & Co.", label: "\"Discount on packaging?\" from Zoe Laurent at Kite & Co." },
  m6: { id: "message:m-6", kind: "message", panel: "inbox", client: "Pinecrest Clinic", label: "\"Homepage feedback\" from Dr. Owen Hale at Pinecrest Clinic" },
  m7: { id: "message:m-7", kind: "message", panel: "inbox", client: "Juniper Books", label: "\"Spring cover brief\" from Luis Ortega at Juniper Books" },
  m8: { id: "message:m-8", kind: "message", panel: "inbox", client: "Solace Yoga", label: "\"Onboarding screens\" from Ava Kim at Solace Yoga" },
  e2: { id: "event:e-2", kind: "event", panel: "calendar", client: "Harbor Coffee Co.", label: "Harbor rebrand review, 11:00 today" },
  e3: { id: "event:e-3", kind: "event", panel: "calendar", client: "Vantage Legal", label: "Focus: Vantage report layout, 13:00 today" },
  e4: { id: "event:e-4", kind: "event", panel: "calendar", client: "Meridian Hotels", label: "Call with Meridian about install, 15:30 today" },
  e5: { id: "event:e-5", kind: "event", panel: "calendar", client: "Solace Yoga", label: "Solace onboarding critique, 10:00 tomorrow" },
  t1: { id: "task:t-1", kind: "task", panel: "tasks", client: "Harbor Coffee Co.", label: "Resend INV-1042 to Harbor accounts team (due today)" },
  t3: { id: "task:t-3", kind: "task", panel: "tasks", client: "Atlas Robotics", label: "Decide on renders vs photos for Atlas deck (due tomorrow)" },
  t4: { id: "task:t-4", kind: "task", panel: "tasks", client: "Pinecrest Clinic", label: "Pinecrest homepage copy changes (Jordan Lee, due tomorrow)" },
  t5: { id: "task:t-5", kind: "task", panel: "tasks", client: "Solace Yoga", label: "Third welcome screen option for Solace (Noor Patel, due in 3 days)" },
  t6: { id: "task:t-6", kind: "task", panel: "tasks", client: "Kite & Co.", label: "Reply to Kite about discount (due today)" },
  t9: { id: "task:t-9", kind: "task", panel: "tasks", client: "Meridian Hotels", label: "Book printer for Meridian run (Riley Chen, due in 5 days)" },
  t10: { id: "task:t-10", kind: "task", panel: "tasks", label: "Update studio portfolio (Alex Moreau, due in 10 days)" },
  pHarbor: { id: "project:p-harbor", kind: "project", panel: "projects", client: "Harbor Coffee Co.", label: "Harbor rebrand for Harbor Coffee Co. (on track, 70% done)" },
  pMeridian: { id: "project:p-meridian", kind: "project", panel: "projects", client: "Meridian Hotels", label: "Lobby signage for Meridian Hotels (at risk, 55% done)" },
  pAtlas: { id: "project:p-atlas", kind: "project", panel: "projects", client: "Atlas Robotics", label: "Pitch deck for Atlas Robotics (blocked, 30% done)" },
  pVantage: { id: "project:p-vantage", kind: "project", panel: "projects", client: "Vantage Legal", label: "Annual report for Vantage Legal (on track, 20% done)" },
  pKite: { id: "project:p-kite", kind: "project", panel: "projects", client: "Kite & Co.", label: "Packaging system for Kite & Co. (at risk, 60% done)" },
  cHarbor: { id: "client:c-harbor", kind: "client", panel: "clients", client: "Harbor Coffee Co.", label: "Harbor Coffee Co. (health: watch)" },
  cAtlas: { id: "client:c-atlas", kind: "client", panel: "clients", client: "Atlas Robotics", label: "Atlas Robotics (health: at risk)" },
  cKite: { id: "client:c-kite", kind: "client", panel: "clients", client: "Kite & Co.", label: "Kite & Co. (health: watch)" },
  cPinecrest: { id: "client:c-pinecrest", kind: "client", panel: "clients", client: "Pinecrest Clinic", label: "Pinecrest Clinic (health: good)" },
  cSolace: { id: "client:c-solace", kind: "client", panel: "clients", client: "Solace Yoga", label: "Solace Yoga (health: good)" },
  cVantage: { id: "client:c-vantage", kind: "client", panel: "clients", client: "Vantage Legal", label: "Vantage Legal (health: good)" },
  uRiley: { id: "person:u-riley", kind: "person", panel: "team", label: "Riley Chen (production designer, available, working on Lobby signage)" },
  uJordan: { id: "person:u-jordan", kind: "person", panel: "team", label: "Jordan Lee (web designer, available, working on Website refresh)" },
  uNoor: { id: "person:u-noor", kind: "person", panel: "team", label: "Noor Patel (product designer, busy, working on App onboarding)" },
  uAlex: { id: "person:u-alex", kind: "person", panel: "team", label: "Alex Moreau (designer, away, working on Annual report)" },
} satisfies Record<string, RecordCandidate>;

/** A candidate with the code hint the client would attach in this context. */
function rec(record: RecordCandidate, why?: string): RecordCandidate {
  return why ? { ...record, why } : { ...record };
}

/**
 * Next-task candidates (focus aid 2), in the words buildNextTasks in
 * src/engine/taskDone.ts writes for the fixture data. A session lists the
 * ones for goals other than its working goal, in code's priority order.
 */
const TASK = {
  unread: { id: "unread_messages", goal: "triage_inbox", label: "Unread client messages to reply to", count: "four", first: "\"Re: Invoice INV-1042\" from Priya Nair at Harbor Coffee Co." },
  overdue: { id: "overdue_invoices", goal: "collect_payments", label: "Overdue invoices that still need a payment reminder", count: "three", first: "INV-1038 · Meridian Hotels · overdue 36 days · $12,800" },
  dueToday: { id: "tasks_due_today", goal: "plan_day", label: "To-do items due today", count: "two", first: "Resend INV-1042 to Harbor accounts team (due today)" },
  projects: { id: "projects_at_risk", goal: "track_projects", label: "Projects at risk or blocked", count: "three", first: "Pitch deck for Atlas Robotics, blocked, 30% done" },
  meetingLater: { id: "next_meeting", goal: "plan_day", label: "Next meeting today, starting later today at 15:30", count: "one", first: "Call with Meridian about install, 15:30 today" },
} satisfies Record<string, TaskCandidate>;

export const SCENARIOS: Scenario[] = [
  {
    id: "collections",
    name: "Chasing overdue invoices",
    description: "Opens invoices, filters to overdue, looks at two late bills, then searches the inbox for the client.",
    finalFocus: "inbox",
    workingGoal: "collect_payments",
    steps: [
      { type: "panel_focus", panel: "invoices", detail: { via: "pointer" } },
      { type: "filter", panel: "invoices", detail: { filter: { status: "overdue" }, via: "pointer" }, delayMs: 900 },
      { type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co.", label: "INV-1042 · Harbor Coffee Co. · overdue 14 days · $4,200" }, delayMs: 1100 },
      { type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1038", client: "Meridian Hotels", label: "INV-1038 · Meridian Hotels · overdue 36 days · $12,800" }, delayMs: 1200 },
      { type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co.", label: "INV-1042 · Harbor Coffee Co. · overdue 14 days · $4,200" }, delayMs: 1000 },
      { type: "search", panel: "inbox", detail: { query: "harbor invoice" }, delayMs: 1300 },
    ],
    candidates: [
      rec(REC.inv1047, "next overdue invoice in the list"),
      rec(REC.m1, "unread, flagged"),
      rec(REC.t1, "due today"),
      rec(REC.inv1038, "overdue, opened earlier"),
      rec(REC.cHarbor, "client of the invoice you opened"),
      rec(REC.m2, "unread"),
      rec(REC.inv1049, "sent, not due yet"),
      rec(REC.e2, "next meeting today"),
      rec(REC.pAtlas, "blocked"),
      rec(REC.uAlex),
    ],
    expect: {
      goal: ["collect_payments"],
      topPanels: ["invoices"],
      notTopPanels: ["notes", "team"],
      nextAction: ["send_payment_reminder", "reply_to_message"],
      targetClient: ["Harbor Coffee Co."],
      struggling: false,
      // The message the inbox search is looking for, or the next overdue bill.
      nextRecord: ["message:m-1", "invoice:INV-1047"],
      // Two bills looked at and nothing reminded yet: still collecting.
      goalDone: false,
    },
  },
  {
    id: "morning",
    name: "Planning the morning",
    description: "Checks today's calendar, then the task list, then back to the calendar.",
    finalFocus: "calendar",
    workingGoal: "plan_day",
    steps: [
      { type: "panel_focus", panel: "calendar", detail: { via: "pointer" } },
      { type: "item_open", panel: "calendar", detail: { itemKind: "event", itemId: "e-2", client: "Harbor Coffee Co.", label: "Harbor rebrand review, 11:00 today" }, delayMs: 1000 },
      { type: "panel_focus", panel: "tasks", detail: { via: "pointer" }, delayMs: 1200 },
      { type: "filter", panel: "tasks", detail: { filter: { due: "today" } }, delayMs: 900 },
      { type: "item_open", panel: "tasks", detail: { itemKind: "task", itemId: "t-6", client: "Kite & Co.", label: "Reply to Kite about discount (due today)" }, delayMs: 1000 },
      { type: "panel_dwell", panel: "calendar", detail: { durationMs: 4200 }, delayMs: 1100 },
    ],
    candidates: [
      rec(REC.e3, "next event today"),
      rec(REC.e4, "later today"),
      rec(REC.t1, "the other task due today"),
      rec(REC.m5, "unread, about the task you opened"),
      rec(REC.pHarbor, "project of the meeting you opened"),
      rec(REC.e5, "tomorrow"),
      rec(REC.inv1038, "most overdue invoice"),
      rec(REC.t10),
      rec(REC.uAlex),
      rec(REC.cVantage),
    ],
    expect: {
      goal: ["plan_day"],
      topPanels: ["calendar", "tasks"],
      notTopPanels: ["analytics"],
      struggling: false,
      // Another item on today's plan, or the message the opened task is about.
      nextRecord: ["event:e-3", "event:e-4", "task:t-1", "message:m-5"],
      // Still looking the day over.
      goalDone: false,
    },
  },
  {
    id: "client_deep_dive",
    name: "Deep dive on one client",
    description: "Opens Atlas Robotics, its blocked project, and its latest message.",
    finalFocus: "clients",
    workingGoal: "manage_client",
    steps: [
      { type: "item_open", panel: "clients", detail: { itemKind: "client", itemId: "c-atlas", client: "Atlas Robotics", label: "Atlas Robotics (health: at risk)" } },
      { type: "item_open", panel: "projects", detail: { itemKind: "project", itemId: "p-atlas", client: "Atlas Robotics", label: "Pitch deck for Atlas Robotics (blocked, 30% done)" }, delayMs: 1200 },
      { type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-3", client: "Atlas Robotics", label: "\"Product photos\" from Mei Tanaka at Atlas Robotics" }, delayMs: 1300 },
      { type: "panel_focus", panel: "clients", detail: { via: "pointer" }, delayMs: 1000 },
    ],
    expect: {
      goal: ["manage_client", "track_projects"],
      topPanels: ["clients"],
      targetClient: ["Atlas Robotics"],
      struggling: false,
      // Records opened, nothing handled yet.
      goalDone: false,
    },
  },
  {
    id: "lost",
    name: "New user who is lost",
    description: "Repeats searches for 'bills', opens and closes panels quickly, and never finds invoices.",
    finalFocus: null,
    steps: [
      { type: "search", panel: "inbox", detail: { query: "bills" } },
      { type: "search", panel: "inbox", detail: { query: "bill" }, delayMs: 1500 },
      { type: "panel_open", panel: "analytics", detail: { via: "pointer" }, delayMs: 1200 },
      { type: "panel_dismiss", panel: "analytics", detail: { durationMs: 1800 }, delayMs: 1800 },
      { type: "search", panel: "clients", detail: { query: "where are bills" }, delayMs: 1600 },
      { type: "panel_open", panel: "team", detail: { via: "pointer" }, delayMs: 1300 },
      { type: "panel_dismiss", panel: "team", detail: { durationMs: 1500 }, delayMs: 1500 },
      { type: "search", panel: "tasks", detail: { query: "unpaid bills" }, delayMs: 1500 },
    ],
    expect: {
      struggling: true,
      topPanels: ["invoices", "help"],
      expertise: "low",
    },
  },
  {
    id: "projects",
    name: "Checking projects at risk",
    description: "Filters projects to at risk, opens the signage project and its task, then checks the team.",
    finalFocus: "team",
    workingGoal: "track_projects",
    steps: [
      { type: "panel_focus", panel: "projects", detail: { via: "pointer" } },
      { type: "filter", panel: "projects", detail: { filter: { status: "at_risk" } }, delayMs: 900 },
      { type: "item_open", panel: "projects", detail: { itemKind: "project", itemId: "p-meridian", client: "Meridian Hotels", label: "Lobby signage for Meridian Hotels (at risk, 55% done)" }, delayMs: 1100 },
      { type: "item_open", panel: "tasks", detail: { itemKind: "task", itemId: "t-2", client: "Meridian Hotels", label: "Revise Meridian signage sizes (Riley Chen, due in 2 days)" }, delayMs: 1200 },
      { type: "panel_focus", panel: "team", detail: { via: "pointer" }, delayMs: 1000 },
    ],
    candidates: [
      rec(REC.uRiley, "assigned to the task you opened"),
      rec(REC.pKite, "next at-risk project in the list"),
      rec(REC.t9, "same project"),
      rec(REC.m2, "unread, same client"),
      rec(REC.e4, "same client, today"),
      rec(REC.uJordan, "available"),
      rec(REC.inv1038, "overdue, same client"),
      rec(REC.m8),
      rec(REC.inv1050),
      rec(REC.cPinecrest),
    ],
    expect: {
      goal: ["track_projects", "coordinate_team"],
      topPanels: ["projects", "team", "tasks"],
      notTopPanels: ["analytics", "notes"],
      // The person the task is assigned to (the user just moved to Team), or the next at-risk project.
      nextRecord: ["person:u-riley", "project:p-kite"],
      // One project of two at risk looked at, none updated.
      goalDone: false,
    },
  },
  {
    id: "power_user",
    name: "Keyboard power user",
    description: "Moves with shortcuts and the command bar, acting fast.",
    finalFocus: "inbox",
    workingGoal: "triage_inbox",
    steps: [
      { type: "shortcut", detail: { key: "mod+k" } },
      { type: "command", detail: { query: "unread from clients", via: "keyboard" }, delayMs: 500 },
      { type: "shortcut", panel: "inbox", detail: { key: "j" }, delayMs: 300 },
      { type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-2", client: "Meridian Hotels", label: "\"Signage install date\" from Hannah Brooks at Meridian Hotels", via: "keyboard" }, delayMs: 400 },
      { type: "action", panel: "inbox", detail: { actionId: "reply_to_message", client: "Meridian Hotels", via: "keyboard" }, delayMs: 600 },
      { type: "shortcut", panel: "inbox", detail: { key: "j" }, delayMs: 300 },
      { type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-5", client: "Kite & Co.", label: "\"Discount on packaging?\" from Zoe Laurent at Kite & Co.", via: "keyboard" }, delayMs: 400 },
    ],
    candidates: [
      rec(REC.m1, "unread, flagged"),
      rec(REC.m3, "unread, flagged"),
      rec(REC.m6, "next message in the list, already read"),
      rec(REC.m4, "already read"),
      rec(REC.t6, "task about the message you opened"),
      rec(REC.inv1047, "same client as the message you opened"),
      rec(REC.cKite, "sender's company"),
      rec(REC.pKite, "same client as the message you opened"),
      rec(REC.e4, "about the message you replied to"),
      rec(REC.uRiley),
    ],
    expect: {
      goal: ["triage_inbox"],
      topPanels: ["inbox"],
      expertise: "high",
      struggling: false,
      // Another unread message from a client.
      nextRecord: ["message:m-1", "message:m-3"],
      listWork: true,
      // The newest step opened the next message.
      goalDone: false,
    },
  },
  {
    id: "compare",
    name: "Back and forth",
    description: "Alternates between an invoice and the client record several times.",
    finalFocus: "clients",
    steps: [
      { type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1038", client: "Meridian Hotels", label: "INV-1038 · Meridian Hotels · overdue 36 days · $12,800" } },
      { type: "item_open", panel: "clients", detail: { itemKind: "client", itemId: "c-meridian", client: "Meridian Hotels", label: "Meridian Hotels (health: watch)" }, delayMs: 900 },
      { type: "panel_focus", panel: "invoices", detail: { via: "pointer" }, delayMs: 800 },
      { type: "panel_focus", panel: "clients", detail: { via: "pointer" }, delayMs: 800 },
      { type: "panel_focus", panel: "invoices", detail: { via: "pointer" }, delayMs: 800 },
      { type: "panel_focus", panel: "clients", detail: { via: "pointer" }, delayMs: 800 },
    ],
    candidates: [
      rec(REC.inv1038, "overdue, same client"),
      rec(REC.m2, "unread, same client"),
      rec(REC.pMeridian, "same client"),
      rec(REC.inv1042, "next overdue invoice in the list"),
      rec(REC.cSolace, "next client in the list"),
      rec(REC.m1, "unread, flagged"),
      rec(REC.t6, "due today"),
      rec(REC.e3, "next event today"),
      rec(REC.uNoor),
    ],
    expect: {
      layout: ["compare"],
      topPanels: ["invoices", "clients"],
      targetClient: ["Meridian Hotels"],
      struggling: false,
      // Back to the invoice being compared, or another record about the same client.
      nextRecord: ["invoice:INV-1038", "message:m-2", "project:p-meridian"],
      listWork: false,
    },
  },
  {
    id: "stuck_reopen",
    name: "Stuck on one bill",
    description: "Opens the same overdue bill again and again between searches for how to remind the client.",
    finalFocus: "invoices",
    workingGoal: "collect_payments",
    steps: [
      { type: "panel_focus", panel: "invoices", detail: { via: "pointer" } },
      { type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1047", client: "Kite & Co.", label: "INV-1047 · Kite & Co. · overdue 5 days · $2,650" }, delayMs: 1200 },
      { type: "search", panel: "inbox", detail: { query: "send reminder" }, delayMs: 2500 },
      { type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1047", client: "Kite & Co.", label: "INV-1047 · Kite & Co. · overdue 5 days · $2,650" }, delayMs: 2000 },
      { type: "search", panel: "clients", detail: { query: "how to remind client" }, delayMs: 2500 },
      { type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1047", client: "Kite & Co.", label: "INV-1047 · Kite & Co. · overdue 5 days · $2,650" }, delayMs: 2000 },
    ],
    candidates: [
      rec(REC.inv1042, "next overdue invoice in the list"),
      rec(REC.m5, "unread, same client"),
      rec(REC.cKite, "client of the invoice you opened"),
      rec(REC.t6, "due today, same client"),
      rec(REC.pKite, "same client"),
      rec(REC.inv1038, "overdue"),
      rec(REC.e2, "next meeting today"),
      rec(REC.uRiley),
    ],
    expect: {
      struggling: true,
      topPanels: ["invoices", "help"],
      listWork: false,
      // Stuck on the first bill is not finished.
      goalDone: false,
    },
  },
  {
    id: "stuck_undo",
    name: "Asks how, then undoes",
    description: "Opens a bill, searches how to send a reminder, reopens the bill, and undoes a layout change.",
    finalFocus: "invoices",
    steps: [
      { type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1038", client: "Meridian Hotels", label: "INV-1038 · Meridian Hotels · overdue 36 days · $12,800" } },
      { type: "search", panel: "clients", detail: { query: "how do I send a reminder" }, delayMs: 2500 },
      { type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1038", client: "Meridian Hotels", label: "INV-1038 · Meridian Hotels · overdue 36 days · $12,800" }, delayMs: 2000 },
      { type: "undo", delayMs: 1500 },
    ],
    expect: {
      struggling: true,
    },
  },
  // Held out for the next-record and list-work questions: not used to tune their wording.
  {
    id: "reply_queue",
    name: "Replying to clients one by one",
    description: "Opens a client message, replies, and moves on to the next one, three times in a row.",
    finalFocus: "inbox",
    // No goal-done expectation: whether any unread message is left is not in what Jev reads.
    workingGoal: "triage_inbox",
    steps: [
      { type: "panel_focus", panel: "inbox", detail: { via: "pointer" } },
      { type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-1", client: "Harbor Coffee Co.", label: "\"Re: Invoice INV-1042\" from Priya Nair at Harbor Coffee Co." }, delayMs: 900 },
      { type: "action", panel: "inbox", detail: { actionId: "reply_to_message", client: "Harbor Coffee Co.", itemId: "m-1", via: "pointer" }, delayMs: 2500 },
      { type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-2", client: "Meridian Hotels", label: "\"Signage install date\" from Hannah Brooks at Meridian Hotels" }, delayMs: 1000 },
      { type: "action", panel: "inbox", detail: { actionId: "reply_to_message", client: "Meridian Hotels", itemId: "m-2", via: "pointer" }, delayMs: 2500 },
      { type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-3", client: "Atlas Robotics", label: "\"Product photos\" from Mei Tanaka at Atlas Robotics" }, delayMs: 1000 },
      { type: "action", panel: "inbox", detail: { actionId: "reply_to_message", client: "Atlas Robotics", itemId: "m-3", via: "pointer" }, delayMs: 2500 },
    ],
    candidates: [
      rec(REC.m5, "unread"),
      rec(REC.m4, "next message in the list, already read"),
      rec(REC.m6, "already read"),
      rec(REC.t6, "due today"),
      rec(REC.pAtlas, "same client as the message you replied to"),
      rec(REC.cAtlas, "sender's company"),
      rec(REC.inv1042, "overdue, linked to a message you replied to"),
      rec(REC.e2, "next meeting today"),
      rec(REC.t3, "same client as the message you replied to"),
      rec(REC.uNoor),
    ],
    expect: {
      goal: ["triage_inbox"],
      topPanels: ["inbox"],
      struggling: false,
      nextRecord: ["message:m-5"],
      listWork: true,
    },
  },
  {
    id: "task_checkoff",
    name: "Checking off today's tasks",
    description: "Filters tasks to today, then opens each one and checks it off in turn.",
    finalFocus: "tasks",
    steps: [
      { type: "panel_focus", panel: "tasks", detail: { via: "pointer" } },
      { type: "filter", panel: "tasks", detail: { filter: { due: "today" } }, delayMs: 800 },
      { type: "item_open", panel: "tasks", detail: { itemKind: "task", itemId: "t-1", client: "Harbor Coffee Co.", label: "Resend INV-1042 to Harbor accounts team (due today)" }, delayMs: 1000 },
      { type: "action", panel: "tasks", detail: { label: "Checked off task: Resend INV-1042 to Harbor accounts team", itemKind: "task", itemId: "t-1", client: "Harbor Coffee Co.", via: "pointer" }, delayMs: 2000 },
      { type: "item_open", panel: "tasks", detail: { itemKind: "task", itemId: "t-6", client: "Kite & Co.", label: "Reply to Kite about discount (due today)" }, delayMs: 1000 },
      { type: "action", panel: "tasks", detail: { label: "Checked off task: Reply to Kite about discount", itemKind: "task", itemId: "t-6", client: "Kite & Co.", via: "pointer" }, delayMs: 2000 },
    ],
    candidates: [
      rec(REC.t3, "next open task in the list"),
      rec(REC.t4, "due tomorrow"),
      rec(REC.t10),
      rec(REC.m5, "unread, about a task you checked off"),
      rec(REC.m1, "unread, about a task you checked off"),
      rec(REC.inv1042, "linked to a task you checked off"),
      rec(REC.e2, "next meeting today"),
      rec(REC.pKite, "project of a task you checked off"),
      rec(REC.cKite),
      rec(REC.uJordan),
    ],
    expect: {
      topPanels: ["tasks"],
      struggling: false,
      // Today's list is done, so the next open tasks (due tomorrow).
      nextRecord: ["task:t-3", "task:t-4"],
      listWork: true,
    },
  },
  {
    id: "scattered",
    name: "Jumping between unrelated things",
    description: "Opens one record in each of five panels, each about a different client or person.",
    finalFocus: "inbox",
    steps: [
      { type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1049", client: "Pinecrest Clinic", label: "INV-1049 · Pinecrest Clinic · due in 20 days · $5,400" } },
      { type: "item_open", panel: "calendar", detail: { itemKind: "event", itemId: "e-6", client: "Juniper Books", label: "Juniper spring brief call, 14:00 in 3 days" }, delayMs: 1500 },
      { type: "item_open", panel: "team", detail: { itemKind: "person", itemId: "u-alex", label: "Alex Moreau (designer, away, working on Annual report)" }, delayMs: 1500 },
      { type: "item_open", panel: "projects", detail: { itemKind: "project", itemId: "p-solace", client: "Solace Yoga", label: "App onboarding for Solace Yoga (on track, 40% done)" }, delayMs: 1500 },
      { type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-10", label: "\"Printer quote\" from Riley Chen" }, delayMs: 1500 },
    ],
    candidates: [
      rec(REC.inv1050, "next invoice in the list"),
      rec(REC.m7, "same client as the event you opened"),
      rec(REC.t9, "about the message you opened"),
      rec(REC.pVantage, "project of the team member you opened"),
      rec(REC.e3, "next event today"),
      rec(REC.uRiley, "sender of the message you opened"),
      rec(REC.cSolace, "client of the project you opened"),
      rec(REC.t5, "same project"),
    ],
    // No next-record expectation: nothing here is predictable, and "none" or a low-confidence pick are both fine.
    expect: {
      listWork: false,
    },
  },
  // Held out for the goal-done and next-task questions (focus aid 2): not used to tune their wording.
  {
    id: "collections_done",
    name: "Every overdue invoice reminded",
    description: "Filters invoices to overdue, sends a reminder on each of the three, then clicks into the inbox.",
    finalFocus: "inbox",
    workingGoal: "collect_payments",
    steps: [
      { type: "panel_focus", panel: "invoices", detail: { via: "pointer" } },
      { type: "filter", panel: "invoices", detail: { filter: { status: "overdue" }, via: "pointer" }, delayMs: 800 },
      { type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1038", client: "Meridian Hotels", label: "INV-1038 · Meridian Hotels · overdue 36 days · $12,800" }, delayMs: 1000 },
      { type: "action", panel: "invoices", detail: { actionId: "send_payment_reminder", client: "Meridian Hotels", itemId: "INV-1038", via: "pointer" }, delayMs: 2500 },
      { type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co.", label: "INV-1042 · Harbor Coffee Co. · overdue 14 days · $4,200" }, delayMs: 1000 },
      { type: "action", panel: "invoices", detail: { actionId: "send_payment_reminder", client: "Harbor Coffee Co.", itemId: "INV-1042", via: "pointer" }, delayMs: 2500 },
      { type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1047", client: "Kite & Co.", label: "INV-1047 · Kite & Co. · overdue 5 days · $2,650" }, delayMs: 1000 },
      { type: "action", panel: "invoices", detail: { actionId: "send_payment_reminder", client: "Kite & Co.", itemId: "INV-1047", via: "pointer" }, delayMs: 2500 },
      { type: "panel_focus", panel: "inbox", detail: { via: "pointer" }, delayMs: 1500 },
    ],
    // The code fact is true (no overdue invoice without a reminder), so the app sends the pending work of the other goals.
    tasks: [TASK.unread, TASK.dueToday, TASK.projects, TASK.meetingLater],
    expect: {
      goalDone: true,
      // The client message about an invoice, or today's to-do items (one is about an invoice).
      nextTask: ["unread_messages", "tasks_due_today"],
    },
  },
  {
    id: "inbox_midway",
    name: "Replying to the inbox, midway",
    description: "Replies to two client messages, then opens the third.",
    finalFocus: "inbox",
    workingGoal: "triage_inbox",
    steps: [
      { type: "panel_focus", panel: "inbox", detail: { via: "pointer" } },
      { type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-1", client: "Harbor Coffee Co.", label: "\"Re: Invoice INV-1042\" from Priya Nair at Harbor Coffee Co." }, delayMs: 900 },
      { type: "action", panel: "inbox", detail: { actionId: "reply_to_message", client: "Harbor Coffee Co.", itemId: "m-1", via: "pointer" }, delayMs: 2500 },
      { type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-2", client: "Meridian Hotels", label: "\"Signage install date\" from Hannah Brooks at Meridian Hotels" }, delayMs: 1000 },
      { type: "action", panel: "inbox", detail: { actionId: "reply_to_message", client: "Meridian Hotels", itemId: "m-2", via: "pointer" }, delayMs: 2500 },
      { type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-3", client: "Atlas Robotics", label: "\"Product photos\" from Mei Tanaka at Atlas Robotics" }, delayMs: 1000 },
    ],
    // Unread messages are left, so the code fact is false and the app sends no task candidates.
    expect: {
      goalDone: false,
    },
  },
  {
    id: "projects_done",
    name: "Every project at risk updated",
    description: "Filters projects to at risk and then blocked, updates each of the three to on track, then clicks into Tasks.",
    finalFocus: "tasks",
    workingGoal: "track_projects",
    steps: [
      { type: "panel_focus", panel: "projects", detail: { via: "pointer" } },
      { type: "filter", panel: "projects", detail: { filter: { status: "at_risk" }, via: "pointer" }, delayMs: 800 },
      { type: "item_open", panel: "projects", detail: { itemKind: "project", itemId: "p-meridian", client: "Meridian Hotels", label: "Lobby signage for Meridian Hotels (at risk, 55% done)" }, delayMs: 1000 },
      { type: "action", panel: "projects", detail: { actionId: "update_project_status", client: "Meridian Hotels", itemId: "p-meridian", via: "pointer" }, delayMs: 2500 },
      { type: "item_open", panel: "projects", detail: { itemKind: "project", itemId: "p-kite", client: "Kite & Co.", label: "Packaging system for Kite & Co. (at risk, 60% done)" }, delayMs: 1000 },
      { type: "action", panel: "projects", detail: { actionId: "update_project_status", client: "Kite & Co.", itemId: "p-kite", via: "pointer" }, delayMs: 2500 },
      { type: "filter", panel: "projects", detail: { filter: { status: "blocked" }, via: "pointer" }, delayMs: 1200 },
      { type: "item_open", panel: "projects", detail: { itemKind: "project", itemId: "p-atlas", client: "Atlas Robotics", label: "Pitch deck for Atlas Robotics (blocked, 30% done)" }, delayMs: 1000 },
      { type: "action", panel: "projects", detail: { actionId: "update_project_status", client: "Atlas Robotics", itemId: "p-atlas", via: "pointer" }, delayMs: 2500 },
      { type: "panel_focus", panel: "tasks", detail: { via: "pointer" }, delayMs: 1500 },
    ],
    // The code fact is true (no project at risk or blocked), so the app sends the pending work of the other goals.
    tasks: [TASK.unread, TASK.overdue, TASK.dueToday, TASK.meetingLater],
    // No next-task expectation: several are sensible after a project review; the pick is printed.
    expect: {
      goalDone: true,
    },
  },
  // The link questions ("Arrange linked panels by next step"). The user's own case first.
  {
    id: "link_resend",
    name: "An email asks to resend an invoice",
    description: "Opens Priya Nair's \"Re: Invoice INV-1042\", which asks to resend the invoice to the accounts team because the old email bounced.",
    finalFocus: "inbox",
    steps: [
      { type: "panel_focus", panel: "inbox", detail: { via: "pointer" } },
      { type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-1", client: "Harbor Coffee Co.", label: "\"Re: Invoice INV-1042\" from Priya Nair at Harbor Coffee Co.", via: "pointer" }, delayMs: 900 },
    ],
    link: { kind: "message", id: "m-1", client: "Harbor Coffee Co." },
    expect: {
      // The invoice to resend, or the to-do item that says to resend it.
      linkNext: ["invoice:INV-1042", "task:t-1"],
      linkAction: ["resend_invoice"],
    },
  },
  {
    id: "link_meeting",
    name: "An email asks for a call",
    description: "Opens Luis Ortega's \"Spring cover brief\", which says a call next week would help.",
    finalFocus: "inbox",
    steps: [
      { type: "panel_focus", panel: "inbox", detail: { via: "pointer" } },
      { type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-7", client: "Juniper Books", label: "\"Spring cover brief\" from Luis Ortega at Juniper Books", via: "pointer" }, delayMs: 900 },
    ],
    link: { kind: "message", id: "m-7", client: "Juniper Books" },
    // No link-next expectation: the client's record and its bill are both sensible places to start; the pick is printed.
    expect: {
      linkAction: ["schedule_meeting"],
    },
  },
  {
    id: "link_thanks",
    name: "An email only says thanks",
    description: "Opens a message from Ava Kim that thanks the studio for the onboarding screens and asks for nothing.",
    finalFocus: "inbox",
    steps: [
      { type: "panel_focus", panel: "inbox", detail: { via: "pointer" } },
      { type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-11", client: "Solace Yoga", label: "\"Thank you!\" from Ava Kim at Solace Yoga", via: "pointer" }, delayMs: 900 },
    ],
    // Not in the fixtures, so its words and linked records are written out here, in the app's wording.
    link: {
      kind: "message",
      id: "m-11",
      client: "Solace Yoga",
      words: {
        id: "message:m-11",
        kind: "message",
        fields: { from: "Ava Kim", client: "Solace Yoga", subject: "Thank you!", text: "Just wanted to say thanks for the new onboarding screens. The whole team loves them." },
      },
      records: [
        rec(REC.t5, "same client: Solace Yoga"),
        { id: "invoice:INV-1051", kind: "invoice", panel: "invoices", client: "Solace Yoga", label: "INV-1051 · Solace Yoga · due in 29 days · $3,100", why: "same client: Solace Yoga" },
        { id: "client:c-solace", kind: "client", panel: "clients", client: "Solace Yoga", label: "Solace Yoga, contact Ava Kim, health good", why: "the client of the clicked message" },
        { id: "project:p-solace", kind: "project", panel: "projects", client: "Solace Yoga", label: "App onboarding for Solace Yoga, on track, 40% done", why: "same client: Solace Yoga" },
      ],
    },
    expect: {
      linkAction: ["none"],
    },
  },
  {
    id: "link_invoice",
    name: "An overdue invoice with a reply from the client",
    description: "Opens INV-1042; the client's message about it is linked, and so is the to-do item copied from that message.",
    finalFocus: "invoices",
    steps: [
      { type: "panel_focus", panel: "invoices", detail: { via: "pointer" } },
      { type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co.", label: "INV-1042 · Harbor Coffee Co. · overdue 14 days · $4,200", via: "pointer" }, delayMs: 900 },
    ],
    link: { kind: "invoice", id: "INV-1042", client: "Harbor Coffee Co." },
    expect: {
      // The client's message about the invoice says what it needs.
      linkNext: ["message:m-1"],
    },
  },
  // Held out for the link questions: not used to tune their wording.
  {
    id: "link_discount",
    name: "An email asks about the price",
    description: "Opens Zoe Laurent's \"Discount on packaging?\", which asks whether the price of the second round is flexible.",
    finalFocus: "inbox",
    steps: [
      { type: "panel_focus", panel: "inbox", detail: { via: "pointer" } },
      { type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-5", client: "Kite & Co.", label: "\"Discount on packaging?\" from Zoe Laurent at Kite & Co.", via: "pointer" }, delayMs: 900 },
    ],
    link: { kind: "message", id: "m-5", client: "Kite & Co." },
    expect: {
      linkAction: ["reply_to_message"],
      // The to-do item about the reply, the project the price is for, or its bill; not the client row, and not none.
      linkNext: ["task:t-6", "project:p-kite", "invoice:INV-1047"],
    },
  },
];

/** Command bar checks: text -> expected command judgments. */
export interface CommandCase {
  text: string;
  /** A scenario id whose steps happen first, so the command is judged in a busy session. */
  after?: string;
  expect: {
    panel?: PanelId[];
    action?: ActionId[];
    invoiceStatus?: string[];
    client?: string[];
    timeframe?: string[];
  };
}

export const COMMAND_CASES: CommandCase[] = [
  { text: "who still owes us money?", expect: { panel: ["invoices"], invoiceStatus: ["overdue", "unpaid"] } },
  { text: "show me harbor's invoices", expect: { panel: ["invoices"], client: ["Harbor Coffee Co."], invoiceStatus: ["all", "not_mentioned"] } },
  { text: "what's on today", expect: { panel: ["calendar"], timeframe: ["today"] } },
  { text: "remind meridian to pay", expect: { panel: ["invoices"], action: ["send_payment_reminder"], client: ["Meridian Hotels"] } },
  { text: "are we making more money than last month", expect: { panel: ["analytics"] } },
  { text: "who is free to help this afternoon", expect: { panel: ["team"] } },
  { text: "jot down: ask Luis about spring cover fonts", expect: { panel: ["notes"], action: ["write_note", "create_task"] } },
  { text: "atlas", expect: { panel: ["clients"], client: ["Atlas Robotics"] } },
  { text: "remind meridian to pay", after: "projects", expect: { panel: ["invoices"], action: ["send_payment_reminder"], client: ["Meridian Hotels"] } },
];

/**
 * Meeting prep checks (focus aid 4, POST /api/prep): a fixture meeting as if
 * it started soon, with the client's records the app's own code picks
 * (buildPrepRecords), plus any `extra` records it would not pick, in its
 * own words. Scores are shares of Jev's three-level scale.
 */
export interface PrepCase {
  id: string;
  name: string;
  /** The meeting, an event id in shared/fixtures.ts. */
  eventId: string;
  /** The meeting starts this many minutes after the request. */
  startsInMin: number;
  /** Records the app would not pick ("message:m-10"), added to test that Jev scores them low. */
  extra?: string[];
  expect: {
    /** Each of these records is among the `within` best scored. */
    top?: { ids: string[]; within: number };
    /** Each of these scores at least the app's tint line (PREP_TINT_AT): the app tints it. */
    high?: string[];
    /** Each of these scores clearly under the tint line. */
    low?: string[];
    /** This record scores lowest of all. */
    last?: string;
    /** Anything urgent: true at or above the app's urgent line (PREP_URGENT_AT), false clearly under it. */
    urgent?: boolean;
  };
}

export const PREP_CASES: PrepCase[] = [
  {
    // The user's case: Priya asks to resend INV-1042, 14 days overdue, before the rebrand review. Riley's printer quote is about another client.
    id: "prep-harbor",
    name: "Harbor rebrand review with an overdue invoice",
    eventId: "e-2",
    startsInMin: 12,
    extra: ["message:m-10"],
    expect: { top: { ids: ["message:m-1", "invoice:INV-1042"], within: 3 }, high: ["project:p-harbor"], low: ["message:m-10"], urgent: true },
  },
  {
    // Ava asked for one more welcome screen option; the matching task is open. The sent invoice is not due for a month.
    id: "prep-solace",
    name: "Solace onboarding critique",
    eventId: "e-5",
    startsInMin: 10,
    expect: { top: { ids: ["message:m-8", "task:t-5"], within: 3 }, high: ["project:p-solace"], last: "invoice:INV-1051" },
  },
  {
    // Nothing is due: Luis says there is no rush, and the invoice is sent, not due for weeks.
    id: "prep-juniper",
    name: "Juniper spring brief call with nothing urgent",
    eventId: "e-6",
    startsInMin: 15,
    expect: { top: { ids: ["message:m-7"], within: 1 }, urgent: false },
  },
  {
    // Held out: the install date moved (an unread question), the signage project is at risk, and the bill is long overdue.
    id: "prep-meridian",
    name: "Call with Meridian about the install",
    eventId: "e-4",
    startsInMin: 8,
    expect: { top: { ids: ["message:m-2"], within: 2 }, high: ["project:p-meridian", "task:t-2"], urgent: true },
  },
];
