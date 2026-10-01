/**
 * Turns Jev's command-bar judgments into what the UI should do.
 *
 * Jev picks the panel, the action, and the arguments from fixed lists; this
 * file decides whether that is confident enough to act on, to ask about, or
 * to give up on. A command can open panels and set filters, but it never runs
 * a side-effecting action by itself: a confident action becomes a suggestion
 * the user still has to click.
 */
import { ACTIONS, PANELS, panelTitle, type PanelId } from "../../shared/catalog.ts";
import { CLIENT_NAMES, INVOICES, PROJECTS, type Invoice, type Message, type Project } from "../../shared/fixtures.ts";
import type { ChoiceJudgment, CommandJudgments, Decision, InvoiceStatusArg, Suggestion } from "../../shared/types.ts";
import type { CommandOutcome, PanelViewState } from "./contract.ts";
import { makeSuggestion, type PolicyLiveData } from "./policy.ts";
import { humanizeId, p2 } from "./words.ts";

/** Panel confidence needed to act on a command. */
export const COMMAND_APPLY_AT = 0.6;
/** Panel confidence needed to offer "did you mean" options instead of giving up. */
export const COMMAND_CONFIRM_AT = 0.35;
/** Argument confidence needed to set a filter from it. */
export const COMMAND_ARG_AT = 0.55;
/**
 * Action confidence needed to offer the action as a primary suggestion. Lower
 * than the 0.7 used for passive next steps: here the user typed the request,
 * and in a busy session Jev read "remind meridian to pay" at 0.60. It is still
 * only a suggestion; a command never performs an action by itself.
 */
export const COMMAND_ACTION_AT = 0.55;
/** Most alternatives offered on "confirm" and "unclear". */
export const COMMAND_OPTION_LIMIT = 3;

/** One patch for one panel's view state. */
export type ViewPatch = {
  [P in keyof PanelViewState]: { panel: P; patch: Partial<PanelViewState[P]> };
}[keyof PanelViewState];

export interface CommandResolution {
  outcome: CommandOutcome;
  /** Panel to make the hero in focus mode, or null when nothing is applied. */
  promote: PanelId | null;
  viewPatches: ViewPatch[];
  /** A confident action from the command, offered as a primary suggestion. Never performed here. */
  suggestion: Suggestion | null;
  /** Change-feed entry for an applied command. */
  decision: Decision | null;
  /**
   * The client and invoice an applied command names, for its anchor (the
   * link color, tags, and lines). Empty when it names neither.
   */
  subject: { client?: string; invoiceId?: string };
}

export interface ResolveOptions {
  /** The user picked this panel from the options, so treat it as applied. */
  forcePanel?: PanelId;
  /** Live invoices, so a reminder suggestion does not point at a paid invoice. */
  invoices?: Invoice[];
  /** Live messages and projects, so a suggestion names the exact record. */
  messages?: Message[];
  projects?: Project[];
  /** Current view state, so a command keeps a selection that still fits. */
  view?: PanelViewState;
}

/** An invoice id written in the command ("mark INV-1047 paid") that exists. */
export function namedInvoiceId(text: string, invoices: Invoice[] = INVOICES): string | undefined {
  const m = /\binv[-\s]?(\d{3,6})\b/i.exec(text);
  if (!m) return undefined;
  const id = `INV-${m[1]}`;
  return invoices.some((i) => i.id === id) ? id : undefined;
}

/** Whether an invoice shows under a status tab (the same rule as the Invoices panel). */
function inStatus(inv: Invoice, status: InvoiceStatusArg | "all"): boolean {
  if (status === "all" || status === "not_mentioned") return true;
  if (status === "unpaid") return inv.status === "sent" || inv.status === "overdue";
  return inv.status === status;
}

/** The argument's value when it is confident and actually mentioned, else null. */
function confidentArg<K extends string>(j: ChoiceJudgment<K> | undefined): K | null {
  if (!j || j.choice === "not_mentioned" || (j.confidence ?? 0) < COMMAND_ARG_AT) return null;
  return j.choice;
}

/** True when the argument's top choice is "not_mentioned", so a command resets that filter. */
function notMentioned(j: ChoiceJudgment<string> | undefined): boolean {
  return !j || j.choice === "not_mentioned";
}

function panelOptions(cmd: CommandJudgments): CommandOutcome["options"] {
  return (Object.entries(cmd.panel.probabilities ?? {}) as [string, number][])
    .filter((entry): entry is [PanelId, number] => entry[0] !== "unclear" && entry[0] in PANELS)
    .sort((a, b) => b[1] - a[1])
    .slice(0, COMMAND_OPTION_LIMIT)
    .map(([panel, probability]) => ({ panel, label: panelTitle(panel), probability }));
}

function viewFor(
  panel: PanelId,
  cmd: CommandJudgments,
  ctx: { suggestion: Suggestion | null; namedInvoice?: string; invoices: Invoice[]; view?: PanelViewState },
): { patches: ViewPatch[]; showing: string } {
  const rawClient = confidentArg(cmd.client);
  const client = rawClient && CLIENT_NAMES.includes(rawClient) ? rawClient : null;
  const resetClient = notMentioned(cmd.client);
  const patches: ViewPatch[] = [];
  switch (panel) {
    case "invoices": {
      const current = ctx.view?.invoices;
      const patch: Partial<PanelViewState["invoices"]> = {};
      let status = confidentArg(cmd.invoiceStatus);
      // The bill the command acts on (a suggested reminder, mark-paid, or resend) or names.
      const invoiceActs = ["mark_invoice_paid", "send_payment_reminder", "resend_invoice"];
      const actsOn = ctx.suggestion && invoiceActs.includes(ctx.suggestion.actionId) ? ctx.suggestion.args.invoiceId : undefined;
      const focusId = actsOn ?? ctx.namedInvoice;
      const focus = focusId ? ctx.invoices.find((i) => i.id === focusId) : undefined;
      // "Mark the pinecrest bill as paid" is not a request to see paid bills:
      // that bill is not paid yet, and the Paid tab would hide it.
      if (focus && status && !inStatus(focus, status)) status = "all";
      if (status) patch.status = status;
      else if (notMentioned(cmd.invoiceStatus)) patch.status = "all";
      if (client) patch.client = client;
      else if (resetClient) patch.client = null;
      if (focus) {
        if (patch.client !== undefined && patch.client !== null && patch.client !== focus.client) patch.client = focus.client;
        patch.selectedId = focus.id;
      } else {
        // Keep the open invoice when it still fits the new filter, so the detail pane does not jump.
        const sel = current?.selectedId ? ctx.invoices.find((i) => i.id === current.selectedId) : undefined;
        const nextStatus = patch.status ?? current?.status ?? "all";
        const nextClient = patch.client !== undefined ? patch.client : (current?.client ?? null);
        patch.selectedId = sel && inStatus(sel, nextStatus) && (!nextClient || sel.client === nextClient) ? sel.id : null;
      }
      patches.push({ panel: "invoices", patch });
      const statusWord = patch.status && patch.status !== "all" ? `${humanizeId(patch.status)} ` : "";
      const who = patch.client ? ` for ${patch.client}` : "";
      return { patches, showing: focus && !actsOn ? `Showing ${focus.id}${who}` : `Showing ${statusWord}invoices${who}` };
    }
    case "inbox": {
      const patch: Partial<PanelViewState["inbox"]> = {};
      if (client) patch.client = client;
      else if (resetClient) patch.client = null;
      patches.push({ panel: "inbox", patch });
      return { patches, showing: patch.client ? `Showing messages from ${patch.client}` : "Showing Inbox" };
    }
    case "clients": {
      if (client) patches.push({ panel: "clients", patch: { selected: client } });
      return { patches, showing: client ? `Showing ${client}` : "Showing Clients" };
    }
    case "tasks": {
      const patch: Partial<PanelViewState["tasks"]> = {};
      if (client) patch.client = client;
      else if (resetClient) patch.client = null;
      patches.push({ panel: "tasks", patch });
      return { patches, showing: patch.client ? `Showing tasks for ${patch.client}` : "Showing Tasks" };
    }
    case "projects": {
      const project = client ? PROJECTS.find((p) => p.client === client) : undefined;
      if (project) patches.push({ panel: "projects", patch: { selectedId: project.id } });
      return { patches, showing: project ? `Showing ${project.name} for ${project.client}` : "Showing Projects" };
    }
    case "calendar": {
      const tf = confidentArg(cmd.timeframe);
      // The calendar offers today and this week; a month request shows the week, the closest view.
      const range = tf === "today" ? "today" : tf ? "this_week" : null;
      if (range) patches.push({ panel: "calendar", patch: { range } });
      return { patches, showing: range === "today" ? "Showing today's calendar" : range ? "Showing this week's calendar" : "Showing Calendar" };
    }
    case "analytics": {
      const tf = confidentArg(cmd.timeframe);
      if (tf) patches.push({ panel: "analytics", patch: { range: "this_month" } });
      return { patches, showing: tf ? "Showing revenue for this month" : `Showing ${panelTitle("analytics")}` };
    }
    default:
      return { patches, showing: `Showing ${panelTitle(panel)}` };
  }
}

function actionSuggestion(cmd: CommandJudgments, live: PolicyLiveData): Suggestion | null {
  const a = cmd.action;
  if (!a || a.choice === "none" || !ACTIONS[a.choice] || (a.confidence ?? 0) < COMMAND_ACTION_AT) return null;
  const rawClient = confidentArg(cmd.client);
  const client = rawClient && CLIENT_NAMES.includes(rawClient) ? rawClient : undefined;
  return makeSuggestion(a.choice, "primary", a.confidence, client, "You asked for this in the command bar", live);
}

/**
 * A suggestion whose result the command already shows would be a no-op
 * button: "Open Atlas Robotics" right after the command opened it, or "Write
 * a note" right after it opened Notes.
 */
function redundant(s: Suggestion | null, target: PanelId, patches: ViewPatch[]): boolean {
  if (!s) return false;
  if (s.actionId === "write_note") return target === "notes";
  if (s.actionId !== "view_client" || target !== "clients") return false;
  const selected = patches.find((p) => p.panel === "clients")?.patch as Partial<PanelViewState["clients"]> | undefined;
  return !s.args.client || selected?.selected === s.args.client;
}

/**
 * Decide what a judged command does. Applied commands promote a panel and set
 * filters; they skip order hysteresis and the minimum change interval in the
 * store, because the user asked.
 */
export function resolveCommand(cmd: CommandJudgments, text: string, opts: ResolveOptions = {}): CommandResolution {
  const invoices = opts.invoices ?? INVOICES;
  const namedInvoice = namedInvoiceId(text, invoices);
  const live: PolicyLiveData = {
    invoices,
    ...(opts.messages ? { messages: opts.messages } : {}),
    ...(opts.projects ? { projects: opts.projects } : {}),
    ...(namedInvoice ? { invoiceId: namedInvoice } : {}),
  };
  let suggestion = actionSuggestion(cmd, live);
  const choice = cmd.panel?.choice;
  const conf = cmd.panel?.confidence ?? 0;
  const forced = opts.forcePanel && PANELS[opts.forcePanel] ? opts.forcePanel : null;
  const target: PanelId | null = forced ?? (choice && choice !== "unclear" && choice in PANELS && conf >= COMMAND_APPLY_AT ? (choice as PanelId) : null);

  if (target) {
    const { patches, showing } = viewFor(target, cmd, { suggestion, invoices, ...(namedInvoice ? { namedInvoice } : {}), ...(opts.view ? { view: opts.view } : {}) });
    if (redundant(suggestion, target, patches)) suggestion = null;
    const message = suggestion ? `${showing}. Suggested: ${suggestion.label}` : showing;
    const p = cmd.panel?.probabilities?.[target] ?? 0;
    const rawClient = confidentArg(cmd.client);
    const named = namedInvoice ? invoices.find((i) => i.id === namedInvoice) : undefined;
    const client = rawClient && CLIENT_NAMES.includes(rawClient) ? rawClient : named?.client;
    return {
      subject: { ...(client ? { client } : {}), ...(namedInvoice ? { invoiceId: namedInvoice } : {}) },
      outcome: { text, status: "applied", options: [], message },
      promote: target,
      viewPatches: patches,
      suggestion,
      decision: {
        kind: "command",
        panel: target,
        text: `Opened ${panelTitle(target)} because you asked`,
        evidence: forced ? `picked by you, command panel ${target} p=${p2(p)}` : `command panel ${target} p=${p2(p)}, confidence ${p2(conf)}`,
      },
    };
  }

  const options = panelOptions(cmd);
  const confirm = choice !== "unclear" && conf >= COMMAND_CONFIRM_AT && options.length > 0;
  return {
    outcome: {
      text,
      status: confirm ? "confirm" : "unclear",
      options,
      message: confirm ? "Did you mean one of these?" : "Not sure what you mean. Pick a panel or try other words.",
    },
    promote: null,
    viewPatches: [],
    suggestion,
    decision: null,
    subject: {},
  };
}
