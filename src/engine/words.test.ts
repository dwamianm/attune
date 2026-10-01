import { describe, expect, it } from "vitest";
import { matchesQuery } from "./words.ts";

describe("matchesQuery (UX-12)", () => {
  const priya = ["Priya Nair", "Re: Invoice INV-1042", "Sorry for the delay.", "Harbor Coffee Co."];

  it("matches when every word appears in some field", () => {
    expect(matchesQuery(priya, "harbor invoice")).toBe(true);
    expect(matchesQuery(priya, "Harbor's invoices")).toBe(true);
    expect(matchesQuery(priya, "harbor kite")).toBe(false);
  });

  it("ignores stop words and keeps plain behavior for short queries", () => {
    expect(matchesQuery(priya, "the invoice from harbor")).toBe(true);
    expect(matchesQuery(priya, "")).toBe(true);
    expect(matchesQuery(priya, "the")).toBe(true); // "the" is in "the delay"
    expect(matchesQuery(["Kite & Co."], "&")).toBe(true);
  });
});
