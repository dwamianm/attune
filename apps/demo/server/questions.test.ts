/**
 * Checks the shape of what we send Jev: every id the client relies on is
 * asked, every Choice offers exactly the catalog's options, and speculative
 * command questions appear only when there is a command.
 */
import { describe, expect, it } from "vitest";
import { ACTION_IDS, GOAL_IDS, LAYOUT_MODES, PANEL_IDS } from "../shared/catalog.ts";
import { CLIENT_NAMES } from "../shared/fixtures.ts";
import { INVOICE_STATUS_ARGS, TIMEFRAME_ARGS, type AdaptRequest, type PrepRequest, type RecordCandidate, type TaskCandidate } from "../shared/types.ts";
import {
  CLIENT_NOT_MENTIONED,
  NO_CLIENT,
  NO_RECORD,
  NO_TASK,
  PANEL_UNCLEAR,
  QUESTION_IDS,
  buildQuestions,
  buildState,
  panelFromQuestionId,
  recordCandidates,
  taskCandidates,
  workingGoalOf,
} from "./questions.ts";
import { buildPrepQuestions, buildPrepState, MAX_PREP_RECORDS, PREP_QUESTION_IDS, prepRecordsOf } from "./questions.ts";

function request(overrides: Partial<AdaptRequest> = {}): AdaptRequest {
  return {
    version: 3,
    snapshot: {
      recent_activity: [
        "Clicked into the Invoices panel",
        "Filtered Invoices to status overdue",
        "Opened invoice INV-1042 for Harbor Coffee Co. (overdue 14 days)",
      ],
      current_focus: "Invoices panel, viewing invoice INV-1042",
      visible_panels: ["Inbox", "Invoices", "Clients"],
      behavior_observations: ["Uses the mouse for everything"],
    },
    candidates: { clients: CLIENT_NAMES },
    ...overrides,
  };
}

const RECORDS: RecordCandidate[] = [
  {
    id: "invoice:INV-1047",
    kind: "invoice",
    panel: "invoices",
    label: "INV-1047 · Kite & Co. · overdue 5 days · $2,650",
    client: "Kite & Co.",
    why: "next overdue invoice in the list",
  },
  { id: "message:m-1", kind: "message", panel: "inbox", label: "\"Re: Invoice INV-1042\" from Priya Nair at Harbor Coffee Co.", client: "Harbor Coffee Co.", why: "unread" },
  { id: "person:u-riley", kind: "person", panel: "team", label: "Riley Chen (production designer, available)" },
];

function withRecords(records: RecordCandidate[] = RECORDS, overrides: Partial<AdaptRequest> = {}): AdaptRequest {
  return request({ candidates: { clients: CLIENT_NAMES, records }, ...overrides });
}

function optionsOf(questions: ReturnType<typeof buildQuestions>, id: string): string[] {
  const q = questions[id];
  if (!q || q.type !== "choice") throw new Error(`${id} is not a choice`);
  return Object.keys(q.criteria);
}

describe("buildQuestions", () => {
  it("asks one four-level relevance Score per panel", () => {
    const questions = buildQuestions(request());
    for (const panel of PANEL_IDS) {
      const q = questions[QUESTION_IDS.relevance(panel)];
      expect(q?.type).toBe("score");
      if (q?.type === "score") expect(q.criteria).toHaveLength(4);
      expect(panelFromQuestionId(QUESTION_IDS.relevance(panel))).toBe(panel);
    }
    expect(panelFromQuestionId("goal")).toBeNull();
    expect(panelFromQuestionId("rel_nope")).toBeNull();
  });

  it("does not repeat the evidence block in every relevance question", () => {
    // Ten copies were 14% of the input tokens for the same answers.
    const questions = buildQuestions(request());
    for (const panel of PANEL_IDS) {
      const q = questions[QUESTION_IDS.relevance(panel)];
      expect(JSON.stringify(q?.instructions)).not.toContain("evidence");
    }
  });

  it("uses identical relevance wording apart from the panel, so scores are comparable", () => {
    const questions = buildQuestions(request());
    const strip = (id: string) => {
      const q = questions[id];
      if (q?.type !== "score" || typeof q.instructions !== "object" || q.instructions === null || Array.isArray(q.instructions)) {
        throw new Error("expected structured instructions");
      }
      const { panel: _panel, ...rest } = q.instructions;
      return JSON.stringify({ rest, criteria: q.criteria });
    };
    const first = strip(QUESTION_IDS.relevance("inbox"));
    for (const panel of PANEL_IDS) expect(strip(QUESTION_IDS.relevance(panel))).toBe(first);
  });

  it("offers exactly the catalog ids as Choice options", () => {
    const questions = buildQuestions(request({ command: "remind meridian to pay" }));
    expect(optionsOf(questions, QUESTION_IDS.goal)).toEqual([...GOAL_IDS]);
    expect(optionsOf(questions, QUESTION_IDS.layout)).toEqual([...LAYOUT_MODES]);
    expect(optionsOf(questions, QUESTION_IDS.nextAction)).toEqual([...ACTION_IDS]);
    expect(optionsOf(questions, QUESTION_IDS.command.panel)).toEqual([...PANEL_IDS, PANEL_UNCLEAR]);
    expect(optionsOf(questions, QUESTION_IDS.command.action)).toEqual([...ACTION_IDS]);
    expect(optionsOf(questions, QUESTION_IDS.command.invoiceStatus)).toEqual([...INVOICE_STATUS_ARGS]);
    expect(optionsOf(questions, QUESTION_IDS.command.timeframe)).toEqual([...TIMEFRAME_ARGS]);
  });

  it("includes every client candidate plus the no-match options", () => {
    const questions = buildQuestions(request({ command: "atlas" }));
    expect(optionsOf(questions, QUESTION_IDS.targetClient)).toEqual([...CLIENT_NAMES, NO_CLIENT]);
    expect(optionsOf(questions, QUESTION_IDS.command.client)).toEqual([...CLIENT_NAMES, CLIENT_NOT_MENTIONED]);
  });

  it("drops duplicate, blank, and reserved client names", () => {
    const questions = buildQuestions(
      request({ candidates: { clients: ["Atlas Robotics", " Atlas Robotics ", "", "none", "not_mentioned"] } }),
    );
    expect(optionsOf(questions, QUESTION_IDS.targetClient)).toEqual(["Atlas Robotics", NO_CLIENT]);
  });

  it("skips client questions when there are no candidates", () => {
    const questions = buildQuestions(request({ candidates: { clients: [] }, command: "atlas" }));
    expect(questions[QUESTION_IDS.targetClient]).toBeUndefined();
    expect(questions[QUESTION_IDS.command.client]).toBeUndefined();
    expect(questions[QUESTION_IDS.command.panel]).toBeDefined();
  });

  it("adds command questions only when a command is set", () => {
    const commandIds = Object.values(QUESTION_IDS.command);
    const without = buildQuestions(request());
    const blank = buildQuestions(request({ command: "   " }));
    const withCommand = buildQuestions(request({ command: "who still owes us money?" }));
    for (const id of commandIds) {
      expect(without[id]).toBeUndefined();
      expect(blank[id]).toBeUndefined();
      expect(withCommand[id]).toBeDefined();
    }
    expect(Object.keys(without)).toHaveLength(16);
    expect(Object.keys(withCommand)).toHaveLength(21);
  });

  it("only points instructions at fields that exist", () => {
    for (const req of [request(), request({ command: "atlas" }), withRecords(), withRecords(RECORDS, { command: "atlas" })]) {
      const state = buildState(req);
      for (const [id, q] of Object.entries(buildQuestions(req))) {
        const localKeys =
          typeof q.instructions === "object" && q.instructions !== null && !Array.isArray(q.instructions)
            ? Object.keys(q.instructions)
            : [];
        const text = JSON.stringify([q.instructions, "criteria" in q ? q.criteria : null]);
        for (const [, name] of text.matchAll(/`([a-z_]+)/g)) {
          expect([...Object.keys(state), ...localKeys], `${id} mentions \`${name}\``).toContain(name);
        }
      }
    }
  });

  it("sends no dashes that Jev or people could misread as em or en dashes", () => {
    const text = JSON.stringify([buildState(request({ command: "x" })), buildQuestions(withRecords(RECORDS, { command: "x" }))]);
    expect(text).not.toMatch(/[–—]/);
  });
});

describe("next-record questions", () => {
  it("are asked only when record candidates are sent", () => {
    for (const req of [request(), withRecords([]), request({ command: "atlas" })]) {
      const questions = buildQuestions(req);
      expect(questions[QUESTION_IDS.nextRecord]).toBeUndefined();
      expect(questions[QUESTION_IDS.listWork]).toBeUndefined();
    }
    const questions = buildQuestions(withRecords());
    expect(questions[QUESTION_IDS.nextRecord]?.type).toBe("choice");
    expect(questions[QUESTION_IDS.listWork]?.type).toBe("noul");
    // Still one request: two more questions, on top of the command ones when there is a command.
    expect(Object.keys(questions)).toHaveLength(18);
    expect(Object.keys(buildQuestions(withRecords(RECORDS, { command: "atlas" })))).toHaveLength(23);
  });

  it("offers every candidate id, in order, plus none", () => {
    expect(optionsOf(buildQuestions(withRecords()), QUESTION_IDS.nextRecord)).toEqual([...RECORDS.map((r) => r.id), NO_RECORD]);
  });

  it("describes each record in words, so the option keys carry no hidden meaning", () => {
    const q = buildQuestions(withRecords())[QUESTION_IDS.nextRecord];
    if (q?.type !== "choice") throw new Error("expected a choice");
    expect(q.criteria["invoice:INV-1047"]).toEqual({
      record: "INV-1047 · Kite & Co. · overdue 5 days · $2,650",
      kind: "invoice",
      panel: "Invoices",
      client: "Kite & Co.",
      listed_because: "next overdue invoice in the list",
    });
    // Kinds and panels in the words the activity lines use; no hint when code gave none.
    expect(q.criteria["person:u-riley"]).toEqual({
      record: "Riley Chen (production designer, available)",
      kind: "team member",
      panel: "Team",
      client: "No client company",
    });
    expect(JSON.stringify(q.criteria[NO_RECORD])).toMatch(/none of these records/i);
  });

  it("keeps the candidates out of the state", () => {
    // The state is shared by every question; the candidates only matter to one.
    expect(buildState(withRecords())).toEqual(buildState(request()));
  });

  it("asks list work with a yes side and a no side", () => {
    const q = buildQuestions(withRecords())[QUESTION_IDS.listWork];
    if (q?.type !== "noul") throw new Error("expected a noul");
    expect(q.criteria?.true).toBeTruthy();
    expect(q.criteria?.false).toBeTruthy();
    expect(JSON.stringify(q.instructions)).toMatch(/one at a time/);
  });

  it("drops duplicate, blank, and reserved ids and caps the options at 12", () => {
    const many = Array.from({ length: 15 }, (_, i): RecordCandidate => ({ id: `task:t-${i}`, kind: "task", panel: "tasks", label: `Task ${i}` }));
    const messy: RecordCandidate[] = [
      RECORDS[0]!,
      { ...RECORDS[0]!, id: " invoice:INV-1047 ", label: "duplicate" },
      { ...RECORDS[1]!, label: "   " },
      { ...RECORDS[1]!, id: NO_RECORD },
      ...many,
    ];
    const kept = recordCandidates(withRecords(messy));
    expect(kept).toHaveLength(12);
    expect(kept.map((r) => r.id)).toEqual(["invoice:INV-1047", ...many.slice(0, 11).map((r) => r.id)]);
    expect(optionsOf(buildQuestions(withRecords(messy)), QUESTION_IDS.nextRecord)).toHaveLength(13);
  });
});

describe("buildState", () => {
  it("splits the newest activity from the earlier ones and omits command when absent", () => {
    const state = buildState(request());
    expect(state.latest_activity).toBe("Opened invoice INV-1042 for Harbor Coffee Co. (overdue 14 days)");
    expect(state.earlier_activity).toEqual(["Clicked into the Invoices panel", "Filtered Invoices to status overdue"]);
    expect(state).not.toHaveProperty("command");
    expect(state).not.toHaveProperty("client_companies");
  });

  it("does not repeat the command as the latest activity", () => {
    // The app logs the command before sending it; `command` already carries it.
    const typed = request({
      command: "remind meridian to pay",
      snapshot: { ...request().snapshot, recent_activity: ["Clicked into the Invoices panel", 'Typed in the command bar: "remind meridian to pay"'] },
    });
    const state = buildState(typed);
    expect(state.latest_activity).toBe("Clicked into the Invoices panel");
    expect(state.earlier_activity).toEqual([]);
    const first = buildState(request({ command: "atlas", snapshot: { ...request().snapshot, recent_activity: ['Typed in the command bar: "atlas"'] } }));
    expect(first.latest_activity).toMatch(/no earlier activity/i);
    // Without a command, the same line stays.
    const plain = buildState(request({ snapshot: { ...request().snapshot, recent_activity: ['Typed in the command bar: "atlas"'] } }));
    expect(plain.latest_activity).toBe('Typed in the command bar: "atlas"');
  });

  it("adds the command and client names when a command is set", () => {
    const state = buildState(request({ command: "  atlas  " }));
    expect(state.command).toBe("atlas");
    expect(state.client_companies).toEqual(CLIENT_NAMES);
  });

  it("uses plain words when there is nothing to report", () => {
    const state = buildState(
      request({ snapshot: { recent_activity: [], current_focus: null, visible_panels: [], behavior_observations: [] } }),
    );
    expect(state.earlier_activity).toEqual([]);
    expect(typeof state.latest_activity).toBe("string");
    expect(state.latest_activity).toMatch(/no activity/i);
    expect(state.current_focus).toMatch(/no panel/i);
    expect(state.behavior_observations).toEqual(["Nothing notable yet."]);
  });
});

describe("focus aid 2: goal done and next task", () => {
  const WORKING = { label: "Collecting payments", description: "Checking unpaid or overdue invoices and getting clients to pay them." };
  const TASKS: TaskCandidate[] = [
    { id: "unread_messages", goal: "triage_inbox", label: "Unread client messages to reply to", count: "four", first: "\"Re: Invoice INV-1042\" from Priya Nair at Harbor Coffee Co." },
    { id: "tasks_due_today", goal: "plan_day", label: "To-do items due today", count: "two", first: "Resend INV-1042 to Harbor accounts team (due today)" },
  ];
  const withTasks = (tasks: TaskCandidate[], overrides: Partial<AdaptRequest> = {}) =>
    request({ candidates: { clients: CLIENT_NAMES, tasks }, workingGoal: WORKING, ...overrides });

  it("asks neither question without a working goal or task candidates, and both with them", () => {
    const q = buildQuestions(request());
    expect(Object.keys(q)).not.toContain("goal_done");
    expect(Object.keys(q)).not.toContain("next_task");
    expect(Object.keys(buildQuestions(withTasks(TASKS)))).toEqual(expect.arrayContaining(["goal_done", "next_task"]));
  });

  it("asks goal done only with a working goal, carried in its instructions and never in the state", () => {
    const req = request({ workingGoal: WORKING });
    const q = buildQuestions(req);
    const gd = q[QUESTION_IDS.goalDone];
    expect(gd?.type).toBe("noul");
    const text = JSON.stringify(gd);
    expect(text).toContain("`working_goal`");
    expect(text).toContain("Collecting payments");
    expect(text).toContain("getting clients to pay them");
    expect(q[QUESTION_IDS.nextTask]).toBeUndefined();
    // Every other question reads exactly the same state.
    expect(buildState(req)).toEqual(buildState(request()));
    expect(JSON.stringify(buildState(req))).not.toContain("Collecting payments");
  });

  it("asks the next task only with task candidates: their ids plus none, described with the same fields", () => {
    const q = buildQuestions(withTasks(TASKS));
    expect(optionsOf(q, QUESTION_IDS.nextTask)).toEqual(["unread_messages", "tasks_due_today", NO_TASK]);
    const nt = q[QUESTION_IDS.nextTask];
    if (!nt || nt.type !== "choice") throw new Error("next_task is not a choice");
    const unread = nt.criteria["unread_messages"] as Record<string, unknown>;
    const due = nt.criteria["tasks_due_today"] as Record<string, unknown>;
    expect(Object.keys(unread)).toEqual(Object.keys(due));
    expect(unread).toMatchObject({ task: "Unread client messages to reply to", how_many: "four", part_of: "Working through the inbox" });
    // The candidates are in the criteria, not the state.
    expect(JSON.stringify(buildState(withTasks(TASKS)))).not.toContain("Unread client messages");
  });

  it("asks the next task without a working goal too, when tasks are sent (the server does not second-guess the client)", () => {
    const q = buildQuestions(request({ candidates: { clients: CLIENT_NAMES, tasks: TASKS } }));
    expect(q[QUESTION_IDS.nextTask]).toBeDefined();
    expect(q[QUESTION_IDS.goalDone]).toBeUndefined();
  });

  it("offers each task once, never the no-match id, skips empty labels and unknown goals, and keeps at most five", () => {
    const many: TaskCandidate[] = Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, goal: "plan_day", label: `Task ${i}`, count: "one", first: "x" }));
    const messy: TaskCandidate[] = [
      TASKS[0],
      { ...TASKS[0], label: "Duplicate" },
      { ...TASKS[1], id: NO_TASK },
      { ...TASKS[1], id: "blank", label: "  " },
      { ...TASKS[1], id: "bad_goal", goal: "not_a_goal" as TaskCandidate["goal"] },
      ...many,
    ];
    const kept = taskCandidates(request({ candidates: { clients: CLIENT_NAMES, tasks: messy } }));
    expect(kept.map((t) => t.id)).toEqual(["unread_messages", "t0", "t1", "t2", "t3"]);
  });

  it("treats a working goal with a blank label as none", () => {
    expect(workingGoalOf(request({ workingGoal: { label: "  ", description: "x" } }))).toBeNull();
    expect(buildQuestions(request({ workingGoal: { label: " ", description: "x" } }))[QUESTION_IDS.goalDone]).toBeUndefined();
  });

  it("leaves the existing questions exactly as they were", () => {
    const before = buildQuestions(withRecords());
    const after = buildQuestions(withRecords(RECORDS, { workingGoal: WORKING, candidates: { clients: CLIENT_NAMES, records: RECORDS, tasks: TASKS } }));
    for (const [id, q] of Object.entries(before)) expect(after[id]).toEqual(q);
    expect(Object.keys(after).filter((id) => !(id in before)).sort()).toEqual([QUESTION_IDS.goalDone, QUESTION_IDS.nextTask].sort());
  });
});

describe("the link questions (Arrange linked panels by next step)", () => {
  const link: NonNullable<AdaptRequest["link"]> = {
    clicked: {
      id: "message:m-1",
      kind: "message",
      fields: { from: "Priya Nair", client: "Harbor Coffee Co.", subject: "Re: Invoice INV-1042", text: "Sorry for the delay. Can you resend the invoice to our accounts team? The old email bounced." },
    },
    records: [
      { id: "invoice:INV-1042", kind: "invoice", panel: "invoices", label: "INV-1042 · Harbor Coffee Co. · overdue 14 days · $4,200", client: "Harbor Coffee Co.", why: "the clicked message names this invoice" },
      { id: "task:t-1", kind: "task", panel: "tasks", label: "Resend INV-1042 to Harbor accounts team (due today)", client: "Harbor Coffee Co.", why: "this task names INV-1042, which the clicked message names" },
      { id: "message:m-1", kind: "message", panel: "inbox", label: "the clicked record itself" },
    ],
  };

  it("are asked only when the request carries a clicked record and its linked records", () => {
    const without = buildQuestions(request());
    expect(without[QUESTION_IDS.linkNext]).toBeUndefined();
    expect(without[QUESTION_IDS.linkAction]).toBeUndefined();
    const q = buildQuestions(request({ link }));
    expect(q[QUESTION_IDS.linkNext]?.type).toBe("choice");
    expect(q[QUESTION_IDS.linkAction]?.type).toBe("choice");
  });

  it("put the clicked record in their instructions, not in the state, so every other question reads the same state", () => {
    expect(buildState(request({ link }))).toEqual(buildState(request()));
    const q = buildQuestions(request({ link }));
    for (const id of [QUESTION_IDS.linkNext, QUESTION_IDS.linkAction]) {
      const instructions = q[id]!.instructions as Record<string, unknown>;
      expect(instructions.clicked_record).toEqual({ kind: "message", ...link.clicked.fields });
    }
    // The other questions are unchanged.
    const plain = buildQuestions(request());
    for (const id of Object.keys(plain)) expect(q[id]).toEqual(plain[id]);
  });

  it("offer the linked records (not the clicked one) plus none, and the catalog's actions, resend_invoice included", () => {
    const q = buildQuestions(request({ link }));
    const next = q[QUESTION_IDS.linkNext]!;
    if (next.type !== "choice") throw new Error("choice expected");
    expect(Object.keys(next.criteria)).toEqual(["invoice:INV-1042", "task:t-1", "none"]);
    expect(next.criteria["invoice:INV-1042"]).toEqual({ record: link.records[0].label, panel: "Invoices", linked_because: link.records[0].why });
    const action = q[QUESTION_IDS.linkAction]!;
    if (action.type !== "choice") throw new Error("choice expected");
    expect(Object.keys(action.criteria)).toEqual([...ACTION_IDS]);
    expect(ACTION_IDS).toContain("resend_invoice");
    // next_action and cmd_action offer the new action too.
    const cmd = buildQuestions(request({ command: "resend harbor's invoice" }));
    for (const id of [QUESTION_IDS.nextAction, QUESTION_IDS.command.action]) {
      const c = cmd[id]!;
      if (c.type !== "choice") throw new Error("choice expected");
      expect(Object.keys(c.criteria)).toContain("resend_invoice");
    }
  });
});

describe("the meeting prep questions (focus aid 4)", () => {
  const prepReq: PrepRequest = {
    version: 1,
    meeting: { title: "Harbor rebrand review", client: "Harbor Coffee Co.", time: "starts in 12 minutes, at 11:00 today", kind: "meeting" },
    records: [
      { id: "invoice:INV-1042", kind: "invoice", panel: "invoices", fields: { id: "INV-1042", client: "Harbor Coffee Co.", status: "overdue", due: "14 days overdue" } },
      { id: "message:m-1", kind: "message", panel: "inbox", fields: { from: "Priya Nair", client: "Harbor Coffee Co.", subject: "Re: Invoice INV-1042", text: "Can you resend the invoice?" } },
      { id: "project:p-harbor", kind: "project", panel: "projects", fields: { name: "Harbor rebrand", client: "Harbor Coffee Co.", status: "on track" } },
    ],
  };

  it("sends only the meeting as the state, never the records or the user's activity", () => {
    expect(buildPrepState(prepReq)).toEqual({ meeting: { title: "Harbor rebrand review", client: "Harbor Coffee Co.", time: "starts in 12 minutes, at 11:00 today", kind: "meeting" } });
  });

  it("asks one Score per record with the same question and levels, the record in its own instructions, plus the anything-urgent Noul", () => {
    const q = buildPrepQuestions(prepReq);
    expect(Object.keys(q)).toEqual([PREP_QUESTION_IDS.record(0), PREP_QUESTION_IDS.record(1), PREP_QUESTION_IDS.record(2), PREP_QUESTION_IDS.anythingUrgent]);
    const scores = [0, 1, 2].map((i) => q[PREP_QUESTION_IDS.record(i)]);
    for (const s of scores) {
      expect(s.type).toBe("score");
      if (s.type !== "score") continue;
      expect(s.criteria).toHaveLength(3);
      expect(s.criteria).toEqual((scores[0] as typeof s).criteria);
      expect((s.instructions as { question: string }).question).toBe("How much does the user need `record` before `meeting` starts?");
    }
    expect((scores[0].instructions as { record: unknown }).record).toEqual({ kind: "invoice", id: "INV-1042", client: "Harbor Coffee Co.", status: "overdue", due: "14 days overdue" });
    expect((scores[1].instructions as { record: unknown }).record).toMatchObject({ kind: "message", from: "Priya Nair" });
    const levels = (scores[0].type === "score" ? scores[0].criteria : []) as { what: string }[];
    expect(levels.map((l) => l.what.split(":")[0])).toEqual(["Not needed for this meeting", "Useful background", "Should be reviewed before this meeting"]);
    const urgent = q[PREP_QUESTION_IDS.anythingUrgent];
    expect(urgent.type).toBe("noul");
    expect((urgent.instructions as { records: unknown[] }).records).toHaveLength(3);
    expect((urgent.instructions as { question: string }).question).toBe("Does any record in `records` need the user to do something before `meeting` starts?");
  });

  it("asks about at most ten records, the first of each id, and nothing without records", () => {
    const many: PrepRequest = {
      ...prepReq,
      records: [prepReq.records[0], prepReq.records[0], ...Array.from({ length: 12 }, (_, i) => ({ id: `task:t-${i}`, kind: "task" as const, panel: "tasks" as const, fields: { title: `T${i}` } }))],
    };
    expect(prepRecordsOf(many)).toHaveLength(MAX_PREP_RECORDS);
    expect(prepRecordsOf(many)[1].id).toBe("task:t-0");
    expect(Object.keys(buildPrepQuestions(many))).toHaveLength(MAX_PREP_RECORDS + 1);
    expect(buildPrepQuestions({ ...prepReq, records: [] })).toEqual({});
  });
});

