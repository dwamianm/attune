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

/** Half-life of an interaction's weight. */
export const USAGE_HALF_LIFE_MS = 90_000;

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
