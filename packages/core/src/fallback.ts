/**
 * A calm answer for when the model cannot give one (no key, a timeout, an
 * answer that does not fit): every panel rated "supporting", so the layout
 * follows the user's recent use and pins and does not jump; the goal unclear;
 * no next step; and for a command, the panel whose title it names. The demo
 * has a richer, keyword-based heuristic of its own (apps/demo/server/heuristic.ts).
 */
import { NO_ACTION, PANEL_UNCLEAR, UNCLEAR_GOAL, type Catalog } from "./catalog.ts";
import type { ChoiceJudgment, CoreCommandJudgments, CoreJudgments, ScoreJudgment } from "./judgments.ts";
import { LAYOUT_MODES, type LayoutMode } from "./layoutModes.ts";

function sure<K extends string>(choice: K, options: readonly K[], confidence = 1): ChoiceJudgment<K> {
  const probabilities = Object.fromEntries(options.map((k) => [k, k === choice ? confidence : (1 - confidence) / Math.max(1, options.length - 1)])) as Record<K, number>;
  return { choice, confidence, probabilities };
}

function level(score: number, max: number, confidence: number): ScoreJudgment {
  return { score, max, confidence, probabilities: Array.from({ length: max + 1 }, (_, i) => (i === Math.round(score) ? 1 : 0)) };
}

/** The panel whose title (or id) the command names as a whole word, or null. */
export function panelNamedIn<P extends string>(catalog: Pick<Catalog<P>, "panelIds" | "panels">, command: string): P | null {
  const text = ` ${command.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  for (const id of catalog.panelIds) {
    const words = [catalog.panels[id].title, id].map((w) => w.toLowerCase());
    if (words.some((w) => text.includes(` ${w} `) || (w.endsWith("s") && text.includes(` ${w.slice(0, -1)} `)))) return id;
  }
  return null;
}

/** The calm answer, with command judgments when `command` is given. */
export function neutralJudgments<P extends string, G extends string, A extends string>(
  catalog: Catalog<P, G, A>,
  opts: { command?: string } = {},
): CoreJudgments<P, G, A> & { command?: CoreCommandJudgments<P, A> } {
  const relevance = Object.fromEntries(catalog.panelIds.map((id) => [id, level(2, 3, 0.5)])) as Record<P, ScoreJudgment>;
  const out: CoreJudgments<P, G, A> & { command?: CoreCommandJudgments<P, A> } = {
    goal: sure(UNCLEAR_GOAL as G, catalog.goalIds),
    relevance,
    struggling: 0.1,
    layout: sure<LayoutMode>("overview", LAYOUT_MODES, 0.5),
    expertise: level(1, 2, 0.5),
    nextAction: sure(NO_ACTION as A, catalog.actionIds),
  };
  const command = opts.command?.trim();
  if (command) {
    const named = panelNamedIn(catalog, command);
    const options = [...catalog.panelIds, PANEL_UNCLEAR] as (P | typeof PANEL_UNCLEAR)[];
    out.command = {
      panel: named ? sure<P | typeof PANEL_UNCLEAR>(named, options, 0.7) : sure<P | typeof PANEL_UNCLEAR>(PANEL_UNCLEAR, options, 0.9),
      action: sure(NO_ACTION as A, catalog.actionIds),
    };
  }
  return out;
}
