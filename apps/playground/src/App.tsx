/**
 * The playground's whole UI: a header, the command bar, the suggestions and
 * the change line, the canvas, and the dock. The canvas, the cards' staged
 * motion, the dock, and the change line are @attuneui/react's (AdaptiveCanvas,
 * Dock, ChangeLine), wired to the store with useStoreCanvas; the app draws
 * only each card's header and panel.
 */
import type { PanelPlacement } from "@attuneui/core";
import { AdaptiveCanvas, ChangeLine, Dock, useAdaptive, useStoreCanvas } from "@attuneui/react";
import { useMemo, useState, type ReactNode } from "react";
import { CATALOG, type PanelId, type RecordKind } from "./catalog.ts";
import { TICKETS, type Ticket } from "./data.ts";
import { createDeskStore, type DeskStore } from "./engine.ts";
import { ArticlesPanel, CustomersPanel, MacrosPanel, TicketsPanel, type PanelProps } from "./panels.tsx";

const store = createDeskStore();

const PANELS: Record<PanelId, (props: PanelProps) => ReactNode> = {
  tickets: TicketsPanel,
  customers: CustomersPanel,
  articles: ArticlesPanel,
  macros: MacrosPanel,
};

const STATUS_TEXT = { idle: "Live with Jev", thinking: "Thinking", offline: "Offline: calm fallback", error: "Error" } as const;

/** A card's header: title, link tag, change badge, and the pin, size, and dock buttons. */
function CardHeader(props: { store: DeskStore; p: PanelPlacement<PanelId, RecordKind>; pinned: boolean }) {
  const { store, p } = props;
  return (
    <>
      <header>
        <h2>{CATALOG.panels[p.id].title}</h2>
        {p.relation && <span className="tag" title={p.relation.reason}>{p.relation.tag}</span>}
        {p.change && <span className="badge">{p.change === "added" ? "New" : p.change === "promoted" ? "Up" : "Down"}</span>}
        <span className="tools">
          <button type="button" onClick={() => (props.pinned ? store.unpin(p.id) : store.pin(p.id))}>{props.pinned ? "Unpin" : "Pin"}</button>
          <button type="button" onClick={() => (p.bigger ? store.restore(p.id) : store.maximize(p.id))}>{p.bigger ? "Smaller" : "Bigger"}</button>
          <button type="button" onClick={() => store.dismiss(p.id)}>Dock</button>
        </span>
      </header>
      <p className="reason">{p.reason}</p>
    </>
  );
}

export function App() {
  const canvas = useStoreCanvas(store);
  const plan = canvas.plan;
  const status = useAdaptive(store, (s) => s.status);
  const goal = useAdaptive(store, (s) => s.goal);
  const command = useAdaptive(store, (s) => s.command);
  const adaptive = useAdaptive(store, (s) => s.settings.adaptive);
  const canUndo = useAdaptive(store, (s) => s.previousPlan !== null);
  const pinned = useAdaptive(store, (s) => s.pinned);
  const [tickets, setTickets] = useState<Ticket[]>(TICKETS);
  const [text, setText] = useState("");

  const linked = useMemo(() => {
    const ids = new Set<string>();
    for (const p of plan.placements) for (const r of p.relation?.records ?? []) ids.add(r.itemId);
    return ids;
  }, [plan]);

  return (
    <div className="app">
      <header className="top">
        <h1>Help desk</h1>
        <span className="sub">an Attune playground</span>
        <span className="goal">{goal && goal.id !== "unclear" ? `Looks like: ${CATALOG.goals[goal.id].label}` : "Looks like: not sure yet"}</span>
        <span className={`status ${status}`}>{STATUS_TEXT[status]}</span>
        <label className="toggle">
          <input type="checkbox" checked={adaptive} onChange={(e) => store.setSettings({ adaptive: e.target.checked })} /> Adaptive
        </label>
      </header>

      <form
        className="command"
        onSubmit={(e) => {
          e.preventDefault();
          void store.runCommand(text);
          setText("");
        }}
      >
        <input value={text} maxLength={300} placeholder="Ask for anything, for example: show the help articles" onChange={(e) => setText(e.target.value)} />
        {command && <span className="command-status">{command.status === "applied" ? `Showing ${CATALOG.panels[command.panel!].title}` : `Not sure what "${command.text}" means`}</span>}
      </form>

      <div className="assist">
        {plan.suggestions.map((s) => (
          <span key={`${s.actionId}-${s.prominence}`} className={`suggestion ${s.prominence}`}>
            <button type="button" onClick={() => store.acceptSuggestion(s)}>{s.label}</button>
            <button type="button" aria-label="Dismiss" onClick={() => store.dismissSuggestion(s)}>x</button>
          </span>
        ))}
        <ChangeLine className="changes" decisions={plan.decisions} {...(canUndo ? { onUndo: () => store.undo() } : {})} />
      </div>

      <AdaptiveCanvas
        {...canvas}
        className="canvas"
        cardClassName={(p) => `card size-${p.size}`}
        renderCard={(p) => {
          const Panel = PANELS[p.id];
          return (
            <>
              <CardHeader store={store} p={p} pinned={pinned.includes(p.id)} />
              <Panel store={store} compact={p.size === "compact"} linked={linked} tickets={tickets} setTickets={setTickets} />
            </>
          );
        }}
        empty={<p className="summary">Everything is in the dock. Pick a panel below to bring it back.</p>}
      />

      <Dock className="dock" docked={plan.docked} label={(id) => CATALOG.panels[id].title} onOpen={(id) => store.open(id)} />
    </div>
  );
}
