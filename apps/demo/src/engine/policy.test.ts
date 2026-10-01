import { describe, expect, it } from "vitest";
import type { GoalId, LayoutMode, PanelId } from "../../shared/catalog.ts";
import type { ActionId } from "../../shared/catalog.ts";
import type { PolicyInput } from "./contract.ts";
import { DENSITY_CAPS, MEMBERSHIP_HOLD_MS } from "@attune/core";
import {
  applyPromotion,
  buildSuggestions,
  computePlan,
  defaultPlan,
  editPlan,
  markChanges,
  orderWithHysteresis,
  planSignature,
  restoredSize,
  traditionalPlan,
} from "./policy.ts";
import type { PanelViewState } from "./contract.ts";
import type { LayoutPlan } from "../../shared/types.ts";
import { choiceJ, ev, makeJudgments, scoreJ, type JudgmentOverrides } from "./test-helpers.ts";
import { panelUsage } from "./usage.ts";

const NOW = 10_000_000;

/** Relevance on a 0..2 scale. With default weights (0.5, 0.25, 0.25) and no usage or goal, priority = rel / 4. */
const REL: Partial<Record<PanelId, number>> = { inbox: 1.2, calendar: 1, tasks: 1, invoices: 2, clients: 1.4, projects: 0.8 };

function input(o: Partial<PolicyInput> & { j?: JudgmentOverrides } = {}): PolicyInput {
  return {
    judgments: o.judgments ?? makeJudgments({ rel: REL, ...o.j }),
    version: o.version ?? 1,
    previous: o.previous ?? defaultPlan(),
    events: o.events ?? [],
    now: o.now ?? NOW,
    weights: o.weights ?? { relevance: 0.5, usage: 0.25, goal: 0.25 },
    pinned: o.pinned ?? [],
    dismissed: o.dismissed ?? {},
    focusedPanel: o.focusedPanel ?? null,
    recentModes: o.recentModes ?? [],
    ...(o.recentDensities ? { recentDensities: o.recentDensities } : {}),
    ...(o.avoid ? { avoid: o.avoid } : {}),
    ...(o.bigger ? { bigger: o.bigger } : {}),
    ...(o.front ? { front: o.front } : {}),
  };
}

const ids = (plan: { placements: { id: PanelId }[] }) => plan.placements.map((p) => p.id);
const layout = (mode: LayoutMode, confidence: number) => choiceJ<LayoutMode>(mode, confidence, { [mode]: confidence });

describe("defaultPlan and traditionalPlan", () => {
  it("is the traditional overview layout", () => {
    const plan = defaultPlan();
    expect(plan.mode).toBe("overview");
    expect(ids(plan)).toEqual(["inbox", "calendar", "tasks", "invoices", "clients", "projects"]);
    expect(plan.placements.every((p) => p.size === "standard" && !p.pinned && p.change === null)).toBe(true);
    expect(plan.docked).toEqual(["analytics", "team", "notes", "help"]);
    expect(plan).toMatchObject({ density: "standard", suggestions: [], help: "none", decisions: [], basedOnVersion: 0 });
  });

  it("equals defaultPlan with no manual changes, and applies manual ones when given", () => {
    expect(traditionalPlan()).toEqual(defaultPlan());
    const plan = traditionalPlan({ pinned: ["notes"], dismissed: { inbox: 1 }, opened: ["team"] });
    expect(ids(plan)).toEqual(["notes", "calendar", "tasks", "invoices", "clients", "projects", "team"]);
    expect(plan.docked).toEqual(["inbox", "analytics", "help"]);
  });
});

describe("priority", () => {
  it("blends relevance, usage, and goal affinity with the weights", () => {
    const plan = computePlan(
      input({
        weights: { relevance: 1, usage: 0, goal: 1 },
        j: { rel: { invoices: 1 }, goal: choiceJ<GoalId>("collect_payments", 0.7, { collect_payments: 0.8, triage_inbox: 0.2 }) },
      }),
    );
    const inv = plan.placements.find((p) => p.id === "invoices");
    // rel 1 of 2 = 0.5, weighted 1/2 -> 0.25; affinity 0.8 * 1 = 0.8, weighted 1/2 -> 0.4.
    expect(inv?.breakdown).toEqual({ relevance: 0.25, usage: 0, goal: 0.4, pin: 0 });
    expect(inv?.priority).toBeCloseTo(0.65, 3);
    const clients = plan.placements.find((p) => p.id === "clients");
    // affinity 0.8 * 0.7 + 0.2 * 0.3 = 0.62, weighted 1/2 -> 0.31.
    expect(clients?.breakdown?.goal).toBeCloseTo(0.31, 3);
  });

  it("sends panels below the dock threshold to the dock", () => {
    // projects is on the canvas, so it stays until it falls below 0.18 - 0.04: 0.125 does.
    const plan = computePlan(input({ j: { rel: { ...REL, projects: 0.5 } } }));
    expect(plan.docked).toContain("projects");
    expect(plan.docked).toContain("analytics");
    expect(ids(plan)).toContain("tasks");
  });
});

describe("mode hysteresis", () => {
  it("switches at once when confident", () => {
    const plan = computePlan(input({ j: { layout: layout("focus", 0.85) } }));
    expect(plan.mode).toBe("focus");
    expect(plan.decisions[0]).toMatchObject({ kind: "mode", text: "Switched to the Focus layout" });
    expect(plan.decisions[0].evidence).toContain("layout focus p=0.85");
  });

  it("holds the previous mode when not confident enough", () => {
    const plan = computePlan(input({ j: { layout: layout("focus", 0.7) }, recentModes: ["overview", "focus"] }));
    expect(plan.mode).toBe("overview");
    expect(plan.decisions.find((d) => d.kind === "hold")).toMatchObject({ text: "Kept the Overview layout for now" });
  });

  it("switches at medium confidence when the same mode was judged twice in a row", () => {
    const plan = computePlan(input({ j: { layout: layout("compare", 0.6) }, recentModes: ["overview", "compare", "compare"] }));
    expect(plan.mode).toBe("compare");
    expect(plan.placements.slice(0, 2).map((p) => p.size)).toEqual(["hero", "hero"]);
  });

  it("still holds below the streak confidence", () => {
    const plan = computePlan(input({ j: { layout: layout("compare", 0.5) }, recentModes: ["compare", "compare"] }));
    expect(plan.mode).toBe("overview");
  });
});

describe("pins, protection, and dismissals", () => {
  it("puts pinned panels first, in pin order", () => {
    const plan = computePlan(input({ pinned: ["notes", "team"] }));
    expect(ids(plan).slice(0, 2)).toEqual(["notes", "team"]);
    expect(plan.placements[0]).toMatchObject({ pinned: true, reason: "Pinned by you" });
    expect(plan.placements[0].priority).toBeGreaterThanOrEqual(1);
    expect(plan.placements[0].breakdown?.pin).toBe(1);
  });

  it("never docks the focused panel, and keeps its size while it is in use", () => {
    const first = computePlan(input({ j: { rel: { ...REL, projects: 2, invoices: 1 }, layout: layout("focus", 0.9) } }));
    expect(first.placements[0]).toMatchObject({ id: "projects", size: "hero" });

    const next = { j: { rel: { ...REL, projects: 0 }, layout: layout("focus", 0.9) }, previous: first };
    const events = [ev("item_open", NOW - 10_000, "projects")];
    const focused = computePlan(input({ ...next, events, focusedPanel: "projects" }));
    expect(focused.placements.find((p) => p.id === "projects")?.size).toBe("hero");

    const unfocused = computePlan(input(next));
    expect(unfocused.docked).toContain("projects");
  });

  it("protects a panel with a very recent event", () => {
    const weights = { relevance: 1, usage: 0, goal: 0 };
    const recent = computePlan(input({ weights, events: [ev("panel_dwell", NOW - 2_000, "team", { durationMs: 3_000 })] }));
    expect(ids(recent)).toContain("team");
    const old = computePlan(input({ weights, events: [ev("panel_dwell", NOW - 10_000, "team", { durationMs: 3_000 })] }));
    expect(old.docked).toContain("team");
  });

  it("does not protect a panel whose latest event is a dismissal", () => {
    const weights = { relevance: 1, usage: 0, goal: 0 };
    const events = [ev("panel_open", NOW - 3_000, "team"), ev("panel_dismiss", NOW - 1_500, "team", { durationMs: 1_500 })];
    expect(computePlan(input({ weights, events })).docked).toContain("team");
  });

  it("still protects the focused panel after an old dismissal and reopen", () => {
    const weights = { relevance: 1, usage: 0, goal: 0 };
    const events = [ev("panel_dismiss", NOW - 600_000, "team"), ev("panel_open", NOW - 500_000, "team")];
    expect(ids(computePlan(input({ weights, events, focusedPanel: "team" })))).toContain("team");
  });

  it("keeps a dismissed panel in the dock for a few minutes, unless pinned", () => {
    const docked = computePlan(input({ dismissed: { invoices: NOW - 60_000 }, focusedPanel: "invoices" }));
    expect(docked.docked).toContain("invoices");
    expect(docked.decisions.find((d) => d.kind === "dock" && d.panel === "invoices")).toMatchObject({
      text: "Moved Invoices to the dock",
      evidence: "dismissed by you",
    });
    const later = computePlan(input({ dismissed: { invoices: NOW - 4 * 60_000 } }));
    expect(ids(later)).toContain("invoices");
    const pinned = computePlan(input({ dismissed: { invoices: NOW - 60_000 }, pinned: ["invoices"] }));
    expect(ids(pinned)[0]).toBe("invoices");
  });

  it("keeps a panel the user just opened on the canvas for a minute", () => {
    const weights = { relevance: 1, usage: 0, goal: 0 };
    const fresh = computePlan(input({ weights, events: [ev("panel_open", NOW - 30_000, "analytics")] }));
    expect(ids(fresh)).toContain("analytics");
    const stale = computePlan(input({ weights, events: [ev("panel_open", NOW - 90_000, "analytics")] }));
    expect(stale.docked).toContain("analytics");
  });
});

describe("order hysteresis", () => {
  const prio = (m: Partial<Record<PanelId, number>>) => (id: PanelId) => m[id] ?? 0;

  it("swaps adjacent panels only past the margin", () => {
    expect(orderWithHysteresis(["inbox", "calendar"], ["inbox", "calendar"], prio({ inbox: 0.3, calendar: 0.35 }))).toEqual(["inbox", "calendar"]);
    expect(orderWithHysteresis(["inbox", "calendar"], ["inbox", "calendar"], prio({ inbox: 0.3, calendar: 0.4 }))).toEqual(["calendar", "inbox"]);
  });

  it("lets new panels enter by priority", () => {
    expect(orderWithHysteresis(["inbox", "calendar", "invoices"], ["inbox", "calendar"], prio({ inbox: 0.3, calendar: 0.2, invoices: 0.25 }))).toEqual([
      "inbox",
      "invoices",
      "calendar",
    ]);
  });

  it("keeps the previous order in computePlan for near ties", () => {
    // Default order starts inbox, calendar. Calendar beats inbox by 0.05 only.
    const plan = computePlan(input({ weights: { relevance: 1, usage: 0, goal: 0 }, j: { rel: { inbox: 1.0, calendar: 1.1, tasks: 0.5, invoices: 2 } } }));
    expect(ids(plan).slice(0, 3)).toEqual(["invoices", "inbox", "calendar"]);
  });
});

describe("density", () => {
  const many: Partial<Record<PanelId, number>> = { inbox: 2, calendar: 2, tasks: 2, invoices: 2, clients: 2, projects: 2, analytics: 2, team: 2, notes: 2 };

  // Enough evidence for a density change, without adding usage or protection to any panel.
  const events = [1, 2, 3, 4, 5].map((i) => ev("command", NOW - i * 10_000, undefined, { query: `q${i}` }));

  it("follows confident expertise and caps the canvas", () => {
    const guided = computePlan(input({ events, j: { rel: many, expertise: scoreJ(0.4, 2, 0.9) } }));
    expect(guided.density).toBe("guided");
    expect(guided.placements.length).toBe(DENSITY_CAPS.guided);
    expect(guided.decisions.some((d) => d.kind === "density")).toBe(true);

    const dense = computePlan(input({ events, j: { rel: many, expertise: scoreJ(1.8, 2, 0.7) } }));
    expect(dense.density).toBe("dense");
    expect(dense.placements.length).toBe(8); // Overview has 8 slots, fewer than the dense cap of 9.
  });

  it("keeps the previous density when expertise is unsure", () => {
    const plan = computePlan(input({ events, j: { expertise: scoreJ(1.8, 2, 0.4) } }));
    expect(plan.density).toBe("standard");
  });

  it("does not change density on too little evidence", () => {
    const events = [ev("panel_focus", NOW - 1_000, "invoices")];
    expect(computePlan(input({ events, j: { expertise: scoreJ(0.2, 2, 0.9) } })).density).toBe("standard");
  });
});

describe("help", () => {
  it("opens the Guide panel, shows a hint, or stays quiet by struggling level", () => {
    const panel = computePlan(input({ j: { struggling: 0.75 } }));
    expect(panel.help).toBe("panel");
    expect(panel.placements.find((p) => p.id === "help")?.reason).toBe("Shown because you may need help");
    expect(panel.decisions.find((d) => d.kind === "help")?.evidence).toBe("struggling p=0.75");

    const hint = computePlan(input({ j: { struggling: 0.6, rel: { ...REL, help: 2 } } }));
    expect(hint.help).toBe("hint");
    expect(hint.docked).toContain("help");

    expect(computePlan(input({ j: { struggling: 0.3 } })).help).toBe("none");
  });
});

describe("suggestions", () => {
  const na = (choice: ActionId, confidence: number, probabilities?: Partial<Record<ActionId, number>>) =>
    choiceJ<ActionId>(choice, confidence, probabilities ?? { [choice]: confidence });
  const harbor = choiceJ("Harbor Coffee Co.", 0.9, { "Harbor Coffee Co.": 0.92 });

  it("shows a confident next step as primary with its args", () => {
    const [s, ...rest] = buildSuggestions(makeJudgments({ nextAction: na("send_payment_reminder", 0.8), targetClient: harbor }), [], NOW);
    expect(rest).toEqual([]);
    expect(s).toMatchObject({
      actionId: "send_payment_reminder",
      prominence: "primary",
      label: "Send payment reminder to Harbor Coffee Co.",
      args: { client: "Harbor Coffee Co.", invoiceId: "INV-1042" },
    });
  });

  it("shows an unsure next step as subtle, plus a strong runner-up", () => {
    const j = makeJudgments({
      nextAction: na("send_payment_reminder", 0.5, { send_payment_reminder: 0.5, reply_to_message: 0.3, none: 0.2 }),
      targetClient: choiceJ("Harbor Coffee Co.", 0.3),
    });
    const out = buildSuggestions(j, [], NOW);
    expect(out.map((s) => [s.actionId, s.prominence])).toEqual([
      ["send_payment_reminder", "subtle"],
      ["reply_to_message", "subtle"],
    ]);
    // No confident client: the reminder goes to the oldest overdue invoice overall.
    expect(out[0].args).toEqual({ client: "Meridian Hotels", invoiceId: "INV-1038" });
    // No client either: the reply goes to the newest unread message, and the label names its sender.
    expect(out[1]).toMatchObject({ label: "Reply to Priya Nair", args: { client: "Harbor Coffee Co.", messageId: "m-1" } });
  });

  it("skips weak, none, and recently dismissed or done steps", () => {
    expect(buildSuggestions(makeJudgments({ nextAction: na("create_task", 0.3) }), [], NOW)).toEqual([]);
    expect(buildSuggestions(makeJudgments({ nextAction: na("none", 0.9) }), [], NOW)).toEqual([]);
    const weakRunnerUp = makeJudgments({ nextAction: na("create_task", 0.5, { create_task: 0.5, write_note: 0.2 }) });
    expect(buildSuggestions(weakRunnerUp, [], NOW)).toHaveLength(1);

    const j = makeJudgments({ nextAction: na("send_payment_reminder", 0.8), targetClient: harbor });
    const dismissed = [ev("suggestion_dismiss", NOW - 60_000, undefined, { actionId: "send_payment_reminder" })];
    expect(buildSuggestions(j, dismissed, NOW)).toEqual([]);
    expect(buildSuggestions(j, [ev("suggestion_dismiss", NOW - 3 * 60_000, undefined, { actionId: "send_payment_reminder" })], NOW)).toHaveLength(1);
    const done = [ev("action", NOW - 10_000, "invoices", { actionId: "send_payment_reminder", client: "Harbor Coffee Co." })];
    expect(buildSuggestions(j, done, NOW)).toEqual([]);
    const doneOther = [ev("action", NOW - 10_000, "invoices", { actionId: "send_payment_reminder", client: "Meridian Hotels" })];
    expect(buildSuggestions(j, doneOther, NOW)).toHaveLength(1);
  });

  it("uses live invoices when given", () => {
    const j = makeJudgments({ nextAction: na("send_payment_reminder", 0.8), targetClient: harbor });
    const [s] = buildSuggestions(j, [], NOW, [{ id: "INV-9", client: "Harbor Coffee Co.", amount: 1, issued: "2020-01-01", due: "2020-02-01", status: "sent", project: "x", remindersSent: 0 }]);
    expect(s.args.invoiceId).toBe("INV-9");
  });

  it("appear in the plan with a decision", () => {
    const plan = computePlan(input({ j: { nextAction: na("send_payment_reminder", 0.8), targetClient: harbor } }));
    expect(plan.suggestions).toHaveLength(1);
    expect(plan.decisions.find((d) => d.kind === "suggest")).toMatchObject({
      text: "Suggested: Send payment reminder to Harbor Coffee Co.",
      evidence: "next step send_payment_reminder p=0.80, client Harbor Coffee Co. p=0.92",
    });
  });
});

describe("decisions and reasons", () => {
  it("explains additions with the strongest part and marks changed panels", () => {
    const plan = computePlan(
      input({ weights: { relevance: 0, usage: 0, goal: 1 }, j: { goal: choiceJ<GoalId>("collect_payments", 0.91, { collect_payments: 0.91, unclear: 0.09 }) } }),
    );
    const add = plan.decisions.find((d) => d.kind === "add" && d.panel === "analytics");
    expect(add?.text).toBe("Brought Revenue onto the canvas");
    expect(add?.evidence).toMatch(/^goal collect_payments p=0\.91, priority 0\.36$/);
    const revenue = plan.placements.find((p) => p.id === "analytics");
    expect(revenue).toMatchObject({ change: "added", reason: "Fits the goal: Collecting payments" });
    // Invoices and Clients kept their order relative to each other; Inbox fell behind both.
    expect(plan.placements.find((p) => p.id === "inbox")?.change).toBe("demoted");
    expect(plan.decisions.find((d) => d.panel === "inbox")?.text).toBe("Moved Inbox down");
    expect(plan.basedOnVersion).toBe(1);
  });

  it("reports nothing when nothing changed", () => {
    const first = computePlan(input());
    const second = computePlan(input({ previous: first, version: 2 }));
    expect(second.decisions).toEqual([]);
    expect(second.placements.every((p) => p.change === null)).toBe(true);
    expect(planSignature(second)).toBe(planSignature(first));
  });
});

describe("plan edits", () => {
  it("promotes a panel to hero in focus mode for a command", () => {
    const base = computePlan(input());
    const plan = applyPromotion({ plan: base, previous: base, panel: "team", pinned: [], decision: { kind: "command", panel: "team", text: "Opened Team because you asked" } });
    expect(plan.mode).toBe("focus");
    expect(plan.placements[0]).toMatchObject({ id: "team", size: "hero", reason: "You asked for it in the command bar", change: "added" });
    expect(plan.placements.length).toBeLessThanOrEqual(6);
    expect(plan.decisions[0].kind).toBe("command");
    expect(plan.decisions.some((d) => d.kind === "mode")).toBe(true);
  });

  it("docks and opens panels by hand", () => {
    const dismissed = editPlan(defaultPlan(), { kind: "dismiss", panel: "inbox" });
    expect(ids(dismissed)).not.toContain("inbox");
    expect(dismissed.docked[0]).toBe("inbox");
    const opened = editPlan(dismissed, { kind: "open", panel: "team" });
    expect(opened.placements.at(-1)).toMatchObject({ id: "team", size: "standard", change: "added" });
    const pinned = editPlan(opened, { kind: "pin", panel: "tasks" });
    expect(pinned.placements.find((p) => p.id === "tasks")?.pinned).toBe(true);
  });
});

describe("focused panel size (ENG-4)", () => {
  it("lets a focused panel that has been idle take its slot's size", () => {
    const weights = { relevance: 1, usage: 0, goal: 0 };
    const focus = computePlan(input({ weights, j: { rel: { ...REL, invoices: 2 }, layout: layout("focus", 0.9) } }));
    expect(focus.placements[0]).toMatchObject({ id: "invoices", size: "hero" });
    // Ten minutes later a round judges Compare with Clients and Inbox on top.
    const later = NOW + 600_000;
    const compare = computePlan(
      input({
        weights,
        now: later,
        previous: focus,
        focusedPanel: "invoices",
        events: [ev("item_open", NOW, "invoices")],
        j: { rel: { ...REL, clients: 2, inbox: 2, invoices: 1.2 }, layout: layout("compare", 0.9) },
      }),
    );
    expect(compare.placements.filter((p) => p.size === "hero").map((p) => p.id)).toEqual(["clients", "inbox"]);
    expect(ids(compare)).toContain("invoices"); // Still on the canvas: it is focused.
  });
});

describe("help (ENG-3, K4)", () => {
  it("shows the tip instead when the user docked the Guide, and never claims it opened", () => {
    const plan = computePlan(input({ j: { struggling: 0.9 }, dismissed: { help: NOW - 30_000 } }));
    expect(plan.help).toBe("hint");
    expect(ids(plan)).not.toContain("help");
    expect(plan.decisions.some((d) => d.text.startsWith("Opened the Guide"))).toBe(false);
    expect(plan.decisions.find((d) => d.kind === "help")?.text).toBe("Showed a tip because you may be stuck");
  });

  it("puts the Guide in the second slot at standard size, after pins", () => {
    const plan = computePlan(input({ j: { struggling: 0.8, layout: layout("focus", 0.9) } }));
    expect(plan.placements[1]).toMatchObject({ id: "help", size: "standard" });
    expect(plan.placements[0].id).toBe("invoices");
    const pinned = computePlan(input({ j: { struggling: 0.8 }, pinned: ["notes", "team"] }));
    expect(ids(pinned).slice(0, 3)).toEqual(["notes", "team", "help"]);
  });
});

describe("membership hysteresis (UX-6)", () => {
  const weights = { relevance: 1, usage: 0, goal: 0 };
  // With these weights, priority = rel / 2.

  it("uses a band around the dock threshold", () => {
    // Team at 0.19 (above 0.18) is not enough to join; it needs 0.22.
    const newcomer = computePlan(input({ weights, j: { rel: { ...REL, team: 0.38 } } }));
    expect(newcomer.docked).toContain("team");
    const joins = computePlan(input({ weights, j: { rel: { ...REL, team: 0.46 } } }));
    expect(ids(joins)).toContain("team");
    // Projects on the canvas at 0.15 (below 0.18) stays until 0.14.
    const incumbent = computePlan(input({ weights, j: { rel: { ...REL, projects: 0.3 } } }));
    expect(ids(incumbent)).toContain("projects");
  });

  it("keeps a panel the policy added for a while, and one it docked in the dock", () => {
    const added = computePlan(input({ weights, j: { rel: { ...REL, team: 1.2 } } }));
    expect(added.placements.find((p) => p.id === "team")).toMatchObject({ change: "added", addedAt: NOW });
    // Ten seconds later Jev's drift drops Team below every threshold: it stays.
    const soon = computePlan(input({ weights, previous: added, now: NOW + 10_000, j: { rel: { ...REL, team: 0.1 } } }));
    expect(ids(soon)).toContain("team");
    const late = computePlan(input({ weights, previous: soon, now: NOW + MEMBERSHIP_HOLD_MS + 1, j: { rel: { ...REL, team: 0.1 } } }));
    expect(late.docked).toContain("team");
    expect(late.autoDockedAt?.team).toBe(NOW + MEMBERSHIP_HOLD_MS + 1);
    // And it does not bounce straight back.
    const back = computePlan(input({ weights, previous: late, now: NOW + MEMBERSHIP_HOLD_MS + 5_000, j: { rel: { ...REL, team: 1.2 } } }));
    expect(back.docked).toContain("team");
    const later = computePlan(input({ weights, previous: back, now: NOW + 2 * MEMBERSHIP_HOLD_MS + 5_000, j: { rel: { ...REL, team: 1.2 } } }));
    expect(ids(later)).toContain("team");
  });
});

describe("moves in the change feed (UX-6, UX-9)", () => {
  const plan = (order: PanelId[]): LayoutPlan => ({
    ...defaultPlan(),
    placements: order.map((id) => ({ id, size: "standard", priority: 0, pinned: false, reason: "", change: null })),
  });

  it("reports a swap of two neighbors, which a one-slot move already is", () => {
    const next = markChanges(plan(["inbox", "calendar", "tasks"]), plan(["calendar", "inbox", "tasks"]));
    expect(next.decisions.map((d) => d.text)).toEqual(["Moved Calendar up"]);
  });

  it("does not report every panel after one that entered or left", () => {
    const inserted = markChanges(plan(["inbox", "calendar", "tasks"]), plan(["team", "inbox", "calendar", "tasks"]));
    expect(inserted.decisions.map((d) => d.text)).toEqual(["Brought Team onto the canvas"]);
    const removed = markChanges(plan(["team", "inbox", "calendar"]), plan(["inbox", "calendar"]));
    expect(removed.decisions.map((d) => d.text)).toEqual(["Moved Team to the dock"]);
  });

  it("lists what left or shrank before what arrived", () => {
    const next = computePlan(input({ weights: { relevance: 0, usage: 0, goal: 1 }, j: { goal: choiceJ<GoalId>("collect_payments", 0.91, { collect_payments: 0.91 }) } }));
    const kinds = next.decisions.map((d) => d.kind);
    expect(kinds.indexOf("dock")).toBeLessThan(kinds.indexOf("add"));
  });

  it("words the density line from the change in panel count", () => {
    const many: Partial<Record<PanelId, number>> = { inbox: 2, calendar: 2, tasks: 2, invoices: 2, clients: 2, projects: 2, analytics: 2, team: 2, notes: 2 };
    const events = [1, 2, 3, 4, 5].map((i) => ev("command", NOW - i * 10_000, undefined, { query: `q${i}` }));
    // Dense in Focus mode: six slots, fewer than the seven panels before.
    const dense = computePlan(input({ events, j: { rel: many, expertise: scoreJ(1.8, 2, 0.8), layout: layout("focus", 0.9) }, previous: computePlan(input({ j: { rel: many } })) }));
    expect(dense.placements.length).toBeLessThan(7);
    expect(dense.decisions.find((d) => d.kind === "density")?.text).toBe("Room for more panels for a fast, experienced user");
  });
});

describe("density streak (UX-10)", () => {
  const events = [1, 2, 3, 4, 5].map((i) => ev("command", NOW - i * 10_000, undefined, { query: `q${i}` }));

  it("changes density only when two rounds in a row agree", () => {
    const once = computePlan(input({ events, j: { expertise: scoreJ(0.2, 2, 0.8) }, recentDensities: ["guided"] }));
    expect(once.density).toBe("standard");
    const twice = computePlan(input({ events, j: { expertise: scoreJ(0.2, 2, 0.8) }, recentDensities: ["guided", "guided"] }));
    expect(twice.density).toBe("guided");
    const mixed = computePlan(input({ events, j: { expertise: scoreJ(0.2, 2, 0.8) }, recentDensities: ["dense", "guided"] }));
    expect(mixed.density).toBe("standard");
  });
});

describe("undo memory (K9)", () => {
  it("does not repeat a mode switch the user undid", () => {
    const plan = computePlan(input({ j: { layout: layout("focus", 0.95) }, avoid: { mode: "focus", add: ["analytics"] } }));
    expect(plan.mode).toBe("overview");
    expect(plan.decisions.find((d) => d.kind === "hold")?.text).toBe("Kept the Overview layout because you undid that change");
    const withoutAvoid = computePlan(input({ j: { layout: layout("focus", 0.95) } }));
    expect(withoutAvoid.mode).toBe("focus");
  });

  it("does not re-add a panel whose adding was undone", () => {
    const weights = { relevance: 1, usage: 0, goal: 0 };
    const plan = computePlan(input({ weights, j: { rel: { ...REL, team: 2 } }, avoid: { add: ["team"] } }));
    expect(plan.docked).toContain("team");
  });
});

describe("suggestion targets (ENG-2, UX-8, JEV-4)", () => {
  const na = (choice: ActionId, confidence: number) => choiceJ<ActionId>(choice, confidence, { [choice]: confidence });
  const noClient = choiceJ("none", 0.9, { none: 0.9 });
  const view = (patch: Partial<PanelViewState>): PanelViewState =>
    ({
      inbox: { query: "", selectedId: null, client: null },
      invoices: { status: "all", client: null, selectedId: null },
      clients: { selected: null, query: "" },
      tasks: { showDone: false, client: null },
      projects: { status: "all", selectedId: null },
      calendar: { range: "today" },
      analytics: { range: "this_year" },
      team: {},
      notes: {},
      help: {},
      ...patch,
    }) as PanelViewState;

  it("blocks a suggestion without a client once that action ran for any client", () => {
    const j = makeJudgments({ nextAction: na("reply_to_message", 0.9), targetClient: noClient });
    expect(buildSuggestions(j, [], NOW)).toHaveLength(1);
    const replied = [ev("action", NOW - 5_000, "inbox", { actionId: "reply_to_message", client: "Harbor Coffee Co.", itemId: "m-1" })];
    expect(buildSuggestions(j, replied, NOW)).toEqual([]);
    const projectDone = [ev("action", NOW - 5_000, "projects", { actionId: "update_project_status", client: "Meridian Hotels", itemId: "p-meridian" })];
    expect(buildSuggestions(makeJudgments({ nextAction: na("update_project_status", 0.9), targetClient: noClient }), projectDone, NOW)).toEqual([]);
  });

  it("names and targets the record on screen", () => {
    const reply = buildSuggestions(makeJudgments({ nextAction: na("reply_to_message", 0.9), targetClient: noClient }), [], NOW, {
      view: view({ inbox: { query: "kite", selectedId: "m-5", client: null } }),
    });
    expect(reply[0]).toMatchObject({ label: "Reply to Zoe Laurent", args: { messageId: "m-5", client: "Kite & Co." } });
    // A search with nothing selected: the message the Inbox shows first.
    const searched = buildSuggestions(makeJudgments({ nextAction: na("reply_to_message", 0.9), targetClient: noClient }), [], NOW, {
      view: view({ inbox: { query: "kite", selectedId: null, client: null } }),
    });
    expect(searched[0]).toMatchObject({ label: "Reply to Zoe Laurent", args: { messageId: "m-5" } });
    const project = buildSuggestions(makeJudgments({ nextAction: na("update_project_status", 0.9), targetClient: noClient }), [], NOW, {
      view: view({ projects: { status: "all", selectedId: "p-kite" } }),
    });
    expect(project[0]).toMatchObject({ label: "Mark Packaging system on track", args: { projectId: "p-kite" } });
    const generic = buildSuggestions(makeJudgments({ nextAction: na("update_project_status", 0.9), targetClient: noClient }), [], NOW);
    expect(generic[0].label).toBe("Mark Lobby signage on track");
  });

  it("drops a suggestion whose result is already on screen", () => {
    const atlas = choiceJ("Atlas Robotics", 0.95, { "Atlas Robotics": 0.95 });
    const j = makeJudgments({ nextAction: na("view_client", 0.87), targetClient: atlas });
    expect(buildSuggestions(j, [], NOW)).toHaveLength(1);
    expect(buildSuggestions(j, [], NOW, { view: view({ clients: { selected: "Atlas Robotics", query: "" } }) })).toEqual([]);
    const opened = [ev("item_open", NOW - 20_000, "clients", { itemKind: "client", itemId: "c-atlas", client: "Atlas Robotics" })];
    expect(buildSuggestions(j, opened, NOW)).toEqual([]);
    const note = makeJudgments({ nextAction: na("write_note", 0.98) });
    expect(buildSuggestions(note, [], NOW, { focusedPanel: "notes" })).toEqual([]);
  });
});

describe("panels the user made bigger", () => {
  const weights = { relevance: 1, usage: 0, goal: 0 };
  /** Team on the canvas, made bigger by the user; Jev rates it useless. */
  const withTeam = () => editPlan(traditionalPlan({ opened: ["team"] }), { kind: "bigger", panel: "team" });
  const low = { rel: { ...REL, team: 0 }, layout: layout("focus", 0.9) };
  const team = (plan: LayoutPlan) => plan.placements.find((p) => p.id === "team");

  it("stays at hero size across later rounds that rate it low, and is never docked", () => {
    let plan = computePlan(input({ weights, j: low, previous: withTeam(), bigger: ["team"] }));
    expect(team(plan)).toMatchObject({ size: "hero", bigger: true, reason: "Made bigger by you" });
    for (let round = 1; round <= 3; round++) {
      plan = computePlan(input({ weights, j: { ...low, layout: layout(round === 2 ? "overview" : "compare", 0.9) }, previous: plan, bigger: ["team"], now: NOW + round * 60_000 }));
      expect(team(plan)).toMatchObject({ size: "hero", bigger: true });
    }
    // Guided density has room for five panels; it still stays.
    const guided = computePlan(input({ weights, j: { ...low, expertise: scoreJ(0, 2, 0.9) }, previous: { ...plan, density: "guided" }, bigger: ["team"], now: NOW + 300_000 }));
    expect(team(guided)?.size).toBe("hero");
    // The same round without the flag docks it: the flag is what keeps it.
    expect(computePlan(input({ weights, j: low, previous: withTeam() })).docked).toContain("team");
  });

  it("hands the size back to the policy once the flag is gone", () => {
    const big = computePlan(input({ weights, j: { ...low, rel: { ...REL, team: 0.4 } }, previous: withTeam(), bigger: ["team"] }));
    expect(team(big)?.size).toBe("hero");
    const handed = computePlan(input({ weights, j: { ...low, rel: { ...REL, team: 0.4 } }, previous: big }));
    expect(team(handed)?.size ?? "docked").not.toBe("hero");
    expect(team(handed)?.bigger).toBeUndefined();
  });

  it("keeps several at once, and a pinned panel that is also bigger stays first and hero", () => {
    const previous = editPlan(editPlan(traditionalPlan({ opened: ["team", "notes"] }), { kind: "bigger", panel: "team" }), { kind: "bigger", panel: "notes" });
    const plan = computePlan(input({ weights, j: { ...low, rel: { ...REL, team: 0, notes: 0 } }, previous, bigger: ["team", "notes"], pinned: ["notes"] }));
    expect(ids(plan)[0]).toBe("notes");
    expect(plan.placements[0]).toMatchObject({ size: "hero", pinned: true, bigger: true });
    expect(team(plan)).toMatchObject({ size: "hero", bigger: true });
    expect(plan.placements.filter((p) => p.size === "hero").map((p) => p.id)).toEqual(expect.arrayContaining(["notes", "team"]));
  });

  it("a command's promotion keeps it hero and on the canvas past the cap", () => {
    const base = computePlan(input({ weights, j: low, previous: withTeam(), bigger: ["team"] }));
    const plan = applyPromotion({ plan: base, previous: base, panel: "invoices", pinned: [], bigger: ["team"] });
    expect(plan.placements[0].id).toBe("invoices");
    expect(team(plan)).toMatchObject({ size: "hero", bigger: true, reason: "Made bigger by you" });
  });

  it("edits: bigger makes the hero with its own reason; smaller goes back to the size before, never the hero", () => {
    const big = editPlan(defaultPlan(), { kind: "bigger", panel: "tasks" });
    expect(big.placements.find((p) => p.id === "tasks")).toMatchObject({ size: "hero", bigger: true, reason: "Made bigger by you", change: "promoted" });
    expect(big.decisions).toContainEqual({ kind: "promote", panel: "tasks", text: "Made Tasks bigger", evidence: "made bigger by you" });
    const small = editPlan(big, { kind: "smaller", panel: "tasks", size: restoredSize(big, "tasks", "standard") });
    const tasks = small.placements.find((p) => p.id === "tasks");
    expect(tasks).toMatchObject({ size: "standard", reason: "Part of your workspace", change: "demoted" });
    expect(tasks?.bigger).toBeUndefined();
    expect(small.decisions).toContainEqual({ kind: "demote", panel: "tasks", text: "Made Tasks smaller", evidence: "made smaller by you" });
    expect(restoredSize(big, "tasks", "compact")).toBe("compact");
    expect(restoredSize(big, "tasks", "hero")).toBe("standard");
    // A pin sent to the front does not resize a panel the user made bigger.
    const pinned = editPlan(big, { kind: "pin", panel: "projects" }, { pinsFirst: true });
    expect(pinned.placements.find((p) => p.id === "tasks")).toMatchObject({ size: "hero", bigger: true });
  });

  it("counts toward recent use like a strong focus", () => {
    const usage = panelUsage([ev("panel_maximize", NOW - 1_000, "team"), ev("panel_restore", NOW - 1_000, "notes"), ev("panel_focus", NOW - 1_000, "inbox")], NOW);
    expect(usage.team).toBe(1);
    expect(usage.notes).toBe(1);
    expect(usage.inbox).toBeGreaterThan(0);
    expect(usage.inbox).toBeLessThan(usage.team);
  });

  it("the fixed layout shows it at hero size too", () => {
    const plan = traditionalPlan({ bigger: ["team", "invoices"] });
    expect(plan.placements.find((p) => p.id === "invoices")).toMatchObject({ size: "hero", bigger: true, reason: "Made bigger by you" });
    expect(plan.placements.find((p) => p.id === "team")).toMatchObject({ size: "hero", bigger: true });
    expect(plan.placements.filter((p) => !p.bigger).every((p) => p.size === "standard")).toBe(true);
  });
});

describe("the front group (Move pinned and bigger panels to the front)", () => {
  const weights = { relevance: 1, usage: 0, goal: 0 };
  // Tasks pinned as a summary tile, then Team made bigger, then Notes pinned: newest first.
  const front: PanelId[] = ["notes", "team", "tasks"];
  const pinned: PanelId[] = ["tasks", "notes"];
  const previous = (): LayoutPlan => {
    const plan = editPlan(traditionalPlan({ opened: ["team", "notes"] }), { kind: "bigger", panel: "team" });
    return {
      ...plan,
      placements: plan.placements.map((p) => (p.id === "tasks" ? { ...p, size: "compact", pinned: true } : p.id === "notes" ? { ...p, pinned: true } : p)),
    };
  };
  const low = { rel: { ...REL, notes: 0, team: 0, tasks: 0 }, layout: layout("focus", 0.9) };
  const sizes = (plan: LayoutPlan) => plan.placements.slice(0, 3).map((p) => p.size);

  it("leads every round in exactly the store's order, a pin at its own size, whatever Jev rates it", () => {
    let plan = computePlan(input({ weights, j: low, previous: previous(), pinned, bigger: ["team"], front }));
    expect(ids(plan).slice(0, 3)).toEqual(front);
    expect(sizes(plan)).toEqual(["standard", "hero", "compact"]);
    for (const [round, mode] of (["compare", "overview", "focus"] as const).entries()) {
      plan = computePlan(input({ weights, j: { ...low, layout: layout(mode, 0.9) }, previous: plan, pinned, bigger: ["team"], front, now: NOW + (round + 1) * 60_000 }));
      expect(plan.mode).toBe(mode);
      expect(ids(plan).slice(0, 3)).toEqual(front);
      expect(sizes(plan)).toEqual(["standard", "hero", "compact"]);
    }
    // Without it, the older rules: pins first in pin order, sized by their slots.
    const older = computePlan(input({ weights, j: low, previous: previous(), pinned, bigger: ["team"] }));
    expect(ids(older).slice(0, 2)).toEqual(["tasks", "notes"]);
    expect(older.placements[0].size).toBe("hero");
  });

  it("gives the panels after it the mode's slots as if they led, so Focus still has the policy's hero", () => {
    const plan = computePlan(input({ weights, j: low, previous: previous(), pinned, bigger: ["team"], front }));
    expect(plan.placements[3]).toMatchObject({ id: "invoices", size: "hero" });
    expect(plan.placements[4]).toMatchObject({ size: "standard" });
  });

  it("follows a command's hero in its order, a pin at its own size", () => {
    const base = computePlan(input({ weights, j: low, previous: previous(), pinned, bigger: ["team"], front }));
    const plan = applyPromotion({ plan: base, previous: base, panel: "clients", pinned, bigger: ["team"], front });
    expect(ids(plan).slice(0, 4)).toEqual(["clients", "notes", "team", "tasks"]);
    expect(plan.placements.slice(0, 4).map((p) => p.size)).toEqual(["hero", "standard", "hero", "compact"]);
    expect(plan.placements[4]).toMatchObject({ size: "standard" });
  });

  it("an edit and the fixed layout put the front group first without resizing anything", () => {
    const edited = editPlan(defaultPlan(), { kind: "pin", panel: "invoices" }, { front: ["invoices"] });
    expect(ids(edited)[0]).toBe("invoices");
    expect(edited.placements.every((p) => p.size === "standard")).toBe(true);
    const big = editPlan(edited, { kind: "bigger", panel: "projects" }, { front: ["projects", "invoices"] });
    expect(ids(big).slice(0, 2)).toEqual(["projects", "invoices"]);
    expect(big.placements[0]).toMatchObject({ size: "hero", bigger: true });
    const fixed = traditionalPlan({ pinned, bigger: ["team"], opened: ["team", "notes"], front });
    expect(ids(fixed).slice(0, 3)).toEqual(front);
  });
});
