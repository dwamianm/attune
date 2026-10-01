/**
 * The Node server: the only process that holds the Jev API key.
 *
 * The browser posts an interaction snapshot to /api/adapt (through the Vite
 * proxy in development) and gets typed judgments back, and, for focus aid 4,
 * a meeting and its records to /api/prep. The routes live in app.ts; bodies
 * are validated and capped in validate.ts before anything reaches Jev.
 */
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { config, hasJevKey } from "./env.ts";

const app = createApp();

// Loopback only (HOST overrides). Without a hostname Node listens on every
// interface, and anyone on the same network could spend the Jev key.
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const jev = hasJevKey() ? `Jev (${config.model})` : "heuristic only (no JEV_API_KEY)";
  console.log(`[server] listening on http://${config.host}:${info.port} (${info.address}), answering with ${jev}`);
});

let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(`[server] ${signal}, shutting down`);
  server.close(() => process.exit(0));
  // Do not hang on keep-alive connections.
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
