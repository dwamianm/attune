/**
 * The app's vocabulary: the panels it can show, the goals the model can
 * infer, and the next steps the model can suggest, plus how strongly each
 * goal implies each panel. An app defines one catalog with defineCatalog()
 * and hands it to the library. Library code never names an app's panels,
 * goals, or actions itself.
 *
 * Descriptions are written for the model as much as for people: they are
 * sent as question context, so keep them concrete and literal.
 *
 * Some ids are fixed by the library, because the model needs an explicit
 * no-match outcome for every choice: UNCLEAR_GOAL and NO_ACTION, which every
 * catalog has, and PANEL_UNCLEAR, which no panel may use.
 */

/** The goal id that means there is too little, or too mixed, activity to tell what the user is doing. */
export const UNCLEAR_GOAL = "unclear";
/** The action id that means there is no clear next step to suggest. */
export const NO_ACTION = "none";
/** The no-match option of the command panel question (no panel fits the command). No panel id may be this. */
export const PANEL_UNCLEAR = "unclear";

export interface PanelDef<P extends string = string> {
  id: P;
  title: string;
  /** What the panel shows and what the user can do in it. Sent to the model. */
  description: string;
  /** Icon name. The app's UI maps it to an icon component. */
  icon: string;
  /** Shown on first load, before there is any activity to adapt to. */
  defaultVisible: boolean;
  /**
   * Example commands this panel answers, sent to the model with the command
   * panel question. Set on every panel or on none, so the options compare
   * directly.
   */
  commandExamples?: string[];
}

export interface GoalDef {
  /** Short label people see, for example "Collecting payments". */
  label: string;
  /** What the goal means. Sent to the model. */
  description: string;
  /**
   * What the goal is not, for goals the model confuses with another, for
   * example "Looking at revenue charts or totals for the year." for
   * collecting payments. Sent to the model. Set on every goal or on none, so
   * the options compare directly.
   */
  notFor?: string;
}

export interface ActionDef<P extends string = string, A extends string = string> {
  id: A;
  /** Short button label. It may hold placeholders such as {client}, which the app fills in. */
  label: string;
  /** Sent to the model as the option description. */
  description: string;
  /** Panel that performs the action. Null for NO_ACTION. */
  panel: P | null;
}

/**
 * P, G, and A are the app's panel, goal, and action id types. G includes
 * UNCLEAR_GOAL and A includes NO_ACTION.
 */
export interface Catalog<P extends string = string, G extends string = string, A extends string = string> {
  /** Panel ids in their default order. */
  readonly panelIds: readonly P[];
  readonly panels: Readonly<Record<P, PanelDef<P>>>;
  readonly goalIds: readonly G[];
  readonly goals: Readonly<Record<G, GoalDef>>;
  readonly actionIds: readonly A[];
  readonly actions: Readonly<Record<A, ActionDef<P, A>>>;
  /**
   * How strongly each goal implies each panel, from 0 to 1. A hand-written
   * rule, not a model call: the layout policy blends it with the model's
   * per-panel relevance. A panel left out counts as 0.
   */
  readonly goalPanelAffinity: Readonly<Record<G, Partial<Record<P, number>>>>;
}

/** A catalog that fails defineCatalog's checks. `problems` lists every one, not only the first. */
export class CatalogError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid catalog:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "CatalogError";
    this.problems = problems;
  }
}

/** Problems with one id list and its definitions: empty or repeated ids, a missing or extra definition. */
function checkIds(kind: string, ids: readonly string[], defs: Readonly<Record<string, unknown>>, problems: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.trim() === "" || id !== id.trim()) problems.push(`${kind} id ${JSON.stringify(id)} must be a non-empty string without surrounding spaces`);
    else if (seen.has(id)) problems.push(`${kind} id "${id}" is listed twice`);
    seen.add(id);
    if (!Object.hasOwn(defs, id)) problems.push(`${kind} "${id}" has no definition`);
  }
  for (const key of Object.keys(defs)) if (!seen.has(key)) problems.push(`${kind} definition "${key}" is not in the ${kind} id list`);
}

/** Problems with an optional field that must be set on every definition of a kind or on none. */
function allOrNone<K extends string>(kind: string, field: string, ids: readonly K[], has: (id: K) => boolean, problems: string[]): void {
  const missing = ids.filter((id) => !has(id));
  if (missing.length > 0 && missing.length < ids.length) problems.push(`${field} is set on some ${kind}s but not on ${missing.map((id) => `"${id}"`).join(", ")}`);
}

/**
 * Checks a catalog and returns it, frozen at the top level. Throws a
 * CatalogError that lists every problem, so a mistake shows up when the app
 * starts rather than as a wrong layout later. It checks that:
 *   - ids are non-empty, unique, and each has exactly one definition,
 *   - each panel and action definition carries its own id,
 *   - the goals include UNCLEAR_GOAL and the actions include NO_ACTION,
 *     whose panel is null,
 *   - no panel uses the id PANEL_UNCLEAR,
 *   - an action's panel is a panel id,
 *   - every goal has an affinity entry, whose keys are panel ids and whose
 *     values are numbers from 0 to 1,
 *   - commandExamples is set on every panel or on none, and notFor on every
 *     goal or on none.
 */
export function defineCatalog<P extends string, G extends string, A extends string>(catalog: Catalog<P, G, A>): Catalog<P, G, A> {
  const problems: string[] = [];
  if (catalog.panelIds.length === 0) problems.push("there must be at least one panel");
  checkIds("panel", catalog.panelIds, catalog.panels, problems);
  checkIds("goal", catalog.goalIds, catalog.goals, problems);
  checkIds("action", catalog.actionIds, catalog.actions, problems);

  const panelIds = new Set<string>(catalog.panelIds);
  if (panelIds.has(PANEL_UNCLEAR)) problems.push(`no panel may have the id "${PANEL_UNCLEAR}", the command panel question's no-match option`);
  for (const id of catalog.panelIds) {
    const def = catalog.panels[id];
    if (def && def.id !== id) problems.push(`panel "${id}" has id "${def.id}" in its definition`);
  }
  allOrNone("panel", "commandExamples", catalog.panelIds, (id) => catalog.panels[id]?.commandExamples !== undefined, problems);
  allOrNone("goal", "notFor", catalog.goalIds, (id) => catalog.goals[id]?.notFor !== undefined, problems);
  if (!catalog.goalIds.includes(UNCLEAR_GOAL as G)) problems.push(`the goals must include "${UNCLEAR_GOAL}", the no-match outcome`);
  if (!catalog.actionIds.includes(NO_ACTION as A)) problems.push(`the actions must include "${NO_ACTION}", the no-match outcome`);
  for (const id of catalog.actionIds) {
    const def = catalog.actions[id];
    if (!def) continue;
    if (def.id !== id) problems.push(`action "${id}" has id "${def.id}" in its definition`);
    if (id === NO_ACTION && def.panel !== null) problems.push(`action "${NO_ACTION}" must have panel null`);
    if (def.panel !== null && !panelIds.has(def.panel)) problems.push(`action "${id}" names panel "${def.panel}", which is not a panel id`);
  }

  for (const goal of catalog.goalIds) {
    const row = catalog.goalPanelAffinity[goal];
    if (!row) {
      problems.push(`goal "${goal}" has no affinity entry (use {} for none)`);
      continue;
    }
    for (const [panel, weight] of Object.entries(row)) {
      if (!panelIds.has(panel)) problems.push(`affinity for goal "${goal}" names panel "${panel}", which is not a panel id`);
      if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 1) {
        problems.push(`affinity for goal "${goal}" and panel "${panel}" must be a number from 0 to 1`);
      }
    }
  }
  const goalIds = new Set<string>(catalog.goalIds);
  for (const goal of Object.keys(catalog.goalPanelAffinity)) {
    if (!goalIds.has(goal)) problems.push(`affinity entry "${goal}" is not a goal id`);
  }

  if (problems.length > 0) throw new CatalogError(problems);
  return Object.freeze({ ...catalog });
}
