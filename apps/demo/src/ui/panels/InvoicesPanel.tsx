/**
 * Invoices panel: status tabs, an optional client filter, and reminder,
 * resend, or mark-paid actions. Due text is computed here in code because Jev
 * cannot do date math; the label on each item_open carries it in words. When
 * the next step Jev read from a click is one of these actions on the open
 * invoice, its button gets a soft ring (useStepAction); nothing runs by itself.
 */
import clsx from "clsx";
import { BellRing, CircleCheck, Receipt, Send } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Invoice } from "../../../shared/fixtures.ts";
import type { InvoiceStatusArg } from "../../../shared/types.ts";
import type { EngineActions } from "../../engine/contract.ts";
import { useEngine } from "../../engine/store.ts";
import { formatDate, formatMoney, INVOICE_STATUS_LABEL, invoiceDueText, invoiceLabel, relativeTime } from "../format.ts";
import { useNow } from "@attuneui/react";
import { useStepAction } from "../linking.tsx";
import {
  Button,
  ClientFilterChip,
  Compact,
  DetailEmpty,
  DetailPane,
  EmptyList,
  Facts,
  HeroSplit,
  ListScroll,
  PanelColumn,
  Pill,
  RowButton,
  Segmented,
  Toolbar,
  type PanelProps,
  type Tone,
} from "./common.tsx";

type Tab = "all" | "overdue" | "unpaid" | "draft" | "paid";

const TABS: { id: Tab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "overdue", label: "Overdue" },
  { id: "unpaid", label: "Unpaid" },
  { id: "draft", label: "Draft" },
  { id: "paid", label: "Paid" },
];

const STATUS_TONE: Record<Invoice["status"], Tone> = {
  overdue: "bad",
  sent: "accent",
  draft: "neutral",
  paid: "good",
};

function toTab(status: InvoiceStatusArg | "all"): Tab {
  return status === "not_mentioned" ? "all" : status;
}

function inTab(inv: Invoice, tab: Tab): boolean {
  switch (tab) {
    case "all":
      return true;
    case "unpaid":
      return inv.status === "sent" || inv.status === "overdue";
    default:
      return inv.status === tab;
  }
}

// Overdue first, then by due date, so the money at risk is always on top.
const ORDER: Record<Invoice["status"], number> = { overdue: 0, sent: 1, draft: 2, paid: 3 };

export function InvoicesPanel({ size }: PanelProps) {
  const { invoices, view, track, setView, perform } = useEngine(
    useShallow((s) => ({
      invoices: s.data.invoices,
      view: s.view.invoices,
      track: s.track,
      setView: s.setView,
      perform: s.perform,
    })),
  );
  const now = useNow();
  const tab = toTab(view.status);

  const list = useMemo(
    () =>
      invoices
        .filter((inv) => inTab(inv, tab) && (!view.client || inv.client === view.client))
        .sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.due.localeCompare(b.due)),
    [invoices, tab, view.client],
  );
  const selected = invoices.find((i) => i.id === view.selectedId) ?? null;

  const select = (inv: Invoice) => {
    setView("invoices", { selectedId: inv.id });
    track({
      type: "item_open",
      panel: "invoices",
      detail: { itemKind: "invoice", itemId: inv.id, client: inv.client, label: invoiceLabel(inv, now), via: "pointer" },
    });
  };

  if (size === "compact") {
    const overdue = invoices.filter((i) => i.status === "overdue");
    const owed = overdue.reduce((sum, i) => sum + i.amount, 0);
    return <Compact value={overdue.length} label="overdue" sub={`${formatMoney(owed)} owed`} />;
  }

  const listView = (
    <PanelColumn>
      <Toolbar>
        <Segmented
          label="Invoice status"
          options={TABS}
          value={tab}
          onChange={(status) => {
            setView("invoices", { status });
            track({ type: "filter", panel: "invoices", detail: { filter: { status } } });
          }}
        />
      </Toolbar>
      {view.client ? (
        <ClientFilterChip
          client={view.client}
          onClear={() => {
            setView("invoices", { client: null });
            track({ type: "filter", panel: "invoices", detail: { filter: { client: "all" } } });
          }}
        />
      ) : null}
      <ListScroll label="Invoices">
        {list.length === 0 ? <EmptyList>No invoices here.</EmptyList> : null}
        {list.map((inv) => {
          const isSel = inv.id === view.selectedId;
          return (
            <li key={inv.id}>
              <RowButton selected={isSel} onClick={() => select(inv)} item={{ kind: "invoice", id: inv.id }}>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2">
                    <span className="min-w-0 truncate text-[13px] font-medium text-ink">{inv.client}</span>
                    <span className="ml-auto shrink-0 text-[13px] font-medium text-ink tabular-nums">{formatMoney(inv.amount)}</span>
                  </span>
                  <span className="mt-0.5 flex items-center gap-2">
                    <span className="shrink-0 font-mono text-2xs text-ink-3">{inv.id}</span>
                    <span
                      className={clsx(
                        "min-w-0 truncate text-2xs",
                        inv.status === "overdue" ? "font-medium text-bad-ink" : "text-ink-3",
                      )}
                    >
                      {invoiceDueText(inv, now)}
                    </span>
                    <Pill tone={STATUS_TONE[inv.status]} className="ml-auto">
                      {INVOICE_STATUS_LABEL[inv.status]}
                    </Pill>
                  </span>
                </span>
              </RowButton>
              {isSel && size !== "hero" ? <InlineActions inv={inv} perform={perform} /> : null}
            </li>
          );
        })}
      </ListScroll>
    </PanelColumn>
  );

  if (size !== "hero") return <HeroSplit hero={false} list={listView} />;

  const shown = selected ?? list[0] ?? null;
  return (
    <HeroSplit
      list={listView}
      detail={
        shown ? (
          <DetailPane actions={<InvoiceActions inv={shown} perform={perform} />}>
            <div className="flex items-center gap-2">
              <span className="font-mono text-2xs text-ink-3">{shown.id}</span>
              <Pill tone={STATUS_TONE[shown.status]}>{INVOICE_STATUS_LABEL[shown.status]}</Pill>
            </div>
            <p className="mt-2 text-3xl font-semibold tracking-tight text-ink">{formatMoney(shown.amount)}</p>
            <p className="mt-0.5 text-sm text-ink-2">
              {shown.client} · <span className={shown.status === "overdue" ? "font-medium text-bad-ink" : undefined}>{invoiceDueText(shown, now)}</span>
            </p>
            <Facts
              items={[
                { label: "Project", value: shown.project },
                { label: "Issued", value: formatDate(shown.issued) },
                { label: "Due", value: formatDate(shown.due) },
                {
                  label: "Reminders",
                  value: shown.remindersSent === 0 ? "None sent yet" : `${shown.remindersSent} sent`,
                },
                ...(shown.resentAt ? [{ label: "Resent", value: relativeTime(shown.resentAt, now) }] : []),
              ]}
            />
          </DetailPane>
        ) : (
          <DetailEmpty icon={Receipt}>Pick an invoice to see it here.</DetailEmpty>
        )
      }
    />
  );
}

type Perform = EngineActions["perform"];

function InvoiceActions({ inv, perform }: { inv: Invoice; perform: Perform }) {
  // The next step's action on this invoice, when Jev read one from a click: its button rings.
  const remindStep = useStepAction("send_payment_reminder", inv.id);
  const resendStep = useStepAction("resend_invoice", inv.id);
  const paidStep = useStepAction("mark_invoice_paid", inv.id);
  if (inv.status === "paid") return <p className="text-xs text-ink-3">Paid in full. Nothing to do.</p>;
  // A reminder or a resend needs an invoice the client already has: sent or overdue.
  const canRemind = inv.status === "overdue" || inv.status === "sent";
  return (
    <>
      {canRemind ? (
        <Button
          variant={inv.status === "overdue" ? "primary" : "secondary"}
          icon={BellRing}
          step={remindStep}
          onClick={() => perform("send_payment_reminder", { client: inv.client, invoiceId: inv.id })}
        >
          Send reminder
        </Button>
      ) : null}
      {canRemind ? (
        <Button data-guide-resend={inv.id} icon={Send} step={resendStep} onClick={() => perform("resend_invoice", { client: inv.client, invoiceId: inv.id })}>
          Resend
        </Button>
      ) : null}
      <Button icon={CircleCheck} step={paidStep} onClick={() => perform("mark_invoice_paid", { client: inv.client, invoiceId: inv.id })}>
        Mark paid
      </Button>
    </>
  );
}

function InlineActions({ inv, perform }: { inv: Invoice; perform: Perform }) {
  return (
    <div className="fl-pad flex flex-wrap gap-2 bg-accent-soft/70 pb-2">
      <InvoiceActions inv={inv} perform={perform} />
    </div>
  );
}
