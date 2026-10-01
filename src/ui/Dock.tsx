/**
 * The dock: every panel that is not on the canvas, one click away. It is
 * the only "navigation" left, and using it is itself a signal.
 *
 * When a panel is opened from the dock, its icon's place is kept empty until
 * the pointer leaves the dock, so the next icon does not slide under the
 * pointer and take the next click (the way browser tab strips close tabs).
 *
 * A card leaving the canvas flies into its icon (PanelFrame finds it by
 * data-dock-id), and the icon rings once when the card lands, so the user
 * sees where the panel went.
 */
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import { PANELS, type PanelId } from "../../shared/catalog.ts";
import { MANUAL_EDIT_HOLD_MS, useEngine } from "../engine/store.ts";
import { DOCK_PULSE_MS, STAGE_EXIT } from "./choreography.ts";
import { DOCK_ID_ATTR } from "./domHooks.ts";
import { useElementSize } from "./hooks.ts";
import { panelIcon } from "./icons.ts";
import { useRoundCues } from "./linking.tsx";

export function Dock() {
  const docked = useEngine((s) => s.plan.docked);
  const open = useEngine((s) => s.open);
  // Cards this round sent to the dock; their icons ring when the card lands.
  const { round, docked: landing } = useRoundCues();
  const reduceMotion = useReducedMotion() ?? false;
  const [ghost, setGhost] = useState<{ id: PanelId; index: number } | null>(null);
  const [barRef, bar] = useElementSize<HTMLDivElement>();

  // Other bottom overlays (the action toast on phones) sit just above the dock.
  useEffect(() => {
    if (bar.height > 0) document.documentElement.style.setProperty("--fl-dock-h", `${Math.round(bar.height)}px`);
  }, [bar.height]);

  useEffect(() => {
    if (!ghost) return;
    const t = setTimeout(() => setGhost(null), MANUAL_EDIT_HOLD_MS);
    return () => clearTimeout(t);
  }, [ghost]);

  const items: (PanelId | { ghost: PanelId })[] = [...docked];
  if (ghost && !docked.includes(ghost.id)) items.splice(Math.min(ghost.index, items.length), 0, { ghost: ghost.id });

  return (
    <nav id="dock" tabIndex={-1} aria-label="Dock" className="pointer-events-none fixed inset-x-0 bottom-3 z-30 flex justify-center px-4 outline-none">
      <motion.div
        ref={barRef}
        layout={!reduceMotion}
        transition={{ type: "spring", stiffness: 380, damping: 34 }}
        style={{ borderRadius: 16 }}
        onPointerLeave={() => setGhost(null)}
        className="pointer-events-auto relative flex max-w-full flex-wrap items-center justify-center gap-1 border border-line bg-surface/90 p-1.5 shadow-pop backdrop-blur-md"
      >
        <motion.span layout={reduceMotion ? false : "position"} className="px-2 text-2xs font-medium text-ink-3">
          Dock
        </motion.span>
        <AnimatePresence initial={false} mode="popLayout">
          {items.length === 0 ? (
            <motion.span
              key="empty"
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.1 } }}
              className="pr-2 text-2xs text-ink-3"
            >
              Panels you send away wait here
            </motion.span>
          ) : (
            items.map((item, index) => {
              if (typeof item !== "string") return <span key={`ghost-${item.ghost}`} aria-hidden className="size-9" />;
              const id = item;
              const Icon = panelIcon(id);
              const title = PANELS[id].title;
              return (
                <motion.div
                  key={id}
                  {...{ [DOCK_ID_ATTR]: id }}
                  layout={!reduceMotion}
                  initial={reduceMotion ? false : { opacity: 0, scale: 0.6 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scale: 0.6, transition: { duration: 0.14 } }}
                  transition={{ type: "spring", stiffness: 420, damping: 30 }}
                  className="group relative"
                >
                  <button
                    type="button"
                    onClick={(e) => {
                      if (e.detail > 0) setGhost({ id, index });
                      open(id);
                    }}
                    aria-label={`Open ${title}`}
                    className="grid size-9 place-items-center rounded-xl text-ink-2 transition-colors hover:bg-surface-3 hover:text-ink"
                  >
                    <Icon className="size-[18px]" aria-hidden />
                  </button>
                  {landing.includes(id) ? (
                    // Keyed on the round, so it rings once when this round's card lands.
                    <motion.span
                      key={`land-${round}`}
                      aria-hidden
                      className="pointer-events-none absolute inset-0 rounded-xl ring-2 ring-accent/60"
                      initial={{ opacity: 0, scale: 1 }}
                      animate={reduceMotion ? { opacity: [0, 1, 0] } : { opacity: [0, 1, 0], scale: [0.85, 1.12, 1.2] }}
                      transition={{
                        delay: reduceMotion ? 0 : (STAGE_EXIT.delayMs + STAGE_EXIT.durationMs) / 1000,
                        duration: DOCK_PULSE_MS / 1000,
                        ease: "easeOut",
                      }}
                    />
                  ) : null}
                  <span
                    aria-hidden
                    className="pointer-events-none absolute bottom-full left-1/2 mb-2 -translate-x-1/2 rounded-md bg-ink px-2 py-1 text-2xs font-medium whitespace-nowrap text-canvas opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                  >
                    {title}
                  </span>
                </motion.div>
              );
            })
          )}
        </AnimatePresence>
      </motion.div>
    </nav>
  );
}
