/**
 * Number and label formatting for the inspector.
 *
 * Kept pure (no React, no store) so the odd cases, like a Jev call that costs
 * a hundred-thousandth of a dollar, can be unit tested.
 */
import { ACTIONS, GOALS, LAYOUT_MODE_DEFS, PANELS } from "../../shared/catalog.ts";
import type { ActionId, GoalId, LayoutMode, PanelId } from "../../shared/catalog.ts";

/** TypeSafe price for System One input tokens. Output tokens are free. */
export const USD_PER_MILLION_INPUT_TOKENS = 0.042;

export function costUsd(inputTokens: number): number {
  return (inputTokens * USD_PER_MILLION_INPUT_TOKENS) / 1_000_000;
}

/**
 * Dollars with enough decimals to show two significant digits, so a
 * $0.000126 call does not collapse to "$0.00".
 */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd >= 0.1) return `$${usd.toFixed(2)}`;
  if (usd < 1e-12) return "under $0.000000000001";
  const decimals = Math.min(12, -Math.floor(Math.log10(usd)) + 1);
  // toFixed can leave a trailing zero ("0.000050"); drop it.
  const trimmed = usd.toFixed(decimals).replace(/(\.\d*?[1-9])0+$/, "$1");
  return `$${trimmed}`;
}

/** 0.914 -> "91%", 0.004 -> "<1%", 0.996 -> ">99%". */
export function formatPercent(p: number): string {
  if (!Number.isFinite(p)) return "n/a";
  if (p <= 0) return "0%";
  if (p >= 1) return "100%";
  if (p < 0.01) return "<1%";
  if (p > 0.99) return ">99%";
  return `${Math.round(p * 100)}%`;
}

export function formatFixed(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits) : "n/a";
}

export function formatInt(n: number): string {
  return Number.isFinite(n) ? Math.round(n).toLocaleString("en-US") : "n/a";
}

export function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return "n/a";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

/** "just now", "12s ago", "3m ago", "2h ago". */
export function formatAgo(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 2) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Probability entries sorted high to low. Missing or bad values count as 0. */
export function sortedEntries<K extends string>(probs: Partial<Record<K, number>>): [K, number][] {
  return (Object.entries(probs) as [K, number | undefined][])
    .map(([k, p]): [K, number] => [k, typeof p === "number" && Number.isFinite(p) ? p : 0])
    .sort((a, b) => b[1] - a[1]);
}

// Labels ---------------------------------------------------------------------
// Judgment keys arrive from the server as plain strings, so every lookup
// falls back to the raw id instead of assuming the catalog has it.

export function goalLabel(id: string): string {
  return GOALS[id as GoalId]?.label ?? id;
}

export function panelLabel(id: string): string {
  if (id === "unclear") return "Unclear";
  return PANELS[id as PanelId]?.title ?? id;
}

export function modeLabel(id: string): string {
  return LAYOUT_MODE_DEFS[id as LayoutMode]?.label ?? id;
}

/** Action labels with the {client} and {invoice} slots filled generically. */
export function actionLabel(id: string): string {
  const def = ACTIONS[id as ActionId];
  if (!def) return id;
  if (!def.label) return "No clear next step";
  return def.label.replace("{client}'s", "a client's").replace("{client}", "a client").replace("{invoice}", "an invoice");
}

export function clientLabel(name: string): string {
  if (name === "none") return "No client";
  if (name === "not_mentioned") return "Not mentioned";
  return name;
}

/** "not_mentioned" -> "Not mentioned", "this_week" -> "This week". */
export function humanize(id: string): string {
  const s = id.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}
