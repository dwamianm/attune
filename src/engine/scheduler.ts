/**
 * Decides when the client asks the server for fresh Jev judgments.
 *
 * Asking on every click would make the layout jumpy and waste requests, so
 * triggers are debounced, capped by a max wait during continuous activity,
 * and limited to one request in flight. Triggers that arrive mid-flight cause
 * exactly one follow-up. Commands are the exception: the user is waiting on
 * them, so they skip the debounce and replace an in-flight background request.
 *
 * The clock and timers are injectable so tests can drive it with fake timers.
 */
import type { SignalType } from "../../shared/types.ts";

/** Wait this long after the last trigger before asking. */
export const DEBOUNCE_MS = 700;
/** But never wait longer than this from the first unsent trigger. */
export const MAX_WAIT_MS = 2_500;
/** At least this long between the end of one background request and the next. */
export const MIN_GAP_MS = 1_000;

/**
 * Events that ask Jev for a new read. panel_focus only counts when the focused
 * panel changed. An open from the Up next card, or starting the next task
 * from the Done card (it opens a record), asks like any record open;
 * context_save and task_done (engine-made), setting_change (a focus aid
 * switched on or off), and context_restore ("Back to" holds its layout until
 * new work, which asks) never ask by themselves.
 */
export const TRIGGER_TYPES: ReadonlySet<SignalType> = new Set<SignalType>([
  "item_open",
  "up_next_open",
  "task_start",
  "filter",
  "search",
  "action",
  "command",
  "panel_open",
  "panel_dismiss",
  "suggestion_dismiss",
]);

/** Events that only re-plan locally from the last judgments, without calling Jev. */
export const LOCAL_REPLAN_TYPES: ReadonlySet<SignalType> = new Set<SignalType>(["panel_dwell", "scroll", "shortcut", "panel_pin", "panel_unpin"]);

export function triggersRequest(type: SignalType, focusChanged: boolean): boolean {
  return TRIGGER_TYPES.has(type) || (type === "panel_focus" && focusChanged);
}

export type RequestKind = "auto" | "command" | "manual";

export interface SendArgs {
  /** What caused the request, for example "item_open" or "command". */
  trigger: string;
  kind: RequestKind;
  /** Aborted when a command replaces this request or the scheduler is cancelled. */
  signal: AbortSignal;
  /** Command bar text, only for kind "command". */
  command?: string;
}

export interface SchedulerOptions {
  /** Performs one request. Should handle its own errors; rejections are swallowed. */
  send: (args: SendArgs) => Promise<void>;
  now?: () => number;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
  /** Called when a request starts or the last one finishes. */
  onBusyChange?: (busy: boolean) => void;
  debounceMs?: number;
  maxWaitMs?: number;
  minGapMs?: number;
}

interface Flight {
  kind: RequestKind;
  controller: AbortController;
  promise: Promise<void>;
}

export class AdaptScheduler {
  private readonly send: SchedulerOptions["send"];
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onBusyChange: (busy: boolean) => void;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly minGapMs: number;

  private timer: unknown = null;
  private flight: Flight | null = null;
  private pendingTrigger: string | null = null;
  private firstPendingAt: number | null = null;
  private lastTriggerAt = 0;
  private lastEndAt = Number.NEGATIVE_INFINITY;

  constructor(opts: SchedulerOptions) {
    this.send = opts.send;
    // Read the globals at call time so fake timers installed later still apply.
    this.now = opts.now ?? (() => Date.now());
    this.setTimer = opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.clearTimer = opts.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onBusyChange = opts.onBusyChange ?? (() => {});
    this.debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.maxWaitMs = opts.maxWaitMs ?? MAX_WAIT_MS;
    this.minGapMs = opts.minGapMs ?? MIN_GAP_MS;
  }

  /** True while a request is in flight. */
  get busy(): boolean {
    return this.flight !== null;
  }

  /** True when a trigger is waiting to be sent. */
  get pending(): boolean {
    return this.pendingTrigger !== null;
  }

  /** A triggering event happened. Debounced; during a flight it marks the state dirty. */
  notify(trigger: string): void {
    const now = this.now();
    this.pendingTrigger = trigger;
    this.firstPendingAt ??= now;
    this.lastTriggerAt = now;
    if (!this.flight) this.reschedule();
  }

  /**
   * A command: send now, skipping the debounce and the minimum gap, and abort
   * any in-flight request (its answer is about an older state anyway). The
   * command request carries the full snapshot, so pending triggers are covered.
   */
  command(text: string, trigger = "command"): Promise<void> {
    this.clearPendingTimer();
    this.pendingTrigger = null;
    this.firstPendingAt = null;
    if (this.flight) {
      this.flight.controller.abort();
      this.flight = null;
    }
    return this.start("command", trigger, text);
  }

  /** Ask now, ignoring the debounce. If a request is in flight, a follow-up is queued instead. */
  flush(trigger = "manual"): Promise<void> {
    if (this.flight) {
      this.notify(trigger);
      return this.flight.promise;
    }
    this.clearPendingTimer();
    this.pendingTrigger = null;
    this.firstPendingAt = null;
    return this.start("manual", trigger);
  }

  /** Drop pending work and abort the in-flight request. */
  cancel(): void {
    this.clearPendingTimer();
    this.pendingTrigger = null;
    this.firstPendingAt = null;
    if (this.flight) {
      this.flight.controller.abort();
      this.flight = null;
      this.onBusyChange(false);
    }
  }

  private reschedule(): void {
    this.clearPendingTimer();
    if (this.pendingTrigger === null || this.firstPendingAt === null) return;
    const now = this.now();
    // Clamp in case the system clock moved backward since the last request.
    if (this.lastEndAt > now) this.lastEndAt = now;
    const debounced = Math.min(this.lastTriggerAt + this.debounceMs, this.firstPendingAt + this.maxWaitMs);
    const due = Math.max(debounced, this.lastEndAt + this.minGapMs);
    this.timer = this.setTimer(() => this.fire(), Math.max(0, due - now));
  }

  private fire(): void {
    this.timer = null;
    if (this.flight || this.pendingTrigger === null) return;
    const trigger = this.pendingTrigger;
    this.pendingTrigger = null;
    this.firstPendingAt = null;
    void this.start("auto", trigger);
  }

  private start(kind: RequestKind, trigger: string, command?: string): Promise<void> {
    const controller = new AbortController();
    const wasBusy = this.flight !== null;
    const flight: Flight = { kind, controller, promise: Promise.resolve() };
    this.flight = flight;
    if (!wasBusy) this.onBusyChange(true);
    const run = async () => {
      try {
        await this.send({ trigger, kind, signal: controller.signal, ...(command !== undefined ? { command } : {}) });
      } catch {
        // send() reports its own errors; the scheduler only sequences requests.
      } finally {
        // A replaced (aborted) flight must not touch the newer one's state.
        if (this.flight === flight) {
          this.flight = null;
          this.lastEndAt = this.now();
          this.onBusyChange(false);
          this.reschedule();
        }
      }
    };
    flight.promise = run();
    return flight.promise;
  }

  private clearPendingTimer(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
