import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defineCatalog } from "./catalog.ts";
import { neutralJudgments } from "./fallback.ts";
import { createAdaptiveWorkspace } from "./workspace.ts";

const catalog = defineCatalog({
  panelIds: ["work", "reference", "notes"],
  panels: {
    work: { id: "work", title: "Work", description: "The task", icon: "Work", defaultVisible: true },
    reference: { id: "reference", title: "Reference", description: "Related records", icon: "Book", defaultVisible: true },
    notes: { id: "notes", title: "Notes", description: "Your notes", icon: "Note", defaultVisible: false },
  },
  goalIds: ["work", "unclear"],
  goals: { work: { label: "Working", description: "Doing the task" }, unclear: { label: "Unsure", description: "No goal yet" } },
  actionIds: ["review", "none"],
  actions: { review: { id: "review", panel: "reference", label: "Review the reference", description: "Review it" }, none: { id: "none", panel: null, label: "None", description: "No action" } },
  goalPanelAffinity: { work: { work: 1 }, unclear: {} },
});

function make() {
  return createAdaptiveWorkspace({
    catalog,
    send: async (request) => ({
      version: request.version,
      source: "test",
      judgments: {
        ...neutralJudgments(catalog, request.command ? { command: request.command } : {}),
        layout: { choice: "focus" as const, confidence: 1, probabilities: { focus: 1, compare: 0, overview: 0 } },
        nextAction: { choice: "review" as const, confidence: 1, probabilities: { review: 1, none: 0 } },
        expertise: { score: 2, max: 2, confidence: 1, probabilities: [0, 0, 1] },
      },
    }),
  });
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_000_000); });
afterEach(() => vi.useRealTimers());

it("supplies a working policy and suggestions with just a catalog and transport", async () => {
  const store = make();
  await store.adaptNow("test");
  expect(store.getState().plan.mode).toBe("focus");
  expect(store.getState().plan.suggestions[0]?.label).toBe("Review the reference");
  expect(store.getState().plan.grid).toBeDefined();
  await store.runCommand("show notes");
  expect(store.getState().command).toMatchObject({ status: "applied", panel: "notes" });
  store.dispose();
});

it("updates assistance without moving, resizing, adding or docking panels in suggestions-only mode", async () => {
  const store = make();
  store.setSettings({ layoutBehavior: "suggestions" });
  const before = store.getState().plan;
  store.track({ type: "item_open", panel: "work", detail: { itemId: "one" } });
  await vi.advanceTimersByTimeAsync(30_000);
  const after = store.getState().plan;
  expect(after.grid?.cells).toEqual(before.grid?.cells);
  expect(after.grid?.rows).toBe(before.grid?.rows);
  expect(after.grid?.columns).toBe(before.grid?.columns);
  expect(after.placements.map(({ id, size }) => ({ id, size }))).toEqual(before.placements.map(({ id, size }) => ({ id, size })));
  expect(after.docked).toEqual(before.docked);
  expect(after.mode).toBe(before.mode);
  expect(after.suggestions[0]?.actionId).toBe("review");
  store.open("notes");
  expect(store.getState().plan.placements.some((p) => p.id === "notes")).toBe(true);
  await store.runCommand("show notes");
  expect(store.getState().command?.status).toBe("applied");
  store.dispose();
});

it("keeps chosen density despite repeated expert judgments, with automatic density available by choice", async () => {
  const store = make();
  store.setSettings({ density: "guided" });
  for (let i = 0; i < 7; i++) store.track({ type: "action", panel: "work" });
  await vi.advanceTimersByTimeAsync(4_000);
  await store.adaptNow("again");
  expect(store.getState().plan.density).toBe("guided");
  store.setSettings({ density: "auto" });
  await vi.advanceTimersByTimeAsync(4_000);
  await store.adaptNow("automatic density");
  expect(store.getState().plan.density).toBe("dense");
  store.dispose();
});

it("retains the density preference through manual edits, Undo, fixed mode and reset", () => {
  const store = make();
  store.setSettings({ density: "guided" });
  store.open("notes");
  store.undo();
  expect(store.getState().plan.density).toBe("guided");
  store.setSettings({ adaptive: false, density: "dense" });
  store.maximize("reference");
  expect(store.getState().plan.density).toBe("dense");
  store.reset();
  expect(store.getState().plan.density).toBe("dense");
  store.dispose();
});
