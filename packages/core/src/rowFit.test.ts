import { describe, expect, it } from "vitest";
import { collapseSteps, FIRST_CUT_MIN_PX, FIT_SLACK_PX, fitRow, stepWidth, type FitItem } from "./rowFit.ts";

const GAP = 8;
const MORE = 36;

// The crowded row from the bug at 1440x900: the prep card, Up next, one primary suggestion, and the label.
// The prep card's shorter form shows the count of things to handle instead of the whole line.
const prep: FitItem = { id: "prep", full: 720, compact: 430 };
const upNext: FitItem = { id: "up-next", full: 403, compact: 190 };
const reply: FitItem = { id: "s-reply", full: 250, compact: 180 };
const notes: FitItem = { id: "s-notes", full: 200, compact: 150 };
const label: FitItem = { id: "label", full: 72, compact: 14, decor: true };

const opts = (available: number) => ({ available, gap: GAP, more: MORE, slack: FIT_SLACK_PX });

describe("collapseSteps", () => {
  it("makes pills from the lowest priority up, drops decoration, shortens the first, then moves items into +N from the lowest up", () => {
    const steps = collapseSteps([prep, upNext, reply, label]);
    expect(steps).toEqual([
      ["full", "full", "full", "full"],
      ["full", "full", "full", "compact"],
      ["full", "full", "compact", "compact"],
      ["full", "compact", "compact", "compact"],
      ["full", "compact", "compact", "more"],
      ["compact", "compact", "compact", "more"],
      ["compact", "compact", "more", "more"],
      ["compact", "more", "more", "more"],
    ]);
  });

  it("skips the compact form of an item without one, or whose compact form is no narrower", () => {
    const first: FitItem = { id: "first", full: 700, compact: null };
    const done: FitItem = { id: "done", full: 300, compact: null };
    const tiny: FitItem = { id: "tiny", full: 80, compact: 90 };
    expect(collapseSteps([first, done, tiny])).toEqual([
      ["full", "full", "full"],
      ["full", "full", "more"],
      ["full", "more", "more"],
    ]);
  });
});

describe("stepWidth", () => {
  it("adds the gaps and the +N button, but not for decoration alone", () => {
    const items = [prep, upNext, label];
    expect(stepWidth(items, ["full", "full", "full"], opts(0))).toBe(720 + 403 + 72 + 2 * GAP);
    expect(stepWidth(items, ["full", "compact", "more"], opts(0))).toBe(720 + 190 + GAP);
    expect(stepWidth(items, ["compact", "more", "more"], opts(0))).toBe(430 + MORE + GAP);
  });
});

describe("fitRow", () => {
  it("shows everything in full when it fits", () => {
    const fit = fitRow([prep, upNext, reply, label], opts(2000));
    expect(fit.step).toBe(0);
    expect(fit.modes).toEqual({ prep: "full", "up-next": "full", "s-reply": "full", label: "full" });
    expect(fit.more).toEqual([]);
  });

  it("fixes the bug's row at 1440x900: the suggestion stays on the row instead of running off it", () => {
    // 1377 px wide: 720 + 403 + 250 + 72 and three gaps is 1469.
    const fit = fitRow([prep, upNext, reply, label], opts(1377));
    expect(fit.modes).toEqual({ prep: "full", "up-next": "full", "s-reply": "compact", label: "compact" });
    expect(fit.more).toEqual([]);
  });

  it("makes a higher card a pill only after every lower one is", () => {
    // Up next full and the rest as pills: 720 + 403 + 180 + 150 + 14 and four gaps is 1499; all pills, 1286.
    const fit = fitRow([prep, upNext, reply, notes, label], opts(1300));
    expect(fit.modes).toEqual({ prep: "full", "up-next": "compact", "s-reply": "compact", "s-notes": "compact", label: "compact" });
  });

  it("shortens the first card, after the label goes, before anything goes into +N", () => {
    // Without the label, 1264; with the prep card shortened, 974.
    const fit = fitRow([prep, upNext, reply, notes, label], opts(1000));
    expect(fit.modes).toEqual({ prep: "compact", "up-next": "compact", "s-reply": "compact", "s-notes": "compact", label: "more" });
    expect(fit.more).toEqual([]);
  });

  it("shows the first card in full, cut short, when the shorter form would leave room empty", () => {
    const items = [prep, upNext, reply, notes, label];
    // Everything else as pills takes 190 + 180 + 150 and three gaps: 544, so the first card has the row less that.
    const plenty = fitRow(items, opts(544 + 430 + FIRST_CUT_MIN_PX));
    expect(plenty.modes.prep).toBe("compact");
    expect(plenty.cut).toBe(true);
    const tight = fitRow(items, opts(544 + 430 + FIRST_CUT_MIN_PX - 1));
    expect(tight.modes.prep).toBe("compact");
    expect(tight.cut).toBe(false);
    // In full or without a shorter form it is never cut.
    expect(fitRow(items, opts(2000)).cut).toBe(false);
  });

  it("moves the lowest items into +N when that is still too wide, and lists them highest first", () => {
    // Without the notes, and with +N: 430 + 190 + 180 + 36 and three gaps is 860.
    const fit = fitRow([prep, upNext, reply, notes, label], opts(900));
    expect(fit.more).toEqual(["s-notes"]);
    const narrower = fitRow([prep, upNext, reply, notes, label], opts(600));
    expect(narrower.more).toEqual(["up-next", "s-reply", "s-notes"]);
    expect(narrower.modes.prep).toBe("compact");
  });

  it("never puts the first item in +N, even when it alone is wider than the row", () => {
    const fit = fitRow([prep, upNext], opts(390));
    expect(fit.modes).toEqual({ prep: "compact", "up-next": "more" });
    expect(fit.more).toEqual(["up-next"]);
    const done: FitItem = { id: "done", full: 500, compact: null };
    expect(fitRow([done, reply], opts(100)).modes).toEqual({ done: "full", "s-reply": "more" });
  });

  it("drops decoration without listing it in +N", () => {
    const first: FitItem = { id: "up-next", full: 403, compact: null };
    const hint: FitItem = { id: "hint", full: 200, compact: null, decor: true };
    const fit = fitRow([first, hint], opts(450));
    expect(fit.modes.hint).toBe("more");
    expect(fit.more).toEqual([]);
    // It goes before the first card gives up words.
    const short = fitRow([prep, hint], opts(800));
    expect(short.modes).toEqual({ prep: "full", hint: "more" });
  });

  it("stays collapsed until the fuller step fits with slack to spare, so it does not flip back and forth", () => {
    const items = [prep, upNext, reply, label];
    const tight = fitRow(items, opts(1377));
    // Room for the full suggestion (720 + 403 + 250 + 14 + 3 gaps = 1411) but less than the slack more.
    const nearly = fitRow(items, opts(1411 + FIT_SLACK_PX - 1), tight);
    expect(nearly.step).toBe(tight.step);
    const roomy = fitRow(items, opts(1411 + FIT_SLACK_PX), tight);
    expect(roomy.modes["s-reply"]).toBe("full");
    expect(roomy.step).toBeLessThan(tight.step);
    // Without a previous fit it takes the fullest step that fits at all.
    expect(fitRow(items, opts(1411)).modes["s-reply"]).toBe("full");
  });

  it("never keeps an earlier step that no longer fits", () => {
    const items = [prep, upNext, reply, label];
    const roomy = fitRow(items, opts(2000));
    const tight = fitRow(items, opts(1377), roomy);
    expect(tight.modes["s-reply"]).toBe("compact");
    expect(stepWidth(items, collapseSteps(items)[tight.step], opts(1377))).toBeLessThanOrEqual(1377);
  });

  it("ignores an earlier fit made for other items", () => {
    const before = fitRow([prep, upNext, reply, label], opts(1000));
    const after = fitRow([upNext, reply, label], opts(1000), before);
    expect(after.step).toBe(0);
    expect(after.modes).toEqual({ "up-next": "full", "s-reply": "full", label: "full" });
  });
});
