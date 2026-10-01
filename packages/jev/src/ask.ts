/**
 * One Jev round that always answers: the state and every question in one
 * System One request, a total time budget across the attempt, the retry,
 * and its backoff, and the app's own fallback answer when anything goes
 * wrong (no key, network, timeout, an answer that does not fit the
 * questions). It logs one line per failure, so the UI never stalls and the
 * server log says why.
 *
 * The SDK timeout is per attempt with no overall budget, so a slow 503 plus
 * a slow retry took 7 s in the demo. Pick `budgetMs` below the browser's own
 * timeout with a margin, so the fallback answer still arrives in time.
 */
import { APIError, APITimeoutError, APIUserAbortError, type Question, type TypeSafeClient } from "@typesafe-ai/sdk";
import { JevAnswerError } from "./answers.ts";
import type { JevState } from "./questions.ts";

/** The app's own answer when Jev cannot give one, for example a heuristic. */
export interface FallbackAnswer<J, F extends string = string> {
  /** Names the answer in `source`, `meta.model`, and the log line, for example "heuristic". */
  name: F;
  answer: () => J;
}

export interface AskJevInput<J, F extends string = string> {
  /** Null when no key is set: the round answers with the fallback, labeled "no_key". */
  client: Pick<TypeSafeClient, "systemOne"> | null;
  state: JevState;
  questions: Record<string, Question>;
  /** Turns the `answers` map into judgments. Throws (a JevAnswerError) when the answers do not fit the questions. */
  read: (answers: unknown) => J;
  fallback: FallbackAnswer<J, F>;
  /** Total time for the round, retry included. */
  budgetMs: number;
  /** Aborts the call, for example when the browser disconnects. Not logged as a failure. */
  signal?: AbortSignal;
  /** Start of the log line on a failure, for example "[adapt] v4". */
  logTag: string;
  /** meta.error when there is no client. Default: "No Jev API key is set". */
  noKeyError?: string;
  /** Where the failure line goes. Default: console.warn. */
  warn?: (line: string) => void;
}

export interface JevRoundMeta {
  /** Versioned model id that answered, for example "jev-1.13.0", or the fallback's name. */
  model: string;
  latencyMs: number;
  usage?: { input_tokens: number; output_tokens: number };
  requestId?: string;
  questionCount: number;
  /** Set when the fallback answered: why. */
  error?: string;
  /** "no_key" when no key is set (a designed mode, not an error), "jev_error" when Jev failed. */
  fallback?: "no_key" | "jev_error";
}

export interface JevRound<J, F extends string = string> {
  source: "jev" | F;
  judgments: J;
  meta: JevRoundMeta;
  /** Exactly what was sent (or would have been), for an inspector. */
  debug: { state: JevState; questions: Record<string, Question> };
}

function elapsed(started: number): number {
  return Math.round(performance.now() - started);
}

/** A short, key-free reason for meta.error and the log line. */
export function describeJevError(err: unknown): string {
  if (err instanceof APIUserAbortError) return "Request was cancelled";
  if (err instanceof APITimeoutError) return `Jev timed out after ${err.timeoutMs} ms`;
  if (err instanceof APIError) {
    const id = err.requestId ? ` (request ${err.requestId})` : "";
    return `Jev returned HTTP ${err.status}${id}`;
  }
  if (err instanceof JevAnswerError) return err.message;
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 200);
  return "Unknown error";
}

export async function askJev<J, F extends string>(input: AskJevInput<J, F>): Promise<JevRound<J, F>> {
  const started = performance.now();
  const { state, questions } = input;
  const questionCount = Object.keys(questions).length;
  const fallback = (error: string, why: "no_key" | "jev_error"): JevRound<J, F> => ({
    source: input.fallback.name,
    judgments: input.fallback.answer(),
    // `fallback` lets the app show the designed no-key mode as "offline", not as an error.
    meta: { model: input.fallback.name, latencyMs: elapsed(started), questionCount, error, fallback: why },
    // What would have been sent, so an inspector still shows the questions.
    debug: { state, questions },
  });

  if (!input.client) return fallback(input.noKeyError ?? "No Jev API key is set", "no_key");

  const deadline = AbortSignal.timeout(input.budgetMs);
  const signal = input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  try {
    const { data, requestId } = await input.client.systemOne({ state, questions }, { signal }).withResponse();
    const judgments = input.read(data.answers);
    return {
      source: "jev",
      judgments,
      meta: {
        model: data.model,
        latencyMs: elapsed(started),
        usage: { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens },
        requestId,
        questionCount,
      },
      debug: { state, questions },
    };
  } catch (err) {
    // Our own deadline aborts through the same signal as a user cancel; tell them apart.
    const overBudget = deadline.aborted && !input.signal?.aborted;
    const message = overBudget ? `Jev did not answer within ${input.budgetMs} ms` : describeJevError(err);
    // A cancelled request is the client moving on, not a Jev failure.
    if (overBudget || !(err instanceof APIUserAbortError)) {
      (input.warn ?? console.warn)(`${input.logTag} Jev failed, using ${input.fallback.name}: ${message}`);
    }
    return fallback(message, "jev_error");
  }
}
