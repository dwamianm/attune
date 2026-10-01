/**
 * The core signal vocabulary: what the user does that every Attune app logs
 * the same way. An app adds its own event types next to these (the demo adds
 * its Up next, Back to, focus aid, and link events) and says, in a
 * SignalProfile, how the library should count them.
 */

export const CORE_SIGNAL_TYPES = [
  /** The user clicked or typed inside a panel. */
  "panel_focus",
  /** A panel brought onto the canvas from the dock. */
  "panel_open",
  /** A panel sent to the dock by the user. */
  "panel_dismiss",
  "panel_pin",
  "panel_unpin",
  /** The pointer rested on a panel (detail.durationMs). */
  "panel_dwell",
  /** Made a panel bigger with its "Make bigger" button. Never asks the model by itself. */
  "panel_maximize",
  /** Made a panel the user had made bigger smaller again. Never asks the model by itself. */
  "panel_restore",
  /** Opened one record (detail.itemKind, detail.itemId). */
  "item_open",
  /** Typed a search inside a panel (detail.query). */
  "search",
  /** Changed a filter (detail.filter or detail.label). */
  "filter",
  /** Performed an action (detail.actionId). */
  "action",
  /** Typed into the command bar (detail.query). */
  "command",
  /** Used a keyboard shortcut (detail.key). */
  "shortcut",
  /** Scrolled a panel's list. */
  "scroll",
  "suggestion_accept",
  "suggestion_dismiss",
  /** Undid the last layout change. */
  "undo",
] as const;
export type CoreSignalType = (typeof CORE_SIGNAL_TYPES)[number];

/** How the user did it. */
export type SignalVia = "pointer" | "keyboard" | "command" | "suggestion";

/** The detail fields the library reads. An app's events may carry more. */
export interface SignalDetail {
  label?: string;
  query?: string;
  filter?: Record<string, string>;
  /** The kind of record (EventWords.itemWords names it), for example "invoice". */
  itemKind?: string;
  itemId?: string;
  /** The customer or company the record belongs to, when there is one. */
  client?: string;
  actionId?: string;
  durationMs?: number;
  key?: string;
  via?: SignalVia;
}

/** A logged event as the library reads it. `T` is the app's event type union, which includes the core types. */
export interface SignalEventLike<T extends string = string, P extends string = string> {
  type: T;
  panel?: P;
  /** Milliseconds since epoch. */
  t: number;
  /** The event's sentence, when the app has already written it. */
  text?: string;
  detail?: SignalDetail;
}

/** How the library counts an app's event types. The core sets below are the defaults; an app adds its own types to them. */
export interface SignalProfile<T extends string = string> {
  /** Types that open one record. */
  recordOpen: ReadonlySet<T>;
  /** Types that mean "the user is working in this panel", for the focus order. */
  work: ReadonlySet<T>;
  /** Types done with the pointer, for the input style. */
  pointer: ReadonlySet<T>;
  /** Types about the app's own cues or bookkeeping, not the work: logged, but never in the snapshot. */
  cueOnly: ReadonlySet<T>;
}

export const CORE_RECORD_OPEN_TYPES: readonly CoreSignalType[] = ["item_open"];
export const CORE_WORK_TYPES: readonly CoreSignalType[] = ["panel_focus", "item_open", "search", "filter", "action"];
export const CORE_POINTER_TYPES: readonly CoreSignalType[] = [
  "panel_focus",
  "panel_open",
  "panel_dismiss",
  "panel_pin",
  "panel_unpin",
  "panel_maximize",
  "panel_restore",
  "panel_dwell",
  "item_open",
  "filter",
  "action",
  "scroll",
  "suggestion_accept",
  "suggestion_dismiss",
];

/** The core profile plus an app's own types in each set. */
export function signalProfile<T extends string>(extra: { recordOpen?: readonly T[]; work?: readonly T[]; pointer?: readonly T[]; cueOnly?: readonly T[] } = {}): SignalProfile<CoreSignalType | T> {
  return {
    recordOpen: new Set<CoreSignalType | T>([...CORE_RECORD_OPEN_TYPES, ...(extra.recordOpen ?? [])]),
    work: new Set<CoreSignalType | T>([...CORE_WORK_TYPES, ...(extra.work ?? [])]),
    pointer: new Set<CoreSignalType | T>([...CORE_POINTER_TYPES, ...(extra.pointer ?? [])]),
    cueOnly: new Set<CoreSignalType | T>(extra.cueOnly ?? []),
  };
}
