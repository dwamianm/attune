/**
 * The inspector's number formatting has a few traps (tiny dollar amounts,
 * probabilities near 0 and 1), so the edges are pinned down here.
 */
import { describe, expect, it } from "vitest";
import {
  actionLabel,
  clientLabel,
  costUsd,
  formatAgo,
  formatMs,
  formatPercent,
  formatUsd,
  goalLabel,
  panelLabel,
  sortedEntries,
} from "./format.ts";

describe("cost", () => {
  it("prices input tokens at $0.042 per million", () => {
    expect(costUsd(1_000_000)).toBeCloseTo(0.042, 10);
    expect(costUsd(3000)).toBeCloseTo(0.000126, 12);
  });

  it("shows tiny amounts with two significant digits instead of $0.00", () => {
    expect(formatUsd(costUsd(3000))).toBe("$0.00013");
    expect(formatUsd(0.00005)).toBe("$0.00005");
    expect(formatUsd(0.042)).toBe("$0.042");
    expect(formatUsd(0.126)).toBe("$0.13");
    expect(formatUsd(12.5)).toBe("$12.50");
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(Number.NaN)).toBe("$0");
    expect(formatUsd(1e-15)).toBe("under $0.000000000001");
  });
});

describe("formatPercent", () => {
  it("never rounds a small non-zero probability down to 0%", () => {
    expect(formatPercent(0.004)).toBe("<1%");
    expect(formatPercent(0.996)).toBe(">99%");
    expect(formatPercent(0.914)).toBe("91%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(1)).toBe("100%");
  });
});

describe("time", () => {
  it("formats latency and relative time", () => {
    expect(formatMs(248.4)).toBe("248 ms");
    expect(formatMs(1500)).toBe("1.5 s");
    expect(formatAgo(10_000, 10_500)).toBe("just now");
    expect(formatAgo(0, 42_000)).toBe("42s ago");
    expect(formatAgo(0, 3 * 60_000)).toBe("3m ago");
    expect(formatAgo(0, 2 * 3_600_000)).toBe("2h ago");
  });
});

describe("labels", () => {
  it("uses catalog labels and falls back to the raw id", () => {
    expect(goalLabel("collect_payments")).toBe("Collecting payments");
    expect(goalLabel("made_up")).toBe("made_up");
    expect(panelLabel("analytics")).toBe("Revenue");
    expect(panelLabel("unclear")).toBe("Unclear");
    expect(actionLabel("send_payment_reminder")).toBe("Send payment reminder to a client");
    expect(actionLabel("mark_invoice_paid")).toBe("Mark a client's invoice as paid");
    expect(actionLabel("none")).toBe("No clear next step");
    expect(clientLabel("none")).toBe("No client");
  });
});

describe("sortedEntries", () => {
  it("sorts high to low and treats bad values as 0", () => {
    expect(sortedEntries({ a: 0.2, b: 0.7, c: Number.NaN })).toEqual([
      ["b", 0.7],
      ["a", 0.2],
      ["c", 0],
    ]);
  });
});
