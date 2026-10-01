/**
 * The focus aids in the store (docs/focus-aids.md): the settings home (one
 * flag per aid, persisted with the other settings, logged as a
 * setting_change that Jev never reads), the Up next and Back to switches,
 * and aid 1, "Fade panels that do not matter now". The API is mocked, as in
 * store.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalId, LayoutMode } from "../../shared/catalog.ts";
import type { AdaptRequest, AdaptResponse, Judgments } from "../../shared/types.ts";
import { postAdapt } from "./api.ts";
import { DEFAULT_FOCUS_AIDS, FOCUS_AID_IDS, FOCUS_AID_TEXT, readFocusAids } from "./focusAids.ts";
import { summarizeMetrics } from "./metrics.ts";
import { triggersRequest } from "./scheduler.ts";
import { buildSnapshot, describeEvent } from "./snapshot.ts";
import { DEFAULT_SETTINGS, loadPersisted, persist, STORAGE_KEY, useEngine } from "./store.ts";
import { choiceJ, ev, makeJudgments } from "./test-helpers.ts";
import { USAGE_WEIGHTS } from "./usage.ts";

vi.mock("./api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.ts")>();
  return { ...actual, postAdapt: vi.fn(), getHealth: vi.fn(async () => ({ ok: true, jev: true })) };
});

const mockedPost = vi.mocked(postAdapt);

function response(version: number, judgments: Judgments): AdaptResponse {
  return { version, source: "jev", judgments, meta: { model: "jev-1.13.0", latencyMs: 200, questionCount: 16 }, debug: { state: {}, questions: {} } };
}

function answerWith(j: Judgments) {
  mockedPost.mockImplementation(async (req: AdaptRequest) => response(req.version, j));
}

/**
 * Working through the inbox in the overview layout (every card standard).
 * Calendar and Tasks stay on the canvas for the goal, but Jev rates them low
 * (0.1 of the scale); Invoices, Clients, and Projects go to the dock.
 */
const inboxWork = makeJudgments({
  rel: { inbox: 2, calendar: 0.2, tasks: 0.2 },
  goal: choiceJ<GoalId>("triage_inbox", 0.9, { triage_inbox: 0.9, unclear: 0.1 }),
  layout: choiceJ<LayoutMode>("overview", 0.9, { overview: 0.9 }),
});

const engine = () => useEngine.getState();
const placement = (id: string) => engine().plan.placements.find((p) => p.id === id);

/** One round of work in the Inbox: a search that names no client, so nothing is linked. */
async function inboxRound(query: string) {
  engine().track({ type: "search", panel: "inbox", detail: { query } });
  await vi.advanceTimersByTimeAsync(3_000);
}

let clock = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  clock += 10_000_000;
  vi.setSystemTime(clock);
  mockedPost.mockReset();
  answerWith(inboxWork);
  engine().reset();
  // Habits outlive Reset (focus aid 3), so each test starts with none.
  engine().forgetHabits();
  engine().setSettings({ ...structuredClone(DEFAULT_SETTINGS) });
  for (const p of engine().pinned) engine().unpin(p);
  engine().reset();
});

afterEach(() => {
  // The pointer is the UI's to report; a test that put it on the canvas takes it away again.
  engine().setCanvasHold("pointer", false);
  engine().setPointer({ panel: null, down: false });
  engine().reset();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the settings home", () => {
  it("has one flag per aid, all on by default, each with a label and a one-line description", () => {
    expect(DEFAULT_FOCUS_AIDS).toEqual({ fadeQuiet: true, upNext: true, backTo: true, moveToFront: true, taskDone: true, arrangeLinks: true, habits: true, meetingPrep: true });
    expect(DEFAULT_SETTINGS.focusAids).toEqual(DEFAULT_FOCUS_AIDS);
    expect(engine().settings.focusAids).toEqual(DEFAULT_FOCUS_AIDS);
    expect(FOCUS_AID_IDS).toEqual(["fadeQuiet", "upNext", "backTo", "moveToFront", "taskDone", "arrangeLinks", "habits", "meetingPrep"]);
    for (const id of FOCUS_AID_IDS) {
      expect(FOCUS_AID_TEXT[id].label.length).toBeGreaterThan(0);
      expect(FOCUS_AID_TEXT[id].description).not.toMatch(/[\n–—]/);
    }
  });

  it("reads saved flags with safe defaults for older saves and bad values", () => {
    expect(readFocusAids(undefined)).toEqual(DEFAULT_FOCUS_AIDS);
    expect(readFocusAids("on")).toEqual(DEFAULT_FOCUS_AIDS);
    expect(readFocusAids({ fadeQuiet: false, upNext: "no", extra: true })).toEqual({ fadeQuiet: false, upNext: true, backTo: true, moveToFront: true, taskDone: true, arrangeLinks: true, habits: true, meetingPrep: true });
  });

  it("persists the flags under the settings key and loads them back, and older or broken saves get the defaults", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    });
    engine().setFocusAid("upNext", false);
    const saved = JSON.parse(store.get(STORAGE_KEY) ?? "{}") as { settings?: { focusAids?: unknown; linkLines?: unknown } };
    expect(saved.settings?.focusAids).toEqual({ fadeQuiet: true, upNext: false, backTo: true, moveToFront: true, taskDone: true, arrangeLinks: true, habits: true, meetingPrep: true });
    // The other settings are saved with them, as before.
    expect(saved.settings?.linkLines).toBe("stay");
    expect(loadPersisted().settings.focusAids).toEqual({ fadeQuiet: true, upNext: false, backTo: true, moveToFront: true, taskDone: true, arrangeLinks: true, habits: true, meetingPrep: true });

    // A save from before the focus aids.
    store.set(STORAGE_KEY, JSON.stringify({ settings: { adaptive: true, linkLines: "fade" }, pinned: ["inbox"] }));
    const older = loadPersisted();
    expect(older.settings.focusAids).toEqual(DEFAULT_FOCUS_AIDS);
    expect(older.settings.linkLines).toBe("fade");
    expect(older.pinned).toEqual(["inbox"]);
    // Broken values and unreadable JSON.
    store.set(STORAGE_KEY, JSON.stringify({ settings: { focusAids: { fadeQuiet: "off", backTo: false } } }));
    expect(loadPersisted().settings.focusAids).toEqual({ fadeQuiet: true, upNext: true, backTo: false, moveToFront: true, taskDone: true, arrangeLinks: true, habits: true, meetingPrep: true });
    store.set(STORAGE_KEY, "{not json");
    expect(loadPersisted().settings.focusAids).toEqual(DEFAULT_FOCUS_AIDS);
    // Blocked storage never throws.
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(() => persist(engine().settings, [], [])).not.toThrow();
    expect(loadPersisted().settings.focusAids).toEqual(DEFAULT_FOCUS_AIDS);
  });

  it("logs each switch as a setting_change for the Signals tab that never asks Jev and stays out of what Jev reads", async () => {
    await inboxRound("reply");
    const calls = mockedPost.mock.calls.length;
    engine().setFocusAid("backTo", false, "keyboard");
    expect(engine().settings.focusAids.backTo).toBe(false);
    const e = engine().events.at(-1);
    expect(e).toMatchObject({ type: "setting_change", detail: { setting: "backTo", enabled: false, label: "Back to", via: "keyboard" } });
    expect(e?.text).toBe('Turned off "Back to", using the keyboard');
    expect(describeEvent({ type: "setting_change", detail: { setting: "fadeQuiet", enabled: true, label: FOCUS_AID_TEXT.fadeQuiet.label } })).toBe(
      'Turned on "Fade panels that do not matter now"',
    );
    // The same value again is not a change.
    engine().setFocusAid("backTo", false);
    expect(engine().events.filter((x) => x.type === "setting_change")).toHaveLength(1);
    // Not a trigger, no recent use, and no request after the debounce.
    expect(triggersRequest("setting_change", false)).toBe(false);
    expect(USAGE_WEIGHTS.setting_change).toBe(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockedPost.mock.calls.length).toBe(calls);
    // Out of the snapshot: the next request does not mention it.
    const snap = buildSnapshot(engine().events, { now: Date.now(), focusedPanel: "inbox", visiblePanels: ["inbox"] });
    expect(snap.recent_activity.some((l) => l.includes("Turned"))).toBe(false);
    await inboxRound("invoice question");
    const sent = mockedPost.mock.calls.at(-1)?.[0].snapshot;
    expect(JSON.stringify(sent)).not.toContain("Turned off");
    // The Metrics tab does not count it as the user's work.
    expect(summarizeMetrics(engine().metrics, Date.now()).find((l) => l.id === "effort")?.value).toBe("2 so far, no actions yet");
  });

  it("keeps the event out of the snapshot even on its own", () => {
    const events = [ev("search", 100, "inbox", { query: "reply" }), ev("setting_change", 200, undefined, { setting: "upNext", enabled: false, label: "Up next" })];
    const snap = buildSnapshot(events, { now: 300, focusedPanel: "inbox", visiblePanels: ["inbox"] });
    expect(snap.recent_activity).toEqual(['Searched Inbox for "reply"']);
  });
});

describe("the Move pinned and bigger panels to the front switch", () => {
  it("is on by default, is saved with the other settings, and switching it is logged without asking Jev or moving a panel", async () => {
    expect(engine().settings.focusAids.moveToFront).toBe(true);
    expect(FOCUS_AID_TEXT.moveToFront).toEqual({
      label: "Move pinned and bigger panels to the front",
      description: "A panel you pin or make bigger goes to the top left, the newest first. Off: it stays where it is.",
    });
    const store = new Map<string, string>();
    vi.stubGlobal("window", { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } });
    await inboxRound("reply");
    const calls = mockedPost.mock.calls.length;
    const plan = engine().plan;
    engine().setFocusAid("moveToFront", false, "keyboard");
    expect(JSON.parse(store.get(STORAGE_KEY) ?? "{}").settings.focusAids.moveToFront).toBe(false);
    expect(loadPersisted().settings.focusAids.moveToFront).toBe(false);
    expect(engine().events.at(-1)?.text).toBe('Turned off "Move pinned and bigger panels to the front", using the keyboard');
    // Nothing moves until the next pin, "Make bigger", or round.
    expect(engine().plan).toBe(plan);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockedPost.mock.calls.length).toBe(calls);
  });
});

describe("the Up next and Back to switches", () => {
  const payments = makeJudgments({
    rel: { invoices: 2, clients: 1.4, inbox: 1.2, calendar: 0.8, tasks: 0.8 },
    goal: choiceJ<GoalId>("collect_payments", 0.9, { collect_payments: 0.9, unclear: 0.1 }),
    layout: choiceJ<LayoutMode>("focus", 0.9, { focus: 0.9 }),
  });

  it("Up next off hides the card, and opening it (the n key's action) does nothing, without touching the rest", async () => {
    answerWith({ ...payments, nextRecord: choiceJ<string>("invoice:INV-1047", 0.8, { "invoice:INV-1047": 0.8, none: 0.05 }) });
    engine().setView("invoices", { selectedId: "INV-1042" });
    engine().track({ type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co.", label: "INV-1042", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(800);
    expect(engine().upNext?.candidate.id).toBe("invoice:INV-1047");
    const plan = engine().plan;

    engine().setFocusAid("upNext", false);
    expect(engine().upNext).toBeNull();
    expect(engine().upNextDone).toBeNull();
    const before = engine().events.length;
    engine().openUpNext("invoice:INV-1047", "keyboard");
    expect(engine().events.length).toBe(before);
    expect(engine().view.invoices.selectedId).toBe("INV-1042");
    // The layout did not change, and a later round does not bring the card back.
    expect(engine().plan.placements.map((p) => [p.id, p.size])).toEqual(plan.placements.map((p) => [p.id, p.size]));
    engine().track({ type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1038", client: "Meridian Hotels", label: "INV-1038", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().upNext).toBeNull();

    engine().setFocusAid("upNext", true);
    expect(engine().upNext?.candidate.id).toBe("invoice:INV-1047");
  });

  it("Back to off saves no context and cannot restore one, and the working goal is still followed", async () => {
    const planDay = makeJudgments({
      rel: { calendar: 2, tasks: 1.8, team: 1.2, inbox: 0.6 },
      goal: choiceJ<GoalId>("plan_day", 0.85, { plan_day: 0.85, collect_payments: 0.1 }),
      layout: choiceJ<LayoutMode>("overview", 0.9, { overview: 0.9 }),
    });
    answerWith(payments);
    engine().track({ type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co.", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().working?.goal).toBe("collect_payments");
    engine().setFocusAid("backTo", false);

    answerWith(planDay);
    engine().track({ type: "item_open", panel: "calendar", detail: { itemKind: "event", itemId: "e-4", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    engine().track({ type: "item_open", panel: "tasks", detail: { itemKind: "task", itemId: "t-6", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().working?.goal).toBe("plan_day");
    expect(engine().contexts).toEqual([]);
    expect(engine().events.some((e) => e.type === "context_save")).toBe(false);

    // Switched on again, the next switch saves as before, and a saved context cannot be restored while it is off.
    engine().setFocusAid("backTo", true);
    answerWith(payments);
    engine().track({ type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1038", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    engine().track({ type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1047", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().contexts).toHaveLength(1);
    const id = engine().contexts[0].id;
    engine().setFocusAid("backTo", false);
    const plan = engine().plan;
    engine().restoreContext(id, "keyboard");
    expect(engine().plan).toBe(plan);
    expect(engine().events.some((e) => e.type === "context_restore")).toBe(false);
  });
});

describe("aid 1: fade panels that do not matter now", () => {
  it("fades and shrinks the panels Jev rates low for two rounds, and the panel the user works in holds still", async () => {
    await inboxRound("reply");
    const inboxCell = engine().plan.grid?.cells.inbox;
    expect(inboxCell).toMatchObject({ col: 0, row: 0 });
    // One low round is not enough.
    expect(engine().plan.placements.some((p) => p.quiet)).toBe(false);
    expect(placement("calendar")).toMatchObject({ size: "standard" });

    await inboxRound("reply to Priya");
    expect(mockedPost).toHaveBeenCalledTimes(2);
    for (const id of ["calendar", "tasks"]) {
      expect(placement(id)).toMatchObject({ quiet: true, size: "compact", unquietSize: "standard", reason: "Not needed for Working through the inbox right now" });
    }
    // The panel the user works in is never quiet and never moves.
    expect(placement("inbox")?.quiet).toBeUndefined();
    expect(engine().plan.grid?.cells.inbox).toEqual(inboxCell);
    expect(engine().metrics.quiet).toEqual({ went: 2, reopened: 0 });
    expect(summarizeMetrics(engine().metrics, Date.now(), { quietNow: 2 }).find((l) => l.id === "quiet")).toMatchObject({ label: "Quiet panels", value: "2 now" });
  });

  it("keeps a quiet panel quiet on hover and keyboard focus; clicking into it brings it back at once and counts a reopen", async () => {
    await inboxRound("reply");
    await inboxRound("reply to Priya");
    const cell = engine().plan.grid?.cells.calendar;
    // The pointer over it, then a re-plan (here a weight change): hover never changes the layout.
    engine().setPointer({ panel: "calendar", down: false });
    engine().setWeights({ goal: 0.27 });
    expect(placement("calendar")).toMatchObject({ quiet: true, size: "compact" });
    engine().track({ type: "panel_dwell", panel: "calendar", detail: { durationMs: 3_000 } });
    engine().track({ type: "panel_focus", panel: "calendar", detail: { via: "keyboard" } });
    engine().setWeights({ goal: 0.26 });
    expect(placement("calendar")).toMatchObject({ quiet: true, size: "compact" });
    expect(engine().metrics.quiet.reopened).toBe(0);

    engine().track({ type: "panel_focus", panel: "calendar", detail: { via: "pointer" } });
    // Brought back by the edit, and the policy's catch-up (the change interval had passed) agrees.
    expect(placement("calendar")).toMatchObject({ size: "standard" });
    expect(placement("calendar")?.reason).not.toMatch(/^Not needed/);
    expect(placement("calendar")?.quiet).toBeUndefined();
    // Its top-left stays; it grows down, as "Make bigger" does.
    expect(engine().plan.grid?.cells.calendar).toMatchObject({ col: cell?.col, row: cell?.row });
    expect(engine().metrics.quiet.reopened).toBe(1);
    engine().track({ type: "panel_focus", panel: "tasks", detail: { via: "pointer" } });
    // At once, as a manual edit (a catch-up that agrees lands quietly with the policy's own reason).
    expect(placement("tasks")).toMatchObject({ size: "standard" });
    expect(placement("tasks")?.reason).not.toMatch(/^Not needed/);
    expect(placement("tasks")?.quiet).toBeUndefined();
    expect(engine().metrics.quiet.reopened).toBe(2);
    // The next rounds do not fade them again right away: they were used in the last minute.
    await inboxRound("reply to Zoe");
    await inboxRound("reply to Zoe again");
    expect(placement("calendar")?.quiet).toBeUndefined();
    expect(placement("tasks")?.quiet).toBeUndefined();
  });

  it("with the pointer on the canvas, the click brings the panel back at once and the policy waits", async () => {
    await inboxRound("reply");
    await inboxRound("reply to Priya");
    const inboxCell = engine().plan.grid?.cells.inbox;
    const calendarCell = engine().plan.grid?.cells.calendar;
    engine().setCanvasHold("pointer", true);
    engine().setPointer({ panel: "calendar", down: true });
    // As PanelFrame does it: the focus first, then the signal.
    engine().setFocused("calendar");
    engine().track({ type: "panel_focus", panel: "calendar", detail: { via: "pointer" } });
    expect(placement("calendar")).toMatchObject({ size: "standard", reason: "Brought back by you" });
    expect(engine().plan.grid?.cells.calendar).toMatchObject({ col: calendarCell?.col, row: calendarCell?.row, h: 2 });
    expect(engine().plan.grid?.cells.inbox).toEqual(inboxCell);
    expect(engine().metrics.quiet.reopened).toBe(1);
    // Tasks is still quiet: only the card the user chose came back.
    expect(placement("tasks")?.quiet).toBe(true);
  });

  it("after an Undo of the round that quieted them, starts their count over", async () => {
    await inboxRound("reply");
    await inboxRound("reply to Priya");
    expect(placement("calendar")?.quiet).toBe(true);
    engine().undo();
    expect(placement("calendar")?.quiet).toBeUndefined();
    await vi.advanceTimersByTimeAsync(16_000);
    await inboxRound("reply to Zoe");
    expect(placement("calendar")?.quiet).toBeUndefined();
    expect(placement("calendar")?.size).toBe("standard");
  });

  it("never fades a pinned panel", async () => {
    engine().pin("tasks");
    await inboxRound("reply");
    await inboxRound("reply to Priya");
    expect(placement("calendar")?.quiet).toBe(true);
    expect(placement("tasks")?.quiet).toBeUndefined();
    expect(placement("tasks")?.size).not.toBe("compact");
  });

  it("switched off, puts back the layout without quiet panels at once, and with it off low rounds change nothing", async () => {
    await inboxRound("reply");
    await inboxRound("reply to Priya");
    expect(placement("calendar")?.quiet).toBe(true);
    const calls = mockedPost.mock.calls.length;
    engine().setFocusAid("fadeQuiet", false);
    expect(engine().plan.placements.some((p) => p.quiet || p.unquietSize)).toBe(false);
    expect(placement("calendar")).toMatchObject({ size: "standard" });
    expect(placement("tasks")).toMatchObject({ size: "standard" });
    expect(engine().events.at(-1)?.text).toBe('Turned off "Fade panels that do not matter now"');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockedPost.mock.calls.length).toBe(calls);

    await inboxRound("reply to Zoe");
    await inboxRound("reply to Zoe again");
    expect(engine().plan.placements.some((p) => p.quiet)).toBe(false);
    expect(placement("calendar")).toMatchObject({ size: "standard" });
    expect(summarizeMetrics(engine().metrics, Date.now(), { quietNow: null }).find((l) => l.id === "quiet")?.value).toBe("off");
  });

  it("with the aid off from the start, plans exactly as without it", async () => {
    engine().setFocusAid("fadeQuiet", false);
    await inboxRound("reply");
    await inboxRound("reply to Priya");
    const off = engine().plan.placements.map((p) => [p.id, p.size, p.reason]);
    expect(engine().plan.placements.some((p) => p.quiet)).toBe(false);
    expect(off).toEqual(expect.arrayContaining([["calendar", "standard", expect.any(String)]]));
  });
});
