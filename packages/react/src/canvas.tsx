/**
 * The adaptive canvas for React: a grid that shows a layout plan, with every
 * card in the cell the plan gives it (so the panel the user just worked in
 * holds still) and every change staged so the eye can follow it: the anchor
 * grows first, leaving cards fly into their dock icon, moved cards glide,
 * and new cards arrive one at a time from the anchor's side (roundCues and
 * the stage timing in @attune/core, choreography.ts). Reduced motion turns
 * every move into a short fade.
 *
 * Around the plan the canvas keeps the calm relayout rules on screen:
 *   - keyboard focus (and a text field's caret) stays on the element it was
 *     on when a re-plan moves it,
 *   - while a panel holds still (`holdStill`, the live work anchor), the grid
 *     keeps its rows and a safety net scrolls by any shift of that card, so
 *     the panel the user works in never moves on screen,
 *   - a card the user docked with the pointer on the canvas leaves an empty
 *     slot (a ghost) until the pointer leaves or the layout changes, so the
 *     next click lands where the user aimed (useCanvasEdit().noteDismiss),
 *   - a panel a pin or "Make bigger" sent to the front (`toFront`) is
 *     followed once: the page scrolls to the canvas top when the front is out
 *     of view, and the card rings when it lands (FRONT_RING_MS),
 *   - quiet cards (`quiet`) show faded and light up at once on hover or focus.
 *
 * The components draw no look of their own: only the layout they need
 * (grid tracks, cells, the anchor above the cards moving around it). Style
 * them with class names and these attributes:
 *   data-canvas on the grid; data-panel, data-size, data-anchor, data-linked,
 *   data-change, data-quiet ("faded" or "lit"), and data-front-ring on each
 *   card; data-ghost on a docked card's empty slot; data-dock-id on each
 *   dock item. An app can draw each card itself (`card`) around PanelCard,
 *   and read the card's motion with usePanelCard().
 *
 * One rule the app's CSS needs: a card leaving the packed grid is popped
 * out of the flow (motion's popLayout), and its own grid lines would shift
 * it by a cell before it flies to the dock, so give
 * `[data-canvas] > [data-motion-pop-id]` `grid-area: auto !important`.
 */
import {
  cellsOverlap,
  cueFor,
  ENTER_OFFSET_PX,
  ENTER_SCALE,
  FRONT_RING_MS,
  GRID_BREAKPOINTS,
  MANUAL_EDIT_HOLD_MS,
  QUIET_FADE_MS,
  QUIET_LIGHT_MS,
  QUIET_OPACITY,
  QUIET_SATURATE,
  REDUCED_FADE_MS,
  roundCues,
  spanOf,
  STAGE_EXIT,
  STAGE_MOVE,
  stageTransition,
  unstaged,
  type AdaptiveSpec,
  type AdaptiveStore,
  type CardCue,
  type CoreSuggestion,
  type Decision,
  type GridCell,
  type GridColumns,
  type LayoutPlan,
  type PanelPlacement,
  type PanelSize,
  type RoundCues,
} from "@attune/core";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion, type TargetAndTransition, type Transition } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type CSSProperties,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { isTextField } from "./hooks.ts";
import { useAdaptive } from "./useAdaptive.ts";

export const CANVAS_ATTR = "data-canvas";
export const PANEL_ATTR = "data-panel";
export const DOCK_ID_ATTR = "data-dock-id";
/** On a quiet card: "faded" while it shows at quiet strength, "lit" while hover or focus brings it to full strength. */
export const QUIET_ATTR = "data-quiet";
/** On a card for FRONT_RING_MS after a pin or "Make bigger" sent it to the front, once it landed. */
export const FRONT_RING_ATTR = "data-front-ring";
/** On the empty slot a docked card leaves while the pointer stays on the canvas. */
export const GHOST_ATTR = "data-ghost";
/** On a card's own controls (pin, dock, tags): pressing or focusing them is not work in the panel, so it does not focus the panel. */
export const CARD_CONTROL_ATTR = "data-card-control";

/** One row track: half a standard card (CELL_SPANS in @attune/core). */
export const ROW_HEIGHT_PX = 104;
/** A pointer rest shorter than this is noise, not interest. */
export const DWELL_MIN_MS = 1_500;
/** Longest pointer rest reported: a card that slid under a resting pointer must not count as a long read. */
export const DWELL_MAX_MS = 15_000;
/** Space left between a sticky bar and the canvas top after the page follows a panel to the front. */
export const FRONT_SCROLL_GAP_PX = 8;

/** Cards spring into place when a round is not staged (a first plan, a reset). */
const PANEL_SPRING = { type: "spring", stiffness: 380, damping: 34 } as const;
/** A leaving card drops this far when it has no dock icon to fly into. */
const EXIT_DROP_PX = 12;
/** Smallest scale a leaving card shrinks to on its way into the dock icon. */
const EXIT_MIN_SCALE = 0.05;

// ---------------------------------------------------------------------------
// Columns and rounds
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

/**
 * The round's cues, fixed for the whole round. A later plan in the same
 * round (new suggestions only) carries an empty change summary, and must not
 * cut short the stages still playing. The first plan seen is the starting
 * layout, not a change.
 */
export function useRoundCues<P extends string>(plan: LayoutPlan<P, CoreSuggestion, string>): RoundCues<P> {
  const round = plan.round ?? 0;
  const [cues, setCues] = useState<RoundCues<P>>(() => unstaged<P>(round));
  if (round !== cues.round) {
    const next = roundCues(plan);
    setCues(next);
    return next;
  }
  return cues;
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

/**
 * Where a leaving card goes. In a staged round it shrinks into its dock
 * icon, so the user sees where the panel went; the icon's final place is
 * read from layout offsets, because the dock itself may still be animating.
 */
function exitTarget(id: string, ctx: ExitContext | undefined): TargetAndTransition {
  if (ctx?.reduceMotion) return { opacity: 0, transition: { duration: REDUCED_FADE_MS / 1000 } };
  if (!ctx?.staged) return { opacity: 0, scale: 0.97, transition: { duration: 0.16 } };
  const t = stageTransition(STAGE_EXIT);
  const card = document.querySelector<HTMLElement>(`[${PANEL_ATTR}="${id}"]`);
  const icon = document.querySelector<HTMLElement>(`[${DOCK_ID_ATTR}="${id}"]`);
  const drop: TargetAndTransition = { opacity: 0, y: EXIT_DROP_PX, zIndex: 3, transition: t };
  if (!card || !icon) return drop;
  // Both boxes without transforms: motion may resolve this again mid-flight,
  // and x/y are offsets from the card's own layout box.
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

function fromCardControl(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(`[${CARD_CONTROL_ATTR}]`) !== null;
}

/** A card's motion, for the parts inside it (usePanelCard). */
export interface PanelCardMotion {
  id: string;
  /** The transition for layout="position" parts (a header, a body), so they glide with the card instead of stretching. */
  layoutTransition: Transition;
  reduceMotion: boolean;
  /** This card's part in the round; absent when the round is not staged. */
  cue?: CardCue;
  /** When the card lands in this round, in ms from the round's start (0 when it is not staged or motion is reduced). */
  landsAtMs: number;
  round: number;
  /** Shows faded now: quiet, and neither hovered nor focused. */
  faded: boolean;
}

const PanelCardContext = createContext<PanelCardMotion | null>(null);

/** The motion of the card this element is in, or null outside a card. */
export function usePanelCard(): PanelCardMotion | null {
  return useContext(PanelCardContext);
}

/** The layout transition for a card's cue: its parts (layout="position") glide with it. */
export function cardLayoutTransition(cue: CardCue | undefined, reduceMotion: boolean): Transition {
  if (reduceMotion) return { duration: 0 };
  return cue ? stageTransition(cue.role === "entering" ? STAGE_MOVE : cue.stage) : PANEL_SPRING;
}

export interface PanelCardProps<P extends string, K extends string> extends Pick<CanvasEvents<P>, "onPointer" | "onFocusPanel" | "onDwell"> {
  placement: PanelPlacement<P, K>;
  /** The card's cell when the plan is packed for the canvas's column count. Absent: it flows, spanning its size. */
  cell?: GridCell;
  columns: GridColumns;
  /** This card's part in the round. Absent: the round is not staged (it springs). */
  cue?: CardCue;
  /** The plan's round. */
  round: number;
  focused: boolean;
  reduceMotion: boolean;
  /** The live anchor's card: it sits above the cards moving around it. Default: the plan's anchor flag. */
  anchor?: boolean;
  /** Shows as quiet now: faded, and at full strength at once on hover or focus. Never a change of size or place. */
  quiet?: boolean;
  /** Rings the card (data-front-ring): a pin or "Make bigger" sent it to the front and it landed. */
  ring?: boolean;
  className?: string;
  /** Corner radius in px, set inline so motion keeps it round while the card scales. Default 12. */
  radius?: number;
  /** The id of the card's title, for its accessible name. */
  labelledBy?: string;
  /** A press in the card (any element, controls too). */
  onPress?: (target: EventTarget | null) => void;
  /** Focus moved to an element in the card (controls too). */
  onFocusInside?: (target: EventTarget | null) => void;
  children: ReactNode;
  /** Forwarded so AnimatePresence's popLayout can measure the card. */
  ref?: Ref<HTMLElement>;
}

export function PanelCard<P extends string, K extends string>(props: PanelCardProps<P, K>) {
  const { placement: p, cell, cue, reduceMotion, quiet = false } = props;
  const enteredAt = useRef<number | null>(null);
  const hovered = useRef(false);
  const cardRef = useRef<HTMLElement | null>(null);
  const outerRef = props.ref;
  const setRef = useCallback(
    (el: HTMLElement | null) => {
      cardRef.current = el;
      if (typeof outerRef === "function") outerRef(el);
      else if (outerRef) outerRef.current = el;
    },
    [outerRef],
  );
  const span = spanOf(p.size, props.columns);
  const place: CSSProperties = cell
    ? { gridColumn: `${cell.col + 1} / span ${cell.w}`, gridRow: `${cell.row + 1} / span ${cell.h}` }
    : { gridColumn: `span ${Math.min(span.w, props.columns)}`, gridRow: `span ${span.h}` };
  const anchor = props.anchor ?? Boolean(p.anchor);

  // Focus is reported only when the focused panel changes. A ref, not the
  // prop, because pointerdown and focusin fire in one gesture before a re-render.
  const lastFocused = useRef(props.focused);
  useEffect(() => {
    lastFocused.current = props.focused;
  }, [props.focused]);
  const focus = (via: "pointer" | "keyboard") => {
    if (lastFocused.current) return;
    lastFocused.current = true;
    props.onFocusPanel?.(p.id, via);
  };

  // A card that leaves the canvas under the pointer fires no pointerleave.
  const onPointer = useRef(props.onPointer);
  onPointer.current = props.onPointer;
  useEffect(
    () => () => {
      if (hovered.current) onPointer.current?.(null, false);
    },
    [],
  );

  // Quiet: full strength while the pointer or focus is in it.
  const [lit, setLit] = useState(false);
  const faded = quiet && !lit;

  const entering = cue?.role === "entering";
  const layoutTransition = cardLayoutTransition(cue, reduceMotion);
  const offset = entering && cue?.from ? { x: -cue.from.x * ENTER_OFFSET_PX, y: -cue.from.y * ENTER_OFFSET_PX } : { x: 0, y: 0 };
  const initial = reduceMotion ? { opacity: 0 } : entering ? { opacity: 0, scale: ENTER_SCALE, ...offset } : { opacity: 0, scale: 0.97 };
  const base: Transition = reduceMotion
    ? { duration: REDUCED_FADE_MS / 1000, layout: { duration: 0 } }
    : entering && cue
      ? { ...stageTransition(cue.stage), layout: layoutTransition }
      : { ...PANEL_SPRING, opacity: { duration: 0.18 }, layout: layoutTransition };
  // A quiet card fades slowly and lights up at once; only opacity and color change.
  const quietTiming = { duration: (faded ? QUIET_FADE_MS : QUIET_LIGHT_MS) / 1000 };
  const transition = quiet ? { ...base, opacity: quietTiming, filter: quietTiming } : base;
  const variants = useMemo(() => ({ exit: (ctx: ExitContext | undefined) => exitTarget(p.id, ctx) }), [p.id]);
  const landsAtMs = reduceMotion || !cue ? 0 : cue.stage.delayMs + cue.stage.durationMs;
  const motionCtx = useMemo<PanelCardMotion>(
    () => ({ id: p.id, layoutTransition, reduceMotion, ...(cue ? { cue } : {}), landsAtMs, round: props.round, faded }),
    // layoutTransition follows cue and reduceMotion.
    [p.id, cue, reduceMotion, landsAtMs, props.round, faded],
  );

  return (
    <motion.section
      ref={setRef}
      {...(props.labelledBy ? { "aria-labelledby": props.labelledBy } : {})}
      {...{ [PANEL_ATTR]: p.id }}
      data-size={p.size}
      {...(anchor ? { "data-anchor": "true" } : {})}
      {...(p.relation ? { "data-linked": "" } : {})}
      {...(p.change ? { "data-change": p.change } : {})}
      {...(quiet ? { [QUIET_ATTR]: faded ? "faded" : "lit" } : {})}
      {...(props.ring ? { [FRONT_RING_ATTR]: "" } : {})}
      className={props.className}
      layout={!reduceMotion}
      initial={initial}
      animate={{ opacity: faded ? QUIET_OPACITY : 1, scale: 1, x: 0, y: 0, ...(quiet ? { filter: `saturate(${faded ? QUIET_SATURATE : 1})` } : {}) }}
      variants={variants}
      exit="exit"
      transition={transition}
      // Set inline so motion can correct the radius while the card scales; the anchor sits above the cards moving around it.
      style={{ borderRadius: props.radius ?? 12, minWidth: 0, minHeight: 0, ...(anchor ? { zIndex: 2 } : {}), ...place }}
      onPointerEnter={(e) => {
        enteredAt.current = null;
        if (e.pointerType === "touch") return;
        hovered.current = true;
        props.onPointer?.(p.id, e.buttons > 0);
        setLit(true);
      }}
      onPointerMove={(e) => {
        // Layout changes under a still pointer produce moves with no movement; those are not interest.
        if (e.pointerType === "touch" || enteredAt.current !== null || (e.movementX === 0 && e.movementY === 0)) return;
        enteredAt.current = Date.now();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch") {
          hovered.current = false;
          props.onPointer?.(null, false);
        }
        // Keyboard focus inside keeps it lit.
        if (!cardRef.current?.contains(document.activeElement)) setLit(false);
        const start = enteredAt.current;
        enteredAt.current = null;
        if (start === null) return;
        const durationMs = Math.min(DWELL_MAX_MS, Date.now() - start);
        if (durationMs >= DWELL_MIN_MS) props.onDwell?.(p.id, durationMs);
      }}
      onPointerDown={(e) => {
        props.onPointer?.(p.id, true);
        props.onPress?.(e.target);
        if (!fromCardControl(e.target)) focus("pointer");
      }}
      // Touch has no hover: once the finger lifts, the pointer is nowhere.
      onPointerUp={(e) => props.onPointer?.(e.pointerType === "touch" ? null : p.id, false)}
      onPointerCancel={() => props.onPointer?.(null, false)}
      onFocus={(e) => {
        setLit(true);
        props.onFocusInside?.(e.target);
        if (!fromCardControl(e.target)) focus("keyboard");
      }}
      onBlur={(e) => {
        // Focus left the card (not just moved inside it), and the pointer is not over it.
        const to = e.relatedTarget;
        if (to instanceof Node && cardRef.current?.contains(to)) return;
        if (!cardRef.current?.matches(":hover")) setLit(false);
      }}
    >
      <PanelCardContext.Provider value={motionCtx}>{props.children}</PanelCardContext.Provider>
    </motion.section>
  );
}

// ---------------------------------------------------------------------------
// The canvas
// ---------------------------------------------------------------------------

/** Lets a card's dock button hold its slot for a moment (see the ghost in AdaptiveCanvas). */
export interface CanvasEdit<P extends string> {
  /** The user is about to dock `panel` from its card: with the pointer on the canvas, its slot stays empty until the pointer leaves or the layout changes. */
  noteDismiss(panel: P): void;
}

const CanvasEditContext = createContext<CanvasEdit<string> | null>(null);

/** The canvas's edit helpers, for a card's controls. Null outside AdaptiveCanvas. */
export function useCanvasEdit<P extends string>(): CanvasEdit<P> | null {
  return useContext(CanvasEditContext) as CanvasEdit<P> | null;
}

export interface AdaptiveCanvasProps<P extends string, S extends CoreSuggestion, K extends string> extends CanvasEvents<P> {
  plan: LayoutPlan<P, S, K>;
  columns: GridColumns;
  /** The focused panel, so a click into it is not reported again. */
  focused?: P | null;
  /** The content of one card: its header and its panel (or, with `card`, what the card wraps). */
  renderCard: (placement: PanelPlacement<P, K>) => ReactNode;
  /** Draws each card around PanelCard (pass the props through). Default: PanelCard. */
  card?: ComponentType<PanelCardProps<P, K>>;
  /** A class name for each card, for example from its size or relation (the default card only). */
  cardClassName?: (placement: PanelPlacement<P, K>) => string | undefined;
  /** Whether a card shows quiet now. Absent: none. */
  quiet?: (placement: PanelPlacement<P, K>) => boolean;
  /** The live anchor's panel: its card sits above the others. Absent: the plan's anchor flags. */
  anchorPanel?: P | null;
  /**
   * The panel that must hold still on screen (the live work anchor), or
   * null. While set, the grid keeps its rows and the page scrolls by any
   * shift of that card, and the browser's own scroll anchoring is off.
   */
  holdStill?: P | null;
  /** The panel a pin or "Make bigger" sent to the front, in which round, and a new `at` for each move. */
  toFront?: { panel: P; round: number; at: number } | null;
  /** The bottom of anything sticky over the page top (an app bar), in window px, for following a panel to the front. */
  stickyTop?: () => number;
  /** What to scroll to the top when following a panel to the front. Default: the grid. */
  scrollTarget?: RefObject<HTMLElement | null>;
  /** The round's cues, when the app tracks them itself (useRoundCues). Default: the canvas's own. */
  cues?: RoundCues<P>;
  /** Drawn inside the grid after the cards, for example link lines (positioned against the grid). */
  overlay?: (grid: RefObject<HTMLDivElement | null>) => ReactNode;
  className?: string;
  /** A class name for a docked card's empty slot. */
  ghostClassName?: string;
  id?: string;
  /** Row track height: px, or a CSS length such as "var(--row)". Default ROW_HEIGHT_PX. */
  rowHeight?: number | string;
  /** Gap between cards: px, or a CSS length. Default 12. */
  gap?: number | string;
  /** Shown after the grid when every panel is in the dock. */
  empty?: ReactNode;
}

interface Ghost<P extends string> {
  id: P;
  index: number;
  size: PanelSize;
  /** The card's cell when the plan was packed; the ghost holds exactly that spot. */
  cell: GridCell | null;
  /** The layout right after the card left, so any later change clears the ghost. */
  signature: string | null;
}

/** Focus and caret inside the grid, read before a commit moves anything. */
interface SavedFocus {
  el: HTMLElement;
  start: number | null;
  end: number | null;
}

function cssLength(v: number | string): string {
  return typeof v === "number" ? `${v}px` : v;
}

/** What is on screen: the cards, their sizes, and their cells. */
function layoutKey<P extends string>(plan: LayoutPlan<P, CoreSuggestion, string>): string {
  const cells = plan.grid?.cells;
  return plan.placements.map((p) => `${p.id}:${p.size}:${cells?.[p.id] ? `${cells[p.id]!.col},${cells[p.id]!.row}` : ""}`).join("|");
}

/** Where a card's top edge is in the window, from layout offsets (a card mid-animation is transformed). */
function cardTop(grid: HTMLElement | null, id: string): number | null {
  const card = grid?.querySelector<HTMLElement>(`:scope > [${PANEL_ATTR}="${id}"]`);
  if (!grid || !card) return null;
  return grid.getBoundingClientRect().top + grid.clientTop + card.offsetTop;
}

/**
 * Row tracks the grid keeps while a panel holds still: never fewer than the
 * most it has shown since. A shorter page would clamp the window scroll and
 * move the anchor up; the rows come back when the hold ends.
 */
function useRowFloor(rows: number, hold: boolean, columns: GridColumns): number {
  const [floor, setFloor] = useState({ rows, columns });
  const next = hold && floor.columns === columns ? Math.max(floor.rows, rows) : rows;
  if (next !== floor.rows || floor.columns !== columns) setFloor({ rows: next, columns });
  return next;
}

function cellOrder<P extends string>(cells: Partial<Record<P, GridCell>>) {
  return (a: P, b: P): number => {
    const ca = cells[a];
    const cb = cells[b];
    if (!ca || !cb) return ca ? -1 : cb ? 1 : 0;
    return ca.row - cb.row || ca.col - cb.col;
  };
}

export function AdaptiveCanvas<P extends string, S extends CoreSuggestion, K extends string>(props: AdaptiveCanvasProps<P, S, K>) {
  const { plan, columns } = props;
  const reduceMotion = useReducedMotion() ?? false;
  const ownCues = useRoundCues<P>(plan);
  const cues = props.cues ?? ownCues;
  const grid = plan.grid?.columns === columns ? plan.grid : undefined;
  const rowHeight = cssLength(props.rowHeight ?? ROW_HEIGHT_PX);
  const gridRef = useRef<HTMLDivElement>(null);
  const pointerInside = useRef(false);
  const lastFocused = useRef<Element | null>(null);
  const onCanvasHold = props.onCanvasHold;
  const holdStill = props.holdStill ?? null;
  const Card = props.card ?? PanelCard;

  // --- Keep focus through a re-plan (read in render, before the commit). ---
  const saved = useRef<SavedFocus | null>(null);
  if (typeof document !== "undefined") {
    const a = document.activeElement;
    if (a instanceof HTMLElement && gridRef.current?.contains(a)) {
      const input = a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement ? a : null;
      saved.current = { el: a, start: input?.selectionStart ?? null, end: input?.selectionEnd ?? null };
    } else {
      saved.current = null;
    }
  }
  useLayoutEffect(() => {
    const s = saved.current;
    if (!s || document.activeElement === s.el) return;
    // Focus went somewhere on purpose (a dialog, the command bar): leave it.
    if (document.activeElement && document.activeElement !== document.body) return;
    if (!s.el.isConnected || !gridRef.current?.contains(s.el)) return;
    s.el.focus({ preventScroll: true });
    if ((s.el instanceof HTMLInputElement || s.el instanceof HTMLTextAreaElement) && s.start !== null && s.end !== null) {
      try {
        s.el.setSelectionRange(s.start, s.end);
      } catch {
        // Some input types do not support selection.
      }
    }
  }, [plan]);

  // --- Keep the held panel still on screen (a safety net). -----------------
  // The packer keeps the anchor's cell, so this is normally a no-op. If
  // something did push the card, scroll by the same amount in the same
  // frame. Read in render, while the DOM still shows the old layout.
  const toFront = props.toFront ?? null;
  const frontRound = toFront !== null && toFront.round === (plan.round ?? 0);
  const heldTop = useRef<{ id: P; top: number } | null>(null);
  if (typeof document !== "undefined") {
    const top = holdStill ? cardTop(gridRef.current, holdStill) : null;
    heldTop.current = holdStill && top !== null ? { id: holdStill, top } : null;
  }
  useLayoutEffect(() => {
    const before = heldTop.current;
    // A pin or "Make bigger" moved cards to the front on purpose; the page follows that panel instead.
    if (!before || frontRound) return;
    const after = cardTop(gridRef.current, before.id);
    if (after === null) return;
    const diff = after - before.top;
    if (Math.abs(diff) >= 1) window.scrollBy({ top: diff, behavior: "instant" });
  }, [plan]);

  // --- Follow a panel a pin or "Make bigger" sent to the front. -------------
  // Once per move, in the round that made it: when the canvas top is out of
  // view, scroll the page to it (a jump with reduced motion), and ring the
  // card from when it lands, for FRONT_RING_MS. Timers live in a ref, so a
  // later render in the same round does not cut the ring short.
  const [ring, setRing] = useState<P | null>(null);
  const followed = useRef(0);
  const ringTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => ringTimers.current.forEach(clearTimeout), []);
  const stickyTop = props.stickyTop;
  const scrollTarget = props.scrollTarget;
  useEffect(() => {
    if (!toFront || toFront.at === followed.current || toFront.round !== (plan.round ?? 0)) return;
    followed.current = toFront.at;
    const el = gridRef.current;
    if (el) {
      const bar = Math.max(0, stickyTop?.() ?? 0);
      const top = el.getBoundingClientRect().top;
      if (top < bar || top > window.innerHeight) {
        const target = scrollTarget?.current ?? el;
        const to = Math.max(0, window.scrollY + target.getBoundingClientRect().top - bar - FRONT_SCROLL_GAP_PX);
        window.scrollTo({ top: to, behavior: reduceMotion ? "instant" : "smooth" });
      }
    }
    const cue = cueFor(cues, toFront.panel);
    const landsMs = reduceMotion || !cue ? 0 : cue.stage.delayMs + cue.stage.durationMs;
    for (const t of ringTimers.current) clearTimeout(t);
    ringTimers.current = [setTimeout(() => setRing(toFront.panel), landsMs), setTimeout(() => setRing(null), landsMs + FRONT_RING_MS)];
  }, [toFront, plan.round, cues, reduceMotion, stickyTop, scrollTarget]);

  // --- The slot of a card the user just docked stays until the pointer leaves. ---
  const [ghost, setGhost] = useState<Ghost<P> | null>(null);
  const planRef = useRef(plan);
  planRef.current = plan;
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const edit = useMemo<CanvasEdit<string>>(
    () => ({
      noteDismiss(id) {
        if (!pointerInside.current) return;
        const p = planRef.current;
        const index = p.placements.findIndex((x) => x.id === id);
        const cell = p.grid && p.grid.columns === columnsRef.current ? (p.grid.cells[id as P] ?? null) : null;
        if (index >= 0) setGhost({ id: id as P, index, size: p.placements[index].size, cell, signature: null });
      },
    }),
    [],
  );
  const signature = layoutKey(plan);
  useEffect(() => {
    if (!ghost) return;
    const gone = !plan.placements.some((p) => p.id === ghost.id);
    if (gone && ghost.signature === null) setGhost({ ...ghost, signature });
    else if (ghost.signature !== null && ghost.signature !== signature) setGhost(null);
  }, [ghost, plan.placements, signature]);
  useEffect(() => {
    if (!ghost) return;
    const t = setTimeout(() => setGhost(null), MANUAL_EDIT_HOLD_MS);
    return () => clearTimeout(t);
  }, [ghost]);

  // Leaving the page with a hold on must not leave the app waiting.
  const holdRef = useRef(onCanvasHold);
  holdRef.current = onCanvasHold;
  useEffect(
    () => () => {
      holdRef.current?.("pointer", false);
      holdRef.current?.("keyboard", false);
    },
    [],
  );

  const blur = useCallback(() => {
    // Wait a tick: a re-plan may have moved the element and the focus restore refocuses it.
    setTimeout(() => {
      if (gridRef.current?.contains(document.activeElement)) return;
      lastFocused.current = null;
      onCanvasHold?.("keyboard", false);
    }, 0);
  }, [onCanvasHold]);

  const floorRows = useRowFloor(grid?.rows ?? 0, holdStill !== null, columns);
  // Stable, so a re-render does not make a leaving card re-aim mid-flight.
  const exitContext = useMemo<ExitContext>(() => ({ staged: cues.staged, reduceMotion }), [cues.staged, reduceMotion]);

  // DOM order follows the cells (row, then column), so Tab order matches the screen.
  const ordered = grid ? [...plan.placements].sort((a, b) => cellOrder(grid.cells)(a.id, b.id)) : plan.placements;
  const cards: ReactNode[] = ordered.map((p) => (
    <Card
      key={p.id}
      placement={p}
      {...(grid?.cells[p.id] ? { cell: grid.cells[p.id] } : {})}
      columns={columns}
      {...(cues.staged ? { cue: cueFor(cues, p.id) } : {})}
      round={cues.round}
      focused={props.focused === p.id}
      reduceMotion={reduceMotion}
      {...(props.anchorPanel !== undefined ? { anchor: props.anchorPanel === p.id } : {})}
      {...(props.quiet ? { quiet: props.quiet(p) } : {})}
      ring={ring === p.id}
      {...(props.cardClassName ? { className: props.cardClassName(p) } : {})}
      {...(props.onPointer ? { onPointer: props.onPointer } : {})}
      {...(props.onFocusPanel ? { onFocusPanel: props.onFocusPanel } : {})}
      {...(props.onDwell ? { onDwell: props.onDwell } : {})}
    >
      {props.renderCard(p)}
    </Card>
  ));

  const shownGhost = ghost && !plan.placements.some((p) => p.id === ghost.id) ? ghost : null;
  if (shownGhost) {
    const ghostProps = { "aria-hidden": true, [GHOST_ATTR]: "", "data-size": shownGhost.size, className: props.ghostClassName };
    if (grid) {
      // In the packed grid the ghost holds the card's own cell, unless a card was placed there.
      const c = shownGhost.cell;
      const taken = !c || Object.values<GridCell | undefined>(grid.cells).some((x) => x !== undefined && cellsOverlap(x, c));
      if (c && !taken) cards.push(<div key={`ghost-${shownGhost.id}`} {...ghostProps} style={{ gridColumn: `${c.col + 1} / span ${c.w}`, gridRow: `${c.row + 1} / span ${c.h}` }} />);
    } else {
      const s = spanOf(shownGhost.size, columns);
      cards.splice(
        Math.min(shownGhost.index, cards.length),
        0,
        <div key={`ghost-${shownGhost.id}`} {...ghostProps} style={{ gridColumn: `span ${Math.min(s.w, columns)}`, gridRow: `span ${s.h}` }} />,
      );
    }
  }

  return (
    <CanvasEditContext.Provider value={edit}>
      <LayoutGroup>
        <div
          ref={gridRef}
          {...(props.id ? { id: props.id } : {})}
          {...{ [CANVAS_ATTR]: "" }}
          className={props.className}
          style={{
            display: "grid",
            position: "relative",
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gridAutoRows: rowHeight,
            gridAutoFlow: "row dense",
            gap: cssLength(props.gap ?? 12),
            ...(grid && floorRows > 0 ? { gridTemplateRows: `repeat(${floorRows}, ${rowHeight})` } : {}),
            // The browser's scroll anchoring could pick a card that moves and shift
            // the page to keep that one still; the held panel is the canvas's to
            // keep, and so is following a panel sent to the front.
            ...(holdStill !== null || frontRound ? { overflowAnchor: "none" } : {}),
          }}
          onPointerEnter={(e) => {
            if (e.pointerType === "touch") return;
            pointerInside.current = true;
            onCanvasHold?.("pointer", true);
          }}
          onPointerLeave={() => {
            pointerInside.current = false;
            setGhost(null);
            onCanvasHold?.("pointer", false);
          }}
          onFocus={(e) => {
            const el = e.target as HTMLElement;
            // The focus restore puts focus back on the same element; that is not navigation.
            if (el === lastFocused.current) return;
            lastFocused.current = el;
            onCanvasHold?.("keyboard", !isTextField(el) && el.matches(":focus-visible"));
          }}
          onBlur={blur}
        >
          <AnimatePresence mode="popLayout" initial={false} custom={exitContext}>
            {cards}
          </AnimatePresence>
          {props.overlay?.(gridRef)}
        </div>
      </LayoutGroup>
      {plan.placements.length === 0 ? props.empty : null}
    </CanvasEditContext.Provider>
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
 * columns, the focused panel, the live anchor (its card stays on top and
 * holds still on screen), and the events wired to the store (pointer,
 * holds, focus, pointer rests). Also keeps the store's column count in step
 * with the window.
 */
export function useStoreCanvas<Sp extends AdaptiveSpec>(
  store: AdaptiveStore<Sp>,
): Pick<
  AdaptiveCanvasProps<Sp["panel"], Sp["suggestion"], Sp["kind"]>,
  "plan" | "columns" | "focused" | "anchorPanel" | "holdStill" | "onPointer" | "onCanvasHold" | "onFocusPanel" | "onDwell"
> {
  useCanvasColumns(store.setColumns);
  const plan = useAdaptive(store, (s) => s.plan);
  const columns = useAdaptive(store, (s) => s.columns);
  const focused = useAdaptive(store, (s) => s.focusedPanel);
  // The plan's anchor while it is the live one; a work anchor holds still.
  const anchorPanel = useAdaptive(store, (s) => (s.anchor && s.plan.anchor && s.anchor.at === s.plan.anchor.at ? s.anchor.panel : null));
  const holdStill = useAdaptive(store, (s) => (s.anchor && s.anchor.source !== "command" ? s.anchor.panel : null));
  return {
    plan,
    columns,
    focused,
    anchorPanel,
    holdStill,
    onPointer: (panel, down) => store.setPointer({ panel, down }),
    onCanvasHold: (source, active) => {
      store.setCanvasHold(source, active);
      if (source === "pointer" && !active) store.setPointer({ panel: null, down: false });
    },
    onFocusPanel: (panel, via) => {
      store.setFocused(panel);
      store.track({ type: "panel_focus", panel, detail: { via } } as Sp["input"]);
    },
    onDwell: (panel, durationMs) => store.track({ type: "panel_dwell", panel, detail: { durationMs } } as Sp["input"]),
  };
}
