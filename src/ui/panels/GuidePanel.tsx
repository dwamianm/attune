/**
 * Guide panel (panel id "help"). The policy brings it forward when Jev judges
 * that the user is struggling, so the tips are short and point at the
 * fastest way out: the command bar.
 */
import clsx from "clsx";
import { ArrowDownToLine, Command, Pin, ScanEye, Sparkles, type LucideIcon } from "lucide-react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { useEngine } from "../../engine/store.ts";
import { focusCommandBar, MOD_K } from "../hooks.ts";
import { Button, Compact, type PanelProps } from "./common.tsx";

const TIPS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Command,
    title: "Ask for anything",
    body: `Press ${MOD_K} and type what you need, for example: who still owes us money?`,
  },
  {
    icon: Sparkles,
    title: "Take the next step",
    body: "The bar under the command bar suggests what to do next. When one step is highlighted, press . (outside a text box) to accept it.",
  },
  {
    icon: Pin,
    title: "Pin what matters",
    body: "Pinned panels stay on the canvas while everything else adapts around them.",
  },
  {
    icon: ArrowDownToLine,
    title: "Use the dock",
    body: "Send a panel to the dock to hide it. Click its icon at the bottom to bring it back.",
  },
  {
    icon: ScanEye,
    title: "See why",
    body: "Each panel has a Why here? button. The inspector shows what Jev saw and judged.",
  },
];

/**
 * How many tips are still below the visible part of the list. At standard
 * size only two of the five fit, and the rest looked cut off under the button.
 */
function useHiddenBelow(): { ref: (el: HTMLOListElement | null) => void; hidden: number; update: () => void } {
  const el = useRef<HTMLOListElement | null>(null);
  const [hidden, setHidden] = useState(0);
  const update = useCallback(() => {
    const list = el.current;
    if (!list) return;
    const bottom = list.getBoundingClientRect().bottom;
    setHidden([...list.children].filter((li) => li.getBoundingClientRect().bottom > bottom + 2).length);
  }, []);
  useLayoutEffect(() => {
    update();
    const list = el.current;
    if (!list) return;
    const ro = new ResizeObserver(update);
    ro.observe(list);
    return () => ro.disconnect();
  }, [update]);
  return {
    ref: (node) => {
      el.current = node;
    },
    hidden,
    update,
  };
}

export function GuidePanel({ size }: PanelProps) {
  const setInspectorOpen = useEngine((s) => s.setInspectorOpen);
  const below = useHiddenBelow();

  if (size === "compact") {
    return <Compact value={TIPS.length} label="tips" sub={`Press ${MOD_K} to ask for anything`} />;
  }

  return (
    <div className="@container fl-pad flex h-full min-h-0 flex-col pb-3">
      <ol
        ref={below.ref}
        onScroll={below.update}
        // Focusable so the tips can be scrolled with the keyboard too.
        tabIndex={0}
        aria-label="Tips"
        className={clsx(
          "fl-scroll grid min-h-0 flex-1 content-start gap-x-4 gap-y-2.5 overflow-y-auto rounded-md @md:grid-cols-2",
          below.hidden > 0 && "[mask-image:linear-gradient(to_bottom,black_75%,transparent)]",
        )}
      >
        {TIPS.map((t) => (
          <li key={t.title} className="flex gap-2.5">
            <span className="grid size-6 shrink-0 place-items-center rounded-md bg-accent-soft text-accent-text">
              <t.icon className="size-3.5" aria-hidden />
            </span>
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-ink">{t.title}</span>
              <span className="block text-xs leading-snug text-ink-2">{t.body}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="mt-2 flex shrink-0 flex-wrap items-center gap-2">
        <Button variant="primary" icon={Command} onClick={() => focusCommandBar()}>
          Try the command bar
        </Button>
        {below.hidden > 0 ? (
          <span className="text-2xs text-ink-3" aria-hidden>
            {below.hidden === 1 ? "1 more tip below" : `${below.hidden} more tips below`}
          </span>
        ) : null}
        {size === "hero" ? (
          <Button icon={ScanEye} onClick={() => setInspectorOpen(true)}>
            Open the inspector
          </Button>
        ) : null}
      </div>
    </div>
  );
}
