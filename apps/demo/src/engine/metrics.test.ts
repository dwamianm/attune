import { describe, expect, it } from "vitest";
import type { ActionId } from "../../shared/catalog.ts";
import type { FlowMetrics } from "./contract.ts";
import { emptyMetrics, metricsOnEvent, metricsOnLayoutChange, metricsOnUpNextShown, recordRoundPrediction, summarizeMetrics } from "./metrics.ts";
import { choiceJ, ev } from "./test-helpers.ts";

const T = 1_000_000;
const openInvoice = (id: string, t = T) => ev("item_open", t, "invoices", { itemKind: "invoice", itemId: id });
const nextRecord = (probabilities: Record<string, number>) => {
  const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  return choiceJ(top[0], top[1], probabilities);
};

function line(m: FlowMetrics, id: string, now = T + 60_000) {
  return summarizeMetrics(m, now).find((l) => l.id === id)!;
}

describe("next-record prediction", () => {
  it("scores the user's next open against the newest round's top three", () => {
    const predicted = recordRoundPrediction(emptyMetrics(), {
      nextRecord: nextRecord({ "invoice:INV-1047": 0.6, "invoice:INV-1042": 0.2, "message:m-1": 0.1, "task:t-1": 0.05 }),
      codePick: null,
    });
    let m = metricsOnEvent(predicted, openInvoice("INV-1047"), null);
    expect(m.nextRecord).toEqual({ hit1: 1, hit3: 1, miss: 0, none: 0 });
    // The prediction is used once: the next open without a new round had none.
    m = metricsOnEvent(m, openInvoice("INV-1042", T + 1), null);
    expect(m.nextRecord.none).toBe(1);

    m = recordRoundPrediction(m, { nextRecord: nextRecord({ "invoice:INV-1047": 0.6, "invoice:INV-1042": 0.2, "message:m-1": 0.1, "task:t-1": 0.05 }), codePick: null });
    m = metricsOnEvent(m, ev("up_next_open", T + 2, "inbox", { itemKind: "message", itemId: "m-1" }), null);
    expect(m.nextRecord).toMatchObject({ hit1: 1, hit3: 2 });
    m = recordRoundPrediction(m, { nextRecord: nextRecord({ "invoice:INV-1047": 0.6, "invoice:INV-1042": 0.2, "message:m-1": 0.1, "task:t-1": 0.05 }), codePick: null });
    m = metricsOnEvent(m, openInvoice("INV-1049", T + 3), null);
    expect(m.nextRecord).toEqual({ hit1: 1, hit3: 2, miss: 1, none: 1 });
    expect(line(m, "record-hit1").value).toBe("1 of 3 (33%)");
    expect(line(m, "record-hit3").value).toBe("2 of 3 (67%)");
  });

  it("uses code's pick when Jev gave no record or chose none", () => {
    let m = recordRoundPrediction(emptyMetrics(), { codePick: "invoice:INV-1047" });
    expect(m.pendingRecord).toEqual({ top: ["invoice:INV-1047"], source: "code" });
    m = recordRoundPrediction(m, { nextRecord: choiceJ<string>("none", 0.9, { none: 0.9, "invoice:INV-1042": 0.1 }), codePick: "invoice:INV-1047" });
    expect(m.pendingRecord?.source).toBe("code");
    m = metricsOnEvent(m, openInvoice("INV-1047"), null);
    expect(m.nextRecord.hit1).toBe(1);
    expect(recordRoundPrediction(emptyMetrics(), { codePick: null }).pendingRecord).toBeNull();
  });
});

describe("next-action prediction", () => {
  it("scores the next performed action, and counts no prediction when Jev said none", () => {
    const na = choiceJ<ActionId>("send_payment_reminder", 0.6, { send_payment_reminder: 0.6, reply_to_message: 0.3, none: 0.1 });
    let m = recordRoundPrediction(emptyMetrics(), { nextAction: na, codePick: null });
    m = metricsOnEvent(m, ev("action", T, "inbox", { actionId: "reply_to_message", itemId: "m-1" }), null);
    expect(m.nextAction).toEqual({ hit1: 0, hit3: 1, miss: 0, none: 0 });
    m = recordRoundPrediction(m, { nextAction: choiceJ<ActionId>("none", 0.9, { none: 0.9 }), codePick: null });
    m = metricsOnEvent(m, ev("action", T + 1, "invoices", { actionId: "send_payment_reminder", itemId: "INV-1038" }), null);
    expect(m.nextAction.none).toBe(1);
  });
});

describe("navigation effort, Up next, undo, and calm", () => {
  it("counts hand navigation per 10 actions, leaving out opens the app made", () => {
    const events = [
      ev("panel_open", T, "team", { via: "pointer" }),
      ev("panel_open", T + 1, "notes", { via: "suggestion" }),
      ev("search", T + 2, "inbox", { query: "harbor" }),
      ev("scroll", T + 3, "invoices"),
      ev("command", T + 4, undefined, { query: "unpaid invoices" }),
      ev("context_restore", T + 5, undefined, { label: "Planning the day" }),
      ev("action", T + 6, "invoices", { actionId: "send_payment_reminder", itemId: "INV-1038" }),
      ev("action", T + 7, "invoices", { actionId: "send_payment_reminder", itemId: "INV-1042" }),
    ];
    const m = events.reduce((acc, e) => metricsOnEvent(acc, e, null), emptyMetrics());
    expect(m.effort).toEqual({ dockOpens: 1, searches: 1, scrolls: 1, commands: 1, backTo: 1, actions: 2 });
    expect(line(m, "effort").value).toBe("25.0");
  });

  it("counts Up next picks shown and taken by click, key, or chip", () => {
    let m = metricsOnUpNextShown(emptyMetrics(), "invoice:INV-1042");
    m = metricsOnUpNextShown(m, "invoice:INV-1042");
    m = metricsOnUpNextShown(m, "invoice:INV-1047");
    m = metricsOnUpNextShown(m, null);
    m = metricsOnUpNextShown(m, "invoice:INV-1047");
    expect(m.upNext.shown).toBe(3);
    m = metricsOnEvent(m, ev("up_next_open", T, "invoices", { itemKind: "invoice", itemId: "INV-1047", via: "keyboard" }), "invoice:INV-1047");
    m = metricsOnEvent(m, ev("up_next_open", T + 1, "invoices", { itemKind: "invoice", itemId: "INV-1049", via: "pointer" }), "invoice:INV-1049");
    m = metricsOnEvent(m, ev("up_next_open", T + 2, "invoices", { itemKind: "invoice", itemId: "INV-1050", via: "pointer" }), "invoice:INV-1051");
    expect(m.upNext).toMatchObject({ openedKey: 1, openedClick: 1, openedAlternative: 1 });
    expect(line(m, "up-next").value).toBe("2 of 3 (67%)");
  });

  it("reports undos per layout change and layout changes per minute, and ignores the engine's own notes", () => {
    let m = metricsOnEvent(emptyMetrics(), ev("context_save", T - 50_000, undefined, { label: "x" }), null);
    expect(m.startedAt).toBeNull();
    m = metricsOnEvent(m, openInvoice("INV-1038", T), null);
    for (let i = 0; i < 4; i++) m = metricsOnLayoutChange(m);
    m = metricsOnEvent(m, ev("undo", T + 1_000), null);
    expect(line(m, "undo-rate", T + 120_000).value).toBe("1 of 4 (25%)");
    expect(line(m, "changes-per-minute", T + 120_000).value).toBe("2.0");
    // The first seconds count as a whole minute.
    expect(line(m, "changes-per-minute", T + 5_000).value).toBe("4.0");
  });
});
