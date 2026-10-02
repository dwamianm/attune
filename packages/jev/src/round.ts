/**
 * One Jev round for an app that asks only the core questions: buildRound
 * makes the state and every question (the command questions too when the
 * user typed one), and readRound turns the answers into the core judgments.
 * An app with its own questions (the demo) adds them next to these instead.
 */
import type { Catalog, CoreCommandJudgments, CoreJudgments } from "@attuneui/core";
import type { Question } from "@typesafe-ai/sdk";
import { isRecord, JevAnswerError, type QuestionMap } from "./answers.ts";
import { readCoreCommand, readCoreJudgments } from "./normalize.ts";
import { buildCoreCommandQuestions, buildCoreQuestions, buildCoreState, CORE_QUESTION_IDS, type CoreStateInput, type JevState } from "./questions.ts";

/** The core judgments, with the command judgments when the round asked them. */
export type RoundJudgments<P extends string, G extends string, A extends string> = CoreJudgments<P, G, A> & { command?: CoreCommandJudgments<P, A> };

/** The state and the questions for one round. `panelRule` adds an app rule to the command panel question. */
export function buildRound<P extends string, G extends string, A extends string>(
  catalog: Catalog<P, G, A>,
  input: CoreStateInput & { panelRule?: string },
): { state: JevState; questions: Record<string, Question> } {
  const state = buildCoreState(input);
  const hasCommand = typeof state.command === "string";
  const questions = buildCoreQuestions(catalog, { hasCommand });
  if (hasCommand) Object.assign(questions, buildCoreCommandQuestions(catalog, input.panelRule ? { panelRule: input.panelRule } : {}));
  return { state, questions };
}

/** The judgments from a System One `answers` map, for the questions buildRound made. Throws JevAnswerError on anything that does not fit. */
export function readRound<P extends string, G extends string, A extends string>(answers: unknown, questions: QuestionMap, catalog: Catalog<P, G, A>): RoundJudgments<P, G, A> {
  if (!isRecord(answers)) throw new JevAnswerError("Jev response has no answers object");
  const judgments: RoundJudgments<P, G, A> = readCoreJudgments(answers, questions, catalog);
  if (CORE_QUESTION_IDS.command.panel in questions) judgments.command = readCoreCommand(answers, catalog);
  return judgments;
}
