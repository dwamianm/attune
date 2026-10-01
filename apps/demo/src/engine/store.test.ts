import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionId, GoalId, LayoutMode, PanelId } from "../../shared/catalog.ts";
import type { AdaptRequest, AdaptResponse, InvoiceStatusArg, Judgments, TimeframeArg } from "../../shared/types.ts";
import { ApiError, postAdapt } from "./api.ts";
import { defaultPlan } from "./policy.ts";
import { frontGroup } from "./focusAids.ts";
import { cellFits, cellsOverlap } from "@attune/core";
import { ANCHOR_IDLE_RELEASE_MS, DEFAULT_SETTINGS, POINTER_LEAVE_HOLD_MS, POINTER_MOVE_HOLD_MS, UNDO_HOLD_MS, useEngine } from "./store.ts";
import { choiceJ, makeJudgments } from "./test-helpers.ts";

vi.mock("./api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.ts")>();
  return { ...actual, postAdapt: vi.fn(), getHealth: vi.fn(async () => ({ ok: true, jev: true })) };
});

const mockedPost = vi.mocked(postAdapt);

function response(version: number, judgments: Judgments): AdaptResponse {
  return {
    version,
    source: "jev",
    judgments,
    meta: { model: "jev-1.13.0", latencyMs: 250, questionCount: 17 },
    debug: { state: {}, questions: {} },
  };
}

const collections = makeJudgments({
  rel: { invoices: 2, clients: 1.4, inbox: 1.2, calendar: 0.8, tasks: 0.8 },
  goal: choiceJ<GoalId>("collect_payments", 0.9, { collect_payments: 0.9, unclear: 0.1 }),
  layout: choiceJ<LayoutMode>("focus", 0.9, { focus: 0.9 }),
});

const compare = makeJudgments({
  rel: { invoices: 2, clients: 2, inbox: 1, calendar: 0.8 },
  goal: choiceJ<GoalId>("manage_client", 0.9, { manage_client: 0.9 }),
  layout: choiceJ<LayoutMode>("compare", 0.9, { compare: 0.9 }),
});

/** Answer every request with these judgments, echoing the request version. */
function answerWith(j: Judgments) {
  mockedPost.mockImplementation(async (req: AdaptRequest) => response(req.version, j));
}

const engine = () => useEngine.getState();
const ids = () => engine().plan.placements.map((p) => p.id);

/** Deterministic PRNG (mulberry32), so a failing random session can be replayed from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each test starts later than the last, the way a real clock moves.
let clock = 1_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  clock += 10_000_000;
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

describe("engine store", () => {
  it("starts with the traditional layout and fresh data", () => {
    expect(engine().plan).toEqual(defaultPlan());
    expect(engine().data.invoices.find((i) => i.id === "INV-1042")?.remindersSent).toBe(1);
    expect(engine().status).toBe("idle");
  });

  it("logs events with text and asks Jev after the debounce", async () => {
    engine().track({ type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1042", label: "INV-1042" } });
    expect(engine().events.at(-1)?.text).toBe("Opened invoice INV-1042 in Invoices");
    expect(engine().focusedPanel).toBe("invoices");
    await vi.advanceTimersByTimeAsync(699);
    expect(mockedPost).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mockedPost).toHaveBeenCalledTimes(1);
    const req = mockedPost.mock.calls[0][0];
    expect(req.snapshot.recent_activity).toEqual(["Opened invoice INV-1042 in Invoices"]);
    expect(req.snapshot.current_focus).toContain("Invoices panel");
    expect(req.candidates.clients).toContain("Harbor Coffee Co.");
    expect(req.command).toBeUndefined();

    await vi.advanceTimersByTimeAsync(0);
    expect(engine().plan.mode).toBe("focus");
    // Invoices is where the user clicked, so it is the anchor and holds still
    // in the last column (it used to jump to the front as the hero).
    expect(engine().anchor).toMatchObject({ panel: "invoices", itemKind: "invoice", itemId: "INV-1042", label: "INV-1042" });
    expect(engine().plan.grid?.cells.invoices).toMatchObject({ col: 3, row: 0 });
    expect(engine().plan.placements.find((p) => p.id === "invoices")).toMatchObject({ anchor: true, size: "standard" });
    expect(engine().goal).toEqual({ id: "collect_payments", confidence: 0.9 });
    expect(engine().history).toHaveLength(1);
    expect(engine().history[0]).toMatchObject({ trigger: "item_open", stale: false });
    expect(engine().previousPlan).toEqual(defaultPlan());
  });

  it("does not ask Jev for dwell, scroll, or an unchanged focus", async () => {
    engine().track({ type: "panel_focus", panel: "inbox" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockedPost).toHaveBeenCalledTimes(1); // Focus changed from nothing to Inbox.
    engine().track({ type: "panel_focus", panel: "inbox" });
    engine().track({ type: "panel_dwell", panel: "calendar", detail: { durationMs: 3000 } });
    engine().track({ type: "scroll", panel: "inbox" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockedPost).toHaveBeenCalledTimes(1);
  });

  it("drops answers older than the last applied one and records them as stale", async () => {
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    const applied = engine().plan;
    mockedPost.mockImplementation(async (req) => response(req.version - 1, compare));
    engine().track({ type: "item_open", panel: "clients" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().history.at(-1)?.stale).toBe(true);
    expect(engine().plan.mode).toBe(applied.mode);
    expect(engine().last?.judgments).toBe(collections);
  });

  it("holds a layout change that lands inside the minimum change interval", async () => {
    engine().track({ type: "item_open", panel: "invoices" }); // Request at +700, plan changes then.
    await vi.advanceTimersByTimeAsync(800);
    expect(engine().plan.mode).toBe("focus");

    answerWith(compare);
    engine().track({ type: "item_open", panel: "clients" }); // Request at +1700, too soon.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mockedPost).toHaveBeenCalledTimes(2);
    expect(engine().plan.mode).toBe("focus");
    expect(engine().history.at(-1)?.decisions[0]).toMatchObject({ kind: "hold" });

    await vi.advanceTimersByTimeAsync(1_600); // Interval ends at +3200.
    expect(engine().plan.mode).toBe("compare");
    expect(engine().history.at(-1)?.decisions.some((d) => d.kind === "mode")).toBe(true);
  });

  it("keeps the traditional layout when adaptive is off but still asks Jev", async () => {
    engine().setSettings({ adaptive: false });
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    expect(mockedPost).toHaveBeenCalledTimes(1);
    expect(engine().plan).toEqual(defaultPlan());
    expect(engine().last).not.toBeNull();
    expect(engine().history).toHaveLength(1);

    engine().setSettings({ adaptive: true });
    expect(engine().plan.mode).toBe("focus");
  });

  it("keeps the plan when frozen but still applies manual edits", async () => {
    engine().setSettings({ frozen: true });
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    expect(ids()).toEqual(defaultPlan().placements.map((p) => p.id));
    engine().dismiss("inbox");
    expect(ids()).not.toContain("inbox");
    engine().setSettings({ frozen: false });
    expect(engine().plan.mode).toBe("focus");
  });

  it("applies a command at once, promotes its panel, and sets filters", async () => {
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    mockedPost.mockImplementation(async (req) =>
      response(req.version, {
        ...collections,
        command: {
          panel: choiceJ<PanelId | "unclear">("clients", 0.9, { clients: 0.9 }),
          action: choiceJ<ActionId>("send_payment_reminder", 0.8),
          invoiceStatus: choiceJ<InvoiceStatusArg>("not_mentioned", 0.9),
          client: choiceJ("Meridian Hotels", 0.9),
          timeframe: choiceJ<TimeframeArg>("not_mentioned", 0.9),
        },
      }),
    );
    const done = engine().runCommand("meridian");
    const req = mockedPost.mock.calls.at(-1)?.[0];
    expect(req?.command).toBe("meridian");
    expect(req?.snapshot.recent_activity.at(-1)).toBe('Typed in the command bar: "meridian"');
    await done;
    // Inside the minimum change interval, but commands skip it.
    expect(engine().plan.placements[0]).toMatchObject({ id: "clients", size: "hero" });
    expect(engine().plan.mode).toBe("focus");
    expect(engine().command).toMatchObject({ status: "applied", text: "meridian" });
    expect(engine().view.clients.selected).toBe("Meridian Hotels");
    expect(engine().focusedPanel).toBe("clients");
    expect(engine().plan.suggestions[0]).toMatchObject({ actionId: "send_payment_reminder", prominence: "primary", args: { invoiceId: "INV-1038" } });
    // Suggested, never performed.
    expect(engine().data.invoices.find((i) => i.id === "INV-1038")?.remindersSent).toBe(2);
  });

  it("keeps the layout and the last judgments when a command is unclear", async () => {
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(5_000);
    const before = ids();
    const last = engine().last;
    // An off-topic command: every panel useless, goal unclear.
    mockedPost.mockImplementation(async (req) =>
      response(req.version, {
        ...makeJudgments(),
        command: {
          panel: choiceJ<PanelId | "unclear">("unclear", 0.98, { unclear: 0.99 }),
          action: choiceJ<ActionId>("none", 1),
          invoiceStatus: choiceJ<InvoiceStatusArg>("not_mentioned", 1),
          client: choiceJ("not_mentioned", 1),
          timeframe: choiceJ<TimeframeArg>("not_mentioned", 1),
        },
      }),
    );
    await engine().runCommand("banana smoothie recipe");
    expect(engine().command).toMatchObject({ status: "unclear" });
    expect(ids()).toEqual(before);
    expect(engine().last).toBe(last);
    expect(engine().history.at(-1)).toMatchObject({ trigger: "command", stale: false, decisions: [{ kind: "hold" }] });
    // A later local re-plan still uses the last good judgments.
    engine().track({ type: "scroll", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ids()).toEqual(before);
  });

  it("performs actions on app data and logs them", () => {
    engine().perform("send_payment_reminder", { client: "Harbor Coffee Co." });
    expect(engine().data.invoices.find((i) => i.id === "INV-1042")?.remindersSent).toBe(2);
    expect(engine().notice?.text).toBe("Reminder sent to Harbor Coffee Co. for INV-1042");
    expect(engine().events.at(-1)).toMatchObject({ type: "action", panel: "invoices", detail: { actionId: "send_payment_reminder", itemId: "INV-1042" } });

    engine().perform("mark_invoice_paid", { invoiceId: "INV-1047" });
    expect(engine().data.invoices.find((i) => i.id === "INV-1047")?.status).toBe("paid");

    engine().perform("reply_to_message", { client: "Meridian Hotels" });
    expect(engine().data.messages.find((m) => m.id === "m-2")?.unread).toBe(false);
    expect(engine().notice?.text).toBe("Reply drafted to Hannah Brooks at Meridian Hotels (prototype, no email is sent)");

    engine().perform("create_task", { client: "Kite & Co." });
    expect(engine().data.tasks[0]).toMatchObject({ title: "Follow up with Kite & Co.", client: "Kite & Co.", project: "Packaging system" });

    engine().perform("update_project_status", { client: "Atlas Robotics" });
    expect(engine().data.projects.find((p) => p.id === "p-atlas")?.status).toBe("on_track");

    const before = engine().data.events.length;
    engine().perform("schedule_meeting", { client: "Juniper Books" });
    const added = engine().data.events.at(-1);
    expect(engine().data.events.length).toBe(before + 1);
    expect(new Date(added?.start ?? "").getHours()).toBe(10);

    engine().perform("view_client", { client: "Solace Yoga" });
    expect(engine().view.clients.selected).toBe("Solace Yoga");
    expect(engine().focusedPanel).toBe("clients");

    engine().perform("write_note", {});
    expect(ids()).toContain("notes");
  });

  it("does not log an action that could not happen", () => {
    const before = engine().events.length;
    engine().perform("send_payment_reminder", { client: "Vantage Legal" }); // Only a draft invoice.
    expect(engine().notice?.text).toBe("No unpaid invoice found for Vantage Legal");
    engine().perform("mark_invoice_paid", { invoiceId: "INV-1031" });
    expect(engine().notice?.text).toBe("INV-1031 is already paid");
    expect(engine().events.length).toBe(before);
  });

  it("lets a command bring back a panel the user dismissed", async () => {
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    engine().dismiss("team");
    expect(engine().dismissed.team).toBeDefined();
    mockedPost.mockImplementation(async (req) =>
      response(req.version, {
        ...collections,
        command: {
          panel: choiceJ<PanelId | "unclear">("team", 0.95),
          action: choiceJ<ActionId>("none", 0.9),
          invoiceStatus: choiceJ<InvoiceStatusArg>("not_mentioned", 0.9),
          client: choiceJ("not_mentioned", 0.9),
          timeframe: choiceJ<TimeframeArg>("today", 0.9),
        },
      }),
    );
    await engine().runCommand("who is free today");
    expect(engine().dismissed.team).toBeUndefined();
    expect(engine().plan.placements[0]).toMatchObject({ id: "team", size: "hero" });
    // A later re-plan keeps it, since the dismissal is gone and it is focused.
    engine().track({ type: "scroll", panel: "team" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ids()).toContain("team");
  });

  it("accepts and dismisses suggestions", async () => {
    answerWith({ ...collections, nextAction: choiceJ<ActionId>("send_payment_reminder", 0.9), targetClient: choiceJ("Harbor Coffee Co.", 0.9) });
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    const [s] = engine().plan.suggestions;
    expect(s.label).toBe("Send payment reminder to Harbor Coffee Co.");
    engine().acceptSuggestion(s);
    expect(engine().plan.suggestions).toEqual([]);
    expect(engine().data.invoices.find((i) => i.id === "INV-1042")?.remindersSent).toBe(2);
    expect(engine().events.map((e) => e.type).slice(-2)).toEqual(["suggestion_accept", "action"]);

    engine().reset();
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(1_500); // The 1000 ms gap after the last request still applies.
    engine().dismissSuggestion(engine().plan.suggestions[0]);
    expect(engine().plan.suggestions).toEqual([]);
    await vi.advanceTimersByTimeAsync(5_000); // The dismissal asks Jev again; the policy skips the dismissed action.
    expect(engine().plan.suggestions).toEqual([]);
  });

  it("pins, dismisses, and opens panels at once, and persists pins", async () => {
    engine().pin("notes");
    expect(ids()[0]).toBe("notes");
    expect(engine().pinned).toEqual(["notes"]);
    engine().dismiss("inbox");
    expect(ids()).not.toContain("inbox");
    engine().open("team");
    expect(ids()).toContain("team");
    expect(engine().focusedPanel).toBe("team");

    // With judgments, the policy keeps a docked panel docked and an opened panel on the canvas.
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    expect(ids()).not.toContain("inbox");
    expect(ids()).toContain("team");
    expect(ids()[0]).toBe("notes");
    engine().unpin("notes");
    expect(engine().pinned).toEqual([]);
  });

  it("moves only the edited panel on a manual open or dismiss, then re-plans at the normal pace", async () => {
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    expect(engine().mode).toBe("focus");
    // Newer judgments that would rearrange the canvas land inside the minimum
    // change interval, so they wait.
    answerWith(compare);
    engine().track({ type: "item_open", panel: "clients" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine().last?.judgments.layout.choice).toBe("compare");
    expect(engine().mode).toBe("focus");

    const before = ids();
    const victim = before.find((id) => id !== "invoices" && id !== "clients")!;
    engine().dismiss(victim);
    expect(ids()).toEqual(before.filter((id) => id !== victim));
    expect(engine().mode).toBe("focus");

    const docked = engine().plan.docked.find((id) => id !== victim && id !== "help")!;
    const beforeOpen = ids();
    engine().open(docked);
    expect(ids()).toEqual([...beforeOpen, docked]);

    // A pin moves only the pinned panel, to the front where the policy puts pins.
    const beforePin = ids();
    const pinnedId = beforePin[2];
    engine().pin(pinnedId);
    expect(ids()).toEqual([pinnedId, ...beforePin.filter((id) => id !== pinnedId)]);
    expect(engine().plan.placements[0]).toMatchObject({ pinned: true, change: "promoted" });

    // The policy catches up after the interval, and keeps every manual edit.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine().mode).toBe("compare");
    expect(ids()).not.toContain(victim);
    expect(ids()).toContain(docked);
    expect(ids()[0]).toBe(pinnedId);
  });

  it("undoes the last layout change", async () => {
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    expect(engine().plan.mode).toBe("focus");
    engine().undo();
    expect(engine().plan.mode).toBe("overview");
    expect(engine().plan.decisions[0].text).toBe("Restored the previous layout");
    expect(engine().events.at(-1)?.type).toBe("undo");
  });

  it("replays a scenario step by step and can be cancelled by reset", async () => {
    const done = engine().replayScenario("morning");
    await vi.advanceTimersByTimeAsync(0);
    expect(engine().events).toHaveLength(1);
    expect(engine().focusedPanel).toBe("calendar");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine().events).toHaveLength(2);
    engine().reset();
    await done;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine().events).toHaveLength(0);

    const full = engine().replayScenario("compare");
    await vi.advanceTimersByTimeAsync(10_000);
    await full;
    expect(engine().events).toHaveLength(6);
    expect(engine().focusedPanel).toBe("clients");
  });

  it("keeps at most 30 history records", async () => {
    for (let i = 0; i < 35; i++) {
      engine().track({ type: "item_open", panel: i % 2 ? "invoices" : "clients" });
      await vi.advanceTimersByTimeAsync(1_800);
    }
    expect(engine().history.length).toBe(30);
  });
});

function commandJ(panel: PanelId | "unclear", conf: number, extra: Partial<Record<string, unknown>> = {}) {
  return {
    panel: choiceJ<PanelId | "unclear">(panel, conf, { [panel]: conf }),
    action: choiceJ<ActionId>("none", 0.9),
    invoiceStatus: choiceJ<InvoiceStatusArg>("not_mentioned", 0.9),
    client: choiceJ("not_mentioned", 0.9),
    timeframe: choiceJ<TimeframeArg>("not_mentioned", 0.9),
    ...extra,
  };
}

describe("engine store: fixes", () => {
  it("logs the panel a command opened, without asking Jev again (ENG-1)", async () => {
    mockedPost.mockImplementation(async (req) => response(req.version, { ...collections, command: commandJ("calendar", 0.95) }));
    await engine().runCommand("calendar");
    // The jump is logged, so usage and recency count the panel.
    expect(engine().events.at(-1)).toMatchObject({ type: "panel_focus", panel: "calendar", detail: { via: "command" } });
    expect(engine().focusedPanel).toBe("calendar");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockedPost).toHaveBeenCalledTimes(1); // The command round already judged it.
  });

  it("holds the command's layout while only the command round's judgments are re-read", async () => {
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    const overview = { ...collections, layout: choiceJ<LayoutMode>("overview", 0.85, { overview: 0.85 }) };
    mockedPost.mockImplementation(async (req) => response(req.version, { ...overview, command: commandJ("calendar", 0.95) }));
    await engine().runCommand("calendar");
    // No new round: every Jev call now fails, so only local re-plans happen.
    mockedPost.mockImplementation(async () => {
      throw new ApiError("network", "Cannot reach the local server");
    });
    engine().track({ type: "panel_dwell", panel: "invoices", detail: { durationMs: 2_000 } });
    engine().pin("tasks");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine().plan.mode).toBe("focus");
    expect(engine().plan.placements.find((p) => p.id === "calendar")?.size).toBe("hero");
    expect(ids().filter((id) => id !== "tasks")[0]).toBe("calendar");

    // A newer applied round replaces the hold.
    answerWith(overview);
    engine().track({ type: "item_open", panel: "inbox" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine().plan.mode).toBe("overview");
  });

  it("keeps the layout on a 'Did you mean' until the user picks (UX-5)", async () => {
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(5_000);
    const before = ids();
    const last = engine().last;
    mockedPost.mockImplementation(async (req) =>
      response(req.version, { ...makeJudgments(), command: commandJ("clients", 0.45, { panel: choiceJ<PanelId | "unclear">("clients", 0.45, { clients: 0.5, inbox: 0.3 }) }) }),
    );
    await engine().runCommand("what should I do next?");
    expect(engine().command?.status).toBe("confirm");
    expect(ids()).toEqual(before);
    expect(engine().last).toBe(last);
    engine().chooseCommandOption("clients");
    expect(engine().plan.placements[0]).toMatchObject({ id: "clients", size: "hero" });
  });

  it("does not undo into an adaptive layout after Adaptive is turned off (ENG-5)", async () => {
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    expect(engine().plan.mode).toBe("focus");
    engine().setSettings({ adaptive: false });
    expect(engine().previousPlan).toBeNull();
    engine().undo();
    expect(engine().plan).toEqual(defaultPlan());
  });

  it("keeps pins and the plan in step after undoing a pin (ENG-6)", async () => {
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(5_000);
    engine().pin("tasks");
    expect(engine().pinned).toEqual(["tasks"]);
    engine().undo();
    expect(engine().plan.placements.find((p) => p.id === "tasks")?.pinned).toBe(false);
    expect(engine().pinned).toEqual([]);
  });

  it("marks what an undo changes back, so badges describe the undo (UX-11)", async () => {
    // A round with no anchor (no click), so Invoices becomes the hero at the front.
    await engine().adaptNow();
    expect(engine().plan.placements[0]).toMatchObject({ id: "invoices", size: "hero" });
    engine().undo();
    expect(engine().plan.placements.find((p) => p.id === "invoices")?.change).toBe("demoted");
  });

  it("does not bring an undone change back while the judgments stay the same (K9)", async () => {
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    expect(engine().plan.mode).toBe("focus");
    engine().undo();
    await vi.advanceTimersByTimeAsync(20_000); // Past the 15 s undo hold.
    engine().open("team"); // Re-plans from the same judgments.
    await vi.advanceTimersByTimeAsync(5_000); // The open also asked Jev, which answered the same.
    expect(engine().plan.mode).toBe("overview");
    // A clearly different read (another goal) may switch again.
    answerWith(compare);
    engine().track({ type: "item_open", panel: "clients" });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine().plan.mode).toBe("compare");
  });

  it("shows the no-key heuristic as offline, and only a real failure as an error (ENG-7)", async () => {
    const heuristic = (fallback: "no_key" | "jev_error", error: string): AdaptResponse => ({
      ...response(0, collections),
      source: "heuristic",
      meta: { model: "heuristic", latencyMs: 3, questionCount: 17, error, fallback },
    });
    mockedPost.mockImplementation(async (req) => ({ ...heuristic("no_key", "No Jev API key is set (JEV_API_KEY)"), version: req.version }));
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    expect(engine().status).toBe("offline");
    mockedPost.mockImplementation(async (req) => ({ ...heuristic("jev_error", "Jev returned HTTP 503"), version: req.version }));
    engine().track({ type: "item_open", panel: "clients" });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().status).toBe("error");
  });

  it("does not overwrite a round's recorded decisions with a later local re-plan (ENG-8)", async () => {
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    const recorded = engine().history[0].decisions;
    expect(recorded.some((d) => d.kind === "mode")).toBe(true);
    engine().open("team"); // Re-plans from the same round, held by the minimum interval.
    mockedPost.mockImplementation(() => new Promise(() => {})); // Its own request never answers.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine().history[0].decisions).toEqual(recorded);
  });

  it("says nothing changed when a command asks for what is already shown (ENG-9)", async () => {
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    mockedPost.mockImplementation(async (req) => response(req.version, { ...collections, command: commandJ("invoices", 0.95) }));
    await engine().runCommand("invoices");
    await engine().runCommand("invoices");
    const undoTarget = engine().previousPlan;
    expect(engine().plan.decisions).toEqual([{ kind: "hold", text: "Already showing Invoices" }]);
    await engine().runCommand("invoices");
    expect(engine().previousPlan).toBe(undoTarget);
  });

  it("clips a long command and explains a server refusal (ENG-10)", async () => {
    mockedPost.mockImplementation(async (req) => response(req.version, { ...collections, command: commandJ("invoices", 0.95) }));
    await engine().runCommand(`show ${"x".repeat(400)}`);
    expect(mockedPost.mock.calls.at(-1)?.[0].command).toHaveLength(300);
    mockedPost.mockImplementation(async () => {
      throw new ApiError("http", "Server answered 400: command must be a string when present.", 400, "command must be a string when present.");
    });
    await engine().runCommand("anything");
    expect(engine().command?.message).toBe("The server could not use that command: command must be a string when present.");
  });

  it("drops a suggestion as soon as the same action is done by hand, so '.' cannot repeat it (UX-2)", async () => {
    answerWith({ ...collections, nextAction: choiceJ<ActionId>("send_payment_reminder", 0.9), targetClient: choiceJ("Kite & Co.", 0.9) });
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(800);
    const [s] = engine().plan.suggestions;
    expect(s).toMatchObject({ label: "Send payment reminder to Kite & Co.", args: { invoiceId: "INV-1047" } });
    engine().perform("send_payment_reminder", { client: "Kite & Co.", invoiceId: "INV-1047" });
    expect(engine().plan.suggestions).toEqual([]);
    engine().acceptSuggestion(s); // The stale chip, or a "." a moment later.
    expect(engine().data.invoices.find((i) => i.id === "INV-1047")?.remindersSent).toBe(1);
  });

  it("replies to the message on screen when the suggestion names no client (UX-8)", async () => {
    answerWith({ ...collections, nextAction: choiceJ<ActionId>("reply_to_message", 0.9), targetClient: choiceJ("none", 0.9) });
    engine().setView("inbox", { query: "kite", selectedId: "m-5" });
    engine().track({ type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-5", client: "Kite & Co." } });
    await vi.advanceTimersByTimeAsync(800);
    const [s] = engine().plan.suggestions;
    expect(s.label).toBe("Reply to Zoe Laurent");
    engine().acceptSuggestion(s);
    expect(engine().notice?.text).toBe("Reply drafted to Zoe Laurent at Kite & Co. (prototype, no email is sent)");
    expect(engine().view.inbox.selectedId).toBe("m-5");
    // Accepting it did not bring the same kind of chip straight back for another message (ENG-2).
    engine().track({ type: "panel_dwell", panel: "inbox", detail: { durationMs: 2_000 } });
    expect(engine().plan.suggestions.some((x) => x.actionId === "reply_to_message")).toBe(false);
  });

  it("does not ask Jev on keyboard focus alone, and holds reflows while tabbing (UX-3)", async () => {
    engine().track({ type: "panel_focus", panel: "inbox", detail: { via: "keyboard" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockedPost).not.toHaveBeenCalled();

    engine().track({ type: "item_open", panel: "invoices" });
    engine().setCanvasHold("keyboard", true); // Focus is still moving through the canvas.
    await vi.advanceTimersByTimeAsync(800);
    expect(engine().last).not.toBeNull();
    expect(engine().plan.mode).toBe("overview");
    engine().setCanvasHold("keyboard", false);
    await vi.advanceTimersByTimeAsync(0);
    expect(engine().plan.mode).toBe("focus");
  });

  it("with Keep in place, changes only the edited card while the pointer is on the canvas (UX-4)", async () => {
    // The older pin behavior; with "Move pinned and bigger panels to the front" on, a pin goes to the front at once (see "move to front").
    engine().setSettings({ focusAids: { ...engine().settings.focusAids, moveToFront: false } });
    engine().track({ type: "item_open", panel: "invoices" });
    await vi.advanceTimersByTimeAsync(5_000);
    const before = ids();
    engine().setCanvasHold("pointer", true);
    const target = before[3];
    engine().pin(target);
    expect(ids()).toEqual(before); // Pinned in place, nothing slides under the pointer.
    expect(engine().plan.placements[3]).toMatchObject({ id: target, pinned: true });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ids()).toEqual(before);
    engine().setCanvasHold("pointer", false);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(ids()[0]).toBe(target);
  });

  it("undoes everything a change card lists, not just its last plan (UX-9)", () => {
    const before = engine().plan;
    engine().open("analytics");
    engine().open("notes");
    engine().undo(before);
    expect(ids()).toEqual(before.placements.map((p) => p.id));
  });
});

describe("anchored relayout", () => {
  afterEach(() => {
    engine().setPointer({ panel: null, down: false });
    engine().setColumns(4);
  });

  /** The cells the reset (default) plan shows at 4 columns: the CSS dense flow. */
  const DEFAULT_CELLS: Partial<Record<PanelId, { col: number; row: number }>> = {
    inbox: { col: 0, row: 0 },
    calendar: { col: 1, row: 0 },
    tasks: { col: 2, row: 0 },
    invoices: { col: 3, row: 0 },
    clients: { col: 0, row: 2 },
    projects: { col: 1, row: 2 },
  };
  const cell = (id: PanelId) => engine().plan.grid?.cells[id];
  const invoiceOpen = () => ({
    type: "item_open" as const,
    panel: "invoices" as const,
    detail: { itemKind: "invoice" as const, itemId: "INV-1042", client: "Harbor Coffee Co.", via: "pointer" as const },
  });
  const clientOpen = (itemId: string, client: string) => ({
    type: "item_open" as const,
    panel: "clients" as const,
    detail: { itemKind: "client" as const, itemId, client, via: "pointer" as const },
  });
  /** These cell checks pin the calm relayout without gathering: "Arrange linked panels by next step" off, its older behavior. */
  const withoutGathering = () => engine().setSettings({ focusAids: { ...engine().settings.focusAids, arrangeLinks: false } });

  function expectValidGrid(): void {
    const plan = engine().plan;
    const g = plan.grid!;
    const cells = plan.placements.map((p) => g.cells[p.id]!);
    for (const c of cells) expect(cellFits(c, g.columns)).toBe(true);
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) expect(cellsOverlap(cells[i], cells[j])).toBe(false);
  }

  it("anchors the panel the user works in, and keeps it for more work there", () => {
    engine().track(invoiceOpen());
    const first = engine().anchor;
    expect(first).toMatchObject({ panel: "invoices", itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co.", label: "INV-1042", source: "work" });
    engine().track({ type: "filter", panel: "invoices", detail: { filter: { status: "overdue" }, via: "pointer" } });
    expect(engine().anchor?.at).toBe(first?.at);
    engine().track(clientOpen("c-atlas", "Atlas Robotics"));
    expect(engine().anchor).toMatchObject({ panel: "clients", label: "Atlas Robotics" });
    expect(engine().anchor!.at).toBeGreaterThan(first!.at);
  });

  it("anchors on a client a search names", () => {
    engine().track({ type: "search", panel: "inbox", detail: { query: "harbor invoice" } });
    expect(engine().anchor).toMatchObject({ panel: "inbox", client: "Harbor Coffee Co.", label: "Harbor Coffee Co." });
  });

  it("does not anchor on keyboard focus, a pointer rest, opening a panel already shown, or a suggestion", () => {
    engine().track({ type: "panel_focus", panel: "inbox", detail: { via: "keyboard" } });
    engine().track({ type: "panel_dwell", panel: "tasks", detail: { durationMs: 2_000 } });
    engine().open("calendar"); // Already on the canvas: logged as a focus, but it is not work there.
    engine().track({ type: "action", panel: "invoices", detail: { actionId: "send_payment_reminder", via: "suggestion" } });
    expect(engine().anchor).toBeNull();
  });

  it("anchors a panel opened from the dock, so the next round keeps the canvas where it is", async () => {
    engine().open("team");
    expect(engine().anchor).toMatchObject({ panel: "team", source: "work" });
    expect(cell("team")).toMatchObject({ col: 2, row: 2 }); // The first free spot, after Projects.
    // The open asked Jev; its round (Focus, Invoices on top) waits for the minimum change interval.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().plan.basedOnVersion).toBeGreaterThan(0);
    expect(engine().plan.grid?.anchored).toBe(true);
    expect(cell("team")).toMatchObject({ col: 2, row: 2 });
    for (const [id, c] of Object.entries(DEFAULT_CELLS) as [PanelId, { col: number; row: number }][]) expect(cell(id)).toMatchObject(c);
    expectValidGrid();
  });

  it("settles a round without an anchor instead of reshuffling the canvas", async () => {
    // Jev ranks the panels in the order they are on screen, so a round keeps
    // that order (Team stays for a minute because the user opened it).
    answerWith(makeJudgments({ rel: { inbox: 2, calendar: 1.8, tasks: 1.6, invoices: 1.4, clients: 1.2, projects: 1 } }));
    engine().open("team");
    await vi.advanceTimersByTimeAsync(3_000);
    const before = engine().plan.grid!.cells;
    await vi.advanceTimersByTimeAsync(ANCHOR_IDLE_RELEASE_MS);
    expect(engine().anchor).toBeNull();
    // After the release, Calendar leaves and Revenue joins: Revenue takes Calendar's cell, and
    // nothing else moves (a reflow from the top would slide every later card back one spot).
    answerWith(makeJudgments({ rel: { inbox: 2, tasks: 1.6, invoices: 1.4, clients: 1.2, projects: 1, analytics: 2 } }));
    await engine().adaptNow();
    const plan = engine().plan;
    expect(plan.grid?.anchored).toBe(false);
    expect(plan.changeSummary).toMatchObject({ added: ["analytics"], docked: ["calendar"], moved: [] });
    expect(cell("analytics")).toMatchObject({ col: before.calendar!.col, row: before.calendar!.row });
    for (const id of ["inbox", "tasks", "invoices", "clients", "projects", "team"] as PanelId[]) expect(cell(id)).toEqual(before[id]);
    expectValidGrid();
  });

  it("gives a cross-panel event to the card that was just pressed", async () => {
    engine().setPointer({ panel: "clients", down: true });
    engine().setPointer({ panel: "clients", down: false });
    // "Invoices" in Clients logs a filter on Invoices.
    engine().track({ type: "filter", panel: "invoices", detail: { filter: { client: "Harbor Coffee Co." }, client: "Harbor Coffee Co.", via: "pointer" } });
    expect(engine().anchor).toMatchObject({ panel: "clients", client: "Harbor Coffee Co." });
    await vi.advanceTimersByTimeAsync(1_500);
    engine().track({ type: "filter", panel: "invoices", detail: { filter: { status: "paid" }, via: "pointer" } });
    expect(engine().anchor?.panel).toBe("invoices");
    // A focus or an opened row is always in its own panel, even right after a press elsewhere.
    engine().setPointer({ panel: "clients", down: true });
    engine().track({ type: "panel_focus", panel: "tasks", detail: { via: "pointer" } });
    expect(engine().anchor?.panel).toBe("tasks");
  });

  it("releases the anchor after a quiet spell, when its panel is docked, and on undo", async () => {
    engine().track(invoiceOpen());
    await vi.advanceTimersByTimeAsync(ANCHOR_IDLE_RELEASE_MS - 1_000);
    expect(engine().anchor).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(engine().anchor).toBeNull();

    engine().track(invoiceOpen());
    engine().dismiss("invoices");
    expect(engine().anchor).toBeNull();

    engine().track(clientOpen("c-harbor", "Harbor Coffee Co."));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().anchor).not.toBeNull();
    engine().undo();
    expect(engine().anchor).toBeNull();
    expect(engine().plan.anchor).toBeNull();
    expect(engine().plan.placements.some((p) => p.relation || p.anchor)).toBe(false);
  });

  it("holds the clicked panel's cell through the relayout, and tags the linked panels", async () => {
    withoutGathering();
    engine().track(clientOpen("c-harbor", "Harbor Coffee Co."));
    await vi.advanceTimersByTimeAsync(800);
    const plan = engine().plan;
    expect(plan.grid?.anchored).toBe(true);
    expect(cell("clients")).toMatchObject(DEFAULT_CELLS.clients!);
    // Nothing above the anchor changed.
    for (const id of ["inbox", "calendar", "tasks", "invoices"] as PanelId[]) expect(cell(id)).toMatchObject({ ...DEFAULT_CELLS[id], w: 1, h: 2 });
    expect(plan.anchor?.at).toBe(engine().anchor?.at);
    expect(plan.placements.find((p) => p.id === "clients")?.anchor).toBe(true);
    const tagged = plan.placements.filter((p) => p.relation);
    // Calendar shows today only, and no Harbor event is today under the test clock, so it holds nothing to tint.
    expect(tagged.map((p) => p.id).sort()).toEqual(["inbox", "invoices", "tasks"]);
    for (const p of tagged) expect(p.relation?.tag).toBe("Linked to Harbor Coffee Co.");
    expect(plan.round).toBeGreaterThan(0);
    expect(plan.changeSummary).toBeDefined();
    expectValidGrid();
  });

  it("brings a linked panel in right under the anchor, and keeps a panel that shows a linked record", async () => {
    withoutGathering();
    // Team scores just under the join line; the link to Atlas (Sam leads its pitch deck) lifts it.
    answerWith(
      makeJudgments({
        rel: { clients: 2, team: 0.7, inbox: 0.2, invoices: 0.2, tasks: 0.2, projects: 0.2, calendar: 0.8 },
        layout: choiceJ<LayoutMode>("overview", 0.9, { overview: 0.9 }),
      }),
    );
    engine().track(clientOpen("c-atlas", "Atlas Robotics"));
    await vi.advanceTimersByTimeAsync(800);
    const plan = engine().plan;
    expect(plan.changeSummary?.added).toEqual(["team"]);
    // Jev rates Projects low, but it shows Atlas's pitch deck, so it stays while Clients is anchored.
    expect(plan.changeSummary?.docked).toEqual([]);
    expect(plan.placements.find((p) => p.id === "team")?.relation).toMatchObject({ tag: "Linked to Atlas Robotics", reason: "1 person on Pitch deck" });
    expect(cell("clients")).toMatchObject(DEFAULT_CELLS.clients!);
    expect(cell("projects")).toMatchObject(DEFAULT_CELLS.projects!);
    // Right under the anchor first, then the backfill closes the gap in the anchor's row: no orphaned hole.
    expect(cell("team")).toMatchObject({ col: 2, row: 2 });
    expectValidGrid();
  });

  it("puts a linked newcomer into the cell a leaving panel vacated beside the anchor", async () => {
    withoutGathering();
    // Calendar holds nothing linked today and leaves; Team (Harbor's project team) joins for the link.
    answerWith(makeJudgments({ rel: { inbox: 2, team: 0.7, tasks: 0.2, invoices: 0.2, clients: 0.2, projects: 0.2 } }));
    engine().track({ type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-1", client: "Harbor Coffee Co.", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(800);
    const plan = engine().plan;
    expect(plan.changeSummary?.docked).toEqual(["calendar"]);
    expect(plan.changeSummary?.added).toEqual(["team"]);
    expect(cell("team")).toMatchObject(DEFAULT_CELLS.calendar!);
    for (const id of ["inbox", "tasks", "invoices", "clients", "projects"] as PanelId[]) expect(cell(id)).toMatchObject(DEFAULT_CELLS[id]!);
    expectValidGrid();
  });

  it("keeps a last-column anchor still when Jev wants it as the hero, at 2 and 4 columns", async () => {
    for (const columns of [4, 2] as const) {
      engine().reset();
      engine().setColumns(columns);
      const start = cell("invoices")!;
      engine().track(invoiceOpen());
      await vi.advanceTimersByTimeAsync(800);
      expect(cell("invoices")).toEqual(start);
      expect(engine().plan.placements.find((p) => p.id === "invoices")?.size).toBe("standard");
      expectValidGrid();
    }
  });

  it("re-packs by reflow on a column change, with an empty summary and no badges", async () => {
    engine().track(invoiceOpen());
    await vi.advanceTimersByTimeAsync(800);
    const round = engine().plan.round ?? 0;
    engine().setColumns(2);
    const plan = engine().plan;
    expect(engine().columns).toBe(2);
    expect(plan.grid?.columns).toBe(2);
    expect(plan.changeSummary).toEqual({ added: [], docked: [], moved: [], grew: [], shrank: [] });
    expect(plan.round).toBe(round + 1);
    expect(plan.placements.every((p) => p.change === null)).toBe(true);
    expectValidGrid();
    engine().setColumns(1);
    expectValidGrid();
  });

  // A search that names no client anchors Inbox with nothing linked. Every
  // other card but Tasks leaves, so Tasks, the only card left to fill it,
  // would slide left into the hole Calendar leaves.
  const plainSearch = () => ({ type: "search" as const, panel: "inbox" as const, detail: { query: "packaging" } });
  const slideLeft = makeJudgments({ rel: { inbox: 2, tasks: 1 } });

  it("keeps the card under the pointer in its cell until the pointer leaves", async () => {
    answerWith(slideLeft);
    engine().track(plainSearch());
    engine().setPointer({ panel: "tasks", down: false });
    await vi.advanceTimersByTimeAsync(800);
    expect(ids()).not.toContain("calendar");
    expect(ids()).not.toContain("invoices");
    expect(cell("tasks")).toEqual({ col: 2, row: 0, w: 1, h: 2 }); // The hole beside it waits for it.
    engine().setPointer({ panel: null, down: false });
    await vi.advanceTimersByTimeAsync(3_000); // Past the minimum change interval.
    expect(cell("tasks")).toEqual({ col: 1, row: 0, w: 1, h: 2 });
    expect(cell("inbox")).toEqual({ col: 0, row: 0, w: 1, h: 2 });
    expectValidGrid();
  });

  it("fills a hole with another card while the pointer holds the card beside it", async () => {
    // Invoices stays this time: it is the next card after the hole that may move, so it takes it, and Tasks waits.
    answerWith(makeJudgments({ rel: { inbox: 2, tasks: 1, invoices: 1 } }));
    engine().track(plainSearch());
    engine().setPointer({ panel: "tasks", down: false });
    await vi.advanceTimersByTimeAsync(800);
    expect(cell("tasks")).toEqual({ col: 2, row: 0, w: 1, h: 2 });
    expect(cell("invoices")).toEqual({ col: 1, row: 0, w: 1, h: 2 });
    expectValidGrid();
  });

  it("lets a resting pointer's card move after the cap", async () => {
    answerWith(slideLeft);
    engine().track(plainSearch());
    engine().setPointer({ panel: "tasks", down: false });
    await vi.advanceTimersByTimeAsync(800);
    expect(cell("tasks")?.col).toBe(2);
    await vi.advanceTimersByTimeAsync(POINTER_MOVE_HOLD_MS);
    expect(cell("tasks")?.col).toBe(1);
  });

  it("keeps the card under the pointer on the canvas for a while when it would leave", async () => {
    // Collections judgments rate Projects 0, so it goes to the dock.
    engine().setPointer({ panel: "projects", down: false });
    engine().track(plainSearch());
    await vi.advanceTimersByTimeAsync(800);
    expect(ids()).toContain("projects");
    // After the cap, at the normal pace (the minimum change interval still applies).
    await vi.advanceTimersByTimeAsync(POINTER_LEAVE_HOLD_MS + DEFAULT_SETTINGS.minChangeIntervalMs);
    expect(ids()).not.toContain("projects");
  });

  it("anchors a command's hero on the client it names, and still puts it at the front", async () => {
    engine().track(invoiceOpen());
    await vi.advanceTimersByTimeAsync(800);
    mockedPost.mockImplementation(async (req) =>
      response(req.version, { ...collections, command: commandJ("invoices", 0.95, { client: choiceJ("Harbor Coffee Co.", 0.9) }) }),
    );
    await engine().runCommand("show me harbor's invoices");
    expect(engine().anchor).toMatchObject({ panel: "invoices", client: "Harbor Coffee Co.", label: "Harbor Coffee Co.", source: "command" });
    expect(engine().plan.placements[0]).toMatchObject({ id: "invoices", size: "hero", anchor: true });
    expect(cell("invoices")).toEqual({ col: 0, row: 0, w: 2, h: 4 });
    const tagged = engine().plan.placements.filter((p) => p.relation);
    expect(tagged.length).toBeGreaterThan(0);
    for (const p of tagged) expect(p.relation?.tag).toBe("Linked to Harbor Coffee Co.");
    expectValidGrid();
  });

  it("names the invoice a command mentions as the anchor's record", async () => {
    mockedPost.mockImplementation(async (req) => response(req.version, { ...collections, command: commandJ("invoices", 0.95) }));
    await engine().runCommand("open INV-1047");
    expect(engine().anchor).toMatchObject({ panel: "invoices", itemKind: "invoice", itemId: "INV-1047", client: "Kite & Co.", label: "INV-1047" });
  });

  it("counts a round when the layout or the anchor changes, and not for suggestions", async () => {
    engine().track(invoiceOpen());
    await vi.advanceTimersByTimeAsync(800);
    const r1 = engine().plan.round ?? 0;
    engine().track({ type: "scroll", panel: "invoices" });
    expect(engine().plan.round).toBe(r1);
    engine().track({ type: "item_open", panel: "tasks", detail: { itemKind: "task", itemId: "t-1", client: "Harbor Coffee Co.", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().plan.anchor?.panel).toBe("tasks");
    expect(engine().plan.round).toBeGreaterThan(r1);
  });

  it("keeps counting rounds up after a reset", async () => {
    engine().track(invoiceOpen());
    await vi.advanceTimersByTimeAsync(800);
    const r1 = engine().plan.round ?? 0;
    engine().reset();
    engine().track(invoiceOpen());
    await vi.advanceTimersByTimeAsync(1_500); // The 1000 ms gap after the last request still applies.
    expect(engine().plan.round).toBeGreaterThan(r1);
  });

  it("undo puts the previous cells back as they were", async () => {
    await engine().adaptNow(); // No anchor: Invoices becomes the hero at the front.
    const before = engine().plan;
    engine().track(clientOpen("c-harbor", "Harbor Coffee Co."));
    await vi.advanceTimersByTimeAsync(3_000);
    engine().undo(before);
    expect(engine().plan.grid?.cells).toEqual(before.grid?.cells);
    expectValidGrid();
  });

  it("keeps the CSS flow while Adaptive is off", async () => {
    engine().setSettings({ adaptive: false });
    engine().track(invoiceOpen());
    await vi.advanceTimersByTimeAsync(800);
    expect(engine().anchor).toBeNull();
    expect(engine().plan.grid).toBeUndefined();
    engine().setSettings({ adaptive: true });
    expect(engine().plan.grid).toBeDefined();
  });

  describe("link cues that stay until the user clears them", () => {
    const linkedIds = () => Object.keys(engine().links?.relations ?? {}).sort();
    /** Harbor's client row: Inbox, Invoices, and Tasks show records linked to it (see the test above). */
    async function harborLinks(waitMs = 800): Promise<number> {
      engine().track(clientOpen("c-harbor", "Harbor Coffee Co."));
      await vi.advanceTimersByTimeAsync(waitMs);
      expect(engine().links?.source).toMatchObject({ panel: "clients", client: "Harbor Coffee Co." });
      expect(linkedIds()).toEqual(["inbox", "invoices", "tasks"]);
      return engine().links!.source.at;
    }
    const lastEvent = () => engine().events.at(-1)!;

    it("keeps the links, and their panels, after the anchor is released and the canvas rebalances", async () => {
      const at = await harborLinks();
      await vi.advanceTimersByTimeAsync(ANCHOR_IDLE_RELEASE_MS);
      expect(engine().anchor).toBeNull();
      expect(engine().links?.source.at).toBe(at);
      // Jev now rates the linked panels and the source useless: without the links they would be docked.
      answerWith(makeJudgments({ rel: { analytics: 2, team: 2, projects: 2, calendar: 2, notes: 2 }, layout: choiceJ<LayoutMode>("focus", 0.9, { focus: 0.9 }) }));
      await engine().adaptNow();
      expect(engine().plan.anchor ?? null).toBeNull();
      expect(ids()).toEqual(expect.arrayContaining(["clients", "inbox", "invoices", "tasks"]));
      expect(engine().links?.source.at).toBe(at);
      expect(linkedIds()).toEqual(["inbox", "invoices", "tasks"]);
      expectValidGrid();
    });

    it("replaces the links when a new click links panels of its own", async () => {
      const at = await harborLinks();
      engine().track(invoiceOpen());
      await vi.advanceTimersByTimeAsync(3_000);
      expect(engine().links?.source).toMatchObject({ panel: "invoices", itemId: "INV-1042" });
      expect(engine().links!.source.at).toBeGreaterThan(at);
      expect(engine().links!.source.at).toBe(engine().anchor?.at);
    });

    it("keeps the links when a click, search, or filter links nothing", async () => {
      const at = await harborLinks();
      engine().track(plainSearch()); // Anchors Inbox with nothing linked.
      await vi.advanceTimersByTimeAsync(3_000);
      expect(engine().plan.anchor?.panel).toBe("inbox");
      expect(engine().plan.placements.some((p) => p.relation)).toBe(false);
      expect(engine().links?.source.at).toBe(at);
      expect(linkedIds()).toEqual(["inbox", "invoices", "tasks"]);
    });

    it("clears every link on clearLinks, logs it without asking Jev, and a later round for the same click does not bring them back", async () => {
      await harborLinks();
      const calls = mockedPost.mock.calls.length;
      engine().clearLinks("keyboard");
      expect(engine().links).toBeNull();
      expect(lastEvent()).toMatchObject({ type: "links_dismiss", text: "Cleared the links for Harbor Coffee Co., using the keyboard" });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(mockedPost.mock.calls.length).toBe(calls);
      // More work on the same record keeps the anchor; its next round still links, but the user cleared that.
      engine().track({ type: "filter", panel: "clients", detail: { filter: { query: "harbor" }, via: "pointer" } });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(engine().plan.placements.some((p) => p.relation)).toBe(true);
      expect(engine().links).toBeNull();
    });

    it("removes one link on removeLink and keeps the rest", async () => {
      await harborLinks();
      const calls = mockedPost.mock.calls.length;
      engine().removeLink("inbox");
      expect(linkedIds()).toEqual(["invoices", "tasks"]);
      expect(lastEvent()).toMatchObject({ type: "links_dismiss", text: "Removed the link to Inbox", detail: { linkedPanel: "inbox" } });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(mockedPost.mock.calls.length).toBe(calls);
      engine().removeLink("invoices");
      engine().removeLink("tasks");
      expect(engine().links).toBeNull();
    });

    it("clears every link when the user docks the source panel", async () => {
      await harborLinks();
      engine().dismiss("clients");
      expect(engine().links).toBeNull();
    });

    it("removes one link when the user docks a linked panel", async () => {
      await harborLinks();
      engine().dismiss("inbox");
      expect(linkedIds()).toEqual(["invoices", "tasks"]);
      expect(engine().links?.source.panel).toBe("clients");
    });

    it("clears the links on an undo of the round that made them, and keeps them on an undo of a later round", async () => {
      await harborLinks();
      engine().undo();
      expect(engine().links).toBeNull();

      const at = await harborLinks(UNDO_HOLD_MS + 1_000); // An undo holds automatic changes for a while.
      await vi.advanceTimersByTimeAsync(ANCHOR_IDLE_RELEASE_MS);
      answerWith(makeJudgments({ rel: { analytics: 2, team: 2, projects: 2 } }));
      await engine().adaptNow(); // A rebalance with no anchor.
      engine().undo();
      expect(engine().links?.source.at).toBe(at);
    });

    it("restores the older behavior with linkLines 'fade': the links go with the anchor and hold nothing", async () => {
      engine().setSettings({ linkLines: "fade" });
      await harborLinks();
      await vi.advanceTimersByTimeAsync(ANCHOR_IDLE_RELEASE_MS);
      expect(engine().anchor).toBeNull();
      expect(engine().links).toBeNull();
      answerWith(makeJudgments({ rel: { analytics: 2, team: 2, projects: 2, calendar: 2, notes: 2 }, layout: choiceJ<LayoutMode>("focus", 0.9, { focus: 0.9 }) }));
      await engine().adaptNow();
      expect(ids()).not.toContain("inbox");
      // A new click with nothing linked takes the old links away at once, as before.
      engine().reset();
      answerWith(collections);
      await harborLinks(1_500); // The 1000 ms gap after the last request still applies.
      engine().track(plainSearch());
      expect(engine().links).toBeNull();
    });

    it("clears the links when Adaptive switches, since the fixed layout does not keep their panels", async () => {
      await harborLinks();
      engine().setSettings({ adaptive: false });
      expect(engine().links).toBeNull();
    });
  });
});

describe("make bigger (Keep in place: the growth rule)", () => {
  // These are the rules from before "Move pinned and bigger panels to the
  // front"; the setting's "Keep in place" choice keeps them exactly.
  beforeEach(() => {
    engine().setSettings({ focusAids: { ...engine().settings.focusAids, moveToFront: false } });
  });
  afterEach(() => {
    engine().setPointer({ panel: null, down: false });
    engine().setCanvasHold("pointer", false);
    engine().setColumns(4);
  });

  const cell = (id: PanelId) => engine().plan.grid?.cells[id];
  const placement = (id: PanelId) => engine().plan.placements.find((p) => p.id === id);
  /** Jev rates Tasks and Inbox useless in every later round. */
  const tasksUseless = makeJudgments({
    rel: { invoices: 2, clients: 1.4, calendar: 1, projects: 0.8, tasks: 0, inbox: 0 },
    goal: choiceJ<GoalId>("collect_payments", 0.9, { collect_payments: 0.9 }),
    layout: choiceJ<LayoutMode>("focus", 0.9, { focus: 0.9 }),
  });

  function expectValidGrid(): void {
    const g = engine().plan.grid!;
    const cells = engine().plan.placements.map((p) => g.cells[p.id]!);
    for (const c of cells) expect(cellFits(c, g.columns)).toBe(true);
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) expect(cellsOverlap(cells[i], cells[j])).toBe(false);
  }

  it("applies at once as a manual edit, even right after a layout change, and never asks Jev by itself", async () => {
    await engine().adaptNow(); // A layout change just happened: an automatic one would wait 2.5 s now.
    const calls = mockedPost.mock.calls.length;
    const before = cell("clients")!;
    engine().maximize("clients");
    expect(placement("clients")).toMatchObject({ size: "hero", bigger: true, reason: "Made bigger by you", change: "promoted" });
    expect(cell("clients")).toMatchObject({ row: before.row, w: 2, h: 4 });
    expect(engine().bigger).toEqual(["clients"]);
    // It is what the user just worked on: the anchor for this change.
    expect(engine().anchor).toMatchObject({ panel: "clients", source: "work" });
    expect(engine().plan.anchor?.panel).toBe("clients");
    expect(engine().plan.changeSummary?.grew).toEqual(["clients"]);
    expect(engine().plan.decisions[0]).toMatchObject({ kind: "promote", panel: "clients", text: "Made Clients bigger" });
    expect(engine().events.at(-1)).toMatchObject({ type: "panel_maximize", panel: "clients", text: "Made Clients bigger" });
    expectValidGrid();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockedPost.mock.calls.length).toBe(calls);
    expect(placement("clients")?.size).toBe("hero");
  });

  it("stays at hero size across later Jev rounds that rate it low, and the next round reads it", async () => {
    engine().maximize("tasks");
    expect(placement("tasks")?.size).toBe("hero");
    answerWith(tasksUseless);
    engine().track({ type: "item_open", panel: "invoices", detail: { itemKind: "invoice", itemId: "INV-1042", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockedPost.mock.calls[0][0].snapshot.recent_activity).toContain("Made Tasks bigger");
    expect(engine().plan.basedOnVersion).toBeGreaterThan(0);
    expect(placement("tasks")).toMatchObject({ size: "hero", bigger: true, reason: "Made bigger by you" });
    // Rounds later, with other work and after the anchor lets go.
    await vi.advanceTimersByTimeAsync(25_000);
    engine().track({ type: "item_open", panel: "clients", detail: { itemKind: "client", itemId: "c-atlas", client: "Atlas Robotics", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    await engine().adaptNow();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(placement("tasks")).toMatchObject({ size: "hero", bigger: true });
    expectValidGrid();
  });

  it("making it smaller hands its size back to the policy at once", async () => {
    engine().maximize("tasks");
    const big = cell("tasks")!;
    await vi.advanceTimersByTimeAsync(3_000);
    engine().restore("tasks");
    expect(placement("tasks")).toMatchObject({ size: "standard" });
    expect(placement("tasks")?.bigger).toBeUndefined();
    expect(cell("tasks")).toMatchObject({ col: big.col, row: big.row, w: 1, h: 2 });
    expect(engine().bigger).toEqual([]);
    expect(engine().events.at(-1)).toMatchObject({ type: "panel_restore", text: "Made Tasks smaller" });
    expect(engine().plan.decisions[0]).toMatchObject({ kind: "demote", text: "Made Tasks smaller" });
    expectValidGrid();
    // From now on Jev and the policy decide: rated useless in Focus, it is no longer the hero.
    answerWith(tasksUseless);
    await vi.advanceTimersByTimeAsync(25_000);
    await engine().adaptNow();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(placement("tasks")?.size ?? "docked").not.toBe("hero");
  });

  it("docking it clears the flag", () => {
    engine().maximize("tasks");
    engine().dismiss("tasks");
    expect(engine().bigger).toEqual([]);
    expect(placement("tasks")).toBeUndefined();
    engine().open("tasks");
    expect(placement("tasks")).toMatchObject({ size: "standard" });
    expect(placement("tasks")?.bigger).toBeUndefined();
  });

  it("keeps several at once, and works with a pin", async () => {
    engine().maximize("tasks");
    engine().maximize("inbox");
    engine().pin("inbox");
    expect(engine().bigger).toEqual(["tasks", "inbox"]);
    answerWith(tasksUseless);
    await engine().adaptNow();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().plan.placements[0]).toMatchObject({ id: "inbox", size: "hero", pinned: true, bigger: true });
    expect(placement("tasks")).toMatchObject({ size: "hero", bigger: true });
    expectValidGrid();
    engine().unpin("inbox");
    expect(placement("inbox")).toMatchObject({ size: "hero", bigger: true });
  });

  it("moves the cards in its way even with the pointer on the canvas", () => {
    engine().setCanvasHold("pointer", true);
    engine().setPointer({ panel: "invoices", down: false });
    engine().maximize("invoices"); // Last column: grows one column left.
    expect(cell("invoices")).toEqual({ col: 2, row: 0, w: 2, h: 4 });
    expect(cell("tasks")?.row).toBeGreaterThanOrEqual(4);
    expectValidGrid();
  });

  it("gets taller on one column, and grows left in a 2-column grid's right column", () => {
    engine().setColumns(1);
    const before = cell("calendar")!;
    engine().maximize("calendar");
    expect(cell("calendar")).toEqual({ ...before, h: 5 });
    expectValidGrid();
    engine().restore("calendar");
    engine().setColumns(2);
    engine().maximize("calendar");
    expect(cell("calendar")).toEqual({ col: 0, row: 0, w: 2, h: 4 });
    expectValidGrid();
  });

  it("with Adaptive off it still keeps its top edge, and going back leaves no old cells behind", () => {
    engine().setSettings({ adaptive: false });
    engine().setCanvasHold("pointer", true);
    engine().setPointer({ panel: "invoices", down: false });
    engine().maximize("invoices");
    expect(cell("invoices")).toEqual({ col: 2, row: 0, w: 2, h: 4 });
    expectValidGrid();
    engine().restore("invoices");
    expect(placement("invoices")?.size).toBe("standard");
    // Nothing is bigger now: the fixed layout is the CSS flow again, with no stale hero cell.
    expect(engine().plan.grid).toBeUndefined();
    engine().setCanvasHold("pointer", false);
    expect(engine().plan.grid).toBeUndefined();
    expect(engine().plan.placements.every((p) => p.size === "standard")).toBe(true);
  });

  it("undo takes the flag back with the layout, and reset clears it", () => {
    engine().maximize("tasks");
    engine().undo();
    expect(placement("tasks")?.size).toBe("standard");
    expect(engine().bigger).toEqual([]);
    engine().maximize("projects");
    engine().reset();
    expect(engine().bigger).toEqual([]);
    expect(placement("projects")?.size).toBe("standard");
  });
});

describe("move to front (a pin or Make bigger goes to the first cell)", () => {
  afterEach(() => {
    engine().setPointer({ panel: null, down: false });
    engine().setCanvasHold("pointer", false);
    engine().setColumns(4);
  });

  const cell = (id: PanelId) => engine().plan.grid?.cells[id];
  const placement = (id: PanelId) => engine().plan.placements.find((p) => p.id === id);
  const FIRST = { col: 0, row: 0 };
  /** The hero's span per column count (CELL_SPANS). */
  const HERO = { 4: { w: 2, h: 4 }, 2: { w: 2, h: 4 }, 1: { w: 1, h: 5 } } as const;
  /** Where a click on a card's pin or "Make bigger" button leaves the pointer: on that card, on the canvas. */
  const pointAt = (id: PanelId) => {
    engine().setCanvasHold("pointer", true);
    engine().setPointer({ panel: id, down: false });
  };
  const pointerOff = () => {
    engine().setPointer({ panel: null, down: false });
    engine().setCanvasHold("pointer", false);
  };
  /** The front group as the store keeps it: every pinned and bigger panel, newest first. */
  const group = () => frontGroup(engine().front, engine().pinned, engine().bigger);

  function expectValidGrid(): void {
    const plan = engine().plan;
    const g = plan.grid!;
    expect(g.columns).toBe(engine().columns);
    const cells = plan.placements.map((p) => g.cells[p.id]!);
    for (const c of cells) expect(c && cellFits(c, g.columns)).toBe(true);
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) expect(cellsOverlap(cells[i], cells[j])).toBe(false);
  }

  it("a pin sends the panel to the first cell at its size at once, even with the pointer on it, at 1, 2, and 4 columns", () => {
    for (const columns of [4, 2, 1] as const) {
      engine().reset();
      engine().setColumns(columns);
      const count = engine().plan.placements.length;
      const size = placement("invoices")!.size;
      pointAt("invoices");
      engine().pin("invoices");
      const at = cell("invoices")!;
      expect(ids()[0]).toBe("invoices");
      expect(at).toMatchObject(FIRST);
      expect(placement("invoices")).toMatchObject({ size, pinned: true });
      // The canvas is told, with the round that moved it, so it can follow the panel.
      expect(engine().toFront).toMatchObject({ panel: "invoices", round: engine().plan.round });
      // Nothing was docked to make room.
      expect(engine().plan.placements).toHaveLength(count);
      expectValidGrid();
      pointerOff();
      engine().unpin("invoices");
    }
  });

  it("a pin keeps its size in a Focus round too, and the policy's hero comes right after it", async () => {
    await engine().adaptNow(); // Focus, no anchor: Invoices is the hero at the front.
    const small = engine().plan.placements.find((p) => p.size === "compact")!.id;
    engine().pin(small);
    expect(ids()[0]).toBe(small);
    expect(placement(small)?.size).toBe("compact");
    expect(cell(small)).toEqual({ col: 0, row: 0, w: 1, h: 1 });
    // The catch-up after the minimum change interval keeps it so.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ids()[0]).toBe(small);
    expect(placement(small)?.size).toBe("compact");
    expect(engine().plan.placements[1]).toMatchObject({ id: "invoices", size: "hero" });
    expectValidGrid();
  });

  it("Make bigger sends the panel to the first cell as the hero, at 1, 2, and 4 columns", () => {
    for (const columns of [4, 2, 1] as const) {
      engine().reset();
      engine().setColumns(columns);
      const count = engine().plan.placements.length;
      expect(cell("tasks") ?? { col: 2, row: 0 }).not.toMatchObject(FIRST);
      pointAt("tasks");
      engine().maximize("tasks");
      expect(ids()[0]).toBe("tasks");
      expect(cell("tasks")).toEqual({ ...FIRST, ...HERO[columns] });
      expect(placement("tasks")).toMatchObject({ size: "hero", bigger: true, reason: "Made bigger by you" });
      // It is what the user just worked on: the anchor for the change, so the next rounds keep it there.
      expect(engine().anchor).toMatchObject({ panel: "tasks", source: "work" });
      expect(engine().plan.anchor?.panel).toBe("tasks");
      expect(engine().toFront?.panel).toBe("tasks");
      expect(engine().plan.placements).toHaveLength(count);
      expectValidGrid();
      pointerOff();
    }
  });

  it("puts the newest pin or Make bigger first and the earlier ones after it, newest first", () => {
    engine().pin("invoices");
    expect(cell("invoices")).toMatchObject(FIRST);
    engine().maximize("calendar");
    expect(cell("calendar")).toEqual({ ...FIRST, w: 2, h: 4 });
    engine().pin("clients");
    expect(ids().slice(0, 3)).toEqual(["clients", "calendar", "invoices"]);
    expect(engine().front.slice(0, 3)).toEqual(["clients", "calendar", "invoices"]);
    expect(cell("clients")).toEqual({ col: 0, row: 0, w: 1, h: 2 });
    expect(cell("calendar")).toEqual({ col: 1, row: 0, w: 2, h: 4 });
    expect(cell("invoices")).toEqual({ col: 3, row: 0, w: 1, h: 2 });
    expectValidGrid();
  });

  it("keeps the front group first and in its cells over later Jev rounds that rate it low", async () => {
    await engine().adaptNow();
    engine().pin("invoices");
    engine().maximize("calendar");
    engine().pin("clients");
    const front: PanelId[] = ["clients", "calendar", "invoices"];
    const cells = front.map((id) => cell(id));
    // Invoices was the Focus hero when it was pinned, so it stays the hero; Calendar is bigger.
    expect(front.map((id) => placement(id)?.size)).toEqual(["standard", "hero", "hero"]);
    const expectFront = () => {
      expect(ids().slice(0, 3)).toEqual(front);
      expect(front.map((id) => cell(id))).toEqual(cells);
      expect(front.map((id) => placement(id)?.size)).toEqual(["standard", "hero", "hero"]);
      expectValidGrid();
    };
    expectFront();
    // Jev now rates all three useless, in Focus and then in Compare.
    const elsewhere = (mode: LayoutMode) =>
      makeJudgments({
        rel: { inbox: 2, tasks: 1.8, projects: 1.6, team: 1.4, clients: 0, calendar: 0, invoices: 0 },
        goal: choiceJ<GoalId>("triage_inbox", 0.9, { triage_inbox: 0.9 }),
        layout: choiceJ<LayoutMode>(mode, 0.9, { [mode]: 0.9 }),
      });
    answerWith(elsewhere("focus"));
    // Work elsewhere: an anchored round, then the release and a round without an anchor, then a Compare round.
    engine().track({ type: "item_open", panel: "inbox", detail: { itemKind: "message", itemId: "m-4", via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().plan.anchor?.panel).toBe("inbox");
    expectFront();
    await vi.advanceTimersByTimeAsync(ANCHOR_IDLE_RELEASE_MS);
    await engine().adaptNow();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().anchor).toBeNull();
    expectFront();
    answerWith(elsewhere("compare"));
    await engine().adaptNow();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().plan.mode).toBe("compare");
    expectFront();
  });

  it("unpin and Make smaller leave the panel where it is, and the catch-up still waits for the pointer", async () => {
    await engine().adaptNow(); // Focus: Invoices is the hero at the front, Clients beside it.
    expect(cell("clients")).not.toMatchObject(FIRST);
    pointAt("clients");
    engine().pin("clients");
    expect(cell("clients")).toMatchObject(FIRST);
    const pinned = engine().plan.grid!.cells;
    // Past the minimum change interval: the policy's catch-up still waits while the pointer is on the canvas.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(engine().plan.grid!.cells).toEqual(pinned);
    engine().unpin("clients");
    expect(placement("clients")?.pinned).toBe(false);
    expect(engine().plan.grid!.cells).toEqual(pinned);

    pointAt("tasks");
    engine().maximize("tasks");
    expect(cell("tasks")).toEqual({ ...FIRST, ...HERO[4] });
    engine().restore("tasks");
    expect(cell("tasks")).toMatchObject(FIRST);
    expect(placement("tasks")?.size).not.toBe("hero");
    expect(placement("tasks")?.bigger).toBeUndefined();
    expectValidGrid();
    // From here the policy places them again: neither is in the front group.
    expect(group()).toEqual([]);
  });

  it("Keep in place brings back the older behavior, and the switch is saved and logged like the other focus aids", () => {
    engine().setFocusAid("moveToFront", false, "pointer");
    expect(engine().settings.focusAids.moveToFront).toBe(false);
    expect(engine().events.at(-1)).toMatchObject({
      type: "setting_change",
      text: 'Turned off "Move pinned and bigger panels to the front"',
      detail: { setting: "moveToFront", enabled: false },
    });
    const before = ids();
    // A pin under the pointer stays put, and Make bigger keeps its top edge (one column left in the last column).
    pointAt("invoices");
    engine().pin("invoices");
    expect(ids()).toEqual(before);
    expect(cell("invoices")).toEqual({ col: 3, row: 0, w: 1, h: 2 });
    engine().maximize("invoices");
    expect(cell("invoices")).toEqual({ col: 2, row: 0, w: 2, h: 4 });
    expect(engine().toFront).toBeNull();
    expectValidGrid();
    // Switched back on, the next pin goes to the front again.
    pointerOff();
    engine().setFocusAid("moveToFront", true);
    engine().pin("projects");
    expect(ids()[0]).toBe("projects");
    expect(cell("projects")).toMatchObject(FIRST);
    expectValidGrid();
  });

  it("never overlaps or leaves the grid, and each pin or Make bigger lands first, over random sessions at 1, 2, and 4 columns", async () => {
    for (const columns of [1, 2, 4] as const) {
      for (let seed = 1; seed <= 12; seed++) {
        const r = rng(seed * 104_729 + columns);
        const pick = <T,>(list: readonly T[]): T => list[Math.floor(r() * list.length)];
        pointerOff();
        for (const p of engine().pinned) engine().unpin(p);
        engine().reset();
        engine().setColumns(columns);
        for (let step = 0; step < 16; step++) {
          const on = ids();
          const s = engine();
          if (r() < 0.5 && on.length > 0) pointAt(pick(on));
          else pointerOff();
          const roll = r();
          const unpinned = on.filter((id) => !s.pinned.includes(id));
          const small = on.filter((id) => !s.bigger.includes(id));
          if (roll < 0.25 && unpinned.length > 0) {
            const id = pick(unpinned);
            const size = placement(id)!.size;
            engine().pin(id);
            expect(ids()[0]).toBe(id);
            expect(cell(id)).toMatchObject(FIRST);
            expect(placement(id)?.size).toBe(size);
            expect(ids().slice(0, group().length)).toEqual(group());
          } else if (roll < 0.45 && small.length > 0) {
            const id = pick(small);
            engine().maximize(id);
            expect(ids()[0]).toBe(id);
            expect(cell(id)).toEqual({ ...FIRST, ...HERO[columns] });
            expect(ids().slice(0, group().length)).toEqual(group());
          } else if (roll < 0.55 && s.pinned.length > 0) {
            const id = pick(s.pinned);
            const was = engine().plan.grid?.cells;
            engine().unpin(id);
            if (was) expect(engine().plan.grid?.cells).toEqual(was);
          } else if (roll < 0.65 && s.bigger.length > 0) {
            const id = pick(s.bigger);
            const was = cell(id)!;
            engine().restore(id);
            expect(cell(id)).toMatchObject({ col: was.col, row: was.row });
          } else if (roll < 0.72 && on.length > 2) {
            engine().dismiss(pick(on));
          } else if (roll < 0.8 && engine().plan.docked.length > 0) {
            engine().open(pick(engine().plan.docked));
          } else {
            // A Jev round once the pointer has left: the front group leads, in its order.
            pointerOff();
            await engine().adaptNow();
            await vi.advanceTimersByTimeAsync(3_000);
            expect(ids().slice(0, group().length)).toEqual(group());
          }
          if (engine().plan.grid) expectValidGrid();
        }
      }
    }
  });
});

describe("storage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("works when localStorage throws", async () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    });
    vi.resetModules();
    const mod = await import("./store.ts");
    const s = mod.useEngine.getState();
    expect(s.settings).toEqual(DEFAULT_SETTINGS);
    s.pin("team");
    expect(mod.useEngine.getState().pinned).toEqual(["team"]);
    mod.useEngine.getState().reset();
  });

  it("restores settings and pins from storage", async () => {
    const data = new Map<string, string>([["floouid:v1", JSON.stringify({ settings: { adaptive: false, weights: { usage: 0.9 } }, pinned: ["notes", "bogus"] })]]);
    vi.stubGlobal("window", {
      localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) },
    });
    vi.resetModules();
    const mod = await import("./store.ts");
    const s = mod.useEngine.getState();
    expect(s.settings.adaptive).toBe(false);
    expect(s.settings.weights).toEqual({ relevance: 0.5, usage: 0.9, goal: 0.25 });
    expect(s.pinned).toEqual(["notes"]);
    expect(s.plan.placements[0].id).toBe("notes");
    expect(s.settings.linkLines).toBe("stay");
    s.setSettings({ linkLines: "fade" });
    expect(JSON.parse(data.get("floouid:v1") ?? "{}").settings.linkLines).toBe("fade");
    s.pin("team");
    expect(JSON.parse(data.get("floouid:v1") ?? "{}").pinned).toEqual(["notes", "team"]);
    mod.useEngine.getState().reset();
  });

  it("persists the panels the user made bigger with the pins, restores them, and reset clears them", async () => {
    const data = new Map<string, string>([["floouid:v1", JSON.stringify({ settings: {}, pinned: ["notes"], bigger: ["team", "bogus", "team"] })]]);
    vi.stubGlobal("window", {
      localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) },
    });
    vi.resetModules();
    const mod = await import("./store.ts");
    const s = mod.useEngine.getState();
    expect(s.bigger).toEqual(["team"]);
    expect(s.plan.placements.find((p) => p.id === "team")).toMatchObject({ size: "hero", bigger: true });
    s.maximize("inbox");
    expect(JSON.parse(data.get("floouid:v1") ?? "{}")).toMatchObject({ pinned: ["notes"], bigger: ["team", "inbox"] });
    mod.useEngine.getState().restore("team");
    expect(JSON.parse(data.get("floouid:v1") ?? "{}").bigger).toEqual(["inbox"]);
    mod.useEngine.getState().reset();
    expect(JSON.parse(data.get("floouid:v1") ?? "{}")).toMatchObject({ pinned: ["notes"], bigger: [] });
  });

  it("persists the front order with the pins, and the first plan after a reload leads with it", async () => {
    const data = new Map<string, string>([
      ["floouid:v1", JSON.stringify({ settings: {}, pinned: ["notes", "team"], bigger: ["inbox"], front: ["team", "inbox", "bogus", "notes"] })],
    ]);
    vi.stubGlobal("window", {
      localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) },
    });
    vi.resetModules();
    const mod = await import("./store.ts");
    const s = mod.useEngine.getState();
    expect(s.front).toEqual(["team", "inbox", "notes"]);
    expect(s.plan.placements.slice(0, 3).map((p) => p.id)).toEqual(["team", "inbox", "notes"]);
    s.pin("tasks");
    expect(JSON.parse(data.get("floouid:v1") ?? "{}").front).toEqual(["tasks", "team", "inbox", "notes"]);
    mod.useEngine.getState().reset();
    // A save from before the setting has no front order: its pins lead in pin order, as before.
    data.set("floouid:v1", JSON.stringify({ settings: {}, pinned: ["notes", "team"] }));
    vi.resetModules();
    const older = (await import("./store.ts")).useEngine.getState();
    expect(older.front).toEqual([]);
    expect(older.plan.placements.slice(0, 2).map((p) => p.id)).toEqual(["notes", "team"]);
    older.reset();
  });

  it("restores the link lines setting, and falls back to 'stay' for anything else", async () => {
    for (const [stored, expected] of [
      ["fade", "fade"],
      ["stay", "stay"],
      ["forever", "stay"],
    ] as const) {
      const data = new Map<string, string>([["floouid:v1", JSON.stringify({ settings: { linkLines: stored } })]]);
      vi.stubGlobal("window", { localStorage: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) } });
      vi.resetModules();
      const mod = await import("./store.ts");
      expect(mod.useEngine.getState().settings.linkLines).toBe(expected);
    }
  });
});
