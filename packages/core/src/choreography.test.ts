import { describe, expect, it } from "vitest";
import {
  ENTER_STAGGER_MS,
  STAGE_ENTER,
  STAGE_EXIT,
  STAGE_GROW,
  STAGE_MOVE,
  cueFor,
  joinTitles,
  linkAnnouncement,
  noteText,
  roundCues,
  stageTransition,
  type StagedPlan,
} from "./choreography.ts";
import type { ChangeSummary, GridCell } from "./grid.ts";

/** Panel ids and titles like the demo app's, so these cases read like real rounds. */
const TITLES = { inbox: "Inbox", calendar: "Calendar", tasks: "Tasks", invoices: "Invoices", clients: "Clients", projects: "Projects", team: "Team" } as const;
type PanelId = keyof typeof TITLES;
const titleOf = (id: PanelId): string => TITLES[id];

type Placement = StagedPlan<PanelId>["placements"][number];
type Plan = Omit<StagedPlan<PanelId>, "placements"> & { placements: Placement[] };

const place = (id: PanelId): Placement => ({ id });

function plan(args: {
  ids: PanelId[];
  cells: Partial<Record<PanelId, GridCell>>;
  summary?: Partial<ChangeSummary<PanelId>>;
  anchor?: PanelId;
  round?: number;
}): Plan {
  return {
    placements: args.ids.map(place),
    grid: { columns: 4, cells: args.cells },
    round: args.round ?? 1,
    ...(args.anchor ? { anchor: { panel: args.anchor } } : {}),
    ...(args.summary ? { changeSummary: { added: [], docked: [], moved: [], grew: [], shrank: [], ...args.summary } } : {}),
  };
}

const c = (col: number, row: number, w = 1, h = 2): GridCell => ({ col, row, w, h });

describe("roundCues", () => {
  it("on one column, moves the cards an anchor's growth pushes down together with the growth", () => {
    const list = plan({
      ids: ["inbox", "tasks", "calendar"],
      cells: { inbox: c(0, 0, 1, 3), tasks: c(0, 3, 1, 5), calendar: c(0, 8, 1, 3) },
      anchor: "tasks",
      summary: { grew: ["tasks"], moved: ["calendar"] },
    });
    const r = roundCues({ ...list, grid: { ...list.grid!, columns: 1 } });
    expect(cueFor(r, "tasks")?.stage).toEqual(STAGE_GROW);
    expect(cueFor(r, "calendar")?.stage).toEqual({ delayMs: STAGE_GROW.delayMs, durationMs: STAGE_MOVE.durationMs });
    // On 4 columns a move still waits for the growth.
    expect(cueFor(roundCues(list), "calendar")?.stage).toEqual(STAGE_MOVE);
  });

  it("on 2 and 4 columns, moves the cards a panel the user made bigger pushes together with its growth", () => {
    const grid = plan({
      ids: ["inbox", "tasks", "calendar", "clients"],
      cells: { inbox: c(0, 0, 2, 4), tasks: c(2, 0), calendar: c(0, 4), clients: c(1, 4) },
      anchor: "inbox",
      summary: { grew: ["inbox"], moved: ["calendar", "clients"] },
    });
    const bigger = { ...grid, placements: grid.placements.map((p) => (p.id === "inbox" ? { ...p, bigger: true } : p)) };
    const r = roundCues(bigger);
    expect(cueFor(r, "inbox")?.stage).toEqual(STAGE_GROW);
    for (const id of ["calendar", "clients"] as PanelId[]) expect(cueFor(r, id)?.stage).toEqual({ delayMs: STAGE_GROW.delayMs, durationMs: STAGE_MOVE.durationMs });
    expect(cueFor(r, "tasks")?.role).toBe("still");
    // An anchor the policy grew into free cells still grows first, then the moves.
    expect(cueFor(roundCues(grid), "calendar")?.stage).toEqual(STAGE_MOVE);
  });

  it("stages nothing without a change summary, or with an empty one (a resize)", () => {
    expect(roundCues(plan({ ids: ["inbox"], cells: { inbox: c(0, 0) } })).staged).toBe(false);
    const empty = roundCues(plan({ ids: ["inbox"], cells: { inbox: c(0, 0) }, summary: {} }));
    expect(empty.staged).toBe(false);
    expect(cueFor(empty, "inbox")).toBeUndefined();
  });

  it("grows the anchor first, then exits, moves, and entries in that order", () => {
    const r = roundCues(
      plan({
        ids: ["invoices", "tasks", "inbox"],
        cells: { invoices: c(0, 0, 2, 4), tasks: c(2, 0), inbox: c(2, 2) },
        anchor: "invoices",
        summary: { grew: ["invoices"], moved: ["tasks"], added: ["inbox"], docked: ["calendar"] },
      }),
    );
    expect(r.staged).toBe(true);
    expect(cueFor(r, "invoices")).toEqual({ role: "anchor", stage: STAGE_GROW });
    expect(cueFor(r, "tasks")).toEqual({ role: "moved", stage: STAGE_MOVE });
    expect(cueFor(r, "inbox")?.role).toBe("entering");
    expect(cueFor(r, "inbox")?.stage.delayMs).toBe(STAGE_ENTER.delayMs);
    expect(r.docked).toEqual(["calendar"]);
    expect(STAGE_GROW.delayMs).toBeLessThan(STAGE_EXIT.delayMs);
    expect(STAGE_EXIT.delayMs).toBeLessThan(STAGE_MOVE.delayMs);
    expect(STAGE_MOVE.delayMs).toBeLessThan(STAGE_ENTER.delayMs);
    expect(r.settleMs).toBe(STAGE_ENTER.delayMs + STAGE_ENTER.durationMs);
  });

  it("brings newcomers in nearest the anchor first, one stagger apart, aimed away from it", () => {
    const r = roundCues(
      plan({
        ids: ["projects", "team", "clients"],
        cells: { projects: c(0, 0), team: c(3, 4), clients: c(1, 0) },
        anchor: "projects",
        summary: { added: ["team", "clients"] },
      }),
    );
    expect(r.entering).toEqual(["clients", "team"]);
    expect(cueFor(r, "clients")?.stage.delayMs).toBe(STAGE_ENTER.delayMs);
    expect(cueFor(r, "team")?.stage.delayMs).toBe(STAGE_ENTER.delayMs + ENTER_STAGGER_MS);
    // Clients sits straight to the right of the anchor, so it slides out rightward.
    const from = cueFor(r, "clients")?.from;
    expect(from?.x).toBeCloseTo(1);
    expect(from?.y).toBeCloseTo(0);
    expect(r.settleMs).toBe(STAGE_ENTER.delayMs + ENTER_STAGGER_MS + STAGE_ENTER.durationMs);
  });

  it("leaves a still anchor and untouched cards still", () => {
    const r = roundCues(
      plan({ ids: ["inbox", "tasks", "team"], cells: { inbox: c(0, 0), tasks: c(1, 0), team: c(2, 0) }, anchor: "inbox", summary: { added: ["team"] } }),
    );
    expect(cueFor(r, "inbox")?.role).toBe("anchor");
    expect(cueFor(r, "tasks")?.role).toBe("still");
  });

  it("lets a command's hero that came from the dock enter first", () => {
    const r = roundCues(plan({ ids: ["clients", "inbox"], cells: { clients: c(0, 0, 2, 4), inbox: c(2, 0) }, anchor: "clients", summary: { added: ["clients"] } }));
    expect(cueFor(r, "clients")).toEqual({ role: "entering", stage: { delayMs: 0, durationMs: STAGE_ENTER.durationMs } });
    expect(r.entering).toEqual([]);
  });

  it("carries the plan's round", () => {
    expect(roundCues(plan({ ids: ["inbox"], cells: { inbox: c(0, 0) }, round: 7, summary: { moved: ["inbox"] } })).round).toBe(7);
  });
});

describe("helpers", () => {
  it("joins panel titles the way the note reads", () => {
    expect(joinTitles(["Inbox"])).toBe("Inbox");
    expect(joinTitles(["Inbox", "Clients"])).toBe("Inbox and Clients");
    expect(joinTitles(["Inbox", "Clients", "Projects"])).toBe("Inbox, Clients, and Projects");
  });

  it("turns a stage into a motion tween in seconds", () => {
    expect(stageTransition(STAGE_MOVE)).toEqual({ type: "tween", delay: 0.25, duration: 0.35, ease: [0.2, 0, 0, 1] });
  });
});

describe("link words", () => {
  const relation = { anchorPanel: "invoices" as const, tag: "Linked to INV-1042", reason: "1 message from Harbor Coffee Co.", records: [{ itemKind: "message" as const, itemId: "m-1", label: "Priya" }] };

  it("builds the note's sentence", () => {
    expect(noteText(["inbox", "clients"], "Harbor Coffee Co.", titleOf)).toBe("Added Inbox and Clients for Harbor Coffee Co.");
    expect(noteText(["team"], undefined, titleOf)).toBe("Added Team");
  });

  it("tells a screen reader what the round added for the link, then every linked panel", () => {
    const p = plan({ ids: ["invoices", "inbox", "clients"], cells: {}, summary: { added: ["inbox"] }, anchor: "invoices" });
    const linked: Plan = {
      ...p,
      anchor: { panel: "invoices", client: "Harbor Coffee Co.", label: "INV-1042" },
      placements: p.placements.map((x) => (x.id === "invoices" ? x : { ...x, relation })),
    };
    expect(linkAnnouncement(linked, titleOf)).toBe("Added Inbox for Harbor Coffee Co. Linked panels: Inbox and Clients");
    expect(linkAnnouncement({ ...linked, changeSummary: { added: [], docked: [], moved: [], grew: [], shrank: [] } }, titleOf)).toBe("Linked panels: Inbox and Clients");
    expect(linkAnnouncement(p, titleOf)).toBe("");
  });
});
