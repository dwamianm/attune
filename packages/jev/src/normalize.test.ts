import { describe, expect, it } from "vitest";
import { certainChoice, choiceOptions, JevAnswerError, readChoice, readNoul, readScore, scoreLevels } from "./answers.ts";
import { readCoreCommand, readCoreJudgments } from "./normalize.ts";
import { buildCoreCommandQuestions, buildCoreQuestions } from "./questions.ts";
import { writingCatalog } from "./test-catalog.ts";

const choiceAnswer = (choice: string, probabilities: Record<string, number>) => ({ type: "choice", choice, confidence: 0.8, probabilities });
const scoreAnswer = (score: number, levels: number) => ({ type: "score", score, confidence: 0.7, probabilities: Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), 1 / levels])) });

describe("the answer readers", () => {
  it("reads a Choice, with a left-out option as zero", () => {
    expect(readChoice({ q: choiceAnswer("b", { b: 0.9 }) }, "q", ["a", "b"])).toEqual({ choice: "b", confidence: 0.8, probabilities: { a: 0, b: 0.9 } });
  });

  it("refuses a pick that was not offered, a missing answer, or the wrong type", () => {
    expect(() => readChoice({ q: choiceAnswer("c", {}) }, "q", ["a", "b"])).toThrow(JevAnswerError);
    expect(() => readChoice({}, "q", ["a"])).toThrow('Jev answer "q" is missing');
    expect(() => readChoice({ q: { type: "noul", noul: 0.5 } }, "q", ["a"])).toThrow('expected "choice"');
  });

  it("reads a Score on its levels and a Noul from 0 to 1", () => {
    expect(readScore({ q: scoreAnswer(1.5, 3) }, "q", 3)).toMatchObject({ score: 1.5, max: 2, probabilities: [1 / 3, 1 / 3, 1 / 3] });
    expect(() => readScore({ q: { ...scoreAnswer(1, 3), probabilities: { "5": 1 } } }, "q", 3)).toThrow('unknown level "5"');
    expect(readNoul({ q: { type: "noul", noul: 0.25 } }, "q")).toBe(0.25);
    expect(() => readNoul({ q: { type: "noul", noul: 2 } }, "q")).toThrow("expected a number from 0 to 1");
  });

  it("knows a sure answer, and the options and levels a question was asked with", () => {
    expect(certainChoice("none", ["a", "none"])).toEqual({ choice: "none", confidence: 1, probabilities: { a: 0, none: 1 } });
    const questions = buildCoreQuestions(writingCatalog(), { hasCommand: false });
    expect(choiceOptions(questions, "goal")).toEqual(["write", "research", "unclear"]);
    expect(scoreLevels(questions, "rel_drafts")).toBe(4);
    expect(() => choiceOptions(questions, "rel_drafts")).toThrow('Question "rel_drafts" was not asked as a choice');
  });
});

describe("readCoreJudgments", () => {
  const catalog = writingCatalog();
  const questions = buildCoreQuestions(catalog, { hasCommand: false });
  const answers = {
    goal: choiceAnswer("research", { write: 0.2, research: 0.7, unclear: 0.1 }),
    rel_drafts: scoreAnswer(1, 4),
    rel_sources: scoreAnswer(3, 4),
    struggling: { type: "noul", noul: 0.1 },
    layout: choiceAnswer("compare", { compare: 0.6 }),
    expertise: scoreAnswer(1, 3),
    next_action: choiceAnswer("cite_source", { cite_source: 0.8, none: 0.2 }),
  };

  it("reads every core judgment against the app's catalog", () => {
    const j = readCoreJudgments(answers, questions, catalog);
    expect(j.goal.choice).toBe("research");
    expect(Object.keys(j.relevance)).toEqual(["drafts", "sources"]);
    expect(j.relevance.sources).toMatchObject({ score: 3, max: 3 });
    expect(j.struggling).toBe(0.1);
    expect(j.layout.probabilities).toEqual({ focus: 0, compare: 0.6, overview: 0 });
    expect(j.expertise.max).toBe(2);
    expect(j.nextAction.choice).toBe("cite_source");
  });

  it("refuses a goal or panel the catalog does not have", () => {
    expect(() => readCoreJudgments({ ...answers, goal: choiceAnswer("triage_inbox", {}) }, questions, catalog)).toThrow(JevAnswerError);
    const { rel_sources: _gone, ...missing } = answers;
    expect(() => readCoreJudgments(missing, questions, catalog)).toThrow('Jev answer "rel_sources" is missing');
  });

  it("reads the command panel, the no-match panel included, and the action", () => {
    const commandQuestions = buildCoreCommandQuestions(catalog);
    expect(Object.keys(commandQuestions)).toEqual(["cmd_panel", "cmd_action"]);
    const j = readCoreCommand({ cmd_panel: choiceAnswer("unclear", { unclear: 0.9 }), cmd_action: choiceAnswer("none", { none: 1 }) }, catalog);
    expect(j.panel).toEqual({ choice: "unclear", confidence: 0.8, probabilities: { drafts: 0, sources: 0, unclear: 0.9 } });
    expect(j.action.choice).toBe("none");
  });
});
