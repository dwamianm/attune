/**
 * The shared "link" cue (docs/anchored-relayout.md): the record the user
 * clicked in the anchor and the records joined to it in other panels get the
 * same tint, so the eye can tell what was added and why.
 *
 * Panels do not know about anchors. PanelFrame puts a lookup in context, and
 * every record row spreads useItemProps()(kind, id), which carries the DOM
 * hooks (data-item-id, data-item-kind) and, while the links show, the
 * data-link role that index.css tints.
 */
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { ActionId } from "../../shared/catalog.ts";
import { CLIENTS } from "../../shared/fixtures.ts";
import type { AnchorRef, ItemKind } from "../../shared/types.ts";
import type { LinkSet } from "../engine/contract.ts";
import { useEngine } from "../engine/store.ts";
import { roundCues, unstaged, type RoundCues } from "./choreography.ts";
import { ITEM_KIND_ATTR, itemAttrs, LINK_ATTR, type LinkRole } from "./domHooks.ts";
import { useLatest } from "./hooks.ts";

/**
 * The plan's anchor while it is still the live one. The anchor note and the
 * anchor card's stacking follow it: once the store releases the anchor (work
 * elsewhere, or ANCHOR_IDLE_RELEASE_MS idle) they go, even before the next
 * plan lands. The link cues follow useLinks instead.
 */
export function useLiveAnchor(): AnchorRef | null {
  return useEngine((s) => (s.anchor && s.plan.anchor && s.anchor.at === s.plan.anchor.at ? s.plan.anchor : null));
}

/**
 * The link cues on screen (tints, tags, lines, and the links bar), or null.
 * The store keeps them in step with the canvas: they outlive the anchor
 * ("stay" mode) and go when the user clears them or docks their panels.
 */
export function useLinks(): LinkSet | null {
  return useEngine((s) => s.links);
}

/**
 * True while the user is working in a panel (a live "work" anchor). The page
 * above the canvas and the spacing hold still meanwhile, so nothing pushes
 * the anchor down. It follows the store's anchor, which is set by the click
 * itself, so the hold starts before the relayout arrives.
 */
export function useWorkAnchorLive(): boolean {
  return useEngine((s) => s.anchor !== null && s.anchor.source !== "command");
}

/**
 * The current round's cues, fixed for the whole round. A later plan in the
 * same round (new suggestions only) carries an empty change summary, and
 * must not cut short the stages still playing. The first plan seen is the
 * starting layout, not a change.
 */
export function useRoundCues(): RoundCues {
  const plan = useEngine((s) => s.plan);
  const round = plan.round ?? 0;
  const [cues, setCues] = useState<RoundCues>(() => unstaged(round));
  if (round !== cues.round) {
    const next = roundCues(plan);
    setCues(next);
    return next;
  }
  return cues;
}

/**
 * True while the next step's suggestion ("Arrange linked panels by next
 * step", Suggestion.nextStep) is the primary one and does `actionId` to the
 * record `recordId`: the panel rings the button that does the same, so the
 * eye finds it. Only "." or a click on it performs it.
 */
export function useStepAction(actionId: ActionId, recordId: string): boolean {
  return useEngine((s) =>
    s.plan.suggestions.some(
      (x) => x.nextStep === true && x.prominence === "primary" && x.actionId === actionId && (x.args.invoiceId ?? x.args.messageId ?? x.args.projectId) === recordId,
    ),
  );
}

/** `value`, except that it keeps the value it had when `hold` turned on until hold turns off. */
export function useHeldWhile<T>(value: T, hold: boolean): T {
  const [held, setHeld] = useState(value);
  // Adjusting state during render is React's pattern for "derived from the last value".
  if (!hold && held !== value) setHeld(value);
  return hold ? held : value;
}

/** The record the anchor is about, as a row in the anchor's own panel. */
export function anchorItem(anchor: AnchorRef): { kind: ItemKind; id: string } | null {
  if (anchor.itemKind && anchor.itemId) return { kind: anchor.itemKind, id: anchor.itemId };
  // "See invoices" in Clients names only the client; its row is the record.
  if (anchor.panel === "clients" && anchor.client) {
    const c = CLIENTS.find((x) => x.name === anchor.client);
    if (c) return { kind: "client", id: c.id };
  }
  return null;
}

/** How a tinted row is marked: its role for the tint, and the words a screen reader adds to its name. */
export interface LinkMark {
  role: LinkRole;
  description: string;
}

/** The mark of a record row in the panel that provides the lookup. */
export type LinkLookup = (kind: ItemKind, id: string) => LinkMark | undefined;

export const LinkContext = createContext<LinkLookup | null>(null);

export type ItemProps = ReturnType<typeof itemAttrs> & { [LINK_ATTR]?: LinkRole; "aria-description"?: string };

/** Props for a record row: {...item("invoice", inv.id)}. A tinted row also says why, for screen readers. */
export function useItemProps(): (kind: ItemKind, id: string) => ItemProps {
  const lookup = useContext(LinkContext);
  return useCallback(
    (kind: ItemKind, id: string) => {
      const mark = lookup?.(kind, id);
      return mark ? { ...itemAttrs(kind, id), [LINK_ATTR]: mark.role, "aria-description": mark.description } : itemAttrs(kind, id);
    },
    [lookup],
  );
}

/**
 * Scroll `row` into view inside its own scrolling list, never the page:
 * element.scrollIntoView also scrolls every scrolling ancestor, the window
 * included, which would move the anchor the user is looking at. The list
 * stops on a row boundary, so no half row is left at its top. Returns the
 * list and where it was, so the caller can put it back, or null when the row
 * was already in view.
 */
export function revealInPanel(row: HTMLElement, card: HTMLElement): { el: HTMLElement; top: number } | null {
  let el = row.parentElement;
  while (el && el !== card) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 1) break;
    el = el.parentElement;
  }
  if (!el || el === card) return null;
  const list = el;
  // Rects include a card's layout-animation scale; offsetHeight does not.
  const box = list.getBoundingClientRect();
  const scale = list.offsetHeight > 0 ? box.height / list.offsetHeight || 1 : 1;
  const topOf = (node: HTMLElement) => (node.getBoundingClientRect().top - box.top) / scale + list.scrollTop;
  const top = topOf(row);
  const height = row.getBoundingClientRect().height / scale;
  const view = list.clientHeight;
  if (top >= list.scrollTop && top + height <= list.scrollTop + view) return null;
  // About a third of the way down, so the rows around it show too, snapped
  // to the top of a row of the same kind that keeps the whole row in view.
  const ideal = top - Math.max(0, view - height) / 3;
  const kind = row.getAttribute(ITEM_KIND_ATTR);
  const bounds = [...list.querySelectorAll<HTMLElement>(`[${ITEM_KIND_ATTR}="${kind}"]`)]
    .map(topOf)
    .filter((b) => b <= top + 0.5 && b + view >= top + height);
  const snap = bounds.reduce((best, b) => (Math.abs(b - ideal) < Math.abs(best - ideal) ? b : best), top);
  const before = list.scrollTop;
  list.scrollTop = Math.max(0, Math.round(snap));
  return { el: list, top: before };
}

// ---------------------------------------------------------------------------
// "Undo" from the anchor note: the change feed forgets the change it lists,
// the same as after its own Undo.
// ---------------------------------------------------------------------------

const NOTE_UNDO_EVENT = "floouid:note-undo";

export function announceNoteUndo(): void {
  window.dispatchEvent(new Event(NOTE_UNDO_EVENT));
}

export function useNoteUndoListener(handler: () => void): void {
  const ref = useLatest(handler);
  useEffect(() => {
    const fn = () => ref.current();
    window.addEventListener(NOTE_UNDO_EVENT, fn);
    return () => window.removeEventListener(NOTE_UNDO_EVENT, fn);
  }, [ref]);
}
