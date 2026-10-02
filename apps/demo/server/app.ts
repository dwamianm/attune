/**
 * The API routes, apart from starting the server (index.ts), so tests can
 * call them through the real guard, rate limits, and validation with
 * app.request() and no open port.
 *
 * Every /api route answers only the app on this machine (the guard in
 * @attuneui/server), and each Jev route has its own rate limit and a capped,
 * validated body.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { adapt as runAdapt, prep as runPrep } from "./adapt.ts";
import { config, hasJevKey } from "./env.ts";
import { checkRequest, createRateLimiter, EDGE_SECRET_HEADER, type EdgeAccess } from "@attuneui/server";
import { parseAdaptRequest, parsePrepRequest } from "./validate.ts";

/**
 * The /api/prep limit (focus aid 4): a prep request goes out once per
 * meeting, again only when its records change, so 4 in any 2 s only ever
 * stops a loop. Its own window, so prep never takes an adapt round's turn.
 */
export const PREP_RATE_MAX = 4;
export const PREP_RATE_WINDOW_MS = 2_000;

/** Largest body either Jev route reads: a full snapshot with candidates is about 10 kB. */
export const MAX_BODY_BYTES = 64 * 1024;

export interface AppDeps {
  adapt?: typeof runAdapt;
  prep?: typeof runPrep;
  /** Clock for the rate limits (tests). */
  now?: () => number;
  /** The deployed copy behind CloudFront (lambda.ts). Without it, only loopback is answered. */
  edge?: EdgeAccess;
}

export function createApp(deps: AppDeps = {}): Hono {
  const adapt = deps.adapt ?? runAdapt;
  const prep = deps.prep ?? runPrep;
  const app = new Hono();
  const allowAdapt = createRateLimiter(undefined, undefined, deps.now);
  const allowPrep = createRateLimiter(PREP_RATE_MAX, PREP_RATE_WINDOW_MS, deps.now);
  const limit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: "Request body is too large." }, 413) });

  // Only the app on this machine (or, deployed, the site behind CloudFront) may call the API (see checkRequest in @attuneui/server).
  app.use("/api/*", async (c, next) => {
    const refused = checkRequest(
      {
        host: c.req.header("host"),
        origin: c.req.header("origin"),
        contentType: c.req.header("content-type"),
        edgeSecret: c.req.header(EDGE_SECRET_HEADER),
      },
      { requireJson: c.req.method === "POST", edge: deps.edge },
    );
    if (refused) return c.json({ error: refused.error }, refused.status);
    await next();
  });

  app.get("/api/health", (c) => c.json({ ok: true, jev: hasJevKey(), model: config.model }));

  app.post("/api/adapt", limit, async (c) => {
    if (!allowAdapt()) return c.json({ error: "Too many requests. Wait a moment." }, 429);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be valid JSON." }, 400);
    }
    const parsed = parseAdaptRequest(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const req = parsed.value;
    // Aborts when the browser disconnects, which cancels the Jev call too.
    const signal = c.req.raw.signal;
    const res = await adapt(req, { signal });
    const tokens = res.meta.usage ? `${res.meta.usage.input_tokens} in` : "no tokens";
    const cancelled = signal.aborted ? " (client gone)" : "";
    console.log(
      `[adapt] v${req.version} ${res.source} ${res.meta.latencyMs} ms ${tokens} command=${req.command ? "yes" : "no"}${cancelled}`,
    );
    return c.json(res);
  });

  // Focus aid 4: rank a meeting's records, behind the same guard and the same kind of limit and validation.
  app.post("/api/prep", limit, async (c) => {
    if (!allowPrep()) return c.json({ error: "Too many requests. Wait a moment." }, 429);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Body must be valid JSON." }, 400);
    }
    const parsed = parsePrepRequest(body);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const req = parsed.value;
    const signal = c.req.raw.signal;
    const res = await prep(req, { signal });
    const tokens = res.meta.usage ? `${res.meta.usage.input_tokens} in` : "no tokens";
    const cancelled = signal.aborted ? " (client gone)" : "";
    console.log(`[prep] v${req.version} ${res.source} ${res.meta.latencyMs} ms ${tokens} records=${req.records.length}${cancelled}`);
    return c.json(res);
  });

  app.notFound((c) => c.json({ error: "Not found." }, 404));

  app.onError((err, c) => {
    console.error(`[server] ${err instanceof Error ? err.message : String(err)}`);
    return c.json({ error: "Internal server error." }, 500);
  });

  return app;
}
