/**
 * The general rules of the layout policy. The model only judges; these
 * rules decide, in plain code, with thresholds and hysteresis so drift in
 * the model's answers does not move the screen:
 *   - scorePanels blends the model's relevance, measured recent use, and
 *     the goal-to-panel affinity into one priority per panel,
 *   - pickMode and pickDensity change the layout mode and density only on a
 *     confident or repeated judgment,
 *   - helpLevel turns "is the user stuck" into a hint or a help panel,
 *   - protectedPanels, sizeHeldPanels, userResizedPanels, and openHeldPanels
 *     find the panels the user is using right now, which must not move away
 *     or shrink.
 *
 * The rest of the demo's policy (placements, docking, suggestions, and the
 * record-specific reasons) is computePlan in apps/demo/src/engine/policy.ts,
 * which reads these. The numbers were tuned there against live Jev answers.
 */
import type { Catalog } from "./catalog.ts";
import type { PanelSize } from "./grid.ts";
import type { ChoiceJudgment, ScoreJudgment } from "./judgments.ts";
import { LAYOUT_MODE_DEFS, LAYOUT_MODES, type LayoutMode } from "./layoutModes.ts";
import { p2, timesWord } from "./words.ts";

/** How many panels the canvas holds, from "guided" (fewer, for a new user) to "dense" (more, for an expert). */
export type Density = "guided" | "standard" | "dense";

/** What the help rule asks for: nothing, a hint, or the help panel. */
export type HelpLevel = "none" | "hint" | "panel";

/** One change the policy made (or held back), in words, for the change feed. */
export interface Decision<P extends string = string> {
  kind: "mode" | "promote" | "demote" | "add" | "dock" | "suggest" | "help" | "hold" | "command" | "density";
  panel?: P;
  /** Plain sentence for the change feed, for example "Moved Invoices to the front". */
  text: string;
  /** The judgment behind it, for example "goal collect_payments p=0.91". */
  evidence?: string;
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/** Added to a pinned panel's priority so it always sorts first. */
export const PIN_BOOST = 1;
/** A panel the user opened from the dock stays on the canvas at least this long. */
export const OPEN_HOLD_MS = 60_000;
/** A panel with any event this recent cannot be docked or shrunk. */
export const PROTECT_RECENT_MS = 4_000;
/**
 * The focused panel keeps its size only while its newest event is this
 * recent. It keeps its seat on the canvas for as long as it stays focused,
 * but a panel clicked ten minutes ago must not stay a hero in every later
 * layout (three heroes in Compare). 15 s covers reading a record after a click.
 */
export const FOCUSED_SIZE_HOLD_MS = 15_000;
/** Switch layout mode at once when the model's layout confidence reaches this. */
export const MODE_SWITCH_CONFIDENCE = 0.8;
/** Or switch at this confidence when recent rounds agree (see MODE_STREAK_LENGTH). */
export const MODE_STREAK_CONFIDENCE = 0.55;
/** How many of the newest recentModes must equal the new mode for the streak rule. */
export const MODE_STREAK_LENGTH = 2;
/** Most panels on the canvas per density. */
export const DENSITY_CAPS: Record<Density, number> = { guided: 5, standard: 7, dense: 9 };
/** Expertise (score / max) below this means guided density. */
export const GUIDED_BELOW = 0.33;
/** Expertise (score / max) above this means dense density. */
export const DENSE_ABOVE = 0.66;
/** Change density only when the model's expertise confidence reaches this. */
export const DENSITY_CONFIDENCE = 0.6;
/** And only after this many events (pointer rests excluded), so one click cannot shrink the canvas. */
export const DENSITY_MIN_EVENTS = 5;
/**
 * And only when this many rounds in a row judged the same density. One read of
 * a slow, careful stretch flipped the canvas to guided mid-task, and a few
 * commands later to dense.
 */
export const DENSITY_STREAK_LENGTH = 2;
/** Struggling (Noul) at or above this opens the help panel. */
export const HELP_PANEL_AT = 0.7;
/** Struggling (Noul) at or above this shows a help hint. */
export const HELP_HINT_AT = 0.55;

/** Panel sizes by position for each layout mode. Positions past the end are compact. */
export const SLOTS: Record<LayoutMode, PanelSize[]> = {
  focus: ["hero", "standard", "standard", "compact", "compact", "compact"],
  compare: ["hero", "hero", "compact", "compact", "compact", "compact"],
  overview: ["standard", "standard", "standard", "standard", "standard", "standard", "standard", "standard"],
};

export const SIZE_RANK: Record<PanelSize, number> = { compact: 0, standard: 1, large: 2, hero: 3 };

function clean(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** How much each part counts in the blend. All zero counts as equal weights. */
export interface BlendWeights {
  /** Weight on the model's per-panel relevance Score. */
  relevance: number;
  /** Weight on code-measured recent use (usage.ts). */
  usage: number;
  /** Weight on the goal-to-panel affinity, weighted by the model's goal probabilities. */
  goal: number;
}

export interface PanelScore<P extends string = string, G extends string = string> {
  id: P;
  /** Blended priority including the pin boost and the habit part. */
  priority: number;
  /** Weighted parts; they sum to priority. `habit` is 0 without ScoreInput.habit. */
  parts: { relevance: number; usage: number; goal: number; pin: number; habit: number };
  /** Unweighted inputs, 0..1, for reasons. `habit` is the learned chance of this panel being next. */
  raw: { relevance: number; usage: number; goal: number; habit: number };
  /** The goal that contributes most to this panel's goal affinity. */
  topGoal: G | null;
}

export interface ScoreInput<P extends string = string, G extends string = string> {
  /** The goal and relevance judgments of this round. */
  judgments: { goal?: ChoiceJudgment<G>; relevance?: Partial<Record<P, ScoreJudgment>> };
  /** Recent use per panel, 0..1 (panelUsage in usage.ts). */
  usage: Partial<Record<P, number>>;
  weights: BlendWeights;
  pinned: readonly P[];
  /**
   * A learned habit: the chance of going to each panel next, and its weight.
   * Added on top of the blend (not blended with it), so without a habit every
   * priority is exactly the blend.
   */
  habit?: { next: Partial<Record<P, number>>; weight: number };
}

/**
 * One priority per panel: the weighted blend of relevance (score / max), recent
 * use, and goal affinity (the goal probabilities times the catalog's
 * affinity), divided by the total weight, plus PIN_BOOST for a pinned panel
 * and the habit part.
 */
export function scorePanels<P extends string, G extends string>(
  catalog: Pick<Catalog<P, G>, "panelIds" | "goalIds" | "goalPanelAffinity">,
  input: ScoreInput<P, G>,
): Record<P, PanelScore<P, G>> {
  const { judgments, weights } = input;
  let wR = clean(weights.relevance);
  let wU = clean(weights.usage);
  let wG = clean(weights.goal);
  let total = wR + wU + wG;
  // All sliders at zero would make every priority zero; treat it as equal weights instead.
  if (total <= 0) {
    wR = wU = wG = 1;
    total = 3;
  }
  const goalProbs = (judgments.goal?.probabilities ?? {}) as Partial<Record<G, number>>;
  const pinned = new Set(input.pinned);
  const habitNext: Partial<Record<P, number>> = input.habit?.next ?? {};
  const wH = input.habit ? input.habit.weight : 0;
  const out = {} as Record<P, PanelScore<P, G>>;
  for (const id of catalog.panelIds) {
    const r = judgments.relevance?.[id];
    const rel = r && r.max > 0 ? clamp01(r.score / r.max) : 0;
    let goal = 0;
    let topGoal: G | null = null;
    let topContribution = 0;
    for (const g of catalog.goalIds) {
      const c = clean(goalProbs[g] ?? 0) * (catalog.goalPanelAffinity[g][id] ?? 0);
      goal += c;
      if (c > topContribution) {
        topContribution = c;
        topGoal = g;
      }
    }
    goal = clamp01(goal);
    const chance = clamp01(habitNext[id] ?? 0);
    const used = input.usage[id] ?? 0;
    const parts = {
      relevance: (wR * rel) / total,
      usage: (wU * used) / total,
      goal: (wG * goal) / total,
      pin: pinned.has(id) ? PIN_BOOST : 0,
      habit: wH * chance,
    };
    out[id] = {
      id,
      priority: parts.relevance + parts.usage + parts.goal + parts.pin + parts.habit,
      parts,
      raw: { relevance: rel, usage: used, goal, habit: chance },
      topGoal,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Mode, density, help
// ---------------------------------------------------------------------------

export function helpLevel(struggling: number): HelpLevel {
  if (struggling >= HELP_PANEL_AT) return "panel";
  if (struggling >= HELP_HINT_AT) return "hint";
  return "none";
}

/** The density one round's expertise judgment points to, or null when it is too unsure or too early to say. */
export function judgedDensity(expertise: ScoreJudgment | undefined, eventCount = DENSITY_MIN_EVENTS): Density | null {
  if (eventCount < DENSITY_MIN_EVENTS) return null;
  if (!expertise || !(expertise.max > 0) || (expertise.confidence ?? 0) < DENSITY_CONFIDENCE) return null;
  const x = expertise.score / expertise.max;
  if (x < GUIDED_BELOW) return "guided";
  if (x > DENSE_ABOVE) return "dense";
  return "standard";
}

/**
 * `recent` is the confidently judged densities of the last rounds, newest
 * last, including this one. When given, a change needs DENSITY_STREAK_LENGTH
 * of them to agree.
 */
export function pickDensity(previous: Density, expertise: ScoreJudgment | undefined, eventCount = DENSITY_MIN_EVENTS, recent?: Density[]): Density {
  const judged = judgedDensity(expertise, eventCount);
  if (!judged || judged === previous) return previous;
  if (recent) {
    const tail = recent.slice(-DENSITY_STREAK_LENGTH);
    if (tail.length < DENSITY_STREAK_LENGTH || !tail.every((d) => d === judged)) return previous;
  }
  return judged;
}

/**
 * The layout mode: the model's choice at MODE_SWITCH_CONFIDENCE, or at
 * MODE_STREAK_CONFIDENCE when the last MODE_STREAK_LENGTH rounds chose it
 * too; else the previous mode, with a "hold" decision that says why.
 */
export function pickMode<P extends string = string>(
  previous: LayoutMode,
  layout: ChoiceJudgment<LayoutMode> | undefined,
  recentModes: LayoutMode[],
): { mode: LayoutMode; decision: Decision<P> | null } {
  const judged = layout?.choice;
  if (!layout || !judged || !(LAYOUT_MODES as readonly string[]).includes(judged) || judged === previous) {
    return { mode: previous, decision: null };
  }
  const conf = layout.confidence ?? 0;
  const p = layout.probabilities?.[judged] ?? 0;
  const tail = recentModes.slice(-MODE_STREAK_LENGTH);
  const streak = tail.length === MODE_STREAK_LENGTH && tail.every((m) => m === judged);
  if (conf >= MODE_SWITCH_CONFIDENCE || (streak && conf >= MODE_STREAK_CONFIDENCE)) {
    return {
      mode: judged,
      decision: {
        kind: "mode",
        text: `Switched to the ${LAYOUT_MODE_DEFS[judged].label} layout`,
        evidence: `layout ${judged} p=${p2(p)}, confidence ${p2(conf)}${conf < MODE_SWITCH_CONFIDENCE ? `, judged ${timesWord(MODE_STREAK_LENGTH)} in a row` : ""}`,
      },
    };
  }
  return {
    mode: previous,
    decision: {
      kind: "hold",
      text: `Kept the ${LAYOUT_MODE_DEFS[previous].label} layout for now`,
      evidence: `layout ${judged} p=${p2(p)}, confidence ${p2(conf)} is below ${p2(streak ? MODE_STREAK_CONFIDENCE : MODE_SWITCH_CONFIDENCE)}`,
    },
  };
}

// ---------------------------------------------------------------------------
// Panels in use
// ---------------------------------------------------------------------------

/** An event as these rules read it: its core type, its panel, and its time. */
interface PanelEvent<P extends string> {
  type: string;
  panel?: P;
  t: number;
}

/**
 * Panels the user is using right now: the focused panel and any panel with a
 * very recent event. A panel whose latest event is a dismissal is not
 * protected: the user just sent it away, and that must win. Pass `focused`
 * only when it is one of the app's panels.
 */
export function protectedPanels<P extends string>(events: readonly PanelEvent<P>[], now: number, focused: P | null): Set<P> {
  const out = new Set<P>();
  const lastType = new Map<P, string>();
  for (const e of events) {
    if (!e.panel) continue;
    lastType.set(e.panel, e.type);
    if (e.type === "panel_dismiss") out.delete(e.panel);
    else if (now - e.t <= PROTECT_RECENT_MS) out.add(e.panel);
  }
  if (focused && lastType.get(focused) !== "panel_dismiss") out.add(focused);
  return out;
}

/**
 * Panels whose size must not shrink right now: any panel with an event in the
 * last PROTECT_RECENT_MS, and the focused panel while its newest event is
 * within FOCUSED_SIZE_HOLD_MS. Unlike protectedPanels, focus alone does not
 * protect a size forever.
 */
export function sizeHeldPanels<P extends string>(events: readonly PanelEvent<P>[], now: number, focused: P | null): Set<P> {
  const out = new Set<P>();
  const lastAt = new Map<P, number>();
  const lastType = new Map<P, string>();
  for (const e of events) {
    if (!e.panel) continue;
    lastAt.set(e.panel, e.t);
    lastType.set(e.panel, e.type);
  }
  for (const [id, t] of lastAt) {
    if (lastType.get(id) === "panel_dismiss") continue;
    if (now - t <= PROTECT_RECENT_MS || (id === focused && now - t <= FOCUSED_SIZE_HOLD_MS)) out.add(id);
  }
  return out;
}

/** Panels the user made bigger or smaller by hand in the event log. A quiet one is faded but never shrunk: the user chose its size. */
export function userResizedPanels<P extends string>(events: readonly PanelEvent<P>[]): Set<P> {
  const out = new Set<P>();
  for (const e of events) if (e.panel && (e.type === "panel_maximize" || e.type === "panel_restore")) out.add(e.panel);
  return out;
}

/** Panels opened from the dock in the last OPEN_HOLD_MS and not dismissed since. */
export function openHeldPanels<P extends string>(events: readonly PanelEvent<P>[], now: number): Set<P> {
  const lastOpen = new Map<P, number>();
  const lastDismiss = new Map<P, number>();
  for (const e of events) {
    if (!e.panel) continue;
    if (e.type === "panel_open") lastOpen.set(e.panel, e.t);
    if (e.type === "panel_dismiss") lastDismiss.set(e.panel, e.t);
  }
  const out = new Set<P>();
  for (const [id, t] of lastOpen) {
    const d = lastDismiss.get(id);
    if (now - t <= OPEN_HOLD_MS && (d == null || d < t)) out.add(id);
  }
  return out;
}
