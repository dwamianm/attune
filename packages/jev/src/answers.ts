/**
 * Readers that turn raw Jev answers into typed judgments.
 *
 * Every answer is checked against the question that was actually sent: a
 * Choice must pick one of the options offered, and a Score's probabilities
 * must cover the levels written. Anything missing or out of shape throws a
 * JevAnswerError, so the app can fall back to its own answer instead of
 * handing the layout code half a judgment.
 */
import type { ChoiceJudgment, ScoreJudgment } from "@attune/core";
import type { Question } from "@typesafe-ai/sdk";

export class JevAnswerError extends Error {
  override name = "JevAnswerError";
}

/** The `answers` map of a System One response, by question id. */
export type Answers = Record<string, unknown>;
/** The questions that were sent, by id. */
export type QuestionMap = Record<string, Question>;

/** Small tolerance for probabilities that sum or round a hair outside 0..1. */
const EPS = 1e-6;

export function isRecord(value: unknown): value is Record<string, unknown> {
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

/** The options a Choice was asked with: the keys of its criteria. Throws when `id` was not asked as a Choice. */
export function choiceOptions(questions: QuestionMap, id: string): string[] {
  const question = questions[id];
  if (!question || question.type !== "choice") throw new JevAnswerError(`Question "${id}" was not asked as a choice`);
  return Object.keys(question.criteria);
}

/** How many levels a Score was asked with. Throws when `id` was not asked as a Score. */
export function scoreLevels(questions: QuestionMap, id: string): number {
  const question = questions[id];
  if (!question || question.type !== "score") throw new JevAnswerError(`Question "${id}" was not asked as a score`);
  return question.criteria.length;
}
