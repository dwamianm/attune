/**
 * Formatting helpers for money, dates, and the plain-English labels that
 * panels attach to signals.
 *
 * Due dates in shared/fixtures.ts are "YYYY-MM-DD" strings made from local
 * midnight via toISOString(), so day differences are computed against the
 * same derivation of "today". That keeps "14 days overdue" exact in any
 * time zone. Jev cannot do date math, so these phrases are computed here.
 */
import type { CalendarEvent, Invoice, Message, Project, Task } from "../../shared/fixtures.ts";

const DAY = 24 * 60 * 60 * 1000;

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function formatMoney(n: number): string {
  return money.format(n);
}

/** $14.6k, $1.2M, $900. */
export function formatMoneyShort(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${trimZero((n / 1_000_000).toFixed(1))}M`;
  if (Math.abs(n) >= 1_000) return `$${trimZero((n / 1_000).toFixed(1))}k`;
  return formatMoney(n);
}

function trimZero(s: string): string {
  return s.replace(/\.0$/, "");
}

function todayIso(now = Date.now()): string {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.toISOString().slice(0, 10);
}

function isoToUtcDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

/** Whole days from today to a YYYY-MM-DD date. Negative means in the past. */
export function daysUntil(isoDate: string, now = Date.now()): number {
  return Math.round((isoToUtcDay(isoDate) - isoToUtcDay(todayIso(now))) / DAY);
}

/** "Sep 29" for a YYYY-MM-DD date, read in UTC to match how fixtures build it. */
export function formatDate(isoDate: string, withYear = false): string {
  return new Date(isoToUtcDay(isoDate)).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: withYear ? "numeric" : undefined,
    timeZone: "UTC",
  });
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Row text: "14 days overdue", "due in 20 days", "due today", "paid". */
export function invoiceDueText(inv: Invoice, now = Date.now()): string {
  if (inv.status === "paid") return "paid";
  if (inv.status === "draft") return "not sent yet";
  const d = daysUntil(inv.due, now);
  if (d < 0) return `${plural(-d, "day")} overdue`;
  if (d === 0) return "due today";
  return `due in ${plural(d, "day")}`;
}

/** Signal label: "INV-1042 · Harbor Coffee Co. · overdue 14 days · $4,200". */
export function invoiceLabel(inv: Invoice, now = Date.now()): string {
  const d = daysUntil(inv.due, now);
  let state: string;
  if (inv.status === "paid") state = "paid";
  else if (inv.status === "draft") state = "draft, not sent";
  else if (d < 0) state = `overdue ${plural(-d, "day")}`;
  else if (d === 0) state = "due today";
  else state = `due in ${plural(d, "day")}`;
  return `${inv.id} · ${inv.client} · ${state} · ${formatMoney(inv.amount)}`;
}

export const INVOICE_STATUS_LABEL: Record<Invoice["status"], string> = {
  draft: "Draft",
  sent: "Sent",
  overdue: "Overdue",
  paid: "Paid",
};

export function messageLabel(m: Message): string {
  return m.client ? `"${m.subject}" from ${m.from} at ${m.client}` : `"${m.subject}" from ${m.from}`;
}

/** "8m ago", "3h ago", "Yesterday", "3 days ago". */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  const diff = now - t;
  if (diff < 0) return `Today, ${clockTime(iso)}`;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const days = calendarDaysAgo(iso, now);
  if (days === 0) return `${Math.floor(mins / 60)}h ago`;
  if (days === 1) return "Yesterday";
  return `${days} days ago`;
}

function calendarDaysAgo(iso: string, now: number): number {
  const a = new Date(iso);
  a.setHours(0, 0, 0, 0);
  const b = new Date(now);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / DAY);
}

/** 24-hour clock without a leading zero: "9:30", "15:30". */
export function clockTime(iso: string): string {
  const d = new Date(iso);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "today", "tomorrow", "Thursday", or "Oct 3" for a timestamp. */
export function dayWord(iso: string, now = Date.now()): string {
  const days = -calendarDaysAgo(iso, now);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  if (days === -1) return "yesterday";
  const d = new Date(iso);
  if (days > 1 && days < 7) return d.toLocaleDateString("en-US", { weekday: "long" });
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Local calendar-day offset of a timestamp from today (0 = today). */
export function dayOffset(iso: string, now = Date.now()): number {
  return -calendarDaysAgo(iso, now);
}

/** Signal label: "Harbor rebrand review, 11:00 today". */
export function eventLabel(e: CalendarEvent, now = Date.now()): string {
  const day = dayWord(e.start, now);
  const joiner = day === "today" || day === "tomorrow" || day === "yesterday" ? " " : " on ";
  return `${e.title}, ${clockTime(e.start)}${joiner}${day}`;
}

/** "due today", "due tomorrow", "due in 3 days", "2 days late", "done". */
export function taskDueText(t: Task, now = Date.now()): string {
  if (t.done) return "done";
  const d = daysUntil(t.due, now);
  if (d < 0) return `${plural(-d, "day")} late`;
  if (d === 0) return "due today";
  if (d === 1) return "due tomorrow";
  return `due in ${plural(d, "day")}`;
}

export const PROJECT_STATUS_LABEL: Record<Project["status"], string> = {
  on_track: "On track",
  at_risk: "At risk",
  blocked: "Blocked",
  done: "Done",
};

export function projectDeadlineText(p: Project, now = Date.now()): string {
  const d = daysUntil(p.deadline, now);
  if (d < 0) return `${plural(-d, "day")} past deadline`;
  if (d === 0) return "deadline today";
  return `deadline in ${plural(d, "day")}`;
}

export function projectLabel(p: Project): string {
  return `${p.name} for ${p.client}, ${PROJECT_STATUS_LABEL[p.status].toLowerCase()}, ${Math.round(p.progress * 100)}% done`;
}

export function initials(name: string): string {
  return name
    .replace(/^Dr\.\s+/, "")
    .split(/\s+/)
    .map((w) => w[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

export function percent(p: number): string {
  return `${Math.round(p * 100)}%`;
}

// Search matching lives in the engine, so suggestions and panels agree on what is shown.
export { matchesQuery } from "@attune/core";
