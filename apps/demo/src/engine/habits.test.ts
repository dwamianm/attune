/**
 * Focus aid 3, "Learn my habits" (docs/focus-aids.md): the pure parts. The
 * decayed counts and their cap, the moves per time of day, the evidence
 * bar, the action after a record kind, the words Jev reads, persistence
 * that never throws, the sample week, and how code uses the habits: the
 * policy's habit part and reason, the subtle suggestion, and the Up next
 * and next-task boosts. The store side is in habits-store.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { ActionId, PanelId } from "../../shared/catalog.ts";
import { EVENTS, INVOICES, MESSAGES, PROJECTS, TASKS } from "../../shared/fixtures.ts";
import type { RecordCandidate, SignalEvent, SignalType, TrackInput } from "../../shared/types.ts";
import type { AppData, HabitHints, HabitMemory, PanelViewState, PolicyInput } from "./contract.ts";
import {
  bumpCount,
  clearSavedHabits,
  decayed,
  describeHabits,
  emptyHabits,
  emptyTrail,
  HABIT_FORGET_BELOW,
  HABIT_HALF_LIFE_MS,
  HABIT_MAX_ENTRIES,
  HABIT_MIN_COUNT,
  HABIT_OBSERVATIONS_MAX,
  HABIT_TASK_BOOST_MAX,
  HABIT_TASK_WHY,
  HABIT_WEIGHT,
  HABITS_STORAGE_KEY,
  habitHints,
  habitObservations,
  habitReason,
  habitStep,
  habitTaskBoost,
  isHabit,
  learnGoal,
  loadHabits,
  mergeHabits,
  nextGoals,
  nextPanels,
  pruneCounts,
  readHabits,
  sampleWeek,
  saveHabits,
  timeOfDay,
  topNextPanel,
  type HabitTrail,
} from "./habits.ts";
import { buildRecordCandidates, chooseUpNext, UP_NEXT_HABIT_LIFT } from "./nextUp.ts";
import { buildSuggestions, computePlan, defaultPlan, HABIT_SUGGEST_NONE_BELOW } from "./policy.ts";
import { describeEvent } from "./snapshot.ts";
import { buildNextTasks, TASK_PRIORITY } from "./taskDone.ts";
import { choiceJ, makeJudgments } from "./test-helpers.ts";

const DAY = 24 * 60 * 60_000;
/** A local time on September 30, 2026. */
const at = (h: number, m = 0) => new Date(2026, 8, 30, h, m).getTime();
const MORNING = at(9);
const AFTERNOON = at(14);

let seq = 0;
function e(type: SignalType, t: number, panel?: PanelId, detail?: TrackInput["detail"]): SignalEvent {
  const input: TrackInput = { type, ...(panel ? { panel } : {}), ...(detail ? { detail } : {}) };
  return { ...input, id: ++seq, t, text: describeEvent(input) };
}

/** Feed events through habitStep, learning, and return the memory, trail, and guesses. */
function learn(events: SignalEvent[], memory: HabitMemory = emptyHabits(), trail: HabitTrail = emptyTrail(), learnOn = true) {
  const guesses: { panel: PanelId; right: boolean }[] = [];
  for (const x of events) {
    const step = habitStep(memory, trail, x, { learn: learnOn });
    memory = step.memory;
    trail = step.trail;
    if (step.guess) guesses.push(step.guess);
  }
  return { memory, trail, guesses };
}

/** `n` moves from Inbox to `to`, each a search in Inbox then a filter in `to`, a minute apart, starting at `t`. */
function moves(to: PanelId, n: number, t: number): SignalEvent[] {
  const out: SignalEvent[] = [];
  for (let i = 0; i < n; i++) {
    out.push(e("search", t + i * 120_000, "inbox", { query: "harbor" }));
    out.push(e("filter", t + i * 120_000 + 60_000, to, { filter: { range: "today" } }));
  }
  return out;
}

describe("decayed counts", () => {
  it("halve every half-life, add up when counted again, and drop when faded", () => {
    const c = { n: 4, at: 0 };
    expect(decayed(c, 0)).toBe(4);
    expect(decayed(c, HABIT_HALF_LIFE_MS)).toBeCloseTo(2, 10);
    expect(decayed(c, 2 * HABIT_HALF_LIFE_MS)).toBeCloseTo(1, 10);
    expect(decayed(undefined, 0)).toBe(0);
    const bumped = bumpCount({ k: c }, "k", HABIT_HALF_LIFE_MS);
    expect(bumped.k).toEqual({ n: 3, at: HABIT_HALF_LIFE_MS });
    // Faded below HABIT_FORGET_BELOW: gone on the next prune.
    const faded = { n: HABIT_FORGET_BELOW * 1.9, at: 0 };
    expect(Object.keys(pruneCounts({ faded, k: c }, HABIT_HALF_LIFE_MS))).toEqual(["k"]);
  });

  it("keep at most HABIT_MAX_ENTRIES per kind, the weakest dropped first", () => {
    const map: Record<string, { n: number; at: number }> = {};
    for (let i = 0; i < HABIT_MAX_ENTRIES + 20; i++) map[`k${String(i).padStart(3, "0")}`] = { n: 1 + i, at: 0 };
    const kept = pruneCounts(map, 0);
    expect(Object.keys(kept)).toHaveLength(HABIT_MAX_ENTRIES);
    // The 20 weakest (n 1 to 20) went.
    expect(kept.k000).toBeUndefined();
    expect(kept.k019).toBeUndefined();
    expect(kept.k020).toBeDefined();
    expect(kept[`k${HABIT_MAX_ENTRIES + 19}`]).toBeDefined();
  });
});

describe("learning moves", () => {
  it("buckets the time of day: morning before 12, afternoon 12 to 17, evening from 17", () => {
    expect(timeOfDay(at(11, 59))).toBe("morning");
    expect(timeOfDay(at(12))).toBe("afternoon");
    expect(timeOfDay(at(16, 59))).toBe("afternoon");
    expect(timeOfDay(at(17))).toBe("evening");
  });

  it("counts the next different panel worked in, per time of day, and where each session starts", () => {
    const { memory } = learn([
      e("item_open", MORNING, "inbox", { itemKind: "message", itemId: "m-1", client: "Harbor Coffee Co." }),
      e("search", MORNING + 1_000, "inbox", { query: "harbor" }), // the same panel: no move
      e("filter", MORNING + 2_000, "calendar", { filter: { range: "today" } }),
      e("action", MORNING + 3_000, "tasks", { label: "Checked off task: Send proofs", itemKind: "task", itemId: "t-1" }),
      // After the session gap, a new session starts in the afternoon.
      e("search", AFTERNOON, "inbox", { query: "invoice" }),
      e("filter", AFTERNOON + 1_000, "invoices", { filter: { status: "overdue" } }),
    ]);
    expect(Object.keys(memory.start).sort()).toEqual(["afternoon|inbox", "morning|inbox"]);
    expect(Object.keys(memory.panel).sort()).toEqual(["afternoon|inbox>invoices", "morning|calendar>tasks", "morning|inbox>calendar"]);
    expect(memory.panel["morning|inbox>calendar"].n).toBe(1);
  });

  it("never counts engine-made or cue-only signals, looking around, suggestions, the command bar, or opens from Up next and Start", () => {
    const { memory } = learn([
      e("search", MORNING, "inbox", { query: "x" }),
      e("panel_focus", MORNING + 1_000, "calendar", { via: "pointer" }),
      e("panel_dwell", MORNING + 2_000, "tasks", { durationMs: 3_000 }),
      e("scroll", MORNING + 3_000, "projects"),
      e("action", MORNING + 4_000, "invoices", { actionId: "send_payment_reminder", itemId: "INV-1042", via: "suggestion" }),
      e("filter", MORNING + 5_000, "clients", { filter: { client: "x" }, via: "command" }),
      e("up_next_open", MORNING + 6_000, "invoices", { itemKind: "invoice", itemId: "INV-1038" }),
      e("task_start", MORNING + 7_000, "tasks", { itemKind: "task", itemId: "t-1", task: "two tasks" }),
      e("task_done", MORNING + 8_000, undefined, { label: "Collecting payments" }),
      e("context_save", MORNING + 9_000, undefined, { label: "x" }),
      e("setting_change", MORNING + 10_000, undefined, { setting: "habits", enabled: true }),
      e("links_dismiss", MORNING + 11_000, "team", { label: "x" }),
    ]);
    expect(memory.panel).toEqual({});
    expect(memory.start).toEqual({ "morning|inbox": { n: 1, at: MORNING } });
  });

  it("counts the first action about a record after opening it, by kind, within the window", () => {
    const { memory } = learn([
      e("item_open", MORNING, "invoices", { itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co." }),
      e("action", MORNING + 5_000, "invoices", { actionId: "send_payment_reminder", itemId: "INV-1042", client: "Harbor Coffee Co." }),
      // A second action on the same open is not "the action after opening it".
      e("action", MORNING + 6_000, "invoices", { actionId: "mark_invoice_paid", itemId: "INV-1042", client: "Harbor Coffee Co." }),
      // "Schedule meeting" in Clients is logged on Calendar, for the client: it counts for the client opened.
      e("item_open", MORNING + 10_000, "clients", { itemKind: "client", itemId: "c-harbor", client: "Harbor Coffee Co." }),
      e("action", MORNING + 12_000, "calendar", { actionId: "schedule_meeting", itemId: "e-new-1", client: "Harbor Coffee Co." }),
      // Too late: the open is about something else by then.
      e("item_open", MORNING + 20_000, "inbox", { itemKind: "message", itemId: "m-1", client: "Harbor Coffee Co." }),
      e("action", MORNING + 20_000 + 6 * 60_000, "inbox", { actionId: "reply_to_message", itemId: "m-1" }),
      // From a suggestion: it uses up the open, but teaches nothing.
      e("item_open", MORNING + 30 * 60_000, "projects", { itemKind: "project", itemId: "p-kite", client: "Kite & Co." }),
      e("action", MORNING + 30 * 60_000 + 1_000, "projects", { actionId: "update_project_status", itemId: "p-kite", via: "suggestion" }),
    ]);
    expect(Object.keys(memory.action).sort()).toEqual(["client>schedule_meeting", "invoice>send_payment_reminder"]);
  });

  it("counts a goal move only between two real goals", () => {
    let m = learnGoal(emptyHabits(), "collect_payments", "triage_inbox", MORNING);
    m = learnGoal(m, null, "plan_day", MORNING);
    m = learnGoal(m, "plan_day", "plan_day", MORNING);
    m = learnGoal(m, "plan_day", "unclear", MORNING);
    expect(m.goal).toEqual({ "collect_payments>triage_inbox": { n: 1, at: MORNING } });
  });
});

describe("the evidence bar", () => {
  it("needs three times and 40% of the moves from there, so one-off moves never count", () => {
    const twice = learn(moves("calendar", 2, MORNING)).memory;
    expect(nextPanels(twice, "inbox", "morning", MORNING + DAY / 10)).toEqual([]);
    const thrice = learn(moves("calendar", 3, MORNING)).memory;
    expect(nextPanels(thrice, "inbox", "morning", MORNING + 600_000).map((o) => o.to)).toEqual(["calendar"]);
    // Only in its own time of day.
    expect(nextPanels(thrice, "inbox", "afternoon", MORNING + 600_000)).toEqual([]);
    // Three times, but spread over four panels: a quarter each is no habit.
    let spread = thrice;
    for (const to of ["tasks", "clients", "projects"] as PanelId[]) spread = learn(moves(to, 3, MORNING + 3_600_000), spread).memory;
    expect(nextPanels(spread, "inbox", "morning", MORNING + 7_200_000)).toEqual([]);
    expect(isHabit({ count: 3, share: 0.39 })).toBe(false);
    expect(isHabit({ count: HABIT_MIN_COUNT - 0.01, share: 1 })).toBe(false);
    expect(isHabit({ count: HABIT_MIN_COUNT, share: 0.4 })).toBe(true);
    // Two moves can never reach the bar, however recent; three in the last three days do.
    expect(2).toBeLessThan(HABIT_MIN_COUNT);
    expect(3 * Math.pow(0.5, 3 / 14)).toBeGreaterThan(HABIT_MIN_COUNT);
  });

  it("checks the habit's guess before learning the move, with learning on or off", () => {
    const base = learn(moves("calendar", 3, MORNING)).memory;
    const later = MORNING + 3_600_000;
    const off = learn([e("search", later, "inbox", { query: "x" }), e("filter", later + 1_000, "calendar", { filter: {} })], base, emptyTrail(), false);
    // One session started in Inbox (no start habit yet), then Calendar: one right guess.
    expect(off.guesses).toEqual([{ panel: "calendar", right: true }]);
    // With a start habit (the sample week), the session start is a guess too.
    const started = learn([e("search", later, "inbox", { query: "x" })], sampleWeek(later), emptyTrail(), false);
    expect(started.guesses).toEqual([{ panel: "inbox", right: true }]);
    // Off: nothing learned.
    expect(off.memory).toBe(base);
    const wrong = learn([e("search", later, "inbox", { query: "x" }), e("filter", later + 1_000, "tasks", { filter: {} })], base);
    expect(wrong.guesses.at(-1)).toEqual({ panel: "calendar", right: false });
  });
});

describe("using the habits", () => {
  const sample = sampleWeek(MORNING);

  it("gives the hints: the chance of each usual next panel, the top one, and the usual action after the open record", () => {
    const hints = habitHints(sample, { from: "inbox", now: MORNING, record: { kind: "invoice", id: "INV-1042", client: "Harbor Coffee Co." } });
    expect(hints?.from).toBe("inbox");
    expect(hints?.bucket).toBe("morning");
    expect(Object.keys(hints?.next ?? {})).toEqual(["calendar"]);
    expect(hints?.next.calendar).toBeGreaterThan(0.75);
    expect(topNextPanel(hints)).toBe("calendar");
    expect(hints?.action).toMatchObject({ kind: "invoice", recordId: "INV-1042", actionId: "send_payment_reminder" });
    expect(habitReason(hints!, "calendar")).toBe("You usually open Calendar after Inbox in the morning");
    const start = habitHints(sample, { from: null, now: AFTERNOON });
    expect(start?.next).toHaveProperty("inbox");
    expect(habitReason(start!, "inbox")).toBe("You usually start in Inbox in the afternoon");
    // Nothing learned: no hints at all, so the policy plans as before.
    expect(habitHints(emptyHabits(), { from: "inbox", now: MORNING })).toBeNull();
  });

  it("puts at most two habits in the words Jev reads, phrased as habits, strongest first", () => {
    const lines = habitObservations(sample, {
      from: "inbox",
      now: MORNING,
      record: { kind: "message", id: "m-1", client: "Harbor Coffee Co." },
      goal: "triage_inbox",
    });
    expect(HABIT_OBSERVATIONS_MAX).toBe(2);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line).toMatch(/^Usually /);
    expect(lines).toContain("Usually opens Calendar after Inbox in the morning");
    const all = [
      "Usually opens Calendar after Inbox in the morning",
      "Usually replies after opening a message",
      "Usually moves on to planning the day after working through the inbox",
    ];
    for (const line of lines) expect(all).toContain(line);
    expect(habitObservations(emptyHabits(), { from: "inbox", now: MORNING })).toEqual([]);
  });

  it("boosts the next task by the goal habit, under 1, so it reorders only near neighbors", () => {
    let m = emptyHabits();
    for (let i = 0; i < 4; i++) m = learnGoal(m, "collect_payments", "plan_day", MORNING);
    const boost = habitTaskBoost(m, MORNING);
    const task = { goal: "plan_day" } as Parameters<typeof boost>[0];
    expect(boost(task, "collect_payments")).toBeCloseTo(HABIT_TASK_BOOST_MAX, 10);
    expect(boost(task, "collect_payments")).toBeLessThan(1);
    expect(boost(task, "triage_inbox")).toBe(0);
    expect(boost(task, null)).toBe(0);

    // Only projects at risk (1) and a meeting later today (0.5) are pending: the habit lifts the meeting past the projects.
    const now = at(8);
    const data: AppData = {
      invoices: INVOICES.map((i) => ({ ...i, status: "paid" as const })),
      messages: MESSAGES.map((x) => ({ ...x, unread: false })),
      tasks: TASKS.map((t) => ({ ...t, done: true })),
      projects: structuredClone(PROJECTS),
      events: [{ id: "e-late", title: "Harbor rebrand review", start: new Date(at(15)).toISOString(), end: new Date(at(16)).toISOString(), client: "Harbor Coffee Co.", kind: "meeting" }],
      notes: "",
    };
    const plain = buildNextTasks({ data, handled: new Set(), now, exclude: "collect_payments" });
    expect(plain.map((t) => t.id)).toEqual(["projects_at_risk", "next_meeting"]);
    const boosted = buildNextTasks({ data, handled: new Set(), now, exclude: "collect_payments", boost: habitTaskBoost(m, now), boostWhy: HABIT_TASK_WHY });
    expect(boosted.map((t) => t.id)).toEqual(["next_meeting", "projects_at_risk"]);
    expect(boosted[0].why).toBe(HABIT_TASK_WHY);
    expect(boosted[1].why).toBe(TASK_PRIORITY.projects_at_risk.why);

    // With the day's usual work pending, the same boost never passes a whole priority step: overdue invoices (3) stay ahead of tasks due today (2 + 0.9).
    const busy: AppData = { ...data, invoices: structuredClone(INVOICES), tasks: structuredClone(TASKS), events: structuredClone(EVENTS) };
    const order = buildNextTasks({ data: busy, handled: new Set(), now, exclude: "triage_inbox", boost: habitTaskBoost(m, now), boostWhy: HABIT_TASK_WHY }).map((t) => t.id);
    const unboosted = buildNextTasks({ data: busy, handled: new Set(), now, exclude: "triage_inbox" }).map((t) => t.id);
    expect(order).toEqual(unboosted);
  });
});

describe("saved in this browser", () => {
  it("round-trips, reads only valid counts, and never throws when storage does", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
    const m = sampleWeek(MORNING);
    saveHabits(storage, m);
    expect(store.has(HABITS_STORAGE_KEY)).toBe(true);
    expect(loadHabits(storage)).toEqual(m);
    clearSavedHabits(storage);
    expect(store.has(HABITS_STORAGE_KEY)).toBe(false);
    expect(loadHabits(storage)).toEqual(emptyHabits());

    expect(readHabits({ panel: { ok: { n: 2, at: 1 }, bad: { n: "2", at: 1 }, neg: { n: -1, at: 1 } }, start: "nope", sample: "yes" })).toEqual({
      ...emptyHabits(),
      panel: { ok: { n: 2, at: 1 } },
    });
    store.set(HABITS_STORAGE_KEY, "{not json");
    expect(loadHabits(storage)).toEqual(emptyHabits());

    const throwing = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(loadHabits(throwing)).toEqual(emptyHabits());
    expect(() => saveHabits(throwing, m)).not.toThrow();
    expect(() => clearSavedHabits(throwing)).not.toThrow();
    expect(loadHabits(null)).toEqual(emptyHabits());
  });
});

describe("the sample week", () => {
  it("is marked as sample data, has a habit from Inbox at every time of day, and adds to what was learned", () => {
    const m = sampleWeek(MORNING);
    expect(m.sample).toBe(true);
    expect(nextPanels(m, "inbox", "morning", MORNING)[0]?.to).toBe("calendar");
    expect(nextPanels(m, "inbox", "afternoon", MORNING)[0]?.to).toBe("invoices");
    expect(nextPanels(m, "inbox", "evening", MORNING)[0]?.to).toBe("tasks");
    expect(nextPanels(m, null, "morning", MORNING)[0]?.to).toBe("inbox");
    expect(nextGoals(m, "collect_payments", MORNING)[0]?.to).toBe("triage_inbox");
    const own = learn(moves("tasks", 1, MORNING)).memory;
    const merged = mergeHabits(own, m, MORNING);
    expect(merged.sample).toBe(true);
    expect(decayed(merged.panel["morning|inbox>tasks"], MORNING)).toBeCloseTo(1 + decayed(m.panel["morning|inbox>tasks"], MORNING), 10);
    // The Habits view: plain words, strength, and counts.
    const rows = describeHabits(m, MORNING);
    const calendar = rows.panel.rows.find((r) => r.text === "Calendar after Inbox, in the morning");
    expect(calendar).toMatchObject({ strength: "Almost always", habit: true, counts: "about 4 of 5 times" });
    // Habits first, strongest first; the weaker moves past HABIT_VIEW_MAX are counted, not listed.
    const shares = rows.panel.rows.map((r) => r.share);
    expect(rows.panel.rows.every((r) => r.habit)).toBe(true);
    expect(shares).toEqual([...shares].sort((a, b) => b - a));
    expect(rows.panel.more).toBeGreaterThan(0);
    expect(rows.panel.habits).toBe(8);
    expect(rows.action.rows.some((r) => r.text === "Sends a payment reminder after opening an invoice")).toBe(true);
    // A rare other move still counts in the total: Clients after Invoices four times, Inbox once.
    expect(rows.panel.rows.find((r) => r.text === "Clients after Invoices, in the afternoon")?.counts).toBe("about 4 of 5 times");
    expect(rows.start.rows.find((r) => r.text === "Starts in Invoices, in the afternoon")?.strength).toBe("Not a habit yet");
  });
});

// ---------------------------------------------------------------------------
// How code uses them
// ---------------------------------------------------------------------------

const NOW = MORNING;

/** The default layout, every panel added a moment ago, so the minimum stay keeps them all on the canvas whatever they score. */
const RECENT = { ...defaultPlan(), placements: defaultPlan().placements.map((p) => ({ ...p, addedAt: NOW - 1_000 })) };

function input(o: Partial<PolicyInput> = {}): PolicyInput {
  return {
    judgments: o.judgments ?? makeJudgments({ rel: { inbox: 2, calendar: 0.2, tasks: 0.4, invoices: 1, clients: 0.8, projects: 0.6 } }),
    version: 1,
    previous: o.previous ?? RECENT,
    events: o.events ?? [],
    now: NOW,
    weights: o.weights ?? { relevance: 0.5, usage: 0.25, goal: 0.25 },
    pinned: [],
    dismissed: {},
    focusedPanel: null,
    recentModes: [],
    ...(o.habit ? { habit: o.habit } : {}),
  };
}

const HINTS: HabitHints = { from: "inbox", bucket: "morning", next: { calendar: 0.8 } };

describe("the policy's habit part", () => {
  it("adds the habit weight times the chance, fills the breakdown, and says why when it is the strongest part", () => {
    const without = computePlan(input());
    const withHabit = computePlan(input({ habit: HINTS }));
    const cal = (plan: typeof without) => plan.placements.find((p) => p.id === "calendar");
    expect(cal(without)?.breakdown?.habit).toBeUndefined();
    expect(cal(withHabit)?.breakdown?.habit).toBeCloseTo(HABIT_WEIGHT * 0.8, 3);
    expect(cal(withHabit)!.priority).toBeCloseTo(cal(without)!.priority + HABIT_WEIGHT * 0.8, 3);
    expect(cal(withHabit)?.reason).toBe("You usually open Calendar after Inbox in the morning");
    // Other panels: a 0 part, and their priority and reason as before.
    const inv = (plan: typeof without) => plan.placements.find((p) => p.id === "invoices");
    expect(inv(withHabit)?.breakdown?.habit).toBe(0);
    expect(inv(withHabit)?.priority).toBe(inv(without)?.priority);
    expect(inv(withHabit)?.reason).toBe(inv(without)?.reason);
    // The evidence says so too.
    expect(withHabit.decisions.find((d) => d.panel === "calendar")?.evidence ?? "habit").toMatch(/habit/);
  });

  it("follows the habit slider, and keeps a stronger part's reason", () => {
    const zero = computePlan(input({ habit: HINTS, weights: { relevance: 0.5, usage: 0.25, goal: 0.25, habit: 0 } }));
    const cal = zero.placements.find((p) => p.id === "calendar");
    expect(cal?.breakdown?.habit).toBe(0);
    expect(cal?.reason).not.toMatch(/usually/);
    const big = computePlan(input({ habit: HINTS, weights: { relevance: 0.5, usage: 0.25, goal: 0.25, habit: 1 } }));
    expect(big.placements.find((p) => p.id === "calendar")?.breakdown?.habit).toBeCloseTo(0.8, 3);
    // Jev rates Invoices useful (relevance part 0.25); a small habit on it does not take its reason.
    const inv = computePlan(input({ habit: { ...HINTS, next: { invoices: 0.5 } } })).placements.find((p) => p.id === "invoices");
    expect(inv?.reason).toMatch(/^Jev rates it/);
  });
});

describe("the habit suggestion", () => {
  const live = { invoices: structuredClone(INVOICES), messages: structuredClone(MESSAGES), view: { inbox: { query: "", selectedId: null, client: null }, invoices: { status: "all", client: null, selectedId: "INV-1042" } } as unknown as PanelViewState };
  const habit: NonNullable<HabitHints["action"]> = { kind: "invoice", recordId: "INV-1042", client: "Harbor Coffee Co.", actionId: "send_payment_reminder", share: 0.8 };
  const unsure = makeJudgments({ nextAction: choiceJ<ActionId>("mark_invoice_paid", 0.3, { mark_invoice_paid: 0.3, none: 0.3, send_payment_reminder: 0.2 }) });

  it("is offered, subtle and marked, on the open record, when Jev is unsure of the next step", () => {
    const out = buildSuggestions(unsure, [], NOW, live, habit);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ actionId: "send_payment_reminder", prominence: "subtle", habit: true, args: { invoiceId: "INV-1042" }, reason: "You usually do this after opening an invoice" });
    // Without the habit: exactly as before.
    expect(buildSuggestions(unsure, [], NOW, live)).toEqual([]);
  });

  it("is never offered over Jev's own step, when Jev says nothing is next, or on another record", () => {
    const sure = makeJudgments({ nextAction: choiceJ<ActionId>("mark_invoice_paid", 0.8, { mark_invoice_paid: 0.8 }) });
    const withJev = buildSuggestions(sure, [], NOW, live, habit);
    expect(withJev.map((s) => [s.actionId, s.prominence, s.habit])).toEqual([["mark_invoice_paid", "primary", undefined]]);
    const nothing = makeJudgments({ nextAction: choiceJ<ActionId>("none", HABIT_SUGGEST_NONE_BELOW, { none: HABIT_SUGGEST_NONE_BELOW }) });
    expect(buildSuggestions(nothing, [], NOW, live, habit)).toEqual([]);
    // A paid invoice is open: the reminder would go to another invoice, so it is not offered.
    const paid = { ...live, invoices: live.invoices.map((i) => (i.id === "INV-1042" ? { ...i, status: "paid" as const } : i)) };
    expect(buildSuggestions(unsure, [], NOW, paid, habit)).toEqual([]);
    // Done on this record a moment ago: not again.
    const done = [e("action", NOW - 10_000, "invoices", { actionId: "send_payment_reminder", itemId: "INV-1042", client: "Harbor Coffee Co." })];
    expect(buildSuggestions(unsure, done, NOW, live, habit)).toEqual([]);
    // Done for another invoice: this one is still offered.
    const other = [e("action", NOW - 10_000, "invoices", { actionId: "send_payment_reminder", itemId: "INV-1038", client: "Meridian Hotels" })];
    expect(buildSuggestions(unsure, other, NOW, live, habit)).toHaveLength(1);
  });
});

describe("the Up next boost", () => {
  const data = (): AppData => ({
    invoices: structuredClone(INVOICES),
    messages: structuredClone(MESSAGES),
    tasks: structuredClone(TASKS),
    projects: structuredClone(PROJECTS),
    events: structuredClone(EVENTS),
    notes: "",
  });
  const view = {
    inbox: { query: "", selectedId: "m-1", client: null },
    invoices: { status: "all", client: null, selectedId: null },
    clients: { selected: null, query: "" },
    tasks: { showDone: false, client: null, selectedId: null },
    projects: { status: "all", selectedId: null },
    calendar: { range: "today", selectedId: null },
    analytics: { range: "this_year" },
    team: {},
    notes: {},
    help: {},
  } as PanelViewState;
  const events = [e("item_open", NOW - 5_000, "inbox", { itemKind: "message", itemId: "m-1", client: "Harbor Coffee Co." })];

  it("moves the usual next panel's records up a few places in code's order, never ahead of the list", () => {
    const base = { data: data(), view, anchor: null, links: null, events, now: NOW };
    const plain = buildRecordCandidates(base);
    const lifted = buildRecordCandidates({ ...base, habitPanel: "invoices" });
    const firstInvoice = (list: RecordCandidate[]) => list.findIndex((c) => c.panel === "invoices");
    const inList = plain.filter((c) => c.why === "next in the list").length;
    expect(inList).toBeGreaterThan(0);
    expect(firstInvoice(plain)).toBeGreaterThan(inList + UP_NEXT_HABIT_LIFT - 1);
    expect(firstInvoice(lifted)).toBe(firstInvoice(plain) - UP_NEXT_HABIT_LIFT);
    // The same records, the list still first.
    expect(lifted.map((c) => c.id).sort()).toEqual(plain.map((c) => c.id).sort());
    expect(lifted.slice(0, inList)).toEqual(plain.slice(0, inList));
  });

  it("orders near-tie chips toward the usual next panel; Jev's pick stays", () => {
    const c = (id: string, panel: PanelId): RecordCandidate => ({ id, kind: panel === "inbox" ? "message" : "invoice", panel, label: id });
    const candidates = [c("message:m-2", "inbox"), c("invoice:INV-1038", "invoices"), c("message:m-3", "inbox")];
    const nextRecord = choiceJ<string>("message:m-3", 0.6, { "message:m-3": 0.6, "message:m-2": 0.2, "invoice:INV-1038": 0.17 });
    const base = { candidates, nextRecord, judgedAt: NOW, lastActionAt: null, queue: false, current: null, listNext: [], dismissed: {}, now: NOW };
    const plain = chooseUpNext(base);
    const lifted = chooseUpNext({ ...base, habitPanel: "invoices" });
    expect(plain?.candidate.id).toBe("message:m-3");
    expect(lifted?.candidate.id).toBe("message:m-3");
    expect(plain?.alternatives.map((x) => x.id)).toEqual(["message:m-2", "invoice:INV-1038"]);
    expect(lifted?.alternatives.map((x) => x.id)).toEqual(["invoice:INV-1038", "message:m-2"]);
  });
});
