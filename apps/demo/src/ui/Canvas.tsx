/**
 * The single-screen canvas: the library's AdaptiveCanvas (@attune/react)
 * with the demo's cards (PanelFrame), its caption, the anchor note, and the
 * link lines. There is no routing: changing "pages" is just the plan changing.
 *
 * The library canvas puts every card in its cell when the plan is packed for
 * the canvas's column count (plan.grid), so the panel the user just worked
 * in (the anchor) stays exactly where it was while the rest moves around it,
 * in the staged order from @attune/core's choreography; without a grid the
 * cards fall back to the dense flow. It also keeps keyboard focus through a
 * re-plan, holds the anchor still on screen, keeps a docked card's slot
 * while the pointer stays, follows a panel a pin or "Make bigger" sent to
 * the front (EngineState.toFront, docs/focus-aids.md) and rings it when it
 * lands, and tells the engine where the user's hands are (setCanvasHold)
 * and how many columns it shows (setColumns).
 *
 * This file adds what is the demo's own: the link cues (tints, tags, lines,
 * and the links bar in the caption) follow the store's link set, which
 * outlives the anchor; quiet panels (focus aid 1, docs/focus-aids.md) show
 * faded while the plan marks them quiet and nothing since exempts them
 * (shownQuiet); the note on the anchor card; and what screen readers hear.
 */
import { LayoutGrid } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { LAYOUT_MODE_DEFS, type PanelId } from "../../shared/catalog.ts";
import type { LayoutPlan } from "../../shared/types.ts";
import { fadeQuietOn } from "../engine/focusAids.ts";
import { shownQuiet, STAGE_ENTER } from "@attune/core";
import { AdaptiveCanvas, useCanvasColumns } from "@attune/react";
import { useEngine } from "../engine/store.ts";
import { AnchorNote } from "./AnchorNote.tsx";
import { BackTo } from "./BackTo.tsx";
import { ChangeFeed } from "./ChangeFeed.tsx";
import { linkAnnouncement, noteText } from "./choreography.ts";
import { appBarSelector, LINK_ATTR, panelSelector } from "./domHooks.ts";
import { LinkLines } from "./LinkLines.tsx";
import { LinksBar } from "./LinksBar.tsx";
import { announceNoteUndo, useLinks, useLiveAnchor, useRoundCues, useWorkAnchorLive } from "./linking.tsx";
import { CardNoteContext, PanelFrame } from "./PanelFrame.tsx";
import { PANEL_COMPONENTS } from "./panels/index.ts";

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

/** The bottom of the sticky app bar, in window px: the page follows a panel to the front below it. */
function appBarBottom(): number {
  return document.querySelector<HTMLElement>(appBarSelector())?.getBoundingClientRect().bottom ?? 0;
}

/**
 * Focus the clicked row in the anchor card (or the control that stands for
 * it: a task row's button), else the card's first list row, else its first
 * header button. Scrolling is left alone, so nothing on screen moves.
 */
function focusAnchorRow(root: HTMLElement | null, id: PanelId): void {
  const card = root?.querySelector<HTMLElement>(panelSelector(id));
  if (!card) return;
  const row = card.querySelector<HTMLElement>(`[${LINK_ATTR}="anchor"]`);
  const target =
    (row && (row.matches("button, [tabindex]") ? row : row.querySelector<HTMLElement>("[data-roving], button"))) ??
    card.querySelector<HTMLElement>("[data-roving]") ??
    card.querySelector<HTMLElement>("header button");
  target?.focus({ preventScroll: true });
}

const renderPanel = (p: { id: PanelId; size: LayoutPlan["placements"][number]["size"] }): ReactNode => {
  const Panel = PANEL_COMPONENTS[p.id];
  return <Panel size={p.size} />;
};

export function Canvas() {
  const plan = useEngine((s) => s.plan);
  const adaptive = useEngine((s) => s.settings.adaptive);
  const frozen = useEngine((s) => s.settings.frozen);
  const setCanvasHold = useEngine((s) => s.setCanvasHold);
  const setColumns = useEngine((s) => s.setColumns);
  const setPointer = useEngine((s) => s.setPointer);
  const setFocused = useEngine((s) => s.setFocused);
  const track = useEngine((s) => s.track);
  const undo = useEngine((s) => s.undo);
  const storeAnchor = useEngine((s) => s.anchor);
  const persistLinks = useEngine((s) => s.settings.linkLines === "stay");
  const fadeOn = useEngine((s) => fadeQuietOn(s.settings));
  const focusedPanel = useEngine((s) => s.focusedPanel);
  const upNextPanel = useEngine((s) => s.upNext?.candidate.panel ?? null);
  const toFront = useEngine((s) => s.toFront);
  const reduceMotion = useReducedMotion() ?? false;
  const sectionRef = useRef<HTMLElement>(null);

  const columns = useCanvasColumns(setColumns);
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

  const quiet = (p: LayoutPlan["placements"][number]): boolean => fadeOn && shownQuiet(p, quietCtx);

  const renderNote = useCallback(
    (id: PanelId): ReactNode => (
      <AnimatePresence>
        {shownNote && shownNote.panel === id ? (
          <AnchorNote
            key={shownNote.round}
            panel={shownNote.panel}
            text={shownNote.text}
            delayMs={reduceMotion || !cues.staged ? 0 : STAGE_ENTER.delayMs}
            reduceMotion={reduceMotion}
            onClose={closeNote}
            onUndo={() => {
              // The Undo button goes away with the note; keep keyboard focus on the card the user was in.
              focusAnchorRow(sectionRef.current, shownNote.panel);
              setNote(null);
              announceNoteUndo();
              undo(shownNote.before ?? undefined);
            }}
          />
        ) : null}
      </AnimatePresence>
    ),
    [shownNote, reduceMotion, cues.staged, closeNote, undo],
  );

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

      <CardNoteContext.Provider value={renderNote}>
        <AdaptiveCanvas
          id="canvas"
          className="fl-grid relative"
          ghostClassName="fl-cell rounded-[14px] border border-dashed border-line"
          rowHeight="var(--row)"
          gap="var(--gap, 12px)"
          plan={plan}
          columns={columns}
          cues={cues}
          focused={focusedPanel}
          card={PanelFrame}
          renderCard={renderPanel}
          quiet={quiet}
          anchorPanel={live?.panel ?? null}
          holdStill={workAnchorLive && storeAnchor ? storeAnchor.panel : null}
          toFront={toFront}
          stickyTop={appBarBottom}
          scrollTarget={sectionRef}
          onPointer={(panel, down) => setPointer({ panel, down })}
          onCanvasHold={setCanvasHold}
          onFocusPanel={(panel, via) => {
            setFocused(panel);
            track({ type: "panel_focus", panel, detail: { via } });
          }}
          onDwell={(panel, durationMs) => track({ type: "panel_dwell", panel, detail: { durationMs } })}
          overlay={(gridRef) => (
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
          )}
          empty={
            <p className="rounded-2xl border border-dashed border-line-strong px-4 py-10 text-center text-sm text-ink-3">
              Everything is in the dock. Pick a panel below to bring it back.
            </p>
          }
        />
      </CardNoteContext.Provider>
    </section>
  );
}
