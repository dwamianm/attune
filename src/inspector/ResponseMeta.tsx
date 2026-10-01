/**
 * Who answered one adaptation round, how fast, and what it cost.
 *
 * Cost is computed here from input tokens because TypeSafe bills only input
 * tokens, and showing it per call makes the "cheap enough to ask on every
 * interaction" argument visible.
 */
import { TriangleAlert } from "lucide-react";
import type { AdaptResponse } from "../../shared/types.ts";
import { costUsd, formatInt, formatMs, formatUsd } from "./format.ts";
import { Badge, Stat } from "./ui.tsx";

export function SourceBadge({ source }: { source: AdaptResponse["source"] }) {
  return source === "jev" ? <Badge tone="accent">Jev</Badge> : <Badge tone="warn">Heuristic</Badge>;
}

export function ResponseMeta({ response }: { response: AdaptResponse }) {
  const { meta } = response;
  const tokens = meta.usage?.input_tokens;
  const cost = tokens != null ? costUsd(tokens) : null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SourceBadge source={response.source} />
        <Badge>v{response.version}</Badge>
        {meta.requestId && (
          <span className="min-w-0 truncate font-mono text-[11px] text-neutral-500 dark:text-neutral-400" title={meta.requestId}>
            {meta.requestId}
          </span>
        )}
      </div>
      {meta.error && (
        <div className="flex gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <TriangleAlert className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden />
          <p className="min-w-0 break-words">
            Jev did not answer, so the heuristic did. <span className="font-mono">{meta.error}</span>
          </p>
        </div>
      )}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Model" value={<span className="font-mono text-xs">{meta.model}</span>} />
        <Stat label="Latency" value={formatMs(meta.latencyMs)} />
        <Stat label="Questions" value={formatInt(meta.questionCount)} />
        <Stat label="Input tokens" value={tokens != null ? formatInt(tokens) : "Not reported"} />
        <Stat
          label="Cost of this call"
          value={cost != null ? formatUsd(cost) : response.source === "heuristic" ? "$0" : "n/a"}
          hint={cost != null ? `${formatUsd(cost * 1000)} per 1,000 calls` : response.source === "heuristic" ? "Runs in code, no charge" : undefined}
        />
        <Stat label="Output tokens" value={meta.usage ? formatInt(meta.usage.output_tokens) : "Not reported"} hint="Free" />
      </div>
    </div>
  );
}
