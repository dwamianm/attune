/**
 * The playground's whole UI: a header, the command bar, the suggestions, the
 * canvas, and the dock. The canvas is a CSS grid that places each card in the
 * cell the plan gives it (plan.grid), so the clicked card holds still. There
 * is no staged motion yet: that comes with the canvas components in
 * @attune/react (docs/library-roadmap.md, step 7).
 */
import { columnsForWidth, spanOf, type GridCell, type GridColumns, type PanelPlacement } from "@attune/core";
import { useAdaptive } from "@attune/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
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

function Card(props: { store: DeskStore; p: PanelPlacement<PanelId, RecordKind>; cell: GridCell | undefined; columns: GridColumns; pinned: boolean; focused: boolean; children: ReactNode }) {
  const { store, p, cell } = props;
  // A plan without cells (adaptive off) flows in order, each card spanning its size.
  const span = spanOf(p.size, props.columns);
  const style = cell
    ? { gridColumn: `${cell.col + 1} / span ${cell.w}`, gridRow: `${cell.row + 1} / span ${cell.h}` }
    : { gridColumn: `span ${Math.min(span.w, props.columns)}`, gridRow: `span ${span.h}` };
  return (
    <section
      className={`card size-${p.size}${p.anchor ? " anchor" : ""}${p.relation ? " is-linked" : ""}`}
      style={style}
      onPointerEnter={() => store.setPointer({ panel: p.id, down: false })}
      onPointerDown={() => {
        store.setPointer({ panel: p.id, down: true });
        if (!props.focused) store.track({ type: "panel_focus", panel: p.id, detail: { via: "pointer" } });
      }}
    >
      <header>
        <h2>{CATALOG.panels[p.id].title}</h2>
        {p.relation && <span className="tag" title={p.relation.reason}>{p.relation.tag}</span>}
        {p.change && <span className="badge">{p.change === "added" ? "New" : p.change === "promoted" ? "Up" : "Down"}</span>}
        <span className="tools">
          <button type="button" title={props.pinned ? "Unpin" : "Pin"} onClick={() => (props.pinned ? store.unpin(p.id) : store.pin(p.id))}>
            {props.pinned ? "Unpin" : "Pin"}
          </button>
          <button type="button" onClick={() => (p.bigger ? store.restore(p.id) : store.maximize(p.id))}>{p.bigger ? "Smaller" : "Bigger"}</button>
          <button type="button" onClick={() => store.dismiss(p.id)}>Dock</button>
        </span>
      </header>
      <p className="reason">{p.reason}</p>
      {props.children}
    </section>
  );
}

export function App() {
  const plan = useAdaptive(store, (s) => s.plan);
  const status = useAdaptive(store, (s) => s.status);
  const goal = useAdaptive(store, (s) => s.goal);
  const columns = useAdaptive(store, (s) => s.columns);
  const command = useAdaptive(store, (s) => s.command);
  const adaptive = useAdaptive(store, (s) => s.settings.adaptive);
  const canUndo = useAdaptive(store, (s) => s.previousPlan !== null);
  const pinned = useAdaptive(store, (s) => s.pinned);
  const focused = useAdaptive(store, (s) => s.focusedPanel);
  const [tickets, setTickets] = useState<Ticket[]>(TICKETS);
  const [text, setText] = useState("");

  useEffect(() => {
    const fit = () => store.setColumns(columnsForWidth(window.innerWidth));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

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
        <span className="changes">
          {plan.decisions.slice(0, 2).map((d) => d.text).join("; ")}
          {canUndo && (
            <button type="button" className="link" onClick={() => store.undo()}>
              Undo
            </button>
          )}
        </span>
      </div>

      <main
        className="canvas"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        onPointerEnter={() => store.setCanvasHold("pointer", true)}
        onPointerLeave={() => {
          store.setCanvasHold("pointer", false);
          store.setPointer({ panel: null, down: false });
        }}
      >
        {plan.placements.map((p) => {
          const Panel = PANELS[p.id];
          return (
            <Card key={p.id} store={store} p={p} cell={plan.grid?.cells[p.id]} columns={columns} pinned={pinned.includes(p.id)} focused={focused === p.id}>
              <Panel store={store} compact={p.size === "compact"} linked={linked} tickets={tickets} setTickets={setTickets} />
            </Card>
          );
        })}
      </main>

      <nav className="dock">
        <span>Dock</span>
        {plan.docked.map((id) => (
          <button key={id} type="button" onClick={() => store.open(id)}>
            {CATALOG.panels[id].title}
          </button>
        ))}
      </nav>
    </div>
  );
}
