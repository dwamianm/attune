import { describe, expect, it } from "vitest";
import { CLIENTS, EVENTS, INVOICES, MESSAGES, PROJECTS, TASKS } from "../../shared/fixtures.ts";
import type { AnchorRef } from "../../shared/types.ts";
import type { AppData, PanelViewState } from "./contract.ts";
import { RELATED_RECORDS_MAX, anchorLabel, clientNamedIn, findLinked, kindOfId, relationFor } from "./relations.ts";

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

const anchor = (a: Omit<AnchorRef, "at">): AnchorRef => ({ at: 1, ...a });
const ids = (records: { itemId: string }[] | undefined) => (records ?? []).map((r) => r.itemId);

describe("findLinked", () => {
  it("joins an invoice to its client's message, client row, project, task, event, and people", () => {
    const linked = findLinked(anchor({ panel: "invoices", itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co." }), data());
    expect(ids(linked.inbox)).toEqual(["m-1"]);
    expect(ids(linked.clients)).toEqual(["c-harbor"]);
    expect(ids(linked.projects)).toEqual(["p-harbor"]);
    expect(ids(linked.tasks)).toEqual(["t-1"]);
    expect(ids(linked.calendar)).toEqual(["e-2"]);
    expect(ids(linked.team)).toEqual(["u-sam"]);
    // Never its own panel, and never the panels that cannot show a tint.
    expect(linked.invoices).toBeUndefined();
    expect(linked.analytics).toBeUndefined();
    expect(linked.notes).toBeUndefined();
    expect(linked.help).toBeUndefined();
  });

  it("puts the record a message names before the client's other records", () => {
    const linked = findLinked(anchor({ panel: "inbox", itemKind: "message", itemId: "m-1", client: "Harbor Coffee Co." }), data());
    expect(ids(linked.invoices)).toEqual(["INV-1042", "INV-1040"]);
    expect(linked.inbox).toBeUndefined();
  });

  it("orders a client's invoices overdue first, then by due date", () => {
    const d = data();
    d.messages = [];
    const linked = findLinked(anchor({ panel: "clients", itemKind: "client", itemId: "c-pinecrest", client: "Pinecrest Clinic" }), d);
    expect(ids(linked.invoices)).toEqual(["INV-1049", "INV-1035"]);
  });

  it("links a client record to its message, invoice, project, and task, and omits panels with nothing", () => {
    const linked = findLinked(anchor({ panel: "clients", itemKind: "client", itemId: "c-atlas", client: "Atlas Robotics" }), data());
    expect(ids(linked.inbox)).toEqual(["m-3"]);
    expect(ids(linked.invoices)).toEqual(["INV-1053"]);
    expect(ids(linked.projects)).toEqual(["p-atlas"]);
    expect(ids(linked.tasks)).toEqual(["t-3"]);
    expect(linked.calendar).toBeUndefined();
    expect(linked.clients).toBeUndefined();
  });

  it("joins by client alone when there is no record", () => {
    const linked = findLinked(anchor({ panel: "invoices", client: "Meridian Hotels" }), data());
    expect(ids(linked.inbox)).toEqual(["m-2"]);
    expect(ids(linked.tasks)).toEqual(["t-2", "t-9"]);
    expect(ids(linked.calendar)).toEqual(["e-4"]);
  });

  it("links nothing without a record or a client", () => {
    expect(findLinked(anchor({ panel: "inbox" }), data())).toEqual({});
  });

  it("leaves done tasks out, since the task list hides them", () => {
    const linked = findLinked(anchor({ panel: "clients", itemKind: "client", itemId: "c-juniper", client: "Juniper Books" }), data());
    expect(ids(linked.tasks)).toEqual([]);
    expect(linked.tasks).toBeUndefined();
  });

  it("with the panels' view, links only records a panel shows now", () => {
    const view: PanelViewState = {
      inbox: { query: "", selectedId: null, client: null },
      invoices: { status: "overdue", client: null, selectedId: null },
      clients: { selected: null, query: "" },
      tasks: { showDone: false, client: null },
      projects: { status: "all", selectedId: null },
      calendar: { range: "today" },
      analytics: { range: "this_year" },
      team: {},
      notes: {},
      help: {},
    };
    const juniper = anchor({ panel: "clients", itemKind: "client", itemId: "c-juniper", client: "Juniper Books" });
    const d = data();
    // The spring brief call is days away: a Calendar showing today holds nothing to tint.
    const all = findLinked(juniper, d);
    expect(all.calendar?.length).toBeGreaterThan(0);
    const now = new Date(d.events.find((e) => e.id === "e-1")!.start).getTime();
    const today = findLinked(juniper, d, { view, now });
    expect(today.calendar).toBeUndefined();
    const week = findLinked(juniper, d, { view: { ...view, calendar: { range: "this_week" } }, now });
    expect(ids(week.calendar)).toEqual(["e-6"]);
    // Juniper's invoices are sent and paid, so an Overdue filter hides them; Inbox shows its message.
    expect(today.invoices).toBeUndefined();
    expect(ids(today.inbox)).toEqual(["m-7"]);
    expect(findLinked(juniper, d, { view: { ...view, inbox: { query: "harbor", selectedId: null, client: null } }, now }).inbox).toBeUndefined();
  });

  it("links a person to the projects they lead or work on", () => {
    const linked = findLinked(anchor({ panel: "team", itemKind: "person", itemId: "u-sam" }), data());
    expect(ids(linked.projects).sort()).toEqual(["p-atlas", "p-harbor", "p-kite"]);
    expect(ids(linked.tasks)).toContain("t-1");
    expect(ids(linked.clients).sort()).toEqual(["c-atlas", "c-harbor", "c-kite"]);
  });

  it("caps the records per panel", () => {
    const d = data();
    d.messages = Array.from({ length: 9 }, (_, i) => ({ ...MESSAGES[0], id: `m-x${i}`, receivedAt: `2026-01-0${i + 1}T08:00:00.000Z` }));
    const linked = findLinked(anchor({ panel: "clients", itemKind: "client", itemId: "c-harbor", client: "Harbor Coffee Co." }), d);
    expect(linked.inbox).toHaveLength(RELATED_RECORDS_MAX);
  });

  it("uses live data, so a task added in the session links too", () => {
    const d = data();
    d.tasks = [{ id: "t-new-1", title: "Follow up with Harbor Coffee Co.", due: "2026-01-01", project: "Harbor rebrand", client: "Harbor Coffee Co.", done: false, assignee: "Sam Rivera" }, ...d.tasks];
    const linked = findLinked(anchor({ panel: "invoices", itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co." }), d);
    expect(ids(linked.tasks)).toEqual(["t-1", "t-new-1"]);
  });
});

describe("anchorLabel", () => {
  const d = data();
  it("names the record the way a tag reads", () => {
    expect(anchorLabel({ itemKind: "invoice", itemId: "INV-1042" }, d)).toBe("INV-1042");
    expect(anchorLabel({ itemKind: "message", itemId: "m-1" }, d)).toBe("Priya Nair");
    expect(anchorLabel({ itemKind: "client", itemId: "c-atlas" }, d)).toBe("Atlas Robotics");
    expect(anchorLabel({ itemKind: "project", itemId: "p-harbor" }, d)).toBe("Harbor rebrand");
    expect(anchorLabel({ itemKind: "task", itemId: "t-6" }, d)).toBe("Kite & Co.");
    expect(anchorLabel({ itemKind: "event", itemId: "e-2" }, d)).toBe("Harbor Coffee Co.");
    expect(anchorLabel({ itemKind: "event", itemId: "e-1" }, d)).toBe("Studio stand-up");
    expect(anchorLabel({ itemKind: "person", itemId: "u-riley" }, d)).toBe("Riley Chen");
  });

  it("falls back to the client, and is undefined with neither", () => {
    expect(anchorLabel({ itemKind: "invoice", itemId: "INV-9999", client: "Kite & Co." }, d)).toBe("Kite & Co.");
    expect(anchorLabel({ client: "Kite & Co." }, d)).toBe("Kite & Co.");
    expect(anchorLabel({}, d)).toBeUndefined();
  });

  it("reads the kind from the id when an event carries none (actions)", () => {
    expect(kindOfId("INV-1042")).toBe("invoice");
    expect(kindOfId("m-3")).toBe("message");
    expect(kindOfId("t-new-2")).toBe("task");
    expect(anchorLabel({ itemId: "p-kite" }, d)).toBe("Packaging system");
  });
});

describe("relationFor", () => {
  const d = data();
  const inv = anchor({ panel: "invoices", itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co.", label: "INV-1042" });

  it("tags with the anchor's label and says why in plain words", () => {
    const linked = findLinked(inv, d);
    expect(relationFor(inv, "inbox", linked.inbox!)).toEqual({ anchorPanel: "invoices", tag: "Linked to INV-1042", reason: "1 message from Harbor Coffee Co.", records: linked.inbox });
    expect(relationFor(inv, "clients", linked.clients!).reason).toBe("Harbor Coffee Co. is the client");
    expect(relationFor(inv, "projects", linked.projects!).reason).toBe("Harbor rebrand is the project");
    expect(relationFor(inv, "tasks", linked.tasks!).reason).toBe("1 open task for Harbor Coffee Co.");
    expect(relationFor(inv, "calendar", linked.calendar!).reason).toBe("1 event with Harbor Coffee Co.");
    expect(relationFor(inv, "team", linked.team!).reason).toBe("1 person on Harbor rebrand");
  });

  it("counts in plural, and names the project for project work", () => {
    const project = anchor({ panel: "projects", itemKind: "project", itemId: "p-harbor", client: "Harbor Coffee Co.", label: "Harbor rebrand" });
    const linked = findLinked(project, d);
    expect(relationFor(project, "invoices", linked.invoices!).reason).toBe("2 invoices for Harbor rebrand");
    expect(relationFor(project, "invoices", linked.invoices!).tag).toBe("Linked to Harbor rebrand");
  });

  it("tags with the client name when the anchor has no record", () => {
    const client = anchor({ panel: "invoices", client: "Meridian Hotels" });
    const linked = findLinked(client, d);
    const rel = relationFor(client, "tasks", linked.tasks!);
    expect(rel.tag).toBe("Linked to Meridian Hotels");
    expect(rel.reason).toBe("2 open tasks for Meridian Hotels");
  });

  it("names the client's one project for its people", () => {
    const atlas = anchor({ panel: "clients", itemKind: "client", itemId: "c-atlas", client: "Atlas Robotics", label: "Atlas Robotics" });
    const linked = findLinked(atlas, d);
    expect(relationFor(atlas, "team", linked.team!).reason).toBe("1 person on Pitch deck");
  });
});

describe("clientNamedIn", () => {
  it("finds the one client a search names by its first word", () => {
    expect(clientNamedIn("harbor invoice")).toBe("Harbor Coffee Co.");
    expect(clientNamedIn("Kite discount")).toBe("Kite & Co.");
    expect(clientNamedIn("bills")).toBeUndefined();
    expect(clientNamedIn("harbor and atlas")).toBeUndefined();
    expect(CLIENTS.every((c) => clientNamedIn(c.name) === c.name)).toBe(true);
  });
});
