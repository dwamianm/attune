/**
 * Contract for the client adaptation engine (types only).
 *
 * The engine owns:
 *   - the signal log (what the user did),
 *   - the mutable app data (copied from shared/fixtures.ts at startup),
 *   - the scheduler that asks the server for Jev judgments,
 *   - the layout policy that turns judgments into a LayoutPlan.
 *
 * UI code reads everything through `useEngine(selector)` exported from
 * ./store.ts, and reports what the user does through `track()`.
 * UI code must never call /api directly.
 */
import type * as Lib from "@attuneui/core";
import type { ActionId, GoalId, LayoutMode, PanelId } from "../../shared/catalog.ts";
import type { CalendarEvent, Invoice, Message, Project, Task } from "../../shared/fixtures.ts";
import type {
  AdaptResponse,
  AnchorRef,
  ChangeSummary,
  Decision,
  GridColumns,
  InvoiceStatusArg,
  ItemKind,
  LayoutPlan,
  PanelRelation,
  PolicyWeights,
  RecordCandidate,
  RelatedRecord,
  SignalEvent,
  Suggestion,
  TaskCandidate,
  TrackInput,
} from "../../shared/types.ts";

/**
 * Per-panel view state. Commands and suggestions can set these; panels read them.
 * Tasks and Calendar keep their selection here too (optional, so older views
 * stay valid), so "Up next" and "Back to" can select a task or an event the
 * way a click does (docs/predictive-flow.md).
 */
export interface PanelViewState {
  inbox: { query: string; selectedId: string | null; client: string | null };
  invoices: { status: InvoiceStatusArg | "all"; client: string | null; selectedId: string | null };
  clients: { selected: string | null; query: string };
  tasks: { showDone: boolean; client: string | null; selectedId?: string | null };
  projects: { status: "all" | "at_risk" | "blocked" | "on_track"; selectedId: string | null };
  calendar: { range: "today" | "this_week"; selectedId?: string | null };
  analytics: { range: "this_month" | "this_year" };
  team: Record<string, never>;
  notes: Record<string, never>;
  help: Record<string, never>;
}

/** App data the user can change during the session. */
export interface AppData {
  invoices: Invoice[];
  messages: Message[];
  tasks: Task[];
  projects: Project[];
  events: CalendarEvent[];
  notes: string;
}

/** One round of adaptation, kept for the inspector's history view. */
export interface AdaptationRecord {
  version: number;
  /** Milliseconds since epoch when the response arrived. */
  at: number;
  /** What triggered the request, for example "item_open" or "command". */
  trigger: string;
  response: AdaptResponse;
  /** Plan decisions that came from this response. */
  decisions: Decision[];
  /** True when the response arrived too late and was not applied. */
  stale: boolean;
}

export interface EngineSettings {
  /** Off = a fixed traditional layout. Signals are still logged. */
  adaptive: boolean;
  /** On = keep asking Jev and show answers in the inspector, but do not move panels. */
  frozen: boolean;
  layoutBehavior?: "adaptive" | "suggestions";
  density?: "guided" | "standard" | "dense" | "auto";
  weights: PolicyWeights;
  /** Minimum milliseconds between two layout changes. */
  minChangeIntervalMs: number;
  /**
   * The link cues after a click (docs/anchored-relayout.md, "Links").
   * "stay": the lines, tags, and tints stay until the user clears them.
   * "fade": the older behavior; the lines fade after about 2 s, and the tags
   * and tints go when the anchor is released.
   */
  linkLines: LinkLinesMode;
  /**
   * The focus aids the user can switch on or off (docs/focus-aids.md), one
   * flag each, persisted with the other settings. Older saves have none, so
   * every flag falls back to DEFAULT_FOCUS_AIDS (./focusAids.ts).
   */
  focusAids: FocusAidSettings;
  /**
   * Focus aid 4, "Prepare for meetings": how many minutes before a meeting
   * the prep chip shows (PREP_LEAD_OPTIONS in ./meetingPrep.ts). Optional,
   * so older saves stay valid; absent means PREP_LEAD_DEFAULT.
   */
  prepLeadMin?: number;
}

export type LinkLinesMode = "stay" | "fade";

/**
 * One on or off flag per focus aid (docs/focus-aids.md, "The settings
 * home"). To add an aid: add its flag here, its default in
 * DEFAULT_FOCUS_AIDS and its label and one-line description in
 * FOCUS_AID_TEXT (./focusAids.ts; both are typed so a missing entry does not
 * compile), and read `settings.focusAids.<flag>` where the aid acts. The
 * header popover, the inspector's Controls tab, persistence, and the
 * setting_change signal pick it up from there.
 */
export interface FocusAidSettings {
  /** Aid 1: panels that do not matter now fade, and shrink where that keeps the calm relayout (./quiet.ts). */
  fadeQuiet: boolean;
  /** The "Up next" card and its n key (docs/predictive-flow.md). Off: no card, and n does nothing. */
  upNext: boolean;
  /** The "Back to" chips and their b key (docs/predictive-flow.md). Off: no chips, no saved contexts, and b does nothing. */
  backTo: boolean;
  /**
   * "Pin or make bigger". On ("Move to front", the default): a panel the
   * user pins or makes bigger goes to the first cell at once (a pin at its
   * size, a bigger one as the hero), the newest first, and the policy keeps
   * that order in later rounds (EngineState.front, PolicyInput.front). Off
   * ("Keep in place"): the older behavior, where a pin under the pointer
   * stays put and a bigger panel keeps its top edge.
   */
  moveToFront: boolean;
  /**
   * Aid 2, "Say when a task is done" (./taskDone.ts): when the work of the
   * working goal is finished, a Done card takes the Up next slot and offers
   * the next task (n starts it). Off: no card, no goal-done or next-task
   * question, and the Up next completion line works as before.
   */
  taskDone: boolean;
  /**
   * "Arrange linked panels by next step" (docs/anchored-relayout.md, "Next
   * step"): in a round that links panels to a click, the linked panels move
   * into the cells nearest the clicked panel, the next step first; Jev reads
   * the clicked record and picks that step (link-next, link-action), which
   * Up next and the suggestion bar then offer. Off: the links only draw, as
   * before, and no link question is asked.
   */
  arrangeLinks: boolean;
  /**
   * Aid 3, "Learn my habits" (./habits.ts): Attune learns where the user
   * usually goes next, where they start, which work follows which, and what
   * they do after opening a record, in this browser only, and uses it for a
   * small habit part in the layout, Up next and next-task order, a subtle
   * suggestion, and at most two lines Jev reads. Off: it stops learning and
   * stops using them (the saved habits stay until the user forgets them).
   */
  habits: boolean;
  /**
   * Aid 4, "Prepare for meetings" (./meetingPrep.ts): a meeting or call with
   * a client that starts within the lead time gets a prep chip ("p"); Prepare
   * saves the current work as a Back to chip and arranges Calendar with the
   * meeting and the client's records, ranked by Jev in its own request. Off:
   * no chip, no prep request, and nothing else changes.
   */
  meetingPrep: boolean;
}

export type FocusAidId = keyof FocusAidSettings;

/**
 * The link cues on screen: the clicked record in the source panel and the
 * panels linked to it (tags, tints, and lines). It outlives the anchor that
 * made it ("stay" mode): only a new click with links of its own replaces it,
 * and the user clears it (all, or one panel at a time).
 */
export interface LinkSet {
  /** The anchor of the click that made these links. Its panel holds the clicked row, where the lines start. */
  source: AnchorRef;
  /** One relation per linked panel, in plan order, at most LINKED_PANELS_MAX (LINK_SET_MAX for a prep view, focus aid 4). Never empty. */
  relations: Partial<Record<PanelId, PanelRelation>>;
  /** The plan round that made the set, so an undo of that round can clear it. */
  round: number;
  /**
   * The linked panel that holds the next step Jev read from the clicked
   * record, when Jev is sure enough ("Arrange linked panels by next step"):
   * its tag reads `text` ("Next: resend INV-1042") in a stronger style and
   * its line stays at full strength. Absent: no "Next" emphasis.
   */
  next?: { panel: PanelId; record: string; text: string; probability: number };
  /**
   * Focus aid 4: set on the links a prep view made ("For the meeting" tags
   * on the client's panels, the meeting in Calendar as the source). A later
   * round for the same anchor keeps these links and their order instead of
   * replacing them with its own. Absent: ordinary links from a click.
   */
  prep?: { eventId: string };
}

export type EngineStatus = "idle" | "thinking" | "error" | "offline";

/** The command bar's outcome after a command is judged. */
export interface CommandOutcome {
  text: string;
  status: "applied" | "confirm" | "unclear";
  /** For "confirm" and "unclear": up to 3 alternatives the user can click. */
  options: { panel: PanelId; label: string; probability: number }[];
  message: string;
}

/** Where the pointer is, as the UI reports it. `down` is true while a button or touch is pressed. */
export interface PointerState {
  panel: PanelId | null;
  down: boolean;
}

// ---------------------------------------------------------------------------
// Predictive flow (docs/predictive-flow.md): "Up next", "Back to", metrics.
// ---------------------------------------------------------------------------

/** The record the "Up next" card offers (chooseUpNext in ./nextUp.ts). */
export interface UpNextPick {
  candidate: RecordCandidate;
  /**
   * "jev": Jev's nextRecord at or above UP_NEXT_JEV_MIN_P. "list": code's next
   * record in the current list, in queue mode. "link": the next step Jev read
   * from the record the user clicked ("Arrange linked panels by next step").
   */
  source: "jev" | "list" | "link";
  /** A "link" pick only: what the step is, for example "to resend it". Absent when the step names no action. */
  step?: string;
  /** Short why for the card: "Jev 72%" or "Next in list". */
  why: string;
  /** The judge's probability for the pick, when it came from the judge. */
  probability?: number;
  /** At most UP_NEXT_ALTERNATIVES_MAX other records, shown as small chips. */
  alternatives: RecordCandidate[];
}

/** The "Up next" card's completion state (queueDone in ./nextUp.ts): the action the user repeats has no record left. */
export interface UpNextDone {
  /** For example "All overdue invoices have a reminder.". */
  text: string;
  /** The id of the action event that finished the list, so a dismissal hides this one only. */
  eventId: number;
}

/**
 * What the user was working on before the goal changed, saved so one click
 * ("Back to") brings it back. Session memory only; Reset clears it.
 */
export interface WorkingContext {
  /** Increasing id, unique within the session. */
  id: number;
  goal: GoalId;
  /** The client the work was about, when known. */
  client?: string;
  /** Goal label plus client, for example "Collecting payments · Harbor Coffee Co.". */
  label: string;
  /** The plan on screen when it was saved: placements, sizes, cells, and mode. */
  plan: LayoutPlan;
  /** Panels the user had made bigger. */
  bigger: PanelId[];
  /** Filters and selected records. */
  view: PanelViewState;
  /** The link cues on screen, or null. */
  links: LinkSet | null;
  /** Epoch ms when it was saved. */
  at: number;
}

/** The goal the current working context is about, and since when. */
export interface WorkingGoal {
  goal: GoalId;
  /** Epoch ms when this context began. */
  since: number;
  /**
   * The client this context is about, when the engine knows it for sure:
   * set only by Prepare (focus aid 4, the meeting's client), so a saved
   * context for the same goal and another client still shows as a Back to
   * chip. Absent: the client is not part of the working context.
   */
  client?: string;
}

// ---------------------------------------------------------------------------
// Focus aid 2, "Say when a task is done" (docs/focus-aids.md, ./taskDone.ts).
// ---------------------------------------------------------------------------

/** One piece of pending work the Done card can offer next: the open records of one goal other than the working goal. */
export interface NextTask {
  /** Stable id, also the TaskCandidate id sent to Jev, for example "unread_messages". */
  id: string;
  goal: GoalId;
  /** The panel that lists the work. */
  panel: PanelId;
  /** How many records it covers. */
  count: number;
  /** The card's words: "2 unread client messages". */
  text: string;
  /** The same in words for the activity line Jev reads: "two unread client messages". */
  words: string;
  /** What Jev reads for it in the next-task Choice. */
  candidate: TaskCandidate;
  /** The first record, which Start selects. */
  first: { kind: ItemKind; id: string; label: string; client?: string };
  /** Code's priority (TASK_PRIORITY), plus any TaskBoost; higher first. */
  priority: number;
  /** Why it ranks there, in a few words, for the card's chip: "Clients are waiting". */
  why: string;
}

/** The Done card: the working goal is finished, and what comes next (judgeTaskDone and chooseNextTask in ./taskDone.ts). */
export interface TaskDoneState {
  goal: GoalId;
  /** The done line, for example "Payments done". */
  title: string;
  /** What makes it done, for example "every overdue invoice has a reminder.". Absent for a goal Jev judged. */
  detail?: string;
  /** "code": the data says so (goalFact). "jev": Jev's goal-done Noul, TASK_DONE_ROUNDS rounds in a row. */
  source: "code" | "jev";
  /** Jev's goal-done probability in the newest round, when source is "jev". */
  probability?: number;
  /** The next task offered, or null when no other goal has pending work. */
  next: NextTask | null;
  /** How the next task was chosen: Jev's nextTask past its gate, or code's top-ranked candidate. */
  nextSource?: "jev" | "code";
  /** The next task's chip: "Jev 64%", or code's reason ("Clients are waiting"). */
  nextWhy?: string;
  /** Epoch ms when the working goal began: with the goal, which completion this is. */
  since: number;
}

// ---------------------------------------------------------------------------
// Focus aid 3, "Learn my habits" (docs/focus-aids.md, ./habits.ts).
// ---------------------------------------------------------------------------

/** Time of day by local clock: morning before 12, afternoon 12 to 17, evening from 17. */
export type TimeOfDay = "morning" | "afternoon" | "evening";

/** One decayed count: `n` as of `at` (epoch ms). It halves every HABIT_HALF_LIFE_MS after that. */
export interface HabitCount {
  n: number;
  at: number;
}

/**
 * What Attune learned about the user's habits, saved in this browser
 * (HABITS_STORAGE_KEY). Keys are plain strings so the saved form stays small.
 */
export interface HabitMemory {
  /** The panel worked in, then the next different one, by time of day: "morning|inbox>calendar". */
  panel: Record<string, HabitCount>;
  /** The first panel worked in per session, by time of day: "morning|inbox". */
  start: Record<string, HabitCount>;
  /** The working goal, then the next working goal: "collect_payments>triage_inbox". */
  goal: Record<string, HabitCount>;
  /** The first action in a record's panel after opening a record of that kind: "invoice>send_payment_reminder". */
  action: Record<string, HabitCount>;
  /** True once "Load a sample week" added made-up counts; the Habits view says so until the user forgets them. */
  sample: boolean;
}

/**
 * What code may use from the habits this round (habitHints in ./habits.ts):
 * only habits with enough evidence. Absent from PolicyInput: the aid is off
 * or nothing is learned yet, and the policy plans exactly as before.
 */
export interface HabitHints {
  /** The panel the user works in now, or null before any work this session (then `next` holds where they usually start). */
  from: PanelId | null;
  bucket: TimeOfDay;
  /** The learned chance of going to each panel next, 0..1, only for panels past the evidence bar. */
  next: Partial<Record<PanelId, number>>;
  /** The action the user usually takes after opening a record of this kind, for the record open now. */
  action?: { kind: ItemKind; recordId: string; client?: string; actionId: ActionId; share: number };
}

// ---------------------------------------------------------------------------
// Focus aid 4, "Prepare for meetings" (docs/focus-aids.md, ./meetingPrep.ts).
// ---------------------------------------------------------------------------

/** Jev's (or the heuristic's) read of which records matter for a meeting (rankingFrom in ./meetingPrep.ts). */
export interface PrepRanking {
  /** Each record's Score as a share of its scale, 0..1, keyed by PrepRecord id ("invoice:INV-1042"). */
  scores: Record<string, number>;
  /** The anything-urgent Noul: some record needs action before the meeting starts. */
  urgent: number;
  source: "jev" | "heuristic";
}

/**
 * The prep chip or card (the Up next row), or null. "offer": a meeting starts
 * within the lead time and the chip offers Prepare (p). "ready": the user
 * pressed Prepare; the prep view is on screen and the card says the meeting
 * is ready, with the thing to handle first when Jev says there is one.
 */
export interface MeetingPrepState {
  stage: "offer" | "ready";
  eventId: string;
  title: string;
  client: string;
  /** ISO start time; the UI counts the minutes down from it. */
  start: string;
  kind: "meeting" | "call";
  /** The ranking for the records as they are now, once /api/prep answered for them. */
  ranking?: PrepRanking;
  /** Set when the ranking says something needs action first: "1 thing to handle first: INV-1042 is 14 days overdue". */
  urgent?: { count: number; text: string; record: string };
  /** The panels the prep view linked, in the order they gathered ("ready" only). */
  panels?: PanelId[];
  /** True once the user pressed "Start meeting notes". */
  notesStarted?: boolean;
}

/** Hits for one kind of prediction, each counted once, at the user's next open or action. */
export interface PredictionScore {
  /** The first-ranked prediction was right. */
  hit1: number;
  /** One of the top PREDICTION_TOP_N was right (includes hit1). */
  hit3: number;
  /** A prediction was made and none of the top ones was right. */
  miss: number;
  /** Nothing was predicted since the previous open or action. */
  none: number;
}

/** Per-session counters for the inspector's Metrics tab (./metrics.ts). */
export interface FlowMetrics {
  /** Epoch ms of the first user signal, or null before any. */
  startedAt: number | null;
  nextRecord: PredictionScore;
  /** The top record ids (RecordCandidate ids) of the newest round, until the next open. */
  pendingRecord: { top: string[]; source: "jev" | "code" } | null;
  nextAction: PredictionScore;
  /** The top next actions of the newest round, until the next performed action. */
  pendingAction: ActionId[] | null;
  /** Navigation the user did by hand, and the actions they performed. */
  effort: { dockOpens: number; searches: number; scrolls: number; commands: number; backTo: number; actions: number };
  /** Up next picks shown (a new record on the card), and opened from the card. */
  upNext: { shown: number; openedClick: number; openedKey: number; openedAlternative: number; lastShown: string | null };
  undos: number;
  /** Layout changes the engine applied (Jev rounds and commands; manual edits, undo, and Back to excluded). */
  layoutChanges: number;
  /**
   * Focus aid 1 (docs/focus-aids.md): panels that went quiet, and quiet
   * panels the user clicked into or used anyway, a sign the fade was wrong.
   */
  quiet: { went: number; reopened: number };
  /**
   * Focus aid 2 (docs/focus-aids.md): working goals the engine said were
   * done (task_done), how many of those Done cards offered a next task, and
   * how many next tasks the user started (task_start).
   */
  taskDone: { done: number; offered: number; started: number };
  /**
   * Focus aid 3 (docs/focus-aids.md): moves where the habits had a guess
   * (the top next panel, or where the session usually starts), and how many
   * matched where the user went. Counted with the aid on or off.
   */
  habits: { guessed: number; right: number };
  /**
   * Focus aid 4 (docs/focus-aids.md): meetings the prep chip offered
   * (prep_offer), meetings the user prepared for (prep_start), and records
   * the user opened from a prep view (each record once).
   */
  prep: { offered: number; prepared: number; opened: number };
}

export interface EngineState {
  events: SignalEvent[];
  data: AppData;
  view: PanelViewState;
  plan: LayoutPlan;
  /** The previous plan, for undo. */
  previousPlan: LayoutPlan | null;
  /** Last response that was applied. */
  last: AdaptResponse | null;
  history: AdaptationRecord[];
  status: EngineStatus;
  lastError: string | null;
  settings: EngineSettings;
  pinned: PanelId[];
  /**
   * Panels the user made bigger ("Make bigger"), persisted with the pins.
   * Each stays at hero size until the user makes it smaller or docks it; the
   * policy never shrinks or docks it. Reset clears the list.
   */
  bigger: PanelId[];
  /**
   * Panels in the order the user last pinned them or made them bigger,
   * newest first, persisted with the pins. With "Move pinned and bigger
   * panels to the front" on, the pinned and bigger ones lead the canvas in
   * this order (frontGroup in ./focusAids.ts). It may still name a panel
   * that is no longer pinned or bigger; that one is skipped.
   */
  front: PanelId[];
  /**
   * The panel the last pin or "Make bigger" moved to the front, the plan
   * round that moved it, and an id that goes up with every move, or null.
   * While plan.round is that round the canvas follows it once: it scrolls
   * the page to the canvas top when the front is out of view, and rings the
   * panel when it lands.
   */
  toFront: { panel: PanelId; round: number; at: number } | null;
  /** Panel id -> epoch ms when the user sent it to the dock. */
  dismissed: Partial<Record<PanelId, number>>;
  focusedPanel: PanelId | null;
  command: CommandOutcome | null;
  /** Latest inferred goal, for the header ("Looks like: Collecting payments"). */
  goal: { id: GoalId; confidence: number } | null;
  mode: LayoutMode;
  inspectorOpen: boolean;
  /** Short-lived confirmation after an action, for example "Reminder sent to Harbor Coffee Co.". */
  notice: { id: number; text: string } | null;
  /**
   * The live anchor: the panel the user just worked in. Null once released
   * (work in another panel replaces it; ANCHOR_IDLE_RELEASE_MS without work
   * clears it). plan.anchor is the anchor the current plan was built with;
   * the anchor note shows only while the two have the same `at`. The link
   * cues (tags, tints, lines) live in `links`, which can outlive the anchor.
   */
  anchor: AnchorRef | null;
  /** Where the pointer is (setPointer). A panel under it does not move or leave for a while. */
  pointer: PointerState;
  /** Canvas column count (setColumns). The grid is packed for this count. */
  columns: GridColumns;
  /**
   * The link cues on screen, or null. Set by a round built for the live
   * anchor that links panels. With settings.linkLines "stay" it lasts until
   * clearLinks, removeLink, a docked source panel (all) or linked panel
   * (that one), an undo of its round, reset, or Adaptive switching; "fade"
   * ties it to the live anchor, as before.
   */
  links: LinkSet | null;
  /** The "Up next" card's record, or null (Jev is not sure and the user is not working through a list). */
  upNext: UpNextPick | null;
  /** Shown instead of a pick when the action the user repeats through a list has no record left; null otherwise, or once dismissed. */
  upNextDone: UpNextDone | null;
  /** True while the user seems to work through a list of similar records (code's list-work signal, or Jev's listWork). */
  queueMode: boolean;
  /** Saved working contexts, most recent first, at most CONTEXTS_MAX. The "Back to" chips show the ones for another goal. */
  contexts: WorkingContext[];
  /** The goal of the current working context, or null before Jev is sure of one. */
  working: WorkingGoal | null;
  /**
   * Focus aid 2: the Done card, or null (the work is not done, the aid is
   * off, or the user started the next task or said "Not now"). While it is
   * set, it takes the Up next slot: upNext and upNextDone are null.
   */
  taskDone: TaskDoneState | null;
  /**
   * Focus aid 3: the habits learned so far, loaded from this browser at
   * start. Kept by Reset; cleared only by forgetHabits.
   */
  habits: HabitMemory;
  /**
   * Focus aid 4: the prep chip ("offer") or card ("ready"), or null (no
   * meeting within the lead time, the aid is off, or the user said "Not now").
   */
  prep: MeetingPrepState | null;
  /** Per-session measurement for the inspector's Metrics tab. */
  metrics: FlowMetrics;
}

export interface EngineActions {
  /** Record a user signal. May schedule an adaptation request (debounced). */
  track(input: TrackInput): void;
  /** Send command bar text. Judged together with the current snapshot in one Jev call. */
  runCommand(text: string): Promise<void>;
  /** Accept one of the CommandOutcome options. */
  chooseCommandOption(panel: PanelId): void;
  clearCommand(): void;
  /**
   * Pin a panel. With "Move pinned and bigger panels to the front" on it goes
   * to the first cell at once, at its size, even with the pointer on the
   * canvas; the other cards reflow. Logged as panel_pin.
   */
  pin(id: PanelId): void;
  /** Unpin a panel. It stays where it is; later rounds place it by the policy's calm rules. */
  unpin(id: PanelId): void;
  /**
   * Make a panel on the canvas bigger (hero size) at once. With "Move pinned
   * and bigger panels to the front" on it goes to the first cell as the hero
   * and the other cards reflow. Off, its top edge stays: it grows right and
   * down, or one column left when there is no room to the right, and the
   * cards in its way move. Logged as panel_maximize; it never asks Jev by
   * itself. No-op when the panel is not on the canvas or is already bigger.
   */
  maximize(id: PanelId, via?: "pointer" | "keyboard"): void;
  /** Make a panel the user made bigger smaller again, at once, and hand its size back to the policy. Logged as panel_restore. */
  restore(id: PanelId, via?: "pointer" | "keyboard"): void;
  /** Send a panel to the dock. It will not be auto-promoted for a while. */
  dismiss(id: PanelId): void;
  /** Bring a docked panel onto the canvas. */
  open(id: PanelId): void;
  setFocused(id: PanelId | null): void;
  acceptSuggestion(s: Suggestion): void;
  dismissSuggestion(s: Suggestion): void;
  /** Perform an app action directly (from a panel button or a suggestion). */
  perform(actionId: ActionId, args: { client?: string; invoiceId?: string; messageId?: string; projectId?: string; taskTitle?: string }): void;
  setView<P extends keyof PanelViewState>(panel: P, patch: Partial<PanelViewState[P]>): void;
  setNotes(text: string): void;
  toggleTask(id: string): void;
  setSettings(patch: Partial<EngineSettings>): void;
  setWeights(patch: Partial<PolicyWeights>): void;
  /**
   * Restore the previous plan, or `to` when given (the change feed passes the
   * plan from before the first change it lists, so one Undo reverts the card).
   * Right after "Back to" it puts back everything the restore replaced: the
   * layout, filters and selections, link cues, working goal, and saved contexts.
   */
  undo(to?: LayoutPlan): void;
  /** Clear events and return to the default layout. */
  reset(): void;
  /** Feed a scripted scenario's events into the log (for demos). */
  replayScenario(id: string): Promise<void>;
  /** Force an adaptation request now. */
  adaptNow(trigger?: string): Promise<void>;
  setInspectorOpen(open: boolean): void;
  clearNotice(): void;
  /**
   * The UI reports where the user's hands are. "pointer": the pointer is over
   * the canvas, so a manual pin or dock changes only that card until it
   * leaves. "keyboard": keyboard focus is moving through the canvas, so
   * automatic reflows wait until it leaves. Commands and manual edits still
   * apply at once.
   */
  setCanvasHold(source: "pointer" | "keyboard", active: boolean): void;
  /**
   * The UI reports which panel the pointer is over and whether it is
   * pressed: on pointerenter, pointerleave, pointerdown, and pointerup of each
   * card (touch reports only presses). No-op when nothing changed.
   */
  setPointer(p: PointerState): void;
  /**
   * The UI reports the canvas column count (columnsForWidth, the same
   * breakpoints as the CSS) on mount and whenever it changes. The engine
   * re-packs the current plan for the new count.
   */
  setColumns(columns: GridColumns): void;
  /** The user cleared every link cue (the links bar, or Escape). Logged as links_dismiss; it never asks Jev. */
  clearLinks(via?: "pointer" | "keyboard"): void;
  /** The user removed one linked panel's link (its tag's x button). Logged as links_dismiss; it never asks Jev. */
  removeLink(panel: PanelId): void;
  /**
   * Open a record the "Up next" card offers (its pick or an alternative, by
   * RecordCandidate id): open its panel from the dock if needed, select the
   * record through the view state the way a click does, and log
   * up_next_open. Never performs an action. No-op for a record the card does not offer.
   */
  openUpNext(id: string, via?: "pointer" | "keyboard"): void;
  /** Hide one record from the "Up next" card for UP_NEXT_DISMISS_MS. */
  dismissUpNext(id: string): void;
  /** Hide the card's completion state (upNextDone); a pick may show again. */
  dismissUpNextDone(): void;
  /**
   * Switch one focus aid on or off (docs/focus-aids.md). Persisted with the
   * other settings and logged as setting_change, which never asks Jev and
   * stays out of the snapshot. Turning "fadeQuiet" off puts back the layout
   * without quiet panels at once; turning "upNext" or "backTo" off hides
   * that feature and its key.
   */
  setFocusAid(id: FocusAidId, on: boolean, via?: "pointer" | "keyboard"): void;
  /**
   * Go "Back to" a saved working context: restore its placements, bigger
   * flags, view state, and links at once, save the context being left, log
   * context_restore, and hold the restored layout until the user does new
   * work. Pins stay as they are. An Undo right after it puts back all it
   * replaced. No-op for an unknown id or with Adaptive off.
   */
  restoreContext(id: number, via?: "pointer" | "keyboard"): void;
  /**
   * Focus aid 2: start the next task the Done card offers. Saves the current
   * context as a Back to chip, makes the task's goal the working goal, opens
   * its panel (from the dock if needed), sets its filter, selects its first
   * record through the view state (the anchor, calm relayout, and links
   * apply), and logs task_start. Never performs an action. No-op without a
   * Done card that offers a next task.
   */
  startNextTask(via?: "pointer" | "keyboard"): void;
  /** Focus aid 2, "Not now": hide the Done card for its goal for TASK_DONE_SNOOZE_MS. */
  snoozeTaskDone(): void;
  /** Focus aid 2: dismiss a Done card that offers no next task, until that goal has open work again. */
  dismissTaskDone(): void;
  /**
   * Focus aid 3: forget every habit, the sample week included: clears the
   * saved habits in this browser and the memory, and the habit guess count.
   * The layout catches up at its normal pace.
   */
  forgetHabits(): void;
  /** Focus aid 3: add a made-up week of use (marked as sample data), so the effect shows at once. Forget removes it. */
  loadSampleHabits(): void;
  /**
   * Focus aid 4: prepare for the meeting the chip offers. Saves the current
   * context as a Back to chip, makes the meeting's client the working
   * context, selects the meeting in Calendar (the anchor), filters Inbox,
   * Invoices, and Tasks to the client, and links the client's records ("For
   * the meeting") so their panels gather next to Calendar, the best first
   * by Jev's ranking. A manual edit: at once. Logs prep_start. Never
   * performs an action and never edits the notes. No-op without an offer.
   */
  prepareMeeting(via?: "pointer" | "keyboard"): void;
  /** Focus aid 4, "Not now": hide the prep chip for that meeting for the rest of the session. */
  snoozePrep(): void;
  /** Focus aid 4: close the card after Prepare (the prep view and its links stay). */
  dismissPrep(): void;
  /** Focus aid 4, a test tool: add a meeting starting SIMULATED_MEETING_IN_MS from now with a client who has recent activity. Reset removes it. */
  simulateMeeting(): void;
  /** Stop every timer and the request in flight (tests). */
  dispose(): void;
}

export type Engine = EngineState & EngineActions;

// ---------------------------------------------------------------------------
// Pure function signatures other modules rely on (scripts/eval.ts uses these).
// ---------------------------------------------------------------------------

/** ./snapshot.ts must export these three functions. They must not touch the DOM. */
export interface SnapshotContext {
  now: number;
  focusedPanel: PanelId | null;
  visiblePanels: PanelId[];
  view?: PanelViewState;
  /**
   * Focus aid 3: at most two habits in words (habitObservations in
   * ./habits.ts), added after the behavior observations. Absent (the aid is
   * off, or the eval): the snapshot is exactly as before.
   */
  habits?: string[];
}
export type DescribeEvent = (input: TrackInput) => string;
export type DeriveObservations = (events: SignalEvent[], now: number) => string[];
export type BuildSnapshot = (events: SignalEvent[], ctx: SnapshotContext) => import("../../shared/types.ts").InteractionSnapshot;

/** ./policy.ts must export computePlan and defaultPlan. Pure, no DOM, no store access. */
/**
 * The policy's input (PolicyInput in @attuneui/core: judgments, the previous
 * plan, events, weights, pins, dismissals, focus, recent modes and
 * densities, undo memory, the anchor and its linked records, holds, link
 * cues, bigger panels, quiet panels, the front group, habits), for the
 * demo's panels, with the demo's own judgments, weights, events, and habits.
 */
export interface PolicyInput extends Lib.PolicyInput<PanelId, GoalId, ActionId, Suggestion, ItemKind, HabitHints> {
  judgments: import("../../shared/types.ts").Judgments;
  previous: LayoutPlan;
  events: SignalEvent[];
  weights: PolicyWeights;
}
export type ComputePlan = (input: PolicyInput) => LayoutPlan;
export type DefaultPlan = () => LayoutPlan;

// ---------------------------------------------------------------------------
// Grid packer (@attuneui/core) and relations (./relations.ts). Pure, no DOM.
// See docs/anchored-relayout.md for the algorithm and the constants.
// ---------------------------------------------------------------------------

/**
 * The packer's types (@attuneui/core), for this app's panel ids. See PackItem,
 * PackInput, and PackResult there for what each field means.
 */
export type PackItem = Lib.PackItem<PanelId>;
export type PackInput = Lib.PackInput<PanelId>;
export type PackResult = Lib.PackResult<PanelId>;
export type PackGrid = Lib.PackGrid<PanelId>;
/** Panels an anchored round must not change. See lockedPanels in @attuneui/core. */
export type LockedPanels = Lib.LockedPanels<PanelId>;
/** Cell changes between two packed plans, for LayoutPlan.changeSummary. */
export type SummarizeChanges = (previous: LayoutPlan, next: LayoutPlan) => ChangeSummary;

/** Records in other panels linked to the anchor, by joining app data. Excludes the anchor's own panel; omits panels with none. */
export type FindLinked = (anchor: AnchorRef, data: AppData) => Partial<Record<PanelId, RelatedRecord[]>>;
/** Short name for an anchor's tag, from its record or client. */
export type AnchorLabel = (ref: Pick<AnchorRef, "itemKind" | "itemId" | "client">, data: AppData) => string | undefined;
/** Tag and reason for one linked panel. */
export type RelationFor = (anchor: AnchorRef, panel: PanelId, records: RelatedRecord[]) => PanelRelation;
