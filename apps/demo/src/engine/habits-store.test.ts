/**
 * Focus aid 3, "Learn my habits", in the store (docs/focus-aids.md, "Aid
 * 3"): the switch, learning from tracked events as they happen, the sample
 * week driving the habit part, reason, Up next order, subtle suggestion,
 * and the words Jev reads, the switch off giving exactly the older
 * requests and plans, Forget, and storage that throws. The API is mocked,
 * as in store.test.ts; the pure parts are in habits.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionId, GoalId, LayoutMode } from "../../shared/catalog.ts";
import { INVOICES } from "../../shared/fixtures.ts";
import { SCENARIOS } from "../../shared/scenarios.ts";
import type { AdaptRequest, AdaptResponse, Judgments, RecordCandidate } from "../../shared/types.ts";
import { postAdapt } from "./api.ts";
import { FOCUS_AID_TEXT } from "./focusAids.ts";
import { emptyHabits, HABIT_WEIGHT, HABITS_STORAGE_KEY } from "./habits.ts";
import { summarizeMetrics } from "./metrics.ts";
import { buildRecordCandidates } from "./nextUp.ts";
import { DEFAULT_SETTINGS, STORAGE_KEY, useEngine } from "./store.ts";
import { choiceJ, makeJudgments } from "./test-helpers.ts";

vi.mock("./api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.ts")>();
  return { ...actual, postAdapt: vi.fn(), getHealth: vi.fn(async () => ({ ok: true, jev: true })) };
});

const mockedPost = vi.mocked(postAdapt);
const engine = () => useEngine.getState();

function response(version: number, judgments: Judgments): AdaptResponse {
  return { version, source: "jev", judgments, meta: { model: "jev-1.13.0", latencyMs: 200, questionCount: 16 }, debug: { state: {}, questions: {} } };
}

/**
 * Working through the inbox: Jev rates Invoices barely useful (0.1 of the
 * scale, a relevance part of 0.05, under the 0.14 line that keeps a panel
 * on the canvas), and is unsure of the next step.
 */
const inboxWork = makeJudgments({
  rel: { inbox: 2, invoices: 0.2, calendar: 1.2, tasks: 1.2, clients: 1.2, projects: 1.2 },
  goal: choiceJ<GoalId>("triage_inbox", 0.9, { triage_inbox: 0.9, unclear: 0.1 }),
  layout: choiceJ<LayoutMode>("overview", 0.9, { overview: 0.9 }),
  nextAction: choiceJ<ActionId>("mark_invoice_paid", 0.3, { mark_invoice_paid: 0.3, none: 0.3, send_payment_reminder: 0.2 }),
});

/** What each request carried, and the candidates code would have built at that moment with and without the habit lift. */
let sent: { req: AdaptRequest; plain: RecordCandidate[]; lifted: RecordCandidate[] }[] = [];

function answer(j: Judgments) {
  mockedPost.mockImplementation(async (req: AdaptRequest) => {
    const s = engine();
    const base = { data: s.data, view: s.view, anchor: s.anchor, links: s.links, events: s.events, now: Date.now() };
    sent.push({ req, plain: buildRecordCandidates(base), lifted: buildRecordCandidates({ ...base, habitPanel: "invoices" }) });
    return response(req.version, j);
  });
}

/** An afternoon: the sample week's habit from Inbox is Invoices. A new day for every test. */
let day = 1;
const afternoon = () => new Date(2026, 9, day, 14, 0).getTime();

async function openMessage(id = "m-1", client = "Harbor Coffee Co.") {
  engine().setView("inbox", { selectedId: id });
  engine().track({ type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: id, client, label: id } });
  await vi.advanceTimersByTimeAsync(3_000);
}

const habitLines = (req: AdaptRequest) => req.snapshot.behavior_observations.filter((o) => o.startsWith("Usually "));

beforeEach(() => {
  vi.useFakeTimers();
  day += 1;
  vi.setSystemTime(afternoon());
  mockedPost.mockReset();
  sent = [];
  answer(inboxWork);
  engine().reset();
  engine().forgetHabits();
  engine().setSettings({ ...structuredClone(DEFAULT_SETTINGS) });
  for (const p of engine().pinned) engine().unpin(p);
  engine().reset();
});

afterEach(() => {
  engine().reset();
  engine().forgetHabits();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the switch", () => {
  it("is on by default, says the habits stay in this browser, and is saved with the settings", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
    expect(engine().settings.focusAids.habits).toBe(true);
    expect(FOCUS_AID_TEXT.habits.label).toBe("Learn my habits");
    expect(FOCUS_AID_TEXT.habits.description).toMatch(/stays in this browser/);
    engine().setFocusAid("habits", false);
    expect(JSON.parse(store.get(STORAGE_KEY) ?? "{}").settings.focusAids.habits).toBe(false);
    expect(engine().events.at(-1)).toMatchObject({ type: "setting_change", detail: { setting: "habits", enabled: false, label: "Learn my habits" } });
    // The habit weight has its default, and the slider is saved like the others.
    expect(engine().settings.weights.habit).toBe(HABIT_WEIGHT);
    engine().setWeights({ habit: 0.3 });
    expect(JSON.parse(store.get(STORAGE_KEY) ?? "{}").settings.weights.habit).toBe(0.3);
    expect(HABIT_WEIGHT).toBe(0.15);
  });
});

describe("learning", () => {
  it("learns from the user's own work as it happens, and saves it in this browser", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
    await openMessage();
    expect(Object.keys(engine().habits.start)).toEqual(["afternoon|inbox"]);
    engine().setView("invoices", { selectedId: "INV-1042" });
    engine().track({ type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co." } });
    engine().perform("send_payment_reminder", { invoiceId: "INV-1042", client: "Harbor Coffee Co." });
    expect(Object.keys(engine().habits.panel)).toEqual(["afternoon|inbox>invoices"]);
    expect(Object.keys(engine().habits.action)).toEqual(["invoice>send_payment_reminder"]);
    // Engine-made and cue-only signals, and looking around, teach nothing.
    const before = engine().habits;
    engine().setFocusAid("upNext", false);
    engine().track({ type: "panel_focus", panel: "calendar", detail: { via: "pointer" } });
    engine().track({ type: "panel_dwell", panel: "tasks", detail: { durationMs: 3_000 } });
    engine().clearLinks();
    expect(engine().habits).toBe(before);
    expect(JSON.parse(store.get(HABITS_STORAGE_KEY) ?? "{}").panel).toHaveProperty(["afternoon|inbox>invoices"]);
    // Reset starts a new session but keeps the habits.
    engine().reset();
    expect(engine().habits).toBe(before);
  });

  it("learns a goal move from a real switch and from Back to, and not with the switch off", async () => {
    const goal = (g: GoalId) => makeJudgments({ ...inboxWork, rel: { inbox: 2, invoices: 2 }, goal: choiceJ<GoalId>(g, 0.9, { [g]: 0.9 }) });
    const round = async (query: string) => {
      engine().track({ type: "search", panel: "invoices", detail: { query } });
      await vi.advanceTimersByTimeAsync(3_000);
    };
    answer(goal("collect_payments"));
    await round("overdue");
    expect(engine().working?.goal).toBe("collect_payments");
    answer(goal("triage_inbox"));
    await round("harbor");
    await round("kite");
    expect(engine().working?.goal).toBe("triage_inbox");
    expect(Object.keys(engine().habits.goal)).toEqual(["collect_payments>triage_inbox"]);
    // Back to the payments: a move the user chose.
    const back = engine().contexts.find((c) => c.goal === "collect_payments");
    engine().restoreContext(back!.id);
    expect(Object.keys(engine().habits.goal).sort()).toEqual(["collect_payments>triage_inbox", "triage_inbox>collect_payments"]);
    // Off: the same moves teach nothing.
    engine().setFocusAid("habits", false);
    const kept = engine().habits;
    answer(goal("plan_day"));
    await round("today");
    await round("tomorrow");
    expect(engine().working?.goal).toBe("plan_day");
    expect(engine().habits).toBe(kept);
  });

  it("learns nothing from a replayed scenario", async () => {
    const done = engine().replayScenario(SCENARIOS[0].id);
    await vi.advanceTimersByTimeAsync(120_000);
    await done;
    expect(engine().events.length).toBeGreaterThan(3);
    expect(engine().habits).toEqual(emptyHabits());
  });
});

describe("with the sample week", () => {
  it("gives the usual next panel its habit part and reason, keeps the clicked panel still, and adds at most two habits to the words Jev reads", async () => {
    engine().loadSampleHabits();
    expect(engine().habits.sample).toBe(true);
    engine().track({ type: "search", panel: "inbox", detail: { query: "harbor" } });
    await vi.advanceTimersByTimeAsync(3_000);
    const inboxCell = engine().plan.grid?.cells.inbox;
    await vi.advanceTimersByTimeAsync(3_000);
    await openMessage();
    const inv = engine().plan.placements.find((p) => p.id === "invoices");
    expect(inv?.breakdown?.habit).toBeGreaterThan(0.1);
    expect(inv?.breakdown?.habit).toBeLessThanOrEqual(HABIT_WEIGHT);
    expect(inv?.reason).toBe("You usually open Invoices after Inbox in the afternoon");
    // The clicked panel holds still.
    expect(engine().plan.grid?.cells.inbox).toEqual(inboxCell);
    // Jev reads at most two habits, phrased as habits.
    const req = sent.at(-1)!.req;
    const lines = habitLines(req);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines).toContain("Usually opens Invoices after Inbox in the afternoon");
    // Up next: code's candidate order has the usual next panel's records moved up.
    expect(req.candidates.records).toEqual(sent.at(-1)!.lifted);
    expect(req.candidates.records).not.toEqual(sent.at(-1)!.plain);
  });

  it("offers the usual action after opening an invoice as a subtle suggestion while Jev is unsure", async () => {
    engine().loadSampleHabits();
    engine().setView("invoices", { selectedId: "INV-1042" });
    engine().track({ type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co." } });
    await vi.advanceTimersByTimeAsync(3_000);
    const s = engine().plan.suggestions;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ actionId: "send_payment_reminder", prominence: "subtle", habit: true, args: { invoiceId: "INV-1042" } });
    // Never performed on its own.
    expect(engine().data.invoices.find((i) => i.id === "INV-1042")?.remindersSent).toBe(INVOICES.find((i) => i.id === "INV-1042")?.remindersSent);
    expect(engine().events.some((e) => e.type === "action")).toBe(false);
  });

  it("counts the habit's guesses in the Metrics tab", async () => {
    engine().loadSampleHabits();
    await openMessage();
    engine().track({ type: "filter", panel: "invoices", detail: { filter: { status: "overdue" } } });
    engine().track({ type: "filter", panel: "tasks", detail: { filter: { client: "all" } } });
    // Started in Inbox (right), then Invoices (right), then Tasks where Clients was the habit (wrong).
    expect(engine().metrics.habits).toEqual({ guessed: 3, right: 2 });
    expect(summarizeMetrics(engine().metrics, Date.now()).find((l) => l.id === "habit-guess")).toMatchObject({ label: "Habit guess right", value: "2 of 3 (67%)" });
  });
});

describe("the switch off", () => {
  /** Open m-1 and filter Invoices at the same moment, and return what Jev was sent and what the plan showed. */
  async function session() {
    vi.setSystemTime(afternoon() + 60 * 60_000);
    sent = [];
    await openMessage();
    const { req } = sent.at(-1)!;
    const plan = engine().plan.placements.map((p) => ({ id: p.id, size: p.size, reason: p.reason, priority: p.priority, breakdown: p.breakdown }));
    return { request: { snapshot: req.snapshot, candidates: req.candidates, workingGoal: req.workingGoal, link: req.link }, plan, suggestions: engine().plan.suggestions };
  }

  it("stops using the habits: the requests and the plan are exactly those with nothing learned, and it stops learning", async () => {
    const fresh = await session();
    expect(fresh.plan.every((p) => p.breakdown?.habit === undefined)).toBe(true);

    engine().reset();
    engine().loadSampleHabits();
    engine().setFocusAid("habits", false);
    const kept = engine().habits;
    const off = await session();
    expect(off.request).toEqual(fresh.request);
    expect(habitLines(sent.at(-1)!.req)).toEqual([]);
    expect(off.plan).toEqual(fresh.plan);
    expect(off.suggestions).toEqual(fresh.suggestions);
    // Nothing more is learned, but the saved habits stay until the user forgets them, and the guesses still count.
    engine().track({ type: "filter", panel: "invoices", detail: { filter: { status: "overdue" } } });
    expect(engine().habits).toBe(kept);
    expect(engine().metrics.habits.guessed).toBeGreaterThan(0);

    // On again: the habits are used at once.
    engine().setFocusAid("habits", true);
    engine().reset();
    const on = await session();
    expect(on.request).not.toEqual(fresh.request);
    expect(on.plan.find((p) => p.id === "invoices")?.breakdown?.habit).toBeGreaterThan(0);
  });
});

describe("forget", () => {
  it("clears the saved habits, the memory, the sample mark, and the guess count", async () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) } });
    engine().loadSampleHabits();
    expect(JSON.parse(store.get(HABITS_STORAGE_KEY) ?? "{}").sample).toBe(true);
    await openMessage();
    expect(engine().metrics.habits.guessed).toBeGreaterThan(0);
    engine().forgetHabits();
    expect(store.has(HABITS_STORAGE_KEY)).toBe(false);
    expect(engine().habits).toEqual(emptyHabits());
    expect(engine().metrics.habits).toEqual({ guessed: 0, right: 0 });
    // The settings and pins are not touched.
    expect(store.has(STORAGE_KEY)).toBe(false);
    // The next round plans without habits.
    engine().track({ type: "search", panel: "inbox", detail: { query: "kite" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().plan.placements.every((p) => p.breakdown?.habit === undefined)).toBe(true);
  });
});

describe("storage that throws", () => {
  it("still learns for this page, and the sample week and Forget never throw", async () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    });
    vi.resetModules();
    const mod = await import("./store.ts");
    const s = mod.useEngine.getState();
    expect(s.habits).toEqual(emptyHabits());
    s.track({ type: "search", panel: "inbox", detail: { query: "x" } });
    s.track({ type: "filter", panel: "invoices", detail: { filter: { status: "overdue" } } });
    expect(Object.keys(mod.useEngine.getState().habits.panel)).toHaveLength(1);
    expect(() => mod.useEngine.getState().loadSampleHabits()).not.toThrow();
    expect(mod.useEngine.getState().habits.sample).toBe(true);
    expect(() => mod.useEngine.getState().forgetHabits()).not.toThrow();
    expect(mod.useEngine.getState().habits).toEqual(emptyHabits());
    mod.useEngine.getState().reset();
  });
});
