/**
 * Turns raw Jev answers into the typed Judgments the client policy reads.
 *
 * Every answer is checked against the question that was actually sent: a
 * Choice must pick one of the options we offered, and a Score's
 * probabilities must cover the levels we wrote. Anything missing or out of
 * shape throws, so adapt.ts can fall back to the heuristic instead of
 * handing the layout policy half a judgment.
 */
import type { Question } from "@typesafe-ai/sdk";
import { ACTION_IDS, GOAL_IDS, LAYOUT_MODES, PANEL_IDS, type PanelId } from "../shared/catalog.ts";
import {
  INVOICE_STATUS_ARGS,
  TIMEFRAME_ARGS,
  type ChoiceJudgment,
  type CommandJudgments,
  type Judgments,
  type PrepJudgments,
  type PrepRecord,
  type ScoreJudgment,
} from "../shared/types.ts";
import { CLIENT_NOT_MENTIONED, NO_CLIENT, PANEL_UNCLEAR, PREP_QUESTION_IDS, QUESTION_IDS } from "./questions.ts";

export class JevAnswerError extends Error {
  override name = "JevAnswerError";
}

type Answers = Record<string, unknown>;
type QuestionMap = Record<string, Question>;

/** Small tolerance for probabilities that sum or round a hair outside 0..1. */
const EPS = 1e-6;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(id: string, problem: string): never {
  throw new JevAnswerError(`Jev answer "${id}" ${problem}`);
}

function unitNumber(id: string, field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < -EPS || value > 1 + EPS) {
    fail(id, `has ${field} ${JSON.stringify(value)}, expected a number from 0 to 1`);
  }
  return Math.min(1, Math.max(0, value));
}

function answerOf(answers: Answers, id: string, type: "choice" | "score" | "noul"): Record<string, unknown> {
  const answer = answers[id];
  if (answer === undefined) fail(id, "is missing");
  if (!isRecord(answer)) fail(id, "is not an object");
  if (answer.type !== type) fail(id, `has type ${JSON.stringify(answer.type)}, expected "${type}"`);
  return answer;
}

/** A judgment code already knows the answer to (for questions not asked). */
export function certainChoice<K extends string>(value: K, options: readonly K[] = [value]): ChoiceJudgment<K> {
  const probabilities = Object.fromEntries(options.map((k) => [k, k === value ? 1 : 0])) as Record<K, number>;
  return { choice: value, confidence: 1, probabilities };
}

export function readChoice<K extends string>(answers: Answers, id: string, options: readonly K[]): ChoiceJudgment<K> {
  const answer = answerOf(answers, id, "choice");
  const picked = answer.choice;
  if (typeof picked !== "string" || !(options as readonly string[]).includes(picked)) {
    fail(id, `chose ${JSON.stringify(picked)}, which is not one of the options`);
  }
  const raw = answer.probabilities;
  if (!isRecord(raw)) fail(id, "has no probabilities");
  const probabilities = {} as Record<K, number>;
  for (const option of options) {
    // An option the API left out is read as zero probability, not as an error.
    probabilities[option] = raw[option] === undefined ? 0 : unitNumber(id, `probability for "${option}"`, raw[option]);
  }
  return {
    choice: picked as K,
    confidence: unitNumber(id, "confidence", answer.confidence),
    probabilities,
  };
}

export function readScore(answers: Answers, id: string, levels: number): ScoreJudgment {
  if (!Number.isInteger(levels) || levels < 2) fail(id, `was asked with ${levels} levels, expected at least 2`);
  const answer = answerOf(answers, id, "score");
  const max = levels - 1;
  const value = answer.score;
  if (typeof value !== "number" || !Number.isFinite(value) || value < -EPS || value > max + EPS) {
    fail(id, `has score ${JSON.stringify(value)}, expected a number from 0 to ${max}`);
  }
  const raw = answer.probabilities;
  if (!isRecord(raw)) fail(id, "has no probabilities");
  for (const key of Object.keys(raw)) {
    const level = Number(key);
    if (!Number.isInteger(level) || level < 0 || level > max) fail(id, `has probability for unknown level "${key}"`);
  }
  const probabilities: number[] = [];
  for (let level = 0; level <= max; level++) {
    const p = raw[String(level)];
    probabilities.push(p === undefined ? 0 : unitNumber(id, `probability for level ${level}`, p));
  }
  return {
    score: Math.min(max, Math.max(0, value)),
    max,
    confidence: unitNumber(id, "confidence", answer.confidence),
    probabilities,
  };
}

export function readNoul(answers: Answers, id: string): number {
  const answer = answerOf(answers, id, "noul");
  return unitNumber(id, "noul", answer.noul);
}

function choiceOptions(questions: QuestionMap, id: string): string[] {
  const question = questions[id];
  if (!question || question.type !== "choice") throw new JevAnswerError(`Question "${id}" was not asked as a choice`);
  return Object.keys(question.criteria);
}

function scoreLevels(questions: QuestionMap, id: string): number {
  const question = questions[id];
  if (!question || question.type !== "score") throw new JevAnswerError(`Question "${id}" was not asked as a score`);
  return question.criteria.length;
}

const CMD_PANEL_OPTIONS = [...PANEL_IDS, PANEL_UNCLEAR] as const;

function readCommand(answers: Answers, questions: QuestionMap): CommandJudgments {
  const ids = QUESTION_IDS.command;
  return {
    panel: readChoice<PanelId | typeof PANEL_UNCLEAR>(answers, ids.panel, CMD_PANEL_OPTIONS),
    action: readChoice(answers, ids.action, ACTION_IDS),
    invoiceStatus: readChoice(answers, ids.invoiceStatus, INVOICE_STATUS_ARGS),
    client:
      ids.client in questions
        ? readChoice(answers, ids.client, choiceOptions(questions, ids.client))
        : certainChoice<string>(CLIENT_NOT_MENTIONED),
    timeframe: readChoice(answers, ids.timeframe, TIMEFRAME_ARGS),
  };
}

/**
 * Build Judgments from `answers` (the `answers` map of a System One
 * response) for the `questions` that were sent. Throws JevAnswerError on
 * any missing or malformed answer.
 */
export function normalizeJudgments(answers: unknown, questions: QuestionMap): Judgments {
  if (!isRecord(answers)) throw new JevAnswerError("Jev response has no answers object");

  const relevance = {} as Record<PanelId, ScoreJudgment>;
  for (const panel of PANEL_IDS) {
    const id = QUESTION_IDS.relevance(panel);
    relevance[panel] = readScore(answers, id, scoreLevels(questions, id));
  }

  const judgments: Judgments = {
    goal: readChoice(answers, QUESTION_IDS.goal, GOAL_IDS),
    relevance,
    struggling: readNoul(answers, QUESTION_IDS.struggling),
    layout: readChoice(answers, QUESTION_IDS.layout, LAYOUT_MODES),
    expertise: readScore(answers, QUESTION_IDS.expertise, scoreLevels(questions, QUESTION_IDS.expertise)),
    nextAction: readChoice(answers, QUESTION_IDS.nextAction, ACTION_IDS),
    // No candidates means there was nothing to choose from, so code answers.
    targetClient:
      QUESTION_IDS.targetClient in questions
        ? readChoice(answers, QUESTION_IDS.targetClient, choiceOptions(questions, QUESTION_IDS.targetClient))
        : certainChoice<string>(NO_CLIENT),
  };

  // Asked only when the client sent record candidates. The options are read
  // from the question that was sent, so the pick must be one of those ids or "none".
  if (QUESTION_IDS.nextRecord in questions) {
    judgments.nextRecord = readChoice(answers, QUESTION_IDS.nextRecord, choiceOptions(questions, QUESTION_IDS.nextRecord));
  }
  if (QUESTION_IDS.listWork in questions) {
    judgments.listWork = readNoul(answers, QUESTION_IDS.listWork);
  }
  // Focus aid 2: asked only when the client sent the working goal, and task
  // candidates. The next task must be one of the task ids sent, or "none".
  if (QUESTION_IDS.goalDone in questions) {
    judgments.goalDone = readNoul(answers, QUESTION_IDS.goalDone);
  }
  if (QUESTION_IDS.nextTask in questions) {
    judgments.nextTask = readChoice(answers, QUESTION_IDS.nextTask, choiceOptions(questions, QUESTION_IDS.nextTask));
  }
  // "Arrange linked panels by next step": asked only when the client sent the
  // clicked record and its linked records. The next record must be one of the
  // linked record ids sent, or "none"; the action one of the catalog's.
  if (QUESTION_IDS.linkNext in questions) {
    judgments.linkNext = readChoice(answers, QUESTION_IDS.linkNext, choiceOptions(questions, QUESTION_IDS.linkNext));
  }
  if (QUESTION_IDS.linkAction in questions) {
    judgments.linkAction = readChoice(answers, QUESTION_IDS.linkAction, ACTION_IDS);
  }

  if (QUESTION_IDS.command.panel in questions) {
    judgments.command = readCommand(answers, questions);
  }
  return judgments;
}

/**
 * Build the meeting-prep judgments (focus aid 4) from `answers` for the
 * `questions` that were sent: one Score per record, keyed back to its record
 * id (the questions follow the order of `records`, PREP_QUESTION_IDS.record),
 * and the anything-urgent Noul. Throws JevAnswerError on any missing or
 * malformed answer, like normalizeJudgments.
 */
export function normalizePrepJudgments(answers: unknown, questions: QuestionMap, records: readonly PrepRecord[]): PrepJudgments {
  if (!isRecord(answers)) throw new JevAnswerError("Jev response has no answers object");
  const scores: Record<string, ScoreJudgment> = {};
  records.forEach((r, i) => {
    const id = PREP_QUESTION_IDS.record(i);
    scores[r.id] = readScore(answers, id, scoreLevels(questions, id));
  });
  return { scores, anythingUrgent: readNoul(answers, PREP_QUESTION_IDS.anythingUrgent) };
}
