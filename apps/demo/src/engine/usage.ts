/**
 * Code-measured recent use per panel, one of the three inputs to layout
 * priority. The count itself (decay with USAGE_HALF_LIFE_MS, normalized so
 * the busiest panel is 1) is rawUsage and panelUsage in @attune/core. This
 * file says how much each of the demo's events counts, and binds the count
 * to the demo's panels (CATALOG).
 */
import { CORE_USAGE_WEIGHTS, eventWeight, panelUsage as countPanelUsage, rawUsage as countRawUsage } from "@attune/core";
import { CATALOG, type PanelId } from "../../shared/catalog.ts";
import type { SignalEvent, SignalType } from "../../shared/types.ts";

/** Weight per event type: the core weights (CORE_USAGE_WEIGHTS in @attune/core) and the demo's own types. */
export const USAGE_WEIGHTS: Record<SignalType, number> = {
  ...CORE_USAGE_WEIGHTS,
  links_dismiss: 0, // About the link cues, not the work in a panel.
  up_next_open: 3, // Opening a record from the Up next card is opening a record, the same as item_open.
  context_save: 0, // Logged by the engine, not something the user did; it carries no panel either.
  context_restore: 0, // No panel: "Back to" puts the saved layout back directly, so it adds no recent use to any one panel.
  setting_change: 0, // A settings switch, not work in a panel; it carries no panel either.
  task_done: 0, // Logged by the engine (focus aid 2), not something the user did; it carries no panel either.
  task_start: 3, // Starting the next task opens its first record, the same as item_open.
  prep_offer: 0, // Logged by the engine (focus aid 4), not something the user did; it carries no panel either.
  prep_start: 3, // Preparing for a meeting selects it in Calendar, the same as item_open.
};

const USAGE = { panelIds: CATALOG.panelIds, weight: (e: SignalEvent) => eventWeight(e, USAGE_WEIGHTS) };

/** Raw decayed totals per panel (not normalized). */
export function rawUsage(events: SignalEvent[], now: number): Record<PanelId, number> {
  return countRawUsage(events, now, USAGE);
}

/** Decayed per-panel usage, normalized to 0..1 by the busiest panel. All zeros when nothing happened. */
export function panelUsage(events: SignalEvent[], now: number): Record<PanelId, number> {
  return countPanelUsage(events, now, USAGE);
}
