/**
 * HEURISTIC FALLBACK. Not Jev.
 *
 * Returns a full Judgments object from keyword matching and simple counting
 * rules, so the UI keeps adapting when there is no API key or Jev fails.
 * Responses built from it carry source "heuristic" and model "heuristic".
 *
 * It is deliberately humble: distributions are blended with uniform and
 * confidences are capped, so the client policy (which gates on confidence)
 * adapts gently instead of acting boldly on a guess.
 */
import {
  ACTION_IDS,
  GOAL_IDS,
  GOAL_PANEL_AFFINITY,
  LAYOUT_MODES,
  PANEL_IDS,
  PANELS,
  type ActionId,
  type GoalId,
  type LayoutMode,
  type PanelId,
} from "../shared/catalog.ts";
import { CLIENTS } from "../shared/fixtures.ts";
import {
  INVOICE_STATUS_ARGS,
  TIMEFRAME_ARGS,
  type AdaptRequest,
  type ChoiceJudgment,
  type ClickedRecord,
  type CommandJudgments,
  type InvoiceStatusArg,
  type ItemKind,
  type Judgments,
  type LinkRequest,
  type PrepJudgments,
  type PrepRecord,
  type PrepRequest,
  type RecordCandidate,
  type ScoreJudgment,
  type TaskCandidate,
  type TimeframeArg,
} from "../shared/types.ts";
import {
  CLIENT_NOT_MENTIONED,
  NO_CLIENT,
  NO_LINK_RECORD,
  NO_RECORD,
  NO_TASK,
  PANEL_UNCLEAR,
  clientCandidates,
  linkOf,
  prepRecordsOf,
  recordCandidates,
  taskCandidates,
  workingGoalOf,
} from "./questions.ts";

/** No heuristic answer claims more certainty than this. */
const MAX_CONFIDENCE = 0.6;
/** Share of every distribution spread evenly, so no option is ever ruled out. */
const UNIFORM_SHARE = 0.3;
/** Each step back in time counts this much less than the step after it. */
const RECENCY_DECAY = 0.75;

// ---------------------------------------------------------------------------
// Text matching
// ---------------------------------------------------------------------------

/** Hand-written cue words per panel. Matched as word prefixes, so "invoice" also hits "invoices". */
const PANEL_CUES: Record<PanelId, string[]> = {
  inbox: ["inbox", "email", "message", "reply", "replied", "unread", "mail"],
  calendar: ["calendar", "meeting", "call with", "schedule", "event", "agenda", "book a", "today"],
  tasks: ["task", "to-do", "todo", "due", "checklist", "remind me"],
  // Cues match as prefixes of words in the text, so "remind" covers "reminder" but not the reverse.
  invoices: ["invoice", "inv-", "bill", "paid", "unpaid", "overdue", "pay", "owe", "owed", "remind"],
  clients: ["client", "customer", "contact", "company"],
  projects: ["project", "deadline", "blocked", "at risk", "progress", "on track"],
  analytics: ["revenue", "analytics", "chart", "totals", "earn", "income", "making", "profit"],
  team: ["team", "teammate", "available", "away", "free to", "who is", "staff"],
  notes: ["note", "jot", "idea", "write down", "scratch"],
  help: ["help", "guide", "how do", "how does", "where is", "where are", "shortcut", "tips"],
};

const STOPWORDS = new Set(
  "the and with from here what their this that they them when where which user users show shows each about still panel".split(" "),
);

/** Content words from the catalog descriptions, counted at half weight. */
const DESCRIPTION_CUES: Record<PanelId, string[]> = Object.fromEntries(
  PANEL_IDS.map((id) => [
    id,
    [...new Set(PANELS[id].description.toLowerCase().match(/[a-z]{5,}/g) ?? [])].filter((w) => !STOPWORDS.has(w)),
  ]),
) as Record<PanelId, string[]>;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compiled cue patterns. Bounded: client names come from the request, and an
 * unbounded cache grew by gigabytes on bodies with made-up names. The fixed
 * cue tables need a few hundred entries, so the cap never evicts in normal use.
 */
export const CUE_CACHE_LIMIT = 1_000;
const cueCache = new Map<string, RegExp>();
function cueRegExp(cue: string): RegExp {
  let re = cueCache.get(cue);
  if (!re) {
    re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(cue)}`, "i");
    if (cueCache.size >= CUE_CACHE_LIMIT) cueCache.clear();
    cueCache.set(cue, re);
  }
  return re;
}

/** Entries in the cue cache, for tests. */
export function cueCacheSize(): number {
  return cueCache.size;
}

function hits(text: string, cues: readonly string[]): number {
  let n = 0;
  for (const cue of cues) if (cueRegExp(cue).test(text)) n++;
  return n;
}

function panelHits(text: string, id: PanelId): number {
  const title = PANELS[id].title.toLowerCase();
  return (cueRegExp(title).test(text) ? 2 : 0) + hits(text, PANEL_CUES[id]) + 0.5 * hits(text, DESCRIPTION_CUES[id]);
}

/** The panel a line of text is mostly about, or null when nothing matches. */
function mainPanel(text: string): PanelId | null {
  let best: PanelId | null = null;
  let bestHits = 0;
  for (const id of PANEL_IDS) {
    const h = panelHits(text, id);
    if (h > bestHits) {
      best = id;
      bestHits = h;
    }
  }
  return best;
}

interface WeightedLine {
  text: string;
  weight: number;
}

/** Activity newest-weighted, plus focus. Command is handled separately. */
function weightedLines(req: AdaptRequest): WeightedLine[] {
  const activity = req.snapshot.recent_activity;
  const lines = activity.map((text, i) => ({ text, weight: RECENCY_DECAY ** (activity.length - 1 - i) }));
  if (req.snapshot.current_focus) lines.push({ text: req.snapshot.current_focus, weight: 1 });
  return lines;
}

// ---------------------------------------------------------------------------
// Distribution helpers
// ---------------------------------------------------------------------------

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Choice-style confidence from a distribution's peak (the formula in the TypeSafe docs), capped. */
function peakConfidence(probs: number[]): number {
  const n = probs.length;
  if (n < 2) return MAX_CONFIDENCE;
  const peak = Math.max(...probs);
  return clamp((n * peak - 1) / (n - 1), 0, MAX_CONFIDENCE);
}

/** Non-negative weights -> a humble ChoiceJudgment. Ties go to the first option. */
function toChoice<K extends string>(options: readonly K[], weights: Partial<Record<K, number>>): ChoiceJudgment<K> {
  const raw = options.map((k) => Math.max(0, weights[k] ?? 0));
  const total = raw.reduce((a, b) => a + b, 0);
  const n = options.length;
  const probs = raw.map((w) => (total > 0 ? (1 - UNIFORM_SHARE) * (w / total) + UNIFORM_SHARE / n : 1 / n));
  let best = 0;
  for (let i = 1; i < n; i++) if (probs[i]! > probs[best]!) best = i;
  const probabilities = Object.fromEntries(options.map((k, i) => [k, probs[i]!])) as Record<K, number>;
  return { choice: options[best]!, confidence: peakConfidence(probs), probabilities };
}

/** A target level (0..levels-1) -> a Score spread around it. */
function toScore(target: number, levels: number): ScoreJudgment {
  const max = levels - 1;
  const t = clamp(target, 0, max);
  const raw = Array.from({ length: levels }, (_, i) => Math.exp(-((i - t) ** 2) / (2 * 0.6 ** 2)));
  const total = raw.reduce((a, b) => a + b, 0);
  const probabilities = raw.map((w) => (1 - UNIFORM_SHARE) * (w / total) + UNIFORM_SHARE / levels);
  const score = probabilities.reduce((sum, p, i) => sum + p * i, 0);
  return { score, max, confidence: peakConfidence(probabilities), probabilities };
}

// ---------------------------------------------------------------------------
// Individual judgments
// ---------------------------------------------------------------------------

const RELEVANCE_LEVELS = 4;
const EXPERTISE_LEVELS = 3;

/** 0..1 per panel: how much the weighted activity talks about it. */
function panelSignal(req: AdaptRequest): Record<PanelId, number> {
  const raw = {} as Record<PanelId, number>;
  for (const id of PANEL_IDS) raw[id] = 0;
  for (const line of weightedLines(req)) {
    for (const id of PANEL_IDS) raw[id] += line.weight * panelHits(line.text, id);
  }
  const command = req.command?.trim();
  if (command) for (const id of PANEL_IDS) raw[id] += 1.5 * panelHits(command, id);
  const top = Math.max(...Object.values(raw));
  const out = {} as Record<PanelId, number>;
  for (const id of PANEL_IDS) out[id] = top > 0 ? raw[id] / top : 0;
  return out;
}

function strugglingProbability(req: AdaptRequest): number {
  const activity = req.snapshot.recent_activity.join("\n");
  const observations = req.snapshot.behavior_observations.join("\n");
  const searches = (activity.match(/\bsearch/gi) ?? []).length;
  const closes = (activity.match(/\b(closed|dismissed|sent .* to the dock|hid)\b/gi) ?? []).length;
  const undos = (activity.match(/\bundo/gi) ?? []).length;
  const patterns = hits(observations, [
    "again",
    "repeat",
    "reworded",
    "several times",
    "3 times",
    "4 times",
    "5 times",
    "three times",
    "four times",
    "within seconds",
    "quickly",
    "back and forth",
    "undo",
  ]);
  const p = 0.15 + 0.12 * Math.max(0, searches - 1) + 0.1 * closes + 0.15 * undos + 0.12 * patterns;
  // Never certain either way: this is counting, not understanding.
  return clamp(p, 0.1, 0.85);
}

function relevanceJudgments(signal: Record<PanelId, number>, struggling: number, hasActivity: boolean): Record<PanelId, ScoreJudgment> {
  const out = {} as Record<PanelId, ScoreJudgment>;
  for (const id of PANEL_IDS) {
    // With nothing to go on, keep the default panels a little ahead.
    let target = hasActivity ? 0.4 + 2.6 * signal[id] : PANELS[id].defaultVisible ? 1.5 : 0.5;
    if (id === "help") target = Math.max(target, struggling >= 0.5 ? 2.5 : 0.5);
    out[id] = toScore(target, RELEVANCE_LEVELS);
  }
  return out;
}

const GOAL_CUES: Partial<Record<GoalId, string[]>> = {
  collect_payments: ["overdue", "unpaid", "owe", "reminder", "pay"],
  review_business: ["revenue", "totals", "this year", "earn", "profit"],
  plan_day: ["today", "schedule", "agenda", "this morning", "this afternoon"],
  coordinate_team: ["available", "away", "who is", "free to"],
  capture_notes: ["note", "jot", "idea", "write down"],
  triage_inbox: ["unread", "reply", "inbox"],
  track_projects: ["at risk", "blocked", "deadline", "progress"],
};

function goalJudgment(req: AdaptRequest, signal: Record<PanelId, number>, hasActivity: boolean): ChoiceJudgment<GoalId> {
  const text = [...req.snapshot.recent_activity, req.snapshot.current_focus ?? "", req.command ?? ""].join("\n");
  const weights: Partial<Record<GoalId, number>> = {};
  for (const goal of GOAL_IDS) {
    if (goal === "unclear") continue;
    const affinity = GOAL_PANEL_AFFINITY[goal];
    let w = 0;
    for (const id of PANEL_IDS) w += (affinity[id] ?? 0) * signal[id];
    w += 0.3 * hits(text, GOAL_CUES[goal] ?? []);
    weights[goal] = w;
  }
  // With no activity at all, "not sure yet" should win clearly.
  weights.unclear = hasActivity ? 0.6 : 3;
  return toChoice(GOAL_IDS, weights);
}

function layoutJudgment(req: AdaptRequest): ChoiceJudgment<LayoutMode> {
  const recent = req.snapshot.recent_activity.slice(-6).map(mainPanel).filter((p): p is PanelId => p !== null);
  if (recent.length < 2) return toChoice(LAYOUT_MODES, { overview: 1 });
  const distinct = new Set(recent);
  let switches = 0;
  for (let i = 1; i < recent.length; i++) if (recent[i] !== recent[i - 1]) switches++;
  if (distinct.size === 1) return toChoice(LAYOUT_MODES, { focus: 1 });
  if (distinct.size === 2) return toChoice(LAYOUT_MODES, switches >= 2 ? { compare: 1 } : { focus: 0.6, compare: 0.4 });
  return toChoice(LAYOUT_MODES, { overview: 1 });
}

function expertiseJudgment(req: AdaptRequest, struggling: number): ScoreJudgment {
  const text = [...req.snapshot.recent_activity, ...req.snapshot.behavior_observations].join("\n");
  const keyboard = hits(text, ["shortcut", "keyboard", "command bar", "pressed", "mod+k"]);
  const novice = hits(text, ["guide", "help", "mouse", "pointer"]);
  const target = 1 + 0.4 * Math.min(keyboard, 3) - 0.3 * Math.min(novice, 2) - (struggling >= 0.6 ? 0.5 : 0);
  return toScore(target, EXPERTISE_LEVELS);
}

const GOAL_NEXT_ACTION: Record<GoalId, ActionId> = {
  triage_inbox: "reply_to_message",
  plan_day: "create_task",
  collect_payments: "send_payment_reminder",
  manage_client: "view_client",
  track_projects: "update_project_status",
  review_business: "none",
  coordinate_team: "schedule_meeting",
  capture_notes: "write_note",
  unclear: "none",
};

function nextActionJudgment(goal: ChoiceJudgment<GoalId>): ChoiceJudgment<ActionId> {
  // Only probability above the uniform floor counts. Otherwise the floor summed
  // over the two goals that map to "none" would outvote a clear goal.
  const floor = 1 / GOAL_IDS.length;
  const weights: Partial<Record<ActionId, number>> = {};
  for (const g of GOAL_IDS) {
    const excess = goal.probabilities[g] - floor;
    if (excess <= 0) continue;
    const action = GOAL_NEXT_ACTION[g];
    weights[action] = (weights[action] ?? 0) + excess;
  }
  if (Object.keys(weights).length === 0) weights.none = 1;
  return toChoice(ACTION_IDS, weights);
}

/** Words that identify a client in free text: full name, first word of the name, contact person. */
function clientCues(name: string): string[] {
  const cues = [name.toLowerCase()];
  const first = name.split(/\s+/)[0]?.toLowerCase().replace(/[^a-z]/g, "");
  if (first && first.length >= 4) cues.push(first);
  const contact = CLIENTS.find((c) => c.name === name)?.contact;
  if (contact) cues.push(contact.toLowerCase());
  return cues;
}

function clientWeights(clients: string[], lines: WeightedLine[]): Record<string, number> {
  const weights: Record<string, number> = {};
  for (const name of clients) {
    const cues = clientCues(name);
    weights[name] = lines.reduce((sum, line) => sum + (hits(line.text, cues) > 0 ? line.weight : 0), 0);
  }
  return weights;
}

function targetClientJudgment(req: AdaptRequest, clients: string[]): ChoiceJudgment<string> {
  const weights = clientWeights(clients, weightedLines(req));
  weights[NO_CLIENT] = 0.5;
  return toChoice([...clients, NO_CLIENT], weights);
}

// ---------------------------------------------------------------------------
// Next record and list work
// ---------------------------------------------------------------------------

/** Activity lines read for list work: the recent stretch, not the whole session. */
const LIST_WORK_WINDOW = 8;
/** List-work probability with at most one record of any kind opened in the window. */
const LIST_WORK_BASE = 0.15;
/** Added for each further different record of the same kind opened in the window. */
const LIST_WORK_STEP = 0.2;
/** Added when records were acted on (replied to, checked off) between the opens: handle one, then the next. */
const LIST_WORK_ACTED = 0.1;
/** List work is never certain either way: this is counting, not understanding. */
const LIST_WORK_MIN = 0.1;
const LIST_WORK_MAX = 0.8;
/** Weight of the first matching candidate. Later matches get less, so the first one wins. */
const NEXT_RECORD_FIRST_WEIGHT = 1;
const NEXT_RECORD_OTHER_WEIGHT = 0.25;
/** "none" keeps a real share even when a candidate matches, so the fallback never sounds sure. */
const NEXT_RECORD_NONE_WEIGHT = 0.5;

/**
 * "Opened <kind> ..." as describeEvent writes an item_open (src/engine/snapshot.ts).
 * "Opened Revenue from the dock" and other panel opens do not match.
 */
const OPENED_RECORD = /^Opened (?:an? )?(invoice|message|client|project|task|calendar event|team member|note)\b/i;
const KIND_OF_WORD: Record<string, ItemKind> = {
  invoice: "invoice",
  message: "message",
  client: "client",
  project: "project",
  task: "task",
  "calendar event": "event",
  "team member": "person",
  note: "note",
};
/** Activity lines for acting on a record, as describeEvent writes them. */
const ACTED_ON_RECORD = /^(Replied to|Sent a payment reminder|Resent |Marked |Used "Checked off|Updated the status)/;

interface OpenedRecord {
  kind: ItemKind;
  /** The line without its repeat suffix, so the same record opened twice has the same key. */
  key: string;
}

function openedRecord(line: string): OpenedRecord | null {
  const m = OPENED_RECORD.exec(line);
  const kind = m ? KIND_OF_WORD[m[1]!.toLowerCase()] : undefined;
  if (!kind) return null;
  return { kind, key: line.replace(/ \((?:twice|\w+ times) in a row\)$/, "") };
}

/** Kind of the newest record opened in the activity, or null when none was. */
function lastOpenedKind(activity: readonly string[]): ItemKind | null {
  for (let i = activity.length - 1; i >= 0; i--) {
    const opened = openedRecord(activity[i]!);
    if (opened) return opened.kind;
  }
  return null;
}

/**
 * The first candidate whose code hint says "next", or whose kind matches the
 * record the user opened last. A guess from the candidate order, so "none"
 * always keeps a real share and the confidence stays under MAX_CONFIDENCE.
 */
function nextRecordJudgment(req: AdaptRequest, records: RecordCandidate[]): ChoiceJudgment<string> {
  const lastKind = lastOpenedKind(req.snapshot.recent_activity);
  const weights: Record<string, number> = {};
  let matched = false;
  for (const r of records) {
    const fits = /\bnext\b/i.test(r.why ?? "") || (lastKind !== null && r.kind === lastKind);
    if (!fits) continue;
    weights[r.id] = matched ? NEXT_RECORD_OTHER_WEIGHT : NEXT_RECORD_FIRST_WEIGHT;
    matched = true;
  }
  weights[NO_RECORD] = matched ? NEXT_RECORD_NONE_WEIGHT : 1;
  return toChoice([...records.map((r) => r.id), NO_RECORD], weights);
}

/** Different records of one kind opened in the recent activity, more of them meaning list work. */
function listWorkProbability(req: AdaptRequest): number {
  const lines = req.snapshot.recent_activity.slice(-LIST_WORK_WINDOW);
  const byKind = new Map<ItemKind, Set<string>>();
  for (const line of lines) {
    const opened = openedRecord(line);
    if (!opened) continue;
    const keys = byKind.get(opened.kind) ?? new Set<string>();
    keys.add(opened.key);
    byKind.set(opened.kind, keys);
  }
  const distinct = Math.max(0, ...[...byKind.values()].map((keys) => keys.size));
  const acted = lines.some((line) => ACTED_ON_RECORD.test(line));
  const p = LIST_WORK_BASE + LIST_WORK_STEP * Math.max(0, distinct - 1) + (acted && distinct >= 2 ? LIST_WORK_ACTED : 0);
  return clamp(p, LIST_WORK_MIN, LIST_WORK_MAX);
}

// ---------------------------------------------------------------------------
// Goal done and next task (focus aid 2)
// ---------------------------------------------------------------------------

/** Activity lines read for goal done: the last few steps, where finishing shows. */
const GOAL_DONE_WINDOW = 6;
/** Goal-done probability with nothing acted on in the window: most of the time the work is still going. */
const GOAL_DONE_BASE = 0.2;
/** Added for each record acted on in the window (replied to, reminded, checked off, updated), at most GOAL_DONE_ACTED_MAX times. */
const GOAL_DONE_ACTED_STEP = 0.1;
const GOAL_DONE_ACTED_MAX = 3;
/** A newest line that opens a record means the work is still going: the value stays at most this. */
const GOAL_DONE_STILL_OPENING = 0.25;
/**
 * Goal done is never sure either way: this is counting, not understanding.
 * The cap is under the client's done threshold (TASK_DONE_JEV_AT, 0.75), so
 * the fallback alone never says a goal without a code fact is done.
 */
const GOAL_DONE_MIN = 0.1;
const GOAL_DONE_MAX = MAX_CONFIDENCE;
/** Weight of the first task candidate (the client sends them ranked by its own priority), and of each other one. */
const NEXT_TASK_FIRST_WEIGHT = 1;
const NEXT_TASK_OTHER_WEIGHT = 0.25;
/** "none" keeps a real share, so the fallback never sounds sure. */
const NEXT_TASK_NONE_WEIGHT = 0.5;

/** Records acted on in the last few steps raise it; a newest step that opens a record keeps it low. */
function goalDoneProbability(req: AdaptRequest): number {
  const lines = req.snapshot.recent_activity.slice(-GOAL_DONE_WINDOW);
  const acted = lines.filter((line) => ACTED_ON_RECORD.test(line)).length;
  let p = GOAL_DONE_BASE + GOAL_DONE_ACTED_STEP * Math.min(acted, GOAL_DONE_ACTED_MAX);
  const latest = lines.at(-1);
  if (latest !== undefined && openedRecord(latest)) p = Math.min(p, GOAL_DONE_STILL_OPENING);
  return clamp(p, GOAL_DONE_MIN, GOAL_DONE_MAX);
}

/** The client's first-ranked task, humbly: the other tasks and "none" keep real shares. */
function nextTaskJudgment(tasks: TaskCandidate[]): ChoiceJudgment<string> {
  const weights: Record<string, number> = { [NO_TASK]: NEXT_TASK_NONE_WEIGHT };
  tasks.forEach((t, i) => {
    weights[t.id] = i === 0 ? NEXT_TASK_FIRST_WEIGHT : NEXT_TASK_OTHER_WEIGHT;
  });
  return toChoice([...tasks.map((t) => t.id), NO_TASK], weights);
}

// ---------------------------------------------------------------------------
// Next step ("Arrange linked panels by next step")
// ---------------------------------------------------------------------------

/**
 * Words in a clicked message that ask for one action, first rule first. A
 * keyword guess, so the answer stays humble (toChoice), like the others.
 */
const LINK_ACTION_CUES: Array<[ActionId, string[]]> = [
  ["resend_invoice", ["resend", "re-send", "send again", "send it again", "bounced", "new address"]],
  ["mark_invoice_paid", ["payment sent", "we have paid", "we paid", "paid the invoice"]],
  ["send_payment_reminder", ["remind"]],
  ["schedule_meeting", ["call", "meeting", "meet", "catch up", "schedule", "book a"]],
];
/** A clicked message that asks a question (or has a question mark) wants a reply. */
const LINK_ASK_CUES = ["can you", "could you", "can we", "could we", "let me know"];
/** The record kind each action works on, so the fallback's link-next leans to the record the action needs. */
const ACTION_RECORD_KIND: Partial<Record<ActionId, ItemKind>> = {
  resend_invoice: "invoice",
  send_payment_reminder: "invoice",
  mark_invoice_paid: "invoice",
  reply_to_message: "message",
  schedule_meeting: "event",
  update_project_status: "project",
  view_client: "client",
};
/**
 * Weights of the fallback's link-next pick and of "none": equal, so the pick
 * never reaches the client's link-next gate (LINK_NEXT_MIN_P, or the lean
 * with a clear lead). Offline, the panels gather in code's order with no
 * "Next" emphasis.
 */
const LINK_NEXT_PICK_WEIGHT = 1;
const LINK_NEXT_NONE_WEIGHT = 1;

/** What a clicked message asks for, from its words; an overdue invoice needs a reminder; anything else asks for nothing. */
function linkActionJudgment(clicked: ClickedRecord): ChoiceJudgment<ActionId> {
  const f = clicked.fields;
  const text = [f.subject, f.text].filter(Boolean).join(" ").toLowerCase();
  if (clicked.kind === "message") {
    const rule = LINK_ACTION_CUES.find(([, cues]) => hits(text, cues) > 0);
    if (rule) return toChoice(ACTION_IDS, { [rule[0]]: 1 } as Partial<Record<ActionId, number>>);
    if (text.includes("?") || hits(text, LINK_ASK_CUES) > 0) return toChoice(ACTION_IDS, { reply_to_message: 1 });
    return toChoice(ACTION_IDS, { none: 1 });
  }
  if (clicked.kind === "invoice" && f.status === "overdue") return toChoice(ACTION_IDS, { send_payment_reminder: 1 });
  return toChoice(ACTION_IDS, { none: 1 });
}

/** The first linked record of the kind the action works on (else the first one), no surer than "none"; "none" when nothing is asked. */
function linkNextJudgment(link: LinkRequest, action: ChoiceJudgment<ActionId>): ChoiceJudgment<string> {
  const want = ACTION_RECORD_KIND[action.choice];
  const pick = link.records.find((r) => r.kind === want) ?? link.records[0];
  const weights: Record<string, number> = { [NO_LINK_RECORD]: LINK_NEXT_NONE_WEIGHT };
  if (pick && action.choice !== "none") weights[pick.id] = LINK_NEXT_PICK_WEIGHT;
  return toChoice([...link.records.map((r) => r.id), NO_LINK_RECORD], weights);
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

const COMMAND_ACTION_CUES: Array<[ActionId, string[]]> = [
  ["send_payment_reminder", ["remind", "chase", "nudge"]],
  ["mark_invoice_paid", ["mark paid", "as paid", "got paid", "has paid"]],
  ["reply_to_message", ["reply", "respond", "write back", "email "]],
  // "book a", not "book": a bare "book" would match "Juniper Books".
  ["schedule_meeting", ["schedule", "book a", "book the", "set up a call", "set up a meeting"]],
  ["create_task", ["add a task", "add task", "to-do", "todo", "remember to"]],
  ["update_project_status", ["update status", "mark project", "set status"]],
  ["write_note", ["jot", "note", "write down"]],
];

const STATUS_CUES: Array<[InvoiceStatusArg, string[]]> = [
  ["overdue", ["overdue", "late", "past due"]],
  ["unpaid", ["unpaid", "owe", "owes", "outstanding", "not paid"]],
  ["draft", ["draft"]],
  ["paid", ["paid"]],
  ["all", ["invoice", "bill"]],
];

const TIMEFRAME_CUES: Array<[TimeframeArg, string[]]> = [
  ["today", ["today", "this morning", "this afternoon", "tonight", "on now"]],
  ["this_week", ["this week", "week", "next few days"]],
  ["this_month", ["this month", "month"]],
];

/** First rule whose cues match wins; otherwise `fallback`. */
function firstMatch<K extends string>(text: string, rules: Array<[K, string[]]>, options: readonly K[], fallback: K): ChoiceJudgment<K> {
  for (const [value, cues] of rules) {
    if (hits(text, cues) > 0) return toChoice(options, { [value]: 1 } as Partial<Record<K, number>>);
  }
  return toChoice(options, { [fallback]: 1 } as Partial<Record<K, number>>);
}

function commandJudgments(command: string, clients: string[]): CommandJudgments {
  const text = command.toLowerCase();

  const panelWeights: Partial<Record<PanelId | typeof PANEL_UNCLEAR, number>> = {};
  for (const id of PANEL_IDS) panelWeights[id] = panelHits(text, id);
  const clientW = clientWeights(clients, [{ text, weight: 1 }]);
  const namesClient = Object.values(clientW).some((w) => w > 0);
  // A bare client name ("atlas") asks for that client.
  if (namesClient) panelWeights.clients = (panelWeights.clients ?? 0) + 1;
  const anyPanel = PANEL_IDS.some((id) => (panelWeights[id] ?? 0) > 0);
  panelWeights[PANEL_UNCLEAR] = anyPanel ? 0.2 : 1;

  clientW[CLIENT_NOT_MENTIONED] = namesClient ? 0 : 1;

  // "remind me to" is a task, not a payment reminder.
  const actionRules = /\bremind me\b/.test(text) ? COMMAND_ACTION_CUES.filter(([a]) => a !== "send_payment_reminder") : COMMAND_ACTION_CUES;

  // "open <client>" is the only phrasing that means view_client; "open my notes" does not.
  const action =
    namesClient && /\bopen\b/.test(text)
      ? toChoice(ACTION_IDS, { view_client: 1 })
      : firstMatch(text, actionRules, ACTION_IDS, "none");

  // "Mark the pinecrest bill as paid" names a bill that is not paid yet, so the
  // word "paid" there is not a request to see paid invoices.
  const marksPaid = action.choice === "mark_invoice_paid";
  const statusRules = marksPaid ? STATUS_CUES.filter(([status]) => status !== "paid") : STATUS_CUES;

  return {
    panel: toChoice([...PANEL_IDS, PANEL_UNCLEAR] as const, panelWeights),
    action,
    invoiceStatus: firstMatch(text, statusRules, INVOICE_STATUS_ARGS, "not_mentioned"),
    client: toChoice([...clients, CLIENT_NOT_MENTIONED], clientW),
    timeframe: firstMatch(text, TIMEFRAME_CUES, TIMEFRAME_ARGS, "not_mentioned"),
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function heuristicJudgments(req: AdaptRequest): Judgments {
  const hasActivity = req.snapshot.recent_activity.length > 0;
  const clients = clientCandidates(req);
  const signal = panelSignal(req);
  const struggling = strugglingProbability(req);
  const goal = goalJudgment(req, signal, hasActivity);

  const judgments: Judgments = {
    goal,
    relevance: relevanceJudgments(signal, struggling, hasActivity || Boolean(req.command?.trim())),
    struggling,
    layout: layoutJudgment(req),
    expertise: expertiseJudgment(req, struggling),
    nextAction: nextActionJudgment(goal),
    targetClient: targetClientJudgment(req, clients),
  };
  // Same rule as the Jev request: no candidates, no next-record judgments.
  const records = recordCandidates(req);
  if (records.length > 0) {
    judgments.nextRecord = nextRecordJudgment(req, records);
    judgments.listWork = listWorkProbability(req);
  }
  // Same rule as the Jev request: goal done only with a working goal, the next task only with task candidates.
  if (workingGoalOf(req)) judgments.goalDone = goalDoneProbability(req);
  const tasks = taskCandidates(req);
  if (tasks.length > 0) judgments.nextTask = nextTaskJudgment(tasks);
  // Same rule as the Jev request: the link questions only with a clicked record and its linked records.
  const link = linkOf(req);
  if (link) {
    judgments.linkAction = linkActionJudgment(link.clicked);
    judgments.linkNext = linkNextJudgment(link, judgments.linkAction);
  }
  const command = req.command?.trim();
  if (command) judgments.command = commandJudgments(command, clients);
  return judgments;
}

// ---------------------------------------------------------------------------
// Meeting prep (focus aid 4)
// ---------------------------------------------------------------------------

/** Levels of the prep Score (PREP_SCORE_LEVELS in questions.ts): not needed, useful background, should be reviewed. */
const PREP_LEVELS = 3;
/** A record with an action due (an overdue invoice, an unread message, a task due today or late) should be reviewed first. */
const PREP_DUE_LEVEL = 2;
/** A project the meeting's title names, or one at risk or blocked, is what the meeting will discuss. */
const PREP_TOPIC_LEVEL = 2;
/** Anything else about the client: background. */
const PREP_BACKGROUND_LEVEL = 1;
/** A message from the last day or two is fresher background, a little above the rest. */
const PREP_RECENT_MESSAGE_LEVEL = 1.4;
/** A record for another client (or none) is not needed. */
const PREP_OTHER_CLIENT_LEVEL = 0.2;
/**
 * The fallback's anything-urgent with and without an action due. The yes is
 * the heuristic's cap (MAX_CONFIDENCE), which just reaches the client's
 * urgent line (PREP_URGENT_AT): an overdue bill is a fact, not a guess.
 */
const PREP_URGENT_YES = MAX_CONFIDENCE;
const PREP_URGENT_NO = 0.2;

/** Whether a record has an action due before a meeting, from its words: overdue, unread, due today, or late. */
function prepDue(r: PrepRecord): boolean {
  const f = r.fields;
  if (r.kind === "invoice") return f.status === "overdue";
  if (r.kind === "message") return f.status === "unread";
  if (r.kind === "task") return /\b(due today|late)\b/.test(f.due ?? "");
  return false;
}

/** The fallback's level for one record: recency, unread, overdue, and the project the meeting names. */
function prepLevel(r: PrepRecord, req: PrepRequest): number {
  const f = r.fields;
  if (f.client && f.client !== req.meeting.client) return PREP_OTHER_CLIENT_LEVEL;
  if (prepDue(r)) return PREP_DUE_LEVEL;
  if (r.kind === "project") {
    const named = f.name ? req.meeting.title.toLowerCase().includes(f.name.toLowerCase()) : false;
    return named || f.status === "at risk" || f.status === "blocked" ? PREP_TOPIC_LEVEL : PREP_BACKGROUND_LEVEL;
  }
  if (r.kind === "message" && /^(today|yesterday)/.test(f.received ?? "")) return PREP_RECENT_MESSAGE_LEVEL;
  return PREP_BACKGROUND_LEVEL;
}

/** HEURISTIC FALLBACK for POST /api/prep: a humble Score per record from its words, and anything-urgent from the facts code wrote. */
export function heuristicPrepJudgments(req: PrepRequest): PrepJudgments {
  const records = prepRecordsOf(req);
  const scores: Record<string, ScoreJudgment> = {};
  for (const r of records) scores[r.id] = toScore(prepLevel(r, req), PREP_LEVELS);
  const urgent = records.some((r) => prepDue(r) && (!r.fields.client || r.fields.client === req.meeting.client));
  return { scores, anythingUrgent: urgent ? PREP_URGENT_YES : PREP_URGENT_NO };
}
