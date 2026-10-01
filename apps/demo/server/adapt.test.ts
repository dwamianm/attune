/**
 * adapt() must always answer inside the browser's timeout, and say whether a
 * heuristic answer is the designed no-key mode or a real Jev failure.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIENT_NAMES } from "../shared/fixtures.ts";
import type { AdaptRequest, PrepRequest } from "../shared/types.ts";

const client = { current: null as unknown };
vi.mock("./jev.ts", () => ({ getJevClient: () => client.current }));

const { adapt, prep, ADAPT_BUDGET_MS } = await import("./adapt.ts");
const { ADAPT_TIMEOUT_MS } = await import("../src/engine/api.ts");

const req: AdaptRequest = {
  version: 4,
  snapshot: { recent_activity: ["Opened invoice INV-1042 in Invoices"], current_focus: null, visible_panels: ["Invoices"], behavior_observations: [] },
  candidates: { clients: [...CLIENT_NAMES] },
};

/** A fake TypeSafe client whose call only ends when its signal aborts, like a stalled 503 retry or a long Retry-After. */
function stalledClient() {
  return {
    systemOne: (_payload: unknown, opts: { signal: AbortSignal }) => ({
      withResponse: () =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        }),
    }),
  };
}

afterEach(() => {
  client.current = null;
  vi.restoreAllMocks();
});

describe("adapt", () => {
  it("marks the no-key heuristic as the offline mode, not an error", async () => {
    client.current = null;
    const res = await adapt(req);
    expect(res.source).toBe("heuristic");
    expect(res.meta.fallback).toBe("no_key");
  });

  it("stops waiting for Jev at its total budget and answers with the heuristic", async () => {
    client.current = stalledClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const started = Date.now();
    const res = await adapt(req, { budgetMs: 60 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res).toMatchObject({ source: "heuristic", meta: { fallback: "jev_error", error: "Jev did not answer within 60 ms" } });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps the server budget below the browser's timeout", () => {
    expect(ADAPT_BUDGET_MS + 1_000).toBeLessThanOrEqual(ADAPT_TIMEOUT_MS);
  });
});

describe("prep (focus aid 4, POST /api/prep)", () => {
  const prepReq: PrepRequest = {
    version: 7,
    meeting: { title: "Harbor rebrand review", client: "Harbor Coffee Co.", time: "starts in 12 minutes, at 11:00 today", kind: "meeting" },
    records: [
      { id: "invoice:INV-1042", kind: "invoice", panel: "invoices", fields: { id: "INV-1042", client: "Harbor Coffee Co.", status: "overdue" } },
      { id: "message:m-10", kind: "message", panel: "inbox", fields: { from: "Riley Chen", client: "No client company", status: "read" } },
    ],
  };
  const score = (p: number[]) => ({ type: "score", score: p.reduce((s, x, i) => s + x * i, 0), confidence: 0.9, probabilities: Object.fromEntries(p.map((x, i) => [String(i), x])) });
  function answering(answers: Record<string, unknown>) {
    return {
      systemOne: () => ({
        withResponse: async () => ({ data: { model: "jev-1.13.0", answers, usage: { input_tokens: 2100, output_tokens: 12 } }, requestId: "req-prep" }),
      }),
    };
  }

  it("answers with the heuristic, labeled offline, without a key", async () => {
    client.current = null;
    const res = await prep(prepReq);
    expect(res).toMatchObject({ version: 7, source: "heuristic", meta: { model: "heuristic", fallback: "no_key", questionCount: 3 } });
    expect(Object.keys(res.judgments.scores)).toEqual(["invoice:INV-1042", "message:m-10"]);
    expect(res.debug.state).toEqual({ meeting: prepReq.meeting });
  });

  it("reads Jev's answers into one Score per record and the anything-urgent Noul", async () => {
    client.current = answering({ prep_record_0: score([0, 0, 1]), prep_record_1: score([1, 0, 0]), anything_urgent: { type: "noul", noul: 0.9 } });
    const res = await prep(prepReq);
    expect(res).toMatchObject({ source: "jev", meta: { model: "jev-1.13.0", requestId: "req-prep", usage: { input_tokens: 2100 }, questionCount: 3 } });
    expect(res.judgments.scores["invoice:INV-1042"].score).toBe(2);
    expect(res.judgments.scores["message:m-10"].score).toBe(0);
    expect(res.judgments.anythingUrgent).toBe(0.9);
  });

  it("falls back to the heuristic on a bad answer or at the budget, labeled as a Jev error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    client.current = answering({ prep_record_0: score([0, 0, 1]) });
    const bad = await prep(prepReq);
    expect(bad).toMatchObject({ source: "heuristic", meta: { fallback: "jev_error" } });
    expect(bad.meta.error).toMatch(/prep_record_1" is missing/);
    client.current = stalledClient();
    const slow = await prep(prepReq, { budgetMs: 60 });
    expect(slow).toMatchObject({ source: "heuristic", meta: { fallback: "jev_error", error: "Jev did not answer within 60 ms" } });
    expect(warn).toHaveBeenCalledTimes(2);
  });
});

