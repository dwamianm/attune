/**
 * The one TypeSafe client the server uses to ask Jev questions: the
 * real-time client from @attune/jev (short per-attempt timeout, one quick
 * retry), made once from the server config.
 */
import { createRealtimeJevClient } from "@attune/jev";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { config } from "./env.ts";

let client: TypeSafeClient | null | undefined;

/** Returns null when no API key is configured. */
export function getJevClient(): TypeSafeClient | null {
  if (client !== undefined) return client;
  client = config.apiKey ? createRealtimeJevClient({ apiKey: config.apiKey, model: config.model }) : null;
  return client;
}
