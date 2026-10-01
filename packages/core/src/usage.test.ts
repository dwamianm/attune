import { describe, expect, it } from "vitest";
import { panelUsage, rawUsage, USAGE_HALF_LIFE_MS, type UsageEvent } from "./usage.ts";

type P = "notes" | "tasks" | "team";
type E = UsageEvent<P> & { kind: "open" | "look" };

const PANELS: readonly P[] = ["notes", "tasks", "team"];
const opts = { panelIds: PANELS, weight: (e: E) => (e.kind === "open" ? 2 : 0) };
const now = 1_000_000;

describe("rawUsage", () => {
  it("gives every panel a total, and halves an event's weight every half-life", () => {
    const events: E[] = [
      { panel: "notes", t: now, kind: "open" },
      { panel: "tasks", t: now - USAGE_HALF_LIFE_MS, kind: "open" },
    ];
    expect(rawUsage(events, now, opts)).toEqual({ notes: 2, tasks: 1, team: 0 });
  });

  it("skips events with no panel, an unknown panel, or no weight", () => {
    const events = [
      { t: now, kind: "open" },
      { panel: "inbox", t: now, kind: "open" },
      { panel: "team", t: now, kind: "look" },
    ] as E[];
    expect(rawUsage(events, now, opts)).toEqual({ notes: 0, tasks: 0, team: 0 });
  });

  it("treats an event from the future as now, and takes another half-life", () => {
    expect(rawUsage([{ panel: "notes", t: now + 5_000, kind: "open" }], now, opts).notes).toBe(2);
    expect(rawUsage([{ panel: "notes", t: now - 1_000, kind: "open" }], now, { ...opts, halfLifeMs: 1_000 }).notes).toBe(1);
  });
});

describe("panelUsage", () => {
  it("normalizes so the busiest panel is 1", () => {
    const events: E[] = [
      { panel: "notes", t: now, kind: "open" },
      { panel: "notes", t: now, kind: "open" },
      { panel: "tasks", t: now, kind: "open" },
    ];
    expect(panelUsage(events, now, opts)).toEqual({ notes: 1, tasks: 0.5, team: 0 });
  });

  it("is all zeros when nothing happened", () => {
    expect(panelUsage([], now, opts)).toEqual({ notes: 0, tasks: 0, team: 0 });
  });
});
