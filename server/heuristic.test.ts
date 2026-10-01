/**
 * The heuristic fallback must always return a complete, well-formed
 * Judgments object with modest confidence, and its simple rules should
 * point roughly the right way.
 */
import { describe, expect, it } from "vitest";
import { ACTION_IDS, GOAL_IDS, LAYOUT_MODES, PANEL_IDS } from "../shared/catalog.ts";
import { CLIENT_NAMES } from "../shared/fixtures.ts";
import type { AdaptRequest, ChoiceJudgment, Judgments, PrepRequest, RecordCandidate, ScoreJudgment, TaskCandidate } from "../shared/types.ts";
import { TASK_DONE_JEV_AT } from "../src/engine/taskDone.ts";
import { CUE_CACHE_LIMIT, cueCacheSize, heuristicJudgments, heuristicPrepJudgments } from "./heuristic.ts";

function request(activity: string[], extra: Partial<AdaptRequest> = {}, observations: string[] = []): AdaptRequest {
  return {
    version: 1,
    snapshot: { recent_activity: activity, current_focus: null, visible_panels: ["Inbox", "Invoices"], behavior_observations: observations },
    candidates: { clients: CLIENT_NAMES },
    ...extra,
  };
}

function expectChoice(j: ChoiceJudgment, options: readonly string[]): void {
  expect(options).toContain(j.choice);
  expect(Object.keys(j.probabilities).sort()).toEqual([...options].sort());
  const sum = Object.values(j.probabilities).reduce((a, b) => a + b, 0);
  expect(sum).toBeCloseTo(1, 6);
  expect(j.probabilities[j.choice]).toBe(Math.max(...Object.values(j.probabilities)));
  expect(j.confidence).toBeGreaterThanOrEqual(0);
  expect(j.confidence).toBeLessThanOrEqual(0.6);
}

function expectScore(j: ScoreJudgment, levels: number): void {
  expect(j.max).toBe(levels - 1);
  expect(j.probabilities).toHaveLength(levels);
  expect(j.probabilities.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
  expect(j.score).toBeGreaterThanOrEqual(0);
  expect(j.score).toBeLessThanOrEqual(j.max);
  expect(j.confidence).toBeLessThanOrEqual(0.6);
}

function expectValid(j: Judgments, withCommand: boolean): void {
  expectChoice(j.goal, GOAL_IDS);
  for (const panel of PANEL_IDS) expectScore(j.relevance[panel], 4);
  expect(j.struggling).toBeGreaterThan(0);
  expect(j.struggling).toBeLessThan(1);
  expectChoice(j.layout, LAYOUT_MODES);
  expectScore(j.expertise, 3);
  expectChoice(j.nextAction, ACTION_IDS);
  expectChoice(j.targetClient, [...CLIENT_NAMES, "none"]);
  if (withCommand) {
    expect(j.command).toBeDefined();
    expectChoice(j.command!.panel, [...PANEL_IDS, "unclear"]);
    expectChoice(j.command!.client, [...CLIENT_NAMES, "not_mentioned"]);
  } else {
    expect(j.command).toBeUndefined();
  }
}

function topPanel(j: Judgments): string {
  return [...PANEL_IDS].sort((a, b) => j.relevance[b].score - j.relevance[a].score)[0]!;
}

const COLLECTIONS = [
  "Clicked into the Invoices panel",
  "Filtered Invoices to status overdue",
  "Opened invoice INV-1042 for Harbor Coffee Co. (overdue 14 days)",
  "Opened invoice INV-1038 for Meridian Hotels (overdue 36 days)",
  "Opened invoice INV-1042 for Harbor Coffee Co. (overdue 14 days)",
];

describe("heuristicJudgments", () => {
  it("returns a complete, modest Judgments object", () => {
    expectValid(heuristicJudgments(request(COLLECTIONS)), false);
    expectValid(heuristicJudgments(request([])), false);
    expectValid(heuristicJudgments(request(COLLECTIONS, { command: "remind meridian to pay" })), true);
  });

  it("raises struggling for repeated searches and quick closes", () => {
    const steady = heuristicJudgments(request(COLLECTIONS));
    const lost = heuristicJudgments(
      request(
        [
          'Searched Inbox for "bills"',
          'Searched Inbox for "bill"',
          "Opened the Revenue panel",
          "Closed the Revenue panel after a few seconds",
          'Searched Clients for "where are bills"',
          'Searched Tasks for "unpaid bills"',
        ],
        {},
        ["Searched 4 times in the last minute", "Closed 1 panel within seconds of opening it"],
      ),
    );
    expect(lost.struggling).toBeGreaterThan(0.6);
    expect(steady.struggling).toBeLessThan(0.4);
    expect(lost.struggling).toBeGreaterThan(steady.struggling);
    expect(lost.relevance.help.score).toBeGreaterThan(steady.relevance.help.score);
  });

  it("follows the activity to the right panel, goal, and client", () => {
    const j = heuristicJudgments(request(COLLECTIONS));
    expect(topPanel(j)).toBe("invoices");
    expect(j.goal.choice).toBe("collect_payments");
    expect(j.nextAction.choice).toBe("send_payment_reminder");
    expect(j.targetClient.choice).toBe("Harbor Coffee Co.");
  });

  it("says unclear when there is no activity", () => {
    const j = heuristicJudgments(request([]));
    expect(j.goal.choice).toBe("unclear");
    expect(j.layout.choice).toBe("overview");
  });

  it("reads simple commands", () => {
    const remind = heuristicJudgments(request([], { command: "remind meridian to pay" })).command!;
    expect(remind.panel.choice).toBe("invoices");
    expect(remind.action.choice).toBe("send_payment_reminder");
    expect(remind.client.choice).toBe("Meridian Hotels");

    const team = heuristicJudgments(request([], { command: "who is free to help this afternoon" })).command!;
    expect(team.panel.choice).toBe("team");
    expect(team.timeframe.choice).toBe("today");

    const atlas = heuristicJudgments(request([], { command: "atlas" })).command!;
    expect(atlas.panel.choice).toBe("clients");
    expect(atlas.client.choice).toBe("Atlas Robotics");

    const juniper = heuristicJudgments(request([], { command: "show juniper books invoices" })).command!;
    expect(juniper.action.choice).toBe("none");
    expect(juniper.invoiceStatus.choice).toBe("all");

    const vague = heuristicJudgments(request([], { command: "hmm" })).command!;
    expect(vague.panel.choice).toBe("unclear");
  });

  it("does not read 'mark ... as paid' as a request to see paid invoices", () => {
    const marked = heuristicJudgments(request([], { command: "mark the pinecrest bill as paid" })).command!;
    expect(marked.action.choice).toBe("mark_invoice_paid");
    expect(marked.invoiceStatus.choice).not.toBe("paid");
    const seePaid = heuristicJudgments(request([], { command: "show paid invoices" })).command!;
    expect(seePaid.invoiceStatus.choice).toBe("paid");
  });

  describe("next record and list work", () => {
    const INVOICE_NEXT: RecordCandidate = {
      id: "invoice:INV-1047",
      kind: "invoice",
      panel: "invoices",
      label: "INV-1047 · Kite & Co. · overdue 5 days · $2,650",
      why: "next overdue invoice in the list",
    };
    const MESSAGE: RecordCandidate = { id: "message:m-5", kind: "message", panel: "inbox", label: "\"Discount on packaging?\" from Zoe Laurent", why: "unread" };
    const TASK: RecordCandidate = { id: "task:t-6", kind: "task", panel: "tasks", label: "Reply to Kite about discount (due today)", why: "due today" };
    const REPLIES = [
      "Clicked into Inbox",
      'Opened message "Re: Invoice INV-1042" from Priya Nair at Harbor Coffee Co. in Inbox',
      "Replied to Harbor Coffee Co. in Inbox",
      'Opened message "Signage install date" from Hannah Brooks at Meridian Hotels in Inbox',
      "Replied to Meridian Hotels in Inbox",
      'Opened message "Product photos" from Mei Tanaka at Atlas Robotics in Inbox',
      "Replied to Atlas Robotics in Inbox",
    ];

    function withRecords(activity: string[], records: RecordCandidate[]): AdaptRequest {
      return request(activity, { candidates: { clients: CLIENT_NAMES, records } });
    }

    it("answers neither without candidates, like the Jev request", () => {
      const j = heuristicJudgments(request(REPLIES));
      expect(j).not.toHaveProperty("nextRecord");
      expect(j).not.toHaveProperty("listWork");
    });

    it("picks the first candidate of the kind opened last, humbly", () => {
      const j = heuristicJudgments(withRecords(REPLIES, [TASK, MESSAGE, { ...MESSAGE, id: "message:m-6", why: undefined }]));
      expectValid(j, false);
      expectChoice(j.nextRecord!, [TASK.id, MESSAGE.id, "message:m-6", "none"]);
      expect(j.nextRecord!.choice).toBe(MESSAGE.id);
      // The first match wins over later ones, and "none" keeps a real share.
      expect(j.nextRecord!.probabilities[MESSAGE.id]).toBeGreaterThan(j.nextRecord!.probabilities["message:m-6"]!);
      expect(j.nextRecord!.probabilities.none).toBeGreaterThan(j.nextRecord!.probabilities[TASK.id]!);
      expect(j.nextRecord!.confidence).toBeLessThanOrEqual(0.6);
    });

    it("picks a candidate whose hint says next, even of another kind", () => {
      const j = heuristicJudgments(withRecords(REPLIES, [TASK, INVOICE_NEXT]));
      expect(j.nextRecord!.choice).toBe(INVOICE_NEXT.id);
      const noOpens = heuristicJudgments(withRecords(["Clicked into Invoices"], [MESSAGE, INVOICE_NEXT]));
      expect(noOpens.nextRecord!.choice).toBe(INVOICE_NEXT.id);
    });

    it("says none when no candidate matches", () => {
      const j = heuristicJudgments(withRecords(REPLIES, [TASK]));
      expect(j.nextRecord!.choice).toBe("none");
      expectChoice(j.nextRecord!, [TASK.id, "none"]);
    });

    it("reads list work from different records of one kind opened in turn", () => {
      const replies = heuristicJudgments(withRecords(REPLIES, [MESSAGE])).listWork!;
      const reopen = heuristicJudgments(
        withRecords(
          [
            "Opened invoice INV-1047 · Kite & Co. · overdue 5 days · $2,650 in Invoices",
            'Searched Inbox for "send reminder"',
            "Opened invoice INV-1047 · Kite & Co. · overdue 5 days · $2,650 in Invoices",
            "Opened invoice INV-1047 · Kite & Co. · overdue 5 days · $2,650 in Invoices (twice in a row)",
          ],
          [MESSAGE],
        ),
      ).listWork!;
      const compare = heuristicJudgments(
        withRecords(
          [
            "Opened invoice INV-1038 · Meridian Hotels · overdue 36 days · $12,800 in Invoices",
            "Opened client Meridian Hotels (health: watch) in Clients",
            "Clicked into Invoices",
            "Clicked into Clients",
          ],
          [MESSAGE],
        ),
      ).listWork!;
      expect(replies).toBeGreaterThan(0.5);
      expect(reopen).toBeLessThan(0.4);
      expect(compare).toBeLessThan(0.4);
      for (const p of [replies, reopen, compare]) {
        expect(p).toBeGreaterThan(0);
        expect(p).toBeLessThan(1);
      }
      // Panel opens are not record opens.
      const panels = heuristicJudgments(withRecords(["Opened Revenue from the dock", "Opened Team from the dock", "Opened Notes from the dock"], [MESSAGE]));
      expect(panels.listWork!).toBeLessThan(0.4);
    });
  });

  it("keeps its pattern cache bounded whatever client names arrive", () => {
    for (let i = 0; i < 60; i++) {
      const names = Array.from({ length: 50 }, (_, k) => `Made Up Client ${i}-${k}`);
      heuristicJudgments({ ...request(COLLECTIONS), candidates: { clients: names } });
    }
    expect(cueCacheSize()).toBeLessThanOrEqual(CUE_CACHE_LIMIT);
  });
});

describe("focus aid 2 fallback", () => {
  const WORKING = { label: "Working through the inbox", description: "Reading, sorting, and replying to email messages." };
  const TASKS: TaskCandidate[] = [
    { id: "tasks_due_today", goal: "plan_day", label: "To-do items due today", count: "two", first: "Resend INV-1042 (due today)" },
    { id: "overdue_invoices", goal: "collect_payments", label: "Overdue invoices that still need a payment reminder", count: "three", first: "INV-1038" },
  ];
  const replies = [
    "Opened message \"Re: Invoice INV-1042\" from Priya Nair at Harbor Coffee Co. in Inbox",
    "Replied to Harbor Coffee Co. in Inbox",
    "Opened message \"Signage install date\" from Hannah Brooks at Meridian Hotels in Inbox",
    "Replied to Meridian Hotels in Inbox",
    "Opened message \"Product photos\" from Mei Tanaka at Atlas Robotics in Inbox",
    "Replied to Atlas Robotics in Inbox",
  ];

  it("answers goal done only with a working goal, and never as high as the client's done threshold", () => {
    expect(heuristicJudgments(request(replies)).goalDone).toBeUndefined();
    const done = heuristicJudgments(request(replies, { workingGoal: WORKING })).goalDone ?? 0;
    expect(done).toBeGreaterThan(0.4);
    expect(done).toBeLessThan(TASK_DONE_JEV_AT);
  });

  it("keeps goal done low while the newest step opens a record, or nothing was handled", () => {
    const opening = heuristicJudgments(request([...replies, "Opened message \"Out Thursday\" from Jordan Lee in Inbox"], { workingGoal: WORKING }));
    expect(opening.goalDone).toBeLessThanOrEqual(0.25);
    const looking = heuristicJudgments(request(["Clicked into Inbox", "Searched Inbox for \"harbor\""], { workingGoal: WORKING }));
    expect(looking.goalDone).toBeLessThanOrEqual(0.25);
  });

  it("picks the client's first-ranked task humbly, with none keeping a share, and only when tasks are sent", () => {
    expect(heuristicJudgments(request(replies)).nextTask).toBeUndefined();
    const j = heuristicJudgments(request(replies, { candidates: { clients: CLIENT_NAMES, tasks: TASKS } }));
    const nt = j.nextTask;
    if (!nt) throw new Error("no next task");
    expectChoice(nt, ["tasks_due_today", "overdue_invoices", "none"]);
    expect(nt.choice).toBe("tasks_due_today");
    expect(nt.probabilities.none).toBeGreaterThan(nt.probabilities.overdue_invoices);
  });
});

describe("heuristic: the link answers (Arrange linked panels by next step)", () => {
  const records: RecordCandidate[] = [
    { id: "task:t-1", kind: "task", panel: "tasks", label: "Resend INV-1042 to Harbor accounts team" },
    { id: "invoice:INV-1042", kind: "invoice", panel: "invoices", label: "INV-1042" },
    { id: "client:c-harbor", kind: "client", panel: "clients", label: "Harbor Coffee Co." },
  ];
  const message = (text: string, subject = "Hello") =>
    heuristicJudgments(request(["Opened message"], { link: { clicked: { id: "message:m-1", kind: "message", fields: { from: "Priya Nair", subject, text } }, records } }));

  it("reads what a message asks for from its words, humbly", () => {
    expect(message("Can you resend the invoice to our accounts team? The old email bounced.").linkAction?.choice).toBe("resend_invoice");
    expect(message("Could you send it again please?").linkAction?.choice).toBe("resend_invoice");
    expect(message("No rush, but a call next week would help.").linkAction?.choice).toBe("schedule_meeting");
    expect(message("Is there any flexibility on the price?").linkAction?.choice).toBe("reply_to_message");
    expect(message("Thanks so much, the team loves the new screens.").linkAction?.choice).toBe("none");
    const j = message("Can you resend the invoice?");
    expectChoice(j.linkAction!, ACTION_IDS);
  });

  it("leans link-next to the record the action works on, never past the app's Next gate, and none when nothing is asked", () => {
    const j = message("Can you resend the invoice?");
    expect(j.linkNext?.choice).toBe("invoice:INV-1042");
    expectChoice(j.linkNext!, [...records.map((r) => r.id), "none"]);
    // The pick and "none" weigh the same, so it is never sure enough to say Next.
    expect(j.linkNext!.probabilities["invoice:INV-1042"]).toBeLessThan(0.5);
    expect(j.linkNext!.probabilities.none).toBeCloseTo(j.linkNext!.probabilities["invoice:INV-1042"], 6);
    expect(message("Thanks!").linkNext?.choice).toBe("none");
    // No link, no link answers.
    expect(heuristicJudgments(request(["Opened message"])).linkNext).toBeUndefined();
  });
});

describe("heuristicPrepJudgments (focus aid 4)", () => {
  const req = (records: PrepRequest["records"]): PrepRequest => ({
    version: 1,
    meeting: { title: "Harbor rebrand review", client: "Harbor Coffee Co.", time: "starts in 12 minutes, at 11:00 today", kind: "meeting" },
    records,
  });
  const share = (s: ScoreJudgment) => s.score / s.max;
  const harbor = req([
    { id: "invoice:INV-1042", kind: "invoice", panel: "invoices", fields: { id: "INV-1042", client: "Harbor Coffee Co.", status: "overdue" } },
    { id: "message:m-1", kind: "message", panel: "inbox", fields: { from: "Priya Nair", client: "Harbor Coffee Co.", status: "unread", received: "today at 8:12" } },
    { id: "task:t-1", kind: "task", panel: "tasks", fields: { title: "Resend INV-1042", client: "Harbor Coffee Co.", due: "due today" } },
    { id: "project:p-harbor", kind: "project", panel: "projects", fields: { name: "Harbor rebrand", client: "Harbor Coffee Co.", status: "on track" } },
    { id: "invoice:INV-2", kind: "invoice", panel: "invoices", fields: { id: "INV-2", client: "Harbor Coffee Co.", status: "sent", due: "due in 20 days" } },
    { id: "message:m-10", kind: "message", panel: "inbox", fields: { from: "Riley Chen", client: "No client company", status: "read", received: "4 days ago" } },
  ]);

  it("rates an action due (overdue, unread, due today) and the project the meeting names high, other business as background, and other clients low", () => {
    const j = heuristicPrepJudgments(harbor);
    const s = (id: string) => share(j.scores[id]);
    for (const id of ["invoice:INV-1042", "message:m-1", "task:t-1", "project:p-harbor"]) expect(s(id)).toBeGreaterThan(0.7);
    expect(s("invoice:INV-2")).toBeCloseTo(0.5, 1);
    expect(s("message:m-10")).toBeLessThan(0.35);
    // Humble: never a certain level.
    for (const sc of Object.values(j.scores)) expect(Math.max(...sc.probabilities)).toBeLessThan(1);
  });

  it("says something is urgent only when a record of the client has an action due, at most at its cap", () => {
    expect(heuristicPrepJudgments(harbor).anythingUrgent).toBe(0.6);
    const calm = req([
      { id: "invoice:INV-2", kind: "invoice", panel: "invoices", fields: { id: "INV-2", client: "Harbor Coffee Co.", status: "sent" } },
      { id: "message:m-10", kind: "message", panel: "inbox", fields: { client: "No client company", status: "unread" } },
    ]);
    expect(heuristicPrepJudgments(calm).anythingUrgent).toBe(0.2);
  });
});

