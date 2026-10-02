/**
 * The playground's vocabulary: a small help desk. Four panels, four goals,
 * three next steps. Descriptions are sent to Jev, so they are concrete and
 * literal.
 */
import { defineCatalog, type Catalog } from "@attuneui/core";

export const PANEL_IDS = ["tickets", "customers", "articles", "macros"] as const;
export type PanelId = (typeof PANEL_IDS)[number];

export const GOAL_IDS = ["answer_tickets", "research_issue", "manage_customer", "write_macros", "unclear"] as const;
export type GoalId = (typeof GOAL_IDS)[number];

export const ACTION_IDS = ["reply_ticket", "solve_ticket", "send_article", "none"] as const;
export type ActionId = (typeof ACTION_IDS)[number];

export type RecordKind = "ticket" | "customer" | "article" | "macro";

export const CATALOG: Catalog<PanelId, GoalId, ActionId> = defineCatalog<PanelId, GoalId, ActionId>({
  panelIds: PANEL_IDS,
  panels: {
    tickets: {
      id: "tickets",
      title: "Tickets",
      description: "Support tickets from customers, with status (open, pending, solved) and priority. The agent reads, replies to, and solves tickets here.",
      icon: "Inbox",
      defaultVisible: true,
    },
    customers: {
      id: "customers",
      title: "Customers",
      description: "The companies that use the product, with their plan and contact person.",
      icon: "Building2",
      defaultVisible: true,
    },
    articles: {
      id: "articles",
      title: "Articles",
      description: "Help articles that explain how to use the product. The agent searches them and sends one to a customer.",
      icon: "BookOpen",
      defaultVisible: true,
    },
    macros: {
      id: "macros",
      title: "Macros",
      description: "Saved replies the agent can reuse in a ticket, such as a refund answer or a password reset answer.",
      icon: "MessageSquareText",
      defaultVisible: false,
    },
  },
  goalIds: GOAL_IDS,
  goals: {
    answer_tickets: { label: "Answering tickets", description: "Reading open tickets and replying to customers." },
    research_issue: { label: "Researching an issue", description: "Looking for how something works, for example in the help articles, to answer a ticket." },
    manage_customer: { label: "Working on one customer", description: "Looking at one customer company: its plan, contact, and tickets." },
    write_macros: { label: "Writing saved replies", description: "Reading or writing macros, the saved replies." },
    unclear: { label: "Not sure yet", description: "There is too little activity, or the activity is too mixed, to tell what the agent is working on." },
  },
  actionIds: ACTION_IDS,
  actions: {
    reply_ticket: { id: "reply_ticket", label: "Reply to the ticket", description: "Write a reply to the open ticket.", panel: "tickets" },
    solve_ticket: { id: "solve_ticket", label: "Mark the ticket solved", description: "Mark the open ticket as solved because the customer has their answer.", panel: "tickets" },
    send_article: { id: "send_article", label: "Send a help article", description: "Send a help article to the customer of the open ticket.", panel: "articles" },
    none: { id: "none", label: "", description: "There is no clear next step to suggest right now.", panel: null },
  },
  goalPanelAffinity: {
    answer_tickets: { tickets: 1, macros: 0.6, articles: 0.5, customers: 0.3 },
    research_issue: { articles: 1, tickets: 0.5 },
    manage_customer: { customers: 1, tickets: 0.7 },
    write_macros: { macros: 1, articles: 0.4 },
    unclear: {},
  },
});
