/**
 * Turns the raw signal log into the words-only InteractionSnapshot that the
 * model reads.
 *
 * The model reads semantic text better than numbers, reads literally, and
 * cannot count or do date math. So code does the counting here (how many
 * searches, how fast, back and forth, quick dismissals) and hands the model
 * short plain sentences. Everything here is pure: no DOM, no store.
 *
 * The app supplies its words (EventWords: panel titles, record kinds, its
 * actions in the past tense), how to count its own event types
 * (SignalProfile, signals.ts), and the sentences for its own event types and
 * for what its focused panel shows. The wording and the thresholds were
 * tuned in the demo app against live Jev answers.
 */
import type { CoreSignalType, SignalDetail, SignalEventLike, SignalProfile } from "./signals.ts";
import { humanizeId, listWords, numberWord, secondsPhrase, timesWord } from "./words.ts";

/** A compact, words-only picture of what the user has been doing. */
export interface InteractionSnapshot {
  /** Oldest first, newest last. At most 15 entries. */
  recent_activity: string[];
  /** Plain sentence, for example "Invoices panel, viewing invoice INV-1042 (Harbor Coffee Co., overdue)". */
  current_focus: string | null;
  /** Titles of panels currently on screen. */
  visible_panels: string[];
  /** Code-derived facts in words, for example "Searched 3 times in the last minute". */
  behavior_observations: string[];
}

/**
 * The activity line for typing `command` into the command bar. The browser
 * logs it, and the model layer drops it from the activity when the same
 * command is sent on its own, so both sides must use the same words.
 */
export function commandActivityLine(command: string): string {
  return `Typed in the command bar: "${command}"`;
}

// ---------------------------------------------------------------------------
// Thresholds. Tuned in the demo; the tests pin the behavior around them.
// ---------------------------------------------------------------------------

/** Most recent activity lines sent to the model. */
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

// ---------------------------------------------------------------------------
// Event sentences
// ---------------------------------------------------------------------------

/** The app's words the sentences use. */
export interface EventWords<P extends string = string> {
  /** The app's panels (Catalog.panels), for their titles. */
  panels: Readonly<Partial<Record<P, { title: string }>>>;
  /** Each record kind in words, for example { event: "calendar event" }. A kind not listed reads as "item". */
  itemWords: Readonly<Record<string, string>>;
  /** Past-tense sentence for one of the app's actions ("Sent a payment reminder to Kite & Co."). Absent: the label, or "Took an action". */
  actionPast?: (actionId: string, detail: SignalDetail) => string;
}

/** A panel's title, or null when `panel` is not one of the app's panels. */
export function panelTitleOf<P extends string>(words: EventWords<P>, panel: P | undefined): string | null {
  const def = panel ? words.panels[panel] : undefined;
  return def ? def.title : null;
}

/** " in Invoices", or "" without a known panel. */
export function inPanel<P extends string>(words: EventWords<P>, panel: P | undefined): string {
  const t = panelTitleOf(words, panel);
  return t ? ` in ${t}` : "";
}

/** ", using the keyboard", ", from the command bar", ", from a suggestion", or "". */
export function viaSuffix(detail: SignalDetail | undefined): string {
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

function itemWord(words: EventWords, kind: string | undefined): string | null {
  return kind ? (words.itemWords[kind] ?? null) : null;
}

/** "invoice INV-1042 for Harbor Coffee Co.": the record an open names, without "Opened". */
export function openedWhat(d: SignalDetail, words: EventWords): string {
  const kind = itemWord(words, d.itemKind);
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

function describeFilter<P extends string>(input: { panel?: P; detail?: SignalDetail }, words: EventWords<P>): string {
  const where = panelTitleOf(words, input.panel);
  const target = where ?? "the list";
  if (input.detail?.label) return `Filtered ${target} to ${input.detail.label}`;
  const entries = Object.entries(input.detail?.filter ?? {});
  if (entries.length === 0) return `Changed a filter${inPanel(words, input.panel)}`;
  const set = entries.filter(([, v]) => v && v !== "all");
  const cleared = entries.filter(([, v]) => !v || v === "all").map(([k]) => humanizeId(k));
  if (set.length === 0) return `Removed the ${listWords(cleared)} filter${inPanel(words, input.panel)}`;
  return `Filtered ${target} to ${listWords(set.map(([k, v]) => `${humanizeId(k)} ${humanizeId(v)}`))}`;
}

function suggestionText(d: SignalDetail, words: EventWords): string {
  if (d.label) return `"${d.label}"`;
  if (d.actionId && words.actionPast) return `to ${words.actionPast(d.actionId, d).replace(/^[A-Z]/, (c) => c.toLowerCase())}`;
  return "";
}

/** One plain English sentence for a core event. Uses panel titles, never raw ids. An app describes its own event types and calls this for the rest. */
export function describeCoreEvent<P extends string>(input: { type: CoreSignalType; panel?: P; detail?: SignalDetail }, words: EventWords<P>): string {
  const d = input.detail ?? {};
  const panel = panelTitleOf(words, input.panel);
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
      return `Opened ${openedWhat(d, words)}${inPanel(words, input.panel)}${viaSuffix(d)}`;
    case "search": {
      const q = (d.query ?? "").trim();
      if (!q) return `Cleared the search${inPanel(words, input.panel)}`;
      return `Searched ${panel ? `${panel} ` : ""}for "${q}"`;
    }
    case "filter":
      return describeFilter(input, words);
    case "action": {
      let text: string;
      if (d.actionId && d.actionId !== "none" && words.actionPast) text = words.actionPast(d.actionId, d);
      else if (d.label) text = `Used "${d.label}"`;
      else text = "Took an action";
      return `${text}${inPanel(words, input.panel)}${viaSuffix(d)}`;
    }
    case "command": {
      const q = (d.query ?? "").trim();
      return q ? commandActivityLine(q) : "Opened the command bar";
    }
    case "shortcut":
      return d.key ? `Used keyboard shortcut ${d.key}${inPanel(words, input.panel)}` : `Used a keyboard shortcut${inPanel(words, input.panel)}`;
    case "scroll":
      return panel ? `Scrolled through ${panel}` : "Scrolled a list";
    case "suggestion_accept": {
      const s = suggestionText(d, words);
      return s ? `Accepted the suggestion ${s}` : "Accepted a suggestion";
    }
    case "suggestion_dismiss": {
      const s = suggestionText(d, words);
      return s ? `Dismissed the suggestion ${s}` : "Dismissed a suggestion";
    }
    case "undo":
      return "Undid the last layout change";
    case "panel_maximize":
      return `Made ${panel ?? "a panel"} bigger`;
    case "panel_restore":
      return `Made ${panel ?? "a panel"} smaller`;
  }
}

// ---------------------------------------------------------------------------
// Behavior observations
// ---------------------------------------------------------------------------

/** What the observations need besides the events: how to count the app's types, its words, and its help panel if it has one. */
export interface ObservationOptions<T extends string = string, P extends string = string> {
  profile: SignalProfile<T>;
  words: EventWords<P>;
  /** A panel whose opening reads as "Opened the <title> panel for help". */
  helpPanel?: P;
}

type Ev<T extends string, P extends string> = SignalEventLike<T, P>;

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

function searchObservations<T extends string, P extends string>(events: readonly Ev<T, P>[], now: number): string[] {
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
function howToSearchObservation<T extends string, P extends string>(events: readonly Ev<T, P>[], now: number): string[] {
  const questions = events
    .filter((e) => e.type === "search" && now - e.t <= RECENT_WINDOW_MS && HOW_TO_SEARCH.test(e.detail?.query ?? ""))
    .map((e) => `"${(e.detail?.query ?? "").trim()}"`);
  if (questions.length === 0) return [];
  return questions.length === 1
    ? [`A search was phrased as a how-to question: ${questions[0]}`]
    : [`${numberWord(questions.length).replace(/^./, (c) => c.toUpperCase())} searches were phrased as how-to questions: ${questions.join(", ")}`];
}

/** The same record opened again and again, which a single reopen while comparing is not. */
function reopenObservation<T extends string, P extends string>(events: readonly Ev<T, P>[], now: number, opts: ObservationOptions<T, P>): string[] {
  const counts = new Map<string, { n: number; what: string; actedAfterFirst: boolean; firstT: number }>();
  for (const e of events) {
    if (now - e.t > RECENT_WINDOW_MS) continue;
    if (opts.profile.recordOpen.has(e.type) && e.detail?.itemId) {
      const key = `${e.panel ?? ""}|${e.detail.itemId}`;
      const kind = e.detail.itemKind ? opts.words.itemWords[e.detail.itemKind] : "item";
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

function quickDismissObservation<T extends string, P extends string>(events: readonly Ev<T, P>[], now: number, words: EventWords<P>): string[] {
  const panels: P[] = [];
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
  const names = listWords(panels.map((p) => panelTitleOf(words, p) ?? p));
  return panels.length === 1
    ? [`Opened ${names}, then sent it back to the dock within a few seconds`]
    : [`Opened ${names}, then sent each one back to the dock within a few seconds`];
}

/** Recent focus order (the profile's work types), with consecutive repeats collapsed. */
export function focusSequence<T extends string, P extends string>(events: readonly Ev<T, P>[], now: number, profile: Pick<SignalProfile<T>, "work">, windowMs = RECENT_WINDOW_MS): P[] {
  const seq: P[] = [];
  for (const e of events) {
    if (!e.panel || !profile.work.has(e.type) || now - e.t > windowMs) continue;
    if (seq[seq.length - 1] !== e.panel) seq.push(e.panel);
  }
  return seq;
}

function backAndForthObservation<T extends string, P extends string>(events: readonly Ev<T, P>[], now: number, opts: ObservationOptions<T, P>): string[] {
  const seq = focusSequence(events, now, opts.profile);
  const n = seq.length;
  if (n < BACK_AND_FORTH_MIN) return [];
  let run = 2; // seq[n-1] and seq[n-2] always differ after collapsing repeats.
  for (let k = n - 3; k >= 0 && seq[k] === seq[k + 2]; k--) run++;
  if (run < BACK_AND_FORTH_MIN) return [];
  const a = panelTitleOf(opts.words, seq[n - 2]) ?? seq[n - 2];
  const b = panelTitleOf(opts.words, seq[n - 1]) ?? seq[n - 1];
  return [`Switched back and forth between ${a} and ${b}${run >= BACK_AND_FORTH_MANY ? " several times" : ""}`];
}

function isKeyboardish(e: Ev<string, string>): boolean {
  return e.type === "shortcut" || e.type === "command" || e.detail?.via === "keyboard" || e.detail?.via === "command";
}

/**
 * Pointer versus keyboard. Panel searches count as neither: people new to an
 * app type searches as much as experts do, so they say nothing about skill.
 */
function inputStyleObservation<T extends string, P extends string>(recent: readonly Ev<T, P>[], profile: SignalProfile<T>): string[] {
  const keyboard = recent.filter(isKeyboardish);
  const pointer = recent.filter((e) => !isKeyboardish(e) && profile.pointer.has(e.type));
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

function paceObservation<T extends string, P extends string>(recent: readonly Ev<T, P>[]): string[] {
  // Pointer rests are passive, so they are not part of the pace.
  const sample = recent.filter((e) => e.type !== "panel_dwell").slice(-PACE_SAMPLE);
  if (sample.length < 4) return [];
  const gaps: number[] = [];
  for (let i = 1; i < sample.length; i++) gaps.push(Math.max(0, sample[i].t - sample[i - 1].t));
  const m = median(gaps);
  if (m < PACE_QUICK_MS) return ["Working at a quick pace"];
  if (m <= PACE_SLOW_MS) return ["Working at a steady pace"];
  // Not "slowly": the model read that word literally against the expertise
  // level for new users and judged a careful, purposeful reader as lost.
  return ["Long pauses between actions, as when reading"];
}

function suggestionObservation<T extends string, P extends string>(events: readonly Ev<T, P>[], now: number): string[] {
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
 * Numbers are bucketed into words because the model reads words better.
 * Pass the events the snapshot reads (without the profile's cue-only types).
 */
export function deriveObservations<T extends string, P extends string>(events: readonly Ev<T, P>[], now: number, opts: ObservationOptions<T, P>): string[] {
  if (events.length === 0) return [];
  const recent = events.filter((e) => now - e.t <= RECENT_WINDOW_MS);
  const out: string[] = [];

  if (events.length <= 2) out.push(events.length === 1 ? "Only one action so far" : "Only two actions so far");
  out.push(...searchObservations(events, now));
  out.push(...howToSearchObservation(events, now));
  out.push(...reopenObservation(events, now, opts));
  out.push(...quickDismissObservation(events, now, opts.words));
  out.push(...backAndForthObservation(events, now, opts));
  const help = opts.helpPanel;
  if (help && events.some((e) => e.panel === help && (e.type === "panel_open" || e.type === "panel_focus") && now - e.t <= LONG_WINDOW_MS)) {
    out.push(`Opened the ${panelTitleOf(opts.words, help) ?? help} panel for help`);
  }
  out.push(...suggestionObservation(events, now));
  if (events.some((e) => e.type === "undo" && now - e.t <= LONG_WINDOW_MS)) out.push("Undid a layout change");
  out.push(...inputStyleObservation(recent, opts.profile));
  out.push(...paceObservation(recent));

  const last = events[events.length - 1];
  if (now - last.t > IDLE_MS) out.push("No activity for the last few minutes");
  return out;
}

// ---------------------------------------------------------------------------
// The snapshot
// ---------------------------------------------------------------------------

export interface SnapshotInput<P extends string = string> {
  now: number;
  focusedPanel: P | null;
  visiblePanels: readonly P[];
  /** The user's habits in words, added after the behavior observations. Absent: none. */
  habits?: readonly string[];
}

/** What the app's focused panel shows, in words, from the app's own view state. */
export interface FocusDetails {
  /** For example ["viewing invoice INV-1042 for Harbor Coffee Co.", "showing overdue invoices"]. */
  parts: string[];
  /** True when a part names the record on screen. Otherwise the last record opened in the panel is named instead. */
  hasSelection: boolean;
}

export interface SnapshotOptions<T extends string = string, P extends string = string, E extends Ev<T, P> = Ev<T, P>> extends ObservationOptions<T, P> {
  /** The sentence for one event: the app's describeEvent, which calls describeCoreEvent for the core types. Used when an event has no text. */
  describe: (event: E) => string;
  /** What the focused panel shows. Absent: only the last record opened there. */
  focusDetails?: (panel: P, events: readonly E[]) => FocusDetails;
}

/** "Invoices panel, viewing invoice INV-1042 ...", or null when no known panel is focused. */
function describeFocus<T extends string, P extends string, E extends Ev<T, P>>(input: SnapshotInput<P>, events: readonly E[], opts: SnapshotOptions<T, P, E>): string | null {
  const panel = input.focusedPanel;
  const title = panelTitleOf(opts.words, panel ?? undefined);
  if (!panel || !title) return null;
  const details = opts.focusDetails?.(panel, events) ?? { parts: [], hasSelection: false };
  const parts = [...details.parts];
  // The app may not record every selection in its view state, so fall back to the log.
  if (!details.hasSelection) {
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (!opts.profile.recordOpen.has(e.type) || e.panel !== panel) continue;
      if (input.now - e.t > RECENT_WINDOW_MS) break;
      const d = e.detail ?? {};
      const kind = d.itemKind ? opts.words.itemWords[d.itemKind] : "item";
      const what = d.label ?? d.itemId;
      if (what) parts.unshift(`last opened ${d.label && d.label.toLowerCase().startsWith(kind) ? "" : `${kind} `}${what}`);
      break;
    }
  }
  return [`${title} panel`, ...parts].join(", ");
}

/**
 * The words-only picture the model reads: recent activity (oldest first,
 * repeats collapsed, short pointer rests left out), the current focus, the
 * panels on screen, and code-derived observations, then the habits. Events
 * of the profile's cue-only types are left out of all of it.
 */
export function buildSnapshot<T extends string, P extends string, E extends Ev<T, P>>(allEvents: readonly E[], input: SnapshotInput<P>, opts: SnapshotOptions<T, P, E>): InteractionSnapshot {
  const events = allEvents.filter((e) => !opts.profile.cueOnly.has(e.type));
  const lines: string[] = [];
  let lastBase: string | null = null;
  let repeats = 0;
  for (const e of events) {
    if (e.type === "panel_dwell" && (e.detail?.durationMs ?? 0) < DWELL_NOISE_MS) continue;
    const text = e.text || opts.describe(e);
    if (text === lastBase) {
      repeats++;
      lines[lines.length - 1] = `${text} (${timesWord(repeats)} in a row)`;
    } else {
      lines.push(text);
      lastBase = text;
      repeats = 1;
    }
  }
  return {
    recent_activity: lines.slice(-SNAPSHOT_MAX_ACTIVITY),
    current_focus: describeFocus(input, events, opts),
    visible_panels: input.visiblePanels.map((p) => panelTitleOf(opts.words, p)).filter((t): t is string => t !== null),
    behavior_observations: [...deriveObservations(events, input.now, opts), ...(input.habits ?? [])],
  };
}
