/**
 * Fixture System One answers -> Judgments, including the Score probability
 * map ("0".."n" keys) becoming an array, and malformed answers that must
 * throw instead of reaching the layout policy.
 */
import type { Question } from "@typesafe-ai/sdk";
import { describe, expect, it } from "vitest";
import { PANEL_IDS } from "../shared/catalog.ts";
import type { AdaptRequest, PrepRequest, RecordCandidate } from "../shared/types.ts";
import { JevAnswerError } from "@attune/jev";
import { normalizeJudgments, normalizePrepJudgments } from "./normalize.ts";
import { PREP_QUESTION_IDS, QUESTION_IDS, buildPrepQuestions, buildQuestions } from "./questions.ts";

const CLIENTS = ["Harbor Coffee Co.", "Meridian Hotels"];

function request(command?: string, clients = CLIENTS): AdaptRequest {
  return {
    version: 1,
    snapshot: { recent_activity: ["Opened invoice INV-1042"], current_focus: null, visible_panels: [], behavior_observations: [] },
    candidates: { clients },
    ...(command ? { command } : {}),
  };
}

/** A valid answer for every question, shaped like the API's response. */
function fakeAnswers(questions: Record<string, Question>): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      answers[id] = { type: "noul", noul: 0.2 };
    } else if (q.type === "choice") {
      const keys = Object.keys(q.criteria);
      answers[id] = {
        type: "choice",
        choice: keys[0],
        confidence: 0.8,
        probabilities: Object.fromEntries(keys.map((k, i) => [k, i === 0 ? 0.85 : 0.15 / (keys.length - 1)])),
      };
    } else {
      const levels = q.criteria.length;
      answers[id] = {
        type: "score",
        score: levels - 1,
        confidence: 1,
        legend: Object.fromEntries(q.criteria.map((c, i) => [String(i), c])),
        probabilities: Object.fromEntries(q.criteria.map((_, i) => [String(i), i === levels - 1 ? 1 : 0])),
      };
    }
  }
  return answers;
}

describe("normalizeJudgments", () => {
  it("maps a full response into Judgments", () => {
    const questions = buildQuestions(request());
    const answers = fakeAnswers(questions);
    answers[QUESTION_IDS.goal] = {
      type: "choice",
      choice: "collect_payments",
      confidence: 0.91,
      probabilities: { collect_payments: 0.93, manage_client: 0.05, triage_inbox: 0.02 },
    };
    answers[QUESTION_IDS.relevance("invoices")] = {
      type: "score",
      score: 2.5,
      confidence: 0.4,
      legend: { "0": "a", "1": "b", "2": "c", "3": "d" },
      probabilities: { "0": 0.0, "1": 0.1, "2": 0.3, "3": 0.6 },
    };
    answers[QUESTION_IDS.struggling] = { type: "noul", noul: 0.12 };

    const j = normalizeJudgments(answers, questions);

    expect(j.goal.choice).toBe("collect_payments");
    expect(j.goal.confidence).toBe(0.91);
    // Options the API left out come back as zero, so every goal has a number.
    expect(j.goal.probabilities.unclear).toBe(0);
    expect(Object.keys(j.goal.probabilities)).toHaveLength(9);

    expect(j.relevance.invoices).toEqual({ score: 2.5, max: 3, confidence: 0.4, probabilities: [0, 0.1, 0.3, 0.6] });
    for (const panel of PANEL_IDS) expect(j.relevance[panel].probabilities).toHaveLength(4);

    expect(j.expertise.max).toBe(2);
    expect(j.expertise.probabilities).toEqual([0, 0, 1]);
    expect(j.struggling).toBe(0.12);
    expect(j.targetClient.choice).toBe("Harbor Coffee Co.");
    expect(j.command).toBeUndefined();
  });

  it("reads command answers when a command was asked", () => {
    const questions = buildQuestions(request("remind meridian to pay"));
    const answers = fakeAnswers(questions);
    answers[QUESTION_IDS.command.client] = {
      type: "choice",
      choice: "Meridian Hotels",
      confidence: 0.95,
      probabilities: { "Harbor Coffee Co.": 0.01, "Meridian Hotels": 0.97, not_mentioned: 0.02 },
    };
    const j = normalizeJudgments(answers, questions);
    expect(j.command?.client.choice).toBe("Meridian Hotels");
    expect(j.command?.panel.choice).toBe("inbox");
    expect(Object.keys(j.command?.panel.probabilities ?? {})).toContain("unclear");
  });

  it("answers the client questions in code when there were no candidates", () => {
    const questions = buildQuestions(request("atlas", []));
    const j = normalizeJudgments(fakeAnswers(questions), questions);
    expect(j.targetClient).toEqual({ choice: "none", confidence: 1, probabilities: { none: 1 } });
    expect(j.command?.client.choice).toBe("not_mentioned");
  });

  describe("next-record answers", () => {
    const records: RecordCandidate[] = [
      { id: "invoice:INV-1047", kind: "invoice", panel: "invoices", label: "INV-1047 · Kite & Co. · overdue 5 days · $2,650" },
      { id: "message:m-1", kind: "message", panel: "inbox", label: "\"Re: Invoice INV-1042\" from Priya Nair" },
    ];
    const withRecords: AdaptRequest = { ...request(), candidates: { clients: CLIENTS, records } };
    const questions = buildQuestions(withRecords);

    it("reads nextRecord and listWork when they were asked", () => {
      const answers = fakeAnswers(questions);
      answers[QUESTION_IDS.nextRecord] = {
        type: "choice",
        choice: "message:m-1",
        confidence: 0.7,
        probabilities: { "invoice:INV-1047": 0.1, "message:m-1": 0.85, none: 0.05 },
      };
      answers[QUESTION_IDS.listWork] = { type: "noul", noul: 0.91 };
      const j = normalizeJudgments(answers, questions);
      expect(j.nextRecord).toEqual({
        choice: "message:m-1",
        confidence: 0.7,
        probabilities: { "invoice:INV-1047": 0.1, "message:m-1": 0.85, none: 0.05 },
      });
      expect(j.listWork).toBe(0.91);
    });

    it("leaves both out when no candidates were sent", () => {
      const plain = buildQuestions(request());
      const j = normalizeJudgments(fakeAnswers(plain), plain);
      expect(j).not.toHaveProperty("nextRecord");
      expect(j).not.toHaveProperty("listWork");
    });

    it("throws on a record id that was not sent", () => {
      const answers = {
        ...fakeAnswers(questions),
        [QUESTION_IDS.nextRecord]: { type: "choice", choice: "invoice:INV-9999", confidence: 1, probabilities: { "invoice:INV-9999": 1 } },
      };
      expect(() => normalizeJudgments(answers, questions)).toThrow(/"next_record" chose "invoice:INV-9999", which is not one of the options/);
    });

    it("throws on a missing or malformed list-work answer", () => {
      const answers = fakeAnswers(questions);
      delete answers[QUESTION_IDS.listWork];
      expect(() => normalizeJudgments(answers, questions)).toThrow(/"list_work" is missing/);
      const bad = { ...fakeAnswers(questions), [QUESTION_IDS.listWork]: { type: "noul", noul: -0.5 } };
      expect(() => normalizeJudgments(bad, questions)).toThrow(JevAnswerError);
    });
  });

  describe("malformed answers", () => {
    const questions = buildQuestions(request());

    function broken(id: string, answer: unknown): Record<string, unknown> {
      return { ...fakeAnswers(questions), [id]: answer };
    }

    it("throws on a missing answer, naming it", () => {
      const answers = fakeAnswers(questions);
      delete answers[QUESTION_IDS.layout];
      expect(() => normalizeJudgments(answers, questions)).toThrow(JevAnswerError);
      expect(() => normalizeJudgments(answers, questions)).toThrow(/"layout" is missing/);
    });

    it("throws on a choice outside the options", () => {
      const answers = broken(QUESTION_IDS.goal, { type: "choice", choice: "take_a_nap", confidence: 1, probabilities: {} });
      expect(() => normalizeJudgments(answers, questions)).toThrow(/not one of the options/);
    });

    it("throws on the wrong answer type", () => {
      const answers = broken(QUESTION_IDS.struggling, { type: "choice", choice: "yes", confidence: 1, probabilities: { yes: 1 } });
      expect(() => normalizeJudgments(answers, questions)).toThrow(/expected "noul"/);
    });

    it("throws on a Score level that was never asked", () => {
      const answers = broken(QUESTION_IDS.relevance("team"), {
        type: "score",
        score: 1,
        confidence: 1,
        legend: {},
        probabilities: { "0": 0, "1": 1, "7": 0 },
      });
      expect(() => normalizeJudgments(answers, questions)).toThrow(/unknown level "7"/);
    });

    it("throws on out-of-range numbers", () => {
      expect(() => normalizeJudgments(broken(QUESTION_IDS.struggling, { type: "noul", noul: 1.7 }), questions)).toThrow(
        JevAnswerError,
      );
      const badScore = broken(QUESTION_IDS.expertise, { type: "score", score: 5, confidence: 1, legend: {}, probabilities: { "0": 1 } });
      expect(() => normalizeJudgments(badScore, questions)).toThrow(/expected a number from 0 to 2/);
    });

    it("throws when there is no answers object at all", () => {
      expect(() => normalizeJudgments(null, questions)).toThrow(/no answers object/);
    });
  });
});

describe("focus aid 2 answers", () => {
  const withAid: AdaptRequest = {
    ...request(),
    workingGoal: { label: "Collecting payments", description: "Checking unpaid or overdue invoices and getting clients to pay them." },
    candidates: {
      clients: CLIENTS,
      tasks: [
        { id: "unread_messages", goal: "triage_inbox", label: "Unread client messages to reply to", count: "two", first: "\"Re: Invoice INV-1042\" from Priya Nair" },
        { id: "tasks_due_today", goal: "plan_day", label: "To-do items due today", count: "one", first: "Resend INV-1042 (due today)" },
      ],
    },
  };

  it("reads goal done and the next task when they were asked", () => {
    const questions = buildQuestions(withAid);
    const answers = fakeAnswers(questions);
    answers[QUESTION_IDS.goalDone] = { type: "noul", noul: 0.82 };
    const j = normalizeJudgments(answers, questions);
    expect(j.goalDone).toBeCloseTo(0.82);
    expect(j.nextTask?.choice).toBe("unread_messages");
    expect(Object.keys(j.nextTask?.probabilities ?? {}).sort()).toEqual(["none", "tasks_due_today", "unread_messages"]);
  });

  it("reads only what was asked: goal done without task candidates has no next task, and neither without a working goal", () => {
    const goalOnly = buildQuestions({ ...withAid, candidates: { clients: CLIENTS } });
    const j = normalizeJudgments(fakeAnswers(goalOnly), goalOnly);
    expect(j.goalDone).toBeCloseTo(0.2);
    expect(j.nextTask).toBeUndefined();
    const plain = buildQuestions(request());
    const k = normalizeJudgments(fakeAnswers(plain), plain);
    expect(k.goalDone).toBeUndefined();
    expect(k.nextTask).toBeUndefined();
  });

  it("throws on a next task that was not offered, or a goal done outside 0 to 1", () => {
    const questions = buildQuestions(withAid);
    const bad = fakeAnswers(questions);
    bad[QUESTION_IDS.nextTask] = { type: "choice", choice: "overdue_invoices", confidence: 1, probabilities: { overdue_invoices: 1 } };
    expect(() => normalizeJudgments(bad, questions)).toThrow(JevAnswerError);
    const worse = fakeAnswers(questions);
    worse[QUESTION_IDS.goalDone] = { type: "noul", noul: 1.7 };
    expect(() => normalizeJudgments(worse, questions)).toThrow(JevAnswerError);
    const missing = fakeAnswers(questions);
    delete missing[QUESTION_IDS.goalDone];
    expect(() => normalizeJudgments(missing, questions)).toThrow(/goal_done/);
  });
});

describe("normalizeJudgments: the link answers", () => {
  const link: NonNullable<AdaptRequest["link"]> = {
    clicked: { id: "message:m-1", kind: "message", fields: { from: "Priya Nair", text: "Can you resend the invoice?" } },
    records: [{ id: "invoice:INV-1042", kind: "invoice", panel: "invoices", label: "INV-1042" } as RecordCandidate],
  };

  it("reads link-next over the ids sent and link-action over the catalog's actions, only when asked", () => {
    const plain = normalizeJudgments(fakeAnswers(buildQuestions(request())), buildQuestions(request()));
    expect(plain.linkNext).toBeUndefined();
    expect(plain.linkAction).toBeUndefined();
    const questions = buildQuestions({ ...request(), link });
    const answers = fakeAnswers(questions);
    answers[QUESTION_IDS.linkNext] = { type: "choice", choice: "invoice:INV-1042", confidence: 0.9, probabilities: { "invoice:INV-1042": 0.95, none: 0.05 } };
    answers[QUESTION_IDS.linkAction] = { type: "choice", choice: "resend_invoice", confidence: 0.97, probabilities: { resend_invoice: 0.98, none: 0.02 } };
    const j = normalizeJudgments(answers, questions);
    expect(j.linkNext).toMatchObject({ choice: "invoice:INV-1042", probabilities: { "invoice:INV-1042": 0.95, none: 0.05 } });
    expect(j.linkAction).toMatchObject({ choice: "resend_invoice", confidence: 0.97 });
  });

  it("throws on a link-next that picks a record that was not offered", () => {
    const questions = buildQuestions({ ...request(), link });
    const answers = fakeAnswers(questions);
    answers[QUESTION_IDS.linkNext] = { type: "choice", choice: "invoice:INV-9999", confidence: 0.9, probabilities: { "invoice:INV-9999": 1 } };
    expect(() => normalizeJudgments(answers, questions)).toThrow(JevAnswerError);
  });
});

describe("normalizePrepJudgments (focus aid 4)", () => {
  const req: PrepRequest = {
    version: 1,
    meeting: { title: "Harbor rebrand review", client: "Harbor Coffee Co.", time: "starts in 12 minutes, at 11:00 today", kind: "meeting" },
    records: [
      { id: "invoice:INV-1042", kind: "invoice", panel: "invoices", fields: { id: "INV-1042" } },
      { id: "message:m-10", kind: "message", panel: "inbox", fields: { from: "Riley Chen" } },
    ],
  };
  const questions = buildPrepQuestions(req);
  const score = (p: number[]) => ({ type: "score", score: p.reduce((s, x, i) => s + x * i, 0), confidence: 0.9, probabilities: Object.fromEntries(p.map((x, i) => [String(i), x])) });
  const answers = {
    [PREP_QUESTION_IDS.record(0)]: score([0, 0.1, 0.9]),
    [PREP_QUESTION_IDS.record(1)]: score([1, 0, 0]),
    [PREP_QUESTION_IDS.anythingUrgent]: { type: "noul", noul: 0.91 },
  };

  it("keys each record's Score back to its id, and reads the anything-urgent Noul", () => {
    const j = normalizePrepJudgments(answers, questions, req.records);
    expect(Object.keys(j.scores)).toEqual(["invoice:INV-1042", "message:m-10"]);
    expect(j.scores["invoice:INV-1042"]).toMatchObject({ max: 2, probabilities: [0, 0.1, 0.9] });
    expect(j.scores["invoice:INV-1042"].score).toBeCloseTo(1.9);
    expect(j.scores["message:m-10"].score).toBe(0);
    expect(j.anythingUrgent).toBe(0.91);
  });

  it("throws on a missing or malformed answer, so the heuristic answers instead", () => {
    const { [PREP_QUESTION_IDS.record(1)]: _gone, ...missing } = answers;
    void _gone;
    expect(() => normalizePrepJudgments(missing, questions, req.records)).toThrow(JevAnswerError);
    expect(() => normalizePrepJudgments({ ...answers, [PREP_QUESTION_IDS.anythingUrgent]: { type: "noul", noul: 2 } }, questions, req.records)).toThrow(JevAnswerError);
    expect(() => normalizePrepJudgments({ ...answers, [PREP_QUESTION_IDS.record(0)]: { ...score([0, 0, 1]), probabilities: { "3": 1 } } }, questions, req.records)).toThrow(JevAnswerError);
    expect(() => normalizePrepJudgments(null, questions, req.records)).toThrow(JevAnswerError);
  });
});

