import { APIError, APITimeoutError, APIUserAbortError, type TypeSafeClient } from "@typesafe-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { JevAnswerError } from "./answers.ts";
import { askJev, describeJevError, type AskJevInput } from "./ask.ts";

type Client = Pick<TypeSafeClient, "systemOne">;

/** A fake client that answers with `answers`. */
function answering(answers: unknown): Client {
  return {
    systemOne: () => ({ withResponse: async () => ({ data: { model: "jev-1.13.0", answers, usage: { input_tokens: 900, output_tokens: 8 } }, requestId: "req-1" }) }),
  } as unknown as Client;
}

/** A fake client whose call fails with `err`. */
function failing(err: unknown): Client {
  return { systemOne: () => ({ withResponse: async () => Promise.reject(err) }) } as unknown as Client;
}

/** A fake client whose call only ends when its signal aborts. */
function stalled(): Client {
  return {
    systemOne: (_request: unknown, opts: { signal: AbortSignal }) => ({
      withResponse: () => new Promise((_resolve, reject) => opts.signal.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true })),
    }),
  } as unknown as Client;
}

function input(client: Client | null, extra: Partial<AskJevInput<{ n: number }, "rules">> = {}): AskJevInput<{ n: number }, "rules"> {
  return {
    client,
    state: { app: "A writing app." },
    questions: {},
    read: (answers) => {
      if (typeof answers !== "object" || answers === null || !("n" in answers)) throw new JevAnswerError('Jev answer "n" is missing');
      return { n: Number((answers as { n: unknown }).n) };
    },
    fallback: { name: "rules", answer: () => ({ n: -1 }) },
    budgetMs: 1_000,
    logTag: "[test] v1",
    warn: vi.fn(),
    ...extra,
  };
}

describe("askJev", () => {
  it("reads Jev's answers and reports the model, tokens, and request id", async () => {
    const round = await askJev(input(answering({ n: 3 })));
    expect(round).toMatchObject({ source: "jev", judgments: { n: 3 }, meta: { model: "jev-1.13.0", usage: { input_tokens: 900, output_tokens: 8 }, requestId: "req-1", questionCount: 0 } });
    expect(round.meta).not.toHaveProperty("fallback");
    expect(round.debug).toEqual({ state: { app: "A writing app." }, questions: {} });
  });

  it("answers with the fallback, labeled no_key and not logged, without a client", async () => {
    const i = input(null, { noKeyError: "No key in .env" });
    const round = await askJev(i);
    expect(round).toMatchObject({ source: "rules", judgments: { n: -1 }, meta: { model: "rules", fallback: "no_key", error: "No key in .env" } });
    expect(i.warn).not.toHaveBeenCalled();
  });

  it("answers with the fallback, labeled jev_error and logged once, when the answers do not fit", async () => {
    const i = input(answering({}));
    const round = await askJev(i);
    expect(round).toMatchObject({ source: "rules", meta: { fallback: "jev_error", error: 'Jev answer "n" is missing' } });
    expect(i.warn).toHaveBeenCalledWith('[test] v1 Jev failed, using rules: Jev answer "n" is missing');
  });

  it("stops at the total budget", async () => {
    const i = input(stalled(), { budgetMs: 40 });
    const started = Date.now();
    const round = await askJev(i);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(round.meta).toMatchObject({ fallback: "jev_error", error: "Jev did not answer within 40 ms" });
    expect(i.warn).toHaveBeenCalledTimes(1);
  });

  it("does not log a call the app cancelled", async () => {
    const cancel = new AbortController();
    const i = input(stalled(), { signal: cancel.signal });
    const pending = askJev(i);
    cancel.abort();
    const round = await pending;
    expect(round.meta).toMatchObject({ fallback: "jev_error", error: "Request was cancelled" });
    expect(i.warn).not.toHaveBeenCalled();
  });

  it("logs an HTTP error with its status", async () => {
    const i = input(failing(new APIError(503, {}, new Headers())));
    const round = await askJev(i);
    expect(round.meta.error).toMatch(/^Jev returned HTTP 503/);
  });
});

describe("describeJevError", () => {
  it("names each failure without the key", () => {
    expect(describeJevError(new APITimeoutError(4000))).toBe("Jev timed out after 4000 ms");
    expect(describeJevError(new APIUserAbortError())).toBe("Request was cancelled");
    expect(describeJevError(new TypeError("fetch failed"))).toBe("TypeError: fetch failed");
    expect(describeJevError("boom")).toBe("Unknown error");
  });
});
