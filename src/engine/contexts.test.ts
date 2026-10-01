import { describe, expect, it } from "vitest";
import type { GoalId } from "../../shared/catalog.ts";
import type { LayoutPlan } from "../../shared/types.ts";
import {
  addContext,
  backToList,
  commandSwitchesArea,
  contextClient,
  contextLabel,
  CONTEXTS_MAX,
  judgeSwitch,
  panelGoal,
  restoredPlan,
} from "./contexts.ts";
import type { PanelViewState, WorkingContext } from "./contract.ts";
import { choiceJ, ev } from "./test-helpers.ts";

const goal = (g: GoalId, c: number) => choiceJ<GoalId>(g, c, { [g]: c });

const VIEW: PanelViewState = {
  inbox: { query: "", selectedId: null, client: null },
  invoices: { status: "overdue", client: null, selectedId: "INV-1042" },
  clients: { selected: null, query: "" },
  tasks: { showDone: false, client: null, selectedId: null },
  projects: { status: "all", selectedId: null },
  calendar: { range: "today", selectedId: null },
  analytics: { range: "this_year" },
  team: {},
  notes: {},
  help: {},
};

const PLAN: LayoutPlan = {
  mode: "focus",
  placements: [
    { id: "invoices", size: "hero", priority: 0.9, pinned: false, reason: "Made bigger by you", change: "promoted", bigger: true, anchor: true },
    { id: "clients", size: "standard", priority: 0.5, pinned: true, reason: "Pinned by you", change: null },
    {
      id: "inbox",
      size: "standard",
      priority: 0.4,
      pinned: false,
      reason: "Jev rates it useful",
      change: null,
      relation: { anchorPanel: "invoices", tag: "Linked to INV-1042", reason: "1 message", records: [{ itemKind: "message", itemId: "m-1", label: "Priya" }] },
    },
  ],
  docked: ["calendar", "tasks", "projects", "analytics", "team", "notes", "help"],
  density: "standard",
  suggestions: [{ actionId: "send_payment_reminder", label: "Send", prominence: "primary", confidence: 0.8, args: {}, reason: "x" }],
  help: "none",
  decisions: [],
  basedOnVersion: 3,
  anchor: { panel: "invoices", itemKind: "invoice", itemId: "INV-1042", at: 5, source: "work" },
  grid: {
    columns: 4,
    cells: { invoices: { col: 0, row: 0, w: 2, h: 4 }, clients: { col: 2, row: 0, w: 1, h: 2 }, inbox: { col: 3, row: 0, w: 1, h: 2 } },
    rows: 4,
    anchored: false,
  },
  round: 7,
};

function ctx(id: number, g: GoalId, client?: string, at = id): WorkingContext {
  return { id, goal: g, ...(client ? { client } : {}), label: contextLabel(g, client), plan: PLAN, bigger: ["invoices"], view: VIEW, links: null, at };
}

describe("judgeSwitch", () => {
  it("starts the first context with the first confident goal, saving nothing", () => {
    expect(judgeSwitch(null, null, goal("collect_payments", 0.8))).toEqual({ kind: "adopt", goal: "collect_payments" });
    expect(judgeSwitch(null, null, goal("collect_payments", 0.6))).toEqual({ kind: "none" });
    expect(judgeSwitch(null, null, goal("unclear", 0.95))).toEqual({ kind: "none" });
  });

  it("switches only after two confident rounds in a row for another goal", () => {
    const first = judgeSwitch("collect_payments", null, goal("plan_day", 0.8));
    expect(first).toEqual({ kind: "pending", pending: { goal: "plan_day", rounds: 1 } });
    const second = judgeSwitch("collect_payments", first.kind === "pending" ? first.pending : null, goal("plan_day", 0.75));
    expect(second).toEqual({ kind: "switch", goal: "plan_day" });
  });

  it("breaks the streak on the current goal, an unsure round, unclear, or a third goal", () => {
    const pending = { goal: "plan_day" as GoalId, rounds: 1 };
    expect(judgeSwitch("collect_payments", pending, goal("collect_payments", 0.9))).toEqual({ kind: "none" });
    expect(judgeSwitch("collect_payments", pending, goal("plan_day", 0.69))).toEqual({ kind: "none" });
    expect(judgeSwitch("collect_payments", pending, goal("unclear", 0.9))).toEqual({ kind: "none" });
    expect(judgeSwitch("collect_payments", pending, goal("triage_inbox", 0.9))).toEqual({ kind: "pending", pending: { goal: "triage_inbox", rounds: 1 } });
  });
});

describe("command switches", () => {
  it("switches areas for a panel outside the current goal's own panels", () => {
    expect(commandSwitchesArea("collect_payments", "calendar")).toBe("plan_day");
    expect(commandSwitchesArea("collect_payments", "analytics")).toBe("review_business");
    expect(commandSwitchesArea("collect_payments", "clients")).toBeNull();
    expect(commandSwitchesArea("collect_payments", "invoices")).toBeNull();
    expect(commandSwitchesArea("collect_payments", "help")).toBeNull();
    expect(panelGoal("tasks")).toBe("plan_day");
  });
});

describe("saved contexts", () => {
  it("labels a context with its goal and client", () => {
    expect(contextLabel("collect_payments", "Harbor Coffee Co.")).toBe("Collecting payments · Harbor Coffee Co.");
    expect(contextLabel("plan_day")).toBe("Planning the day");
  });

  it("reads the client from the newest record in the goal's own panels, else a sure target client", () => {
    const events = [
      ev("item_open", 100, "invoices", { itemKind: "invoice", itemId: "INV-1038", client: "Meridian Hotels" }),
      ev("item_open", 200, "invoices", { itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co." }),
      // The click that started planning the day names another client; it is not about collecting payments.
      ev("item_open", 300, "calendar", { itemKind: "event", itemId: "e-4", client: "Meridian Hotels" }),
    ];
    expect(contextClient(events, "collect_payments")).toBe("Harbor Coffee Co.");
    expect(contextClient(events, "plan_day")).toBe("Meridian Hotels");
    expect(contextClient(events, "capture_notes", choiceJ("Kite & Co.", 0.8))).toBe("Kite & Co.");
    expect(contextClient(events, "capture_notes", choiceJ("Kite & Co.", 0.4))).toBeUndefined();
  });

  it("keeps the most recent first, one per goal and client, at most three", () => {
    let list: WorkingContext[] = [];
    list = addContext(list, ctx(1, "collect_payments", "Harbor Coffee Co."));
    list = addContext(list, ctx(2, "plan_day"));
    list = addContext(list, ctx(3, "collect_payments", "Kite & Co."));
    expect(list.map((c) => c.id)).toEqual([3, 2, 1]);
    // The same goal and client replaces the older one and moves to the front.
    list = addContext(list, ctx(4, "collect_payments", "Harbor Coffee Co."));
    expect(list.map((c) => c.id)).toEqual([4, 3, 2]);
    list = addContext(list, ctx(5, "triage_inbox"));
    expect(list).toHaveLength(CONTEXTS_MAX);
    expect(list.map((c) => c.id)).toEqual([5, 4, 3]);
  });

  it("offers the saved contexts for other goals than the current work", () => {
    const list = [ctx(3, "plan_day"), ctx(2, "collect_payments", "Harbor Coffee Co."), ctx(1, "triage_inbox")];
    expect(backToList(list, "collect_payments").map((c) => c.id)).toEqual([3, 1]);
    expect(backToList(list, null).map((c) => c.id)).toEqual([3, 2, 1]);
  });
});

describe("restoredPlan", () => {
  const current: LayoutPlan = { ...PLAN, placements: [PLAN.placements[1]], basedOnVersion: 9, round: 12 };

  it("puts back the saved placements, sizes, cells, and bigger flags, without the old anchor, links, or suggestions", () => {
    const plan = restoredPlan(ctx(1, "collect_payments", "Harbor Coffee Co."), current, ["clients"]);
    expect(plan.placements.map((p) => [p.id, p.size, p.pinned, Boolean(p.bigger)])).toEqual([
      ["invoices", "hero", false, true],
      ["clients", "standard", true, false],
      ["inbox", "standard", false, false],
    ]);
    expect(plan.grid?.cells).toEqual(PLAN.grid?.cells);
    expect(plan.placements.every((p) => !p.anchor && !p.relation && p.change === null)).toBe(true);
    expect(plan.anchor).toBeNull();
    expect(plan.suggestions).toEqual([]);
    expect(plan.decisions).toEqual([{ kind: "command", text: "Went back to Collecting payments · Harbor Coffee Co." }]);
    expect(plan.basedOnVersion).toBe(9);
  });

  it("keeps the pins as they are now: a new pin joins at the front, an old one is unpinned", () => {
    const plan = restoredPlan(ctx(1, "collect_payments"), current, ["team"]);
    expect(plan.placements[0]).toMatchObject({ id: "team", pinned: true });
    expect(plan.placements.find((p) => p.id === "clients")).toMatchObject({ pinned: false, reason: "Part of your workspace" });
    // A new card has no saved cell, so the place step reflows.
    expect(plan.grid).toBeUndefined();
    expect(plan.docked).not.toContain("team");
  });
});
