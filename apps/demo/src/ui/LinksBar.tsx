/**
 * The links bar in the canvas caption: "Links for INV-1047 · 3 panels ·
 * Clear all links" ("3 links" and an x on a phone). It shows while the link cues (tints, tags, and lines)
 * are on screen, which by default is until the user clears them, so there
 * is always a visible, keyboard reachable way to do that. Escape clears
 * them too, unless the key belongs to something else first: a text field,
 * an open popover, the command bar, or the inspector.
 *
 * Screen readers hear what a dismissal did ("Removed the link to Inbox")
 * from a polite live region that is always mounted.
 */
import { Link2, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { linkLabel, useEngine } from "../engine/store.ts";
import { commandBarSelector, LINKS_BAR_ATTR } from "./domHooks.ts";
import { isTextField, useWindowKeydown } from "@attune/react";
import { useLinks } from "./linking.tsx";

/** The bar's entry and exit, short so it reads as part of the caption rather than a new thing. */
const BAR_FADE_MS = 150;

/** Escape belongs to something else first: a text field, an open popover, the command bar, or the inspector. */
function escapeTaken(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || useEngine.getState().inspectorOpen) return true;
  const active = document.activeElement;
  if (isTextField(e.target) || isTextField(active)) return true;
  if (active instanceof Element && active.closest(commandBarSelector())) return true;
  // "Why here?", the change list, and other popovers mark their open state this way.
  return document.querySelector('[role="dialog"], [aria-expanded="true"]') !== null;
}

export function LinksBar() {
  const links = useLinks();
  const clearLinks = useEngine((s) => s.clearLinks);
  // The newest event, when it is a dismissal: its sentence is what the live region reads.
  const dismissed = useEngine((s) => {
    const e = s.events.at(-1);
    return e?.type === "links_dismiss" ? e : null;
  });
  const reduceMotion = useReducedMotion() ?? false;
  const count = links ? Object.keys(links.relations).length : 0;

  useWindowKeydown((e) => {
    if (e.key !== "Escape" || escapeTaken(e)) return;
    e.preventDefault();
    clearLinks("keyboard");
  }, links !== null);

  return (
    <>
      <span className="sr-only" aria-live="polite">
        {dismissed?.text ?? ""}
      </span>
      <AnimatePresence initial={false}>
        {links ? (
          <motion.div
            key="links"
            {...{ [LINKS_BAR_ATTR]: "" }}
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: BAR_FADE_MS / 1000 } }}
            transition={{ duration: BAR_FADE_MS / 1000 }}
            className="flex min-w-0 shrink-0 items-center gap-1 rounded-full bg-link-soft py-0.5 pr-0.5 pl-2 text-link-text ring-1 ring-link/25 ring-inset"
          >
            <Link2 className="size-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate sm:max-w-[18rem]">
              <span className="sm:hidden">
                {count} {count === 1 ? "link" : "links"}
              </span>
              <span className="hidden sm:inline">
                Links for {linkLabel(links)} · {count} {count === 1 ? "panel" : "panels"}
              </span>
            </span>
            <span className="hidden shrink-0 sm:inline" aria-hidden>
              ·
            </span>
            <button
              type="button"
              onClick={(e) => {
                // The bar goes away with the links; keep keyboard focus at the start of the workspace, not on the page.
                const refocus = document.activeElement === e.currentTarget;
                clearLinks("pointer");
                if (refocus) document.getElementById("canvas-start")?.focus({ preventScroll: true });
              }}
              aria-label="Clear all links"
              title="Clear all links (Esc)"
              // On a phone the caption is narrow: an x, so the change feed beside it keeps its words.
              className="grid h-5 min-w-5 shrink-0 place-items-center rounded-full font-medium transition-colors hover:bg-link/15 focus-visible:bg-link/15 sm:px-1.5"
            >
              <X className="size-3 sm:hidden" aria-hidden />
              <span className="hidden sm:inline">Clear all links</span>
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
