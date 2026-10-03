/** The help desk uses the starting API with its vocabulary, transport and record links. */
import {
  createAdaptiveWorkspace,
  type AdaptiveRequest,
  type AdaptiveResponse,
  type AnchorRef,
  type CoreSuggestion,
  type EventWords,
  type RelatedRecord,
} from "@attuneui/core";
import type { RoundJudgments } from "@attuneui/jev";
import { CATALOG, type ActionId, type GoalId, type PanelId, type RecordKind } from "./catalog.ts";
import { ARTICLES, CUSTOMERS, TICKETS } from "./data.ts";

export type Judgments = RoundJudgments<PanelId, GoalId, ActionId>;
export type Suggestion = CoreSuggestion<ActionId>;

export const WORDS: EventWords<PanelId> = {
  panels: CATALOG.panels,
  itemWords: { ticket: "ticket", customer: "customer", article: "help article", macro: "saved reply" },
  actionPast: (actionId, d) => {
    if (actionId === "reply_ticket") return d.itemId ? `Replied to ticket ${d.itemId}` : "Replied to a ticket";
    if (actionId === "solve_ticket") return d.itemId ? `Marked ticket ${d.itemId} solved` : "Marked a ticket solved";
    if (actionId === "send_article") return `Sent ${d.label ? `"${d.label}"` : "a help article"}${d.client ? ` to ${d.client}` : ""}`;
    return "Took an action";
  },
};

/** Records in other panels linked to the anchor: the same customer's tickets and record, and a ticket's help article. */
export function linkedRecords(anchor: AnchorRef<PanelId, RecordKind>): Partial<Record<PanelId, RelatedRecord<RecordKind>[]>> {
  const out: Partial<Record<PanelId, RelatedRecord<RecordKind>[]>> = {};
  const ticket = anchor.itemKind === "ticket" ? TICKETS.find((t) => t.id === anchor.itemId) : undefined;
  const customer = anchor.client ?? ticket?.customer;
  if (customer) {
    const tickets = TICKETS.filter((t) => t.customer === customer && t.id !== anchor.itemId);
    // The anchor's own panel never links to itself, so a ticket's sibling tickets link only from another panel.
    if (tickets.length && anchor.panel !== "tickets") out.tickets = tickets.map((t) => ({ itemKind: "ticket", itemId: t.id, label: t.subject }));
    const c = CUSTOMERS.find((x) => x.name === customer);
    if (c && anchor.panel !== "customers") out.customers = [{ itemKind: "customer", itemId: c.id, label: c.name }];
  }
  const article = ticket?.article ? ARTICLES.find((a) => a.id === ticket.article) : undefined;
  if (article) out.articles = [{ itemKind: "article", itemId: article.id, label: article.title }];
  return out;
}

/** POST /api/adapt on the playground's own server. */
export async function postAdapt(request: AdaptiveRequest, opts: { signal: AbortSignal }): Promise<AdaptiveResponse<Judgments>> {
  const res = await fetch("/api/adapt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request), signal: opts.signal });
  if (!res.ok) throw new Error(`The server answered ${res.status}`);
  return (await res.json()) as AdaptiveResponse<Judgments>;
}

export function createDeskStore(send: (request: AdaptiveRequest, opts: { signal: AbortSignal }) => Promise<AdaptiveResponse<Judgments>> = postAdapt) {
  return createAdaptiveWorkspace({
    catalog: CATALOG,
    words: WORDS,
    send,
    linked: linkedRecords,
    // Short names for the link tags: a ticket's id, a customer's name, an article's title.
    anchorLabel: (ref) =>
      ref.itemKind === "ticket"
        ? ref.itemId
        : ref.itemKind === "customer"
          ? ref.client
          : ref.itemKind === "article"
            ? ARTICLES.find((a) => a.id === ref.itemId)?.title
            : (ref.client ?? ref.itemId),
  });
}

export type DeskStore = ReturnType<typeof createDeskStore>;
