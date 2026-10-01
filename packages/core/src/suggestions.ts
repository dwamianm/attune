/**
 * Basic suggestions and link tags, for an app that has no record-specific
 * ones of its own. The demo builds richer suggestions (with the invoice or
 * message they act on) in apps/demo/src/engine/policy.ts, from the same
 * thresholds.
 */
import { NO_ACTION, UNCLEAR_GOAL, type Catalog } from "./catalog.ts";
import type { CoreJudgments } from "./judgments.ts";
import type { AnchorRef, CoreSuggestion, PanelRelation, RelatedRecord } from "./plan.ts";
import { lowerFirst } from "./words.ts";

/** Next-step confidence for a primary suggestion. */
export const SUGGEST_PRIMARY_AT = 0.7;
/** Next-step confidence for a subtle suggestion. */
export const SUGGEST_SUBTLE_AT = 0.45;
/** Runner-up next step probability needed to show it as a second, subtle suggestion. */
export const RUNNER_UP_MIN_P = 0.25;

/**
 * The suggestions from the model's next step: primary at SUGGEST_PRIMARY_AT;
 * subtle at SUGGEST_SUBTLE_AT, with the runner-up as a second subtle one when
 * it reaches RUNNER_UP_MIN_P. Labels are the catalog's action labels.
 */
export function basicSuggestions<P extends string, G extends string, A extends string>(
  catalog: Pick<Catalog<P, G, A>, "actions" | "goals">,
  judgments: Pick<CoreJudgments<P, G, A>, "nextAction" | "goal">,
): CoreSuggestion<A>[] {
  const na = judgments.nextAction;
  if (!na || na.choice === NO_ACTION || !catalog.actions[na.choice]) return [];
  const goal = judgments.goal?.choice;
  const goalText = goal && goal !== UNCLEAR_GOAL && catalog.goals[goal] ? ` while ${lowerFirst(catalog.goals[goal].label)}` : "";
  const make = (actionId: A, prominence: "primary" | "subtle", confidence: number, reason: string): CoreSuggestion<A> => ({
    actionId,
    label: catalog.actions[actionId].label,
    prominence,
    confidence,
    reason,
  });
  const conf = na.confidence ?? 0;
  if (conf >= SUGGEST_PRIMARY_AT) return [make(na.choice, "primary", conf, `Likely next step${goalText}`)];
  if (conf < SUGGEST_SUBTLE_AT) return [];
  const out = [make(na.choice, "subtle", conf, `A possible next step${goalText}`)];
  const runnerUp = (Object.entries(na.probabilities ?? {}) as [A, number][])
    .filter(([id]) => id !== na.choice && id !== NO_ACTION && catalog.actions[id])
    .sort((a, b) => b[1] - a[1])[0];
  if (runnerUp && runnerUp[1] >= RUNNER_UP_MIN_P) out.push(make(runnerUp[0], "subtle", runnerUp[1], "Another possible next step"));
  return out;
}

/** A plain link tag and reason: "Linked to Bee Weekly" and "2 linked records". */
export function basicRelation<P extends string, K extends string>(
  anchor: AnchorRef<P, K>,
  panel: P,
  records: RelatedRecord<K>[],
  panels: Readonly<Record<P, { title: string }>>,
): PanelRelation<P, K> {
  const name = anchor.label ?? anchor.client ?? panels[anchor.panel].title;
  const n = records.length;
  void panel;
  return { anchorPanel: anchor.panel, tag: `Linked to ${name}`, reason: `${n} linked ${n === 1 ? "record" : "records"}`, records };
}
