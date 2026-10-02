/**
 * Team panel: who is available, busy, or away, and what each person is
 * working on. Team data is static in this prototype; tasks come from the store.
 */
import { CalendarPlus, Users } from "lucide-react";
import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { TEAM, type TeamMember } from "../../../shared/fixtures.ts";
import { useEngine } from "../../engine/store.ts";
import { initials, taskDueText } from "../format.ts";
import { useNow } from "@attuneui/react";
import { useItemProps } from "../linking.tsx";
import {
  Button,
  Compact,
  DetailEmpty,
  DetailPane,
  Dot,
  Facts,
  HeroSplit,
  ListScroll,
  PanelColumn,
  RowButton,
  type PanelProps,
  type Tone,
} from "./common.tsx";

const STATUS: Record<TeamMember["status"], { label: string; tone: Tone }> = {
  available: { label: "Available", tone: "good" },
  busy: { label: "Busy", tone: "warn" },
  away: { label: "Away", tone: "neutral" },
};

export function TeamPanel({ size }: PanelProps) {
  const { tasks, track, perform } = useEngine(useShallow((s) => ({ tasks: s.data.tasks, track: s.track, perform: s.perform })));
  const now = useNow();
  const item = useItemProps();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const select = (m: TeamMember) => {
    setSelectedId(m.id);
    track({
      type: "item_open",
      panel: "team",
      detail: {
        itemKind: "person",
        itemId: m.id,
        label: `${m.name}, ${m.role}, ${STATUS[m.status].label.toLowerCase()}, working on ${m.workingOn}`,
        via: "pointer",
      },
    });
  };

  if (size === "compact") {
    const available = TEAM.filter((m) => m.status === "available").length;
    const busy = TEAM.filter((m) => m.status === "busy").length;
    const away = TEAM.filter((m) => m.status === "away").length;
    return <Compact value={available} label="available" sub={`${busy} busy, ${away} away`} />;
  }

  const listView = (
    <PanelColumn className="pt-0.5">
      <ListScroll label="Team members">
        {TEAM.map((m) => (
          <li key={m.id}>
            <RowButton selected={m.id === selectedId} onClick={() => select(m)} item={{ kind: "person", id: m.id }}>
              <span className="relative grid size-7 shrink-0 place-items-center rounded-full bg-surface-3 text-2xs font-semibold text-ink-2">
                {initials(m.name)}
                <Dot tone={STATUS[m.status].tone} className="absolute -right-0.5 -bottom-0.5 ring-2 ring-surface" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-2">
                  <span className="min-w-0 truncate text-[13px] font-medium text-ink">{m.name}</span>
                  <span className="ml-auto shrink-0 text-2xs text-ink-3">{STATUS[m.status].label}</span>
                </span>
                <span className="block truncate text-2xs text-ink-3">
                  {m.role} · on {m.workingOn}
                </span>
              </span>
            </RowButton>
          </li>
        ))}
      </ListScroll>
    </PanelColumn>
  );

  if (size !== "hero") return <HeroSplit hero={false} list={listView} />;

  const shown = TEAM.find((m) => m.id === selectedId) ?? TEAM[0] ?? null;
  const theirTasks = shown ? tasks.filter((t) => t.assignee === shown.name && !t.done) : [];
  return (
    <HeroSplit
      list={listView}
      detail={
        shown ? (
          <DetailPane
            actions={
              <Button variant="primary" icon={CalendarPlus} onClick={() => perform("schedule_meeting", {})}>
                Schedule a chat
              </Button>
            }
          >
            <div className="flex items-center gap-2 text-2xs text-ink-3">
              <Dot tone={STATUS[shown.status].tone} />
              {STATUS[shown.status].label} today
            </div>
            <h3 className="mt-1 text-base leading-snug font-semibold text-ink">{shown.name}</h3>
            <p className="mt-0.5 text-xs text-ink-2">{shown.role}</p>
            <Facts items={[{ label: "Working on", value: shown.workingOn }]} />
            <p className="mt-4 text-2xs font-medium text-ink-3">Open tasks</p>
            {theirTasks.length === 0 ? (
              <p className="mt-1 text-xs text-ink-3">None.</p>
            ) : (
              <ul className="mt-1 space-y-1">
                {theirTasks.map((t) => (
                  <li key={t.id} {...item("task", t.id)} className="truncate text-xs text-ink">
                    {t.title} <span className="text-ink-3">· {taskDueText(t, now)}</span>
                  </li>
                ))}
              </ul>
            )}
          </DetailPane>
        ) : (
          <DetailEmpty icon={Users}>No team members.</DetailEmpty>
        )
      }
    />
  );
}
