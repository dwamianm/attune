/**
 * Revenue panel (panel id "analytics"): a hand-drawn SVG bar chart of
 * MONTHLY_REVENUE plus the headline numbers. No chart library: the chart is
 * small, and drawing it directly keeps it crisp at every card size.
 *
 * Money owed is computed from the live store data (same rule as
 * outstandingTotal in fixtures) so marking an invoice paid updates it.
 */
import clsx from "clsx";
import { Receipt } from "lucide-react";
import { useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import { useShallow } from "zustand/react/shallow";
import { CLIENTS, MONTHLY_REVENUE, type Invoice } from "../../../shared/fixtures.ts";
import { useEngine } from "../../engine/store.ts";
import { formatMoney, formatMoneyShort } from "../format.ts";
import { useElementSize } from "../hooks.ts";
import { useItemProps } from "../linking.tsx";
import { Button, Compact, HeroSplit, PanelColumn, Segmented, Toolbar, type PanelProps } from "./common.tsx";

const RANGES = [
  { id: "this_month", label: "This month" },
  { id: "this_year", label: "This year" },
] as const;

function isOwed(i: Invoice): boolean {
  return i.status === "overdue" || i.status === "sent";
}

export function RevenuePanel({ size }: PanelProps) {
  const { invoices, range, track, setView, open } = useEngine(
    useShallow((s) => ({
      invoices: s.data.invoices,
      range: s.view.analytics.range,
      track: s.track,
      setView: s.setView,
      open: s.open,
    })),
  );

  const owed = invoices.filter(isOwed).reduce((sum, i) => sum + i.amount, 0);
  const thisMonth = MONTHLY_REVENUE.at(-1)?.amount ?? 0;
  // The series ends with the current month, so the year so far is the last (month index + 1) entries.
  const ytdCount = new Date().getMonth() + 1;
  const ytd = MONTHLY_REVENUE.slice(-ytdCount).reduce((sum, m) => sum + m.amount, 0);

  if (size === "compact") {
    return <Compact value={formatMoneyShort(thisMonth)} label="this month so far" sub={`${formatMoneyShort(owed)} still owed`} />;
  }

  const highlight = (i: number) => (range === "this_month" ? i === MONTHLY_REVENUE.length - 1 : i >= MONTHLY_REVENUE.length - ytdCount);

  const overview = (
    <PanelColumn>
      <Toolbar>
        <Segmented
          label="Revenue range"
          options={[...RANGES]}
          value={range}
          onChange={(r) => {
            setView("analytics", { range: r });
            track({ type: "filter", panel: "analytics", detail: { filter: { range: r } } });
          }}
        />
      </Toolbar>
      <div className="fl-pad flex shrink-0 items-end gap-6 pb-1">
        <Stat label={range === "this_month" ? "This month so far" : "Year to date"} value={formatMoney(range === "this_month" ? thisMonth : ytd)} strong />
        <Stat label="Owed to you" value={formatMoney(owed)} />
      </div>
      <div className="min-h-0 flex-1 px-1 pb-1">
        <RevenueChart highlight={highlight} />
      </div>
    </PanelColumn>
  );

  if (size !== "hero") return <HeroSplit hero={false} list={overview} />;

  return <HeroSplit list={overview} detail={<OwedList invoices={invoices} onSee={(client) => {
    setView("invoices", { client, status: "unpaid", selectedId: null });
    track({ type: "filter", panel: "invoices", detail: { filter: { status: "unpaid", client }, client, via: "pointer" } });
    open("invoices");
  }} />} />;
}

function Stat({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-2xs text-ink-3">{label}</p>
      <p className={clsx("leading-tight font-semibold tracking-tight text-ink", strong ? "text-xl" : "text-base text-ink-2")}>{value}</p>
    </div>
  );
}

/** Who owes money, largest first. The hero view's "detail" side. */
function OwedList({ invoices, onSee }: { invoices: Invoice[]; onSee: (client: string) => void }) {
  const item = useItemProps();
  const rows = useMemo(() => {
    const by = new Map<string, { client: string; total: number; overdue: number }>();
    for (const i of invoices.filter(isOwed)) {
      const r = by.get(i.client) ?? { client: i.client, total: 0, overdue: 0 };
      r.total += i.amount;
      if (i.status === "overdue") r.overdue += 1;
      by.set(i.client, r);
    }
    return [...by.values()].sort((a, b) => b.overdue - a.overdue || b.total - a.total);
  }, [invoices]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="fl-pad shrink-0 pt-2 pb-1 text-2xs font-medium text-ink-3">Who owes you</p>
      <ul className="fl-scroll min-h-0 flex-1 overflow-y-auto pb-2" aria-label="Money owed by client">
        {rows.length === 0 ? <li className="fl-pad py-4 text-xs text-ink-3">Nobody. Every invoice is paid.</li> : null}
        {rows.map((r) => (
          <li key={r.client} {...item("client", CLIENTS.find((c) => c.name === r.client)?.id ?? r.client)} className="fl-row fl-pad flex items-center gap-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium text-ink">{r.client}</span>
              <span className={clsx("block text-2xs", r.overdue ? "font-medium text-bad-ink" : "text-ink-3")}>
                {r.overdue ? `${r.overdue} overdue` : "Not due yet"}
              </span>
            </span>
            <span className="shrink-0 text-[13px] font-medium text-ink tabular-nums">{formatMoney(r.total)}</span>
            <Button size="xs" icon={Receipt} onClick={() => onSee(r.client)} aria-label={`See invoices for ${r.client}`}>
              Invoices
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chart
// ---------------------------------------------------------------------------

const MARGIN = { top: 10, right: 6, bottom: 18, left: 34 };

function niceMax(v: number): number {
  const step = v > 20_000 ? 10_000 : 5_000;
  return Math.ceil(v / step) * step;
}

/** Column with a 4 px rounded data end and a square baseline. */
function barPath(x: number, y: number, w: number, base: number): string {
  const r = Math.min(4, w / 2, Math.max(0, base - y));
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

function RevenueChart({ highlight }: { highlight: (i: number) => boolean }) {
  const [wrapRef, { width, height }] = useElementSize<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const data = MONTHLY_REVENUE;
  const n = data.length;
  const lastIdx = n - 1;

  const plotW = Math.max(0, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(0, height - MARGIN.top - MARGIN.bottom);
  const yMax = niceMax(Math.max(...data.map((d) => d.amount)));
  const ticks = plotH < 70 ? [0, yMax] : [0, yMax / 3, (2 * yMax) / 3, yMax];
  const band = n > 0 ? plotW / n : 0;
  const barW = Math.max(2, Math.min(24, band * 0.62));
  const base = MARGIN.top + plotH;
  const y = (v: number) => MARGIN.top + plotH - (v / yMax) * plotH;
  const labelEvery = band < 24 ? 2 : 1;

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left - MARGIN.left;
    if (band <= 0) return;
    setActive(Math.min(lastIdx, Math.max(0, Math.floor(px / band))));
  };

  const onKey = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    setActive((a) => {
      const cur = a ?? lastIdx;
      if (e.key === "Home") return 0;
      if (e.key === "End") return lastIdx;
      return Math.min(lastIdx, Math.max(0, cur + (e.key === "ArrowRight" ? 1 : -1)));
    });
  };

  const activeDatum = active !== null ? data[active] : undefined;
  const tipText = activeDatum ? `${activeDatum.month}${active === lastIdx ? " so far" : ""}: ${formatMoney(activeDatum.amount)}` : "";

  return (
    <div ref={wrapRef} className="relative h-full min-h-[60px] w-full">
      {width > 0 && height > 0 ? (
        <svg
          width={width}
          height={height}
          role="group"
          aria-label="Monthly revenue for the last 12 months. Use the left and right arrow keys to read each month."
          tabIndex={0}
          className="block rounded-md"
          onPointerMove={onMove}
          onPointerLeave={() => setActive(null)}
          onKeyDown={onKey}
          onBlur={() => setActive(null)}
          onFocus={() => setActive((a) => a ?? lastIdx)}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={MARGIN.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--color-ink-3)" className="tabular-nums">
                {t === 0 ? "0" : formatMoneyShort(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const x = MARGIN.left + i * band + (band - barW) / 2;
            const on = highlight(i);
            const dim = active !== null && active !== i;
            return (
              <g key={`${d.month}-${i}`}>
                <path
                  d={barPath(x, y(d.amount), barW, base)}
                  fill={on ? "var(--color-chart-current)" : "var(--color-chart)"}
                  opacity={dim ? 0.55 : 1}
                  style={{ transition: "opacity 120ms" }}
                />
                {(lastIdx - i) % labelEvery === 0 ? (
                  <text x={x + barW / 2} y={height - 4} textAnchor="middle" fontSize={10} fill={active === i ? "var(--color-ink)" : "var(--color-ink-3)"}>
                    {d.month}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      ) : null}

      {activeDatum && active !== null ? (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-line bg-surface px-2 py-1 text-2xs whitespace-nowrap shadow-pop"
          style={{
            left: Math.min(Math.max(MARGIN.left + active * band + band / 2, 44), width - 44),
            top: Math.max(0, y(activeDatum.amount) - 30),
          }}
          aria-hidden
        >
          <span className="font-semibold text-ink tabular-nums">{formatMoney(activeDatum.amount)}</span>{" "}
          <span className="text-ink-3">
            {activeDatum.month}
            {active === lastIdx ? " so far" : ""}
          </span>
        </div>
      ) : null}

      <p className="sr-only" aria-live="polite">
        {tipText}
      </p>
      <table className="sr-only">
        <caption>Monthly revenue, last 12 months</caption>
        <thead>
          <tr>
            <th scope="col">Month</th>
            <th scope="col">Revenue</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={`${d.month}-${i}`}>
              <th scope="row">
                {d.month}
                {i === lastIdx ? " (so far)" : ""}
              </th>
              <td>{formatMoney(d.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
