/**
 * The demo's adaptation engine: the library's adaptive loop
 * (createAdaptiveEngine in @attuneui/core) in one zustand store, with the
 * demo's own parts as its extension.
 *
 * UI code reads state with useEngine(selector) and reports what the user does
 * with track(). The loop (the event log, the scheduler, requests and answers,
 * the policy, the place step, the anchor, the holds, undo, commands) is the
 * library's. This file adds what only the demo has, through the loop's hooks:
 * the app data and the panel views, the link cues that outlive the anchor,
 * the next step, the focus aids (quiet panels, Up next and Back to, the Done
 * card, habits, meeting prep), the front group, saved settings, the metrics,
 * the command's view changes, and the scenario replay. Its bookkeeping lives
 * in the extension's closure because it is not UI state.
 *
 * Safe to import anywhere: it never touches window or localStorage at import
 * time without a guard, so Node (tests) and browsers with blocked storage work.
 */
import { create } from "zustand";
import { ACTIONS, CATALOG, GOALS, panelTitle, type ActionId, type GoalId, type PanelId } from "../../shared/catalog.ts";
import { CLIENT_NAMES, CURRENT_USER, EVENTS, INVOICES, MESSAGES, PROJECTS, TASKS, type Invoice } from "../../shared/fixtures.ts";
import { SCENARIOS, type ScenarioStep } from "../../shared/scenarios.ts";
import type { CalendarEvent } from "../../shared/fixtures.ts";
import {
  COMMAND_MAX_LENGTH,
  type AdaptRequest,
  type AdaptResponse,
  type AnchorRef,
  type ChoiceJudgment,
  type ItemKind,
  type Judgments,
  type LayoutPlan,
  type LinkRequest,
  type PolicyWeights,
  type PrepRequest,
  type RelatedRecord,
  type SignalEvent,
  type SignalType,
  type Suggestion,
  type TrackInput,
} from "../../shared/types.ts";
import { clockTime, eventLabel } from "../ui/format.ts";
import { commandFailureMessage, isAbortError, postAdapt, postPrep, watchHealth } from "./api.ts";
import { resolveCommand, type CommandResolution, type ViewPatch } from "./command.ts";
import { addContext, commandSwitchesArea, contextClient, contextLabel, judgeSwitch, panelGoal, restoredPlan, type PendingSwitch } from "./contexts.ts";
import type {
  AppData,
  CommandOutcome,
  Engine,
  EngineActions,
  EngineSettings,
  EngineState,
  LinkSet,
  MeetingPrepState,
  PanelViewState,
  PolicyInput,
  PrepRanking,
  TaskDoneState,
  WorkingContext,
  WorkingGoal,
} from "./contract.ts";
import {
  arrangeLinksOn,
  backToOn,
  DEFAULT_FOCUS_AIDS,
  FOCUS_AID_TEXT,
  fadeQuietOn,
  frontGroup,
  habitsOn,
  meetingPrepOn,
  moveToFrontOn,
  readFocusAids,
  taskDoneOn,
  upNextOn,
} from "./focusAids.ts";
import {
  createAdaptiveEngine,
  HISTORY_LIMIT,
  shownQuiet,
  SIZE_RANK,
  touchQuiet,
  withGrid,
  withoutQuiet,
  type AdaptiveHooks,
  type AdaptiveKernel,
  type AdaptiveSpec,
  type AdaptiveState,
  type AdaptiveActions,
} from "@attuneui/core";
import {
  clearSavedHabits,
  emptyHabits,
  emptyTrail,
  HABIT_SESSION_GAP_MS,
  HABIT_TASK_WHY,
  HABIT_WEIGHT,
  habitHints,
  habitObservations,
  habitStep,
  habitTaskBoost,
  learnGoal,
  loadHabits,
  mergeHabits,
  sampleWeek,
  saveHabits,
  topNextPanel,
  type HabitContext,
  type HabitTrail,
} from "./habits.ts";
import { FOLLOW_UP_MS, followUpSuggestion, followUpTask, linkPanelOrder, linkRequestFor, linkStepFrom, stepLive, stepSuggestion, type LinkStep } from "./linkFlow.ts";
import {
  buildPrepPlan,
  buildPrepRecords,
  isPrepLead,
  meetingUnderway,
  notesHeading,
  PREP_NOTES_LABEL,
  PREP_RECHECK_MS,
  prepLeadMs,
  prepMeetingWords,
  prepPanels,
  prepSignature,
  prepViewPatches,
  rankingFrom,
  simulatedMeeting,
  upcomingMeeting,
  urgentLine,
  withNotesHeading,
} from "./meetingPrep.ts";
import { editPlan, isPanelId, POLICY, suggestionRecord, traditionalPlan, type PolicyLiveData } from "./policy.ts";
import { countQuietRound, emptyQuietTrack, isQuietTouch, quietPanels, type QuietTrack } from "./quiet.ts";
import { anchorLabel, clientNamedIn, findLinked, kindOfId } from "./relations.ts";
import {
  emptyMetrics,
  metricsOnEvent,
  metricsOnHabitGuess,
  metricsOnLayoutChange,
  metricsOnPrepOpened,
  metricsOnQuietReopened,
  metricsOnQuietWent,
  metricsOnUpNextShown,
  recordRoundPrediction,
} from "./metrics.ts";
import {
  actionApplies,
  buildRecordCandidates,
  chooseUpNext,
  currentRecord,
  detectListWork,
  handledRecords,
  listSkip,
  makeCandidate,
  nextInList,
  parseRecordKey,
  queueDone,
  queueModeOn,
  recordKey,
  revealPatch,
  UP_NEXT_DISMISS_MS,
  upNextKey,
} from "./nextUp.ts";
import { LOCAL_REPLAN_TYPES, triggersRequest } from "./scheduler.ts";
import { actionPast, buildSnapshot, describeEvent, SIGNAL_PROFILE, WORDS } from "./snapshot.ts";
import {
  buildNextTasks,
  chooseNextTask,
  countDoneRound,
  emptyDoneRounds,
  goalFact,
  hasGoalFact,
  judgeTaskDone,
  mightBeDone,
  TASK_CANDIDATES_MAX,
  TASK_DONE_JEV_AT,
  TASK_DONE_SNOOZE_MS,
  taskViewPatch,
  type DoneRounds,
} from "./taskDone.ts";

// The loop's thresholds, for the UI and the tests.
export {
  ANCHOR_IDLE_RELEASE_MS,
  ANCHOR_PRESS_WINDOW_MS,
  COMMAND_HOLD_MS,
  EVENT_LOG_LIMIT,
  HISTORY_LIMIT,
  MANUAL_EDIT_HOLD_MS,
  POINTER_LEAVE_HOLD_MS,
  POINTER_MOVE_HOLD_MS,
  RECENT_DENSITIES_LIMIT,
  RECENT_MODES_LIMIT,
  UNDO_HOLD_MS,
  UNDO_MEMORY_MS,
  UNDO_TOP_PANEL_MARGIN,
} from "@attuneui/core";

/** localStorage key for settings, pins, and the panels the user made bigger. */
export const STORAGE_KEY = "floouid:v1";
/** Default pause between scenario replay steps. */
export const REPLAY_STEP_MS = 800;
/**
 * Events that make the panel they happen in (or the pressed card) the anchor.
 * Opening a panel from the dock counts: the user asked for that card, so the
 * next round keeps it and everything before it where they are.
 */
const ANCHOR_TYPES: ReadonlySet<SignalType> = new Set<SignalType>(["item_open", "up_next_open", "task_start", "filter", "action", "search", "panel_focus", "panel_open"]);
/** Events that mean the user acted, not just looked or moved focus. They end a keyboard or pointer hold. */
const REAL_ACTION_TYPES: ReadonlySet<SignalType> = new Set<SignalType>(["item_open", "up_next_open", "task_start", "prep_start", "filter", "search", "action", "suggestion_accept"]);
/**
 * Events that end the hold on a layout the user went "Back to": new work
 * (docs/predictive-flow.md). Looking around (focus, pointer rests, scrolls)
 * does not, so the restored layout stays put while the user reads it.
 */
const CONTEXT_HOLD_END_TYPES: ReadonlySet<SignalType> = new Set<SignalType>(["item_open", "up_next_open", "task_start", "filter", "search", "action", "suggestion_accept", "command"]);
/** History text for a round whose layout waited because the user went back to a saved working context. */
const CONTEXT_HOLD_TEXT = "Kept the layout you went back to until you start new work";
/** Events that make their panel the focused one. */
const FOCUS_TYPES: ReadonlySet<SignalType> = new Set<SignalType>(["panel_focus", "item_open", "up_next_open", "task_start"]);
/**
 * Events left out of the density rule's count: pointer rests are passive,
 * and a saved working context, a settings switch, a task marked done, or a
 * prep offer is the engine's own note or the user's setup, not the work.
 */
const DENSITY_IGNORES: ReadonlySet<SignalType> = new Set<SignalType>(["panel_dwell", "context_save", "setting_change", "task_done", "prep_offer"]);

export const DEFAULT_SETTINGS: EngineSettings = {
  adaptive: true,
  frozen: false,
  // The habit part (focus aid 3) is added on top of the other three, not blended with them.
  weights: { relevance: 0.5, usage: 0.25, goal: 0.25, habit: HABIT_WEIGHT },
  minChangeIntervalMs: 2_500,
  // The user asked for the link cues to stay until they dismiss them.
  linkLines: "stay",
  focusAids: { ...DEFAULT_FOCUS_AIDS },
};

// ---------------------------------------------------------------------------
// Initial data and persistence
// ---------------------------------------------------------------------------

function freshData(): AppData {
  return {
    invoices: structuredClone(INVOICES),
    messages: structuredClone(MESSAGES),
    tasks: structuredClone(TASKS),
    projects: structuredClone(PROJECTS),
    events: structuredClone(EVENTS),
    notes: "",
  };
}

function defaultView(): PanelViewState {
  return {
    inbox: { query: "", selectedId: null, client: null },
    invoices: { status: "all", client: null, selectedId: null },
    clients: { selected: null, query: "" },
    tasks: { showDone: false, client: null, selectedId: null },
    projects: { status: "all", selectedId: null },
    calendar: { range: "today", selectedId: null },
    analytics: { range: "this_year" },
    team: {},
    notes: {},
    help: {},
  };
}

function storage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Settings, pins, bigger panels, and the front order from localStorage, with safe defaults for anything missing or unreadable. Exported for tests. */
export function loadPersisted(): { settings: EngineSettings; pinned: PanelId[]; bigger: PanelId[]; front: PanelId[] } {
  const fallback = { settings: structuredClone(DEFAULT_SETTINGS), pinned: [] as PanelId[], bigger: [] as PanelId[], front: [] as PanelId[] };
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as { settings?: Partial<EngineSettings>; pinned?: unknown; bigger?: unknown; front?: unknown };
    const s = parsed.settings ?? {};
    const w: Partial<PolicyWeights> = s.weights ?? {};
    return {
      settings: {
        adaptive: typeof s.adaptive === "boolean" ? s.adaptive : DEFAULT_SETTINGS.adaptive,
        frozen: typeof s.frozen === "boolean" ? s.frozen : DEFAULT_SETTINGS.frozen,
        weights: {
          relevance: num(w.relevance, DEFAULT_SETTINGS.weights.relevance),
          usage: num(w.usage, DEFAULT_SETTINGS.weights.usage),
          goal: num(w.goal, DEFAULT_SETTINGS.weights.goal),
          // Stored since focus aid 3; an older save has none, which the policy reads as HABIT_WEIGHT.
          ...(w.habit !== undefined ? { habit: num(w.habit, HABIT_WEIGHT) } : {}),
        },
        minChangeIntervalMs: num(s.minChangeIntervalMs, DEFAULT_SETTINGS.minChangeIntervalMs),
        linkLines: s.linkLines === "stay" || s.linkLines === "fade" ? s.linkLines : DEFAULT_SETTINGS.linkLines,
        // Stored since the focus aids; older saves have none, and each missing flag takes its default.
        focusAids: readFocusAids(s.focusAids),
        // Stored since focus aid 4; an older save has none, which means PREP_LEAD_DEFAULT.
        ...(isPrepLead(s.prepLeadMin) ? { prepLeadMin: s.prepLeadMin } : {}),
      },
      pinned: Array.isArray(parsed.pinned) ? [...new Set(parsed.pinned.filter(isPanelId))] : [],
      // Stored since "Make bigger"; older saves have none.
      bigger: Array.isArray(parsed.bigger) ? [...new Set(parsed.bigger.filter(isPanelId))] : [],
      // Stored since "Move pinned and bigger panels to the front"; older saves have none, and frontGroup keeps their pins in pin order.
      front: Array.isArray(parsed.front) ? [...new Set(parsed.front.filter(isPanelId))] : [],
    };
  } catch {
    return fallback;
  }
}

/** Save settings, pins, bigger panels, and the front order (when given). Storage can be full or blocked; then nothing is saved. Exported for tests. */
export function persist(settings: EngineSettings, pinned: PanelId[], bigger: PanelId[], front?: PanelId[]): void {
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify({ settings, pinned, bigger, ...(front ? { front } : {}) }));
  } catch {
    // Storage can be full or blocked; the app works without it.
  }
}

function without<T extends string>(map: Partial<Record<T, number>>, key: T): Partial<Record<T, number>> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}


type PerformArgs = { client?: string; invoiceId?: string; messageId?: string; projectId?: string; taskTitle?: string };
type Via = NonNullable<TrackInput["detail"]>["via"];

/** Two suggestions offer the same thing on the same record. */
function sameSuggestion(a: Suggestion, b: Suggestion): boolean {
  return (
    a.actionId === b.actionId &&
    a.label === b.label &&
    (a.args.client ?? "") === (b.args.client ?? "") &&
    (suggestionRecord(a) ?? "") === (suggestionRecord(b) ?? "")
  );
}

function suggestionIdentity(s: Suggestion): string {
  return `${s.actionId}|${s.prominence}|${s.label}|${suggestionRecord(s) ?? ""}`;
}

/** The name the link cues go by: the clicked record, else its client, else the source panel. */
export function linkLabel(links: LinkSet): string {
  return links.source.label ?? links.source.client ?? panelTitle(links.source.panel);
}

/** Same source, panels, and records: a refresh of the same links, not a new set. */
function sameLinks(a: LinkSet | null, b: LinkSet | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.source.at !== b.source.at) return false;
  const key = (l: LinkSet) =>
    (Object.entries(l.relations) as [PanelId, NonNullable<LinkSet["relations"][PanelId]>][])
      .map(([id, r]) => `${id}:${r.tag}:${r.records.map((x) => x.itemId).join("+")}`)
      .join(",") + (l.next ? `|next:${l.next.panel}:${l.next.record}:${l.next.text}` : "");
  return key(a) === key(b);
}


/** Same members, in any order. */
function sameSet(a: PanelId[], b: PanelId[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}


/**
 * What the last "Back to" replaced, while its plan is on screen, so an Undo
 * right after it brings all of it back: the plan, the view state (filters and
 * selections), the link cues, the docked marks, the working goal, and the
 * saved contexts. Bigger panels ride on the plan.
 */
interface BackToUndo {
  round: number;
  plan: LayoutPlan;
  view: PanelViewState;
  links: LinkSet | null;
  dismissed: EngineState["dismissed"];
  working: WorkingGoal | null;
  contexts: WorkingContext[];
}

/** The demo's types for the library loop. */
interface DemoSpec extends AdaptiveSpec {
  panel: PanelId;
  goal: GoalId;
  action: ActionId;
  kind: ItemKind;
  eventType: SignalType;
  input: TrackInput;
  event: SignalEvent;
  suggestion: Suggestion;
  judgments: Judgments;
  response: AdaptResponse;
  request: AdaptRequest;
  policyInput: PolicyInput;
  policyExtra: PolicyLiveData;
  outcome: CommandOutcome;
  resolution: CommandResolution;
  settings: EngineSettings;
  state: Omit<EngineState, keyof AdaptiveState<AdaptiveSpec>>;
  actions: Omit<EngineActions, keyof AdaptiveActions<AdaptiveSpec>>;
}

type Kernel = AdaptiveKernel<DemoSpec>;

// ---------------------------------------------------------------------------
// The extension: the demo's own state, bookkeeping, hooks, and actions
// ---------------------------------------------------------------------------

function demoExtension(k: Kernel) {
  const { get, set } = k;
  const persisted = loadPersisted();

  // Bookkeeping. Not UI state, so not in the store.
  let noticeSeq = 0;
  let newItemSeq = 0;
  let replayToken = 0;
  let replayCancel: (() => void) | null = null;

  // Anchored relayout (docs/anchored-relayout.md).
  /**
   * What the user dismissed from one click's links (the anchor's `at`): every
   * link, or some panels. A later round for the same click must not bring
   * them back.
   */
  let linkDrops: { at: number; all: boolean; panels: Set<PanelId> } | null = null;
  // Predictive flow (docs/predictive-flow.md).
  /** RecordCandidate id -> epoch ms when the user dismissed it from the Up next card. */
  let upNextDismissed: Record<string, number> = {};
  let upNextTimer: ReturnType<typeof setTimeout> | null = null;
  /** When the judgments in `last` arrived, so Up next can tell an action that came after them. */
  let judgedAt: number | null = null;
  /** A goal switch Jev judged once, when it began, and the working context as it was before that round. */
  let goalSwitch: { pending: PendingSwitch; at: number; before: WorkingContext } | null = null;
  let contextSeq = 0;
  /** True after "Back to": automatic changes wait until the user does new work (CONTEXT_HOLD_END_TYPES). */
  let contextHold = false;
  /** Answers to requests sent before a "Back to" read the work left behind, so they never count toward a goal switch. */
  let switchIgnoreThrough = 0;
  /** The action event id of the Up next completion state the user dismissed (upNextDone). */
  let upNextDoneDismissed: number | null = null;
  /** What the last "Back to" replaced, while its plan is on screen (BackToUndo; the undoBack hook reads it). */
  let restoreUndo: BackToUndo | null = null;
  // Focus aid 1, "Fade panels that do not matter now" (docs/focus-aids.md).
  /** Each panel's low-relevance streak and the panels quiet by relevance, counted once per applied Jev round. */
  let quietTrack: QuietTrack = emptyQuietTrack();
  // "Move pinned and bigger panels to the front" (docs/focus-aids.md).
  /** Goes up with every move to the front, so the canvas follows each one once (EngineState.toFront). */
  let frontSeq = 0;
  // Focus aid 2, "Say when a task is done" (docs/focus-aids.md).
  /** Jev's goal-done rounds in a row for the working context (countDoneRound). */
  let doneRounds: DoneRounds = emptyDoneRounds();
  /**
   * Goals whose completion the engine already announced (task_done), and
   * whether the user acted on it (Start, or dismissing a card with no next
   * task), which hides the card. Cleared for a goal once it has open work
   * again: its code fact is false, or a round judged its goal-done below
   * TASK_DONE_JEV_AT, so a later completion is announced anew.
   */
  const doneSeen = new Map<GoalId, { acked: boolean }>();
  /** Goal -> epoch ms until which "Not now" hides its Done card. */
  let doneSnooze: Partial<Record<GoalId, number>> = {};
  /** The working goal each request asked about, by request version, so a round's goal-done counts only for that same context. */
  const sentWorking = new Map<number, WorkingGoal | null>();
  /** Re-checks the Done card when the first minute of a working goal ends or a "Not now" runs out. */
  let taskDoneTimer: ReturnType<typeof setTimeout> | null = null;
  let taskDoneTimerAt = 0;
  // "Arrange linked panels by next step" (docs/anchored-relayout.md, "Next step").
  /** The click (AnchorRef.at) each request's link questions were about, and what they offered, by request version. */
  const sentLink = new Map<number, { at: number; link: LinkRequest }>();
  /** Jev's link answer for the newest click that got one. It orders that click's linked panels; one answer per click. */
  let linkAnswer: { at: number; linkNext?: ChoiceJudgment<string>; linkAction?: ChoiceJudgment<ActionId> } | null = null;
  /** The next step Jev read from a click (Up next, the "Next" tag, the suggestion once its record is open), until done, dismissed, replaced, or stale. */
  let linkStep: LinkStep | null = null;
  /** The to-do item that matches the step just done, offered as "Check off: ...", and since when (FOLLOW_UP_MS). */
  let followUp: { taskId: string; since: number; reason: string } | null = null;
  // Focus aid 3, "Learn my habits" (docs/focus-aids.md).
  /** Where the user is in this session for learning: the last panel worked in and the record opened by hand. Never saved. */
  let habitTrail: HabitTrail = emptyTrail();
  /** True while a scenario replays: its steps are not the user's, so they teach no habit and count no guess. */
  let replaying = false;
  // Focus aid 4, "Prepare for meetings" (docs/focus-aids.md).
  /** Meetings the user prepared for this session (never offered again), and the ones they said "Not now" to. */
  const prepPrepared = new Set<string>();
  const prepDismissed = new Set<string>();
  /** Meetings whose offer was logged (prep_offer), so each is announced once per session. */
  const prepOffered = new Set<string>();
  /** The newest /api/prep answer per meeting, with the signature of the records it read, so it is reused until they change. */
  const prepAnswers = new Map<string, { signature: string; ranking: PrepRanking }>();
  /** The /api/prep request in flight: its meeting, the records' signature, and how to cancel it. */
  let prepFlight: { eventId: string; signature: string; controller: AbortController } | null = null;
  let prepVersion = 0;
  /** Looks again for an upcoming meeting every PREP_RECHECK_MS while the aid applies. */
  let prepTimer: ReturnType<typeof setTimeout> | null = null;
  /** The prep view's anchor (AnchorRef.at) and the order its panels gathered in: later rounds for that anchor keep both. */
  let prepGather: { at: number; order: PanelId[] } | null = null;
  /** Records opened from a prep view this session, each counted once in the Metrics tab. */
  const prepOpened = new Set<string>();
  /** The meeting whose "Start meeting notes" the user dismissed, so it is not offered again. */
  let prepNotesDismissed: string | null = null;
  /** Numbers the simulated meetings, across resets, so an id is never reused. */
  let simSeq = 0;

  /** The undo's "Back to" state while an undo runs (hooks undoBack, undoing, undone). */
  let undoFrom: BackToUndo | null = null;
  /** What a settings change switched off, from settingsSet to the later settings hooks. */
  let prepWentOff = false;
  let linkFlowWentOff = false;

  /**
   * The front group, newest first, while "Move pinned and bigger panels to
   * the front" applies (moveToFrontOn: Adaptive on, not frozen, the setting
   * on); undefined otherwise, which keeps the older rules everywhere.
   */
  const frontOf = (s: EngineState): PanelId[] | undefined => (moveToFrontOn(s.settings) ? frontGroup(s.front, s.pinned, s.bigger) : undefined);

  const liveData = (): PolicyLiveData => {
    const s = get();
    return { invoices: s.data.invoices, messages: s.data.messages, projects: s.data.projects, view: s.view, focusedPanel: s.focusedPanel };
  };


  // ----- the link cues (docs/anchored-relayout.md, "Links") --------------------

  /** "stay": the links last until the user clears them. "fade": they live only with their anchor, as before. */
  function linksPersist(): boolean {
    return get().settings.linkLines === "stay";
  }

  /** The panels the links on screen keep on the canvas ("stay" mode only; "fade" keeps the older rules). */
  function linkHold(): PolicyInput["linkHold"] {
    const links = get().links;
    if (!links || !linksPersist()) return undefined;
    return { source: links.source.panel, linked: Object.keys(links.relations) as PanelId[] };
  }

  /**
   * The links a plan built for the live anchor makes: its relations, less
   * what the user dismissed from that click. Null when it links nothing.
   */
  function linksFromPlan(plan: LayoutPlan): Omit<LinkSet, "round"> | null {
    const a = get().anchor;
    const pa = plan.anchor;
    if (!a || !pa || pa.at !== a.at || !plan.placements.some((p) => p.id === pa.panel)) return null;
    const drop = linkDrops?.at === pa.at ? linkDrops : null;
    if (drop?.all) return null;
    const relations: LinkSet["relations"] = {};
    for (const p of plan.placements) if (p.relation && p.id !== pa.panel && !drop?.panels.has(p.id)) relations[p.id] = p.relation;
    return Object.keys(relations).length > 0 ? { source: pa, relations } : null;
  }

  /** `links` without one panel's link; null when none is left. */
  function withoutLink(links: LinkSet, panel: PanelId): LinkSet | null {
    const ids = (Object.keys(links.relations) as PanelId[]).filter((id) => id !== panel);
    return ids.length > 0 ? { ...links, relations: Object.fromEntries(ids.map((id) => [id, links.relations[id]])) } : null;
  }

  /** The links, less panels that left the canvas; null when the source panel left. */
  function onCanvasOnly(links: LinkSet | null, plan: LayoutPlan): LinkSet | null {
    if (!links) return null;
    const on = new Set(plan.placements.map((p) => p.id));
    if (!on.has(links.source.panel)) return null;
    let out: LinkSet | null = links;
    for (const id of Object.keys(links.relations) as PanelId[]) if (out && !on.has(id)) out = withoutLink(out, id);
    return out;
  }

  /** Remember what the user dismissed from one click's links, so a later round for that click does not bring it back. */
  function rememberDrop(at: number, panel: PanelId | "all"): void {
    if (linkDrops?.at !== at) linkDrops = { at, all: false, panels: new Set() };
    if (panel === "all") linkDrops.all = true;
    else linkDrops.panels.add(panel);
  }

  /**
   * Bring `links` in line with the plan and the anchor after either changes.
   * "stay": a round for the live anchor that links panels makes the set (a
   * new click replaces the old one, the same click refreshes it), a round
   * that links nothing leaves it alone, and panels that left the canvas drop
   * out. "fade": the links are the live anchor's round's relations and go
   * with the anchor, as before.
   */
  function syncLinks(): void {
    const s = get();
    const current = s.links;
    const made = linksFromPlan(s.plan);
    let next: LinkSet | null;
    // A prep view's links (focus aid 4) stay as it made them through later rounds for its anchor, and while the user opens the meeting's records.
    if (made) next = current && inPrepView(current, made.source) ? current : { ...made, round: current?.source.at === made.source.at ? current.round : (s.plan.round ?? 0) };
    else next = linksPersist() ? current : null;
    next = withNext(onCanvasOnly(next, s.plan));
    if (!sameLinks(next, current)) set({ links: next });
  }

  /** The user docked `panel`: docking the source clears every link (the user acted), docking a linked panel removes its link. */
  function dropLinksOf(panel: PanelId): void {
    const links = get().links;
    if (!links) return;
    if (links.source.panel === panel) {
      rememberDrop(links.source.at, "all");
      set({ links: null });
    } else if (links.relations[panel]) {
      rememberDrop(links.source.at, panel);
      set({ links: withNext(withoutLink(links, panel)) });
    }
  }

  // ----- the next step (docs/anchored-relayout.md, "Next step") --------------

  /** "Arrange linked panels by next step" applies: Adaptive on and the aid on. */
  function linksArranged(): boolean {
    return arrangeLinksOn(get().settings);
  }

  /** The step to offer now, or null: the aid is off, or the step went stale or no longer fits its record (then it is dropped). */
  function activeStep(now: number = Date.now()): LinkStep | null {
    if (!linkStep || !linksArranged()) return null;
    if (!stepLive(linkStep, get().data, now)) {
      linkStep = null;
      return null;
    }
    return linkStep;
  }

  /**
   * The linked panels of a plan built for the live work anchor, in
   * next-step order, for PackInput.gather: Jev's order when its link answer
   * for this click is sure, else code's (linkPanelOrder). Panels the user
   * dismissed from this click's links are left out. Undefined: nothing gathers.
   */
  function gatherOrder(plan: LayoutPlan, anchor: AnchorRef): PanelId[] | undefined {
    // A prep view (focus aid 4) gathers in its own order, the most useful first, and keeps it for its anchor. The user asked for it, so it does not wait for the link aid.
    // Work on the meeting's records inside it gathers nothing: the view is already arranged.
    const shown = get().links;
    if (shown?.prep && shown.source.at !== anchor.at && inPrepView(shown, anchor)) return undefined;
    if (prepGather?.at === anchor.at && plan.anchor?.at === anchor.at) {
      const drop = linkDrops?.at === anchor.at ? linkDrops : null;
      const linked = new Set(plan.placements.filter((p) => p.relation && p.id !== anchor.panel && !drop?.panels.has(p.id)).map((p) => p.id));
      const order = drop?.all ? [] : prepGather.order.filter((id) => linked.has(id));
      return order.length > 0 ? order : undefined;
    }
    if (!linksArranged() || plan.anchor?.at !== anchor.at) return undefined;
    const drop = linkDrops?.at === anchor.at ? linkDrops : null;
    if (drop?.all) return undefined;
    const panels = plan.placements
      .filter((p) => p.relation && p.id !== anchor.panel && !drop?.panels.has(p.id))
      .map((p) => ({ id: p.id, records: p.relation!.records, priority: p.priority }));
    if (panels.length === 0) return undefined;
    return linkPanelOrder(anchor, panels, get().data, linkAnswer?.at === anchor.at ? linkAnswer.linkNext : undefined).order;
  }

  /** `links` with the "Next" emphasis the live step gives it: on the step's panel, when that panel shows the step's record. */
  function withNext(links: LinkSet | null): LinkSet | null {
    if (!links) return null;
    const step = activeStep();
    const rel = step && step.at === links.source.at ? links.relations[step.record.panel] : undefined;
    if (step && rel?.records.some((r) => recordKey(r.itemKind, r.itemId) === step.record.id)) {
      const next = { panel: step.record.panel, record: step.record.id, text: step.tag, probability: step.probability };
      const same = links.next && links.next.panel === next.panel && links.next.record === next.record && links.next.text === next.text;
      return same ? links : { ...links, next };
    }
    if (!links.next) return links;
    const { next: _next, ...rest } = links;
    void _next;
    return rest;
  }

  /**
   * The request's link fields: once per click (until an answer for it
   * lands), with the aid on, for a work anchor on a record the link
   * questions read. Not for the step's own record: the step already says
   * what to do there.
   */
  function linkRequestNow(now: number): LinkRequest | null {
    const s = get();
    const a = s.anchor;
    if (!linksArranged() || !a || a.source === "command" || !a.itemKind || !a.itemId) return null;
    if (linkAnswer?.at === a.at) return null;
    // A prep view's meeting (focus aid 4): its own request ranked what matters, so no link question.
    if (prepGather?.at === a.at) return null;
    if (linkStep && linkStep.record.id === recordKey(a.itemKind, a.itemId)) return null;
    return linkRequestFor(a, s.data, s.view, now);
  }

  /** Remember which click request `v` asked about. Only the newest few are kept: an answer older than that is stale anyway. */
  function rememberLink(v: number, at: number, link: LinkRequest): void {
    sentLink.set(v, { at, link });
    for (const key of sentLink.keys()) if (key < v - HISTORY_LIMIT) sentLink.delete(key);
  }

  /**
   * One applied round's link answer, when its request asked about the live
   * click: it orders that click's linked panels, and a sure one makes the
   * next step (linkStepFrom). An unsure answer drops an older step: it was
   * about an earlier click.
   */
  function noteLinkAnswer(res: AdaptResponse): void {
    const sent = sentLink.get(res.version);
    sentLink.delete(res.version);
    const a = get().anchor;
    const j = res.judgments;
    if (!sent || !a || sent.at !== a.at || !j.linkNext) return;
    linkAnswer = { at: a.at, linkNext: j.linkNext, ...(j.linkAction ? { linkAction: j.linkAction } : {}) };
    linkStep = linkStepFrom({
      at: a.at,
      clicked: sent.link.clicked,
      records: sent.link.records,
      linkNext: j.linkNext,
      ...(j.linkAction ? { linkAction: j.linkAction } : {}),
      data: get().data,
      now: Date.now(),
      judge: res.source === "heuristic" ? "Heuristic" : "Jev",
    });
  }

  /**
   * After an event: the step's action done on its record ends the step and
   * offers the matching to-do item (followUpTask); checking that item off
   * ends the follow-up. Opening the step's record counts as that click's link
   * answer, so no link question is asked for it. True when the suggestions
   * should refresh now: one of those, or the step's record was just opened
   * (its action is offered at once).
   */
  function noteLinkEvent(e: SignalEvent): boolean {
    if (!linksArranged()) return false;
    const id = e.detail?.itemId;
    const kind = e.detail?.itemKind ?? kindOfId(id);
    const key = id && kind ? recordKey(kind, id) : null;
    if (!key || !id || !kind) return false;
    if (e.type === "action") {
      let changed = false;
      if (followUp && kind === "task" && id === followUp.taskId) {
        followUp = null;
        changed = true;
      }
      const step = activeStep(e.t);
      if (step?.action && e.detail?.actionId === step.action && key === step.record.id) {
        linkStep = null;
        const task = followUpTask(step.action, kind, id, get().data);
        followUp = task ? { taskId: task.id, since: e.t, reason: `Follows what you just did: ${actionPast(step.action, e.detail ?? {})}` } : null;
        syncLinks();
        changed = true;
      }
      return changed;
    }
    if ((e.type === "item_open" || e.type === "up_next_open") && activeStep(e.t)?.record.id === key) {
      // Following the step: this click asks no link question of its own, now or after the step is done
      // (it would only point back to where the user came from). The step is its answer.
      const a = get().anchor;
      if (a) linkAnswer = { at: a.at };
      return true;
    }
    return false;
  }

  /** The primary suggestion the next step adds now: its action once its record is open, else the check-off follow-up. */
  function linkSuggestionNow(now: number): Suggestion | null {
    if (!linksArranged()) return null;
    const s = get();
    const step = activeStep(now);
    if (step) {
      const current = currentRecord(s.events, s.anchor);
      const offered = stepSuggestion(step, { current: current ? recordKey(current.kind, current.id) : null, data: s.data, view: s.view, events: s.events, now });
      if (offered) return offered;
    }
    if (followUp && now - followUp.since <= FOLLOW_UP_MS) {
      const task = s.data.tasks.find((t) => t.id === followUp?.taskId);
      if (task && !task.done) return followUpSuggestion(task, followUp.reason);
    }
    return null;
  }

  /** The plan with the next step's suggestion first, as the primary one; the others stay, as subtle ones. */
  function withLinkSuggestion(plan: LayoutPlan): LayoutPlan {
    const extra = linkSuggestionNow(Date.now());
    if (!extra) return plan;
    const record = suggestionRecord(extra) ?? "";
    const others = plan.suggestions
      .filter((x) => !(x.actionId === extra.actionId && (suggestionRecord(x) ?? "") === record))
      .map((x) => (x.prominence === "primary" ? { ...x, prominence: "subtle" as const } : x));
    const text = `Suggested: ${extra.label}`;
    const said = get().plan.suggestions.some((x) => sameSuggestion(x, extra)) || plan.decisions.some((d) => d.kind === "suggest" && d.text === text);
    const evidence = extra.task ? "follows the step just done" : `link action ${extra.actionId} p=${extra.confidence.toFixed(2)}`;
    return { ...plan, suggestions: [extra, ...others], decisions: said ? plan.decisions : [...plan.decisions, { kind: "suggest", text, evidence }] };
  }

  /** Forget the next step, its follow-up, and the link answers (the aid went off, or a reset). */
  function clearLinkFlow(): void {
    linkStep = null;
    followUp = null;
    linkAnswer = null;
    sentLink.clear();
  }


  // ----- predictive flow: Up next, Back to (docs/predictive-flow.md) ---------

  /**
   * The current record, list work, code's next records in the current list
   * (only those the repeated action still applies to), and the candidates,
   * from the state now.
   */
  function flowState(now: number) {
    const s = get();
    const handled = handledRecords(s.events);
    const current = currentRecord(s.events, s.anchor);
    const listWork = detectListWork(s.events, now);
    const listNext = current ? nextInList(current, s.data, s.view, now, listSkip(handled, listWork.action, s.data)) : [];
    // Focus aid 3: the panel the user usually goes to next, whose records move up in code's order.
    const habitPanel = topNextPanel(habitHintsNow(now));
    const candidates = buildRecordCandidates({ data: s.data, view: s.view, anchor: s.anchor, links: s.links, events: s.events, now, ...(habitPanel ? { habitPanel } : {}) });
    return { s, current, listWork, handled, listNext, candidates, habitPanel };
  }

  function lastActionAt(events: SignalEvent[]): number | null {
    for (let i = events.length - 1; i >= 0; i--) if (events[i].type === "action") return events[i].t;
    return null;
  }

  /**
   * Recompute the Up next card and queue mode after anything that can
   * change them (a signal, a round, a view change, a dismissal). A new
   * record on the card counts as one shown. When the action the user
   * repeats has no record left, the card says so instead of a pick, until
   * dismissed or the user moves on (queueDone). With Adaptive off, or the
   * "Up next" focus aid off, the card is hidden (so n has nothing to open).
   * While the Done card shows (focus aid 2), it takes the Up next slot: no
   * pick and no completion line. The first time a completion shows, the
   * engine logs task_done.
   */
  function refreshFlow(): void {
    const now = Date.now();
    const { s, current, listWork, handled, listNext, candidates, habitPanel } = flowState(now);
    const j = s.last?.judgments;
    const queue = queueModeOn(listWork, j?.listWork);
    const { state: taskDone, announce } = taskDoneNow(now, handled);
    // The card shows only with Adaptive on and the "Up next" focus aid on, and not while the Done card has its slot.
    const cardOn = upNextOn(s.settings) && !taskDone;
    const found = cardOn ? queueDone(listWork, s.events, s.data) : null;
    const done = found && found.eventId !== upNextDoneDismissed ? found : null;
    const action = listWork.action;
    const applies = (id: string) => {
      const r = parseRecordKey(id);
      return r === null || actionApplies(action, r.kind, r.id, s.data, handled);
    };
    // The next step of the click ("Arrange linked panels by next step"), until its record is open.
    const step = cardOn ? activeStep(now) : null;
    const stepRecord = step ? parseRecordKey(step.record.id) : null;
    const onStep = current !== null && step !== null && recordKey(current.kind, current.id) === step.record.id;
    const stepCandidate = step && stepRecord && !onStep && !handled.has(step.record.id) ? makeCandidate(stepRecord.kind, stepRecord.id, `the next step for ${step.fromLabel}`, s.data, now) : null;
    const link = step && stepCandidate ? { candidate: stepCandidate, p: step.probability, ...(step.phrase ? { step: step.phrase } : {}) } : null;
    const pick =
      cardOn && !done
        ? chooseUpNext({
            candidates,
            ...(link ? { link } : {}),
            ...(j?.nextRecord ? { nextRecord: j.nextRecord } : {}),
            judgedAt,
            lastActionAt: lastActionAt(s.events),
            queue,
            ...(listWork.kind ? { queueKind: listWork.kind } : {}),
            ...(action ? { applies } : {}),
            current,
            listNext,
            dismissed: upNextDismissed,
            now,
            judge: s.last?.source === "heuristic" ? "Heuristic" : "Jev",
            ...(habitPanel ? { habitPanel } : {}),
          })
        : null;
    const metrics = metricsOnUpNextShown(s.metrics, pick?.candidate.id ?? null);
    const sameDone = (done?.eventId ?? null) === (s.upNextDone?.eventId ?? null);
    const sameTask = taskDoneKey(taskDone) === taskDoneKey(s.taskDone);
    if (upNextKey(pick) === upNextKey(s.upNext) && sameDone && queue === s.queueMode && metrics === s.metrics && sameTask) return;
    if (announce && taskDone) doneSeen.set(taskDone.goal, { acked: false });
    set({ upNext: pick, upNextDone: done, queueMode: queue, metrics, taskDone });
    if (announce && taskDone) {
      // The engine's own note: left out of the snapshot (SIGNAL_PROFILE.cueOnly in snapshot.ts), no recent use, never a request.
      k.track(
        { type: "task_done", detail: { label: GOALS[taskDone.goal].label, ...(taskDone.next ? { task: taskDone.next.words } : {}) } },
        { schedule: false, anchor: false },
      );
    }
  }

  // ----- focus aid 2: say when a task is done (docs/focus-aids.md) ----------

  /** A string that changes only when what the Done card shows changes, so refreshFlow skips no-op updates. */
  function taskDoneKey(t: TaskDoneState | null): string {
    if (!t) return "";
    return [t.goal, t.since, t.title, t.detail ?? "", t.source, t.next?.id ?? "", t.next?.text ?? "", t.next?.first.id ?? "", t.nextWhy ?? ""].join("|");
  }

  function clearTaskDoneTimer(): void {
    if (taskDoneTimer !== null) clearTimeout(taskDoneTimer);
    taskDoneTimer = null;
    taskDoneTimerAt = 0;
  }

  /** Re-check the Done card at `at` (the end of a working goal's first minute, or of a "Not now"), unless a sooner check is already armed. */
  function armTaskDoneTimer(at: number): void {
    const now = Date.now();
    if (taskDoneTimer !== null && taskDoneTimerAt > now && taskDoneTimerAt <= at) return;
    clearTaskDoneTimer();
    taskDoneTimerAt = at;
    taskDoneTimer = setTimeout(
      () => {
        taskDoneTimer = null;
        taskDoneTimerAt = 0;
        refreshFlow();
      },
      Math.max(0, at - now),
    );
  }

  /**
   * The Done card now, or null, and whether it is a completion the engine
   * has not announced yet. Done by the rule in judgeTaskDone (the code fact,
   * or Jev's goal-done two rounds in a row, never in the first minute), and
   * shown unless the user already acted on this completion or said "Not
   * now" in the last TASK_DONE_SNOOZE_MS. The next task is Jev's nextTask
   * past its gate, else code's top-ranked candidate (chooseNextTask).
   */
  function taskDoneNow(now: number, handled: ReadonlySet<string>): { state: TaskDoneState | null; announce: boolean } {
    const s = get();
    // A goal with a code fact whose work came back (an unread message, a new overdue invoice) can be done again later.
    for (const g of [...doneSeen.keys()]) {
      const f = goalFact(g, s.data, handled);
      if (f && !f.done) doneSeen.delete(g);
    }
    if (!taskDoneOn(s.settings) || !s.working) return { state: null, announce: false };
    const goal = s.working.goal;
    const verdict = judgeTaskDone({ working: s.working, fact: goalFact(goal, s.data, handled), rounds: doneRounds, now });
    if (!verdict.done) {
      if (verdict.waitUntil !== undefined) armTaskDoneTimer(verdict.waitUntil);
      return { state: null, announce: false };
    }
    if (doneSeen.get(goal)?.acked) return { state: null, announce: false };
    const snoozed = doneSnooze[goal];
    if (snoozed !== undefined && now < snoozed) {
      armTaskDoneTimer(snoozed);
      return { state: null, announce: false };
    }
    const tasks = buildNextTasks({ data: s.data, handled, now, exclude: goal, ...habitBoost(now) });
    const pick = chooseNextTask(tasks, s.last?.judgments.nextTask, s.last?.source === "heuristic" ? "Heuristic" : "Jev");
    const state: TaskDoneState = {
      goal,
      title: verdict.title,
      ...(verdict.detail ? { detail: verdict.detail } : {}),
      source: verdict.source,
      ...(verdict.probability !== undefined ? { probability: verdict.probability } : {}),
      next: pick?.task ?? null,
      ...(pick ? { nextSource: pick.source, nextWhy: pick.why } : {}),
      since: s.working.since,
    };
    return { state, announce: !doneSeen.has(goal) };
  }

  /** Focus aid 3: the next-task boost from goal habits (under 1: it only reorders near neighbors), with the aid on. */
  function habitBoost(now: number): Pick<Parameters<typeof buildNextTasks>[0], "boost" | "boostWhy"> {
    return habitsOn(get().settings) ? { boost: habitTaskBoost(get().habits, now), boostWhy: HABIT_TASK_WHY } : {};
  }

  /**
   * One applied round's goal-done for the working context (countDoneRound).
   * It counts only when the request asked about this same working context:
   * an answer about the context before a goal switch, a Back to, or a Start
   * starts the new one over. A round that judges a goal with no code fact
   * still in progress lets its next completion be announced again.
   */
  function noteDoneRound(res: AdaptResponse): void {
    const asked = sentWorking.get(res.version) ?? null;
    sentWorking.delete(res.version);
    const w = get().working;
    const same = asked !== null && w !== null && asked.goal === w.goal && asked.since === w.since;
    const goalDone = same ? res.judgments.goalDone : undefined;
    doneRounds = countDoneRound(doneRounds, w, goalDone, res.version);
    if (w && typeof goalDone === "number" && goalDone < TASK_DONE_JEV_AT && !hasGoalFact(w.goal)) doneSeen.delete(w.goal);
  }

  /** The working context as it is now, under `goal`: the plan with its cells, bigger panels, view state, and links. */
  function captureContext(goal: GoalId): WorkingContext {
    const s = get();
    // Prepare (focus aid 4) names the working context's client for sure.
    const client = (s.working?.goal === goal ? s.working.client : undefined) ?? contextClient(s.events, goal, s.last?.judgments.targetClient);
    return {
      id: ++contextSeq,
      goal,
      ...(client ? { client } : {}),
      label: contextLabel(goal, client),
      plan: withGrid(s.plan, get().columns),
      bigger: [...s.bigger],
      view: structuredClone(s.view),
      links: s.links,
      at: Date.now(),
    };
  }

  function saveContext(ctx: WorkingContext): void {
    // With the "Back to" focus aid off nothing is saved; the working goal is still followed, so turning it on works at once.
    if (!backToOn(get().settings)) return;
    set({ contexts: addContext(get().contexts, ctx) });
    // The engine's own note: left out of the snapshot (SIGNAL_PROFILE.cueOnly in snapshot.ts), no recent use, never a request.
    k.track({ type: "context_save", detail: { label: ctx.label } }, { schedule: false, anchor: false });
  }

  /**
   * An applied command that sends the user to another area (a panel that is
   * not one of the current goal's own) saves the current context first, as
   * it is before the command's filters and layout land, and starts the new one.
   */
  function noteCommandSwitch(panel: PanelId): boolean {
    const s = get();
    if (!s.settings.adaptive) return false;
    const now = Date.now();
    if (!s.working) {
      const goal = panelGoal(panel);
      if (goal) set({ working: { goal, since: now } });
      return false;
    }
    const to = commandSwitchesArea(s.working.goal, panel);
    if (!to) return false;
    saveContext(captureContext(s.working.goal));
    noteGoalMove(s.working.goal, to);
    goalSwitch = null;
    set({ working: { goal: to, since: now } });
    return true;
  }

  /**
   * One applied round's goal against the current working context (see
   * judgeSwitch): the first time Jev judges another goal, capture the
   * context as it is, before this round's layout lands; the second time in
   * a row, save that capture and start the new context.
   */
  function noteGoalRound(res: AdaptResponse): void {
    const s = get();
    if (!s.settings.adaptive || res.version <= switchIgnoreThrough) return;
    const step = judgeSwitch(s.working?.goal ?? null, goalSwitch?.pending ?? null, res.judgments.goal);
    const now = Date.now();
    switch (step.kind) {
      case "none":
        goalSwitch = null;
        return;
      case "adopt":
        goalSwitch = null;
        set({ working: { goal: step.goal, since: now } });
        return;
      case "pending": {
        const same = goalSwitch?.pending.goal === step.pending.goal ? goalSwitch : null;
        goalSwitch = { pending: step.pending, at: same?.at ?? now, before: same?.before ?? captureContext(s.working!.goal) };
        return;
      }
      case "switch": {
        const before = goalSwitch?.before ?? captureContext(s.working!.goal);
        const since = goalSwitch?.at ?? now;
        goalSwitch = null;
        saveContext(before);
        noteGoalMove(s.working?.goal, step.goal);
        set({ working: { goal: step.goal, since } });
        return;
      }
    }
  }

  // ----- focus aid 3: learn my habits (docs/focus-aids.md) -------------------

  /** Keep the habits in the store and in this browser (storage that is blocked or full is skipped). */
  function keepHabits(habits: EngineState["habits"]): void {
    set({ habits });
    saveHabits(storage(), habits);
  }

  /**
   * One tracked event for the habits (habitStep): with the aid on it learns
   * the move; on or off, a move the habits had a guess for is counted in
   * the Metrics tab. Replayed scenario steps are not the user's and count for nothing.
   */
  function noteHabitEvent(e: SignalEvent): void {
    if (replaying) return;
    const s = get();
    const step = habitStep(s.habits, habitTrail, e, { learn: s.settings.focusAids.habits });
    habitTrail = step.trail;
    if (step.guess) set({ metrics: metricsOnHabitGuess(get().metrics, step.guess.right) });
    if (step.memory !== s.habits) keepHabits(step.memory);
  }

  /** The working goal moved from `from` to `to` by the user's own work (a goal switch, a command to another area, Back to): learn it. */
  function noteGoalMove(from: GoalId | null | undefined, to: GoalId): void {
    if (replaying || !get().settings.focusAids.habits) return;
    const habits = learnGoal(get().habits, from ?? null, to, Date.now());
    if (habits !== get().habits) keepHabits(habits);
  }

  /** The record the user opened and has not acted on since (any action on a record ends it), for the usual action after its kind. */
  function openRecord(events: SignalEvent[]): HabitContext["record"] {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      const id = e.detail?.itemId;
      if (!id) continue;
      if (e.type === "action") return null;
      if (e.type === "item_open" || e.type === "up_next_open" || e.type === "task_start") {
        const kind = e.detail?.itemKind ?? kindOfId(id);
        return kind ? { kind, id, ...(e.detail?.client ? { client: e.detail.client } : {}) } : null;
      }
    }
    return null;
  }

  /** What the habits read now: the panel worked in this session (none after HABIT_SESSION_GAP_MS), the open record, and the working goal. */
  function habitContext(now: number): HabitContext {
    const s = get();
    const from = habitTrail.last !== null && now - habitTrail.at <= HABIT_SESSION_GAP_MS ? habitTrail.last : null;
    return { from, now, record: openRecord(s.events), goal: s.working?.goal ?? null };
  }

  /** The habits code may use now (habitHints), or null with the aid off (or Adaptive off) or when no habit applies. */
  function habitHintsNow(now: number): ReturnType<typeof habitHints> {
    const s = get();
    return habitsOn(s.settings) ? habitHints(s.habits, habitContext(now)) : null;
  }

  // ----- focus aid 4: prepare for meetings (docs/focus-aids.md) -------------

  /**
   * Whether `anchor` belongs to the prep view `links` shows: its own anchor
   * (the meeting in Calendar), or work on a record of the meeting's client in
   * Calendar or in one of its linked panels. Such work keeps the prep view's
   * links, so the user can open its records one after another.
   */
  function inPrepView(links: LinkSet, anchor: AnchorRef): boolean {
    if (!links.prep) return false;
    if (links.source.at === anchor.at) return true;
    const client = links.source.client;
    return anchor.source !== "command" && client !== undefined && anchor.client === client && (anchor.panel === links.source.panel || links.relations[anchor.panel] !== undefined);
  }

  /** The records a prep view linked, per panel, when `anchor` is its anchor (the policy links these, not every record of the client). */
  function prepLinked(anchor: AnchorRef): Partial<Record<PanelId, RelatedRecord[]>> | null {
    const links = get().links;
    if (!links || !inPrepView(links, anchor)) return null;
    const out: Partial<Record<PanelId, RelatedRecord[]>> = {};
    for (const [id, r] of Object.entries(links.relations) as [PanelId, NonNullable<LinkSet["relations"][PanelId]>][]) out[id] = r.records;
    return out;
  }

  function clearPrepTimer(): void {
    if (prepTimer !== null) clearTimeout(prepTimer);
    prepTimer = null;
  }

  /** Look again in PREP_RECHECK_MS while the aid applies: a meeting may come into its lead time, or start. */
  function armPrepTimer(): void {
    clearPrepTimer();
    if (!meetingPrepOn(get().settings)) return;
    prepTimer = setTimeout(() => {
      prepTimer = null;
      refreshPrep();
    }, PREP_RECHECK_MS);
  }

  function cancelPrepFlight(): void {
    prepFlight?.controller.abort();
    prepFlight = null;
  }

  /** The ranking for these records of `meeting`, when /api/prep answered for exactly them. */
  function prepRanking(meeting: CalendarEvent, candidates: ReturnType<typeof buildPrepRecords>): PrepRanking | null {
    const a = prepAnswers.get(meeting.id);
    return a && a.signature === prepSignature(candidates) ? a.ranking : null;
  }

  /** The chip's or the card's state for `meeting`, with the ranking and the thing to handle first once /api/prep answered for its records. */
  function prepStateFor(meeting: CalendarEvent, stage: MeetingPrepState["stage"], extra: Partial<MeetingPrepState> = {}): MeetingPrepState {
    const candidates = buildPrepRecords(meeting, get().data, Date.now());
    const ranking = prepRanking(meeting, candidates);
    const urgent = urgentLine(candidates, ranking);
    return {
      stage,
      eventId: meeting.id,
      title: meeting.title,
      client: meeting.client ?? "",
      start: meeting.start,
      kind: meeting.kind === "call" ? "call" : "meeting",
      ...(ranking ? { ranking } : {}),
      ...(urgent ? { urgent } : {}),
      ...extra,
    };
  }

  /** A string that changes only when what the chip or card shows changes, so a recheck skips no-op updates. */
  function prepKey(p: MeetingPrepState | null): string {
    return p ? JSON.stringify(p) : "";
  }

  function setPrep(next: MeetingPrepState | null): void {
    if (prepKey(next) !== prepKey(get().prep)) set({ prep: next });
  }

  /**
   * Look for a meeting to prepare for, after anything that can change it:
   * the recheck timer, a setting, a new event, "Not now", Prepare, or a
   * reset. The card after Prepare stays until its meeting is underway or
   * the user closes it. Otherwise the chip offers upcomingMeeting's pick,
   * logs prep_offer the first time, and asks /api/prep for the ranking
   * ahead of time, so Prepare finds it ready. With the aid off (or Adaptive
   * off) there is no chip, no request, and no timer.
   */
  function refreshPrep(): void {
    const s = get();
    const now = Date.now();
    if (!meetingPrepOn(s.settings)) {
      clearPrepTimer();
      cancelPrepFlight();
      if (s.prep) set({ prep: null });
      dropPrepSuggestion();
      return;
    }
    const cur = s.prep;
    if (cur?.stage === "ready") {
      const e = s.data.events.find((x) => x.id === cur.eventId);
      if (e && !meetingUnderway(e.start, now)) {
        setPrep(prepStateFor(e, "ready", { panels: cur.panels ?? [], ...(cur.notesStarted ? { notesStarted: true } : {}) }));
        armPrepTimer();
        return;
      }
      set({ prep: null });
      dropPrepSuggestion();
    }
    const meeting = upcomingMeeting({ events: get().data.events, now, leadMs: prepLeadMs(s.settings.prepLeadMin), prepared: prepPrepared, dismissed: prepDismissed });
    if (!meeting) {
      setPrep(null);
      armPrepTimer();
      return;
    }
    setPrep(prepStateFor(meeting, "offer"));
    if (!prepOffered.has(meeting.id)) {
      prepOffered.add(meeting.id);
      // The engine's own note: left out of the snapshot (SIGNAL_PROFILE.cueOnly in snapshot.ts), no recent use, never a request.
      k.track(
        { type: "prep_offer", detail: { itemKind: "event", itemId: meeting.id, ...(meeting.client ? { client: meeting.client } : {}), label: eventLabel(meeting, now) } },
        { schedule: false, anchor: false },
      );
    }
    requestPrep(meeting);
    armPrepTimer();
  }

  /**
   * Ask /api/prep to rank `meeting`'s records, unless an answer or a request
   * for exactly these records exists. A request for records that changed
   * replaces the one in flight. A failure (offline, the server down) keeps
   * code's order; the server's own heuristic answers when Jev cannot.
   */
  function requestPrep(meeting: CalendarEvent): void {
    const now = Date.now();
    const candidates = buildPrepRecords(meeting, get().data, now);
    if (candidates.length === 0) return;
    const signature = prepSignature(candidates);
    if (prepAnswers.get(meeting.id)?.signature === signature) return;
    if (prepFlight?.eventId === meeting.id && prepFlight.signature === signature) return;
    cancelPrepFlight();
    const controller = new AbortController();
    const flight = { eventId: meeting.id, signature, controller };
    prepFlight = flight;
    const request: PrepRequest = { version: ++prepVersion, meeting: prepMeetingWords(meeting, now), records: candidates.map((c) => c.record) };
    postPrep(request, { signal: controller.signal }).then(
      (res) => {
        if (prepFlight === flight) prepFlight = null;
        if (controller.signal.aborted) return;
        prepAnswers.set(meeting.id, { signature, ranking: rankingFrom(request.records, res.judgments, res.source) });
        notePrepAnswer(meeting.id);
      },
      () => {
        // Offline, or replaced: the chip and the prep view keep code's order.
        if (prepFlight === flight) prepFlight = null;
      },
    );
  }

  /**
   * An /api/prep answer landed for `eventId`: the chip or the card shows its
   * thing to handle first, and a prep view still on screen for that meeting
   * (its anchor still live, its links still the prep view's) takes Jev's
   * order and tints at once.
   */
  function notePrepAnswer(eventId: string): void {
    const s = get();
    const cur = s.prep;
    const meeting = s.data.events.find((e) => e.id === eventId);
    if (!cur || cur.eventId !== eventId || !meeting || !meetingPrepOn(s.settings)) return;
    if (cur.stage === "offer") {
      setPrep(prepStateFor(meeting, "offer"));
      return;
    }
    const a = s.anchor;
    if (a && prepGather?.at === a.at && s.links?.prep?.eventId === eventId) {
      arrangePrep(meeting, a);
      return;
    }
    setPrep(prepStateFor(meeting, "ready", { panels: cur.panels ?? [], ...(cur.notesStarted ? { notesStarted: true } : {}) }));
  }

  /**
   * Lay out the prep view for `meeting` around `anchor` (the meeting in
   * Calendar, already the live anchor): link the client's panels in Jev's
   * order (code's before an answer), then place them as a manual edit, so
   * Calendar holds still and the linked panels gather next to it, the most
   * useful first. Frozen, nothing moves: the links show where the panels
   * are. The links become the prep view's own. Links the user removed from
   * this view stay removed.
   */
  function arrangePrep(meeting: CalendarEvent, anchor: AnchorRef): void {
    const s = get();
    const candidates = buildPrepRecords(meeting, s.data, Date.now());
    const ranking = prepRanking(meeting, candidates);
    const made = prepPanels(candidates, ranking, meeting.client ?? "");
    const drop = linkDrops?.at === anchor.at ? linkDrops : null;
    if (drop?.all) return;
    const order = made.order.filter((id) => !drop?.panels.has(id));
    const relations: LinkSet["relations"] = {};
    for (const id of order) relations[id] = made.relations[id];
    prepGather = { at: anchor.at, order };
    const first = s.prep?.stage !== "ready" || !s.prep.panels?.length;
    let plan = withPrepSuggestion(buildPrepPlan(s.plan, { anchor, order, relations, title: meeting.title }));
    if (first && plan.suggestions.some((x) => x.meetingNotes)) plan = { ...plan, decisions: [...plan.decisions, { kind: "suggest", text: `Suggested: ${PREP_NOTES_LABEL}` }] };
    k.setPlanDirect(plan, s.settings.frozen ? { holdAll: true } : {});
    const placed = get().plan;
    const on = new Set(placed.placements.map((p) => p.id));
    const shown: LinkSet["relations"] = {};
    for (const id of order) if (on.has(id) && relations[id]) shown[id] = relations[id];
    set({ links: Object.keys(shown).length > 0 ? { source: placed.anchor ?? anchor, relations: shown, round: placed.round ?? 0, prep: { eventId: meeting.id } } : null });
    const cur = get().prep;
    setPrep(prepStateFor(meeting, "ready", { panels: order.filter((id) => on.has(id)), ...(cur?.notesStarted ? { notesStarted: true } : {}) }));
  }

  /** "Start meeting notes" while the card after Prepare shows, until the user presses or dismisses it. Subtle: an offer, never a step to take for the user. */
  function prepSuggestionNow(): Suggestion | null {
    const s = get();
    const p = s.prep;
    if (!meetingPrepOn(s.settings) || !p || p.stage !== "ready" || p.notesStarted || prepNotesDismissed === p.eventId) return null;
    const heading = notesHeading({ title: p.title, start: p.start });
    return {
      actionId: "write_note",
      label: PREP_NOTES_LABEL,
      prominence: "subtle",
      confidence: 1,
      args: { client: p.client },
      reason: `Adds "${heading}" to your notes and opens Notes. Nothing is written until you press it.`,
      meetingNotes: { eventId: p.eventId, heading },
    };
  }

  /** The plan with "Start meeting notes" after the primary suggestions (and no other note step beside it), or without it once it no longer applies. */
  function withPrepSuggestion(plan: LayoutPlan): LayoutPlan {
    const extra = prepSuggestionNow();
    const others = plan.suggestions.filter((x) => !x.meetingNotes && !(extra && x.actionId === "write_note"));
    if (!extra) return others.length === plan.suggestions.length ? plan : { ...plan, suggestions: others };
    return { ...plan, suggestions: [...others.filter((x) => x.prominence === "primary"), extra, ...others.filter((x) => x.prominence !== "primary")] };
  }

  /** Take "Start meeting notes" off the suggestion row at once (the card closed, the aid went off). */
  function dropPrepSuggestion(): void {
    const plan = get().plan;
    if (plan.suggestions.some((x) => x.meetingNotes)) set({ plan: { ...plan, suggestions: plan.suggestions.filter((x) => !x.meetingNotes) } });
  }

  /** The record key when a record open is one the prep view linked: a tinted row, or a record of the meeting's client in a linked panel. */
  function prepRecordOpened(input: TrackInput): string | null {
    const links = get().links;
    const d = input.detail ?? {};
    const kind = d.itemKind ?? kindOfId(d.itemId);
    if (!links?.prep || !input.panel || !d.itemId || !kind) return null;
    const rel = links.relations[input.panel as PanelId];
    if (!rel) return null;
    const tinted = rel.records.some((r) => r.itemKind === kind && r.itemId === d.itemId);
    return tinted || (d.client !== undefined && d.client === links.source.client) ? recordKey(kind, d.itemId) : null;
  }

  /** Notes on the canvas with room to write: opened from the dock when needed (as from a suggestion), and at least standard size, its top edge kept. */
  function showNotes(): void {
    k.openPanel("notes", "suggestion");
    const plan = get().plan;
    const p = plan.placements.find((x) => x.id === "notes");
    if (!p || SIZE_RANK[p.size] >= SIZE_RANK.standard) return;
    k.setPlanDirect({ ...plan, placements: plan.placements.map((x) => (x.id === "notes" ? withoutQuiet({ ...x, size: "standard" }) : x)), decisions: [] }, { userResized: "notes" });
  }


  function newlyQuiet(current: LayoutPlan, next: LayoutPlan): number {
    const before = new Set(current.placements.filter((p) => p.quiet).map((p) => p.id));
    return next.placements.filter((p) => p.quiet && !before.has(p.id)).length;
  }

  /** The panels in the link cues (the source and the tagged panels). */
  function linkCuePanels(): PanelId[] {
    const links = get().links;
    return links ? [links.source.panel, ...(Object.keys(links.relations) as PanelId[])] : [];
  }

  /**
   * Whether the canvas shows `placement` faded now (shownQuiet in ./quiet.ts,
   * the same check the UI makes). `clicked`: a click into a card calls
   * setFocused just before it logs the focus, so that focus is the click's
   * own and does not count.
   */
  function showsQuiet(placement: LayoutPlan["placements"][number], clicked?: PanelId): boolean {
    const s = get();
    if (!fadeQuietOn(s.settings)) return false;
    const focused = s.focusedPanel === clicked ? null : s.focusedPanel;
    return shownQuiet(placement, { focused, upNext: s.upNext?.candidate.panel ?? null, linked: new Set(linkCuePanels()) });
  }

  /**
   * Focus aid 1 (docs/focus-aids.md): the panels that are quiet now. The
   * relevance side is the round count in `quietTrack`; the exemptions are
   * read from the state: the anchor, the panels in the link cues, pins,
   * bigger panels, the Up next panel, anything used in the last minute, and
   * (only for a panel not already quiet) the focused panel and the pointer's
   * card. (A panel the policy tags as linked this round is exempted there.)
   * Empty with the aid off or Adaptive off.
   */
  function quietNow(now: number): PanelId[] {
    const s = get();
    if (!fadeQuietOn(s.settings)) return [];
    return quietPanels(quietTrack, {
      onCanvas: s.plan.placements.map((p) => p.id),
      anchor: s.anchor?.panel ?? null,
      linked: linkCuePanels(),
      pinned: s.pinned,
      bigger: s.bigger,
      focused: s.focusedPanel,
      pointer: s.pointer.panel,
      upNext: s.upNext?.candidate.panel ?? null,
      // Focus aid 3: where the user usually goes next is not faded.
      usual: topNextPanel(habitHintsNow(now)) ?? null,
      events: s.events,
      now,
      current: s.plan.placements.filter((p) => p.quiet).map((p) => p.id),
    });
  }

  /**
   * The "Fade panels that do not matter now" flag changed. With judgments to
   * re-plan from, re-plan at once, as a weight change does; turning it off
   * first releases the anchor, since a locked card keeps its size in an
   * anchored round and the quiet sizes must all come back. Frozen, or on a
   * layout the user went "Back to", nothing is re-planned, so turning it off
   * only takes the quiet marks and sizes away.
   */
  function applyFadeQuiet(on: boolean): void {
    const s = get();
    if (!s.settings.adaptive) return;
    if (!on) k.releaseAnchor();
    if (!s.settings.frozen && s.last && !contextHold) {
      k.replanLocal({ force: true });
      return;
    }
    if (on || !s.plan.placements.some((p) => p.quiet)) return;
    const placements = get().plan.placements.map((p) =>
      p.quiet ? withoutQuiet({ ...p, size: p.unquietSize ?? p.size, reason: p.pinned ? "Pinned by you" : "Part of your workspace" }) : p,
    );
    k.setPlanDirect({ ...get().plan, placements });
  }

  /**
   * When a held round's plan lands later, record its decisions on that
   * round's history entry. Only an entry still showing the waiting
   * placeholder is filled: a later local re-plan from the same judgments must
   * not overwrite the decisions that round really made.
   */

  function rememberSent(v: number, working: WorkingGoal | null): void {
    sentWorking.set(v, working);
    for (const key of sentWorking.keys()) if (key < v - HISTORY_LIMIT) sentWorking.delete(key);
  }


  /** The demo's request: the snapshot with the panel views and habits, the candidates, the working goal, and the link question. */
  function buildRequest(s: EngineState, { now, version, kind, command }: { now: number; version: number; kind: string; command?: string }): AdaptRequest {
    // Focus aid 3: the habits, only with the aid on: the usual next panel's records move up, and at most two habits in words.
    const habitsNow = habitsOn(s.settings);
    const habitPanel = topNextPanel(habitHintsNow(now));
    const habitWords = habitsNow ? habitObservations(s.habits, habitContext(now)) : [];
    // Records the user might work on next, for Jev's nextRecord Choice (select, do not generate).
    const records = buildRecordCandidates({ data: s.data, view: s.view, anchor: s.anchor, links: s.links, events: s.events, now, ...(habitPanel ? { habitPanel } : {}) });
    // Focus aid 2: the working goal in words (Jev's goal-done Noul), and the next-task candidates only when it might be done.
    const working = taskDoneOn(s.settings) && s.working && s.working.goal !== "unclear" ? s.working : null;
    let tasks: AdaptRequest["candidates"]["tasks"] = [];
    if (working) {
      const handled = handledRecords(s.events);
      if (mightBeDone(working, goalFact(working.goal, s.data, handled), doneRounds)) {
        tasks = buildNextTasks({ data: s.data, handled, now, exclude: working.goal, ...habitBoost(now) })
          .slice(0, TASK_CANDIDATES_MAX)
          .map((t) => t.candidate);
      }
    }
    rememberSent(version, working);
    // "Arrange linked panels by next step": the clicked record and its linked records, once per click (not with a command).
    const link = kind === "command" ? null : linkRequestNow(now);
    if (link && s.anchor) rememberLink(version, s.anchor.at, link);
    return {
      version,
      snapshot: buildSnapshot(s.events, {
        now,
        focusedPanel: s.focusedPanel,
        visiblePanels: s.plan.placements.map((p) => p.id),
        view: s.view,
        ...(habitWords.length > 0 ? { habits: habitWords } : {}),
      }),
      candidates: { clients: [...CLIENT_NAMES], ...(records.length > 0 ? { records } : {}), ...(tasks.length > 0 ? { tasks } : {}) },
      ...(command ? { command } : {}),
      ...(working ? { workingGoal: { label: GOALS[working.goal].label, description: GOALS[working.goal].description } } : {}),
      ...(link ? { link } : {}),
    };
  }

  function applyViewPatches(patches: ViewPatch[]): void {
    if (!patches.length) return;
    const view = { ...get().view } as PanelViewState;
    for (const { panel, patch } of patches) {
      (view as unknown as Record<string, object>)[panel] = { ...view[panel], ...patch };
    }
    set({ view });
  }


  // ----- actions on app data ------------------------------------------------

  function setNotice(text: string): void {
    set({ notice: { id: ++noticeSeq, text } });
  }

  function findInvoice(invoices: Invoice[], args: PerformArgs, statuses: Invoice["status"][]): Invoice | undefined {
    if (args.invoiceId) return invoices.find((i) => i.id === args.invoiceId);
    const byDue = (a: Invoice, b: Invoice) => a.due.localeCompare(b.due);
    for (const status of statuses) {
      const hit = invoices.filter((i) => i.status === status && (!args.client || i.client === args.client)).sort(byDue)[0];
      if (hit) return hit;
    }
    return undefined;
  }

  /**
   * An action just happened: drop every suggestion for the same action on the
   * same record or client at once. Waiting for the next plan left a stale
   * primary suggestion up, and "." sent a second reminder.
   */
  function pruneDone(actionId: ActionId, client: string | undefined, itemId: string | undefined): void {
    const matches = (x: Suggestion) =>
      x.actionId === actionId && ((itemId !== undefined && suggestionRecord(x) === itemId) || (client !== undefined && x.args.client === client) || !x.args.client);
    const plan = get().plan;
    const kept = plan.suggestions.filter((x) => !matches(x));
    if (kept.length !== plan.suggestions.length) set({ plan: { ...plan, suggestions: kept } });
    k.dropHeldSuggestion(matches);
  }


  function performInternal(actionId: ActionId, args: PerformArgs, via: Via): void {
    if (actionId === "none" || !ACTIONS[actionId]) return;
    const data = get().data;
    let client = args.client;
    let itemId: string | undefined = args.invoiceId;
    // Only log actions that actually happened, so Jev never reads a reminder that was not sent.
    let done = true;
    const fail = (text: string) => {
      done = false;
      setNotice(text);
    };

    switch (actionId) {
      case "send_payment_reminder": {
        const inv = findInvoice(data.invoices, args, ["overdue", "sent"]);
        if (!inv) {
          fail(client ? `No unpaid invoice found for ${client}` : "No overdue invoice to remind about");
          break;
        }
        if (inv.status === "paid") {
          fail(`${inv.id} is already paid`);
          break;
        }
        set({ data: { ...data, invoices: data.invoices.map((i) => (i.id === inv.id ? { ...i, remindersSent: i.remindersSent + 1 } : i)) } });
        client = inv.client;
        itemId = inv.id;
        setNotice(`Reminder sent to ${inv.client} for ${inv.id}`);
        break;
      }
      case "mark_invoice_paid": {
        const inv = findInvoice(data.invoices, args, ["overdue", "sent", "draft"]);
        if (!inv) {
          fail(client ? `No open invoice found for ${client}` : "No open invoice to mark as paid");
          break;
        }
        if (inv.status === "paid") {
          fail(`${inv.id} is already paid`);
          break;
        }
        set({ data: { ...data, invoices: data.invoices.map((i) => (i.id === inv.id ? { ...i, status: "paid" as const } : i)) } });
        client = inv.client;
        itemId = inv.id;
        setNotice(`Marked ${inv.id} for ${inv.client} as paid`);
        break;
      }
      case "resend_invoice": {
        const inv = findInvoice(data.invoices, args, ["overdue", "sent"]);
        if (!inv) {
          fail(client ? `No sent invoice found for ${client}` : "No sent invoice to resend");
          break;
        }
        if (inv.status === "paid" || inv.status === "draft") {
          fail(inv.status === "paid" ? `${inv.id} is already paid` : `${inv.id} is a draft and was never sent`);
          break;
        }
        // Prototype: nothing is emailed; the invoice only records that it went out again.
        set({ data: { ...data, invoices: data.invoices.map((i) => (i.id === inv.id ? { ...i, resentAt: new Date().toISOString() } : i)) } });
        client = inv.client;
        itemId = inv.id;
        setNotice(`Invoice ${inv.id} resent to ${inv.client}`);
        break;
      }
      case "reply_to_message": {
        const byNewest = [...data.messages].sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
        const selectedId = get().view.inbox.selectedId;
        // The exact message when the caller named one; otherwise the client's
        // newest; otherwise the message open in the Inbox, then the newest unread.
        const m = args.messageId
          ? data.messages.find((x) => x.id === args.messageId)
          : client
            ? byNewest.find((x) => x.client === client)
            : ((selectedId ? data.messages.find((x) => x.id === selectedId) : undefined) ?? byNewest.find((x) => x.unread) ?? byNewest[0]);
        if (!m) {
          fail(client ? `No message from ${client} to reply to` : "No message to reply to");
          break;
        }
        set({
          data: { ...data, messages: data.messages.map((x) => (x.id === m.id ? { ...x, unread: false } : x)) },
          view: { ...get().view, inbox: { ...get().view.inbox, selectedId: m.id } },
        });
        client = m.client ?? client;
        itemId = m.id;
        setNotice(`Reply drafted to ${m.from}${m.client ? ` at ${m.client}` : ""} (prototype, no email is sent)`);
        break;
      }
      case "schedule_meeting": {
        const start = new Date();
        start.setDate(start.getDate() + 1);
        start.setHours(10, 0, 0, 0);
        const end = new Date(start.getTime() + 30 * 60_000);
        const id = `e-new-${++newItemSeq}`;
        set({
          data: {
            ...data,
            events: [
              ...data.events,
              { id, title: client ? `Meeting with ${client}` : "New meeting", start: start.toISOString(), end: end.toISOString(), client: client ?? null, kind: "meeting" },
            ],
          },
        });
        itemId = id;
        setNotice(client ? `Meeting with ${client} booked for tomorrow at 10:00` : "Meeting booked for tomorrow at 10:00");
        break;
      }
      case "create_task": {
        const title = args.taskTitle?.trim() || (client ? `Follow up with ${client}` : "Follow up");
        const project = client ? data.projects.find((p) => p.client === client && p.status !== "done") : undefined;
        const id = `t-new-${++newItemSeq}`;
        const today = new Date();
        const due = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        set({
          data: {
            ...data,
            tasks: [{ id, title, due, project: project?.name ?? null, client: client ?? null, done: false, assignee: CURRENT_USER.name }, ...data.tasks],
          },
        });
        itemId = id;
        setNotice(`Task added: ${title}`);
        break;
      }
      case "update_project_status": {
        const needsWork = (p: (typeof data.projects)[number]) => p.status === "at_risk" || p.status === "blocked";
        const named = args.projectId ? data.projects.find((p) => p.id === args.projectId) : undefined;
        if (named && !needsWork(named)) {
          fail(`${named.name} is already on track`);
          break;
        }
        const project = named ?? data.projects.find((p) => (!client || p.client === client) && needsWork(p));
        if (!project) {
          fail(client ? `No project at risk for ${client}` : "No project at risk");
          break;
        }
        set({ data: { ...data, projects: data.projects.map((p) => (p.id === project.id ? { ...p, status: "on_track" as const } : p)) } });
        client = project.client;
        itemId = project.id;
        setNotice(`${project.name} for ${project.client} is now on track`);
        break;
      }
      case "view_client": {
        if (client) set({ view: { ...get().view, clients: { ...get().view.clients, selected: client } } });
        k.openPanel("clients", via);
        break;
      }
      case "write_note": {
        k.openPanel("notes", via);
        break;
      }
    }

    if (!done) return;
    k.track({
      type: "action",
      panel: ACTIONS[actionId].panel ?? undefined,
      detail: {
        actionId,
        ...(client ? { client } : {}),
        ...(itemId ? { itemId } : {}),
        ...(args.taskTitle ? { label: args.taskTitle } : {}),
        ...(via ? { via } : {}),
      },
    });
    pruneDone(actionId, client, itemId);
  }


  // ----- replay ----------------------------------------------------------------

  function cancelReplay(): void {
    replayToken++;
    const cancel = replayCancel;
    replayCancel = null;
    cancel?.();
  }

  function sleep(ms: number, token: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (ms <= 0) {
        resolve(token === replayToken);
        return;
      }
      const handle = setTimeout(() => {
        replayCancel = null;
        resolve(token === replayToken);
      }, ms);
      replayCancel = () => {
        clearTimeout(handle);
        resolve(false);
      };
    });
  }

  function replayStep(step: ScenarioStep): void {
    const { delayMs: _delay, ...input } = step;
    void _delay;
    if (input.type === "command" && input.detail?.query) {
      void get().runCommand(input.detail.query, input.detail.via ?? "keyboard");
      return;
    }
    k.track(input);
  }


  // ----- the hooks: where the demo's parts join the library loop --------------

  const hooks: AdaptiveHooks<DemoSpec> = {
    describe: describeEvent,
    triggers: triggersRequest,
    itemKindOf: kindOfId,
    clientIn: clientNamedIn,
    anchorLabel: (ref, s) => anchorLabel(ref, s.data),
    sameSuggestion,
    suggestionKey: suggestionIdentity,
    // A follow-up checks off a to-do item, so it is logged against Tasks.
    suggestionPanel: (s) => (s.task ? "tasks" : (ACTIONS[s.actionId]?.panel ?? undefined)),
    suggestionDetail: (s) => (s.args.client ? { client: s.args.client } : {}),
    request: buildRequest,
    isAbort: isAbortError,

    resolveCommand: (cj, text, opts, s) => resolveCommand(cj, text, { ...opts, invoices: s.data.invoices, messages: s.data.messages, projects: s.data.projects, view: s.view }),
    commandResolved: (resolution, { chosen }) => {
      // A command to another area saves the current working context first, before its filters land.
      if (resolution.promote && (chosen || resolution.outcome.status === "applied")) noteCommandSwitch(resolution.promote);
      applyViewPatches(resolution.viewPatches);
    },
    commandUnclear: (text) => ({ text, status: "unclear", options: [], message: "Could not understand that. Try other words." }),
    commandFailed: (text, err) => ({ text, status: "unclear", options: [], message: commandFailureMessage(err) }),
    // An applied command anchors its hero on the client and invoice it names.
    commandAnchor: (resolution) => {
      const { client, invoiceId } = resolution.subject;
      return { ...(invoiceId ? { itemKind: "invoice" as const, itemId: invoiceId } : {}), ...(client ? { client } : {}) };
    },

    initialPlan: (s) => traditionalPlan({ pinned: s.pinned, bigger: s.bigger, front: frontOf(s) }),
    front: frontOf,
    linkHold: () => linkHold(),
    // Only records the panels show now: a filter or date range that hides them would leave a tag with nothing to tint.
    // A prep view's anchor (focus aid 4) links the records it chose, not every record of the client.
    linked: (anchor, s, now) => prepLinked(anchor) ?? findLinked(anchor, s.data, { view: s.view, now }),
    policyInput: (_s, now) => {
      const quiet = quietNow(now);
      const habit = habitHintsNow(now);
      return { ...(quiet.length > 0 ? { quiet } : {}), ...(habit ? { habit } : {}) };
    },
    extra: () => liveData(),
    gather: gatherOrder,
    // The next step's action once its record is open, or the check-off follow-up, leads the suggestions (a command's still goes first).
    // Focus aid 4: "Start meeting notes" after Prepare, until pressed or dismissed.
    afterPolicy: (plan) => withPrepSuggestion(withLinkSuggestion(plan)),
    // A layout the user went "Back to" stays until they do new work.
    layoutHold: () => (contextHold ? CONTEXT_HOLD_TEXT : null),
    // With the plan, so the canvas never renders the move without knowing it is one (it follows it instead of holding the anchor still).
    planPatch: (plan, opts) => (opts.toFront ? { toFront: { panel: opts.toFront, round: plan.round ?? 0, at: ++frontSeq } } : {}),
    // A new round is one layout change for the Metrics tab, and a panel can go quiet without a layout change (it only fades): count it too.
    committed: (previous, next, { applied, moved }) => ({
      metrics: metricsOnQuietWent(applied && moved ? metricsOnLayoutChange(get().metrics) : get().metrics, newlyQuiet(previous, next)),
    }),
    planChanged: syncLinks,

    trackStart: ({ input, event, panel: p, state: s }) => {
      // Focus aid 1: using a quiet panel brings it back (a manual edit), and when
      // it showed faded that counts as a reopen, a sign the fade was wrong.
      const touched = p !== undefined && isQuietTouch(input);
      const quietPlacement = touched ? s.plan.placements.find((x) => x.id === p && x.quiet) : undefined;
      const reopened = quietPlacement !== undefined && showsQuiet(quietPlacement, input.type === "panel_focus" ? p : undefined);
      if (touched) quietTrack = touchQuiet(quietTrack, p);

      const counted = metricsOnEvent(s.metrics, event, s.upNext?.candidate.id ?? null);
      // Focus aid 4: a record the prep view linked, opened for the first time this session.
      const prepOpen = input.type === "item_open" || input.type === "up_next_open" ? prepRecordOpened(input) : null;
      const firstPrepOpen = prepOpen !== null && !prepOpened.has(prepOpen);
      if (prepOpen !== null) prepOpened.add(prepOpen);
      const withReopen = reopened ? metricsOnQuietReopened(counted) : counted;
      const patch: Partial<Engine> = { metrics: firstPrepOpen ? metricsOnPrepOpened(withReopen) : withReopen };
      // The newest pin or "Make bigger" leads the front group (kept whatever the setting, so switching it on uses the real order).
      if (p && ((input.type === "panel_pin" && !s.pinned.includes(p)) || (input.type === "panel_maximize" && !s.bigger.includes(p)))) {
        patch.front = [p, ...s.front.filter((x) => x !== p)];
      }
      return { patch, unquiet: quietPlacement !== undefined };
    },
    logged: (event, p) => {
      // Focus aid 3: learn from the user's own work, before the flow and the next request read the habits.
      noteHabitEvent(event);
      // Docking a panel takes its links with it.
      if (event.type === "panel_dismiss" && p) dropLinksOf(p);
    },
    worked: (event) => {
      // New work ends the hold on a layout the user went "Back to"; Jev may adapt again.
      if (contextHold && CONTEXT_HOLD_END_TYPES.has(event.type)) contextHold = false;
    },
    tracked: (event) => {
      // The next step: its record opened, its action done, or the follow-up checked off. The suggestions show that at once.
      if (noteLinkEvent(event)) k.refreshPassive();
      refreshFlow();
    },
    densityIgnores: DENSITY_IGNORES,

    roundStart: (res, { promoted }) => {
      // Did the work really change? Before this round's layout lands, so a saved context is the one before the switch.
      // A command round's goal still reads the activity before the command, so the command alone decides that round.
      if (!promoted) noteGoalRound(res);
      // Focus aid 2: one more goal-done round for the working context, now that this round's goal switch (if any) has landed.
      noteDoneRound(res);
      // The next step Jev read from the click, before this round's layout gathers its linked panels.
      noteLinkAnswer(res);
      // One more round for the quiet rule (focus aid 1). Counted even with the aid off, so turning it on uses what Jev said.
      quietTrack = countQuietRound(quietTrack, res.judgments.relevance, res.version);
    },
    roundJudged: (res, now) => {
      // What this round predicts the user opens and does next, for the Metrics tab.
      judgedAt = now;
      const code = flowState(now).listNext[0] ?? null;
      set({ metrics: recordRoundPrediction(get().metrics, { nextRecord: res.judgments.nextRecord, codePick: code, nextAction: res.judgments.nextAction }) });
    },
    roundDone: () => refreshFlow(),

    suggestionAccepted: (current) => {
      if (current.meetingNotes) {
        // Focus aid 4: only now that the user pressed it, the heading goes into the notes, and Notes opens with room to write.
        const heading = current.meetingNotes.heading;
        const title = get().prep?.eventId === current.meetingNotes.eventId ? get().prep?.title : undefined;
        set({ data: { ...get().data, notes: withNotesHeading(get().data.notes, heading) } });
        const p = get().prep;
        if (p?.eventId === current.meetingNotes.eventId) set({ prep: { ...p, notesStarted: true } });
        showNotes();
        setNotice(`Meeting notes started${title ? ` for ${title}` : ""}`);
        k.track({ type: "action", panel: "notes", detail: { actionId: "write_note", label: PREP_NOTES_LABEL, ...(current.args.client ? { client: current.args.client } : {}), via: "suggestion" } });
        return;
      }
      if (current.task) {
        // The follow-up checks off exactly its to-do item, the way the Tasks panel does, and only now that the user pressed it.
        const task = get().data.tasks.find((t) => t.id === current.task?.id);
        if (!task || task.done) return;
        const data = get().data;
        set({ data: { ...data, tasks: data.tasks.map((t) => (t.id === task.id ? { ...t, done: true } : t)) } });
        setNotice(`Checked off: ${task.title}`);
        k.track({
          type: "action",
          panel: "tasks",
          detail: { label: `Checked off task: ${task.title}`, itemKind: "task", itemId: task.id, ...(task.client ? { client: task.client } : {}), via: "suggestion" },
        });
        return;
      }
      performInternal(current.actionId, current.args, "suggestion");
    },
    suggestionDismissed: (s) => {
      // Turning down the next step, or its follow-up, ends it: Up next and the "Next" tag stop offering it.
      if (s.nextStep && linkStep) {
        linkStep = null;
        syncLinks();
      }
      if (s.task && followUp?.taskId === s.task.id) followUp = null;
      // Focus aid 4: "Start meeting notes" turned down is not offered again for that meeting.
      if (s.meetingNotes) prepNotesDismissed = s.meetingNotes.eventId;
    },

    mergeSettings: (prev, patch) => ({
      ...prev,
      ...patch,
      weights: { ...prev.weights, ...(patch.weights ?? {}) },
      focusAids: readFocusAids({ ...prev.focusAids, ...(patch.focusAids ?? {}) }),
    }),
    settingsSet: (prev, settings) => {
      // Focus aid 4 off (or Adaptive off): no chip or card, and the prep view's links become ordinary links; nothing moves.
      prepWentOff = meetingPrepOn(prev) && !meetingPrepOn(settings);
      if (prepWentOff) {
        prepGather = null;
        const l = get().links;
        if (l?.prep) {
          const { prep: _prep, ...plain } = l;
          void _prep;
          set({ links: plain });
        }
      }
      // "Arrange linked panels by next step" off (or Adaptive off): no step, no follow-up, and no "Next" tag; nothing moves.
      linkFlowWentOff = arrangeLinksOn(prev) && !arrangeLinksOn(settings);
      if (linkFlowWentOff) {
        clearLinkFlow();
        syncLinks();
      }
    },
    settingsReleased: (prev, settings) => {
      // The links belong to the adaptive layout too: the other layout would not keep their panels.
      if (prev.adaptive !== settings.adaptive) set({ links: null });
      // So do the hold on a layout the user went "Back to", a half-judged goal switch, and the undo of a "Back to".
      if (prev.adaptive !== settings.adaptive) {
        contextHold = false;
        goalSwitch = null;
        restoreUndo = null;
      } else if (prev.linkLines !== settings.linkLines) syncLinks();
    },
    settingsOther: (prev, settings) => {
      if (prev.focusAids.fadeQuiet !== settings.focusAids.fadeQuiet) {
        applyFadeQuiet(settings.focusAids.fadeQuiet);
      } else if (prev.focusAids.habits !== settings.focusAids.habits) {
        // "Learn my habits": the habit parts, reasons, and suggestion come or go at the normal pace (off: exactly the plan without habits).
        k.replanLocal();
      } else if (linkFlowWentOff) {
        // Only the suggestions change: the step's action and the follow-up go.
        k.refreshPassive();
      }
    },
    settingsDone: (prev, settings) => {
      // The Up next card shows only with Adaptive on and its focus aid on.
      refreshFlow();
      // Focus aid 4: the chip comes or goes at once, and a new lead time applies at once.
      if (prepWentOff || meetingPrepOn(prev) !== meetingPrepOn(settings) || prev.prepLeadMin !== settings.prepLeadMin) refreshPrep();
    },
    persist: (s) => persist(s.settings, s.pinned, s.bigger, s.front),

    undoBack: (s) => {
      // Undo right after "Back to" (its plan is still on screen) puts back
      // everything the restore replaced, not only the layout: the same data
      // a WorkingContext holds, plus the working goal and the saved contexts.
      // Chosen over "restore the context just left" because it is the exact
      // state before the click, and it stays an undo: it does not count as
      // another Back to, save the restored work as a new context, or hold the layout.
      const back = restoreUndo && restoreUndo.round === (s.plan.round ?? 0) && restoreUndo.plan === s.previousPlan ? restoreUndo : null;
      restoreUndo = null;
      undoFrom = back;
      return back;
    },
    undoing: (s, target) => {
      // Undoing the round that made the links (built for their click, or
      // undoing back past it) takes them away too; older links stay.
      const links = s.links;
      const undoesLinks = links !== null && (s.plan.anchor?.at === links.source.at || links.round > (target.round ?? 0));
      // Panels the undone change made quiet are not quiet in what comes back: the user said no, so they start over (focus aid 1).
      const quietAfter = new Set(target.placements.filter((p) => p.quiet).map((p) => p.id));
      for (const p of s.plan.placements) if (p.quiet && !quietAfter.has(p.id)) quietTrack = touchQuiet(quietTrack, p.id);
      // The user undid it; a "Back to" hold does not come back either.
      contextHold = false;
      const back = undoFrom;
      return { ...(undoesLinks ? { links: null } : {}), ...(back ? { view: back.view, working: back.working, contexts: back.contexts } : {}) };
    },
    undone: () => {
      // The link cues that were on screen before "Back to" come back with its undo.
      const back = undoFrom;
      undoFrom = null;
      if (back) set({ links: withNext(onCanvasOnly(back.links, get().plan)) });
    },

    resetStart: () => cancelReplay(),
    resetting: () => {
      linkDrops = null;
      // Predictive flow: session memory only.
      upNextDismissed = {};
      if (upNextTimer !== null) clearTimeout(upNextTimer);
      upNextTimer = null;
      judgedAt = null;
      goalSwitch = null;
      contextHold = false;
      switchIgnoreThrough = 0;
      upNextDoneDismissed = null;
      restoreUndo = null;
      quietTrack = emptyQuietTrack();
      clearLinkFlow();
      // Focus aid 2: session memory only.
      doneRounds = emptyDoneRounds();
      doneSeen.clear();
      doneSnooze = {};
      sentWorking.clear();
      clearTaskDoneTimer();
      // Focus aid 3: a new session for learning; the habits themselves stay (only forgetHabits clears them).
      habitTrail = emptyTrail();
      replaying = false;
      // Focus aid 4: session memory only; a simulated meeting goes with the data.
      prepPrepared.clear();
      prepDismissed.clear();
      prepOffered.clear();
      prepAnswers.clear();
      cancelPrepFlight();
      clearPrepTimer();
      prepGather = null;
      prepOpened.clear();
      prepNotesDismissed = null;
      return {
        data: freshData(),
        view: defaultView(),
        notice: null,
        links: null,
        toFront: null,
        upNext: null,
        upNextDone: null,
        queueMode: false,
        contexts: [],
        working: null,
        taskDone: null,
        prep: null,
        metrics: emptyMetrics(),
      };
    },
    // A real meeting may be coming up.
    resetDone: () => refreshPrep(),
  };

  // ----- the demo's own actions ----------------------------------------------------

  const actions: DemoSpec["actions"] = {
    perform(actionId, args) {
      performInternal(actionId, args, "pointer");
    },

    setView(panel, patch) {
      const view = get().view;
      set({ view: { ...view, [panel]: { ...view[panel], ...patch } } });
      // The current list decides what comes next in it.
      refreshFlow();
    },

    setNotes(text) {
      set({ data: { ...get().data, notes: text } });
    },

    toggleTask(id) {
      const data = get().data;
      set({ data: { ...data, tasks: data.tasks.map((t) => (t.id === id ? { ...t, done: !t.done } : t)) } });
    },

    setFocusAid(id, on, via) {
      const prev = get().settings.focusAids;
      if (!(id in prev) || prev[id] === on) return;
      get().setSettings({ focusAids: { ...prev, [id]: on } });
      // Logged for the inspector: not a trigger, no recent use, and left out of the snapshot (SIGNAL_PROFILE.cueOnly in snapshot.ts).
      k.track(
        { type: "setting_change", detail: { setting: id, enabled: on, label: FOCUS_AID_TEXT[id].label, ...(via ? { via } : {}) } },
        { schedule: false, anchor: false },
      );
    },

    async replayScenario(id) {
      const scenario = SCENARIOS.find((x) => x.id === id);
      if (!scenario) return;
      get().reset(); // Also cancels a running replay.
      const token = ++replayToken;
      // A replay is not the user's work: it teaches no habit (focus aid 3). Reset or the next replay takes over the flag.
      replaying = true;
      try {
        for (let i = 0; i < scenario.steps.length; i++) {
          const step = scenario.steps[i];
          // The first step starts at once unless it asks for a delay.
          const ok = await sleep(step.delayMs ?? (i === 0 ? 0 : REPLAY_STEP_MS), token);
          if (!ok) return;
          replayStep(step);
        }
        if (token === replayToken) set({ focusedPanel: scenario.finalFocus });
      } finally {
        if (token === replayToken) replaying = false;
      }
    },

    setInspectorOpen(open) {
      set({ inspectorOpen: open });
    },

    clearNotice() {
      set({ notice: null });
    },

    clearLinks(via) {
      const links = get().links;
      if (!links) return;
      rememberDrop(links.source.at, "all");
      set({ links: null });
      // Logged for the inspector; links_dismiss never asks Jev and stays out of the snapshot.
      k.track({ type: "links_dismiss", detail: { label: linkLabel(links), ...(via ? { via } : {}) } });
    },

    removeLink(panel) {
      const links = get().links;
      if (!links?.relations[panel]) return;
      rememberDrop(links.source.at, panel);
      set({ links: withNext(withoutLink(links, panel)) });
      k.track({ type: "links_dismiss", detail: { label: linkLabel(links), linkedPanel: panel } });
    },

    openUpNext(id, via = "pointer") {
      const s = get();
      const pick = s.upNext;
      const c = pick ? [pick.candidate, ...pick.alternatives].find((x) => x.id === id) : undefined;
      const r = parseRecordKey(id);
      if (!c || !r) return;
      // A docked panel comes onto the canvas first. Logged as an open from a
      // suggestion (the card offered it), so it is not counted as the user
      // navigating; the record open below anchors the panel.
      if (!s.plan.placements.some((p) => p.id === c.panel)) k.openPanel(c.panel, "suggestion");
      // Select it the way a click in the panel does, clearing only a filter that would hide it.
      const patch = revealPatch(r.kind, r.id, get().data, get().view, Date.now());
      if (patch) applyViewPatches([patch]);
      k.track({
        type: "up_next_open",
        panel: c.panel,
        detail: { itemKind: r.kind, itemId: r.id, ...(c.client ? { client: c.client } : {}), label: c.label, via },
      });
    },

    dismissUpNext(id) {
      upNextDismissed = { ...upNextDismissed, [id]: Date.now() };
      if (upNextTimer !== null) clearTimeout(upNextTimer);
      // Once the dismissal runs out, the record may come back if it is still the best pick.
      upNextTimer = setTimeout(() => {
        upNextTimer = null;
        refreshFlow();
      }, UP_NEXT_DISMISS_MS);
      refreshFlow();
    },

    dismissUpNextDone() {
      const done = get().upNextDone;
      if (!done) return;
      upNextDoneDismissed = done.eventId;
      refreshFlow();
    },

    restoreContext(id, via) {
      const s = get();
      const ctx = s.contexts.find((c) => c.id === id);
      if (!ctx || !backToOn(s.settings)) return;
      const now = Date.now();
      // Save the work being left first, so the user can go straight back to it ("b").
      const leaving = s.working ? captureContext(s.working.goal) : null;
      const before = { plan: s.plan, view: structuredClone(s.view), links: s.links, dismissed: s.dismissed, working: s.working, contexts: s.contexts };
      let contexts = s.contexts.filter((c) => c.id !== id);
      if (leaving) contexts = addContext(contexts, leaving);
      // Going back to earlier work is a move the user chose (focus aid 3).
      noteGoalMove(s.working?.goal, ctx.goal);
      // The anchor, a command's promotion, and a half-judged goal switch were about the work being left.
      k.releaseAnchor();
      k.clearCommandHold();
      goalSwitch = null;
      switchIgnoreThrough = k.version();
      k.clearHeld();
      const plan = restoredPlan(ctx, s.plan, s.pinned);
      const bigger = plan.placements.filter((p) => p.bigger).map((p) => p.id);
      for (const b of s.bigger) if (!bigger.includes(b)) k.forgetSize(b);
      let dismissed = s.dismissed;
      for (const p of plan.placements) dismissed = without(dismissed, p.id);
      set({ view: structuredClone(ctx.view), bigger, dismissed, contexts, working: { goal: ctx.goal, since: now } });
      if (!sameSet(bigger, s.bigger)) k.persist();
      // A manual edit: at once, not after the minimum change interval. The
      // saved cells come back when the column count is the same; otherwise it reflows in the saved order.
      k.setPlanDirect(plan, { keepGrid: true, reflow: true });
      // The link cues come back too, counted from this round (an Undo right after puts back the ones they replaced).
      const placed = get().plan;
      linkDrops = null;
      set({ links: ctx.links ? withNext(onCanvasOnly({ ...ctx.links, round: placed.round ?? 0 }, placed)) : null });
      // Undo goes back to the plan before this restore, even when the layout looked the same, and brings back all of `before`.
      if (get().previousPlan !== s.plan) set({ previousPlan: s.plan });
      restoreUndo = { round: placed.round ?? 0, ...before };
      contextHold = true;
      k.track({ type: "context_restore", detail: { label: ctx.label, ...(via ? { via } : {}) } }, { schedule: false, anchor: false });
    },

    startNextTask(via = "pointer") {
      const s = get();
      const done = s.taskDone;
      const task = done?.next;
      if (!done || !task || !taskDoneOn(s.settings)) return;
      const now = Date.now();
      // Save the work being left first, so a Back to chip returns to it (with the "Back to" aid on).
      if (s.working) saveContext(captureContext(s.working.goal));
      // This completion is acted on: its card does not come back until that goal has open work again.
      doneSeen.set(done.goal, { acked: true });
      // The task's goal is the new working context. Answers to requests sent before this read the work left behind.
      goalSwitch = null;
      switchIgnoreThrough = k.version();
      set({ working: { goal: task.goal, since: now } });
      // A docked panel comes onto the canvas first, logged as an open from a suggestion (not the user navigating); task_start below anchors it.
      if (!get().plan.placements.some((p) => p.id === task.panel)) k.openPanel(task.panel, "suggestion");
      // Its filter and its first record, through the view state, the way a click there would. Never an action.
      const patch = taskViewPatch(task, get().data);
      if (patch) applyViewPatches([patch]);
      k.track({
        type: "task_start",
        panel: task.panel,
        detail: {
          itemKind: task.first.kind,
          itemId: task.first.id,
          ...(task.first.client ? { client: task.first.client } : {}),
          label: task.first.label,
          task: task.words,
          via,
        },
      });
    },

    snoozeTaskDone() {
      const done = get().taskDone;
      if (!done) return;
      doneSnooze = { ...doneSnooze, [done.goal]: Date.now() + TASK_DONE_SNOOZE_MS };
      refreshFlow();
    },

    dismissTaskDone() {
      const done = get().taskDone;
      if (!done) return;
      doneSeen.set(done.goal, { acked: true });
      refreshFlow();
    },

    forgetHabits() {
      clearSavedHabits(storage());
      set({ habits: emptyHabits(), metrics: { ...get().metrics, habits: { guessed: 0, right: 0 } } });
      // The habit parts, reasons, and suggestion go at the normal pace; Up next and the Done card at once.
      k.replanLocal();
      refreshFlow();
    },

    loadSampleHabits() {
      const now = Date.now();
      keepHabits(mergeHabits(get().habits, sampleWeek(now), now));
      k.replanLocal();
      refreshFlow();
    },

    prepareMeeting(via = "pointer") {
      const s = get();
      const cur = s.prep;
      if (!cur || cur.stage !== "offer" || !meetingPrepOn(s.settings)) return;
      const meeting = s.data.events.find((e) => e.id === cur.eventId);
      if (!meeting?.client) return;
      const now = Date.now();
      // Save the work being left first, so a Back to chip returns to it (with the "Back to" aid on).
      saveContext(captureContext(s.working?.goal ?? "unclear"));
      prepPrepared.add(meeting.id);
      // The meeting's client is the new working context. Answers to requests sent before this read the work left behind.
      goalSwitch = null;
      switchIgnoreThrough = k.version();
      k.clearCommandHold();
      k.clearHeld();
      set({ working: { goal: "manage_client", since: now, client: meeting.client } });
      // The meeting selected and the client's records in view, through the view state, the way the user would set them. Never an action.
      applyViewPatches(prepViewPatches(meeting, buildPrepRecords(meeting, get().data, now), get().view, now));
      // Calendar holds still while the rest gathers around it, so it needs a cell first: a docked Calendar comes onto the canvas.
      if (!get().plan.placements.some((p) => p.id === "calendar")) k.setPlanDirect(editPlan(get().plan, { kind: "open", panel: "calendar" }), { holdAll: true });
      k.setAnchor({ panel: "calendar", itemKind: "event", itemId: meeting.id, client: meeting.client, source: "work" }, now);
      const anchor = get().anchor;
      set({ prep: prepStateFor(meeting, "ready") });
      // A manual edit: at once, not after the minimum change interval.
      if (anchor) arrangePrep(meeting, anchor);
      // The prep view holds until the user does new work, like a layout they went back to.
      contextHold = true;
      k.track(
        { type: "prep_start", panel: "calendar", detail: { itemKind: "event", itemId: meeting.id, client: meeting.client, label: eventLabel(meeting, now), via } },
        { schedule: false, anchor: false },
      );
      // The records may have changed since the prefetch: ask again for exactly these (the view takes the answer when it lands).
      requestPrep(meeting);
    },

    snoozePrep() {
      const p = get().prep;
      if (!p || p.stage !== "offer") return;
      prepDismissed.add(p.eventId);
      set({ prep: null });
      refreshPrep();
    },

    dismissPrep() {
      const p = get().prep;
      if (!p || p.stage !== "ready") return;
      set({ prep: null });
      dropPrepSuggestion();
      // Another meeting may be coming up; this one was prepared for and is not offered again.
      refreshPrep();
    },

    simulateMeeting() {
      const s = get();
      const event = simulatedMeeting(s.events, s.data, Date.now(), ++simSeq);
      if (!event) return;
      set({ data: { ...s.data, events: [...s.data.events, event] } });
      setNotice(`Test meeting added: ${event.title} at ${clockTime(event.start)} with ${event.client}`);
      refreshPrep();
    },
  };

  const state: Partial<Engine> & DemoSpec["state"] = {
    data: freshData(),
    view: defaultView(),
    settings: persisted.settings,
    pinned: persisted.pinned,
    bigger: persisted.bigger,
    front: persisted.front,
    toFront: null,
    inspectorOpen: false,
    notice: null,
    links: null,
    // Predictive flow (docs/predictive-flow.md).
    upNext: null,
    upNextDone: null,
    queueMode: false,
    contexts: [],
    working: null,
    // Focus aid 2 (docs/focus-aids.md).
    taskDone: null,
    // Focus aid 3: the habits saved in this browser (none when storage is blocked or the save is unreadable).
    habits: loadHabits(storage()),
    // Focus aid 4: the prep chip or card, once a meeting comes up.
    prep: null,
    metrics: emptyMetrics(),
  };

  // Focus aid 4: start looking for a meeting to prepare for (then every PREP_RECHECK_MS), in a browser.
  return { state, actions, hooks, ...(inBrowser ? { start: refreshPrep } : {}) };
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** In a browser, not Node (tests, the eval): only then the store checks the server's health and looks for meetings. */
const inBrowser = typeof window !== "undefined" && typeof fetch === "function";

export const useEngine = create<Engine>()((set, get) =>
  createAdaptiveEngine<DemoSpec>(
    {
      catalog: CATALOG,
      policy: POLICY,
      send: postAdapt,
      words: WORDS,
      profile: SIGNAL_PROFILE,
      anchorTypes: ANCHOR_TYPES,
      realActionTypes: REAL_ACTION_TYPES,
      passiveTypes: LOCAL_REPLAN_TYPES,
      focusTypes: FOCUS_TYPES,
      commandMaxLength: COMMAND_MAX_LENGTH,
      ...(inBrowser ? { watchHealth } : {}),
      extend: demoExtension,
    },
    { get, set },
  ),
);
