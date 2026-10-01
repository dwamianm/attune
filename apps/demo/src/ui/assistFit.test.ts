import { describe, expect, it } from "vitest";
import { assistSlots } from "./assistFit.ts";

describe("assistSlots", () => {
  it("puts a meeting first, then the Done card, then the primary suggestion, then the subtle ones, then the label", () => {
    const slots = assistSlots({
      prep: true,
      taskDone: true,
      upNext: true,
      upNextDone: false,
      suggestions: [
        { id: "a", primary: false },
        { id: "b", primary: true },
        { id: "c", primary: false },
      ],
      hint: true,
    });
    expect(slots.map((s) => s.id)).toEqual(["prep", "task-done", "b", "a", "c", "label"]);
  });

  it("gives the one card slot to the Done card, else Up next, else its completion line", () => {
    const base = { prep: false, suggestions: [], hint: false };
    expect(assistSlots({ ...base, taskDone: false, upNext: true, upNextDone: true }).map((s) => s.kind)).toEqual(["upNext"]);
    expect(assistSlots({ ...base, taskDone: false, upNext: false, upNextDone: true }).map((s) => s.kind)).toEqual(["upNextDone"]);
    expect(assistSlots({ ...base, taskDone: true, upNext: true, upNextDone: true }).map((s) => s.kind)).toEqual(["taskDone"]);
  });

  it("shows the empty state only without suggestions", () => {
    const base = { prep: false, taskDone: false, upNext: false, upNextDone: false, hint: true };
    expect(assistSlots({ ...base, suggestions: [] }).map((s) => s.kind)).toEqual(["hint"]);
    expect(assistSlots({ ...base, suggestions: [{ id: "a", primary: true }] }).map((s) => s.kind)).toEqual(["suggestion", "label"]);
    expect(assistSlots({ ...base, hint: false, suggestions: [] })).toEqual([]);
  });
});
