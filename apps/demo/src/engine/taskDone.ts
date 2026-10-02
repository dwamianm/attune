/**
 * Focus aid 2, "Say when a task is done" (docs/focus-aids.md): when the work
 * of the working goal is finished, say so and offer the next task.
 *
 * Code facts come first. Where the data can say a goal is done (collecting
 * payments, the inbox, projects), goalFact answers from the data and Jev is
 * not needed. The other goals rely on Jev's goal-done Noul, at or above
 * TASK_DONE_JEV_AT for TASK_DONE_ROUNDS rounds in a row (countDoneRound,
 * judgeTaskDone), and never in the first minute of a working goal.
 *
 * Code also builds the next-task candidates: the pending work of every goal
 * other than the working goal, as short plain items with a count and a
 * first record (buildNextTasks), ranked by a simple code priority
 * (TASK_PRIORITY) plus an optional boost, the extension point for aid 3's
 * habits (TaskBoost). chooseNextTask offers Jev's nextTask when Jev is sure
 * enough, else code's top candidate. Starting a task only opens its panel,
 * sets its filter, and selects its first record (taskViewPatch); it never
 * performs an action.
 *
 * Pure: no DOM, no store, no clock except `now`. Record labels use the same
 * formatters as the panels' item_open labels, so Jev reads one wording.
 */
import { GOALS, type GoalId } from "../../shared/catalog.ts";
import type { CalendarEvent, Project } from "../../shared/fixtures.ts";
import type { ChoiceJudgment } from "../../shared/types.ts";
import { clockTime, dayOffset, daysUntil, eventLabel, invoiceLabel, messageLabel, projectLabel, taskDueText } from "../ui/format.ts";
import type { AppData, NextTask, PanelViewState, WorkingGoal } from "./contract.ts";
import { rankedRecords, recordKey, type RevealPatch } from "./nextUp.ts";
import { numberWord } from "@attuneui/core";

// ---------------------------------------------------------------------------
// Constants. Demo defaults; tune them here.
// ---------------------------------------------------------------------------

/** Jev's goal-done Noul at or above this counts toward done, for a goal with no code fact: well past the unsure middle, since saying "done" too early is worse than a round late. */
export const TASK_DONE_JEV_AT = 0.75;
/** ...for this many applied rounds in a row, so one stray round never says done (the same rule as a goal switch). */
export const TASK_DONE_ROUNDS = 2;
/** Never in the first minute of a working goal: the work has barely started, and a fresh goal can arrive with its work already done. */
export const TASK_DONE_MIN_WORK_MS = 60_000;
/** "Not now" hides the Done card for that goal this long: long enough to finish a thought, short enough to come back while it still matters. */
export const TASK_DONE_SNOOZE_MS = 5 * 60_000;
/**
 * Task candidates are sent to Jev only when the working goal might be done
 * (its code fact is true, or the previous round's goal-done is at least
 * this), so most requests carry none and cost no extra tokens. Below
 * TASK_DONE_JEV_AT, so Jev has already picked a next task by the round that says done.
 */
export const TASK_CANDIDATES_AT = 0.5;
/** Most task candidates sent (the contract's cap): one per goal with pending work fits. */
export const TASK_CANDIDATES_MAX = 5;
/**
 * The gate on Jev's nextTask, in the spirit of the Up next gate
 * (UP_NEXT_JEV_* in ./nextUp.ts): a pick this likely shows on its own...
 */
export const NEXT_TASK_JEV_MIN_P = 0.5;
/** ...or a pick this likely... */
export const NEXT_TASK_JEV_LEAN_P = 0.4;
/** ...that leads the next task by at least this much (a near tie is a guess)... */
export const NEXT_TASK_JEV_MARGIN = 0.15;
/** ...while Jev gives "none" (no task fits) less than this. Below the gate, code's top-ranked task shows instead. */
export const NEXT_TASK_JEV_NONE_MAX = 0.2;
/** A meeting that starts within this long ranks first: it has a set time, and there is just enough time to get ready. */
export const MEETING_SOON_MS = 60 * 60_000;

/** The kinds of pending work, one per goal other than plan_day, which has two (tasks due today and the next meeting). */
export type NextTaskId = "next_meeting" | "unread_messages" | "overdue_invoices" | "tasks_due_today" | "projects_at_risk";

/**
 * Code's priority per kind of pending work, higher first, and its reason in
 * a few words (the card's chip when code chose the task). Whole numbers one
 * apart, so a TaskBoost under 1 only reorders near neighbors.
 */
export const TASK_PRIORITY: Record<NextTaskId | "meeting_later", { priority: number; why: string }> = {
  // A meeting soon has a set time: getting ready for it cannot wait.
  next_meeting: { priority: 5, why: "Starts soon" },
  // A client is waiting on a reply, and a reply is quick.
  unread_messages: { priority: 4, why: "Clients are waiting" },
  // Money owed gets later every day it waits.
  overdue_invoices: { priority: 3, why: "Money is owed" },
  // Due by the end of the day, so there is still some time.
  tasks_due_today: { priority: 2, why: "Due today" },
  // Usually a longer look: best after the quick items.
  projects_at_risk: { priority: 1, why: "Needs attention" },
  // A meeting later today is on the list, but not the next thing.
  meeting_later: { priority: 0.5, why: "Later today" },
};

/**
 * Extension point for focus aid 3 ("Learn habits"): a score added to a
 * task's code priority, for example how often the user went from the goal
 * they just finished (`finished`) to this task's goal. Return 0 for no
 * change. Priorities are one apart, so keep a boost under 1 to reorder only
 * near neighbors, or larger to let a habit win outright.
 */
export type TaskBoost = (task: NextTask, finished: GoalId | null) => number;

// ---------------------------------------------------------------------------
// Code facts
// ---------------------------------------------------------------------------

/** What the data says about a goal: whether it is done, and the Done card's line. */
export interface GoalFact {
  done: boolean;
  /** "Payments done". */
  title: string;
  /** "every overdue invoice has a reminder.". */
  detail: string;
}

/** Overdue invoices without a reminder this session (a reminder, or any action, makes an invoice handled), most overdue first. */
function overdueWithoutReminder(data: AppData, handled: ReadonlySet<string>) {
  return data.invoices.filter((i) => i.status === "overdue" && !handled.has(recordKey("invoice", i.id))).sort((a, b) => a.due.localeCompare(b.due));
}

/** Unread messages from client companies, newest first. A teammate's message is not client work. */
function unreadClientMessages(data: AppData) {
  return data.messages.filter((m) => m.unread && m.client).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
}

/** Projects at risk or blocked, soonest deadline first (the Projects panel's order). */
function projectsNeedingWork(data: AppData): Project[] {
  return data.projects.filter((p) => p.status === "at_risk" || p.status === "blocked").sort((a, b) => a.deadline.localeCompare(b.deadline));
}

/** Open tasks due today or already late, soonest first. */
function tasksDueNow(data: AppData, now: number) {
  return data.tasks.filter((t) => !t.done && daysUntil(t.due, now) <= 0).sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
}

/** Goals whose done check is a code fact (goalFact); the rest rely on Jev's goal-done Noul. */
const FACT_GOALS: ReadonlySet<GoalId> = new Set<GoalId>(["collect_payments", "triage_inbox", "track_projects"]);

/** Whether the data can say this goal is done (goalFact is not null for it). */
export function hasGoalFact(goal: GoalId): boolean {
  return FACT_GOALS.has(goal);
}

/**
 * The done check for a goal where the data can say it, or null for a goal
 * that relies on Jev (plan_day, manage_client, review_business,
 * coordinate_team, capture_notes). `handled` is handledRecords of the
 * session's events (./nextUp.ts).
 * - collect_payments: no overdue invoice is left without a reminder this session (or none is overdue);
 * - triage_inbox: no unread message from a client is left;
 * - track_projects: no project is at risk or blocked.
 */
export function goalFact(goal: GoalId, data: AppData, handled: ReadonlySet<string>): GoalFact | null {
  switch (goal) {
    case "collect_payments": {
      const anyOverdue = data.invoices.some((i) => i.status === "overdue");
      return {
        done: overdueWithoutReminder(data, handled).length === 0,
        title: "Payments done",
        detail: anyOverdue ? "every overdue invoice has a reminder." : "no invoice is overdue.",
      };
    }
    case "triage_inbox":
      return { done: unreadClientMessages(data).length === 0, title: "Inbox done", detail: "no unread client messages left." };
    case "track_projects":
      return { done: projectsNeedingWork(data).length === 0, title: "Projects done", detail: "no project is at risk or blocked." };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// The done rule
// ---------------------------------------------------------------------------

/** Jev's goal-done rounds for one working context: how many in a row were at or above TASK_DONE_JEV_AT. */
export interface DoneRounds {
  /** The working context counted (its goal and since); null before there is one. */
  goal: GoalId | null;
  since: number;
  streak: number;
  /** The newest round counted, so the same round never counts twice. */
  version: number;
  /** The newest round's goal-done, or null when that round did not ask it. */
  last: number | null;
}

export function emptyDoneRounds(): DoneRounds {
  return { goal: null, since: 0, streak: 0, version: 0, last: null };
}

/**
 * One applied round's goal-done for the working context. A new working
 * context starts over; a round without a goal-done (the aid was off, or no
 * working goal was sent), or below TASK_DONE_JEV_AT, breaks the streak.
 */
export function countDoneRound(t: DoneRounds, working: WorkingGoal | null, goalDone: number | undefined, version: number): DoneRounds {
  if (!working) return emptyDoneRounds();
  const last = typeof goalDone === "number" && Number.isFinite(goalDone) ? goalDone : null;
  const high = last !== null && last >= TASK_DONE_JEV_AT;
  if (t.goal !== working.goal || t.since !== working.since) return { goal: working.goal, since: working.since, streak: high ? 1 : 0, version, last };
  if (version <= t.version) return t;
  return { ...t, streak: high ? t.streak + 1 : 0, version, last };
}

/** Whether the counted rounds are about this working context. */
function sameContext(rounds: DoneRounds, working: WorkingGoal): boolean {
  return rounds.goal === working.goal && rounds.since === working.since;
}

export type DoneVerdict =
  /** Not done. `waitUntil`: it would be, but the working goal is younger than TASK_DONE_MIN_WORK_MS; ask again then. */
  | { done: false; waitUntil?: number }
  | { done: true; source: "code" | "jev"; title: string; detail?: string; probability?: number };

export interface DoneInput {
  working: WorkingGoal | null;
  /** goalFact for the working goal, or null when it has none. */
  fact: GoalFact | null;
  rounds: DoneRounds;
  now: number;
}

/**
 * The done rule. Done when the working goal's code fact is true, or, for a
 * goal without one, when Jev's goal-done was at least TASK_DONE_JEV_AT for
 * TASK_DONE_ROUNDS rounds in a row in this working context; never in the
 * first TASK_DONE_MIN_WORK_MS of a working goal. A goal with a code fact
 * ignores Jev's goal-done: the data is sure.
 */
export function judgeTaskDone(input: DoneInput): DoneVerdict {
  const { working, fact, rounds, now } = input;
  if (!working || working.goal === "unclear" || !GOALS[working.goal]) return { done: false };
  let verdict: Extract<DoneVerdict, { done: true }>;
  if (fact) {
    if (!fact.done) return { done: false };
    verdict = { done: true, source: "code", title: fact.title, detail: fact.detail };
  } else {
    if (!sameContext(rounds, working) || rounds.streak < TASK_DONE_ROUNDS) return { done: false };
    verdict = { done: true, source: "jev", title: `${GOALS[working.goal].label} looks done`, ...(rounds.last !== null ? { probability: rounds.last } : {}) };
  }
  const ready = working.since + TASK_DONE_MIN_WORK_MS;
  return now < ready ? { done: false, waitUntil: ready } : verdict;
}

/**
 * Whether the next request carries task candidates: only when the working
 * goal might be done, so most requests cost no extra tokens. With a code
 * fact, when the fact is true; without one, when the previous round in this
 * working context judged goal-done at TASK_CANDIDATES_AT or more.
 */
export function mightBeDone(working: WorkingGoal | null, fact: GoalFact | null, rounds: DoneRounds): boolean {
  if (!working || working.goal === "unclear") return false;
  if (fact) return fact.done;
  return sameContext(rounds, working) && rounds.last !== null && rounds.last >= TASK_CANDIDATES_AT;
}

// ---------------------------------------------------------------------------
// Next-task candidates
// ---------------------------------------------------------------------------

/** "1 blocked project", "2 unread client messages": a count and a noun, plural when needed. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** Events that are meetings with other people: a focus block is not a task to start. */
const MEETING_KINDS: ReadonlySet<CalendarEvent["kind"]> = new Set<CalendarEvent["kind"]>(["meeting", "call", "internal"]);
const MEETING_WORD: Record<CalendarEvent["kind"], string> = { meeting: "Meeting", call: "Call", internal: "Meeting", focus: "Focus time" };

/** How soon a meeting starts, in words, because Jev reads words better than clock math. */
function startsInWords(ms: number, start: string): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 10) return "starting in a few minutes";
  if (minutes < 45) return "starting in about half an hour";
  if (minutes < 90) return "starting in about an hour";
  return `starting later today at ${clockTime(start)}`;
}

export interface NextTaskInput {
  data: AppData;
  /** handledRecords of the session's events (./nextUp.ts): an invoice with a reminder this session is handled. */
  handled: ReadonlySet<string>;
  now: number;
  /** The working goal: its own work is never a next task. */
  exclude: GoalId | null;
  /** Focus aid 3's habit score, added to the code priority. Absent: code's priority alone. */
  boost?: TaskBoost;
  /** The chip's words (NextTask.why) for a task the boost moved ahead of one code ranked higher. Absent: code's reason stays. */
  boostWhy?: string;
}

/**
 * The pending work of every goal other than `exclude`, as short plain items
 * with a count and a first record, highest priority first (TASK_PRIORITY plus
 * the boost; ties keep this order):
 * - unread client messages (first: the newest unread), triage_inbox;
 * - overdue invoices without a reminder this session (first: the most overdue), collect_payments;
 * - open tasks due today or late (first: the soonest due), plan_day;
 * - projects at risk or blocked (first: the soonest deadline), track_projects;
 * - the next meeting today that has not started yet, plan_day.
 * Kinds with nothing pending are left out.
 */
export function buildNextTasks(input: NextTaskInput): NextTask[] {
  const { data, handled, now, exclude } = input;
  const out: NextTask[] = [];
  /** One kind of pending work: its priority key (TASK_PRIORITY) and its label for Jev. */
  const add = (task: Omit<NextTask, "priority" | "why" | "candidate"> & { id: NextTaskId }, kind: NextTaskId | "meeting_later", label: string) => {
    if (task.goal === exclude) return;
    const base = TASK_PRIORITY[kind];
    out.push({
      ...task,
      priority: base.priority,
      why: base.why,
      candidate: { id: task.id, goal: task.goal, label, count: numberWord(task.count), first: task.first.label },
    });
  };

  const unread = unreadClientMessages(data);
  if (unread.length > 0) {
    const m = unread[0];
    const n = unread.length;
    add(
      {
        id: "unread_messages",
        goal: "triage_inbox",
        panel: "inbox",
        count: n,
        text: `${n} unread client ${plural(n, "message", "messages")}`,
        words: `${numberWord(n)} unread client ${plural(n, "message", "messages")}`,
        first: { kind: "message", id: m.id, label: messageLabel(m), ...(m.client ? { client: m.client } : {}) },
      },
      "unread_messages",
      "Unread client messages to reply to",
    );
  }

  const overdue = overdueWithoutReminder(data, handled);
  if (overdue.length > 0) {
    const inv = overdue[0];
    const n = overdue.length;
    add(
      {
        id: "overdue_invoices",
        goal: "collect_payments",
        panel: "invoices",
        count: n,
        text: `${n} overdue ${plural(n, "invoice", "invoices")} without a reminder`,
        words: `${numberWord(n)} overdue ${plural(n, "invoice", "invoices")} without a reminder`,
        first: { kind: "invoice", id: inv.id, label: invoiceLabel(inv, now), client: inv.client },
      },
      "overdue_invoices",
      "Overdue invoices that still need a payment reminder",
    );
  }

  const due = tasksDueNow(data, now);
  if (due.length > 0) {
    const t = due[0];
    const n = due.length;
    const when = due.some((x) => daysUntil(x.due, now) < 0) ? "due today or late" : "due today";
    add(
      {
        id: "tasks_due_today",
        goal: "plan_day",
        panel: "tasks",
        count: n,
        text: `${n} ${plural(n, "task", "tasks")} ${when}`,
        words: `${numberWord(n)} ${plural(n, "task", "tasks")} ${when}`,
        first: { kind: "task", id: t.id, label: `${t.title} (${taskDueText(t, now)})`, ...(t.client ? { client: t.client } : {}) },
      },
      "tasks_due_today",
      `To-do items ${when}`,
    );
  }

  const projects = projectsNeedingWork(data);
  if (projects.length > 0) {
    const p = projects[0];
    const n = projects.length;
    const blocked = projects.filter((x) => x.status === "blocked").length;
    const what = blocked === n ? plural(n, "blocked project", "blocked projects") : blocked === 0 ? `${plural(n, "project", "projects")} at risk` : "projects at risk or blocked";
    add(
      {
        id: "projects_at_risk",
        goal: "track_projects",
        panel: "projects",
        count: n,
        text: `${n} ${what}`,
        words: `${numberWord(n)} ${what}`,
        first: { kind: "project", id: p.id, label: projectLabel(p), client: p.client },
      },
      "projects_at_risk",
      what.charAt(0).toUpperCase() + what.slice(1),
    );
  }

  const meeting = [...data.events]
    .filter((e) => MEETING_KINDS.has(e.kind) && dayOffset(e.start, now) === 0 && new Date(e.start).getTime() > now)
    .sort((a, b) => a.start.localeCompare(b.start))[0];
  if (meeting) {
    const inMs = new Date(meeting.start).getTime() - now;
    const minutes = Math.max(1, Math.round(inMs / 60_000));
    const soon = inMs <= MEETING_SOON_MS;
    const when = soon ? `in ${minutes} ${plural(minutes, "minute", "minutes")}` : `at ${clockTime(meeting.start)}`;
    const inWords = startsInWords(inMs, meeting.start);
    add(
      {
        id: "next_meeting",
        goal: "plan_day",
        panel: "calendar",
        count: 1,
        // "Meeting in 40 minutes: Harbor rebrand review"; a title that already says what it is reads "Call with Meridian about install at 15:30".
        text: meeting.title.toLowerCase().startsWith(MEETING_WORD[meeting.kind].toLowerCase()) ? `${meeting.title} ${when}` : `${MEETING_WORD[meeting.kind]} ${when}: ${meeting.title}`,
        words: `the next meeting, ${meeting.title}, ${inWords}`,
        first: { kind: "event", id: meeting.id, label: eventLabel(meeting, now), ...(meeting.client ? { client: meeting.client } : {}) },
      },
      soon ? "next_meeting" : "meeting_later",
      `Next meeting today, ${inWords}`,
    );
  }

  const boosted = input.boost ? out.map((t) => ({ ...t, priority: t.priority + (input.boost?.(t, exclude) ?? 0) })) : out;
  // Stable: equal priorities keep the order above.
  const rank = (list: NextTask[]) =>
    list
      .map((t, i) => ({ t, i }))
      .sort((a, b) => b.t.priority - a.t.priority || a.i - b.i)
      .map(({ t }) => t);
  const ranked = rank(boosted);
  if (!input.boost || !input.boostWhy) return ranked;
  // A task now ahead of one code ranked higher got there by the boost, so its chip says why.
  const codeIndex = new Map(rank(out).map((t, i) => [t.id, i]));
  return ranked.map((t, i) => (ranked.slice(i + 1).some((later) => (codeIndex.get(later.id) ?? 0) < (codeIndex.get(t.id) ?? 0)) ? { ...t, why: input.boostWhy ?? t.why } : t));
}

// ---------------------------------------------------------------------------
// The next task on the card
// ---------------------------------------------------------------------------

/** The judge's probability for one option. */
function probabilityOf(j: ChoiceJudgment<string>, id: string): number {
  const p = j.probabilities?.[id];
  if (typeof p === "number" && Number.isFinite(p)) return p;
  return id === j.choice ? (j.confidence ?? 0) : 0;
}

/**
 * Jev's next task when Jev is sure enough to show it: probability
 * NEXT_TASK_JEV_MIN_P or more, or NEXT_TASK_JEV_LEAN_P or more with a lead of
 * NEXT_TASK_JEV_MARGIN over the next task and "none" under
 * NEXT_TASK_JEV_NONE_MAX. Null for "none" or an unsure answer.
 */
export function confidentTask(j: ChoiceJudgment<string> | undefined): { id: string; p: number } | null {
  if (!j || j.choice === "none") return null;
  const p = probabilityOf(j, j.choice);
  if (p >= NEXT_TASK_JEV_MIN_P) return { id: j.choice, p };
  if (p < NEXT_TASK_JEV_LEAN_P) return null;
  const runnerUp = rankedRecords(j).find((x) => x.id !== j.choice)?.p ?? 0;
  return p - runnerUp >= NEXT_TASK_JEV_MARGIN && probabilityOf(j, "none") < NEXT_TASK_JEV_NONE_MAX ? { id: j.choice, p } : null;
}

/**
 * What the Done card offers next: Jev's nextTask when it passes the gate
 * (confidentTask) and is still one of the current candidates, else code's
 * top-ranked candidate, else nothing.
 */
export function chooseNextTask(
  tasks: NextTask[],
  nextTask: ChoiceJudgment<string> | undefined,
  judge = "Jev",
): { task: NextTask; source: "jev" | "code"; why: string } | null {
  const sure = confidentTask(nextTask);
  const jev = sure ? tasks.find((t) => t.id === sure.id) : undefined;
  if (jev && sure) return { task: jev, source: "jev", why: `${judge} ${Math.round(sure.p * 100)}%` };
  const top = tasks[0];
  return top ? { task: top, source: "code", why: top.why } : null;
}

// ---------------------------------------------------------------------------
// Starting a task
// ---------------------------------------------------------------------------

/**
 * The view change Start makes: the task's filter and its first record
 * selected, the way a click there would. Inbox has no unread filter, so it
 * clears the search and client filter (the unread messages are the newest
 * and marked); Invoices filters to Overdue; Tasks clears the client filter
 * and hides done tasks; Projects filters to the one status its pending
 * projects share, else All; Calendar shows today.
 */
export function taskViewPatch(task: NextTask, data: AppData): RevealPatch | null {
  const selectedId = task.first.id;
  switch (task.id as NextTaskId) {
    case "unread_messages":
      return { panel: "inbox", patch: { query: "", client: null, selectedId } };
    case "overdue_invoices":
      return { panel: "invoices", patch: { status: "overdue", client: null, selectedId } };
    case "tasks_due_today":
      return { panel: "tasks", patch: { client: null, showDone: false, selectedId } };
    case "projects_at_risk": {
      const statuses = new Set(projectsNeedingWork(data).map((p) => p.status));
      const status: PanelViewState["projects"]["status"] = statuses.size === 1 && statuses.has("blocked") ? "blocked" : statuses.size === 1 ? "at_risk" : "all";
      return { panel: "projects", patch: { status, selectedId } };
    }
    case "next_meeting":
      return { panel: "calendar", patch: { range: "today", selectedId } };
    default:
      return null;
  }
}
