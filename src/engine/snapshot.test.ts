import { describe, expect, it } from "vitest";
import { SCENARIOS } from "../../shared/scenarios.ts";
import { buildSnapshot, deriveObservations, describeEvent } from "./snapshot.ts";
import { ev, stepsToEvents } from "./test-helpers.ts";
import type { PanelViewState } from "./contract.ts";

const scenario = (id: string) => {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s) throw new Error(`missing scenario ${id}`);
  return s;
};

describe("describeEvent", () => {
  it("matches the example sentences", () => {
    expect(
      describeEvent({
        type: "item_open",
        panel: "invoices",
        detail: { itemKind: "invoice", itemId: "INV-1042", client: "Harbor Coffee Co.", label: "INV-1042 · Harbor Coffee Co. · overdue 14 days · $4,200" },
      }),
    ).toBe("Opened invoice INV-1042 · Harbor Coffee Co. · overdue 14 days · $4,200 in Invoices");
    expect(describeEvent({ type: "filter", panel: "invoices", detail: { filter: { status: "overdue" } } })).toBe("Filtered Invoices to status overdue");
    expect(describeEvent({ type: "search", panel: "inbox", detail: { query: "harbor invoice" } })).toBe('Searched Inbox for "harbor invoice"');
    expect(describeEvent({ type: "command", detail: { query: "who owes us" } })).toBe('Typed in the command bar: "who owes us"');
    expect(describeEvent({ type: "shortcut", detail: { key: "mod+k" } })).toBe("Used keyboard shortcut mod+k");
    expect(describeEvent({ type: "panel_dwell", panel: "calendar", detail: { durationMs: 4200 } })).toBe("Rested the pointer on Calendar for about 4 seconds");
    expect(describeEvent({ type: "panel_dismiss", panel: "team", detail: { durationMs: 1500 } })).toBe("Sent Team back to the dock after 2 seconds");
  });

  it("uses panel titles, never raw ids", () => {
    expect(describeEvent({ type: "panel_open", panel: "analytics" })).toBe("Opened Revenue from the dock");
    expect(describeEvent({ type: "panel_focus", panel: "help" })).toBe("Clicked into Guide");
  });

  it("handles action events with and without an action id", () => {
    expect(describeEvent({ type: "action", panel: "inbox", detail: { actionId: "reply_to_message", client: "Meridian Hotels", via: "keyboard" } })).toBe(
      "Replied to Meridian Hotels in Inbox, using the keyboard",
    );
    expect(describeEvent({ type: "action", panel: "invoices", detail: { actionId: "send_payment_reminder", client: "Harbor Coffee Co.", itemId: "INV-1042" } })).toBe(
      "Sent a payment reminder to Harbor Coffee Co. for INV-1042 in Invoices",
    );
    expect(describeEvent({ type: "action", panel: "tasks", detail: { label: "Export list" } })).toBe('Used "Export list" in Tasks');
    expect(describeEvent({ type: "action" })).toBe("Took an action");
  });

  it("describes items without labels and suggestions", () => {
    expect(describeEvent({ type: "item_open", panel: "clients", detail: { itemKind: "client", itemId: "c-atlas", client: "Atlas Robotics" } })).toBe(
      "Opened client c-atlas for Atlas Robotics in Clients",
    );
    expect(describeEvent({ type: "suggestion_dismiss", detail: { actionId: "write_note", label: "Write a note" } })).toBe('Dismissed the suggestion "Write a note"');
    expect(describeEvent({ type: "filter", panel: "invoices", detail: { filter: { status: "all" } } })).toBe("Removed the status filter in Invoices");
  });

  it("describes clearing the link cues and removing one", () => {
    expect(describeEvent({ type: "links_dismiss", detail: { label: "INV-1047" } })).toBe("Cleared the links for INV-1047");
    expect(describeEvent({ type: "links_dismiss", detail: { label: "INV-1047", via: "keyboard" } })).toBe("Cleared the links for INV-1047, using the keyboard");
    expect(describeEvent({ type: "links_dismiss", detail: { label: "INV-1047", linkedPanel: "inbox" } })).toBe("Removed the link to Inbox");
  });
});

describe("deriveObservations", () => {
  it("returns [] when nothing happened", () => {
    expect(deriveObservations([], 5000)).toEqual([]);
  });

  it("spots the lost user: repeated searches, quick dismissals, no item opened", () => {
    const { events, end } = stepsToEvents(scenario("lost").steps);
    const obs = deriveObservations(events, end + 500);
    expect(obs).toContain('Searched four times in the last minute and a half: "bills", "bill", "where are bills", "unpaid bills"');
    expect(obs).toContain('The searches keep repeating the same word: "bill"');
    expect(obs).toContain("None of these searches led to opening an item");
    expect(obs).toContain("Opened Revenue and Team, then sent each one back to the dock within a few seconds");
    expect(obs.some((o) => o.includes("pointer"))).toBe(true);
  });

  it("does not count old searches", () => {
    const events = [ev("search", 0, "inbox", { query: "a1" }), ev("search", 1000, "inbox", { query: "a2" }), ev("search", 2000, "inbox", { query: "a3" })];
    expect(deriveObservations(events, 200_000).some((o) => o.startsWith("Searched"))).toBe(false);
  });

  it("spots back and forth between two panels", () => {
    const { events, end } = stepsToEvents(scenario("compare").steps);
    expect(deriveObservations(events, end + 200)).toContain("Switched back and forth between Invoices and Clients several times");
  });

  it("spots keyboard use and a quick pace", () => {
    const { events, end } = stepsToEvents(scenario("power_user").steps);
    const obs = deriveObservations(events, end + 100);
    expect(obs).toContain("Moves only with keyboard shortcuts and the command bar, not the pointer");
    expect(obs).toContain("Working at a quick pace");
  });

  it("describes a steady pace in words", () => {
    const events = [0, 2000, 4000, 6000, 8000].map((t) => ev("panel_focus", t, t % 4000 ? "inbox" : "tasks"));
    expect(deriveObservations(events, 8500)).toContain("Working at a steady pace");
  });

  it("never claims pointer use without pointer events, or shortcuts for a typed command", () => {
    // One command: too little for an input style, and a command is not a shortcut.
    const one = deriveObservations([ev("command", 1000, undefined, { query: "atlas", via: "keyboard" })], 1500);
    expect(one.some((o) => o.includes("pointer") || o.includes("shortcut"))).toBe(false);

    // Two shortcuts and three searches: searches are neither pointer nor keyboard style.
    const keys = [ev("shortcut", 0, "inbox", { key: "j" }), ev("shortcut", 500, "inbox", { key: "k" }), ...[1, 2, 3].map((i) => ev("search", 1000 * i, "inbox", { query: `q${i}` }))];
    expect(deriveObservations(keys, 4000).some((o) => o.includes("pointer mostly"))).toBe(false);

    // Pointer work plus one typed command: the command bar, not keyboard shortcuts.
    const { events, end } = stepsToEvents(scenario("collections").steps);
    const mixed = [...events, ev("command", end + 1000, undefined, { query: "remind harbor", via: "keyboard" })];
    expect(deriveObservations(mixed, end + 1500)).toContain("Uses the pointer mostly, with some use of the command bar");
  });

  it("describes long pauses without calling the user slow, and ignores pointer rests", () => {
    const reading = [0, 8000, 16000, 24000, 32000].map((t) => ev("item_open", t, "invoices", { itemKind: "invoice", itemId: `INV-${t}` }));
    const obs = deriveObservations(reading, 33_000);
    expect(obs).toContain("Long pauses between actions, as when reading");
    expect(obs.join(" ")).not.toMatch(/slow/i);
    // Frequent pointer rests between the same actions do not make the pace look quick.
    const withDwell = [...reading, ...[1, 2, 3, 4].map((i) => ev("panel_dwell", 8000 * i - 500, "calendar", { durationMs: 2000 }))].sort((a, b) => a.t - b.t);
    expect(deriveObservations(withDwell, 33_000)).toContain("Long pauses between actions, as when reading");
  });

  it("spots a record opened again and again, and a how-to search", () => {
    const open = (t: number) => ev("item_open", t, "invoices", { itemKind: "invoice", itemId: "INV-1047", client: "Kite & Co." });
    const events = [open(0), ev("search", 2000, "inbox", { query: "send reminder" }), open(4000), ev("search", 6000, "clients", { query: "how to remind client" }), open(8000)];
    const obs = deriveObservations(events, 9000);
    expect(obs).toContain("Opened invoice INV-1047 three times in the last few minutes without acting on it");
    expect(obs).toContain('A search was phrased as a how-to question: "how to remind client"');
    // Twice is normal (checking a record while comparing), and acting on it is not stuck.
    expect(deriveObservations(events.slice(0, 3), 5000).some((o) => o.startsWith("Opened invoice"))).toBe(false);
    const acted = [...events.slice(0, 4), ev("action", 7000, "invoices", { actionId: "send_payment_reminder", itemId: "INV-1047" }), open(8000)];
    expect(deriveObservations(acted, 9000).some((o) => o.startsWith("Opened invoice"))).toBe(false);
  });

  it("reports help, suggestions, undo, and idleness", () => {
    const events = [
      ev("panel_open", 0, "help"),
      ev("suggestion_accept", 1000, undefined, { actionId: "create_task" }),
      ev("suggestion_dismiss", 2000, undefined, { actionId: "write_note" }),
      ev("suggestion_dismiss", 3000, undefined, { actionId: "view_client" }),
      ev("undo", 4000),
    ];
    const obs = deriveObservations(events, 4000 + 130_000);
    expect(obs).toContain("Opened the Guide panel for help");
    expect(obs).toContain("Accepted one suggested next step and dismissed two");
    expect(obs).toContain("Undid a layout change");
    expect(obs).toContain("No activity for the last few minutes");
  });
});

describe("buildSnapshot", () => {
  const view: PanelViewState = {
    inbox: { query: "", selectedId: null, client: null },
    invoices: { status: "all", client: null, selectedId: "INV-1042" },
    clients: { selected: null, query: "" },
    tasks: { showDone: false, client: null },
    projects: { status: "all", selectedId: null },
    calendar: { range: "today" },
    analytics: { range: "this_year" },
    team: {},
    notes: {},
    help: {},
  };

  it("keeps the last 15 lines, oldest first, drops short dwell, collapses repeats", () => {
    const events = [
      ev("panel_dwell", 0, "calendar", { durationMs: 800 }),
      ev("panel_focus", 100, "invoices"),
      ev("panel_focus", 200, "invoices"),
      ev("panel_focus", 300, "invoices"),
      ...Array.from({ length: 20 }, (_, i) => ev("search", 1000 + i * 100, "inbox", { query: `q${i}` })),
    ];
    const snap = buildSnapshot(events, { now: 5000, focusedPanel: "invoices", visiblePanels: ["invoices", "analytics"], view });
    expect(snap.recent_activity).toHaveLength(15);
    expect(snap.recent_activity[0]).toBe('Searched Inbox for "q5"');
    expect(snap.recent_activity[14]).toBe('Searched Inbox for "q19"');
    expect(snap.visible_panels).toEqual(["Invoices", "Revenue"]);
    expect(snap.current_focus).toBe("Invoices panel, viewing invoice INV-1042 for Harbor Coffee Co.");

    const short = buildSnapshot(events.slice(0, 4), { now: 400, focusedPanel: null, visiblePanels: [] });
    expect(short.recent_activity).toEqual(["Clicked into Invoices (three times in a row)"]);
    expect(short.current_focus).toBeNull();
  });

  it("tells Jev when the user made a panel bigger or smaller", () => {
    expect(describeEvent({ type: "panel_maximize", panel: "invoices" })).toBe("Made Invoices bigger");
    expect(describeEvent({ type: "panel_restore", panel: "invoices", detail: { via: "keyboard" } })).toBe("Made Invoices smaller");
    const events = [ev("item_open", 100, "invoices", { itemKind: "invoice", itemId: "INV-1047" }), ev("panel_maximize", 200, "invoices"), ev("panel_restore", 300, "invoices")];
    const snap = buildSnapshot(events, { now: 400, focusedPanel: "invoices", visiblePanels: ["invoices"] });
    expect(snap.recent_activity.slice(-2)).toEqual(["Made Invoices bigger", "Made Invoices smaller"]);
  });

  it("leaves out link cue dismissals, so they cannot change what Jev judges", () => {
    const events = [ev("item_open", 100, "invoices", { itemKind: "invoice", itemId: "INV-1047" }), ev("links_dismiss", 200, undefined, { label: "INV-1047" })];
    const snap = buildSnapshot(events, { now: 300, focusedPanel: null, visiblePanels: [] });
    expect(snap).toEqual(buildSnapshot(events.slice(0, 1), { now: 300, focusedPanel: null, visiblePanels: [] }));
    expect(snap.recent_activity.join(" ")).not.toContain("links");
  });

  it("leaves out the engine's saved-context notes, and reads Up next and Back to like the user's own steps", () => {
    const opened = ev("item_open", 100, "invoices", { itemKind: "invoice", itemId: "INV-1047" });
    const saved = ev("context_save", 200, undefined, { label: "Collecting payments · Kite & Co." });
    const snap = buildSnapshot([opened, saved], { now: 300, focusedPanel: null, visiblePanels: [] });
    expect(snap).toEqual(buildSnapshot([opened], { now: 300, focusedPanel: null, visiblePanels: [] }));
    expect(describeEvent(saved)).toBe("Saved Collecting payments · Kite & Co. for Back to");
    expect(describeEvent({ type: "context_restore", detail: { label: "Planning the day", via: "keyboard" } })).toBe(
      "Went back to earlier work: Planning the day, using the keyboard",
    );
    // An open from Up next counts as working in that panel and as a reopen, like a click on the row.
    const nextOpens = [1, 2, 3].map((i) => ev("up_next_open", 100 + i, "invoices", { itemKind: "invoice", itemId: "INV-1042" }));
    const obs = buildSnapshot(nextOpens, { now: 200, focusedPanel: "invoices", visiblePanels: ["invoices"] });
    expect(obs.behavior_observations).toContain("Opened invoice INV-1042 three times in the last few minutes without acting on it");
    expect(obs.current_focus).toBe("Invoices panel, last opened invoice INV-1042");
  });

  it("falls back to the last opened item when view state has no selection", () => {
    const { events, end } = stepsToEvents(scenario("collections").steps.slice(0, 3));
    const snap = buildSnapshot(events, { now: end, focusedPanel: "invoices", visiblePanels: ["invoices"] });
    expect(snap.current_focus).toBe("Invoices panel, last opened invoice INV-1042 · Harbor Coffee Co. · overdue 14 days · $4,200");
    // Three pointer events are too few for an input-style or pace observation.
    expect(snap.behavior_observations).toEqual([]);

    const full = stepsToEvents(scenario("collections").steps);
    const obs = buildSnapshot(full.events, { now: full.end, focusedPanel: "inbox", visiblePanels: [] }).behavior_observations;
    expect(obs).toContain("Uses only the pointer, no keyboard shortcuts or command bar");
    expect(obs).toContain("Working at a steady pace");
  });
});
