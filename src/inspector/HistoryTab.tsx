/**
 * "History" tab: every adaptation round, newest first, including stale
 * answers the engine dropped. Opening a round shows its judgments with the
 * same views as the Now tab.
 */
import { useState } from "react";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useEngine } from "../engine/store.ts";
import type { AdaptationRecord } from "../engine/contract.ts";
import { formatAgo, formatMs, formatPercent, goalLabel, humanize } from "./format.ts";
import { DecisionList } from "./DecisionsTab.tsx";
import { JudgmentsView } from "./judgments.tsx";
import { ResponseMeta, SourceBadge } from "./ResponseMeta.tsx";
import { Badge, Empty, Section } from "./ui.tsx";
import { useNow } from "./useNow.ts";

function recordKey(r: AdaptationRecord): string {
  return `${r.version}-${r.at}`;
}

function RecordRow({ record, now, onOpen }: { record: AdaptationRecord; now: number; onOpen: () => void }) {
  const goal = record.response.judgments.goal;
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-neutral-50 focus-visible:outline-2 focus-visible:outline-violet-500 dark:hover:bg-neutral-900"
      >
        <span className="w-10 shrink-0 text-xs font-medium text-neutral-500 tabular-nums dark:text-neutral-400">v{record.version}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-neutral-900 dark:text-neutral-100">
            {goalLabel(goal.choice)} <span className="text-neutral-500 tabular-nums dark:text-neutral-400">{formatPercent(goal.probabilities[goal.choice] ?? 0)}</span>
          </span>
          <span className="block truncate text-[11px] text-neutral-500 tabular-nums dark:text-neutral-400">
            {humanize(record.trigger)} · {formatAgo(record.at, now)} · {formatMs(record.response.meta.latencyMs)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {record.stale && <Badge tone="bad" title="Arrived too late and was not applied">Stale</Badge>}
          <SourceBadge source={record.response.source} />
        </span>
        <ChevronRight className="h-4 w-4 shrink-0 text-neutral-400" aria-hidden />
      </button>
    </li>
  );
}

function RecordDetail({ record, now, onBack }: { record: AdaptationRecord; now: number; onBack: () => void }) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs text-neutral-600 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          All rounds
        </button>
        <p className="text-sm text-neutral-900 dark:text-neutral-100">
          Round v{record.version}, triggered by {humanize(record.trigger).toLowerCase()}, {formatAgo(record.at, now)}.
        </p>
        {record.stale && (
          <p className="text-xs text-rose-700 dark:text-rose-300">This answer arrived too late, so the layout ignored it.</p>
        )}
      </div>
      <ResponseMeta response={record.response} />
      <Section title="Decisions from this round">
        <DecisionList decisions={record.decisions} />
      </Section>
      <JudgmentsView judgments={record.response.judgments} />
    </div>
  );
}

export function HistoryTab() {
  const history = useEngine((s) => s.history);
  const [selected, setSelected] = useState<string | null>(null);
  const now = useNow();

  if (history.length === 0) return <Empty>No rounds yet. Use the app or replay a scenario.</Empty>;

  const record = selected ? history.find((r) => recordKey(r) === selected) : undefined;
  if (record) return <RecordDetail record={record} now={now} onBack={() => setSelected(null)} />;

  const newestFirst = [...history].sort((a, b) => b.at - a.at || b.version - a.version);
  return (
    <div className="space-y-2">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {history.length} {history.length === 1 ? "round" : "rounds"}, newest first. Select one to see its answers.
      </p>
      <ul className="-mx-3 divide-y divide-neutral-100 dark:divide-neutral-900">
        {newestFirst.map((r) => (
          <RecordRow key={recordKey(r)} record={r} now={now} onOpen={() => setSelected(recordKey(r))} />
        ))}
      </ul>
    </div>
  );
}
