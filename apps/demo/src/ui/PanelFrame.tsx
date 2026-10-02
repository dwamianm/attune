/**
 * The demo's card: its look, header, link tag, "Why here?" popover, and
 * body around the library card (PanelCard in @attuneui/react), which owns the
 * motion and the hands: it glides to its new cell and size whenever the plan
 * changes, plays its part of an anchored round (the anchor grows first, a
 * leaving card flies into its dock icon, a moving card glides, a new card
 * slides out from the anchor's side), fades while quiet and lights up on
 * hover or focus, and reports focus, the pointer, and pointer rests.
 *
 * Header and body use layout="position" so their contents are
 * scale-corrected instead of being stretched while the card grows or
 * shrinks. This file also captures list scrolls in the body.
 *
 * While the links show (they outlive the anchor until the user clears them),
 * a linked card shows a "Linked to ..." tag with an x that removes that
 * link, and its linked rows share the clicked row's link tint. The linked
 * card that holds the next step Jev read from the clicked record ("Arrange
 * linked panels by next step") says so instead, in a stronger style:
 * "Next: resend INV-1042".
 *
 * "Make bigger" (the button beside the pin, or a double-click on the title
 * area) makes the card the hero size until the user makes it smaller or
 * docks it; the engine keeps its top edge and moves the cards in its way.
 * With "Move pinned and bigger panels to the front" on, a pin or "Make
 * bigger" sends the card to the first cell instead, and the canvas rings it
 * once it lands.
 *
 * A quiet card (focus aid 1, docs/focus-aids.md) shows faded with a "Quiet"
 * label; hover or keyboard focus inside it brings full strength at once,
 * with no layout change. Clicking into it is the engine's business: it makes
 * the panel normal again.
 */
import clsx from "clsx";
import { ArrowDownToLine, CornerDownRight, Info, Link2, Maximize2, Minimize2, Pin, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { PANELS, type PanelId } from "../../shared/catalog.ts";
import type { ItemKind, PanelPlacement, PanelRelation, PanelSize } from "../../shared/types.ts";
import { moveToFrontOn } from "../engine/focusAids.ts";
import { REDUCED_FADE_MS, SIZE_RANK } from "@attuneui/core";
import { useEngine } from "../engine/store.ts";
import { LINK_ATTR, LINK_NEXT_ATTR, LINK_REMOVE_ATTR, LINK_TAG_ATTR, PANEL_HEADER_ATTR } from "./domHooks.ts";
import { CARD_CONTROL_ATTR, cardLayoutTransition, PanelCard, useCanvasEdit, useThrottleGate, useWindowKeydown, type PanelCardProps } from "@attuneui/react";
import { panelIcon } from "./icons.ts";
import { anchorItem, LinkContext, revealInPanel, useLinks, type LinkLookup, type LinkMark } from "./linking.tsx";

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
/** Space between a link tag and its x button (gap-0.5), counted when checking whether the whole tag fits. */
const REMOVE_GAP_PX = 2;
/** Marks a card's own controls (CARD_CONTROL_ATTR): using them is not work in the panel. */
const CONTROL = { [CARD_CONTROL_ATTR]: "" };

type FlashKind = "added" | "bigger" | "smaller" | "up" | "down";

/** One label per kind of change: a card that only moved down is not "Smaller". */
const CHANGE_TEXT: Record<FlashKind, string> = {
  added: "New",
  bigger: "Bigger",
  smaller: "Smaller",
  up: "Moved up",
  down: "Moved down",
};

const SIZE_TEXT: Record<PanelSize, string> = {
  hero: "Main panel",
  large: "Wide",
  standard: "Standard",
  compact: "Summary only",
};

/** The note attached to a card (the anchor note, "Added Inbox for ..."), from the canvas (see Canvas). */
export const CardNoteContext = createContext<(id: PanelId) => ReactNode>(() => null);

export function PanelFrame(props: PanelCardProps<PanelId, ItemKind>) {
  const { placement, reduceMotion, children, cue, round, quiet = false, ring = false } = props;
  const { id, size, pinned } = placement;
  const title = PANELS[id].title;
  const Icon = panelIcon(id);
  const titleId = useId();
  const note = useContext(CardNoteContext)(id);

  const { track, pin, unpin, dismiss, removeLink, bigger, maximize, restore, toFront } = useEngine(
    useShallow((s) => ({
      track: s.track,
      pin: s.pin,
      unpin: s.unpin,
      dismiss: s.dismiss,
      removeLink: s.removeLink,
      bigger: s.bigger.includes(id),
      maximize: s.maximize,
      restore: s.restore,
      toFront: moveToFrontOn(s.settings),
    })),
  );
  const toggleBigger = (via: "pointer" | "keyboard") => (bigger ? restore(id, via) : maximize(id, via));

  // The card element, shared with the library card's ref (AnimatePresence's popLayout measures it).
  const cardRef = useRef<HTMLElement | null>(null);
  const outerRef = props.ref;
  const setCardRef = useCallback(
    (el: HTMLElement | null) => {
      cardRef.current = el;
      if (typeof outerRef === "function") outerRef(el);
      else if (outerRef) outerRef.current = el;
    },
    [outerRef],
  );

  const canvasEdit = useCanvasEdit<PanelId>();

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
  // The link cues follow the link set, which outlives the anchor.
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

  // --- "Why here?" popover. -----------------------------------------------
  const whyRef = useRef<HTMLButtonElement>(null);
  const [whyOpen, setWhyOpen] = useState(false);
  const closeWhy = useCallback(() => setWhyOpen(false), []);

  const focused = props.focused;
  const linkedLook = relation !== undefined || isSource;
  const layoutTransition = cardLayoutTransition(cue, reduceMotion);
  // Reduced motion: a card that changed cell fades in place (see .fl-fade-a in index.css).
  const fade = reduceMotion && cue?.role === "moved" ? (round % 2 === 0 ? "fl-fade-a" : "fl-fade-b") : undefined;

  return (
    <PanelCard
      {...props}
      ref={setCardRef}
      labelledBy={titleId}
      radius={14}
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
      onPress={keepRevealed}
      onFocusInside={keepRevealed}
    >
      <motion.header
        layout={reduceMotion ? false : "position"}
        transition={{ layout: layoutTransition }}
        {...{ [PANEL_HEADER_ATTR]: id }}
        // A double-click on the title area does what "Make bigger" does; the buttons and tags keep their own clicks.
        onDoubleClick={(e) => {
          if (e.target instanceof Element && e.target.closest(`button, [${CARD_CONTROL_ATTR}]`)) return;
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

        <div className="ml-auto flex shrink-0 items-center gap-0.5" {...CONTROL}>
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
    </PanelCard>
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
      {...CONTROL}
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
