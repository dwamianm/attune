/**
 * The single-screen canvas. Renders the plan's placements inside a CSS grid
 * and lets motion animate every move, resize, entry, and exit. There is no
 * routing: changing "pages" is just the plan changing.
 *
 * When the plan is packed for the canvas's column count (plan.grid), every
 * card gets its explicit cell, so the panel the user just worked in (the
 * anchor) stays exactly where it was while the rest moves around it, in the
 * staged order from ./choreography.ts. Without a grid the canvas falls back
 * to the dense CSS flow. The link cues (tints, tags, lines, and the links
 * bar in the caption) follow the store's link set, which outlives the anchor.
 *
 * Quiet panels (focus aid 1, docs/focus-aids.md) show faded while the plan
 * marks them quiet and nothing since exempts them (shownQuiet).
 *
 * A pin or "Make bigger" that sends a panel to the front (EngineState.toFront,
 * docs/focus-aids.md) is followed once: the page scrolls up to the canvas
 * top when the front is out of view, and the card gets a short ring when it
 * lands. That round skips the anchor's scroll safety net: the move is the point.
 *
 * It also tells the engine where the user's hands are (setCanvasHold) and
 * how many columns it shows (setColumns), and it puts keyboard focus back if
 * a re-plan moved the focused element.
 */
import { LayoutGrid } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { LAYOUT_MODE_DEFS, type PanelId } from "../../shared/catalog.ts";
import type { GridCell, GridColumns, LayoutPlan, PanelSize } from "../../shared/types.ts";
import { fadeQuietOn } from "../engine/focusAids.ts";
import { cellsOverlap, cueFor, FRONT_RING_MS, GRID_BREAKPOINTS, shownQuiet, STAGE_ENTER } from "@attune/core";
import { planSignature } from "../engine/policy.ts";
import { MANUAL_EDIT_HOLD_MS, useEngine } from "../engine/store.ts";
import { AnchorNote } from "./AnchorNote.tsx";
import { BackTo } from "./BackTo.tsx";
import { ChangeFeed } from "./ChangeFeed.tsx";
import { linkAnnouncement, noteText } from "./choreography.ts";
import { appBarSelector, CANVAS_ATTR, LINK_ATTR, PANEL_ATTR, panelSelector } from "./domHooks.ts";
import { isTextField } from "@attune/react";
import { LinkLines } from "./LinkLines.tsx";
import { LinksBar } from "./LinksBar.tsx";
import { announceNoteUndo, useLinks, useLiveAnchor, useRoundCues, useWorkAnchorLive } from "./linking.tsx";
import { CanvasEditContext, PanelFrame, type ExitContext } from "./PanelFrame.tsx";
import { PANEL_COMPONENTS } from "./panels/index.ts";

interface Ghost {
  id: PanelId;
  index: number;
  size: PanelSize;
  /** The card's cell when the plan was packed; the ghost holds exactly that spot. */
  cell: GridCell | null;
  /** The plan signature right after the card left, so any later change clears the ghost. */
  signature: string | null;
}

/** Focus and caret inside the grid, read before a commit moves anything. */
interface SavedFocus {
  el: HTMLElement;
  start: number | null;
  end: number | null;
}

/** The anchor note for one round, shown on the anchor card. */
interface NoteState {
  round: number;
  /** The anchor it belongs to (AnchorRef.at); it goes when that anchor does. */
  at: number;
  panel: PanelId;
  text: string;
  /** The plan from before the round, for Undo. */
  before: LayoutPlan | null;
}

const COLUMN_QUERIES = [`(min-width: ${GRID_BREAKPOINTS.twoColumns}px)`, `(min-width: ${GRID_BREAKPOINTS.fourColumns}px)`] as const;

/** Space left between the sticky app bar and the canvas caption after the page follows a panel to the front, so the caption does not touch the bar. */
const FRONT_SCROLL_GAP_PX = 8;

function readColumns(): GridColumns {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return 4;
  if (window.matchMedia(COLUMN_QUERIES[1]).matches) return 4;
  if (window.matchMedia(COLUMN_QUERIES[0]).matches) return 2;
  return 1;
}

/**
 * The canvas column count, from the same breakpoints as the .fl-grid media
 * queries. Reported to the engine in a layout effect, so the first paint is
 * already packed for the right count.
 */
function useColumns(): GridColumns {
  const setColumns = useEngine((s) => s.setColumns);
  const [columns, set] = useState<GridColumns>(readColumns);
  useLayoutEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const lists = COLUMN_QUERIES.map((q) => window.matchMedia(q));
    const update = () => set(readColumns());
    for (const l of lists) l.addEventListener("change", update);
    update();
    return () => {
      for (const l of lists) l.removeEventListener("change", update);
    };
  }, []);
  useLayoutEffect(() => {
    setColumns(columns);
  }, [columns, setColumns]);
  return columns;
}

/**
 * Row tracks the grid keeps while the anchor is live: never fewer than the
 * most it has shown since. A shorter page would clamp the window scroll and
 * move the anchor up; the rows come back when the anchor is released.
 */
function useRowFloor(rows: number, hold: boolean, columns: GridColumns): number {
  const [floor, setFloor] = useState({ rows, columns });
  const next = hold && floor.columns === columns ? Math.max(floor.rows, rows) : rows;
  if (next !== floor.rows || floor.columns !== columns) setFloor({ rows: next, columns });
  return next;
}

/** Where a card's top edge is in the window, from layout offsets (a card mid-animation is transformed). */
function cardTop(grid: HTMLElement | null, id: PanelId): number | null {
  const card = grid?.querySelector<HTMLElement>(`:scope > [${PANEL_ATTR}="${id}"]`);
  if (!grid || !card) return null;
  return grid.getBoundingClientRect().top + grid.clientTop + card.offsetTop;
}

/**
 * Focus the clicked row in the anchor card (or the control that stands for
 * it: a task row's button), else the card's first list row, else its first
 * header button. Scrolling is left alone, so nothing on screen moves.
 */
function focusAnchorRow(grid: HTMLElement | null, id: PanelId): void {
  const card = grid?.querySelector<HTMLElement>(panelSelector(id));
  if (!card) return;
  const row = card.querySelector<HTMLElement>(`[${LINK_ATTR}="anchor"]`);
  const target =
    (row && (row.matches("button, [tabindex]") ? row : row.querySelector<HTMLElement>("[data-roving], button"))) ??
    card.querySelector<HTMLElement>("[data-roving]") ??
    card.querySelector<HTMLElement>("header button");
  target?.focus({ preventScroll: true });
}

function byCell(cells: Partial<Record<PanelId, GridCell>>) {
  return (a: PanelId, b: PanelId): number => {
    const ca = cells[a];
    const cb = cells[b];
    if (!ca || !cb) return ca ? -1 : cb ? 1 : 0;
    return ca.row - cb.row || ca.col - cb.col;
  };
}

function cellStyle(c: GridCell): { gridColumn: string; gridRow: string } {
  return { gridColumn: `${c.col + 1} / span ${c.w}`, gridRow: `${c.row + 1} / span ${c.h}` };
}

export function Canvas() {
  const plan = useEngine((s) => s.plan);
  const adaptive = useEngine((s) => s.settings.adaptive);
  const frozen = useEngine((s) => s.settings.frozen);
  const setCanvasHold = useEngine((s) => s.setCanvasHold);
  const undo = useEngine((s) => s.undo);
  const storeAnchor = useEngine((s) => s.anchor);
  const persistLinks = useEngine((s) => s.settings.linkLines === "stay");
  const fadeOn = useEngine((s) => fadeQuietOn(s.settings));
  const focusedPanel = useEngine((s) => s.focusedPanel);
  const upNextPanel = useEngine((s) => s.upNext?.candidate.panel ?? null);
  const toFront = useEngine((s) => s.toFront);
  const reduceMotion = useReducedMotion() ?? false;
  const sectionRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const pointerInside = useRef(false);
  const lastFocused = useRef<Element | null>(null);
  const [ghost, setGhost] = useState<Ghost | null>(null);

  const columns = useColumns();
  const grid = plan.grid && plan.grid.columns === columns ? plan.grid : null;
  const cues = useRoundCues();
  const live = useLiveAnchor();
  const links = useLinks();
  const workAnchorLive = useWorkAnchorLive();

  // Screen readers hear what changed, not just that something moved, and,
  // once per round, why: the note's sentence and the linked panels. It goes
  // with that round's decisions only, so a later quiet update does not read
  // it again.
  const [linkSay, setLinkSay] = useState<{ round: number; decisions: LayoutPlan["decisions"]; text: string }>(() => ({ round: cues.round, decisions: plan.decisions, text: "" }));
  let roundSay = linkSay;
  if (linkSay.round !== cues.round) {
    roundSay = { round: cues.round, decisions: plan.decisions, text: live && cues.staged ? linkAnnouncement(plan) : "" };
    setLinkSay(roundSay);
  }
  const linkText = roundSay.decisions === plan.decisions ? roundSay.text : "";
  const announcement = useMemo(
    () =>
      [
        ...plan.decisions.filter((d) => d.kind !== "hold").map((d) => d.text.replace(/\.$/, "")),
        ...(linkText ? [linkText] : []),
      ].join(". "),
    [plan.decisions, linkText],
  );

  // --- Keep focus through a re-plan (read in render, before the commit). ---
  const saved = useRef<SavedFocus | null>(null);
  if (typeof document !== "undefined") {
    const a = document.activeElement;
    if (a instanceof HTMLElement && gridRef.current?.contains(a)) {
      const input = a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement ? a : null;
      saved.current = { el: a, start: input?.selectionStart ?? null, end: input?.selectionEnd ?? null };
    } else {
      saved.current = null;
    }
  }
  useLayoutEffect(() => {
    const s = saved.current;
    if (!s || document.activeElement === s.el) return;
    // Focus went somewhere on purpose (a dialog, the command bar): leave it.
    if (document.activeElement && document.activeElement !== document.body) return;
    if (!s.el.isConnected || !gridRef.current?.contains(s.el)) return;
    s.el.focus({ preventScroll: true });
    if ((s.el instanceof HTMLInputElement || s.el instanceof HTMLTextAreaElement) && s.start !== null && s.end !== null) {
      try {
        s.el.setSelectionRange(s.start, s.end);
      } catch {
        // Some input types do not support selection.
      }
    }
  }, [plan]);

  // --- Keep the anchor still on screen (a safety net). ---------------------
  // The packer keeps the anchor's cell and nothing above the canvas changes
  // height while it is live, so this is normally a no-op. If something did
  // push the anchor, scroll by the same amount in the same frame. Read in
  // render, while the DOM still shows the old layout.
  const anchorTopBefore = useRef<{ id: PanelId; top: number } | null>(null);
  if (typeof document !== "undefined") {
    const id = workAnchorLive && storeAnchor ? storeAnchor.panel : null;
    const top = id ? cardTop(gridRef.current, id) : null;
    anchorTopBefore.current = id && top !== null ? { id, top } : null;
  }
  useLayoutEffect(() => {
    const before = anchorTopBefore.current;
    if (!before) return;
    // A pin or "Make bigger" moved cards to the front on purpose; the page follows that panel instead (below).
    const moved = useEngine.getState().toFront;
    if (moved && moved.round === (plan.round ?? 0)) return;
    const after = cardTop(gridRef.current, before.id);
    if (after === null) return;
    const diff = after - before.top;
    if (Math.abs(diff) >= 1) window.scrollBy({ top: diff, behavior: "instant" });
  }, [plan]);

  // --- Follow a panel a pin or "Make bigger" sent to the front. -------------
  // Once per move, in the round that made it: when the front of the canvas
  // is out of view (above the app bar, or below the window), scroll the page
  // to the canvas top (a jump with reduced motion), and ring the card from
  // when it lands, for FRONT_RING_MS. Timers live in a ref, so a later render
  // in the same round does not cut the ring short.
  const frontRound = toFront !== null && toFront.round === (plan.round ?? 0);
  const [ring, setRing] = useState<PanelId | null>(null);
  const followed = useRef(0);
  const ringTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(() => () => ringTimers.current.forEach(clearTimeout), []);
  useEffect(() => {
    if (!toFront || toFront.at === followed.current || toFront.round !== (plan.round ?? 0)) return;
    followed.current = toFront.at;
    const grid = gridRef.current;
    const section = sectionRef.current;
    if (grid && section) {
      const bar = Math.max(0, document.querySelector<HTMLElement>(appBarSelector())?.getBoundingClientRect().bottom ?? 0);
      const top = grid.getBoundingClientRect().top;
      if (top < bar || top > window.innerHeight) {
        const to = Math.max(0, window.scrollY + section.getBoundingClientRect().top - bar - FRONT_SCROLL_GAP_PX);
        window.scrollTo({ top: to, behavior: reduceMotion ? "instant" : "smooth" });
      }
    }
    const cue = cueFor(cues, toFront.panel);
    const landsMs = reduceMotion || !cue ? 0 : cue.stage.delayMs + cue.stage.durationMs;
    for (const t of ringTimers.current) clearTimeout(t);
    ringTimers.current = [setTimeout(() => setRing(toFront.panel), landsMs), setTimeout(() => setRing(null), landsMs + FRONT_RING_MS)];
  }, [toFront, plan.round, cues, reduceMotion]);

  // --- The slot of a card the user just docked stays until the pointer leaves. ---
  const edit = useMemo(
    () => ({
      noteDismiss(id: PanelId) {
        if (!pointerInside.current) return;
        const s = useEngine.getState();
        const placements = s.plan.placements;
        const index = placements.findIndex((p) => p.id === id);
        const cell = s.plan.grid && s.plan.grid.columns === s.columns ? (s.plan.grid.cells[id] ?? null) : null;
        if (index >= 0) setGhost({ id, index, size: placements[index].size, cell, signature: null });
      },
    }),
    [],
  );
  const signature = planSignature(plan);
  useEffect(() => {
    if (!ghost) return;
    const gone = !plan.placements.some((p) => p.id === ghost.id);
    if (gone && ghost.signature === null) setGhost({ ...ghost, signature });
    else if (ghost.signature !== null && ghost.signature !== signature) setGhost(null);
  }, [ghost, plan.placements, signature]);
  useEffect(() => {
    if (!ghost) return;
    const t = setTimeout(() => setGhost(null), MANUAL_EDIT_HOLD_MS);
    return () => clearTimeout(t);
  }, [ghost]);

  // Leaving the page with a hold on must not leave the engine waiting.
  useEffect(
    () => () => {
      setCanvasHold("pointer", false);
      setCanvasHold("keyboard", false);
    },
    [setCanvasHold],
  );

  // --- The note on the anchor card, once per round that added linked panels. -
  const [note, setNote] = useState<NoteState | null>(null);
  const noteRound = cues.round;
  useEffect(() => {
    const s = useEngine.getState();
    const p = s.plan;
    const anchor = s.anchor && p.anchor && s.anchor.at === p.anchor.at ? p.anchor : null;
    const added = new Set(p.changeSummary?.added ?? []);
    const linked = p.placements.filter((x) => x.relation && added.has(x.id) && x.id !== anchor?.panel);
    if (!anchor || linked.length === 0 || !p.placements.some((x) => x.id === anchor.panel)) return;
    setNote({
      round: noteRound,
      at: anchor.at,
      panel: anchor.panel,
      text: noteText(
        linked.map((x) => x.id),
        anchor.client ?? anchor.label,
      ),
      before: s.previousPlan,
    });
  }, [noteRound]);
  const closeNote = useCallback(() => setNote(null), []);
  const shownNote = note && live && note.at === live.at && plan.placements.some((p) => p.id === note.panel) ? note : null;

  const mode = LAYOUT_MODE_DEFS[plan.mode];
  const idle = !adaptive
    ? "Adaptive is off. Panels stay where they are."
    : frozen
      ? "Frozen. Jev keeps judging, panels stay put."
      : `${plan.placements.length} on the canvas, ${plan.docked.length} in the dock`;

  // The link cues outlive the anchor: they follow the store's link set, in plan order.
  const linkTargets = links ? plan.placements.filter((p) => links.relations[p.id] && p.id !== links.source.panel).map((p) => p.id) : [];
  const inLinks = useMemo(() => new Set<PanelId>(links ? [links.source.panel, ...(Object.keys(links.relations) as PanelId[])] : []), [links]);
  const quietCtx = { focused: focusedPanel, upNext: upNextPanel, linked: inLinks };

  // DOM order follows the cells (row, then column), so Tab order matches the screen.
  const ordered = grid ? [...plan.placements].sort((a, b) => byCell(grid.cells)(a.id, b.id)) : plan.placements;
  const cards = ordered.map((p) => {
    const Panel = PANEL_COMPONENTS[p.id];
    const cell = grid?.cells[p.id];
    const isNoteCard = shownNote?.panel === p.id;
    return (
      <PanelFrame
        key={p.id}
        placement={p}
        reduceMotion={reduceMotion}
        round={cues.round}
        quiet={fadeOn && shownQuiet(p, quietCtx)}
        ring={ring === p.id}
        {...(cell ? { cell } : {})}
        {...(cues.staged ? { cue: cueFor(cues, p.id) } : {})}
        note={
          <AnimatePresence>
            {isNoteCard && shownNote ? (
              <AnchorNote
                key={shownNote.round}
                panel={shownNote.panel}
                text={shownNote.text}
                delayMs={reduceMotion || !cues.staged ? 0 : STAGE_ENTER.delayMs}
                reduceMotion={reduceMotion}
                onClose={closeNote}
                onUndo={() => {
                  // The Undo button goes away with the note; keep keyboard focus on the card the user was in.
                  focusAnchorRow(gridRef.current, shownNote.panel);
                  setNote(null);
                  announceNoteUndo();
                  undo(shownNote.before ?? undefined);
                }}
              />
            ) : null}
          </AnimatePresence>
        }
      >
        <Panel size={p.size} />
      </PanelFrame>
    );
  });

  const showGhost = ghost && !plan.placements.some((p) => p.id === ghost.id) ? ghost : null;
  if (showGhost) {
    const ghostClass = "fl-cell rounded-[14px] border border-dashed border-line";
    if (grid) {
      // In the packed grid the ghost holds the card's own cell, unless a card was placed there.
      const cell = showGhost.cell;
      const taken = !cell || Object.values(grid.cells).some((c) => c && cellsOverlap(c, cell));
      if (cell && !taken) cards.push(<div key={`ghost-${showGhost.id}`} aria-hidden className={ghostClass} data-size={showGhost.size} style={cellStyle(cell)} />);
    } else {
      cards.splice(
        Math.min(showGhost.index, cards.length),
        0,
        <div key={`ghost-${showGhost.id}`} aria-hidden className={ghostClass} data-size={showGhost.size} />,
      );
    }
  }

  const floorRows = useRowFloor(grid?.rows ?? 0, workAnchorLive, columns);
  // Stable, so a re-render does not make a leaving card re-aim mid-flight.
  const exitContext = useMemo<ExitContext>(() => ({ staged: cues.staged, reduceMotion }), [cues.staged, reduceMotion]);

  return (
    <section ref={sectionRef} aria-label="Workspace" className="mt-1">
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>

      <div className="relative mb-2 flex min-h-6 items-center gap-2 text-2xs text-ink-3">
        <LayoutGrid className="size-3.5 shrink-0" aria-hidden />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={plan.mode}
            initial={reduceMotion ? false : { opacity: 0, y: 3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -3, transition: { duration: 0.12 } }}
            className="shrink-0 font-medium text-ink-2"
          >
            {/* "layout" only where the caption has room: on a phone the change feed, links bar, and Back to chip need it. */}
            {mode.label}
            <span className="sr-only sm:not-sr-only"> layout</span>
          </motion.span>
        </AnimatePresence>
        <span aria-hidden>·</span>
        <ChangeFeed idle={idle} />
        <LinksBar />
        <BackTo />
      </div>

      <CanvasEditContext.Provider value={edit}>
        <LayoutGroup>
          <div
            id="canvas"
            ref={gridRef}
            {...{ [CANVAS_ATTR]: "" }}
            className="fl-grid relative"
            style={{
              ...(grid && floorRows > 0 ? { gridTemplateRows: `repeat(${floorRows}, var(--row))` } : {}),
              // The browser's own scroll anchoring could pick a card that moves and
              // shift the page to keep that one still; the anchor is ours to keep,
              // and so is following a panel sent to the front (it jumped the page otherwise).
              ...(workAnchorLive || frontRound ? { overflowAnchor: "none" } : {}),
            }}
            onPointerEnter={(e) => {
              if (e.pointerType === "touch") return;
              pointerInside.current = true;
              setCanvasHold("pointer", true);
            }}
            onPointerLeave={() => {
              pointerInside.current = false;
              setGhost(null);
              setCanvasHold("pointer", false);
            }}
            onFocus={(e) => {
              const el = e.target as HTMLElement;
              // Our own focus restore puts focus back on the same element; that is not navigation.
              if (el === lastFocused.current) return;
              lastFocused.current = el;
              setCanvasHold("keyboard", !isTextField(el) && el.matches(":focus-visible"));
            }}
            onBlur={() => {
              // Wait a tick: a re-plan may have moved the element and our restore refocuses it.
              setTimeout(() => {
                if (gridRef.current?.contains(document.activeElement)) return;
                lastFocused.current = null;
                setCanvasHold("keyboard", false);
              }, 0);
            }}
          >
            <AnimatePresence mode="popLayout" initial={false} custom={exitContext}>
              {cards}
            </AnimatePresence>
            <LinkLines
              canvasRef={gridRef}
              source={links?.source ?? null}
              targets={linkTargets}
              round={cues.round}
              settleMs={cues.settleMs}
              reduceMotion={reduceMotion}
              persist={persistLinks}
              strong={links?.next?.panel ?? null}
            />
          </div>
        </LayoutGroup>
      </CanvasEditContext.Provider>

      {plan.placements.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-line-strong px-4 py-10 text-center text-sm text-ink-3">
          Everything is in the dock. Pick a panel below to bring it back.
        </p>
      ) : null}
    </section>
  );
}
