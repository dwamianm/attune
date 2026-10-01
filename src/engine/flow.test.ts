/**
 * The predictive flow in the store (docs/predictive-flow.md): record
 * candidates in every request, the Up next card, "Back to" working
 * contexts, and the Metrics counters. The API is mocked, as in store.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionId, GoalId, LayoutMode, PanelId } from "../../shared/catalog.ts";
import type { AdaptRequest, AdaptResponse, InvoiceStatusArg, Judgments, TimeframeArg } from "../../shared/types.ts";
import { postAdapt } from "./api.ts";
import { UP_NEXT_DISMISS_MS } from "./nextUp.ts";
import { DEFAULT_SETTINGS, useEngine } from "./store.ts";
import { choiceJ, makeJudgments } from "./test-helpers.ts";

vi.mock("./api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.ts")>();
  return { ...actual, postAdapt: vi.fn(), getHealth: vi.fn(async () => ({ ok: true, jev: true })) };
});

const mockedPost = vi.mocked(postAdapt);

function response(version: number, judgments: Judgments): AdaptResponse {
  return { version, source: "jev", judgments, meta: { model: "jev-1.13.0", latencyMs: 200, questionCount: 18 }, debug: { state: {}, questions: {} } };
}

const collections = makeJudgments({
  rel: { invoices: 2, clients: 1.4, inbox: 1.2, calendar: 0.8, tasks: 0.8 },
  goal: choiceJ<GoalId>("collect_payments", 0.9, { collect_payments: 0.9, unclear: 0.1 }),
  layout: choiceJ<LayoutMode>("focus", 0.9, { focus: 0.9 }),
});

const planDay = makeJudgments({
  rel: { calendar: 2, tasks: 1.8, team: 1.2, inbox: 0.6 },
  goal: choiceJ<GoalId>("plan_day", 0.85, { plan_day: 0.85, collect_payments: 0.1 }),
  layout: choiceJ<LayoutMode>("overview", 0.9, { overview: 0.9 }),
});

function answerWith(j: Judgments) {
  mockedPost.mockImplementation(async (req: AdaptRequest) => response(req.version, j));
}

const engine = () => useEngine.getState();
const ids = () => engine().plan.placements.map((p) => p.id);

function openInvoice(id: string, client: string) {
  engine().setView("invoices", { selectedId: id });
  engine().track({ type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: id, client, label: id, via: "pointer" } });
}

// A real day, so "overdue" and "today" read as in the app; each test starts a little later.
let clock = (() => {
  const d = new Date();
  d.setHours(9, 0, 0, 0);
  return d.getTime();
})();

beforeEach(() => {
  vi.useFakeTimers();
  clock += 5 * 60_000;
  vi.setSystemTime(clock);
  mockedPost.mockReset();
  answerWith(collections);
  engine().reset();
  // Habits outlive Reset (focus aid 3), so each test starts with none.
  engine().forgetHabits();
  engine().setSettings({ ...structuredClone(DEFAULT_SETTINGS) });
  for (const p of engine().pinned) engine().unpin(p);
  engine().reset();
});

afterEach(() => {
  engine().reset();
  vi.useRealTimers();
});

describe("record candidates", () => {
  it("sends the records the user might work on next with every request", async () => {
    engine().setView("invoices", { status: "overdue" });
    openInvoice("INV-1038", "Meridian Hotels");
    await vi.advanceTimersByTimeAsync(800);
    const records = mockedPost.mock.calls[0][0].candidates.records ?? [];
    expect(records.length).toBeGreaterThan(0);
    expect(records.length).toBeLessThanOrEqual(12);
    expect(records[0]).toMatchObject({ id: "invoice:INV-1042", panel: "invoices", why: "next in the list" });
    expect(records.some((r) => r.id === "invoice:INV-1038")).toBe(false);
  });
});

describe("Up next", () => {
  it("offers Jev's sure pick and opens it the way a click does, without acting", async () => {
    answerWith({ ...collections, nextRecord: choiceJ<string>("invoice:INV-1047", 0.7, { "invoice:INV-1047": 0.72, none: 0.1 }) });
    openInvoice("INV-1042", "Harbor Coffee Co.");
    await vi.advanceTimersByTimeAsync(800);
    expect(engine().upNext).toMatchObject({ source: "jev", why: "Jev 72%", candidate: { id: "invoice:INV-1047" } });

    const reminders = engine().data.invoices.map((i) => i.remindersSent);
    const before = engine().events.length;
    engine().openUpNext("invoice:INV-1047", "keyboard");
    expect(engine().view.invoices.selectedId).toBe("INV-1047");
    const e = engine().events.at(-1);
    expect(e).toMatchObject({ type: "up_next_open", panel: "invoices", detail: { itemId: "INV-1047", via: "keyboard" } });
    expect(e?.text).toMatch(/^Opened invoice INV-1047 · Kite & Co\. .* in Invoices from Up next, using the keyboard$/);
    expect(engine().anchor).toMatchObject({ panel: "invoices", itemId: "INV-1047", source: "work" });
    expect(engine().focusedPanel).toBe("invoices");
    // Never an action.
    expect(engine().data.invoices.map((i) => i.remindersSent)).toEqual(reminders);
    expect(engine().events.slice(before).some((x) => x.type === "action")).toBe(false);
    expect(engine().metrics.upNext).toMatchObject({ shown: 1, openedKey: 1 });
    // It asks Jev like any record open.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockedPost.mock.calls.at(-1)?.[0].snapshot.recent_activity.at(-1)).toContain("from Up next");
  });

  it("opens a docked panel first", async () => {
    answerWith({ ...collections, nextRecord: choiceJ<string>("message:m-2", 0.8, { "message:m-2": 0.8 }) });
    openInvoice("INV-1042", "Harbor Coffee Co.");
    await vi.advanceTimersByTimeAsync(800);
    engine().dismiss("inbox");
    expect(ids()).not.toContain("inbox");
    expect(engine().upNext?.candidate.id).toBe("message:m-2");
    engine().openUpNext("message:m-2");
    expect(ids()).toContain("inbox");
    expect(engine().view.inbox.selectedId).toBe("m-2");
    expect(engine().events.slice(-2).map((x) => x.type)).toEqual(["panel_open", "up_next_open"]);
    // Opened for the card, not by hand from the dock.
    expect(engine().metrics.effort.dockOpens).toBe(0);
  });

  it("shows nothing when Jev is not sure and the user is not working through a list", async () => {
    answerWith({ ...collections, nextRecord: choiceJ<string>("invoice:INV-1047", 0.3, { "invoice:INV-1047": 0.3, "invoice:INV-1049": 0.28 }) });
    openInvoice("INV-1042", "Harbor Coffee Co.");
    await vi.advanceTimersByTimeAsync(800);
    expect(engine().upNext).toBeNull();
    expect(engine().queueMode).toBe(false);
  });

  /** Remind Meridian and Harbor with the Invoices filter on All, as a user working through the overdue bills. */
  async function remindTwo() {
    expect(engine().view.invoices.status).toBe("all");
    openInvoice("INV-1038", "Meridian Hotels");
    engine().perform("send_payment_reminder", { invoiceId: "INV-1038" });
    expect(engine().upNext).toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);
    openInvoice("INV-1042", "Harbor Coffee Co.");
    engine().perform("send_payment_reminder", { invoiceId: "INV-1042" });
  }

  it("walks only the overdue invoices right after each reminder, then says they are done, with Jev silent", async () => {
    await remindTwo();
    // Two records, same action: queue mode, and the card moves on at once, never to a sent or draft invoice.
    expect(engine().queueMode).toBe(true);
    expect(engine().upNext).toMatchObject({ source: "list", why: "Next in list", candidate: { id: "invoice:INV-1047" } });
    expect(engine().upNext?.alternatives).toEqual([]);
    engine().openUpNext("invoice:INV-1047", "keyboard");
    expect(engine().view.invoices.selectedId).toBe("INV-1047");
    engine().perform("send_payment_reminder", { invoiceId: "INV-1047" });
    // The last overdue invoice: no pick (not INV-1049, which is not due yet), and the card says the list is done.
    expect(engine().upNext).toBeNull();
    expect(engine().upNextDone?.text).toBe("All overdue invoices have a reminder.");
    // Still never an action.
    expect(engine().data.invoices.find((i) => i.id === "INV-1049")?.remindersSent).toBe(0);
    // A Jev round does not bring a pick back while it shows.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().upNextDone).not.toBeNull();
    expect(engine().upNext).toBeNull();
  });

  it("hides the completion state on dismiss, and on the next unrelated action", async () => {
    await remindTwo();
    engine().openUpNext("invoice:INV-1047");
    engine().perform("send_payment_reminder", { invoiceId: "INV-1047" });
    expect(engine().upNextDone).not.toBeNull();
    engine().dismissUpNextDone();
    expect(engine().upNextDone).toBeNull();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().upNextDone).toBeNull();

    engine().reset();
    await remindTwo();
    engine().openUpNext("invoice:INV-1047");
    engine().perform("send_payment_reminder", { invoiceId: "INV-1047" });
    expect(engine().upNextDone).not.toBeNull();
    engine().track({ type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-2", client: "Meridian Hotels", via: "pointer" } });
    expect(engine().upNextDone).toBeNull();
  });

  it("skips Jev's sure pick of an invoice the reminders do not apply to", async () => {
    answerWith({ ...collections, nextRecord: choiceJ<string>("invoice:INV-1049", 0.8, { "invoice:INV-1049": 0.8, none: 0.05 }) });
    await remindTwo();
    // The Jev round lands after the reminder, so its pick would lead.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().last?.judgments.nextRecord?.choice).toBe("invoice:INV-1049");
    expect(engine().upNext).toMatchObject({ source: "list", candidate: { id: "invoice:INV-1047" } });
    expect(engine().upNext?.alternatives.map((a) => a.id) ?? []).not.toContain("invoice:INV-1049");
  });

  it("hides a dismissed pick for two minutes", async () => {
    answerWith({ ...collections, nextRecord: choiceJ<string>("invoice:INV-1047", 0.8, { "invoice:INV-1047": 0.8 }) });
    openInvoice("INV-1042", "Harbor Coffee Co.");
    await vi.advanceTimersByTimeAsync(800);
    engine().dismissUpNext("invoice:INV-1047");
    expect(engine().upNext).toBeNull();
    await vi.advanceTimersByTimeAsync(UP_NEXT_DISMISS_MS - 1_000);
    expect(engine().upNext).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine().upNext?.candidate.id).toBe("invoice:INV-1047");
  });
});

/** Collect payments on Harbor's bill with a filter, a selection, and Invoices made bigger. */
async function collectingPayments() {
  engine().setView("invoices", { status: "overdue" });
  openInvoice("INV-1042", "Harbor Coffee Co.");
  await vi.advanceTimersByTimeAsync(3_000);
  engine().maximize("invoices");
  await vi.advanceTimersByTimeAsync(3_000);
}

/** Two confident plan_day rounds, as a user moves to the day's schedule. */
async function planTheDay() {
  answerWith(planDay);
  engine().track({ type: "item_open", panel: "calendar", detail: { itemKind: "event", itemId: "e-4", client: "Meridian Hotels", via: "pointer" } });
  await vi.advanceTimersByTimeAsync(3_000);
  engine().track({ type: "item_open", panel: "tasks", detail: { itemKind: "task", itemId: "t-6", via: "pointer" } });
  await vi.advanceTimersByTimeAsync(3_000);
}

describe("Back to", () => {
  it("saves the context as it was before the goal changed, after two sure rounds, and keeps it out of what Jev reads", async () => {
    await collectingPayments();
    expect(engine().working?.goal).toBe("collect_payments");
    const plan = engine().plan;

    answerWith(planDay);
    engine().track({ type: "item_open", panel: "calendar", detail: { itemKind: "event", itemId: "e-4", client: "Meridian Hotels", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    // One round is not enough.
    expect(engine().contexts).toHaveLength(0);
    expect(engine().working?.goal).toBe("collect_payments");

    engine().track({ type: "item_open", panel: "tasks", detail: { itemKind: "task", itemId: "t-6", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().contexts).toHaveLength(1);
    const saved = engine().contexts[0];
    expect(saved).toMatchObject({ goal: "collect_payments", client: "Harbor Coffee Co.", label: "Collecting payments · Harbor Coffee Co.", bigger: ["invoices"] });
    expect(saved.view.invoices).toMatchObject({ status: "overdue", selectedId: "INV-1042" });
    expect(saved.plan.placements.map((p) => [p.id, p.size])).toEqual(plan.placements.map((p) => [p.id, p.size]));
    expect(saved.plan.grid?.cells).toEqual(plan.grid?.cells);
    expect(engine().working?.goal).toBe("plan_day");
    expect(engine().events.some((e) => e.type === "context_save" && e.text === "Saved Collecting payments · Harbor Coffee Co. for Back to")).toBe(true);

    engine().track({ type: "search", panel: "inbox", detail: { query: "stand-up" } });
    await vi.advanceTimersByTimeAsync(3_000);
    const activity = mockedPost.mock.calls.at(-1)?.[0].snapshot.recent_activity ?? [];
    expect(activity.some((line) => line.startsWith("Saved"))).toBe(false);
  });

  it("does not save on one stray round, and a round of the current goal resets the count", async () => {
    await collectingPayments();
    answerWith(planDay);
    engine().track({ type: "item_open", panel: "calendar", detail: { itemKind: "event", itemId: "e-4", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    answerWith(collections);
    engine().track({ type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1038", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    answerWith(planDay);
    engine().track({ type: "item_open", panel: "tasks", detail: { itemKind: "task", itemId: "t-6", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().contexts).toHaveLength(0);
    expect(engine().working?.goal).toBe("collect_payments");
  });

  it("saves the context when a command switches areas, before the command's filters land", async () => {
    await collectingPayments();
    mockedPost.mockImplementation(async (req) =>
      response(req.version, {
        ...collections,
        command: {
          panel: choiceJ<PanelId | "unclear">("calendar", 0.9, { calendar: 0.9 }),
          action: choiceJ<ActionId>("none", 0.9),
          invoiceStatus: choiceJ<InvoiceStatusArg>("not_mentioned", 0.9),
          client: choiceJ("not_mentioned", 0.9),
          timeframe: choiceJ<TimeframeArg>("this_week", 0.9),
        },
      }),
    );
    await engine().runCommand("this week's meetings");
    expect(engine().contexts).toHaveLength(1);
    expect(engine().contexts[0]).toMatchObject({ goal: "collect_payments", label: "Collecting payments · Harbor Coffee Co." });
    expect(engine().contexts[0].view.calendar.range).toBe("today");
    expect(engine().view.calendar.range).toBe("this_week");
    expect(engine().working?.goal).toBe("plan_day");
  });

  it("restores the placements, bigger panels, filters, selections, and links at once, saves the work left, and holds until new work", async () => {
    await collectingPayments();
    const saved = { plan: engine().plan, view: engine().view };
    await planTheDay();
    expect(engine().working?.goal).toBe("plan_day");
    engine().setView("invoices", { status: "paid", selectedId: null });
    engine().restore("invoices");
    engine().pin("team");
    await vi.advanceTimersByTimeAsync(3_000);

    const ctx = engine().contexts[0];
    engine().restoreContext(ctx.id, "pointer");
    // Not delayed by the minimum change interval.
    expect(engine().view.invoices).toMatchObject({ status: "overdue", selectedId: "INV-1042" });
    expect(engine().bigger).toEqual(["invoices"]);
    expect(engine().plan.placements.find((p) => p.id === "invoices")).toMatchObject({ size: "hero", bigger: true });
    for (const p of saved.plan.placements) expect(ids()).toContain(p.id);
    // Pins stay global: Team was pinned after the save and stays pinned and on the canvas.
    expect(engine().plan.placements.find((p) => p.id === "team")).toMatchObject({ pinned: true });
    expect(engine().plan.decisions[0]).toEqual({ kind: "command", text: "Went back to Collecting payments · Harbor Coffee Co." });
    expect(engine().previousPlan).not.toBeNull();
    expect(engine().events.at(-1)).toMatchObject({ type: "context_restore", text: "Went back to earlier work: Collecting payments · Harbor Coffee Co." });
    expect(engine().working?.goal).toBe("collect_payments");
    // The work left is saved, so the user can go straight back to it.
    expect(engine().contexts[0]).toMatchObject({ goal: "plan_day" });
    expect(engine().contexts.some((c) => c.id === ctx.id)).toBe(false);
    expect(engine().metrics.effort.backTo).toBe(1);

    // Held against Jev rounds until new work.
    const held = ids();
    const heldPlan = engine().plan;
    answerWith(planDay);
    await engine().adaptNow();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ids()).toEqual(held);
    expect(engine().plan.placements.map((p) => p.size)).toEqual(heldPlan.placements.map((p) => p.size));
    expect(engine().history.at(-1)?.decisions[0]).toMatchObject({ kind: "hold" });
    expect(engine().plan.basedOnVersion).toBeLessThan(engine().last?.version ?? 0);
    // A Jev round from before the restore does not count toward a switch back.
    expect(engine().contexts).toHaveLength(1);

    // New work ends the hold: the next round is laid out from its judgments again.
    engine().track({ type: "item_open", panel: "calendar", detail: { itemKind: "event", itemId: "e-3", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine().plan.basedOnVersion).toBe(engine().last?.version);
    expect(engine().history.at(-1)?.decisions.some((d) => d.kind === "hold" && d.text.includes("went back to"))).toBe(false);
  });

  it("puts back the layout, filters, selections, links, and chips on an Undo right after Back to", async () => {
    await collectingPayments();
    await planTheDay();
    engine().setView("invoices", { status: "paid", selectedId: null });
    engine().setView("calendar", { range: "this_week" });
    await vi.advanceTimersByTimeAsync(3_000);
    const before = {
      plan: engine().plan.placements.map((p) => [p.id, p.size]),
      cells: engine().plan.grid?.cells,
      bigger: engine().bigger,
      view: structuredClone(engine().view),
      links: engine().links,
      working: engine().working,
      contexts: engine().contexts,
    };
    expect(before.links).not.toBeNull();

    engine().restoreContext(engine().contexts[0].id);
    expect(engine().view.invoices).toMatchObject({ status: "overdue", selectedId: "INV-1042" });
    expect(engine().working?.goal).toBe("collect_payments");

    engine().undo();
    expect(engine().plan.placements.map((p) => [p.id, p.size])).toEqual(before.plan);
    expect(engine().plan.grid?.cells).toEqual(before.cells);
    expect(engine().bigger).toEqual(before.bigger);
    expect(engine().view).toEqual(before.view);
    expect(engine().links?.source).toEqual(before.links?.source);
    expect(Object.keys(engine().links?.relations ?? {}).sort()).toEqual(Object.keys(before.links?.relations ?? {}).sort());
    expect(engine().working).toEqual(before.working);
    // The chip for the work the user went back to is offered again.
    expect(engine().contexts).toEqual(before.contexts);
    expect(engine().events.at(-1)?.type).toBe("undo");
    expect(engine().metrics.undos).toBe(1);
  });

  it("restores the link cues that were on screen", async () => {
    await collectingPayments();
    const links = engine().links;
    expect(links).not.toBeNull();
    await planTheDay();
    engine().clearLinks();
    expect(engine().links).toBeNull();
    engine().restoreContext(engine().contexts[0].id);
    expect(engine().links?.source).toMatchObject({ panel: links?.source.panel, itemId: links?.source.itemId });
    expect(Object.keys(engine().links?.relations ?? {}).sort()).toEqual(Object.keys(links?.relations ?? {}).sort());
  });

  it("forgets contexts, the Up next card, and the metrics on Reset", async () => {
    await collectingPayments();
    await planTheDay();
    expect(engine().contexts).toHaveLength(1);
    engine().reset();
    expect(engine().contexts).toEqual([]);
    expect(engine().working).toBeNull();
    expect(engine().upNext).toBeNull();
    expect(engine().metrics.startedAt).toBeNull();
  });
});

describe("metrics in the store", () => {
  it("scores Jev's next record against the next open, and counts layout changes and undos", async () => {
    answerWith({ ...collections, nextRecord: choiceJ<string>("invoice:INV-1047", 0.8, { "invoice:INV-1047": 0.8, "invoice:INV-1049": 0.1 }) });
    openInvoice("INV-1042", "Harbor Coffee Co.");
    await vi.advanceTimersByTimeAsync(800);
    expect(engine().metrics.pendingRecord).toEqual({ top: ["invoice:INV-1047", "invoice:INV-1049"], source: "jev" });
    openInvoice("INV-1047", "Kite & Co.");
    expect(engine().metrics.nextRecord).toMatchObject({ hit1: 1, hit3: 1 });
    expect(engine().metrics.layoutChanges).toBeGreaterThan(0);
    engine().undo();
    expect(engine().metrics.undos).toBe(1);
  });
});
