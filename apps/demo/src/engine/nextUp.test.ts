import { describe, expect, it } from "vitest";
import { CLIENTS, EVENTS, INVOICES, MESSAGES, PROJECTS, TASKS } from "../../shared/fixtures.ts";
import type { AnchorRef, RecordCandidate } from "../../shared/types.ts";
import type { AppData, PanelViewState } from "./contract.ts";
import {
  actionApplies,
  buildRecordCandidates,
  CHECK_OFF_TASK,
  chooseUpNext,
  confidentRecord,
  currentRecord,
  detectListWork,
  LIST_WORK_WINDOW_MS,
  nextInList,
  queueDone,
  queueModeOn,
  RECORD_CANDIDATES_MAX,
  recordCardText,
  revealPatch,
  UP_NEXT_DISMISS_MS,
  type UpNextInput,
} from "./nextUp.ts";
import { describeEvent } from "./snapshot.ts";
import { choiceJ, ev } from "./test-helpers.ts";

/** Today at 10:30 local time: after stand-up, before the Harbor review at 11:00. */
const NOW = (() => {
  const d = new Date();
  d.setHours(10, 30, 0, 0);
  return d.getTime();
})();

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

function view(patch: Partial<PanelViewState> = {}): PanelViewState {
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
    ...patch,
  };
}

const open = (id: string, client: string, t = NOW - 10_000) => ev("item_open", t, "invoices", { itemKind: "invoice", itemId: id, client });
const remind = (id: string, t = NOW - 5_000) => ev("action", t, "invoices", { actionId: "send_payment_reminder", itemId: id });

describe("buildRecordCandidates", () => {
  it("with no current record offers unread client messages, tasks due today, the next event today, and overdue invoices, in that order", () => {
    const c = buildRecordCandidates({ data: data(), view: view(), anchor: null, links: null, events: [], now: NOW });
    expect(c.map((x) => x.id)).toEqual([
      "message:m-1",
      "message:m-2",
      "message:m-3",
      "task:t-1",
      "task:t-6",
      "event:e-2",
      "invoice:INV-1038",
      "invoice:INV-1042",
      "invoice:INV-1047",
    ]);
    expect(c.find((x) => x.id === "message:m-1")?.why).toBe("unread message from Harbor Coffee Co.");
    expect(c.find((x) => x.id === "task:t-1")?.why).toBe("task due today");
    expect(c.find((x) => x.id === "event:e-2")?.why).toBe("next event today");
    expect(c.find((x) => x.id === "invoice:INV-1038")?.why).toBe("overdue, no reminder today");
  });

  it("labels records the way the panels label their opens", () => {
    const c = buildRecordCandidates({ data: data(), view: view(), anchor: null, links: null, events: [], now: NOW });
    expect(c.find((x) => x.id === "invoice:INV-1038")).toEqual({
      id: "invoice:INV-1038",
      kind: "invoice",
      panel: "invoices",
      label: "INV-1038 · Meridian Hotels · overdue 36 days · $12,800",
      client: "Meridian Hotels",
      why: "overdue, no reminder today",
    });
    expect(c.find((x) => x.id === "message:m-1")?.label).toBe('"Re: Invoice INV-1042" from Priya Nair at Harbor Coffee Co.');
    expect(c.find((x) => x.id === "task:t-1")?.label).toBe("Resend INV-1042 to Harbor accounts team (due today)");
  });

  it("puts the next records in the current filtered list first and leaves out the current one", () => {
    const events = [open("INV-1038", "Meridian Hotels")];
    const c = buildRecordCandidates({ data: data(), view: view({ invoices: { status: "overdue", client: null, selectedId: "INV-1038" } }), anchor: null, links: null, events, now: NOW });
    expect(c.slice(0, 2).map((x) => [x.id, x.why])).toEqual([
      ["invoice:INV-1042", "next in the list"],
      ["invoice:INV-1047", "next in the list"],
    ]);
    expect(c.some((x) => x.id === "invoice:INV-1038")).toBe(false);
  });

  it("adds records linked to the anchor, one per linked panel, and stops at the cap", () => {
    const anchor: AnchorRef = { panel: "invoices", itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co.", label: "INV-1042", at: NOW - 1_000, source: "work" };
    const c = buildRecordCandidates({ data: data(), view: view(), anchor, links: null, events: [], now: NOW });
    expect(c).toHaveLength(RECORD_CANDIDATES_MAX);
    expect(c.map((x) => x.id)).toEqual([
      "invoice:INV-1047",
      "invoice:INV-1049",
      "invoice:INV-1050",
      "message:m-1",
      "client:c-harbor",
      "project:p-harbor",
      "message:m-2",
      "message:m-3",
      "message:m-5",
      "task:t-1",
      "task:t-6",
      "event:e-2",
    ]);
    expect(c.find((x) => x.id === "client:c-harbor")?.why).toBe("linked to INV-1042");
  });

  it("leaves out records handled this session: a reminder sent, a reply drafted, a task checked off, marked paid, a project updated", () => {
    const events = [
      remind("INV-1038", NOW - 50_000),
      ev("action", NOW - 40_000, "inbox", { actionId: "reply_to_message", itemId: "m-1", client: "Harbor Coffee Co." }),
      ev("action", NOW - 30_000, "tasks", { label: "Checked off task: Resend INV-1042 to Harbor accounts team", itemKind: "task", itemId: "t-1" }),
      ev("action", NOW - 20_000, "invoices", { actionId: "mark_invoice_paid", itemId: "INV-1042" }),
      ev("action", NOW - 10_000, "projects", { actionId: "update_project_status", itemId: "p-meridian" }),
    ];
    const ids = buildRecordCandidates({ data: data(), view: view(), anchor: null, links: null, events, now: NOW }).map((x) => x.id);
    for (const handled of ["invoice:INV-1038", "message:m-1", "task:t-1", "invoice:INV-1042", "project:p-meridian"]) expect(ids).not.toContain(handled);
    // Reopening the task takes it back off the handled list.
    const reopened = [
      ...events,
      ev("action", NOW - 5_000, "tasks", { label: "Reopened task: Resend INV-1042 to Harbor accounts team", itemKind: "task", itemId: "t-1" }),
      open("INV-1049", "Pinecrest Clinic", NOW - 1_000),
    ];
    expect(buildRecordCandidates({ data: data(), view: view(), anchor: null, links: null, events: reopened, now: NOW }).map((x) => x.id)).toContain("task:t-1");
  });

  it("is deterministic", () => {
    const input = { data: data(), view: view(), anchor: null, links: null, events: [open("INV-1047", "Kite & Co.")], now: NOW };
    expect(buildRecordCandidates(input)).toEqual(buildRecordCandidates(structuredClone(input)));
  });
});

describe("nextInList", () => {
  it("walks on from the current record, then from the top, and skips settled and handled records", () => {
    const d = data();
    const current = currentRecord([open("INV-1042", "Harbor Coffee Co.")], null)!;
    const overdue = view({ invoices: { status: "overdue", client: null, selectedId: null } });
    expect(nextInList(current, d, overdue, NOW)).toEqual(["invoice:INV-1047", "invoice:INV-1038"]);
    expect(nextInList(current, d, overdue, NOW, (k) => k === "invoice:INV-1047")).toEqual(["invoice:INV-1038"]);
    // "All" lists paid invoices last; walking skips them.
    const all = nextInList(current, d, view(), NOW, () => false, 20);
    expect(all).not.toContain("invoice:INV-1031");
    expect(all.slice(0, 2)).toEqual(["invoice:INV-1047", "invoice:INV-1049"]);
  });
});

describe("the repeated action", () => {
  it("applies only where it still makes sense", () => {
    const d = data();
    const none = new Set<string>();
    const applies = (action: string | undefined, kind: RecordCandidate["kind"], id: string, handled: Set<string> = none) => actionApplies(action, kind, id, d, handled);
    // A reminder: overdue invoices with no reminder sent this session, never sent, draft, or paid ones.
    expect(applies("send_payment_reminder", "invoice", "INV-1047")).toBe(true);
    expect(applies("send_payment_reminder", "invoice", "INV-1047", new Set(["invoice:INV-1047"]))).toBe(false);
    for (const id of ["INV-1049", "INV-1052", "INV-1031"]) expect(applies("send_payment_reminder", "invoice", id)).toBe(false);
    // Marking paid: sent or overdue invoices.
    expect(["INV-1047", "INV-1049", "INV-1052", "INV-1031"].map((id) => applies("mark_invoice_paid", "invoice", id))).toEqual([true, true, false, false]);
    // A reply: unread messages (m-4 is read).
    expect(["m-1", "m-4"].map((id) => applies("reply_to_message", "message", id))).toEqual([true, false]);
    // A status update: projects at risk or blocked.
    expect(["p-meridian", "p-atlas", "p-harbor"].map((id) => applies("update_project_status", "project", id))).toEqual([true, true, false]);
    // Checking off: tasks not done (t-8 is done).
    expect(["t-1", "t-8"].map((id) => applies(CHECK_OFF_TASK, "task", id))).toEqual([true, false]);
    // Other kinds, other actions, and no action keep the plain list walk.
    expect(applies("send_payment_reminder", "message", "m-4")).toBe(true);
    expect(applies("schedule_meeting", "invoice", "INV-1052")).toBe(true);
    expect(applies(undefined, "invoice", "INV-1052")).toBe(true);
  });

  it("walks only the overdue invoices without a reminder under the All filter, then says the list is done", () => {
    const d = data();
    const twice = [open("INV-1038", "Meridian Hotels", NOW - 60_000), remind("INV-1038", NOW - 55_000), open("INV-1042", "Harbor Coffee Co.", NOW - 40_000), remind("INV-1042", NOW - 35_000)];
    const nextOf = (events: typeof twice) =>
      buildRecordCandidates({ data: d, view: view(), anchor: null, links: null, events, now: NOW })
        .filter((c) => c.why === "next in the list")
        .map((c) => c.id);
    // Not INV-1049, INV-1050 (sent, not due yet), or the drafts.
    expect(nextOf(twice)).toEqual(["invoice:INV-1047"]);
    expect(queueDone(detectListWork(twice, NOW), twice, d)).toBeNull();

    const thrice = [...twice, open("INV-1047", "Kite & Co.", NOW - 20_000), remind("INV-1047", NOW - 15_000)];
    expect(nextOf(thrice)).toEqual([]);
    expect(queueDone(detectListWork(thrice, NOW), thrice, d)).toEqual({ text: "All overdue invoices have a reminder.", eventId: thrice.at(-1)!.id });
    // The next unrelated action ends it.
    const moved = [...thrice, ev("item_open", NOW - 5_000, "inbox", { itemKind: "message", itemId: "m-2" })];
    expect(queueDone(detectListWork(moved, NOW), moved, d)).toBeNull();
    // List work from opening records repeats no action, so it has no completion state.
    const opens = [open("INV-1038", "Meridian Hotels", NOW - 30_000), open("INV-1042", "Harbor Coffee Co.", NOW - 20_000), open("INV-1047", "Kite & Co.", NOW - 10_000)];
    expect(queueDone(detectListWork(opens, NOW), opens, d)).toBeNull();
  });
});

describe("detectListWork", () => {
  it("is on after the same action on two records of one kind in the last few minutes, and remembers the action", () => {
    const events = [remind("INV-1038", NOW - 60_000), remind("INV-1042", NOW - 10_000)];
    expect(detectListWork(events, NOW)).toMatchObject({ on: true, kind: "invoice", action: "send_payment_reminder" });
  });

  it("is off for the same action twice on one record, different actions, or old actions", () => {
    expect(detectListWork([remind("INV-1038", NOW - 60_000), remind("INV-1038", NOW - 10_000)], NOW).on).toBe(false);
    const mixed = [remind("INV-1038", NOW - 60_000), ev("action", NOW - 10_000, "invoices", { actionId: "mark_invoice_paid", itemId: "INV-1042" })];
    expect(detectListWork(mixed, NOW).on).toBe(false);
    expect(detectListWork([remind("INV-1038", NOW - LIST_WORK_WINDOW_MS - 20_000), remind("INV-1042", NOW - LIST_WORK_WINDOW_MS - 1)], NOW).on).toBe(false);
  });

  it("counts checking off tasks, which carry no action id", () => {
    const check = (id: string, t: number) => ev("action", t, "tasks", { label: `Checked off task: ${id}`, itemKind: "task", itemId: id });
    expect(detectListWork([check("t-1", NOW - 20_000), check("t-6", NOW - 5_000)], NOW)).toMatchObject({ on: true, kind: "task", action: CHECK_OFF_TASK });
  });

  it("is on after three different records of one kind opened in a row, and off when the run breaks", () => {
    const three = [open("INV-1038", "Meridian Hotels", NOW - 30_000), open("INV-1042", "Harbor Coffee Co.", NOW - 20_000), open("INV-1047", "Kite & Co.", NOW - 10_000)];
    expect(detectListWork(three, NOW)).toMatchObject({ on: true, kind: "invoice", reason: "Opened three invoices in a row" });
    const broken = [three[0], three[1], ev("item_open", NOW - 15_000, "inbox", { itemKind: "message", itemId: "m-2" }), three[2]];
    expect(detectListWork(broken, NOW).on).toBe(false);
    const same = [open("INV-1038", "Meridian Hotels", NOW - 30_000), open("INV-1038", "Meridian Hotels", NOW - 20_000), open("INV-1038", "Meridian Hotels", NOW - 10_000)];
    expect(detectListWork(same, NOW).on).toBe(false);
  });

  it("turns queue mode on from code's signal or Jev's listWork at 0.6", () => {
    const off = { on: false, reason: "" };
    expect(queueModeOn({ on: true, kind: "invoice", reason: "x" }, undefined)).toBe(true);
    expect(queueModeOn(off, 0.6)).toBe(true);
    expect(queueModeOn(off, 0.59)).toBe(false);
    expect(queueModeOn(off, undefined)).toBe(false);
  });
});

function cand(id: string): RecordCandidate {
  const [kind, rid] = id.split(":");
  return { id, kind: kind as RecordCandidate["kind"], panel: "invoices", label: rid };
}

function input(o: Partial<UpNextInput> = {}): UpNextInput {
  return {
    candidates: ["invoice:INV-1042", "invoice:INV-1047", "invoice:INV-1049", "message:m-5", "task:t-3", "event:e-3", "client:c-kite", "task:t-9", "message:m-7", "message:m-3"].map(cand),
    judgedAt: NOW - 1_000,
    lastActionAt: null,
    queue: false,
    current: null,
    listNext: [],
    dismissed: {},
    now: NOW,
    ...o,
  };
}

describe("chooseUpNext", () => {
  it("shows Jev's pick with its probability when Jev is sure", () => {
    const pick = chooseUpNext(input({ nextRecord: choiceJ<string>("invoice:INV-1047", 0.7, { "invoice:INV-1047": 0.72, "invoice:INV-1049": 0.2, none: 0.05 }) }));
    expect(pick).toMatchObject({ source: "jev", why: "Jev 72%", probability: 0.72, candidate: { id: "invoice:INV-1047" } });
    expect(pick?.alternatives.map((a) => a.id)).toEqual(["invoice:INV-1049"]);
  });

  it("separates the eval's correct picks from its unclear sessions (September 30 run)", () => {
    const shows = (choice: string, probabilities: Record<string, number>) => confidentRecord(choiceJ(choice, probabilities[choice], probabilities))?.id ?? null;
    // Correct picks near 0.5 with a clear lead and little on "none".
    expect(shows("event:e-3", { "event:e-3": 0.46, "project:p-harbor": 0.23, none: 0.11, "event:e-4": 0.09 })).toBe("event:e-3"); // morning
    expect(shows("message:m-5", { "message:m-5": 0.44, "task:t-3": 0.16, "message:m-4": 0.14 })).toBe("message:m-5"); // reply_queue
    expect(shows("task:t-3", { "task:t-3": 0.46, "message:m-5": 0.29, none: 0.16 })).toBe("task:t-3"); // task_checkoff
    expect(shows("task:t-3", { "task:t-3": 0.56, "message:m-5": 0.23, none: 0.13 })).toBe("task:t-3"); // task_checkoff
    expect(shows("invoice:INV-1038", { "invoice:INV-1038": 0.58, "client:c-solace": 0.38, none: 0.02 })).toBe("invoice:INV-1038"); // compare
    // No clear next record: a near tie, or a real share on "none".
    expect(shows("task:t-9", { "task:t-9": 0.39, "message:m-7": 0.34, "person:u-riley": 0.21, none: 0.05 })).toBeNull(); // scattered
    expect(shows("task:t-9", { "task:t-9": 0.34, "message:m-7": 0.33, "person:u-riley": 0.26, none: 0.06 })).toBeNull(); // scattered
    expect(shows("client:c-kite", { "client:c-kite": 0.48, none: 0.23, "invoice:INV-1042": 0.13, "message:m-5": 0.13 })).toBeNull(); // stuck_reopen
  });

  it("lets code's next record win in queue mode when Jev's pick is weak (power_user: 0.26, listWork 0.93)", () => {
    const nextRecord = choiceJ<string>("task:t-6", 0.26, { "task:t-6": 0.26, "message:m-3": 0.21, "message:m-1": 0.18 });
    const queue = queueModeOn({ on: false, reason: "" }, 0.93);
    const pick = chooseUpNext(input({ nextRecord, queue, listNext: ["message:m-3", "message:m-7"] }));
    expect(pick).toMatchObject({ source: "list", why: "Next in list", candidate: { id: "message:m-3" } });
    expect(pick?.alternatives.map((a) => a.id)).toEqual(["message:m-7"]);
  });

  it("shows nothing when Jev is not sure or says none and the user is not working through a list", () => {
    expect(chooseUpNext(input({ nextRecord: choiceJ<string>("invoice:INV-1047", 0.3, { "invoice:INV-1047": 0.3, "invoice:INV-1049": 0.28 }) }))).toBeNull();
    expect(chooseUpNext(input({ nextRecord: choiceJ<string>("none", 0.9, { none: 0.9 }), listNext: ["invoice:INV-1047"] }))).toBeNull();
    // Queue mode: "none" from Jev falls back to the next record in the list.
    expect(chooseUpNext(input({ nextRecord: choiceJ<string>("none", 0.9, { none: 0.9 }), queue: true, listNext: ["invoice:INV-1047"] }))?.candidate.id).toBe("invoice:INV-1047");
  });

  it("skips handled records, the current record, and dismissed ones until the dismissal runs out", () => {
    // Handled: built candidates leave INV-1038 out after its reminder, so Jev's pick of it does not show.
    const events = [open("INV-1042", "Harbor Coffee Co.", NOW - 20_000), remind("INV-1038", NOW - 10_000)];
    const candidates = buildRecordCandidates({ data: data(), view: view(), anchor: null, links: null, events, now: NOW });
    expect(chooseUpNext(input({ candidates, nextRecord: choiceJ<string>("invoice:INV-1038", 0.9, { "invoice:INV-1038": 0.9 }) }))).toBeNull();
    // Current.
    const current = { kind: "invoice" as const, id: "INV-1047", panel: "invoices" as const, at: NOW - 1 };
    expect(chooseUpNext(input({ current, nextRecord: choiceJ<string>("invoice:INV-1047", 0.9, { "invoice:INV-1047": 0.9 }) }))).toBeNull();
    // Dismissed.
    const sure = choiceJ<string>("invoice:INV-1047", 0.9, { "invoice:INV-1047": 0.9 });
    expect(chooseUpNext(input({ nextRecord: sure, dismissed: { "invoice:INV-1047": NOW - 1_000 } }))).toBeNull();
    expect(chooseUpNext(input({ nextRecord: sure, dismissed: { "invoice:INV-1047": NOW - UP_NEXT_DISMISS_MS } }))?.candidate.id).toBe("invoice:INV-1047");
  });

  it("walks the list right after an action in queue mode, then lets the next Jev round refine it", () => {
    const nextRecord = choiceJ<string>("invoice:INV-1049", 0.8, { "invoice:INV-1049": 0.8 });
    const listNext = ["invoice:INV-1047", "invoice:INV-1049"];
    const acted = chooseUpNext(input({ nextRecord, queue: true, listNext, judgedAt: NOW - 5_000, lastActionAt: NOW - 1_000 }));
    expect(acted).toMatchObject({ source: "list", candidate: { id: "invoice:INV-1047" } });
    const refined = chooseUpNext(input({ nextRecord, queue: true, listNext, judgedAt: NOW - 500, lastActionAt: NOW - 1_000 }));
    expect(refined).toMatchObject({ source: "jev", candidate: { id: "invoice:INV-1049" } });
  });

  it("skips a sure Jev pick, and alternatives, that the repeated action no longer applies to", () => {
    const nextRecord = choiceJ<string>("invoice:INV-1049", 0.8, { "invoice:INV-1049": 0.8, "invoice:INV-1047": 0.15 });
    const current = { kind: "invoice" as const, id: "INV-1042", panel: "invoices" as const, at: NOW - 1 };
    const applies = (id: string) => id !== "invoice:INV-1049";
    // The gate is unchanged: without a repeated action, Jev's pick shows.
    expect(chooseUpNext(input({ nextRecord, queue: true, queueKind: "invoice", current, listNext: ["invoice:INV-1047"] }))?.candidate.id).toBe("invoice:INV-1049");
    const pick = chooseUpNext(input({ nextRecord, queue: true, queueKind: "invoice", applies, current, listNext: ["invoice:INV-1047"] }));
    expect(pick).toMatchObject({ source: "list", candidate: { id: "invoice:INV-1047" } });
    expect(pick?.alternatives.map((a) => a.id)).not.toContain("invoice:INV-1049");
    expect(chooseUpNext(input({ nextRecord, queue: true, queueKind: "invoice", applies, current }))).toBeNull();
  });

  it("walks only the kind of record the list work is about", () => {
    const current = { kind: "message" as const, id: "m-2", panel: "inbox" as const, at: NOW - 1 };
    expect(chooseUpNext(input({ queue: true, queueKind: "invoice", current, listNext: ["message:m-3"] }))).toBeNull();
    expect(chooseUpNext(input({ queue: true, queueKind: "message", current, listNext: ["message:m-3"] }))?.candidate.id).toBe("message:m-3");
  });
});

describe("opening a record", () => {
  it("selects the record and clears only the filter that would hide it", () => {
    const d = data();
    expect(revealPatch("invoice", "INV-1049", d, view({ invoices: { status: "overdue", client: null, selectedId: null } }), NOW)).toEqual({
      panel: "invoices",
      patch: { selectedId: "INV-1049", status: "all" },
    });
    expect(revealPatch("invoice", "INV-1042", d, view({ invoices: { status: "overdue", client: null, selectedId: null } }), NOW)).toEqual({
      panel: "invoices",
      patch: { selectedId: "INV-1042" },
    });
    expect(revealPatch("message", "m-5", d, view({ inbox: { query: "harbor", selectedId: null, client: null } }), NOW)).toEqual({
      panel: "inbox",
      patch: { selectedId: "m-5", query: "" },
    });
    expect(revealPatch("task", "t-8", d, view(), NOW)).toEqual({ panel: "tasks", patch: { selectedId: "t-8", showDone: true } });
    expect(revealPatch("client", "c-kite", d, view(), NOW)).toEqual({ panel: "clients", patch: { selected: CLIENTS.find((c) => c.id === "c-kite")?.name } });
  });

  it("reads like a record open to Jev, from Up next", () => {
    const detail = { itemKind: "invoice" as const, itemId: "INV-1038", client: "Meridian Hotels", label: "INV-1038 · Meridian Hotels · overdue 36 days · $12,800" };
    expect(describeEvent({ type: "up_next_open", panel: "invoices", detail })).toBe("Opened invoice INV-1038 · Meridian Hotels · overdue 36 days · $12,800 in Invoices from Up next");
    expect(describeEvent({ type: "up_next_open", panel: "invoices", detail: { ...detail, via: "keyboard" } })).toBe(
      "Opened invoice INV-1038 · Meridian Hotels · overdue 36 days · $12,800 in Invoices from Up next, using the keyboard",
    );
  });

  it("gives the card a short line", () => {
    const d = data();
    const c = buildRecordCandidates({ data: d, view: view(), anchor: null, links: null, events: [], now: NOW }).find((x) => x.id === "invoice:INV-1038")!;
    expect(recordCardText(c, d, NOW)).toBe("Meridian Hotels · INV-1038 · 36 days overdue");
  });
});
