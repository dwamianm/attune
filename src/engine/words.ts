/**
 * Small helpers that turn numbers and ids into plain words.
 *
 * Jev reads words better than numbers and reads literally, so the engine
 * buckets counts and timings into words before they reach a snapshot. The
 * change feed and command bar use the same phrasing, so people and the model
 * see the same sentences.
 */

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/** 3 -> "three". Above ten -> "more than ten". */
export function numberWord(n: number): string {
  const i = Math.max(0, Math.round(n));
  return NUMBER_WORDS[i] ?? "more than ten";
}

/** 1 -> "once", 2 -> "twice", 3 -> "three times". */
export function timesWord(n: number): string {
  if (n <= 1) return "once";
  if (n === 2) return "twice";
  return `${numberWord(n)} times`;
}

/** 4200 -> "4 seconds", 1000 -> "1 second", 75000 -> "a minute", 200000 -> "3 minutes". */
export function secondsPhrase(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s === 1) return "1 second";
  if (s < 60) return `${s} seconds`;
  const m = Math.round(s / 60);
  return m <= 1 ? "a minute" : `${m} minutes`;
}

/** "at_risk" -> "at risk", "this_week" -> "this week". */
export function humanizeId(value: string): string {
  return value.replace(/_/g, " ").trim();
}

/** ["A"] -> "A", ["A","B"] -> "A and B", ["A","B","C"] -> "A, B, and C". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

/** "Harbor Coffee Co." -> "Harbor Coffee Co.'s", "Meridian Hotels" -> "Meridian Hotels'". */
export function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

/** Probability or score rounded for evidence strings: 0.9137 -> "0.91". */
export function p2(n: number): string {
  return (Number.isFinite(n) ? n : 0).toFixed(2);
}

/** "Collecting payments" -> "collecting payments". */
export function lowerFirst(text: string): string {
  return text.length ? text[0].toLowerCase() + text.slice(1) : text;
}

const SEARCH_STOP_WORDS = new Set(["a", "an", "the", "and", "or", "for", "to", "of", "from", "with", "in", "on", "at", "my", "our", "me", "show", "find", "about"]);

/**
 * True when every word of the query (stop words dropped, a plural "s"
 * ignored) appears in one of the fields. Matching the whole phrase inside a
 * single field made "harbor invoice" find nothing, although Harbor's
 * "Re: Invoice INV-1042" was the obvious hit. Used by the panel searches and
 * by the policy to know which record a panel is showing.
 */
export function matchesQuery(fields: (string | null | undefined)[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const text = fields.map((f) => (f ?? "").toLowerCase());
  const words = q.split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !SEARCH_STOP_WORDS.has(w));
  if (words.length === 0) return text.some((f) => f.includes(q));
  return words.every((w) => {
    const stem = w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w;
    return text.some((f) => f.includes(stem));
  });
}
