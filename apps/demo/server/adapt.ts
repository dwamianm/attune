/**
 * One adaptation round: snapshot in, typed judgments out.
 *
 * askJev in @attune/jev sends every question in one request, reads the
 * answers, and keeps to a total budget. If anything goes wrong (no key,
 * network, timeout, bad answer), it logs one line and answers with the
 * heuristic instead, so the UI never stalls.
 *
 * prep() is the same for focus aid 4's meeting prep (POST /api/prep): its
 * own state (the meeting) and questions, the same budget, error handling,
 * and source labels.
 *
 * No HTTP here: the eval script imports adapt() and prep() directly in Node.
 */
import { askJev } from "@attune/jev";
import type { AdaptRequest, AdaptResponse, PrepRequest, PrepResponse } from "../shared/types.ts";
import { getJevClient } from "./jev.ts";
import { heuristicJudgments, heuristicPrepJudgments } from "./heuristic.ts";
import { normalizeJudgments, normalizePrepJudgments } from "./normalize.ts";
import { buildPrepQuestions, buildPrepState, buildQuestions, buildState, prepRecordsOf } from "./questions.ts";

/**
 * Total time adapt() gives Jev, across the attempt, the retry, and its
 * backoff. This must stay below the browser's ADAPT_TIMEOUT_MS (6 s,
 * src/engine/api.ts) with a margin, so the heuristic answer still arrives
 * in time.
 */
export const ADAPT_BUDGET_MS = 4_500;

export interface AdaptOptions {
  /** Aborts the Jev call, for example when the browser disconnects. */
  signal?: AbortSignal;
  /** Overrides ADAPT_BUDGET_MS (tests). */
  budgetMs?: number;
}

const NO_KEY = "No Jev API key is set (JEV_API_KEY)";

export async function adapt(req: AdaptRequest, opts: AdaptOptions = {}): Promise<AdaptResponse> {
  const state = buildState(req);
  const questions = buildQuestions(req);
  const round = await askJev({
    client: getJevClient(),
    state,
    questions,
    read: (answers) => normalizeJudgments(answers, questions),
    fallback: { name: "heuristic", answer: () => heuristicJudgments(req) },
    budgetMs: opts.budgetMs ?? ADAPT_BUDGET_MS,
    signal: opts.signal,
    logTag: `[adapt] v${req.version}`,
    noKeyError: NO_KEY,
  });
  return { version: req.version, ...round };
}

/**
 * One meeting-prep round (focus aid 4): the meeting and the client's records
 * in, one Score per record and the anything-urgent Noul out. The same
 * budget, fallback, and labels as adapt(): no key is the "no_key" heuristic,
 * any Jev failure the "jev_error" one, with the reason in meta.error.
 */
export async function prep(req: PrepRequest, opts: AdaptOptions = {}): Promise<PrepResponse> {
  const state = buildPrepState(req);
  const questions = buildPrepQuestions(req);
  const records = prepRecordsOf(req);
  const round = await askJev({
    client: getJevClient(),
    state,
    questions,
    read: (answers) => normalizePrepJudgments(answers, questions, records),
    fallback: { name: "heuristic", answer: () => heuristicPrepJudgments(req) },
    budgetMs: opts.budgetMs ?? ADAPT_BUDGET_MS,
    signal: opts.signal,
    logTag: `[prep] v${req.version}`,
    noKeyError: NO_KEY,
  });
  return { version: req.version, ...round };
}
