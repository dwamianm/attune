/**
 * Focus aid 4, "Prepare for meetings", the pure parts: which meeting is
 * upcoming (lead time, the started window, focus time skipped, prepared and
 * dismissed skipped, any clock), the records Jev ranks, the prep view's
 * links and order from a ranking, the thing to handle first, the view
 * changes, the plan, the notes heading, and the simulated meeting.
 */
import { describe, expect, it } from "vitest";
import { CLIENTS, EVENTS, INVOICES, MESSAGES, PROJECTS, TASKS, type CalendarEvent } from "../../shared/fixtures.ts";
import type { AnchorRef, LayoutPlan, PrepJudgments } from "../../shared/types.ts";
import type { AppData, PanelViewState, PrepRanking } from "./contract.ts";
import {
  buildPrepPlan,
  buildPrepRecords,
  isPrepLead,
  meetingUnderway,
  notesHeading,
  PREP_ANCHOR_REASON,
  PREP_CLIENT_SCORE,
  PREP_LEAD_DEFAULT,
  PREP_RECORDS_MAX,
  PREP_STARTED_GRACE_MS,
  PREP_TAG,
  PREP_TEXT_MAX,
  prepLeadMs,
  prepMeetingWords,
  prepPanels,
  prepRecordWords,
  prepSignature,
  prepViewPatches,
  rankingFrom,
  recentClient,
  SIMULATED_MEETING_IN_MS,
  simulatedMeeting,
  startsInText,
  upcomingMeeting,
  urgentLine,
  withNotesHeading,
} from "./meetingPrep.ts";
import { traditionalPlan } from "./policy.ts";
import { ev, scoreJ } from "./test-helpers.ts";

const MIN = 60_000;

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

const harbor = EVENTS.find((e) => e.id === "e-2")!;
/** Twelve minutes before the Harbor rebrand review, on the fixtures' own day. */
const beforeHarbor = Date.parse(harbor.start) - 12 * MIN;

function event(id: string, startsInMin: number, kind: CalendarEvent["kind"] = "meeting", client: string | null = "Harbor Coffee Co.", now = 0): CalendarEvent {
  const start = now + startsInMin * MIN;
  return { id, title: `Event ${id}`, start: new Date(start).toISOString(), end: new Date(start + 30 * MIN).toISOString(), client, kind };
}

const none = new Set<string>();

describe("the upcoming meeting", () => {
  it("offers a meeting or call with a client that starts within the lead time", () => {
    const lead = 15 * MIN;
    expect(upcomingMeeting({ events: [event("a", 16)], now: 0, leadMs: lead, prepared: none, dismissed: none })).toBeNull();
    expect(upcomingMeeting({ events: [event("a", 15)], now: 0, leadMs: lead, prepared: none, dismissed: none })?.id).toBe("a");
    expect(upcomingMeeting({ events: [event("a", 12, "call")], now: 0, leadMs: lead, prepared: none, dismissed: none })?.id).toBe("a");
    // A shorter lead time waits longer.
    expect(upcomingMeeting({ events: [event("a", 12)], now: 0, leadMs: 5 * MIN, prepared: none, dismissed: none })).toBeNull();
  });

  it("keeps a meeting for five minutes after it starts, then drops it", () => {
    const lead = 15 * MIN;
    expect(upcomingMeeting({ events: [event("a", -4)], now: 0, leadMs: lead, prepared: none, dismissed: none })?.id).toBe("a");
    expect(upcomingMeeting({ events: [event("a", -6)], now: 0, leadMs: lead, prepared: none, dismissed: none })).toBeNull();
    expect(meetingUnderway(event("a", -4).start, 0)).toBe(false);
    expect(meetingUnderway(new Date(-PREP_STARTED_GRACE_MS - 1).toISOString(), 0)).toBe(true);
  });

  it("skips focus time, internal meetings, meetings without a client, and meetings prepared for or dismissed", () => {
    const lead = 15 * MIN;
    const events = [event("focus", 5, "focus"), event("internal", 5, "internal"), event("noclient", 5, "meeting", null), event("prepared", 6), event("dismissed", 7)];
    const input = { events, now: 0, leadMs: lead, prepared: new Set(["prepared"]), dismissed: new Set(["dismissed"]) };
    expect(upcomingMeeting(input)).toBeNull();
    expect(upcomingMeeting({ ...input, dismissed: none })?.id).toBe("dismissed");
  });

  it("picks the soonest start, and reads the clock only from `now`", () => {
    const events = [event("later", 14), event("sooner", 9)];
    expect(upcomingMeeting({ events, now: 0, leadMs: 15 * MIN, prepared: none, dismissed: none })?.id).toBe("sooner");
    // The same events at another time: the clock is injected, never read.
    expect(upcomingMeeting({ events, now: 10 * MIN, leadMs: 15 * MIN, prepared: none, dismissed: none })?.id).toBe("sooner");
    expect(upcomingMeeting({ events, now: -2 * MIN, leadMs: 15 * MIN, prepared: none, dismissed: none })?.id).toBe("sooner");
    // Once the sooner one is more than five minutes in, the later one is offered.
    expect(upcomingMeeting({ events, now: 15 * MIN, leadMs: 15 * MIN, prepared: none, dismissed: none })?.id).toBe("later");
    expect(upcomingMeeting({ events, now: 30 * MIN, leadMs: 15 * MIN, prepared: none, dismissed: none })).toBeNull();
  });

  it("finds the Harbor rebrand review in the fixtures twelve minutes before it", () => {
    expect(upcomingMeeting({ events: EVENTS, now: beforeHarbor, leadMs: prepLeadMs(undefined), prepared: none, dismissed: none })?.id).toBe("e-2");
    expect(upcomingMeeting({ events: EVENTS, now: beforeHarbor, leadMs: prepLeadMs(10), prepared: none, dismissed: none })).toBeNull();
  });

  it("counts down in whole minutes and says it in words for Jev", () => {
    const start = new Date(12 * MIN - 5_000).toISOString();
    expect(startsInText(start, 0)).toBe("in 12 min");
    expect(startsInText(new Date(30_000).toISOString(), 0)).toBe("in 1 min");
    expect(startsInText(new Date(0).toISOString(), 30_000)).toBe("now");
    expect(startsInText(new Date(0).toISOString(), 3 * MIN + 10_000)).toBe("started 3 min ago");
    expect(prepMeetingWords(harbor, beforeHarbor)).toEqual({ title: "Harbor rebrand review", client: "Harbor Coffee Co.", time: "starts in 12 minutes, at 11:00 today", kind: "meeting" });
    const meridian = EVENTS.find((e) => e.id === "e-4")!;
    expect(prepMeetingWords(meridian, Date.parse(meridian.start) + 2 * MIN)).toMatchObject({ time: "started 2 minutes ago, at 15:30 today", kind: "call" });
  });

  it("reads the lead time from the saved setting, a listed option or the default", () => {
    expect(prepLeadMs(undefined)).toBe(PREP_LEAD_DEFAULT * MIN);
    expect(prepLeadMs(30)).toBe(30 * MIN);
    expect(prepLeadMs(7)).toBe(PREP_LEAD_DEFAULT * MIN);
    expect([5, 10, 15, 30].every(isPrepLead)).toBe(true);
    expect(isPrepLead("15")).toBe(false);
  });
});

describe("the records Jev ranks", () => {
  it("lists the client's recent messages, open invoices, open project, and open tasks, the ones with an action due first", () => {
    const records = buildPrepRecords(harbor, data(), beforeHarbor);
    // INV-1040 is paid, so it is not open business.
    expect(records.map((r) => r.record.id)).toEqual(["invoice:INV-1042", "message:m-1", "task:t-1", "project:p-harbor"]);
    expect(records.map((r) => r.record.panel)).toEqual(["invoices", "inbox", "tasks", "projects"]);
    expect(records[0].record.fields).toEqual({
      id: "INV-1042",
      client: "Harbor Coffee Co.",
      status: "overdue",
      due: "14 days overdue",
      amount: "$4,200",
      project: "Harbor rebrand",
      reminders: "1 reminder sent",
    });
    expect(records[1].record.fields).toMatchObject({ from: "Priya Nair", client: "Harbor Coffee Co.", subject: "Re: Invoice INV-1042", received: "today at 8:12", status: "unread" });
    expect(records[2].record.fields).toEqual({ title: "Resend INV-1042 to Harbor accounts team", client: "Harbor Coffee Co.", due: "due today", assignee: "Sam Rivera" });
    expect(records[3].record.fields).toMatchObject({ name: "Harbor rebrand", client: "Harbor Coffee Co.", status: "on track", progress: "70% done" });
    // Code sees an action due on three of them, all about INV-1042.
    expect(records.map((r) => r.fact ?? null)).toEqual(["INV-1042 is 14 days overdue", "Priya Nair's message is unread", '"Resend INV-1042 to Harbor accounts team" is due today', null]);
    expect(records.map((r) => r.about)).toEqual([["INV-1042"], ["INV-1042"], ["INV-1042"], []]);
  });

  it("clips a long message, leaves out old messages and done tasks, and never sends more than ten", () => {
    const d = data();
    d.messages.push({ id: "m-long", from: "Priya Nair", client: "Harbor Coffee Co.", subject: "Long", preview: "x".repeat(500), receivedAt: new Date(beforeHarbor - 60 * MIN).toISOString(), unread: false, flagged: false });
    d.messages.push({ id: "m-old", from: "Priya Nair", client: "Harbor Coffee Co.", subject: "Old", preview: "Old news", receivedAt: new Date(beforeHarbor - 30 * 24 * 60 * MIN).toISOString(), unread: false, flagged: false });
    for (let i = 0; i < 12; i++) d.tasks.push({ id: `t-x${i}`, title: `Task ${i}`, due: "2099-01-01", project: null, client: "Harbor Coffee Co.", done: i % 2 === 0, assignee: "Sam Rivera" });
    const records = buildPrepRecords(harbor, d, beforeHarbor);
    expect(records.length).toBeLessThanOrEqual(PREP_RECORDS_MAX);
    const long = records.find((r) => r.record.id === "message:m-long")!;
    expect(long.record.fields.text.length).toBe(PREP_TEXT_MAX);
    expect(long.record.fields.text.endsWith("…")).toBe(true);
    expect(records.some((r) => r.record.id === "message:m-old")).toBe(false);
    expect(records.filter((r) => r.record.kind === "task").every((r) => !d.tasks.find((t) => `task:${t.id}` === r.record.id)?.done)).toBe(true);
  });

  it("has nothing for a meeting without a client, and words for a record it would not pick", () => {
    expect(buildPrepRecords({ client: null }, data(), beforeHarbor)).toEqual([]);
    const riley = prepRecordWords("message", "m-10", data(), beforeHarbor);
    expect(riley?.record.fields).toMatchObject({ from: "Riley Chen", client: "No client company", status: "read" });
    expect(prepRecordWords("client", "c-harbor", data(), beforeHarbor)).toBeNull();
  });

  it("changes its signature only when the records Jev reads change", () => {
    const d = data();
    const a = prepSignature(buildPrepRecords(harbor, d, beforeHarbor));
    expect(prepSignature(buildPrepRecords(harbor, d, beforeHarbor + 60_000))).toBe(a);
    d.messages = d.messages.map((m) => (m.id === "m-1" ? { ...m, unread: false } : m));
    expect(prepSignature(buildPrepRecords(harbor, d, beforeHarbor))).not.toBe(a);
  });
});

/** A ranking with these shares (of a three-level scale) and this anything-urgent. */
function ranking(shares: Record<string, number>, urgent: number, source: PrepRanking["source"] = "jev"): PrepRanking {
  const judgments: PrepJudgments = { scores: Object.fromEntries(Object.entries(shares).map(([id, s]) => [id, scoreJ(s * 2, 2)])), anythingUrgent: urgent };
  return rankingFrom(
    Object.keys(shares).map((id) => ({ id, kind: "message", panel: "inbox", fields: { x: "y" } })),
    judgments,
    source,
  );
}

describe("the prep view's links", () => {
  const candidates = () => buildPrepRecords(harbor, data(), beforeHarbor);

  it("orders the linked panels by the best score of their records, Clients at its fixed score, and tints the records Jev rates useful", () => {
    const r = ranking({ "message:m-1": 1, "invoice:INV-1042": 0.9, "task:t-1": 0.6, "project:p-harbor": 0.4 }, 0.9);
    const made = prepPanels(candidates(), r, "Harbor Coffee Co.");
    expect(made.order).toEqual(["inbox", "invoices", "tasks", "clients", "projects"]);
    expect(made.source).toBe("jev");
    for (const id of made.order) expect(made.relations[id]).toMatchObject({ anchorPanel: "calendar", tag: PREP_TAG });
    expect(made.relations.inbox?.records.map((x) => x.itemId)).toEqual(["m-1"]);
    expect(made.relations.inbox?.reason).toBe("1 message from Harbor Coffee Co.");
    expect(made.relations.invoices?.reason).toBe("1 open invoice for Harbor Coffee Co.");
    expect(made.relations.clients?.records).toEqual([{ itemKind: "client", itemId: "c-harbor", label: "Harbor Coffee Co." }]);
    expect(made.relations.clients?.reason).toBe("Harbor Coffee Co. is the client");
    // Nothing in Projects reaches the tint line, so its best record is tinted, and it ranks after Clients.
    expect(made.relations.projects?.records.map((x) => x.itemId)).toEqual(["p-harbor"]);
    expect(made.relations.projects?.reason).toBe("Harbor rebrand is the project");
    expect(PREP_CLIENT_SCORE).toBe(0.5);
  });

  it("uses code's order before Jev answers: the records with an action due first, Clients last", () => {
    const made = prepPanels(candidates(), null, "Harbor Coffee Co.");
    expect(made.order).toEqual(["invoices", "inbox", "tasks", "projects", "clients"]);
    expect(made.source).toBe("code");
  });

  it("names one thing to handle first when Jev says something is urgent, grouping records about the same invoice", () => {
    const r = ranking({ "message:m-1": 1, "invoice:INV-1042": 0.9, "task:t-1": 0.8, "project:p-harbor": 0.9 }, 0.91);
    expect(urgentLine(candidates(), r)).toEqual({ count: 1, text: "1 thing to handle first: INV-1042 is 14 days overdue", record: "invoice:INV-1042" });
    // Under the urgent line, or before an answer: nothing.
    expect(urgentLine(candidates(), ranking({ "invoice:INV-1042": 1 }, 0.4))).toBeNull();
    expect(urgentLine(candidates(), null)).toBeNull();
  });

  it("counts separate things, the best scored first, and names Jev's top record when code sees no action due", () => {
    const meridian = EVENTS.find((e) => e.id === "e-4")!;
    const now = Date.parse(meridian.start) - 8 * MIN;
    const list = buildPrepRecords(meridian, data(), now);
    const r = ranking({ "message:m-2": 1, "invoice:INV-1038": 0.8, "project:p-meridian": 0.7 }, 0.8);
    expect(urgentLine(list, r)).toEqual({ count: 2, text: "2 things to handle first: Hannah Brooks's message is unread", record: "message:m-2" });
    const juniper = EVENTS.find((e) => e.id === "e-6")!;
    const jlist = buildPrepRecords(juniper, data(), Date.parse(juniper.start) - 10 * MIN);
    expect(urgentLine(jlist, ranking({ "message:m-7": 1, "invoice:INV-1050": 0.5 }, 0.7))).toEqual({ count: 1, text: "1 thing to handle first: Luis Ortega's message", record: "message:m-7" });
  });

  it("changes the views the way the user would: the meeting selected, the client's records shown", () => {
    const v = view();
    v.projects.status = "blocked";
    v.clients.query = "pinecrest";
    expect(prepViewPatches(harbor, candidates(), v, beforeHarbor)).toEqual([
      { panel: "calendar", patch: { selectedId: "e-2", range: "today" } },
      { panel: "inbox", patch: { client: "Harbor Coffee Co.", query: "" } },
      { panel: "invoices", patch: { client: "Harbor Coffee Co.", status: "unpaid" } },
      { panel: "tasks", patch: { client: "Harbor Coffee Co.", showDone: false } },
      { panel: "projects", patch: { status: "all" } },
      { panel: "clients", patch: { query: "" } },
    ]);
    // Nothing to show in a panel: it is left alone.
    const juniper = EVENTS.find((e) => e.id === "e-6")!;
    const now = Date.parse(juniper.start) - 10 * MIN;
    expect(prepViewPatches(juniper, buildPrepRecords(juniper, data(), now), view(), now).map((p) => p.panel)).toEqual(["calendar", "inbox", "invoices"]);
  });

  it("builds the plan: Calendar the anchor, the linked panels with their relations at least standard and not quiet, docked ones added, nothing docked", () => {
    const base: LayoutPlan = traditionalPlan();
    const plan0: LayoutPlan = {
      ...base,
      placements: base.placements
        .filter((p) => p.id !== "projects")
        .map((p) =>
          p.id === "tasks"
            ? { ...p, size: "compact" as const, quiet: true, unquietSize: "standard" as const }
            : p.id === "inbox"
              ? { ...p, relation: { anchorPanel: "invoices" as const, tag: "Linked to X", reason: "r", records: [] } }
              : p,
        ),
      docked: [...base.docked, "projects"],
    };
    const anchor: AnchorRef = { panel: "calendar", itemKind: "event", itemId: "e-2", client: "Harbor Coffee Co.", at: 5, source: "work" };
    const made = prepPanels(candidates(), null, "Harbor Coffee Co.");
    const plan = buildPrepPlan(plan0, { anchor, order: made.order, relations: made.relations, title: "Harbor rebrand review" });
    const byId = new Map(plan.placements.map((p) => [p.id, p]));
    expect(byId.get("calendar")).toMatchObject({ anchor: true, reason: PREP_ANCHOR_REASON });
    expect(byId.get("tasks")).toMatchObject({ size: "standard", relation: { tag: PREP_TAG } });
    expect(byId.get("tasks")?.quiet).toBeUndefined();
    expect(byId.get("inbox")?.relation?.tag).toBe(PREP_TAG);
    expect(byId.get("projects")).toMatchObject({ size: "standard", relation: { tag: PREP_TAG } });
    expect(plan.placements.at(-1)?.id).toBe("projects");
    expect(plan.docked).not.toContain("projects");
    expect(plan.anchor).toEqual(anchor);
    expect(plan.decisions).toEqual([{ kind: "command", text: "Prepared for Harbor rebrand review" }]);
  });
});

describe("meeting notes and the simulated meeting", () => {
  it("writes a short heading, after any notes already there", () => {
    expect(notesHeading(harbor)).toBe("Harbor rebrand review, 11:00, notes:");
    expect(withNotesHeading("", "H, 11:00, notes:")).toBe("H, 11:00, notes:\n");
    expect(withNotesHeading("Call Priya\n\n", "H, 11:00, notes:")).toBe("Call Priya\n\nH, 11:00, notes:\n");
  });

  it("simulates a meeting ten minutes out with the client of the newest work, else the newest client message", () => {
    const events = [ev("item_open", 1, "invoices", { itemKind: "invoice", itemId: "INV-1047", client: "Kite & Co." }), ev("setting_change", 2)];
    expect(recentClient(events, data())).toBe("Kite & Co.");
    expect(recentClient([], data())).toBe("Harbor Coffee Co.");
    const m = simulatedMeeting(events, data(), 1_000_000, 3)!;
    expect(m).toMatchObject({ id: "e-sim-3", title: "Packaging system check-in", client: "Kite & Co.", kind: "meeting" });
    expect(Date.parse(m.start) - 1_000_000).toBe(SIMULATED_MEETING_IN_MS);
    expect(upcomingMeeting({ events: [m], now: 1_000_000, leadMs: prepLeadMs(undefined), prepared: none, dismissed: none })?.id).toBe("e-sim-3");
    expect(CLIENTS.some((c) => c.name === m.client)).toBe(true);
  });
});
