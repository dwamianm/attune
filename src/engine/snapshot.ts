/**
 * Turns the raw signal log into the words-only InteractionSnapshot that Jev reads.
 *
 * Jev reads semantic text better than numbers, reads literally, and cannot
 * count or do date math. So code does the counting here (how many searches,
 * how fast, back and forth, quick dismissals) and hands Jev short plain
 * sentences. Everything in this file is pure: scripts/eval.ts and the tests
 * import it in Node, so it must never touch the DOM or the store.
 */
import { PANELS, panelTitle, type ActionId, type PanelId } from "../../shared/catalog.ts";
import { CLIENTS, INVOICES, MESSAGES, PROJECTS } from "../../shared/fixtures.ts";
import type { InteractionSnapshot, ItemKind, SignalDetail, SignalEvent, SignalType, TrackInput } from "../../shared/types.ts";
import type { BuildSnapshot, DeriveObservations, DescribeEvent, SnapshotContext } from "./contract.ts";
import { humanizeId, listWords, numberWord, possessive, secondsPhrase, timesWord } from "./words.ts";

// Demo defaults. Tune freely; the tests only pin the behavior around them.
/** Most recent activity lines sent to Jev (the contract caps it at 15). */
export const SNAPSHOT_MAX_ACTIVITY = 15;
/** Pointer rests shorter than this are noise, not interest. */
export const DWELL_NOISE_MS = 1_500;
/** Window for counting repeated searches. */
export const SEARCH_WINDOW_MS = 90_000;
/** This many searches inside the window counts as "several". */
export const SEARCH_BURST_MIN = 3;
/** Opening a panel and docking it again within this long counts as a quick dismissal. */
export const QUICK_DISMISS_MS = 5_000;
/** Window for most behavior observations (input style, pace, back and forth). */
export const RECENT_WINDOW_MS = 3 * 60_000;
/** Window for help and suggestion observations. */
export const LONG_WINDOW_MS = 5 * 60_000;
/** Median gap below this reads as a quick pace. */
export const PACE_QUICK_MS = 1_000;
/** Median gap above this reads as a slow pace. */
export const PACE_SLOW_MS = 5_000;
/** How many recent events the pace is measured over. */
export const PACE_SAMPLE = 12;
/** No events for this long reads as idle. */
export const IDLE_MS = 2 * 60_000;
/**
 * Opening the same record this many times in RECENT_WINDOW_MS counts as going
 * back to it again and again. Three, not two: checking a record twice while
 * comparing is normal; a third open with nothing done in between reads as stuck.
 */
export const REOPEN_MIN = 3;
/** A search that starts like a question about how or where, not a keyword ("how do I send a reminder"). */
export const HOW_TO_SEARCH = /^\s*(how\s+(do|does|can|to|should|would)|where\s+(is|are|do|does|can)|can\s+i|what\s+do\s+i|help\b)/i;
/** A, B, A, B: the shortest alternating run that counts as back and forth. */
export const BACK_AND_FORTH_MIN = 4;
/** An alternating run this long reads as "several times". */
export const BACK_AND_FORTH_MANY = 6;

/**
 * Event types that mean "the user is working in this panel". Used for focus
 * order. Opening a record from Up next, starting the next task from the
 * Done card (which opens its first record), or preparing for a meeting
 * (which selects it in Calendar) is a record open.
 */
export const WORK_TYPES: ReadonlySet<SignalType> = new Set<SignalType>(["panel_focus", "item_open", "up_next_open", "task_start", "prep_start", "search", "filter", "action"]);
/**
 * Event types about the app's own cues or bookkeeping, not the work: logged
 * for the inspector's Signals tab and never put in the snapshot, so clearing
 * the link cues, the engine saving a working context (context_save, which
 * the user did not do), switching a focus aid on or off (setting_change),
 * the engine saying the work is done (task_done), or the engine offering to
 * prepare for a meeting (prep_offer) cannot change what Jev judges.
 */
export const CUE_ONLY_TYPES: ReadonlySet<SignalType> = new Set<SignalType>(["links_dismiss", "context_save", "setting_change", "task_done", "prep_offer"]);
/** Event types that open one record: a click on a row, the Up next card, starting the next task, or preparing for a meeting. */
const RECORD_OPEN_TYPES: ReadonlySet<SignalType> = new Set<SignalType>(["item_open", "up_next_open", "task_start", "prep_start"]);

const ITEM_WORDS: Record<ItemKind, string> = {
  invoice: "invoice",
  message: "message",
  client: "client",
  project: "project",
  task: "task",
  event: "calendar event",
  person: "team member",
  note: "note",
};

function title(panel: PanelId | undefined): string | null {
  return panel && PANELS[panel] ? panelTitle(panel) : null;
}

function inPanel(panel: PanelId | undefined): string {
  const t = title(panel);
  return t ? ` in ${t}` : "";
}

function viaSuffix(detail: SignalDetail | undefined): string {
  switch (detail?.via) {
    case "keyboard":
      return ", using the keyboard";
    case "command":
      return ", from the command bar";
    case "suggestion":
      return ", from a suggestion";
    default:
      return "";
  }
}

/** Past-tense sentence for a performed action. Exported so the store and tests agree on wording. */
export function actionPast(actionId: ActionId, detail: SignalDetail = {}): string {
  const client = detail.client;
  switch (actionId) {
    case "send_payment_reminder":
      return `Sent a payment reminder${client ? ` to ${client}` : ""}${detail.itemId ? ` for ${detail.itemId}` : ""}`;
    case "mark_invoice_paid":
      if (detail.itemId) return `Marked invoice ${detail.itemId} as paid`;
      return client ? `Marked ${possessive(client)} invoice as paid` : "Marked an invoice as paid";
    case "resend_invoice":
      return `Resent ${detail.itemId ? `invoice ${detail.itemId}` : "an invoice"}${client ? ` to ${client}` : ""}`;
    case "reply_to_message":
      return client ? `Replied to ${client}` : "Replied to a message";
    case "schedule_meeting":
      return client ? `Scheduled a meeting with ${client}` : "Scheduled a meeting";
    case "create_task":
      if (detail.label) return `Added a task: "${detail.label}"`;
      return client ? `Added a task for ${client}` : "Added a task";
    case "update_project_status":
      return client ? `Updated the status of ${possessive(client)} project` : "Updated a project's status";
    case "view_client":
      return client ? `Opened the details for ${client}` : "Opened a client's details";
    case "write_note":
      return "Wrote a note";
    case "none":
      return "Took an action";
  }
}

function describeFilter(input: TrackInput): string {
  const where = title(input.panel);
  const target = where ?? "the list";
  if (input.detail?.label) return `Filtered ${target} to ${input.detail.label}`;
  const entries = Object.entries(input.detail?.filter ?? {});
  if (entries.length === 0) return `Changed a filter${inPanel(input.panel)}`;
  const set = entries.filter(([, v]) => v && v !== "all");
  const cleared = entries.filter(([, v]) => !v || v === "all").map(([k]) => humanizeId(k));
  if (set.length === 0) return `Removed the ${listWords(cleared)} filter${inPanel(input.panel)}`;
  return `Filtered ${target} to ${listWords(set.map(([k, v]) => `${humanizeId(k)} ${humanizeId(v)}`))}`;
}

/** "invoice INV-1042 · Harbor Coffee Co. · ...": the record an open names, without "Opened". */
function openedWhat(d: SignalDetail): string {
  const kind = d.itemKind ? ITEM_WORDS[d.itemKind] : null;
  let what: string;
  if (d.label) {
    // Skip the kind word when the label already starts with it ("Invoice INV-1042").
    const repeatsKind = kind !== null && d.label.toLowerCase().startsWith(kind);
    what = kind && !repeatsKind ? `${kind} ${d.label}` : d.label;
  } else if (d.itemId) {
    what = `${kind ?? "item"} ${d.itemId}${d.client ? ` for ${d.client}` : ""}`;
  } else {
    what = `${kind ? `a ${kind}` : "an item"}${d.client ? ` for ${d.client}` : ""}`;
  }
  return what;
}

function describeItemOpen(input: TrackInput): string {
  const d = input.detail ?? {};
  return `Opened ${openedWhat(d)}${inPanel(input.panel)}${viaSuffix(d)}`;
}

/** Reads like a record open, so Jev sees the same record words: "Opened invoice INV-1038 ... in Invoices from Up next". */
function describeUpNextOpen(input: TrackInput): string {
  const d = input.detail ?? {};
  return `Opened ${openedWhat(d)}${inPanel(input.panel)} from Up next${d.via === "keyboard" ? ", using the keyboard" : ""}`;
}

/**
 * Preparing for a meeting (focus aid 4), with the meeting in the same words
 * as a record open: "Started preparing for calendar event Harbor rebrand
 * review, 11:00 today in Calendar".
 */
function describePrepStart(input: TrackInput): string {
  const d = input.detail ?? {};
  return `Started preparing for ${openedWhat(d)}${inPanel(input.panel)}${d.via === "keyboard" ? ", using the keyboard" : ""}`;
}

/**
 * Starting the next task from the Done card (focus aid 2), with the record it
 * opened in the same words as a record open: "Started the next task: two
 * unread client messages, and opened message ... in Inbox".
 */
function describeTaskStart(input: TrackInput): string {
  const d = input.detail ?? {};
  const opened = d.itemId || d.label ? `, and opened ${openedWhat(d)}${inPanel(input.panel)}` : "";
  return `Started the next task: ${d.task ?? "the next piece of work"}${opened}${d.via === "keyboard" ? ", using the keyboard" : ""}`;
}

function suggestionText(d: SignalDetail): string {
  if (d.label) return `"${d.label}"`;
  if (d.actionId) return `to ${actionPast(d.actionId, d).replace(/^[A-Z]/, (c) => c.toLowerCase())}`;
  return "";
}

/** One plain English sentence per event. Uses panel titles, never raw ids. */
export const describeEvent: DescribeEvent = (input) => {
  const d = input.detail ?? {};
  const panel = title(input.panel);
  switch (input.type) {
    case "panel_focus": {
      const t = panel ?? "a panel";
      if (d.via === "keyboard") return `Moved to ${t} with the keyboard`;
      if (d.via === "command") return `Jumped to ${t} from the command bar`;
      if (d.via === "suggestion") return `Went to ${t} from a suggestion`;
      return `Clicked into ${t}`;
    }
    case "panel_open": {
      const t = panel ?? "a panel";
      if (d.via === "command") return `Opened ${t} from the command bar`;
      if (d.via === "suggestion") return `Opened ${t} from a suggestion`;
      return `Opened ${t} from the dock`;
    }
    case "panel_dismiss":
      return `Sent ${panel ?? "a panel"} back to the dock${d.durationMs != null ? ` after ${secondsPhrase(d.durationMs)}` : ""}`;
    case "panel_pin":
      return `Pinned ${panel ?? "a panel"} to keep it on screen`;
    case "panel_unpin":
      return `Unpinned ${panel ?? "a panel"}`;
    case "panel_dwell": {
      const on = panel ? ` on ${panel}` : "";
      return d.durationMs != null ? `Rested the pointer${on} for about ${secondsPhrase(d.durationMs)}` : `Rested the pointer${on}`;
    }
    case "item_open":
      return describeItemOpen(input);
    case "search": {
      const q = (d.query ?? "").trim();
      if (!q) return `Cleared the search${inPanel(input.panel)}`;
      return `Searched ${panel ? `${panel} ` : ""}for "${q}"`;
    }
    case "filter":
      return describeFilter(input);
    case "action": {
      let text: string;
      if (d.actionId && d.actionId !== "none") text = actionPast(d.actionId, d);
      else if (d.label) text = `Used "${d.label}"`;
      else text = "Took an action";
      return `${text}${inPanel(input.panel)}${viaSuffix(d)}`;
    }
    case "command": {
      const q = (d.query ?? "").trim();
      return q ? `Typed in the command bar: "${q}"` : "Opened the command bar";
    }
    case "shortcut":
      return d.key ? `Used keyboard shortcut ${d.key}${inPanel(input.panel)}` : `Used a keyboard shortcut${inPanel(input.panel)}`;
    case "scroll":
      return panel ? `Scrolled through ${panel}` : "Scrolled a list";
    case "suggestion_accept": {
      const s = suggestionText(d);
      return s ? `Accepted the suggestion ${s}` : "Accepted a suggestion";
    }
    case "suggestion_dismiss": {
      const s = suggestionText(d);
      return s ? `Dismissed the suggestion ${s}` : "Dismissed a suggestion";
    }
    case "undo":
      return "Undid the last layout change";
    case "links_dismiss": {
      const t = title(d.linkedPanel);
      if (t) return `Removed the link to ${t}${viaSuffix(d)}`;
      return `Cleared the links${d.label ? ` for ${d.label}` : ""}${viaSuffix(d)}`;
    }
    case "panel_maximize":
      return `Made ${panel ?? "a panel"} bigger`;
    case "panel_restore":
      return `Made ${panel ?? "a panel"} smaller`;
    case "up_next_open":
      return describeUpNextOpen(input);
    // Engine-made and left out of the snapshot (CUE_ONLY_TYPES); for the inspector's Signals tab.
    case "context_save":
      return `Saved ${d.label ?? "the previous work"} for Back to`;
    case "context_restore":
      return `Went back to earlier work: ${d.label ?? "a saved layout"}${viaSuffix(d)}`;
    // A settings switch, left out of the snapshot (CUE_ONLY_TYPES); for the inspector's Signals tab.
    case "setting_change":
      return `Turned ${d.enabled === false ? "off" : "on"} "${d.label ?? d.setting ?? "a setting"}"${viaSuffix(d)}`;
    // Engine-made (focus aid 2) and left out of the snapshot (CUE_ONLY_TYPES); for the inspector's Signals tab.
    case "task_done":
      return `Said "${d.label ?? "the current work"}" is done${d.task ? `, and offered the next task: ${d.task}` : ""}`;
    case "task_start":
      return describeTaskStart(input);
    // Engine-made (focus aid 4) and left out of the snapshot (CUE_ONLY_TYPES); for the inspector's Signals tab.
    case "prep_offer":
      return `Offered to prepare for ${d.label ?? "a meeting"}`;
    case "prep_start":
      return describePrepStart(input);
  }
};

// ---------------------------------------------------------------------------
// Behavior observations
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set(["the", "and", "for", "are", "where", "what", "who", "how", "show", "find", "from", "with", "our", "all", "any", "can", "you", "this", "that"]);

/** Lowercase, drop punctuation and a plural "s" so "bills" and "bill" match. */
function searchTokens(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function searchObservations(events: SignalEvent[], now: number): string[] {
  const searches = events.filter((e) => e.type === "search" && now - e.t <= SEARCH_WINDOW_MS && (e.detail?.query ?? "").trim());
  if (searches.length < SEARCH_BURST_MIN) return [];
  const queries = searches.map((e) => `"${(e.detail?.query ?? "").trim()}"`);
  const out = [`Searched ${numberWord(searches.length)} times in the last minute and a half: ${queries.join(", ")}`];

  // A word shared by at least half of the searches suggests the user keeps looking for the same thing.
  const counts = new Map<string, number>();
  for (const s of searches) for (const w of new Set(searchTokens(s.detail?.query ?? ""))) counts.set(w, (counts.get(w) ?? 0) + 1);
  const shared = [...counts.entries()].filter(([, n]) => n >= Math.max(2, Math.ceil(searches.length / 2))).sort((a, b) => b[1] - a[1]);
  if (shared.length) out.push(`The searches keep repeating the same word: "${shared[0][0]}"`);

  const firstT = searches[0].t;
  const openedAfter = events.some((e) => e.type === "item_open" && e.t >= firstT);
  if (!openedAfter) out.push("None of these searches led to opening an item");
  return out;
}

/** A search phrased as a question about how or where suggests the user does not know the way. */
function howToSearchObservation(events: SignalEvent[], now: number): string[] {
  const questions = events
    .filter((e) => e.type === "search" && now - e.t <= RECENT_WINDOW_MS && HOW_TO_SEARCH.test(e.detail?.query ?? ""))
    .map((e) => `"${(e.detail?.query ?? "").trim()}"`);
  if (questions.length === 0) return [];
  return questions.length === 1
    ? [`A search was phrased as a how-to question: ${questions[0]}`]
    : [`${numberWord(questions.length).replace(/^./, (c) => c.toUpperCase())} searches were phrased as how-to questions: ${questions.join(", ")}`];
}

/** The same record opened again and again, which a single reopen while comparing is not. */
function reopenObservation(events: SignalEvent[], now: number): string[] {
  const counts = new Map<string, { n: number; what: string; actedAfterFirst: boolean; firstT: number }>();
  for (const e of events) {
    if (now - e.t > RECENT_WINDOW_MS) continue;
    if (RECORD_OPEN_TYPES.has(e.type) && e.detail?.itemId) {
      const key = `${e.panel ?? ""}|${e.detail.itemId}`;
      const kind = e.detail.itemKind ? ITEM_WORDS[e.detail.itemKind] : "item";
      const entry = counts.get(key) ?? { n: 0, what: `${kind} ${e.detail.itemId}`, actedAfterFirst: false, firstT: e.t };
      entry.n += 1;
      counts.set(key, entry);
    } else if (e.type === "action" && e.detail?.itemId) {
      for (const [key, entry] of counts) if (key.endsWith(`|${e.detail.itemId}`)) entry.actedAfterFirst = true;
    }
  }
  const out: string[] = [];
  for (const { n, what, actedAfterFirst } of counts.values()) {
    if (n >= REOPEN_MIN && !actedAfterFirst) out.push(`Opened ${what} ${timesWord(n)} in the last few minutes without acting on it`);
  }
  return out;
}

function quickDismissObservation(events: SignalEvent[], now: number): string[] {
  const panels: PanelId[] = [];
  events.forEach((e, i) => {
    if (e.type !== "panel_dismiss" || !e.panel || now - e.t > RECENT_WINDOW_MS) return;
    let quick = e.detail?.durationMs != null && e.detail.durationMs <= QUICK_DISMISS_MS;
    if (!quick) {
      for (let j = i - 1; j >= 0; j--) {
        const prev = events[j];
        if (prev.panel !== e.panel) continue;
        if (prev.type === "panel_dismiss") break;
        if (prev.type === "panel_open") {
          quick = e.t - prev.t <= QUICK_DISMISS_MS;
          break;
        }
      }
    }
    if (quick && !panels.includes(e.panel)) panels.push(e.panel);
  });
  if (panels.length === 0) return [];
  const names = listWords(panels.map(panelTitle));
  return panels.length === 1
    ? [`Opened ${names}, then sent it back to the dock within a few seconds`]
    : [`Opened ${names}, then sent each one back to the dock within a few seconds`];
}

/** Recent focus order, with consecutive repeats collapsed. */
export function focusSequence(events: SignalEvent[], now: number, windowMs = RECENT_WINDOW_MS): PanelId[] {
  const seq: PanelId[] = [];
  for (const e of events) {
    if (!e.panel || !WORK_TYPES.has(e.type) || now - e.t > windowMs) continue;
    if (seq[seq.length - 1] !== e.panel) seq.push(e.panel);
  }
  return seq;
}

function backAndForthObservation(events: SignalEvent[], now: number): string[] {
  const seq = focusSequence(events, now);
  const n = seq.length;
  if (n < BACK_AND_FORTH_MIN) return [];
  let run = 2; // seq[n-1] and seq[n-2] always differ after collapsing repeats.
  for (let k = n - 3; k >= 0 && seq[k] === seq[k + 2]; k--) run++;
  if (run < BACK_AND_FORTH_MIN) return [];
  const a = panelTitle(seq[n - 2]);
  const b = panelTitle(seq[n - 1]);
  return [`Switched back and forth between ${a} and ${b}${run >= BACK_AND_FORTH_MANY ? " several times" : ""}`];
}

function isKeyboardish(e: SignalEvent): boolean {
  return e.type === "shortcut" || e.type === "command" || e.detail?.via === "keyboard" || e.detail?.via === "command";
}

const POINTER_TYPES: ReadonlySet<SignalType> = new Set<SignalType>([
  "panel_focus",
  "panel_open",
  "panel_dismiss",
  "panel_pin",
  "panel_unpin",
  "panel_maximize",
  "panel_restore",
  "panel_dwell",
  "item_open",
  "up_next_open",
  "task_start",
  "prep_start",
  "filter",
  "action",
  "scroll",
  "suggestion_accept",
  "suggestion_dismiss",
  "context_restore",
]);

/**
 * Pointer versus keyboard. Panel searches count as neither: people new to an
 * app type searches as much as experts do, so they say nothing about skill.
 */
function inputStyleObservation(recent: SignalEvent[]): string[] {
  const keyboard = recent.filter(isKeyboardish);
  const pointer = recent.filter((e) => !isKeyboardish(e) && POINTER_TYPES.has(e.type));
  // A typed command is the command bar, not a keyboard shortcut, even though it arrives with via "keyboard".
  const usesShortcuts = keyboard.some((e) => e.type === "shortcut" || (e.type !== "command" && e.detail?.via === "keyboard"));
  const usesCommandBar = keyboard.some((e) => e.type === "command" || e.detail?.via === "command");
  const tools =
    usesShortcuts && usesCommandBar ? "keyboard shortcuts and the command bar" : usesCommandBar ? "the command bar" : "keyboard shortcuts";
  if (keyboard.length >= 3 && pointer.length === 0) return [`Moves only with ${tools}, not the pointer`];
  if (keyboard.length >= 3 && keyboard.length >= pointer.length) return [`Uses ${tools} more than the pointer`];
  if (keyboard.length >= 1) {
    // Only claim "pointer mostly" when the pointer really was used more.
    if (pointer.length > keyboard.length) return [`Uses the pointer mostly, with some use of ${tools}`];
    if (pointer.length > 0) return [`Uses both the pointer and ${tools}`];
    return []; // One or two keyboard events and nothing else: too little to describe a style.
  }
  if (pointer.length >= 4) return ["Uses only the pointer, no keyboard shortcuts or command bar"];
  return [];
}

function paceObservation(recent: SignalEvent[]): string[] {
  // Pointer rests are passive, so they are not part of the pace.
  const sample = recent.filter((e) => e.type !== "panel_dwell").slice(-PACE_SAMPLE);
  if (sample.length < 4) return [];
  const gaps: number[] = [];
  for (let i = 1; i < sample.length; i++) gaps.push(Math.max(0, sample[i].t - sample[i - 1].t));
  const m = median(gaps);
  if (m < PACE_QUICK_MS) return ["Working at a quick pace"];
  if (m <= PACE_SLOW_MS) return ["Working at a steady pace"];
  // Not "slowly": Jev read that word literally against the expertise level
  // for new users and judged a careful, purposeful reader as lost.
  return ["Long pauses between actions, as when reading"];
}

function suggestionObservation(events: SignalEvent[], now: number): string[] {
  const recent = events.filter((e) => now - e.t <= LONG_WINDOW_MS);
  const accepted = recent.filter((e) => e.type === "suggestion_accept").length;
  const dismissed = recent.filter((e) => e.type === "suggestion_dismiss").length;
  const noun = (n: number) => (n === 1 ? "suggested next step" : "suggested next steps");
  if (accepted && dismissed) return [`Accepted ${numberWord(accepted)} ${noun(accepted)} and dismissed ${numberWord(dismissed)}`];
  if (accepted) return [`Accepted ${numberWord(accepted)} ${noun(accepted)}`];
  if (dismissed) return [`Dismissed ${numberWord(dismissed)} ${noun(dismissed)}`];
  return [];
}

/**
 * Code-derived behavior facts as short sentences, included only when true.
 * Numbers are bucketed into words because Jev reads words better.
 */
export const deriveObservations: DeriveObservations = (events, now) => {
  if (events.length === 0) return [];
  const recent = events.filter((e) => now - e.t <= RECENT_WINDOW_MS);
  const out: string[] = [];

  if (events.length <= 2) out.push(events.length === 1 ? "Only one action so far" : "Only two actions so far");
  out.push(...searchObservations(events, now));
  out.push(...howToSearchObservation(events, now));
  out.push(...reopenObservation(events, now));
  out.push(...quickDismissObservation(events, now));
  out.push(...backAndForthObservation(events, now));
  if (events.some((e) => e.panel === "help" && (e.type === "panel_open" || e.type === "panel_focus") && now - e.t <= LONG_WINDOW_MS)) {
    out.push(`Opened the ${panelTitle("help")} panel for help`);
  }
  out.push(...suggestionObservation(events, now));
  if (events.some((e) => e.type === "undo" && now - e.t <= LONG_WINDOW_MS)) out.push("Undid a layout change");
  out.push(...inputStyleObservation(recent));
  out.push(...paceObservation(recent));

  const last = events[events.length - 1];
  if (now - last.t > IDLE_MS) out.push("No activity for the last few minutes");
  return out;
};

// ---------------------------------------------------------------------------
// Current focus
// ---------------------------------------------------------------------------

function clientName(value: string): string {
  return CLIENTS.find((c) => c.id === value)?.name ?? value;
}

/** What the focused panel is showing, from view state, falling back to the last item opened there. */
function focusDetails(ctx: SnapshotContext, events: SignalEvent[]): string[] {
  const panel = ctx.focusedPanel;
  const view = ctx.view;
  const parts: string[] = [];
  if (!panel) return parts;
  switch (panel) {
    case "inbox": {
      const v = view?.inbox;
      const m = v?.selectedId ? MESSAGES.find((x) => x.id === v.selectedId) : undefined;
      if (m) parts.push(`reading "${m.subject}" from ${m.from}`);
      if (v?.query) parts.push(`searching for "${v.query}"`);
      if (v?.client) parts.push(`showing messages from ${v.client}`);
      break;
    }
    case "invoices": {
      const v = view?.invoices;
      if (v?.selectedId) {
        const inv = INVOICES.find((x) => x.id === v.selectedId);
        parts.push(`viewing invoice ${v.selectedId}${inv ? ` for ${inv.client}` : ""}`);
      }
      if (v && v.status !== "all" && v.status !== "not_mentioned") parts.push(`showing ${humanizeId(v.status)} invoices`);
      if (v?.client) parts.push(`filtered to ${v.client}`);
      break;
    }
    case "clients": {
      const v = view?.clients;
      if (v?.selected) parts.push(`viewing ${clientName(v.selected)}`);
      if (v?.query) parts.push(`searching for "${v.query}"`);
      break;
    }
    case "tasks": {
      const v = view?.tasks;
      if (v?.client) parts.push(`showing tasks for ${v.client}`);
      if (v?.showDone) parts.push("including done tasks");
      break;
    }
    case "projects": {
      const v = view?.projects;
      const p = v?.selectedId ? PROJECTS.find((x) => x.id === v.selectedId) : undefined;
      if (p) parts.push(`viewing ${p.name} for ${p.client}`);
      if (v && v.status !== "all") parts.push(`showing ${humanizeId(v.status)} projects`);
      break;
    }
    case "calendar":
      if (view) parts.push(view.calendar.range === "today" ? "showing today" : "showing this week");
      break;
    case "analytics":
      if (view) parts.push(view.analytics.range === "this_month" ? "showing this month" : "showing this year");
      break;
    default:
      break;
  }
  // The UI may not record every selection in view state, so fall back to the log.
  const hasSelection = parts.some((p) => p.startsWith("viewing") || p.startsWith("reading"));
  if (!hasSelection) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!RECORD_OPEN_TYPES.has(e.type) || e.panel !== panel) continue;
      if (ctx.now - e.t > RECENT_WINDOW_MS) break;
      const d = e.detail ?? {};
      const kind = d.itemKind ? ITEM_WORDS[d.itemKind] : "item";
      const what = d.label ?? d.itemId;
      if (what) parts.unshift(`last opened ${d.label && d.label.toLowerCase().startsWith(kind) ? "" : `${kind} `}${what}`);
      break;
    }
  }
  return parts;
}

function describeFocus(ctx: SnapshotContext, events: SignalEvent[]): string | null {
  if (!ctx.focusedPanel || !PANELS[ctx.focusedPanel]) return null;
  const parts = focusDetails(ctx, events);
  return [`${panelTitle(ctx.focusedPanel)} panel`, ...parts].join(", ");
}

/**
 * The words-only picture Jev reads: recent activity (oldest first), the
 * current focus, the panels on screen, and code-derived observations (plus
 * ctx.habits, the user's habits in words, when focus aid 3 is on).
 */
export const buildSnapshot: BuildSnapshot = (allEvents, ctx) => {
  const events = allEvents.filter((e) => !CUE_ONLY_TYPES.has(e.type));
  const lines: string[] = [];
  let lastBase: string | null = null;
  let repeats = 0;
  for (const e of events) {
    if (e.type === "panel_dwell" && (e.detail?.durationMs ?? 0) < DWELL_NOISE_MS) continue;
    const text = e.text || describeEvent(e);
    if (text === lastBase) {
      repeats++;
      lines[lines.length - 1] = `${text} (${timesWord(repeats)} in a row)`;
    } else {
      lines.push(text);
      lastBase = text;
      repeats = 1;
    }
  }
  const snapshot: InteractionSnapshot = {
    recent_activity: lines.slice(-SNAPSHOT_MAX_ACTIVITY),
    current_focus: describeFocus(ctx, events),
    visible_panels: ctx.visiblePanels.filter((p) => PANELS[p]).map(panelTitle),
    // Focus aid 3: at most two habits in words, after the facts about now. Absent (the aid off, the eval): as before.
    behavior_observations: [...deriveObservations(events, ctx.now), ...(ctx.habits ?? [])],
  };
  return snapshot;
};

