/**
 * The Jev request: one small, words-only state and every question the
 * client policy might need, all sent together so they run in parallel.
 *
 * Pure (no I/O) so tests and the eval script can inspect exactly what is
 * sent. Design notes, from the TypeSafe docs (state, primitives, fan-out,
 * jev-1.13 jaggedness):
 *   - Question ids are never sent to the model, so every instruction carries
 *     its full meaning and points at state fields by backticked name.
 *   - The newest activity gets its own field instead of being "the last item
 *     of a list": Jev reads literally and positional indirection costs accuracy.
 *     Splitting (rather than copying) it avoids showing one search twice,
 *     which would look like a repeated search to the struggling question.
 *   - Per-panel relevance is one Score per panel with identical wording and
 *     levels, so the scores are comparable and code can rank them.
 *   - Every Choice has an explicit no-match option, and values such as client
 *     names are selected from candidates, never generated.
 *   - Command questions are speculative fan-out: they ride along in the same
 *     request and the client ignores the ones that do not apply.
 *   - Next-record questions ride along the same way when the client sends
 *     record candidates. The candidates live in the Choice criteria, never in
 *     the state, so the state stays the same for every other question.
 *   - The goal-done Noul and the next-task Choice (focus aid 2) follow the
 *     same rule: the working goal rides in the Noul's instructions and the
 *     task candidates in the Choice's criteria, never in the state.
 *   - So do the link questions ("Arrange linked panels by next step"): the
 *     clicked record rides in their instructions as structured data
 *     (`clicked_record`) and the linked records in the link-next criteria.
 */
import { choice, noul, score } from "@typesafe-ai/sdk";
import type { EntryType, JsonValue, NoulQuestion, Question } from "@typesafe-ai/sdk";
import {
  ACTION_IDS,
  ACTIONS,
  GOAL_IDS,
  GOALS,
  LAYOUT_MODE_DEFS,
  LAYOUT_MODES,
  PANEL_IDS,
  PANELS,
  type GoalId,
  type PanelId,
} from "../shared/catalog.ts";
import { CLIENTS } from "../shared/fixtures.ts";
import type {
  AdaptRequest,
  ClickedRecord,
  InvoiceStatusArg,
  ItemKind,
  LinkRequest,
  PrepRecord,
  PrepRequest,
  RecordCandidate,
  TaskCandidate,
  TimeframeArg,
  WorkingGoalWords,
} from "../shared/types.ts";

// ---------------------------------------------------------------------------
// Question ids (internal; normalize.ts reads answers by these)
// ---------------------------------------------------------------------------

const REL_PREFIX = "rel_";

export const QUESTION_IDS = {
  goal: "goal",
  struggling: "struggling",
  layout: "layout",
  expertise: "expertise",
  nextAction: "next_action",
  targetClient: "target_client",
  nextRecord: "next_record",
  listWork: "list_work",
  goalDone: "goal_done",
  nextTask: "next_task",
  linkNext: "link_next",
  linkAction: "link_action",
  relevance: (panel: PanelId): string => `${REL_PREFIX}${panel}`,
  command: {
    panel: "cmd_panel",
    action: "cmd_action",
    invoiceStatus: "cmd_invoice_status",
    client: "cmd_client",
    timeframe: "cmd_timeframe",
  },
} as const;

/** The panel a relevance question id belongs to, or null for other ids. */
export function panelFromQuestionId(id: string): PanelId | null {
  if (!id.startsWith(REL_PREFIX)) return null;
  const panel = id.slice(REL_PREFIX.length);
  return (PANEL_IDS as readonly string[]).includes(panel) ? (panel as PanelId) : null;
}

/** No-match option names. Kept distinct so code can tell "no client" from "command names none". */
export const NO_CLIENT = "none";
export const CLIENT_NOT_MENTIONED = "not_mentioned";
export const PANEL_UNCLEAR = "unclear";
/** No-match option of the next-record Choice. Record ids always contain ":", so they never collide with it. */
export const NO_RECORD = "none";
/** No-match option of the next-task Choice. validate.ts and taskCandidates drop a task with this id. */
export const NO_TASK = "none";
/** No-match option of the link-next Choice. Record ids always contain ":", so they never collide with it. */
export const NO_LINK_RECORD = "none";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type JevState = { [key: string]: JsonValue };

const APP_DESCRIPTION =
  "A one-screen workspace for Fernhill Studio, a small design studio. Its panels show the inbox, calendar, tasks, invoices, clients, projects, revenue, team, notes, and a guide.";

const NO_ACTIVITY = "No activity yet. The user has just opened the workspace.";
const NO_ACTIVITY_BEFORE_COMMAND = "No earlier activity. The command is the first thing the user did.";
const NO_FOCUS = "No panel is in focus.";
const NO_OBSERVATIONS = "Nothing notable yet.";

function cleanCommand(req: AdaptRequest): string | null {
  const text = req.command?.trim();
  return text ? text : null;
}

/** The activity line the client logs for typing `command` (describeEvent in src/engine/snapshot.ts). */
function commandLine(command: string): string {
  return `Typed in the command bar: "${command}"`;
}

export function buildState(req: AdaptRequest): JevState {
  const command = cleanCommand(req);
  let activity = req.snapshot.recent_activity;
  // The app logs the command before sending it, so it would also arrive as
  // latest_activity. Said twice, it lowered Jev's action confidence ("remind
  // meridian to pay" 0.96 alone, 0.63 duplicated). `command` and COMMAND_NOTE
  // already say the user just typed it.
  if (command && activity.at(-1)?.startsWith(commandLine(command))) activity = activity.slice(0, -1);
  const observations = req.snapshot.behavior_observations;
  const state: JevState = {
    app: APP_DESCRIPTION,
    earlier_activity: activity.slice(0, -1),
    latest_activity: activity.at(-1) ?? (command ? NO_ACTIVITY_BEFORE_COMMAND : NO_ACTIVITY),
    current_focus: req.snapshot.current_focus ?? NO_FOCUS,
    visible_panels: [...req.snapshot.visible_panels],
    behavior_observations: observations.length > 0 ? [...observations] : [NO_OBSERVATIONS],
  };
  if (command) {
    state.command = command;
    // Lets a bare name such as "atlas" read as a client, for every question.
    state.client_companies = clientCandidates(req);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Shared wording
// ---------------------------------------------------------------------------

// Deliberately neutral about recency. Drafts that said "the newest activity
// matters most" or "when they disagree, go with the newer" let one last click
// (a Team focus, an inbox search for an invoice) outvote the whole task.
const ORDER_NOTE =
  "`earlier_activity` lists older actions, oldest first, and `latest_activity` is the newest. Together they show what the user is working on.";

const COMMAND_NOTE = "The user just typed `command` into the command bar. It says what they want now.";

/** The evidence a "what is the user doing now" question should read. */
function nowEvidence(hasCommand: boolean): JsonValue {
  const fields = ["`latest_activity`", "`current_focus`", "`earlier_activity`"];
  if (hasCommand) fields.unshift("`command`");
  const notes = [ORDER_NOTE];
  if (hasCommand) notes.unshift(COMMAND_NOTE);
  return { read: fields, note: notes.join(" ") };
}

// Relevance is about usefulness for the user's work, not about where the pointer
// was: the client policy already weighs code-measured recent use separately.
// Says "work", never "task": Jev read "the task" as a to-do item the user had
// opened and marked the calendar as not needed for it.
const RELEVANCE_LEVELS = [
  "Not useful: the panel has nothing to do with what the user is working on.",
  "Background only: the panel is loosely related, but the user's current work does not need it.",
  "Supporting: the panel shows information that the user's current work draws on.",
  "Central: the user's current work happens in this panel, or the panel holds the main information that work needs.",
] as const;

// Boundary case from the "lost" scenario: a user who searches Tasks for bills is
// looking for Invoices. (A broader "not by which panel they used last" was read
// literally and pushed the last-used panel down.)
const RELEVANCE_NOTE =
  "A search in a panel that did not find what the user wanted does not make that panel useful.";

// Level 0 is about not finding the way, not about mouse use or speed: "explores
// slowly with the mouse" matched a careful reader's pace line word for word and
// judged a purposeful user as new.
const EXPERTISE_LEVELS = [
  "Still finding their way: searches that find nothing, opening the guide, or trying several places before finding things.",
  "Comfortable: finds what they need and works steadily, mostly with the mouse, with an occasional keyboard shortcut.",
  "Expert: moves with the command bar and keyboard shortcuts and acts quickly.",
] as const;

const INVOICE_STATUS_CRITERIA: Record<InvoiceStatusArg, string> = {
  overdue: "Overdue bills: past their due date and still not paid.",
  unpaid: "Unpaid bills: any bill not yet paid, money still owed, including sent and overdue bills.",
  paid: "Paid bills: bills the client has already paid. Not a request to mark or record a bill as paid; that bill is still unpaid.",
  draft: "Draft bills: bills written but not sent to the client yet.",
  all: "Every invoice: the command is about invoices but does not limit them to one status.",
  not_mentioned: "Not about invoice status: the command is not about invoices or bills.",
};

const TIMEFRAME_CRITERIA: Record<TimeframeArg, string> = {
  today: "Today, including this morning, this afternoon, or tonight.",
  this_week: "This week or the next few days.",
  this_month: "This month or the past few weeks.",
  not_mentioned: "The command does not mention a time period.",
};

// Next record: which records continue the work, stated literally (jev-1.13
// literal reading), with the near misses on the other side (contrastive
// criteria). General patterns only. Tuning notes:
//   - "A record about the same client, project, or item" picked records merely
//     related to the one just opened or finished (the project of a meeting).
//   - A generic "a record in a panel the user has been working in" pattern
//     backed a "next in the list" record over the two records being compared,
//     so only its negative form stays, under less_likely.
//   - "Several records" was read as three or more; "two or more" is literal.
//   - "About the same client or item" did not stop linked records in unused
//     panels (a to-do item about the open message); naming the links did.
const NEXT_RECORD_LIKELY = [
  "When the user has opened two or more different records of one kind one after another, another record of that kind that the user has not opened yet.",
  "When the user is going back and forth between two records, one of those two records.",
  "The record that a search in `latest_activity` is looking for.",
];
const NEXT_RECORD_UNLIKELY = [
  "A record in a panel the user has not been working in, even when it is linked to a record the user opened, for example its project, its client, or a to-do item about it.",
  "A record that is only related to a record the user has already dealt with, such as replied to or checked off.",
  "The next record in a list the user has not been going through one record after another.",
];

const LIST_WORK_QUESTION =
  "Is the user working through a list of similar records one at a time: handling one record, then opening the next record of the same kind?";

// Signs describe general patterns. The false side names the patterns that
// also open several records but are not list work (comparing, reopening).
const LIST_WORK_CRITERIA: NoulQuestion["criteria"] = {
  true: {
    what: "The user is working through similar records one by one.",
    signs: [
      "Two or more different records of the same kind opened one after another",
      "A record opened and dealt with (for example replied to or checked off), then the next record of the same kind opened",
      "Moving down a list, one record after another",
    ],
  },
  false: {
    what: "The user is not working through a list of similar records.",
    signs: [
      "Records of different kinds, from different panels, opened in turn",
      "One record opened several times",
      "Moving between two records to compare them",
      "Searching or looking around panels without opening records one after another",
      "Only one record opened so far",
    ],
  },
};

// Goal done (focus aid 2): has the user finished the work of their working
// goal? The working goal rides in the instructions as `working_goal`, so the
// state stays the same for every other question. Signs describe general
// patterns only (no goal, panel, or record names), per the literal-reading note.
// Tuning notes:
//   - "Has the user finished the work in `working_goal`?" alone was read
//     literally against the goal's outcome (clients paying, projects on
//     track), so a user who handled every record scored 0.32 to 0.57. The
//     question now asks about the user's own part, and the note says the
//     outcome can still depend on other people.
const GOAL_DONE_QUESTION = "Has the user finished their own part of the work in `working_goal` for now?";
const GOAL_DONE_NOTE =
  "Their part is finished when the records they were working through have each been handled and they stopped opening new ones. The outcome can still depend on other people.";

const GOAL_DONE_CRITERIA: NoulQuestion["criteria"] = {
  true: {
    what: "The user has finished their part of that work for now.",
    signs: [
      "The latest steps completed that kind of work: several records of that kind were handled one after another, for example replied to, reminded, checked off, or updated",
      "After handling those records, the user stopped opening new records of that kind and turned to something else",
    ],
  },
  false: {
    what: "The user is still doing that work, or has only started it.",
    signs: [
      "The newest step opened a record of that kind that has not been handled yet",
      "Records of that kind were opened or looked at, but none was handled",
      "The work has only started: one or two steps so far",
      "Searching or looking around for something that work needs",
    ],
  },
};

// Next task (focus aid 2): which pending piece of work comes next once the
// current work is done. The candidates live in the criteria; every option has
// the same field names so the options compare directly (Choice docs).
const NEXT_TASK_QUESTION = "Which one of these tasks will the user most likely start next, after finishing their current work?";
const NEXT_TASK_LIKELY = [
  "A task that follows from the latest activity, for example one about a client, invoice, or project the user just worked on.",
  "A task with a set time that comes up soon, such as a meeting that starts shortly.",
];

// Next step ("Arrange linked panels by next step"): what the record the user
// just clicked asks for, and which linked record the user needs to do it.
// The clicked record rides in the instructions (`clicked_record`), never in
// the state, so the other questions and their eval results are unchanged.
// Literal wording (jev-1.13): the question names the condition, and every
// option has the same fields so they compare directly. Tuning notes:
//   - Without `likely`, an overdue invoice "asked for" nothing, so the
//     client's message about it scored 0.10 and the client row won; naming
//     the message that names the clicked record as likely moved it to first.
//   - "asks for nothing and needs nothing" in the rule changed nothing
//     (within drift), so the shorter rule stays.
//   - Limiting "none" to messages, with a note that an unpaid invoice asks
//     to be paid, moved an invoice click to its to-do item (0.41 to 0.44)
//     and pushed a held-out price question and a call request toward none,
//     so it was reverted. An invoice click stays a near tie between the
//     client's message, none, and the client (about 0.27 to 0.38 each).
const LINK_NEXT_QUESTION = "Which one of these linked records does the user need next to do what `clicked_record` asks for or needs?";
const LINK_NEXT_NOTE = "The user just opened `clicked_record`. Each option is a record in another panel that is linked to it.";
const LINK_NEXT_RULE = "Pick none when `clicked_record` asks for nothing, or when none of these records is needed for it.";
const LINK_NEXT_LIKELY = [
  "A linked record that `clicked_record` names, when what it asks for is done to that record.",
  "When `clicked_record` is not a message: a linked message that names it, since the message says what the other side needs.",
];
const LINK_ACTION_QUESTION = "Which one of these actions does `clicked_record` ask the user to take?";
const LINK_ACTION_RULE = "Pick none when `clicked_record` does not ask the user to do anything.";

/**
 * What each goal is not, for the pairs Jev confused in live runs (an inbox
 * search for an invoice read as inbox triage). Same field names on every
 * option so the options compare directly, per the Choice docs.
 */
const GOAL_NOT_FOR: Record<GoalId, string> = {
  triage_inbox: "Searching the inbox for one bill, project, or client while working on that.",
  plan_day: "Working through one client's or one project's details.",
  collect_payments: "Looking at revenue charts or totals for the year.",
  manage_client: "Mainly chasing overdue or unpaid invoices.",
  track_projects: "Only checking who on the team is free.",
  review_business: "Chasing one specific unpaid invoice.",
  coordinate_team: "Only checking a project's progress or deadline.",
  capture_notes: "Adding an item to the to-do list.",
  unclear: "Activity that clearly fits one of the other goals.",
};

function goalCriteria(): Record<string, EntryType> {
  return Object.fromEntries(
    GOAL_IDS.map((id) => [id, { goal: GOALS[id].label, what: GOALS[id].description, not_for: GOAL_NOT_FOR[id] }]),
  );
}

/**
 * Example commands per panel, as in the function-calling cookbook's spec.
 * Written to differ from the eval's COMMAND_CASES so the eval stays honest.
 */
const PANEL_COMMAND_EXAMPLES: Record<PanelId, string[]> = {
  inbox: ["find the email from Priya", "any new messages from clients"],
  calendar: ["what meetings do I have tomorrow", "book a call with Juniper"],
  tasks: ["what do I need to finish this week", "add a to-do to send the files"],
  invoices: ["which bills are still unpaid", "show late invoices", "send Kite a payment reminder"],
  clients: ["open Pinecrest Clinic", "contact details for Kite & Co."],
  projects: ["which projects are behind schedule", "how is the signage project going"],
  analytics: ["how much did we earn this year", "show the revenue chart"],
  team: ["who is out of the office", "what is Riley working on"],
  notes: ["write down an idea", "open my scratch pad"],
  help: ["how does this workspace work", "what keyboard shortcuts are there"],
};

function panelOption(id: PanelId): EntryType {
  return { panel: PANELS[id].title, shows: PANELS[id].description, examples: PANEL_COMMAND_EXAMPLES[id] };
}

function actionCriteria(noneDescription: string): Record<string, string> {
  return Object.fromEntries(
    ACTION_IDS.map((id) => [id, id === "none" ? noneDescription : ACTIONS[id].description]),
  );
}

/**
 * Client options. The contact person helps Jev match activity such as
 * "message from Priya Nair" to the right company without generating a name.
 */
function clientCriteria(candidates: readonly string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const name of candidates) {
    const known = CLIENTS.find((c) => c.name === name);
    out[name] = known ? `Client company. Contact person: ${known.contact}.` : null;
  }
  return out;
}

/** Unique, non-empty candidate names that do not collide with the no-match options. */
export function clientCandidates(req: AdaptRequest): string[] {
  const reserved = new Set([NO_CLIENT, CLIENT_NOT_MENTIONED]);
  const seen = new Set<string>();
  for (const raw of req.candidates.clients) {
    const name = raw.trim();
    if (name && !reserved.has(name)) seen.add(name);
  }
  return [...seen];
}

/** The contract's cap on record candidates (AdaptRequest.candidates.records). */
const MAX_RECORD_OPTIONS = 12;

/**
 * Record candidates to offer, first of each id, at most MAX_RECORD_OPTIONS.
 * validate.ts already cleans HTTP bodies; this also covers callers that skip
 * it (the eval calls adapt() directly).
 */
export function recordCandidates(req: AdaptRequest): RecordCandidate[] {
  const out: RecordCandidate[] = [];
  const seen = new Set<string>([NO_RECORD]);
  for (const record of req.candidates.records ?? []) {
    const id = record.id.trim();
    if (!id || seen.has(id) || !record.label.trim()) continue;
    seen.add(id);
    out.push({ ...record, id });
    if (out.length >= MAX_RECORD_OPTIONS) break;
  }
  return out;
}

/** Record kinds in the words the activity lines use (describeEvent in src/engine/snapshot.ts). */
const RECORD_KIND_WORDS: Record<ItemKind, string> = {
  invoice: "invoice",
  message: "message",
  client: "client",
  project: "project",
  task: "task",
  event: "calendar event",
  person: "team member",
  note: "note",
};

/**
 * One next-record option. The key ("invoice:INV-1038") is only a handle for
 * code; everything Jev should weigh is spelled out here, with the same field
 * names on every option so the options compare directly (Choice docs).
 */
function recordOption(record: RecordCandidate): EntryType {
  const option: { [key: string]: JsonValue } = {
    record: record.label,
    kind: RECORD_KIND_WORDS[record.kind],
    panel: PANELS[record.panel].title,
    client: record.client ?? "No client company",
  };
  if (record.why) option.listed_because = record.why;
  return option;
}

/** The contract's cap on task candidates (AdaptRequest.candidates.tasks). */
const MAX_TASK_OPTIONS = 5;

/**
 * Task candidates to offer, first of each id, at most MAX_TASK_OPTIONS,
 * without the no-match id. Like recordCandidates, this also covers callers
 * that skip validate.ts (the eval calls adapt() directly).
 */
export function taskCandidates(req: AdaptRequest): TaskCandidate[] {
  const out: TaskCandidate[] = [];
  const seen = new Set<string>([NO_TASK]);
  for (const task of req.candidates.tasks ?? []) {
    const id = task.id.trim();
    if (!id || seen.has(id) || !task.label.trim() || !GOALS[task.goal]) continue;
    seen.add(id);
    out.push({ ...task, id });
    if (out.length >= MAX_TASK_OPTIONS) break;
  }
  return out;
}

/** The working goal in words, or null when the request carries none (then no goal-done question). */
export function workingGoalOf(req: AdaptRequest): WorkingGoalWords | null {
  const label = req.workingGoal?.label.trim();
  return label ? { label, description: req.workingGoal?.description.trim() ?? "" } : null;
}

/** The contract's cap on linked records in a link request (AdaptRequest.link.records). */
const MAX_LINK_OPTIONS = 8;

/**
 * The link request to ask about, cleaned, or null (then no link question).
 * Like recordCandidates, this also covers callers that skip validate.ts
 * (the eval calls adapt() directly): the first of each id, not the clicked
 * record, with a label, at most MAX_LINK_OPTIONS.
 */
export function linkOf(req: AdaptRequest): LinkRequest | null {
  const clicked = req.link?.clicked;
  if (!clicked || !clicked.id.trim() || Object.keys(clicked.fields ?? {}).length === 0) return null;
  const out: RecordCandidate[] = [];
  const seen = new Set<string>([NO_LINK_RECORD, clicked.id]);
  for (const record of req.link?.records ?? []) {
    const id = record.id.trim();
    if (!id || seen.has(id) || !record.label.trim()) continue;
    seen.add(id);
    out.push({ ...record, id });
    if (out.length >= MAX_LINK_OPTIONS) break;
  }
  return out.length > 0 ? { clicked, records: out } : null;
}

/** The clicked record as the instructions show it: its kind in words, then its fields ("from", "subject", "text", ...). */
function clickedWords(clicked: ClickedRecord): JsonValue {
  return { kind: RECORD_KIND_WORDS[clicked.kind] ?? clicked.kind, ...clicked.fields };
}

/** One link-next option: the same field names on every option (Choice docs). The key is only a handle for code. */
function linkOption(record: RecordCandidate): EntryType {
  return { record: record.label, panel: PANELS[record.panel].title, linked_because: record.why ?? "It is linked to `clicked_record`." };
}

/** One next-task option: the same field names on every option (Choice docs). The key is only a handle for code. */
function taskOption(task: TaskCandidate): EntryType {
  return { task: task.label, how_many: task.count, first_record: task.first, part_of: GOALS[task.goal].label };
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

export function buildQuestions(req: AdaptRequest): Record<string, Question> {
  const command = cleanCommand(req);
  const hasCommand = command !== null;
  const clients = clientCandidates(req);
  const records = recordCandidates(req);
  const evidence = nowEvidence(hasCommand);
  const questions: Record<string, Question> = {};

  questions[QUESTION_IDS.goal] = choice(
    {
      question: "Which goal is the user working on right now?",
      evidence,
    },
    goalCriteria(),
  );

  // No `evidence` block here: ten copies of it were 14% of the input tokens,
  // and the live A/B kept the same top panel without it. Jev reads the whole
  // state for every question anyway.
  for (const id of PANEL_IDS) {
    questions[QUESTION_IDS.relevance(id)] = score(
      {
        panel: { name: PANELS[id].title, what_it_shows: PANELS[id].description },
        question: "How useful would `panel` be on screen right now for what the user is working on?",
        note: RELEVANCE_NOTE,
      },
      RELEVANCE_LEVELS,
    );
  }

  questions[QUESTION_IDS.struggling] = noul(
    {
      question: "Is the user stuck: unable to find something, or unable to finish a step?",
      read: ["`earlier_activity`", "`latest_activity`", "`behavior_observations`"],
    },
    {
      // Signs describe general patterns, never particular sessions. The code
      // counts the evidence for them (behavior_observations).
      true: {
        what: "The user is stuck.",
        signs: [
          "The same search repeated or reworded",
          "A search phrased as a question about how to do something or where something is",
          "Panels opened and then closed again quickly",
          "Undo used",
          "Moving between panels without opening anything or getting anything done",
        ],
      },
      false: {
        what: "The user is getting on with their work, or there is too little activity to tell.",
        signs: [
          "Each action follows from the one before",
          "Filtering a list and then opening an item from it",
          "Moving between two related records to compare them",
          "Returning to a record once, or one search for something related to the record at hand",
          "Only one or two actions so far",
        ],
      },
    },
  );

  questions[QUESTION_IDS.layout] = choice(
    {
      question: "Which screen layout fits how the user is working right now?",
      read: ["`latest_activity`", "`earlier_activity`", "`behavior_observations`"],
    },
    Object.fromEntries(LAYOUT_MODES.map((mode) => [mode, LAYOUT_MODE_DEFS[mode].description])),
  );

  questions[QUESTION_IDS.expertise] = score(
    {
      question: "How familiar is the user with this workspace, judging by how they move around and how quickly they act?",
      read: ["`behavior_observations`", "`earlier_activity`", "`latest_activity`"],
    },
    EXPERTISE_LEVELS,
  );

  questions[QUESTION_IDS.nextAction] = choice(
    {
      question: "Which one next step would the user most likely want to take now?",
      evidence,
      rule: "Pick none when no listed step clearly follows from what the user is doing.",
    },
    actionCriteria("No clear next step: the activity does not point to any of these steps."),
  );

  if (clients.length > 0) {
    questions[QUESTION_IDS.targetClient] = choice(
      {
        question: "Which one client company is the user's current work about?",
        evidence,
      },
      {
        ...clientCriteria(clients),
        [NO_CLIENT]: "No single client: the recent activity is not about one specific client company.",
      },
    );
  }

  if (records.length > 0) {
    questions[QUESTION_IDS.nextRecord] = choice(
      {
        question: "Which one of these records will the user most likely open or work on next, after what they are looking at now?",
        evidence,
        likely: NEXT_RECORD_LIKELY,
        less_likely: NEXT_RECORD_UNLIKELY,
        rule: "Pick none when no listed record fits the user's current work.",
      },
      {
        ...Object.fromEntries(records.map((r) => [r.id, recordOption(r)])),
        [NO_RECORD]: {
          record: "None of these records",
          listed_because: "No listed record fits the user's current work.",
        },
      },
    );

    questions[QUESTION_IDS.listWork] = noul(
      {
        question: LIST_WORK_QUESTION,
        read: ["`earlier_activity`", "`latest_activity`", "`behavior_observations`"],
      },
      LIST_WORK_CRITERIA,
    );
  }

  // Focus aid 2: asked only when the client sends the working goal, and the
  // next task only when it also sends task candidates (it does so only when
  // the working goal might be done, to keep the token cost down).
  const working = workingGoalOf(req);
  if (working) {
    questions[QUESTION_IDS.goalDone] = noul(
      {
        working_goal: { goal: working.label, what: working.description },
        question: GOAL_DONE_QUESTION,
        note: GOAL_DONE_NOTE,
        read: ["`earlier_activity`", "`latest_activity`", "`current_focus`"],
      },
      GOAL_DONE_CRITERIA,
    );
  }

  const tasks = taskCandidates(req);
  if (tasks.length > 0) {
    questions[QUESTION_IDS.nextTask] = choice(
      {
        question: NEXT_TASK_QUESTION,
        ...(working ? { current_work: working.label } : {}),
        evidence,
        likely: NEXT_TASK_LIKELY,
        rule: "Pick none when no listed task fits what the user has been doing.",
      },
      {
        ...Object.fromEntries(tasks.map((t) => [t.id, taskOption(t)])),
        [NO_TASK]: { task: "None of these tasks", part_of: "No listed task fits what the user has been doing." },
      },
    );
  }

  // "Arrange linked panels by next step": asked only when the client sends
  // the clicked record and its linked records, once per click.
  const link = linkOf(req);
  if (link) {
    const clicked = clickedWords(link.clicked);
    questions[QUESTION_IDS.linkNext] = choice(
      {
        clicked_record: clicked,
        question: LINK_NEXT_QUESTION,
        note: LINK_NEXT_NOTE,
        likely: LINK_NEXT_LIKELY,
        rule: LINK_NEXT_RULE,
      },
      {
        ...Object.fromEntries(link.records.map((r) => [r.id, linkOption(r)])),
        [NO_LINK_RECORD]: { record: "None of these records", panel: "None", linked_because: "`clicked_record` needs none of these records." },
      },
    );
    questions[QUESTION_IDS.linkAction] = choice(
      {
        clicked_record: clicked,
        question: LINK_ACTION_QUESTION,
        rule: LINK_ACTION_RULE,
      },
      actionCriteria("No action: `clicked_record` does not ask the user to do any of these."),
    );
  }

  if (hasCommand) {
    questions[QUESTION_IDS.command.panel] = choice(
      {
        question: "Which panel best answers or carries out `command`?",
        // Without this, a bare "atlas" has nothing to match and lands on "unclear".
        rule: "A command that only names one of `client_companies` asks to see that client.",
      },
      {
        ...Object.fromEntries(PANEL_IDS.map((id) => [id, panelOption(id)])),
        [PANEL_UNCLEAR]: {
          panel: "No panel",
          shows: "`command` matches none of these panels, or it is too vague to tell.",
          examples: ["hello", "do the thing"],
        },
      },
    );

    questions[QUESTION_IDS.command.action] = choice(
      {
        question: "Does `command` ask to perform one of these actions?",
        rule: "Pick none when `command` only asks to see or find something.",
      },
      actionCriteria("No action: `command` asks to see or find something, or asks for none of these actions."),
    );

    questions[QUESTION_IDS.command.invoiceStatus] = choice(
      { question: "Which invoice status does `command` ask about?" },
      { ...INVOICE_STATUS_CRITERIA },
    );

    if (clients.length > 0) {
      questions[QUESTION_IDS.command.client] = choice(
        { question: "Which client company does `command` name or point to?" },
        {
          ...clientCriteria(clients),
          [CLIENT_NOT_MENTIONED]: "Not mentioned: `command` does not name or point to one client company.",
        },
      );
    }

    questions[QUESTION_IDS.command.timeframe] = choice(
      { question: "Which time period does `command` ask about?" },
      { ...TIMEFRAME_CRITERIA },
    );
  }

  return questions;
}

// ---------------------------------------------------------------------------
// Meeting prep (focus aid 4): POST /api/prep
// ---------------------------------------------------------------------------

// Its own request, because its state is different: the meeting about to
// start, not what the user has been doing. Every record gets one Score with
// identical wording and levels, so the scores compare and code can rank them
// (the re-ranking cookbook's pattern: the same question for every
// candidate, sorted in code). Each record rides in its own question's
// instructions as structured data (`record`), never in the state, so no
// question reads the other records as distractors. The levels describe
// situations, not degrees (Score docs), and the anything-urgent Noul reads
// all the records together, since it asks whether any of them needs action.
export const PREP_QUESTION_IDS = {
  record: (index: number): string => `prep_record_${index}`,
  anythingUrgent: "anything_urgent",
} as const;

/** The contract's cap on prep records (PrepRequest.records). */
export const MAX_PREP_RECORDS = 10;

const PREP_NOTE =
  "The user runs Fernhill Studio, a small design studio, and is about to go into `meeting` with one of the studio's clients. `record` is one of the studio's records.";
const PREP_URGENT_NOTE =
  "The user runs Fernhill Studio, a small design studio, and is about to go into `meeting` with one of the studio's clients. `records` lists the studio's records that may matter for it.";
const PREP_SCORE_QUESTION = "How much does the user need `record` before `meeting` starts?";
const PREP_SCORE_LEVELS: [EntryType, EntryType, EntryType] = [
  {
    what: "Not needed for this meeting: the record belongs to another client or to no client, or it is finished and needs nothing from anyone.",
    examples: ["a message about another client's job", "a record for a different client"],
  },
  {
    what: "Useful background: the record is about this client and could come up, but it is not part of the work the meeting is about, and nothing in it is waiting on the user.",
    examples: ["a bill that is sent and not due yet", "a message that only shares information or says there is no rush"],
  },
  {
    what: "Should be reviewed before this meeting: the record is part of the work the meeting is about (the project, an open task for it, or a message about it), or something in it is waiting on the user.",
    examples: ["a request or question from the client that has not been answered", "a bill past its due date", "the project the meeting is about, or an open task for it"],
  },
];
const PREP_URGENT_QUESTION = "Does any record in `records` need the user to do something before `meeting` starts?";
const PREP_URGENT_CRITERIA: NoulQuestion["criteria"] = {
  true: {
    what: "At least one record needs the user to act before the meeting starts.",
    signs: [
      "An invoice for this client is overdue and still unpaid",
      "A message from the client asks for something that has not been done yet",
      "A task for this client is due today or is late",
    ],
  },
  false: {
    what: "Nothing in these records needs the user to act before the meeting; it can wait, or be discussed in the meeting.",
    signs: [
      "Invoices are sent and not due yet",
      "Messages only share information, or say there is no rush",
      "Tasks are due on a later day",
    ],
  },
};

/**
 * The records to ask about, first of each id, with at least one field, at
 * most MAX_PREP_RECORDS. validate.ts already cleans HTTP bodies; this also
 * covers callers that skip it (the eval calls prep() directly).
 */
export function prepRecordsOf(req: PrepRequest): PrepRecord[] {
  const out: PrepRecord[] = [];
  const seen = new Set<string>();
  for (const r of req.records ?? []) {
    const id = r.id.trim();
    if (!id || seen.has(id) || Object.keys(r.fields ?? {}).length === 0) continue;
    seen.add(id);
    out.push({ ...r, id });
    if (out.length >= MAX_PREP_RECORDS) break;
  }
  return out;
}

/** One record as the instructions show it: its kind in words, then its fields ("from", "subject", "text", ...). */
function prepRecordWords(r: PrepRecord): JsonValue {
  return { kind: RECORD_KIND_WORDS[r.kind] ?? r.kind, ...r.fields };
}

/** The prep state: only the meeting, in words (title, client, time, kind). */
export function buildPrepState(req: PrepRequest): JevState {
  const m = req.meeting;
  return { meeting: { title: m.title, client: m.client, time: m.time, kind: m.kind } };
}

/** One Score per record (PREP_QUESTION_IDS.record(i), in the order of prepRecordsOf) and the anything-urgent Noul. */
export function buildPrepQuestions(req: PrepRequest): Record<string, Question> {
  const records = prepRecordsOf(req);
  const questions: Record<string, Question> = {};
  records.forEach((r, i) => {
    questions[PREP_QUESTION_IDS.record(i)] = score({ record: prepRecordWords(r), question: PREP_SCORE_QUESTION, note: PREP_NOTE }, PREP_SCORE_LEVELS);
  });
  if (records.length > 0) {
    questions[PREP_QUESTION_IDS.anythingUrgent] = noul(
      { records: records.map(prepRecordWords), question: PREP_URGENT_QUESTION, note: PREP_URGENT_NOTE },
      PREP_URGENT_CRITERIA,
    );
  }
  return questions;
}

/** Levels per Score question, for code that wants to read or label them. */
export const SCORE_LEVELS = {
  relevance: RELEVANCE_LEVELS,
  expertise: EXPERTISE_LEVELS,
  prep: PREP_SCORE_LEVELS,
} as const;
