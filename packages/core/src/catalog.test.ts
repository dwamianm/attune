import { describe, expect, it } from "vitest";
import { CatalogError, defineCatalog, NO_ACTION, UNCLEAR_GOAL, type Catalog } from "./catalog.ts";

type P = "notes" | "tasks";
type G = "write" | "unclear";
type A = "add_task" | "none";

/** A small valid catalog. Each case breaks one thing in a copy of it. */
function valid(): Catalog<P, G, A> {
  return {
    panelIds: ["notes", "tasks"],
    panels: {
      notes: { id: "notes", title: "Notes", description: "A scratch pad.", icon: "NotebookPen", defaultVisible: true },
      tasks: { id: "tasks", title: "Tasks", description: "A to-do list.", icon: "ListChecks", defaultVisible: false },
    },
    goalIds: ["write", "unclear"],
    goals: {
      write: { label: "Writing", description: "Writing notes." },
      unclear: { label: "Not sure yet", description: "Too little activity to tell." },
    },
    actionIds: ["add_task", "none"],
    actions: {
      add_task: { id: "add_task", label: "Add a task", description: "Add a to-do item.", panel: "tasks" },
      none: { id: "none", label: "", description: "No clear next step.", panel: null },
    },
    goalPanelAffinity: { write: { notes: 1, tasks: 0.4 }, unclear: {} },
  };
}

/** The problems defineCatalog reports for a catalog, or [] when it passes. */
function problemsOf(catalog: unknown): readonly string[] {
  try {
    defineCatalog(catalog as Catalog<P, G, A>);
    return [];
  } catch (err) {
    if (err instanceof CatalogError) return err.problems;
    throw err;
  }
}

describe("defineCatalog", () => {
  it("returns a valid catalog unchanged, frozen at the top level", () => {
    const input = valid();
    const catalog = defineCatalog(input);
    expect(catalog).toEqual(input);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(catalog.panels).toBe(input.panels);
  });

  it("fixes the no-match ids", () => {
    expect(UNCLEAR_GOAL).toBe("unclear");
    expect(NO_ACTION).toBe("none");
  });

  it("needs at least one panel", () => {
    const c = valid();
    const noPanels = { ...c, panelIds: [], panels: {}, actions: { ...c.actions, add_task: { ...c.actions.add_task, panel: null } }, goalPanelAffinity: { write: {}, unclear: {} } };
    expect(problemsOf(noPanels)).toEqual(["there must be at least one panel"]);
  });

  it("finds repeated ids, missing definitions, and extra definitions", () => {
    const c = valid();
    expect(problemsOf({ ...c, panelIds: ["notes", "tasks", "notes"] })).toEqual(['panel id "notes" is listed twice']);
    expect(problemsOf({ ...c, panelIds: ["notes"] })).toEqual([
      'panel definition "tasks" is not in the panel id list',
      'action "add_task" names panel "tasks", which is not a panel id',
      'affinity for goal "write" names panel "tasks", which is not a panel id',
    ]);
    expect(problemsOf({ ...c, goalIds: ["write", "unclear", "plan"] })).toEqual(['goal "plan" has no definition', 'goal "plan" has no affinity entry (use {} for none)']);
    expect(problemsOf({ ...c, panelIds: ["notes", " tasks"] })).toContain('panel id " tasks" must be a non-empty string without surrounding spaces');
  });

  it("checks that each definition carries its own id", () => {
    const c = valid();
    expect(problemsOf({ ...c, panels: { ...c.panels, tasks: { ...c.panels.tasks, id: "notes" } } })).toEqual(['panel "tasks" has id "notes" in its definition']);
    expect(problemsOf({ ...c, actions: { ...c.actions, add_task: { ...c.actions.add_task, id: "none" } } })).toEqual(['action "add_task" has id "none" in its definition']);
  });

  it("needs the no-match goal and action, and the no-match action has no panel", () => {
    const c = valid();
    expect(problemsOf({ ...c, goalIds: ["write"], goals: { write: c.goals.write }, goalPanelAffinity: { write: {} } })).toEqual(['the goals must include "unclear", the no-match outcome']);
    expect(problemsOf({ ...c, actionIds: ["add_task"], actions: { add_task: c.actions.add_task } })).toEqual(['the actions must include "none", the no-match outcome']);
    expect(problemsOf({ ...c, actions: { ...c.actions, none: { ...c.actions.none, panel: "notes" } } })).toEqual(['action "none" must have panel null']);
  });

  it("checks that an action's panel exists", () => {
    const c = valid();
    expect(problemsOf({ ...c, actions: { ...c.actions, add_task: { ...c.actions.add_task, panel: "inbox" } } })).toEqual([
      'action "add_task" names panel "inbox", which is not a panel id',
    ]);
  });

  it("checks the goal-to-panel affinity", () => {
    const c = valid();
    expect(problemsOf({ ...c, goalPanelAffinity: { write: { notes: 1 } } })).toEqual(['goal "unclear" has no affinity entry (use {} for none)']);
    expect(problemsOf({ ...c, goalPanelAffinity: { ...c.goalPanelAffinity, write: { notes: 1.5, tasks: -0.1 } } })).toEqual([
      'affinity for goal "write" and panel "notes" must be a number from 0 to 1',
      'affinity for goal "write" and panel "tasks" must be a number from 0 to 1',
    ]);
    expect(problemsOf({ ...c, goalPanelAffinity: { ...c.goalPanelAffinity, write: { notes: Number.NaN } } })).toEqual([
      'affinity for goal "write" and panel "notes" must be a number from 0 to 1',
    ]);
    expect(problemsOf({ ...c, goalPanelAffinity: { ...c.goalPanelAffinity, plan: {} } })).toEqual(['affinity entry "plan" is not a goal id']);
  });

  it("keeps the command panel question's no-match id free", () => {
    const c = valid();
    const withUnclear = { ...c, panelIds: [...c.panelIds, "unclear"], panels: { ...c.panels, unclear: { ...c.panels.notes, id: "unclear" } } };
    expect(problemsOf(withUnclear)).toEqual(['no panel may have the id "unclear", the command panel question\'s no-match option']);
  });

  it("wants the model hints on every panel and goal, or on none", () => {
    const c = valid();
    const someExamples = { ...c, panels: { ...c.panels, notes: { ...c.panels.notes, commandExamples: ["write an idea down"] } } };
    expect(problemsOf(someExamples)).toEqual(['commandExamples is set on some panels but not on "tasks"']);
    const someNotFor = { ...c, goals: { ...c.goals, write: { ...c.goals.write, notFor: "Adding a to-do item." } } };
    expect(problemsOf(someNotFor)).toEqual(['notFor is set on some goals but not on "unclear"']);
    const all = {
      ...someExamples,
      panels: { ...someExamples.panels, tasks: { ...c.panels.tasks, commandExamples: ["add a to-do"] } },
      goals: { write: { ...c.goals.write, notFor: "Adding a to-do item." }, unclear: { ...c.goals.unclear, notFor: "Activity that fits writing." } },
    };
    expect(problemsOf(all)).toEqual([]);
  });

  it("lists every problem in one error", () => {
    const c = valid();
    const broken = { ...c, actionIds: ["add_task"], actions: { add_task: { ...c.actions.add_task, panel: "inbox" } }, goalPanelAffinity: { write: { notes: 2 }, unclear: {} } };
    const err = (() => {
      try {
        defineCatalog(broken as unknown as Catalog<P, G, A>);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(CatalogError);
    expect((err as CatalogError).problems).toHaveLength(3);
    expect((err as CatalogError).message).toContain("Invalid catalog:\n  - ");
  });
});
