/**
 * Timing for one relayout round (apps/demo/docs/anchored-relayout.md,
 * "Choreography").
 *
 * A round plays in stages so the eye can follow it: the anchor grows in
 * place, panels leaving fly into their dock icon, panels that move glide to
 * their new cell, then new panels arrive one at a time from the anchor's
 * side. Everything here is pure (no DOM, no React), so the canvas, the dock,
 * and the link lines read one schedule and cannot drift apart.
 *
 * Generic over the panel id. The two sentences that name panels (noteText,
 * linkAnnouncement) take a function from panel id to title, so the app's
 * catalog supplies the words.
 */
import type { ChangeSummary, GridCell, GridColumns } from "./grid.ts";

export interface Stage {
  delayMs: number;
  durationMs: number;
}

/** The anchor grows in place first, so the user sees their panel settle before anything else moves. */
export const STAGE_GROW: Stage = { delayMs: 0, durationMs: 250 };
/** Leaving panels go next, which frees the cells the movers and newcomers need. */
export const STAGE_EXIT: Stage = { delayMs: 150, durationMs: 250 };
/** Panels that change cell glide once the exits are under way. */
export const STAGE_MOVE: Stage = { delayMs: 250, durationMs: 350 };
/** New panels arrive last, into cells that are already free. */
export const STAGE_ENTER: Stage = { delayMs: 450, durationMs: 300 };
/** One newcomer at a time, and a round with three of them still ends near 1 s. */
export const ENTER_STAGGER_MS = 70;
/** Reads as coming from the anchor without crossing another card. */
export const ENTER_OFFSET_PX = 24;
/** Newcomers start a little small, so they read as arriving rather than blinking on. */
export const ENTER_SCALE = 0.96;
/** Quick start, soft landing, one curve for every stage so the round reads as one motion. */
export const STAGE_EASE = [0.2, 0, 0, 1] as const;
/** Long enough to follow the line with the eye as it draws in. */
export const LINK_LINE_DRAW_MS = 350;
/** Full strength after drawing in, long enough to see where each line goes; then it rests (or fades, in "fade" mode). */
export const LINK_LINE_SHOW_MS = 2000;
/** The step from full strength to resting (or gone, in "fade" mode), and back on hover. */
export const LINK_LINE_FADE_MS = 300;
/** A line that stays rests this faint: easy to find again, quiet enough to work beside for minutes. */
export const LINK_LINE_REST_OPACITY = 0.45;
/**
 * After a plan change the lines are re-measured every frame for this long,
 * so they glide with the cards: a staged round ends near 1 s, and the plain
 * spring settles in well under that.
 */
export const LINK_FOLLOW_MS = 1200;
/** One beat on the tag of a linked panel no clean line reaches (the line would cross another card, or be off screen). */
export const LINK_TAG_PULSE_MS = 700;
/** The same as the demo change feed's FRESH_MS, so the anchor note and the feed line fade together. */
export const ANCHOR_NOTE_MS = 6000;
/** Reduced motion: a change still shows, as a short fade with no movement. */
export const REDUCED_FADE_MS = 150;
/** The dock icon's ring after a card lands in it: one beat, not a blink. */
export const DOCK_PULSE_MS = 450;
/** The ring on a card a pin or "Make bigger" sent to the front, from when it lands: long enough to find it, short enough not to read as a state. */
export const FRONT_RING_MS = 1200;
/** The quiet rule (quiet.ts): a quiet panel's strength. About half: still readable, clearly behind the panels that matter. */
export const QUIET_OPACITY = 0.55;
/** A quiet panel's color, slightly desaturated (a CSS saturate() amount), so the eye goes to the colored panels first. */
export const QUIET_SATURATE = 0.6;
/** Going quiet takes this long: slow enough to read as calm, not as a flicker. */
export const QUIET_FADE_MS = 400;
/** Hover or keyboard focus brings a quiet panel to full strength this fast, so it reads as at once. */
export const QUIET_LIGHT_MS = 100;
/**
 * One column is about three row tracks wide (a 330 px column over 104 px
 * rows plus gaps at 4 columns). Used only to order newcomers by distance
 * from the anchor and to aim their entry, so a rough ratio is enough.
 */
export const COLUMN_TRACK_RATIO = 3;

export type CardRole = "anchor" | "moved" | "entering" | "still";

/**
 * The part of a layout plan the choreography reads. The demo's plan type
 * fits it as is.
 */
export interface StagedPlan<P extends string = string> {
  /** Increases by 1 on every change that moves something. Absent: 0. */
  round?: number;
  /** Cell changes versus the previous plan. Absent: nothing to stage. */
  changeSummary?: ChangeSummary<P>;
  grid?: { columns: GridColumns; cells: Partial<Record<P, GridCell>> };
  /** The panel the user just worked in, and who or what the work was about. */
  anchor?: { panel: P; client?: string; label?: string } | null;
  /** Panels on the canvas in display order. `relation` is set on a panel linked to the anchor. */
  placements: readonly { id: P; bigger?: boolean; relation?: unknown }[];
}

export interface CardCue {
  role: CardRole;
  stage: Stage;
  /**
   * Entering cards only: unit vector from the anchor toward this card. The
   * card starts ENTER_OFFSET_PX back toward the anchor and slides out.
   * Absent when there is no anchor on the canvas (a plain fade and scale).
   */
  from?: { x: number; y: number };
}

export interface RoundCues<P extends string = string> {
  /** The plan's round number (absent on the plan means 0). */
  round: number;
  /** True when the plan carries a change summary, so the stages apply. */
  staged: boolean;
  cues: Partial<Record<P, CardCue>>;
  /** Newcomers in entry order, nearest the anchor first. */
  entering: P[];
  docked: P[];
  /** Milliseconds after the commit when every card has landed. */
  settleMs: number;
}

const STILL: CardCue = { role: "still", stage: STAGE_MOVE };

function center(c: GridCell): { x: number; y: number } {
  return { x: (c.col + c.w / 2) * COLUMN_TRACK_RATIO, y: c.row + c.h / 2 };
}

function end(stage: Stage): number {
  return stage.delayMs + stage.durationMs;
}

/**
 * Who plays which stage in this plan's round. Without a change summary
 * (plans from before the anchored relayout) or with an empty one (a resize)
 * nothing is staged and the canvas keeps its plain spring.
 */
export function roundCues<P extends string>(plan: StagedPlan<P>): RoundCues<P> {
  const round = plan.round ?? 0;
  const summary = plan.changeSummary;
  // An empty summary is a resize reflow (or only a new anchor): no stages to play.
  const empty = !summary || [summary.added, summary.docked, summary.moved, summary.grew, summary.shrank].every((l) => l.length === 0);
  if (!summary || empty) return unstaged<P>(round);

  const cells: Partial<Record<P, GridCell>> = plan.grid?.cells ?? {};
  const anchorId = plan.anchor && plan.placements.some((p) => p.id === plan.anchor?.panel) ? plan.anchor.panel : null;
  const anchorCell = anchorId ? cells[anchorId] : undefined;
  const grew = new Set(summary.grew);
  const changed = new Set([...summary.moved, ...summary.shrank, ...summary.grew]);
  const added = new Set(summary.added);

  const cues: Partial<Record<P, CardCue>> = {};
  let settleMs = summary.docked.length > 0 ? end(STAGE_EXIT) : 0;

  if (anchorId) {
    // A work anchor only grows in place. A command's hero may also travel to
    // the front or come in from the dock; either way it goes first.
    const cue: CardCue = added.has(anchorId)
      ? { role: "entering", stage: { delayMs: 0, durationMs: STAGE_ENTER.durationMs } }
      : { role: "anchor", stage: grew.has(anchorId) || !changed.has(anchorId) ? STAGE_GROW : { delayMs: 0, durationMs: STAGE_MOVE.durationMs } };
    cues[anchorId] = cue;
    if (added.has(anchorId) || changed.has(anchorId)) settleMs = Math.max(settleMs, end(cue.stage));
  }

  // On one column the canvas is a list, and an anchor that grows pushes the
  // cards after it down. They move with the growth, not after it, so none
  // sits hidden under the growing anchor. (On 2 and 4 columns the packer
  // grows an anchor only into free cells, so it never covers a card, except
  // a panel the user made bigger: it takes its room, and every card that
  // moves in that round makes room for it, so they all move with the growth.)
  const oneColumn = plan.grid?.columns === 1;
  const madeBigger = anchorId !== null && plan.placements.some((p) => p.id === anchorId && p.bigger);
  const pushes = anchorId !== null && grew.has(anchorId) && anchorCell !== undefined && (oneColumn || madeBigger);
  const pushed: Stage = { delayMs: STAGE_GROW.delayMs, durationMs: STAGE_MOVE.durationMs };
  for (const id of changed) {
    if (id === anchorId) continue;
    const below = pushes && (!oneColumn || (cells[id]?.row ?? -1) > anchorCell.row);
    const stage = below ? pushed : STAGE_MOVE;
    cues[id] = { role: "moved", stage };
    settleMs = Math.max(settleMs, end(stage));
  }

  // Nearest the anchor first, so the eye travels outward from where it already is.
  const a = anchorCell ? center(anchorCell) : null;
  const distance = (id: P): number => {
    const c = cells[id];
    if (!a || !c) return 0;
    const p = center(c);
    return Math.hypot(p.x - a.x, p.y - a.y);
  };
  const entering = summary.added.filter((id) => id !== anchorId && plan.placements.some((p) => p.id === id));
  entering.sort((x, y) => distance(x) - distance(y));
  entering.forEach((id, i) => {
    const stage = { delayMs: STAGE_ENTER.delayMs + i * ENTER_STAGGER_MS, durationMs: STAGE_ENTER.durationMs };
    const c = cells[id];
    let from: CardCue["from"];
    if (a && c) {
      const p = center(c);
      const dx = p.x - a.x;
      const dy = p.y - a.y;
      const len = Math.hypot(dx, dy);
      if (len > 0) from = { x: dx / len, y: dy / len };
    }
    cues[id] = from ? { role: "entering", stage, from } : { role: "entering", stage };
    settleMs = Math.max(settleMs, end(stage));
  });

  return { round, staged: true, cues, entering, docked: summary.docked, settleMs };
}

/** A round with nothing to stage. */
export function unstaged<P extends string = string>(round: number): RoundCues<P> {
  return { round, staged: false, cues: {}, entering: [], docked: [], settleMs: 0 };
}

/** The cue for one card; cards the round does not touch are "still". */
export function cueFor<P extends string>(cues: RoundCues<P>, id: P): CardCue | undefined {
  if (!cues.staged) return undefined;
  return cues.cues[id] ?? STILL;
}

/** motion tween for a stage. */
export function stageTransition(stage: Stage): { type: "tween"; delay: number; duration: number; ease: [number, number, number, number] } {
  return { type: "tween", delay: stage.delayMs / 1000, duration: stage.durationMs / 1000, ease: [...STAGE_EASE] };
}

/** "A", "A and B", "A, B, and C". */
export function joinTitles(titles: string[]): string {
  if (titles.length <= 1) return titles[0] ?? "";
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles.slice(0, -1).join(", ")}, and ${titles.at(-1)}`;
}

/** The anchor note's sentence: "Added Inbox and Clients for Harbor Coffee Co.". `titleOf` gives a panel's title. */
export function noteText<P extends string>(panels: P[], subject: string | undefined, titleOf: (id: P) => string): string {
  return `Added ${joinTitles(panels.map((id) => titleOf(id)))}${subject ? ` for ${subject}` : ""}`;
}

/**
 * What a screen reader hears about the link after a round, next to the
 * change feed's decisions: the note's sentence when the round added linked
 * panels, then every linked panel. Empty when the plan links nothing.
 */
export function linkAnnouncement<P extends string>(plan: StagedPlan<P>, titleOf: (id: P) => string): string {
  const anchor = plan.anchor;
  if (!anchor) return "";
  const linked = plan.placements.filter((p) => p.relation && p.id !== anchor.panel).map((p) => p.id);
  if (linked.length === 0) return "";
  const added = new Set(plan.changeSummary?.added ?? []);
  const fresh = linked.filter((id) => added.has(id));
  const parts = fresh.length > 0 ? [noteText(fresh, anchor.client ?? anchor.label, titleOf)] : [];
  parts.push(`Linked panels: ${joinTitles(linked.map((id) => titleOf(id)))}`);
  // A client name can end in a period ("Harbor Coffee Co."); do not read two.
  return parts.map((t) => t.replace(/\.$/, "")).join(". ");
}
