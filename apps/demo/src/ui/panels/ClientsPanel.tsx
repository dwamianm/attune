/**
 * Clients panel: search, a health dot per client, and a detail view that
 * links out to the client's invoices. Selecting a client is one of the
 * strongest hints for the "working on one client" goal.
 */
import { Building2, CalendarPlus, Receipt } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { CLIENTS, type Client } from "../../../shared/fixtures.ts";
import { useEngine } from "../../engine/store.ts";
import { formatDate, matchesQuery } from "../format.ts";
import { useDebouncedCallback } from "@attuneui/react";
import {
  Button,
  Compact,
  DetailEmpty,
  DetailPane,
  Dot,
  EmptyList,
  Facts,
  HeroSplit,
  ListScroll,
  PanelColumn,
  RowButton,
  SearchField,
  Toolbar,
  type PanelProps,
  type Tone,
} from "./common.tsx";

const HEALTH: Record<Client["health"], { label: string; tone: Tone }> = {
  good: { label: "Good", tone: "good" },
  watch: { label: "Watch", tone: "warn" },
  at_risk: { label: "At risk", tone: "bad" },
};

export function ClientsPanel({ size }: PanelProps) {
  const { view, invoices, projects, track, setView, perform, open } = useEngine(
    useShallow((s) => ({
      view: s.view.clients,
      invoices: s.data.invoices,
      projects: s.data.projects,
      track: s.track,
      setView: s.setView,
      perform: s.perform,
      open: s.open,
    })),
  );

  const list = useMemo(() => CLIENTS.filter((c) => matchesQuery([c.name, c.contact, c.industry, c.email], view.query)), [view.query]);

  // Commands may set `selected` to a client name; accept an id too.
  const selected = CLIENTS.find((c) => c.name === view.selected || c.id === view.selected) ?? null;

  const reportSearch = useDebouncedCallback((query: string) => {
    const q = query.trim();
    if (q) track({ type: "search", panel: "clients", detail: { query: q } });
  }, 600);

  const select = (c: Client) => {
    setView("clients", { selected: c.name });
    track({
      type: "item_open",
      panel: "clients",
      detail: { itemKind: "client", itemId: c.id, client: c.name, label: `${c.name}, contact ${c.contact}, health ${HEALTH[c.health].label.toLowerCase()}`, via: "pointer" },
    });
  };

  const seeInvoices = (c: Client) => {
    setView("invoices", { client: c.name, status: "all", selectedId: null });
    track({ type: "filter", panel: "invoices", detail: { filter: { client: c.name }, client: c.name, via: "pointer" } });
    open("invoices");
  };

  const counts = (c: Client) => ({
    projects: projects.filter((p) => p.client === c.name && p.status !== "done").length,
    openInvoices: invoices.filter((i) => i.client === c.name && (i.status === "sent" || i.status === "overdue")).length,
  });

  if (size === "compact") {
    const atRisk = CLIENTS.filter((c) => c.health === "at_risk").length;
    const watch = CLIENTS.filter((c) => c.health === "watch").length;
    return <Compact value={CLIENTS.length} label="clients" sub={`${atRisk} at risk, ${watch} to watch`} />;
  }

  const listView = (
    <PanelColumn>
      <Toolbar>
        <SearchField
          label="Search clients"
          placeholder="Search clients"
          value={view.query}
          onChange={(q) => {
            setView("clients", { query: q });
            reportSearch(q);
          }}
        />
      </Toolbar>
      <ListScroll label="Clients">
        {list.length === 0 ? <EmptyList>No clients match.</EmptyList> : null}
        {list.map((c) => {
          const isSel = selected?.id === c.id;
          const n = counts(c);
          return (
            <li key={c.id}>
              <RowButton selected={isSel} onClick={() => select(c)} item={{ kind: "client", id: c.id }}>
                <Dot tone={HEALTH[c.health].tone} label={`Health: ${HEALTH[c.health].label}.`} className="mt-1.5" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-ink">{c.name}</span>
                  <span className="block truncate text-2xs text-ink-3">
                    {c.contact} · {c.industry}
                  </span>
                </span>
                {n.openInvoices > 0 ? (
                  <span className="shrink-0 text-2xs text-ink-3 tabular-nums">
                    {n.openInvoices} open {n.openInvoices === 1 ? "bill" : "bills"}
                  </span>
                ) : null}
              </RowButton>
              {isSel && size !== "hero" ? (
                <div className="fl-pad flex flex-wrap gap-2 bg-accent-soft/70 pb-2">
                  <Button icon={Receipt} onClick={() => seeInvoices(c)}>
                    See invoices
                  </Button>
                  <Button icon={CalendarPlus} onClick={() => perform("schedule_meeting", { client: c.name })}>
                    Schedule meeting
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ListScroll>
    </PanelColumn>
  );

  if (size !== "hero") return <HeroSplit hero={false} list={listView} />;

  const shown = selected ?? list[0] ?? null;
  const n = shown ? counts(shown) : null;
  return (
    <HeroSplit
      list={listView}
      detail={
        shown && n ? (
          <DetailPane
            actions={
              <>
                <Button variant="primary" icon={Receipt} onClick={() => seeInvoices(shown)}>
                  See invoices
                </Button>
                <Button icon={CalendarPlus} onClick={() => perform("schedule_meeting", { client: shown.name })}>
                  Schedule meeting
                </Button>
              </>
            }
          >
            <div className="flex items-center gap-2 text-2xs text-ink-3">
              <Dot tone={HEALTH[shown.health].tone} />
              {HEALTH[shown.health].label} · client since {formatDate(shown.since, true)}
            </div>
            <h3 className="mt-1 text-base leading-snug font-semibold text-ink">{shown.name}</h3>
            <p className="mt-0.5 text-xs text-ink-2">{shown.industry}</p>
            <Facts
              items={[
                { label: "Contact", value: shown.contact },
                { label: "Email", value: shown.email },
                { label: "Projects", value: `${n.projects} active` },
                { label: "Invoices", value: n.openInvoices === 0 ? "None open" : `${n.openInvoices} open` },
              ]}
            />
            <p className="mt-3 rounded-lg bg-surface-2 p-2.5 text-xs leading-relaxed text-ink-2">{shown.notes}</p>
          </DetailPane>
        ) : (
          <DetailEmpty icon={Building2}>Pick a client to see everything about them.</DetailEmpty>
        )
      }
    />
  );
}
