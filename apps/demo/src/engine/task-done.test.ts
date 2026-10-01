/**
 * Focus aid 2, "Say when a task is done", in the store: the Done card takes
 * the Up next slot when the working goal is done (never in its first
 * minute), the requests carry the working goal and, only when it might be
 * done, the task candidates, Start saves a Back to context and opens,
 * filters, and selects without acting, "Not now" hides the card for five
 * minutes, and the switch off keeps the older behavior exactly. The API is
 * mocked, as in store.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalId, LayoutMode } from "../../shared/catalog.ts";
import type { AdaptRequest, AdaptResponse, Judgments } from "../../shared/types.ts";
import { postAdapt } from "./api.ts";
import { summarizeMetrics } from "./metrics.ts";
import { triggersRequest } from "./scheduler.ts";
import { buildSnapshot, describeEvent } from "./snapshot.ts";
import { DEFAULT_SETTINGS, useEngine } from "./store.ts";
import { TASK_DONE_MIN_WORK_MS, TASK_DONE_SNOOZE_MS } from "./taskDone.ts";
import { choiceJ, makeJudgments } from "./test-helpers.ts";
import { USAGE_WEIGHTS } from "./usage.ts";

vi.mock("./api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.ts")>();
  return { ...actual, postAdapt: vi.fn(), getHealth: vi.fn(async () => ({ ok: true, jev: true })) };
});

const mockedPost = vi.mocked(postAdapt);

function response(version: number, judgments: Judgments): AdaptResponse {
  return { version, source: "jev", judgments, meta: { model: "jev-1.13.0", latencyMs: 200, questionCount: 18 }, debug: { state: {}, questions: {} } };
}

function answerWith(j: Judgments) {
  mockedPost.mockImplementation(async (req: AdaptRequest) => response(req.version, j));
}

const payments = makeJudgments({
  rel: { invoices: 2, clients: 1.4, inbox: 1.2, calendar: 0.8, tasks: 0.8 },
  goal: choiceJ<GoalId>("collect_payments", 0.9, { collect_payments: 0.9, unclear: 0.1 }),
  layout: choiceJ<LayoutMode>("focus", 0.9, { focus: 0.9 }),
});

const planning = makeJudgments({
  rel: { calendar: 2, tasks: 1.6, inbox: 0.8 },
  goal: choiceJ<GoalId>("plan_day", 0.9, { plan_day: 0.9, unclear: 0.1 }),
  layout: choiceJ<LayoutMode>("overview", 0.9, { overview: 0.9 }),
});

const engine = () => useEngine.getState();
const requests = () => mockedPost.mock.calls.map((c) => c[0]);

/** Filter to overdue: the round adopts collecting payments as the working goal. */
async function startCollecting() {
  engine().track({ type: "filter", panel: "invoices", detail: { filter: { status: "overdue" }, via: "pointer" } });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(engine().working?.goal).toBe("collect_payments");
}

/** Send a reminder on every overdue invoice, one round each. */
async function remindAll() {
  for (const invoiceId of ["INV-1038", "INV-1042", "INV-1047"]) {
    engine().perform("send_payment_reminder", { invoiceId });
    await vi.advanceTimersByTimeAsync(3_000);
  }
}

let clock = 5_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  clock += 10_000_000;
  vi.setSystemTime(clock);
  mockedPost.mockReset();
  answerWith(payments);
  engine().reset();
  // Habits outlive Reset (focus aid 3), so each test starts with none.
  engine().forgetHabits();
  engine().setSettings({ ...structuredClone(DEFAULT_SETTINGS) });
  for (const p of engine().pinned) engine().unpin(p);
  engine().reset();
});

afterEach(() => {
  engine().setCanvasHold("pointer", false);
  engine().setPointer({ panel: null, down: false });
  engine().reset();
  vi.useRealTimers();
});

describe("the Done card for a goal with a code fact", () => {
  it("says payments are done once every overdue invoice has a reminder, never in the working goal's first minute, and offers the next task", async () => {
    await startCollecting();
    const since = engine().working!.since;
    await remindAll();
    // Done by the data, but the working goal is younger than a minute: the Up next completion line still shows.
    expect(Date.now() - since).toBeLessThan(TASK_DONE_MIN_WORK_MS);
    expect(engine().taskDone).toBeNull();
    expect(engine().upNextDone?.text).toBe("All overdue invoices have a reminder.");
    await vi.advanceTimersByTimeAsync(since + TASK_DONE_MIN_WORK_MS - Date.now());
    const card = engine().taskDone;
    expect(card).toMatchObject({ goal: "collect_payments", title: "Payments done", detail: "every overdue invoice has a reminder.", source: "code" });
    // The top code-ranked task (no meeting or task is due at the test clock's date), chosen by code since Jev gave no next task.
    expect(card?.next).toMatchObject({ id: "unread_messages", text: "4 unread client messages", panel: "inbox" });
    expect(card?.nextSource).toBe("code");
    // It takes the Up next slot.
    expect(engine().upNext).toBeNull();
    expect(engine().upNextDone).toBeNull();
    // Announced once, as the engine's own note that Jev never reads.
    const done = engine().events.filter((e) => e.type === "task_done");
    expect(done).toHaveLength(1);
    expect(done[0].text).toBe('Said "Collecting payments" is done, and offered the next task: four unread client messages');
    const snap = buildSnapshot(engine().events, { now: Date.now(), focusedPanel: "invoices", visiblePanels: ["invoices"] });
    expect(snap.recent_activity.some((l) => l.includes("is done"))).toBe(false);
    expect(triggersRequest("task_done", false)).toBe(false);
    expect(USAGE_WEIGHTS.task_done).toBe(0);
    expect(engine().metrics.taskDone).toEqual({ done: 1, offered: 1, started: 0 });
  });

  it("sends the working goal on every request, and the task candidates only once the goal might be done", async () => {
    await startCollecting();
    // The round that adopted the goal was asked before there was one.
    expect(requests()[0].workingGoal).toBeUndefined();
    engine().perform("send_payment_reminder", { invoiceId: "INV-1038" });
    await vi.advanceTimersByTimeAsync(3_000);
    const mid = requests().at(-1)!;
    expect(mid.workingGoal).toEqual({ label: "Collecting payments", description: "Checking unpaid or overdue invoices and getting clients to pay them." });
    expect(mid.candidates.tasks).toBeUndefined();
    engine().perform("send_payment_reminder", { invoiceId: "INV-1042" });
    await vi.advanceTimersByTimeAsync(3_000);
    engine().perform("send_payment_reminder", { invoiceId: "INV-1047" });
    await vi.advanceTimersByTimeAsync(3_000);
    const last = requests().at(-1)!;
    // Every other goal's pending work, never the working goal's own.
    expect(last.candidates.tasks?.map((t) => t.id)).toEqual(["unread_messages", "projects_at_risk"]);
    expect(last.candidates.tasks?.[0]).toEqual({
      id: "unread_messages",
      goal: "triage_inbox",
      label: "Unread client messages to reply to",
      count: "four",
      first: "\"Re: Invoice INV-1042\" from Priya Nair at Harbor Coffee Co.",
    });
  });

  it("offers Jev's next task when it is sure enough, else code's", async () => {
    answerWith({ ...payments, nextTask: choiceJ<string>("projects_at_risk", 0.7, { projects_at_risk: 0.72, unread_messages: 0.2, none: 0.03 }) });
    await startCollecting();
    await remindAll();
    await vi.advanceTimersByTimeAsync(TASK_DONE_MIN_WORK_MS);
    expect(engine().taskDone?.next?.id).toBe("projects_at_risk");
    expect(engine().taskDone).toMatchObject({ nextSource: "jev", nextWhy: "Jev 72%" });
  });

  it("goes away when the working goal has open work again, and says so again after the next completion", async () => {
    await startCollecting();
    await remindAll();
    await vi.advanceTimersByTimeAsync(TASK_DONE_MIN_WORK_MS);
    expect(engine().taskDone).not.toBeNull();
    // A reopened overdue invoice (made overdue again here by hand) is open work.
    const data = engine().data;
    useEngine.setState({ data: { ...data, invoices: data.invoices.map((i) => (i.id === "INV-1049" ? { ...i, status: "overdue" as const } : i)) } });
    engine().setView("invoices", { status: "overdue" });
    expect(engine().taskDone).toBeNull();
    engine().perform("send_payment_reminder", { invoiceId: "INV-1049" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().taskDone?.title).toBe("Payments done");
    expect(engine().events.filter((e) => e.type === "task_done")).toHaveLength(2);
  });
});

describe("Start", () => {
  it("saves the current context as a Back to chip, opens the task's panel from the dock, sets its filter, selects the first record, and performs no action", async () => {
    await startCollecting();
    // Inbox in the dock, with a search that would hide the message.
    engine().dismiss("inbox");
    engine().setView("inbox", { query: "printer", client: "Meridian Hotels" });
    await remindAll();
    await vi.advanceTimersByTimeAsync(TASK_DONE_MIN_WORK_MS);
    expect(engine().plan.placements.some((p) => p.id === "inbox")).toBe(false);
    const before = structuredClone(engine().data);
    const actionsBefore = engine().events.filter((e) => e.type === "action").length;

    engine().startNextTask("keyboard");

    // Back to: the payments work, one click away.
    expect(engine().contexts[0]).toMatchObject({ goal: "collect_payments", label: expect.stringMatching(/^Collecting payments/) });
    expect(engine().working?.goal).toBe("triage_inbox");
    // The panel is on the canvas, filtered, with the first record selected the way a click does.
    expect(engine().plan.placements.some((p) => p.id === "inbox")).toBe(true);
    expect(engine().view.inbox).toEqual({ query: "", client: null, selectedId: "m-1" });
    expect(engine().focusedPanel).toBe("inbox");
    expect(engine().anchor).toMatchObject({ panel: "inbox", itemId: "m-1", source: "work" });
    // Nothing was done for the user.
    expect(engine().data).toEqual(before);
    expect(engine().events.filter((e) => e.type === "action")).toHaveLength(actionsBefore);
    const start = engine().events.at(-1)!;
    expect(start).toMatchObject({ type: "task_start", panel: "inbox", detail: { itemId: "m-1", task: "four unread client messages", via: "keyboard" } });
    expect(start.text).toBe(
      'Started the next task: four unread client messages, and opened message "Re: Invoice INV-1042" from Priya Nair at Harbor Coffee Co. in Inbox, using the keyboard',
    );
    // A user signal Jev reads, that asks for a new read.
    expect(triggersRequest("task_start", false)).toBe(true);
    expect(engine().taskDone).toBeNull();
    expect(engine().metrics.taskDone).toEqual({ done: 1, offered: 1, started: 1 });
    expect(summarizeMetrics(engine().metrics, Date.now()).find((l) => l.id === "next-task")?.value).toBe("1 of 1 (100%)");
    // The card does not come back for the same completion, even back on the payments work.
    await vi.advanceTimersByTimeAsync(TASK_DONE_MIN_WORK_MS);
    engine().restoreContext(engine().contexts[0].id);
    await vi.advanceTimersByTimeAsync(TASK_DONE_MIN_WORK_MS + 1_000);
    expect(engine().working?.goal).toBe("collect_payments");
    expect(engine().taskDone).toBeNull();
  });

  it("does nothing without a Done card that offers a next task", async () => {
    await startCollecting();
    const events = engine().events.length;
    engine().startNextTask();
    expect(engine().events).toHaveLength(events);
    expect(engine().working?.goal).toBe("collect_payments");
  });
});

describe("Not now and dismiss", () => {
  it("Not now hides the card for that goal for five minutes, then it comes back without a second announcement", async () => {
    await startCollecting();
    await remindAll();
    await vi.advanceTimersByTimeAsync(TASK_DONE_MIN_WORK_MS);
    expect(engine().taskDone).not.toBeNull();
    engine().snoozeTaskDone();
    expect(engine().taskDone).toBeNull();
    await vi.advanceTimersByTimeAsync(TASK_DONE_SNOOZE_MS - 1_000);
    expect(engine().taskDone).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(engine().taskDone?.title).toBe("Payments done");
    expect(engine().events.filter((e) => e.type === "task_done")).toHaveLength(1);
  });

  it("a card with no pending task elsewhere only says the done line, and dismissing it keeps it away", async () => {
    await startCollecting();
    // Nothing else pending: every client message read, every project on track (no task or meeting is due at the test clock's date).
    const data = engine().data;
    useEngine.setState({
      data: {
        ...data,
        messages: data.messages.map((m) => ({ ...m, unread: false })),
        projects: data.projects.map((p) => (p.status === "done" ? p : { ...p, status: "on_track" as const })),
      },
    });
    await remindAll();
    await vi.advanceTimersByTimeAsync(TASK_DONE_MIN_WORK_MS);
    expect(engine().taskDone).toMatchObject({ title: "Payments done", next: null });
    expect(engine().events.filter((e) => e.type === "task_done")[0].text).toBe('Said "Collecting payments" is done');
    engine().dismissTaskDone();
    expect(engine().taskDone).toBeNull();
    await vi.advanceTimersByTimeAsync(TASK_DONE_SNOOZE_MS * 2);
    engine().track({ type: "panel_focus", panel: "invoices", detail: { via: "pointer" } });
    expect(engine().taskDone).toBeNull();
    expect(engine().metrics.taskDone).toEqual({ done: 1, offered: 0, started: 0 });
  });
});

describe("a goal without a code fact", () => {
  async function planRound(query: string) {
    engine().track({ type: "search", panel: "calendar", detail: { query } });
    await vi.advanceTimersByTimeAsync(3_000);
  }

  it("is done after two rounds in a row of Jev's goal-done at 0.75 or more, and not in the first minute", async () => {
    answerWith({ ...planning, goalDone: 0.8 });
    await planRound("today");
    expect(engine().working?.goal).toBe("plan_day");
    // The adopting round was not asked about plan_day, so it does not count; one round that was is not enough.
    await planRound("meetings");
    await vi.advanceTimersByTimeAsync(TASK_DONE_MIN_WORK_MS);
    expect(engine().taskDone).toBeNull();
    // The request after a high round carries the task candidates, ready for the round that says done.
    await planRound("afternoon");
    expect(requests().at(-1)?.candidates.tasks?.length).toBeGreaterThan(0);
    expect(engine().taskDone).toMatchObject({ goal: "plan_day", title: "Planning the day looks done", source: "jev", probability: 0.8 });
    expect(engine().taskDone?.next?.goal).not.toBe("plan_day");
  });

  it("a round below the threshold breaks the streak and takes the card away", async () => {
    answerWith({ ...planning, goalDone: 0.8 });
    await planRound("today");
    await planRound("meetings");
    await planRound("afternoon");
    await vi.advanceTimersByTimeAsync(TASK_DONE_MIN_WORK_MS);
    expect(engine().taskDone).not.toBeNull();
    answerWith({ ...planning, goalDone: 0.3 });
    await planRound("tomorrow");
    expect(engine().taskDone).toBeNull();
    // Low rounds send no task candidates.
    await planRound("next week");
    expect(requests().at(-1)?.candidates.tasks).toBeUndefined();
  });

  it("the heuristic's modest goal-done never says it is done", async () => {
    mockedPost.mockImplementation(async (req: AdaptRequest) => ({ ...response(req.version, { ...planning, goalDone: 0.6 }), source: "heuristic" as const }));
    await planRound("today");
    for (const q of ["a", "b", "c", "d"]) await planRound(q);
    await vi.advanceTimersByTimeAsync(TASK_DONE_MIN_WORK_MS);
    expect(engine().taskDone).toBeNull();
  });
});

describe("the switch", () => {
  it("is on by default; off keeps the older behavior exactly: no card, no working goal or tasks sent, the Up next completion line as before", async () => {
    expect(engine().settings.focusAids.taskDone).toBe(true);
    engine().setFocusAid("taskDone", false);
    await startCollecting();
    await remindAll();
    await vi.advanceTimersByTimeAsync(TASK_DONE_MIN_WORK_MS);
    expect(engine().taskDone).toBeNull();
    expect(engine().upNextDone?.text).toBe("All overdue invoices have a reminder.");
    expect(requests().every((r) => r.workingGoal === undefined && r.candidates.tasks === undefined)).toBe(true);
    expect(engine().events.some((e) => e.type === "task_done")).toBe(false);
    // Switching it on works at once: the working goal was followed all along.
    engine().setFocusAid("taskDone", true);
    expect(engine().taskDone?.title).toBe("Payments done");
    // And off again takes the card away at once, giving the slot back.
    engine().setFocusAid("taskDone", false);
    expect(engine().taskDone).toBeNull();
    expect(engine().upNextDone?.text).toBe("All overdue invoices have a reminder.");
  });

  it("describes the start signal on its own too", () => {
    expect(describeEvent({ type: "task_start", panel: "calendar", detail: { task: "the next meeting, Harbor rebrand review, starting in about half an hour" } })).toBe(
      "Started the next task: the next meeting, Harbor rebrand review, starting in about half an hour",
    );
  });
});
