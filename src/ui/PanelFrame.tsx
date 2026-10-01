/**
 * Card chrome shared by every panel, and the place where most passive
 * signals are captured (focus, pointer dwell, list scroll).
 *
 * The card is the motion element: `layout` makes it glide to its new grid
 * slot and size whenever the plan changes. Header and body use
 * layout="position" so their contents are scale-corrected instead of being
 * stretched while the card grows or shrinks.
 *
 * In an anchored round (docs/anchored-relayout.md) the card plays its part
 * of the round's choreography (its `cue`): the anchor grows first, a leaving
 * card flies into its dock icon, a moving card glides, a new card slides out
 * from the anchor's side. While the links show (they outlive the anchor
 * until the user clears them), a linked card shows a "Linked to ..." tag
 * with an x that removes that link, and its linked rows share the clicked
 * row's link tint. The linked card that holds the next step Jev read from the
 * clicked record ("Arrange linked panels by next step") says so instead, in a
 * stronger style: "Next: resend INV-1042".
 *
 * "Make bigger" (the button beside the pin, or a double-click on the title
 * area) makes the card the hero size until the user makes it smaller or
 * docks it; the engine keeps its top edge and moves the cards in its way.
 * With "Move pinned and bigger panels to the front" on, a pin or "Make
 * bigger" sends the card to the first cell instead, and the canvas rings it
 * (`ring`) once it lands.
 *
 * A quiet card (focus aid 1, docs/focus-aids.md) shows at QUIET_OPACITY and
 * a little desaturated, with a "Quiet" label; hover or keyboard focus inside
 * it brings full strength at once, with no layout change. Clicking into it
 * is the engine's business: it makes the panel normal again.
 */
import clsx from "clsx";
import { ArrowDownToLine, CornerDownRight, Info, Link2, Maximize2, Minimize2, Pin, X } from "lucide-react";
import { AnimatePresence, motion, type TargetAndTransition } from "motion/react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { PANELS, type PanelId } from "../../shared/catalog.ts";
import type { GridCell, PanelPlacement, PanelRelation, PanelSize } from "../../shared/types.ts";
import { moveToFrontOn } from "../engine/focusAids.ts";
import { SIZE_RANK } from "../engine/policy.ts";
import { useEngine } from "../engine/store.ts";
import {
  ENTER_OFFSET_PX,
  ENTER_SCALE,
  QUIET_FADE_MS,
  QUIET_LIGHT_MS,
  QUIET_OPACITY,
  QUIET_SATURATE,
  REDUCED_FADE_MS,
  STAGE_EXIT,
  STAGE_MOVE,
  stageTransition,
  type CardCue,
} from "./choreography.ts";
import { ANCHOR_ATTR, dockIconSelector, FRONT_RING_ATTR, LINK_ATTR, LINK_NEXT_ATTR, LINK_REMOVE_ATTR, LINK_TAG_ATTR, PANEL_ATTR, PANEL_HEADER_ATTR, QUIET_ATTR } from "./domHooks.ts";
import { useThrottleGate, useWindowKeydown } from "./hooks.ts";
import { panelIcon } from "./icons.ts";
import { anchorItem, LinkContext, revealInPanel, useLinks, useLiveAnchor, type LinkLookup, type LinkMark } from "./linking.tsx";

const PANEL_SPRING = { type: "spring", stiffness: 380, damping: 34 } as const;

const DWELL_MIN_MS = 1500;
/**
 * Longest pointer rest reported. A card that slid under a resting pointer was
 * logged as "about 42 seconds" of interest; past 15 s the number says more
 * about a mouse left alone than about the panel.
 */
const DWELL_MAX_MS = 15_000;
const SCROLL_GAP_MS = 3000;
/**
 * A scroll counts as the user's only this soon after they scrolled by hand
 * in the card: a wheel, a touch drag, a scrolling key, or a press on the
 * list's own scrollbar. A card that moves, grows, or shrinks resets or
 * clamps its list's scroll, and "Back to" swaps many cards at once; those
 * scrolls are the layout's, not navigation, so they must not reach Jev or
 * the navigation count in the Metrics tab.
 */
const USER_SCROLL_INPUT_MS = 1_000;
/** Keys that scroll a list. */
const SCROLL_KEYS: ReadonlySet<string> = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const FLASH_MS = 4000;
/**
 * A scroll this soon after the card revealed a linked row itself is ours,
 * not the user's, so it is not logged as a scroll signal.
 */
const OWN_SCROLL_MS = 300;
/**
 * Putting a list back after its link tint clears is a smooth scroll, which
 * Chrome and Safari finish within about half a second; its scroll events are
 * ours for this long.
 */
const RESTORE_SCROLL_MS = 700;
/** A card leaving with no dock icon to fly to drops this far as it fades. */
const EXIT_DROP_PX = 12;
/** Smallest scale a leaving card shrinks to on its way into the dock icon. */
const EXIT_MIN_SCALE = 0.05;
/** Space between a link tag and its x button (gap-0.5), counted when checking whether the whole tag fits. */
const REMOVE_GAP_PX = 2;

type FlashKind = "added" | "bigger" | "smaller" | "up" | "down";

/** One label per kind of change: a card that only moved down is not "Smaller". */
const CHANGE_TEXT: Record<FlashKind, string> = {
  added: "New",
  bigger: "Bigger",
  smaller: "Smaller",
  up: "Moved up",
  down: "Moved down",
};

/** Lets the canvas hold a card's slot for a moment after the user docks it (see Canvas). */
export const CanvasEditContext = createContext<{ noteDismiss: (id: PanelId) => void } | null>(null);

const SIZE_TEXT: Record<PanelSize, string> = {
  hero: "Main panel",
  large: "Wide",
  standard: "Standard",
  compact: "Summary only",
};

/** What AnimatePresence passes a leaving card (its `custom`), read when the exit starts. */
export interface ExitContext {
  /** The round that removed the card is staged: fly into the dock icon. */
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
function exitTarget(id: PanelId, ctx: ExitContext | undefined): TargetAndTransition {
  if (ctx?.reduceMotion) return { opacity: 0, transition: { duration: REDUCED_FADE_MS / 1000 } };
  if (!ctx?.staged) return { opacity: 0, scale: 0.97, transition: { duration: 0.16 } };
  const t = stageTransition(STAGE_EXIT);
  const card = document.querySelector<HTMLElement>(`[${PANEL_ATTR}="${id}"]`);
  const icon = document.querySelector<HTMLElement>(dockIconSelector(id));
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

interface PanelFrameProps {
  placement: PanelPlacement;
  reduceMotion: boolean;
  children: ReactNode;
  /** Forwarded so AnimatePresence mode="popLayout" can measure the card. */
  ref?: Ref<HTMLElement>;
  /** Explicit cell when the plan is packed for the canvas's column count; absent: the CSS dense flow. */
  cell?: GridCell;
  /** This card's part in the current round; absent when the round is not staged. */
  cue?: CardCue;
  /** The plan's round, so a reduced-motion fade restarts once per round. */
  round: number;
  /** The note attached to the anchor card ("Added Inbox for ..."). */
  note?: ReactNode;
  /** Shows as quiet now (focus aid 1): the plan marks it quiet and nothing since exempts it (shownQuiet in src/engine/quiet.ts). */
  quiet?: boolean;
  /** Rings the card: a pin or "Make bigger" just sent it to the front and it has landed (the canvas times it, FRONT_RING_MS). */
  ring?: boolean;
}

export function PanelFrame({ placement, reduceMotion, children, ref, cell, cue, round, note, quiet = false, ring = false }: PanelFrameProps) {
  const { id, size, pinned } = placement;
  const title = PANELS[id].title;
  const Icon = panelIcon(id);
  const titleId = useId();

  const { focusedPanel, track, setFocused, pin, unpin, dismiss, setPointer, removeLink, bigger, maximize, restore, toFront } = useEngine(
    useShallow((s) => ({
      focusedPanel: s.focusedPanel,
      track: s.track,
      setFocused: s.setFocused,
      pin: s.pin,
      unpin: s.unpin,
      dismiss: s.dismiss,
      setPointer: s.setPointer,
      removeLink: s.removeLink,
      bigger: s.bigger.includes(id),
      maximize: s.maximize,
      restore: s.restore,
      toFront: moveToFrontOn(s.settings),
    })),
  );
  const toggleBigger = (via: "pointer" | "keyboard") => (bigger ? restore(id, via) : maximize(id, via));

  // The card element, shared with AnimatePresence's ref (popLayout measures it).
  const cardRef = useRef<HTMLElement | null>(null);
  const setCardRef = useCallback(
    (el: HTMLElement | null) => {
      cardRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) ref.current = el;
    },
    [ref],
  );

  // --- Focus: report only when the focused panel actually changes. -------
  // A ref, not the store value, because pointerdown and focusin fire in the
  // same gesture before React re-renders.
  const lastFocused = useRef(focusedPanel);
  useEffect(() => {
    lastFocused.current = focusedPanel;
  }, [focusedPanel]);

  const markFocus = (via: "pointer" | "keyboard") => {
    if (lastFocused.current === id) return;
    lastFocused.current = id;
    setFocused(id);
    track({ type: "panel_focus", panel: id, detail: { via } });
  };

  const fromFrameControl = (target: EventTarget | null) =>
    target instanceof Element && target.closest("[data-frame-control]") !== null;

  // --- Pointer: the engine holds a card under the pointer still for a while. -
  // A card that leaves the canvas under the pointer fires no pointerleave.
  useEffect(
    () => () => {
      const p = useEngine.getState().pointer;
      if (p.panel === id) setPointer({ panel: null, down: false });
    },
    [id, setPointer],
  );

  // --- Dwell: pointer resting on the card. ---------------------------------
  // Timed from the first real pointer movement inside the card, not from
  // pointerenter: a card that slides under a still pointer fires pointerenter
  // too, and that is not interest.
  const enteredAt = useRef<number | null>(null);
  const canvasEdit = useContext(CanvasEditContext);

  // --- Scroll: at most one signal per panel every 3 s. --------------------
  // Native capture listener, because scroll does not bubble and every panel
  // scrolls its own inner list.
  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollGate = useThrottleGate(SCROLL_GAP_MS);
  /** Until when scroll events in this card come from our own reveal or restore. */
  const ownScrollUntil = useRef(0);
  /**
   * The list a link cue scrolled, where it was before, and whether the user
   * has since taken it as it is (scrolled it, pressed in it, or moved focus
   * into it): then it stays, so a row the user just clicked does not slide away.
   */
  const revealed = useRef<{ el: HTMLElement; top: number; kept: boolean } | null>(null);
  const keepRevealed = (target: EventTarget | null) => {
    const r = revealed.current;
    if (r && target instanceof Node && r.el.contains(target)) r.kept = true;
  };
  /** A restore still gliding back, so a new cue starts from where the user left the list. */
  const restoring = useRef<{ el: HTMLElement; top: number; until: number } | null>(null);
  /** When the user last used a wheel, touch, key, or press in this card's body (see USER_SCROLL_INPUT_MS). */
  const scrollInputAt = useRef(0);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const onInput = (e: Event) => {
      if (e instanceof KeyboardEvent && !SCROLL_KEYS.has(e.key)) return;
      // A press on a row is a click; only a press on the scrolling list itself (its scrollbar) scrolls.
      if (e.type === "pointerdown" && !(e.target instanceof Element && e.target.scrollHeight > e.target.clientHeight)) return;
      scrollInputAt.current = Date.now();
    };
    const onScroll = (e: Event) => {
      if (Date.now() < ownScrollUntil.current || Date.now() - scrollInputAt.current > USER_SCROLL_INPUT_MS) return;
      if (revealed.current && e.target === revealed.current.el) revealed.current.kept = true;
      if (scrollGate()) track({ type: "scroll", panel: id });
    };
    const inputs = ["wheel", "touchmove", "keydown", "pointerdown"] as const;
    for (const t of inputs) el.addEventListener(t, onInput, { capture: true, passive: true });
    el.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      for (const t of inputs) el.removeEventListener(t, onInput, { capture: true });
      el.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [id, scrollGate, track]);

  // --- Link cue: the clicked record and the records linked to it. --------
  // The anchor card sits above the cards moving around it while the anchor
  // is live; the link cues follow the link set, which outlives the anchor.
  const live = useLiveAnchor();
  const isAnchor = live !== null && live.panel === id;
  const links = useLinks();
  const isSource = links !== null && links.source.panel === id;
  const relation = links?.relations[id];
  // The next step lives here: this tag says "Next: ..." (LinkSet.next).
  const next = links?.next?.panel === id ? links.next : undefined;
  const roles = useMemo(() => {
    const m = new Map<string, LinkMark>();
    if (!links) return m;
    const own = isSource ? anchorItem(links.source) : null;
    if (own) m.set(`${own.kind}:${own.id}`, { role: "anchor", description: "Opened" });
    for (const r of relation?.records ?? []) {
      const k = `${r.itemKind}:${r.itemId}`;
      if (!m.has(k)) m.set(k, { role: "linked", description: relation?.tag ?? "Linked" });
    }
    return m;
  }, [links, isSource, relation]);
  const lookup = useMemo<LinkLookup | null>(() => (roles.size === 0 ? null : (kind, itemId) => roles.get(`${kind}:${itemId}`)), [roles]);

  // Bring the first tinted row into view in its own list once the card has
  // landed, and put the list back where it was when the tint clears (the
  // user cleared the links, or a new click replaced them), unless the user
  // scrolled it since. Keyed on the link set and the records, so it runs
  // once per link.
  const linkKey = links && roles.size > 0 ? `${links.source.at}|${[...roles.keys()].join(",")}` : null;
  const landsAtMs = reduceMotion || !cue ? 0 : cue.stage.delayMs + cue.stage.durationMs;
  useEffect(() => {
    if (!linkKey) return;
    // landsAtMs is from the render that brought this link, which is the round that placed the card.
    const t = setTimeout(() => {
      const card = cardRef.current;
      const row = card?.querySelector<HTMLElement>(`[${LINK_ATTR}]`);
      if (!card || !row) return;
      // Finish a restore still under way first, so the reveal measures the list where the user left it.
      const back = restoring.current;
      if (back && Date.now() < back.until) back.el.scrollTop = back.top;
      restoring.current = null;
      ownScrollUntil.current = Date.now() + OWN_SCROLL_MS;
      const r = revealInPanel(row, card);
      if (r) revealed.current = { ...r, kept: false };
    }, landsAtMs);
    return () => {
      clearTimeout(t);
      const saved = revealed.current;
      revealed.current = null;
      if (!saved || saved.kept || !saved.el.isConnected) return;
      ownScrollUntil.current = Date.now() + (reduceMotion ? OWN_SCROLL_MS : RESTORE_SCROLL_MS);
      restoring.current = { el: saved.el, top: saved.top, until: ownScrollUntil.current };
      saved.el.scrollTo({ top: saved.top, behavior: reduceMotion ? "auto" : "smooth" });
    };
    // Keyed on the link only: once per link, not once per render.
  }, [linkKey]);

  // The links outlive the round that made them, and a later round can move
  // this card; moving it in the DOM resets its list's scroll. Once it lands,
  // bring the tinted row back into view, unless the user has taken the list
  // as it is. The list still goes back to where it was when the tint clears.
  const shownRound = useRef(round);
  useEffect(() => {
    if (shownRound.current === round) return;
    shownRound.current = round;
    if (!linkKey || revealed.current?.kept) return;
    const t = setTimeout(() => {
      const card = cardRef.current;
      const row = card?.querySelector<HTMLElement>(`[${LINK_ATTR}]`);
      if (!card || !row) return;
      ownScrollUntil.current = Date.now() + OWN_SCROLL_MS;
      const r = revealInPanel(row, card);
      if (r && revealed.current?.el !== r.el) revealed.current = { ...r, kept: false };
    }, landsAtMs);
    return () => clearTimeout(t);
    // Keyed on the round only: linkKey and landsAtMs are read from the render that brought the round.
  }, [round]);

  // --- Change badge and ring, shown for a few seconds after a plan change. -
  const [flash, setFlash] = useState<{ kind: FlashKind; at: number } | null>(null);
  const shownSize = useRef(size);
  useEffect(() => {
    const was = shownSize.current;
    shownSize.current = size;
    const change = placement.change;
    if (!change) return;
    // Compare with the size this card last showed, so a move is not called a resize.
    const kind: FlashKind =
      change === "added"
        ? "added"
        : SIZE_RANK[size] > SIZE_RANK[was]
          ? "bigger"
          : SIZE_RANK[size] < SIZE_RANK[was]
            ? "smaller"
            : change === "promoted"
              ? "up"
              : "down";
    setFlash({ kind, at: Date.now() });
  }, [placement, size]);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flash]);

  // --- Quiet (focus aid 1): full strength while the pointer or focus is in it. -
  const [lit, setLit] = useState(false);
  const faded = quiet && !lit;

  // --- "Why here?" popover. -----------------------------------------------
  const whyRef = useRef<HTMLButtonElement>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const closeWhy = useCallback(() => setWhyOpen(false), []);

  const focused = focusedPanel === id;
  const linkedLook = relation !== undefined || isSource;

  // --- Motion for this round. ----------------------------------------------
  const entering = cue?.role === "entering";
  const layoutTransition = reduceMotion ? { duration: 0 } : cue ? stageTransition(entering ? STAGE_MOVE : cue.stage) : PANEL_SPRING;
  const offset = entering && cue?.from ? { x: -cue.from.x * ENTER_OFFSET_PX, y: -cue.from.y * ENTER_OFFSET_PX } : { x: 0, y: 0 };
  const initial = reduceMotion ? { opacity: 0 } : entering ? { opacity: 0, scale: ENTER_SCALE, ...offset } : { opacity: 0, scale: 0.97 };
  const baseTransition = reduceMotion
    ? { duration: REDUCED_FADE_MS / 1000, layout: { duration: 0 } }
    : entering && cue
      ? { ...stageTransition(cue.stage), layout: layoutTransition }
      : { ...PANEL_SPRING, opacity: { duration: 0.18 }, layout: layoutTransition };
  // A quiet card fades slowly and lights up at once; only opacity and color change, never its size or place.
  const quietTiming = { duration: (faded ? QUIET_FADE_MS : QUIET_LIGHT_MS) / 1000 };
  const transition = quiet ? { ...baseTransition, opacity: quietTiming, filter: quietTiming } : baseTransition;
  // Reduced motion: a card that changed cell fades in place (see .fl-fade-a in index.css).
  const fade = reduceMotion && cue?.role === "moved" ? (round % 2 === 0 ? "fl-fade-a" : "fl-fade-b") : undefined;
  const variants = useMemo(() => ({ exit: (ctx: ExitContext | undefined) => exitTarget(id, ctx) }), [id]);

  return (
    <motion.section
      ref={setCardRef}
      aria-labelledby={titleId}
      data-size={size}
      {...{ [PANEL_ATTR]: id }}
      {...(isAnchor ? { [ANCHOR_ATTR]: "true" } : {})}
      {...(quiet ? { [QUIET_ATTR]: faded ? "faded" : "lit" } : {})}
      {...(ring ? { [FRONT_RING_ATTR]: "" } : {})}
      layout={!reduceMotion}
      initial={initial}
      animate={{ opacity: faded ? QUIET_OPACITY : 1, scale: 1, x: 0, y: 0, ...(quiet ? { filter: `saturate(${faded ? QUIET_SATURATE : 1})` } : {}) }}
      variants={variants}
      exit="exit"
      transition={transition}
      // Set inline so motion can correct the radius while the card scales.
      // The anchor sits above the cards moving around it.
      style={{
        borderRadius: 14,
        ...(isAnchor ? { zIndex: 2 } : {}),
        ...(cell ? { gridColumn: `${cell.col + 1} / span ${cell.w}`, gridRow: `${cell.row + 1} / span ${cell.h}` } : {}),
      }}
      className={clsx(
        "fl-cell relative flex min-w-0 flex-col overflow-hidden border bg-surface shadow-card transition-[border-color,box-shadow] duration-500",
        fade,
        // Sent to the front: a stronger ring than a change badge's, for a moment, so the eye finds where it went.
        ring
          ? "border-accent ring-4 ring-accent/50"
          : linkedLook
            ? flash
              ? "border-link/50 ring-4 ring-link/15"
              : "border-link/45"
            : flash
              ? "border-accent/45 ring-4 ring-accent/15"
              : focused
                ? "border-line-strong"
                : "border-line",
      )}
      onPointerEnter={(e) => {
        enteredAt.current = null;
        if (e.pointerType !== "touch") {
          setPointer({ panel: id, down: e.buttons > 0 });
          setLit(true);
        }
      }}
      onPointerMove={(e) => {
        // Layout changes under a still pointer produce moves with no movement; skip them.
        if (e.pointerType === "touch" || enteredAt.current !== null || (e.movementX === 0 && e.movementY === 0)) return;
        enteredAt.current = Date.now();
      }}
      onPointerLeave={(e) => {
        if (e.pointerType !== "touch") setPointer({ panel: null, down: false });
        // Keyboard focus inside keeps it lit.
        if (!cardRef.current?.contains(document.activeElement)) setLit(false);
        const start = enteredAt.current;
        enteredAt.current = null;
        if (start === null) return;
        const durationMs = Math.min(DWELL_MAX_MS, Date.now() - start);
        if (durationMs >= DWELL_MIN_MS) track({ type: "panel_dwell", panel: id, detail: { durationMs } });
      }}
      onPointerDown={(e) => {
        setPointer({ panel: id, down: true });
        keepRevealed(e.target);
        if (!fromFrameControl(e.target)) markFocus("pointer");
      }}
      onPointerUp={(e) => {
        // Touch has no hover: once the finger lifts, the pointer is nowhere.
        setPointer({ panel: e.pointerType === "touch" ? null : id, down: false });
      }}
      onPointerCancel={() => setPointer({ panel: null, down: false })}
      onFocus={(e) => {
        setLit(true);
        keepRevealed(e.target);
        if (!fromFrameControl(e.target)) markFocus("keyboard");
      }}
      onBlur={(e) => {
        // Focus left the card (not just moved inside it), and the pointer is not over it.
        const to = e.relatedTarget;
        if (to instanceof Node && cardRef.current?.contains(to)) return;
        if (!cardRef.current?.matches(":hover")) setLit(false);
      }}
    >
      <motion.header
        layout={reduceMotion ? false : "position"}
        transition={{ layout: layoutTransition }}
        {...{ [PANEL_HEADER_ATTR]: id }}
        // A double-click on the title area does what "Make bigger" does; the buttons and tags keep their own clicks.
        onDoubleClick={(e) => {
          if (e.target instanceof Element && e.target.closest("button, [data-frame-control]")) return;
          window.getSelection()?.removeAllRanges();
          toggleBigger("pointer");
        }}
        className="fl-pad relative z-10 flex h-10 shrink-0 items-center gap-2"
      >
        <Icon className={clsx("size-4 shrink-0", focused ? "text-accent-text" : "text-ink-2")} aria-hidden />
        <h2 id={titleId} className={clsx("min-w-0 truncate text-[13px] font-semibold text-ink", relation && "shrink-0")}>
          {title}
        </h2>
        {quiet && !relation ? (
          <span
            className="inline-flex h-5 shrink-0 items-center rounded-full bg-surface-3 px-2 text-2xs font-medium text-ink-2"
            title={placement.reason}
          >
            Quiet
          </span>
        ) : relation ? (
          <LinkTag
            relation={relation}
            {...(next ? { next: next.text } : {})}
            panel={id}
            title={title}
            onRemove={() => {
              // The x goes away with its tag; keep keyboard focus in this card's header.
              const refocus = cardRef.current?.contains(document.activeElement) ?? false;
              removeLink(id);
              if (refocus) whyRef.current?.focus({ preventScroll: true });
            }}
            reduceMotion={reduceMotion}
            delayMs={reduceMotion || !cue ? 0 : cue.stage.delayMs}
          />
        ) : (
          <AnimatePresence initial={false}>
            {flash ? (
              <motion.span
                key={flash.at}
                initial={reduceMotion ? false : { opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.3 } }}
                className="inline-flex h-5 shrink-0 items-center rounded-full bg-accent-soft px-2 text-2xs font-medium text-accent-text"
              >
                {CHANGE_TEXT[flash.kind]}
              </motion.span>
            ) : null}
          </AnimatePresence>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-0.5" data-frame-control>
          {/* While a tag shows, "Why here?" is an icon, so "Linked to" and the name fit beside the title. */}
          <button
            ref={whyRef}
            type="button"
            onClick={() => setWhyOpen((o) => !o)}
            aria-expanded={whyOpen}
            aria-haspopup="dialog"
            {...(relation ? { "aria-label": "Why here?", title: "Why here?" } : {})}
            className={clsx(
              "h-6 rounded-md text-2xs font-medium transition-colors",
              relation ? "grid w-6 place-items-center" : "px-1.5",
              whyOpen ? "bg-surface-3 text-ink" : "text-ink-3 hover:bg-surface-2 hover:text-ink",
            )}
          >
            {relation ? <Info className="size-3.5" aria-hidden /> : "Why here?"}
          </button>
          <button
            type="button"
            // detail 0: Enter or Space, not a pointer click.
            onClick={(e) => toggleBigger(e.detail === 0 ? "keyboard" : "pointer")}
            aria-pressed={bigger}
            aria-label={bigger ? `Make ${title} smaller` : `Make ${title} bigger`}
            title={bigger ? "Make smaller" : "Make bigger"}
            className={clsx(
              "grid size-6 place-items-center rounded-md transition-colors",
              bigger ? "text-accent-text hover:bg-accent-soft" : "text-ink-3 hover:bg-surface-2 hover:text-ink",
            )}
          >
            {bigger ? <Minimize2 className="size-3.5" aria-hidden /> : <Maximize2 className="size-3.5" aria-hidden />}
          </button>
          <button
            type="button"
            onClick={() => (pinned ? unpin(id) : pin(id))}
            aria-pressed={pinned}
            aria-label={pinned ? `Unpin ${title}` : `Pin ${title}`}
            title={pinned ? "Pinned. Click to unpin" : toFront ? "Pin to the front" : "Pin in place"}
            className={clsx(
              "grid size-6 place-items-center rounded-md transition-colors",
              pinned ? "text-accent-text hover:bg-accent-soft" : "text-ink-3 hover:bg-surface-2 hover:text-ink",
            )}
          >
            <Pin className="size-3.5" fill={pinned ? "currentColor" : "none"} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => {
              canvasEdit?.noteDismiss(id);
              dismiss(id);
            }}
            aria-label={`Send ${title} to dock`}
            title="Send to dock"
            className="grid size-6 place-items-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <ArrowDownToLine className="size-3.5" aria-hidden />
          </button>
        </div>
      </motion.header>

      <motion.div
        ref={bodyRef}
        layout={reduceMotion ? false : "position"}
        transition={{ layout: layoutTransition }}
        className="fl-scroll relative min-h-0 flex-1 overflow-y-auto"
      >
        <LinkContext.Provider value={lookup}>{children}</LinkContext.Provider>
      </motion.div>

      {note}

      {whyOpen && whyRef.current ? (
        <WhyPopover anchor={whyRef.current} placement={placement} title={title} onClose={closeWhy} />
      ) : null}
    </motion.section>
  );
}

/**
 * "Linked to INV-1042" in a linked card's header, in the link color, with
 * an x beside it that removes just this link (tag, tint, and line). The
 * reason ("2 messages from Harbor Coffee Co.") is in its accessible name and
 * in a tip on hover and focus; a tap toggles the tip, since touch has no
 * hover. Both are frame controls, so using them is not work in the panel.
 */
function LinkTag({
  relation,
  next,
  panel,
  title,
  onRemove,
  reduceMotion,
  delayMs,
}: {
  relation: PanelRelation;
  /** The next step, when it lives in this panel: "Next: resend INV-1042". Shown instead of "Linked to ...", in a stronger style. */
  next?: string;
  /** The linked panel this tag is on. */
  panel: PanelId;
  /** Its title, for the x button's name ("Remove link to Inbox"). */
  title: string;
  onRemove: () => void;
  reduceMotion: boolean;
  delayMs: number;
}) {
  const [open, setOpen] = useState(false);
  const text = next ?? relation.tag;
  // In a narrow header the record name matters more than "Linked to"; the link icon says that part.
  const named = next ? null : /^(Linked to )(.+)$/.exec(text);
  // The next step in shorter forms, longest first, for narrow headers:
  // "Next: resend INV-1042", "resend INV-1042", "Resend". A step that only
  // opens a record keeps its name instead ("Placeholder charts for...", truncated): "Open" alone says nothing.
  const forms = useMemo(() => {
    if (!next) return [text];
    const phrase = next.replace(/^Next: /, "");
    if (phrase.startsWith("open ")) return [next, phrase.slice(5)];
    const verb = phrase.split(" ")[0] ?? phrase;
    return [...new Set([next, phrase, verb.charAt(0).toUpperCase() + verb.slice(1)])];
  }, [next, text]);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  // The whole tag (and the next step's shorter forms), measured off screen: when it fits, "Linked to" shows even in a narrow header.
  const fullRef = useRef<HTMLSpanElement>(null);
  const [fits, setFits] = useState(true);
  const [form, setForm] = useState(0);
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const full = fullRef.current;
    if (!wrap || !full || typeof ResizeObserver === "undefined") return;
    // The x button shares the row with the tag.
    const check = () => {
      const room = wrap.clientWidth - (removeRef.current?.offsetWidth ?? 0) - REMOVE_GAP_PX;
      const widths = [...full.children].map((c) => (c as HTMLElement).offsetWidth);
      setFits(widths[0] <= room);
      const i = widths.findIndex((w) => w <= room);
      setForm(i === -1 ? widths.length - 1 : i);
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [forms]);

  // Keep the tip inside the card (it clips): start under the tag, shift left if it would overflow.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const tip = tipRef.current;
    const header = wrap?.closest("header");
    if (!open || !wrap || !tip || !header) return;
    const room = header.clientWidth - wrap.offsetLeft - 8;
    // Shift left (never past the header's padding) when the tip would pass the header's right edge.
    const width = tip.offsetWidth;
    const left = Math.max(-wrap.offsetLeft + 8, Math.min(0, room - width));
    tip.style.left = `${left}px`;
  }, [open, relation.reason]);

  return (
    <motion.span
      ref={wrapRef}
      data-frame-control
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 3 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: delayMs / 1000, duration: (reduceMotion ? REDUCED_FADE_MS : 250) / 1000 }}
      // A container, so the tag can drop its "Linked to" when the header has little room.
      className="@container relative flex min-w-0 flex-1 items-center gap-0.5"
    >
      <button
        type="button"
        {...{ [LINK_TAG_ATTR]: relation.anchorPanel }}
        {...(next ? { [LINK_NEXT_ATTR]: "" } : {})}
        // "Linked to Kite & Co." ends in a period already; do not read two.
        aria-label={`${next ? `${next}. ` : ""}${relation.tag.replace(/\.$/, "")}. ${relation.reason}`}
        onClick={() => setOpen((o) => !o)}
        onPointerEnter={(e) => {
          if (e.pointerType !== "touch") setOpen(true);
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== "touch") setOpen(false);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && open) {
            e.stopPropagation();
            setOpen(false);
          }
        }}
        className={clsx(
          "inline-flex h-5 min-w-0 items-center gap-1 rounded-full px-2 text-2xs ring-inset",
          // The next step: a solid fill, so the eye finds it before the other tags.
          next ? "bg-link font-semibold text-link-fg ring-1 ring-link" : "bg-link-soft font-medium text-link-text ring-1 ring-link/30",
        )}
      >
        {next ? <CornerDownRight className="size-3 shrink-0" aria-hidden /> : <Link2 className="size-3 shrink-0" aria-hidden />}
        {named ? (
          <span className="min-w-0 truncate">
            <span className={fits ? "inline" : "hidden @[9rem]:inline"}>{named[1]}</span>
            {named[2]}
          </span>
        ) : (
          <span className="min-w-0 truncate">{forms[form] ?? text}</span>
        )}
      </button>
      <button
        ref={removeRef}
        type="button"
        {...{ [LINK_REMOVE_ATTR]: panel }}
        onClick={onRemove}
        aria-label={`Remove link to ${title}`}
        title="Remove this link"
        className="grid size-5 shrink-0 place-items-center rounded-full text-link-text transition-colors hover:bg-link/15 focus-visible:bg-link/15"
      >
        <X className="size-3" aria-hidden />
      </button>
      <span ref={fullRef} aria-hidden className="invisible absolute top-0 left-0 flex flex-col text-2xs font-semibold whitespace-nowrap">
        {forms.map((f) => (
          <span key={f} className="inline-flex h-5 w-max items-center gap-1 px-2">
            <Link2 className="size-3 shrink-0" />
            {f}
          </span>
        ))}
      </span>
      <span
        ref={tipRef}
        aria-hidden
        className={clsx(
          "pointer-events-none absolute top-full left-0 z-20 mt-1.5 w-max max-w-64 rounded-md bg-ink px-2 py-1 text-2xs font-medium whitespace-normal text-canvas shadow-pop transition-opacity",
          open ? "opacity-100" : "opacity-0",
        )}
      >
        {next ? `${next}. ${relation.tag.replace(/\.$/, "")}: ${relation.reason}` : relation.reason}
      </span>
    </motion.span>
  );
}

/**
 * Rendered in a portal so a short card cannot clip it. It re-anchors every
 * frame, so it follows the card while the card glides to a new slot.
 */
function WhyPopover({
  anchor,
  placement,
  title,
  onClose,
}: {
  anchor: HTMLButtonElement;
  placement: PanelPlacement;
  title: string;
  onClose: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    let raf = 0;
    const place = () => {
      const box = boxRef.current;
      if (!box) return;
      if (!anchor.isConnected) {
        onClose();
        return;
      }
      const r = anchor.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.min(296, vw - 24);
      const left = Math.max(12, Math.min(r.right - width, vw - 12 - width));
      const h = box.offsetHeight;
      const below = r.bottom + 6;
      const top = below + h > vh - 8 && r.top - 6 - h > 8 ? r.top - 6 - h : below;
      box.style.width = `${width}px`;
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      raf = requestAnimationFrame(place);
    };
    place();
    return () => cancelAnimationFrame(raf);
  }, [anchor, onClose]);

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || anchor.contains(t)) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [anchor, onClose]);

  useWindowKeydown((e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      anchor.focus();
    }
  });

  const b = placement.breakdown;
  const parts = b
    ? [
        { label: "Jev says it fits now", value: b.relevance },
        { label: "You used it recently", value: b.usage },
        { label: "Fits what you are doing", value: b.goal },
        { label: "Pinned", value: b.pin },
        // Focus aid 3: only in a round that used a habit.
        ...(b.habit !== undefined ? [{ label: "You usually go here next", value: b.habit }] : []),
      ]
    : [];
  const maxPart = Math.max(0.0001, ...parts.map((p) => p.value));

  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-label={`Why ${title} is here`}
      className="fixed z-50 rounded-xl border border-line bg-surface p-3 text-ink shadow-pop"
      style={{ top: -9999, left: -9999 }}
    >
      <p className="text-2xs font-medium tracking-wide text-ink-3 uppercase">Why here?</p>
      <p className="mt-1 text-sm leading-snug">{placement.reason || "This panel is part of the default layout."}</p>
      {parts.length > 0 ? (
        <ul className="mt-3 space-y-1.5" aria-label="What set its priority">
          {parts.map((p) => (
            <li key={p.label} className="grid grid-cols-[minmax(0,1fr)_64px_32px] items-center gap-2 text-2xs text-ink-2">
              <span className="truncate">{p.label}</span>
              <span className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                <span className="block h-full rounded-full bg-accent" style={{ width: `${(p.value / maxPart) * 100}%` }} />
              </span>
              <span className="text-right tabular-nums">{p.value.toFixed(2)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 border-t border-line pt-2 text-2xs text-ink-3">
        {SIZE_TEXT[placement.size]} · priority {placement.priority.toFixed(2)}
        {placement.pinned ? " · pinned" : ""}
      </p>
    </div>,
    document.body,
  );
}
