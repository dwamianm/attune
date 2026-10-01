/**
 * Focus aid 3, "Learn my habits" (docs/focus-aids.md): what the user usually
 * does next, learned from their own work over days and kept in this browser
 * only (HABITS_STORAGE_KEY).
 *
 * Four kinds of decayed counts (HabitMemory in ./contract.ts):
 *   - panel: the panel the user worked in, then the next different panel
 *     they worked in, by time of day ("morning|inbox>calendar");
 *   - start: the first panel worked in per session, by time of day ("morning|inbox");
 *   - goal: the working goal, then the next working goal ("collect_payments>triage_inbox");
 *   - action: the first action about a record the user opened (in its
 *     panel, on it, or for its client) after opening a record of that kind
 *     ("invoice>send_payment_reminder").
 * Every count halves every HABIT_HALF_LIFE_MS, so an old habit fades, and
 * each kind keeps at most HABIT_MAX_ENTRIES. A count is a habit only with
 * enough evidence (HABIT_MIN_COUNT and HABIT_MIN_SHARE), so one-off moves
 * never count.
 *
 * Only what the user did by hand teaches it: a record opened, an action, a
 * filter, or a search (HABIT_EVENT_TYPES). Engine-made and cue-only signals,
 * anything done from a suggestion or the command bar, and records opened
 * from Up next or Start never count, so Attune's own offers cannot teach it.
 *
 * Code uses the habits, never Jev: a small habit part in each panel's
 * priority (the "habit" weight), a small lift for Up next candidates in the
 * usual next panel, a boost under 1 for the next task, a subtle suggestion
 * when Jev is unsure of the next step, and at most two habits in the words
 * Jev reads.
 *
 * Pure: no DOM, no store, no clock except `now`. The storage helpers take
 * the Storage and never throw.
 */
import { ACTIONS, GOALS, GOAL_IDS, PANEL_IDS, panelTitle, type ActionId, type GoalId, type PanelId } from "../../shared/catalog.ts";
import type { ItemKind, SignalEvent, SignalType } from "../../shared/types.ts";
import type { HabitCount, HabitHints, HabitMemory, NextTask, TimeOfDay } from "./contract.ts";
import { kindOfId } from "./relations.ts";
import type { TaskBoost } from "./taskDone.ts";
import { lowerFirst } from "./words.ts";

// ---------------------------------------------------------------------------
// Constants. Demo defaults; tune them here.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60_000;

/** localStorage key for the habits, beside the settings key (floouid:v1); kept apart so Forget clears only this. */
export const HABITS_STORAGE_KEY = "floouid:habits:v1";
/** Every count halves in this long: a habit from a normal week stays strong, and one unused for a month counts a quarter. */
export const HABIT_HALF_LIFE_MS = 14 * DAY_MS;
/**
 * A move is a habit only when its decayed count reaches this: three recent
 * times (once is chance, twice can be a coincidence, three times is a
 * pattern). Counts decay, so three moves in the last three days add up to
 * 2.5 or more, while two can never reach it.
 */
export const HABIT_MIN_COUNT = 2.5;
/** ...and only when it is at least this share of all moves from the same place, so a spread of one-off moves is no habit and at most two panels can be one. */
export const HABIT_MIN_SHARE = 0.4;
/** Most entries kept per kind, weakest dropped first: far more than the real pairs (10 panels, 3 times of day), and the saved JSON stays a few kilobytes. */
export const HABIT_MAX_ENTRIES = 100;
/** A count that faded below this (about two months unused) is dropped, so the saved habits do not grow forever. */
export const HABIT_FORGET_BELOW = 0.05;
/** Work after this long without any counted work starts a new session, as a page load does. */
export const HABIT_SESSION_GAP_MS = 30 * 60_000;
/** An action counts for the record opened at most this long before it; later it is about something else. */
export const HABIT_ACTION_WINDOW_MS = 5 * 60_000;
/** Morning ends at this local hour (before noon). */
export const MORNING_ENDS_HOUR = 12;
/** Afternoon ends at this local hour (12 to 17); evening is from here on. */
export const AFTERNOON_ENDS_HOUR = 17;
/**
 * The default habit weight (PolicyWeights.habit): at most this much on top
 * of a panel's blended priority. A strong habit lifts a panel past the dock
 * line or a near neighbor (the swap margin is 0.08), never past a panel Jev
 * rates central (its relevance part alone is about 0.4).
 */
export const HABIT_WEIGHT = 0.15;
/** Habits added to the words Jev reads: enough to name the strongest, few enough not to crowd what the user is doing now. */
export const HABIT_OBSERVATIONS_MAX = 2;
/**
 * The next-task boost (TaskBoost in ./taskDone.ts) is this times the
 * habit's share: under 1, so a habit reorders only near neighbors in
 * TASK_PRIORITY and never overrules a whole priority step (the hook's contract).
 */
export const HABIT_TASK_BOOST_MAX = 0.9;
/** A habit at or above this share reads "Almost always". */
export const HABIT_STRONG_SHARE = 0.75;
/** ...at or above this "Usually"; below it, down to HABIT_MIN_SHARE, "Often". */
export const HABIT_USUAL_SHARE = 0.55;
/** Rows per section in the inspector's Habits view: the strongest first, the rest counted. */
export const HABIT_VIEW_MAX = 8;
/** The Done card's chip for a next task a habit moved ahead of one code ranked higher. */
export const HABIT_TASK_WHY = "You usually do this next";

/** Work events that teach habits: the user worked in that panel by hand. */
export const HABIT_EVENT_TYPES: ReadonlySet<SignalType> = new Set<SignalType>(["item_open", "action", "filter", "search"]);
/** Record opens Attune offered (Up next, Start, Prepare): they teach nothing, and they end the open an action would count for. */
const OFFERED_OPEN_TYPES: ReadonlySet<SignalType> = new Set<SignalType>(["up_next_open", "task_start", "prep_start"]);
/** Record kinds with their own panel, so an action after opening one can be counted. */
const RECORD_KINDS: ReadonlySet<ItemKind> = new Set<ItemKind>(["invoice", "message", "client", "project", "task", "event"]);

const BUCKET_WORDS: Record<TimeOfDay, string> = { morning: "in the morning", afternoon: "in the afternoon", evening: "in the evening" };

/** What an action is, as a habit: "Usually sends a payment reminder after opening an invoice". */
const ACTION_HABIT_WORDS: Record<Exclude<ActionId, "none">, string> = {
  send_payment_reminder: "sends a payment reminder",
  mark_invoice_paid: "marks the invoice as paid",
  resend_invoice: "resends the invoice",
  reply_to_message: "replies",
  schedule_meeting: "schedules a meeting",
  create_task: "adds a task",
  update_project_status: "updates the project status",
  view_client: "opens the client's details",
  write_note: "writes a note",
};

const KIND_WORDS: Record<ItemKind, string> = {
  invoice: "an invoice",
  message: "a message",
  client: "a client",
  project: "a project",
  task: "a task",
  event: "a calendar event",
  person: "a team member",
  note: "a note",
};

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

export function emptyHabits(): HabitMemory {
  return { panel: {}, start: {}, goal: {}, action: {}, sample: false };
}

/** Local time of day: morning before MORNING_ENDS_HOUR, afternoon before AFTERNOON_ENDS_HOUR, then evening. */
export function timeOfDay(t: number): TimeOfDay {
  const h = new Date(t).getHours();
  return h < MORNING_ENDS_HOUR ? "morning" : h < AFTERNOON_ENDS_HOUR ? "afternoon" : "evening";
}

/** A count as of `now`: halved for every HABIT_HALF_LIFE_MS since it was last counted. */
export function decayed(c: HabitCount | undefined, now: number): number {
  if (!c) return 0;
  return c.n * Math.pow(0.5, Math.max(0, now - c.at) / HABIT_HALF_LIFE_MS);
}

/** Without counts that faded below HABIT_FORGET_BELOW, and at most HABIT_MAX_ENTRIES, the weakest dropped first. */
export function pruneCounts(map: Record<string, HabitCount>, now: number): Record<string, HabitCount> {
  const kept = Object.entries(map)
    .map(([key, c]) => ({ key, c, v: decayed(c, now) }))
    .filter((x) => x.v >= HABIT_FORGET_BELOW)
    .sort((a, b) => b.v - a.v || a.key.localeCompare(b.key))
    .slice(0, HABIT_MAX_ENTRIES);
  return Object.fromEntries(kept.map((x) => [x.key, x.c]));
}

/** One more time for `key` at `now`: the old count decays to now, plus `by`. */
export function bumpCount(map: Record<string, HabitCount>, key: string, now: number, by = 1): Record<string, HabitCount> {
  return pruneCounts({ ...map, [key]: { n: decayed(map[key], now) + by, at: now } }, now);
}

/** One option after a given place, with how often it happened and its share of all options from there. */
export interface HabitOption {
  /** What comes next: a panel, goal, or action id. */
  to: string;
  count: number;
  total: number;
  share: number;
}

/** Every option whose key starts with `prefix`, most likely first. */
function optionsAfter(map: Record<string, HabitCount>, prefix: string, now: number): HabitOption[] {
  const rows = Object.entries(map)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, c]) => ({ to: key.slice(prefix.length), count: decayed(c, now) }))
    .filter((r) => r.to.length > 0 && r.count > 0);
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return rows.map((r) => ({ ...r, total, share: total > 0 ? r.count / total : 0 })).sort((a, b) => b.share - a.share || a.to.localeCompare(b.to));
}

/** Enough evidence to call it a habit: a decayed count of HABIT_MIN_COUNT (three recent times) and HABIT_MIN_SHARE of the moves from there. */
export function isHabit(o: Pick<HabitOption, "count" | "share">): boolean {
  return o.count >= HABIT_MIN_COUNT && o.share >= HABIT_MIN_SHARE;
}

const isPanel = (v: string): v is PanelId => (PANEL_IDS as readonly string[]).includes(v);
const isGoal = (v: string): v is GoalId => (GOAL_IDS as readonly string[]).includes(v) && v !== "unclear";
const isAction = (v: string): v is Exclude<ActionId, "none"> => v !== "none" && Object.prototype.hasOwnProperty.call(ACTIONS, v);

/** Where the user usually goes after `from` at this time of day (or starts, when `from` is null): habits only, most likely first. */
export function nextPanels(memory: HabitMemory, from: PanelId | null, bucket: TimeOfDay, now: number): (HabitOption & { to: PanelId })[] {
  const opts = from === null ? optionsAfter(memory.start, `${bucket}|`, now) : optionsAfter(memory.panel, `${bucket}|${from}>`, now);
  return opts.filter((o): o is HabitOption & { to: PanelId } => isPanel(o.to) && o.to !== from && isHabit(o));
}

/** The work the user usually moves on to after `from`: habits only, most likely first. */
export function nextGoals(memory: HabitMemory, from: GoalId, now: number): (HabitOption & { to: GoalId })[] {
  return optionsAfter(memory.goal, `${from}>`, now).filter((o): o is HabitOption & { to: GoalId } => isGoal(o.to) && o.to !== from && isHabit(o));
}

/** What the user usually does after opening a record of `kind`: habits only, most likely first. */
export function actionsAfter(memory: HabitMemory, kind: ItemKind, now: number): (HabitOption & { to: Exclude<ActionId, "none"> })[] {
  return optionsAfter(memory.action, `${kind}>`, now).filter((o): o is HabitOption & { to: Exclude<ActionId, "none"> } => isAction(o.to) && isHabit(o));
}

// ---------------------------------------------------------------------------
// Learning from events
// ---------------------------------------------------------------------------

/** Where the user is in this session, for learning. Session memory only, never saved. */
export interface HabitTrail {
  /** The panel last worked in this session, or null before any counted work. */
  last: PanelId | null;
  /** When that counted work happened, for HABIT_SESSION_GAP_MS. */
  at: number;
  /** The newest record the user opened by hand, until the first action about it. */
  opened: { kind: ItemKind; id: string; panel: PanelId; client?: string; at: number } | null;
}

export function emptyTrail(): HabitTrail {
  return { last: null, at: 0, opened: null };
}

/** What one event did: the trail and memory after it, and the habit's guess for this move when it had one. */
export interface HabitStep {
  trail: HabitTrail;
  /** The same object when nothing was learned. */
  memory: HabitMemory;
  /** The habit's top panel for where the user just went (or started), and whether it was right. Null when no habit had a guess. */
  guess: { panel: PanelId; right: boolean } | null;
}

/** Work the user did by hand, not from a suggestion or the command bar. */
function byHand(e: SignalEvent): boolean {
  return e.detail?.via !== "suggestion" && e.detail?.via !== "command";
}

/**
 * One tracked event. A counted work event (HABIT_EVENT_TYPES, by hand, in a
 * panel) in another panel than the last one is a move: the habit's guess is
 * checked first (from the memory before this move), then, with `learn`, the
 * move is counted: a panel move, or where the session started when nothing
 * was worked yet (a gap of HABIT_SESSION_GAP_MS starts a new session). A
 * record opened by hand waits for the first action about it (in its panel,
 * on it, or for its client: "Schedule meeting" in Clients is logged on
 * Calendar) within HABIT_ACTION_WINDOW_MS, which counts as the action after
 * that kind.
 * Without `learn` the trail still follows the user (for the guesses) and the
 * memory is left as it is.
 */
export function habitStep(memory: HabitMemory, trail: HabitTrail, e: SignalEvent, opts: { learn: boolean }): HabitStep {
  let next: HabitTrail = trail;
  let mem = memory;
  let guess: HabitStep["guess"] = null;
  const p = e.panel && isPanel(e.panel) ? e.panel : null;

  if (OFFERED_OPEN_TYPES.has(e.type)) return { trail: { ...trail, opened: null }, memory, guess };
  if (!p || !HABIT_EVENT_TYPES.has(e.type)) return { trail, memory, guess };

  // The first action about the opened record, by hand or not, uses up the open; only one by hand is learned.
  const o = trail.opened;
  const about = o !== null && (o.panel === p || e.detail?.itemId === o.id || (o.client !== undefined && e.detail?.client === o.client));
  if (e.type === "action" && o && about) {
    const id = e.detail?.actionId;
    if (opts.learn && byHand(e) && id && isAction(id) && e.t - o.at <= HABIT_ACTION_WINDOW_MS) {
      mem = { ...mem, action: bumpCount(mem.action, `${o.kind}>${id}`, e.t) };
    }
    next = { ...next, opened: null };
  }
  if (!byHand(e)) return { trail: next, memory: mem, guess };

  if (e.type === "item_open") {
    const id = e.detail?.itemId;
    const kind = e.detail?.itemKind ?? kindOfId(id);
    const client = e.detail?.client;
    next = { ...next, opened: id && kind && RECORD_KINDS.has(kind) ? { kind, id, panel: p, ...(client ? { client } : {}), at: e.t } : null };
  }

  const bucket = timeOfDay(e.t);
  const from = next.last !== null && e.t - next.at <= HABIT_SESSION_GAP_MS ? next.last : null;
  if (from !== p) {
    const top = nextPanels(mem, from, bucket, e.t)[0];
    if (top) guess = { panel: top.to, right: top.to === p };
    if (opts.learn) {
      mem =
        from === null
          ? { ...mem, start: bumpCount(mem.start, `${bucket}|${p}`, e.t) }
          : { ...mem, panel: bumpCount(mem.panel, `${bucket}|${from}>${p}`, e.t) };
    }
  }
  return { trail: { ...next, last: p, at: e.t }, memory: mem, guess };
}

/** The working goal changed from `from` to `to` by the user's own work (not a started next task, not an undo): count the move. */
export function learnGoal(memory: HabitMemory, from: GoalId | null, to: GoalId, now: number): HabitMemory {
  if (!from || from === to || !isGoal(from) || !isGoal(to)) return memory;
  return { ...memory, goal: bumpCount(memory.goal, `${from}>${to}`, now) };
}

// ---------------------------------------------------------------------------
// Using habits
// ---------------------------------------------------------------------------

/** What the store knows about now, for the hints and the words. */
export interface HabitContext {
  /** The panel worked in now (HabitTrail.last within the session), or null before any work. */
  from: PanelId | null;
  now: number;
  /** The record opened by hand and not yet acted on, when there is one. */
  record?: { kind: ItemKind; id: string; client?: string } | null;
  /** The working goal, for the goal habit in the words Jev reads. */
  goal?: GoalId | null;
}

/**
 * The habits code may use this round: the chance of each panel being next
 * (only habits), and the usual action after the open record. Null when no
 * habit applies, so the policy plans exactly as before.
 */
export function habitHints(memory: HabitMemory, ctx: HabitContext): HabitHints | null {
  const bucket = timeOfDay(ctx.now);
  const next: Partial<Record<PanelId, number>> = {};
  for (const o of nextPanels(memory, ctx.from, bucket, ctx.now)) next[o.to] = o.share;
  const r = ctx.record;
  const top = r ? actionsAfter(memory, r.kind, ctx.now)[0] : undefined;
  const action = r && top ? { kind: r.kind, recordId: r.id, ...(r.client ? { client: r.client } : {}), actionId: top.to, share: top.share } : undefined;
  if (Object.keys(next).length === 0 && !action) return null;
  return { from: ctx.from, bucket, next, ...(action ? { action } : {}) };
}

/** The panel the user most likely goes to next, from the hints. */
export function topNextPanel(hints: HabitHints | null | undefined): PanelId | undefined {
  if (!hints) return undefined;
  let best: PanelId | undefined;
  for (const [id, p] of Object.entries(hints.next) as [PanelId, number][]) if (best === undefined || p > (hints.next[best] ?? 0)) best = id;
  return best;
}

/** A panel's reason when its habit part is the strongest: "You usually open Calendar after Inbox in the morning". */
export function habitReason(hints: HabitHints, panel: PanelId): string {
  const when = BUCKET_WORDS[hints.bucket];
  return hints.from === null ? `You usually start in ${panelTitle(panel)} ${when}` : `You usually open ${panelTitle(panel)} after ${panelTitle(hints.from)} ${when}`;
}

/** A suggestion's reason: "You usually do this after opening an invoice". */
export function habitActionReason(kind: ItemKind): string {
  return `You usually do this after opening ${KIND_WORDS[kind]}`;
}

/**
 * At most HABIT_OBSERVATIONS_MAX habits that fit now, in words, strongest
 * first, for the behavior observations Jev reads: where the user usually
 * goes from here (or starts), what they usually do after the open record's
 * kind, and what work usually follows the working goal.
 */
export function habitObservations(memory: HabitMemory, ctx: HabitContext): string[] {
  const bucket = timeOfDay(ctx.now);
  const when = BUCKET_WORDS[bucket];
  const lines: { share: number; text: string }[] = [];
  const panel = nextPanels(memory, ctx.from, bucket, ctx.now)[0];
  if (panel) {
    const text = ctx.from === null ? `Usually starts in ${panelTitle(panel.to)} ${when}` : `Usually opens ${panelTitle(panel.to)} after ${panelTitle(ctx.from)} ${when}`;
    lines.push({ share: panel.share, text });
  }
  const action = ctx.record ? actionsAfter(memory, ctx.record.kind, ctx.now)[0] : undefined;
  if (action && ctx.record) lines.push({ share: action.share, text: `Usually ${ACTION_HABIT_WORDS[action.to]} after opening ${KIND_WORDS[ctx.record.kind]}` });
  const goal = ctx.goal && isGoal(ctx.goal) ? nextGoals(memory, ctx.goal, ctx.now)[0] : undefined;
  if (goal && ctx.goal) lines.push({ share: goal.share, text: `Usually moves on to ${lowerFirst(GOALS[goal.to].label)} after ${lowerFirst(GOALS[ctx.goal].label)}` });
  // Stable: equal shares keep the order above (where to go, what to do, what work follows).
  return lines
    .map((l, i) => ({ ...l, i }))
    .sort((a, b) => b.share - a.share || a.i - b.i)
    .slice(0, HABIT_OBSERVATIONS_MAX)
    .map((l) => l.text);
}

/**
 * The next-task boost from goal habits (TaskBoost): HABIT_TASK_BOOST_MAX
 * times the share of the habit "after `finished`, this task's goal". Under
 * 1, so it only reorders near neighbors. 0 without a habit.
 */
export function habitTaskBoost(memory: HabitMemory, now: number): TaskBoost {
  return (task: NextTask, finished: GoalId | null) => {
    if (!finished || !isGoal(finished)) return 0;
    const g = nextGoals(memory, finished, now).find((o) => o.to === task.goal);
    return g ? HABIT_TASK_BOOST_MAX * g.share : 0;
  };
}

// ---------------------------------------------------------------------------
// Saved in this browser
// ---------------------------------------------------------------------------

function readCounts(raw: unknown): Record<string, HabitCount> {
  const out: Record<string, HabitCount> = {};
  if (raw === null || typeof raw !== "object") return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    const c = v as Partial<HabitCount> | null;
    if (c && typeof c === "object" && typeof c.n === "number" && Number.isFinite(c.n) && c.n > 0 && typeof c.at === "number" && Number.isFinite(c.at)) {
      out[key] = { n: c.n, at: c.at };
    }
  }
  return out;
}

/** Saved habits from their JSON value; anything unreadable is left out, each kind on its own. */
export function readHabits(raw: unknown): HabitMemory {
  const r = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { panel: readCounts(r.panel), start: readCounts(r.start), goal: readCounts(r.goal), action: readCounts(r.action), sample: r.sample === true };
}

/** The saved habits, or none when there are none, the JSON is broken, or storage is blocked. Never throws. */
export function loadHabits(storage: Pick<Storage, "getItem"> | null): HabitMemory {
  try {
    const raw = storage?.getItem(HABITS_STORAGE_KEY);
    return raw ? readHabits(JSON.parse(raw)) : emptyHabits();
  } catch {
    return emptyHabits();
  }
}

/** Save the habits. Storage can be full or blocked; then nothing is saved and the app works on. */
export function saveHabits(storage: Pick<Storage, "setItem"> | null, memory: HabitMemory): void {
  try {
    storage?.setItem(HABITS_STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Storage can be full or blocked; the habits then last for this page only.
  }
}

/** Remove the saved habits ("Forget my habits"). Never throws. */
export function clearSavedHabits(storage: Pick<Storage, "removeItem"> | null): void {
  try {
    storage?.removeItem(HABITS_STORAGE_KEY);
  } catch {
    // Blocked storage has nothing saved to remove.
  }
}

// ---------------------------------------------------------------------------
// A sample week ("Load a sample week")
// ---------------------------------------------------------------------------

/** Panel moves in a made-up week of a studio owner: mail, then the day's plan in the morning; money in the afternoon; tomorrow's list in the evening. */
const SAMPLE_PANEL: readonly [TimeOfDay, PanelId, PanelId, number][] = [
  ["morning", "inbox", "calendar", 5],
  ["morning", "inbox", "tasks", 1],
  ["morning", "calendar", "tasks", 4],
  ["morning", "calendar", "inbox", 1],
  ["morning", "tasks", "projects", 4],
  ["morning", "tasks", "inbox", 1],
  ["afternoon", "inbox", "invoices", 5],
  ["afternoon", "inbox", "clients", 1],
  ["afternoon", "invoices", "clients", 4],
  ["afternoon", "invoices", "inbox", 1],
  ["afternoon", "clients", "inbox", 4],
  ["evening", "inbox", "tasks", 4],
  ["evening", "inbox", "notes", 1],
  ["evening", "tasks", "notes", 4],
];
const SAMPLE_START: readonly [TimeOfDay, PanelId, number][] = [
  ["morning", "inbox", 5],
  ["afternoon", "inbox", 4],
  ["afternoon", "invoices", 1],
  ["evening", "inbox", 4],
];
const SAMPLE_GOAL: readonly [GoalId, GoalId, number][] = [
  ["triage_inbox", "plan_day", 5],
  ["triage_inbox", "collect_payments", 1],
  ["plan_day", "track_projects", 4],
  ["collect_payments", "triage_inbox", 4],
  ["track_projects", "collect_payments", 4],
];
const SAMPLE_ACTION: readonly [ItemKind, ActionId, number][] = [
  ["invoice", "send_payment_reminder", 5],
  ["invoice", "mark_invoice_paid", 1],
  ["message", "reply_to_message", 5],
  ["message", "schedule_meeting", 1],
  ["project", "update_project_status", 4],
  ["client", "schedule_meeting", 4],
];

/** `times` occurrences, one a day over the last `times` days, decayed to `now`. */
function sampleCount(times: number, now: number): HabitCount {
  let n = 0;
  for (let d = 1; d <= times; d++) n += Math.pow(0.5, (d * DAY_MS) / HABIT_HALF_LIFE_MS);
  return { n, at: now };
}

/** A made-up week of use, marked as sample data. Each move happened once a day on the last few days, so it has decayed a little. */
export function sampleWeek(now: number): HabitMemory {
  const m = emptyHabits();
  for (const [b, from, to, times] of SAMPLE_PANEL) m.panel[`${b}|${from}>${to}`] = sampleCount(times, now);
  for (const [b, p, times] of SAMPLE_START) m.start[`${b}|${p}`] = sampleCount(times, now);
  for (const [from, to, times] of SAMPLE_GOAL) m.goal[`${from}>${to}`] = sampleCount(times, now);
  for (const [kind, action, times] of SAMPLE_ACTION) m.action[`${kind}>${action}`] = sampleCount(times, now);
  m.sample = true;
  return m;
}

/** Both memories added up as of `now` (each kind pruned). `sample` stays true once either has sample data. */
export function mergeHabits(a: HabitMemory, b: HabitMemory, now: number): HabitMemory {
  const add = (x: Record<string, HabitCount>, y: Record<string, HabitCount>) => {
    const out: Record<string, HabitCount> = {};
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) out[key] = { n: decayed(x[key], now) + decayed(y[key], now), at: now };
    return pruneCounts(out, now);
  };
  return { panel: add(a.panel, b.panel), start: add(a.start, b.start), goal: add(a.goal, b.goal), action: add(a.action, b.action), sample: a.sample || b.sample };
}

// ---------------------------------------------------------------------------
// The inspector's Habits view
// ---------------------------------------------------------------------------

/** One learned move in plain words. */
export interface HabitRow {
  key: string;
  /** "Calendar after Inbox, in the morning". */
  text: string;
  /** "Almost always", "Usually", "Often", or "Not a habit yet". */
  strength: string;
  /** "about 4 of 5 times". */
  counts: string;
  habit: boolean;
  share: number;
}

export interface HabitSection {
  rows: HabitRow[];
  /** Learned moves not shown (past HABIT_VIEW_MAX). */
  more: number;
  /** How many learned moves of this kind pass the evidence bar, shown or not. */
  habits: number;
}

/** A share in words; below the evidence bar, "Not a habit yet". */
export function habitStrength(o: Pick<HabitOption, "count" | "share">): string {
  if (!isHabit(o)) return "Not a habit yet";
  if (o.share >= HABIT_STRONG_SHARE) return "Almost always";
  if (o.share >= HABIT_USUAL_SHARE) return "Usually";
  return "Often";
}

/** "about 4 of 5 times": each move rounded on its own, so a rare other move still shows in the total. */
function countsText(o: HabitOption, all: HabitOption[]): string {
  const n = Math.max(1, Math.round(o.count));
  const total = Math.max(n, all.reduce((sum, x) => sum + (x === o ? n : Math.round(x.count)), 0));
  return `about ${n} of ${total} ${total === 1 ? "time" : "times"}`;
}

function section(map: Record<string, HabitCount>, now: number, describe: (key: string) => { prefix: string; text: string } | null): HabitSection {
  const rows: HabitRow[] = [];
  for (const key of Object.keys(map)) {
    const d = describe(key);
    if (!d) continue;
    const all = optionsAfter(map, d.prefix, now);
    const o = all.find((x) => `${d.prefix}${x.to}` === key);
    if (!o) continue;
    rows.push({ key, text: d.text, strength: habitStrength(o), counts: countsText(o, all), habit: isHabit(o), share: o.share });
  }
  rows.sort((a, b) => Number(b.habit) - Number(a.habit) || b.share - a.share || a.key.localeCompare(b.key));
  return { rows: rows.slice(0, HABIT_VIEW_MAX), more: Math.max(0, rows.length - HABIT_VIEW_MAX), habits: rows.filter((r) => r.habit).length };
}

/** Everything learned, in plain words, strongest first, for the inspector. */
export function describeHabits(memory: HabitMemory, now: number): { panel: HabitSection; start: HabitSection; goal: HabitSection; action: HabitSection } {
  return {
    panel: section(memory.panel, now, (key) => {
      const m = /^(morning|afternoon|evening)\|([a-z]+)>([a-z]+)$/.exec(key);
      if (!m || !isPanel(m[2]) || !isPanel(m[3])) return null;
      return { prefix: `${m[1]}|${m[2]}>`, text: `${panelTitle(m[3])} after ${panelTitle(m[2])}, ${BUCKET_WORDS[m[1] as TimeOfDay]}` };
    }),
    start: section(memory.start, now, (key) => {
      const m = /^(morning|afternoon|evening)\|([a-z]+)$/.exec(key);
      if (!m || !isPanel(m[2])) return null;
      return { prefix: `${m[1]}|`, text: `Starts in ${panelTitle(m[2])}, ${BUCKET_WORDS[m[1] as TimeOfDay]}` };
    }),
    goal: section(memory.goal, now, (key) => {
      const [from, to] = key.split(">");
      if (!from || !to || !isGoal(from) || !isGoal(to)) return null;
      return { prefix: `${from}>`, text: `${GOALS[to].label} after ${lowerFirst(GOALS[from].label)}` };
    }),
    action: section(memory.action, now, (key) => {
      const [kind, action] = key.split(">");
      if (!kind || !action || !RECORD_KINDS.has(kind as ItemKind) || !isAction(action)) return null;
      const words = ACTION_HABIT_WORDS[action];
      return { prefix: `${kind}>`, text: `${words.charAt(0).toUpperCase()}${words.slice(1)} after opening ${KIND_WORDS[kind as ItemKind]}` };
    }),
  };
}

/** How many learned moves pass the evidence bar, over all four kinds. */
export function habitCount(memory: HabitMemory, now: number): number {
  const d = describeHabits(memory, now);
  return d.panel.habits + d.start.habits + d.goal.habits + d.action.habits;
}
