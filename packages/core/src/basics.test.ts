/** The defaults an app gets for free: usage weights, suggestions, link tags, and the calm fallback. */
import { describe, expect, it } from "vitest";
import { defineCatalog } from "./catalog.ts";
import { neutralJudgments, panelNamedIn } from "./fallback.ts";
import type { ChoiceJudgment } from "./judgments.ts";
import { basicRelation, basicSuggestions, SUGGEST_PRIMARY_AT, SUGGEST_SUBTLE_AT } from "./suggestions.ts";
import { CORE_USAGE_WEIGHTS, DWELL_MAX_WEIGHT, eventWeight } from "./usage.ts";

type P = "tickets" | "articles";
type G = "answer" | "unclear";
type A = "reply" | "send" | "none";
const catalog = defineCatalog<P, G, A>({
  panelIds: ["tickets", "articles"],
  panels: {
    tickets: { id: "tickets", title: "Tickets", description: "Tickets.", icon: "Inbox", defaultVisible: true },
    articles: { id: "articles", title: "Articles", description: "Articles.", icon: "Book", defaultVisible: true },
  },
  goalIds: ["answer", "unclear"],
  goals: { answer: { label: "Answering tickets", description: "." }, unclear: { label: "Not sure yet", description: "." } },
  actionIds: ["reply", "send", "none"],
  actions: {
    reply: { id: "reply", label: "Reply to the ticket", description: ".", panel: "tickets" },
    send: { id: "send", label: "Send an article", description: ".", panel: "articles" },
    none: { id: "none", label: "", description: ".", panel: null },
  },
  goalPanelAffinity: { answer: { tickets: 1 }, unclear: {} },
});

const step = (choice: A, confidence: number, probabilities: Partial<Record<A, number>> = {}): ChoiceJudgment<A> => ({ choice, confidence, probabilities: { [choice]: confidence, ...probabilities } as Record<A, number> });
const goal: ChoiceJudgment<G> = { choice: "answer", confidence: 0.9, probabilities: { answer: 0.9, unclear: 0.1 } };

describe("the core usage weights", () => {
  it("count doing more than looking, and a pointer rest by its length", () => {
    expect(CORE_USAGE_WEIGHTS.item_open).toBeGreaterThan(CORE_USAGE_WEIGHTS.panel_focus);
    expect(eventWeight({ type: "panel_dwell", detail: { durationMs: 60_000 } })).toBe(DWELL_MAX_WEIGHT);
    expect(eventWeight({ type: "an_app_type" })).toBe(0);
    expect(eventWeight({ type: "an_app_type" }, { an_app_type: 2 })).toBe(2);
  });
});

describe("basicSuggestions", () => {
  it("offers the model's next step, primary when sure, with a runner-up when unsure", () => {
    expect(basicSuggestions(catalog, { nextAction: step("reply", SUGGEST_PRIMARY_AT), goal })).toEqual([
      { actionId: "reply", label: "Reply to the ticket", prominence: "primary", confidence: SUGGEST_PRIMARY_AT, reason: "Likely next step while answering tickets" },
    ]);
    const unsure = basicSuggestions(catalog, { nextAction: step("reply", SUGGEST_SUBTLE_AT, { send: 0.3 }), goal });
    expect(unsure.map((s) => [s.actionId, s.prominence])).toEqual([
      ["reply", "subtle"],
      ["send", "subtle"],
    ]);
    expect(basicSuggestions(catalog, { nextAction: step("none", 0.9), goal })).toEqual([]);
    expect(basicSuggestions(catalog, { nextAction: step("reply", 0.2), goal })).toEqual([]);
  });

  it("tags a linked panel with the anchor's short name", () => {
    const records = [{ itemKind: "article", itemId: "a-1", label: "Reset" }];
    expect(basicRelation({ panel: "tickets", at: 1, label: "T-1" }, "articles", records, catalog.panels)).toEqual({ anchorPanel: "tickets", tag: "Linked to T-1", reason: "1 linked record", records });
  });
});

describe("neutralJudgments", () => {
  it("rates every panel supporting, with no goal and no next step", () => {
    const j = neutralJudgments(catalog);
    expect(j.goal.choice).toBe("unclear");
    expect(j.relevance.tickets).toMatchObject({ score: 2, max: 3 });
    expect(j.nextAction.choice).toBe("none");
    expect(j.command).toBeUndefined();
  });

  it("finds the panel a command names, in the singular too", () => {
    expect(panelNamedIn(catalog, "open the article about passwords")).toBe("articles");
    expect(neutralJudgments(catalog, { command: "show tickets" }).command?.panel.choice).toBe("tickets");
    expect(neutralJudgments(catalog, { command: "banana" }).command?.panel.choice).toBe("unclear");
  });
});
