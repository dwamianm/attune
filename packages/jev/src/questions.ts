/**
 * The core Jev questions every Attune app asks each round, built from the
 * app's catalog: which goal the user is working on, how useful each panel is,
 * whether the user is stuck, which layout fits, how familiar the user is,
 * and the next step. With a command, two more: which panel answers it and
 * which action it asks for. An app adds its own questions next to these in
 * the same request, under ids of its own.
 *
 * Pure (no I/O), so tests and evals can inspect exactly what is sent. Design
 * notes, from the TypeSafe docs (state, primitives, fan-out, jev-1.13
 * jaggedness):
 *   - Question ids are never sent to the model, so every instruction carries
 *     its full meaning and points at state fields by backticked name.
 *   - The newest activity gets its own field instead of being "the last item
 *     of a list": Jev reads literally and positional indirection costs
 *     accuracy. Splitting (rather than copying) it avoids showing one search
 *     twice, which would look like a repeated search to the stuck question.
 *   - Per-panel relevance is one Score per panel with identical wording and
 *     levels, so the scores are comparable and code can rank them.
 *   - Every Choice has an explicit no-match option, and every option of a
 *     Choice has the same field names, so the options compare directly.
 *   - Command questions are speculative fan-out: they ride along in the same
 *     request and the app ignores the ones that do not apply.
 *
 * The wording was tuned in the demo app against live Jev answers; the
 * comments next to each piece say what changed and why.
 */
import { commandActivityLine, LAYOUT_MODE_DEFS, LAYOUT_MODES, NO_ACTION, PANEL_UNCLEAR, type Catalog, type InteractionSnapshot } from "@attune/core";
import { choice, noul, score } from "@typesafe-ai/sdk";
import type { EntryType, JsonValue, Question } from "@typesafe-ai/sdk";

// ---------------------------------------------------------------------------
// Question ids. The readers (normalize.ts) read answers by these, and an app
// must not reuse them for its own questions.
// ---------------------------------------------------------------------------

const REL_PREFIX = "rel_";

export const CORE_QUESTION_IDS = {
  goal: "goal",
  struggling: "struggling",
  layout: "layout",
  expertise: "expertise",
  nextAction: "next_action",
  relevance: (panel: string): string => `${REL_PREFIX}${panel}`,
  command: {
    panel: "cmd_panel",
    action: "cmd_action",
  },
} as const;

/** The panel a relevance question id belongs to, or null for other ids. */
export function relevancePanel<P extends string>(catalog: Pick<Catalog<P>, "panelIds">, id: string): P | null {
  if (!id.startsWith(REL_PREFIX)) return null;
  const panel = id.slice(REL_PREFIX.length);
  return (catalog.panelIds as readonly string[]).includes(panel) ? (panel as P) : null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type JevState = { [key: string]: JsonValue };

const NO_ACTIVITY = "No activity yet. The user has just opened the workspace.";
const NO_ACTIVITY_BEFORE_COMMAND = "No earlier activity. The command is the first thing the user did.";
const NO_FOCUS = "No panel is in focus.";
const NO_OBSERVATIONS = "Nothing notable yet.";

export interface CoreStateInput {
  /** One or two sentences about the app, for example what kind of workspace it is and which panels it has. */
  app: string;
  snapshot: InteractionSnapshot;
  /** What the user typed into the command bar this round, if anything. Trimmed here. */
  command?: string | null;
}

/**
 * The state every question reads: `app`, `earlier_activity`,
 * `latest_activity`, `current_focus`, `visible_panels`,
 * `behavior_observations`, and `command` when there is one. An app may add
 * fields after these (the demo adds `client_companies` with a command).
 */
export function buildCoreState(input: CoreStateInput): JevState {
  const command = input.command?.trim() || null;
  let activity = input.snapshot.recent_activity;
  // The app logs the command before sending it, so it would also arrive as
  // latest_activity. Said twice, it lowered Jev's action confidence ("remind
  // meridian to pay" 0.96 alone, 0.63 duplicated). `command` and COMMAND_NOTE
  // already say the user just typed it.
  if (command && activity.at(-1)?.startsWith(commandActivityLine(command))) activity = activity.slice(0, -1);
  const observations = input.snapshot.behavior_observations;
  const state: JevState = {
    app: input.app,
    earlier_activity: activity.slice(0, -1),
    latest_activity: activity.at(-1) ?? (command ? NO_ACTIVITY_BEFORE_COMMAND : NO_ACTIVITY),
    current_focus: input.snapshot.current_focus ?? NO_FOCUS,
    visible_panels: [...input.snapshot.visible_panels],
    behavior_observations: observations.length > 0 ? [...observations] : [NO_OBSERVATIONS],
  };
  if (command) state.command = command;
  return state;
}

// ---------------------------------------------------------------------------
// Shared wording
// ---------------------------------------------------------------------------

// Deliberately neutral about recency. Drafts that said "the newest activity
// matters most" or "when they disagree, go with the newer" let one last click
// (a Team focus, an inbox search for an invoice) outvote the whole task.
const ORDER_NOTE =
  "`earlier_activity` lists older actions, oldest first, and `latest_activity` is the newest. Together they show what the user is working on.";

const COMMAND_NOTE = "The user just typed `command` into the command bar. It says what they want now.";

/** The evidence a "what is the user doing now" question should read. An app's own questions of that kind use it too. */
export function nowEvidence(hasCommand: boolean): JsonValue {
  const fields = ["`latest_activity`", "`current_focus`", "`earlier_activity`"];
  if (hasCommand) fields.unshift("`command`");
  const notes = [ORDER_NOTE];
  if (hasCommand) notes.unshift(COMMAND_NOTE);
  return { read: fields, note: notes.join(" ") };
}

// Relevance is about usefulness for the user's work, not about where the pointer
// was: the layout code already weighs code-measured recent use separately.
// Says "work", never "task": Jev read "the task" as a to-do item the user had
// opened and marked the calendar as not needed for it.
export const RELEVANCE_LEVELS = [
  "Not useful: the panel has nothing to do with what the user is working on.",
  "Background only: the panel is loosely related, but the user's current work does not need it.",
  "Supporting: the panel shows information that the user's current work draws on.",
  "Central: the user's current work happens in this panel, or the panel holds the main information that work needs.",
] as const;

// Boundary case from the demo's "lost" scenario: a user who searches Tasks for
// bills is looking for Invoices. (A broader "not by which panel they used
// last" was read literally and pushed the last-used panel down.)
const RELEVANCE_NOTE =
  "A search in a panel that did not find what the user wanted does not make that panel useful.";

// Level 0 is about not finding the way, not about mouse use or speed: "explores
// slowly with the mouse" matched a careful reader's pace line word for word and
// judged a purposeful user as new.
export const EXPERTISE_LEVELS = [
  "Still finding their way: searches that find nothing, opening the guide, or trying several places before finding things.",
  "Comfortable: finds what they need and works steadily, mostly with the mouse, with an occasional keyboard shortcut.",
  "Expert: moves with the command bar and keyboard shortcuts and acts quickly.",
] as const;

/** Goal options. `not_for` is sent when the catalog sets notFor (on every goal, per defineCatalog). */
function goalCriteria<G extends string>(catalog: Pick<Catalog<string, G>, "goalIds" | "goals">): Record<string, EntryType> {
  return Object.fromEntries(
    catalog.goalIds.map((id): [string, EntryType] => {
      const g = catalog.goals[id];
      return [id, g.notFor === undefined ? { goal: g.label, what: g.description } : { goal: g.label, what: g.description, not_for: g.notFor }];
    }),
  );
}

/** Action options: each action's description, and `noneDescription` for NO_ACTION. An app's own action questions use it too. */
export function actionCriteria<A extends string>(catalog: Pick<Catalog<string, string, A>, "actionIds" | "actions">, noneDescription: string): Record<string, string> {
  return Object.fromEntries(
    catalog.actionIds.map((id) => [id, id === NO_ACTION ? noneDescription : catalog.actions[id].description]),
  );
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/**
 * The core questions, in this order: goal, one relevance Score per panel
 * (catalog order), struggling, layout, expertise, next action. `hasCommand`
 * says whether the state carries a command, so the evidence points at it.
 */
export function buildCoreQuestions<P extends string, G extends string, A extends string>(
  catalog: Catalog<P, G, A>,
  opts: { hasCommand: boolean },
): Record<string, Question> {
  const evidence = nowEvidence(opts.hasCommand);
  const questions: Record<string, Question> = {};

  questions[CORE_QUESTION_IDS.goal] = choice(
    {
      question: "Which goal is the user working on right now?",
      evidence,
    },
    goalCriteria(catalog),
  );

  // No `evidence` block here: ten copies of it were 14% of the input tokens,
  // and the live A/B kept the same top panel without it. Jev reads the whole
  // state for every question anyway.
  for (const id of catalog.panelIds) {
    questions[CORE_QUESTION_IDS.relevance(id)] = score(
      {
        panel: { name: catalog.panels[id].title, what_it_shows: catalog.panels[id].description },
        question: "How useful would `panel` be on screen right now for what the user is working on?",
        note: RELEVANCE_NOTE,
      },
      RELEVANCE_LEVELS,
    );
  }

  questions[CORE_QUESTION_IDS.struggling] = noul(
    {
      question: "Is the user stuck: unable to find something, or unable to finish a step?",
      read: ["`earlier_activity`", "`latest_activity`", "`behavior_observations`"],
    },
    {
      // Signs describe general patterns, never particular sessions. The app's
      // code counts the evidence for them (behavior_observations).
      true: {
        what: "The user is stuck.",
        signs: [
          "The same search repeated or reworded",
          "A search phrased as a question about how to do something or where something is",
          "Panels opened and then closed again quickly",
          "Undo used",
          "Moving between panels without opening anything or getting anything done",
        ],
      },
      false: {
        what: "The user is getting on with their work, or there is too little activity to tell.",
        signs: [
          "Each action follows from the one before",
          "Filtering a list and then opening an item from it",
          "Moving between two related records to compare them",
          "Returning to a record once, or one search for something related to the record at hand",
          "Only one or two actions so far",
        ],
      },
    },
  );

  questions[CORE_QUESTION_IDS.layout] = choice(
    {
      question: "Which screen layout fits how the user is working right now?",
      read: ["`latest_activity`", "`earlier_activity`", "`behavior_observations`"],
    },
    Object.fromEntries(LAYOUT_MODES.map((mode) => [mode, LAYOUT_MODE_DEFS[mode].description])),
  );

  questions[CORE_QUESTION_IDS.expertise] = score(
    {
      question: "How familiar is the user with this workspace, judging by how they move around and how quickly they act?",
      read: ["`behavior_observations`", "`earlier_activity`", "`latest_activity`"],
    },
    EXPERTISE_LEVELS,
  );

  questions[CORE_QUESTION_IDS.nextAction] = choice(
    {
      question: "Which one next step would the user most likely want to take now?",
      evidence,
      rule: "Pick none when no listed step clearly follows from what the user is doing.",
    },
    actionCriteria(catalog, "No clear next step: the activity does not point to any of these steps."),
  );

  return questions;
}

/**
 * The core command questions: which panel answers `command`, and which
 * action it asks for. Ask them only when the state carries a command.
 * `panelRule` adds an app rule to the panel question (the demo's: a command
 * that only names a client asks to see that client).
 */
export function buildCoreCommandQuestions<P extends string, G extends string, A extends string>(
  catalog: Catalog<P, G, A>,
  opts: { panelRule?: string } = {},
): Record<string, Question> {
  const examples = catalog.panelIds.every((id) => catalog.panels[id].commandExamples !== undefined);
  const panelOption = (id: P): EntryType => {
    const p = catalog.panels[id];
    return examples ? { panel: p.title, shows: p.description, examples: p.commandExamples ?? [] } : { panel: p.title, shows: p.description };
  };
  const noPanel: EntryType = examples
    ? { panel: "No panel", shows: "`command` matches none of these panels, or it is too vague to tell.", examples: ["hello", "do the thing"] }
    : { panel: "No panel", shows: "`command` matches none of these panels, or it is too vague to tell." };
  return {
    [CORE_QUESTION_IDS.command.panel]: choice(
      {
        question: "Which panel best answers or carries out `command`?",
        ...(opts.panelRule ? { rule: opts.panelRule } : {}),
      },
      {
        ...Object.fromEntries(catalog.panelIds.map((id) => [id, panelOption(id)])),
        [PANEL_UNCLEAR]: noPanel,
      },
    ),
    [CORE_QUESTION_IDS.command.action]: choice(
      {
        question: "Does `command` ask to perform one of these actions?",
        rule: "Pick none when `command` only asks to see or find something.",
      },
      actionCriteria(catalog, "No action: `command` asks to see or find something, or asks for none of these actions."),
    ),
  };
}
