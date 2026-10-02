import { describe, expect, it } from "vitest";
import { COMMAND_MAX_LENGTH, parseAdaptRequest, SNAPSHOT_LIST_MAX } from "./request.ts";

const snapshot = { recent_activity: ["Opened ticket T-1"], current_focus: null, visible_panels: ["Tickets"], behavior_observations: [] };

describe("parseAdaptRequest", () => {
  it("keeps a good request and clips long text", () => {
    const long = Array.from({ length: SNAPSHOT_LIST_MAX + 5 }, (_, i) => `line ${i}`);
    const r = parseAdaptRequest({ version: 3, snapshot: { ...snapshot, recent_activity: long }, command: `  ${"x".repeat(COMMAND_MAX_LENGTH + 10)} ` });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.snapshot.recent_activity).toHaveLength(SNAPSHOT_LIST_MAX);
    expect(r.request.snapshot.recent_activity.at(-1)).toBe(`line ${SNAPSHOT_LIST_MAX + 4}`);
    expect(r.request.command).toHaveLength(COMMAND_MAX_LENGTH);
  });

  it("drops an empty command and says what is wrong with a bad body", () => {
    const r = parseAdaptRequest({ version: 1, snapshot, command: "   " });
    expect(r.ok && r.request.command).toBe(undefined);
    expect(parseAdaptRequest([])).toEqual({ ok: false, error: "The body must be a JSON object" });
    expect(parseAdaptRequest({ version: -1, snapshot })).toEqual({ ok: false, error: "version must be a whole number from 0" });
    expect(parseAdaptRequest({ version: 1, snapshot: { ...snapshot, visible_panels: [1] } })).toEqual({ ok: false, error: "snapshot.visible_panels must be a list of strings" });
  });
});
