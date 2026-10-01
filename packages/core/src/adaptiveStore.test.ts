/**
 * createAdaptiveStore with a small writing app and a fake server: the loop
 * end to end, with fake timers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANCHOR_IDLE_RELEASE_MS, COMMAND_PANEL_AT, createAdaptiveStore, UNDO_HOLD_MS, type AdaptiveRequest, type AdaptiveResponse } from "./adaptiveStore.ts";
import { defineCatalog } from "./catalog.ts";
import { createPolicy, type PolicyInput } from "./createPolicy.ts";
import type { ChoiceJudgment, CoreCommandJudgments, CoreJudgments, ScoreJudgment } from "./judgments.ts";
import type { LayoutMode } from "./layoutModes.ts";
import type { CoreSuggestion } from "./plan.ts";

type P = "drafts" | "sources" | "outline" | "notes";
type G = "write" | "research" | "unclear";
type A = "cite" | "none";
type S = CoreSuggestion<A>;
type J = CoreJudgments<P, G, A> & { command?: CoreCommandJudgments<P, A> };

const catalog = defineCatalog<P, G, A>({
  panelIds: ["drafts", "sources", "outline", "notes"],
  panels: {
    drafts: { id: "drafts", title: "Drafts", description: "Documents.", icon: "FileText", defaultVisible: true },
    sources: { id: "sources", title: "Sources", description: "Saved articles.", icon: "Library", defaultVisible: true },
    outline: { id: "outline", title: "Outline", description: "The plan of a draft.", icon: "List", defaultVisible: true },
    notes: { id: "notes", title: "Notes", description: "A scratch pad.", icon: "NotebookPen", defaultVisible: false },
  },
  goalIds: ["write", "research", "unclear"],
  goals: { write: { label: "Writing", description: "Writing." }, research: { label: "Researching", description: "Reading." }, unclear: { label: "Not sure yet", description: "Too little." } },
  actionIds: ["cite", "none"],
  actions: { cite: { id: "cite", label: "Cite a source", description: "Add a citation.", panel: "sources" }, none: { id: "none", label: "", description: "No step.", panel: null } },
  goalPanelAffinity: { write: { drafts: 1, outline: 0.5 }, research: { sources: 1, notes: 0.4 }, unclear: {} },
});

const policy = createPolicy<P, G, A, S, string, { next: Partial<Record<P, number>> }, PolicyInput<P, G, A, S>, undefined>({
  catalog,
  usage: () => ({}),
  suggest: () => [],
  relationFor: (anchor, _panel, records) => ({ anchorPanel: anchor.panel, tag: "Linked", reason: "Linked", records }),
});

const score = (s: number): ScoreJudgment => ({ score: s, max: 3, confidence: 0.8, probabilities: [] });
const choice = <K extends string>(c: K, confidence: number): ChoiceJudgment<K> => ({ choice: c, confidence, probabilities: { [c]: confidence } as Record<K, number> });
const writing = (o: Partial<J> = {}): J => ({
  goal: choice<G>("write", 0.9),
  relevance: { drafts: score(3), sources: score(1), outline: score(2.5), notes: score(0) },
  struggling: 0.1,
  layout: choice<LayoutMode>("focus", 0.9),
  expertise: score(1.5),
  nextAction: choice<A>("none", 0.9),
  ...o,
});

let sent: AdaptiveRequest[] = [];
let answer: (req: AdaptiveRequest) => J = () => writing();
function make() {
  return createAdaptiveStore<P, G, A, S, string, J>({
    catalog,
    policy,
    words: { panels: catalog.panels, itemWords: { draft: "draft", source: "source" } },
    send: async (req): Promise<AdaptiveResponse<J>> => {
      sent.push(req);
      return { version: req.version, source: "jev", judgments: answer(req) };
    },
  });
}

const ids = (store: ReturnType<typeof make>) => store.getState().plan.placements.map((p) => p.id);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  sent = [];
  answer = () => writing();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createAdaptiveStore", () => {
  it("starts with the default panels and asks the model after work, debounced", async () => {
    const store = make();
    expect(ids(store)).toEqual(["drafts", "sources", "outline"]);
    store.track({ type: "item_open", panel: "drafts", detail: { itemKind: "draft", itemId: "d-1", label: "Bees" } });
    expect(sent).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(800);
    expect(sent).toHaveLength(1);
    expect(sent[0].snapshot.recent_activity.at(-1)).toBe("Opened draft Bees in Drafts");
    const s = store.getState();
    expect(s.goal).toEqual({ id: "write", confidence: 0.9 });
    expect(s.plan.mode).toBe("focus");
    expect(s.anchor).toMatchObject({ panel: "drafts", itemId: "d-1", source: "work" });
    expect(s.plan.grid).toBeDefined();
    expect(s.history).toHaveLength(1);
    store.dispose();
  });

  it("holds the anchor's top-left still in later rounds, and releases it after idle time", async () => {
    const store = make();
    store.track({ type: "item_open", panel: "outline", detail: { itemKind: "draft", itemId: "o-1" } });
    await vi.advanceTimersByTimeAsync(800);
    const cell = store.getState().plan.grid?.cells.outline;
    answer = () => writing({ relevance: { drafts: score(1), sources: score(3), outline: score(1), notes: score(2) } });
    store.track({ type: "search", panel: "outline", detail: { query: "bees" } });
    await vi.advanceTimersByTimeAsync(4_000);
    const after = store.getState().plan.grid?.cells.outline;
    expect({ col: after?.col, row: after?.row }).toEqual({ col: cell?.col, row: cell?.row });
    await vi.advanceTimersByTimeAsync(ANCHOR_IDLE_RELEASE_MS);
    expect(store.getState().anchor).toBeNull();
    store.dispose();
  });

  it("promotes the panel a confident command names, and keeps the layout for an unclear one", async () => {
    const store = make();
    answer = (req) =>
      writing({
        command: {
          panel: req.command === "show my notes" ? choice<P | "unclear">("notes", COMMAND_PANEL_AT + 0.2) : choice<P | "unclear">("unclear", 0.9),
          action: choice<A>("none", 0.9),
        },
      });
    await store.runCommand("show my notes");
    expect(sent.at(-1)?.command).toBe("show my notes");
    expect(store.getState().command).toEqual({ text: "show my notes", status: "applied", panel: "notes" });
    expect(store.getState().plan.placements[0]).toMatchObject({ id: "notes", size: "hero" });
    const before = ids(store);
    await vi.advanceTimersByTimeAsync(3_000);
    await store.runCommand("banana smoothie recipe");
    expect(store.getState().command?.status).toBe("unclear");
    expect(ids(store)).toEqual(before);
    store.dispose();
  });

  it("applies pins and dismissals at once, and undo puts the last layout back", async () => {
    const store = make();
    store.track({ type: "item_open", panel: "drafts", detail: { itemId: "d-1" } });
    await vi.advanceTimersByTimeAsync(800);
    store.pin("sources");
    expect(store.getState().pinned).toEqual(["sources"]);
    expect(store.getState().plan.placements[0].id).toBe("sources");
    await vi.advanceTimersByTimeAsync(3_000);
    store.dismiss("outline");
    expect(ids(store)).not.toContain("outline");
    const dismissed = store.getState().plan;
    store.undo();
    expect(ids(store)).toContain("outline");
    expect(store.getState().plan).not.toBe(dismissed);
    expect(store.getState().plan.decisions[0].text).toBe("Undid the last layout change");
    // The undo holds while the same judgments come back.
    store.track({ type: "item_open", panel: "drafts", detail: { itemId: "d-2" } });
    await vi.advanceTimersByTimeAsync(UNDO_HOLD_MS - 2_000);
    expect(ids(store)).toContain("outline");
    store.dispose();
  });

  it("keeps the card under the pointer from leaving for a while", async () => {
    const store = make();
    store.track({ type: "item_open", panel: "drafts", detail: { itemId: "d-1" } });
    await vi.advanceTimersByTimeAsync(800);
    expect(ids(store)).toContain("sources");
    store.setPointer({ panel: "sources", down: false });
    answer = () => writing({ relevance: { drafts: score(3), sources: score(0), outline: score(2.5), notes: score(2.4) } });
    store.track({ type: "item_open", panel: "drafts", detail: { itemId: "d-2" } });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(ids(store)).toContain("sources");
    store.dispose();
  });

  it("reports a failed request as an error and keeps the layout", async () => {
    const store = createAdaptiveStore<P, G, A, S, string, J>({
      catalog,
      policy,
      words: { panels: catalog.panels, itemWords: {} },
      send: async () => {
        throw new Error("Network down");
      },
    });
    const before = ids(store);
    const seen: string[] = [];
    const stop = store.subscribe((s) => seen.push(s.status));
    store.track({ type: "item_open", panel: "drafts", detail: { itemId: "d-1" } });
    await vi.advanceTimersByTimeAsync(800);
    expect(store.getState()).toMatchObject({ status: "error", lastError: "Network down" });
    expect(seen).toContain("thinking");
    expect(ids(store)).toEqual(before);
    stop();
    store.dispose();
  });
});
