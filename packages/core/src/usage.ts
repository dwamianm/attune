/**
 * Code-measured recent use per panel, one of the inputs to layout priority.
 *
 * The model judges relevance from words; this is the plain behavioral count
 * next to it, so a panel the user keeps working in stays prominent even when
 * the model's read of the goal wobbles. Each event adds a weight that halves
 * every USAGE_HALF_LIFE_MS, and the result is normalized so the busiest
 * panel is 1.
 *
 * The app says how much each of its events counts (UsageOptions.weight),
 * because only the app knows its event types. The demo's weights are
 * USAGE_WEIGHTS in apps/demo/src/engine/usage.ts.
 */

import type { CoreSignalType } from "./signals.ts";

/** Half-life of an interaction's weight. */
export const USAGE_HALF_LIFE_MS = 90_000;

/**
 * Weight of making a panel bigger or smaller by hand: a strong focus, more
 * than a click into the panel (1) and as much as opening it from the dock,
 * because the user chose that panel and how much room it gets.
 */
export const RESIZE_USAGE_WEIGHT = 1.5;

/** A pointer rest adds this much per second, capped at DWELL_MAX_WEIGHT. */
export const DWELL_WEIGHT_PER_SECOND = 0.15;
export const DWELL_MAX_WEIGHT = 1;

/**
 * Weight per core event type. Doing something counts more than looking. An
 * app adds its own types to a copy of these (the demo: USAGE_WEIGHTS in
 * apps/demo/src/engine/usage.ts).
 */
export const CORE_USAGE_WEIGHTS: Readonly<Record<CoreSignalType, number>> = {
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
  panel_dwell: 0, // Scaled by duration in eventWeight.
  panel_dismiss: 0, // Dismissal is handled by the policy, not as negative use.
  panel_unpin: 0,
  command: 0,
  suggestion_dismiss: 0,
  undo: 0,
  panel_maximize: RESIZE_USAGE_WEIGHT,
  panel_restore: RESIZE_USAGE_WEIGHT,
};

/** One event's weight: a pointer rest by its duration, anything else from `weights` (a type not listed counts 0). */
export function eventWeight(e: { type: string; detail?: { durationMs?: number } }, weights: Readonly<Record<string, number>> = CORE_USAGE_WEIGHTS): number {
  if (e.type === "panel_dwell") return Math.min(DWELL_MAX_WEIGHT, ((e.detail?.durationMs ?? 0) / 1000) * DWELL_WEIGHT_PER_SECOND);
  return weights[e.type] ?? 0;
}

/** An event as the usage count sees it: the panel it happened in, if any, and when (epoch ms). */
export interface UsageEvent<P extends string = string> {
  panel?: P;
  t: number;
}

export interface UsageOptions<P extends string, E extends UsageEvent<P>> {
  /** Every panel id (Catalog.panelIds). Each gets a total, 0 when nothing happened in it. */
  panelIds: readonly P[];
  /** How much one event counts. 0 or less: it does not count. */
  weight: (event: E) => number;
  /** Default: USAGE_HALF_LIFE_MS. */
  halfLifeMs?: number;
}

/** Raw decayed totals per panel (not normalized). Events in no panel, or in a panel not in `panelIds`, are skipped. */
export function rawUsage<P extends string, E extends UsageEvent<P>>(events: readonly E[], now: number, opts: UsageOptions<P, E>): Record<P, number> {
  const totals = Object.fromEntries(opts.panelIds.map((id) => [id, 0])) as Record<P, number>;
  const halfLife = opts.halfLifeMs ?? USAGE_HALF_LIFE_MS;
  for (const e of events) {
    if (!e.panel || !(e.panel in totals)) continue;
    const w = opts.weight(e);
    if (w <= 0) continue;
    const age = Math.max(0, now - e.t);
    totals[e.panel] += w * Math.pow(0.5, age / halfLife);
  }
  return totals;
}

/** Decayed per-panel usage, normalized to 0..1 by the busiest panel. All zeros when nothing happened. */
export function panelUsage<P extends string, E extends UsageEvent<P>>(events: readonly E[], now: number, opts: UsageOptions<P, E>): Record<P, number> {
  const totals = rawUsage(events, now, opts);
  const max = Math.max(...(Object.values(totals) as number[]));
  if (!(max > 0)) return totals;
  for (const id of opts.panelIds) totals[id] = totals[id] / max;
  return totals;
}
