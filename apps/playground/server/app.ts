/**
 * The playground's API, built only from the library: the guard and the
 * request check (@attune/server), one Jev round with the core questions and
 * the calm fallback (@attune/jev, @attune/core). Split from index.ts so tests
 * can call it with app.request() and no open port.
 */
import { neutralJudgments } from "@attune/core";
import { askJev, buildRound, readRound } from "@attune/jev";
import { checkRequest, createRateLimiter, parseAdaptRequest } from "@attune/server";
import type { TypeSafeClient } from "@typesafe-ai/sdk";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { CATALOG } from "../src/catalog.ts";

/** One sentence about the app for Jev's state. */
export const APP_DESCRIPTION =
  "A help desk for a small software company. Its panels show support tickets, customers, help articles, and macros (saved replies).";

/** Total time for one Jev round. Below the browser's patience with a margin, so the fallback still arrives in time. */
export const BUDGET_MS = 4_500;

export interface AppDeps {
  /** Null when no key is set: every answer is the fallback, labeled no_key. */
  client: Pick<TypeSafeClient, "systemOne"> | null;
  now?: () => number;
}

export function createApp(deps: AppDeps) {
  const app = new Hono();
  const allow = createRateLimiter(undefined, undefined, deps.now);

  // Only the app on this machine may spend the key (see checkRequest in @attune/server).
  app.use("/api/*", async (c, next) => {
    const refused = checkRequest(
      { host: c.req.header("host"), origin: c.req.header("origin"), contentType: c.req.header("content-type") },
      { requireJson: c.req.method === "POST" },
    );
    if (refused) return c.json({ error: refused.error }, refused.status);
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true, jev: deps.client !== null }));

  app.post("/api/adapt", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "Request body is too large." }, 413) }), async (c) => {
    if (!allow()) return c.json({ error: "Too many requests." }, 429);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "The body is not valid JSON." }, 400);
    }
    const parsed = parseAdaptRequest(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const { version, snapshot, command } = parsed.request;
    const { state, questions } = buildRound(CATALOG, { app: APP_DESCRIPTION, snapshot, command: command ?? null });
    const round = await askJev({
      client: deps.client,
      state,
      questions,
      read: (answers) => readRound(answers, questions, CATALOG),
      fallback: { name: "fallback", answer: () => neutralJudgments(CATALOG, command ? { command } : {}) },
      budgetMs: BUDGET_MS,
      signal: c.req.raw.signal,
      logTag: `[adapt] v${version}`,
      noKeyError: "No Jev API key is set (JEV_API_KEY in apps/playground/.env)",
    });
    return c.json({ version, ...round });
  });

  return app;
}
