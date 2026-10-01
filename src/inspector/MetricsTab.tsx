/**
 * "Metrics" tab: is the workspace keeping the user focused? Per session
 * (docs/predictive-flow.md): how often the next record and the next action
 * were predicted, how much navigating the user still did by hand, how often
 * the Up next card was taken, how often a layout change was undone, how
 * often the layout changed at all, how many panels are quiet (focus aid
 * 1) and how often the user reopened one, how many tasks were marked
 * done and next tasks started (focus aid 2), and how many meetings were
 * offered and prepared for, and records opened from a prep view (focus aid
 * 4). The counting is in src/engine/metrics.ts.
 */
import { useShallow } from "zustand/react/shallow";
import { fadeQuietOn } from "../engine/focusAids.ts";
import { summarizeMetrics } from "../engine/metrics.ts";
import { useEngine } from "../engine/store.ts";
import { Badge, Empty, Section } from "./ui.tsx";
import { useNow } from "./useNow.ts";

export function MetricsTab() {
  const { metrics, queueMode, upNext, contexts, quietNow, taskDone, prep } = useEngine(
    useShallow((s) => ({
      metrics: s.metrics,
      queueMode: s.queueMode,
      upNext: s.upNext,
      contexts: s.contexts.length,
      // Focus aid 1: the quiet panels on the canvas now, or null with that aid off.
      quietNow: fadeQuietOn(s.settings) ? s.plan.placements.filter((p) => p.quiet).length : null,
      // Focus aid 2: the Done card on screen, if any.
      taskDone: s.taskDone,
      // Focus aid 4: the prep chip or card on screen, if any.
      prep: s.prep,
    })),
  );
  const now = useNow();

  if (metrics.startedAt === null) return <Empty>No signals yet. Work in the app, then come back to see how well it kept up.</Empty>;

  const lines = summarizeMetrics(metrics, now, { quietNow });
  return (
    <div className="space-y-5">
      <Section title="Right now">
        <div className="flex flex-wrap gap-1.5">
          <Badge tone={queueMode ? "accent" : "neutral"}>{queueMode ? "Working through a list" : "Not working through a list"}</Badge>
          <Badge tone={upNext ? "info" : "neutral"}>{upNext ? `Up next: ${upNext.why}` : "No Up next card"}</Badge>
          {taskDone ? <Badge tone="good">{`Done card: ${taskDone.title}${taskDone.next ? `, next ${taskDone.next.text}` : ""}`}</Badge> : null}
          {prep ? <Badge tone="info">{`${prep.stage === "ready" ? "Prepared" : "Prep chip"}: ${prep.title}${prep.ranking ? ` (${prep.ranking.source === "jev" ? "Jev" : "heuristic"} ranking)` : ""}`}</Badge> : null}
          <Badge>
            {contexts} saved {contexts === 1 ? "context" : "contexts"}
          </Badge>
        </div>
      </Section>
      <Section title="This session">
        <dl className="divide-y divide-neutral-100 dark:divide-neutral-900">
          {lines.map((l) => (
            <div key={l.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-0.5 py-2">
              <dt className="text-xs font-medium text-neutral-800 dark:text-neutral-200">{l.label}</dt>
              <dd className="text-right text-sm font-semibold text-neutral-900 tabular-nums dark:text-neutral-50">{l.value}</dd>
              <dd className="col-span-2 text-[11px] leading-snug text-neutral-500 dark:text-neutral-400">{l.explain}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}
