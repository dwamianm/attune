/**
 * Wire contract between the browser and the Node server, plus the layout
 * types the client engine produces. Both sides import from here.
 *
 * Flow:
 *   UI signals -> engine event log -> InteractionSnapshot (plain words)
 *   -> POST /api/adapt -> server asks Jev -> Judgments (typed, with probabilities)
 *   -> client layout policy (code) -> LayoutPlan -> animated canvas
 *
 * Jev only supplies judgments. All thresholds, weights, hysteresis, and the
 * final layout are decided in client code (src/engine/policy.ts).
 */
import type {
  BlendWeights,
  ChangeSummary as LibChangeSummary,
  ChoiceJudgment,
  CoreCommandJudgments,
  CoreSignalType,
  Decision as LibDecision,
  Density,
  HelpLevel,
  CoreJudgments,
  GridCell,
  GridColumns,
  InteractionSnapshot,
  PanelSize,
  ScoreJudgment,
} from "@attune/core";
import type { ActionId, GoalId, LayoutMode, PanelId } from "./catalog.ts";

export type { ChoiceJudgment, Density, GridCell, GridColumns, HelpLevel, InteractionSnapshot, PanelSize, ScoreJudgment } from "@attune/core";

// ---------------------------------------------------------------------------
// Signals captured in the browser
// ---------------------------------------------------------------------------

/**
 * The core signal types (CoreSignalType in @attune/core: panel focus, open,
 * dismiss, pin, unpin, dwell, maximize, restore, item open, search, filter,
 * action, command, shortcut, scroll, suggestion accept and dismiss, undo),
 * plus the demo's own.
 */
export type SignalType =
  | CoreSignalType
  | "links_dismiss" // cleared the link cues, or removed one (detail.linkedPanel); logged for the inspector, never read by Jev
  | "up_next_open" // opened the record offered in the "Up next" card (detail.itemId, detail.via)
  | "context_save" // the engine saved the previous working context because the goal changed (detail.label)
  | "context_restore" // the user went "Back to" a saved working context (detail.label)
  | "setting_change" // the user switched a focus aid on or off (detail.setting, detail.enabled, detail.label); logged for the inspector, never read by Jev
  | "task_done" // the engine said the working goal is done (detail.label, detail.task when it offered a next task); logged for the inspector, never read by Jev
  | "task_start" // the user started the next task from the Done card (detail.task, and the first record in detail.itemKind, itemId, client, label)
  | "prep_offer" // the engine offered to prepare for a meeting about to start (the event in detail.itemId, client, label); logged for the inspector, never read by Jev
  | "prep_start"; // the user pressed Prepare (or p) for a meeting (the event in detail.itemKind, itemId, client, label)

export type ItemKind = "invoice" | "message" | "client" | "project" | "task" | "event" | "person" | "note";

export interface SignalDetail {
  label?: string;
  query?: string;
  filter?: Record<string, string>;
  itemKind?: ItemKind;
  itemId?: string;
  /** Client company the record belongs to, when there is one. */
  client?: string;
  actionId?: ActionId;
  durationMs?: number;
  key?: string;
  via?: "pointer" | "keyboard" | "command" | "suggestion";
  /** links_dismiss: the linked panel whose link was removed. Absent when every link was cleared. */
  linkedPanel?: PanelId;
  /** setting_change: which focus aid the user switched (a FocusAidSettings key, for example "fadeQuiet"). */
  setting?: string;
  /** setting_change: true when the user switched it on, false when off. */
  enabled?: boolean;
  /** task_start and task_done: the next task in words, for example "two unread client messages". */
  task?: string;
}

/** What UI code passes to `track()`. The engine adds id, time, and text. */
export interface TrackInput {
  type: SignalType;
  panel?: PanelId;
  detail?: SignalDetail;
}

export interface SignalEvent extends TrackInput {
  id: number;
  /** Milliseconds since epoch. */
  t: number;
  /** One plain-English sentence describing the event, built by describeEvent(). */
  text: string;
}

// ---------------------------------------------------------------------------
// Request: what the client sends to the server. The snapshot shape
// (InteractionSnapshot) comes from @attune/core.
// ---------------------------------------------------------------------------

/** Longest command the server reads. The command bar caps input at this, and the server clips longer text. */
export const COMMAND_MAX_LENGTH = 300;

/**
 * A record the user might open or work on next. Built by client code
 * (src/engine/nextUp.ts) from the data and the current context; Jev only
 * selects among these (select, do not generate).
 */
export interface RecordCandidate {
  /** Stable id, "<kind>:<record id>", for example "invoice:INV-1038". */
  id: string;
  kind: ItemKind;
  panel: PanelId;
  /** Plain words, for example "INV-1038 · Meridian Hotels · overdue 36 days · $12,800". */
  label: string;
  client?: string;
  /** Code-derived hint in words, for example "next overdue invoice in the list" or "unread". */
  why?: string;
}

/**
 * Pending work the user might start next, once the current work is done
 * (focus aid 2, docs/focus-aids.md). Built by client code
 * (src/engine/taskDone.ts), one per goal other than the working goal; Jev
 * only selects among these (select, do not generate).
 */
export interface TaskCandidate {
  /** Stable id, for example "unread_messages". */
  id: string;
  /** The goal this work belongs to. */
  goal: GoalId;
  /** What the work is, in plain words, for example "Unread client messages to reply to". */
  label: string;
  /** How many records it covers, in words, for example "two". */
  count: string;
  /** The first record, in the same words as the record labels, for example "\"Re: Invoice INV-1042\" from Priya Nair at Harbor Coffee Co.". */
  first: string;
}

/**
 * The record the user just clicked, in words, for the link questions
 * ("Arrange linked panels by next step", docs/anchored-relayout.md). Built
 * by client code (src/engine/linkFlow.ts) from the app data, field by field.
 */
export interface ClickedRecord {
  /** "<kind>:<record id>", for example "message:m-1". */
  id: string;
  /** Only these kinds are asked about: message, invoice, task, project, event. */
  kind: ItemKind;
  /**
   * The record's words, for example { from: "Priya Nair", client: "Harbor
   * Coffee Co.", subject: "Re: Invoice INV-1042", text: "Sorry for the
   * delay..." } for a message, or { id, client, status, amount, due } for an
   * invoice. Short: a message's text is clipped to about 300 characters.
   */
  fields: Record<string, string>;
}

/** The clicked record and the records linked to it. Present: adds the link-next and link-action questions. */
export interface LinkRequest {
  clicked: ClickedRecord;
  /** Records in other panels linked to the clicked one (at most 8), each with why it is linked in `why`. Jev selects among these. */
  records: RecordCandidate[];
}

/** The goal of the user's current working context, in words (GOALS in shared/catalog.ts). */
export interface WorkingGoalWords {
  /** For example "Collecting payments". */
  label: string;
  /** For example "Checking unpaid or overdue invoices and getting clients to pay them.". */
  description: string;
}

export interface AdaptRequest {
  /** Monotonic client state version. Echoed back so the client can drop stale answers. */
  version: number;
  snapshot: InteractionSnapshot;
  /** Candidate values Jev may select from (select, do not generate). */
  candidates: {
    clients: string[];
    /** At most 12 records the user might work on next. Omitted or empty: no next-record question. */
    records?: RecordCandidate[];
    /** At most 5 tasks the user might start after the current work. Omitted or empty: no next-task question. */
    tasks?: TaskCandidate[];
  };
  /** Present when the user typed into the command bar. Adds command questions. */
  command?: string;
  /** The goal of the current working context (focus aid 2). Present: adds the goal-done question. */
  workingGoal?: WorkingGoalWords;
  /**
   * The record the user just clicked and its linked records ("Arrange linked
   * panels by next step"). Present: adds the link-next and link-action
   * questions. Sent once per click, only while the aid is on.
   */
  link?: LinkRequest;
}

// ---------------------------------------------------------------------------
// Response: typed judgments from Jev (or the heuristic fallback). The core
// judgments and the Choice and Score shapes come from @attune/core.
// ---------------------------------------------------------------------------

export const INVOICE_STATUS_ARGS = ["overdue", "unpaid", "paid", "draft", "all", "not_mentioned"] as const;
export type InvoiceStatusArg = (typeof INVOICE_STATUS_ARGS)[number];

export const TIMEFRAME_ARGS = ["today", "this_week", "this_month", "not_mentioned"] as const;
export type TimeframeArg = (typeof TIMEFRAME_ARGS)[number];

/** Only present when AdaptRequest.command was set. The panel and the action are the core command judgments. */
export interface CommandJudgments extends CoreCommandJudgments<PanelId, ActionId> {
  invoiceStatus: ChoiceJudgment<InvoiceStatusArg>;
  /** One of AdaptRequest.candidates.clients, or "not_mentioned". */
  client: ChoiceJudgment<string>;
  timeframe: ChoiceJudgment<TimeframeArg>;
}

/** The core judgments (goal, relevance, struggling, layout, expertise, next action) and the demo's own. */
export interface Judgments extends CoreJudgments<PanelId, GoalId, ActionId> {
  /** Which client the current work is about: a candidate name or "none". */
  targetClient: ChoiceJudgment<string>;
  /** Which RecordCandidate id the user will most likely work on next, or "none". Absent when no candidates were sent. */
  nextRecord?: ChoiceJudgment<string>;
  /** Noul: probability the user is working through a list of similar records one at a time. */
  listWork?: number;
  /** Noul: probability the user has finished the work in the working goal. Absent when no working goal was sent. */
  goalDone?: number;
  /** Which TaskCandidate id the user will most likely start next, or "none". Absent when no task candidates were sent. */
  nextTask?: ChoiceJudgment<string>;
  /** Which linked record (a LinkRequest.records id) the user needs next to do what the clicked record asks, or "none". Absent when no link was sent. */
  linkNext?: ChoiceJudgment<string>;
  /** What the clicked record asks the user to do, or "none" when it asks for nothing. Absent when no link was sent. */
  linkAction?: ChoiceJudgment<ActionId>;
  command?: CommandJudgments;
}

export interface AdaptResponse {
  version: number;
  source: "jev" | "heuristic";
  judgments: Judgments;
  meta: {
    /** Versioned model id that answered, for example "jev-1.13.0", or "heuristic". */
    model: string;
    latencyMs: number;
    usage?: { input_tokens: number; output_tokens: number };
    requestId?: string;
    questionCount: number;
    /** Set when Jev failed and the heuristic answered instead. */
    error?: string;
    /**
     * Why the heuristic answered: "no_key" is the designed offline mode (no
     * JEV_API_KEY), "jev_error" is a real failure. Absent on Jev answers.
     */
    fallback?: "no_key" | "jev_error";
  };
  /** Exactly what was sent to Jev, for the inspector. */
  debug: {
    state: unknown;
    questions: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Meeting prep (focus aid 4, docs/focus-aids.md, "Aid 4"): POST /api/prep.
// Its own request, since its state is the meeting, not the user's activity.
// ---------------------------------------------------------------------------

/** The meeting about to start, in words. Code computes the time words; Jev cannot do clock math. */
export interface PrepMeetingWords {
  /** For example "Harbor rebrand review". */
  title: string;
  /** The client company, one of the studio's clients. */
  client: string;
  /** For example "starts in 12 minutes, at 11:00 today". */
  time: string;
  kind: "meeting" | "call";
}

/**
 * One record that may matter for the meeting, in words, field by field.
 * Built by client code (src/engine/meetingPrep.ts) from the data: a recent
 * message from the client (its text clipped to about 200 characters), an
 * open invoice, the client's project, or an open task.
 */
export interface PrepRecord {
  /** "<kind>:<record id>", for example "invoice:INV-1042". */
  id: string;
  /** Only these kinds are sent: message, invoice, project, task. */
  kind: ItemKind;
  panel: PanelId;
  /** For example { id: "INV-1042", status: "overdue", due: "14 days overdue", amount: "$4,200" }. */
  fields: Record<string, string>;
}

export interface PrepRequest {
  /** Client counter, echoed back, so the client can drop an answer for records that changed since. */
  version: number;
  meeting: PrepMeetingWords;
  /** At most 10. Jev scores each one (select and rank, never generate). */
  records: PrepRecord[];
}

export interface PrepJudgments {
  /** One comparable Score per record, keyed by PrepRecord id: how much the user needs it before the meeting. */
  scores: Record<string, ScoreJudgment>;
  /** Noul: probability that some record needs the user to act before the meeting starts. */
  anythingUrgent: number;
}

export interface PrepResponse {
  version: number;
  source: "jev" | "heuristic";
  judgments: PrepJudgments;
  /** The same fields as an adapt answer: model, latency, tokens, and why the heuristic answered. */
  meta: AdaptResponse["meta"];
  /** Exactly what was sent to Jev, for the inspector. */
  debug: {
    state: unknown;
    questions: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Layout plan: what the client policy produces from judgments. The size and
// cell types (PanelSize, GridCell, GridColumns) come from @attune/core.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Anchored relayout (docs/anchored-relayout.md). All fields below are
// optional on the plan, so plans built before this feature stay valid.
// ---------------------------------------------------------------------------

/**
 * The panel the user just worked in, and the record or client that work was
 * about. During the relayout that follows, a "work" anchor's top-left stays
 * still on screen and everything else moves around it.
 */
export interface AnchorRef {
  panel: PanelId;
  itemKind?: ItemKind;
  itemId?: string;
  /** Client company the work was about, when there is one. */
  client?: string;
  /** Short name for tags, for example "INV-1042", "Priya Nair", or "Harbor Coffee Co.". */
  label?: string;
  /** Epoch ms when this anchor was set. Also its identity: new work makes a new anchor. */
  at: number;
  /**
   * "work" (or absent): a click or keystroke inside the panel; its top-left is held.
   * "command": the panel the command bar asked for; it still goes to the front
   * as the hero, and gets the same link color, lines, and tags.
   */
  source?: "work" | "command";
}

/** One record in another panel that code joined to the anchor (no model call). */
export interface RelatedRecord {
  itemKind: ItemKind;
  /** The same id the row carries in data-item-id, for example "m-1" or "c-harbor". */
  itemId: string;
  /** Readable name, for example "Priya Nair: Re: Invoice INV-1042". */
  label: string;
}

/** Why a panel is linked to the anchor. Set on at most LINKED_PANELS_MAX placements. */
export interface PanelRelation {
  anchorPanel: PanelId;
  /** Header tag, for example "Linked to INV-1042" (the client name when the anchor has no record). */
  tag: string;
  /** Hover and focus text, for example "2 messages from Harbor Coffee Co.". */
  reason: string;
  /** Linked records in this panel, most useful first, never empty. The UI tints the ones it shows. */
  records: RelatedRecord[];
}

/** Explicit cells for every placement, packed for one column count. */
export interface PlanGrid {
  columns: GridColumns;
  cells: Partial<Record<PanelId, GridCell>>;
  /** Rows in use (largest row + h), so the canvas can reserve its height. */
  rows: number;
  /** True when this round kept the anchor's top-left (a work anchor that was already on the canvas). */
  anchored: boolean;
}

/**
 * What happened to each panel's cell versus the previous plan (ChangeSummary
 * in @attune/core, for this app's panel ids).
 */
export type ChangeSummary = LibChangeSummary<PanelId>;

export interface PanelPlacement {
  id: PanelId;
  size: PanelSize;
  /** Final blended priority, 0..1 (plus pin boost). */
  priority: number;
  pinned: boolean;
  /** Why the panel is here and this big, in one short sentence. */
  reason: string;
  /** Set on the plan that changed this panel, cleared on the next plan. */
  change: "promoted" | "demoted" | "added" | null;
  /** How the priority was built, for the inspector. Each part is already weighted. */
  breakdown?: {
    relevance: number;
    usage: number;
    goal: number;
    pin: number;
    /** Focus aid 3: the weighted habit part. Present only in a round that used a habit (docs/focus-aids.md, "Aid 3"). */
    habit?: number;
  };
  /** Epoch ms when the policy brought this panel onto the canvas, for the minimum stay. */
  addedAt?: number;
  /** True on the anchor's placement (the panel just worked in, or a command's hero). */
  anchor?: boolean;
  /** Set when this panel holds records linked to the plan's anchor. */
  relation?: PanelRelation;
  /**
   * True when the user made this panel bigger ("Make bigger"). It stays at
   * hero size until the user makes it smaller or docks it; the policy never
   * shrinks or docks it. Absent: the policy decides its size.
   */
  bigger?: boolean;
  /**
   * True when the focus aid "Fade panels that do not matter now" judged this
   * panel quiet (docs/focus-aids.md): the UI shows it faded, with a "Quiet"
   * label, and `reason` says why. Absent: a normal panel.
   */
  quiet?: boolean;
  /**
   * Set only when being quiet made the panel smaller: the size it had
   * before, which it goes back to when the user clicks into it.
   */
  unquietSize?: PanelSize;
}

export interface Suggestion {
  actionId: ActionId;
  label: string;
  prominence: "primary" | "subtle";
  confidence: number;
  /** The exact record the action will act on, so the label and the action agree. */
  args: { client?: string; invoiceId?: string; messageId?: string; projectId?: string; taskId?: string };
  reason: string;
  /**
   * True for the step Jev read from the record the user clicked (its
   * link-action), offered once the record it acts on is open. The panel
   * rings the matching button. Absent: an ordinary suggestion.
   */
  nextStep?: boolean;
  /**
   * A follow-up that checks off this to-do item after the step it names was
   * done. It is not a catalog action, so actionId is "none"; accepting it
   * checks off exactly this task, never on its own.
   */
  task?: { id: string; title: string };
  /**
   * Focus aid 3: offered because the user usually takes this action after
   * opening a record of this kind, while Jev was unsure of the next step.
   * Always subtle, never performed on its own; its chip says "Habit"
   * instead of Jev's probability. Absent: an ordinary suggestion.
   */
  habit?: boolean;
  /**
   * Focus aid 4, "Prepare for meetings": the "Start meeting notes" offer
   * after Prepare. Accepting it appends `heading` to the notes and opens
   * Notes; nothing is written until the user presses it. Its actionId is
   * "write_note". Absent: an ordinary suggestion.
   */
  meetingNotes?: { eventId: string; heading: string };
}

/** One change the policy made or held back, in words (Decision in @attune/core), for the demo's panels. */
export type Decision = LibDecision<PanelId>;

export interface LayoutPlan {
  mode: LayoutMode;
  /** Panels on the canvas, in display order. */
  placements: PanelPlacement[];
  /** Panels available in the dock (not on the canvas). */
  docked: PanelId[];
  density: Density;
  suggestions: Suggestion[];
  help: HelpLevel;
  /** What changed versus the previous plan, and why. */
  decisions: Decision[];
  /** Version of the AdaptResponse this plan came from, 0 for the default plan. */
  basedOnVersion: number;
  /** Panel id -> epoch ms when the policy (not the user) moved it to the dock, for the minimum stay there. */
  autoDockedAt?: Partial<Record<PanelId, number>>;
  /** The anchor this plan was built around. Absent or null: none. */
  anchor?: AnchorRef | null;
  /** Cell changes versus the previous plan, for the staged choreography. Absent: nothing to stage. */
  changeSummary?: ChangeSummary;
  /**
   * Increases by 1 whenever membership, a size, a cell, or anchor.at changes
   * (suggestion-only updates keep it). Absent means 0. The UI plays one
   * choreography per round and keys it on this number.
   */
  round?: number;
  /** Explicit cells from packGrid (@attune/core). Absent: the canvas falls back to the CSS dense flow. */
  grid?: PlanGrid;
}

/** The blend's weights (BlendWeights in @attune/core: relevance, usage, goal), plus the habit weight. */
export interface PolicyWeights extends BlendWeights {
  /**
   * Focus aid 3, "Learn my habits" (docs/focus-aids.md): weight on the
   * learned chance that the user goes to a panel next. Added on top of the
   * three parts above (not blended with them), and only with the aid on and
   * a habit with enough evidence, so without one every priority is as
   * before. Absent: HABIT_WEIGHT (src/engine/habits.ts).
   */
  habit?: number;
}
