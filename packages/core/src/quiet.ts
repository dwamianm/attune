/**
 * The quiet rule: "Fade panels that do not matter now" (the demo's focus aid
 * 1, apps/demo/docs/focus-aids.md).
 *
 * The model rates how useful each panel is for what the user is working on.
 * This file decides in plain code which panels on the canvas are quiet:
 * rated low for QUIET_ROUNDS rounds in a row, with a band so run-to-run
 * drift cannot make a panel flicker, and never a panel the user is working
 * in, pointing at, linked to, or was just offered. Quiet panels are faded by
 * the UI and shown compact by the policy where that keeps the calm relayout
 * rules; nothing is hidden or docked.
 *
 * The app passes its panel ids and says which of its events count as using
 * a panel (QuietContext.isTouch), because only the app knows its event
 * types. The demo's rule is isQuietTouch in apps/demo/src/engine/quiet.ts.
 *
 * Pure: no DOM, no store, no clock except `now`.
 */
import { UNCLEAR_GOAL, type Catalog } from "./catalog.ts";
import type { PanelSize } from "./grid.ts";

/**
 * Relevance (score / max) below this is low. Level 1 of the model's 4 is
 * "Background only: ... the user's current work does not need it" (0.33 of
 * the scale), so this is that level with a little spread. Tuned from 0.3:
 * live, panels on the canvas that the work did not need scored 0.27 to 0.38
 * (anything much lower is docked anyway), and 0.3 faded almost nothing.
 */
export const QUIET_BELOW = 0.4;
/** A quiet panel comes back above this, halfway to "Supporting" (0.67); the band absorbs the model's drift of a few hundredths per round. */
export const QUIET_EXIT_ABOVE = 0.5;
/** Low this many rounds in a row before a panel goes quiet, so one stray round never fades anything. */
export const QUIET_ROUNDS = 2;
/** A panel the user used this recently is still part of the work, whatever the model rates it. */
export const QUIET_RECENT_USE_MS = 60_000;
/** The size a quiet panel takes: the summary tile (header plus a one-line summary), so nothing is hidden. */
export const QUIET_SIZE: PanelSize = "compact";

/** One panel's relevance in a round: a probability-weighted level out of `max`. */
export interface RelevanceScore {
  score: number;
  max: number;
}

/** What the rule remembers between rounds. */
export interface QuietTrack<P extends string = string> {
  /** Rounds in a row each panel was rated below QUIET_BELOW. Absent: zero. */
  low: Partial<Record<P, number>>;
  /** Panels quiet by their relevance after the last round, before the exemptions (quietPanels checks those at every plan). */
  quiet: P[];
  /** The last round counted (the response version), so a round counts once. */
  version: number;
}

export function emptyQuietTrack<P extends string = string>(): QuietTrack<P> {
  return { low: {}, quiet: [], version: 0 };
}

/** Normalized relevance, 0..1, or null when the round has no usable answer for the panel. */
function relShare<P extends string>(relevance: Partial<Record<P, RelevanceScore>> | undefined, id: P): number | null {
  const r = relevance?.[id];
  if (!r || !(r.max > 0) || !Number.isFinite(r.score)) return null;
  return Math.min(1, Math.max(0, r.score / r.max));
}

/**
 * Count one applied model round. A panel rated below QUIET_BELOW adds one to
 * its low streak, anything else resets it. A panel goes quiet once its
 * streak reaches QUIET_ROUNDS, and a quiet one stays quiet until it is rated
 * above QUIET_EXIT_ABOVE (the band). A panel with no usable answer is
 * neither low nor quiet. A round that is not newer than the last one counted
 * changes nothing. `panelIds` (Catalog.panelIds) sets which panels count and
 * the order of `quiet`.
 */
export function countQuietRound<P extends string>(
  track: QuietTrack<P>,
  relevance: Partial<Record<P, RelevanceScore>> | undefined,
  version: number,
  panelIds: readonly P[],
): QuietTrack<P> {
  if (version <= track.version) return track;
  const low: QuietTrack<P>["low"] = {};
  const quiet: P[] = [];
  for (const id of panelIds) {
    const r = relShare(relevance, id);
    if (r === null) continue;
    const n = r < QUIET_BELOW ? (track.low[id] ?? 0) + 1 : 0;
    if (n > 0) low[id] = n;
    const was = track.quiet.includes(id);
    if (was ? r <= QUIET_EXIT_ABOVE : n >= QUIET_ROUNDS) quiet.push(id);
  }
  return { low, quiet, version };
}

/** The user touched `panel`: it stops being quiet, and needs QUIET_ROUNDS new low rounds to go quiet again. */
export function touchQuiet<P extends string>(track: QuietTrack<P>, panel: P): QuietTrack<P> {
  if (!track.quiet.includes(panel) && !track.low[panel]) return track;
  const low = { ...track.low };
  delete low[panel];
  return { ...track, low, quiet: track.quiet.filter((id) => id !== panel) };
}

/** An event as the quiet rule sees it: the panel it happened in, if any, and when (epoch ms). */
export interface QuietEvent<P extends string = string> {
  panel?: P;
  t: number;
}

/** What exempts a panel from being quiet right now. */
export interface QuietContext<P extends string = string, E extends QuietEvent<P> = QuietEvent<P>> {
  /** Panels on the canvas. Only these can be quiet. */
  onCanvas: P[];
  /** The live anchor's panel: the one the user is working in. */
  anchor: P | null;
  /**
   * Panels in the link cues: the source and the tagged linked panels. A
   * panel that only holds a record joined to the anchor, with no tag, can be
   * quiet: nearly every panel shares a client with some record.
   */
  linked: P[];
  pinned: P[];
  /** Panels the user made bigger. */
  bigger: P[];
  focused: P | null;
  /** The panel under the pointer. */
  pointer: P | null;
  /** The panel of the record the "Up next" card offers. */
  upNext: P | null;
  /** The panel the user usually goes to next (their habits), so it is not faded just before they go there. Absent: none. */
  usual?: P | null;
  events: readonly E[];
  /** True when the event means the user used its panel. Pointer rests and keyboard focus should not count. */
  isTouch: (event: E) => boolean;
  now: number;
  /**
   * Panels quiet in the plan on screen. The pointer and focus keep a panel
   * from going quiet, but they do not end it: hover and keyboard focus only
   * light a quiet panel up in the UI, so a re-plan while the pointer passes
   * over it never changes the layout.
   */
  current?: P[];
}

/**
 * The quiet panels now: quiet by relevance (`track.quiet`), on the canvas,
 * and not the anchor, linked, pinned, made bigger, the Up next panel, the
 * usual next panel, or used in the last QUIET_RECENT_USE_MS, and, unless
 * already quiet on screen, not focused or under the pointer. Canvas order.
 */
export function quietPanels<P extends string, E extends QuietEvent<P>>(track: QuietTrack<P>, ctx: QuietContext<P, E>): P[] {
  const quiet = new Set(track.quiet);
  const current = new Set(ctx.current ?? []);
  const exempt = new Set<P>([...ctx.linked, ...ctx.pinned, ...ctx.bigger]);
  for (const p of [ctx.anchor, ctx.upNext, ctx.usual]) if (p) exempt.add(p);
  for (const p of [ctx.focused, ctx.pointer]) if (p && !current.has(p)) exempt.add(p);
  for (const e of ctx.events) {
    if (e.panel && ctx.now - e.t <= QUIET_RECENT_USE_MS && ctx.isTouch(e)) exempt.add(e.panel);
  }
  return ctx.onCanvas.filter((id) => quiet.has(id) && !exempt.has(id));
}

/**
 * Whether the canvas shows a quiet placement faded now. The plan marks it
 * quiet as of its round; anything since that exempts it shows it at full
 * strength at once, before the next round catches up: it became the focused
 * panel, the Up next card now offers a record in it, it joined the link
 * cues, or it was pinned or made bigger. (Hover and keyboard focus are the
 * UI's own, on top of this.)
 */
export function shownQuiet<P extends string>(
  p: { id: P; quiet?: boolean; pinned?: boolean; bigger?: boolean },
  ctx: { focused: P | null; upNext: P | null; linked: ReadonlySet<P> },
): boolean {
  return Boolean(p.quiet) && !p.pinned && !p.bigger && ctx.focused !== p.id && ctx.upNext !== p.id && !ctx.linked.has(p.id);
}

/** The "Why here?" reason of a quiet panel: "Not needed for Collecting payments right now". */
export function quietReason<G extends string>(catalog: Pick<Catalog<string, G>, "goals">, goal: G | null | undefined): string {
  const label = goal && goal !== UNCLEAR_GOAL ? catalog.goals[goal]?.label : undefined;
  return `Not needed for ${label ?? "what you are doing"} right now`;
}
