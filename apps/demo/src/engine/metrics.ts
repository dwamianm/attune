/**
 * Per-session measurement of the predictive flow, for the inspector's
 * Metrics tab (docs/predictive-flow.md): how often the next record and the
 * next action were predicted, how much navigating the user still did by
 * hand, how often the Up next card was taken, and how calm the layout was.
 *
 * Pure counting: the store calls these reducers as rounds land and signals
 * arrive, and summarizeMetrics turns the counters into plain lines.
 */
import { ACTIONS, type ActionId } from "../../shared/catalog.ts";
import type { ChoiceJudgment, SignalEvent } from "../../shared/types.ts";
import type { FlowMetrics, PredictionScore } from "./contract.ts";
import { rankedRecords, recordKey } from "./nextUp.ts";
import { kindOfId } from "./relations.ts";

/** Predictions checked per round: the card shows one pick and two chips, so "hit at 3" is what the user could click. */
export const PREDICTION_TOP_N = 3;
/** Rates per minute divide by at least this many minutes, so the first seconds of a session do not read as a storm of changes. */
export const METRICS_MIN_MINUTES = 1;
/** Navigation effort is reported per this many performed actions. */
export const EFFORT_PER_ACTIONS = 10;

function emptyScore(): PredictionScore {
  return { hit1: 0, hit3: 0, miss: 0, none: 0 };
}

export function emptyMetrics(): FlowMetrics {
  return {
    startedAt: null,
    nextRecord: emptyScore(),
    pendingRecord: null,
    nextAction: emptyScore(),
    pendingAction: null,
    effort: { dockOpens: 0, searches: 0, scrolls: 0, commands: 0, backTo: 0, actions: 0 },
    upNext: { shown: 0, openedClick: 0, openedKey: 0, openedAlternative: 0, lastShown: null },
    undos: 0,
    layoutChanges: 0,
    quiet: { went: 0, reopened: 0 },
    taskDone: { done: 0, offered: 0, started: 0 },
    habits: { guessed: 0, right: 0 },
    prep: { offered: 0, prepared: 0, opened: 0 },
  };
}

/** Score one outcome against the top predictions (empty or null: nothing was predicted). */
function score(s: PredictionScore, top: readonly string[] | null, actual: string): PredictionScore {
  if (!top || top.length === 0) return { ...s, none: s.none + 1 };
  const i = top.slice(0, PREDICTION_TOP_N).indexOf(actual);
  if (i === 0) return { ...s, hit1: s.hit1 + 1, hit3: s.hit3 + 1 };
  if (i > 0) return { ...s, hit3: s.hit3 + 1 };
  return { ...s, miss: s.miss + 1 };
}

export interface RoundPrediction {
  nextRecord?: ChoiceJudgment<string>;
  /** Code's pick (the next record in the current list), used when Jev gave no record. */
  codePick: string | null;
  nextAction?: ChoiceJudgment<ActionId>;
}

/**
 * An applied round: remember its top PREDICTION_TOP_N next records (or
 * code's pick when Jev gave none, or chose "none") and its top next actions
 * (nothing when Jev chose "none"), to score against the user's next open
 * and next action.
 */
export function recordRoundPrediction(m: FlowMetrics, r: RoundPrediction): FlowMetrics {
  const jevRecords = r.nextRecord && r.nextRecord.choice !== "none" ? rankedRecords(r.nextRecord).slice(0, PREDICTION_TOP_N).map((x) => x.id) : [];
  const pendingRecord: FlowMetrics["pendingRecord"] =
    jevRecords.length > 0 ? { top: jevRecords, source: "jev" } : r.codePick ? { top: [r.codePick], source: "code" } : null;
  const na = r.nextAction;
  let pendingAction: ActionId[] | null = null;
  if (na && na.choice !== "none" && ACTIONS[na.choice]) {
    const ids = new Set<ActionId>([na.choice, ...(Object.keys(na.probabilities ?? {}) as ActionId[])]);
    ids.delete("none");
    const p = (id: ActionId) => na.probabilities?.[id] ?? (id === na.choice ? na.confidence : 0);
    pendingAction = [...ids]
      .filter((id) => ACTIONS[id])
      .sort((a, b) => p(b) - p(a) || a.localeCompare(b))
      .slice(0, PREDICTION_TOP_N);
  }
  return { ...m, pendingRecord, pendingAction };
}

/** The record an open names, as a RecordCandidate id. */
function openedRecord(e: SignalEvent): string | null {
  const id = e.detail?.itemId;
  if (!id) return null;
  const kind = e.detail?.itemKind ?? kindOfId(id);
  return kind ? recordKey(kind, id) : null;
}

/**
 * One signal. `upNextPick` is the record the Up next card offered when the
 * signal arrived, so an open of it counts as taking the card's pick and an
 * open of another record from the card counts as an alternative.
 */
export function metricsOnEvent(m: FlowMetrics, e: SignalEvent, upNextPick: string | null): FlowMetrics {
  // The engine's own note is not something the user did, and a settings switch is not work.
  if (e.type === "context_save" || e.type === "setting_change") return m;
  // Focus aid 2: the engine said the work is done, offering a next task when detail.task is set. Not user activity either.
  if (e.type === "task_done") {
    const t = m.taskDone;
    return { ...m, taskDone: { ...t, done: t.done + 1, offered: t.offered + (e.detail?.task ? 1 : 0) } };
  }
  // Focus aid 4: the engine offered to prepare for a meeting. Not user activity either.
  if (e.type === "prep_offer") return { ...m, prep: { ...m.prep, offered: m.prep.offered + 1 } };
  const next: FlowMetrics = { ...m, startedAt: m.startedAt ?? e.t };
  const effort = { ...m.effort };
  switch (e.type) {
    case "item_open":
    case "up_next_open":
    case "task_start":
    case "prep_start": {
      const key = openedRecord(e);
      if (key) {
        next.nextRecord = score(m.nextRecord, m.pendingRecord?.top ?? null, key);
        next.pendingRecord = null;
      }
      if (e.type === "task_start") next.taskDone = { ...m.taskDone, started: m.taskDone.started + 1 };
      if (e.type === "prep_start") next.prep = { ...m.prep, prepared: m.prep.prepared + 1 };
      if (e.type === "up_next_open") {
        const u = { ...m.upNext };
        if (key && key === upNextPick) {
          if (e.detail?.via === "keyboard") u.openedKey += 1;
          else u.openedClick += 1;
        } else {
          u.openedAlternative += 1;
        }
        next.upNext = u;
      }
      break;
    }
    case "action": {
      effort.actions += 1;
      const id = e.detail?.actionId;
      if (id && id !== "none") {
        next.nextAction = score(m.nextAction, m.pendingAction, id);
        next.pendingAction = null;
      }
      break;
    }
    case "panel_open":
      // From the dock by hand; an open from a suggestion, a command, or Up next is not the user navigating.
      if (e.detail?.via !== "suggestion" && e.detail?.via !== "command") effort.dockOpens += 1;
      break;
    case "search":
      if ((e.detail?.query ?? "").trim()) effort.searches += 1;
      break;
    case "scroll":
      effort.scrolls += 1;
      break;
    case "command":
      if ((e.detail?.query ?? "").trim()) effort.commands += 1;
      break;
    case "context_restore":
      effort.backTo += 1;
      break;
    case "undo":
      next.undos = m.undos + 1;
      break;
    default:
      break;
  }
  next.effort = effort;
  return next;
}

/** The Up next card now shows `id` (or nothing). A new record on the card counts as one shown. */
export function metricsOnUpNextShown(m: FlowMetrics, id: string | null): FlowMetrics {
  if (id === m.upNext.lastShown) return m;
  return { ...m, upNext: { ...m.upNext, lastShown: id, shown: m.upNext.shown + (id ? 1 : 0) } };
}

/** `count` more panels went quiet (focus aid 1, docs/focus-aids.md). */
export function metricsOnQuietWent(m: FlowMetrics, count: number): FlowMetrics {
  return count > 0 ? { ...m, quiet: { ...m.quiet, went: m.quiet.went + count } } : m;
}

/** The user clicked into or used a panel that showed quiet: a sign the fade was wrong. */
export function metricsOnQuietReopened(m: FlowMetrics): FlowMetrics {
  return { ...m, quiet: { ...m.quiet, reopened: m.quiet.reopened + 1 } };
}

/**
 * Focus aid 3: the habits had a guess for a move the user made (the top next
 * panel, or where the session usually starts), and whether it was right.
 * Counted with the aid on or off, so the user can judge the habits.
 */
export function metricsOnHabitGuess(m: FlowMetrics, right: boolean): FlowMetrics {
  return { ...m, habits: { guessed: m.habits.guessed + 1, right: m.habits.right + (right ? 1 : 0) } };
}

/** Focus aid 4: the user opened a record the prep view linked, for the first time this session. */
export function metricsOnPrepOpened(m: FlowMetrics): FlowMetrics {
  return { ...m, prep: { ...m.prep, opened: m.prep.opened + 1 } };
}

/** The engine applied a layout change (a Jev round or a command). */
export function metricsOnLayoutChange(m: FlowMetrics): FlowMetrics {
  return { ...m, layoutChanges: m.layoutChanges + 1 };
}

export interface MetricLine {
  id: string;
  label: string;
  /** The number, in words and digits, for example "2 of 3 (67%)". */
  value: string;
  /** One plain line on what it means. */
  explain: string;
}

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : "no data";
}

function ofText(n: number, d: number): string {
  return d > 0 ? `${n} of ${d} (${pct(n, d)})` : "none yet";
}

function oneDecimal(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

/** What the Metrics tab knows about now that the counters do not: the quiet panels on the canvas, or null with that aid off. */
export interface MetricsNow {
  quietNow: number | null;
}

/** The counters as plain lines for the Metrics tab. */
export function summarizeMetrics(m: FlowMetrics, now: number, current: MetricsNow = { quietNow: null }): MetricLine[] {
  const rec = m.nextRecord;
  const recPredicted = rec.hit3 + rec.miss;
  const act = m.nextAction;
  const actPredicted = act.hit3 + act.miss;
  const e = m.effort;
  const nav = e.dockOpens + e.searches + e.scrolls + e.commands + e.backTo;
  const accepted = m.upNext.openedClick + m.upNext.openedKey;
  const minutes = m.startedAt === null ? 0 : Math.max(METRICS_MIN_MINUTES, (now - m.startedAt) / 60_000);
  return [
    {
      id: "record-hit1",
      label: "Next record, hit at 1",
      value: ofText(rec.hit1, recPredicted),
      explain: "Records you opened that were the first prediction (Jev, or the next in the list when Jev gave none).",
    },
    {
      id: "record-hit3",
      label: "Next record, hit at 3",
      value: ofText(rec.hit3, recPredicted),
      explain: `Records you opened that were in the top 3 predictions. ${rec.none} ${rec.none === 1 ? "open had" : "opens had"} no prediction.`,
    },
    {
      id: "action-hit1",
      label: "Next action, hit at 1",
      value: ofText(act.hit1, actPredicted),
      explain: "Actions you performed that were Jev's first choice for the next step.",
    },
    {
      id: "action-hit3",
      label: "Next action, hit at 3",
      value: ofText(act.hit3, actPredicted),
      explain: `Actions you performed that were in Jev's top 3. ${act.none} ${act.none === 1 ? "action had" : "actions had"} no prediction.`,
    },
    {
      id: "effort",
      label: `Navigation per ${EFFORT_PER_ACTIONS} actions`,
      value: e.actions > 0 ? oneDecimal((nav / e.actions) * EFFORT_PER_ACTIONS) : `${nav} so far, no actions yet`,
      explain: `Dock opens ${e.dockOpens}, searches ${e.searches}, list scrolls ${e.scrolls}, command bar ${e.commands}, Back to ${e.backTo}, over ${e.actions} ${e.actions === 1 ? "action" : "actions"}. Lower means less navigating.`,
    },
    {
      id: "up-next",
      label: "Up next taken",
      value: ofText(accepted, m.upNext.shown),
      explain: `Cards you opened (click ${m.upNext.openedClick}, key ${m.upNext.openedKey}) out of records the card showed. Chips opened: ${m.upNext.openedAlternative}.`,
    },
    {
      id: "undo-rate",
      label: "Undo rate",
      value: m.layoutChanges > 0 ? `${m.undos} of ${m.layoutChanges} (${pct(m.undos, m.layoutChanges)})` : `${m.undos} undos, no layout changes yet`,
      explain: "Undos per layout change the app made. Lower means the changes were wanted.",
    },
    {
      id: "changes-per-minute",
      label: "Layout changes per minute",
      value: minutes > 0 ? oneDecimal(m.layoutChanges / minutes) : "none yet",
      explain: `${m.layoutChanges} ${m.layoutChanges === 1 ? "change" : "changes"} since the first signal. Lower is calmer.`,
    },
    {
      id: "quiet",
      label: "Quiet panels",
      value: current.quietNow === null ? "off" : `${current.quietNow} now`,
      explain:
        m.quiet.went > 0
          ? `You reopened ${m.quiet.reopened} of the ${m.quiet.went} ${m.quiet.went === 1 ? "panel that" : "panels that"} went quiet (${pct(m.quiet.reopened, m.quiet.went)}). A reopen is a sign the fade was wrong, so lower is better.`
          : "No panel has gone quiet yet. A panel Jev rates as not needed for two rounds fades and shrinks.",
    },
    {
      id: "tasks-done",
      label: "Tasks marked done",
      value: String(m.taskDone.done),
      explain:
        m.taskDone.done > 0
          ? `Times the Done card said the work in front of you was finished (${m.taskDone.offered} of them offered a next task).`
          : "The Done card has not said a task is done yet. It does when the work of your current goal is finished.",
    },
    {
      id: "next-task",
      label: "Next task started",
      value: ofText(m.taskDone.started, m.taskDone.offered),
      explain: "Next tasks you started from the Done card (click or n) out of those it offered.",
    },
    {
      id: "habit-guess",
      label: "Habit guess right",
      value: m.habits.guessed > 0 ? `${m.habits.right} of ${m.habits.guessed} (${pct(m.habits.right, m.habits.guessed)})` : "none yet",
      explain:
        "Moves where your habits pointed to a next panel (or where you usually start), and how often you went there. Counted with Learn my habits on or off, so you can judge them.",
    },
    {
      id: "meeting-prep",
      label: "Meetings prepared",
      value: ofText(m.prep.prepared, m.prep.offered),
      explain: `The prep chip offered ${m.prep.offered} ${m.prep.offered === 1 ? "meeting" : "meetings"} before ${m.prep.offered === 1 ? "it" : "they"} started, and you prepared for ${m.prep.prepared} (Prepare or p).`,
    },
    {
      id: "prep-opened",
      label: "Records opened from a prep view",
      value: String(m.prep.opened),
      explain:
        m.prep.prepared > 0
          ? "Records linked for a meeting that you then opened, each counted once. Opening them is the point of the prep view."
          : "No meeting prepared yet. After Prepare, each record you open from the linked panels counts once.",
    },
  ];
}
