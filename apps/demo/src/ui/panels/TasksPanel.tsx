/**
 * Tasks panel: check off, add, and filter the to-do list. Checking a task is
 * reported as an action with a readable label, since toggleTask() only
 * changes data.
 */
import clsx from "clsx";
import { Building2, Check, ListChecks, Plus, RotateCcw } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Task } from "../../../shared/fixtures.ts";
import { useEngine } from "../../engine/store.ts";
import { daysUntil, formatDate, taskDueText } from "../format.ts";
import { useNow } from "@attuneui/react";
import { useItemProps } from "../linking.tsx";
import {
  Button,
  ClientFilterChip,
  Compact,
  DetailEmpty,
  DetailPane,
  EmptyList,
  Facts,
  HeroSplit,
  ListScroll,
  PanelColumn,
  Toolbar,
  type PanelProps,
} from "./common.tsx";

export function TasksPanel({ size }: PanelProps) {
  const { tasks, view, track, setView, perform, toggleTask, open } = useEngine(
    useShallow((s) => ({
      tasks: s.data.tasks,
      view: s.view.tasks,
      track: s.track,
      setView: s.setView,
      perform: s.perform,
      toggleTask: s.toggleTask,
      open: s.open,
    })),
  );
  const now = useNow();
  const item = useItemProps();
  // In the view state, so "Up next" and "Back to" can select a task the way a click does.
  const selectedId = view.selectedId ?? null;
  const [draft, setDraft] = useState("");
  const inputId = useId();

  const visible = useMemo(
    () =>
      tasks
        .filter((t) => (view.showDone || !t.done) && (!view.client || t.client === view.client))
        .sort((a, b) => Number(a.done) - Number(b.done) || a.due.localeCompare(b.due)),
    [tasks, view.showDone, view.client],
  );

  const toggle = (t: Task) => {
    toggleTask(t.id);
    track({
      type: "action",
      panel: "tasks",
      detail: {
        label: t.done ? `Reopened task: ${t.title}` : `Checked off task: ${t.title}`,
        itemKind: "task",
        itemId: t.id,
        client: t.client ?? undefined,
        via: "pointer",
      },
    });
  };

  const select = (t: Task) => {
    setView("tasks", { selectedId: t.id });
    track({
      type: "item_open",
      panel: "tasks",
      detail: { itemKind: "task", itemId: t.id, client: t.client ?? undefined, label: `${t.title} (${taskDueText(t, now)})`, via: "pointer" },
    });
  };

  const add = () => {
    const title = draft.trim();
    if (!title) return;
    perform("create_task", { taskTitle: title, client: view.client ?? undefined });
    setDraft("");
  };

  if (size === "compact") {
    const dueNow = tasks.filter((t) => !t.done && daysUntil(t.due, now) <= 0);
    return <Compact value={dueNow.length} label="due today" sub={dueNow[0]?.title ?? "Nothing due today"} />;
  }

  const listView = (
    <PanelColumn>
      <Toolbar>
        <form
          className="relative flex min-w-0 flex-1 items-center"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <label className="sr-only" htmlFor={inputId}>
            New task
          </label>
          <input
            id={inputId}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Add a task"
            className="h-7 w-full min-w-0 rounded-lg border border-line bg-surface-2 pr-8 pl-2.5 text-xs text-ink placeholder:text-ink-3 focus:border-accent focus:bg-surface focus:outline-none"
          />
          <button
            type="submit"
            disabled={!draft.trim()}
            aria-label="Add task"
            className="absolute right-1 grid size-5 place-items-center rounded-md text-ink-2 hover:bg-surface-3 hover:text-ink disabled:opacity-40"
          >
            <Plus className="size-3.5" aria-hidden />
          </button>
        </form>
        <button
          type="button"
          aria-pressed={view.showDone}
          onClick={() => {
            const showDone = !view.showDone;
            setView("tasks", { showDone });
            track({ type: "filter", panel: "tasks", detail: { filter: { show_done: showDone ? "yes" : "no" } } });
          }}
          className={clsx(
            "h-7 shrink-0 rounded-lg px-2 text-2xs font-medium transition-colors",
            view.showDone ? "bg-accent-soft text-accent-text" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
          )}
        >
          Show done
        </button>
      </Toolbar>
      {view.client ? (
        <ClientFilterChip
          client={view.client}
          onClear={() => {
            setView("tasks", { client: null });
            track({ type: "filter", panel: "tasks", detail: { filter: { client: "all" } } });
          }}
        />
      ) : null}
      <ListScroll label="Tasks">
        {visible.length === 0 ? <EmptyList>No open tasks here.</EmptyList> : null}
        {visible.map((t) => {
          const d = daysUntil(t.due, now);
          const late = !t.done && d < 0;
          const today = !t.done && d === 0;
          return (
            <li
              key={t.id}
              {...item("task", t.id)}
              className={clsx("fl-row fl-pad flex items-start gap-2.5", t.id === selectedId ? "bg-accent-soft/70" : "hover:bg-surface-2")}
            >
              <input
                type="checkbox"
                checked={t.done}
                onChange={() => toggle(t)}
                aria-label={t.done ? `Reopen ${t.title}` : `Check off ${t.title}`}
                className="mt-0.5 size-3.5 shrink-0 cursor-pointer"
              />
              <button
                type="button"
                data-roving
                aria-current={t.id === selectedId ? "true" : undefined}
                onClick={() => select(t)}
                className="min-w-0 flex-1 text-left"
              >
                <span className={clsx("block truncate text-[13px]", t.done ? "text-ink-3 line-through" : "text-ink")}>{t.title}</span>
                <span className="block truncate text-2xs text-ink-3">
                  <span className={clsx(late && "font-medium text-bad-ink", today && "font-medium text-warn-ink")}>{taskDueText(t, now)}</span>
                  {t.client ? ` · ${t.client}` : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ListScroll>
    </PanelColumn>
  );

  if (size !== "hero") return <HeroSplit hero={false} list={listView} />;

  const shown = tasks.find((t) => t.id === selectedId) ?? visible[0] ?? null;
  return (
    <HeroSplit
      list={listView}
      detail={
        shown ? (
          <DetailPane
            actions={
              <>
                <Button variant={shown.done ? "secondary" : "primary"} icon={shown.done ? RotateCcw : Check} onClick={() => toggle(shown)}>
                  {shown.done ? "Reopen" : "Mark done"}
                </Button>
                {shown.client ? (
                  <Button
                    icon={Building2}
                    onClick={() => {
                      setView("clients", { selected: shown.client });
                      open("clients");
                    }}
                  >
                    Open client
                  </Button>
                ) : null}
              </>
            }
          >
            <p className="text-2xs text-ink-3 capitalize">{taskDueText(shown, now)}</p>
            <h3 className="mt-1 text-base leading-snug font-semibold text-ink">{shown.title}</h3>
            <Facts
              items={[
                { label: "Project", value: shown.project ?? "None" },
                { label: "Client", value: shown.client ?? "Internal" },
                { label: "Owner", value: shown.assignee },
                { label: "Due", value: formatDate(shown.due) },
              ]}
            />
          </DetailPane>
        ) : (
          <DetailEmpty icon={ListChecks}>No tasks to show.</DetailEmpty>
        )
      }
    />
  );
}
