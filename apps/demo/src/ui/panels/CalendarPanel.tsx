/**
 * Calendar panel: today or this week, with a Book meeting action. The range
 * toggle is reported as a filter signal so Jev can tell planning from
 * checking a single meeting.
 */
import clsx from "clsx";
import { Building2, CalendarPlus, CalendarDays } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { CalendarEvent } from "../../../shared/fixtures.ts";
import { useEngine } from "../../engine/store.ts";
import { clockTime, dayOffset, dayWord, eventLabel } from "../format.ts";
import { useNow } from "@attuneui/react";
import {
  Button,
  Compact,
  DetailEmpty,
  DetailPane,
  EmptyList,
  Facts,
  HeroSplit,
  ListScroll,
  PanelColumn,
  Pill,
  RowButton,
  Segmented,
  Toolbar,
  type PanelProps,
  type Tone,
} from "./common.tsx";

const KIND: Record<CalendarEvent["kind"], { label: string; tone: Tone }> = {
  meeting: { label: "Meeting", tone: "accent" },
  call: { label: "Call", tone: "neutral" },
  focus: { label: "Focus time", tone: "good" },
  internal: { label: "Internal", tone: "neutral" },
};

const RANGES = [
  { id: "today", label: "Today" },
  { id: "this_week", label: "This week" },
] as const;

export function CalendarPanel({ size }: PanelProps) {
  const { events, range, selectedId, track, setView, perform, open } = useEngine(
    useShallow((s) => ({
      events: s.data.events,
      range: s.view.calendar.range,
      // In the view state, so "Up next" and "Back to" can select an event the way a click does.
      selectedId: s.view.calendar.selectedId ?? null,
      track: s.track,
      setView: s.setView,
      perform: s.perform,
      open: s.open,
    })),
  );
  const now = useNow();

  const sorted = useMemo(() => [...events].sort((a, b) => a.start.localeCompare(b.start)), [events]);
  const today = sorted.filter((e) => dayOffset(e.start, now) === 0);
  const shown = range === "today" ? today : sorted.filter((e) => {
    const d = dayOffset(e.start, now);
    return d >= 0 && d < 7;
  });
  const next = today.find((e) => new Date(e.end).getTime() > now);

  const select = (e: CalendarEvent) => {
    setView("calendar", { selectedId: e.id });
    track({
      type: "item_open",
      panel: "calendar",
      detail: { itemKind: "event", itemId: e.id, client: e.client ?? undefined, label: eventLabel(e, now), via: "pointer" },
    });
  };

  const book = (client?: string | null) => perform("schedule_meeting", { client: client ?? undefined });

  if (size === "compact") {
    return (
      <Compact
        value={today.length}
        label={today.length === 1 ? "event today" : "events today"}
        sub={next ? `Next: ${next.title} at ${clockTime(next.start)}` : "Nothing else today"}
      />
    );
  }

  // Group by day for the week view.
  const groups: { day: string; items: CalendarEvent[] }[] = [];
  for (const e of shown) {
    const day = dayWord(e.start, now);
    const g = groups.at(-1);
    if (g && g.day === day) g.items.push(e);
    else groups.push({ day, items: [e] });
  }

  const listView = (
    <PanelColumn>
      <Toolbar>
        <Segmented
          label="Date range"
          options={[...RANGES]}
          value={range}
          onChange={(r) => {
            setView("calendar", { range: r });
            track({ type: "filter", panel: "calendar", detail: { filter: { range: r } } });
          }}
        />
        <Button className="ml-auto" icon={CalendarPlus} onClick={() => book(null)}>
          Book meeting
        </Button>
      </Toolbar>
      <ListScroll label="Events">
        {shown.length === 0 ? <EmptyList>No events in this range.</EmptyList> : null}
        {groups.map((g) => (
          <li key={g.day}>
            {range === "this_week" ? (
              <p className="fl-pad pt-2 pb-0.5 text-2xs font-medium text-ink-3 capitalize">{g.day}</p>
            ) : null}
            <ul>
              {g.items.map((e) => {
                const past = new Date(e.end).getTime() < now;
                return (
                  <li key={e.id}>
                    <RowButton selected={e.id === selectedId} onClick={() => select(e)} item={{ kind: "event", id: e.id }}>
                      <span className={clsx("w-10 shrink-0 text-xs tabular-nums", past ? "text-ink-3" : "text-ink-2")}>
                        {clockTime(e.start)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={clsx("block truncate text-[13px] font-medium", past ? "text-ink-3" : "text-ink")}>
                          {e.title}
                        </span>
                        <span className="block truncate text-2xs text-ink-3">
                          {KIND[e.kind].label}
                          {e.client ? ` · ${e.client}` : ""}
                          {past ? " · done" : ""}
                        </span>
                      </span>
                    </RowButton>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ListScroll>
    </PanelColumn>
  );

  if (size !== "hero") return <HeroSplit hero={false} list={listView} />;

  const detail = sorted.find((e) => e.id === selectedId) ?? next ?? shown[0] ?? null;
  return (
    <HeroSplit
      list={listView}
      detail={
        detail ? (
          <DetailPane
            actions={
              <>
                <Button variant="primary" icon={CalendarPlus} onClick={() => book(detail.client)}>
                  {detail.client ? "Book follow-up" : "Book meeting"}
                </Button>
                {detail.client ? (
                  <Button
                    icon={Building2}
                    onClick={() => {
                      setView("clients", { selected: detail.client });
                      open("clients");
                    }}
                  >
                    Open client
                  </Button>
                ) : null}
              </>
            }
          >
            <Pill tone={KIND[detail.kind].tone}>{KIND[detail.kind].label}</Pill>
            <h3 className="mt-2 text-base leading-snug font-semibold text-ink">{detail.title}</h3>
            <p className="mt-0.5 text-xs text-ink-2 capitalize">
              {dayWord(detail.start, now)}, {clockTime(detail.start)} to {clockTime(detail.end)}
            </p>
            <Facts
              items={[
                { label: "Client", value: detail.client ?? "Internal" },
                { label: "Length", value: `${Math.round((new Date(detail.end).getTime() - new Date(detail.start).getTime()) / 60000)} minutes` },
              ]}
            />
          </DetailPane>
        ) : (
          <DetailEmpty icon={CalendarDays}>No events to show.</DetailEmpty>
        )
      }
    />
  );
}
