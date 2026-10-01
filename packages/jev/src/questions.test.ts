import { commandActivityLine, LAYOUT_MODES, PANEL_UNCLEAR } from "@attune/core";
import type { Question } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { buildCoreCommandQuestions, buildCoreQuestions, buildCoreState, CORE_QUESTION_IDS, nowEvidence, relevancePanel } from "./questions.ts";
import { writingCatalog } from "./test-catalog.ts";

const snapshot = {
  recent_activity: ["Opened the Drafts panel", "Opened draft \"Bees\""],
  current_focus: "Drafts panel, editing \"Bees\"",
  visible_panels: ["Drafts", "Sources"],
  behavior_observations: [],
};

function optionsOf(questions: Record<string, Question>, id: string): string[] {
  const q = questions[id];
  if (!q || q.type !== "choice") throw new Error(`${id} is not a choice`);
  return Object.keys(q.criteria);
}

describe("buildCoreState", () => {
  it("splits off the newest activity and fills the empty fields with words", () => {
    expect(buildCoreState({ app: "A writing app.", snapshot })).toEqual({
      app: "A writing app.",
      earlier_activity: ["Opened the Drafts panel"],
      latest_activity: 'Opened draft "Bees"',
      current_focus: 'Drafts panel, editing "Bees"',
      visible_panels: ["Drafts", "Sources"],
      behavior_observations: ["Nothing notable yet."],
    });
  });

  it("trims the command and drops its own activity line, so it is not said twice", () => {
    const state = buildCoreState({ app: "A writing app.", snapshot: { ...snapshot, recent_activity: [...snapshot.recent_activity, commandActivityLine("cite bees")] }, command: "  cite bees " });
    expect(state.command).toBe("cite bees");
    expect(state.latest_activity).toBe('Opened draft "Bees"');
    const first = buildCoreState({ app: "A writing app.", snapshot: { ...snapshot, recent_activity: [commandActivityLine("cite bees")] }, command: "cite bees" });
    expect(first.latest_activity).toBe("No earlier activity. The command is the first thing the user did.");
  });
});

describe("buildCoreQuestions", () => {
  it("asks the core questions in order, with the catalog's goals, panels, and actions", () => {
    const catalog = writingCatalog();
    const questions = buildCoreQuestions(catalog, { hasCommand: false });
    expect(Object.keys(questions)).toEqual(["goal", "rel_drafts", "rel_sources", "struggling", "layout", "expertise", "next_action"]);
    expect(optionsOf(questions, CORE_QUESTION_IDS.goal)).toEqual(["write", "research", "unclear"]);
    expect(optionsOf(questions, CORE_QUESTION_IDS.layout)).toEqual([...LAYOUT_MODES]);
    expect(optionsOf(questions, CORE_QUESTION_IDS.nextAction)).toEqual(["cite_source", "none"]);
    expect(relevancePanel(catalog, "rel_sources")).toBe("sources");
    expect(relevancePanel(catalog, "rel_inbox")).toBeNull();
    expect(relevancePanel(catalog, "goal")).toBeNull();
  });

  it("sends a goal's notFor only when the catalog has them", () => {
    const plain = buildCoreQuestions(writingCatalog(), { hasCommand: false })[CORE_QUESTION_IDS.goal];
    const hinted = buildCoreQuestions(writingCatalog(true), { hasCommand: false })[CORE_QUESTION_IDS.goal];
    expect(plain.type === "choice" && plain.criteria.write).toEqual({ goal: "Writing", what: "Writing or editing a draft." });
    expect(hinted.type === "choice" && hinted.criteria.write).toEqual({ goal: "Writing", what: "Writing or editing a draft.", not_for: "Reading a source without writing." });
  });

  it("points the evidence at the command when there is one", () => {
    expect(nowEvidence(true)).toMatchObject({ read: ["`command`", "`latest_activity`", "`current_focus`", "`earlier_activity`"] });
    expect(nowEvidence(false)).toMatchObject({ read: ["`latest_activity`", "`current_focus`", "`earlier_activity`"] });
  });
});

describe("buildCoreCommandQuestions", () => {
  it("offers every panel plus the no-match panel, and every action", () => {
    const questions = buildCoreCommandQuestions(writingCatalog());
    expect(optionsOf(questions, CORE_QUESTION_IDS.command.panel)).toEqual(["drafts", "sources", PANEL_UNCLEAR]);
    expect(optionsOf(questions, CORE_QUESTION_IDS.command.action)).toEqual(["cite_source", "none"]);
  });

  it("sends example commands on every option or on none, and the app's rule when given", () => {
    const plain = buildCoreCommandQuestions(writingCatalog())[CORE_QUESTION_IDS.command.panel];
    const hinted = buildCoreCommandQuestions(writingCatalog(true), { panelRule: "A bare title asks to open that draft." })[CORE_QUESTION_IDS.command.panel];
    if (plain.type !== "choice" || hinted.type !== "choice") throw new Error("not choices");
    for (const option of Object.values(plain.criteria)) expect(option).not.toHaveProperty("examples");
    for (const option of Object.values(hinted.criteria)) expect(option).toHaveProperty("examples");
    expect(plain.instructions).not.toHaveProperty("rule");
    expect(hinted.instructions).toMatchObject({ rule: "A bare title asks to open that draft." });
  });
});
