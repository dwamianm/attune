/**
 * The snapshot rules with a small writing app's words, not the demo's. The
 * demo's own sentences and cases are in apps/demo/src/engine/snapshot.test.ts.
 */
import { describe, expect, it } from "vitest";
import { signalProfile, type SignalEventLike } from "./signals.ts";
import { buildSnapshot, commandActivityLine, deriveObservations, describeCoreEvent, focusSequence, IDLE_MS, type EventWords, type SnapshotOptions } from "./snapshot.ts";

type P = "drafts" | "sources" | "tips";
type T = Parameters<typeof describeCoreEvent>[0]["type"] | "autosave";
type E = SignalEventLike<T, P>;

const WORDS: EventWords<P> = {
  panels: { drafts: { title: "Drafts" }, sources: { title: "Sources" }, tips: { title: "Tips" } },
  itemWords: { draft: "draft", source: "saved source" },
  actionPast: (id, d) => (id === "cite" ? `Cited ${d.label ?? "a source"}` : "Did something"),
};
const PROFILE = signalProfile<T>({ cueOnly: ["autosave"] });
const describe_ = (e: E): string => (e.type === "autosave" ? "Saved the draft" : describeCoreEvent({ type: e.type, ...(e.panel ? { panel: e.panel } : {}), ...(e.detail ? { detail: e.detail } : {}) }, WORDS));
const OPTS: SnapshotOptions<T, P, E> = { profile: PROFILE, words: WORDS, helpPanel: "tips", describe: describe_ };

const T0 = 1_000_000;
const ev = (type: T, dt: number, panel?: P, detail?: E["detail"]): E => ({ type, t: T0 + dt, ...(panel ? { panel } : {}), ...(detail ? { detail } : {}) });

describe("describeCoreEvent", () => {
  it("writes each core event as one sentence in the app's words", () => {
    expect(describeCoreEvent({ type: "item_open", panel: "sources", detail: { itemKind: "source", itemId: "s-1", client: "Bee Weekly" } }, WORDS)).toBe("Opened saved source s-1 for Bee Weekly in Sources");
    // A label that already starts with its kind word does not repeat it.
    expect(describeCoreEvent({ type: "item_open", panel: "drafts", detail: { itemKind: "draft", label: "Draft: Bees", via: "keyboard" } }, WORDS)).toBe("Opened Draft: Bees in Drafts, using the keyboard");
    expect(describeCoreEvent({ type: "item_open", panel: "drafts", detail: { itemKind: "draft", label: "Bees" } }, WORDS)).toBe("Opened draft Bees in Drafts");
    expect(describeCoreEvent({ type: "action", panel: "drafts", detail: { actionId: "cite", label: "Bee Weekly" } }, WORDS)).toBe("Cited Bee Weekly in Drafts");
    expect(describeCoreEvent({ type: "search", panel: "sources", detail: { query: " bees " } }, WORDS)).toBe('Searched Sources for "bees"');
    expect(describeCoreEvent({ type: "filter", panel: "sources", detail: { filter: { topic: "insects", year: "all" } } }, WORDS)).toBe("Filtered Sources to topic insects");
    expect(describeCoreEvent({ type: "command", detail: { query: "cite bees" } }, WORDS)).toBe(commandActivityLine("cite bees"));
    expect(describeCoreEvent({ type: "panel_focus", panel: "inbox" as P }, WORDS)).toBe("Clicked into a panel");
  });

  it("falls back to the label without an actionPast", () => {
    const plain: EventWords<P> = { panels: WORDS.panels, itemWords: {} };
    expect(describeCoreEvent({ type: "action", detail: { actionId: "cite", label: "Cite" } }, plain)).toBe('Used "Cite"');
    expect(describeCoreEvent({ type: "suggestion_accept", detail: { actionId: "cite" } }, plain)).toBe("Accepted a suggestion");
  });
});

describe("deriveObservations", () => {
  it("counts repeated searches that led nowhere, and the app's help panel", () => {
    const events = [ev("search", 0, "drafts", { query: "bee facts" }), ev("search", 2_000, "sources", { query: "bees" }), ev("search", 4_000, "sources", { query: "bee" }), ev("panel_open", 5_000, "tips")];
    expect(deriveObservations(events, T0 + 6_000, OPTS)).toEqual([
      'Searched three times in the last minute and a half: "bee facts", "bees", "bee"',
      'The searches keep repeating the same word: "bee"',
      "None of these searches led to opening an item",
      "Opened the Tips panel for help",
      "Working at a steady pace",
    ]);
  });

  it("sees back and forth in the profile's work types, and idle time", () => {
    const events = [0, 1, 2, 3].map((i) => ev("panel_focus", i * 1_000, i % 2 ? "sources" : "drafts"));
    expect(focusSequence(events, T0 + 4_000, PROFILE)).toEqual(["drafts", "sources", "drafts", "sources"]);
    const obs = deriveObservations(events, T0 + 3_000 + IDLE_MS + 1, OPTS);
    expect(obs).toContain("No activity for the last few minutes");
    expect(deriveObservations(events, T0 + 4_000, OPTS)).toContain("Switched back and forth between Drafts and Sources");
  });
});

describe("buildSnapshot", () => {
  it("leaves out cue-only events, collapses repeats, and names panels by title", () => {
    const events = [ev("autosave", 0), ev("panel_focus", 1_000, "drafts"), ev("panel_focus", 2_000, "drafts"), ev("panel_dwell", 3_000, "drafts", { durationMs: 500 })];
    const snap = buildSnapshot(events, { now: T0 + 4_000, focusedPanel: null, visiblePanels: ["drafts", "sources", "nope" as P] }, OPTS);
    expect(snap.recent_activity).toEqual(["Clicked into Drafts (twice in a row)"]);
    expect(snap.visible_panels).toEqual(["Drafts", "Sources"]);
    expect(snap.current_focus).toBeNull();
  });

  it("names the focused panel, the app's details, or else the last record opened there, then the habits", () => {
    const events = [ev("item_open", 0, "sources", { itemKind: "source", itemId: "s-1" })];
    const input = { now: T0 + 1_000, focusedPanel: "sources" as const, visiblePanels: ["sources" as const], habits: ["You usually open Drafts next"] };
    expect(buildSnapshot(events, input, OPTS).current_focus).toBe("Sources panel, last opened saved source s-1");
    const withView = { ...OPTS, focusDetails: () => ({ parts: ["viewing Bee Weekly", "sorted by date"], hasSelection: true }) };
    expect(buildSnapshot(events, input, withView).current_focus).toBe("Sources panel, viewing Bee Weekly, sorted by date");
    expect(buildSnapshot(events, input, OPTS).behavior_observations.at(-1)).toBe("You usually open Drafts next");
  });
});
