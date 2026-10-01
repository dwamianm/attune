/**
 * Views for one set of Jev judgments (or the heuristic stand-in).
 *
 * The Now tab and the History tab both render these, so an old round reads
 * exactly like the current one.
 */
import clsx from "clsx";
import { ACTION_IDS, GOAL_IDS, LAYOUT_MODES } from "../../shared/catalog.ts";
import type { ChoiceJudgment, CommandJudgments, Judgments, ScoreJudgment } from "../../shared/types.ts";
import {
  actionLabel,
  clamp01,
  clientLabel,
  formatFixed,
  formatPercent,
  goalLabel,
  humanize,
  modeLabel,
  panelLabel,
  sortedEntries,
} from "./format.ts";
import { Bar, ProbBars, Section, type ProbRow } from "./ui.tsx";

const CONFIDENCE_TIP = "How concentrated the answer is. It does not say whether the answer is right.";

function Confidence({ value }: { value: number }) {
  return <span title={CONFIDENCE_TIP}>confidence {formatPercent(value)}</span>;
}

/**
 * Rows for a Choice. `order` lists every known option so options the server
 * left out still show as 0%; unknown keys from the server are kept too.
 */
function choiceRows(j: ChoiceJudgment, label: (key: string) => string, order: readonly string[] = []): ProbRow[] {
  const probs: Record<string, number> = {};
  for (const key of order) probs[key] = 0;
  Object.assign(probs, j.probabilities);
  return sortedEntries(probs).map(([key, p]) => ({ key, label: label(key), p }));
}

function ChoiceSection({
  title,
  judgment,
  label,
  order,
  limit,
}: {
  title: string;
  judgment: ChoiceJudgment;
  label: (key: string) => string;
  order?: readonly string[];
  limit?: number;
}) {
  return (
    <Section title={title} aside={<Confidence value={judgment.confidence} />}>
      <ProbBars rows={choiceRows(judgment, label, order)} chosen={judgment.choice} limit={limit} />
    </Section>
  );
}

function RelevanceSection({ relevance }: { relevance: Judgments["relevance"] }) {
  const rows = (Object.entries(relevance) as [string, ScoreJudgment | undefined][])
    .filter((e): e is [string, ScoreJudgment] => e[1] != null)
    .sort((a, b) => b[1].score / (b[1].max || 1) - a[1].score / (a[1].max || 1));
  return (
    <Section title="Panel relevance" aside="ranked by score">
      <div className="space-y-1.5">
        {rows.map(([id, s], i) => (
          <div key={id} className="grid grid-cols-[minmax(0,6.5rem)_1fr_3.25rem_2.5rem] items-center gap-2 text-xs">
            <span
              className={clsx(
                "truncate",
                i < 3 ? "font-semibold text-neutral-900 dark:text-neutral-50" : "text-neutral-600 dark:text-neutral-400",
              )}
            >
              {panelLabel(id)}
            </span>
            <Bar value={s.max > 0 ? s.score / s.max : 0} tone={i < 3 ? "accent" : "neutral"} />
            <span className="text-right text-neutral-700 tabular-nums dark:text-neutral-300">
              {formatFixed(s.score, 1)} / {s.max}
            </span>
            <span className="text-right text-neutral-500 tabular-nums dark:text-neutral-400" title={CONFIDENCE_TIP}>
              {formatPercent(s.confidence)}
            </span>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-neutral-500 dark:text-neutral-400">Right column is confidence. Top three are in bold.</p>
    </Section>
  );
}

function strugglingReading(p: number): string {
  if (p >= 0.65) return "Leans yes";
  if (p <= 0.35) return "Leans no";
  return "Unsure";
}

/** A Noul is a position on a no-to-yes line, so it is drawn as a marker, not a fill. */
function StrugglingSection({ value }: { value: number }) {
  const v = clamp01(value);
  const tone = v >= 0.65 ? "bg-rose-500 dark:bg-rose-400" : v <= 0.35 ? "bg-emerald-500 dark:bg-emerald-400" : "bg-amber-500 dark:bg-amber-400";
  return (
    <Section title="Struggling" aside={`${formatFixed(v, 2)} · ${strugglingReading(v)}`}>
      <div
        className="relative h-2 rounded-full bg-linear-to-r from-emerald-100 via-neutral-100 to-rose-100 dark:from-emerald-950 dark:via-neutral-800 dark:to-rose-950"
        role="meter"
        aria-label="Struggling"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={Number(v.toFixed(2))}
      >
        <div className="absolute top-[-3px] left-1/2 h-[14px] w-px bg-neutral-400 dark:bg-neutral-500" aria-hidden />
        <div
          className={clsx(
            "absolute top-1/2 h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-white transition-[left] duration-300 dark:ring-neutral-950",
            tone,
          )}
          style={{ left: `${v * 100}%` }}
          aria-hidden
        />
      </div>
      <div className="flex justify-between text-[11px] text-neutral-500 dark:text-neutral-400">
        <span>0 fine</span>
        <span>0.5 unsure</span>
        <span>1 struggling</span>
      </div>
      <p className="text-[11px] text-neutral-500 dark:text-neutral-400">About 0.5 means Jev is unsure, not that the user is half lost.</p>
    </Section>
  );
}

const EXPERTISE_LEVELS = ["New", "Comfortable", "Expert"];

function ExpertiseSection({ expertise }: { expertise: ScoreJudgment }) {
  const rows: ProbRow[] = expertise.probabilities.map((p, i) => ({
    key: String(i),
    label: EXPERTISE_LEVELS[i] ?? `Level ${i}`,
    p,
  }));
  const top = rows.reduce<ProbRow | null>((best, r) => (best == null || r.p > best.p ? r : best), null);
  return (
    <Section
      title="Expertise"
      aside={
        <>
          {formatFixed(expertise.score, 2)} / {expertise.max} · <Confidence value={expertise.confidence} />
        </>
      }
    >
      <ProbBars rows={rows} chosen={top?.key} />
    </Section>
  );
}

function CommandSection({ command }: { command: CommandJudgments }) {
  return (
    <div className="space-y-4 rounded-xl border border-violet-200 bg-violet-50/40 p-3 dark:border-violet-900 dark:bg-violet-950/30">
      <p className="text-sm font-medium text-violet-800 dark:text-violet-300">Command bar judgments</p>
      <ChoiceSection title="Panel" judgment={command.panel} label={panelLabel} limit={4} />
      <ChoiceSection title="Action" judgment={command.action} label={actionLabel} limit={4} />
      <ChoiceSection title="Invoice status" judgment={command.invoiceStatus} label={humanize} limit={3} />
      <ChoiceSection title="Client" judgment={command.client} label={clientLabel} limit={3} />
      <ChoiceSection title="Timeframe" judgment={command.timeframe} label={humanize} limit={3} />
    </div>
  );
}

export function JudgmentsView({ judgments }: { judgments: Judgments }) {
  const j = judgments;
  return (
    <div className="space-y-6">
      {j.command && <CommandSection command={j.command} />}
      <ChoiceSection title="Goal" judgment={j.goal} label={goalLabel} order={GOAL_IDS} />
      <RelevanceSection relevance={j.relevance} />
      <ChoiceSection title="Layout mode" judgment={j.layout} label={modeLabel} order={LAYOUT_MODES} />
      <StrugglingSection value={j.struggling} />
      <ExpertiseSection expertise={j.expertise} />
      <ChoiceSection title="Next step" judgment={j.nextAction} label={actionLabel} order={ACTION_IDS} />
      <ChoiceSection title="Target client" judgment={j.targetClient} label={clientLabel} limit={5} />
      {/* Asked only when the request carried record candidates (docs/predictive-flow.md). */}
      {j.nextRecord && <ChoiceSection title="Next record" judgment={j.nextRecord} label={(k) => (k === "none" ? "None" : k)} limit={5} />}
      {typeof j.listWork === "number" && (
        <Section title="Working through a list" aside={`${formatFixed(clamp01(j.listWork), 2)} · ${strugglingReading(clamp01(j.listWork))}`}>
          <Bar value={clamp01(j.listWork)} tone="accent" />
        </Section>
      )}
      {/* Focus aid 2: asked only with a working goal, and the next task only with task candidates (docs/focus-aids.md). */}
      {typeof j.goalDone === "number" && (
        <Section title="Working goal done" aside={`${formatFixed(clamp01(j.goalDone), 2)} · ${strugglingReading(clamp01(j.goalDone))}`}>
          <Bar value={clamp01(j.goalDone)} tone="accent" />
        </Section>
      )}
      {j.nextTask && <ChoiceSection title="Next task" judgment={j.nextTask} label={(k) => (k === "none" ? "None" : humanize(k))} limit={6} />}
      {/* "Arrange linked panels by next step": asked only on the first round after a click on a record (docs/anchored-relayout.md). */}
      {j.linkNext && <ChoiceSection title="Next linked record" judgment={j.linkNext} label={(k) => (k === "none" ? "None" : k)} limit={5} />}
      {j.linkAction && <ChoiceSection title="What the clicked record asks" judgment={j.linkAction} label={actionLabel} limit={4} />}
    </div>
  );
}
