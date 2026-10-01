/**
 * "Decisions" tab: what the code policy did with the judgments.
 *
 * Jev only supplies judgments; this tab shows the plan that code built from
 * them, including how each panel's priority was blended, so a reader can tell
 * a model judgment apart from a policy choice.
 */
import { Maximize2, Pin } from "lucide-react";
import { useEngine } from "../engine/store.ts";
import type { Decision, PanelPlacement, PanelSize, Suggestion } from "../../shared/types.ts";
import { formatFixed, formatPercent, humanize, modeLabel, panelLabel } from "./format.ts";
import { Badge, Section, Stat, type Tone } from "./ui.tsx";

const SIZE_LABELS: Record<PanelSize, string> = {
  hero: "Hero 2x2",
  large: "Large 2x1",
  standard: "Standard",
  compact: "Compact",
};

type Part = keyof NonNullable<PanelPlacement["breakdown"]>;

const PARTS: { key: Part; label: string; color: string }[] = [
  { key: "relevance", label: "Relevance", color: "bg-violet-500 dark:bg-violet-400" },
  { key: "usage", label: "Usage", color: "bg-sky-500 dark:bg-sky-400" },
  { key: "goal", label: "Goal", color: "bg-emerald-500 dark:bg-emerald-400" },
  { key: "pin", label: "Pin", color: "bg-amber-500 dark:bg-amber-400" },
  // Focus aid 3: present only in a round that used a habit.
  { key: "habit", label: "Habit", color: "bg-rose-400 dark:bg-rose-300" },
];

/** The parts a breakdown has: the habit part only when the round used a habit. */
function partsOf(b: NonNullable<PanelPlacement["breakdown"]>): typeof PARTS {
  return PARTS.filter((part) => b[part.key] !== undefined);
}

const CHANGE_TONES: Record<NonNullable<PanelPlacement["change"]>, Tone> = {
  promoted: "good",
  demoted: "neutral",
  added: "info",
};

const DECISION_TONES: Record<Decision["kind"], Tone> = {
  mode: "accent",
  promote: "good",
  demote: "neutral",
  add: "info",
  dock: "neutral",
  suggest: "accent",
  help: "warn",
  hold: "neutral",
  command: "accent",
  density: "info",
};

function breakdownTotal(p: PanelPlacement): number {
  const b = p.breakdown;
  return b ? partsOf(b).reduce((sum, part) => sum + Math.max(0, b[part.key] ?? 0), 0) : 0;
}

function Legend({ habit }: { habit: boolean }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-neutral-500 dark:text-neutral-400">
      {PARTS.filter((part) => habit || part.key !== "habit").map((part) => (
        <span key={part.key} className="inline-flex items-center gap-1">
          <span className={`h-2 w-2 rounded-sm ${part.color}`} aria-hidden />
          {part.label}
        </span>
      ))}
    </div>
  );
}

/** Stacked bar of the weighted parts. `scale` keeps bars comparable across rows. */
function BreakdownBar({ placement, scale }: { placement: PanelPlacement; scale: number }) {
  const b = placement.breakdown;
  if (!b) return <p className="text-[11px] text-neutral-500 dark:text-neutral-400">No breakdown for this panel.</p>;
  return (
    <div className="space-y-1">
      <div className="flex h-2 w-full overflow-hidden rounded-full bg-neutral-100 dark:bg-neutral-800">
        {partsOf(b).map((part) => {
          const v = Math.max(0, b[part.key] ?? 0);
          if (v === 0) return null;
          return (
            <div
              key={part.key}
              className={`h-full transition-[width] duration-300 ${part.color}`}
              style={{ width: `${(v / scale) * 100}%` }}
              title={`${part.label} ${formatFixed(v, 2)}`}
            />
          );
        })}
      </div>
      <p className="text-[11px] text-neutral-500 tabular-nums dark:text-neutral-400">
        {partsOf(b)
          .map((part) => `${part.label} ${formatFixed(b[part.key] ?? 0, 2)}`)
          .join("  ·  ")}
      </p>
    </div>
  );
}

function PlacementRow({ placement, index, scale }: { placement: PanelPlacement; index: number; scale: number }) {
  return (
    <li className="space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-5 text-xs text-neutral-400 tabular-nums dark:text-neutral-500">{index + 1}</span>
        <span className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{panelLabel(placement.id)}</span>
        <Badge>{SIZE_LABELS[placement.size] ?? placement.size}</Badge>
        {placement.pinned && (
          <Badge tone="warn">
            <Pin className="h-3 w-3" aria-hidden />
            Pinned
          </Badge>
        )}
        {placement.bigger && (
          <Badge tone="accent">
            <Maximize2 className="h-3 w-3" aria-hidden />
            Made bigger
          </Badge>
        )}
        {placement.change && <Badge tone={CHANGE_TONES[placement.change]}>{humanize(placement.change)}</Badge>}
        <span className="ml-auto text-xs text-neutral-600 tabular-nums dark:text-neutral-300" title="Final priority">
          {formatFixed(placement.priority, 2)}
        </span>
      </div>
      <BreakdownBar placement={placement} scale={scale} />
      {placement.reason && <p className="text-xs text-neutral-600 dark:text-neutral-400">{placement.reason}</p>}
    </li>
  );
}

function SuggestionRow({ s }: { s: Suggestion }) {
  return (
    <li className="space-y-1 rounded-lg bg-neutral-50 px-3 py-2 dark:bg-neutral-900">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-neutral-900 dark:text-neutral-100">{s.label}</span>
        <Badge tone={s.prominence === "primary" ? "accent" : "neutral"}>{humanize(s.prominence)}</Badge>
        <span className="ml-auto text-xs text-neutral-500 tabular-nums dark:text-neutral-400">
          confidence {formatPercent(s.confidence)}
        </span>
      </div>
      {s.reason && <p className="text-xs text-neutral-600 dark:text-neutral-400">{s.reason}</p>}
    </li>
  );
}

export function DecisionList({ decisions }: { decisions: Decision[] }) {
  if (decisions.length === 0) {
    return <p className="text-xs text-neutral-500 dark:text-neutral-400">Nothing changed in this round.</p>;
  }
  return (
    <ul className="space-y-2">
      {decisions.map((d, i) => (
        <li key={i} className="space-y-1">
          <div className="flex items-start gap-2">
            <Badge tone={DECISION_TONES[d.kind] ?? "neutral"}>{humanize(d.kind)}</Badge>
            <span className="text-sm text-neutral-800 dark:text-neutral-200">{d.text}</span>
          </div>
          {d.evidence && (
            <p className="ml-1 break-words font-mono text-[11px] text-neutral-500 dark:text-neutral-400">{d.evidence}</p>
          )}
        </li>
      ))}
    </ul>
  );
}

export function DecisionsTab() {
  const plan = useEngine((s) => s.plan);
  const scale = Math.max(1, ...plan.placements.map(breakdownTotal));
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Mode" value={modeLabel(plan.mode)} />
        <Stat label="Density" value={humanize(plan.density)} />
        <Stat label="Help" value={humanize(plan.help)} />
        <Stat label="Based on" value={plan.basedOnVersion === 0 ? "Default" : `v${plan.basedOnVersion}`} />
      </div>

      <Section title="Panels on the canvas" aside={`${plan.placements.length} in order`}>
        <Legend habit={plan.placements.some((p) => p.breakdown?.habit !== undefined)} />
        <ol className="space-y-2">
          {plan.placements.map((p, i) => (
            <PlacementRow key={p.id} placement={p} index={i} scale={scale} />
          ))}
        </ol>
        {plan.docked.length > 0 && (
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            In the dock: {plan.docked.map(panelLabel).join(", ")}
          </p>
        )}
      </Section>

      {plan.suggestions.length > 0 && (
        <Section title="Suggested next steps">
          <ul className="space-y-2">
            {plan.suggestions.map((s, i) => (
              <SuggestionRow key={`${s.actionId}-${i}`} s={s} />
            ))}
          </ul>
        </Section>
      )}

      <Section title="Decisions">
        <DecisionList decisions={plan.decisions} />
      </Section>
    </div>
  );
}
