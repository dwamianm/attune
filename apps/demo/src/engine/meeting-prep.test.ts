/**
 * Focus aid 4, "Prepare for meetings", in the store: the chip offers a
 * meeting once it is within the lead time (rechecked on a timer, logged once
 * as prep_offer, ranked ahead of time by /api/prep); Prepare saves a Back to
 * context, anchors Calendar on the meeting, filters the client's panels, and
 * links them in Jev's order with "For the meeting" tags, without performing
 * anything or touching the notes; "Start meeting notes" writes only when
 * pressed; Not now, the simulated meeting, the records opened from the prep
 * view, and the switch off. The API is mocked, as in store.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalId, LayoutMode, PanelId } from "../../shared/catalog.ts";
import { EVENTS } from "../../shared/fixtures.ts";
import type { AdaptRequest, AdaptResponse, GridCell, Judgments, PrepRequest, PrepResponse } from "../../shared/types.ts";
import { postAdapt, postPrep } from "./api.ts";
import { backToList } from "./contexts.ts";
import { PREP_RECHECK_MS, PREP_TAG } from "./meetingPrep.ts";
import { SIZE_RANK } from "@attuneui/core";
import { triggersRequest } from "./scheduler.ts";
import { buildSnapshot } from "./snapshot.ts";
import { DEFAULT_SETTINGS, useEngine } from "./store.ts";
import { choiceJ, makeJudgments, scoreJ } from "./test-helpers.ts";
import { USAGE_WEIGHTS } from "./usage.ts";

vi.mock("./api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.ts")>();
  return { ...actual, postAdapt: vi.fn(), postPrep: vi.fn(), getHealth: vi.fn(async () => ({ ok: true, jev: true })) };
});

const mockedPost = vi.mocked(postAdapt);
const mockedPrep = vi.mocked(postPrep);

function response(version: number, judgments: Judgments): AdaptResponse {
  return { version, source: "jev", judgments, meta: { model: "jev-1.13.0", latencyMs: 200, questionCount: 18 }, debug: { state: {}, questions: {} } };
}

const payments = makeJudgments({
  rel: { invoices: 2, clients: 1.4, inbox: 1.2, calendar: 0.8, tasks: 0.8, projects: 0.6 },
  goal: choiceJ<GoalId>("collect_payments", 0.9, { collect_payments: 0.9, unclear: 0.1 }),
  layout: choiceJ<LayoutMode>("overview", 0.9, { overview: 0.9 }),
});

/** Jev's ranking for the Harbor meeting: Priya's message first, then the bill, the to-do, and the project under the tint line. */
const HARBOR_SHARES: Record<string, number> = { "message:m-1": 1, "invoice:INV-1042": 0.9, "task:t-1": 0.6, "project:p-harbor": 0.4 };

function prepResponse(req: PrepRequest, shares: Record<string, number>, urgent: number): PrepResponse {
  return {
    version: req.version,
    source: "jev",
    judgments: { scores: Object.fromEntries(req.records.map((r) => [r.id, scoreJ((shares[r.id] ?? 0.5) * 2, 2)])), anythingUrgent: urgent },
    meta: { model: "jev-1.13.0", latencyMs: 150, questionCount: req.records.length + 1 },
    debug: { state: {}, questions: {} },
  };
}

function prepWith(shares: Record<string, number>, urgent: number) {
  mockedPrep.mockImplementation(async (req: PrepRequest) => prepResponse(req, shares, urgent));
}

const engine = () => useEngine.getState();
const harbor = EVENTS.find((e) => e.id === "e-2")!;
const HARBOR_START = Date.parse(harbor.start);
const MIN = 60_000;

/** The clock this many minutes before the Harbor rebrand review, on the fixtures' own day. */
function clockAt(minutesBefore: number): void {
  vi.setSystemTime(HARBOR_START - minutesBefore * MIN);
}

/** Let the store's recheck timer fire once. */
async function recheck(): Promise<void> {
  await vi.advanceTimersByTimeAsync(PREP_RECHECK_MS);
}

/** Let a mocked answer land. */
async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function cell(id: PanelId): GridCell | undefined {
  return engine().plan.grid?.cells[id];
}

/** Two cells touch (share an edge or a corner gap of zero). */
function touching(a: GridCell, b: GridCell): boolean {
  const gapX = Math.max(0, b.col - (a.col + a.w), a.col - (b.col + b.w));
  const gapY = Math.max(0, b.row - (a.row + a.h), a.row - (b.row + b.h));
  return gapX + gapY === 0;
}

/** Filter Invoices to overdue: a Jev round adopts collecting payments as the working goal. */
async function startCollecting() {
  engine().track({ type: "filter", panel: "invoices", detail: { filter: { status: "overdue" }, via: "pointer" } });
  await vi.advanceTimersByTimeAsync(3_000);
  expect(engine().working?.goal).toBe("collect_payments");
}

/** Twelve minutes before the meeting: the chip offers it and its ranking has landed. */
async function offered() {
  clockAt(12.5);
  await recheck();
  await flush();
  expect(engine().prep).toMatchObject({ stage: "offer", eventId: "e-2" });
}

beforeEach(() => {
  vi.useFakeTimers();
  clockAt(40);
  mockedPost.mockReset();
  mockedPost.mockImplementation(async (req: AdaptRequest) => response(req.version, payments));
  mockedPrep.mockReset();
  prepWith(HARBOR_SHARES, 0.91);
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

describe("the prep chip", () => {
  it("offers the meeting once it is within the lead time, asks /api/prep ahead, and logs the offer once, out of what Jev reads", async () => {
    clockAt(17);
    await recheck();
    expect(engine().prep).toBeNull();
    expect(mockedPrep).not.toHaveBeenCalled();
    clockAt(15.2);
    await recheck();
    expect(engine().prep).toMatchObject({ stage: "offer", eventId: "e-2", title: "Harbor rebrand review", client: "Harbor Coffee Co.", kind: "meeting", start: harbor.start });
    const req = mockedPrep.mock.calls[0][0];
    expect(req.meeting).toEqual({ title: "Harbor rebrand review", client: "Harbor Coffee Co.", time: "starts in 15 minutes, at 11:00 today", kind: "meeting" });
    expect(req.records.map((r) => r.id)).toEqual(["invoice:INV-1042", "message:m-1", "task:t-1", "project:p-harbor"]);
    await flush();
    expect(engine().prep?.ranking).toMatchObject({ source: "jev", urgent: 0.91 });
    expect(engine().prep?.urgent).toEqual({ count: 1, text: "1 thing to handle first: INV-1042 is 14 days overdue", record: "invoice:INV-1042" });
    await recheck();
    await recheck();
    // Announced once, as the engine's own note that Jev never reads, and ranked once while the records stay the same.
    const offers = engine().events.filter((e) => e.type === "prep_offer");
    expect(offers).toHaveLength(1);
    expect(offers[0].text).toBe("Offered to prepare for Harbor rebrand review, 11:00 today");
    const snap = buildSnapshot(engine().events, { now: Date.now(), focusedPanel: null, visiblePanels: ["calendar"] });
    expect(snap.recent_activity.join(" ")).not.toMatch(/prepare/i);
    expect(triggersRequest("prep_offer", false)).toBe(false);
    expect(USAGE_WEIGHTS.prep_offer).toBe(0);
    expect(mockedPrep).toHaveBeenCalledTimes(1);
    expect(mockedPost).not.toHaveBeenCalled();
    expect(engine().metrics.prep).toEqual({ offered: 1, prepared: 0, opened: 0 });
  });

  it("follows the lead time setting", async () => {
    engine().setSettings({ prepLeadMin: 5 });
    clockAt(12);
    await recheck();
    expect(engine().prep).toBeNull();
    engine().setSettings({ prepLeadMin: 30 });
    expect(engine().prep?.eventId).toBe("e-2");
  });

  it("Not now hides it for that meeting for the session, and another meeting still shows", async () => {
    await offered();
    engine().snoozePrep();
    expect(engine().prep).toBeNull();
    await recheck();
    await recheck();
    expect(engine().prep).toBeNull();
    expect(engine().events.filter((e) => e.type === "prep_offer")).toHaveLength(1);
    engine().simulateMeeting();
    expect(engine().prep).toMatchObject({ stage: "offer", title: "Harbor rebrand check-in" });
    expect(engine().prep?.eventId.startsWith("e-sim-")).toBe(true);
  });

  it("goes once the meeting is more than five minutes in", async () => {
    await offered();
    clockAt(-5.2);
    await recheck();
    expect(engine().prep).toBeNull();
  });
});

describe("Prepare", () => {
  it("saves the work as a Back to chip and arranges the prep view: Calendar anchored and still, the client's panels linked in Jev's order, nothing performed", async () => {
    clockAt(13);
    await startCollecting();
    await recheck();
    await flush();
    expect(engine().prep?.stage).toBe("offer");
    const calendar = cell("calendar")!;
    const data = structuredClone(engine().data);
    const adaptCalls = mockedPost.mock.calls.length;

    engine().prepareMeeting("keyboard");

    // The work being left is a Back to chip, even though the new work is one client's.
    const saved = engine().contexts[0];
    expect(saved).toMatchObject({ goal: "collect_payments" });
    expect(engine().working).toMatchObject({ goal: "manage_client", client: "Harbor Coffee Co." });
    expect(backToList(engine().contexts, engine().working!.goal, engine().working!.client).map((c) => c.id)).toEqual([saved.id]);
    // Calendar is the anchor, with the meeting selected, and it did not move.
    expect(engine().anchor).toMatchObject({ panel: "calendar", itemKind: "event", itemId: "e-2", client: "Harbor Coffee Co.", source: "work" });
    expect(engine().view.calendar.selectedId).toBe("e-2");
    expect(cell("calendar")).toMatchObject({ col: calendar.col, row: calendar.row });
    // The client's records, filtered the way the user would.
    expect(engine().view.inbox).toMatchObject({ client: "Harbor Coffee Co.", query: "" });
    expect(engine().view.invoices).toMatchObject({ client: "Harbor Coffee Co.", status: "unpaid" });
    expect(engine().view.tasks).toMatchObject({ client: "Harbor Coffee Co.", showDone: false });
    // Linked in Jev's order by each panel's best record, Clients at its fixed score, tagged "For the meeting".
    const links = engine().links!;
    expect(links.prep).toEqual({ eventId: "e-2" });
    expect(links.source).toMatchObject({ panel: "calendar", itemId: "e-2" });
    expect(engine().prep?.panels).toEqual(["inbox", "invoices", "tasks", "clients", "projects"]);
    for (const id of engine().prep!.panels!) expect(links.relations[id]?.tag).toBe(PREP_TAG);
    expect(links.relations.inbox?.records.map((r) => r.itemId)).toEqual(["m-1"]);
    expect(links.relations.invoices?.records.map((r) => r.itemId)).toEqual(["INV-1042"]);
    expect(links.relations.clients?.records.map((r) => r.itemId)).toEqual(["c-harbor"]);
    // The most useful panel gathers right next to Calendar.
    expect(touching(cell("inbox")!, cell("calendar")!)).toBe(true);
    for (const id of engine().prep!.panels!) expect(SIZE_RANK[engine().plan.placements.find((p) => p.id === id)!.size]).toBeGreaterThanOrEqual(SIZE_RANK.standard);
    expect(engine().plan.decisions.some((d) => d.text === "Prepared for Harbor rebrand review")).toBe(true);
    // The card says so, with the thing to handle first.
    expect(engine().prep).toMatchObject({ stage: "ready", urgent: { count: 1, text: "1 thing to handle first: INV-1042 is 14 days overdue" } });
    // Nothing performed, and the notes untouched.
    expect(engine().data).toEqual(data);
    // Logged as the user's own step: Jev reads it, but it asks no round by itself (the view holds until new work).
    const start = engine().events.filter((e) => e.type === "prep_start");
    expect(start).toHaveLength(1);
    expect(start[0].text).toBe("Started preparing for calendar event Harbor rebrand review, 11:00 today in Calendar, using the keyboard");
    expect(triggersRequest("prep_start", false)).toBe(false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockedPost.mock.calls.length).toBe(adaptCalls);
    expect(engine().metrics.prep).toMatchObject({ offered: 1, prepared: 1 });
    // "Start meeting notes" is offered, and only offered.
    expect(engine().plan.suggestions.find((s) => s.meetingNotes)).toMatchObject({ label: "Start meeting notes", prominence: "subtle", actionId: "write_note" });
    // The meeting is not offered again.
    await recheck();
    expect(engine().prep?.stage).toBe("ready");
    expect(engine().events.filter((e) => e.type === "prep_offer")).toHaveLength(1);
  });

  it("opens a docked Calendar first, and takes a ranking that lands later at once", async () => {
    let answer: ((r: PrepResponse) => void) | null = null;
    mockedPrep.mockImplementation((req: PrepRequest) => new Promise<PrepResponse>((resolve) => (answer = (r) => resolve(r ?? prepResponse(req, HARBOR_SHARES, 0.91)))));
    clockAt(12.5);
    await recheck();
    engine().dismiss("calendar");
    expect(engine().plan.placements.some((p) => p.id === "calendar")).toBe(false);
    engine().prepareMeeting("pointer");
    expect(engine().plan.placements.some((p) => p.id === "calendar")).toBe(true);
    // No answer yet: code's order, the records with an action due first.
    expect(engine().prep?.panels).toEqual(["invoices", "inbox", "tasks", "projects", "clients"]);
    expect(engine().prep?.urgent).toBeUndefined();
    const req = mockedPrep.mock.calls[0][0];
    answer!(prepResponse(req, HARBOR_SHARES, 0.91));
    await flush();
    expect(engine().prep?.panels).toEqual(["inbox", "invoices", "tasks", "clients", "projects"]);
    expect(engine().prep?.urgent?.count).toBe(1);
    expect(engine().links?.relations.inbox?.records.map((r) => r.itemId)).toEqual(["m-1"]);
  });

  it("writes the meeting notes heading and opens Notes only when the user presses Start meeting notes", async () => {
    await offered();
    engine().setNotes("Call Priya");
    engine().prepareMeeting("pointer");
    expect(engine().data.notes).toBe("Call Priya");
    const notes = engine().plan.suggestions.find((s) => s.meetingNotes)!;
    expect(notes.meetingNotes).toEqual({ eventId: "e-2", heading: "Harbor rebrand review, 11:00, notes:" });
    engine().acceptSuggestion(notes);
    expect(engine().data.notes).toBe("Call Priya\n\nHarbor rebrand review, 11:00, notes:\n");
    const panel = engine().plan.placements.find((p) => p.id === "notes");
    expect(panel).toBeDefined();
    expect(SIZE_RANK[panel!.size]).toBeGreaterThanOrEqual(SIZE_RANK.standard);
    expect(engine().plan.suggestions.some((s) => s.meetingNotes)).toBe(false);
    expect(engine().prep?.notesStarted).toBe(true);
    const action = engine().events.findLast((e) => e.type === "action");
    expect(action?.detail).toMatchObject({ actionId: "write_note", via: "suggestion" });
  });

  it("does not offer the notes again once dismissed", async () => {
    await offered();
    engine().prepareMeeting("pointer");
    engine().dismissSuggestion(engine().plan.suggestions.find((s) => s.meetingNotes)!);
    engine().track({ type: "panel_dwell", panel: "tasks", detail: { durationMs: 2_000 } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().plan.suggestions.some((s) => s.meetingNotes)).toBe(false);
    expect(engine().data.notes).toBe("");
  });

  it("Back to returns to the work as it was", async () => {
    clockAt(13);
    await startCollecting();
    await recheck();
    await flush();
    const before = { view: structuredClone(engine().view), cells: structuredClone(engine().plan.grid?.cells) };
    engine().prepareMeeting("pointer");
    engine().restoreContext(engine().contexts[0].id, "keyboard");
    expect(engine().view.invoices).toEqual(before.view.invoices);
    expect(engine().view.inbox).toEqual(before.view.inbox);
    expect(engine().plan.grid?.cells).toEqual(before.cells);
    expect(engine().links).toBeNull();
    expect(engine().working?.goal).toBe("collect_payments");
  });

  it("keeps the prep view's links while the user opens its records, and counts each record once", async () => {
    await offered();
    engine().prepareMeeting("pointer");
    engine().setView("inbox", { selectedId: "m-1" });
    engine().track({ type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-1", client: "Harbor Coffee Co.", label: "m-1", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().metrics.prep.opened).toBe(1);
    expect(engine().links?.prep).toEqual({ eventId: "e-2" });
    engine().track({ type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-1", client: "Harbor Coffee Co.", label: "m-1", via: "pointer" } });
    engine().track({ type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co.", label: "INV-1042", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().metrics.prep.opened).toBe(2);
    expect(engine().links?.prep).toEqual({ eventId: "e-2" });
    // Work for another client is new work: its own links replace the prep view's.
    engine().track({ type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1047", client: "Kite & Co.", label: "INV-1047", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().links?.prep).toBeUndefined();
    expect(engine().metrics.prep.opened).toBe(2);
  });

  it("closes the card, keeping the panels as they are", async () => {
    await offered();
    engine().prepareMeeting("pointer");
    const links = engine().links;
    engine().dismissPrep();
    expect(engine().prep).toBeNull();
    expect(engine().plan.suggestions.some((s) => s.meetingNotes)).toBe(false);
    expect(engine().links).toBe(links);
  });
});

describe("the simulated meeting", () => {
  it("adds a meeting ten minutes out with the client of the newest work, offers it, and Reset removes it", async () => {
    clockAt(60);
    await recheck();
    expect(engine().prep).toBeNull();
    engine().track({ type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1047", client: "Kite & Co.", label: "INV-1047", via: "pointer" } });
    engine().simulateMeeting();
    const sim = engine().data.events.at(-1)!;
    expect(sim).toMatchObject({ client: "Kite & Co.", kind: "meeting", title: "Packaging system check-in" });
    expect(Date.parse(sim.start) - Date.now()).toBe(10 * MIN);
    expect(engine().prep).toMatchObject({ stage: "offer", eventId: sim.id });
    expect(engine().notice?.text).toMatch(/^Test meeting added: Packaging system check-in at \d+:\d\d with Kite & Co\.$/);
    engine().reset();
    expect(engine().data.events.some((e) => e.id === sim.id)).toBe(false);
    expect(engine().prep).toBeNull();
  });
});

describe("the switch", () => {
  it("off: no chip, no prep request, no signal, and Prepare does nothing; switched off while the chip shows, it goes", async () => {
    engine().setFocusAid("meetingPrep", false);
    await offeredOff();
    expect(engine().prep).toBeNull();
    expect(mockedPrep).not.toHaveBeenCalled();
    engine().prepareMeeting("keyboard");
    expect(engine().events.some((e) => e.type === "prep_offer" || e.type === "prep_start")).toBe(false);
    expect(engine().anchor).toBeNull();
    engine().setFocusAid("meetingPrep", true);
    expect(engine().prep?.eventId).toBe("e-2");
    engine().setFocusAid("meetingPrep", false);
    expect(engine().prep).toBeNull();
    const calls = mockedPrep.mock.calls.length;
    await recheck();
    await recheck();
    expect(engine().prep).toBeNull();
    expect(mockedPrep.mock.calls.length).toBe(calls);
  });

  it("off, every adapt request is exactly the one with the aid on", async () => {
    const run = async (on: boolean) => {
      mockedPost.mockClear();
      engine().setFocusAid("meetingPrep", on);
      engine().reset();
      clockAt(12.5);
      await recheck();
      engine().track({ type: "filter", panel: "invoices", detail: { filter: { status: "overdue" }, via: "pointer" } });
      await vi.advanceTimersByTimeAsync(3_000);
      const { version: _v, ...rest } = mockedPost.mock.calls.at(-1)![0];
      void _v;
      return rest;
    };
    const off = await run(false);
    const on = await run(true);
    expect(engine().events.some((e) => e.type === "prep_offer")).toBe(true);
    expect(on).toEqual(off);
  });
});

/** Twelve minutes before the meeting with the aid off: nothing is offered. */
async function offeredOff() {
  clockAt(12.5);
  await recheck();
  await flush();
}
