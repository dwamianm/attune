import { describe, expect, it, vi } from "vitest";
import { createApp } from "./app.ts";

const snapshot = { recent_activity: ["Opened ticket T-201 in Tickets"], current_focus: "Tickets panel", visible_panels: ["Tickets", "Customers", "Articles"], behavior_observations: [] };

function post(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.request("/api/adapt", { method: "POST", headers: { host: "localhost:8791", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("the playground API", () => {
  it("answers with the calm fallback, labeled no_key, without a key", async () => {
    const res = await post(createApp({ client: null }), { version: 2, snapshot, command: "show the articles" });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toMatchObject({ version: 2, source: "fallback", meta: { model: "fallback", fallback: "no_key" } });
    expect(json.judgments.goal.choice).toBe("unclear");
    expect(json.judgments.command.panel.choice).toBe("articles");
    expect(Object.keys(json.debug.questions)).toEqual(["goal", "rel_tickets", "rel_customers", "rel_articles", "rel_macros", "struggling", "layout", "expertise", "next_action", "cmd_panel", "cmd_action"]);
  });

  it("reads Jev's answers into the core judgments", async () => {
    const choice = (c: string) => ({ type: "choice", choice: c, confidence: 0.9, probabilities: { [c]: 0.9 } });
    const score = (s: number, n: number) => ({ type: "score", score: s, confidence: 0.8, probabilities: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), 1 / n])) });
    const answers = { goal: choice("answer_tickets"), rel_tickets: score(3, 4), rel_customers: score(1, 4), rel_articles: score(2, 4), rel_macros: score(1, 4), struggling: { type: "noul", noul: 0.1 }, layout: choice("focus"), expertise: score(1, 3), next_action: choice("reply_ticket") };
    const client = { systemOne: () => ({ withResponse: async () => ({ data: { model: "jev-1.13.0", answers, usage: { input_tokens: 800, output_tokens: 9 } }, requestId: "r-1" }) }) };
    const res = await post(createApp({ client: client as never }), { version: 3, snapshot });
    const json = await res.json();
    expect(json).toMatchObject({ source: "jev", meta: { model: "jev-1.13.0", requestId: "r-1" } });
    expect(json.judgments.goal.choice).toBe("answer_tickets");
    expect(json.judgments.relevance.tickets.score).toBe(3);
  });

  it("refuses other hosts, bad bodies, and floods", async () => {
    const app = createApp({ client: null, now: () => 1_000 });
    expect((await post(app, { version: 1, snapshot }, { host: "evil.example" })).status).toBe(403);
    expect((await post(app, { version: "x", snapshot })).status).toBe(400);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const codes: number[] = [];
    for (let i = 0; i < 10; i++) codes.push((await post(app, { version: i, snapshot })).status);
    expect(codes).toContain(429);
  });
});
