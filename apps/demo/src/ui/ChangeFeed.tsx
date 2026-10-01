/**
 * What the last plan changed and why, with an Undo while the change is
 * fresh. Adaptive UIs must never move things silently; this is the visible
 * half of that promise (the other half is the aria-live region in Canvas).
 *
 * It is one line in the canvas caption, in the page flow, not a floating
 * card: floating over the canvas it covered the panel that had just been
 * added (new panels land last, at the bottom), and on phones it covered the
 * command bar. "+N more" opens the full list.
 */
import clsx from "clsx";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  Command,
  LayoutGrid,
  LifeBuoy,
  Pause,
  Plus,
  Rows3,
  Sparkles,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Decision, LayoutPlan } from "../../shared/types.ts";
import { useEngine } from "../engine/store.ts";
import { useWindowKeydown } from "@attune/react";
import { requestInspectorTab } from "./hooks.ts";
import { useNoteUndoListener } from "./linking.tsx";

const FRESH_MS = 6000;
/** Lines kept per card (the inspector's Decisions tab has all of them). */
const MAX_ITEMS = 8;
/** Lines shown inline before "+N more". */
const INLINE_ITEMS = 2;

const KIND_ICON: Record<Decision["kind"], LucideIcon> = {
  mode: LayoutGrid,
  promote: ArrowUp,
  demote: ArrowDown,
  add: Plus,
  dock: ArrowDownToLine,
  suggest: Sparkles,
  help: LifeBuoy,
  hold: Pause,
  command: Command,
  density: Rows3,
};

interface Entry {
  id: number;
  at: number;
  items: Decision[];
  /** The plan before the card's first change, so one Undo reverts everything the card lists. */
  before: LayoutPlan | null;
}

/** The feed line. `idle` is what the caption shows when nothing changed recently. */
export function ChangeFeed({ idle }: { idle: ReactNode }) {
  // Decisions, not the whole plan: removing an accepted suggestion copies the
  // plan with the same decisions, which must not replay the last change.
  const { decisions, canUndo, undo, adaptive, frozen, setInspectorOpen } = useEngine(
    useShallow((s) => ({
      decisions: s.plan.decisions,
      canUndo: s.previousPlan !== null,
      undo: s.undo,
      adaptive: s.settings.adaptive,
      frozen: s.settings.frozen,
      setInspectorOpen: s.setInspectorOpen,
    })),
  );
  const reduceMotion = useReducedMotion() ?? false;
  // `id` stays the same while changes keep arriving, so a burst of plans
  // (layout, then a suggestion) reads as one card instead of stacking.
  const [entry, setEntry] = useState<Entry | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const seenFirst = useRef(false);
  const skipNext = useRef(false);
  const listId = useId();

  useEffect(() => {
    // The first plan is the starting layout, not a change.
    if (!seenFirst.current) {
      seenFirst.current = true;
      return;
    }
    // The plan restored by Undo is not news either.
    if (skipNext.current) {
      skipNext.current = false;
      return;
    }
    const fresh = decisions.filter((d) => d.kind !== "hold");
    if (fresh.length === 0) return;
    setEntry((prev) => {
      const now = Date.now();
      if (!prev) return { id: now, at: now, items: fresh.slice(0, MAX_ITEMS), before: useEngine.getState().previousPlan };
      const seen = new Set(fresh.map((d) => d.text));
      const items = [...fresh, ...prev.items.filter((d) => !seen.has(d.text))].slice(0, MAX_ITEMS);
      return { ...prev, at: now, items };
    });
  }, [decisions]);

  // Switching Adaptive or Freeze starts over: an Undo from before the switch
  // would bring back a layout from the other setting.
  useEffect(() => {
    setEntry(null);
    setOpen(false);
  }, [adaptive, frozen]);

  // Fade after FRESH_MS, but not while the pointer or keyboard focus is on
  // it. Checked when the timer fires rather than tracked with enter and
  // leave events, which went stale when the line moved under a still pointer.
  useEffect(() => {
    if (!entry || open) return;
    let t: ReturnType<typeof setTimeout>;
    const tick = () => {
      const el = wrapRef.current;
      const inUse = el !== null && (el.matches(":hover") || el.contains(document.activeElement));
      if (inUse) t = setTimeout(tick, 1000);
      else setEntry(null);
    };
    t = setTimeout(tick, FRESH_MS);
    return () => clearTimeout(t);
  }, [entry, open]);

  useEffect(() => {
    if (!entry) setOpen(false);
  }, [entry]);

  useWindowKeydown((e) => {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    }
  }, open);

  const onUndo = () => {
    skipNext.current = true;
    undo(entry?.before ?? undefined);
    setEntry(null);
  };

  // Undo from the note on the anchor card reverts the same change.
  useNoteUndoListener(() => {
    skipNext.current = true;
    setEntry(null);
  });

  const items = entry?.items ?? [];
  const inline = items.slice(0, INLINE_ITEMS);
  const more = items.length - inline.length;

  return (
    // Not `relative`: the details list anchors to the caption row (Canvas), so it fits on phones.
    // While a change is fresh it keeps room for its first words and Undo, however full the caption is.
    <div ref={wrapRef} className={clsx("flex flex-1 items-center gap-1.5", entry ? "min-w-[7.5rem]" : "min-w-0")}>
      <AnimatePresence mode="wait" initial={false}>
        {entry ? (
          <motion.div
            key={entry.id}
            initial={reduceMotion ? false : { opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.2 } }}
            // A size container: "Layout changed:" and "+N more" show when the room the caption leaves allows, not by window width.
            className="@container flex min-w-0 flex-1 items-center gap-1.5"
          >
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls={listId}
              className="flex min-w-0 items-center gap-1.5 rounded-md px-1 text-left text-ink-2 hover:bg-surface-2 hover:text-ink"
              title="Show every change and why"
            >
              {/* Read to screen readers in every width; shown where it fits. */}
              <span className="sr-only shrink-0 font-medium text-accent-text @[20rem]:not-sr-only">Layout changed: </span>
              <span className="min-w-0 truncate text-accent-text @[20rem]:text-ink-2">{inline.map((d) => d.text).join("; ")}</span>
              {more > 0 ? <span className="sr-only shrink-0 font-medium text-ink-3 @[11rem]:not-sr-only">+{more} more</span> : null}
            </button>
            {canUndo ? (
              <button
                type="button"
                onClick={onUndo}
                className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 font-medium text-accent-text hover:bg-accent-soft"
              >
                <Undo2 className="size-3" aria-hidden />
                Undo
              </button>
            ) : null}
          </motion.div>
        ) : (
          <motion.span
            key="idle"
            initial={reduceMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.12 } }}
            className="min-w-0 truncate"
            title={typeof idle === "string" ? idle : undefined}
          >
            {idle}
          </motion.span>
        )}
      </AnimatePresence>

      {open && entry ? (
        <div
          id={listId}
          className="absolute top-full left-0 z-20 mt-1 w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-2.5 text-xs text-ink-2 shadow-pop"
        >
          <ul className="space-y-1">
            {items.map((d, i) => {
              const Icon = KIND_ICON[d.kind];
              return (
                <li key={`${d.kind}-${d.panel ?? ""}-${i}`} className="flex items-start gap-2">
                  <Icon className="mt-0.5 size-3.5 shrink-0 text-ink-3" aria-hidden />
                  <span className="min-w-0">
                    {d.text}
                    {d.evidence ? <span className="block text-2xs text-ink-3">{d.evidence}</span> : null}
                  </span>
                </li>
              );
            })}
          </ul>
          <div className="mt-2 flex items-center gap-2 border-t border-line pt-2">
            <button
              type="button"
              onClick={() => {
                requestInspectorTab("decisions");
                setInspectorOpen(true);
                setOpen(false);
              }}
              className={clsx("h-6 rounded-md px-1.5 text-2xs font-medium text-accent-text hover:bg-accent-soft")}
            >
              Open the Decisions tab
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
