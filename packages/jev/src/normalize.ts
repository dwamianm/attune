/**
 * Read the answers to the core questions (questions.ts) into typed
 * judgments. Each reader checks the answers against the questions that were
 * sent and the app's catalog, and throws a JevAnswerError on anything
 * missing or out of shape (answers.ts).
 */
import { LAYOUT_MODES, PANEL_UNCLEAR, type Catalog, type CoreCommandJudgments, type CoreJudgments, type ScoreJudgment } from "@attuneui/core";
import { readChoice, readNoul, readScore, scoreLevels, type Answers, type QuestionMap } from "./answers.ts";
import { CORE_QUESTION_IDS } from "./questions.ts";

/**
 * The core judgments from `answers` for the `questions` that were sent
 * (buildCoreQuestions). The relevance Scores are read first, then the goal,
 * struggling, layout, expertise, and next action, so the first problem
 * found is reported the same way every time.
 */
export function readCoreJudgments<P extends string, G extends string, A extends string>(
  answers: Answers,
  questions: QuestionMap,
  catalog: Catalog<P, G, A>,
): CoreJudgments<P, G, A> {
  const relevance = {} as Record<P, ScoreJudgment>;
  for (const panel of catalog.panelIds) {
    const id = CORE_QUESTION_IDS.relevance(panel);
    relevance[panel] = readScore(answers, id, scoreLevels(questions, id));
  }
  return {
    goal: readChoice(answers, CORE_QUESTION_IDS.goal, catalog.goalIds),
    relevance,
    struggling: readNoul(answers, CORE_QUESTION_IDS.struggling),
    layout: readChoice(answers, CORE_QUESTION_IDS.layout, LAYOUT_MODES),
    expertise: readScore(answers, CORE_QUESTION_IDS.expertise, scoreLevels(questions, CORE_QUESTION_IDS.expertise)),
    nextAction: readChoice(answers, CORE_QUESTION_IDS.nextAction, catalog.actionIds),
  };
}

/** The core command judgments (buildCoreCommandQuestions): the panel, or PANEL_UNCLEAR, and the action. */
export function readCoreCommand<P extends string, G extends string, A extends string>(answers: Answers, catalog: Catalog<P, G, A>): CoreCommandJudgments<P, A> {
  const ids = CORE_QUESTION_IDS.command;
  return {
    panel: readChoice<P | typeof PANEL_UNCLEAR>(answers, ids.panel, [...catalog.panelIds, PANEL_UNCLEAR]),
    action: readChoice(answers, ids.action, catalog.actionIds),
  };
}
