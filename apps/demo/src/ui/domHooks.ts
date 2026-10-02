/**
 * DOM attribute names for the anchored relayout (docs/anchored-relayout.md).
 * The choreography finds rows, headers, and dock icons by these attributes,
 * and the browser checks read them too, so producers and readers use the
 * constants and helpers here instead of string literals.
 */
import type { PanelId } from "../../shared/catalog.ts";
import type { ItemKind } from "../../shared/types.ts";

/** On the canvas grid element (the one with id "canvas"), set by AdaptiveCanvas (@attuneui/react). No value. The link-line overlay is positioned against it. */
export const CANVAS_ATTR = "data-canvas";
/** On each card, set by PanelCard (@attuneui/react), which PanelFrame draws around. Value: its PanelId. */
export const PANEL_ATTR = "data-panel";
/** On each card's header element. Value: its PanelId. Link lines end here. */
export const PANEL_HEADER_ATTR = "data-panel-header";
/**
 * On every list row that shows exactly one record (Inbox, Invoices, Clients,
 * Projects, Tasks, Calendar, Team). Value: the record id, for example
 * "INV-1042", "m-1", "c-harbor", "p-harbor", "t-1", "e-2", "u-sam".
 */
export const ITEM_ID_ATTR = "data-item-id";
/** Always paired with ITEM_ID_ATTR. Value: an ItemKind. Ids are unique only within a kind. */
export const ITEM_KIND_ATTR = "data-item-kind";
/** On each dock icon's wrapper. Value: its PanelId. A card leaving the canvas flies to this element. */
export const DOCK_ID_ATTR = "data-dock-id";
/** On the anchor's card while its anchor is live, set by PanelCard (@attuneui/react). Value: "true". */
export const ANCHOR_ATTR = "data-anchor";
/** Set by the UI on a tinted row: LinkRole "anchor" for the clicked record, "linked" for records related to it. */
export const LINK_ATTR = "data-link";
/** On the link tag in a linked card's header. Value: the anchor's PanelId. */
export const LINK_TAG_ATTR = "data-link-tag";
/** On the short note attached to the anchor card ("Added Inbox and Clients for ..."). Value: the anchor's PanelId. */
export const ANCHOR_NOTE_ATTR = "data-anchor-note";
/** On the link-line overlay (an aria-hidden svg with pointer-events none). No value. */
export const LINK_LINES_ATTR = "data-link-lines";
/** Set for one beat on a link tag whose panel no line can reach without crossing other cards. No value. */
export const LINK_PULSE_ATTR = "data-link-pulse";
/** On the sticky app bar. No value. Content under it is not visible, so no line is drawn there. */
export const APP_BAR_ATTR = "data-app-bar";
/** On each link line's group in the overlay. Value: the linked panel's PanelId. */
export const LINK_LINE_ATTR = "data-link-line";
/** On the link tag that holds the next step ("Next: resend INV-1042"). No value. */
export const LINK_NEXT_ATTR = "data-link-next";
/** On a panel's action button that the next step's suggestion would press ("Resend" for "Resend INV-1042 to ..."), while it is offered. No value. */
export const STEP_ACTION_ATTR = "data-step-action";
/** On the x button beside a link tag that removes that one link. Value: the linked panel's PanelId. */
export const LINK_REMOVE_ATTR = "data-link-remove";
/** On the links bar in the canvas caption ("Links for INV-1047 · 3 panels · Clear links"). No value. */
export const LINKS_BAR_ATTR = "data-links-bar";
/** On the command bar's wrapper. No value. Escape there is the command bar's, not the links'. */
export const COMMAND_BAR_ATTR = "data-command-bar";

/** On a quiet card (focus aid 1), set by PanelCard (@attuneui/react): "faded" while it shows at quiet strength, "lit" while hover or focus brings it to full strength. */
export const QUIET_ATTR = "data-quiet";
/** On a card for FRONT_RING_MS after a pin or "Make bigger" sent it to the front, while its ring shows, set by AdaptiveCanvas (@attuneui/react). No value. */
export const FRONT_RING_ATTR = "data-front-ring";

export type LinkRole = "anchor" | "linked";

/** Spread on a record row: {...itemAttrs("invoice", inv.id)}. */
export function itemAttrs(kind: ItemKind, id: string): { [ITEM_ID_ATTR]: string; [ITEM_KIND_ATTR]: ItemKind } {
  return { [ITEM_ID_ATTR]: id, [ITEM_KIND_ATTR]: kind };
}

/** Attribute selector with the value quoted, safe in Node too (no CSS.escape). */
function attr(name: string, value?: string): string {
  return value === undefined ? `[${name}]` : `[${name}="${value.replace(/["\\]/g, "\\$&")}"]`;
}

export const canvasSelector = (): string => attr(CANVAS_ATTR);
export const panelSelector = (id: PanelId): string => attr(PANEL_ATTR, id);
export const panelHeaderSelector = (id: PanelId): string => attr(PANEL_HEADER_ATTR, id);
/** A record row anywhere; scope it with a card element (card.querySelector) to find it in one panel. */
export const itemSelector = (kind: ItemKind, id: string): string => `${attr(ITEM_KIND_ATTR, kind)}${attr(ITEM_ID_ATTR, id)}`;
export const dockIconSelector = (id: PanelId): string => attr(DOCK_ID_ATTR, id);
export const linkTagSelector = (anchor: PanelId): string => attr(LINK_TAG_ATTR, anchor);
export const anchorNoteSelector = (anchor: PanelId): string => attr(ANCHOR_NOTE_ATTR, anchor);
export const appBarSelector = (): string => attr(APP_BAR_ATTR);
export const linkRemoveSelector = (): string => attr(LINK_REMOVE_ATTR);
export const commandBarSelector = (): string => attr(COMMAND_BAR_ATTR);
