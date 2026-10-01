/**
 * "Back to" chips in the canvas caption (docs/predictive-flow.md): the
 * working contexts the engine saved when the work changed, most recent
 * first, for another goal than the current one. One click puts back that
 * layout, its filters and selections, the panels made bigger, and the link
 * cues, and saves the work being left so the user can go back and forth.
 * "b" goes back to the most recent one, with the same key rules as "n".
 * With the "Back to" focus aid off (docs/focus-aids.md) there are no chips
 * and "b" does nothing.
 *
 * The chips sit in the caption line, which keeps its height, so they never
 * move a panel. The most recent one shows as a chip; the older ones wait
 * behind "+N" beside it, a small list (usePopover), so three long labels
 * never crowd out the change feed. On a phone only the most recent chip
 * shows, as an icon.
 */
import clsx from "clsx";
import { ChevronDown, History } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId } from "react";
import { useShallow } from "zustand/react/shallow";
import { backToList } from "../engine/contexts.ts";
import { backToOn } from "../engine/focusAids.ts";
import { useEngine } from "../engine/store.ts";
import { usePopover, useWindowKeydown } from "./hooks.ts";
import { flowKeyTaken } from "./UpNext.tsx";

export function BackTo() {
  const list = useEngine(useShallow((s) => (backToOn(s.settings) ? backToList(s.contexts, s.working?.goal ?? null, s.working?.client) : [])));
  const restoreContext = useEngine((s) => s.restoreContext);
  const reduceMotion = useReducedMotion() ?? false;

  useWindowKeydown((e) => {
    if (e.key !== "b" || flowKeyTaken(e)) return;
    const s = useEngine.getState();
    const first = backToOn(s.settings) ? backToList(s.contexts, s.working?.goal ?? null, s.working?.client)[0] : undefined;
    if (!first) return;
    e.preventDefault();
    restoreContext(first.id, "keyboard");
  });

  const [first, ...older] = list;
  const { open, setOpen, wrapRef, buttonRef, panelRef, onBlur, closeAfterAction } = usePopover();
  const baseId = useId();
  // The list goes when the chips in it do.
  useEffect(() => {
    if (older.length === 0) setOpen(false);
  }, [older.length, setOpen]);

  return (
    <div
      ref={wrapRef}
      onBlur={onBlur}
      className="flex min-w-0 shrink items-center gap-1"
      role={list.length > 0 ? "group" : undefined}
      aria-label={list.length > 0 ? "Back to earlier work" : undefined}
    >
      <AnimatePresence initial={false}>
        {first ? (
          <motion.button
            key={first.id}
            type="button"
            layout={!reduceMotion}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.15 }}
            onClick={(e) => restoreContext(first.id, e.detail === 0 ? "keyboard" : "pointer")}
            title={`Back to ${first.label} (b)`}
            aria-label={`Back to ${first.label} (b)`}
            className="inline-flex h-5 max-w-[11rem] min-w-5 shrink items-center justify-center gap-1 rounded-full border border-line bg-surface px-1.5 text-2xs font-medium text-ink-2 transition-colors hover:border-accent/40 hover:text-ink sm:max-w-[17rem] xl:max-w-[24rem]"
          >
            <History className="size-3 shrink-0" aria-hidden />
            {/* On a phone just the icon, so the change feed beside it keeps its words; the label is in the tip and the name. */}
            <span className="hidden min-w-0 truncate sm:inline">Back to: {first.label}</span>
            <kbd className="hidden shrink-0 rounded border border-line px-1 font-sans text-2xs text-ink-3 sm:inline" aria-hidden>
              b
            </kbd>
          </motion.button>
        ) : null}
      </AnimatePresence>
      {older.length > 0 ? (
        <>
          <button
            ref={buttonRef}
            type="button"
            onClick={() => setOpen((o) => !o)}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-controls={open ? `${baseId}-older` : undefined}
            aria-label={`${older.length} more to go back to: ${older.map((c) => c.label).join(", ")}`}
            title={`${older.length} more to go back to`}
            className={clsx(
              "hidden h-5 shrink-0 items-center gap-0.5 rounded-full border px-1.5 text-2xs font-medium tabular-nums transition-colors sm:inline-flex",
              open ? "border-accent/40 bg-accent-soft text-accent-text" : "border-line bg-surface text-ink-2 hover:border-accent/40 hover:text-ink",
            )}
          >
            +{older.length}
            <ChevronDown className="size-3" aria-hidden />
          </button>
          {open ? (
            <div
              ref={panelRef}
              id={`${baseId}-older`}
              role="dialog"
              aria-label="More earlier work"
              // Anchored to the caption (its positioned ancestor), right edge to right edge.
              className="absolute top-full right-0 z-30 mt-1 w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-1 text-xs text-ink shadow-pop"
            >
              <ul>
                {older.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={(e) => {
                        restoreContext(c.id, e.detail === 0 ? "keyboard" : "pointer");
                        closeAfterAction();
                      }}
                      aria-label={`Back to ${c.label}`}
                      className="flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
                    >
                      <History className="mt-0.5 size-3 shrink-0" aria-hidden />
                      <span className="min-w-0 [overflow-wrap:anywhere]">Back to: {c.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
