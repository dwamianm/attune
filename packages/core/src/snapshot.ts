/**
 * The words-only picture of what the user has been doing, which the browser
 * sends and the model reads. Code does the counting and timing and writes
 * the result as sentences, because the model reads words better than numbers
 * and cannot count.
 */

/** A compact, words-only picture of what the user has been doing. */
export interface InteractionSnapshot {
  /** Oldest first, newest last. At most 15 entries. */
  recent_activity: string[];
  /** Plain sentence, for example "Invoices panel, viewing invoice INV-1042 (Harbor Coffee Co., overdue)". */
  current_focus: string | null;
  /** Titles of panels currently on screen. */
  visible_panels: string[];
  /** Code-derived facts in words, for example "Searched 3 times in the last minute". */
  behavior_observations: string[];
}

/**
 * The activity line for typing `command` into the command bar. The browser
 * logs it, and the model layer drops it from the activity when the same
 * command is sent on its own, so both sides must use the same words.
 */
export function commandActivityLine(command: string): string {
  return `Typed in the command bar: "${command}"`;
}
