/**
 * The only place the browser talks to the Node server.
 *
 * The TypeSafe key lives on the server, so the client posts snapshots to
 * /api/adapt (Vite proxies it in development). Every call has a timeout and
 * honors an outside AbortSignal, so the scheduler can replace a stale request.
 */
import type { AdaptRequest, AdaptResponse, PrepRequest, PrepResponse } from "../../shared/types.ts";

/** Give up on /api/adapt after this long. Jev usually answers in well under a second. */
export const ADAPT_TIMEOUT_MS = 6_000;
/** Health checks are cheap; fail fast. */
export const HEALTH_TIMEOUT_MS = 3_000;
/** Same origin by default; Vite proxies /api to the Node server. */
export const API_BASE = "";

export type ApiErrorKind = "timeout" | "aborted" | "http" | "network" | "invalid";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  /** The server's own reason, from an error body such as {"error": "..."}. */
  readonly detail?: string;
  constructor(kind: ApiErrorKind, message: string, status?: number, detail?: string) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    if (status !== undefined) this.status = status;
    if (detail) this.detail = detail;
  }
}

/**
 * What the command bar says when a command request fails. Only a network
 * failure is "could not reach"; a 400 says why, so the user does not retry
 * the same text forever.
 */
export function commandFailureMessage(err: unknown): string {
  if (err instanceof ApiError) {
    switch (err.kind) {
      case "timeout":
        return "The server took too long to answer. Try again.";
      case "http":
        if (err.status !== undefined && err.status >= 400 && err.status < 500) {
          return err.detail ? `The server could not use that command: ${err.detail.replace(/\.$/, "")}.` : "The server could not use that command.";
        }
        return "The server had a problem. Try again.";
      case "invalid":
        return "The server sent an answer the app could not read. Try again.";
      default:
        break;
    }
  }
  return "Could not reach the server. Try again.";
}

/** True when the request was cancelled on purpose (replaced or reset), which is not a failure. */
export function isAbortError(err: unknown): boolean {
  return (err instanceof ApiError && err.kind === "aborted") || (err instanceof Error && err.name === "AbortError");
}

export interface HealthInfo {
  ok: boolean;
  /** False when the server has no Jev key or cannot reach TypeSafe; it then answers with its heuristic. */
  jev: boolean | null;
  model?: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function requestJson(path: string, init: RequestInit, opts: RequestOptions, defaultTimeout: number): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMs = opts.timeoutMs ?? defaultTimeout;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const outer = opts.signal;
  const onAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const res = await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal });
    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as { error?: unknown };
        if (typeof body?.error === "string") detail = body.error;
      } catch {
        // Body was not JSON; the status code is enough.
      }
      throw new ApiError("http", `Server answered ${res.status}${detail ? `: ${detail}` : ""}`, res.status, detail);
    }
    try {
      return await res.json();
    } catch {
      throw new ApiError("invalid", "Server sent a response that is not JSON");
    }
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (timedOut) throw new ApiError("timeout", `No answer from the server after ${Math.round(timeoutMs / 1000)} seconds`);
    if (controller.signal.aborted) throw new ApiError("aborted", "Request cancelled");
    throw new ApiError("network", "Cannot reach the local server");
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", onAbort);
  }
}

/** POST /api/adapt: the snapshot in, typed judgments out. */
export async function postAdapt(body: AdaptRequest, opts: RequestOptions = {}): Promise<AdaptResponse> {
  const data = await requestJson(
    "/api/adapt",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    opts,
    ADAPT_TIMEOUT_MS,
  );
  const res = data as Partial<AdaptResponse> | null;
  if (!res || typeof res.version !== "number" || !res.judgments) throw new ApiError("invalid", "Server sent an incomplete answer");
  return res as AdaptResponse;
}

/**
 * POST /api/prep (focus aid 4): a meeting and the client's records in, one
 * Score per record and the anything-urgent Noul out. Same timeout as adapt:
 * the server's budget and heuristic fallback are the same.
 */
export async function postPrep(body: PrepRequest, opts: RequestOptions = {}): Promise<PrepResponse> {
  const data = await requestJson(
    "/api/prep",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    opts,
    ADAPT_TIMEOUT_MS,
  );
  const res = data as Partial<PrepResponse> | null;
  if (!res || typeof res.version !== "number" || !res.judgments || typeof res.judgments.scores !== "object") throw new ApiError("invalid", "Server sent an incomplete answer");
  return res as PrepResponse;
}

/** GET /api/health. `jev` is null when the server did not say. */
export async function getHealth(opts: RequestOptions = {}): Promise<HealthInfo> {
  const data = (await requestJson("/api/health", { method: "GET" }, opts, HEALTH_TIMEOUT_MS)) as Record<string, unknown> | null;
  return {
    ok: data?.ok !== false,
    jev: typeof data?.jev === "boolean" ? data.jev : null,
    ...(typeof data?.model === "string" ? { model: data.model } : {}),
  };
}

/** Waits between health checks while the server does not answer: quick at first, then every 30 s. */
export const HEALTH_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000];

export type HealthResult = { ok: true; info: HealthInfo } | { ok: false; error: unknown; retryInMs: number };

export interface HealthWatchOptions {
  onResult: (result: HealthResult) => void;
  /** Defaults to getHealth; tests pass a fake. */
  check?: () => Promise<HealthInfo>;
  delays?: readonly number[];
}

/**
 * Check /api/health now and, while it fails, again with backoff until the
 * server answers, so the status recovers when the server starts after the
 * page. Stops after the first answer. Returns a function that stops it.
 */
export function watchHealth(opts: HealthWatchOptions): () => void {
  const check = opts.check ?? (() => getHealth());
  const delays = opts.delays ?? HEALTH_RETRY_DELAYS_MS;
  let stopped = false;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const run = async (): Promise<void> => {
    timer = null;
    try {
      const info = await check();
      if (!stopped) opts.onResult({ ok: true, info });
    } catch (error) {
      if (stopped) return;
      const retryInMs = delays[Math.min(attempt, delays.length - 1)] ?? 30_000;
      attempt += 1;
      opts.onResult({ ok: false, error, retryInMs });
      if (!stopped) timer = setTimeout(() => void run(), retryInMs);
    }
  };
  void run();
  return () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
}
