/**
 * The adaptive canvas for React: a grid that shows a layout plan, with every
 * card in the cell the plan gives it (so the panel the user just worked in
 * holds still) and every change staged so the eye can follow it: the anchor
 * grows first, leaving cards fly into their dock icon, moved cards glide,
 * and new cards arrive one at a time from the anchor's side (roundCues and
 * the stage timing in @attune/core, choreography.ts). Reduced motion turns
 * every move into a short fade.
 *
 * The components draw no look of their own: only the layout they need
 * (grid tracks, cells, the anchor above the cards moving around it). Style
 * them with class names and these attributes:
 *   data-canvas on the grid; data-panel, data-size, data-anchor, data-linked,
 *   and data-change on each card; data-dock-id on each dock item.
 *
 * The demo app has a richer canvas of its own (link lines, the anchor note,
 * quiet fades, focus restore; apps/demo/src/ui/Canvas.tsx) until it moves
 * onto these (docs/library-roadmap.md, step 6d).
 */
import {
  cueFor,
  ENTER_OFFSET_PX,
  ENTER_SCALE,
  GRID_BREAKPOINTS,
  REDUCED_FADE_MS,
  roundCues,
  spanOf,
  STAGE_EXIT,
  STAGE_MOVE,
  stageTransition,
  type AdaptiveStore,
  type CardCue,
  type CoreSuggestion,
  type Decision,
  type GridCell,
  type GridColumns,
  type LayoutPlan,
  type PanelPlacement,
} from "@attune/core";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion, type TargetAndTransition } from "motion/react";
import { useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { isTextField } from "./hooks.ts";
import { useAdaptive } from "./useAdaptive.ts";

export const CANVAS_ATTR = "data-canvas";
export const PANEL_ATTR = "data-panel";
export const DOCK_ID_ATTR = "data-dock-id";

/** One row track: half a standard card (CELL_SPANS in @attune/core). */
export const ROW_HEIGHT_PX = 104;
/** A pointer rest shorter than this is noise, not interest. */
export const DWELL_MIN_MS = 1_500;
/** Longest pointer rest reported: a card that slid under a resting pointer must not count as a long read. */
export const DWELL_MAX_MS = 15_000;

/** Cards spring into place when a round is not staged (a first plan, a reset). */
const PANEL_SPRING = { type: "spring", stiffness: 380, damping: 34 } as const;
/** A leaving card drops this far when it has no dock icon to fly into. */
const EXIT_DROP_PX = 12;
/** Smallest scale a leaving card shrinks to on its way into the dock icon. */
const EXIT_MIN_SCALE = 0.05;

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

const COLUMN_QUERIES = [`(min-width: ${GRID_BREAKPOINTS.twoColumns}px)`, `(min-width: ${GRID_BREAKPOINTS.fourColumns}px)`] as const;

function readColumns(): GridColumns {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return 4;
  if (window.matchMedia(COLUMN_QUERIES[1]).matches) return 4;
  if (window.matchMedia(COLUMN_QUERIES[0]).matches) return 2;
  return 1;
}

/**
 * The canvas column count for the window, from GRID_BREAKPOINTS. `onChange`
 * (for example the store's setColumns) runs in a layout effect, so the first
 * paint is already packed for the right count.
 */
export function useCanvasColumns(onChange?: (columns: GridColumns) => void): GridColumns {
  const [columns, setColumns] = useState<GridColumns>(readColumns);
  useLayoutEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const lists = COLUMN_QUERIES.map((q) => window.matchMedia(q));
    const update = () => setColumns(readColumns());
    for (const l of lists) l.addEventListener("change", update);
    update();
    return () => {
      for (const l of lists) l.removeEventListener("change", update);
    };
  }, []);
  const latest = useRef(onChange);
  latest.current = onChange;
  useLayoutEffect(() => {
    latest.current?.(columns);
  }, [columns]);
  return columns;
}

// ---------------------------------------------------------------------------
// A card
// ---------------------------------------------------------------------------

/** What the canvas tells the app about the user's hands. Every callback is optional. */
export interface CanvasEvents<P extends string> {
  /** The pointer is over a card (`down`: a button is pressed), or over none. */
  onPointer?: (panel: P | null, down: boolean) => void;
  /** The pointer or keyboard focus entered (true) or left (false) the canvas. */
  onCanvasHold?: (source: "pointer" | "keyboard", active: boolean) => void;
  /** The user moved into a card that was not the focused one. */
  onFocusPanel?: (panel: P, via: "pointer" | "keyboard") => void;
  /** The pointer rested on a card for at least DWELL_MIN_MS (capped at DWELL_MAX_MS). */
  onDwell?: (panel: P, durationMs: number) => void;
}

/** What a leaving card reads when its exit starts (AnimatePresence's `custom`). */
interface ExitContext {
  staged: boolean;
  reduceMotion: boolean;
}

/** An element's box on screen without any transform on it (offsets ignore transforms). */
function untransformedRect(el: HTMLElement): { left: number; top: number; width: number; height: number } {
  let left = 0;
  let top = 0;
  let node: HTMLElement | null = el;
  while (node) {
    const parent = node.offsetParent as HTMLElement | null;
    if (!parent) {
      const r = node.getBoundingClientRect();
      left += r.left;
      top += r.top;
      break;
    }
    left += node.offsetLeft + parent.clientLeft;
    top += node.offsetTop + parent.clientTop;
    node = parent;
  }
  return { left, top, width: el.offsetWidth, height: el.offsetHeight };
}

/** Where a leaving card goes: in a staged round it shrinks into its dock icon, so the user sees where the panel went. */
function exitTarget(id: string, ctx: ExitContext | undefined): TargetAndTransition {
  if (ctx?.reduceMotion) return { opacity: 0, transition: { duration: REDUCED_FADE_MS / 1000 } };
  if (!ctx?.staged) return { opacity: 0, scale: 0.97, transition: { duration: 0.16 } };
  const t = stageTransition(STAGE_EXIT);
  const card = document.querySelector<HTMLElement>(`[${PANEL_ATTR}="${id}"]`);
  const icon = document.querySelector<HTMLElement>(`[${DOCK_ID_ATTR}="${id}"]`);
  const drop: TargetAndTransition = { opacity: 0, y: EXIT_DROP_PX, zIndex: 3, transition: t };
  if (!card || !icon) return drop;
  const from = untransformedRect(card);
  const to = untransformedRect(icon);
  if (from.width === 0 || from.height === 0 || to.width === 0) return drop;
  const scale = Math.max(EXIT_MIN_SCALE, Math.min(to.width / from.width, to.height / from.height));
  return {
    x: to.left + to.width / 2 - (from.left + from.width / 2),
    y: to.top + to.height / 2 - (from.top + from.height / 2),
    scale,
    opacity: 0,
    zIndex: 3,
    // Visible for the flight, gone as it lands.
    transition: { ...t, opacity: { ...t, delay: t.delay + t.duration / 2, duration: t.duration / 2 } },
  };
}

export interface PanelCardProps<P extends string, K extends string> extends Pick<CanvasEvents<P>, "onPointer" | "onFocusPanel" | "onDwell"> {
  placement: PanelPlacement<P, K>;
  /** The card's cell when the plan is packed for the canvas's column count. Absent: it flows, spanning its size. */
  cell?: GridCell;
  columns: GridColumns;
  /** This card's part in the round. Absent: the round is not staged (it springs). */
  cue?: CardCue;
  focused: boolean;
  reduceMotion: boolean;
  className?: string;
  children: ReactNode;
  /** Forwarded so AnimatePresence's popLayout can measure the card. */
  ref?: Ref<HTMLElement>;
}

export function PanelCard<P extends string, K extends string>(props: PanelCardProps<P, K>) {
  const { placement: p, cell, cue, reduceMotion } = props;
  const enteredAt = useRef<number | null>(null);
  const span = spanOf(p.size, props.columns);
  const place: CSSProperties = cell
    ? { gridColumn: `${cell.col + 1} / span ${cell.w}`, gridRow: `${cell.row + 1} / span ${cell.h}` }
    : { gridColumn: `span ${Math.min(span.w, props.columns)}`, gridRow: `span ${span.h}` };

  const entering = cue?.role === "entering";
  const layoutTransition = reduceMotion ? { duration: 0 } : cue ? stageTransition(entering ? STAGE_MOVE : cue.stage) : PANEL_SPRING;
  const offset = entering && cue?.from ? { x: -cue.from.x * ENTER_OFFSET_PX, y: -cue.from.y * ENTER_OFFSET_PX } : { x: 0, y: 0 };
  const initial = reduceMotion ? { opacity: 0 } : entering ? { opacity: 0, scale: ENTER_SCALE, ...offset } : { opacity: 0, scale: 0.97 };
  const transition = reduceMotion
    ? { duration: REDUCED_FADE_MS / 1000, layout: { duration: 0 } }
    : entering && cue
      ? { ...stageTransition(cue.stage), layout: layoutTransition }
      : { ...PANEL_SPRING, opacity: { duration: 0.18 }, layout: layoutTransition };
  const variants = useMemo(() => ({ exit: (ctx: ExitContext | undefined) => exitTarget(p.id, ctx) }), [p.id]);
  const focus = (via: "pointer" | "keyboard") => {
    if (!props.focused) props.onFocusPanel?.(p.id, via);
  };

  return (
    <motion.section
      ref={props.ref}
      {...{ [PANEL_ATTR]: p.id }}
      data-size={p.size}
      {...(p.anchor ? { "data-anchor": "" } : {})}
      {...(p.relation ? { "data-linked": "" } : {})}
      {...(p.change ? { "data-change": p.change } : {})}
      className={props.className}
      layout={!reduceMotion}
      initial={initial}
      animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
      variants={variants}
      exit="exit"
      transition={transition}
      // Set inline so motion can correct the radius while the card scales; the anchor sits above the cards moving around it.
      style={{ borderRadius: 12, minWidth: 0, minHeight: 0, ...(p.anchor ? { zIndex: 2 } : {}), ...place }}
      onPointerEnter={(e) => {
        enteredAt.current = null;
        if (e.pointerType !== "touch") props.onPointer?.(p.id, e.buttons > 0);
      }}
      onPointerMove={(e) => {
        // Layout changes under a still pointer produce moves with no movement; those are not interest.
        if (e.pointerType === "touch" || enteredAt.current !== null || (e.movementX === 0 && e.movementY === 0)) return;
        enteredAt.current = Date.now();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch") props.onPointer?.(null, false);
        const start = enteredAt.current;
        enteredAt.current = null;
        if (start === null) return;
        const durationMs = Math.min(DWELL_MAX_MS, Date.now() - start);
        if (durationMs >= DWELL_MIN_MS) props.onDwell?.(p.id, durationMs);
      }}
      onPointerDown={() => {
        props.onPointer?.(p.id, true);
        focus("pointer");
      }}
      onPointerUp={(e) => props.onPointer?.(e.pointerType === "touch" ? null : p.id, false)}
      onFocus={(e) => {
        if (e.target instanceof HTMLElement && e.target.matches(":focus-visible")) focus("keyboard");
      }}
    >
      {props.children}
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------

export interface AdaptiveCanvasProps<P extends string, S extends CoreSuggestion, K extends string> extends CanvasEvents<P> {
  plan: LayoutPlan<P, S, K>;
  columns: GridColumns;
  /** The focused panel, so a click into it is not reported again. */
  focused?: P | null;
  /** The content of one card: its header and its panel. */
  renderCard: (placement: PanelPlacement<P, K>) => ReactNode;
  /** A class name for each card, for example from its size or relation. */
  cardClassName?: (placement: PanelPlacement<P, K>) => string | undefined;
  className?: string;
  /** Row track height in px. Default ROW_HEIGHT_PX. */
  rowHeight?: number;
  /** Gap between cards in px. Default 12. */
  gap?: number;
  /** Shown when every panel is in the dock. */
  empty?: ReactNode;
}

export function AdaptiveCanvas<P extends string, S extends CoreSuggestion, K extends string>(props: AdaptiveCanvasProps<P, S, K>) {
  const { plan, columns } = props;
  const reduceMotion = useReducedMotion() ?? false;
  const cues = useMemo(() => roundCues(plan), [plan]);
  const grid = plan.grid?.columns === columns ? plan.grid : undefined;
  const rowHeight = props.rowHeight ?? ROW_HEIGHT_PX;
  const exitContext: ExitContext = { staged: cues.staged, reduceMotion };
  const gridRef = useRef<HTMLDivElement>(null);
  const onCanvasHold = props.onCanvasHold;
  const blur = useCallback(() => {
    // Wait a tick: a re-plan may have moved the focused element.
    setTimeout(() => {
      if (gridRef.current?.contains(document.activeElement)) return;
      onCanvasHold?.("keyboard", false);
    }, 0);
  }, [onCanvasHold]);

  if (plan.placements.length === 0 && props.empty) return <>{props.empty}</>;
  return (
    <LayoutGroup>
      <div
        ref={gridRef}
        {...{ [CANVAS_ATTR]: "" }}
        className={props.className}
        style={{
          display: "grid",
          position: "relative",
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridAutoRows: `${rowHeight}px`,
          gap: props.gap ?? 12,
          ...(grid ? { gridTemplateRows: `repeat(${grid.rows}, ${rowHeight}px)` } : {}),
          // The browser's scroll anchoring could pick a card that moves; holding the anchor still is the canvas's job.
          overflowAnchor: "none",
        }}
        onPointerEnter={(e) => {
          if (e.pointerType !== "touch") onCanvasHold?.("pointer", true);
        }}
        onPointerLeave={() => onCanvasHold?.("pointer", false)}
        onFocus={(e) => {
          const el = e.target as HTMLElement;
          onCanvasHold?.("keyboard", !isTextField(el) && el.matches(":focus-visible"));
        }}
        onBlur={blur}
      >
        <AnimatePresence mode="popLayout" initial={false} custom={exitContext}>
          {plan.placements.map((p) => (
            <PanelCard
              key={p.id}
              placement={p}
              {...(grid?.cells[p.id] ? { cell: grid.cells[p.id] } : {})}
              columns={columns}
              {...(cues.staged ? { cue: cueFor(cues, p.id) } : {})}
              focused={props.focused === p.id}
              reduceMotion={reduceMotion}
              className={props.cardClassName?.(p)}
              {...(props.onPointer ? { onPointer: props.onPointer } : {})}
              {...(props.onFocusPanel ? { onFocusPanel: props.onFocusPanel } : {})}
              {...(props.onDwell ? { onDwell: props.onDwell } : {})}
            >
              {props.renderCard(p)}
            </PanelCard>
          ))}
        </AnimatePresence>
      </div>
    </LayoutGroup>
  );
}

// ---------------------------------------------------------------------------
// The dock and the change line
// ---------------------------------------------------------------------------

export interface DockProps<P extends string> {
  docked: readonly P[];
  /** A docked panel's label (its title). */
  label: (panel: P) => string;
  onOpen: (panel: P) => void;
  /** What a dock item shows. Default: its label. */
  renderItem?: (panel: P) => ReactNode;
  className?: string;
  itemClassName?: string;
  /** Shown before the items. Default "Dock". */
  title?: ReactNode;
}

/** The panels that are not on the canvas. A leaving card flies into its item here (data-dock-id). */
export function Dock<P extends string>(props: DockProps<P>) {
  const reduceMotion = useReducedMotion() ?? false;
  return (
    <motion.nav layout={!reduceMotion} transition={PANEL_SPRING} className={props.className} aria-label="Dock">
      <motion.span layout={reduceMotion ? false : "position"}>{props.title ?? "Dock"}</motion.span>
      <AnimatePresence initial={false} mode="popLayout">
        {props.docked.map((id) => (
          <motion.span
            key={id}
            {...{ [DOCK_ID_ATTR]: id }}
            layout={!reduceMotion}
            initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.6, transition: { duration: 0.14 } }}
            transition={{ type: "spring", stiffness: 420, damping: 30 }}
            style={{ display: "inline-flex" }}
          >
            <button type="button" className={props.itemClassName} title={`Bring back ${props.label(id)}`} onClick={() => props.onOpen(id)}>
              {props.renderItem ? props.renderItem(id) : props.label(id)}
            </button>
          </motion.span>
        ))}
      </AnimatePresence>
    </motion.nav>
  );
}

export interface ChangeLineProps<P extends string> {
  decisions: readonly Decision<P>[];
  /** Lines shown before "+N more". Default 2. */
  max?: number;
  onUndo?: () => void;
  className?: string;
}

/**
 * What the last round changed, in one line, with Undo. A later round that
 * changes nothing (no decisions) keeps the last change on screen. Screen
 * readers hear it as it changes.
 */
export function ChangeLine<P extends string>(props: ChangeLineProps<P>) {
  const max = props.max ?? 2;
  const [last, setLast] = useState<readonly Decision<P>[]>(props.decisions);
  if (props.decisions.length > 0 && props.decisions !== last) setLast(props.decisions);
  const lines = (props.decisions.length > 0 ? props.decisions : last).map((d) => d.text);
  const shown = lines.slice(0, max).join("; ");
  const more = lines.length - max;
  return (
    <span className={props.className} aria-live="polite">
      {shown}
      {more > 0 ? <span title={lines.slice(max).join("\n")}>{` +${more} more`}</span> : null}
      {props.onUndo ? (
        <button type="button" onClick={props.onUndo}>
          Undo
        </button>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Binding a library store
// ---------------------------------------------------------------------------

/**
 * The canvas props for a store from createAdaptiveStore: the plan, the
 * columns, the focused panel, and the events wired to the store (pointer,
 * holds, focus, pointer rests). Also keeps the store's column count in step
 * with the window.
 */
export function useStoreCanvas<P extends string, G extends string, S extends CoreSuggestion, K extends string, J, T extends string>(
  store: AdaptiveStore<P, G, S, K, J, T>,
): Pick<AdaptiveCanvasProps<P, S, K>, "plan" | "columns" | "focused" | "onPointer" | "onCanvasHold" | "onFocusPanel" | "onDwell"> {
  useCanvasColumns(store.setColumns);
  const plan = useAdaptive(store, (s) => s.plan);
  const columns = useAdaptive(store, (s) => s.columns);
  const focused = useAdaptive(store, (s) => s.focusedPanel);
  return {
    plan,
    columns,
    focused,
    onPointer: (panel, down) => store.setPointer({ panel, down }),
    onCanvasHold: (source, active) => {
      store.setCanvasHold(source, active);
      if (source === "pointer" && !active) store.setPointer({ panel: null, down: false });
    },
    onFocusPanel: (panel, via) => {
      store.setFocused(panel);
      store.track({ type: "panel_focus", panel, detail: { via } });
    },
    onDwell: (panel, durationMs) => store.track({ type: "panel_dwell", panel, detail: { durationMs } }),
  };
}
