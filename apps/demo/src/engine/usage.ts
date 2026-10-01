/**
 * Code-measured recent use per panel, one of the three inputs to layout
 * priority. The count itself (decay with USAGE_HALF_LIFE_MS, normalized so
 * the busiest panel is 1) is rawUsage and panelUsage in @attune/core. This
 * file says how much each of the demo's events counts, and binds the count
 * to the demo's panels (CATALOG).
 */
import { panelUsage as countPanelUsage, rawUsage as countRawUsage } from "@attune/core";
import { CATALOG, type PanelId } from "../../shared/catalog.ts";
import type { SignalEvent, SignalType } from "../../shared/types.ts";

/**
 * Weight of making a panel bigger or smaller by hand: a strong focus, more
 * than a click into the panel (1) and as much as opening it from the dock,
 * because the user chose that panel and how much room it gets.
 */
export const RESIZE_USAGE_WEIGHT = 1.5;

/** Weight per event type. Doing something counts more than looking. */
export const USAGE_WEIGHTS: Record<SignalType, number> = {
  item_open: 3,
  action: 3,
  search: 2.5,
  filter: 2.5,
  panel_open: 1.5,
  panel_focus: 1,
  shortcut: 0.5,
  scroll: 0.5,
  panel_pin: 0.5,
  suggestion_accept: 1,
  panel_dwell: 0, // Scaled by duration below.
  panel_dismiss: 0, // Dismissal is handled by the policy, not as negative use.
  panel_unpin: 0,
  command: 0,
  suggestion_dismiss: 0,
  undo: 0,
  links_dismiss: 0, // About the link cues, not the work in a panel.
  panel_maximize: RESIZE_USAGE_WEIGHT,
  panel_restore: RESIZE_USAGE_WEIGHT,
  up_next_open: 3, // Opening a record from the Up next card is opening a record, the same as item_open.
  context_save: 0, // Logged by the engine, not something the user did; it carries no panel either.
  context_restore: 0, // No panel: "Back to" puts the saved layout back directly, so it adds no recent use to any one panel.
  setting_change: 0, // A settings switch, not work in a panel; it carries no panel either.
  task_done: 0, // Logged by the engine (focus aid 2), not something the user did; it carries no panel either.
  task_start: 3, // Starting the next task opens its first record, the same as item_open.
  prep_offer: 0, // Logged by the engine (focus aid 4), not something the user did; it carries no panel either.
  prep_start: 3, // Preparing for a meeting selects it in Calendar, the same as item_open.
};

/** A pointer rest adds this much per second, capped at DWELL_MAX_WEIGHT. */
export const DWELL_WEIGHT_PER_SECOND = 0.15;
export const DWELL_MAX_WEIGHT = 1;

function eventWeight(e: SignalEvent): number {
  if (e.type === "panel_dwell") return Math.min(DWELL_MAX_WEIGHT, ((e.detail?.durationMs ?? 0) / 1000) * DWELL_WEIGHT_PER_SECOND);
  return USAGE_WEIGHTS[e.type] ?? 0;
}

const USAGE = { panelIds: CATALOG.panelIds, weight: eventWeight };

/** Raw decayed totals per panel (not normalized). */
export function rawUsage(events: SignalEvent[], now: number): Record<PanelId, number> {
  return countRawUsage(events, now, USAGE);
}

/** Decayed per-panel usage, normalized to 0..1 by the busiest panel. All zeros when nothing happened. */
export function panelUsage(events: SignalEvent[], now: number): Record<PanelId, number> {
  return countPanelUsage(events, now, USAGE);
}
