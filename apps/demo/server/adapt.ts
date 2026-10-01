/**
 * One adaptation round: snapshot in, typed judgments out.
 *
 * Asks Jev every question in a single request and normalizes the answers.
 * If anything goes wrong (no key, network, timeout, bad answer), it logs one
 * line and answers with the heuristic instead, so the UI never stalls.
 *
 * prep() is the same for focus aid 4's meeting prep (POST /api/prep): its
 * own state (the meeting) and questions, the same budget, error handling,
 * and source labels.
 *
 * No HTTP here: the eval script imports adapt() and prep() directly in Node.
 */
import { JevAnswerError, type JevState } from "@attune/jev";
import { APIError, APITimeoutError, APIUserAbortError, type Question } from "@typesafe-ai/sdk";
import type { AdaptRequest, AdaptResponse, Judgments, PrepRequest, PrepResponse } from "../shared/types.ts";
import { getJevClient, JEV_TIMEOUT_MS } from "./jev.ts";
import { heuristicJudgments, heuristicPrepJudgments } from "./heuristic.ts";
import { normalizeJudgments, normalizePrepJudgments } from "./normalize.ts";
import { buildPrepQuestions, buildPrepState, buildQuestions, buildState, prepRecordsOf } from "./questions.ts";

/**
 * Total time adapt() gives Jev, across the attempt, the retry, and its
 * backoff. The SDK timeout is per attempt with no overall budget, so a slow
 * 503 plus a slow retry took 7 s. This must stay below the browser's
 * ADAPT_TIMEOUT_MS (6 s, src/engine/api.ts) with a margin, so the heuristic
 * answer still arrives in time.
 */
export const ADAPT_BUDGET_MS = 4_500;

export interface AdaptOptions {
  /** Aborts the Jev call, for example when the browser disconnects. */
  signal?: AbortSignal;
  /** Overrides ADAPT_BUDGET_MS (tests). */
  budgetMs?: number;
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

/** A short, key-free reason for meta.error and the log line. */
function describeError(err: unknown): string {
  if (err instanceof APIUserAbortError) return "Request was cancelled";
  if (err instanceof APITimeoutError) return `Jev timed out after ${JEV_TIMEOUT_MS} ms`;
  if (err instanceof APIError) {
    const id = err.requestId ? ` (request ${err.requestId})` : "";
    return `Jev returned HTTP ${err.status}${id}`;
  }
  if (err instanceof JevAnswerError) return err.message;
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 200);
  return "Unknown error";
}

function heuristicResponse(
  req: AdaptRequest,
  state: JevState,
  questions: Record<string, Question>,
  started: number,
  error: string,
  fallback: "no_key" | "jev_error",
): AdaptResponse {
  const judgments: Judgments = heuristicJudgments(req);
  return {
    version: req.version,
    source: "heuristic",
    judgments,
    meta: {
      model: "heuristic",
      latencyMs: elapsed(started),
      questionCount: Object.keys(questions).length,
      error,
      // Lets the client show the designed no-key mode as "offline", not as an error.
      fallback,
    },
    // What would have been sent, so the inspector still shows the questions.
    debug: { state, questions },
  };
}

export async function adapt(req: AdaptRequest, opts: AdaptOptions = {}): Promise<AdaptResponse> {
  const started = performance.now();
  const state = buildState(req);
  const questions = buildQuestions(req);

  const client = getJevClient();
  if (!client) {
    return heuristicResponse(req, state, questions, started, "No Jev API key is set (JEV_API_KEY)", "no_key");
  }

  const budgetMs = opts.budgetMs ?? ADAPT_BUDGET_MS;
  const deadline = AbortSignal.timeout(budgetMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  try {
    const { data, requestId } = await client.systemOne({ state, questions }, { signal }).withResponse();
    const judgments = normalizeJudgments(data.answers, questions);
    return {
      version: req.version,
      source: "jev",
      judgments,
      meta: {
        model: data.model,
        latencyMs: elapsed(started),
        usage: { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens },
        requestId,
        questionCount: Object.keys(questions).length,
      },
      debug: { state, questions },
    };
  } catch (err) {
    // Our own deadline aborts through the same signal as a user cancel; tell them apart.
    const overBudget = deadline.aborted && !opts.signal?.aborted;
    const message = overBudget ? `Jev did not answer within ${budgetMs} ms` : describeError(err);
    // A cancelled request is the client moving on, not a Jev failure.
    if (overBudget || !(err instanceof APIUserAbortError)) {
      console.warn(`[adapt] v${req.version} Jev failed, using heuristic: ${message}`);
    }
    return heuristicResponse(req, state, questions, started, message, "jev_error");
  }
}

/**
 * One meeting-prep round (focus aid 4): the meeting and the client's records
 * in, one Score per record and the anything-urgent Noul out. The same
 * budget, fallback, and labels as adapt(): no key is the "no_key" heuristic,
 * any Jev failure the "jev_error" one, with the reason in meta.error.
 */
export async function prep(req: PrepRequest, opts: AdaptOptions = {}): Promise<PrepResponse> {
  const started = performance.now();
  const state = buildPrepState(req);
  const questions = buildPrepQuestions(req);
  const records = prepRecordsOf(req);
  const fallback = (error: string, why: "no_key" | "jev_error"): PrepResponse => ({
    version: req.version,
    source: "heuristic",
    judgments: heuristicPrepJudgments(req),
    meta: { model: "heuristic", latencyMs: elapsed(started), questionCount: Object.keys(questions).length, error, fallback: why },
    debug: { state, questions },
  });

  const client = getJevClient();
  if (!client) return fallback("No Jev API key is set (JEV_API_KEY)", "no_key");

  const budgetMs = opts.budgetMs ?? ADAPT_BUDGET_MS;
  const deadline = AbortSignal.timeout(budgetMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, deadline]) : deadline;
  try {
    const { data, requestId } = await client.systemOne({ state, questions }, { signal }).withResponse();
    const judgments = normalizePrepJudgments(data.answers, questions, records);
    return {
      version: req.version,
      source: "jev",
      judgments,
      meta: {
        model: data.model,
        latencyMs: elapsed(started),
        usage: { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens },
        requestId,
        questionCount: Object.keys(questions).length,
      },
      debug: { state, questions },
    };
  } catch (err) {
    const overBudget = deadline.aborted && !opts.signal?.aborted;
    const message = overBudget ? `Jev did not answer within ${budgetMs} ms` : describeError(err);
    if (overBudget || !(err instanceof APIUserAbortError)) {
      console.warn(`[prep] v${req.version} Jev failed, using heuristic: ${message}`);
    }
    return fallback(message, "jev_error");
  }
}
