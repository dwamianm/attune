/**
 * Focus aid 2, "Say when a task is done" (./taskDone.ts): the code facts,
 * the next-task candidates and their order, the extension point for aid 3,
 * the done rule (two rounds, the first minute), when task candidates are
 * sent, the gate on Jev's next task, and the view change Start makes.
 */
import { describe, expect, it } from "vitest";
import { EVENTS, INVOICES, MESSAGES, PROJECTS, TASKS } from "../../shared/fixtures.ts";
import type { AppData, NextTask } from "./contract.ts";
import {
  buildNextTasks,
  chooseNextTask,
  confidentTask,
  countDoneRound,
  emptyDoneRounds,
  goalFact,
  hasGoalFact,
  judgeTaskDone,
  MEETING_SOON_MS,
  mightBeDone,
  TASK_CANDIDATES_AT,
  TASK_DONE_JEV_AT,
  TASK_DONE_MIN_WORK_MS,
  TASK_DONE_ROUNDS,
  TASK_PRIORITY,
  taskViewPatch,
} from "./taskDone.ts";
import { choiceJ } from "./test-helpers.ts";

function data(): AppData {
  return {
    invoices: structuredClone(INVOICES),
    messages: structuredClone(MESSAGES),
    tasks: structuredClone(TASKS),
    projects: structuredClone(PROJECTS),
    events: structuredClone(EVENTS),
    notes: "",
  };
}

/** Today at hh:mm, local time, as epoch ms (the fixtures' events are at fixed times today). */
function todayAt(hh: number, mm = 0): number {
  const d = new Date();
  d.setHours(hh, mm, 0, 0);
  return d.getTime();
}

const REMINDED = new Set(["invoice:INV-1038", "invoice:INV-1042", "invoice:INV-1047"]);

describe("code facts", () => {
  it("collect_payments is done when no overdue invoice is left without a reminder this session, or none is overdue", () => {
    const d = data();
    expect(goalFact("collect_payments", d, new Set())?.done).toBe(false);
    expect(goalFact("collect_payments", d, new Set(["invoice:INV-1038", "invoice:INV-1042"]))?.done).toBe(false);
    const fact = goalFact("collect_payments", d, REMINDED);
    expect(fact).toEqual({ done: true, title: "Payments done", detail: "every overdue invoice has a reminder." });
    // Reminders sent before this session do not count: INV-1038 already had two.
    expect(d.invoices.find((i) => i.id === "INV-1038")?.remindersSent).toBe(2);
    for (const inv of d.invoices) if (inv.status === "overdue") inv.status = "paid";
    expect(goalFact("collect_payments", d, new Set())).toMatchObject({ done: true, detail: "no invoice is overdue." });
  });

  it("triage_inbox is done when no unread client message is left (a teammate's message does not count)", () => {
    const d = data();
    expect(goalFact("triage_inbox", d, new Set())?.done).toBe(false);
    for (const m of d.messages) if (m.client) m.unread = false;
    d.messages.find((m) => m.id === "m-4")!.unread = true; // Jordan Lee, a teammate.
    expect(goalFact("triage_inbox", d, new Set())).toMatchObject({ done: true, title: "Inbox done" });
  });

  it("track_projects is done when no project is at risk or blocked", () => {
    const d = data();
    expect(goalFact("track_projects", d, new Set())?.done).toBe(false);
    for (const p of d.projects) if (p.status === "at_risk" || p.status === "blocked") p.status = "on_track";
    expect(goalFact("track_projects", d, new Set())).toMatchObject({ done: true, title: "Projects done" });
  });

  it("the other goals have no code fact and rely on Jev", () => {
    for (const g of ["plan_day", "manage_client", "review_business", "coordinate_team", "capture_notes"] as const) {
      expect(goalFact(g, data(), new Set())).toBeNull();
      expect(hasGoalFact(g)).toBe(false);
    }
    for (const g of ["collect_payments", "triage_inbox", "track_projects"] as const) expect(hasGoalFact(g)).toBe(true);
  });
});

describe("next-task candidates", () => {
  it("lists the pending work of every other goal with a count and a first record, highest priority first", () => {
    const tasks = buildNextTasks({ data: data(), handled: REMINDED, now: todayAt(10, 20), exclude: "collect_payments" });
    expect(tasks.map((t) => t.text)).toEqual([
      "Meeting in 40 minutes: Harbor rebrand review",
      "4 unread client messages",
      "2 tasks due today",
      "3 projects at risk or blocked",
    ]);
    const unread = tasks[1];
    expect(unread).toMatchObject({ id: "unread_messages", goal: "triage_inbox", panel: "inbox", count: 4, words: "four unread client messages" });
    // The newest unread client message first.
    expect(unread.first).toMatchObject({ kind: "message", id: "m-1", client: "Harbor Coffee Co." });
    expect(unread.candidate).toEqual({
      id: "unread_messages",
      goal: "triage_inbox",
      label: "Unread client messages to reply to",
      count: "four",
      first: "\"Re: Invoice INV-1042\" from Priya Nair at Harbor Coffee Co.",
    });
    expect(tasks[0]).toMatchObject({ id: "next_meeting", first: { kind: "event", id: "e-2" }, why: TASK_PRIORITY.next_meeting.why });
    expect(tasks[0].candidate.label).toBe("Next meeting today, starting in about half an hour");
    expect(tasks[3].first).toMatchObject({ kind: "project", id: "p-atlas" });
  });

  it("never offers the working goal's own work, and leaves out kinds with nothing pending", () => {
    const d = data();
    for (const m of d.messages) m.unread = false;
    const tasks = buildNextTasks({ data: d, handled: new Set(), now: todayAt(12), exclude: "track_projects" });
    expect(tasks.map((t) => t.id)).toEqual(["overdue_invoices", "tasks_due_today", "next_meeting"]);
    expect(tasks[0]).toMatchObject({ text: "3 overdue invoices without a reminder", first: { id: "INV-1038" } });
  });

  it("ranks a meeting later today last and words its time as a clock time", () => {
    const tasks = buildNextTasks({ data: data(), handled: new Set(), now: todayAt(13, 30), exclude: null });
    const meeting = tasks.at(-1);
    expect(meeting?.id).toBe("next_meeting");
    expect(meeting?.priority).toBe(TASK_PRIORITY.meeting_later.priority);
    expect(meeting?.text).toMatch(/^Call with Meridian about install at /);
    expect(new Date(todayAt(15, 30)).getTime() - todayAt(13, 30)).toBeGreaterThan(MEETING_SOON_MS);
  });

  it("words the projects by their statuses: one blocked project", () => {
    const d = data();
    for (const p of d.projects) if (p.status === "at_risk") p.status = "on_track";
    const [t] = buildNextTasks({ data: d, handled: new Set(), now: todayAt(12), exclude: null }).filter((x) => x.id === "projects_at_risk");
    expect(t.text).toBe("1 blocked project");
  });

  it("lets a boost (focus aid 3's extension point) reorder the tasks, and gets the goal just finished", () => {
    const seen: (string | null)[] = [];
    const boost = (task: NextTask, finished: string | null) => {
      seen.push(finished);
      return task.id === "projects_at_risk" ? 10 : 0;
    };
    const tasks = buildNextTasks({ data: data(), handled: REMINDED, now: todayAt(12), exclude: "collect_payments", boost });
    expect(tasks[0].id).toBe("projects_at_risk");
    expect(tasks[0].priority).toBe(TASK_PRIORITY.projects_at_risk.priority + 10);
    expect(new Set(seen)).toEqual(new Set(["collect_payments"]));
  });
});

describe("the done rule", () => {
  const since = 1_000_000;
  const working = { goal: "plan_day" as const, since };

  it("a goal without a code fact is done after two rounds in a row at or above the threshold, not one", () => {
    let rounds = countDoneRound(emptyDoneRounds(), working, 0.9, 1);
    const later = since + TASK_DONE_MIN_WORK_MS + 1;
    expect(rounds.streak).toBe(1);
    expect(judgeTaskDone({ working, fact: null, rounds, now: later }).done).toBe(false);
    rounds = countDoneRound(rounds, working, TASK_DONE_JEV_AT, 2);
    expect(rounds.streak).toBe(TASK_DONE_ROUNDS);
    expect(judgeTaskDone({ working, fact: null, rounds, now: later })).toMatchObject({ done: true, source: "jev", title: "Planning the day looks done", probability: TASK_DONE_JEV_AT });
  });

  it("a round below the threshold, or without a goal-done, breaks the streak; the same round never counts twice", () => {
    let rounds = countDoneRound(emptyDoneRounds(), working, 0.9, 1);
    rounds = countDoneRound(rounds, working, 0.9, 1);
    expect(rounds.streak).toBe(1);
    rounds = countDoneRound(rounds, working, 0.6, 2);
    expect(rounds.streak).toBe(0);
    rounds = countDoneRound(rounds, working, 0.9, 3);
    rounds = countDoneRound(rounds, working, undefined, 4);
    expect(rounds.streak).toBe(0);
  });

  it("a new working context starts over, and rounds for another context do not count", () => {
    let rounds = countDoneRound(emptyDoneRounds(), working, 0.9, 1);
    rounds = countDoneRound(rounds, working, 0.9, 2);
    const next = { goal: "coordinate_team" as const, since: since + 5_000 };
    expect(judgeTaskDone({ working: next, fact: null, rounds, now: next.since + TASK_DONE_MIN_WORK_MS }).done).toBe(false);
    rounds = countDoneRound(rounds, next, 0.9, 3);
    expect(rounds).toMatchObject({ goal: "coordinate_team", streak: 1 });
    expect(countDoneRound(rounds, null, 0.9, 4)).toEqual(emptyDoneRounds());
  });

  it("never in the first minute of a working goal: it says when to ask again", () => {
    const fact = { done: true, title: "Payments done", detail: "every overdue invoice has a reminder." };
    const w = { goal: "collect_payments" as const, since };
    expect(judgeTaskDone({ working: w, fact, rounds: emptyDoneRounds(), now: since + TASK_DONE_MIN_WORK_MS - 1 })).toEqual({
      done: false,
      waitUntil: since + TASK_DONE_MIN_WORK_MS,
    });
    expect(judgeTaskDone({ working: w, fact, rounds: emptyDoneRounds(), now: since + TASK_DONE_MIN_WORK_MS })).toEqual({
      done: true,
      source: "code",
      title: "Payments done",
      detail: "every overdue invoice has a reminder.",
    });
  });

  it("a goal with a code fact follows the data only: Jev's goal-done does not make it done, and cannot keep it from being done", () => {
    const w = { goal: "collect_payments" as const, since };
    let rounds = countDoneRound(emptyDoneRounds(), w, 0.95, 1);
    rounds = countDoneRound(rounds, w, 0.95, 2);
    const now = since + TASK_DONE_MIN_WORK_MS;
    expect(judgeTaskDone({ working: w, fact: { done: false, title: "Payments done", detail: "" }, rounds, now }).done).toBe(false);
    expect(judgeTaskDone({ working: w, fact: { done: true, title: "Payments done", detail: "" }, rounds: emptyDoneRounds(), now }).done).toBe(true);
  });

  it("nothing is done without a working goal, or while the goal is unclear", () => {
    expect(judgeTaskDone({ working: null, fact: null, rounds: emptyDoneRounds(), now: since * 2 }).done).toBe(false);
    expect(judgeTaskDone({ working: { goal: "unclear", since }, fact: null, rounds: emptyDoneRounds(), now: since * 2 }).done).toBe(false);
  });
});

describe("when task candidates are sent", () => {
  const since = 1_000_000;
  it("with a code fact, only when it is true", () => {
    const w = { goal: "collect_payments" as const, since };
    expect(mightBeDone(w, { done: false, title: "", detail: "" }, emptyDoneRounds())).toBe(false);
    expect(mightBeDone(w, { done: true, title: "", detail: "" }, emptyDoneRounds())).toBe(true);
  });

  it("without one, when the previous round in this context judged goal-done at the named threshold or more", () => {
    const w = { goal: "plan_day" as const, since };
    expect(mightBeDone(w, null, emptyDoneRounds())).toBe(false);
    expect(mightBeDone(w, null, countDoneRound(emptyDoneRounds(), w, TASK_CANDIDATES_AT - 0.01, 1))).toBe(false);
    expect(mightBeDone(w, null, countDoneRound(emptyDoneRounds(), w, TASK_CANDIDATES_AT, 1))).toBe(true);
    // A round about another context does not count.
    expect(mightBeDone({ goal: "plan_day", since: since + 1 }, null, countDoneRound(emptyDoneRounds(), w, 0.9, 1))).toBe(false);
    expect(mightBeDone(null, null, emptyDoneRounds())).toBe(false);
  });
});

describe("the next task on the card", () => {
  const tasks = buildNextTasks({ data: data(), handled: REMINDED, now: todayAt(12), exclude: "collect_payments" });

  it("offers Jev's pick when it passes the gate, else code's top-ranked candidate", () => {
    expect(tasks[0].id).toBe("unread_messages");
    const sure = chooseNextTask(tasks, choiceJ<string>("tasks_due_today", 0.7, { tasks_due_today: 0.62, unread_messages: 0.2, none: 0.05 }));
    expect(sure).toMatchObject({ source: "jev", why: "Jev 62%" });
    expect(sure?.task.id).toBe("tasks_due_today");
    const unsure = chooseNextTask(tasks, choiceJ<string>("tasks_due_today", 0.2, { tasks_due_today: 0.38, unread_messages: 0.35, none: 0.1 }));
    expect(unsure).toMatchObject({ source: "code", why: TASK_PRIORITY.unread_messages.why });
    expect(unsure?.task.id).toBe("unread_messages");
    expect(chooseNextTask(tasks, undefined)?.source).toBe("code");
    expect(chooseNextTask([], undefined)).toBeNull();
  });

  it("the gate: 0.5 on its own, or 0.4 with a clear lead and little on none; never none or a task no longer offered", () => {
    expect(confidentTask(choiceJ<string>("a", 0.5, { a: 0.5, b: 0.3 }))?.id).toBe("a");
    expect(confidentTask(choiceJ<string>("a", 0.4, { a: 0.42, b: 0.25, none: 0.1 }))?.id).toBe("a");
    expect(confidentTask(choiceJ<string>("a", 0.4, { a: 0.42, b: 0.3, none: 0.1 }))).toBeNull();
    expect(confidentTask(choiceJ<string>("a", 0.4, { a: 0.42, b: 0.1, none: 0.25 }))).toBeNull();
    expect(confidentTask(choiceJ("none", 0.9, { none: 0.9 }))).toBeNull();
    const gone = chooseNextTask(tasks, choiceJ<string>("overdue_invoices", 0.9, { overdue_invoices: 0.9 }));
    expect(gone?.source).toBe("code");
  });
});

describe("the view change Start makes", () => {
  const byId = (d: AppData, exclude: Parameters<typeof buildNextTasks>[0]["exclude"] = null) =>
    Object.fromEntries(buildNextTasks({ data: d, handled: new Set(), now: todayAt(10, 20), exclude }).map((t) => [t.id, t]));

  it("sets each task's filter and selects its first record", () => {
    const d = data();
    const t = byId(d);
    expect(taskViewPatch(t.unread_messages, d)).toEqual({ panel: "inbox", patch: { query: "", client: null, selectedId: "m-1" } });
    expect(taskViewPatch(t.overdue_invoices, d)).toEqual({ panel: "invoices", patch: { status: "overdue", client: null, selectedId: "INV-1038" } });
    expect(taskViewPatch(t.tasks_due_today, d)).toEqual({ panel: "tasks", patch: { client: null, showDone: false, selectedId: "t-1" } });
    expect(taskViewPatch(t.next_meeting, d)).toEqual({ panel: "calendar", patch: { range: "today", selectedId: "e-2" } });
    // At risk and blocked projects together: All, so both show.
    expect(taskViewPatch(t.projects_at_risk, d)).toEqual({ panel: "projects", patch: { status: "all", selectedId: "p-atlas" } });
  });

  it("filters projects to the one status they share", () => {
    const d = data();
    for (const p of d.projects) if (p.status === "blocked") p.status = "on_track";
    expect(taskViewPatch(byId(d).projects_at_risk, d)?.patch).toMatchObject({ status: "at_risk" });
  });
});
