/**
 * Focus aid 1, "Fade panels that do not matter now" (docs/focus-aids.md):
 * the pure quiet rule (./quiet.ts) and what the policy does with quiet
 * panels (./policy.ts).
 */
import { describe, expect, it } from "vitest";
import type { GoalId, LayoutMode, PanelId } from "../../shared/catalog.ts";
import type { AnchorRef, LayoutPlan } from "../../shared/types.ts";
import type { PolicyInput } from "./contract.ts";
import { packGrid } from "./grid.ts";
import { UNQUIET_REASON, applyPromotion, computePlan, defaultPlan, editPlan } from "./policy.ts";
import {
  QUIET_BELOW,
  QUIET_EXIT_ABOVE,
  QUIET_RECENT_USE_MS,
  QUIET_ROUNDS,
  countQuietRound,
  emptyQuietTrack,
  isQuietTouch,
  quietPanels,
  quietReason,
  shownQuiet,
  touchQuiet,
  type QuietContext,
  type QuietTrack,
} from "./quiet.ts";
import { choiceJ, ev, makeJudgments, type JudgmentOverrides } from "./test-helpers.ts";

const NOW = 50_000_000;

/** Relevance as a share of the scale (0..1); makeJudgments uses a 0..2 scale. Missing panels get 0. */
function rel(shares: Partial<Record<PanelId, number>>) {
  const scores = Object.fromEntries(Object.entries(shares).map(([id, share]) => [id, (share ?? 0) * 2])) as Partial<Record<PanelId, number>>;
  return makeJudgments({ rel: scores }).relevance;
}

/** Every panel at a middle relevance, `low` panels at `share`. */
function round(track: QuietTrack, version: number, low: PanelId[], share = 0.1): QuietTrack {
  const shares: Partial<Record<PanelId, number>> = { inbox: 0.8, calendar: 0.8, tasks: 0.8, invoices: 0.8, clients: 0.8, projects: 0.8, analytics: 0.8, team: 0.8, notes: 0.8, help: 0.8 };
  for (const id of low) shares[id] = share;
  return countQuietRound(track, rel(shares), version);
}

function ctx(o: Partial<QuietContext> = {}): QuietContext {
  return {
    onCanvas: ["inbox", "calendar", "tasks", "invoices", "clients", "projects"],
    anchor: null,
    linked: [],
    pinned: [],
    bigger: [],
    focused: null,
    pointer: null,
    upNext: null,
    events: [],
    now: NOW,
    ...o,
  };
}

/** Team quiet by relevance after QUIET_ROUNDS low rounds. */
function teamQuiet(): QuietTrack {
  let t = emptyQuietTrack();
  for (let v = 1; v <= QUIET_ROUNDS; v++) t = round(t, v, ["team"]);
  return t;
}

describe("the quiet rule", () => {
  it("makes a panel quiet only after two low rounds in a row", () => {
    expect(QUIET_ROUNDS).toBe(2);
    const one = round(emptyQuietTrack(), 1, ["team"]);
    expect(one.quiet).toEqual([]);
    expect(one.low.team).toBe(1);
    const two = round(one, 2, ["team"]);
    expect(two.quiet).toEqual(["team"]);
    // A round in between that is not low starts the count again.
    let t = round(emptyQuietTrack(), 1, ["team"]);
    t = round(t, 2, ["team"], QUIET_BELOW + 0.05);
    t = round(t, 3, ["team"]);
    expect(t.quiet).toEqual([]);
    expect(t.low.team).toBe(1);
  });

  it("uses the named threshold: just below it is low, at it is not", () => {
    let t = round(emptyQuietTrack(), 1, ["team"], QUIET_BELOW - 0.01);
    t = round(t, 2, ["team"], QUIET_BELOW - 0.01);
    expect(t.quiet).toEqual(["team"]);
    let u = round(emptyQuietTrack(), 1, ["team"], QUIET_BELOW);
    u = round(u, 2, ["team"], QUIET_BELOW);
    expect(u.quiet).toEqual([]);
  });

  it("keeps a quiet panel quiet inside the band and brings it back above it", () => {
    expect(QUIET_EXIT_ABOVE).toBeGreaterThan(QUIET_BELOW);
    let t = teamQuiet();
    t = round(t, 3, ["team"], (QUIET_BELOW + QUIET_EXIT_ABOVE) / 2);
    expect(t.quiet).toEqual(["team"]);
    t = round(t, 4, ["team"], QUIET_EXIT_ABOVE);
    expect(t.quiet).toEqual(["team"]);
    t = round(t, 5, ["team"], QUIET_EXIT_ABOVE + 0.05);
    expect(t.quiet).toEqual([]);
    // Back to low: two new low rounds are needed again.
    t = round(t, 6, ["team"]);
    expect(t.quiet).toEqual([]);
    t = round(t, 7, ["team"]);
    expect(t.quiet).toEqual(["team"]);
  });

  it("counts a round once, and a panel with no usable answer is neither low nor quiet", () => {
    const t = teamQuiet();
    expect(round(t, 2, [])).toBe(t);
    const relevance = rel({ inbox: 0.8 });
    delete (relevance as Partial<typeof relevance>).team;
    const next = countQuietRound(t, relevance, 3);
    expect(next.quiet).not.toContain("team");
    expect(next.low.team).toBeUndefined();
  });

  it("forgets a panel the user touched, so it needs two new low rounds", () => {
    let t = touchQuiet(teamQuiet(), "team");
    expect(t.quiet).toEqual([]);
    expect(t.low.team).toBeUndefined();
    t = round(t, 3, ["team"]);
    expect(t.quiet).toEqual([]);
    t = round(t, 4, ["team"]);
    expect(t.quiet).toEqual(["team"]);
  });

  it("counts clicks, record opens, scrolls, and actions as a touch, but not hover, keyboard focus, or docking", () => {
    expect(isQuietTouch({ type: "panel_focus", panel: "team", detail: { via: "pointer" } })).toBe(true);
    expect(isQuietTouch({ type: "item_open", panel: "team" })).toBe(true);
    expect(isQuietTouch({ type: "scroll", panel: "team" })).toBe(true);
    expect(isQuietTouch({ type: "action", panel: "team" })).toBe(true);
    expect(isQuietTouch({ type: "panel_pin", panel: "team" })).toBe(true);
    expect(isQuietTouch({ type: "panel_dwell", panel: "team", detail: { durationMs: 4_000 } })).toBe(false);
    expect(isQuietTouch({ type: "panel_focus", panel: "team", detail: { via: "keyboard" } })).toBe(false);
    expect(isQuietTouch({ type: "panel_dismiss", panel: "team" })).toBe(false);
    expect(isQuietTouch({ type: "setting_change", detail: { setting: "fadeQuiet", enabled: false } })).toBe(false);
  });
});

describe("quiet panels now: every exemption", () => {
  const onCanvas: PanelId[] = ["inbox", "team", "invoices"];
  const t = teamQuiet();

  it("is quiet on the canvas with nothing to exempt it", () => {
    expect(quietPanels(t, ctx({ onCanvas }))).toEqual(["team"]);
    // Not on the canvas: nothing to fade.
    expect(quietPanels(t, ctx({ onCanvas: ["inbox"] }))).toEqual([]);
  });

  it.each<[string, Partial<QuietContext>]>([
    ["the anchor", { anchor: "team" }],
    ["a linked panel", { linked: ["team"] }],
    ["a pinned panel", { pinned: ["team"] }],
    ["a panel made bigger", { bigger: ["team"] }],
    ["the focused panel", { focused: "team" }],
    ["the panel under the pointer", { pointer: "team" }],
    ["the Up next panel", { upNext: "team" }],
    ["a panel used in the last minute", { events: [ev("panel_focus", NOW - QUIET_RECENT_USE_MS + 1_000, "team", { via: "pointer" })] }],
  ])("never makes %s quiet", (_name, o) => {
    expect(quietPanels(t, ctx({ onCanvas, ...o }))).toEqual([]);
  });

  it("keeps a panel that is already quiet quiet under the pointer or focus, so hover never changes the layout", () => {
    expect(quietPanels(t, ctx({ onCanvas, pointer: "team", current: ["team"] }))).toEqual(["team"]);
    expect(quietPanels(t, ctx({ onCanvas, focused: "team", current: ["team"] }))).toEqual(["team"]);
    // The other exemptions still end it.
    expect(quietPanels(t, ctx({ onCanvas, upNext: "team", current: ["team"] }))).toEqual([]);
    expect(quietPanels(t, ctx({ onCanvas, pinned: ["team"], current: ["team"] }))).toEqual([]);
  });

  it("does not count use older than a minute, a pointer rest, or keyboard focus as use", () => {
    const events = [
      ev("item_open", NOW - QUIET_RECENT_USE_MS - 1_000, "team"),
      ev("panel_dwell", NOW - 2_000, "team", { durationMs: 3_000 }),
      ev("panel_focus", NOW - 1_000, "team", { via: "keyboard" }),
    ];
    expect(quietPanels(t, ctx({ onCanvas, events }))).toEqual(["team"]);
  });

  it("shows a quiet placement faded unless something since exempts it", () => {
    const p = { id: "team" as PanelId, quiet: true, pinned: false };
    const none = { focused: null, upNext: null, linked: new Set<PanelId>() };
    expect(shownQuiet(p, none)).toBe(true);
    expect(shownQuiet({ ...p, quiet: undefined }, none)).toBe(false);
    expect(shownQuiet({ ...p, pinned: true }, none)).toBe(false);
    expect(shownQuiet({ ...p, bigger: true }, none)).toBe(false);
    expect(shownQuiet(p, { ...none, focused: "team" })).toBe(false);
    expect(shownQuiet(p, { ...none, upNext: "team" })).toBe(false);
    expect(shownQuiet(p, { ...none, linked: new Set<PanelId>(["team"]) })).toBe(false);
  });

  it("says why in plain words", () => {
    expect(quietReason("collect_payments")).toBe("Not needed for Collecting payments right now");
    expect(quietReason("unclear")).toBe("Not needed for what you are doing right now");
    expect(quietReason(null)).toBe("Not needed for what you are doing right now");
  });
});

// ---------------------------------------------------------------------------
// The policy with quiet panels
// ---------------------------------------------------------------------------

/** A plan with the cells the canvas shows for it (dense flow at 4 columns). */
function gridded(plan: LayoutPlan): LayoutPlan {
  const r = packGrid({
    items: plan.placements.map((p) => ({ id: p.id, size: p.size, priority: p.priority, pinned: p.pinned, anchor: false, linked: false })),
    columns: 4,
    previous: null,
    hold: [],
  });
  return { ...plan, grid: { columns: 4, cells: r.cells, rows: r.rows, anchored: false } };
}

/**
 * Collecting payments in the overview layout (every card standard). Inbox
 * and Clients stay on the canvas for the goal, though Jev rates Inbox low.
 * The default canvas at 4 columns: Inbox, Calendar, Tasks, Invoices on the
 * first row, Clients and Projects below.
 */
const payments: JudgmentOverrides = {
  rel: { invoices: 2, clients: 1.4, inbox: 0.2 },
  goal: choiceJ<GoalId>("collect_payments", 0.9, { collect_payments: 0.9, unclear: 0.1 }),
  layout: choiceJ<LayoutMode>("overview", 0.9, { overview: 0.9 }),
};

function input(o: Partial<PolicyInput> = {}): PolicyInput {
  return {
    judgments: makeJudgments(payments),
    version: 3,
    previous: gridded(defaultPlan()),
    events: [],
    now: NOW,
    weights: { relevance: 0.5, usage: 0.25, goal: 0.25 },
    pinned: [],
    dismissed: {},
    focusedPanel: null,
    recentModes: [],
    ...o,
  };
}

const placement = (plan: LayoutPlan, id: PanelId) => plan.placements.find((p) => p.id === id);
const work = (panel: PanelId): AnchorRef => ({ panel, at: NOW - 500, source: "work" });

describe("the policy with quiet panels", () => {
  it("shows a quiet panel as the summary tile, remembers its size, and says why", () => {
    const plan = computePlan(input({ quiet: ["inbox"] }));
    expect(placement(plan, "inbox")).toMatchObject({
      quiet: true,
      size: "compact",
      unquietSize: "standard",
      reason: "Not needed for Collecting payments right now",
    });
    // Nothing is hidden: it stays on the canvas, and the others keep their sizes.
    expect(placement(plan, "clients")).toMatchObject({ size: "standard" });
    expect(placement(plan, "clients")?.quiet).toBeUndefined();
    expect(plan.decisions.find((d) => d.panel === "inbox")?.evidence).toContain("quiet");
  });

  it("with no quiet panels given (the aid off), plans exactly as before", () => {
    const off = computePlan(input());
    expect(computePlan(input({ quiet: [] }))).toEqual(off);
    expect(off.placements.some((p) => p.quiet || p.unquietSize)).toBe(false);
    expect(placement(off, "inbox")).toMatchObject({ size: "standard" });
  });

  it("shrinks a quiet card before the anchor in an anchored round too, since every card has an explicit cell", () => {
    // Clients at (0, 2) is the anchor; Inbox at (0, 0) is above it, so it is
    // locked. It shrinks in place (the packer keeps its top-left), so the anchor cannot move.
    const plan = computePlan(input({ quiet: ["inbox"], anchor: work("clients") }));
    expect(placement(plan, "inbox")).toMatchObject({ quiet: true, size: "compact", unquietSize: "standard" });
  });

  it("shrinks a quiet card after the anchor in an anchored round", () => {
    // Inbox at (0, 0) is the anchor, Clients at (0, 2) comes after it.
    const plan = computePlan(input({ judgments: makeJudgments({ ...payments, rel: { invoices: 2, inbox: 1.4, clients: 0.2 } }), quiet: ["clients"], anchor: work("inbox") }));
    expect(placement(plan, "clients")).toMatchObject({ quiet: true, size: "compact" });
    expect(placement(plan, "inbox")).toMatchObject({ anchor: true, size: "standard" });
    expect(placement(plan, "inbox")?.quiet).toBeUndefined();
  });

  it("never shrinks a panel the user resized, only fades it", () => {
    const events = [ev("panel_maximize", NOW - 200_000, "inbox"), ev("panel_restore", NOW - 190_000, "inbox")];
    const plan = computePlan(input({ quiet: ["inbox"], events }));
    expect(placement(plan, "inbox")).toMatchObject({ quiet: true, size: "standard" });
  });

  it("never marks the anchor, a linked panel, a pin, a bigger panel, or the pointer's card quiet", () => {
    const cases: Partial<PolicyInput>[] = [
      { anchor: work("inbox") },
      { anchor: work("invoices"), linked: { inbox: [{ itemKind: "message", itemId: "m-1", label: "Priya Nair" }] } },
      { linkHold: { source: "invoices", linked: ["inbox"] } },
      { pinned: ["inbox"] },
      { bigger: ["inbox"] },
      { hold: ["inbox"] },
    ];
    for (const c of cases) {
      const plan = computePlan(input({ quiet: ["inbox"], ...c }));
      expect(placement(plan, "inbox")?.quiet, JSON.stringify(c)).toBeUndefined();
    }
  });

  it("can make a panel quiet that holds a record joined to the anchor but has no link tag", () => {
    const rec = (itemId: string) => [{ itemKind: "message" as const, itemId, label: itemId }];
    const linked = { inbox: rec("m-1"), clients: rec("c-harbor"), tasks: rec("t-1"), projects: rec("p-1") };
    const plan = computePlan(input({ quiet: ["tasks", "projects"], anchor: work("invoices"), linked }));
    // Three panels get a tag (the link cap); the fourth, Projects, has none and may go quiet.
    expect(plan.placements.filter((p) => p.relation).map((p) => p.id).sort()).toEqual(["clients", "inbox", "tasks"]);
    expect(placement(plan, "tasks")?.quiet).toBeUndefined();
    expect(placement(plan, "projects")).toMatchObject({ quiet: true, size: "compact" });
  });

  it("brings a quiet panel back to its size when the user clicks into it", () => {
    const plan = computePlan(input({ quiet: ["inbox"] }));
    const back = editPlan(plan, { kind: "unquiet", panel: "inbox" });
    const inbox = placement(back, "inbox");
    expect(inbox).toMatchObject({ size: "standard", reason: UNQUIET_REASON });
    expect(inbox?.quiet).toBeUndefined();
    expect(inbox?.unquietSize).toBeUndefined();
    // Any other edit of the panel drops the marks too.
    expect(placement(editPlan(plan, { kind: "pin", panel: "inbox" }), "inbox")?.quiet).toBeUndefined();
  });

  it("keeps a quiet panel faded through a command, at the command's sizes", () => {
    const plan = computePlan(input({ quiet: ["inbox"] }));
    const promoted = applyPromotion({ plan, previous: plan, panel: "invoices", pinned: [] });
    const inbox = placement(promoted, "inbox");
    expect(inbox?.quiet).toBe(true);
    expect(placement(promoted, "invoices")?.quiet).toBeUndefined();
  });
});
