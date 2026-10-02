import { describe, expect, it } from "vitest";
import { JevAnswerError } from "./answers.ts";
import { buildRound, readRound } from "./round.ts";
import { writingCatalog } from "./test-catalog.ts";

const snapshot = { recent_activity: ['Typed in the command bar: "show sources"'], current_focus: null, visible_panels: ["Drafts"], behavior_observations: [] };

describe("buildRound and readRound", () => {
  it("asks the command questions only with a command", () => {
    const plain = buildRound(writingCatalog(), { app: "A writing app.", snapshot });
    expect(Object.keys(plain.questions)).not.toContain("cmd_panel");
    const withCommand = buildRound(writingCatalog(), { app: "A writing app.", snapshot, command: "show sources" });
    expect(withCommand.state.command).toBe("show sources");
    expect(withCommand.state.latest_activity).toBe("No earlier activity. The command is the first thing the user did.");
    expect(Object.keys(withCommand.questions).slice(-2)).toEqual(["cmd_panel", "cmd_action"]);
  });

  it("reads the core and command judgments, and refuses answers that are not an object", () => {
    const catalog = writingCatalog();
    const { questions } = buildRound(catalog, { app: "A writing app.", snapshot, command: "show sources" });
    const choice = (c: string) => ({ type: "choice", choice: c, confidence: 0.8, probabilities: { [c]: 0.8 } });
    const score = (n: number) => ({ type: "score", score: 1, confidence: 0.7, probabilities: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), 1 / n])) });
    const answers = { goal: choice("write"), rel_drafts: score(4), rel_sources: score(4), struggling: { type: "noul", noul: 0.2 }, layout: choice("focus"), expertise: score(3), next_action: choice("none"), cmd_panel: choice("sources"), cmd_action: choice("none") };
    const j = readRound(answers, questions, catalog);
    expect(j.goal.choice).toBe("write");
    expect(j.command?.panel.choice).toBe("sources");
    expect(() => readRound(null, questions, catalog)).toThrow(JevAnswerError);
  });
});
