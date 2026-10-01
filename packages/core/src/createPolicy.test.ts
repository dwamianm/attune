/**
 * createPolicy with a small writing app: three panels, no help panel, and
 * one suggestion. The demo's computePlan cases are in
 * apps/demo/src/engine/policy.test.ts and policy-anchor.test.ts.
 */
import { describe, expect, it } from "vitest";
import { defineCatalog } from "./catalog.ts";
import { BIGGER_REASON, BIGGER_SIZE, createPolicy, type PolicyInput } from "./createPolicy.ts";
import type { ChoiceJudgment, CoreJudgments, ScoreJudgment } from "./judgments.ts";
import type { LayoutMode } from "./layoutModes.ts";
import type { CoreSuggestion } from "./plan.ts";

type P = "drafts" | "sources" | "outline";
type G = "write" | "unclear";
type A = "cite" | "none";
type S = CoreSuggestion<A>;

const catalog = defineCatalog<P, G, A>({
  panelIds: ["drafts", "sources", "outline"],
  panels: {
    drafts: { id: "drafts", title: "Drafts", description: "Documents.", icon: "FileText", defaultVisible: true },
    sources: { id: "sources", title: "Sources", description: "Saved articles.", icon: "Library", defaultVisible: true },
    outline: { id: "outline", title: "Outline", description: "The plan of a draft.", icon: "List", defaultVisible: false },
  },
  goalIds: ["write", "unclear"],
  goals: { write: { label: "Writing", description: "Writing." }, unclear: { label: "Not sure yet", description: "Too little to tell." } },
  actionIds: ["cite", "none"],
  actions: {
    cite: { id: "cite", label: "Cite a source", description: "Add a citation.", panel: "sources" },
    none: { id: "none", label: "", description: "No step.", panel: null },
  },
  goalPanelAffinity: { write: { drafts: 1, outline: 0.6 }, unclear: {} },
});

const policy = createPolicy<P, G, A, S, string, { next: Partial<Record<P, number>> }, PolicyInput<P, G, A, S>, undefined>({
  catalog,
  usage: () => ({}),
  suggest: (input) => (input.judgments.nextAction.choice === "cite" ? [{ actionId: "cite", label: "Cite a source", prominence: "primary", confidence: input.judgments.nextAction.confidence, reason: "You are writing" }] : []),
  relationFor: (anchor, panel, records) => ({ anchorPanel: anchor.panel, tag: `Linked to ${anchor.label ?? "it"}`, reason: `${records.length} in ${panel}`, records }),
});

const score = (s: number): ScoreJudgment => ({ score: s, max: 3, confidence: 0.8, probabilities: [] });
const choice = <K extends string>(c: K, confidence: number): ChoiceJudgment<K> => ({ choice: c, confidence, probabilities: { [c]: confidence } as Record<K, number> });

function judgments(o: Partial<CoreJudgments<P, G, A>> = {}): CoreJudgments<P, G, A> {
  return {
    goal: choice<G>("write", 0.9),
    relevance: { drafts: score(3), sources: score(2), outline: score(2.5) },
    struggling: 0.9,
    layout: choice<LayoutMode>("focus", 0.9),
    expertise: score(1.5),
    nextAction: choice<A>("cite", 0.8),
    ...o,
  };
}

function input(o: Partial<PolicyInput<P, G, A, S>> = {}): PolicyInput<P, G, A, S> {
  return { judgments: judgments(), version: 1, previous: policy.defaultPlan(), events: [], now: 1_000_000, weights: { relevance: 1, usage: 0, goal: 0 }, pinned: [], dismissed: {}, focusedPanel: null, recentModes: [], ...o };
}

describe("createPolicy", () => {
  it("starts from the catalog's default panels", () => {
    const plan = policy.defaultPlan();
    expect(plan.placements.map((p) => p.id)).toEqual(["drafts", "sources"]);
    expect(plan.docked).toEqual(["outline"]);
  });

  it("orders panels by priority, sizes them by the mode, and asks the app for suggestions", () => {
    const plan = policy.computePlan(input());
    expect(plan.mode).toBe("focus");
    expect(plan.placements.map((p) => [p.id, p.size])).toEqual([
      ["drafts", "hero"],
      ["outline", "standard"],
      ["sources", "standard"],
    ]);
    expect(plan.placements[0].reason).toBe("The model rates it central to your current work");
    expect(plan.suggestions.map((s) => s.label)).toEqual(["Cite a source"]);
    expect(plan.decisions.map((d) => d.text)).toContain("Switched to the Focus layout");
  });

  it("shows only a hint for a stuck user when the app has no help panel", () => {
    const plan = policy.computePlan(input());
    expect(plan.help).toBe("panel");
    expect(plan.decisions.some((d) => d.kind === "help")).toBe(false);
    expect(plan.placements.some((p) => p.id === ("help" as P))).toBe(false);
  });

  it("keeps a dismissed panel in the dock, and a pinned one first", () => {
    const plan = policy.computePlan(input({ dismissed: { drafts: 999_000 }, pinned: ["sources"] }));
    expect(plan.placements.map((p) => p.id)).toEqual(["sources", "outline"]);
    expect(plan.placements[0].reason).toBe("Pinned by you");
  });

  it("edits a plan by hand: bigger, then smaller, and a command's hero", () => {
    const plan = policy.computePlan(input());
    const bigger = policy.editPlan(plan, { kind: "bigger", panel: "sources" });
    expect(bigger.placements.find((p) => p.id === "sources")).toMatchObject({ size: BIGGER_SIZE, bigger: true, reason: BIGGER_REASON });
    const smaller = policy.editPlan(bigger, { kind: "smaller", panel: "sources", size: "standard" });
    expect(smaller.placements.find((p) => p.id === "sources")?.bigger).toBeUndefined();
    const promoted = policy.applyPromotion({ plan, previous: plan, panel: "sources", pinned: [] });
    expect(promoted.placements[0]).toMatchObject({ id: "sources", size: "hero", reason: "You asked for it in the command bar" });
    expect(policy.planSignature(promoted)).not.toBe(policy.planSignature(plan));
  });
});
