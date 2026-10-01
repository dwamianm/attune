/**
 * The quiet rule with plain data and no app. The demo's own cases, with its
 * events and its policy, are in apps/demo/src/engine/quiet.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  countQuietRound,
  emptyQuietTrack,
  QUIET_BELOW,
  QUIET_RECENT_USE_MS,
  QUIET_ROUNDS,
  quietPanels,
  quietReason,
  type QuietContext,
  type QuietTrack,
  type RelevanceScore,
} from "./quiet.ts";

type P = "notes" | "tasks" | "team";
type E = { panel?: P; t: number; hover?: boolean };

const PANELS: readonly P[] = ["notes", "tasks", "team"];
const low: RelevanceScore = { score: (QUIET_BELOW - 0.1) * 3, max: 3 };
const high: RelevanceScore = { score: 3, max: 3 };

/** Count QUIET_ROUNDS rounds in which `quiet` are rated low and the rest high. */
function rounds(quiet: P[]): QuietTrack<P> {
  let t = emptyQuietTrack<P>();
  for (let v = 1; v <= QUIET_ROUNDS; v++) {
    t = countQuietRound(t, { notes: quiet.includes("notes") ? low : high, tasks: quiet.includes("tasks") ? low : high, team: quiet.includes("team") ? low : high }, v, PANELS);
  }
  return t;
}

function ctx(extra: Partial<QuietContext<P, E>> = {}): QuietContext<P, E> {
  return {
    onCanvas: [...PANELS],
    anchor: null,
    linked: [],
    pinned: [],
    bigger: [],
    focused: null,
    pointer: null,
    upNext: null,
    events: [],
    isTouch: (e) => !e.hover,
    now: 100_000,
    ...extra,
  };
}

describe("the quiet rule without an app", () => {
  it("counts only the panels it is given, in their order", () => {
    expect(rounds(["team", "notes"]).quiet).toEqual(["notes", "team"]);
    const t = countQuietRound(emptyQuietTrack<P>(), { notes: low, tasks: low }, 1, ["tasks"]);
    expect(t.low).toEqual({ tasks: 1 });
  });

  it("lets the app say which events count as use", () => {
    const track = rounds(["team"]);
    const now = 100_000;
    expect(quietPanels(track, ctx())).toEqual(["team"]);
    expect(quietPanels(track, ctx({ events: [{ panel: "team", t: now - 1_000 }] }))).toEqual([]);
    expect(quietPanels(track, ctx({ events: [{ panel: "team", t: now - 1_000, hover: true }] }))).toEqual(["team"]);
    expect(quietPanels(track, ctx({ events: [{ panel: "team", t: now - QUIET_RECENT_USE_MS - 1 }] }))).toEqual(["team"]);
  });

  it("names the goal from the catalog, and not the no-match goal", () => {
    const goals = { write: { label: "Writing notes", description: "" }, unclear: { label: "Not sure yet", description: "" } };
    expect(quietReason({ goals }, "write")).toBe("Not needed for Writing notes right now");
    expect(quietReason({ goals }, "unclear")).toBe("Not needed for what you are doing right now");
    expect(quietReason({ goals }, null)).toBe("Not needed for what you are doing right now");
  });
});
