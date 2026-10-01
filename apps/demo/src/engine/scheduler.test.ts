import { describe, expect, it } from "vitest";
import { triggersRequest } from "./scheduler.ts";

describe("triggersRequest", () => {
  it("knows which events ask Jev", () => {
    expect(triggersRequest("item_open", false)).toBe(true);
    expect(triggersRequest("suggestion_dismiss", false)).toBe(true);
    expect(triggersRequest("panel_focus", false)).toBe(false);
    expect(triggersRequest("panel_focus", true)).toBe(true);
    for (const t of ["panel_dwell", "scroll", "shortcut", "panel_pin", "panel_unpin", "links_dismiss", "panel_maximize", "panel_restore"] as const) {
      expect(triggersRequest(t, true)).toBe(false);
    }
  });
});
