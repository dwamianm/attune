/**
 * Small presentational pieces shared by the inspector tabs.
 *
 * No chart library: every bar is a div with a percentage width, so the
 * inspector stays light and reads the same in light and dark mode.
 */
import type { ReactNode } from "react";
import clsx from "clsx";
import { clamp01, formatPercent } from "./format.ts";

export type Tone = "neutral" | "accent" | "good" | "warn" | "bad" | "info";

const BADGE_TONES: Record<Tone, string> = {
  neutral: "bg-neutral-100 text-neutral-700 ring-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:ring-neutral-700",
  accent: "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:ring-violet-800",
  good: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-800",
  warn: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-800",
  bad: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-800",
  info: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-800",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={clsx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">{title}</h3>
        {aside != null && <div className="text-xs text-neutral-500 tabular-nums dark:text-neutral-400">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-8 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
      {children}
    </p>
  );
}

/** A labeled value in a compact grid of facts. */
export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg bg-neutral-50 px-3 py-2 dark:bg-neutral-900">
      <div className="text-[11px] text-neutral-500 dark:text-neutral-400">{label}</div>
      <div className="truncate text-sm font-medium text-neutral-900 tabular-nums dark:text-neutral-100">{value}</div>
      {hint != null && <div className="text-[11px] text-neutral-500 tabular-nums dark:text-neutral-400">{hint}</div>}
    </div>
  );
}

const FILL_TONES: Record<Tone, string> = {
  neutral: "bg-neutral-300 dark:bg-neutral-600",
  accent: "bg-violet-500 dark:bg-violet-400",
  good: "bg-emerald-500 dark:bg-emerald-400",
  warn: "bg-amber-500 dark:bg-amber-400",
  bad: "bg-rose-500 dark:bg-rose-400",
  info: "bg-sky-500 dark:bg-sky-400",
};

/** A single horizontal bar, `value` in 0..1. */
export function Bar({ value, tone = "neutral", className }: { value: number; tone?: Tone; className?: string }) {
  return (
    <div className={clsx("h-2 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800", className)}>
      <div
        className={clsx("h-full rounded-full transition-[width] duration-300 ease-out", FILL_TONES[tone])}
        style={{ width: `${clamp01(value) * 100}%` }}
      />
    </div>
  );
}

export interface ProbRow {
  key: string;
  label: string;
  p: number;
}

/**
 * Probability bars for a Choice (or the levels of a Score).
 * The chosen row is highlighted; the rest stay neutral so the eye lands on it.
 */
export function ProbBars({ rows, chosen, limit }: { rows: ProbRow[]; chosen?: string; limit?: number }) {
  const shown = limit ? rows.slice(0, limit) : rows;
  const hidden = rows.length - shown.length;
  return (
    <div className="space-y-1.5">
      {shown.map((r) => {
        const isChosen = r.key === chosen;
        return (
          <div key={r.key} className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_3rem] items-center gap-2 text-xs">
            <span
              title={r.label}
              className={clsx(
                "truncate",
                isChosen ? "font-semibold text-neutral-900 dark:text-neutral-50" : "text-neutral-600 dark:text-neutral-400",
              )}
            >
              {r.label}
            </span>
            <Bar value={r.p} tone={isChosen ? "accent" : "neutral"} />
            <span
              className={clsx(
                "text-right tabular-nums",
                isChosen ? "font-semibold text-neutral-900 dark:text-neutral-50" : "text-neutral-500 dark:text-neutral-400",
              )}
            >
              {formatPercent(r.p)}
            </span>
          </div>
        );
      })}
      {hidden > 0 && (
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          {hidden} more {hidden === 1 ? "option" : "options"} not shown
        </p>
      )}
    </div>
  );
}

/** A labeled on/off switch. `label` is the accessible name. */
export function Switch({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  description?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-lg px-1 py-1 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"
    >
      <span
        aria-hidden
        className={clsx(
          "relative mt-0.5 inline-flex h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? "bg-violet-600 dark:bg-violet-500" : "bg-neutral-300 dark:bg-neutral-700",
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
            checked && "translate-x-4",
          )}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-neutral-900 dark:text-neutral-100">{label}</span>
        {description && <span className="block text-xs text-neutral-500 dark:text-neutral-400">{description}</span>}
      </span>
    </button>
  );
}

export function Slider({
  id,
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (next: number) => void;
  format: (v: number) => string;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <label htmlFor={id} className="text-neutral-800 dark:text-neutral-200">
          {label}
        </label>
        <output htmlFor={id} className="text-xs text-neutral-500 tabular-nums dark:text-neutral-400">
          {format(value)}
        </output>
      </div>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="w-full accent-violet-600 dark:accent-violet-400"
      />
    </div>
  );
}

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500";

export function Button({
  children,
  onClick,
  disabled,
  primary,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={clsx(
        BUTTON_BASE,
        primary
          ? "bg-violet-600 text-white hover:bg-violet-700 dark:bg-violet-500 dark:hover:bg-violet-400 dark:text-neutral-950"
          : "bg-neutral-100 text-neutral-800 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-100 dark:hover:bg-neutral-700",
      )}
    >
      {children}
    </button>
  );
}
