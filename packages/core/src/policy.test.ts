/**
 * The general policy rules with a small writing app's catalog, not the
 * demo's. The demo's computePlan cases are in apps/demo/src/engine/policy.test.ts.
 */
import { describe, expect, it } from "vitest";
import { defineCatalog } from "./catalog.ts";
import type { ChoiceJudgment, ScoreJudgment } from "./judgments.ts";
import type { LayoutMode } from "./layoutModes.ts";
import {
  DENSITY_MIN_EVENTS,
  FOCUSED_SIZE_HOLD_MS,
  helpLevel,
  judgedDensity,
  OPEN_HOLD_MS,
  openHeldPanels,
  pickDensity,
  pickMode,
  PIN_BOOST,
  protectedPanels,
  PROTECT_RECENT_MS,
  scorePanels,
  sizeHeldPanels,
  userResizedPanels,
} from "./policy.ts";

type P = "drafts" | "sources";
type G = "write" | "unclear";
const catalog = defineCatalog<P, G, "none">({
  panelIds: ["drafts", "sources"],
  panels: {
    drafts: { id: "drafts", title: "Drafts", description: "Documents.", icon: "FileText", defaultVisible: true },
    sources: { id: "sources", title: "Sources", description: "Saved articles.", icon: "Library", defaultVisible: true },
  },
  goalIds: ["write", "unclear"],
  goals: { write: { label: "Writing", description: "Writing." }, unclear: { label: "Not sure yet", description: "Too little to tell." } },
  actionIds: ["none"],
  actions: { none: { id: "none", label: "", description: "No step.", panel: null } },
  goalPanelAffinity: { write: { drafts: 1, sources: 0.5 }, unclear: {} },
});

const score = (s: number, max = 3, confidence = 0.8): ScoreJudgment => ({ score: s, max, confidence, probabilities: [] });
const layout = (choice: LayoutMode, confidence: number): ChoiceJudgment<LayoutMode> => ({ choice, confidence, probabilities: { [choice]: confidence } as Record<LayoutMode, number> });

describe("scorePanels", () => {
  const judgments = { goal: { choice: "write" as const, confidence: 0.8, probabilities: { write: 0.8, unclear: 0.2 } }, relevance: { drafts: score(3), sources: score(1.5) } };

  it("blends relevance, recent use, and goal affinity by weight, and boosts pins", () => {
    const s = scorePanels(catalog, { judgments, usage: { sources: 1 }, weights: { relevance: 2, usage: 1, goal: 1 }, pinned: ["sources"] });
    expect(s.drafts.raw).toEqual({ relevance: 1, usage: 0, goal: 0.8, habit: 0 });
    expect(s.drafts.priority).toBeCloseTo((2 * 1 + 1 * 0 + 1 * 0.8) / 4);
    expect(s.drafts.topGoal).toBe("write");
    expect(s.sources.parts.pin).toBe(PIN_BOOST);
    expect(s.sources.priority).toBeCloseTo((2 * 0.5 + 1 * 1 + 1 * 0.4) / 4 + PIN_BOOST);
  });

  it("treats all-zero weights as equal, and adds a habit on top of the blend", () => {
    const flat = scorePanels(catalog, { judgments, usage: {}, weights: { relevance: 0, usage: 0, goal: 0 }, pinned: [] });
    expect(flat.drafts.priority).toBeCloseTo((1 + 0 + 0.8) / 3);
    const habit = scorePanels(catalog, { judgments, usage: {}, weights: { relevance: 1, usage: 0, goal: 0 }, pinned: [], habit: { next: { sources: 0.5 }, weight: 0.2 } });
    expect(habit.sources.parts.habit).toBeCloseTo(0.1);
    expect(habit.sources.priority).toBeCloseTo(0.5 + 0.1);
  });
});

describe("mode, density, and help", () => {
  it("switches the mode on a confident judgment or a confirmed streak, and says why it holds", () => {
    expect(pickMode("overview", layout("focus", 0.85), []).mode).toBe("focus");
    expect(pickMode("overview", layout("focus", 0.6), ["focus", "focus"]).mode).toBe("focus");
    const held = pickMode("overview", layout("focus", 0.6), []);
    expect(held).toEqual({ mode: "overview", decision: { kind: "hold", text: "Kept the Overview layout for now", evidence: "layout focus p=0.60, confidence 0.60 is below 0.80" } });
    expect(pickMode("overview", layout("overview", 0.99), []).decision).toBeNull();
  });

  it("changes density only when sure, late enough, and repeated", () => {
    expect(judgedDensity(score(0.5, 2), DENSITY_MIN_EVENTS - 1)).toBeNull();
    expect(judgedDensity(score(0.5, 2, 0.5))).toBeNull();
    expect(judgedDensity(score(0.5, 2))).toBe("guided");
    expect(judgedDensity(score(2, 2))).toBe("dense");
    expect(pickDensity("standard", score(2, 2), DENSITY_MIN_EVENTS, ["dense"])).toBe("standard");
    expect(pickDensity("standard", score(2, 2), DENSITY_MIN_EVENTS, ["dense", "dense"])).toBe("dense");
  });

  it("asks for a hint, then the help panel, as the user seems more stuck", () => {
    expect([0.2, 0.55, 0.7].map(helpLevel)).toEqual(["none", "hint", "panel"]);
  });
});

describe("panels in use", () => {
  const now = 1_000_000;
  const events = [
    { type: "panel_open", panel: "sources" as P, t: now - 10_000 },
    { type: "panel_focus", panel: "drafts" as P, t: now - 1_000 },
    { type: "panel_maximize", panel: "drafts" as P, t: now - 900 },
    { type: "panel_dismiss", panel: "sources" as P, t: now - 500 },
  ];

  it("protects recent and focused panels, but never one the user just dismissed", () => {
    expect([...protectedPanels(events, now, "sources")]).toEqual(["drafts"]);
    expect([...protectedPanels(events, now + PROTECT_RECENT_MS + 1, "drafts")]).toEqual(["drafts"]);
  });

  it("holds a focused panel's size only for a while, and remembers hand resizes and recent opens", () => {
    // The hold runs from the panel's newest event (the resize, 900 ms before now).
    const last = now - 900;
    expect([...sizeHeldPanels(events, last + FOCUSED_SIZE_HOLD_MS, "drafts")]).toEqual(["drafts"]);
    expect([...sizeHeldPanels(events, last + FOCUSED_SIZE_HOLD_MS + 1, "drafts")]).toEqual([]);
    expect([...userResizedPanels(events)]).toEqual(["drafts"]);
    expect([...openHeldPanels(events, now)]).toEqual([]);
    expect([...openHeldPanels(events.slice(0, 1), now - 10_000 + OPEN_HOLD_MS)]).toEqual(["sources"]);
  });
});
