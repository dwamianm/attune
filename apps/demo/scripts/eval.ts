/**
 * Checks Jev's judgments against the scripted sessions in shared/scenarios.ts.
 *
 * Each case goes through the same code the app uses: describeEvent and
 * buildSnapshot on the client side, then adapt() on the server side, called
 * directly with no HTTP server in between. So a failure here is a failure of
 * the real wording and the real evidence, not of a copy of it.
 *
 * Usage:
 *   pnpm eval [--only <id>[,<id>...]] [--repeat <n>] [--scenarios-only | --commands-only] [--verbose]
 *
 * Scenarios that list record candidates send them, so those requests also
 * ask the next-record and list-work questions. The summary reports how often
 * the most probable next record (top 1), or any of the three most probable
 * (top 3), is one the scenario accepts. Scenarios with a working goal send it
 * (the goal-done question), and those that list task candidates send them
 * (the next-task question), as the app does for focus aid 2. Scenarios with a
 * clicked record send it with its linked records (the link-next and
 * link-action questions), built by the app's own code from the fixtures.
 *
 * The prep cases (focus aid 4, PREP_CASES) ask POST /api/prep's questions
 * through prep(): a fixture meeting as if it started soon, with the records
 * the app's own code picks, and check which records Jev scores highest and
 * whether it says something needs action first. Their scores are always
 * printed, and they are counted apart from the session and command checks.
 *
 * Case ids are scenario ids ("collections"), command ids ("cmd-1",
 * "cmd-2", and so on, in COMMAND_CASES order), and prep ids ("prep-harbor").
 * --only also accepts a command's exact text.
 * Full details of the last run go to eval-results/latest.json (gitignored).
 *
 * Exit code: 0 when every check passes, 1 when a check fails, 2 when Jev did
 * not answer (no key, network, timeout), since then there is nothing to judge.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { GOALS, PANEL_IDS, PANELS, type PanelId } from "../shared/catalog.ts";
import { CLIENT_NAMES, EVENTS, INVOICES, MESSAGES, PROJECTS, TASKS } from "../shared/fixtures.ts";
import { COMMAND_CASES, PREP_CASES, SCENARIOS, type CommandCase, type PrepCase, type Scenario } from "../shared/scenarios.ts";
import type { AdaptRequest, AdaptResponse, ChoiceJudgment, Judgments, LinkRequest, PrepRequest, PrepResponse, SignalEvent, TrackInput } from "../shared/types.ts";
import { adapt, prep } from "../server/adapt.ts";
import { config, hasJevKey } from "../server/env.ts";
import { COMMAND_ACTION_AT, COMMAND_APPLY_AT } from "../src/engine/command.ts";
import type { AppData, PanelViewState } from "../src/engine/contract.ts";
import { confidentLinkNext, linkRequestFor } from "../src/engine/linkFlow.ts";
import { buildPrepRecords, PREP_TINT_AT, PREP_URGENT_AT, prepMeetingWords, prepRecordWords } from "../src/engine/meetingPrep.ts";
import { PANEL_OF_KIND, parseRecordKey } from "../src/engine/nextUp.ts";
import { HELP_HINT_AT } from "@attuneui/core";
import { buildSnapshot, describeEvent } from "../src/engine/snapshot.ts";

/** TypeSafe price for input tokens. Output tokens are free. */
const USD_PER_MILLION_INPUT_TOKENS = 0.042;
/** Pause before a step without delayMs, the same default the store's replay uses. */
const REPLAY_STEP_MS = 800;
/** How many panels count as "top" for topPanels and notTopPanels. */
const TOP_N = 3;
/**
 * The thresholds the Scenario type documents for its expectations. "Stuck"
 * means the app would at least show its help hint (HELP_HINT_AT), the same
 * bar the policy acts on. "Not stuck" keeps a wider margin below it (0.4), so
 * drift does not put a productive session near the hint.
 */
const STRUGGLING_YES = HELP_HINT_AT;
const STRUGGLING_NO = 0.4;
const EXPERTISE_LOW = 0.8;
const EXPERTISE_HIGH = 1.2;
/** List work, as the Scenario type documents it: a clear yes or a clear no, with an unsure band between. */
const LIST_WORK_YES = 0.6;
const LIST_WORK_NO = 0.4;
/** How many of the most probable next records count for the top-3 figure. */
const NEXT_RECORD_TOP_N = 3;
/** Goal done (focus aid 2), as the Scenario type documents it: a clear yes or a clear no, with an unsure band between. */
const GOAL_DONE_YES = 0.6;
const GOAL_DONE_NO = 0.4;
/** Meeting prep (focus aid 4), as the PrepCase type documents it: "high" is the app's tint line, "low" keeps a margin under it. */
const PREP_HIGH_AT = PREP_TINT_AT;
const PREP_LOW_AT = 0.35;
/** Anything urgent: yes at the app's urgent line, no clearly under it, with an unsure band between. */
const PREP_URGENT_YES = PREP_URGENT_AT;
const PREP_URGENT_NO = 0.4;

const OUT_DIR = fileURLToPath(new URL("../eval-results/", import.meta.url));
const OUT_FILE = `${OUT_DIR}latest.json`;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const USAGE = `Usage: pnpm eval [options]
  --only <id>        Run only these cases. Repeat the flag or separate ids with commas.
                     Ids: ${SCENARIOS.map((s) => s.id).join(", ")}, cmd-1 to cmd-${COMMAND_CASES.length}, ${PREP_CASES.map((c) => c.id).join(", ")}
  --repeat <n>       Run each case n times and report whether the choices changed.
  --scenarios-only   Skip the command and prep cases.
  --commands-only    Skip the scenarios and prep cases.
  --prep-only        Run only the meeting prep cases.
  --verbose          Also print the checks that passed.
  --help             Show this help.`;

interface Options {
  only: string[];
  repeat: number;
  scenarios: boolean;
  commands: boolean;
  prep: boolean;
  verbose: boolean;
}

function readOptions(): Options {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        only: { type: "string", multiple: true },
        repeat: { type: "string" },
        "scenarios-only": { type: "boolean" },
        "commands-only": { type: "boolean" },
        "prep-only": { type: "boolean" },
        verbose: { type: "boolean", short: "v" },
        help: { type: "boolean", short: "h" },
      },
    }).values;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error(USAGE);
    process.exit(2);
  }
  if (parsed.help) {
    console.log(USAGE);
    process.exit(0);
  }
  const repeat = parsed.repeat === undefined ? 1 : Number(parsed.repeat);
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10) {
    console.error("--repeat must be a whole number from 1 to 10.");
    process.exit(2);
  }
  if ([parsed["scenarios-only"], parsed["commands-only"], parsed["prep-only"]].filter(Boolean).length > 1) {
    console.error("Use only one of --scenarios-only, --commands-only, and --prep-only.");
    process.exit(2);
  }
  const some = Boolean(parsed["scenarios-only"] || parsed["commands-only"] || parsed["prep-only"]);
  return {
    only: (parsed.only ?? []).flatMap((v) => v.split(",")).map((v) => v.trim()).filter(Boolean),
    repeat,
    scenarios: !some || Boolean(parsed["scenarios-only"]),
    commands: !some || Boolean(parsed["commands-only"]),
    prep: !some || Boolean(parsed["prep-only"]),
    verbose: parsed.verbose ?? false,
  };
}

// ---------------------------------------------------------------------------
// Cases and requests
// ---------------------------------------------------------------------------

type EvalCase =
  | { kind: "scenario"; id: string; label: string; scenario: Scenario }
  | { kind: "command"; id: string; label: string; command: CommandCase }
  | { kind: "prep"; id: string; label: string; prep: PrepCase };
/** The cases that go through adapt(): sessions and commands. */
type AdaptCase = Exclude<EvalCase, { kind: "prep" }>;

function allCases(): EvalCase[] {
  return [
    ...SCENARIOS.map((scenario): EvalCase => ({ kind: "scenario", id: scenario.id, label: scenario.name, scenario })),
    ...COMMAND_CASES.map((command, i): EvalCase => ({
      kind: "command",
      id: `cmd-${i + 1}`,
      label: command.after ? `${command.text} (after ${command.after})` : command.text,
      command,
    })),
    ...PREP_CASES.map((prep): EvalCase => ({ kind: "prep", id: prep.id, label: prep.name, prep })),
  ];
}

function selectCases(opts: Options): EvalCase[] {
  let cases = allCases().filter((c) => (c.kind === "scenario" ? opts.scenarios : c.kind === "command" ? opts.commands : opts.prep));
  if (opts.only.length > 0) {
    const unknown = opts.only.filter((id) => !cases.some((c) => c.id === id || c.label === id));
    if (unknown.length > 0) {
      console.error(`No case matches: ${unknown.join(", ")}`);
      console.error(USAGE);
      process.exit(2);
    }
    cases = cases.filter((c) => opts.only.includes(c.id) || opts.only.includes(c.label));
  }
  return cases;
}

const DEFAULT_VISIBLE: PanelId[] = PANEL_IDS.filter((id) => PANELS[id].defaultVisible);

/**
 * Scenario steps as logged events: ids 1..n, and times spaced by each step's
 * delayMs (as a replay would), shifted so the last event happens at `now`.
 */
function scenarioEvents(scenario: Scenario, now: number): SignalEvent[] {
  const offsets: number[] = [];
  let t = 0;
  scenario.steps.forEach((step, i) => {
    t += step.delayMs ?? (i === 0 ? 0 : REPLAY_STEP_MS);
    offsets.push(t);
  });
  const end = t;
  return scenario.steps.map((step, i) => {
    const input: TrackInput = {
      type: step.type,
      ...(step.panel ? { panel: step.panel } : {}),
      ...(step.detail ? { detail: step.detail } : {}),
    };
    return { ...input, id: i + 1, t: now - (end - offsets[i]), text: describeEvent(input) };
  });
}

/**
 * Panels on screen at the end: the default ones plus any the steps opened or
 * used. A panel whose last step sent it to the dock is no longer on screen.
 */
function visibleAtEnd(scenario: Scenario): PanelId[] {
  const shown = new Set<PanelId>(DEFAULT_VISIBLE);
  for (const step of scenario.steps) {
    if (!step.panel) continue;
    if (step.type === "panel_dismiss") shown.delete(step.panel);
    else shown.add(step.panel);
  }
  return PANEL_IDS.filter((id) => shown.has(id));
}

let nextVersion = 1;

/** The panels' view when the app loads (the store's defaultView): what findLinked counts as shown. */
const DEFAULT_VIEW: PanelViewState = {
  inbox: { query: "", selectedId: null, client: null },
  invoices: { status: "all", client: null, selectedId: null },
  clients: { selected: null, query: "" },
  tasks: { showDone: false, client: null, selectedId: null },
  projects: { status: "all", selectedId: null },
  calendar: { range: "today", selectedId: null },
  analytics: { range: "this_year" },
  team: {},
  notes: {},
  help: {},
};

/**
 * A scenario's link request, the way the app builds it: its words and linked
 * records from the scenario when it writes them out, else from the fixtures
 * with the app's code (linkRequestFor), on a fresh session's data and view.
 */
function linkRequest(scenario: Scenario, now: number): LinkRequest | null {
  const l = scenario.link;
  if (!l) return null;
  if (l.words && l.records) return { clicked: l.words, records: l.records };
  const panel = PANEL_OF_KIND[l.kind];
  if (!panel) return null;
  const data: AppData = {
    invoices: structuredClone(INVOICES),
    messages: structuredClone(MESSAGES),
    tasks: structuredClone(TASKS),
    projects: structuredClone(PROJECTS),
    events: structuredClone(EVENTS),
    notes: "",
  };
  return linkRequestFor({ panel, itemKind: l.kind, itemId: l.id, ...(l.client ? { client: l.client } : {}), at: now, source: "work" }, data, DEFAULT_VIEW, now);
}

/** Pause between the last scenario step and a command typed after it. */
const COMMAND_AFTER_MS = 1_500;

/**
 * A command request the way the app builds it: the store logs the command
 * event first (via the keyboard), so the snapshot ends with it, after any
 * earlier session the case names in `after`.
 */
function buildRequest(c: AdaptCase, now: number): AdaptRequest {
  const version = nextVersion++;
  const candidates = { clients: [...CLIENT_NAMES] };
  if (c.kind === "scenario") {
    const events = scenarioEvents(c.scenario, now);
    const snapshot = buildSnapshot(events, { now, focusedPanel: c.scenario.finalFocus, visiblePanels: visibleAtEnd(c.scenario) });
    const records = c.scenario.candidates;
    const tasks = c.scenario.tasks;
    const goal = c.scenario.workingGoal;
    const link = linkRequest(c.scenario, now);
    return {
      version,
      snapshot,
      candidates: { ...candidates, ...(records?.length ? { records: [...records] } : {}), ...(tasks?.length ? { tasks: [...tasks] } : {}) },
      // The working goal in the same words the app sends (GOALS in shared/catalog.ts).
      ...(goal ? { workingGoal: { label: GOALS[goal].label, description: GOALS[goal].description } } : {}),
      ...(link ? { link } : {}),
    };
  }
  const before = c.command.after ? SCENARIOS.find((x) => x.id === c.command.after) : undefined;
  const earlier = before ? scenarioEvents(before, now - COMMAND_AFTER_MS) : [];
  const input: TrackInput = { type: "command", detail: { query: c.command.text, via: "keyboard" } };
  const events: SignalEvent[] = [...earlier, { ...input, id: earlier.length + 1, t: now, text: describeEvent(input) }];
  const snapshot = buildSnapshot(events, {
    now,
    focusedPanel: before?.finalFocus ?? null,
    visiblePanels: before ? visibleAtEnd(before) : DEFAULT_VISIBLE,
  });
  return { version, snapshot, candidates, command: c.command.text };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

interface Check {
  name: string;
  pass: boolean;
  /** What the expectation allows, with Jev's probability or score for each. */
  expected: string;
  /** What Jev answered. */
  actual: string;
}

const f2 = (n: number): string => n.toFixed(2);

function probOf<K extends string>(j: ChoiceJudgment<K>, option: string): number {
  return (j.probabilities as Record<string, number>)[option] ?? 0;
}

function choiceCheck<K extends string>(name: string, j: ChoiceJudgment<K>, allowed: readonly string[]): Check {
  return {
    name,
    pass: allowed.includes(j.choice),
    expected: allowed.map((k) => `${k} ${f2(probOf(j, k))}`).join(" | "),
    actual: `${j.choice} ${f2(probOf(j, j.choice))} (confidence ${f2(j.confidence)})`,
  };
}

/** Panels by relevance score, highest first. Ties keep catalog order (sort is stable). */
function rankPanels(j: Judgments): { id: PanelId; score: number }[] {
  return PANEL_IDS.map((id) => ({ id, score: j.relevance[id].score })).sort((a, b) => b.score - a.score);
}

function topText(ranked: { id: PanelId; score: number }[]): string {
  return `top ${TOP_N}: ${ranked
    .slice(0, TOP_N)
    .map((r) => `${r.id} ${f2(r.score)}`)
    .join(", ")}`;
}

function rankText(ranked: { id: PanelId; score: number }[], ids: readonly PanelId[]): string {
  return ids
    .map((id) => {
      const i = ranked.findIndex((r) => r.id === id);
      return `${id} #${i + 1} ${f2(ranked[i]?.score ?? 0)}`;
    })
    .join(" | ");
}

/** Options by probability, highest first. Ties keep the order the options were sent in. */
function topOptions(j: ChoiceJudgment<string>, n: number): string[] {
  return Object.entries(j.probabilities)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k]) => k);
}

function scenarioChecks(expect: Scenario["expect"], j: Judgments): Check[] {
  const checks: Check[] = [];
  const ranked = rankPanels(j);
  const top = ranked.slice(0, TOP_N).map((r) => r.id);

  if (expect.goal) checks.push(choiceCheck("goal", j.goal, expect.goal));
  if (expect.topPanels) {
    checks.push({
      name: "topPanels",
      pass: expect.topPanels.some((id) => top.includes(id)),
      expected: `any in top ${TOP_N}: ${rankText(ranked, expect.topPanels)}`,
      actual: topText(ranked),
    });
  }
  if (expect.notTopPanels) {
    checks.push({
      name: "notTopPanels",
      pass: !expect.notTopPanels.some((id) => top.includes(id)),
      expected: `none in top ${TOP_N}: ${rankText(ranked, expect.notTopPanels)}`,
      actual: topText(ranked),
    });
  }
  if (expect.layout) checks.push(choiceCheck("layout", j.layout, expect.layout));
  if (expect.nextAction) checks.push(choiceCheck("nextAction", j.nextAction, expect.nextAction));
  if (expect.targetClient) checks.push(choiceCheck("targetClient", j.targetClient, expect.targetClient));
  if (expect.struggling !== undefined) {
    const v = j.struggling;
    checks.push({
      name: "struggling",
      pass: expect.struggling ? v >= STRUGGLING_YES : v <= STRUGGLING_NO,
      expected: expect.struggling ? `noul >= ${f2(STRUGGLING_YES)}` : `noul <= ${f2(STRUGGLING_NO)}`,
      actual: `noul ${f2(v)}`,
    });
  }
  if (expect.expertise) {
    const e = j.expertise;
    checks.push({
      name: "expertise",
      pass: expect.expertise === "low" ? e.score <= EXPERTISE_LOW : e.score >= EXPERTISE_HIGH,
      expected: expect.expertise === "low" ? `score <= ${f2(EXPERTISE_LOW)}` : `score >= ${f2(EXPERTISE_HIGH)}`,
      actual: `score ${f2(e.score)} (levels ${e.probabilities.map(f2).join(" / ")})`,
    });
  }
  if (expect.nextRecord) {
    const nr = j.nextRecord;
    if (!nr) checks.push({ name: "nextRecord", pass: false, expected: `any of ${expect.nextRecord.join(" | ")}`, actual: "not asked" });
    else {
      const check = choiceCheck("nextRecord", nr, expect.nextRecord);
      const top = topOptions(nr, NEXT_RECORD_TOP_N).map((k) => `${k} ${f2(probOf(nr, k))}`);
      checks.push({ ...check, actual: `${check.actual}; top ${NEXT_RECORD_TOP_N}: ${top.join(", ")}` });
    }
  }
  if (expect.listWork !== undefined) {
    const v = j.listWork;
    checks.push({
      name: "listWork",
      pass: v !== undefined && (expect.listWork ? v >= LIST_WORK_YES : v <= LIST_WORK_NO),
      expected: expect.listWork ? `noul >= ${f2(LIST_WORK_YES)}` : `noul <= ${f2(LIST_WORK_NO)}`,
      actual: v === undefined ? "not asked" : `noul ${f2(v)}`,
    });
  }
  if (expect.goalDone !== undefined) {
    const v = j.goalDone;
    checks.push({
      name: "goalDone",
      pass: v !== undefined && (expect.goalDone ? v >= GOAL_DONE_YES : v <= GOAL_DONE_NO),
      expected: expect.goalDone ? `noul >= ${f2(GOAL_DONE_YES)}` : `noul <= ${f2(GOAL_DONE_NO)}`,
      actual: v === undefined ? "not asked" : `noul ${f2(v)}`,
    });
  }
  if (expect.nextTask) {
    const nt = j.nextTask;
    if (!nt) checks.push({ name: "nextTask", pass: false, expected: `any of ${expect.nextTask.join(" | ")}`, actual: "not asked" });
    else {
      const check = choiceCheck("nextTask", nt, expect.nextTask);
      const top = topOptions(nt, NEXT_RECORD_TOP_N).map((k) => `${k} ${f2(probOf(nt, k))}`);
      checks.push({ ...check, actual: `${check.actual}; top ${NEXT_RECORD_TOP_N}: ${top.join(", ")}` });
    }
  }
  if (expect.linkNext) {
    const ln = j.linkNext;
    if (!ln) checks.push({ name: "linkNext", pass: false, expected: `any of ${expect.linkNext.join(" | ")}`, actual: "not asked" });
    else {
      const check = choiceCheck("linkNext", ln, expect.linkNext);
      checks.push({ ...check, actual: `${check.actual}; ${linkNextText(ln)}` });
    }
  }
  if (expect.linkAction) {
    const la = j.linkAction;
    checks.push(la ? choiceCheck("linkAction", la, expect.linkAction) : { name: "linkAction", pass: false, expected: `any of ${expect.linkAction.join(" | ")}`, actual: "not asked" });
  }
  return checks;
}

/** Link-next's top options, and whether the app would say "Next" for it (confidentLinkNext in src/engine/linkFlow.ts). */
function linkNextText(ln: ChoiceJudgment<string>): string {
  const top = topOptions(ln, NEXT_RECORD_TOP_N).map((k) => `${k} ${f2(probOf(ln, k))}`);
  return `top ${NEXT_RECORD_TOP_N}: ${top.join(", ")}; ${confidentLinkNext(ln) ? "passes" : "under"} the Next gate`;
}

/** Top-1 and top-3 hits of the next-record Choice, for runs whose scenario accepts some ids. */
interface NextRecordTally {
  runs: number;
  top1: number;
  top3: number;
}

function nextRecordTally(runs: CaseRun[]): NextRecordTally {
  const tally: NextRecordTally = { runs: 0, top1: 0, top3: 0 };
  for (const r of runs) {
    const accepted = r.kind === "scenario" ? (r.expect as Scenario["expect"]).nextRecord : undefined;
    const nr = r.answers?.nextRecord;
    if (!accepted || !nr) continue;
    tally.runs++;
    if (accepted.includes(nr.choice)) tally.top1++;
    if (topOptions(nr, NEXT_RECORD_TOP_N).some((k) => accepted.includes(k))) tally.top3++;
  }
  return tally;
}

/** The right choice is not enough: the app acts only above its thresholds (src/engine/command.ts). */
function confidenceCheck(name: string, j: ChoiceJudgment<string>, bar: number): Check {
  const conf = j.confidence ?? 0;
  return { name, pass: conf >= bar, expected: `confidence >= ${f2(bar)}`, actual: `${j.choice} confidence ${f2(conf)}` };
}

function commandChecks(expect: CommandCase["expect"], j: Judgments): Check[] {
  const cmd = j.command;
  if (!cmd) return [{ name: "command", pass: false, expected: "command judgments", actual: "none returned" }];
  const checks: Check[] = [];
  if (expect.panel) {
    checks.push(choiceCheck("panel", cmd.panel, expect.panel));
    checks.push(confidenceCheck("panelApplies", cmd.panel, COMMAND_APPLY_AT));
  }
  if (expect.action) {
    checks.push(choiceCheck("action", cmd.action, expect.action));
    if (expect.action.some((a) => a !== "none")) checks.push(confidenceCheck("actionSuggests", cmd.action, COMMAND_ACTION_AT));
  }
  if (expect.invoiceStatus) checks.push(choiceCheck("invoiceStatus", cmd.invoiceStatus, expect.invoiceStatus));
  if (expect.client) checks.push(choiceCheck("client", cmd.client, expect.client));
  if (expect.timeframe) checks.push(choiceCheck("timeframe", cmd.timeframe, expect.timeframe));
  return checks;
}

// ---------------------------------------------------------------------------
// Consistency between repeated runs
// ---------------------------------------------------------------------------

/**
 * The discrete outcomes of one run, compared across --repeat runs. `margin`
 * is only for display: it shows whether a change was a near tie.
 */
type Outcome = { value: string; margin: string };

function choiceOutcome<K extends string>(j: ChoiceJudgment<K>): Outcome {
  const sorted = Object.values<number>(j.probabilities).sort((a, b) => b - a);
  return { value: j.choice, margin: `${f2(probOf(j, j.choice))} vs ${f2(sorted[1] ?? 0)}` };
}

function fingerprint(c: AdaptCase, j: Judgments): Record<string, Outcome> {
  if (c.kind === "command") {
    const cmd = j.command;
    if (!cmd) return { command: { value: "missing", margin: "" } };
    return {
      panel: choiceOutcome(cmd.panel),
      action: choiceOutcome(cmd.action),
      invoiceStatus: choiceOutcome(cmd.invoiceStatus),
      client: choiceOutcome(cmd.client),
      timeframe: choiceOutcome(cmd.timeframe),
    };
  }
  const s = j.struggling;
  const e = j.expertise.score;
  const ranked = rankPanels(j);
  return {
    goal: choiceOutcome(j.goal),
    layout: choiceOutcome(j.layout),
    nextAction: choiceOutcome(j.nextAction),
    targetClient: choiceOutcome(j.targetClient),
    top3: {
      value: ranked
        .slice(0, TOP_N)
        .map((r) => r.id)
        .join(">"),
      margin: `#${TOP_N} ${f2(ranked[TOP_N - 1].score)} vs #${TOP_N + 1} ${f2(ranked[TOP_N].score)}`,
    },
    struggling: { value: s >= STRUGGLING_YES ? "yes" : s <= STRUGGLING_NO ? "no" : "unsure", margin: f2(s) },
    expertise: { value: e <= EXPERTISE_LOW ? "low" : e >= EXPERTISE_HIGH ? "high" : "middle", margin: f2(e) },
    ...(j.nextRecord ? { nextRecord: choiceOutcome(j.nextRecord) } : {}),
    ...(j.listWork !== undefined
      ? {
          listWork: {
            value: j.listWork >= LIST_WORK_YES ? "yes" : j.listWork <= LIST_WORK_NO ? "no" : "unsure",
            margin: f2(j.listWork),
          },
        }
      : {}),
    ...(j.goalDone !== undefined
      ? {
          goalDone: {
            value: j.goalDone >= GOAL_DONE_YES ? "yes" : j.goalDone <= GOAL_DONE_NO ? "no" : "unsure",
            margin: f2(j.goalDone),
          },
        }
      : {}),
    ...(j.nextTask ? { nextTask: choiceOutcome(j.nextTask) } : {}),
    ...(j.linkNext ? { linkNext: choiceOutcome(j.linkNext) } : {}),
    ...(j.linkAction ? { linkAction: choiceOutcome(j.linkAction) } : {}),
  };
}

/** Numbers that can drift without changing a choice, keyed so runs can be compared. */
function numbers(c: AdaptCase, j: Judgments): Record<string, number> {
  const out: Record<string, number> = {};
  const choices: [string, ChoiceJudgment<string>][] =
    c.kind === "command" && j.command
      ? Object.entries(j.command)
      : [
          ["goal", j.goal],
          ["layout", j.layout],
          ["nextAction", j.nextAction],
          ["targetClient", j.targetClient],
          ...(j.nextRecord ? ([["nextRecord", j.nextRecord]] as [string, ChoiceJudgment<string>][]) : []),
          ...(j.nextTask ? ([["nextTask", j.nextTask]] as [string, ChoiceJudgment<string>][]) : []),
          ...(j.linkNext ? ([["linkNext", j.linkNext]] as [string, ChoiceJudgment<string>][]) : []),
          ...(j.linkAction ? ([["linkAction", j.linkAction]] as [string, ChoiceJudgment<string>][]) : []),
        ];
  for (const [name, cj] of choices) for (const [k, p] of Object.entries(cj.probabilities)) out[`${name}.${k}`] = p as number;
  if (c.kind === "scenario") {
    out.struggling = j.struggling;
    out.expertise = j.expertise.score;
    if (j.listWork !== undefined) out.listWork = j.listWork;
    if (j.goalDone !== undefined) out.goalDone = j.goalDone;
    for (const id of PANEL_IDS) out[`relevance.${id}`] = j.relevance[id].score;
  }
  return out;
}

interface Consistency {
  id: string;
  runs: number;
  stable: boolean;
  changed: Record<string, string[]>;
  /** Largest change of any probability, noul, or score between runs, and where. */
  maxDrift: { key: string; delta: number };
}

function consistencyOf(c: AdaptCase, runs: CaseRun[]): Consistency {
  const answered = runs.filter((r) => r.answers);
  const prints = answered.map((r) => fingerprint(c, r.answers as Judgments));
  const changed: Record<string, string[]> = {};
  for (const key of Object.keys(prints[0] ?? {})) {
    const outcomes = prints.map((p) => p[key]);
    if (new Set(outcomes.map((o) => o.value)).size > 1) changed[key] = outcomes.map((o) => `${o.value} (${o.margin})`);
  }
  const nums = answered.map((r) => numbers(c, r.answers as Judgments));
  let maxDrift = { key: "", delta: 0 };
  for (const key of Object.keys(nums[0] ?? {})) {
    const values = nums.map((n) => n[key] ?? 0);
    const delta = Math.max(...values) - Math.min(...values);
    if (delta > maxDrift.delta) maxDrift = { key, delta };
  }
  return { id: c.id, runs: answered.length, stable: Object.keys(changed).length === 0, changed, maxDrift };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

interface CaseRun {
  kind: AdaptCase["kind"];
  id: string;
  label: string;
  run: number;
  source: AdaptResponse["source"];
  /** Set when the heuristic answered: the checks were not run. */
  infraError: string | null;
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  requestId: string | null;
  questionCount: number;
  pass: boolean;
  checks: Check[];
  request: AdaptRequest;
  state: unknown;
  questions: Record<string, unknown>;
  /** Jev's answers after normalization (the Judgments the client reads). */
  answers: Judgments | null;
  expect: Scenario["expect"] | CommandCase["expect"];
}

async function runCase(c: AdaptCase, run: number): Promise<CaseRun> {
  const request = buildRequest(c, Date.now());
  const res = await adapt(request);
  const heuristic = res.source !== "jev";
  const checks = heuristic
    ? []
    : c.kind === "scenario"
      ? scenarioChecks(c.scenario.expect, res.judgments)
      : commandChecks(c.command.expect, res.judgments);
  return {
    kind: c.kind,
    id: c.id,
    label: c.label,
    run,
    source: res.source,
    infraError: heuristic ? (res.meta.error ?? "The heuristic answered instead of Jev") : null,
    model: res.meta.model,
    latencyMs: res.meta.latencyMs,
    inputTokens: res.meta.usage?.input_tokens ?? null,
    requestId: res.meta.requestId ?? null,
    questionCount: res.meta.questionCount,
    pass: !heuristic && checks.every((k) => k.pass),
    checks,
    request,
    state: res.debug.state,
    questions: res.debug.questions,
    answers: heuristic ? null : res.judgments,
    expect: c.kind === "scenario" ? c.scenario.expect : c.command.expect,
  };
}

// ---------------------------------------------------------------------------
// Meeting prep (focus aid 4)
// ---------------------------------------------------------------------------

/** The app's data as a fresh session has it (the store's freshData). */
function freshData(): AppData {
  return {
    invoices: structuredClone(INVOICES),
    messages: structuredClone(MESSAGES),
    tasks: structuredClone(TASKS),
    projects: structuredClone(PROJECTS),
    events: structuredClone(EVENTS),
    notes: "",
  };
}

/**
 * A prep request the way the app builds it: the fixture meeting as if it
 * started `startsInMin` from now, the records the app's code picks
 * (buildPrepRecords), and the case's extra records in the app's words.
 */
function buildPrepRequest(c: PrepCase, now: number): PrepRequest {
  const data = freshData();
  const event = EVENTS.find((e) => e.id === c.eventId);
  if (!event) throw new Error(`Prep case ${c.id}: no event ${c.eventId} in the fixtures`);
  const length = Date.parse(event.end) - Date.parse(event.start);
  const start = now + c.startsInMin * 60_000;
  const meeting = { ...event, start: new Date(start).toISOString(), end: new Date(start + length).toISOString() };
  const records = buildPrepRecords(meeting, data, now).map((x) => x.record);
  for (const key of c.extra ?? []) {
    const r = parseRecordKey(key);
    const words = r ? prepRecordWords(r.kind, r.id, data, now) : null;
    if (words && !records.some((x) => x.id === words.record.id)) records.push(words.record);
  }
  return { version: nextVersion++, meeting: prepMeetingWords(meeting, now), records };
}

/** Each record's score as a share of its scale, best first (ties keep the order sent). */
function prepRanked(res: PrepResponse, req: PrepRequest): { id: string; share: number }[] {
  return req.records
    .map((r) => {
      const s = res.judgments.scores[r.id];
      return { id: r.id, share: s && s.max > 0 ? s.score / s.max : 0 };
    })
    .sort((a, b) => b.share - a.share);
}

function prepChecks(expect: PrepCase["expect"], ranked: { id: string; share: number }[], urgent: number): Check[] {
  const checks: Check[] = [];
  const share = (id: string) => ranked.find((r) => r.id === id)?.share;
  const text = (ids: string[]) => ids.map((id) => `${id} ${share(id) === undefined ? "not sent" : f2(share(id)!)}`).join(" | ");
  const order = (n: number) => ranked.slice(0, n).map((r) => `${r.id} ${f2(r.share)}`).join(", ");
  if (expect.top) {
    const { ids, within } = expect.top;
    const top = ranked.slice(0, within).map((r) => r.id);
    checks.push({ name: "prepTop", pass: ids.every((id) => top.includes(id)), expected: `all in top ${within}: ${text(ids)}`, actual: `top ${within}: ${order(within)}` });
  }
  if (expect.high) {
    checks.push({ name: "prepHigh", pass: expect.high.every((id) => (share(id) ?? -1) >= PREP_HIGH_AT), expected: `each >= ${f2(PREP_HIGH_AT)}`, actual: text(expect.high) });
  }
  if (expect.low) {
    checks.push({ name: "prepLow", pass: expect.low.every((id) => (share(id) ?? 2) <= PREP_LOW_AT), expected: `each <= ${f2(PREP_LOW_AT)}`, actual: text(expect.low) });
  }
  if (expect.last) {
    const bottom = ranked.at(-1);
    checks.push({ name: "prepLast", pass: bottom?.id === expect.last, expected: `lowest: ${text([expect.last])}`, actual: `lowest: ${bottom ? `${bottom.id} ${f2(bottom.share)}` : "none"}` });
  }
  if (expect.urgent !== undefined) {
    checks.push({
      name: "prepUrgent",
      pass: expect.urgent ? urgent >= PREP_URGENT_YES : urgent <= PREP_URGENT_NO,
      expected: expect.urgent ? `noul >= ${f2(PREP_URGENT_YES)}` : `noul <= ${f2(PREP_URGENT_NO)}`,
      actual: `noul ${f2(urgent)}`,
    });
  }
  return checks;
}

interface PrepRun {
  id: string;
  label: string;
  run: number;
  source: PrepResponse["source"];
  infraError: string | null;
  model: string;
  latencyMs: number;
  inputTokens: number | null;
  pass: boolean;
  checks: Check[];
  /** Every record's share of the scale, best first. */
  ranked: { id: string; share: number }[];
  urgent: number;
  request: PrepRequest;
  state: unknown;
  questions: Record<string, unknown>;
}

async function runPrepCase(c: Extract<EvalCase, { kind: "prep" }>, run: number): Promise<PrepRun> {
  const request = buildPrepRequest(c.prep, Date.now());
  const res = await prep(request);
  const heuristic = res.source !== "jev";
  const ranked = prepRanked(res, request);
  const checks = heuristic ? [] : prepChecks(c.prep.expect, ranked, res.judgments.anythingUrgent);
  return {
    id: c.id,
    label: c.label,
    run,
    source: res.source,
    infraError: heuristic ? (res.meta.error ?? "The heuristic answered instead of Jev") : null,
    model: res.meta.model,
    latencyMs: res.meta.latencyMs,
    inputTokens: res.meta.usage?.input_tokens ?? null,
    pass: !heuristic && checks.every((k) => k.pass),
    checks,
    ranked,
    urgent: res.judgments.anythingUrgent,
    request,
    state: res.debug.state,
    questions: res.debug.questions,
  };
}

/** Between --repeat runs: the order of the three best records and the urgent verdict, and the largest drift of any share. */
function prepConsistency(id: string, runs: PrepRun[]): Consistency {
  const answered = runs.filter((r) => !r.infraError);
  const changed: Record<string, string[]> = {};
  const tops = answered.map((r) => r.ranked.slice(0, 3).map((x) => x.id).join(">"));
  if (new Set(tops).size > 1) changed.top3 = answered.map((r) => `${r.ranked.slice(0, 3).map((x) => x.id).join(">")} (#3 ${f2(r.ranked[2]?.share ?? 0)} vs #4 ${f2(r.ranked[3]?.share ?? 0)})`);
  const verdict = (u: number) => (u >= PREP_URGENT_YES ? "yes" : u <= PREP_URGENT_NO ? "no" : "unsure");
  if (new Set(answered.map((r) => verdict(r.urgent))).size > 1) changed.urgent = answered.map((r) => `${verdict(r.urgent)} (${f2(r.urgent)})`);
  let maxDrift = { key: "", delta: 0 };
  const keys = [...new Set(answered.flatMap((r) => r.ranked.map((x) => x.id)))];
  for (const key of keys) {
    const values = answered.map((r) => r.ranked.find((x) => x.id === key)?.share ?? 0);
    const delta = Math.max(...values) - Math.min(...values);
    if (delta > maxDrift.delta) maxDrift = { key, delta };
  }
  const u = answered.map((r) => r.urgent);
  if (u.length && Math.max(...u) - Math.min(...u) > maxDrift.delta) maxDrift = { key: "urgent", delta: Math.max(...u) - Math.min(...u) };
  return { id, runs: answered.length, stable: Object.keys(changed).length === 0, changed, maxDrift };
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const tty = process.stdout.isTTY === true;
const paint = (code: string, text: string): string => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (t: string) => paint("32", t);
const red = (t: string) => paint("31", t);
const bold = (t: string) => paint("1", t);
const dim = (t: string) => paint("2", t);

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest rank: with few samples, p95 is the slowest or second slowest request.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function checkLine(k: Check, prefix = ""): string {
  const mark = k.pass ? green("ok  ") : red("FAIL");
  return `    ${prefix}${mark} ${k.name.padEnd(13)} want ${k.expected}\n    ${prefix}     ${" ".repeat(13)} got  ${k.actual}`;
}

function loudInfraBanner(failed: { id: string; run: number; infraError: string | null }[]): void {
  const line = "!".repeat(78);
  console.log(`\n${red(line)}`);
  console.log(red(bold(`INFRASTRUCTURE FAILURE: ${failed.length} request(s) were answered by the heuristic, not by Jev.`)));
  console.log(red("These are not Jev results, so their checks were not run and they count as failures."));
  for (const r of failed) console.log(red(`  ${r.id} (run ${r.run}): ${r.infraError}`));
  console.log(red(line));
}

async function main(): Promise<void> {
  const opts = readOptions();
  const selected = selectCases(opts);
  const cases = selected.filter((c): c is AdaptCase => c.kind !== "prep");
  const prepCases = selected.filter((c): c is Extract<EvalCase, { kind: "prep" }> => c.kind === "prep");

  if (!hasJevKey()) {
    console.error(red(bold("INFRASTRUCTURE FAILURE: no Jev API key is set (JEV_API_KEY in .env).")));
    console.error(red("Every answer would come from the heuristic, so there is nothing to evaluate."));
    process.exit(2);
  }

  const nScenarios = cases.filter((c) => c.kind === "scenario").length;
  const nCommands = cases.length - nScenarios;
  console.log(
    bold(
      `Attune eval: ${nScenarios} scenario(s), ${nCommands} command case(s), ${prepCases.length} prep case(s), ${opts.repeat} run(s) each, model ${config.model}`,
    ),
  );

  // Run-major order, so a repeat is a second pass rather than back-to-back twins.
  const runs: CaseRun[] = [];
  const prepRuns: PrepRun[] = [];
  for (let run = 1; run <= opts.repeat; run++) {
    for (const c of cases) runs.push(await runCase(c, run));
    for (const c of prepCases) prepRuns.push(await runPrepCase(c, run));
  }

  const byCase = new Map<string, CaseRun[]>();
  for (const r of runs) byCase.set(r.id, [...(byCase.get(r.id) ?? []), r]);
  const consistency = opts.repeat > 1 ? cases.map((c) => consistencyOf(c, byCase.get(c.id) ?? [])) : [];

  // Table
  const idWidth = Math.max(4, ...selected.map((c) => c.id.length)) + 2;
  console.log(`\n${bold("case".padEnd(idWidth) + "result".padEnd(10) + "ms".padStart(6) + "  " + "label")}`);
  for (const c of cases) {
    const rs = byCase.get(c.id) ?? [];
    const passed = rs.filter((r) => r.pass).length;
    const infra = rs.some((r) => r.infraError);
    const ok = !infra && passed === rs.length;
    const word = infra ? "INFRA" : ok ? "pass" : "FAIL";
    const count = opts.repeat > 1 ? ` ${passed}/${rs.length}` : "";
    // Pad before coloring, since escape codes would throw off the width.
    const cell = `${word}${count}`.padEnd(10).replace(word, ok ? green(word) : red(word));
    const ms = Math.round(median(rs.map((r) => r.latencyMs).sort((a, b) => a - b)));
    console.log(`${c.id.padEnd(idWidth)}${cell}${String(ms).padStart(6)}  ${dim(c.label)}`);
    for (const r of rs) {
      const prefix = opts.repeat > 1 ? `run ${r.run} ` : "";
      if (r.infraError) {
        console.log(red(`    ${prefix}heuristic answered: ${r.infraError}`));
        continue;
      }
      for (const k of r.checks) if (opts.verbose || !k.pass) console.log(checkLine(k, prefix));
      // No expectation to check, but the pick and its confidence are still worth seeing.
      const nr = r.answers?.nextRecord;
      if (nr && r.kind === "scenario" && !(r.expect as Scenario["expect"]).nextRecord) {
        const top = topOptions(nr, NEXT_RECORD_TOP_N).map((k) => `${k} ${f2(probOf(nr, k))}`);
        console.log(dim(`    ${prefix}nextRecord (not checked): ${nr.choice}, confidence ${f2(nr.confidence)}; top ${NEXT_RECORD_TOP_N}: ${top.join(", ")}`));
      }
      // The same for the focus aid 2 answers a scenario asks but does not check.
      const expect = r.expect as Scenario["expect"];
      if (r.kind === "scenario" && r.answers?.goalDone !== undefined && expect.goalDone === undefined) {
        console.log(dim(`    ${prefix}goalDone (not checked): noul ${f2(r.answers.goalDone)}`));
      }
      const nt = r.answers?.nextTask;
      if (nt && r.kind === "scenario" && !expect.nextTask) {
        const top = topOptions(nt, NEXT_RECORD_TOP_N).map((k) => `${k} ${f2(probOf(nt, k))}`);
        console.log(dim(`    ${prefix}nextTask (not checked): ${nt.choice}, confidence ${f2(nt.confidence)}; top ${NEXT_RECORD_TOP_N}: ${top.join(", ")}`));
      }
      // The link answers: always printed, since the app's "Next" gate matters as much as the pick.
      const ln = r.answers?.linkNext;
      if (ln && r.kind === "scenario") console.log(dim(`    ${prefix}linkNext${expect.linkNext ? "" : " (not checked)"}: ${ln.choice}; ${linkNextText(ln)}`));
      const la = r.answers?.linkAction;
      if (la && r.kind === "scenario") {
        const top = topOptions(la, NEXT_RECORD_TOP_N).map((k) => `${k} ${f2(probOf(la, k))}`);
        console.log(dim(`    ${prefix}linkAction${expect.linkAction ? "" : " (not checked)"}: ${la.choice}; top ${NEXT_RECORD_TOP_N}: ${top.join(", ")}`));
      }
    }
    const cons = consistency.find((x) => x.id === c.id);
    if (cons) {
      const drift = cons.maxDrift.key ? `; largest drift ${f2(cons.maxDrift.delta)} on ${cons.maxDrift.key}` : "";
      if (cons.stable) console.log(dim(`    same choices in every run${drift}`));
      else {
        const what = Object.entries(cons.changed).map(([k, v]) => `${k}: ${v.join(" then ")}`);
        console.log(red(`    CHANGED between runs: ${what.join("; ")}`) + dim(drift));
      }
    }
  }

  // The prep cases: every record's score is printed, since the order is the point.
  const prepById = new Map<string, PrepRun[]>();
  for (const r of prepRuns) prepById.set(r.id, [...(prepById.get(r.id) ?? []), r]);
  const prepCons = opts.repeat > 1 ? prepCases.map((c) => prepConsistency(c.id, prepById.get(c.id) ?? [])) : [];
  for (const c of prepCases) {
    const rs = prepById.get(c.id) ?? [];
    const passed = rs.filter((r) => r.pass).length;
    const infra = rs.some((r) => r.infraError);
    const ok = !infra && passed === rs.length;
    const word = infra ? "INFRA" : ok ? "pass" : "FAIL";
    const count = opts.repeat > 1 ? ` ${passed}/${rs.length}` : "";
    const cell = `${word}${count}`.padEnd(10).replace(word, ok ? green(word) : red(word));
    const ms = Math.round(median(rs.map((r) => r.latencyMs).sort((a, b) => a - b)));
    console.log(`${c.id.padEnd(idWidth)}${cell}${String(ms).padStart(6)}  ${dim(c.label)}`);
    for (const r of rs) {
      const prefix = opts.repeat > 1 ? `run ${r.run} ` : "";
      if (r.infraError) {
        console.log(red(`    ${prefix}heuristic answered: ${r.infraError}`));
        continue;
      }
      for (const k of r.checks) if (opts.verbose || !k.pass) console.log(checkLine(k, prefix));
      console.log(dim(`    ${prefix}scores: ${r.ranked.map((x) => `${x.id} ${f2(x.share)}`).join(", ")}; urgent ${f2(r.urgent)}`));
    }
    const cons = prepCons.find((x) => x.id === c.id);
    if (cons) {
      const drift = cons.maxDrift.key ? `; largest drift ${f2(cons.maxDrift.delta)} on ${cons.maxDrift.key}` : "";
      if (cons.stable) console.log(dim(`    same order and urgent verdict in every run${drift}`));
      else console.log(red(`    CHANGED between runs: ${Object.entries(cons.changed).map(([k, v]) => `${k}: ${v.join(" then ")}`).join("; ")}`) + dim(drift));
    }
  }

  // Summary
  const jevRuns = runs.filter((r) => !r.infraError);
  const latencies = jevRuns.map((r) => r.latencyMs).sort((a, b) => a - b);
  const tokens = jevRuns.map((r) => r.inputTokens).filter((t): t is number => t !== null);
  const meanTokens = tokens.length ? tokens.reduce((a, b) => a + b, 0) / tokens.length : 0;
  const costPerRequest = (meanTokens * USD_PER_MILLION_INPUT_TOKENS) / 1_000_000;
  const casePass = (kind: AdaptCase["kind"]) => {
    const ids = cases.filter((c) => c.kind === kind).map((c) => c.id);
    return { passed: ids.filter((id) => (byCase.get(id) ?? []).every((r) => r.pass)).length, total: ids.length };
  };
  const scenarioPass = casePass("scenario");
  const commandPass = casePass("command");
  const allChecks = runs.flatMap((r) => r.checks);
  const models = [...new Set(jevRuns.map((r) => r.model))];
  const infraFailures: { id: string; run: number; infraError: string | null }[] = [...runs, ...prepRuns].filter((r) => r.infraError);
  const prepChecksAll = prepRuns.flatMap((r) => r.checks);
  const prepPass = { passed: prepCases.filter((c) => (prepById.get(c.id) ?? []).every((r) => r.pass)).length, total: prepCases.length };
  const prepJev = prepRuns.filter((r) => !r.infraError);
  const prepLatencies = prepJev.map((r) => r.latencyMs).sort((a, b) => a - b);
  const prepTokens = prepJev.map((r) => r.inputTokens).filter((t): t is number => t !== null);
  const prepMeanTokens = prepTokens.length ? prepTokens.reduce((a, b) => a + b, 0) / prepTokens.length : 0;
  const nextRecord = nextRecordTally(runs);
  const listWorkChecks = allChecks.filter((k) => k.name === "listWork");
  const goalDoneChecks = allChecks.filter((k) => k.name === "goalDone");
  const nextTaskChecks = allChecks.filter((k) => k.name === "nextTask");
  const linkNextChecks = allChecks.filter((k) => k.name === "linkNext");
  const linkActionChecks = allChecks.filter((k) => k.name === "linkAction");

  console.log("");
  if (nScenarios) console.log(`Scenarios: ${scenarioPass.passed}/${scenarioPass.total} passed${opts.repeat > 1 ? " in every run" : ""}`);
  if (nCommands) console.log(`Commands:  ${commandPass.passed}/${commandPass.total} passed${opts.repeat > 1 ? " in every run" : ""}`);
  if (runs.length) console.log(`Checks:    ${allChecks.filter((k) => k.pass).length}/${allChecks.length} passed across ${runs.length} request(s)`);
  if (prepCases.length) {
    console.log(
      `Prep:      ${prepPass.passed}/${prepPass.total} cases passed${opts.repeat > 1 ? " in every run" : ""}, ${prepChecksAll.filter((k) => k.pass).length}/${prepChecksAll.length} checks across ${prepRuns.length} request(s)`,
    );
  }
  if (nextRecord.runs) {
    console.log(
      `Next rec:  top 1 ${nextRecord.top1}/${nextRecord.runs}, top ${NEXT_RECORD_TOP_N} ${nextRecord.top3}/${nextRecord.runs} (an accepted record among the ${NEXT_RECORD_TOP_N} most probable)`,
    );
  }
  if (listWorkChecks.length) console.log(`List work: ${listWorkChecks.filter((k) => k.pass).length}/${listWorkChecks.length} passed`);
  if (goalDoneChecks.length) console.log(`Goal done: ${goalDoneChecks.filter((k) => k.pass).length}/${goalDoneChecks.length} passed`);
  if (nextTaskChecks.length) console.log(`Next task: ${nextTaskChecks.filter((k) => k.pass).length}/${nextTaskChecks.length} passed`);
  if (linkNextChecks.length) console.log(`Link next: ${linkNextChecks.filter((k) => k.pass).length}/${linkNextChecks.length} passed`);
  if (linkActionChecks.length) console.log(`Link act:  ${linkActionChecks.filter((k) => k.pass).length}/${linkActionChecks.length} passed`);
  if (consistency.length || prepCons.length) {
    const unstable = [...consistency, ...prepCons].filter((x) => !x.stable).map((x) => x.id);
    console.log(`Repeat:    ${unstable.length ? red(`choices changed in ${unstable.join(", ")}`) : "choices identical in every run"}`);
  }
  if (latencies.length === 0) {
    console.log("Latency:   no Jev answers to measure");
  } else {
    console.log(
      `Latency:   median ${Math.round(median(latencies))} ms, p95 ${Math.round(percentile(latencies, 95))} ms over ${latencies.length} Jev request(s), model ${models.join(", ")}`,
    );
    console.log(
      `Tokens:    mean ${Math.round(meanTokens).toLocaleString("en-US")} input tokens per request, about $${costPerRequest.toFixed(6)} per request at $${USD_PER_MILLION_INPUT_TOKENS} per million input tokens`,
    );
  }
  if (prepLatencies.length) {
    console.log(
      `Prep cost: median ${Math.round(median(prepLatencies))} ms, mean ${Math.round(prepMeanTokens).toLocaleString("en-US")} input tokens per request, about $${((prepMeanTokens * USD_PER_MILLION_INPUT_TOKENS) / 1_000_000).toFixed(6)}`,
    );
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    options: opts,
    models,
    summary: {
      scenarios: scenarioPass,
      commands: commandPass,
      checks: { passed: allChecks.filter((k) => k.pass).length, total: allChecks.length },
      nextRecord,
      listWork: { passed: listWorkChecks.filter((k) => k.pass).length, total: listWorkChecks.length },
      goalDone: { passed: goalDoneChecks.filter((k) => k.pass).length, total: goalDoneChecks.length },
      nextTask: { passed: nextTaskChecks.filter((k) => k.pass).length, total: nextTaskChecks.length },
      linkNext: { passed: linkNextChecks.filter((k) => k.pass).length, total: linkNextChecks.length },
      linkAction: { passed: linkActionChecks.filter((k) => k.pass).length, total: linkActionChecks.length },
      infraFailures: infraFailures.length,
      latencyMs: { median: median(latencies), p95: percentile(latencies, 95), min: latencies[0] ?? 0, max: latencies.at(-1) ?? 0 },
      meanInputTokens: meanTokens,
      usdPerRequest: costPerRequest,
      prep: {
        cases: prepPass,
        checks: { passed: prepChecksAll.filter((k) => k.pass).length, total: prepChecksAll.length },
        latencyMs: { median: median(prepLatencies), p95: percentile(prepLatencies, 95) },
        meanInputTokens: prepMeanTokens,
      },
    },
    consistency: [...consistency, ...prepCons],
    runs,
    prepRuns,
  };
  writeFileSync(OUT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Details:   ${OUT_FILE.replace(`${process.cwd()}/`, "")}`);

  if (infraFailures.length) {
    loudInfraBanner(infraFailures);
    process.exit(2);
  }
  process.exit(runs.every((r) => r.pass) && prepRuns.every((r) => r.pass) ? 0 : 1);
}

await main();
