import { describe, expect, it } from "vitest";
import type { ActionId, PanelId } from "../../shared/catalog.ts";
import type { CommandJudgments, InvoiceStatusArg, TimeframeArg } from "../../shared/types.ts";
import { namedInvoiceId, resolveCommand } from "./command.ts";
import type { PanelViewState } from "./contract.ts";
import { choiceJ } from "./test-helpers.ts";

function cmd(o: {
  panel?: [PanelId | "unclear", number, Partial<Record<PanelId | "unclear", number>>?];
  action?: [ActionId, number];
  status?: [InvoiceStatusArg, number];
  client?: [string, number];
  timeframe?: [TimeframeArg, number];
}): CommandJudgments {
  const [panel, pc, pp] = o.panel ?? ["unclear", 0.9];
  const [action, ac] = o.action ?? ["none", 0.9];
  const [status, sc] = o.status ?? ["not_mentioned", 0.9];
  const [client, cc] = o.client ?? ["not_mentioned", 0.9];
  const [tf, tc] = o.timeframe ?? ["not_mentioned", 0.9];
  return {
    panel: choiceJ<PanelId | "unclear">(panel, pc, pp ?? { [panel]: pc }),
    action: choiceJ<ActionId>(action, ac),
    invoiceStatus: choiceJ<InvoiceStatusArg>(status, sc),
    client: choiceJ(client, cc),
    timeframe: choiceJ<TimeframeArg>(tf, tc),
  };
}

describe("resolveCommand", () => {
  it("applies a confident panel and sets filters from confident arguments", () => {
    const r = resolveCommand(cmd({ panel: ["invoices", 0.9], status: ["overdue", 0.8] }), "who still owes us money?");
    expect(r.outcome).toMatchObject({ status: "applied", text: "who still owes us money?", message: "Showing overdue invoices", options: [] });
    expect(r.promote).toBe("invoices");
    expect(r.viewPatches).toEqual([{ panel: "invoices", patch: { selectedId: null, status: "overdue", client: null } }]);
    expect(r.decision).toMatchObject({ kind: "command", panel: "invoices", text: "Opened Invoices because you asked" });
    expect(r.suggestion).toBeNull();
  });

  it("filters to a client and resets an unmentioned status", () => {
    const r = resolveCommand(cmd({ panel: ["invoices", 0.8], client: ["Harbor Coffee Co.", 0.9] }), "show me harbor's invoices");
    expect(r.viewPatches).toEqual([{ panel: "invoices", patch: { selectedId: null, status: "all", client: "Harbor Coffee Co." } }]);
    expect(r.outcome.message).toBe("Showing invoices for Harbor Coffee Co.");
  });

  it("ignores low-confidence arguments and unknown clients", () => {
    const low = resolveCommand(cmd({ panel: ["invoices", 0.8], status: ["paid", 0.4], client: ["Harbor Coffee Co.", 0.5] }), "x");
    expect(low.viewPatches).toEqual([{ panel: "invoices", patch: { selectedId: null } }]);
    const unknown = resolveCommand(cmd({ panel: ["clients", 0.8], client: ["Acme", 0.9] }), "acme");
    expect(unknown.viewPatches).toEqual([]);
  });

  it("maps client and timeframe to the right view fields", () => {
    expect(resolveCommand(cmd({ panel: ["clients", 0.9], client: ["Atlas Robotics", 0.9] }), "atlas").viewPatches).toEqual([
      { panel: "clients", patch: { selected: "Atlas Robotics" } },
    ]);
    expect(resolveCommand(cmd({ panel: ["inbox", 0.9], client: ["Kite & Co.", 0.7] }), "kite mail").viewPatches).toEqual([
      { panel: "inbox", patch: { client: "Kite & Co." } },
    ]);
    expect(resolveCommand(cmd({ panel: ["tasks", 0.9], client: ["Solace Yoga", 0.7] }), "solace todo").viewPatches).toEqual([
      { panel: "tasks", patch: { client: "Solace Yoga" } },
    ]);
    const today = resolveCommand(cmd({ panel: ["calendar", 0.9], timeframe: ["today", 0.8] }), "what's on today");
    expect(today.viewPatches).toEqual([{ panel: "calendar", patch: { range: "today" } }]);
    expect(today.outcome.message).toBe("Showing today's calendar");
  });

  it("offers a confident action as a primary suggestion but never performs it", () => {
    const r = resolveCommand(
      cmd({ panel: ["invoices", 0.9], action: ["send_payment_reminder", 0.85], client: ["Meridian Hotels", 0.9] }),
      "remind meridian to pay",
    );
    expect(r.suggestion).toMatchObject({
      actionId: "send_payment_reminder",
      prominence: "primary",
      label: "Send payment reminder to Meridian Hotels",
      args: { client: "Meridian Hotels", invoiceId: "INV-1038" },
    });
    expect(r.outcome.message).toBe("Showing invoices for Meridian Hotels. Suggested: Send payment reminder to Meridian Hotels");

    // The user typed the request, so a lower bar than passive next steps (0.55, not 0.7).
    const busy = resolveCommand(cmd({ panel: ["invoices", 0.9], action: ["send_payment_reminder", 0.6] }), "remind");
    expect(busy.suggestion).toMatchObject({ actionId: "send_payment_reminder", prominence: "primary" });
    const weak = resolveCommand(cmd({ panel: ["invoices", 0.9], action: ["send_payment_reminder", 0.5] }), "remind");
    expect(weak.suggestion).toBeNull();
  });

  it("asks to confirm at medium confidence, with up to three options by probability", () => {
    const r = resolveCommand(
      cmd({ panel: ["invoices", 0.45, { invoices: 0.5, clients: 0.2, analytics: 0.15, inbox: 0.1, unclear: 0.05 }] }),
      "money stuff",
    );
    expect(r.outcome.status).toBe("confirm");
    expect(r.outcome.options.map((o) => o.panel)).toEqual(["invoices", "clients", "analytics"]);
    expect(r.outcome.options[2].label).toBe("Revenue");
    expect(r.promote).toBeNull();
    expect(r.viewPatches).toEqual([]);
  });

  it("gives up with options when unclear or too unsure", () => {
    const unclear = resolveCommand(cmd({ panel: ["unclear", 0.9, { unclear: 0.7, notes: 0.2, tasks: 0.1 }] }), "blorp");
    expect(unclear.outcome.status).toBe("unclear");
    expect(unclear.outcome.options.map((o) => o.panel)).toEqual(["notes", "tasks"]);
    const unsure = resolveCommand(cmd({ panel: ["team", 0.2, { team: 0.3, calendar: 0.25 }] }), "free?");
    expect(unsure.outcome.status).toBe("unclear");
  });

  it("applies the panel the user picked from the options", () => {
    const r = resolveCommand(cmd({ panel: ["invoices", 0.45, { invoices: 0.5, clients: 0.3 }], client: ["Harbor Coffee Co.", 0.9] }), "harbor", {
      forcePanel: "clients",
    });
    expect(r.outcome.status).toBe("applied");
    expect(r.promote).toBe("clients");
    expect(r.viewPatches).toEqual([{ panel: "clients", patch: { selected: "Harbor Coffee Co." } }]);
  });

  it("keeps the bill a mark-paid command acts on in view, instead of filtering to Paid", () => {
    // Jev reads "paid" in "mark ... as paid" literally; the Paid tab would hide the unpaid bill.
    const r = resolveCommand(
      cmd({ panel: ["invoices", 0.95], action: ["mark_invoice_paid", 1], status: ["paid", 0.97], client: ["Pinecrest Clinic", 0.95] }),
      "mark the pinecrest bill as paid",
    );
    expect(r.suggestion?.args.invoiceId).toBe("INV-1049");
    expect(r.viewPatches).toEqual([{ panel: "invoices", patch: { status: "all", client: "Pinecrest Clinic", selectedId: "INV-1049" } }]);
    // Asking to see paid bills still filters to them.
    const seePaid = resolveCommand(cmd({ panel: ["invoices", 0.95], status: ["paid", 0.9] }), "show paid invoices");
    expect(seePaid.viewPatches[0]).toMatchObject({ patch: { status: "paid" } });
  });

  it("acts on an invoice the command names, not another client's", () => {
    expect(namedInvoiceId("mark INV-1047 paid")).toBe("INV-1047");
    expect(namedInvoiceId("mark inv 1047 paid")).toBe("INV-1047");
    expect(namedInvoiceId("mark INV-9999 paid")).toBeUndefined();
    const r = resolveCommand(cmd({ panel: ["invoices", 0.9], action: ["mark_invoice_paid", 0.95], status: ["paid", 0.8] }), "mark INV-1047 paid");
    expect(r.suggestion).toMatchObject({ args: { invoiceId: "INV-1047", client: "Kite & Co." } });
    expect(r.viewPatches[0]).toMatchObject({ patch: { selectedId: "INV-1047", status: "all" } });
  });

  it("keeps the open invoice when it still fits the new filter", () => {
    const view = {
      invoices: { status: "all", client: null, selectedId: "INV-1042" },
    } as unknown as PanelViewState;
    const overdue = resolveCommand(cmd({ panel: ["invoices", 0.9], status: ["overdue", 0.9] }), "late bills", { view });
    expect(overdue.viewPatches[0]).toMatchObject({ patch: { status: "overdue", selectedId: "INV-1042" } });
    const drafts = resolveCommand(cmd({ panel: ["invoices", 0.9], status: ["draft", 0.9] }), "drafts", { view });
    expect(drafts.viewPatches[0]).toMatchObject({ patch: { status: "draft", selectedId: null } });
  });

  it("does not suggest opening the client the command already opens", () => {
    const r = resolveCommand(cmd({ panel: ["clients", 0.95], action: ["view_client", 0.84], client: ["Atlas Robotics", 0.99] }), "open atlas robotics");
    expect(r.viewPatches).toEqual([{ panel: "clients", patch: { selected: "Atlas Robotics" } }]);
    expect(r.suggestion).toBeNull();
    expect(r.outcome.message).toBe("Showing Atlas Robotics");
    const note = resolveCommand(cmd({ panel: ["notes", 0.9], action: ["write_note", 0.8] }), "jot down: call Luis");
    expect(note.suggestion).toBeNull();
  });
});
