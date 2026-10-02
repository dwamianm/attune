/**
 * Projects panel: status filter chips and progress cards. Wide sizes lay the
 * cards out in two columns through a container query.
 */
import clsx from "clsx";
import { CircleCheck, KanbanSquare } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Project } from "../../../shared/fixtures.ts";
import type { PanelViewState } from "../../engine/contract.ts";
import { useEngine } from "../../engine/store.ts";
import { formatDate, percent, PROJECT_STATUS_LABEL, projectDeadlineText, projectLabel } from "../format.ts";
import { useNow, useRovingList } from "@attuneui/react";
import { useItemProps } from "../linking.tsx";
import {
  Button,
  Compact,
  DetailEmpty,
  DetailPane,
  EmptyList,
  Facts,
  HeroSplit,
  PanelColumn,
  Pill,
  Segmented,
  Toolbar,
  type PanelProps,
  type Tone,
} from "./common.tsx";

type Filter = PanelViewState["projects"]["status"];

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "at_risk", label: "At risk" },
  { id: "blocked", label: "Blocked" },
  { id: "on_track", label: "On track" },
];

const STATUS_TONE: Record<Project["status"], Tone> = {
  on_track: "good",
  at_risk: "warn",
  blocked: "bad",
  done: "neutral",
};

const BAR_TONE: Record<Project["status"], string> = {
  on_track: "bg-good",
  at_risk: "bg-warn",
  blocked: "bg-bad",
  done: "bg-ink-3",
};

export function ProjectsPanel({ size }: PanelProps) {
  const { projects, tasks, view, track, setView, perform } = useEngine(
    useShallow((s) => ({
      projects: s.data.projects,
      tasks: s.data.tasks,
      view: s.view.projects,
      track: s.track,
      setView: s.setView,
      perform: s.perform,
    })),
  );
  const now = useNow();
  const item = useItemProps();
  const roving = useRovingList<HTMLUListElement>();

  const list = useMemo(
    () => projects.filter((p) => view.status === "all" || p.status === view.status).sort((a, b) => a.deadline.localeCompare(b.deadline)),
    [projects, view.status],
  );
  const selected = projects.find((p) => p.id === view.selectedId) ?? null;

  const select = (p: Project) => {
    setView("projects", { selectedId: p.id });
    track({
      type: "item_open",
      panel: "projects",
      detail: { itemKind: "project", itemId: p.id, client: p.client, label: projectLabel(p), via: "pointer" },
    });
  };

  if (size === "compact") {
    const atRisk = projects.filter((p) => p.status === "at_risk").length;
    const blocked = projects.filter((p) => p.status === "blocked").length;
    return <Compact value={atRisk + blocked} label="need attention" sub={`${atRisk} at risk, ${blocked} blocked`} />;
  }

  const listView = (
    <PanelColumn>
      <Toolbar>
        <Segmented
          label="Project status"
          options={FILTERS}
          value={view.status}
          onChange={(status) => {
            setView("projects", { status });
            track({ type: "filter", panel: "projects", detail: { filter: { status } } });
          }}
        />
      </Toolbar>
      <div className="@container fl-scroll min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 ? <EmptyList>No projects with this status.</EmptyList> : null}
        <ul
          ref={roving.ref}
          onKeyDown={roving.onKeyDown}
          onFocus={roving.onFocus}
          aria-label="Projects"
          className={clsx("fl-pad grid gap-2 pb-3", size !== "standard" && "@md:grid-cols-2")}
        >
          {list.map((p) => {
            const isSel = p.id === view.selectedId;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  {...item("project", p.id)}
                  data-roving
                  onClick={() => select(p)}
                  aria-current={isSel ? "true" : undefined}
                  className={clsx(
                    "w-full rounded-lg border px-2.5 py-2 text-left transition-colors",
                    isSel ? "border-accent/40 bg-accent-soft/70" : "border-line hover:bg-surface-2",
                  )}
                >
                  <span className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{p.name}</span>
                    <Pill tone={STATUS_TONE[p.status]}>{PROJECT_STATUS_LABEL[p.status]}</Pill>
                  </span>
                  <span className="mt-0.5 block truncate text-2xs text-ink-3">
                    {p.client} · {projectDeadlineText(p, now)}
                  </span>
                  <span className="mt-1.5 flex items-center gap-2">
                    <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
                      <span className={clsx("block h-full rounded-full", BAR_TONE[p.status])} style={{ width: percent(p.progress) }} />
                    </span>
                    <span className="w-8 shrink-0 text-right text-2xs text-ink-2 tabular-nums">{percent(p.progress)}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </PanelColumn>
  );

  if (size !== "hero") return <HeroSplit hero={false} list={listView} />;

  const shown = selected ?? list[0] ?? null;
  const related = shown ? tasks.filter((t) => t.project === shown.name && !t.done) : [];
  return (
    <HeroSplit
      list={listView}
      detail={
        shown ? (
          <DetailPane
            actions={
              shown.status === "on_track" || shown.status === "done" ? (
                <p className="text-xs text-ink-3">This project is on track.</p>
              ) : (
                <Button variant="primary" icon={CircleCheck} onClick={() => perform("update_project_status", { projectId: shown.id, client: shown.client })}>
                  Mark on track
                </Button>
              )
            }
          >
            <Pill tone={STATUS_TONE[shown.status]}>{PROJECT_STATUS_LABEL[shown.status]}</Pill>
            <h3 className="mt-2 text-base leading-snug font-semibold text-ink">{shown.name}</h3>
            <p className="mt-0.5 text-xs text-ink-2">{shown.client}</p>
            <Facts
              items={[
                { label: "Lead", value: shown.lead },
                { label: "Deadline", value: `${formatDate(shown.deadline)}, ${projectDeadlineText(shown, now).replace("deadline ", "")}` },
                { label: "Progress", value: `${percent(shown.progress)} done` },
              ]}
            />
            <p className="mt-4 text-2xs font-medium text-ink-3">Open tasks</p>
            {related.length === 0 ? (
              <p className="mt-1 text-xs text-ink-3">None.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {related.map((t) => (
                  <li key={t.id} {...item("task", t.id)} className="truncate text-xs text-ink">
                    {t.title} <span className="text-ink-3">· {t.assignee}</span>
                  </li>
                ))}
              </ul>
            )}
          </DetailPane>
        ) : (
          <DetailEmpty icon={KanbanSquare}>Pick a project to see its details.</DetailEmpty>
        )
      }
    />
  );
}
