/**
 * The adaptive loop for an app, in one framework-free store: the kernel.
 *
 * The UI reports what the user does with track(); the store keeps the event
 * log, asks the model for judgments through the scheduler (debounced, one
 * request in flight, commands first), turns the newest judgments into a plan
 * with the app's policy (createPolicy), and places it on the canvas with the
 * clicked panel held still (placePlan). Request bookkeeping and timers live
 * in the store's closure because they are not UI state.
 *
 * The calm relayout rules come from the demo and keep its numbers:
 *   - the panel the user works in is the anchor; its top-left holds still,
 *     and it is released after ANCHOR_IDLE_RELEASE_MS without work,
 *   - the card under the pointer waits POINTER_MOVE_HOLD_MS to move and
 *     POINTER_LEAVE_HOLD_MS to leave,
 *   - layout changes are at least settings.minChangeIntervalMs apart,
 *   - after a manual edit under the pointer, or while keyboard focus is on
 *     the canvas, other cards wait until the hands leave (or
 *     MANUAL_EDIT_HOLD_MS), so the next click lands where the user aimed,
 *   - a command's promotion survives local re-plans from the same judgments
 *     for COMMAND_HOLD_MS,
 *   - undo puts the previous plan back, holds it UNDO_HOLD_MS, and does not
 *     redo the undone change while the judgments stay the same.
 *
 * An app adds its own features without a second loop. Hooks (AdaptiveHooks)
 * run at fixed points of the loop: on each tracked event, before a request,
 * on an answer, as extra policy input, after the policy's plan, on a commit,
 * and around settings, undo, and reset. `extend` gets the kernel's
 * primitives (AdaptiveKernel) and returns the app's own state, actions, and
 * hooks. The demo's focus aids (apps/demo/src/engine/store.ts) are one such
 * extension.
 *
 * Two ways to hold the state: createAdaptiveStore keeps it in a small store
 * of its own (getState, setState, subscribe; @attuneui/react has
 * useAdaptive), and createAdaptiveEngine runs on a host's get and set, for
 * example a zustand store's initializer. The state carries the actions, as
 * in zustand, and createAdaptiveStore also puts them on the store.
 */
import type { Catalog } from "./catalog.ts";
import { PANEL_UNCLEAR } from "./catalog.ts";
import type { Policy, PolicyInput, PlanEdit } from "./createPolicy.ts";
import { emptySummary, type GridColumns, type PanelSize } from "./grid.ts";
import type { ChoiceJudgment, CoreCommandJudgments, CoreJudgments } from "./judgments.ts";
import type { LayoutMode } from "./layoutModes.ts";
import { cellsEqual, placePlan, reflowCells, withGrid, type PlaceOptions } from "./place.ts";
import type { AnchorRef, CoreSuggestion, LayoutPlan, RelatedRecord } from "./plan.ts";
import { judgedDensity, type BlendWeights, type Decision, type Density } from "./policy.ts";
import { AdaptScheduler, type SendArgs } from "./scheduler.ts";
import { signalProfile, type CoreSignalType, type SignalDetail, type SignalProfile, type SignalVia } from "./signals.ts";
import { buildSnapshot, describeCoreEvent, type EventWords, type InteractionSnapshot } from "./snapshot.ts";

// ---------------------------------------------------------------------------
// Thresholds (the demo's)
// ---------------------------------------------------------------------------

/** Adaptation records kept for an inspector. */
export const HISTORY_LIMIT = 30;
/** Signal events kept in memory. Snapshots and usage only look at recent ones. */
export const EVENT_LOG_LIMIT = 300;
/** Judged layout modes kept for mode hysteresis. */
export const RECENT_MODES_LIMIT = 5;
/** Judged densities kept for the density streak rule. */
export const RECENT_DENSITIES_LIMIT = 5;
/** After an undo, hold automatic layout changes this long so the undo sticks. */
export const UNDO_HOLD_MS = 15_000;
/**
 * After an undo, do not redo the undone change (mode switch, panels added or
 * docked) until the judgments change materially, or at most this long. Past
 * the 15 s hold, the same judgments brought the undone change straight back.
 */
export const UNDO_MEMORY_MS = 5 * 60_000;
/** A different top panel counts as a material change only when it leads the old one by this share of the relevance scale. */
export const UNDO_TOP_PANEL_MARGIN = 0.1;
/**
 * A command's promotion (its panel first as the hero, in Focus) survives
 * local re-plans from the same judgments for this long, or until a newer
 * round lands. Without it, a pointer rest 2 s after "calendar" re-read that
 * round's "overview" judgment and undid the command with no new information.
 */
export const COMMAND_HOLD_MS = 45_000;
/**
 * After a pin, unpin, or dock under the pointer, the other cards keep their
 * places until the pointer leaves the canvas (as browser tab strips do), a
 * real action happens, or this long passes, so the next click lands on the
 * card the user aimed at. The cap keeps a resting mouse from freezing the canvas.
 */
export const MANUAL_EDIT_HOLD_MS = 10_000;
/**
 * An anchoring event this soon after a press in a card belongs to the
 * pressed card: a button in one card can log a filter on another, but the
 * user's eyes are on the card they pressed, so it holds still.
 */
export const ANCHOR_PRESS_WINDOW_MS = 1_000;
/** The anchor is released after this long without work, so a later round may rebalance the canvas. */
export const ANCHOR_IDLE_RELEASE_MS = 20_000;
/**
 * A card under the pointer keeps its cell for at most this long after a
 * round first wanted to move it, so the next click does not land on a card
 * that slid in, while a mouse left resting does not freeze the canvas.
 */
export const POINTER_MOVE_HOLD_MS = 3_000;
/** Longer for a card that would leave: taking away what the user points at is worse than moving it. */
export const POINTER_LEAVE_HOLD_MS = 5_000;
/** The default command rule (no `resolveCommand` hook): a panel answer at or above this applies, and the panel becomes the hero. */
export const COMMAND_PANEL_AT = 0.6;
/** Command text longer than this is clipped before it is sent. Matches COMMAND_MAX_LENGTH in @attuneui/server. */
export const COMMAND_TEXT_MAX = 300;
/** A dismissal this soon after opening a panel records how long it was open. */
export const DISMISS_DURATION_WINDOW_MS = 10 * 60_000;

/** Core events that ask the model for a new read. panel_focus counts only when the focused panel changed. */
export const CORE_TRIGGER_TYPES: ReadonlySet<string> = new Set<CoreSignalType>(["item_open", "filter", "search", "action", "command", "panel_open", "panel_dismiss", "suggestion_dismiss"]);
/** Events that only refresh the suggestions from the last judgments; they never move a panel. */
export const CORE_PASSIVE_TYPES: ReadonlySet<string> = new Set<CoreSignalType>(["panel_dwell", "scroll", "shortcut", "panel_pin", "panel_unpin"]);
/**
 * Events that make the panel they happen in (or the pressed card) the
 * anchor. Opening a panel from the dock counts: the user asked for that
 * card, so the next round keeps it and everything before it where they are.
 */
export const CORE_ANCHOR_TYPES: ReadonlySet<string> = new Set<CoreSignalType>(["item_open", "filter", "action", "search", "panel_focus", "panel_open"]);
/** Events that mean the user acted, not just looked or moved focus. They end a keyboard or pointer hold. */
export const CORE_REAL_ACTION_TYPES: ReadonlySet<string> = new Set<CoreSignalType>(["item_open", "filter", "search", "action", "suggestion_accept"]);
/**
 * Events a button can log against another panel (a button in one card can
 * log a filter on another). Only these follow the press; a focus, an opened
 * row, or a search always happens in its own panel.
 */
const CROSS_PANEL_TYPES: ReadonlySet<string> = new Set<CoreSignalType>(["filter", "action"]);
/** Signals that are a manual edit of one panel, applied at once (manualReplan). */
const MANUAL_EDITS: Partial<Record<string, PlanEdit["kind"]>> = {
  panel_pin: "pin",
  panel_unpin: "unpin",
  panel_dismiss: "dismiss",
  panel_open: "open",
  panel_maximize: "bigger",
  panel_restore: "smaller",
};
/** History text for a round whose layout waits for the minimum change interval. */
export const HELD_TEXT = "Waiting a moment before moving panels again";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** What the UI passes to track(). The store adds id, time, and text. */
export interface TrackInput<P extends string = string, T extends string = string> {
  type: CoreSignalType | T;
  panel?: P;
  detail?: SignalDetail;
}

export interface LoggedEvent<P extends string = string, T extends string = string> extends TrackInput<P, T> {
  id: number;
  t: number;
  text: string;
}

/** What the store sends by default: the snapshot in words, the command if any, and the app's own fields. */
export interface AdaptiveRequest {
  version: number;
  snapshot: InteractionSnapshot;
  command?: string;
}

/** What the server answers. `judgments.command` is present when the request carried a command. */
export interface AdaptiveResponse<J> {
  version: number;
  source: string;
  judgments: J;
  meta?: { model?: string; error?: string; fallback?: "no_key" | "jev_error" };
}

export type AdaptiveStatus = "idle" | "thinking" | "offline" | "error";

export interface AdaptiveSettings {
  /** Off: the fixed layout plus the user's own changes. */
  adaptive: boolean;
  /** On: nothing moves automatically; manual edits still apply. */
  frozen: boolean;
  weights: BlendWeights;
  minChangeIntervalMs: number;
}

/** The command bar's outcome. An app with its own command rule adds fields (options, a message). */
export interface CommandOutcome<P extends string = string> {
  text: string;
  status: "applied" | "confirm" | "unclear";
  panel?: P;
}

/**
 * What a command means for the layout. `promote` is the panel to make the
 * hero, `suggestion` an action to offer first, `decision` the change line
 * for the promotion. An app with its own command rule adds fields (view
 * changes, the records it names).
 */
export interface CommandResolution<P extends string = string, S extends CoreSuggestion = CoreSuggestion, O extends CommandOutcome<P> = CommandOutcome<P>> {
  outcome: O;
  promote: P | null;
  suggestion: S | null;
  decision?: Decision<P> | null;
}

/** What a health check found: the server answered (and whether the model is reachable), or it failed. */
export type HealthCheck = { ok: true; info: { jev?: boolean | null } } | { ok: false; error: unknown };

/** The judgments of one round, with the command's when the request carried one. */
export type JudgmentsWithCommand<P extends string, G extends string, A extends string> = CoreJudgments<P, G, A> & { command?: CoreCommandJudgments<P, A> };

/**
 * The app's types in one place. Extend it and narrow what the app uses; the
 * rest follow (`this`), for example:
 *
 *   interface DeskSpec extends AdaptiveSpec { panel: PanelId; goal: GoalId; action: ActionId; kind: RecordKind }
 */
export interface AdaptiveSpec {
  panel: string;
  goal: string;
  action: string;
  /** Record kinds (AnchorRef.itemKind). */
  kind: string;
  /** The app's own event types, beyond the core ones. */
  eventType: string;
  input: TrackInput<this["panel"], this["eventType"]>;
  event: this["input"] & { id: number; t: number; text: string };
  suggestion: CoreSuggestion<this["action"]>;
  judgments: JudgmentsWithCommand<this["panel"], this["goal"], this["action"]>;
  response: AdaptiveResponse<this["judgments"]>;
  request: AdaptiveRequest;
  /** The policy's input type (createPolicy's I). */
  policyInput: PolicyInput<this["panel"], this["goal"], this["action"], this["suggestion"], this["kind"]>;
  /** The policy's extra argument (createPolicy's X). */
  policyExtra: unknown;
  outcome: CommandOutcome<this["panel"]>;
  resolution: CommandResolution<this["panel"], this["suggestion"], this["outcome"]>;
  settings: AdaptiveSettings;
  /** The app's own state fields. */
  state: object;
  /** The app's own actions. */
  actions: object;
}

export type PlanOf<Sp extends AdaptiveSpec> = LayoutPlan<Sp["panel"], Sp["suggestion"], Sp["kind"]>;
type Anchor<Sp extends AdaptiveSpec> = AnchorRef<Sp["panel"], Sp["kind"]>;
type Dismissed<Sp extends AdaptiveSpec> = Partial<Record<Sp["panel"], number>>;

export interface RoundRecord<Sp extends AdaptiveSpec> {
  version: number;
  at: number;
  trigger: string;
  response: Sp["response"];
  decisions: Decision<Sp["panel"]>[];
  stale: boolean;
}

export interface AdaptiveState<Sp extends AdaptiveSpec> {
  events: Sp["event"][];
  plan: PlanOf<Sp>;
  /** The previous plan, for undo. */
  previousPlan: PlanOf<Sp> | null;
  /** The last answer that was applied. */
  last: Sp["response"] | null;
  history: RoundRecord<Sp>[];
  status: AdaptiveStatus;
  lastError: string | null;
  settings: Sp["settings"];
  pinned: Sp["panel"][];
  /** Panels the user made bigger. */
  bigger: Sp["panel"][];
  /** Panel id -> epoch ms when the user sent it to the dock. */
  dismissed: Dismissed<Sp>;
  focusedPanel: Sp["panel"] | null;
  /** The live anchor: the panel the user just worked in, or a command's hero. Null once released. */
  anchor: Anchor<Sp> | null;
  pointer: { panel: Sp["panel"] | null; down: boolean };
  /** Canvas column count (setColumns). The grid is packed for this count. */
  columns: GridColumns;
  goal: { id: Sp["goal"]; confidence: number } | null;
  mode: LayoutMode;
  /** The last command and what came of it. */
  command: Sp["outcome"] | null;
}

type Via = "pointer" | "keyboard";

export interface AdaptiveActions<Sp extends AdaptiveSpec> {
  /** Record a user signal. May schedule a request (debounced). */
  track(input: Sp["input"]): void;
  /** Send command bar text. Judged together with the current snapshot in one request. */
  runCommand(text: string, via?: SignalVia): Promise<void>;
  /** The user picked what a command meant (one of its options): apply that panel. */
  chooseCommandOption(panel: Sp["panel"]): void;
  clearCommand(): void;
  pin(panel: Sp["panel"]): void;
  unpin(panel: Sp["panel"]): void;
  /** Make a panel on the canvas bigger, at once. No-op when it is not on the canvas or already bigger. */
  maximize(panel: Sp["panel"], via?: Via): void;
  /** Make a panel the user made bigger smaller again, at once. */
  restore(panel: Sp["panel"], via?: Via): void;
  /** Send a panel to the dock. It will not be promoted again for a while. */
  dismiss(panel: Sp["panel"]): void;
  /** Bring a docked panel onto the canvas. */
  open(panel: Sp["panel"]): void;
  setFocused(panel: Sp["panel"] | null): void;
  /** Accept a suggestion that is still offered: log it and take it off the row. The app does the action (hook `suggestionAccepted`). */
  acceptSuggestion(s: Sp["suggestion"]): void;
  dismissSuggestion(s: Sp["suggestion"]): void;
  setSettings(patch: Partial<Sp["settings"]>): void;
  setWeights(patch: Partial<Sp["settings"]["weights"]>): void;
  /** Restore the previous plan, or `to` when given. */
  undo(to?: PlanOf<Sp>): void;
  /** Clear the events and return to the starting layout. Pins and settings stay. */
  reset(): void;
  /** Ask the model now. */
  adaptNow(trigger?: string): Promise<void>;
  /** The pointer or keyboard focus is on the canvas (true) or left it (false). */
  setCanvasHold(source: "pointer" | "keyboard", active: boolean): void;
  /** Which panel the pointer is over, and whether it is pressed. No-op when nothing changed. */
  setPointer(pointer: { panel: Sp["panel"] | null; down: boolean }): void;
  /** The canvas column count. The current plan is re-packed for it. */
  setColumns(columns: GridColumns): void;
  /** Stops every timer and the request in flight. */
  dispose(): void;
}

export type AdaptiveFull<Sp extends AdaptiveSpec> = AdaptiveState<Sp> & Sp["state"] & AdaptiveActions<Sp> & Sp["actions"];

/** How to place a plan (PlaceOptions), plus the panel a pin or "Make bigger" sent to the front. */
export interface StorePlaceOptions<P extends string = string> extends PlaceOptions<P> {
  /** The panel a pin or "Make bigger" sent to the front. The `planPatch` hook sees it with the placed plan, in one update. */
  toFront?: P;
}

/** The command's promotion, kept until a newer round lands (COMMAND_HOLD_MS). */
export interface CommandHold<P extends string, S> {
  panel: P;
  version: number;
  at: number;
  suggestion: S | null;
}

/** The kernel's primitives, for an extension's own actions and hooks. */
export interface AdaptiveKernel<Sp extends AdaptiveSpec> {
  get(): AdaptiveFull<Sp>;
  set(patch: Partial<AdaptiveFull<Sp>>): void;
  /** Log an event. `schedule: false`: never asks the model. `anchor: false`: does not move the anchor. */
  track(input: Sp["input"], opts?: { schedule?: boolean; anchor?: boolean }): void;
  /** Bring a panel onto the canvas (or focus it when it is there), logged with `via`. */
  openPanel(panel: Sp["panel"], via?: SignalVia): void;
  place(next: PlanOf<Sp>, opts?: StorePlaceOptions<Sp["panel"]>): { plan: PlanOf<Sp>; heldMove: Sp["panel"] | null };
  /** Place and apply a plan at once (a manual edit): no minimum interval, no holds. */
  setPlanDirect(next: PlanOf<Sp>, opts?: StorePlaceOptions<Sp["panel"]>): void;
  /** Re-plan from the last judgments without asking the model. True when the plan changed. */
  replanLocal(opts?: { force?: boolean; skipQuiet?: boolean }): boolean;
  /** Refresh the suggestions from the last judgments, never moving a panel. */
  refreshPassive(): void;
  noteDecisions(plan: PlanOf<Sp>): void;
  /** The fixed layout plus the user's own changes. */
  basePlan(): PlanOf<Sp>;
  releaseAnchor(): void;
  setAnchor(ref: Omit<Anchor<Sp>, "at" | "label">, now: number): void;
  clearHeld(): void;
  /** Forget the pointer's hold (the card under the pointer may move at once). */
  clearPointerHold(): void;
  clearCommandHold(): void;
  /** Take a suggestion off the command hold, so a re-plan does not bring it back. */
  dropHeldSuggestion(match: (s: Sp["suggestion"]) => boolean): void;
  /** Forget the size a panel had before the user made it bigger. */
  forgetSize(panel: Sp["panel"]): void;
  /** The plan with `s` first, as the primary suggestion; the others stay, as subtle ones. */
  addSuggestion(plan: PlanOf<Sp>, s: Sp["suggestion"], opts?: { announce?: boolean }): PlanOf<Sp>;
  /** The request version now: requests sent up to it read the state as it was. */
  version(): number;
  /** Save what the app keeps across visits (hook `persist`). */
  persist(): void;
}

type Full<Sp extends AdaptiveSpec> = AdaptiveFull<Sp>;

/**
 * Optional hooks at fixed points of the loop. An app sets the ones it needs
 * in the config or returns them from `extend`. Each says when it runs; the
 * defaults are the core behavior.
 */
export interface AdaptiveHooks<Sp extends AdaptiveSpec> {
  // ----- words, types, and records ------------------------------------------
  /** The sentence for an event. Absent, or undefined: the core sentence. */
  describe?: (input: Sp["input"]) => string | undefined;
  /** Whether an event asks the model for a new read. Default: CORE_TRIGGER_TYPES, and panel_focus on a new panel. */
  triggers?: (type: Sp["input"]["type"], focusChanged: boolean) => boolean;
  /** The record kind of an id, when an event names an id but no kind. */
  itemKindOf?: (itemId: string | undefined) => Sp["kind"] | undefined;
  /** The client a search names, so a search anchors on it. */
  clientIn?: (query: string) => string | undefined;
  /** A short name for the anchor's link tags. Default: the event's label, else its client. */
  anchorLabel?: (ref: Omit<Anchor<Sp>, "at" | "label">, state: Full<Sp>) => string | undefined;
  /** Two suggestions offer the same thing. Default: the same action and label. */
  sameSuggestion?: (a: Sp["suggestion"], b: Sp["suggestion"]) => boolean;
  /** A suggestion's identity for change detection. Default: action, prominence, and label. */
  suggestionKey?: (s: Sp["suggestion"]) => string;
  /** The panel a suggestion's accept or dismiss is logged against. Default: the catalog action's panel. */
  suggestionPanel?: (s: Sp["suggestion"]) => Sp["panel"] | undefined;
  /** More detail for a suggestion's accept or dismiss event (for example its client). */
  suggestionDetail?: (s: Sp["suggestion"]) => SignalDetail;

  // ----- requests ---------------------------------------------------------------
  /** The request to send. Default: the core snapshot plus `requestFields`. Runs once per request, at send time. */
  request?: (state: Full<Sp>, args: { now: number; version: number; kind: SendArgs["kind"]; command?: string }) => Sp["request"];
  /** The app's own fields on the default request (candidates and so on). */
  requestFields?: (state: Full<Sp>) => Record<string, unknown>;
  /** A thrown error means the request was replaced or cancelled. Default: an AbortError, or the signal aborted. */
  isAbort?: (err: unknown) => boolean;
  /** Checks the server at start and, while it fails, again (the app's own backoff). The store sets the status from it. */
  watchHealth?: (opts: { onResult: (r: HealthCheck) => void }) => unknown;

  // ----- commands -----------------------------------------------------------------
  /** What a command's judgments mean. `forcePanel`: the user picked that panel. Default: COMMAND_PANEL_AT on the panel answer. */
  resolveCommand?: (judgments: NonNullable<Sp["judgments"]["command"]>, text: string, opts: { forcePanel?: Sp["panel"] }, state: Full<Sp>) => Sp["resolution"];
  /** A resolved command, before its outcome is set: the app applies its own parts (filters, a working context). `chosen`: from chooseCommandOption. */
  commandResolved?: (resolution: Sp["resolution"], opts: { chosen: boolean }) => void;
  /** The outcome when the answer has no command judgments. */
  commandUnclear?: (text: string) => Sp["outcome"];
  /** The outcome when the command's request failed. */
  commandFailed?: (text: string, err: unknown) => Sp["outcome"];
  /** The record or client a command's hero anchors on. */
  commandAnchor?: (resolution: Sp["resolution"]) => Partial<Pick<Anchor<Sp>, "itemKind" | "itemId" | "client">>;

  // ----- the plan -----------------------------------------------------------------
  /** The starting plan, and the plan after reset (with `bigger` empty). Default: the fixed layout, with cells when adaptive. */
  initialPlan?: (state: Full<Sp>) => PlanOf<Sp>;
  /** The front group: panels that lead the order (pins and bigger panels, newest first). Absent: pins first. */
  front?: (state: Full<Sp>) => Sp["panel"][] | undefined;
  /** Panels the link cues on screen keep on the canvas (PolicyInput.linkHold). */
  linkHold?: (state: Full<Sp>) => { source: Sp["panel"]; linked: Sp["panel"][] } | undefined;
  /** Records joined to the anchor, per panel, from the app's data. Absent: no links. */
  linked?: (anchor: Anchor<Sp>, state: Full<Sp>, now: number) => Partial<Record<Sp["panel"], RelatedRecord<Sp["kind"]>[]>> | undefined;
  /** The linked panels in next-step order, gathered next to the work anchor in an automatic round (PlaceInput.gather). */
  gather?: (plan: PlanOf<Sp>, anchor: Anchor<Sp>) => Sp["panel"][] | undefined;
  /** More policy input (quiet panels, habits). */
  policyInput?: (state: Full<Sp>, now: number) => Partial<Sp["policyInput"]>;
  /** The policy's extra argument (createPolicy's X), from the state now. */
  extra?: (state: Full<Sp>) => Sp["policyExtra"];
  /** The policy's plan, before the command hold: the app adds its own suggestions. */
  afterPolicy?: (plan: PlanOf<Sp>) => PlanOf<Sp>;
  /** Non-null: automatic changes wait (for example on a layout the user went back to), with this text in the history. Manual edits and commands still apply. */
  layoutHold?: () => string | null;
  /** State to set with a plan placed at once (setPlanDirect), in the same update. */
  planPatch?: (plan: PlanOf<Sp>, opts: StorePlaceOptions<Sp["panel"]>) => Partial<Full<Sp>>;
  /** State to set with a committed policy plan, in the same update. `applied`: a visible change; `moved`: a new round. */
  committed?: (previous: PlanOf<Sp>, next: PlanOf<Sp>, info: { applied: boolean; moved: boolean }) => Partial<Full<Sp>>;
  /** After the plan or the anchor changed (the app's cues follow them). */
  planChanged?: () => void;

  // ----- events -------------------------------------------------------------------
  /** Each event, before it is logged: state to set with it, and `unquiet` when it uses a quiet panel (it becomes a normal panel). */
  trackStart?: (ctx: { input: Sp["input"]; event: Sp["event"]; panel: Sp["panel"] | undefined; state: Full<Sp>; now: number }) => { patch?: Partial<Full<Sp>>; unquiet?: boolean } | void;
  /** Right after an event is logged and the pins and dock marks follow it. */
  logged?: (event: Sp["event"], panel: Sp["panel"] | undefined) => void;
  /** After the anchor followed an event, before holds end and the plan changes. */
  worked?: (event: Sp["event"]) => void;
  /** Last, after an event is handled and maybe scheduled. */
  tracked?: (event: Sp["event"]) => void;
  /** Event types not counted for the density rule. Default: panel_dwell and the profile's cue-only types. */
  densityIgnores?: ReadonlySet<string>;

  // ----- answers ----------------------------------------------------------------
  /** An answer that will be applied, before its layout: the app reads its own judgments. `promoted`: a command promoted a panel this round. */
  roundStart?: (res: Sp["response"], info: { promoted: boolean }) => void;
  /** After the answer's judgments are the last ones, before its layout. */
  roundJudged?: (res: Sp["response"], now: number) => void;
  /** After the answer's layout and history. */
  roundDone?: (res: Sp["response"]) => void;

  // ----- suggestions, settings, undo, reset ---------------------------------
  /** A suggestion was accepted, logged, and taken off the row: do it. */
  suggestionAccepted?: (s: Sp["suggestion"]) => void;
  /** A suggestion was dismissed and taken off the row, before the dismissal is logged. */
  suggestionDismissed?: (s: Sp["suggestion"]) => void;
  /** Merge a settings patch. Default: shallow, with the weights merged. */
  mergeSettings?: (prev: Sp["settings"], patch: Partial<Sp["settings"]>) => Sp["settings"];
  /** Settings changed: right after they are set and saved, before the anchor is released. */
  settingsSet?: (prev: Sp["settings"], next: Sp["settings"]) => void;
  /** After the anchor and pointer hold were released for a switch of Adaptive or Freeze, before the layout follows. */
  settingsReleased?: (prev: Sp["settings"], next: Sp["settings"]) => void;
  /** Neither Adaptive nor Freeze changed: the app's own settings take effect. */
  settingsOther?: (prev: Sp["settings"], next: Sp["settings"]) => void;
  /** Last, after the layout followed the settings. */
  settingsDone?: (prev: Sp["settings"], next: Sp["settings"]) => void;
  /** Save what the app keeps across visits. Called when the settings, pins, or bigger panels change. */
  persist?: (state: Full<Sp>) => void;
  /** Undo starts: a plan and dock marks to go back to instead of the previous plan (for example before a "Back to"). */
  undoBack?: (state: Full<Sp>) => { plan: PlanOf<Sp>; dismissed: Dismissed<Sp> } | null;
  /** Before the undo's anchor release: state to set with the restored plan. */
  undoing?: (state: Full<Sp>, target: PlanOf<Sp>, back: { plan: PlanOf<Sp>; dismissed: Dismissed<Sp> } | null) => Partial<Full<Sp>>;
  /** After the restored plan is set, before the undo is logged. */
  undone?: (back: { plan: PlanOf<Sp>; dismissed: Dismissed<Sp> } | null) => void;
  /** Reset starts, before the request in flight is cancelled. */
  resetStart?: () => void;
  /** Reset clears the app's bookkeeping and returns its fresh state fields. */
  resetting?: () => Partial<Full<Sp>>;
  /** After reset. */
  resetDone?: () => void;
}

export interface AdaptiveStoreConfig<Sp extends AdaptiveSpec> extends AdaptiveHooks<Sp> {
  catalog: Catalog<Sp["panel"], Sp["goal"], Sp["action"]>;
  /** The app's policy (createPolicy). */
  policy: Policy<Sp["panel"], Sp["suggestion"], Sp["kind"], Sp["policyInput"], Sp["policyExtra"]>;
  /** Sends one request to the app's server and returns its answer. Abort the call when `signal` aborts. */
  send: (request: Sp["request"], opts: { signal: AbortSignal }) => Promise<Sp["response"]>;
  /** The app's words for the snapshot (panel titles, record kinds, actions in the past tense). */
  words: EventWords<Sp["panel"]>;
  /** How the app's own event types count. Default: the core profile. */
  profile?: SignalProfile<string>;
  /** Events that make their panel the anchor. Default: CORE_ANCHOR_TYPES. */
  anchorTypes?: ReadonlySet<string>;
  /** Events that end a keyboard or pointer hold. Default: CORE_REAL_ACTION_TYPES. */
  realActionTypes?: ReadonlySet<string>;
  /** Events that only refresh the suggestions. Default: CORE_PASSIVE_TYPES. */
  passiveTypes?: ReadonlySet<string>;
  /** Events that make their panel the focused one. Default: panel_focus and the profile's record opens. */
  focusTypes?: ReadonlySet<string>;
  /** The app's help panel, for the snapshot. */
  helpPanel?: Sp["panel"];
  /** Starting settings over the defaults. */
  settings?: Partial<Sp["settings"]>;
  /** The starting column count. Default 4. */
  columns?: GridColumns;
  /** Command text longer than this is clipped. Default COMMAND_TEXT_MAX. */
  commandMaxLength?: number;
  /** The app's own state, actions, and hooks, built on the kernel's primitives. Called once, when the store is made. */
  extend?: (kernel: AdaptiveKernel<Sp>) => {
    state?: Partial<Full<Sp>> & Sp["state"];
    actions?: Partial<AdaptiveActions<Sp>> & Sp["actions"];
    hooks?: AdaptiveHooks<Sp>;
    /** Runs once, in a timer after the store exists (work that reads the store). */
    start?: () => void;
  };
}

/** Where the state lives: a host's get and set (for example zustand's initializer arguments). */
export interface AdaptiveHost<Sp extends AdaptiveSpec> {
  get(): Full<Sp>;
  set(patch: Partial<Full<Sp>>): void;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function withoutKey<T extends string>(map: Partial<Record<T, number>>, key: T): Partial<Record<T, number>> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** Same members, in any order. */
function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "Something went wrong";
}

/**
 * The plan re-anchored on `anchor` (a panel the user just made bigger or
 * smaller becomes the anchor, so its round plays the anchor's stages). The
 * relations belong to the old anchor's click, so they go when the anchor
 * changed.
 */
export function anchoredOn<P extends string, S extends CoreSuggestion, K extends string>(plan: LayoutPlan<P, S, K>, anchor: AnchorRef<P, K> | null): LayoutPlan<P, S, K> {
  const same = (plan.anchor?.at ?? null) === (anchor?.at ?? null);
  return {
    ...plan,
    anchor,
    placements: plan.placements.map((p) => {
      const on = anchor?.panel === p.id;
      if (Boolean(p.anchor) === on && (same || !p.relation)) return p;
      const q = { ...p };
      if (on) q.anchor = true;
      else delete q.anchor;
      if (!same) delete q.relation;
      return q;
    }),
  };
}

/** A plan with no anchor, relations, or anchor flags (undo restores the layout, not the links). */
export function withoutLinks<P extends string, S extends CoreSuggestion, K extends string>(plan: LayoutPlan<P, S, K>): LayoutPlan<P, S, K> {
  return {
    ...plan,
    anchor: null,
    placements: plan.placements.map((p) => {
      if (!p.relation && !p.anchor) return p;
      const q = { ...p };
      delete q.relation;
      delete q.anchor;
      return q;
    }),
  };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/**
 * The adaptive loop on a host's state. Returns the starting state with the
 * actions, for the host to hold (a zustand initializer returns it as is).
 */
export function createAdaptiveEngine<Sp extends AdaptiveSpec>(config: AdaptiveStoreConfig<Sp>, host: AdaptiveHost<Sp>): Full<Sp> {
  type P = Sp["panel"];
  type S = Sp["suggestion"];
  type K = Sp["kind"];
  type J = Sp["judgments"];
  type Res = Sp["response"];
  type Input = Sp["input"];
  type Event = Sp["event"];
  type Plan = PlanOf<Sp>;
  type State = Full<Sp>;
  type Opts = StorePlaceOptions<P>;
  const { catalog, policy } = config;
  type KState = AdaptiveState<Sp>;
  const { get, set } = host;
  /** Set kernel fields (the host's set takes the whole state's). */
  const setK = (patch: Partial<KState>): void => set(patch as unknown as Partial<State>);
  const profile = config.profile ?? signalProfile();
  const anchorTypes = config.anchorTypes ?? CORE_ANCHOR_TYPES;
  const realActionTypes = config.realActionTypes ?? CORE_REAL_ACTION_TYPES;
  const passiveTypes = config.passiveTypes ?? CORE_PASSIVE_TYPES;
  const focusTypes = config.focusTypes ?? new Set<string>(["panel_focus", ...profile.recordOpen]);
  const commandMax = config.commandMaxLength ?? COMMAND_TEXT_MAX;
  // The hooks: the config's, then the extension's (set below, before anything runs).
  let h: AdaptiveHooks<Sp> = config;
  const densityIgnores = (): ReadonlySet<string> => h.densityIgnores ?? new Set<string>(["panel_dwell", ...profile.cueOnly]);
  const sameSuggestion = (a: S, b: S): boolean => (h.sameSuggestion ? h.sameSuggestion(a, b) : a.actionId === b.actionId && a.label === b.label);
  const suggestionKey = (s: S): string => (h.suggestionKey ? h.suggestionKey(s) : `${s.actionId}|${s.prominence}|${s.label}`);

  // Request and timing bookkeeping. Not UI state, so not in the store.
  let eventSeq = 0;
  let version = 0;
  let lastAppliedVersion = 0;
  let recentModes: LayoutMode[] = [];
  let recentDensities: Density[] = [];
  let lastPlanChangeAt = Number.NEGATIVE_INFINITY;
  let undoHoldUntil = 0;
  let heldTimer: ReturnType<typeof setTimeout> | null = null;
  let manuallyOpened: P[] = [];
  let lastCommand: { text: string; judgments: NonNullable<J["command"]> } | null = null;
  let baseStatus: Exclude<AdaptiveStatus, "thinking"> = "idle";
  let healthFailed = false;
  /** The last command's promotion, kept until a newer round lands (see COMMAND_HOLD_MS). */
  let commandHold: CommandHold<P, S> | null = null;
  /** What the last undo reverted, and the judgments it was based on (see UNDO_MEMORY_MS). */
  let undone: { avoid: NonNullable<PolicyInput<P>["avoid"]>; judgments: J; at: number } | null = null;
  // Where the user's hands are, as reported by the UI (setCanvasHold).
  let pointerOnCanvas = false;
  let keyboardOnCanvas = false;
  let manualHoldUntil = 0;
  /** A plan waited for a canvas hold and should be applied when it ends. */
  let canvasDeferred = false;
  /** The waiting catch-up is the traditional layout (adaptive off or no judgments yet). */
  let catchupTraditional = false;
  let canvasTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last press in a card, for ANCHOR_PRESS_WINDOW_MS. */
  let lastPress: { panel: P; at: number } | null = null;
  let anchorTimer: ReturnType<typeof setTimeout> | null = null;
  /** Anchors are told apart by `at`, so two in the same millisecond still differ. */
  let lastAnchorAt = 0;
  /** The highest round ever issued, so rounds keep counting up after a reset. */
  let roundSeq = 0;
  /** A round kept the pointer's card from moving or leaving, and since when (see POINTER_MOVE_HOLD_MS). */
  let pointerHold: { panel: P; moveSince: number | null; leaveSince: number | null } | null = null;
  let pointerTimer: ReturnType<typeof setTimeout> | null = null;
  /** The size each panel had before the user made it bigger, so "Make smaller" puts it back (restoredSize). */
  let sizeBeforeBigger: Partial<Record<P, PanelSize>> = {};

  const scheduler = new AdaptScheduler({
    send: (args) => sendRequest(args),
    onBusyChange: (busy) => setK({ status: busy ? "thinking" : baseStatus }),
  });

  const statusNow = (): AdaptiveStatus => (scheduler.busy ? "thinking" : baseStatus);
  const isPanel = (id: unknown): id is P => policy.isPanelId(id);
  const without = (map: Partial<Record<P, number>>, key: P) => withoutKey<P>(map, key);
  const frontNow = (): P[] | undefined => h.front?.(get());
  const basePlan = (): Plan => policy.traditionalPlan({ pinned: get().pinned, dismissed: get().dismissed, opened: manuallyOpened, bigger: get().bigger, front: frontNow() });
  const persistState = (state: State): void => h.persist?.(state);

  function describe(input: Input): string {
    const own = h.describe?.(input);
    if (own !== undefined) return own;
    return describeCoreEvent({ type: input.type as CoreSignalType, ...(input.panel ? { panel: input.panel } : {}), ...(input.detail ? { detail: input.detail } : {}) }, config.words);
  }

  /** Panel of the newest event that shows where the user is working, for "did focus change". */
  function lastWorkPanel(events: readonly Event[]): P | null {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.panel && profile.work.has(e.type)) return e.panel as P;
    }
    return null;
  }

  // ----- the place step: explicit cells ---------------------------------------

  /** The live anchor when it holds still (a command's hero goes to the front instead). */
  function workAnchor(): AnchorRef<P, K> | null {
    const a = get().anchor;
    return a && a.source !== "command" ? a : null;
  }

  /** The card under the pointer, when pointer holds may apply: on the canvas and not the anchor (which never moves). */
  function pointerPanel(): P | null {
    const s = get();
    const p = s.pointer.panel;
    if (!p || p === workAnchor()?.panel) return null;
    return s.plan.placements.some((x) => x.id === p) ? p : null;
  }

  /** Whether a pointer hold of this kind may still apply to `panel`: its cap has not run out. */
  function holdOpen(panel: P, kind: "move" | "leave", now: number): boolean {
    const since = pointerHold?.panel === panel ? (kind === "move" ? pointerHold.moveSince : pointerHold.leaveSince) : null;
    return since === null || now - since < (kind === "move" ? POINTER_MOVE_HOLD_MS : POINTER_LEAVE_HOLD_MS);
  }

  /** Remember the highest round set, so rounds keep counting up after a reset. */
  function adopt(plan: Plan): void {
    roundSeq = Math.max(roundSeq, plan.round ?? 0);
  }

  /**
   * Whether a plan gets explicit cells: always with Adaptive on; with it off
   * only while a panel is bigger, so "Make bigger" keeps its top edge there
   * too (otherwise the fixed layout keeps the CSS flow).
   */
  function packedLayout(plan: Plan): boolean {
    return get().settings.adaptive || plan.placements.some((p) => p.bigger);
  }

  /**
   * The place step every plan goes through (placePlan): pack explicit cells
   * with the anchor held still, keep the pointer's card from moving for a
   * while, show the old size of any card whose cell was kept, re-mark what
   * changed from the cells, and count the round. `heldMove` is the pointer's
   * card when this plan kept it from moving.
   */
  function place(next: Plan, opts: Opts = {}): { plan: Plan; heldMove: P | null } {
    const s = get();
    const gather = h.gather;
    return placePlan({
      ...opts,
      current: s.plan,
      next,
      columns: s.columns,
      packed: packedLayout(next),
      anchor: s.anchor,
      pointerPanel: pointerPanel(),
      pointerMoveOpen: (ptr) => holdOpen(ptr, "move", Date.now()),
      ...(gather ? { gather: (anchor: AnchorRef<P, K>) => gather(next, anchor) } : {}),
      roundSeq,
      remark: policy.remarkPanels,
    });
  }

  // ----- the anchor ------------------------------------------------------------

  function clearAnchorTimer(): void {
    if (anchorTimer !== null) clearTimeout(anchorTimer);
    anchorTimer = null;
  }

  /** Release the anchor. This does not re-plan: the next round without an anchor rebalances. */
  function releaseAnchor(): void {
    clearAnchorTimer();
    if (get().anchor) setK({ anchor: null });
    h.planChanged?.();
  }

  function armAnchorTimer(): void {
    clearAnchorTimer();
    anchorTimer = setTimeout(() => {
      anchorTimer = null;
      if (get().anchor) setK({ anchor: null });
      h.planChanged?.();
    }, ANCHOR_IDLE_RELEASE_MS);
  }

  function setAnchor(ref: Omit<AnchorRef<P, K>, "at" | "label">, now: number, fallbackLabel?: string): void {
    const label = h.anchorLabel ? h.anchorLabel(ref, get()) : fallbackLabel;
    lastAnchorAt = Math.max(now, lastAnchorAt + 1);
    setK({ anchor: { ...ref, ...(label ? { label } : {}), at: lastAnchorAt } });
    armAnchorTimer();
    h.planChanged?.();
  }

  /**
   * A click or keystroke in a panel makes it the anchor (anchorTypes; a
   * panel_focus only from the pointer). More work in the same panel on the
   * same record or client keeps the anchor and only restarts the idle timer.
   */
  function noteWork(input: Input, now: number): void {
    if (!anchorTypes.has(input.type)) return;
    const s = get();
    if (!s.settings.adaptive || s.settings.frozen) return;
    const d = input.detail ?? {};
    if (d.via === "suggestion" || d.via === "command") return;
    if (input.type === "panel_focus" && d.via !== "pointer") return;
    const pressed =
      lastPress && CROSS_PANEL_TYPES.has(input.type) && d.via !== "keyboard" && now - lastPress.at <= ANCHOR_PRESS_WINDOW_MS && s.plan.placements.some((x) => x.id === lastPress?.panel)
        ? lastPress.panel
        : null;
    const panel = pressed ?? (input.panel && isPanel(input.panel) ? input.panel : null);
    if (!panel) return;
    const itemId = d.itemId;
    const itemKind = (d.itemKind as K | undefined) ?? h.itemKindOf?.(itemId);
    const client = d.client ?? (input.type === "search" && d.query ? h.clientIn?.(d.query) : undefined);
    const cur = s.anchor;
    if (cur && cur.source !== "command" && cur.panel === panel && (!itemId || itemId === cur.itemId) && (!client || client === cur.client)) {
      armAnchorTimer();
      return;
    }
    setAnchor({ panel, ...(itemKind && itemId ? { itemKind, itemId } : {}), ...(client ? { client } : {}), source: "work" }, now, d.label ?? client);
  }

  /** An applied command anchors its hero (on the record or client it names, hook `commandAnchor`). */
  function setCommandAnchor(resolution: Sp["resolution"], panel: P): void {
    const s = get();
    if (!s.settings.adaptive || s.settings.frozen) return;
    setAnchor({ panel, ...h.commandAnchor?.(resolution), source: "command" }, Date.now());
  }

  /**
   * The user made `panel` bigger or smaller: that is what they just worked
   * on, so it becomes the anchor for the change (it stays the same anchor,
   * with its record, when it already is one).
   */
  function anchorResized(panel: P, now: number): void {
    const s = get();
    if (!s.settings.adaptive || s.settings.frozen) return;
    const cur = s.anchor;
    if (cur && cur.source !== "command" && cur.panel === panel) armAnchorTimer();
    else setAnchor({ panel, source: "work" }, now);
  }

  // ----- holds -------------------------------------------------------------------

  function clearPointerTimer(): void {
    if (pointerTimer !== null) clearTimeout(pointerTimer);
    pointerTimer = null;
  }

  /**
   * After a round is set: remember whether it kept the pointer's card from
   * moving or leaving, and re-plan when the cap runs out. A round that needed
   * no hold ends it.
   */
  function notePointerHolds(move: P | null, leave: P | null): void {
    const panel = move ?? leave;
    if (!panel) {
      pointerHold = null;
      clearPointerTimer();
      return;
    }
    const now = Date.now();
    const hold = pointerHold?.panel === panel ? pointerHold : { panel, moveSince: null, leaveSince: null };
    hold.moveSince = move ? (hold.moveSince ?? now) : null;
    hold.leaveSince = leave ? (hold.leaveSince ?? now) : null;
    pointerHold = hold;
    const ends = [hold.moveSince !== null ? hold.moveSince + POINTER_MOVE_HOLD_MS : Infinity, hold.leaveSince !== null ? hold.leaveSince + POINTER_LEAVE_HOLD_MS : Infinity];
    clearPointerTimer();
    pointerTimer = setTimeout(
      () => {
        pointerTimer = null;
        if (replanLocal()) noteDecisions(get().plan);
      },
      Math.max(0, Math.min(...ends) - now),
    );
  }

  function clearHeld(): void {
    if (heldTimer !== null) {
      clearTimeout(heldTimer);
      heldTimer = null;
    }
  }

  // ----- plan commits ------------------------------------------------------

  function setPlanDirect(next: Plan, opts: Opts = {}): void {
    const s = get();
    const plan = place(next, opts).plan;
    adopt(plan);
    // With the plan, so the canvas never renders the move without knowing what it is.
    const extra = h.planPatch?.(plan, opts) ?? {};
    if (policy.planSignature(plan) === policy.planSignature(s.plan)) {
      setK({ plan, mode: plan.mode, ...extra });
      h.planChanged?.();
      return;
    }
    clearHeld();
    lastPlanChangeAt = Date.now();
    setK({ previousPlan: s.plan, plan, mode: plan.mode, ...extra });
    h.planChanged?.();
  }

  /** True while the user's keyboard focus or pointer (right after a manual edit) is on the canvas. */
  function canvasHeld(now: number): boolean {
    return keyboardOnCanvas || (pointerOnCanvas && now < manualHoldUntil);
  }

  function armCanvasTimer(now: number): void {
    if (canvasTimer !== null) clearTimeout(canvasTimer);
    canvasTimer = null;
    // The keyboard hold ends when focus leaves; only the pointer hold has a time cap.
    if (!keyboardOnCanvas && pointerOnCanvas && manualHoldUntil > now) {
      canvasTimer = setTimeout(() => {
        canvasTimer = null;
        releaseCanvas();
      }, manualHoldUntil - now);
    }
  }

  /** Apply what waited for a canvas hold, once no hold remains. */
  function releaseCanvas(): void {
    const now = Date.now();
    if (canvasHeld(now)) {
      armCanvasTimer(now);
      return;
    }
    if (canvasTimer !== null) {
      clearTimeout(canvasTimer);
      canvasTimer = null;
    }
    if (!canvasDeferred) return;
    canvasDeferred = false;
    const s = get();
    if (catchupTraditional) {
      catchupTraditional = false;
      if (!s.settings.adaptive || !s.last) {
        setPlanDirect(basePlan());
        return;
      }
    }
    if (replanLocal()) noteDecisions(get().plan);
  }

  /**
   * Apply a policy plan, respecting the canvas holds and the minimum change
   * interval unless forced. A plan that changes nothing visible is applied
   * quietly (fresh priorities and reasons) and does not count as a change.
   */
  function commit(raw: Plan, opts: { force?: boolean; skipQuiet?: boolean; leaveHeld?: P | null } = {}): "applied" | "quiet" | "held" {
    const s = get();
    // Commands skip pointer holds: the user asked, and the hero goes to the front.
    const { plan: next, heldMove } = place(raw, { pointerHolds: !opts.force });
    const holds = opts.force ? { move: null, leave: null } : { move: heldMove, leave: opts.leaveHeld ?? null };
    if (policy.planSignature(next) === policy.planSignature(s.plan)) {
      // Frequent local re-plans (scroll, dwell) skip no-op updates to avoid needless renders.
      if (!opts.skipQuiet) {
        adopt(next);
        setK({ plan: next, mode: next.mode, ...h.committed?.(s.plan, next, { applied: false, moved: false }) });
        h.planChanged?.();
        notePointerHolds(holds.move, holds.leave);
      }
      return "quiet";
    }
    const now = Date.now();
    if (!opts.force && canvasHeld(now)) {
      // Keyboard focus is moving through the canvas, or the pointer just
      // edited it: wait until the user's hands leave, then re-plan.
      clearHeld();
      canvasDeferred = true;
      armCanvasTimer(now);
      return "held";
    }
    // Clamp in case the system clock moved backward.
    if (lastPlanChangeAt > now) lastPlanChangeAt = now;
    if (undoHoldUntil > now + UNDO_HOLD_MS) undoHoldUntil = now + UNDO_HOLD_MS;
    const readyAt = Math.max(lastPlanChangeAt + s.settings.minChangeIntervalMs, undoHoldUntil);
    if (!opts.force && now < readyAt) {
      clearHeld();
      // Re-plan when the interval passes, from whatever judgments are newest then.
      heldTimer = setTimeout(() => {
        heldTimer = null;
        const applied = replanLocal();
        if (applied) noteDecisions(get().plan);
      }, readyAt - now);
      return "held";
    }
    clearHeld();
    lastPlanChangeAt = now;
    adopt(next);
    // A new round is a layout change (a suggestion-only update keeps the round).
    const moved = (next.round ?? 0) !== (s.plan.round ?? 0);
    setK({ previousPlan: s.plan, plan: next, mode: next.mode, ...h.committed?.(s.plan, next, { applied: true, moved }) });
    h.planChanged?.();
    notePointerHolds(holds.move, holds.leave);
    return "applied";
  }

  /**
   * When a held round's plan lands later, record its decisions on that
   * round's history entry. Only an entry still showing the waiting
   * placeholder is filled: a later local re-plan from the same judgments must
   * not overwrite the decisions that round really made.
   */
  function noteDecisions(plan: Plan): void {
    const history = get().history;
    const i = history.findIndex(
      (r) => r.version === plan.basedOnVersion && !r.stale && r.decisions.length === 1 && r.decisions[0].kind === "hold" && r.decisions[0].text === HELD_TEXT,
    );
    if (i === -1) return;
    const next = [...history];
    next[i] = { ...next[i], decisions: plan.decisions };
    setK({ history: next });
  }

  // ----- the policy round -----------------------------------------------------

  /** The command hold, if it still applies to a plan computed from `res`. */
  function activeCommandHold(res: Res, now: number): CommandHold<P, S> | null {
    const hold = commandHold;
    if (!hold) return null;
    const s = get();
    if (now - hold.at > COMMAND_HOLD_MS || res.version > hold.version || s.dismissed[hold.panel] != null) {
      commandHold = null;
      return null;
    }
    return hold;
  }

  function relShare(j: J, id: P): number {
    const r = j.relevance?.[id];
    return r && r.max > 0 ? r.score / r.max : 0;
  }

  function topPanel(j: J): P {
    let best: P = catalog.panelIds[0];
    for (const id of catalog.panelIds) if (relShare(j, id) > relShare(j, best)) best = id;
    return best;
  }

  /** A different goal, or a clearly different top panel. Drift between near ties does not count. */
  function judgmentsDifferMaterially(a: J, b: J): boolean {
    if ((a.goal?.choice ?? null) !== (b.goal?.choice ?? null)) return true;
    const ta = topPanel(a);
    const tb = topPanel(b);
    return ta !== tb && relShare(b, tb) - relShare(b, ta) >= UNDO_TOP_PANEL_MARGIN;
  }

  /** What the last undo asked not to repeat, while the judgments stay the same. */
  function undoAvoid(res: Res, now: number): PolicyInput<P>["avoid"] {
    if (!undone) return undefined;
    if (now - undone.at > UNDO_MEMORY_MS || judgmentsDifferMaterially(undone.judgments, res.judgments)) {
      undone = null;
      return undefined;
    }
    return undone.avoid;
  }

  /**
   * The policy's plan from `res`, built around the live anchor and the
   * records joined to it. With `holds`, the card under the pointer waits to
   * leave (POINTER_LEAVE_HOLD_MS); `leaveHeld` says it did.
   */
  function policyPlan(res: Res, opts: { holds?: boolean } = {}): { plan: Plan; leaveHeld: P | null } {
    const s = get();
    const now = Date.now();
    const avoid = undoAvoid(res, now);
    const anchor = s.anchor;
    const held = h.linkHold?.(s);
    const linked = anchor && h.linked ? h.linked(anchor, s, now) : undefined;
    const front = frontNow();
    const more = h.policyInput?.(s, now);
    const input = {
      judgments: res.judgments,
      version: res.version,
      previous: withGrid(s.plan, s.columns),
      events: s.events,
      now,
      weights: s.settings.weights,
      pinned: s.pinned,
      dismissed: s.dismissed,
      focusedPanel: s.focusedPanel,
      recentModes,
      recentDensities,
      ...(avoid ? { avoid } : {}),
      ...(anchor && linked ? { anchor, linked } : anchor ? { anchor } : {}),
      ...(held ? { linkHold: held } : {}),
      ...(s.bigger.length > 0 ? { bigger: s.bigger } : {}),
      ...more,
      ...(front ? { front } : {}),
    } as Sp["policyInput"];
    let plan = policy.computePlan(input, h.extra?.(get()));
    let leaveHeld: P | null = null;
    const ptr = opts.holds ? pointerPanel() : null;
    if (ptr && !plan.placements.some((p) => p.id === ptr) && holdOpen(ptr, "leave", now)) {
      plan = policy.computePlan({ ...input, hold: [ptr] }, h.extra?.(get()));
      leaveHeld = ptr;
    }
    if (h.afterPolicy) plan = h.afterPolicy(plan);
    // Re-reading the command round's own judgments must not undo the command.
    const hold = activeCommandHold(res, now);
    if (hold) {
      plan = policy.applyPromotion({ plan, previous: s.plan, panel: hold.panel, pinned: s.pinned, bigger: s.bigger, ...(held ? { linkHold: held } : {}), ...(front ? { front } : {}) });
      const offered = hold.suggestion;
      if (offered) plan = addSuggestion(plan, offered, { announce: !s.plan.suggestions.some((x) => sameSuggestion(x, offered)) });
    }
    return { plan, leaveHeld };
  }

  /** Re-plan from the last judgments without asking the model. Returns true when the plan changed. */
  function replanLocal(opts: { force?: boolean; skipQuiet?: boolean } = {}): boolean {
    const s = get();
    if (!s.settings.adaptive) {
      // The traditional layout depends only on pins, dismissals, and opened panels.
      if (opts.skipQuiet) return false;
      setPlanDirect(basePlan());
      return true;
    }
    if (s.settings.frozen || !s.last) return false;
    if (h.layoutHold?.() && !opts.force) return false;
    const { plan, leaveHeld } = policyPlan(s.last, { holds: !opts.force });
    return commit(plan, { ...opts, leaveHeld }) === "applied";
  }

  /**
   * After a pointer rest, a scroll, or a shortcut: refresh the suggestions
   * from the last judgments, but never move, resize, add, or dock a panel.
   * Those passive signals say little about the work, and a full re-plan from
   * them reshuffled the canvas (and undid commands) with no new information.
   */
  function refreshPassive(): void {
    const s = get();
    if (!s.settings.adaptive || s.settings.frozen || !s.last || h.layoutHold?.()) return;
    const fresh = policyPlan(s.last).plan.suggestions;
    const key = (list: S[]) => list.map(suggestionKey).join(",");
    if (key(fresh) === key(s.plan.suggestions)) return;
    const before = new Set(s.plan.suggestions.map(suggestionKey));
    const decisions: Decision<P>[] = fresh.filter((x) => !before.has(suggestionKey(x))).map((x) => ({ kind: "suggest", text: `Suggested: ${x.label}` }));
    setK({ plan: { ...s.plan, suggestions: fresh, decisions } });
  }

  /**
   * Pin, unpin, dismiss, open, and "Make bigger" or "Make smaller" always
   * take effect at once. With judgments, the click changes only that panel
   * now (a pin also moves it to the front, where the policy puts pins; a
   * resized panel keeps its top edge and the cards in its way move), and the
   * policy catches up at its normal pace.
   *
   * With the pointer on the canvas, nothing else moves until it leaves, so
   * the next click does not land on a card that slid in under the pointer. A
   * resize still moves the cards in its way (the user asked for the room).
   *
   * With a front group (hook `front`), a pin or "Make bigger" instead sends
   * the panel to the first cell at once, the front group in its order behind
   * it and the other cards reflowing, even with the pointer on the canvas.
   */
  function manualReplan(edit: PlanEdit<P>): void {
    const { kind, panel } = edit;
    const s = get();
    const now = Date.now();
    const front = kind === "pin" || kind === "bigger" ? frontNow() : undefined;
    // Bringing a quiet panel back to the size it had is a resize too: its top edge stays and the cards in its way move.
    const target = s.plan.placements.find((x) => x.id === panel);
    const grows = kind === "unquiet" && target?.unquietSize !== undefined && target.unquietSize !== target.size;
    const userResized = !front && (kind === "bigger" || kind === "smaller" || grows) ? panel : null;
    // A resized panel, or one made bigger at the front, is the anchor for its change (anchorResized set it), so its round plays the anchor's stages.
    const anchors = userResized !== null || (front !== undefined && kind === "bigger");
    const edited = (plan: Plan, opts: { pinsFirst?: boolean; front?: P[] } = {}): Plan => {
      const next = policy.editPlan(plan, edit, opts);
      return anchors ? anchoredOn(next, get().anchor) : next;
    };
    const inPlace: Opts = userResized ? { userResized } : { holdAll: true };
    const toFront: Opts = { reflow: true, toFront: panel };
    if (s.settings.frozen && s.settings.adaptive) {
      // Frozen: apply the edit without moving anything else.
      setPlanDirect(edited(s.plan), inPlace);
      return;
    }
    // An open comes from the dock and appends at the end, so nothing slides under the pointer.
    if (pointerOnCanvas && kind !== "open") {
      setPlanDirect(front ? edited(s.plan, { front }) : edited(s.plan), front ? toFront : inPlace);
      manualHoldUntil = now + MANUAL_EDIT_HOLD_MS;
      canvasDeferred = true;
      catchupTraditional = !s.settings.adaptive || !s.last;
      armCanvasTimer(now);
      return;
    }
    // Only the edited card changes: the rest keep their cells, except that a
    // pin moves to the front, where the user asked for it.
    const placeOpts: Opts = front ? toFront : kind === "pin" ? { reflow: true } : inPlace;
    if (!s.settings.adaptive || !s.last) {
      // Traditional layout, or no judgments yet (the canvas is still the traditional one).
      const base = policy.traditionalPlan({ pinned: s.pinned, dismissed: s.dismissed, opened: manuallyOpened, bigger: s.bigger, front });
      setPlanDirect(anchors ? anchoredOn(base, get().anchor) : base, placeOpts);
    } else {
      setPlanDirect(edited(s.plan, front ? { front } : { pinsFirst: kind === "pin" }), placeOpts);
      const placed = get().plan;
      replanLocal(); // Held until the minimum change interval passes.
      // A catch-up that agrees with a resize applies quietly in the same tick;
      // it must not wipe the resize's change line and card badges before they show.
      const caught = get().plan;
      if ((userResized || front) && caught !== placed && policy.planSignature(caught) === policy.planSignature(placed)) {
        const change = new Map(placed.placements.map((p) => [p.id, p.change]));
        setK({ plan: { ...caught, decisions: placed.decisions, placements: caught.placements.map((p) => ({ ...p, change: change.get(p.id) ?? null })) } });
      }
    }
  }

  // ----- requests ----------------------------------------------------------

  function pushHistory(record: RoundRecord<Sp>): void {
    setK({ history: [...get().history, record].slice(-HISTORY_LIMIT) });
  }

  function defaultRequest(s: State, now: number, command: string | undefined): Sp["request"] {
    return {
      ...h.requestFields?.(s),
      version,
      snapshot: buildSnapshot(
        s.events,
        { now, focusedPanel: s.focusedPanel, visiblePanels: s.plan.placements.map((p) => p.id) },
        { profile, words: config.words, ...(config.helpPanel ? { helpPanel: config.helpPanel } : {}), describe: (e) => e.text || describe(e as Input) },
      ),
      ...(command ? { command } : {}),
    } as Sp["request"];
  }

  async function sendRequest({ trigger, kind, signal, command }: SendArgs): Promise<void> {
    const s = get();
    const now = Date.now();
    const request = h.request ? h.request(s, { now, version, kind, ...(command ? { command } : {}) }) : defaultRequest(s, now, command);
    let response: Res;
    try {
      response = await config.send(request, { signal });
    } catch (err) {
      // Replaced by a newer request, or reset.
      if (h.isAbort ? h.isAbort(err) : signal.aborted || (err instanceof Error && err.name === "AbortError")) return;
      baseStatus = "error";
      setK({ lastError: messageOf(err), status: statusNow() });
      if (kind === "command" && command) setK({ command: h.commandFailed ? h.commandFailed(command, err) : { text: command, status: "unclear" } });
      return;
    }
    if (signal.aborted) return;
    handleResponse(response, trigger, kind, command);
  }

  /** The plan with `s` first, as the primary suggestion; the others stay, as subtle ones. */
  function addSuggestion(plan: Plan, s: S, opts: { announce?: boolean } = {}): Plan {
    const others = plan.suggestions
      .filter((x) => x.actionId !== s.actionId)
      .map((x) => (x.prominence === "primary" ? { ...x, prominence: "subtle" as const } : x));
    const decision: Decision<P> = { kind: "suggest", text: `Suggested: ${s.label}`, evidence: `command action ${s.actionId} p=${s.confidence.toFixed(2)}` };
    const skip = opts.announce === false || plan.decisions.some((d) => d.kind === "suggest" && d.text === decision.text);
    return { ...plan, suggestions: [s, ...others], decisions: skip ? plan.decisions : [...plan.decisions, decision] };
  }

  /** "idle" for the model, "offline" for the designed no-key mode, "error" only for a real failure. */
  function statusFrom(res: Res): Exclude<AdaptiveStatus, "thinking"> {
    if (res.source === "jev") return "idle";
    if (res.meta?.fallback === "no_key") return "offline";
    return res.meta?.error ? "error" : "offline";
  }

  /** The default command rule: the panel answer at or above COMMAND_PANEL_AT applies (or the panel the user picked). */
  function defaultResolve(cj: NonNullable<J["command"]>, text: string, forcePanel: P | undefined): Sp["resolution"] {
    const panel: ChoiceJudgment<P | typeof PANEL_UNCLEAR> | undefined = cj.panel;
    const p = forcePanel ?? panel?.choice;
    const applies = forcePanel !== undefined || (panel !== undefined && p !== undefined && p !== PANEL_UNCLEAR && isPanel(p) && panel.confidence >= COMMAND_PANEL_AT);
    const promote = applies && p !== undefined && isPanel(p) ? p : null;
    const outcome = promote ? { text, status: "applied" as const, panel: promote } : { text, status: "unclear" as const };
    return { outcome, promote, suggestion: null } as Sp["resolution"];
  }

  function resolve(cj: NonNullable<J["command"]>, text: string, forcePanel?: P): Sp["resolution"] {
    return h.resolveCommand ? h.resolveCommand(cj, text, forcePanel !== undefined ? { forcePanel } : {}, get()) : defaultResolve(cj, text, forcePanel);
  }

  function handleResponse(res: Res, trigger: string, kind: SendArgs["kind"], commandText: string | undefined): void {
    const now = Date.now();
    const stale = res.version <= lastAppliedVersion;

    // A command's outcome matters even if its layout judgments are old: the user asked.
    let resolution: Sp["resolution"] | null = null;
    if (kind === "command" && commandText) {
      const cj = res.judgments.command as NonNullable<J["command"]> | undefined;
      if (cj) {
        lastCommand = { text: commandText, judgments: cj };
        resolution = resolve(cj, commandText);
        h.commandResolved?.(resolution, { chosen: false });
        setK({
          command: resolution.outcome,
          // Asking for a panel overrides an earlier dismissal of it.
          ...(resolution.promote ? { dismissed: without(get().dismissed, resolution.promote) } : {}),
        });
        if (resolution.promote) {
          // Log the jump so usage and recency count the panel the user asked
          // for. The command round already judged it, so no new request.
          trackInternal({ type: "panel_focus", panel: resolution.promote, detail: { via: "command" } } as Input, { schedule: false });
        }
      } else {
        setK({ command: h.commandUnclear ? h.commandUnclear(commandText) : { text: commandText, status: "unclear" } });
      }
    }

    if (stale) {
      pushHistory({ version: res.version, at: now, trigger, response: res, decisions: [], stale: true });
      if (resolution) applyCommandLayout(resolution, null);
      return;
    }

    // An unclear command says nothing about the work, but the round's other
    // judgments read its stray text: "banana smoothie recipe" rated every
    // panel useless and docked all but two. Keep the layout and the last good
    // judgments (`last`), so later local re-plans do not use this round either.
    // A "Did you mean" is treated the same until the user picks an option.
    if (kind === "command" && (!resolution || resolution.outcome.status !== "applied")) {
      lastAppliedVersion = res.version;
      baseStatus = statusFrom(res);
      setK({ lastError: res.meta?.error ?? null, status: statusNow() });
      const confirm = resolution?.outcome.status === "confirm";
      const hold: Decision<P> = { kind: "hold", text: confirm ? "Kept the layout until you pick what the command meant" : "Kept the layout because the command was unclear" };
      const decisions: Decision<P>[] = [hold];
      // A confident action still shows while the user picks the panel.
      if (confirm && resolution?.suggestion) {
        const next = addSuggestion({ ...get().plan, decisions: [] }, resolution.suggestion);
        setPlanDirect(next, { holdAll: true });
        decisions.push(...next.decisions);
      }
      pushHistory({ version: res.version, at: now, trigger, response: res, decisions, stale: false });
      return;
    }

    lastAppliedVersion = res.version;
    // A newer round replaces the command round's judgments, and with them the command hold.
    if (commandHold && res.version > commandHold.version) commandHold = null;
    h.roundStart?.(res, { promoted: Boolean(resolution?.promote) });
    const judgedMode = res.judgments.layout?.choice;
    if (judgedMode) recentModes = [...recentModes, judgedMode].slice(-RECENT_MODES_LIMIT);
    const ignores = densityIgnores();
    const density = judgedDensity(res.judgments.expertise, get().events.filter((e) => !ignores.has(e.type)).length);
    if (density) recentDensities = [...recentDensities, density].slice(-RECENT_DENSITIES_LIMIT);
    baseStatus = statusFrom(res);
    const goal = res.judgments.goal;
    setK({
      last: res,
      goal: goal ? { id: goal.choice, confidence: goal.confidence } : null,
      lastError: res.meta?.error ?? null,
      status: statusNow(),
    });
    h.roundJudged?.(res, now);

    if (resolution?.promote) setCommandAnchor(resolution, resolution.promote);
    const decisions = applyCommandLayout(resolution, res);
    pushHistory({ version: res.version, at: now, trigger, response: res, decisions, stale: false });
    h.roundDone?.(res);
  }

  /** Lay out after a response (and a command, if any). Returns the decisions for history. */
  function applyCommandLayout(resolution: Sp["resolution"] | null, res: Res | null): Decision<P>[] {
    const s = get();
    const adaptiveLayout = s.settings.adaptive && !s.settings.frozen;

    if (!adaptiveLayout || !res) {
      // Traditional or frozen layout (or old judgments): only open what the user asked for.
      // Start from no decisions, so the change feed does not replay the last change.
      let plan: Plan = { ...s.plan, decisions: [] };
      let changed = false;
      const promote = resolution?.promote;
      if (resolution && promote && !plan.placements.some((p) => p.id === promote)) {
        if (!s.settings.adaptive) {
          if (!manuallyOpened.includes(promote)) manuallyOpened = [...manuallyOpened, promote];
          plan = policy.traditionalPlan({ pinned: s.pinned, dismissed: without(s.dismissed, promote), opened: manuallyOpened, bigger: s.bigger });
          setK({ dismissed: without(s.dismissed, promote) });
        } else {
          plan = policy.editPlan(plan, { kind: "open", panel: promote });
        }
        if (resolution.decision) plan = { ...plan, decisions: [resolution.decision, ...plan.decisions] };
        changed = true;
      }
      if (resolution?.suggestion) {
        plan = addSuggestion(plan, resolution.suggestion);
        changed = true;
      }
      if (changed) setPlanDirect(plan, { holdAll: true });
      return changed ? plan.decisions : [];
    }

    // A held layout waits for Jev rounds (a command is new work and ended the hold).
    const held = h.layoutHold?.();
    if (held && !resolution?.promote && !resolution?.suggestion) return [{ kind: "hold", text: held }];
    // Commands skip the minimum change interval and the pointer holds.
    const force = Boolean(resolution?.promote || resolution?.suggestion);
    const { plan: base, leaveHeld } = policyPlan(res, { holds: !force });
    let next = base;
    if (resolution?.promote) {
      const linkHold = h.linkHold?.(get());
      const front = frontNow();
      next = policy.applyPromotion({
        plan: next,
        previous: s.plan,
        panel: resolution.promote,
        pinned: s.pinned,
        bigger: s.bigger,
        ...(resolution.decision ? { decision: resolution.decision } : {}),
        ...(linkHold ? { linkHold } : {}),
        ...(front ? { front } : {}),
      });
    }
    if (resolution?.suggestion) {
      next = addSuggestion(next, resolution.suggestion);
    }
    if (resolution?.promote && policy.planSignature(place(next).plan) === policy.planSignature(s.plan)) {
      // Nothing visible changes: say so quietly instead of "Layout changed"
      // with an Undo that would revert an earlier, unrelated change.
      next = { ...next, decisions: [{ kind: "hold", text: `Already showing ${catalog.panels[resolution.promote as P].title}` }] };
    }
    const result = commit(next, { force, leaveHeld });
    if (resolution?.promote) commandHold = { panel: resolution.promote, version: res.version, at: Date.now(), suggestion: resolution.suggestion };
    if (result === "held") return [{ kind: "hold", text: HELD_TEXT }];
    return next.decisions;
  }

  // ----- health ------------------------------------------------------------------

  /**
   * Ask the server's health at load and, while it is down, again (the app's
   * own backoff), so a server that starts after the page clears the error.
   * Only sets the status before the first real answer, or to recover.
   */
  function startHealthWatch(): void {
    h.watchHealth?.({
      onResult: (r) => {
        if (r.ok) {
          const recovering = healthFailed;
          healthFailed = false;
          if (get().last === null || recovering) {
            if (r.info.jev === false) baseStatus = "offline";
            else if (recovering && baseStatus === "error") baseStatus = "idle";
          }
          setK({ status: statusNow(), ...(recovering ? { lastError: null } : {}) });
        } else {
          healthFailed = true;
          baseStatus = "error";
          setK({ status: statusNow(), lastError: messageOf(r.error) });
        }
      },
    });
  }

  // ----- tracking ------------------------------------------------------------

  function trackInternal(input: Input, opts: { schedule?: boolean; anchor?: boolean } = {}): void {
    const s = get();
    const now = Date.now();
    const event = { ...input, id: ++eventSeq, t: now, text: describe(input) } as Event;
    version += 1;
    const p = input.panel && isPanel(input.panel) ? input.panel : undefined;
    // Keyboard focus alone (Tab) does not ask the model: tabbing through the
    // canvas re-planned it under the keyboard, and Tab looped between two panels.
    const focusChanged = input.type === "panel_focus" && input.detail?.via !== "keyboard" && p !== undefined && p !== lastWorkPanel(s.events);
    const start: { patch?: Partial<State>; unquiet?: boolean } = h.trackStart?.({ input, event, panel: p, state: s, now }) || {};
    const patch: Partial<KState> = { events: [...s.events, event].slice(-EVENT_LOG_LIMIT) };
    let pinsChanged = false;
    let biggerChanged = false;
    /** "Make smaller": the size to go back to, read before the remembered size is dropped. */
    let smallerSize: PanelSize | undefined;
    if (p) {
      switch (input.type) {
        case "panel_pin":
          if (!s.pinned.includes(p)) {
            patch.pinned = [...s.pinned, p];
            pinsChanged = true;
          }
          patch.dismissed = without(s.dismissed, p);
          break;
        case "panel_unpin":
          if (s.pinned.includes(p)) {
            patch.pinned = s.pinned.filter((x) => x !== p);
            pinsChanged = true;
          }
          break;
        case "panel_dismiss":
          patch.dismissed = { ...s.dismissed, [p]: now };
          // Dismissing a pinned panel unpins it; otherwise the pin would keep it on screen.
          if (s.pinned.includes(p)) {
            patch.pinned = s.pinned.filter((x) => x !== p);
            pinsChanged = true;
          }
          if (s.focusedPanel === p) patch.focusedPanel = null;
          manuallyOpened = manuallyOpened.filter((x) => x !== p);
          if (commandHold?.panel === p) commandHold = null;
          // Docking a panel the user made bigger clears that too.
          if (s.bigger.includes(p)) {
            patch.bigger = s.bigger.filter((x) => x !== p);
            biggerChanged = true;
          }
          delete sizeBeforeBigger[p];
          break;
        case "panel_maximize":
          if (!s.bigger.includes(p)) {
            patch.bigger = [...s.bigger, p];
            biggerChanged = true;
            const was = s.plan.placements.find((x) => x.id === p)?.size;
            if (was) sizeBeforeBigger[p] = was;
          }
          break;
        case "panel_restore":
          if (s.bigger.includes(p)) {
            patch.bigger = s.bigger.filter((x) => x !== p);
            biggerChanged = true;
          }
          smallerSize = policy.restoredSize(s.plan, p, sizeBeforeBigger[p]);
          delete sizeBeforeBigger[p];
          break;
        case "panel_open":
          patch.dismissed = without(s.dismissed, p);
          if (!manuallyOpened.includes(p)) manuallyOpened = [...manuallyOpened, p];
          break;
        default:
          if (focusTypes.has(input.type)) patch.focusedPanel = p;
          break;
      }
    }
    set({ ...start.patch, ...patch } as unknown as Partial<State>);
    h.logged?.(event, p);
    if (pinsChanged || biggerChanged) persistState(get());
    // Docking the anchor releases it; work in a panel makes that panel the anchor.
    if (input.type === "panel_dismiss" && p && get().anchor?.panel === p) releaseAnchor();
    if (opts.anchor !== false) noteWork(input, now);
    // A panel the user made bigger or smaller is the anchor for that change.
    if ((input.type === "panel_maximize" || input.type === "panel_restore") && p) anchorResized(p, now);
    h.worked?.(event);

    // Acting (not just looking) ends a hold, so the result of the action can show.
    if (realActionTypes.has(input.type) && (keyboardOnCanvas || manualHoldUntil > now)) {
      keyboardOnCanvas = false;
      manualHoldUntil = 0;
      releaseCanvas();
    }

    const kind = MANUAL_EDITS[input.type];
    if (p && kind) {
      // A manual edit of a quiet panel also makes it a normal panel (editPlan drops the quiet marks).
      manualReplan({ kind, panel: p, ...(smallerSize ? { size: smallerSize } : {}) });
    } else {
      if (p && start.unquiet) manualReplan({ kind: "unquiet", panel: p });
      if (passiveTypes.has(input.type)) refreshPassive();
    }
    const asks = h.triggers ? h.triggers(input.type, focusChanged) : CORE_TRIGGER_TYPES.has(input.type) || (input.type === "panel_focus" && focusChanged);
    if (opts.schedule !== false && asks) scheduler.notify(input.type);
    h.tracked?.(event);
  }

  function openPanel(id: P, via: SignalVia = "pointer"): void {
    const s = get();
    if (s.plan.placements.some((p) => p.id === id)) {
      setK({ focusedPanel: id });
      // Asking for a panel that is already here is not work in it, so it does not anchor.
      trackInternal({ type: "panel_focus", panel: id, detail: { via } } as Input, { anchor: false });
      return;
    }
    setK({ focusedPanel: id });
    // Opening from the dock anchors the opened card (noteWork), so the next
    // round keeps it and everything before it in place instead of sending it
    // to the front. An open from a suggestion or a command does not anchor.
    trackInternal({ type: "panel_open", panel: id, detail: { via } } as Input);
  }

  async function runCommandInternal(text: string, via: SignalVia = "keyboard"): Promise<void> {
    // The server reads at most commandMax characters; clip here too so a paste never fails.
    const q = text.trim().slice(0, commandMax).trim();
    if (!q) return;
    setK({ command: null });
    // The command request carries this event in its snapshot; no separate debounced request.
    trackInternal({ type: "command", detail: { query: q, via } } as Input, { schedule: false });
    await scheduler.command(q);
  }

  function dropHeldSuggestion(match: (s: S) => boolean): void {
    if (commandHold?.suggestion && match(commandHold.suggestion)) commandHold = { ...commandHold, suggestion: null };
  }

  function firstPlan(s: State): Plan {
    if (h.initialPlan) return h.initialPlan(s);
    const base = policy.traditionalPlan({ pinned: s.pinned, bigger: s.bigger, front: h.front?.(s) });
    // With Adaptive on, the first plan has its cells at once, so the canvas never shows a plan without them.
    return s.settings.adaptive ? withGrid(base, s.columns) : base;
  }

  // ----- the kernel and the extension ---------------------------------------------

  const kernel: AdaptiveKernel<Sp> = {
    get,
    set,
    track: trackInternal,
    openPanel,
    place,
    setPlanDirect,
    replanLocal,
    refreshPassive,
    noteDecisions,
    basePlan,
    releaseAnchor,
    setAnchor: (ref, now) => setAnchor(ref, now),
    clearHeld,
    clearPointerHold() {
      pointerHold = null;
      clearPointerTimer();
    },
    clearCommandHold() {
      commandHold = null;
    },
    dropHeldSuggestion,
    forgetSize(panel) {
      delete sizeBeforeBigger[panel];
    },
    addSuggestion,
    version: () => version,
    persist: () => persistState(get()),
  };
  const ext = config.extend?.(kernel);
  if (ext?.hooks) h = { ...config, ...ext.hooks };

  // ----- actions ---------------------------------------------------------------

  const actions: AdaptiveActions<Sp> = {
    track(input) {
      trackInternal(input);
    },

    runCommand(text, via = "keyboard") {
      return runCommandInternal(text, via);
    },

    chooseCommandOption(panel) {
      const cmd = lastCommand;
      if (!cmd) {
        setK({ command: null });
        openPanel(panel, "command");
        return;
      }
      const s = get();
      const resolution = resolve(cmd.judgments, cmd.text, panel);
      // Picking what the command meant is the command applying.
      h.commandResolved?.(resolution, { chosen: true });
      setK({ command: resolution.outcome, dismissed: without(s.dismissed, panel) });
      // Logged before the layout so usage and recency count it. No new request:
      // the command round already judged this command.
      trackInternal({ type: "panel_focus", panel, detail: { via: "command" } } as Input, { schedule: false });
      const now = get();
      if (now.settings.adaptive && !now.settings.frozen && now.last) {
        setCommandAnchor(resolution, panel);
        const anchor = get().anchor;
        const held = h.linkHold?.(get());
        const front = frontNow();
        const linked = anchor && h.linked ? h.linked(anchor, get(), Date.now()) : undefined;
        let next = policy.applyPromotion({
          plan: now.plan,
          previous: now.plan,
          panel,
          pinned: now.pinned,
          bigger: now.bigger,
          ...(resolution.decision ? { decision: resolution.decision } : {}),
          anchor,
          ...(linked ? { linked } : {}),
          ...(held ? { linkHold: held } : {}),
          ...(front ? { front } : {}),
        });
        if (resolution.suggestion) next = addSuggestion(next, resolution.suggestion);
        if (policy.planSignature(place(next).plan) === policy.planSignature(now.plan)) next = { ...next, decisions: [{ kind: "hold", text: `Already showing ${catalog.panels[panel].title}` }] };
        commit(next, { force: true });
        commandHold = { panel, version: lastAppliedVersion, at: Date.now(), suggestion: resolution.suggestion };
      } else {
        applyCommandLayout(resolution, null);
      }
    },

    clearCommand() {
      setK({ command: null });
    },

    pin(id) {
      trackInternal({ type: "panel_pin", panel: id } as Input);
    },

    unpin(id) {
      trackInternal({ type: "panel_unpin", panel: id } as Input);
    },

    maximize(id, via) {
      const s = get();
      if (s.bigger.includes(id) || !s.plan.placements.some((p) => p.id === id)) return;
      trackInternal({ type: "panel_maximize", panel: id, ...(via ? { detail: { via } } : {}) } as Input);
    },

    restore(id, via) {
      if (!get().bigger.includes(id)) return;
      trackInternal({ type: "panel_restore", panel: id, ...(via ? { detail: { via } } : {}) } as Input);
    },

    dismiss(id) {
      const s = get();
      const now = Date.now();
      let openedAt: number | undefined;
      for (let i = s.events.length - 1; i >= 0; i--) {
        const e = s.events[i];
        if (e.panel !== id) continue;
        if (e.type === "panel_dismiss") break;
        if (e.type === "panel_open") {
          openedAt = e.t;
          break;
        }
      }
      const durationMs = openedAt !== undefined && now - openedAt <= DISMISS_DURATION_WINDOW_MS ? now - openedAt : undefined;
      trackInternal({ type: "panel_dismiss", panel: id, ...(durationMs !== undefined ? { detail: { durationMs } } : {}) } as Input);
    },

    open(id) {
      openPanel(id, "pointer");
    },

    setFocused(id) {
      setK({ focusedPanel: id });
    },

    acceptSuggestion(offered) {
      // Act only on a suggestion that is still offered. A stale chip (or a key
      // pressed right after doing the same thing by hand) must not repeat it.
      const current = get().plan.suggestions.find((x) => sameSuggestion(x, offered));
      if (!current) return;
      trackInternal({
        type: "suggestion_accept",
        panel: h.suggestionPanel ? h.suggestionPanel(current) : (catalog.actions[current.actionId as Sp["action"]]?.panel ?? undefined),
        detail: { actionId: current.actionId, label: current.label, via: "suggestion", ...h.suggestionDetail?.(current) },
      } as Input);
      const plan = get().plan;
      setK({ plan: { ...plan, suggestions: plan.suggestions.filter((x) => !sameSuggestion(x, current)) } });
      dropHeldSuggestion((x) => sameSuggestion(x, current));
      h.suggestionAccepted?.(current);
    },

    dismissSuggestion(offered) {
      const plan = get().plan;
      setK({ plan: { ...plan, suggestions: plan.suggestions.filter((x) => !sameSuggestion(x, offered)) } });
      dropHeldSuggestion((x) => sameSuggestion(x, offered));
      h.suggestionDismissed?.(offered);
      trackInternal({
        type: "suggestion_dismiss",
        panel: catalog.actions[offered.actionId as Sp["action"]]?.panel ?? undefined,
        detail: { actionId: offered.actionId, label: offered.label, ...h.suggestionDetail?.(offered) },
      } as Input);
    },

    setSettings(patch) {
      const prev = get().settings;
      const settings = h.mergeSettings ? h.mergeSettings(prev, patch) : ({ ...prev, ...patch, weights: { ...prev.weights, ...(patch.weights ?? {}) } } as Sp["settings"]);
      setK({ settings });
      persistState(get());
      h.settingsSet?.(prev, settings);
      // The anchor belongs to the adaptive layout: switching it off, or freezing, releases it.
      if (prev.adaptive !== settings.adaptive || (!prev.frozen && settings.frozen)) {
        releaseAnchor();
        pointerHold = null;
        clearPointerTimer();
      }
      h.settingsReleased?.(prev, settings);
      if (prev.adaptive !== settings.adaptive) {
        commandHold = null;
        undone = null;
        if (!settings.adaptive) setPlanDirect(basePlan());
        else if (!replanLocal({ force: true }) && !get().last) setPlanDirect(basePlan());
      } else if (prev.frozen && !settings.frozen) {
        replanLocal({ force: true });
      } else {
        h.settingsOther?.(prev, settings);
      }
      // Undo must not bring back a layout from before the switch (an adaptive
      // plan while Adaptive is off, or the reverse).
      if (prev.adaptive !== settings.adaptive || prev.frozen !== settings.frozen) setK({ previousPlan: null });
      h.settingsDone?.(prev, settings);
    },

    setWeights(patch) {
      const prev = get().settings;
      setK({ settings: { ...prev, weights: { ...prev.weights, ...patch } } });
      persistState(get());
      replanLocal({ force: true });
    },

    undo(to) {
      const s = get();
      // previousPlan is cleared when Adaptive or Freeze changes; then there is nothing to undo.
      if (!s.previousPlan) return;
      const back = h.undoBack?.(s) ?? null;
      const target = back?.plan ?? to ?? s.previousPlan;
      const extra = h.undoing?.(s, target, back) ?? {};
      // The user undid the relayout around the anchor, so it lets go.
      releaseAnchor();
      // Mark what the undo changes, so card badges describe the undo and not the undone change.
      const marked = withoutLinks(policy.markChanges(s.plan, target));
      const restored = place({ ...marked, decisions: [{ kind: "hold", text: "Restored the previous layout" }] }, { keepGrid: true, decisions: false }).plan;
      adopt(restored);
      let dismissed = back?.dismissed ?? s.dismissed;
      for (const p of restored.placements) dismissed = without(dismissed, p.id);
      // Pins follow the restored plan, so the pin button and the store agree, and so do the panels the user made bigger.
      const pinned = restored.placements.filter((p) => p.pinned).map((p) => p.id);
      const pinsChanged = pinned.join(",") !== s.pinned.join(",");
      const bigger = restored.placements.filter((p) => p.bigger).map((p) => p.id);
      const biggerChanged = !sameSet(bigger, s.bigger);
      if (biggerChanged) for (const id of s.bigger) if (!bigger.includes(id)) delete sizeBeforeBigger[id];
      const now = Date.now();
      if (s.last && s.settings.adaptive) {
        const onTarget = new Set(target.placements.map((p) => p.id));
        const onUndone = new Set(s.plan.placements.map((p) => p.id));
        undone = {
          avoid: {
            ...(s.plan.mode !== target.mode ? { mode: s.plan.mode } : {}),
            add: s.plan.placements.filter((p) => !onTarget.has(p.id) && !p.pinned).map((p) => p.id),
            dock: target.placements.filter((p) => !onUndone.has(p.id)).map((p) => p.id),
          },
          judgments: s.last.judgments,
          at: now,
        };
      }
      // The user undid it; a command's promotion must not come back either.
      commandHold = null;
      clearHeld();
      lastPlanChangeAt = now;
      undoHoldUntil = now + UNDO_HOLD_MS;
      setK({
        plan: restored,
        previousPlan: s.plan,
        mode: restored.mode,
        dismissed,
        ...(pinsChanged ? { pinned } : {}),
        ...(biggerChanged ? { bigger } : {}),
        ...extra,
      });
      h.planChanged?.();
      h.undone?.(back);
      if (pinsChanged || biggerChanged) persistState(get());
      trackInternal({ type: "undo" } as Input);
    },

    reset() {
      h.resetStart?.();
      scheduler.cancel();
      clearHeld();
      if (canvasTimer !== null) clearTimeout(canvasTimer);
      canvasTimer = null;
      lastAppliedVersion = version; // Anything still in flight is now stale.
      recentModes = [];
      recentDensities = [];
      lastPlanChangeAt = Number.NEGATIVE_INFINITY;
      undoHoldUntil = 0;
      manualHoldUntil = 0;
      canvasDeferred = false;
      catchupTraditional = false;
      manuallyOpened = [];
      lastCommand = null;
      commandHold = null;
      undone = null;
      clearAnchorTimer();
      clearPointerTimer();
      pointerHold = null;
      lastPress = null;
      sizeBeforeBigger = {};
      const fresh = h.resetting?.() ?? {};
      if (baseStatus === "error") baseStatus = "idle";
      // Reset keeps the pins but clears the panels the user made bigger.
      if (get().bigger.length > 0) persistState({ ...get(), bigger: [] });
      let plan = firstPlan({ ...get(), bigger: [] });
      if (!h.initialPlan) {
        // A new round, so the canvas places the starting layout afresh.
        roundSeq += 1;
        plan = { ...plan, round: roundSeq };
      }
      setK({
        events: [],
        plan,
        previousPlan: null,
        last: null,
        history: [],
        status: statusNow(),
        lastError: null,
        dismissed: {},
        focusedPanel: null,
        command: null,
        goal: null,
        mode: plan.mode,
        anchor: null,
        bigger: [],
        ...fresh,
      });
      h.resetDone?.();
    },

    adaptNow(trigger = "manual") {
      version += 1; // So the answer counts as newer than the last applied one.
      return scheduler.flush(trigger);
    },

    setCanvasHold(source, active) {
      if (source === "pointer") pointerOnCanvas = active;
      else keyboardOnCanvas = active;
      if (!active) {
        if (source === "pointer") manualHoldUntil = 0;
        releaseCanvas();
      }
    },

    setPointer(ptr) {
      const cur = get().pointer;
      if (cur.panel === ptr.panel && cur.down === ptr.down) return;
      if (ptr.down && ptr.panel && !(cur.down && cur.panel === ptr.panel)) lastPress = { panel: ptr.panel, at: Date.now() };
      setK({ pointer: { panel: ptr.panel, down: ptr.down } });
      // The pointer left the card a round held still: apply what waited, at the normal pace.
      if (pointerHold && pointerHold.panel !== ptr.panel) {
        pointerHold = null;
        clearPointerTimer();
        if (replanLocal()) noteDecisions(get().plan);
      }
    },

    setColumns(columns) {
      const s = get();
      const repack = packedLayout(s.plan) && s.plan.grid?.columns !== columns;
      if (s.columns === columns && !repack) return;
      setK({ columns });
      if (!repack) return;
      // A resize re-packs by reflow and plays no stages: an empty summary and no badges.
      const plan = s.plan;
      const before = plan.grid ? (plan.grid.columns === columns ? plan.grid.cells : null) : reflowCells(plan, columns).cells;
      const r = reflowCells(plan, columns);
      const moved = !before || plan.placements.some((p) => !cellsEqual(before[p.id], r.cells[p.id]));
      const next: Plan = {
        ...plan,
        placements: plan.placements.map((p) => (p.change ? { ...p, change: null } : p)),
        grid: { columns, cells: r.cells, rows: r.rows, anchored: false },
        changeSummary: emptySummary(),
        round: moved ? Math.max(plan.round ?? 0, roundSeq) + 1 : (plan.round ?? 0),
      };
      adopt(next);
      setK({ plan: next });
    },

    dispose() {
      scheduler.cancel();
      clearHeld();
      clearAnchorTimer();
      clearPointerTimer();
      if (canvasTimer !== null) clearTimeout(canvasTimer);
      canvasTimer = null;
    },
  };

  // ----- the starting state ---------------------------------------------------------

  const settings0 = {
    adaptive: true,
    frozen: false,
    weights: { relevance: 0.5, usage: 0.25, goal: 0.25 },
    minChangeIntervalMs: 2_500,
    ...config.settings,
  } as Sp["settings"];
  const base = {
    events: [],
    previousPlan: null,
    last: null,
    history: [],
    status: "idle",
    lastError: null,
    settings: { ...settings0, weights: { ...settings0.weights } },
    pinned: [],
    bigger: [],
    dismissed: {},
    focusedPanel: null,
    command: null,
    goal: null,
    anchor: null,
    pointer: { panel: null, down: false },
    columns: config.columns ?? 4,
    ...ext?.state,
  } as unknown as State;
  const plan = firstPlan(base);
  if (h.watchHealth) setTimeout(startHealthWatch, 0);
  if (ext?.start) setTimeout(() => ext.start?.(), 0);
  return { ...base, plan, mode: plan.mode, ...actions, ...ext?.actions } as State;
}

// ---------------------------------------------------------------------------
// A store of its own
// ---------------------------------------------------------------------------

export interface AdaptiveStore<Sp extends AdaptiveSpec> extends AdaptiveActions<Sp> {
  getState(): Full<Sp>;
  getInitialState(): Full<Sp>;
  setState(patch: Partial<Full<Sp>>): void;
  subscribe(listener: (state: Full<Sp>, previous: Full<Sp>) => void): () => void;
}

/**
 * The adaptive loop in a small store of its own: getState, setState,
 * subscribe (zustand's store shape, so zustand's useStore can read it too),
 * and the actions on the store as well as in the state.
 */
export function createAdaptiveStore<Sp extends AdaptiveSpec>(config: AdaptiveStoreConfig<Sp>): AdaptiveStore<Sp> & Sp["actions"] {
  let state: Full<Sp>;
  const listeners = new Set<(s: Full<Sp>, prev: Full<Sp>) => void>();
  const get = () => state;
  const set = (patch: Partial<Full<Sp>>): void => {
    const prev = state;
    state = { ...state, ...patch };
    for (const l of listeners) l(state, prev);
  };
  state = createAdaptiveEngine(config, { get, set });
  const initial = state;
  const actionKeys = Object.keys(state).filter((k) => typeof (state as Record<string, unknown>)[k] === "function");
  const bound = Object.fromEntries(actionKeys.map((k) => [k, (...args: unknown[]) => ((state as Record<string, unknown>)[k] as (...a: unknown[]) => unknown)(...args)]));
  const dispose = bound.dispose as () => void;
  return {
    ...(bound as unknown as AdaptiveActions<Sp> & Sp["actions"]),
    getState: get,
    getInitialState: () => initial,
    setState: set,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      dispose();
      listeners.clear();
    },
  };
}
