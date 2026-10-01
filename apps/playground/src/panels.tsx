/**
 * The four help desk panels. Each reports what the agent does with
 * store.track(), in the core signal types (item_open, filter, search, action).
 * `linked` holds the record ids the plan links to the anchor, which the rows tint.
 */
import { matchesQuery } from "@attune/core";
import { useDebouncedCallback } from "@attune/react";
import { useState } from "react";
import { ARTICLES, CUSTOMERS, MACROS, type Ticket } from "./data.ts";
import type { DeskStore } from "./engine.ts";

export interface PanelProps {
  store: DeskStore;
  compact: boolean;
  linked: ReadonlySet<string>;
  tickets: Ticket[];
  setTickets: (next: Ticket[]) => void;
}

function Row(props: { id: string; selected: boolean; linked: boolean; onOpen: () => void; title: string; meta: string }) {
  return (
    <li>
      <button type="button" className={`row${props.selected ? " selected" : ""}${props.linked ? " linked" : ""}`} onClick={props.onOpen}>
        <span className="row-title">{props.title}</span>
        <span className="row-meta">{props.meta}</span>
      </button>
    </li>
  );
}

const FILTERS = ["All", "Open", "Pending", "Solved"] as const;

export function TicketsPanel({ store, compact, linked, tickets, setTickets }: PanelProps) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [selected, setSelected] = useState<string | null>(null);
  const open = tickets.filter((t) => t.status === "open").length;
  if (compact) return <p className="summary">{open} open tickets</p>;
  const shown = tickets.filter((t) => filter === "All" || t.status === filter.toLowerCase());
  const ticket = tickets.find((t) => t.id === selected);
  return (
    <div className="panel-body">
      <div className="chips">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={f === filter ? "chip on" : "chip"}
            onClick={() => {
              setFilter(f);
              store.track({ type: "filter", panel: "tickets", detail: { label: f === "All" ? "all tickets" : `${f.toLowerCase()} tickets` } });
            }}
          >
            {f}
          </button>
        ))}
      </div>
      <ul className="rows">
        {shown.map((t) => (
          <Row
            key={t.id}
            id={t.id}
            selected={t.id === selected}
            linked={linked.has(t.id)}
            title={t.subject}
            meta={`${t.id} · ${t.customer} · ${t.status}${t.priority === "high" ? " · high" : ""}`}
            onOpen={() => {
              setSelected(t.id);
              store.track({ type: "item_open", panel: "tickets", detail: { itemKind: "ticket", itemId: t.id, client: t.customer, label: `${t.id} "${t.subject}"`, via: "pointer" } });
            }}
          />
        ))}
      </ul>
      {ticket && (
        <div className="detail">
          <strong>{ticket.subject}</strong>
          <span>
            {ticket.customer} · {ticket.status}
          </span>
          <div className="actions">
            <button type="button" onClick={() => store.track({ type: "action", panel: "tickets", detail: { actionId: "reply_ticket", itemId: ticket.id, client: ticket.customer } })}>
              Reply
            </button>
            <button
              type="button"
              disabled={ticket.status === "solved"}
              onClick={() => {
                setTickets(tickets.map((t) => (t.id === ticket.id ? { ...t, status: "solved" } : t)));
                store.track({ type: "action", panel: "tickets", detail: { actionId: "solve_ticket", itemId: ticket.id, client: ticket.customer } });
              }}
            >
              Mark solved
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function CustomersPanel({ store, compact, linked, tickets }: PanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  if (compact) return <p className="summary">{CUSTOMERS.length} customers</p>;
  const customer = CUSTOMERS.find((c) => c.id === selected);
  return (
    <div className="panel-body">
      <ul className="rows">
        {CUSTOMERS.map((c) => (
          <Row
            key={c.id}
            id={c.id}
            selected={c.id === selected}
            linked={linked.has(c.id)}
            title={c.name}
            meta={`${c.plan} plan · ${c.contact}`}
            onOpen={() => {
              setSelected(c.id);
              store.track({ type: "item_open", panel: "customers", detail: { itemKind: "customer", itemId: c.id, client: c.name, label: c.name, via: "pointer" } });
            }}
          />
        ))}
      </ul>
      {customer && (
        <div className="detail">
          <strong>{customer.name}</strong>
          <span>{tickets.filter((t) => t.customer === customer.name && t.status !== "solved").length} open or pending tickets</span>
        </div>
      )}
    </div>
  );
}

export function ArticlesPanel({ store, compact, linked }: PanelProps) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const logSearch = useDebouncedCallback((q: string) => store.track({ type: "search", panel: "articles", detail: { query: q } }), 600);
  if (compact) return <p className="summary">{ARTICLES.length} help articles</p>;
  const shown = ARTICLES.filter((a) => matchesQuery([a.title, ...a.tags], query));
  const article = ARTICLES.find((a) => a.id === selected);
  return (
    <div className="panel-body">
      <input
        className="search"
        placeholder="Search articles"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          logSearch(e.target.value);
        }}
      />
      <ul className="rows">
        {shown.map((a) => (
          <Row
            key={a.id}
            id={a.id}
            selected={a.id === selected}
            linked={linked.has(a.id)}
            title={a.title}
            meta={a.tags.join(", ")}
            onOpen={() => {
              setSelected(a.id);
              store.track({ type: "item_open", panel: "articles", detail: { itemKind: "article", itemId: a.id, label: a.title, via: "pointer" } });
            }}
          />
        ))}
      </ul>
      {article && (
        <div className="actions">
          <button type="button" onClick={() => store.track({ type: "action", panel: "articles", detail: { actionId: "send_article", itemId: article.id, label: article.title } })}>
            Send "{article.title}"
          </button>
        </div>
      )}
    </div>
  );
}

export function MacrosPanel({ store, compact, linked }: PanelProps) {
  const [selected, setSelected] = useState<string | null>(null);
  if (compact) return <p className="summary">{MACROS.length} saved replies</p>;
  const macro = MACROS.find((m) => m.id === selected);
  return (
    <div className="panel-body">
      <ul className="rows">
        {MACROS.map((m) => (
          <Row
            key={m.id}
            id={m.id}
            selected={m.id === selected}
            linked={linked.has(m.id)}
            title={m.title}
            meta={m.text.slice(0, 48) + "..."}
            onOpen={() => {
              setSelected(m.id);
              store.track({ type: "item_open", panel: "macros", detail: { itemKind: "macro", itemId: m.id, label: m.title, via: "pointer" } });
            }}
          />
        ))}
      </ul>
      {macro && <p className="detail">{macro.text}</p>}
    </div>
  );
}
