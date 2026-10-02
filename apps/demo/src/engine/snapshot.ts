/**
 * The demo's part of the snapshot Jev reads. The rules (the observations,
 * the thresholds, collapsing repeats, the focus fallback) and the sentences
 * for the core event types are in @attuneui/core (snapshot.ts). This file adds
 * the demo's words: its record kinds, its actions in the past tense, the
 * sentences for its own event types (Up next, Back to, the focus aids, the
 * link cues), what its focused panel shows from its view state, and how to
 * count its own event types (SIGNAL_PROFILE).
 *
 * Pure: scripts/eval.ts and the tests import it in Node, so it must never
 * touch the DOM or the store.
 */
import {
  buildSnapshot as coreBuildSnapshot,
  deriveObservations as coreDeriveObservations,
  describeCoreEvent,
  focusSequence as coreFocusSequence,
  humanizeId,
  inPanel as inPanelOf,
  openedWhat as openedWhatOf,
  panelTitleOf,
  possessive,
  RECENT_WINDOW_MS,
  signalProfile,
  viaSuffix,
  type EventWords,
  type FocusDetails,
} from "@attuneui/core";
import { PANELS, type ActionId, type PanelId } from "../../shared/catalog.ts";
import { CLIENTS, INVOICES, MESSAGES, PROJECTS } from "../../shared/fixtures.ts";
import type { ItemKind, SignalDetail, SignalEvent, SignalType, TrackInput } from "../../shared/types.ts";
import type { BuildSnapshot, DeriveObservations, DescribeEvent, SnapshotContext } from "./contract.ts";

/**
 * How the library counts the demo's own event types. Opening a record from
 * Up next, starting the next task from the Done card (which opens its first
 * record), or preparing for a meeting (which selects it in Calendar) is a
 * record open and work in that panel. The cue-only types are about the app's
 * own cues or bookkeeping, not the work: logged for the inspector's Signals
 * tab and never put in the snapshot, so clearing the link cues, the engine
 * saving a working context (context_save, which the user did not do),
 * switching a focus aid on or off (setting_change), the engine saying the
 * work is done (task_done), or the engine offering to prepare for a meeting
 * (prep_offer) cannot change what Jev judges.
 */
export const SIGNAL_PROFILE = signalProfile<SignalType>({
  recordOpen: ["up_next_open", "task_start", "prep_start"],
  work: ["up_next_open", "task_start", "prep_start"],
  pointer: ["up_next_open", "task_start", "prep_start", "context_restore"],
  cueOnly: ["links_dismiss", "context_save", "setting_change", "task_done", "prep_offer"],
});

/** Event types that mean "the user is working in this panel". Used for focus order. */
export const WORK_TYPES = SIGNAL_PROFILE.work;

const ITEM_WORDS: Record<ItemKind, string> = {
  invoice: "invoice",
  message: "message",
  client: "client",
  project: "project",
  task: "task",
  event: "calendar event",
  person: "team member",
  note: "note",
};

/** Past-tense sentence for a performed action. Exported so the store and tests agree on wording. */
export function actionPast(actionId: ActionId, detail: SignalDetail = {}): string {
  const client = detail.client;
  switch (actionId) {
    case "send_payment_reminder":
      return `Sent a payment reminder${client ? ` to ${client}` : ""}${detail.itemId ? ` for ${detail.itemId}` : ""}`;
    case "mark_invoice_paid":
      if (detail.itemId) return `Marked invoice ${detail.itemId} as paid`;
      return client ? `Marked ${possessive(client)} invoice as paid` : "Marked an invoice as paid";
    case "resend_invoice":
      return `Resent ${detail.itemId ? `invoice ${detail.itemId}` : "an invoice"}${client ? ` to ${client}` : ""}`;
    case "reply_to_message":
      return client ? `Replied to ${client}` : "Replied to a message";
    case "schedule_meeting":
      return client ? `Scheduled a meeting with ${client}` : "Scheduled a meeting";
    case "create_task":
      if (detail.label) return `Added a task: "${detail.label}"`;
      return client ? `Added a task for ${client}` : "Added a task";
    case "update_project_status":
      return client ? `Updated the status of ${possessive(client)} project` : "Updated a project's status";
    case "view_client":
      return client ? `Opened the details for ${client}` : "Opened a client's details";
    case "write_note":
      return "Wrote a note";
    case "none":
      return "Took an action";
  }
}

/** The demo's words for the core sentences: panel titles, record kinds, and its actions in the past tense. */
export const WORDS: EventWords<PanelId> = {
  panels: PANELS,
  itemWords: ITEM_WORDS,
  actionPast: (actionId, detail) => actionPast(actionId as ActionId, detail as SignalDetail),
};

function title(panel: PanelId | undefined): string | null {
  return panelTitleOf(WORDS, panel);
}

function inPanel(panel: PanelId | undefined): string {
  return inPanelOf(WORDS, panel);
}

function openedWhat(d: SignalDetail): string {
  return openedWhatOf(d, WORDS);
}

/** Reads like a record open, so Jev sees the same record words: "Opened invoice INV-1038 ... in Invoices from Up next". */
function describeUpNextOpen(input: TrackInput): string {
  const d = input.detail ?? {};
  return `Opened ${openedWhat(d)}${inPanel(input.panel)} from Up next${d.via === "keyboard" ? ", using the keyboard" : ""}`;
}

/**
 * Preparing for a meeting (focus aid 4), with the meeting in the same words
 * as a record open: "Started preparing for calendar event Harbor rebrand
 * review, 11:00 today in Calendar".
 */
function describePrepStart(input: TrackInput): string {
  const d = input.detail ?? {};
  return `Started preparing for ${openedWhat(d)}${inPanel(input.panel)}${d.via === "keyboard" ? ", using the keyboard" : ""}`;
}

/**
 * Starting the next task from the Done card (focus aid 2), with the record it
 * opened in the same words as a record open: "Started the next task: two
 * unread client messages, and opened message ... in Inbox".
 */
function describeTaskStart(input: TrackInput): string {
  const d = input.detail ?? {};
  const opened = d.itemId || d.label ? `, and opened ${openedWhat(d)}${inPanel(input.panel)}` : "";
  return `Started the next task: ${d.task ?? "the next piece of work"}${opened}${d.via === "keyboard" ? ", using the keyboard" : ""}`;
}

/**
 * One plain English sentence per event. Uses panel titles, never raw ids.
 * The demo's own event types are here; the core ones are describeCoreEvent.
 */
export const describeEvent: DescribeEvent = (input) => {
  const d = input.detail ?? {};
  switch (input.type) {
    case "links_dismiss": {
      const t = title(d.linkedPanel);
      if (t) return `Removed the link to ${t}${viaSuffix(d)}`;
      return `Cleared the links${d.label ? ` for ${d.label}` : ""}${viaSuffix(d)}`;
    }
    case "up_next_open":
      return describeUpNextOpen(input);
    // Engine-made and left out of the snapshot (cue-only in SIGNAL_PROFILE); for the inspector's Signals tab.
    case "context_save":
      return `Saved ${d.label ?? "the previous work"} for Back to`;
    case "context_restore":
      return `Went back to earlier work: ${d.label ?? "a saved layout"}${viaSuffix(d)}`;
    // A settings switch, left out of the snapshot (cue-only in SIGNAL_PROFILE); for the inspector's Signals tab.
    case "setting_change":
      return `Turned ${d.enabled === false ? "off" : "on"} "${d.label ?? d.setting ?? "a setting"}"${viaSuffix(d)}`;
    // Engine-made (focus aid 2) and left out of the snapshot (cue-only in SIGNAL_PROFILE); for the inspector's Signals tab.
    case "task_done":
      return `Said "${d.label ?? "the current work"}" is done${d.task ? `, and offered the next task: ${d.task}` : ""}`;
    case "task_start":
      return describeTaskStart(input);
    // Engine-made (focus aid 4) and left out of the snapshot (cue-only in SIGNAL_PROFILE); for the inspector's Signals tab.
    case "prep_offer":
      return `Offered to prepare for ${d.label ?? "a meeting"}`;
    case "prep_start":
      return describePrepStart(input);
    default:
      return describeCoreEvent({ type: input.type, ...(input.panel ? { panel: input.panel } : {}), ...(input.detail ? { detail: input.detail } : {}) }, WORDS);
  }
};

const OBSERVATIONS = { profile: SIGNAL_PROFILE, words: WORDS, helpPanel: "help" as const };

/**
 * Code-derived behavior facts as short sentences, included only when true
 * (deriveObservations in @attuneui/core), with the demo's Guide as its help panel.
 */
export const deriveObservations: DeriveObservations = (events, now) => coreDeriveObservations(events, now, OBSERVATIONS);

/** Recent focus order, with consecutive repeats collapsed. */
export function focusSequence(events: SignalEvent[], now: number, windowMs = RECENT_WINDOW_MS): PanelId[] {
  return coreFocusSequence(events, now, SIGNAL_PROFILE, windowMs);
}

// ---------------------------------------------------------------------------
// Current focus
// ---------------------------------------------------------------------------

function clientName(value: string): string {
  return CLIENTS.find((c) => c.id === value)?.name ?? value;
}

/**
 * What the focused panel is showing, from view state. When nothing names the
 * record on screen, the library names the last record opened there.
 */
function focusDetails(ctx: SnapshotContext): FocusDetails {
  const panel = ctx.focusedPanel;
  const view = ctx.view;
  const parts: string[] = [];
  if (!panel) return { parts, hasSelection: false };
  switch (panel) {
    case "inbox": {
      const v = view?.inbox;
      const m = v?.selectedId ? MESSAGES.find((x) => x.id === v.selectedId) : undefined;
      if (m) parts.push(`reading "${m.subject}" from ${m.from}`);
      if (v?.query) parts.push(`searching for "${v.query}"`);
      if (v?.client) parts.push(`showing messages from ${v.client}`);
      break;
    }
    case "invoices": {
      const v = view?.invoices;
      if (v?.selectedId) {
        const inv = INVOICES.find((x) => x.id === v.selectedId);
        parts.push(`viewing invoice ${v.selectedId}${inv ? ` for ${inv.client}` : ""}`);
      }
      if (v && v.status !== "all" && v.status !== "not_mentioned") parts.push(`showing ${humanizeId(v.status)} invoices`);
      if (v?.client) parts.push(`filtered to ${v.client}`);
      break;
    }
    case "clients": {
      const v = view?.clients;
      if (v?.selected) parts.push(`viewing ${clientName(v.selected)}`);
      if (v?.query) parts.push(`searching for "${v.query}"`);
      break;
    }
    case "tasks": {
      const v = view?.tasks;
      if (v?.client) parts.push(`showing tasks for ${v.client}`);
      if (v?.showDone) parts.push("including done tasks");
      break;
    }
    case "projects": {
      const v = view?.projects;
      const p = v?.selectedId ? PROJECTS.find((x) => x.id === v.selectedId) : undefined;
      if (p) parts.push(`viewing ${p.name} for ${p.client}`);
      if (v && v.status !== "all") parts.push(`showing ${humanizeId(v.status)} projects`);
      break;
    }
    case "calendar":
      if (view) parts.push(view.calendar.range === "today" ? "showing today" : "showing this week");
      break;
    case "analytics":
      if (view) parts.push(view.analytics.range === "this_month" ? "showing this month" : "showing this year");
      break;
    default:
      break;
  }
  return { parts, hasSelection: parts.some((p) => p.startsWith("viewing") || p.startsWith("reading")) };
}

/**
 * The words-only picture Jev reads: recent activity (oldest first), the
 * current focus, the panels on screen, and code-derived observations (plus
 * ctx.habits, the user's habits in words, when focus aid 3 is on).
 */
export const buildSnapshot: BuildSnapshot = (events, ctx) =>
  coreBuildSnapshot(events, ctx, {
    ...OBSERVATIONS,
    describe: describeEvent,
    focusDetails: () => focusDetails(ctx),
  });
