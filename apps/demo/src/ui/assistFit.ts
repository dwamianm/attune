/**
 * The row under the command bar (AssistRow.tsx) holds the meeting prep card,
 * the Done card or Up next, and the suggested next steps on one line of a
 * fixed height. This file is the demo's part of it: which cards there are,
 * and their priority order. How they fit the line (in full, as compact
 * pills, or in the "+N" list) is fitRow in @attuneui/core.
 *
 * In the demo the first card is the most time-sensitive one: the prep card
 * shows the count of things to handle as its shorter form, and the keys work
 * in every state.
 */

/** What a slot on the row holds. "label" is "Next step" before the suggestions; "hint" is the empty state in its place. */
export type AssistKind = "prep" | "taskDone" | "upNext" | "upNextDone" | "suggestion" | "label" | "hint";

export interface AssistSlot {
  id: string;
  kind: AssistKind;
}

export interface AssistSlotInput {
  prep: boolean;
  /** Focus aid 2's Done card. It takes the Up next slot. */
  taskDone: boolean;
  upNext: boolean;
  /** Up next's completion line ("All overdue invoices have a reminder."). */
  upNextDone: boolean;
  /** The suggestions in plan order. */
  suggestions: { id: string; primary: boolean }[];
  /** An empty state to show when there are no suggestions (the examples, or "Suggestions show up here"). */
  hint: boolean;
}

/**
 * The slots in priority order, highest first: a meeting starting soon, then
 * the Done card (or Up next, or its completion line: one card shares that
 * slot), then the primary suggestion, then the subtle ones in plan order,
 * then the "Next step" label (or the empty state), which is only decoration.
 */
export function assistSlots(input: AssistSlotInput): AssistSlot[] {
  const out: AssistSlot[] = [];
  if (input.prep) out.push({ id: "prep", kind: "prep" });
  if (input.taskDone) out.push({ id: "task-done", kind: "taskDone" });
  else if (input.upNext) out.push({ id: "up-next", kind: "upNext" });
  else if (input.upNextDone) out.push({ id: "up-next-done", kind: "upNextDone" });
  const primary = input.suggestions.filter((s) => s.primary);
  const subtle = input.suggestions.filter((s) => !s.primary);
  for (const s of [...primary, ...subtle]) out.push({ id: s.id, kind: "suggestion" });
  if (input.suggestions.length > 0) out.push({ id: "label", kind: "label" });
  else if (input.hint) out.push({ id: "hint", kind: "hint" });
  return out;
}
