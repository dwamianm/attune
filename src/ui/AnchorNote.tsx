/**
 * The short note on the anchor card after a round added linked panels:
 * "Added Inbox and Clients for Harbor Coffee Co. · Undo". It sits on the
 * card the user is looking at, not in a far corner, and it changes no
 * layout: it is absolutely placed inside the card's bottom edge, or over
 * the top of the list when the clicked row is down there, and never over
 * the card's header, so the panel keeps its name and frame controls. The
 * change feed line above the canvas stays as the fuller record.
 *
 * Screen readers hear the same sentence from the canvas's live region
 * (Canvas), which is already mounted; a status role on a note that mounts
 * with its text inside is often not announced.
 *
 * It hides after ANCHOR_NOTE_MS (not while the pointer or focus is on it) or
 * on the next press anywhere else.
 */
import clsx from "clsx";
import { Link2, Undo2 } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PanelId } from "../../shared/catalog.ts";
import { ANCHOR_NOTE_MS, REDUCED_FADE_MS } from "./choreography.ts";
import { ANCHOR_NOTE_ATTR, LINK_ATTR, panelHeaderSelector } from "./domHooks.ts";
import { useLatest } from "./hooks.ts";

/** While the pointer or focus is on the note, check again this often before hiding it. */
const NOTE_RECHECK_MS = 1000;
/** Clear space kept between the note and the clicked row, so the row still reads as a row. */
const NOTE_ROW_GAP_PX = 8;
/** Inset from the edge the note sits on, the same as its side inset (inset-x-2). */
const NOTE_INSET_PX = 8;

/** Where the note sits in the card, in px: `top` null means the bottom edge. */
interface NotePlace {
  top: number | null;
  left: number;
  right: number;
}

const scrolls = (el: Element): boolean => {
  const oy = getComputedStyle(el).overflowY;
  return oy === "auto" || oy === "scroll";
};

/** The row's own scrolling list inside the card (a ListScroll), or null. */
function listOf(row: HTMLElement, card: HTMLElement): HTMLElement | null {
  for (let el = row.parentElement; el && el !== card; el = el.parentElement) if (scrolls(el)) return el;
  return null;
}

/**
 * An element's box inside the card, from layout offsets minus the scroll of
 * the lists between them. Rects would not do: while the anchor grows, the
 * card is scaled and its header and body are scaled back the other way.
 */
function boxIn(el: HTMLElement, card: HTMLElement): { left: number; top: number; width: number; height: number } {
  let left = 0;
  let top = 0;
  for (let n: HTMLElement | null = el; n && n !== card; ) {
    left += n.offsetLeft;
    top += n.offsetTop;
    const parent = n.offsetParent as HTMLElement | null;
    if (parent && parent !== card) {
      left += parent.clientLeft;
      top += parent.clientTop;
    }
    n = parent;
  }
  for (let p = el.parentElement; p && p !== card; p = p.parentElement) {
    left -= p.scrollLeft;
    top -= p.scrollTop;
  }
  return { left, top, width: el.offsetWidth, height: el.offsetHeight };
}

export function AnchorNote({
  panel,
  text,
  delayMs,
  reduceMotion,
  onUndo,
  onClose,
}: {
  panel: PanelId;
  text: string;
  /** Wait for the linked panels to arrive before showing it. */
  delayMs: number;
  reduceMotion: boolean;
  onUndo: () => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useLatest(onClose);
  // Where it sits, in order: the card's bottom edge; over the top of the
  // clicked row's list (below the search box or filters); just below the
  // header (over the search box or filters, which come back in 6 s). The
  // first that keeps the clicked row clear wins, and if none does (a very
  // short card) the bottom edge, which may cover lower rows but never the
  // header. A row cannot be near both the top and the bottom of a standard
  // or larger card, so one of the last two always clears it. It spans only
  // the row's list, so in a hero card the detail pane keeps its buttons.
  const [place, setPlace] = useState<NotePlace | null>(null);
  useLayoutEffect(() => {
    const note = ref.current;
    const card = note?.parentElement;
    if (!note || !card) return;
    const row = card.querySelector<HTMLElement>(`[${LINK_ATTR}="anchor"]`);
    const list = row ? listOf(row, card) : ([...card.querySelectorAll<HTMLElement>("ul")].find(scrolls) ?? null);
    let left = NOTE_INSET_PX;
    let right = NOTE_INSET_PX;
    const l = list ? boxIn(list, card) : null;
    if (l) {
      left = Math.max(NOTE_INSET_PX, l.left + NOTE_INSET_PX);
      right = Math.max(NOTE_INSET_PX, card.clientWidth - (l.left + l.width) + NOTE_INSET_PX);
    }
    // Set the width first, so the height read below is the wrapped one.
    note.style.left = `${left}px`;
    note.style.right = `${right}px`;
    let top: number | null = null;
    if (row) {
      const r = boxIn(row, card);
      const h = note.offsetHeight;
      const clears = (t: number) => t + h + NOTE_ROW_GAP_PX <= r.top || t >= r.top + r.height + NOTE_ROW_GAP_PX;
      const header = card.querySelector<HTMLElement>(panelHeaderSelector(panel));
      const belowHeader = (header ? boxIn(header, card).top + header.offsetHeight : 0) + NOTE_INSET_PX / 2;
      const overList = l ? Math.max(belowHeader, l.top + NOTE_INSET_PX / 2) : null;
      if (!clears(card.clientHeight - NOTE_INSET_PX - h)) {
        if (overList !== null && clears(overList)) top = overList;
        else if (clears(belowHeader)) top = belowHeader;
      }
    }
    setPlace({ top, left, right });
  }, [panel]);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const el = ref.current;
      if (el && (el.matches(":hover") || el.contains(document.activeElement))) t = setTimeout(tick, NOTE_RECHECK_MS);
      else close.current();
    };
    t = setTimeout(tick, delayMs + ANCHOR_NOTE_MS);
    return () => clearTimeout(t);
  }, [close, delayMs]);

  // The next press anywhere else means the user moved on.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node)) return;
      close.current();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [close]);

  return (
    <motion.div
      ref={ref}
      {...{ [ANCHOR_NOTE_ATTR]: panel }}
      // A frame control, so pressing Undo is not work in the panel.
      data-frame-control
      initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, transition: { duration: (reduceMotion ? REDUCED_FADE_MS : 200) / 1000 } }}
      transition={{ delay: delayMs / 1000, duration: (reduceMotion ? REDUCED_FADE_MS : 250) / 1000 }}
      style={place ? { left: place.left, right: place.right, ...(place.top === null ? {} : { top: place.top }) } : undefined}
      className={clsx(
        "absolute inset-x-2 z-20 flex items-center gap-2 rounded-lg border border-link/30 bg-link-soft py-1.5 pr-1 pl-2.5 text-xs text-link-text shadow-pop",
        (place?.top ?? null) === null && "bottom-2",
      )}
    >
      <Link2 className="size-3.5 shrink-0" aria-hidden />
      <span className="line-clamp-2 min-w-0 flex-1 leading-snug">{text}</span>
      <span className="shrink-0 text-link-text/60" aria-hidden>
        ·
      </span>
      <button
        type="button"
        onClick={onUndo}
        className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-medium hover:bg-link/10"
      >
        <Undo2 className="size-3" aria-hidden />
        Undo
      </button>
    </motion.div>
  );
}
