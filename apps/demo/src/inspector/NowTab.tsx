/**
 * "Now" tab: the judgments behind the layout on screen right now
 * (the last response the engine applied).
 */
import { useEngine } from "../engine/store.ts";
import { JudgmentsView } from "./judgments.tsx";
import { ResponseMeta } from "./ResponseMeta.tsx";
import { Empty } from "./ui.tsx";

export const EMPTY_ANSWERS = "No answers yet. Use the app or replay a scenario.";

export function NowTab() {
  const last = useEngine((s) => s.last);
  if (!last) return <Empty>{EMPTY_ANSWERS}</Empty>;
  return (
    <div className="space-y-6">
      <ResponseMeta response={last} />
      <JudgmentsView judgments={last.judgments} />
    </div>
  );
}
