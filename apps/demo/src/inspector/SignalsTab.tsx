/**
 * "Signals" tab: the raw event log the engine turns into the plain-words
 * snapshot Jev reads. Newest first, so the latest click is at the top.
 */
import { useEngine } from "../engine/store.ts";
import { formatAgo, humanize, panelLabel } from "./format.ts";
import { Badge, Empty } from "./ui.tsx";
import { useNow } from "./useNow.ts";

// Rendering thousands of rows would slow the drawer; the tail is what matters.
const MAX_ROWS = 300;

export function SignalsTab() {
  const events = useEngine((s) => s.events);
  const now = useNow();

  if (events.length === 0) return <Empty>No signals yet. Click, search, or type in the app.</Empty>;

  const newestFirst = [...events].sort((a, b) => b.t - a.t || b.id - a.id).slice(0, MAX_ROWS);
  return (
    <div className="space-y-2">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        {events.length} {events.length === 1 ? "signal" : "signals"}, newest first.
        {events.length > MAX_ROWS && ` Showing the latest ${MAX_ROWS}.`}
      </p>
      <ol className="divide-y divide-neutral-100 dark:divide-neutral-900">
        {newestFirst.map((e) => (
          <li key={e.id} className="grid grid-cols-[3.75rem_1fr] gap-2 py-2">
            <span className="pt-0.5 text-[11px] text-neutral-500 tabular-nums dark:text-neutral-400" title={new Date(e.t).toLocaleTimeString()}>
              {formatAgo(e.t, now)}
            </span>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="info">{humanize(e.type)}</Badge>
                {e.panel && <Badge>{panelLabel(e.panel)}</Badge>}
              </div>
              <p className="break-words text-xs text-neutral-700 dark:text-neutral-300">{e.text}</p>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
