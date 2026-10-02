/**
 * Which of the demo's events ask Jev for a new read. The timing (debounce,
 * max wait, one request in flight, commands first) is AdaptScheduler in
 * @attuneui/core; this file only decides what counts as a trigger.
 */
import type { SignalType } from "../../shared/types.ts";

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
