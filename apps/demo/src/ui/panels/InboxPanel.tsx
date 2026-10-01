/**
 * Inbox panel. Emits the richest signals in the app: debounced searches,
 * message opens with the client attached, and j/k keyboard navigation.
 */
import clsx from "clsx";
import { Building2, MailOpen, Reply } from "lucide-react";
import { useMemo, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Message } from "../../../shared/fixtures.ts";
import { useEngine } from "../../engine/store.ts";
import { matchesQuery, messageLabel, relativeTime } from "../format.ts";
import { hasModifier, isTextField, useDebouncedCallback, useNow, useWindowKeydown } from "@attune/react";
import {
  Button,
  ClientFilterChip,
  Compact,
  DetailEmpty,
  DetailPane,
  EmptyList,
  HeroSplit,
  ListScroll,
  PanelColumn,
  RowButton,
  SearchField,
  Toolbar,
  type PanelProps,
} from "./common.tsx";

function matches(m: Message, query: string, client: string | null): boolean {
  if (client && m.client !== client) return false;
  return matchesQuery([m.from, m.subject, m.preview, m.client], query);
}

export function InboxPanel({ size }: PanelProps) {
  const { messages, view, focused, track, setView, perform, open } = useEngine(
    useShallow((s) => ({
      messages: s.data.messages,
      view: s.view.inbox,
      focused: s.focusedPanel === "inbox",
      track: s.track,
      setView: s.setView,
      perform: s.perform,
      open: s.open,
    })),
  );
  const now = useNow();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const list = useMemo(
    () =>
      messages
        .filter((m) => matches(m, view.query, view.client))
        .sort((a, b) => b.receivedAt.localeCompare(a.receivedAt)),
    [messages, view.query, view.client],
  );
  const selected = messages.find((m) => m.id === view.selectedId) ?? null;
  const unread = messages.filter((m) => m.unread).length;

  const reportSearch = useDebouncedCallback((query: string) => {
    const q = query.trim();
    if (q) track({ type: "search", panel: "inbox", detail: { query: q } });
  }, 600);

  const select = (m: Message) => {
    setView("inbox", { selectedId: m.id });
    track({
      type: "item_open",
      panel: "inbox",
      detail: { itemKind: "message", itemId: m.id, client: m.client ?? undefined, label: messageLabel(m), via: "pointer" },
    });
  };

  useWindowKeydown((e) => {
    if (!focused || size === "compact" || hasModifier(e) || isTextField(e.target)) return;
    if (e.key !== "j" && e.key !== "k") return;
    if (list.length === 0) return;
    e.preventDefault();
    const idx = list.findIndex((m) => m.id === view.selectedId);
    const nextIdx = idx === -1 ? 0 : Math.min(list.length - 1, Math.max(0, idx + (e.key === "j" ? 1 : -1)));
    const next = list[nextIdx];
    if (!next) return;
    setView("inbox", { selectedId: next.id });
    track({
      type: "shortcut",
      panel: "inbox",
      detail: { key: e.key, via: "keyboard", itemKind: "message", itemId: next.id, client: next.client ?? undefined, label: messageLabel(next) },
    });
    requestAnimationFrame(() => rowRefs.current.get(next.id)?.scrollIntoView({ block: "nearest" }));
  });

  if (size === "compact") {
    const latest = list.find((m) => m.unread) ?? list[0];
    return <Compact value={unread} label="unread" sub={latest ? `${latest.from}: ${latest.subject}` : "All caught up"} />;
  }

  const listView = (
    <PanelColumn>
      <Toolbar>
        <SearchField
          label="Search messages"
          placeholder="Search messages"
          value={view.query}
          onChange={(q) => {
            setView("inbox", { query: q });
            reportSearch(q);
          }}
        />
      </Toolbar>
      {view.client ? (
        <ClientFilterChip
          client={view.client}
          onClear={() => {
            setView("inbox", { client: null });
            track({ type: "filter", panel: "inbox", detail: { filter: { client: "all" } } });
          }}
        />
      ) : null}
      <ListScroll label="Messages">
        {list.length === 0 ? <EmptyList>No messages match.</EmptyList> : null}
        {list.map((m) => {
          const isSel = m.id === view.selectedId;
          return (
            <li key={m.id}>
              <RowButton
                selected={isSel}
                onClick={() => select(m)}
                item={{ kind: "message", id: m.id }}
                ref={(el) => {
                  if (el) rowRefs.current.set(m.id, el);
                  else rowRefs.current.delete(m.id);
                }}
              >
                <span className="mt-1.5 flex w-2 shrink-0 justify-center">
                  {m.unread ? <span className="size-2 rounded-full bg-accent" title="Unread" /> : null}
                  {m.unread ? <span className="sr-only">Unread.</span> : null}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className={clsx("min-w-0 truncate text-[13px]", m.unread ? "font-semibold text-ink" : "font-medium text-ink-2")}>
                      {m.from}
                    </span>
                    {m.client ? <span className="hidden min-w-0 truncate text-2xs text-ink-3 @sm:inline">{m.client}</span> : null}
                    <span className="ml-auto shrink-0 text-2xs text-ink-3 tabular-nums">{relativeTime(m.receivedAt, now)}</span>
                  </span>
                  <span className="block truncate text-xs text-ink-2">
                    <span className={m.unread ? "text-ink" : undefined}>{m.subject}</span>
                    <span className="text-ink-3"> · {m.preview}</span>
                  </span>
                  {isSel && size === "standard" ? (
                    <span className="mt-1 block text-xs whitespace-normal text-ink-2">{m.preview}</span>
                  ) : null}
                </span>
              </RowButton>
            </li>
          );
        })}
      </ListScroll>
    </PanelColumn>
  );

  if (size !== "hero") return <HeroSplit hero={false} list={listView} />;

  const shown = selected ?? list[0] ?? null;
  return (
    <HeroSplit
      list={listView}
      detail={
        shown ? (
          <DetailPane
            actions={
              <>
                <Button
                  variant="primary"
                  icon={Reply}
                  onClick={() => perform("reply_to_message", { messageId: shown.id, client: shown.client ?? undefined })}
                >
                  Reply
                </Button>
                {shown.client ? (
                  <Button
                    icon={Building2}
                    onClick={() => {
                      setView("clients", { selected: shown.client });
                      open("clients");
                    }}
                  >
                    Open {shown.client}
                  </Button>
                ) : null}
              </>
            }
          >
            <p className="text-2xs text-ink-3">
              {relativeTime(shown.receivedAt, now)}
              {shown.client ? ` · ${shown.client}` : ""}
            </p>
            <h3 className="mt-1 text-base leading-snug font-semibold text-ink">{shown.subject}</h3>
            <p className="mt-0.5 text-xs text-ink-2">From {shown.from}</p>
            <p className="mt-3 text-sm leading-relaxed text-ink">{shown.preview}</p>
          </DetailPane>
        ) : (
          <DetailEmpty icon={MailOpen}>Pick a message to read it here.</DetailEmpty>
        )
      }
    />
  );
}
