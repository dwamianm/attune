/**
 * Policy rules for the anchored relayout (docs/anchored-relayout.md): the
 * anchor stays, what is before it on screen stays, newcomers go after it, and
 * panels holding records linked to the anchor get a small boost and a tag.
 */
import { describe, expect, it } from "vitest";
import type { LayoutMode, PanelId } from "../../shared/catalog.ts";
import { EVENTS, INVOICES, MESSAGES, PROJECTS, TASKS } from "../../shared/fixtures.ts";
import type { AnchorRef, LayoutPlan } from "../../shared/types.ts";
import type { AppData, PolicyInput } from "./contract.ts";
import { LINK_PRIORITY_BOOST, LINKED_PANELS_MAX, packGrid, SIZE_RANK } from "@attuneui/core";
import { applyPromotion, computePlan, defaultPlan, remarkPanels, scorePanels } from "./policy.ts";
import { findLinked } from "./relations.ts";
import { choiceJ, makeJudgments, type JudgmentOverrides } from "./test-helpers.ts";

const NOW = 10_000_000;
const DATA: AppData = {
  invoices: INVOICES,
  messages: MESSAGES,
  tasks: TASKS,
  projects: PROJECTS,
  events: EVENTS,
  notes: "",
};

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

const layout = (mode: LayoutMode) => choiceJ<LayoutMode>(mode, 0.9, { [mode]: 0.9 });
const ids = (plan: LayoutPlan) => plan.placements.map((p) => p.id);
const placement = (plan: LayoutPlan, id: PanelId) => plan.placements.find((p) => p.id === id);

function input(o: Partial<PolicyInput> & { j?: JudgmentOverrides } = {}): PolicyInput {
  return {
    judgments: o.judgments ?? makeJudgments(o.j),
    version: 1,
    previous: o.previous ?? gridded(defaultPlan()),
    events: [],
    now: NOW,
    weights: { relevance: 0.5, usage: 0.25, goal: 0.25 },
    pinned: o.pinned ?? [],
    dismissed: o.dismissed ?? {},
    focusedPanel: null,
    recentModes: [],
    ...(o.anchor !== undefined ? { anchor: o.anchor } : {}),
    ...(o.linked ? { linked: o.linked } : {}),
    ...(o.hold ? { hold: o.hold } : {}),
    ...(o.linkHold ? { linkHold: o.linkHold } : {}),
  };
}

function work(panel: PanelId, rest: Partial<AnchorRef> = {}): AnchorRef {
  return { panel, at: NOW - 500, source: "work", ...rest };
}

describe("anchored round", () => {
  it("keeps the anchor on the canvas at its size even when Jev rates it useless", () => {
    const plan = computePlan(input({ j: { rel: { inbox: 2, calendar: 2, tasks: 2, invoices: 0, clients: 2, projects: 2, team: 2 }, layout: layout("focus") }, anchor: work("invoices") }));
    expect(placement(plan, "invoices")).toMatchObject({ size: "standard", anchor: true });
    expect(plan.anchor).toMatchObject({ panel: "invoices" });
  });

  it("keeps what is before the anchor in its order and size, and puts newcomers after it", () => {
    // Clients at (0, 2) is the anchor: Inbox, Calendar, Tasks, and Invoices are above it.
    const plan = computePlan(input({ j: { rel: { team: 2, invoices: 0.2, clients: 1.4, analytics: 2 }, layout: layout("focus") }, anchor: work("clients") }));
    expect(ids(plan).slice(0, 5)).toEqual(["inbox", "calendar", "tasks", "invoices", "clients"]);
    for (const id of ["inbox", "calendar", "tasks", "invoices"] as PanelId[]) expect(placement(plan, id)?.size).toBe("standard");
    const shown = ids(defaultPlan());
    const newcomers = ids(plan).filter((id) => !shown.includes(id));
    expect(newcomers.length).toBeGreaterThan(0);
    for (const id of newcomers) expect(ids(plan).indexOf(id)).toBeGreaterThan(ids(plan).indexOf("clients"));
    // Without the anchor, the same judgments put Team (or Revenue) first as the hero.
    const free = computePlan(input({ j: { rel: { team: 2, invoices: 0.2, clients: 1.4, analytics: 2 }, layout: layout("focus") } }));
    expect(["team", "analytics"]).toContain(ids(free)[0]);
  });

  it("lets the anchor ask for the size it would get as the top panel", () => {
    const plan = computePlan(input({ j: { rel: { inbox: 2, invoices: 1 }, layout: layout("focus") }, anchor: work("inbox") }));
    expect(placement(plan, "inbox")?.size).toBe("hero");
    const second = computePlan(input({ j: { rel: { tasks: 2, invoices: 1 }, layout: layout("focus") }, anchor: work("tasks") }));
    // Tasks would lead, so it asks for hero; the packer decides whether there is room.
    expect(placement(second, "tasks")?.size).toBe("hero");
    expect(ids(second)[0]).toBe("inbox");
  });

  it("does not hold anything when the anchor was not on the canvas", () => {
    const plan = computePlan(input({ j: { rel: { invoices: 2 }, layout: layout("focus") }, anchor: work("team") }));
    expect(ids(plan)[0]).toBe("invoices");
  });

  it("keeps the panel under the pointer on the canvas", () => {
    const rel = { invoices: 2, clients: 1.4, inbox: 1.2, calendar: 0.8, tasks: 0.8 };
    const without = computePlan(input({ j: { rel, layout: layout("focus") } }));
    expect(ids(without)).not.toContain("projects");
    const held = computePlan(input({ j: { rel, layout: layout("focus") }, hold: ["projects"] }));
    expect(ids(held)).toContain("projects");
  });
});

describe("linked panels", () => {
  const atlas = work("clients", { itemKind: "client", itemId: "c-atlas", client: "Atlas Robotics", label: "Atlas Robotics" });
  // Team holds a linked record (Sam leads the Atlas pitch deck). At 0.7 of 2 it
  // scores 0.175: below the 0.22 join line alone, above it with the boost.
  const rel = { clients: 2, team: 0.7, inbox: 0.2, invoices: 0.2, tasks: 0.2, projects: 0.2, calendar: 0.8 };

  it("boosts a linked panel Jev rates a little useful past the join line, and tags it", () => {
    const base = scorePanels({ judgments: makeJudgments({ rel }), events: [], now: NOW, weights: { relevance: 0.5, usage: 0.25, goal: 0.25 }, pinned: [] });
    expect(base.team.priority).toBeLessThan(0.22);
    expect(base.team.priority + LINK_PRIORITY_BOOST).toBeGreaterThanOrEqual(0.22);

    const linked = findLinked(atlas, DATA);
    const plan = computePlan(input({ j: { rel, layout: layout("overview") }, anchor: atlas, linked }));
    expect(ids(plan)).toContain("team");
    expect(placement(plan, "team")?.relation).toMatchObject({ anchorPanel: "clients", tag: "Linked to Atlas Robotics", reason: "1 person on Pitch deck" });
    expect(placement(plan, "team")?.reason).toBe("Linked to Atlas Robotics: 1 person on Pitch deck");
    expect(plan.decisions.find((d) => d.panel === "team")?.evidence).toContain("linked to Atlas Robotics +0.12");

    // The same judgments without the anchor leave Team in the dock: Jev decides.
    expect(ids(computePlan(input({ j: { rel, layout: layout("overview") } })))).not.toContain("team");
  });

  it("does not lift a panel Jev rates useless", () => {
    const plan = computePlan(input({ j: { rel: { ...rel, team: 0.1 }, layout: layout("overview") }, anchor: atlas, linked: findLinked(atlas, DATA) }));
    expect(ids(plan)).not.toContain("team");
  });

  it("links at most three panels, the highest priority ones", () => {
    const linked = findLinked(atlas, DATA);
    expect(Object.keys(linked).length).toBeGreaterThan(LINKED_PANELS_MAX);
    const plan = computePlan(input({ j: { rel: { clients: 2, inbox: 1.6, invoices: 1.4, projects: 1.2, tasks: 1, team: 0.8 }, layout: layout("overview") }, anchor: atlas, linked }));
    expect(plan.placements.filter((p) => p.relation).map((p) => p.id).sort()).toEqual(["inbox", "invoices", "projects"]);
  });

  it("tags a panel this round added before the ones already shown", () => {
    const linked = findLinked(atlas, DATA);
    // Team joins on its own (0.3 is past the join line) and is less useful than Inbox or Invoices.
    const plan = computePlan(input({ j: { rel: { clients: 2, inbox: 1.6, invoices: 1.4, projects: 1.2, tasks: 1, team: 1.2 }, layout: layout("overview") }, anchor: atlas, linked }));
    expect(ids(plan)).toContain("team");
    expect(plan.placements.filter((p) => p.relation).map((p) => p.id).sort()).toEqual(["inbox", "invoices", "team"]);
  });

  it("keeps a panel on the canvas that shows a linked record, even without a tag", () => {
    const linked = findLinked(atlas, DATA);
    expect(linked.projects?.length).toBeGreaterThan(0);
    // Projects (after the anchor, so not locked) is rated useless and is the fourth linked panel.
    const judged = { clients: 2, inbox: 1.6, invoices: 1.4, tasks: 1, team: 1.2, projects: 0 };
    const plan = computePlan(input({ j: { rel: judged, layout: layout("overview") }, anchor: atlas, linked }));
    expect(ids(plan)).toContain("projects");
    expect(placement(plan, "projects")?.relation).toBeUndefined();
    expect(plan.placements.filter((p) => p.relation)).toHaveLength(LINKED_PANELS_MAX);
    // Without the link, the same judgments send it to the dock.
    expect(ids(computePlan(input({ j: { rel: judged, layout: layout("overview") }, anchor: atlas })))).not.toContain("projects");
  });

  it("shows a linked panel at least standard size, so its tint has rows", () => {
    const plan = computePlan(input({ j: { rel: { clients: 2, inbox: 1.6, invoices: 1.4, projects: 1.2 }, layout: layout("focus") }, anchor: atlas, linked: findLinked(atlas, DATA) }));
    for (const p of plan.placements.filter((x) => x.relation)) expect(SIZE_RANK[p.size]).toBeGreaterThanOrEqual(SIZE_RANK.standard);
  });

  it("never links the anchor's own panel", () => {
    const plan = computePlan(input({ j: { rel: { clients: 2, inbox: 1.6 } }, anchor: atlas, linked: findLinked(atlas, DATA) }));
    expect(placement(plan, "clients")?.relation).toBeUndefined();
  });
});

describe("command anchor", () => {
  const harbor: AnchorRef = { panel: "invoices", client: "Harbor Coffee Co.", label: "Harbor Coffee Co.", at: NOW, source: "command" };

  it("locks nothing, but links and flags the hero", () => {
    const linked = findLinked(harbor, DATA);
    const plan = computePlan(input({ j: { rel: { invoices: 2, clients: 1.4, inbox: 1.2 }, layout: layout("focus") }, anchor: harbor, linked }));
    const promoted = applyPromotion({ plan, previous: plan, panel: "invoices", pinned: [] });
    expect(promoted.placements[0]).toMatchObject({ id: "invoices", size: "hero", anchor: true });
    expect(promoted.anchor).toEqual(harbor);
    // Linked panels come right after the hero, at least standard.
    const withRelation = promoted.placements.filter((p) => p.relation);
    expect(withRelation.length).toBeGreaterThan(0);
    expect(promoted.placements.slice(1, 1 + withRelation.length).every((p) => p.relation)).toBe(true);
    for (const p of withRelation) expect(SIZE_RANK[p.size]).toBeGreaterThanOrEqual(SIZE_RANK.standard);
  });

  it("links on a picked option too, when the plan was built before the anchor", () => {
    const plan = computePlan(input({ j: { rel: { invoices: 2, clients: 1.4, inbox: 1.2 } } }));
    const promoted = applyPromotion({ plan, previous: plan, panel: "invoices", pinned: [], anchor: harbor, linked: findLinked(harbor, DATA) });
    expect(placement(promoted, "clients")?.relation?.tag).toBe("Linked to Harbor Coffee Co.");
  });
});

describe("command hold with a work anchor", () => {
  it("never docks the panel the user is working in, even past the cap", () => {
    // Seven panels in Overview; the user works in the last one while a command's promotion is re-applied.
    const previous = gridded(computePlan(input({ j: { rel: { inbox: 2, calendar: 2, tasks: 2, invoices: 2, clients: 2, projects: 2, team: 1.5 }, layout: layout("overview") } })));
    expect(ids(previous)).toHaveLength(7);
    const last = ids(previous)[6];
    const plan = computePlan(input({ previous, j: { rel: { inbox: 2, calendar: 2, tasks: 2, invoices: 2, clients: 2, projects: 2, team: 1.5 }, layout: layout("overview") }, anchor: work(last) }));
    const promoted = applyPromotion({ plan, previous, panel: "calendar", pinned: [] });
    expect(ids(promoted)).toContain(last);
    expect(placement(promoted, last)?.anchor).toBe(true);
  });
});

describe("links on screen (linkHold)", () => {
  // Clients was clicked a while ago and Inbox shows a message linked to it; the
  // anchor is gone, and Jev now rates both useless while six others are useful.
  const judged = { inbox: 0, clients: 0, calendar: 2, tasks: 2, invoices: 2, projects: 2, team: 2, analytics: 2 };

  it("keeps the source and the linked panels on the canvas, at least standard, with no anchor", () => {
    const free = computePlan(input({ j: { rel: judged, layout: layout("focus") } }));
    expect(ids(free)).not.toContain("inbox");
    expect(ids(free)).not.toContain("clients");
    const held = computePlan(input({ j: { rel: judged, layout: layout("focus") }, linkHold: { source: "clients", linked: ["inbox"] } }));
    expect(ids(held)).toEqual(expect.arrayContaining(["clients", "inbox"]));
    for (const id of ["clients", "inbox"] as PanelId[]) expect(SIZE_RANK[placement(held, id)!.size]).toBeGreaterThanOrEqual(SIZE_RANK.standard);
    // A panel the user docked is not kept.
    const docked = computePlan(input({ j: { rel: judged, layout: layout("focus") }, dismissed: { inbox: NOW - 1_000 }, linkHold: { source: "clients", linked: ["inbox"] } }));
    expect(ids(docked)).toContain("clients");
    expect(ids(docked)).not.toContain("inbox");
  });

  it("keeps them past a command's cap too", () => {
    const rel = { inbox: 2, calendar: 2, tasks: 2, invoices: 2, clients: 2, projects: 2, team: 1.5 };
    const previous = gridded(computePlan(input({ j: { rel, layout: layout("overview") } })));
    const last = ids(previous)[6];
    expect(ids(applyPromotion({ plan: previous, previous, panel: "calendar", pinned: [] }))).not.toContain(last);
    const promoted = applyPromotion({ plan: previous, previous, panel: "calendar", pinned: [], linkHold: { source: "inbox", linked: [last] } });
    expect(ids(promoted)).toContain(last);
    expect(SIZE_RANK[placement(promoted, last)!.size]).toBeGreaterThanOrEqual(SIZE_RANK.standard);
  });
});

describe("remarkPanels", () => {
  it("reads moves from cells: a card that kept its cell did not move, whatever its order", () => {
    const before = gridded(defaultPlan());
    // Same cells, Calendar and Inbox swapped in order.
    const swapped: LayoutPlan = { ...before, placements: [before.placements[1], before.placements[0], ...before.placements.slice(2)] };
    const marked = remarkPanels(before, swapped, { previousCells: before.grid!.cells, decisions: true });
    expect(marked.placements.every((p) => p.change === null)).toBe(true);
    expect(marked.decisions).toEqual([]);
  });

  it("reports a card whose cell changed, keeps leading decisions, and drops a resize the packer undid", () => {
    const before = gridded(defaultPlan());
    const cells = { ...before.grid!.cells, projects: { col: 2, row: 2, w: 1, h: 2 } };
    const next: LayoutPlan = {
      ...before,
      grid: { ...before.grid!, cells },
      decisions: [
        { kind: "mode", text: "Switched to the Focus layout" },
        { kind: "promote", panel: "invoices", text: "Made Invoices bigger", evidence: "relevance 2" },
        { kind: "suggest", text: "Suggested: Send a reminder" },
      ],
    };
    const marked = remarkPanels(before, next, { previousCells: before.grid!.cells, decisions: true });
    expect(marked.decisions.map((d) => d.text)).toEqual(["Switched to the Focus layout", "Moved Projects down", "Suggested: Send a reminder"]);
    expect(placement(marked, "projects")?.change).toBe("demoted");
    // Badges only: the decisions stay as they were.
    expect(remarkPanels(before, next, { previousCells: before.grid!.cells, decisions: false }).decisions).toBe(next.decisions);
  });
});
