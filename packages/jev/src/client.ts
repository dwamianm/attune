/**
 * A TypeSafe client tuned for a real-time UI rather than a batch job: a
 * short per-attempt timeout and one quick retry for transient failures. A
 * slow answer is worse than a fast fallback, because the user has usually
 * moved on by then. askJev (ask.ts) puts a total budget on top.
 */
import { TypeSafeClient } from "@typesafe-ai/sdk";

/** How long one attempt may take before the SDK gives up on it. */
export const JEV_ATTEMPT_TIMEOUT_MS = 4000;

export interface RealtimeClientConfig {
  apiKey: string;
  /** For example "jev-latest". */
  model: string;
}

export function createRealtimeJevClient(config: RealtimeClientConfig): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: config.apiKey,
    defaultModel: config.model,
    timeout: JEV_ATTEMPT_TIMEOUT_MS,
    retry: {
      maxRetries: 1,
      backoffInitialMs: 150,
      backoffMaxMs: 400,
      // A timed-out attempt already cost 4 s; retrying it would double the wait.
      apiTimeoutError: false,
      // A Retry-After longer than this falls back to the short backoff above.
      // The SDK default (60 s) slept through the demo browser's 6 s timeout
      // on a 429, so the fallback answer never reached the UI.
      maxRetryAfterMs: 300,
    },
    // askJev logs one line per failure; the SDK's own warnings would duplicate it.
    logLevel: "error",
  });
}
