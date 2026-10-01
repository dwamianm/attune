/**
 * Hand validation for POST /api/adapt bodies.
 *
 * Separate from index.ts so tests can import it without starting a server.
 * Caps sizes so a runaway client cannot send Jev a huge state: accuracy drops
 * as state grows, and every token is billed.
 */
import { GOAL_IDS, PANEL_IDS, type GoalId, type PanelId } from "../shared/catalog.ts";
import { CLIENT_NAMES } from "../shared/fixtures.ts";
import {
  COMMAND_MAX_LENGTH,
  type AdaptRequest,
  type ClickedRecord,
  type InteractionSnapshot,
  type ItemKind,
  type LinkRequest,
  type PrepMeetingWords,
  type PrepRecord,
  type PrepRequest,
  type RecordCandidate,
  type TaskCandidate,
  type WorkingGoalWords,
} from "../shared/types.ts";

const MAX_ACTIVITY = 15;
const MAX_LIST = 20;
const MAX_TEXT = 300;
const MAX_COMMAND = COMMAND_MAX_LENGTH;
const MAX_CLIENTS = 50;
/**
 * Client names become Jev Choice options and heuristic patterns, so only the
 * studio's real clients are accepted (the app always sends exactly these).
 * Arbitrary names from a foreign client would otherwise grow server memory.
 */
const KNOWN_CLIENTS = new Set<string>(CLIENT_NAMES);
/** The contract's cap on record candidates: each one is a Jev option with a few lines of criteria. */
const MAX_RECORDS = 12;
/** Longest record id ("<kind>:<record id>"). Ids are keys, so a longer one is dropped, never clipped. */
const MAX_RECORD_ID = 64;
/** Longest record label; longer labels are clipped, like the activity lines. */
const MAX_RECORD_LABEL = 200;
/** Longest code hint ("next overdue invoice in the list"); longer hints are clipped. */
const MAX_RECORD_WHY = 120;
/** The contract's cap on task candidates (focus aid 2): one per goal with pending work fits well under it. */
const MAX_TASKS = 5;
/** Longest task id ("unread_messages"). Ids are keys, so a longer one is dropped, never clipped. */
const MAX_TASK_ID = 64;
/** Longest task label; longer labels are clipped. */
const MAX_TASK_LABEL = 120;
/** Longest count in words ("more than ten"); longer counts are clipped. */
const MAX_TASK_COUNT = 20;
/** Longest working goal label ("Collecting payments"); the catalog's longest is under 30 characters. */
const MAX_GOAL_LABEL = 80;
/** Longest working goal description; the catalog's longest is under 100 characters. */
const MAX_GOAL_DESCRIPTION = 200;
/** The no-match option of the next-task Choice (NO_TASK in questions.ts), so a task can never take its id. */
const RESERVED_TASK_ID = "none";
/** Goals a task can belong to: "unclear" is no work at all. */
const TASK_GOALS = new Set<string>(GOAL_IDS.filter((g) => g !== "unclear"));
/** Linked records per link request ("Arrange linked panels by next step"): one per linked panel fits; each is a Jev option. */
const MAX_LINK_RECORDS = 8;
/** Clicked records the link questions read (LINK_KINDS in src/engine/linkFlow.ts). */
const LINK_KINDS = new Set<string>(["message", "invoice", "task", "project", "event"]);
/** The clicked record's fields the client writes; anything else is dropped. */
const CLICKED_FIELDS = new Set<string>(["from", "client", "subject", "text", "id", "status", "amount", "due", "title", "name", "time"]);
/** Longest clicked text (a message's words), the client's CLICKED_TEXT_MAX; longer text is clipped. */
const MAX_CLICKED_TEXT = 300;
/** Longest other clicked field (a subject, a title, due words); longer ones are clipped. */
const MAX_CLICKED_FIELD = 120;

const ITEM_KINDS = ["invoice", "message", "client", "project", "task", "event", "person", "note"] as const satisfies readonly ItemKind[];
// Compile-time guard: fails if ItemKind gains a kind this list does not have.
const ITEM_KINDS_COMPLETE: [Exclude<ItemKind, (typeof ITEM_KINDS)[number]>] extends [never] ? true : false = true;
void ITEM_KINDS_COMPLETE;
const KNOWN_KINDS = new Set<string>(ITEM_KINDS);
const KNOWN_PANELS = new Set<string>(PANEL_IDS);

/** Records per prep request (focus aid 4): each is one Score question, and ten cover a client's open business. */
const MAX_PREP_RECORDS = 10;
/** Record kinds the prep questions score: a client row is not scored (PREP_RECORD_KINDS in src/engine/meetingPrep.ts). */
const PREP_KINDS = new Set<string>(["message", "invoice", "project", "task"]);
/** The fields the client writes for a prep record; anything else is dropped. */
const PREP_FIELDS = new Set<string>([
  "from",
  "client",
  "subject",
  "text",
  "received",
  "status",
  "id",
  "due",
  "amount",
  "project",
  "reminders",
  "name",
  "progress",
  "deadline",
  "lead",
  "title",
  "assignee",
]);
/** Longest message text in a prep record, the client's PREP_TEXT_MAX; longer text is clipped. */
const MAX_PREP_TEXT = 200;
/** Longest other prep field or meeting word (a title, due words); longer ones are clipped. */
const MAX_PREP_FIELD = 120;
/** The meeting kinds the client prepares for (PREP_KINDS in src/engine/meetingPrep.ts). */
const MEETING_KINDS = new Set<string>(["meeting", "call"]);

export type Parsed = { ok: true; value: AdaptRequest } | { ok: false; error: string };
export type ParsedPrep = { ok: true; value: PrepRequest } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text;
}

/**
 * One record candidate, cleaned, or null when it cannot be used. The id must
 * start with its own kind ("invoice:INV-1038"), so an id never claims a
 * different kind than the entry. A bad optional field is dropped, not the entry.
 */
function parseRecord(raw: unknown): RecordCandidate | null {
  if (!isRecord(raw)) return null;
  const { id, kind, panel, label, client, why } = raw;
  if (typeof kind !== "string" || !KNOWN_KINDS.has(kind)) return null;
  if (typeof panel !== "string" || !KNOWN_PANELS.has(panel)) return null;
  if (typeof id !== "string") return null;
  const cleanId = id.trim();
  if (cleanId.length > MAX_RECORD_ID || !cleanId.startsWith(`${kind}:`) || cleanId.length === kind.length + 1) return null;
  if (typeof label !== "string" || !label.trim()) return null;
  const record: RecordCandidate = {
    id: cleanId,
    kind: kind as ItemKind,
    panel: panel as PanelId,
    label: label.trim().slice(0, MAX_RECORD_LABEL),
  };
  // Same rule as candidates.clients: only the studio's real client names.
  if (typeof client === "string" && KNOWN_CLIENTS.has(client.trim())) record.client = client.trim();
  const hint = typeof why === "string" ? why.trim().slice(0, MAX_RECORD_WHY).trim() : "";
  if (hint) record.why = hint;
  return record;
}

/**
 * candidates.records is optional, so a malformed value costs only the
 * next-record questions, never the whole round: the entries that parse are
 * kept (first of each id, at most MAX_RECORDS), and anything else is dropped.
 */
function parseRecords(raw: unknown): RecordCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: RecordCandidate[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const record = parseRecord(item);
    if (!record || seen.has(record.id)) continue;
    seen.add(record.id);
    out.push(record);
    if (out.length >= MAX_RECORDS) break;
  }
  return out;
}

/** Trimmed text clipped to `max`, or "" when it is not a string. */
function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max).trim() : "";
}

/**
 * One task candidate (focus aid 2), cleaned, or null when it cannot be used:
 * an id that is not a short key or is the no-match id, a goal that is not a
 * real goal, or an empty label, count, or first record. Long text is clipped.
 */
function parseTask(raw: unknown): TaskCandidate | null {
  if (!isRecord(raw)) return null;
  const { id, goal, label, count, first } = raw;
  if (typeof id !== "string") return null;
  const cleanId = id.trim();
  if (!cleanId || cleanId.length > MAX_TASK_ID || cleanId === RESERVED_TASK_ID) return null;
  if (typeof goal !== "string" || !TASK_GOALS.has(goal)) return null;
  const task: TaskCandidate = {
    id: cleanId,
    goal: goal as GoalId,
    label: cleanText(label, MAX_TASK_LABEL),
    count: cleanText(count, MAX_TASK_COUNT),
    first: cleanText(first, MAX_RECORD_LABEL),
  };
  return task.label && task.count && task.first ? task : null;
}

/**
 * candidates.tasks is optional, like candidates.records: a malformed value
 * costs only the next-task question. The entries that parse are kept (first
 * of each id, at most MAX_TASKS), and anything else is dropped.
 */
function parseTasks(raw: unknown): TaskCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: TaskCandidate[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const task = parseTask(item);
    if (!task || seen.has(task.id)) continue;
    seen.add(task.id);
    out.push(task);
    if (out.length >= MAX_TASKS) break;
  }
  return out;
}

/**
 * The clicked record in words, cleaned, or null when it cannot be used: an id
 * that does not start with its own kind, a kind the link questions do not
 * read, or no usable field. Unknown fields are dropped, long ones clipped.
 */
function parseClicked(raw: unknown): ClickedRecord | null {
  if (!isRecord(raw)) return null;
  const { id, kind, fields } = raw;
  if (typeof kind !== "string" || !LINK_KINDS.has(kind) || typeof id !== "string") return null;
  const cleanId = id.trim();
  if (cleanId.length > MAX_RECORD_ID || !cleanId.startsWith(`${kind}:`) || cleanId.length === kind.length + 1) return null;
  if (!isRecord(fields)) return null;
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!CLICKED_FIELDS.has(key)) continue;
    const text = cleanText(value, key === "text" ? MAX_CLICKED_TEXT : MAX_CLICKED_FIELD);
    if (text) clean[key] = text;
  }
  return Object.keys(clean).length > 0 ? { id: cleanId, kind: kind as ItemKind, fields: clean } : null;
}

/**
 * The link request ("Arrange linked panels by next step"), or null. It is
 * optional like the candidates, so a malformed one costs only the two link
 * questions: the linked records that parse are kept (first of each id, not
 * the clicked record, at most MAX_LINK_RECORDS), and with none left there is
 * nothing to ask.
 */
function parseLink(raw: unknown): LinkRequest | null {
  if (!isRecord(raw)) return null;
  const clicked = parseClicked(raw.clicked);
  if (!clicked) return null;
  const records = parseRecords(raw.records)
    .filter((r) => r.id !== clicked.id)
    .slice(0, MAX_LINK_RECORDS);
  return records.length > 0 ? { clicked, records } : null;
}

/** The working goal in words (focus aid 2), or null when it is missing or has no label. It is optional, so a bad one is dropped, never a 400. */
function parseWorkingGoal(raw: unknown): WorkingGoalWords | null {
  if (!isRecord(raw)) return null;
  const label = cleanText(raw.label, MAX_GOAL_LABEL);
  return label ? { label, description: cleanText(raw.description, MAX_GOAL_DESCRIPTION) } : null;
}

/** Validate and cap an /api/adapt body. Returns a plain-English error for a 400. */
export function parseAdaptRequest(body: unknown): Parsed {
  if (!isRecord(body)) return { ok: false, error: "Body must be a JSON object." };

  const { version, snapshot, candidates, command, workingGoal, link } = body;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return { ok: false, error: "version must be a number." };
  }

  if (!isRecord(snapshot)) return { ok: false, error: "snapshot must be an object." };
  const { recent_activity, current_focus, visible_panels, behavior_observations } = snapshot;
  if (!isStringArray(recent_activity)) return { ok: false, error: "snapshot.recent_activity must be an array of strings." };
  if (current_focus !== null && typeof current_focus !== "string") {
    return { ok: false, error: "snapshot.current_focus must be a string or null." };
  }
  if (!isStringArray(visible_panels)) return { ok: false, error: "snapshot.visible_panels must be an array of strings." };
  if (!isStringArray(behavior_observations)) {
    return { ok: false, error: "snapshot.behavior_observations must be an array of strings." };
  }

  if (!isRecord(candidates) || !isStringArray(candidates.clients)) {
    return { ok: false, error: "candidates.clients must be an array of strings." };
  }

  if (command !== undefined && command !== null && typeof command !== "string") {
    return { ok: false, error: "command must be a string when present." };
  }

  const clean: InteractionSnapshot = {
    // Keep the newest entries: the list is oldest first.
    recent_activity: recent_activity.slice(-MAX_ACTIVITY).map(clip),
    current_focus: current_focus === null ? null : clip(current_focus),
    visible_panels: visible_panels.slice(0, MAX_LIST).map(clip),
    behavior_observations: behavior_observations.slice(0, MAX_LIST).map(clip),
  };
  const value: AdaptRequest = {
    version,
    snapshot: clean,
    candidates: { clients: candidates.clients.map((c) => c.trim()).filter((c) => KNOWN_CLIENTS.has(c)).slice(0, MAX_CLIENTS) },
  };
  const records = parseRecords(candidates.records);
  if (records.length > 0) value.candidates.records = records;
  const tasks = parseTasks(candidates.tasks);
  if (tasks.length > 0) value.candidates.tasks = tasks;
  // Clipped like the activity lines, not rejected: a pasted long request still works.
  const text = typeof command === "string" ? command.trim().slice(0, MAX_COMMAND).trim() : "";
  if (text) value.command = text;
  const working = parseWorkingGoal(workingGoal);
  if (working) value.workingGoal = working;
  const linked = parseLink(link);
  if (linked) value.link = linked;
  return { ok: true, value };
}

/**
 * One prep record, cleaned, or null when it cannot be used: an id that does
 * not start with its own kind, a kind the prep questions do not score, an
 * unknown panel, or no usable field. Unknown fields are dropped, long ones
 * clipped, and a client field must name one of the studio's clients or say
 * there is none.
 */
function parsePrepRecord(raw: unknown): PrepRecord | null {
  if (!isRecord(raw)) return null;
  const { id, kind, panel, fields } = raw;
  if (typeof kind !== "string" || !PREP_KINDS.has(kind) || typeof id !== "string") return null;
  if (typeof panel !== "string" || !KNOWN_PANELS.has(panel)) return null;
  const cleanId = id.trim();
  if (cleanId.length > MAX_RECORD_ID || !cleanId.startsWith(`${kind}:`) || cleanId.length === kind.length + 1) return null;
  if (!isRecord(fields)) return null;
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!PREP_FIELDS.has(key)) continue;
    const text = cleanText(value, key === "text" ? MAX_PREP_TEXT : MAX_PREP_FIELD);
    if (!text) continue;
    if (key === "client" && !KNOWN_CLIENTS.has(text) && text !== "No client company") continue;
    clean[key] = text;
  }
  return Object.keys(clean).length > 0 ? { id: cleanId, kind: kind as ItemKind, panel: panel as PanelId, fields: clean } : null;
}

/** The meeting in words, or an error: a title, a known client, time words, and "meeting" or "call". */
function parseMeeting(raw: unknown): PrepMeetingWords | string {
  if (!isRecord(raw)) return "meeting must be an object.";
  const title = cleanText(raw.title, MAX_PREP_FIELD);
  const client = cleanText(raw.client, MAX_PREP_FIELD);
  const time = cleanText(raw.time, MAX_PREP_FIELD);
  if (!title) return "meeting.title must be a non-empty string.";
  if (!KNOWN_CLIENTS.has(client)) return "meeting.client must be one of the studio's clients.";
  if (!time) return "meeting.time must be a non-empty string.";
  if (typeof raw.kind !== "string" || !MEETING_KINDS.has(raw.kind)) return 'meeting.kind must be "meeting" or "call".';
  return { title, client, time, kind: raw.kind as PrepMeetingWords["kind"] };
}

/**
 * Validate and cap a POST /api/prep body (focus aid 4). The meeting must be
 * well formed; records that do not parse are dropped (first of each id, at
 * most MAX_PREP_RECORDS), and with none left there is nothing to rank, which
 * is a 400. Returns a plain-English error for a 400.
 */
export function parsePrepRequest(body: unknown): ParsedPrep {
  if (!isRecord(body)) return { ok: false, error: "Body must be a JSON object." };
  const { version, meeting, records } = body;
  if (typeof version !== "number" || !Number.isFinite(version)) return { ok: false, error: "version must be a number." };
  const m = parseMeeting(meeting);
  if (typeof m === "string") return { ok: false, error: m };
  if (!Array.isArray(records)) return { ok: false, error: "records must be an array." };
  const out: PrepRecord[] = [];
  const seen = new Set<string>();
  for (const item of records) {
    const r = parsePrepRecord(item);
    if (!r || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push(r);
    if (out.length >= MAX_PREP_RECORDS) break;
  }
  if (out.length === 0) return { ok: false, error: "records must list at least one record the prep questions can read." };
  return { ok: true, value: { version, meeting: m, records: out } };
}
