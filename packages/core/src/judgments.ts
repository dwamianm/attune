/**
 * The typed answers the layout code reads, the same whichever model or
 * fallback produced them. The model layer (@attune/jev) builds them from the
 * model's answers; an app's fallback (the demo's heuristic) builds them from
 * plain rules.
 */
import type { LayoutMode } from "./layoutModes.ts";
import type { PANEL_UNCLEAR } from "./catalog.ts";

/** A Choice answer: the picked option, the model's confidence in it, and a probability per option. */
export interface ChoiceJudgment<K extends string = string> {
  choice: K;
  confidence: number;
  probabilities: Record<K, number>;
}

/** A Score answer on an ordered scale. */
export interface ScoreJudgment {
  /** Probability-weighted level, 0..max. */
  score: number;
  /** Highest level index (levels - 1). */
  max: number;
  confidence: number;
  /** Probability per level, index = level. */
  probabilities: number[];
}

/**
 * What every Attune app learns each round from the core questions: the
 * goal, how useful each panel is, whether the user is stuck, which layout
 * fits, how familiar the user is, and the next step. An app adds its own
 * judgments next to these.
 */
export interface CoreJudgments<P extends string = string, G extends string = string, A extends string = string> {
  goal: ChoiceJudgment<G>;
  /** One comparable Score per panel: how useful the panel is right now. */
  relevance: Record<P, ScoreJudgment>;
  /** Noul: probability the user is having trouble. Near 0.5 means unsure, not "medium". */
  struggling: number;
  layout: ChoiceJudgment<LayoutMode>;
  /** 0 = new, 1 = comfortable, 2 = expert. */
  expertise: ScoreJudgment;
  nextAction: ChoiceJudgment<A>;
}

/** What the core command questions learn about a command the user typed. */
export interface CoreCommandJudgments<P extends string = string, A extends string = string> {
  /** Which panel best answers the command, or PANEL_UNCLEAR. */
  panel: ChoiceJudgment<P | typeof PANEL_UNCLEAR>;
  /** Which action the command asks for, or NO_ACTION. */
  action: ChoiceJudgment<A>;
}
