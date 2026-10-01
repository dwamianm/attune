/**
 * Focus aid 4, "Prepare for meetings" (docs/focus-aids.md, "Aid 4"): the
 * prep card in the row under the command bar (AssistRow.tsx). It is the most
 * time-sensitive card there, so it comes first and is never a pill or in
 * "+N"; in a crowded row it shows the count of things to handle instead of
 * the whole line (the line stays in its tip and is read to screen readers).
 * The row keeps one line's height, so it coming and going never moves a
 * panel.
 *
 * Before a meeting or call with a client starts (within the lead time, and
 * up to 5 minutes after), it says "Harbor rebrand review in 12 min" with a
 * live minute countdown, the one thing to handle first when Jev says there
 * is one ("1 thing to handle first: INV-1042 is 14 days overdue"), Prepare
 * (p), and Not now (hides it for that meeting). Prepare saves the current
 * work as a Back to chip and arranges the prep view; it never performs an
 * action and never writes a note. After it, the chip becomes a card that
 * says the meeting is ready, with the same urgent line and a close button,
 * while "Start meeting notes" waits in the suggestion row.
 *
 * "p" prepares when the key is not taken by a text field, the command bar, a
 * popover, or the inspector (flowKeyTaken, the same rules as "n" and "b").
 * With the aid off there is no chip and "p" does nothing.
 */
import clsx from "clsx";
import { CalendarCheck, CalendarClock, TriangleAlert, X } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { meetingPrepOn } from "../engine/focusAids.ts";
import { startsInText } from "../engine/meetingPrep.ts";
import { useEngine } from "../engine/store.ts";
import type { AssistEntry } from "./AssistRow.tsx";
import { useNow, useWindowKeydown } from "./hooks.ts";
import { flowKeyTaken, revealPanel } from "./UpNext.tsx";

/** The countdown re-renders this often: the minute it shows is never more than a quarter minute late. */
const PREP_TICK_MS = 15_000;

/**
 * The prep card for the row, or null, and the "p" key. Call it once (the
 * row does): the key listener lives here, not in the card, so "p" works
 * however the row shows the card.
 */
export function useMeetingPrepEntry(): AssistEntry | null {
  const { prep, prepareMeeting, snoozePrep, dismissPrep } = useEngine(
    useShallow((s) => ({
      // The store already clears it with the aid off; checked here too, so the chip and "p" go at once.
      prep: meetingPrepOn(s.settings) ? s.prep : null,
      prepareMeeting: s.prepareMeeting,
      snoozePrep: s.snoozePrep,
      dismissPrep: s.dismissPrep,
    })),
  );
  // The tick re-renders the countdown; the time is read at render, so a chip that just appeared is not a tick behind.
  useNow(PREP_TICK_MS);
  const now = Date.now();
  const reduceMotion = useReducedMotion() ?? false;

  /** Prepare, then bring Calendar (the meeting) into view when it is out of sight, as on a phone's one column. */
  const prepare = (via: "pointer" | "keyboard") => {
    prepareMeeting(via);
    revealPanel("calendar", reduceMotion);
  };

  useWindowKeydown((e) => {
    if (e.key !== "p" || flowKeyTaken(e)) return;
    // Read the store now, not the last render.
    const state = useEngine.getState();
    const cur = meetingPrepOn(state.settings) ? state.prep : null;
    if (!cur || cur.stage !== "offer") return;
    e.preventDefault();
    prepare("keyboard");
  });

  if (!prep) return null;
  const when = startsInText(prep.start, now);
  const ready = prep.stage === "ready";
  const title = `${ready ? "Ready: " : ""}${prep.title} ${when}`;
  const tip = `${prep.kind === "call" ? "Call" : "Meeting"} with ${prep.client}: ${prep.title} ${when}.${prep.urgent ? ` ${prep.urgent.text}.` : ""}`;

  /** The card; `narrow` is its shorter form for a crowded row: the count of things to handle, and an x for Not now. */
  const card = (narrow: boolean) => (
    <div
      role="group"
      aria-label={ready ? "Meeting prepared" : "Prepare for a meeting"}
      title={tip}
      data-meeting-prep={prep.stage}
      className="flex h-8 min-w-0 items-center gap-1 rounded-full border border-link/35 bg-link-soft pr-0.5 pl-2.5 text-sm text-ink"
    >
      {ready ? <CalendarCheck className="size-3.5 shrink-0 text-link-text" aria-hidden /> : <CalendarClock className="size-3.5 shrink-0 text-link-text" aria-hidden />}
      {/* On a phone only the countdown, so the buttons keep their room; the full line is in the tip and read to screen readers. */}
      <span className="shrink-0 font-medium tabular-nums sm:hidden">{when}</span>
      <span className="sr-only sm:hidden">{title}</span>
      {/* In full the title and countdown keep their words and the line of things to handle gives way first, when the card is cut short. */}
      <span className={clsx("hidden font-medium sm:inline", narrow ? "min-w-0 truncate" : "shrink-0")}>
        {ready ? <span className="text-2xs font-semibold text-link-text">Ready: </span> : null}
        {prep.title} <span className="tabular-nums">{when}</span>
      </span>
      {prep.urgent ? (
        <span
          className={clsx(
            "inline-flex h-5 min-w-0 shrink-0 items-center gap-1 rounded-full bg-warn-soft px-1.5 text-2xs font-medium text-warn-ink ring-1 ring-warn/30 ring-inset",
            !narrow && "lg:shrink",
          )}
          title={prep.urgent.text}
        >
          <TriangleAlert className="size-3 shrink-0" aria-hidden />
          {/* The count on a phone and in a crowded row; the whole line where it fits. */}
          {narrow ? (
            <>
              <span>{prep.urgent.count}</span>
              <span className="sr-only">{prep.urgent.text}</span>
            </>
          ) : (
            <>
              <span className="lg:hidden">{prep.urgent.count}</span>
              <span className="hidden min-w-0 truncate lg:inline">{prep.urgent.text}</span>
              <span className="sr-only lg:hidden">{prep.urgent.text}</span>
            </>
          )}
        </span>
      ) : null}
      {ready ? (
        <button
          type="button"
          onClick={dismissPrep}
          aria-label={`Close: ${prep.title} is prepared`}
          title="Close this. The panels stay as they are."
          className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : (
        <>
          <button
            type="button"
            // detail 0: Enter or Space, not a pointer click.
            onClick={(e) => prepare(e.detail === 0 ? "keyboard" : "pointer")}
            aria-label={`Prepare for ${prep.title} (p)`}
            title="Bring up what matters for this meeting (p). Your current work stays one click away in Back to."
            className={clsx(
              "ml-0.5 inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-link px-2.5 text-2xs font-semibold text-link-fg transition-colors hover:opacity-90",
            )}
          >
            Prepare
            <kbd className="hidden rounded border border-white/35 px-1 font-sans text-2xs sm:inline" aria-hidden>
              p
            </kbd>
          </button>
          <button
            type="button"
            onClick={snoozePrep}
            aria-label={`Not now: hide the prep chip for ${prep.title}`}
            title="Hide this for this meeting"
            className={clsx(
              "inline-flex h-6 shrink-0 items-center rounded-full px-1.5 text-2xs font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink",
              !narrow && "sm:px-2",
            )}
          >
            <X className={clsx("size-3.5", !narrow && "sm:hidden")} aria-hidden />
            {narrow ? null : <span className="hidden sm:inline">Not now</span>}
          </button>
        </>
      )}
    </div>
  );

  return {
    id: "prep",
    motionKey: `prep-${prep.eventId}-${prep.stage}`,
    kind: "prep",
    group: ready ? "Meeting prepared" : "Prepare for a meeting",
    icon: ready ? CalendarCheck : CalendarClock,
    tone: "link",
    text: title,
    ...(prep.urgent ? { detail: prep.urgent.text } : {}),
    tip,
    short: when,
    ...(ready
      ? { dismiss: { label: "Close", name: `Close: ${prep.title} is prepared`, title: "Close this. The panels stay as they are.", run: () => dismissPrep() } }
      : {
          hotkey: "p" as const,
          primary: {
            label: "Prepare",
            name: `Prepare for ${prep.title} ${when}${prep.urgent ? `. ${prep.urgent.text}` : ""} (p)`,
            title: "Bring up what matters for this meeting (p). Your current work stays one click away in Back to.",
            run: prepare,
          },
          dismiss: { label: "Not now", name: `Not now: hide the prep chip for ${prep.title}`, title: "Hide this for this meeting", run: () => snoozePrep() },
        }),
    full: card(false),
    narrow: card(true),
  };
}
