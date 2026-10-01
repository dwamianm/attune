/**
 * A slim help banner. The policy sets plan.help to "hint" when Jev's
 * struggling judgment is high but not high enough to bring in the Guide
 * panel. Dismissing it lasts until the policy stops asking for it.
 *
 * It sits above the canvas, so while the user works in a panel (a live
 * anchor) it neither appears nor goes away on its own: either would push
 * the panel they are looking at. It catches up when the anchor is released.
 */
import { LifeBuoy, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { useEngine } from "../engine/store.ts";
import { focusCommandBar } from "./hooks.ts";
import { useHeldWhile, useWorkAnchorLive } from "./linking.tsx";

export function HelpHint() {
  const help = useHeldWhile(
    useEngine((s) => s.plan.help),
    useWorkAnchorLive(),
  );
  const track = useEngine((s) => s.track);
  const reduceMotion = useReducedMotion() ?? false;
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (help !== "hint") setDismissed(false);
  }, [help]);

  const show = help === "hint" && !dismissed;

  return (
    <AnimatePresence initial={false}>
      {show ? (
        <motion.div
          key="hint"
          initial={reduceMotion ? false : { opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, height: 0 }}
          transition={{ type: "spring", stiffness: 380, damping: 34 }}
          className="overflow-hidden"
        >
          <div role="note" className="flex items-center gap-2.5 rounded-xl border border-accent/25 bg-accent-soft px-3 py-2 text-sm text-ink">
            <LifeBuoy className="size-4 shrink-0 text-accent-text" aria-hidden />
            <p className="min-w-0 flex-1 leading-snug">
              Looking for something? Type it in the command bar, for example: unpaid invoices.
            </p>
            <button
              type="button"
              onClick={() => focusCommandBar("unpaid invoices")}
              className="hidden h-7 shrink-0 rounded-lg px-2.5 text-xs font-medium text-accent-text hover:bg-accent/10 sm:block"
            >
              Try it
            </button>
            <button
              type="button"
              onClick={() => {
                setDismissed(true);
                track({ type: "suggestion_dismiss", detail: { label: "Dismissed the help hint" } });
              }}
              aria-label="Dismiss help hint"
              className="grid size-7 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-accent/10 hover:text-ink"
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
