/**
 * /api/adapt body validation: good bodies pass and get capped, bad ones get
 * a plain-English reason for the 400.
 */
import { describe, expect, it } from "vitest";
import { COMMAND_MAX_LENGTH } from "../shared/types.ts";
import { parseAdaptRequest } from "./validate.ts";
import { parsePrepRequest } from "./validate.ts";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 7,
    snapshot: {
      recent_activity: ["Clicked into the Invoices panel"],
      current_focus: null,
      visible_panels: ["Invoices"],
      behavior_observations: [],
    },
    candidates: { clients: ["Harbor Coffee Co."] },
    ...overrides,
  };
}

describe("parseAdaptRequest", () => {
  it("accepts a valid body", () => {
    const parsed = parseAdaptRequest(body({ command: "  atlas " }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.version).toBe(7);
      expect(parsed.value.command).toBe("atlas");
    }
  });

  it("keeps the newest 15 activity lines and clips long strings", () => {
    const activity = Array.from({ length: 20 }, (_, i) => `step ${i}`);
    activity[19] = "x".repeat(500);
    const parsed = parseAdaptRequest(
      body({ snapshot: { recent_activity: activity, current_focus: "y".repeat(400), visible_panels: [], behavior_observations: [] } }),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      const kept = parsed.value.snapshot.recent_activity;
      expect(kept).toHaveLength(15);
      expect(kept[0]).toBe("step 5");
      expect(kept[14]).toHaveLength(300);
      expect(parsed.value.snapshot.current_focus).toHaveLength(300);
    }
  });

  it("clips a long command instead of rejecting it", () => {
    // A 400 here showed as "Could not reach the server", and retrying could never work.
    const parsed = parseAdaptRequest(body({ command: `  ${"a".repeat(327)}` }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.command).toHaveLength(COMMAND_MAX_LENGTH);
  });

  it("keeps only the studio's real client names", () => {
    // Made-up names would become Jev options and heuristic patterns, and grow memory.
    const parsed = parseAdaptRequest(body({ candidates: { clients: ["Harbor Coffee Co.", "Evil Corp", " Atlas Robotics ", "x".repeat(300)] } }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.candidates.clients).toEqual(["Harbor Coffee Co.", "Atlas Robotics"]);
  });

  it("drops a blank command", () => {
    const parsed = parseAdaptRequest(body({ command: "   " }));
    expect(parsed.ok && parsed.value.command).toBe(undefined);
  });

  describe("candidates.records", () => {
    const good = {
      id: "invoice:INV-1038",
      kind: "invoice",
      panel: "invoices",
      label: "INV-1038 · Meridian Hotels · overdue 36 days · $12,800",
      client: "Meridian Hotels",
      why: "next overdue invoice in the list",
    };

    function records(list: unknown): unknown {
      const parsed = parseAdaptRequest(body({ candidates: { clients: ["Harbor Coffee Co."], records: list } }));
      expect(parsed.ok).toBe(true);
      return parsed.ok ? parsed.value.candidates.records : "rejected";
    }

    it("keeps a valid record, trimmed", () => {
      expect(records([{ ...good, id: " invoice:INV-1038 ", label: `  ${good.label} `, why: " next overdue invoice in the list " }])).toEqual([good]);
    });

    it("omits the field when there are no usable records, instead of failing the round", () => {
      // Optional: a broken value costs only the next-record questions.
      expect(records(undefined)).toBeUndefined();
      expect(records([])).toBeUndefined();
      expect(records("invoice:INV-1038")).toBeUndefined();
      expect(records({ 0: good })).toBeUndefined();
      expect(records([null, 3, "x"])).toBeUndefined();
    });

    it.each([
      ["an unknown kind", { ...good, kind: "receipt", id: "receipt:R-1" }],
      ["an unknown panel", { ...good, panel: "billing" }],
      ["an id without its kind prefix", { ...good, id: "INV-1038" }],
      ["an id for another kind", { ...good, id: "message:m-1" }],
      ["an id that is only the prefix", { ...good, id: "invoice: " }],
      ["an id over 64 characters", { ...good, id: `invoice:${"9".repeat(57)}` }],
      ["a missing label", { ...good, label: undefined }],
      ["a blank label", { ...good, label: "   " }],
      ["a numeric id", { ...good, id: 1038 }],
    ])("drops an entry with %s and keeps the rest", (_label, bad) => {
      const second = { id: "message:m-1", kind: "message", panel: "inbox", label: "\"Re: Invoice INV-1042\" from Priya Nair" };
      expect(records([bad, second])).toEqual([second]);
    });

    it("accepts an id of exactly 64 characters", () => {
      const id = `invoice:${"9".repeat(56)}`;
      expect(id).toHaveLength(64);
      expect(records([{ ...good, id }])).toEqual([{ ...good, id }]);
    });

    it("clips long labels and hints, and drops a blank hint", () => {
      const [clipped] = records([{ ...good, label: "L".repeat(500), why: "W".repeat(500) }]) as { label: string; why: string }[];
      expect(clipped?.label).toHaveLength(200);
      expect(clipped?.why).toHaveLength(120);
      const { why: _why, ...noWhy } = good;
      expect(records([{ ...good, why: "   " }])).toEqual([noWhy]);
    });

    it("drops an unknown client name but keeps the record", () => {
      // Same rule as candidates.clients: made-up names never reach Jev.
      const { client: _client, ...noClient } = good;
      expect(records([{ ...good, client: "Evil Corp" }])).toEqual([noClient]);
      expect(records([{ ...good, client: 42 }])).toEqual([noClient]);
      expect(records([{ ...good, client: " Meridian Hotels " }])).toEqual([good]);
    });

    it("keeps the first of each id and at most 12 records", () => {
      const many = Array.from({ length: 20 }, (_, i) => ({ ...good, id: `invoice:INV-${2000 + i}` }));
      const kept = records([{ ...good, label: "first" }, { ...good, label: "second" }, ...many]) as { id: string; label: string }[];
      expect(kept).toHaveLength(12);
      expect(kept[0]).toMatchObject({ id: "invoice:INV-1038", label: "first" });
      expect(kept.filter((r) => r.id === "invoice:INV-1038")).toHaveLength(1);
      expect(kept[11]?.id).toBe("invoice:INV-2010");
    });
  });

  it.each([
    ["not an object", "nope"],
    ["missing version", body({ version: undefined })],
    ["string version", body({ version: "7" })],
    ["missing snapshot", body({ snapshot: undefined })],
    ["activity not strings", body({ snapshot: { recent_activity: [1], current_focus: null, visible_panels: [], behavior_observations: [] } })],
    ["focus a number", body({ snapshot: { recent_activity: [], current_focus: 3, visible_panels: [], behavior_observations: [] } })],
    ["missing candidates", body({ candidates: undefined })],
    ["clients not strings", body({ candidates: { clients: [null] } })],
    ["command not a string", body({ command: 42 })],
  ])("rejects %s", (_label, input) => {
    const parsed = parseAdaptRequest(input);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error.length).toBeGreaterThan(0);
  });
});

describe("focus aid 2 fields", () => {
  const task = (over: Record<string, unknown> = {}) => ({
    id: "unread_messages",
    goal: "triage_inbox",
    label: "Unread client messages to reply to",
    count: "two",
    first: "\"Re: Invoice INV-1042\" from Priya Nair at Harbor Coffee Co.",
    ...over,
  });

  it("keeps a working goal, trimmed, and clips long text", () => {
    const parsed = parseAdaptRequest(body({ workingGoal: { label: "  Collecting payments ", description: "d".repeat(500) } }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.workingGoal?.label).toBe("Collecting payments");
    expect(parsed.value.workingGoal?.description.length).toBe(200);
  });

  it("drops a working goal with no label or of the wrong shape, without failing the body", () => {
    for (const workingGoal of [{ label: "  ", description: "x" }, { description: "x" }, "Collecting payments", 42, null, []]) {
      const parsed = parseAdaptRequest(body({ workingGoal }));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.workingGoal).toBeUndefined();
    }
    // A label with no description is still a working goal.
    const labelOnly = parseAdaptRequest(body({ workingGoal: { label: "Planning the day" } }));
    expect(labelOnly.ok && labelOnly.value.workingGoal).toEqual({ label: "Planning the day", description: "" });
  });

  it("keeps valid task candidates, first of each id, clipped, at most five", () => {
    const tasks = [
      task({ label: "l".repeat(300) }),
      task({ label: "Same id again" }),
      ...Array.from({ length: 6 }, (_, i) => task({ id: `task_${i}`, goal: "plan_day" })),
    ];
    const parsed = parseAdaptRequest(body({ candidates: { clients: ["Harbor Coffee Co."], tasks } }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const kept = parsed.value.candidates.tasks ?? [];
    expect(kept.map((t) => t.id)).toEqual(["unread_messages", "task_0", "task_1", "task_2", "task_3"]);
    expect(kept[0].label.length).toBe(120);
  });

  it("drops bad task entries: an unknown or unclear goal, the reserved id, a long id, or a missing label, count, or first record", () => {
    const bad = [
      task({ goal: "not_a_goal" }),
      task({ id: "b", goal: "unclear" }),
      task({ id: "none" }),
      task({ id: "x".repeat(65) }),
      task({ id: "c", label: " " }),
      task({ id: "d", count: undefined }),
      task({ id: "e", first: 7 }),
      "not an object",
      null,
    ];
    const parsed = parseAdaptRequest(body({ candidates: { clients: ["Harbor Coffee Co."], tasks: [...bad, task({ id: "ok" })] } }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.candidates.tasks?.map((t) => t.id)).toEqual(["ok"]);
  });

  it("drops candidates.tasks that is not an array, and omits the field when nothing is left", () => {
    for (const tasks of ["unread", { id: "x" }, [], [task({ goal: "nope" })]]) {
      const parsed = parseAdaptRequest(body({ candidates: { clients: ["Harbor Coffee Co."], tasks } }));
      expect(parsed.ok).toBe(true);
      if (parsed.ok) expect(parsed.value.candidates.tasks).toBeUndefined();
    }
    const good = parseAdaptRequest(body({ candidates: { clients: ["Harbor Coffee Co."], tasks: [task()] } }));
    expect(good.ok && good.value.candidates.tasks).toEqual([task()]);
  });
});

describe("parseAdaptRequest: the link request (Arrange linked panels by next step)", () => {
  const clicked = {
    id: "message:m-1",
    kind: "message",
    fields: { from: "Priya Nair", client: "Harbor Coffee Co.", subject: "Re: Invoice INV-1042", text: "Can you resend the invoice?", secret: "dropped" },
  };
  const records = [
    { id: "invoice:INV-1042", kind: "invoice", panel: "invoices", label: "INV-1042 · Harbor Coffee Co.", client: "Harbor Coffee Co.", why: "the clicked message names this invoice" },
    { id: "task:t-1", kind: "task", panel: "tasks", label: "Resend INV-1042 to Harbor accounts team" },
  ];

  it("keeps a clean clicked record and its linked records, dropping unknown fields", () => {
    const parsed = parseAdaptRequest(body({ link: { clicked, records } }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.link?.clicked).toEqual({ id: "message:m-1", kind: "message", fields: { from: "Priya Nair", client: "Harbor Coffee Co.", subject: "Re: Invoice INV-1042", text: "Can you resend the invoice?" } });
    expect(parsed.value.link?.records.map((r) => r.id)).toEqual(["invoice:INV-1042", "task:t-1"]);
  });

  it("clips a long text, and drops the whole link (never a 400) when it cannot be used", () => {
    const long = parseAdaptRequest(body({ link: { clicked: { ...clicked, fields: { text: "x".repeat(900) } }, records } }));
    expect(long.ok && long.value.link?.clicked.fields.text).toHaveLength(300);
    const cases: unknown[] = [
      "nope",
      { clicked: { ...clicked, kind: "client", id: "client:c-harbor" }, records }, // A kind the questions do not read.
      { clicked: { ...clicked, id: "invoice:INV-1042" }, records }, // The id claims another kind.
      { clicked: { ...clicked, fields: { secret: "x" } }, records }, // No usable field.
      { clicked, records: [] },
      { clicked, records: [{ ...records[0], id: "message:m-1", kind: "message", panel: "inbox" }] }, // Only the clicked record itself.
    ];
    for (const link of cases) {
      const parsed = parseAdaptRequest(body({ link }));
      expect(parsed.ok, JSON.stringify(link)).toBe(true);
      if (parsed.ok) expect(parsed.value.link, JSON.stringify(link)).toBeUndefined();
    }
  });

  it("keeps at most 8 linked records", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ id: `task:t-${i + 1}`, kind: "task", panel: "tasks", label: `Task ${i + 1}` }));
    const parsed = parseAdaptRequest(body({ link: { clicked, records: many } }));
    expect(parsed.ok && parsed.value.link?.records).toHaveLength(8);
  });
});

describe("parsePrepRequest (focus aid 4, POST /api/prep)", () => {
  const meeting = { title: "Harbor rebrand review", client: "Harbor Coffee Co.", time: "starts in 12 minutes, at 11:00 today", kind: "meeting" };
  const invoice = { id: "invoice:INV-1042", kind: "invoice", panel: "invoices", fields: { id: "INV-1042", client: "Harbor Coffee Co.", status: "overdue", due: "14 days overdue" } };

  it("accepts the meeting and its records, and drops unknown fields", () => {
    const parsed = parsePrepRequest({ version: 3, meeting, records: [{ ...invoice, fields: { ...invoice.fields, secret: "x" } }] });
    expect(parsed).toEqual({ ok: true, value: { version: 3, meeting, records: [invoice] } });
  });

  it("refuses a bad meeting: no title, an unknown client, no time words, or another kind", () => {
    const bad = (m: object) => parsePrepRequest({ version: 1, meeting: { ...meeting, ...m }, records: [invoice] });
    expect(bad({ title: " " })).toEqual({ ok: false, error: "meeting.title must be a non-empty string." });
    expect(bad({ client: "Evil Corp" })).toEqual({ ok: false, error: "meeting.client must be one of the studio's clients." });
    expect(bad({ time: "" })).toEqual({ ok: false, error: "meeting.time must be a non-empty string." });
    expect(bad({ kind: "focus" })).toEqual({ ok: false, error: 'meeting.kind must be "meeting" or "call".' });
    expect(parsePrepRequest({ version: "1", meeting, records: [invoice] })).toMatchObject({ ok: false, error: "version must be a number." });
    expect(parsePrepRequest([])).toMatchObject({ ok: false });
  });

  it("drops records it cannot use, keeps the first of each id, caps at ten, and needs at least one", () => {
    const records = [
      invoice,
      invoice,
      { ...invoice, id: "message:INV-1042" },
      { ...invoice, id: "client:c-harbor", kind: "client" },
      { ...invoice, panel: "nowhere" },
      { ...invoice, id: "invoice:INV-9", fields: { unknown: "x" } },
      ...Array.from({ length: 12 }, (_, i) => ({ id: `task:t-${i}`, kind: "task", panel: "tasks", fields: { title: `Task ${i}`, due: "due today" } })),
    ];
    const parsed = parsePrepRequest({ version: 1, meeting, records });
    expect(parsed.ok).toBe(true);
    const ids = parsed.ok ? parsed.value.records.map((r) => r.id) : [];
    expect(ids[0]).toBe("invoice:INV-1042");
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
    expect(parsePrepRequest({ version: 1, meeting, records: [{ ...invoice, kind: "person" }] })).toEqual({
      ok: false,
      error: "records must list at least one record the prep questions can read.",
    });
    expect(parsePrepRequest({ version: 1, meeting, records: "all" })).toEqual({ ok: false, error: "records must be an array." });
  });

  it("clips long text and keeps a client field only when it names a studio client or says there is none", () => {
    const message = { id: "message:m-1", kind: "message", panel: "inbox", fields: { from: "Priya Nair", client: "Harbor Coffee Co.", text: "y".repeat(400), subject: "s".repeat(300) } };
    const other = { id: "message:m-10", kind: "message", panel: "inbox", fields: { from: "Riley Chen", client: "No client company", text: "hi" } };
    const forged = { id: "message:m-99", kind: "message", panel: "inbox", fields: { from: "X", client: "Made Up Ltd.", text: "hi" } };
    const parsed = parsePrepRequest({ version: 1, meeting, records: [message, other, forged] });
    if (!parsed.ok) throw new Error(parsed.error);
    const [m, o, f] = parsed.value.records;
    expect(m.fields.text).toHaveLength(200);
    expect(m.fields.subject).toHaveLength(120);
    expect(o.fields.client).toBe("No client company");
    expect(f.fields.client).toBeUndefined();
  });
});

