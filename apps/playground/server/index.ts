/**
 * Starts the playground's API on localhost. Reads JEV_API_KEY (or
 * TYPESAFE_API_KEY), JEV_MODEL, and PORT from the shell or apps/playground/.env.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createRealtimeJevClient } from "@attuneui/jev";
import { createApp } from "./app.ts";

/** Not the demo's 8790, so both can run at once. */
const DEFAULT_PORT = 8791;

const envFile = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envFile)) process.loadEnvFile(envFile);

const read = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const apiKey = read("JEV_API_KEY") ?? read("TYPESAFE_API_KEY");
const port = Number(read("PORT") ?? DEFAULT_PORT);
const client = apiKey ? createRealtimeJevClient({ apiKey, model: read("JEV_MODEL") ?? "jev-latest" }) : null;

serve({ fetch: createApp({ client }).fetch, port, hostname: "localhost" }, (info) => {
  console.log(`[playground] listening on http://localhost:${info.port}, ${client ? "answering with Jev" : "no key: answering with the fallback"}`);
});
