/**
 * The one TypeSafe client the server uses to ask Jev questions.
 *
 * Tuned for a real-time UI rather than a batch job: a short per-attempt
 * timeout and one quick retry for transient failures. A slow answer is worse
 * than a fast heuristic, because the user has usually moved on by then.
 */
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { config } from "./env.ts";

export const JEV_TIMEOUT_MS = 4000;

let client: TypeSafeClient | null | undefined;

/** Returns null when no API key is configured. */
export function getJevClient(): TypeSafeClient | null {
  if (client !== undefined) return client;
  if (!config.apiKey) {
    client = null;
    return client;
  }
  client = new TypeSafeClient({
    apiKey: config.apiKey,
    defaultModel: config.model,
    timeout: JEV_TIMEOUT_MS,
    retry: {
      maxRetries: 1,
      backoffInitialMs: 150,
      backoffMaxMs: 400,
      // A timed-out attempt already cost 4 s; retrying it would double the wait.
      apiTimeoutError: false,
      // A Retry-After longer than this falls back to the short backoff above.
      // The SDK default (60 s) slept through the browser's 6 s timeout on a
      // 429, so the heuristic answer never reached the UI.
      maxRetryAfterMs: 300,
    },
    // adapt.ts logs one line per failure; the SDK's own warnings would duplicate it.
    logLevel: "error",
  });
  return client;
}
