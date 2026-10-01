import { describe, expect, it } from "vitest";
import { noteText } from "./choreography.ts";

describe("the demo's link words", () => {
  it("names panels by their titles in the demo catalog", () => {
    expect(noteText(["inbox", "analytics", "help"], "Harbor Coffee Co.")).toBe("Added Inbox, Revenue, and Guide for Harbor Coffee Co.");
  });
});
