/**
 * The /api/prep route (focus aid 4) goes through the same guard as
 * /api/adapt: loopback Host, loopback or no Origin, a JSON body, its own
 * rate limit, and validation before anything reaches Jev. Called with
 * app.request(), so no port opens; Jev is mocked out (no key).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./jev.ts", () => ({ getJevClient: () => null }));

const { createApp, PREP_RATE_MAX, PREP_RATE_WINDOW_MS } = await import("./app.ts");

const meeting = { title: "Harbor rebrand review", client: "Harbor Coffee Co.", time: "starts in 12 minutes, at 11:00 today", kind: "meeting" };
const invoice = { id: "invoice:INV-1042", kind: "invoice", panel: "invoices", fields: { id: "INV-1042", client: "Harbor Coffee Co.", status: "overdue" } };
const body = JSON.stringify({ version: 1, meeting, records: [invoice] });

function post(app: ReturnType<typeof createApp>, path: string, init: { headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return Promise.resolve(
    app.request(path, { method: "POST", headers: { host: "localhost:8790", "content-type": "application/json", ...init.headers }, body: init.body ?? body }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/prep behind the guard", () => {
  it("answers the app on this machine with a ranking (the heuristic, without a key)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await post(createApp(), "/api/prep", { headers: { origin: "http://localhost:5173" } });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { source: string; meta: { fallback: string }; judgments: { scores: Record<string, unknown>; anythingUrgent: number } };
    expect(json.source).toBe("heuristic");
    expect(json.meta.fallback).toBe("no_key");
    expect(Object.keys(json.judgments.scores)).toEqual(["invoice:INV-1042"]);
    expect(json.judgments.anythingUrgent).toBe(0.6);
  });

  it("refuses other hosts, other sites, and bodies not declared JSON, before reading them", async () => {
    const prep = vi.fn();
    const app = createApp({ prep });
    expect((await post(app, "/api/prep", { headers: { host: "attacker.example:8790" } })).status).toBe(403);
    expect((await post(app, "/api/prep", { headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await post(app, "/api/prep", { headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect(prep).not.toHaveBeenCalled();
  });

  it("deployed behind CloudFront, answers only requests that carry the gate's secret", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const prep = vi.fn(async (req: { version: number }) => ({ version: req.version, source: "heuristic", judgments: { scores: {}, anythingUrgent: 0.2 }, meta: { model: "heuristic", latencyMs: 1, questionCount: 0 }, debug: { state: {}, questions: {} } }));
    const app = createApp({ prep: prep as never, edge: { secret: "s3cret-value", origin: "https://attuneui.com" } });
    const host = "abc123.lambda-url.us-west-1.on.aws";
    expect((await post(app, "/api/prep", { headers: { host, origin: "https://attuneui.com" } })).status).toBe(403);
    expect((await post(app, "/api/prep", { headers: { host, origin: "https://evil.example", "x-origin-verify": "s3cret-value" } })).status).toBe(403);
    expect(prep).not.toHaveBeenCalled();
    expect((await post(app, "/api/prep", { headers: { host, origin: "https://attuneui.com", "x-origin-verify": "s3cret-value" } })).status).toBe(200);
    expect(prep).toHaveBeenCalledTimes(1);
  });

  it("refuses a body that does not validate, with the reason, and never asks Jev", async () => {
    const prep = vi.fn();
    const app = createApp({ prep });
    const bad = await post(app, "/api/prep", { body: JSON.stringify({ version: 1, meeting: { ...meeting, client: "Evil Corp" }, records: [invoice] }) });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "meeting.client must be one of the studio's clients." });
    expect((await post(app, "/api/prep", { body: "{not json" })).status).toBe(400);
    expect((await post(app, "/api/prep", { body: "x".repeat(70 * 1024) })).status).toBe(413);
    expect(prep).not.toHaveBeenCalled();
  });

  it("has its own rate limit, apart from /api/adapt's", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let t = 0;
    const prep = vi.fn(async (req: { version: number }) => ({ version: req.version, source: "heuristic", judgments: { scores: {}, anythingUrgent: 0.2 }, meta: { model: "heuristic", latencyMs: 1, questionCount: 0 }, debug: { state: {}, questions: {} } }));
    const adapt = vi.fn();
    const app = createApp({ prep: prep as never, adapt: adapt as never, now: () => t });
    for (let i = 0; i < PREP_RATE_MAX; i++) expect((await post(app, "/api/prep")).status).toBe(200);
    expect((await post(app, "/api/prep")).status).toBe(429);
    // /api/adapt still has its own turn (a bad body gets past the limit to validation).
    expect((await post(app, "/api/adapt", { body: "{}" })).status).toBe(400);
    t = PREP_RATE_WINDOW_MS;
    expect((await post(app, "/api/prep")).status).toBe(200);
    expect(prep).toHaveBeenCalledTimes(PREP_RATE_MAX + 1);
  });
});
