/**
 * The help desk engine, headless: the library loop with the playground's
 * catalog, words, and links, against a fake server.
 */
import { neutralJudgments, type AdaptiveRequest, type LayoutMode } from "@attune/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CATALOG, type ActionId, type GoalId } from "./catalog.ts";
import { createDeskStore, type Judgments } from "./engine.ts";

let sent: AdaptiveRequest[] = [];
let answer: (req: AdaptiveRequest) => Judgments = (req) => neutralJudgments(CATALOG, req.command ? { command: req.command } : {});

function desk() {
  return createDeskStore(async (req) => {
    sent.push(req);
    return { version: req.version, source: "jev", judgments: answer(req) };
  });
}

const score = (s: number) => ({ score: s, max: 3, confidence: 0.8, probabilities: [] });
const choice = <K extends string>(c: K, confidence = 0.9) => ({ choice: c, confidence, probabilities: { [c]: confidence } as Record<K, number> });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(5_000_000);
  sent = [];
  answer = (req) => neutralJudgments(CATALOG, req.command ? { command: req.command } : {});
});

afterEach(() => vi.useRealTimers());

describe("the help desk engine", () => {
  it("writes the agent's work in the snapshot, and links the ticket's customer and article", async () => {
    const store = desk();
    answer = () => ({
      ...neutralJudgments(CATALOG),
      goal: choice<GoalId>("answer_tickets"),
      relevance: { tickets: score(3), customers: score(2), articles: score(2.5), macros: score(1) },
      layout: choice<LayoutMode>("focus"),
      nextAction: choice<ActionId>("reply_ticket", 0.8),
    });
    store.track({ type: "item_open", panel: "tickets", detail: { itemKind: "ticket", itemId: "T-201", client: "Larkspur Bakery", label: 'T-201 "Cannot reset my password"', via: "pointer" } });
    await vi.advanceTimersByTimeAsync(800);
    expect(sent[0].snapshot.recent_activity).toEqual(['Opened ticket T-201 "Cannot reset my password" in Tickets']);
    const plan = store.getState().plan;
    expect(store.getState().anchor).toMatchObject({ panel: "tickets", itemId: "T-201", client: "Larkspur Bakery" });
    const tags = Object.fromEntries(plan.placements.filter((p) => p.relation).map((p) => [p.id, p.relation!.records.map((r) => r.itemId)]));
    expect(tags).toEqual({ customers: ["c-larkspur"], articles: ["a-reset"] });
    expect(plan.suggestions.map((s) => s.label)).toEqual(["Reply to the ticket"]);
    store.dispose();
  });

  it("brings the panel a command names to the front with the calm fallback", async () => {
    const store = desk();
    await store.runCommand("show the macros");
    expect(store.getState().command).toEqual({ text: "show the macros", status: "applied", panel: "macros" });
    expect(store.getState().plan.placements[0]).toMatchObject({ id: "macros", size: "hero" });
    store.dispose();
  });
});
