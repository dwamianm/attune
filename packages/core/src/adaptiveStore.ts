/**
 * createAdaptiveStore: the adaptive loop for an app, in one framework-free
 * store. The UI reports what the user does with track(); the store keeps the
 * event log, asks the model for judgments through the scheduler (debounced,
 * one request in flight, commands first), turns the newest judgments into a
 * plan with the app's policy (createPolicy), and places it on the canvas
 * with the clicked panel held still (placePlan). Request bookkeeping and
 * timers live in the store's closure because they are not UI state.
 *
 * The calm relayout rules come from the demo's store and keep its numbers:
 *   - the panel the user works in is the anchor; its top-left holds still,
 *     and it is released after ANCHOR_IDLE_RELEASE_MS without work,
 *   - the card under the pointer waits POINTER_MOVE_HOLD_MS to move and
 *     POINTER_LEAVE_HOLD_MS to leave,
 *   - layout changes are at least settings.minChangeIntervalMs apart,
 *   - after a manual edit under the pointer, or while keyboard focus is on
 *     the canvas, other cards wait until the hands leave (or
 *     MANUAL_EDIT_HOLD_MS), so the next click lands where the user aimed,
 *   - undo puts the previous plan back, holds it UNDO_HOLD_MS, and does not
 *     redo the undone change while the judgments stay the same.
 *
 * Not here yet (the demo has them in its own store, apps/demo/src/engine/
 * store.ts): link cues that outlive the anchor, the quiet rule, the front
 * group, saved settings, and the focus aids. See docs/library-roadmap.md.
 *
 * Subscribe from any UI: getState, subscribe, and the actions. @attune/react
 * has useAdaptive(store, selector) for React.
 */
import { PANEL_UNCLEAR, type Catalog } from "./catalog.ts";
import type { Policy, PolicyInput } from "./createPolicy.ts";
import type { GridColumns } from "./grid.ts";
import type { ChoiceJudgment, CoreCommandJudgments, CoreJudgments } from "./judgments.ts";
import type { LayoutMode } from "./layoutModes.ts";
import { placePlan, withGrid, type PlaceOptions } from "./place.ts";
import type { AnchorRef, CoreSuggestion, LayoutPlan, RelatedRecord } from "./plan.ts";
import { judgedDensity, type BlendWeights, type Decision, type Density } from "./policy.ts";
import { AdaptScheduler, type SendArgs } from "./scheduler.ts";
import { signalProfile, type CoreSignalType, type SignalDetail, type SignalProfile } from "./signals.ts";
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
/** After an undo, do not redo the undone change until the judgments change, or at most this long. */
export const UNDO_MEMORY_MS = 5 * 60_000;
/** After a manual edit under the pointer, the other cards keep their places until the pointer leaves, a real action happens, or this long passes. */
export const MANUAL_EDIT_HOLD_MS = 10_000;
/** An anchoring filter or action this soon after a press in another card belongs to the pressed card. */
export const ANCHOR_PRESS_WINDOW_MS = 1_000;
/** The anchor is released after this long without work, so a later round may rebalance the canvas. */
export const ANCHOR_IDLE_RELEASE_MS = 20_000;
/** A card under the pointer keeps its cell for at most this long after a round first wanted to move it. */
export const POINTER_MOVE_HOLD_MS = 3_000;
/** Longer for a card that would leave: taking away what the user points at is worse than moving it. */
export const POINTER_LEAVE_HOLD_MS = 5_000;
/** A command's panel answer at or above this applies: the panel becomes the hero. */
export const COMMAND_PANEL_AT = 0.6;
/** A command's promotion survives local re-plans from the same judgments this long, or until a newer round lands. */
export const COMMAND_HOLD_MS = 45_000;

/** Core events that ask the model for a new read. panel_focus counts only when the focused panel changed. */
export const CORE_TRIGGER_TYPES: ReadonlySet<string> = new Set<CoreSignalType>(["item_open", "filter", "search", "action", "command", "panel_open", "panel_dismiss", "suggestion_dismiss"]);
/** Events that only refresh the suggestions from the last judgments; they never move a panel. */
const PASSIVE_TYPES: ReadonlySet<string> = new Set<CoreSignalType>(["panel_dwell", "scroll", "shortcut", "panel_pin", "panel_unpin"]);
/** Events that make the panel they happen in the anchor (a panel_focus only from the pointer). */
const ANCHOR_TYPES: ReadonlySet<string> = new Set<CoreSignalType>(["item_open", "filter", "action", "search", "panel_focus", "panel_open"]);
/** Events a button can log against another panel; only these follow a press in a card. */
const CROSS_PANEL_TYPES: ReadonlySet<string> = new Set<CoreSignalType>(["filter", "action"]);
/** Events that mean the user acted, not just looked; they end a keyboard or pointer hold. */
const REAL_ACTION_TYPES: ReadonlySet<string> = new Set<CoreSignalType>(["item_open", "filter", "search", "action", "suggestion_accept"]);
const MANUAL_EDITS: Partial<Record<string, "pin" | "unpin" | "dismiss" | "open" | "bigger" | "smaller">> = {
  panel_pin: "pin",
  panel_unpin: "unpin",
  panel_dismiss: "dismiss",
  panel_open: "open",
  panel_maximize: "bigger",
  panel_restore: "smaller",
};
const HELD_TEXT = "Waiting a moment before moving panels again";

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

/** What the store sends: the snapshot in words, the command if any, and the app's own fields. */
export interface AdaptiveRequest {
  version: number;
  snapshot: InteractionSnapshot;
  command?: string;
  [field: string]: unknown;
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

export interface RoundRecord<P extends string, J> {
  version: number;
  at: number;
  trigger: string;
  response: AdaptiveResponse<J>;
  decisions: Decision<P>[];
  stale: boolean;
}

export interface AdaptiveState<P extends string, G extends string, S extends CoreSuggestion, K extends string, J, T extends string> {
  events: LoggedEvent<P, T>[];
  plan: LayoutPlan<P, S, K>;
  previousPlan: LayoutPlan<P, S, K> | null;
  last: AdaptiveResponse<J> | null;
  history: RoundRecord<P, J>[];
  status: AdaptiveStatus;
  lastError: string | null;
  settings: AdaptiveSettings;
  pinned: P[];
  bigger: P[];
  dismissed: Partial<Record<P, number>>;
  focusedPanel: P | null;
  anchor: AnchorRef<P, K> | null;
  pointer: { panel: P | null; down: boolean };
  columns: GridColumns;
  goal: { id: G; confidence: number } | null;
  mode: LayoutMode;
  /** The last command and what came of it. */
  command: { text: string; status: "applied" | "unclear"; panel?: P } | null;
}

export interface AdaptiveActions<P extends string, S extends CoreSuggestion, T extends string> {
  track(input: TrackInput<P, T>): void;
  runCommand(text: string): Promise<void>;
  pin(panel: P): void;
  unpin(panel: P): void;
  maximize(panel: P): void;
  restore(panel: P): void;
  dismiss(panel: P): void;
  open(panel: P): void;
  setFocused(panel: P | null): void;
  acceptSuggestion(s: S): void;
  dismissSuggestion(s: S): void;
  setSettings(patch: Partial<AdaptiveSettings>): void;
  setWeights(patch: Partial<BlendWeights>): void;
  undo(): void;
  reset(): void;
  adaptNow(trigger?: string): Promise<void>;
  setPointer(pointer: { panel: P | null; down: boolean }): void;
  setColumns(columns: GridColumns): void;
  /** The pointer or keyboard focus is on the canvas (true) or left it (false). */
  setCanvasHold(source: "pointer" | "keyboard", active: boolean): void;
  /** Stops every timer and the request in flight. */
  dispose(): void;
}

export interface AdaptiveStore<P extends string, G extends string, S extends CoreSuggestion, K extends string, J, T extends string> extends AdaptiveActions<P, S, T> {
  getState(): AdaptiveState<P, G, S, K, J, T>;
  subscribe(listener: (state: AdaptiveState<P, G, S, K, J, T>, previous: AdaptiveState<P, G, S, K, J, T>) => void): () => void;
}

export interface AdaptiveStoreConfig<
  P extends string,
  G extends string,
  A extends string,
  S extends CoreSuggestion<A>,
  K extends string,
  J extends CoreJudgments<P, G, A> & { command?: CoreCommandJudgments<P, A> },
  T extends string,
  X,
> {
  catalog: Catalog<P, G, A>;
  /** The app's policy (createPolicy), built on the core PolicyInput. */
  policy: Policy<P, S, K, PolicyInput<P, G, A, S, K>, X>;
  /** Sends one request to the app's server and returns its answer. Abort the call when `signal` aborts. */
  send: (request: AdaptiveRequest, opts: { signal: AbortSignal }) => Promise<AdaptiveResponse<J>>;
  /** The app's words for the snapshot (panel titles, record kinds, actions in the past tense). */
  words: EventWords<P>;
  /** How the app's own event types count. Default: the core profile. */
  profile?: SignalProfile<string>;
  /** The sentence for one of the app's own event types. Absent, or undefined: the core sentence. */
  describe?: (input: TrackInput<P, T>) => string | undefined;
  /** Whether an event asks the model for a new read. Default: CORE_TRIGGER_TYPES, and panel_focus on a new panel. */
  triggers?: (input: TrackInput<P, T>, focusChanged: boolean) => boolean;
  /** The app's own request fields (candidates and so on), from the state at send time. */
  request?: (state: AdaptiveState<P, G, S, K, J, T>) => Record<string, unknown>;
  /** Records joined to the anchor, per panel, from the app's data. Absent: no links. */
  linked?: (anchor: AnchorRef<P, K>, state: AdaptiveState<P, G, S, K, J, T>) => Partial<Record<P, RelatedRecord<K>[]>> | undefined;
  /** Passed to the policy's computePlan for the app's suggestions. */
  extra?: (state: AdaptiveState<P, G, S, K, J, T>) => X;
  /** A short name for the anchor's link tags, for example "T-201" or "Larkspur Bakery". Default: the event's label, else its client. */
  anchorLabel?: (ref: Omit<AnchorRef<P, K>, "at" | "label">, state: AdaptiveState<P, G, S, K, J, T>) => string | undefined;
  /** The app's help panel, never the pointer's hold. */
  helpPanel?: P;
  settings?: Partial<AdaptiveSettings>;
  /** The starting column count. Default 4. */
  columns?: GridColumns;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export function createAdaptiveStore<
  P extends string,
  G extends string,
  A extends string,
  S extends CoreSuggestion<A>,
  K extends string,
  J extends CoreJudgments<P, G, A> & { command?: CoreCommandJudgments<P, A> },
  T extends string = never,
  X = undefined,
>(config: AdaptiveStoreConfig<P, G, A, S, K, J, T, X>): AdaptiveStore<P, G, S, K, J, T> {
  type State = AdaptiveState<P, G, S, K, J, T>;
  type Plan = LayoutPlan<P, S, K>;
  type Input = TrackInput<P, T>;
  const { catalog, policy } = config;
  const profile = config.profile ?? signalProfile();
  const settings0: AdaptiveSettings = {
    adaptive: true,
    frozen: false,
    weights: { relevance: 0.5, usage: 0.25, goal: 0.25 },
    minChangeIntervalMs: 2_500,
    ...config.settings,
  };

  const initial = (): State => {
    // With adaptive on, the first plan has its cells at once, so the canvas never shows a plan without them.
    const columns = config.columns ?? 4;
    const plan = settings0.adaptive ? withGrid(policy.defaultPlan(), columns) : policy.defaultPlan();
    return {
      events: [],
      plan,
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
      anchor: null,
      pointer: { panel: null, down: false },
      columns,
      goal: null,
      mode: plan.mode,
      command: null,
    };
  };

  // ----- the observable state -------------------------------------------------

  let state = initial();
  const listeners = new Set<(s: State, prev: State) => void>();
  const get = (): State => state;
  const set = (patch: Partial<State>): void => {
    const prev = state;
    state = { ...state, ...patch };
    for (const l of listeners) l(state, prev);
  };

  // ----- bookkeeping (not UI state) ------------------------------------------

  let eventSeq = 0;
  let version = 0;
  let lastAppliedVersion = 0;
  let recentModes: LayoutMode[] = [];
  let recentDensities: Density[] = [];
  let lastPlanChangeAt = Number.NEGATIVE_INFINITY;
  let undoHoldUntil = 0;
  let heldTimer: ReturnType<typeof setTimeout> | null = null;
  let baseStatus: Exclude<AdaptiveStatus, "thinking"> = "idle";
  let manuallyOpened: P[] = [];
  let commandHold: { panel: P; version: number; at: number } | null = null;
  let undone: { avoid: NonNullable<PolicyInput<P, G, A, S, K>["avoid"]>; judgments: J; at: number } | null = null;
  let pointerOnCanvas = false;
  let keyboardOnCanvas = false;
  let manualHoldUntil = 0;
  let canvasDeferred = false;
  let canvasTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPress: { panel: P; at: number } | null = null;
  let anchorTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAnchorAt = 0;
  let roundSeq = 0;
  let pointerHold: { panel: P; moveSince: number | null; leaveSince: number | null } | null = null;
  let pointerTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduler = new AdaptScheduler({
    send: (args) => sendRequest(args),
    onBusyChange: (busy) => set({ status: busy ? "thinking" : baseStatus }),
  });
  const statusNow = (): AdaptiveStatus => (scheduler.busy ? "thinking" : baseStatus);
  const isPanel = (id: unknown): id is P => policy.isPanelId(id);
  const without = <V,>(record: Partial<Record<P, V>>, id: P): Partial<Record<P, V>> => {
    const out = { ...record };
    delete out[id];
    return out;
  };
  const basePlan = (): Plan => policy.traditionalPlan({ pinned: get().pinned, dismissed: get().dismissed, opened: manuallyOpened, bigger: get().bigger });

  function describe(input: Input): string {
    const own = config.describe?.(input);
    if (own !== undefined) return own;
    return describeCoreEvent({ type: input.type as CoreSignalType, ...(input.panel ? { panel: input.panel } : {}), ...(input.detail ? { detail: input.detail } : {}) }, config.words);
  }

  // ----- the place step -------------------------------------------------------

  function workAnchor(): AnchorRef<P, K> | null {
    const a = get().anchor;
    return a && a.source !== "command" ? a : null;
  }

  /** The card under the pointer, when pointer holds may apply: on the canvas and not the anchor (which never moves). */
  function pointerPanel(): P | null {
    const s = get();
    const p = s.pointer.panel;
    if (!p || p === workAnchor()?.panel || p === config.helpPanel) return null;
    return s.plan.placements.some((x) => x.id === p) ? p : null;
  }

  function holdOpen(panel: P, kind: "move" | "leave", now: number): boolean {
    const since = pointerHold?.panel === panel ? (kind === "move" ? pointerHold.moveSince : pointerHold.leaveSince) : null;
    return since === null || now - since < (kind === "move" ? POINTER_MOVE_HOLD_MS : POINTER_LEAVE_HOLD_MS);
  }

  function place(next: Plan, opts: PlaceOptions<P> = {}): { plan: Plan; heldMove: P | null } {
    const s = get();
    return placePlan({
      ...opts,
      current: s.plan,
      next,
      columns: s.columns,
      packed: s.settings.adaptive || next.placements.some((p) => p.bigger),
      anchor: s.anchor,
      pointerPanel: pointerPanel(),
      pointerMoveOpen: (ptr) => holdOpen(ptr, "move", Date.now()),
      roundSeq,
      remark: policy.remarkPanels,
    });
  }

  function adopt(plan: Plan): void {
    roundSeq = Math.max(roundSeq, plan.round ?? 0);
  }

  function clearHeld(): void {
    if (heldTimer !== null) clearTimeout(heldTimer);
    heldTimer = null;
  }

  function setPlanDirect(next: Plan, opts: PlaceOptions<P> = {}): void {
    const s = get();
    const plan = place(next, opts).plan;
    adopt(plan);
    if (policy.planSignature(plan) === policy.planSignature(s.plan)) {
      set({ plan, mode: plan.mode });
      return;
    }
    clearHeld();
    lastPlanChangeAt = Date.now();
    set({ previousPlan: s.plan, plan, mode: plan.mode });
  }

  // ----- the anchor -----------------------------------------------------------

  function clearAnchorTimer(): void {
    if (anchorTimer !== null) clearTimeout(anchorTimer);
    anchorTimer = null;
  }

  function releaseAnchor(): void {
    clearAnchorTimer();
    if (get().anchor) set({ anchor: null });
  }

  function armAnchorTimer(): void {
    clearAnchorTimer();
    anchorTimer = setTimeout(() => {
      anchorTimer = null;
      if (get().anchor) set({ anchor: null });
    }, ANCHOR_IDLE_RELEASE_MS);
  }

  function setAnchor(ref: Omit<AnchorRef<P, K>, "at">, now: number): void {
    lastAnchorAt = Math.max(now, lastAnchorAt + 1);
    set({ anchor: { ...ref, at: lastAnchorAt } });
    armAnchorTimer();
  }

  /** Work in a panel makes it the anchor; more work there on the same record or client only restarts the idle timer. */
  function noteWork(input: Input, now: number): void {
    if (!ANCHOR_TYPES.has(input.type)) return;
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
    const itemKind = d.itemKind as K | undefined;
    const client = d.client;
    const cur = s.anchor;
    if (cur && cur.source !== "command" && cur.panel === panel && (!itemId || itemId === cur.itemId) && (!client || client === cur.client)) {
      armAnchorTimer();
      return;
    }
    const ref = { panel, ...(itemKind && itemId ? { itemKind, itemId } : {}), ...(client ? { client } : {}), source: "work" as const };
    const label = config.anchorLabel ? config.anchorLabel(ref, s) : (d.label ?? client);
    setAnchor({ ...ref, ...(label ? { label } : {}) }, now);
  }

  // ----- holds ----------------------------------------------------------------

  function clearPointerTimer(): void {
    if (pointerTimer !== null) clearTimeout(pointerTimer);
    pointerTimer = null;
  }

  /** Remember whether a round kept the pointer's card from moving or leaving, and re-plan when the cap runs out. */
  function notePointerHolds(move: P | null, leave: P | null): void {
    const panel = move ?? leave;
    if (!panel) {
      pointerHold = null;
      clearPointerTimer();
      return;
    }
    const now = Date.now();
    const h = pointerHold?.panel === panel ? pointerHold : { panel, moveSince: null, leaveSince: null };
    h.moveSince = move ? (h.moveSince ?? now) : null;
    h.leaveSince = leave ? (h.leaveSince ?? now) : null;
    pointerHold = h;
    const ends = [h.moveSince !== null ? h.moveSince + POINTER_MOVE_HOLD_MS : Infinity, h.leaveSince !== null ? h.leaveSince + POINTER_LEAVE_HOLD_MS : Infinity];
    clearPointerTimer();
    pointerTimer = setTimeout(
      () => {
        pointerTimer = null;
        if (replanLocal()) noteDecisions(get().plan);
      },
      Math.max(0, Math.min(...ends) - now),
    );
  }

  function canvasHeld(now: number): boolean {
    return keyboardOnCanvas || (pointerOnCanvas && now < manualHoldUntil);
  }

  function armCanvasTimer(now: number): void {
    if (canvasTimer !== null) clearTimeout(canvasTimer);
    canvasTimer = null;
    if (!keyboardOnCanvas && pointerOnCanvas && manualHoldUntil > now) {
      canvasTimer = setTimeout(() => {
        canvasTimer = null;
        releaseCanvas();
      }, manualHoldUntil - now);
    }
  }

  function releaseCanvas(): void {
    const now = Date.now();
    if (canvasHeld(now)) {
      armCanvasTimer(now);
      return;
    }
    if (canvasTimer !== null) clearTimeout(canvasTimer);
    canvasTimer = null;
    if (!canvasDeferred) return;
    canvasDeferred = false;
    const s = get();
    if (!s.settings.adaptive || !s.last) {
      setPlanDirect(basePlan());
      return;
    }
    if (replanLocal()) noteDecisions(get().plan);
  }

  // ----- the policy round -----------------------------------------------------

  function undoAvoid(res: AdaptiveResponse<J>, now: number): PolicyInput<P, G, A, S, K>["avoid"] {
    if (!undone) return undefined;
    if (now - undone.at > UNDO_MEMORY_MS || topGoalOrPanelChanged(undone.judgments, res.judgments)) {
      undone = null;
      return undefined;
    }
    return undone.avoid;
  }

  /** The judgments changed materially: another goal, layout, or top panel. */
  function topGoalOrPanelChanged(a: J, b: J): boolean {
    if (a.goal?.choice !== b.goal?.choice || a.layout?.choice !== b.layout?.choice) return true;
    const top = (j: J): P | null => {
      let best: P | null = null;
      let bestShare = -1;
      for (const id of catalog.panelIds) {
        const r = j.relevance?.[id];
        const share = r && r.max > 0 ? r.score / r.max : 0;
        if (share > bestShare) {
          best = id;
          bestShare = share;
        }
      }
      return best;
    };
    return top(a) !== top(b);
  }

  function policyInput(res: AdaptiveResponse<J>, now: number, hold?: P[]): PolicyInput<P, G, A, S, K> {
    const s = get();
    const avoid = undoAvoid(res, now);
    const anchor = s.anchor;
    const linked = anchor && config.linked ? config.linked(anchor, s) : undefined;
    return {
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
      ...(s.bigger.length > 0 ? { bigger: s.bigger } : {}),
      ...(hold ? { hold } : {}),
    };
  }

  function policyPlan(res: AdaptiveResponse<J>, opts: { holds?: boolean } = {}): { plan: Plan; leaveHeld: P | null } {
    const s = get();
    const now = Date.now();
    const extra = config.extra?.(s);
    let plan = policy.computePlan(policyInput(res, now), extra);
    let leaveHeld: P | null = null;
    const ptr = opts.holds ? pointerPanel() : null;
    if (ptr && !plan.placements.some((p) => p.id === ptr) && holdOpen(ptr, "leave", now)) {
      plan = policy.computePlan(policyInput(res, now, [ptr]), extra);
      leaveHeld = ptr;
    }
    // Re-reading the command round's own judgments must not undo the command.
    const h = commandHold;
    if (h && (now - h.at > COMMAND_HOLD_MS || res.version > h.version || s.dismissed[h.panel] != null)) commandHold = null;
    if (commandHold) plan = policy.applyPromotion({ plan, previous: s.plan, panel: commandHold.panel, pinned: s.pinned, bigger: s.bigger });
    return { plan, leaveHeld };
  }

  /** Apply a plan, respecting the canvas holds and the minimum change interval unless forced. */
  function commit(raw: Plan, opts: { force?: boolean; skipQuiet?: boolean; leaveHeld?: P | null } = {}): "applied" | "quiet" | "held" {
    const s = get();
    const { plan: next, heldMove } = place(raw, { pointerHolds: !opts.force });
    const holds = opts.force ? { move: null, leave: null } : { move: heldMove, leave: opts.leaveHeld ?? null };
    if (policy.planSignature(next) === policy.planSignature(s.plan)) {
      if (!opts.skipQuiet) {
        adopt(next);
        set({ plan: next, mode: next.mode });
        notePointerHolds(holds.move, holds.leave);
      }
      return "quiet";
    }
    const now = Date.now();
    if (!opts.force && canvasHeld(now)) {
      clearHeld();
      canvasDeferred = true;
      armCanvasTimer(now);
      return "held";
    }
    if (lastPlanChangeAt > now) lastPlanChangeAt = now;
    if (undoHoldUntil > now + UNDO_HOLD_MS) undoHoldUntil = now + UNDO_HOLD_MS;
    const readyAt = Math.max(lastPlanChangeAt + s.settings.minChangeIntervalMs, undoHoldUntil);
    if (!opts.force && now < readyAt) {
      clearHeld();
      heldTimer = setTimeout(() => {
        heldTimer = null;
        if (replanLocal()) noteDecisions(get().plan);
      }, readyAt - now);
      return "held";
    }
    clearHeld();
    lastPlanChangeAt = now;
    adopt(next);
    set({ previousPlan: s.plan, plan: next, mode: next.mode });
    notePointerHolds(holds.move, holds.leave);
    return "applied";
  }

  function replanLocal(opts: { force?: boolean; skipQuiet?: boolean } = {}): boolean {
    const s = get();
    if (!s.settings.adaptive) {
      if (opts.skipQuiet) return false;
      setPlanDirect(basePlan());
      return true;
    }
    if (s.settings.frozen || !s.last) return false;
    const { plan, leaveHeld } = policyPlan(s.last, { holds: !opts.force });
    return commit(plan, { ...opts, leaveHeld }) === "applied";
  }

  /** After a passive signal: refresh the suggestions from the last judgments, never moving a panel. */
  function refreshPassive(): void {
    const s = get();
    if (!s.settings.adaptive || s.settings.frozen || !s.last) return;
    const suggestions = policyPlan(s.last).plan.suggestions;
    const key = (list: S[]) => list.map((x) => `${x.actionId}|${x.prominence}|${x.label}`).join(",");
    if (key(suggestions) !== key(s.plan.suggestions)) set({ plan: { ...s.plan, suggestions } });
  }

  function noteDecisions(plan: Plan): void {
    const history = get().history;
    const i = history.findIndex((r) => r.version === plan.basedOnVersion && !r.stale && r.decisions.length === 1 && r.decisions[0].kind === "hold" && r.decisions[0].text === HELD_TEXT);
    if (i === -1) return;
    const next = [...history];
    next[i] = { ...next[i], decisions: plan.decisions };
    set({ history: next });
  }

  function manualReplan(kind: "pin" | "unpin" | "dismiss" | "open" | "bigger" | "smaller", panel: P, size?: Plan["placements"][number]["size"]): void {
    const s = get();
    const now = Date.now();
    const userResized = kind === "bigger" || kind === "smaller" ? panel : null;
    const edit = { kind, panel, ...(size ? { size } : {}) };
    const inPlace: PlaceOptions<P> = userResized ? { userResized } : { holdAll: true };
    if (s.settings.frozen && s.settings.adaptive) {
      setPlanDirect(policy.editPlan(s.plan, edit), inPlace);
      return;
    }
    if (pointerOnCanvas && kind !== "open") {
      setPlanDirect(policy.editPlan(s.plan, edit), inPlace);
      manualHoldUntil = now + MANUAL_EDIT_HOLD_MS;
      canvasDeferred = true;
      armCanvasTimer(now);
      return;
    }
    const placeOpts: PlaceOptions<P> = kind === "pin" ? { reflow: true } : inPlace;
    if (!s.settings.adaptive || !s.last) {
      setPlanDirect(basePlan(), placeOpts);
    } else {
      setPlanDirect(policy.editPlan(s.plan, edit, { pinsFirst: kind === "pin" }), placeOpts);
      replanLocal();
    }
  }

  // ----- requests -------------------------------------------------------------

  function pushHistory(record: RoundRecord<P, J>): void {
    set({ history: [...get().history, record].slice(-HISTORY_LIMIT) });
  }

  async function sendRequest({ trigger, kind, signal, command }: SendArgs): Promise<void> {
    const s = get();
    const now = Date.now();
    const request: AdaptiveRequest = {
      ...config.request?.(s),
      version,
      snapshot: buildSnapshot(s.events, { now, focusedPanel: s.focusedPanel, visiblePanels: s.plan.placements.map((p) => p.id) }, { profile, words: config.words, ...(config.helpPanel ? { helpPanel: config.helpPanel } : {}), describe: (e) => e.text || describe(e) }),
      ...(command ? { command } : {}),
    };
    let response: AdaptiveResponse<J>;
    try {
      response = await config.send(request, { signal });
    } catch (err) {
      if (signal.aborted || (err instanceof Error && err.name === "AbortError")) return;
      baseStatus = "error";
      set({ lastError: err instanceof Error ? err.message : String(err), status: statusNow() });
      if (kind === "command" && command) set({ command: { text: command, status: "unclear" } });
      return;
    }
    if (signal.aborted) return;
    handleResponse(response, trigger, kind, command);
  }

  function statusFrom(res: AdaptiveResponse<J>): Exclude<AdaptiveStatus, "thinking"> {
    if (res.source === "jev") return "idle";
    if (res.meta?.fallback === "no_key") return "offline";
    return res.meta?.error ? "error" : "offline";
  }

  function handleResponse(res: AdaptiveResponse<J>, trigger: string, kind: SendArgs["kind"], commandText: string | undefined): void {
    const now = Date.now();
    const stale = res.version <= lastAppliedVersion;
    // A command's outcome matters even if its layout judgments are old: the user asked.
    let promote: P | null = null;
    if (kind === "command" && commandText) {
      const panel: ChoiceJudgment<P | typeof PANEL_UNCLEAR> | undefined = res.judgments.command?.panel;
      const p = panel?.choice;
      if (panel && p && p !== PANEL_UNCLEAR && isPanel(p) && panel.confidence >= COMMAND_PANEL_AT) {
        promote = p;
        set({ command: { text: commandText, status: "applied", panel: p }, dismissed: without(get().dismissed, p) });
      } else {
        set({ command: { text: commandText, status: "unclear" } });
      }
    }
    if (stale) {
      pushHistory({ version: res.version, at: now, trigger, response: res, decisions: [], stale: true });
      return;
    }
    lastAppliedVersion = res.version;
    baseStatus = statusFrom(res);
    // An unclear command says nothing about the work: keep the layout and the last good judgments.
    if (kind === "command" && !promote) {
      set({ lastError: res.meta?.error ?? null, status: statusNow() });
      pushHistory({ version: res.version, at: now, trigger, response: res, decisions: [{ kind: "hold", text: "Kept the layout because the command was unclear" }], stale: false });
      return;
    }
    if (commandHold && res.version > commandHold.version) commandHold = null;
    const judgedMode = res.judgments.layout?.choice;
    if (judgedMode) recentModes = [...recentModes, judgedMode].slice(-RECENT_MODES_LIMIT);
    const density = judgedDensity(res.judgments.expertise, get().events.filter((e) => e.type !== "panel_dwell").length);
    if (density) recentDensities = [...recentDensities, density].slice(-RECENT_DENSITIES_LIMIT);
    const goal = res.judgments.goal;
    set({ last: res, goal: goal ? { id: goal.choice, confidence: goal.confidence } : null, lastError: res.meta?.error ?? null, status: statusNow() });

    const s = get();
    let decisions: Decision<P>[] = [];
    if (!s.settings.adaptive || s.settings.frozen) {
      if (promote) setPlanDirect(policy.editPlan(s.plan, { kind: "open", panel: promote }), { holdAll: true });
    } else if (promote) {
      lastAnchorAt = Math.max(now, lastAnchorAt + 1);
      set({ anchor: { panel: promote, at: lastAnchorAt, source: "command" } });
      armAnchorTimer();
      commandHold = { panel: promote, version: res.version, at: now };
      const { plan } = policyPlan(res);
      commit(plan, { force: true });
      decisions = get().plan.decisions;
    } else {
      const { plan, leaveHeld } = policyPlan(res, { holds: true });
      const result = commit(plan, { leaveHeld });
      decisions = result === "held" ? [{ kind: "hold", text: HELD_TEXT }] : result === "applied" ? get().plan.decisions : [];
    }
    pushHistory({ version: res.version, at: now, trigger, response: res, decisions, stale: false });
  }

  // ----- tracking -------------------------------------------------------------

  function trackInternal(input: Input, opts: { schedule?: boolean } = {}): void {
    const s = get();
    const now = Date.now();
    const event: LoggedEvent<P, T> = { ...input, id: ++eventSeq, t: now, text: describe(input) };
    version += 1;
    const p = input.panel && isPanel(input.panel) ? input.panel : undefined;
    const lastWork = [...s.events].reverse().find((e) => e.panel && profile.work.has(e.type))?.panel ?? null;
    // Keyboard focus alone (Tab) does not ask the model.
    const focusChanged = input.type === "panel_focus" && input.detail?.via !== "keyboard" && p !== undefined && p !== lastWork;
    const patch: Partial<State> = { events: [...s.events, event].slice(-EVENT_LOG_LIMIT) };
    if (p) {
      switch (input.type) {
        case "panel_pin":
          if (!s.pinned.includes(p)) patch.pinned = [...s.pinned, p];
          patch.dismissed = without(s.dismissed, p);
          break;
        case "panel_unpin":
          patch.pinned = s.pinned.filter((x) => x !== p);
          break;
        case "panel_dismiss":
          patch.dismissed = { ...s.dismissed, [p]: now };
          patch.pinned = s.pinned.filter((x) => x !== p);
          patch.bigger = s.bigger.filter((x) => x !== p);
          if (s.focusedPanel === p) patch.focusedPanel = null;
          manuallyOpened = manuallyOpened.filter((x) => x !== p);
          if (commandHold?.panel === p) commandHold = null;
          break;
        case "panel_maximize":
          if (!s.bigger.includes(p)) patch.bigger = [...s.bigger, p];
          break;
        case "panel_restore":
          patch.bigger = s.bigger.filter((x) => x !== p);
          break;
        case "panel_open":
          patch.dismissed = without(s.dismissed, p);
          if (!manuallyOpened.includes(p)) manuallyOpened = [...manuallyOpened, p];
          break;
        default:
          if (profile.work.has(input.type) && input.type !== "search" && input.type !== "filter" && input.type !== "action") patch.focusedPanel = p;
          break;
      }
    }
    set(patch);
    if (input.type === "panel_dismiss" && p && get().anchor?.panel === p) releaseAnchor();
    noteWork(input, now);
    if ((input.type === "panel_maximize" || input.type === "panel_restore") && p) {
      const cur = get().anchor;
      if (cur && cur.source !== "command" && cur.panel === p) armAnchorTimer();
      else if (get().settings.adaptive && !get().settings.frozen) setAnchor({ panel: p, source: "work" }, now);
    }
    if (REAL_ACTION_TYPES.has(input.type) && (keyboardOnCanvas || manualHoldUntil > now)) {
      keyboardOnCanvas = false;
      manualHoldUntil = 0;
      releaseCanvas();
    }
    const kind = MANUAL_EDITS[input.type];
    if (p && kind) {
      const size = kind === "smaller" ? policy.restoredSize(s.plan, p) : undefined;
      manualReplan(kind, p, size);
    } else if (PASSIVE_TYPES.has(input.type)) {
      refreshPassive();
    }
    const asks = config.triggers ? config.triggers(input, focusChanged) : CORE_TRIGGER_TYPES.has(input.type) || (input.type === "panel_focus" && focusChanged);
    if (opts.schedule !== false && asks) scheduler.notify(input.type);
  }

  // ----- actions --------------------------------------------------------------

  const actions: AdaptiveActions<P, S, T> = {
    track(input) {
      trackInternal(input);
    },
    async runCommand(text) {
      const clean = text.trim();
      if (!clean) return;
      trackInternal({ type: "command", detail: { query: clean, via: "keyboard" } }, { schedule: false });
      await scheduler.command(clean);
    },
    pin(panel) {
      trackInternal({ type: "panel_pin", panel });
    },
    unpin(panel) {
      trackInternal({ type: "panel_unpin", panel });
    },
    maximize(panel) {
      trackInternal({ type: "panel_maximize", panel });
    },
    restore(panel) {
      trackInternal({ type: "panel_restore", panel });
    },
    dismiss(panel) {
      trackInternal({ type: "panel_dismiss", panel });
    },
    open(panel) {
      trackInternal({ type: "panel_open", panel });
    },
    setFocused(panel) {
      set({ focusedPanel: panel });
    },
    acceptSuggestion(s) {
      trackInternal({ type: "suggestion_accept", detail: { label: s.label, actionId: s.actionId, via: "suggestion" } });
    },
    dismissSuggestion(s) {
      trackInternal({ type: "suggestion_dismiss", detail: { label: s.label, actionId: s.actionId } });
    },
    setSettings(patch) {
      const s = get();
      const settings = { ...s.settings, ...patch };
      set({ settings });
      if (patch.adaptive !== undefined && patch.adaptive !== s.settings.adaptive) {
        releaseAnchor();
        if (!settings.adaptive || !s.last) setPlanDirect(basePlan(), { reflow: true });
        else replanLocal({ force: true });
      }
    },
    setWeights(patch) {
      set({ settings: { ...get().settings, weights: { ...get().settings.weights, ...patch } } });
      replanLocal({ force: true });
    },
    undo() {
      const s = get();
      const to = s.previousPlan;
      if (!to) return;
      const now = Date.now();
      // Do not redo what was undone while the judgments stay the same.
      if (s.last) {
        const before = new Set(to.placements.map((p) => p.id));
        const after = new Set(s.plan.placements.map((p) => p.id));
        undone = {
          avoid: {
            ...(to.mode !== s.plan.mode ? { mode: s.plan.mode } : {}),
            add: [...after].filter((id) => !before.has(id)),
            dock: [...before].filter((id) => !after.has(id)),
          },
          judgments: s.last.judgments,
          at: now,
        };
      }
      undoHoldUntil = now + UNDO_HOLD_MS;
      releaseAnchor();
      const marked = policy.markChanges(s.plan, { ...to, decisions: [] });
      const { plan } = place({ ...marked, decisions: [{ kind: "hold", text: "Undid the last layout change" }, ...marked.decisions] }, { keepGrid: true, decisions: false });
      adopt(plan);
      clearHeld();
      lastPlanChangeAt = now;
      set({ previousPlan: null, plan, mode: plan.mode });
      trackInternal({ type: "undo" }, { schedule: false });
    },
    reset() {
      scheduler.cancel();
      clearHeld();
      clearAnchorTimer();
      clearPointerTimer();
      if (canvasTimer !== null) clearTimeout(canvasTimer);
      canvasTimer = null;
      lastAppliedVersion = version;
      recentModes = [];
      recentDensities = [];
      lastPlanChangeAt = Number.NEGATIVE_INFINITY;
      undoHoldUntil = 0;
      baseStatus = "idle";
      manuallyOpened = [];
      commandHold = null;
      undone = null;
      pointerOnCanvas = keyboardOnCanvas = false;
      manualHoldUntil = 0;
      canvasDeferred = false;
      lastPress = null;
      pointerHold = null;
      const fresh = initial();
      const columns = get().columns;
      const base = get().settings.adaptive ? withGrid(policy.defaultPlan(), columns) : policy.defaultPlan();
      const plan = { ...base, round: roundSeq + 1 };
      roundSeq += 1;
      set({ ...fresh, columns, plan, settings: get().settings });
    },
    adaptNow(trigger = "manual") {
      return scheduler.flush(trigger);
    },
    setPointer(pointer) {
      const prev = get().pointer;
      if (pointer.down && pointer.panel) lastPress = { panel: pointer.panel, at: Date.now() };
      if (prev.panel === pointer.panel && prev.down === pointer.down) return;
      set({ pointer });
    },
    setColumns(columns) {
      const s = get();
      if (columns === s.columns) return;
      set({ columns });
      if (s.settings.adaptive || s.plan.placements.some((p) => p.bigger)) {
        const { plan } = place(s.plan, { reflow: true, decisions: false });
        adopt(plan);
        set({ plan, mode: plan.mode });
      }
    },
    setCanvasHold(source, active) {
      if (source === "pointer") pointerOnCanvas = active;
      else keyboardOnCanvas = active;
      if (!active) releaseCanvas();
    },
    dispose() {
      scheduler.cancel();
      clearHeld();
      clearAnchorTimer();
      clearPointerTimer();
      if (canvasTimer !== null) clearTimeout(canvasTimer);
      canvasTimer = null;
      listeners.clear();
    },
  };

  return {
    ...actions,
    getState: get,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
