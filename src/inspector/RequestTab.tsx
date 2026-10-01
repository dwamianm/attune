/**
 * "Request" tab: exactly what the server sent to Jev for the last applied
 * round, so a judgment can be reproduced or debugged outside the app.
 */
import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useEngine } from "../engine/store.ts";
import { EMPTY_ANSWERS } from "./NowTab.tsx";
import { Empty, Section } from "./ui.tsx";

function toJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "undefined";
  } catch {
    return String(value);
  }
}

function CopyButton({ text, what }: { text: string; what: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch {
      // Clipboard is blocked outside secure contexts and in some iframes.
      setState("failed");
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 1600);
  }

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={`Copy ${what}`}
      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-100 focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-neutral-300 dark:hover:bg-neutral-800"
    >
      {state === "copied" ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</span>
    </button>
  );
}

function JsonBlock({ title, value }: { title: string; value: unknown }) {
  const json = toJson(value);
  return (
    <Section title={title} aside={<CopyButton text={json} what={title.toLowerCase()} />}>
      <pre className="max-h-[45vh] overflow-auto rounded-lg bg-neutral-50 p-3 font-mono text-[11px] leading-relaxed text-neutral-800 dark:bg-neutral-900 dark:text-neutral-200">
        {json}
      </pre>
    </Section>
  );
}

export function RequestTab() {
  const last = useEngine((s) => s.last);
  if (!last) return <Empty>{EMPTY_ANSWERS}</Empty>;
  return (
    <div className="space-y-6">
      <p className="text-xs text-neutral-500 dark:text-neutral-400">
        Sent for v{last.version}. Jev never sees question ids, only the instructions and criteria.
      </p>
      <JsonBlock title="State" value={last.debug.state} />
      <JsonBlock title="Questions" value={last.debug.questions} />
    </div>
  );
}
