/**
 * Builders for engine tests: judgments with sensible defaults and timed events.
 * Kept out of the *.test.ts files so policy, command, and store tests share
 * one idea of what a "neutral" Jev answer looks like.
 */
import { PANEL_IDS, type ActionId, type GoalId, type LayoutMode, type PanelId } from "../../shared/catalog.ts";
import type { ScenarioStep } from "../../shared/scenarios.ts";
import type { ChoiceJudgment, CommandJudgments, Judgments, ScoreJudgment, SignalEvent, SignalType, TrackInput } from "../../shared/types.ts";
import { describeEvent } from "./snapshot.ts";

export function choiceJ<K extends string>(choice: K, confidence: number, probabilities?: Partial<Record<K, number>>): ChoiceJudgment<K> {
  return { choice, confidence, probabilities: (probabilities ?? { [choice]: confidence }) as Record<K, number> };
}

export function scoreJ(score: number, max = 2, confidence = 0.8): ScoreJudgment {
  return { score, max, confidence, probabilities: Array.from({ length: max + 1 }, (_, i) => (Math.round(score) === i ? 1 : 0)) };
}

export interface JudgmentOverrides {
  /** Relevance per panel on a 0..2 scale. Missing panels get 0. */
  rel?: Partial<Record<PanelId, number>>;
  goal?: ChoiceJudgment<GoalId>;
  layout?: ChoiceJudgment<LayoutMode>;
  struggling?: number;
  expertise?: ScoreJudgment;
  nextAction?: ChoiceJudgment<ActionId>;
  targetClient?: ChoiceJudgment<string>;
  command?: CommandJudgments;
}

/** A neutral answer: goal unclear, overview layout, not struggling, standard expertise, no next step. */
export function makeJudgments(o: JudgmentOverrides = {}): Judgments {
  const relevance = Object.fromEntries(PANEL_IDS.map((id) => [id, scoreJ(o.rel?.[id] ?? 0)])) as Record<PanelId, ScoreJudgment>;
  return {
    goal: o.goal ?? choiceJ<GoalId>("unclear", 0.9, { unclear: 1 }),
    relevance,
    struggling: o.struggling ?? 0.1,
    layout: o.layout ?? choiceJ<LayoutMode>("overview", 0.9, { overview: 0.95, focus: 0.03, compare: 0.02 }),
    expertise: o.expertise ?? scoreJ(1, 2, 0.8),
    nextAction: o.nextAction ?? choiceJ<ActionId>("none", 0.9, { none: 0.95 }),
    targetClient: o.targetClient ?? choiceJ("none", 0.9, { none: 0.95 }),
    ...(o.command ? { command: o.command } : {}),
  };
}

let seq = 0;

export function ev(type: SignalType, t: number, panel?: PanelId, detail?: TrackInput["detail"]): SignalEvent {
  const input: TrackInput = { type, ...(panel ? { panel } : {}), ...(detail ? { detail } : {}) };
  return { ...input, id: ++seq, t, text: describeEvent(input) };
}

/** Scenario steps as timed events, the way a replay would log them. Returns the events and the last time. */
export function stepsToEvents(steps: ScenarioStep[], start = 1_000_000, defaultDelay = 800): { events: SignalEvent[]; end: number } {
  let t = start;
  const events = steps.map((step, i) => {
    t += step.delayMs ?? (i === 0 ? 0 : defaultDelay);
    const { delayMs: _d, ...input } = step;
    void _d;
    return { ...input, id: ++seq, t, text: describeEvent(input) } satisfies SignalEvent;
  });
  return { events, end: t };
}
