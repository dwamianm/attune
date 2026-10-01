/**
 * "Arrange linked panels by next step" in the store (docs/anchored-relayout.md,
 * "Next step"): the user's case end to end, the order and the gate, the code
 * fallback, the resend action, the follow-up, and the switch off.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionId, GoalId, LayoutMode, PanelId } from "../../shared/catalog.ts";
import type { AdaptRequest, AdaptResponse, Judgments } from "../../shared/types.ts";
import { postAdapt } from "./api.ts";
import { cellFits, cellsOverlap } from "@attune/core";
import { actionApplies, buildRecordCandidates, handledRecords } from "./nextUp.ts";
import { DEFAULT_SETTINGS, useEngine } from "./store.ts";
import { choiceJ, makeJudgments } from "./test-helpers.ts";

vi.mock("./api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.ts")>();
  return { ...actual, postAdapt: vi.fn(), getHealth: vi.fn(async () => ({ ok: true, jev: true })) };
});

const mockedPost = vi.mocked(postAdapt);
const engine = () => useEngine.getState();
const cell = (id: PanelId) => engine().plan.grid?.cells[id];
const topLeft = (id: PanelId) => {
  const c = cell(id);
  return c ? { col: c.col, row: c.row } : undefined;
};

/** Jev reads the canvas as Priya's work: Inbox first, then Invoices, Tasks, Clients (they get the three link tags). */
function judgments(extra: Partial<Judgments> = {}): Judgments {
  return {
    ...makeJudgments({
      rel: { inbox: 2, invoices: 1.6, tasks: 1.4, clients: 1.2, calendar: 0.8, projects: 0.8 },
      goal: choiceJ<GoalId>("collect_payments", 0.8, { collect_payments: 0.8, triage_inbox: 0.2 }),
      layout: choiceJ<LayoutMode>("overview", 0.9, { overview: 0.9 }),
    }),
    ...extra,
  };
}

const sure: Partial<Judgments> = {
  linkNext: choiceJ<string>("invoice:INV-1042", 0.95, { "invoice:INV-1042": 0.95, "task:t-1": 0.03, "client:c-harbor": 0.01, none: 0.01 }),
  linkAction: choiceJ<ActionId>("resend_invoice", 0.98, { resend_invoice: 0.98, none: 0.02 }),
};

function answerWith(j: Judgments, source: AdaptResponse["source"] = "jev") {
  mockedPost.mockImplementation(async (req: AdaptRequest) => ({
    version: req.version,
    source,
    judgments: j,
    meta: { model: source === "jev" ? "jev-1.13.0" : "heuristic", latencyMs: 200, questionCount: 19 },
    debug: { state: {}, questions: {} },
  }));
}

const openPriya = () =>
  engine().track({
    type: "item_open",
    panel: "inbox",
    detail: { itemKind: "message", itemId: "m-1", client: "Harbor Coffee Co.", label: '"Re: Invoice INV-1042" from Priya Nair at Harbor Coffee Co.', via: "pointer" },
  });

function expectValidGrid(): void {
  const plan = engine().plan;
  const g = plan.grid!;
  const cells = plan.placements.map((p) => g.cells[p.id]!);
  for (const c of cells) expect(cellFits(c, g.columns)).toBe(true);
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) expect(cellsOverlap(cells[i], cells[j])).toBe(false);
}

let clock = 5_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  clock += 10_000_000;
  vi.setSystemTime(clock);
  mockedPost.mockReset();
  answerWith(judgments(sure));
  engine().reset();
  // Habits outlive Reset (focus aid 3), so each test starts with none.
  engine().forgetHabits();
  engine().setSettings({ ...structuredClone(DEFAULT_SETTINGS) });
  engine().setColumns(4);
  engine().reset();
});

afterEach(() => {
  engine().setPointer({ panel: null, down: false });
  engine().reset();
  vi.useRealTimers();
});

describe("the user's case: Priya's message asks to resend INV-1042", () => {
  it("asks the link questions once, with the clicked record and its linked records", async () => {
    openPriya();
    await vi.advanceTimersByTimeAsync(800);
    const req = mockedPost.mock.calls[0][0];
    expect(req.link?.clicked).toMatchObject({ id: "message:m-1", kind: "message", fields: { from: "Priya Nair", subject: "Re: Invoice INV-1042" } });
    expect(req.link?.records.map((r) => r.id)).toEqual(expect.arrayContaining(["invoice:INV-1042", "task:t-1", "client:c-harbor"]));
    // More work in the same panel on the same click keeps the anchor: its answer is in, so no second link question.
    engine().track({ type: "filter", panel: "inbox", detail: { filter: { client: "all" }, via: "pointer" } });
    await vi.advanceTimersByTimeAsync(3_000);
    expect(mockedPost.mock.calls.length).toBeGreaterThan(1);
    expect(mockedPost.mock.calls.at(-1)?.[0].link).toBeUndefined();
  });

  it("gathers Invoices, Tasks, and Clients next to Inbox in next-step order, and Inbox does not move", async () => {
    // The default overview shows the dense flow: Inbox in the top-left cell.
    openPriya();
    await vi.advanceTimersByTimeAsync(800);
    expect(cell("inbox")).toEqual({ col: 0, row: 0, w: 1, h: 2 });
    expect(topLeft("invoices")).toEqual({ col: 1, row: 0 }); // The next step, right beside it.
    expect(topLeft("tasks")).toEqual({ col: 0, row: 2 }); // Directly below.
    expect(topLeft("clients")).toEqual({ col: 1, row: 2 });
    expectValidGrid();
    expect(engine().links?.next).toEqual({ panel: "invoices", record: "invoice:INV-1042", text: "Next: resend INV-1042", probability: 0.95 });
    // The other tags stay as they are.
    expect(engine().links?.relations.tasks?.tag).toBe("Linked to Priya Nair");
  });

  it("offers the step in Up next, opens it with the normal view state, and offers the action only then", async () => {
    openPriya();
    await vi.advanceTimersByTimeAsync(800);
    expect(engine().upNext).toMatchObject({ source: "link", candidate: { id: "invoice:INV-1042" }, step: "to resend it", why: "Jev 95%" });
    // Nothing yet: the action waits until INV-1042 is open.
    expect(engine().plan.suggestions.some((s) => s.actionId === "resend_invoice")).toBe(false);
    engine().openUpNext("invoice:INV-1042", "keyboard");
    expect(engine().view.invoices.selectedId).toBe("INV-1042");
    const primary = engine().plan.suggestions[0];
    expect(primary).toMatchObject({ actionId: "resend_invoice", label: "Resend INV-1042 to Harbor Coffee Co.", prominence: "primary", nextStep: true, args: { invoiceId: "INV-1042" } });
    await vi.advanceTimersByTimeAsync(3_000);
    // A later round keeps offering it, and nothing was performed for the user.
    expect(engine().plan.suggestions[0]).toMatchObject({ actionId: "resend_invoice", nextStep: true });
    expect(engine().data.invoices.find((i) => i.id === "INV-1042")?.resentAt).toBeUndefined();
    expect(engine().events.some((e) => e.type === "action")).toBe(false);
  });

  it("resends on '.', then offers to check off the matching to-do item, and checks it off only when pressed", async () => {
    openPriya();
    await vi.advanceTimersByTimeAsync(800);
    engine().openUpNext("invoice:INV-1042", "keyboard");
    engine().acceptSuggestion(engine().plan.suggestions[0]);
    expect(engine().data.invoices.find((i) => i.id === "INV-1042")?.resentAt).toBeDefined();
    expect(engine().notice?.text).toBe("Invoice INV-1042 resent to Harbor Coffee Co.");
    expect(handledRecords(engine().events).has("invoice:INV-1042")).toBe(true);
    // The step is done: no tag, no Up next pick for it.
    expect(engine().links?.next).toBeUndefined();
    const follow = engine().plan.suggestions[0];
    expect(follow).toMatchObject({ label: "Check off: Resend INV-1042 to Harbor accounts team", prominence: "primary", task: { id: "t-1" } });
    expect(engine().data.tasks.find((t) => t.id === "t-1")?.done).toBe(false);
    engine().acceptSuggestion(follow);
    expect(engine().data.tasks.find((t) => t.id === "t-1")?.done).toBe(true);
    expect(engine().events.at(-1)).toMatchObject({ type: "action", detail: { itemKind: "task", itemId: "t-1", via: "suggestion" } });
    expect(engine().plan.suggestions.some((s) => s.task)).toBe(false);
  });

  it("asks no link question for the record the step led to, not even after the step is done", async () => {
    openPriya();
    await vi.advanceTimersByTimeAsync(800);
    engine().openUpNext("invoice:INV-1042", "keyboard");
    engine().acceptSuggestion(engine().plan.suggestions[0]);
    await vi.advanceTimersByTimeAsync(3_000);
    const after = mockedPost.mock.calls.slice(1).map((c) => c[0]);
    expect(after.length).toBeGreaterThan(0);
    for (const req of after) expect(req.link).toBeUndefined();
    // So Up next does not point back to the message the user came from.
    expect(engine().upNext?.source).not.toBe("link");
  });

  it("the Resend button by hand also finishes the step and offers the follow-up", async () => {
    openPriya();
    await vi.advanceTimersByTimeAsync(800);
    engine().openUpNext("invoice:INV-1042", "pointer");
    engine().perform("resend_invoice", { client: "Harbor Coffee Co.", invoiceId: "INV-1042" });
    expect(engine().plan.suggestions[0]).toMatchObject({ task: { id: "t-1" } });
    // Dismissing the follow-up ends it.
    engine().dismissSuggestion(engine().plan.suggestions[0]);
    expect(engine().plan.suggestions.some((s) => s.task)).toBe(false);
  });
});

describe("order and the Next gate", () => {
  it("orders the linked panels by link-next", async () => {
    answerWith(judgments({ ...sure, linkNext: choiceJ<string>("task:t-1", 0.9, { "task:t-1": 0.9, "invoice:INV-1042": 0.08, none: 0.02 }) }));
    openPriya();
    await vi.advanceTimersByTimeAsync(800);
    expect(topLeft("tasks")).toEqual({ col: 1, row: 0 });
    expect(topLeft("invoices")).toEqual({ col: 0, row: 2 });
    // Resending does not fit a to-do item, so the step only opens it.
    expect(engine().links?.next).toMatchObject({ panel: "tasks", text: "Next: open Resend INV-1042 to Harbor accounts team" });
  });

  it("when Jev is not sure: gathers in code's order (the same record id first, then the same client) with no Next emphasis", async () => {
    answerWith(judgments({ linkNext: choiceJ<string>("client:c-harbor", 0.2, { "client:c-harbor": 0.36, "task:t-1": 0.33, none: 0.31 }), linkAction: sure.linkAction! }));
    openPriya();
    await vi.advanceTimersByTimeAsync(800);
    expect(topLeft("invoices")).toEqual({ col: 1, row: 0 });
    expect(topLeft("tasks")).toEqual({ col: 0, row: 2 });
    expect(topLeft("clients")).toEqual({ col: 1, row: 2 });
    expect(engine().links).not.toBeNull();
    expect(engine().links?.next).toBeUndefined();
    expect(engine().upNext?.source).not.toBe("link");
  });

  it("offline, the heuristic's link answer never passes the gate", async () => {
    answerWith(judgments({ linkNext: choiceJ<string>("invoice:INV-1042", 0.28, { "invoice:INV-1042": 0.4, none: 0.4, "task:t-1": 0.05 }), linkAction: sure.linkAction! }), "heuristic");
    openPriya();
    await vi.advanceTimersByTimeAsync(800);
    expect(topLeft("invoices")).toEqual({ col: 1, row: 0 });
    expect(engine().links?.next).toBeUndefined();
  });
});

describe("the switch", () => {
  it("off: the links draw, nothing gathers, and no link question is asked", async () => {
    expect(engine().settings.focusAids.arrangeLinks).toBe(true);
    engine().setFocusAid("arrangeLinks", false);
    expect(engine().settings.focusAids.arrangeLinks).toBe(false);
    openPriya();
    await vi.advanceTimersByTimeAsync(800);
    expect(mockedPost.mock.calls[0][0].link).toBeUndefined();
    expect(engine().links?.relations.invoices).toBeDefined();
    expect(engine().links?.next).toBeUndefined();
    // The canvas keeps its cells (the default overview): Invoices stays in the last column.
    expect(topLeft("invoices")).toEqual({ col: 3, row: 0 });
    expect(topLeft("tasks")).toEqual({ col: 2, row: 0 });
    expect(cell("inbox")).toEqual({ col: 0, row: 0, w: 1, h: 2 });
    expect(engine().upNext?.source).not.toBe("link");
  });

  it("switching it off drops the step, its tag, and its suggestion at once, and moves nothing", async () => {
    openPriya();
    await vi.advanceTimersByTimeAsync(800);
    engine().openUpNext("invoice:INV-1042", "keyboard");
    expect(engine().plan.suggestions[0]?.nextStep).toBe(true);
    const cells = { ...engine().plan.grid!.cells };
    engine().setFocusAid("arrangeLinks", false);
    expect(engine().plan.suggestions.some((s) => s.nextStep)).toBe(false);
    expect(engine().links?.next).toBeUndefined();
    expect(engine().plan.grid?.cells).toEqual(cells);
  });
});

describe("resend_invoice", () => {
  it("records the resend on the invoice, says so, and logs it; nothing is emailed", () => {
    engine().perform("resend_invoice", { invoiceId: "INV-1042" });
    expect(engine().data.invoices.find((i) => i.id === "INV-1042")?.resentAt).toBeDefined();
    expect(engine().notice?.text).toBe("Invoice INV-1042 resent to Harbor Coffee Co.");
    const e = engine().events.at(-1)!;
    expect(e).toMatchObject({ type: "action", panel: "invoices", detail: { actionId: "resend_invoice", itemId: "INV-1042", client: "Harbor Coffee Co." } });
    expect(e.text).toBe("Resent invoice INV-1042 to Harbor Coffee Co. in Invoices");
    const handled = handledRecords(engine().events);
    expect(handled.has("invoice:INV-1042")).toBe(true);
    // A handled record is no longer offered next, and resending again through a list skips it.
    const s = engine();
    expect(buildRecordCandidates({ data: s.data, view: s.view, anchor: null, links: null, events: s.events, now: Date.now() }).some((c) => c.id === "invoice:INV-1042")).toBe(false);
    expect(actionApplies("resend_invoice", "invoice", "INV-1042", s.data, handled)).toBe(false);
    expect(actionApplies("resend_invoice", "invoice", "INV-1038", s.data, handled)).toBe(true);
  });

  it("refuses a draft or a paid invoice and logs nothing", () => {
    engine().perform("resend_invoice", { invoiceId: "INV-1052" });
    expect(engine().notice?.text).toBe("INV-1052 is a draft and was never sent");
    engine().perform("resend_invoice", { invoiceId: "INV-1040" });
    expect(engine().notice?.text).toBe("INV-1040 is already paid");
    expect(engine().events.some((e) => e.type === "action")).toBe(false);
  });
});
