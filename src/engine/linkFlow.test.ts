import { describe, expect, it } from "vitest";
import { EVENTS, INVOICES, MESSAGES, PROJECTS, TASKS } from "../../shared/fixtures.ts";
import type { ActionId } from "../../shared/catalog.ts";
import type { AnchorRef } from "../../shared/types.ts";
import type { AppData, PanelViewState } from "./contract.ts";
import {
  CLICKED_TEXT_MAX,
  actionFits,
  clickedRecordWords,
  confidentLinkNext,
  followUpSuggestion,
  followUpTask,
  LINK_ACTION_MIN_P,
  LINK_NEXT_LEAN_P,
  LINK_NEXT_MARGIN,
  LINK_NEXT_MIN_P,
  LINK_NEXT_NONE_MAX,
  LINK_STEP_MS,
  linkCandidates,
  linkPanelOrder,
  linkRequestFor,
  linkStepFrom,
  recordShortName,
  stepLive,
  stepSuggestion,
} from "./linkFlow.ts";
import { findLinked } from "./relations.ts";
import { choiceJ } from "./test-helpers.ts";

const NOW = Date.now();

function data(): AppData {
  return {
    invoices: structuredClone(INVOICES),
    messages: structuredClone(MESSAGES),
    tasks: structuredClone(TASKS),
    projects: structuredClone(PROJECTS),
    events: structuredClone(EVENTS),
    notes: "",
  };
}

function view(): PanelViewState {
  return {
    inbox: { query: "", selectedId: null, client: null },
    invoices: { status: "all", client: null, selectedId: null },
    clients: { selected: null, query: "" },
    tasks: { showDone: false, client: null, selectedId: null },
    projects: { status: "all", selectedId: null },
    calendar: { range: "today", selectedId: null },
    analytics: { range: "this_year" },
    team: {},
    notes: {},
    help: {},
  };
}

/** Priya Nair's "Re: Invoice INV-1042", clicked in Inbox: the user's case. */
const priya: AnchorRef = { panel: "inbox", itemKind: "message", itemId: "m-1", client: "Harbor Coffee Co.", label: "Priya Nair", at: 1, source: "work" };
const inv1042: AnchorRef = { panel: "invoices", itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co.", label: "INV-1042", at: 2, source: "work" };

describe("what the request carries", () => {
  it("writes the clicked record out field by field, a message's text clipped", () => {
    expect(clickedRecordWords(priya, data(), NOW)).toEqual({
      id: "message:m-1",
      kind: "message",
      fields: {
        from: "Priya Nair",
        client: "Harbor Coffee Co.",
        subject: "Re: Invoice INV-1042",
        text: "Sorry for the delay. Can you resend the invoice to our accounts team? The old email bounced.",
      },
    });
    const long = data();
    long.messages[0] = { ...long.messages[0], preview: "word ".repeat(200) };
    expect(clickedRecordWords(priya, long, NOW)?.fields.text?.length).toBeLessThanOrEqual(CLICKED_TEXT_MAX);
    expect(clickedRecordWords(inv1042, data(), NOW)?.fields).toMatchObject({ id: "INV-1042", client: "Harbor Coffee Co.", status: "overdue", amount: "$4,200" });
    expect(clickedRecordWords({ itemKind: "task", itemId: "t-1" }, data(), NOW)?.fields).toMatchObject({ title: "Resend INV-1042 to Harbor accounts team", due: "due today" });
    expect(clickedRecordWords({ itemKind: "project", itemId: "p-atlas" }, data(), NOW)?.fields).toEqual({ name: "Pitch deck", status: "blocked" });
    expect(clickedRecordWords({ itemKind: "event", itemId: "e-2" }, data(), NOW)?.fields.title).toBe("Harbor rebrand review");
    // A client or a person row says nothing it asks for: no link questions.
    expect(clickedRecordWords({ itemKind: "client", itemId: "c-harbor" }, data(), NOW)).toBeNull();
    expect(clickedRecordWords({ itemKind: "message", itemId: "m-404" }, data(), NOW)).toBeNull();
  });

  it("offers the first linked record of each panel, the closest link first, with why it is linked", () => {
    const records = linkCandidates(priya, data(), view(), NOW);
    expect(records.map((r) => r.id).slice(0, 2)).toEqual(["invoice:INV-1042", "task:t-1"]);
    expect(records[0].why).toBe("the clicked message names this invoice");
    expect(records[1].why).toBe("this task names INV-1042, which the clicked message names");
    expect(records.some((r) => r.id === "client:c-harbor" && r.why === "the client of the clicked message")).toBe(true);
    // Team members have no panel selection to open, so they are never offered.
    expect(records.some((r) => r.kind === "person")).toBe(false);
    expect(records.some((r) => r.panel === "inbox")).toBe(false);
    const request = linkRequestFor(priya, data(), view(), NOW);
    expect(request?.clicked.id).toBe("message:m-1");
    expect(request?.records).toEqual(records);
  });

  it("offers an invoice's client message and to-do item as naming it", () => {
    const records = linkCandidates(inv1042, data(), view(), NOW);
    expect(records.find((r) => r.id === "message:m-1")?.why).toBe("this message names the clicked invoice");
    expect(records.find((r) => r.id === "task:t-1")?.why).toBe("this task names the clicked invoice");
  });
});

describe("the Next gate", () => {
  it("says Next at LINK_NEXT_MIN_P, or at the lean with a clear lead and little on none", () => {
    expect(confidentLinkNext(choiceJ<string>("invoice:INV-1042", 0.9, { "invoice:INV-1042": LINK_NEXT_MIN_P, "task:t-1": 0.3, none: 0.2 }))).toEqual({ id: "invoice:INV-1042", p: LINK_NEXT_MIN_P });
    const lean = LINK_NEXT_LEAN_P + 0.05;
    expect(confidentLinkNext(choiceJ<string>("invoice:INV-1042", 0.5, { "invoice:INV-1042": lean, "task:t-1": lean - LINK_NEXT_MARGIN - 0.01, none: LINK_NEXT_NONE_MAX - 0.05 }))?.id).toBe("invoice:INV-1042");
    // A near tie, a real share on none, too little, or none itself: not sure.
    expect(confidentLinkNext(choiceJ<string>("invoice:INV-1042", 0.3, { "invoice:INV-1042": lean, "task:t-1": lean - 0.05, none: 0.1 }))).toBeNull();
    expect(confidentLinkNext(choiceJ<string>("invoice:INV-1042", 0.3, { "invoice:INV-1042": lean, "task:t-1": 0.1, none: LINK_NEXT_NONE_MAX + 0.05 }))).toBeNull();
    expect(confidentLinkNext(choiceJ<string>("invoice:INV-1042", 0.3, { "invoice:INV-1042": LINK_NEXT_LEAN_P - 0.01, none: 0.1 }))).toBeNull();
    expect(confidentLinkNext(choiceJ<string>("none", 0.9, { none: 0.9 }))).toBeNull();
    expect(confidentLinkNext(undefined)).toBeNull();
  });
});

describe("the order of the linked panels", () => {
  const d = data();
  const linked = findLinked(priya, d, { view: view(), now: NOW });
  const panels = (["clients", "tasks", "invoices"] as const).map((id, i) => ({ id, records: linked[id]!, priority: 0.5 - i * 0.01 }));

  it("follows link-next when Jev is sure", () => {
    const sure = choiceJ<string>("task:t-1", 0.8, { "task:t-1": 0.8, "invoice:INV-1042": 0.15, "client:c-harbor": 0.05 });
    expect(linkPanelOrder(priya, panels, d, sure)).toEqual({ order: ["tasks", "invoices", "clients"], source: "jev" });
  });

  it("falls back to code's order when Jev is unsure or down: the same record id first, then the same client", () => {
    const unsure = choiceJ<string>("client:c-harbor", 0.2, { "client:c-harbor": 0.35, "task:t-1": 0.33, none: 0.32 });
    expect(linkPanelOrder(priya, panels, d, unsure)).toEqual({ order: ["invoices", "tasks", "clients"], source: "code" });
    expect(linkPanelOrder(priya, panels, d)).toEqual({ order: ["invoices", "tasks", "clients"], source: "code" });
  });
});

describe("the step", () => {
  const d = data();
  const request = linkRequestFor(priya, d, view(), NOW)!;
  const sure = choiceJ<string>("invoice:INV-1042", 0.95, { "invoice:INV-1042": 0.95, "task:t-1": 0.03, none: 0.02 });
  const resend = choiceJ<ActionId>("resend_invoice", 0.98, { resend_invoice: 0.98, none: 0.02 });

  it("names the record and, when it fits, what to do there", () => {
    const step = linkStepFrom({ at: 1, clicked: request.clicked, records: request.records, linkNext: sure, linkAction: resend, data: d, now: NOW });
    expect(step).toMatchObject({
      at: 1,
      from: "message:m-1",
      fromLabel: "Priya Nair's message",
      record: { id: "invoice:INV-1042", panel: "invoices" },
      action: "resend_invoice",
      tag: "Next: resend INV-1042",
      phrase: "to resend it",
      probability: 0.95,
    });
  });

  it("only opens the record when the action does not fit it or Jev is unsure of the action, and is null when Jev is unsure of the record", () => {
    const onTask = linkStepFrom({ at: 1, clicked: request.clicked, records: request.records, linkNext: choiceJ<string>("task:t-1", 0.9, { "task:t-1": 0.9 }), linkAction: resend, data: d, now: NOW });
    expect(onTask).toMatchObject({ action: null, tag: "Next: open Resend INV-1042 to Harbor accounts team" });
    expect(onTask?.phrase).toBeUndefined();
    const vague = choiceJ<ActionId>("resend_invoice", 0.2, { resend_invoice: LINK_ACTION_MIN_P - 0.1, reply_to_message: 0.3 });
    expect(linkStepFrom({ at: 1, clicked: request.clicked, records: request.records, linkNext: sure, linkAction: vague, data: d, now: NOW })?.tag).toBe("Next: open INV-1042");
    const unsure = choiceJ<string>("invoice:INV-1042", 0.2, { "invoice:INV-1042": 0.35, "task:t-1": 0.33 });
    expect(linkStepFrom({ at: 1, clicked: request.clicked, records: request.records, linkNext: unsure, linkAction: resend, data: d, now: NOW })).toBeNull();
    // A record that was not offered never becomes the step.
    expect(linkStepFrom({ at: 1, clicked: request.clicked, records: request.records, linkNext: choiceJ<string>("invoice:INV-9999", 0.9, { "invoice:INV-9999": 0.9 }), data: d, now: NOW })).toBeNull();
  });

  it("goes stale after LINK_STEP_MS, or once its action no longer fits the record", () => {
    const step = linkStepFrom({ at: 1, clicked: request.clicked, records: request.records, linkNext: sure, linkAction: resend, data: d, now: NOW })!;
    expect(stepLive(step, d, NOW + LINK_STEP_MS)).toBe(true);
    expect(stepLive(step, d, NOW + LINK_STEP_MS + 1)).toBe(false);
    const paid = data();
    paid.invoices = paid.invoices.map((i) => (i.id === "INV-1042" ? { ...i, status: "paid" as const } : i));
    expect(stepLive(step, paid, NOW)).toBe(false);
  });

  it("offers its action as the primary suggestion only while its record is open, on exactly that record", () => {
    const step = linkStepFrom({ at: 1, clicked: request.clicked, records: request.records, linkNext: sure, linkAction: resend, data: d, now: NOW })!;
    const ctx = { data: d, view: view(), events: [], now: NOW };
    expect(stepSuggestion(step, { ...ctx, current: "message:m-1" })).toBeNull();
    expect(stepSuggestion(step, { ...ctx, current: "invoice:INV-1042" })).toMatchObject({
      actionId: "resend_invoice",
      label: "Resend INV-1042 to Harbor Coffee Co.",
      prominence: "primary",
      args: { invoiceId: "INV-1042", client: "Harbor Coffee Co." },
      nextStep: true,
    });
  });

  it("fits actions to records", () => {
    expect(actionFits("resend_invoice", "invoice", "INV-1042", d)).toBe(true);
    expect(actionFits("resend_invoice", "invoice", "INV-1052", d)).toBe(false); // A draft was never sent.
    expect(actionFits("resend_invoice", "invoice", "INV-1040", d)).toBe(false); // Paid.
    expect(actionFits("resend_invoice", "task", "t-1", d)).toBe(false);
    expect(actionFits("reply_to_message", "message", "m-1", d)).toBe(true);
    expect(actionFits("schedule_meeting", "client", "c-juniper", d)).toBe(true);
    expect(recordShortName("message:m-1", d)).toBe("Priya Nair's message");
  });
});

describe("the follow-up", () => {
  it("finds the open to-do item that is the work just done, and never checks it off itself", () => {
    const d = data();
    expect(followUpTask("resend_invoice", "invoice", "INV-1042", d)?.id).toBe("t-1");
    // Other work on the same invoice is not that to-do item.
    expect(followUpTask("send_payment_reminder", "invoice", "INV-1042", d)).toBeNull();
    expect(followUpTask("reply_to_message", "message", "m-5", d)?.id).toBe("t-6");
    const done = data();
    done.tasks = done.tasks.map((t) => (t.id === "t-1" ? { ...t, done: true } : t));
    expect(followUpTask("resend_invoice", "invoice", "INV-1042", done)).toBeNull();
    const s = followUpSuggestion(d.tasks.find((t) => t.id === "t-1")!, "Follows what you just did");
    expect(s).toMatchObject({ actionId: "none", label: "Check off: Resend INV-1042 to Harbor accounts team", prominence: "primary", task: { id: "t-1" }, args: { taskId: "t-1" } });
    expect(d.tasks.find((t) => t.id === "t-1")?.done).toBe(false);
  });
});
