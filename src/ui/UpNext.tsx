/**
 * The "Up next" card (docs/predictive-flow.md): one record the user will
 * likely work on next, with a short why, an Open button, and up to two
 * alternative chips. It sits in the row under the command bar
 * (AssistRow.tsx), which keeps one line's height whatever it shows, so the
 * card coming and going never moves a panel. When the row is short of room
 * it becomes a pill ("INV-1042 to resend it", n, and a dismiss) or waits in
 * the row's "+N" list; "n" works either way.
 *
 * The engine chooses the record: Jev's pick when Jev is sure enough, the
 * next record in the current list while the user works through a list, or
 * nothing. While the user repeats one action through a list, it offers only
 * records that action still applies to, and when none is left it says so
 * ("All overdue invoices have a reminder.") until dismissed or the user
 * moves on. Opening it selects the record in its panel the way a click does
 * (the calm relayout, anchor, and links apply); it never performs an action.
 * Right after a click that links panels, it can offer the next step Jev read
 * from the clicked record ("INV-1042 to resend it", "Arrange linked panels
 * by next step"); the action itself waits in the suggestion bar for ".".
 * "n" opens it when the key is not taken by a text field, the command bar, a
 * popover, or the inspector. With the "Up next" focus aid off
 * (docs/focus-aids.md) there is no card and "n" does nothing.
 *
 * Focus aid 2, "Say when a task is done": when the work of the working goal
 * is finished, a Done card takes this slot ("Payments done: every overdue
 * invoice has a reminder." then "Next: 2 unread client messages", Start and
 * Not now). Start (or "n", with the same key rules) opens the next task's
 * panel, sets its filter, and selects its first record, saving the work
 * being left as a Back to chip; it never performs an action. "Not now" hides
 * the card for that goal for 5 minutes. With no pending task elsewhere it
 * only says the done line, with a dismiss button. It shows with that aid on,
 * whether or not Up next is on. After Start, when the task's panel is out of
 * view (a phone's one column), the page scrolls it under the app bar.
 */
import clsx from "clsx";
import { ArrowRight, CircleCheck, CornerDownRight, X } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import type { PanelId } from "../../shared/catalog.ts";
import { taskDoneOn, upNextOn } from "../engine/focusAids.ts";
import { recordShortName } from "../engine/linkFlow.ts";
import { recordCardText, recordChipText } from "../engine/nextUp.ts";
import { useEngine } from "../engine/store.ts";
import type { AssistEntry } from "./AssistRow.tsx";
import { appBarSelector, commandBarSelector, panelSelector } from "./domHooks.ts";
import { hasModifier, isTextField, useNow, useWindowKeydown } from "./hooks.ts";

/**
 * A one-letter shortcut belongs to something else first: a text field, the
 * command bar, an open popover or list, or the inspector. Shared by "n" (Up
 * next) and "b" (Back to), with the same checks as Escape in the links bar.
 */
export function flowKeyTaken(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || hasModifier(e) || e.repeat) return true;
  if (useEngine.getState().inspectorOpen) return true;
  const active = document.activeElement;
  if (isTextField(e.target) || isTextField(active)) return true;
  if (active instanceof Element && active.closest(commandBarSelector())) return true;
  return document.querySelector('[role="dialog"], [aria-expanded="true"]') !== null;
}

/** After Start the page leaves this much room under the app bar above the task's panel, as when it follows a panel sent to the front. */
const START_SCROLL_GAP_PX = 8;
/** The task's panel counts as in view when its top is at least this far above the window's bottom: its header and first row show. */
const START_MIN_VISIBLE_PX = 160;

/**
 * Bring the panel a started task opened into view when its top is hidden
 * (above the sticky app bar, or too low in the window), on the next frame,
 * once the panel is on the canvas. A jump with reduced motion. Prepare
 * (focus aid 4) uses it for Calendar too.
 */
export function revealPanel(panel: PanelId, reduceMotion: boolean): void {
  requestAnimationFrame(() => {
    const card = document.querySelector<HTMLElement>(panelSelector(panel));
    if (!card) return;
    const bar = Math.max(0, document.querySelector<HTMLElement>(appBarSelector())?.getBoundingClientRect().bottom ?? 0);
    const top = card.getBoundingClientRect().top;
    if (top >= bar && top <= window.innerHeight - START_MIN_VISIBLE_PX) return;
    window.scrollTo({ top: Math.max(0, window.scrollY + top - bar - START_SCROLL_GAP_PX), behavior: reduceMotion ? "instant" : "smooth" });
  });
}

/**
 * The card for the Up next slot of the row (AssistRow.tsx), or null: the
 * Done card (focus aid 2) first, then the Up next pick, then its completion
 * line. It also listens for "n". Call it once (the row does): the key
 * listener lives here, not in the card, so "n" works however the row shows
 * the card.
 */
export function useUpNextEntry(): AssistEntry | null {
  const { pick, done, finished, data, openUpNext, dismissUpNext, dismissUpNextDone, startNextTask, snoozeTaskDone, dismissTaskDone } = useEngine(
    useShallow((s) => ({
      // The store already clears both with the aid off; checked here too, so the card and "n" go at once.
      pick: upNextOn(s.settings) ? s.upNext : null,
      done: upNextOn(s.settings) ? s.upNextDone : null,
      // Focus aid 2: the Done card has the slot first.
      finished: taskDoneOn(s.settings) ? s.taskDone : null,
      data: s.data,
      openUpNext: s.openUpNext,
      dismissUpNext: s.dismissUpNext,
      dismissUpNextDone: s.dismissUpNextDone,
      startNextTask: s.startNextTask,
      snoozeTaskDone: s.snoozeTaskDone,
      dismissTaskDone: s.dismissTaskDone,
    })),
  );
  const now = useNow();
  const reduceMotion = useReducedMotion() ?? false;

  /** Start the Done card's next task, then bring its panel into view. */
  const start = (via: "pointer" | "keyboard") => {
    const panel = useEngine.getState().taskDone?.next?.panel;
    startNextTask(via);
    if (panel) revealPanel(panel, reduceMotion);
  };

  useWindowKeydown((e) => {
    if (e.key !== "n" || flowKeyTaken(e)) return;
    // Read the store now, not the last render: right after an action the card has already moved on.
    const state = useEngine.getState();
    // While the Done card shows, n starts its next task (and does nothing when it offers none).
    const taskDone = taskDoneOn(state.settings) ? state.taskDone : null;
    if (taskDone) {
      if (!taskDone.next) return;
      e.preventDefault();
      start("keyboard");
      return;
    }
    const current = upNextOn(state.settings) ? state.upNext : null;
    if (!current) return;
    e.preventDefault();
    openUpNext(current.candidate.id, "keyboard");
  });

  if (finished) {
    const doneLine = finished.detail ? `${finished.title}: ${finished.detail}` : `${finished.title}.`;
    const doneWhy = finished.source === "jev" && finished.probability !== undefined ? `Jev ${Math.round(finished.probability * 100)}%` : null;
    const next = finished.next;
    const nextLine = next ? `Next: ${next.text}${finished.nextWhy ? ` (${finished.nextWhy})` : ""}` : "";
    const full = (
      <div
        role="group"
        aria-label="Task done"
        title={next ? `${doneLine} ${nextLine}` : doneLine}
        className="flex h-8 min-w-0 items-center gap-1 rounded-full border border-good/35 bg-good-soft pr-0.5 pl-2.5 text-sm text-ink"
      >
        <CircleCheck className="size-3.5 shrink-0 text-good-ink" aria-hidden />
        {next ? (
          <>
            {/* On a phone only the title ("Payments done"), so "Next" keeps its words; the rest is in the tip and read to screen readers. */}
            <span className="shrink-0 font-medium sm:hidden">{finished.title}</span>
            {finished.detail ? <span className="sr-only sm:hidden">: {finished.detail}</span> : null}
            <span className="hidden min-w-0 truncate font-medium sm:inline">{doneLine}</span>
          </>
        ) : (
          <span className="min-w-0 truncate font-medium">{doneLine}</span>
        )}
        {doneWhy ? (
          <span className="hidden shrink-0 rounded-full bg-good/15 px-1.5 py-px text-2xs font-medium text-good-ink tabular-nums sm:inline">{doneWhy}</span>
        ) : null}
        {next ? (
          <>
            <span className="ml-1 shrink-0 text-2xs font-semibold text-accent-text">Next:</span>
            <span className="min-w-0 truncate font-medium">{next.text}</span>
            {finished.nextWhy ? (
              <span
                className={clsx(
                  "hidden shrink-0 rounded-full px-1.5 py-px text-2xs font-medium tabular-nums lg:inline",
                  finished.nextSource === "jev" ? "bg-accent/15 text-accent-text" : "bg-surface-3 text-ink-2",
                )}
              >
                {finished.nextWhy}
              </span>
            ) : null}
            <button
              type="button"
              // detail 0: Enter or Space, not a pointer click.
              onClick={(e) => start(e.detail === 0 ? "keyboard" : "pointer")}
              aria-label={`Start the next task: ${next.text} (n)`}
              title="Start it (n). Your current work stays one click away in Back to."
              className="ml-0.5 inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-accent px-2.5 text-2xs font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
            >
              <ArrowRight className="size-3 sm:hidden" aria-hidden />
              <span className="hidden sm:inline">Start</span>
              <kbd className="hidden rounded border border-white/35 px-1 font-sans text-2xs sm:inline" aria-hidden>
                n
              </kbd>
            </button>
            <button
              type="button"
              onClick={snoozeTaskDone}
              aria-label="Not now: hide this for 5 minutes"
              title="Hide this for 5 minutes"
              className="inline-flex h-6 shrink-0 items-center rounded-full px-1.5 text-2xs font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink sm:px-2"
            >
              <X className="size-3.5 sm:hidden" aria-hidden />
              <span className="hidden sm:inline">Not now</span>
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={dismissTaskDone}
            aria-label={`Dismiss: ${doneLine}`}
            title="Hide this"
            className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        )}
      </div>
    );
    return {
      id: "task-done",
      motionKey: `task-done-${finished.goal}-${finished.since}`,
      kind: "taskDone",
      group: "Task done",
      icon: CircleCheck,
      tone: "good",
      text: doneLine,
      ...(next || doneWhy ? { detail: [doneWhy, nextLine].filter(Boolean).join(" · ") } : {}),
      tip: next ? `${doneLine} ${nextLine}` : doneLine,
      short: finished.title,
      ...(next
        ? {
            hotkey: "n" as const,
            primary: {
              label: "Start",
              name: `${doneLine} Start the next task: ${next.text} (n)`,
              title: "Start it (n). Your current work stays one click away in Back to.",
              run: start,
            },
            dismiss: { label: "Not now", name: "Not now: hide this for 5 minutes", title: "Hide this for 5 minutes", run: () => snoozeTaskDone() },
          }
        : { dismiss: { label: "Dismiss", name: `Dismiss: ${doneLine}`, title: "Hide this", run: () => dismissTaskDone() } }),
      full,
    };
  }

  if (pick) {
    // The next step of a click names the record and what it is for: "INV-1042 to resend it".
    const pickText =
      pick.source === "link" ? `${recordShortName(pick.candidate.id, data)}${pick.step ? ` ${pick.step}` : ""}` : recordCardText(pick.candidate, data, now);
    const why = pick.candidate.why ? `Why: ${pick.candidate.why}` : undefined;
    const open = (id: string) => (via: "pointer" | "keyboard") => openUpNext(id, via);
    const full = (
      <div
        role="group"
        aria-label="Up next"
        title={why}
        className="flex h-8 min-w-0 items-center gap-1 rounded-full border border-accent/35 bg-accent-soft pr-0.5 pl-2.5 text-sm text-ink"
      >
        <CornerDownRight className="size-3.5 shrink-0 text-accent-text" aria-hidden />
        <span className="shrink-0 text-2xs font-semibold text-accent-text">Up next:</span>
        <span className="min-w-0 truncate font-medium">{pickText}</span>
        <span
          className={clsx(
            "hidden shrink-0 rounded-full px-1.5 py-px text-2xs font-medium tabular-nums sm:inline",
            pick.source === "list" ? "bg-surface-3 text-ink-2" : "bg-accent/15 text-accent-text",
          )}
        >
          {pick.why}
        </span>
        <button
          type="button"
          // detail 0: Enter or Space, not a pointer click.
          onClick={(e) => openUpNext(pick.candidate.id, e.detail === 0 ? "keyboard" : "pointer")}
          aria-label={`Open ${pickText} (n)`}
          title="Open it (n)"
          className="ml-0.5 inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full bg-accent px-2.5 text-2xs font-semibold text-accent-fg transition-colors hover:bg-accent-hover"
        >
          Open
          <kbd className="hidden rounded border border-white/35 px-1 font-sans text-2xs sm:inline" aria-hidden>
            n
          </kbd>
        </button>
        {pick.alternatives.map((alt) => (
          <button
            key={alt.id}
            type="button"
            onClick={(e) => openUpNext(alt.id, e.detail === 0 ? "keyboard" : "pointer")}
            aria-label={`Open ${recordCardText(alt, data, now)} instead`}
            title={alt.why ? `Or: ${alt.label} (${alt.why})` : `Or: ${alt.label}`}
            className="hidden h-6 max-w-40 min-w-0 shrink items-center truncate rounded-full border border-line bg-surface px-2 text-2xs text-ink-2 transition-colors hover:border-accent/40 hover:text-ink lg:inline-flex"
          >
            <span className="truncate">{recordChipText(alt, data)}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => dismissUpNext(pick.candidate.id)}
          aria-label={`Dismiss Up next: ${pickText}`}
          title="Hide this for 2 minutes"
          className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    );
    return {
      id: "up-next",
      motionKey: `up-next-${pick.candidate.id}`,
      kind: "upNext",
      group: "Up next",
      icon: CornerDownRight,
      tone: "accent",
      text: `Up next: ${pickText}`,
      detail: [pick.why, why].filter(Boolean).join(" · "),
      tip: why ? `Up next: ${pickText}. ${why}` : `Up next: ${pickText}`,
      short: pickText,
      hotkey: "n",
      primary: { label: "Open", name: `Open ${pickText} (n)`, title: "Open it (n)", run: open(pick.candidate.id) },
      others: pick.alternatives.map((alt) => ({
        label: `Or: ${recordChipText(alt, data)}`,
        name: `Or: ${recordChipText(alt, data)}. Open ${recordCardText(alt, data, now)} instead`,
        title: alt.why ? `Or: ${alt.label} (${alt.why})` : `Or: ${alt.label}`,
        run: open(alt.id),
      })),
      dismiss: { label: "Dismiss", name: `Dismiss Up next: ${pickText}`, title: "Hide this for 2 minutes", run: () => dismissUpNext(pick.candidate.id) },
      full,
    };
  }

  if (done) {
    const full = (
      <div
        role="status"
        aria-label="Up next"
        className="flex h-8 min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface-2 pr-0.5 pl-2.5 text-sm text-ink-2"
      >
        <CircleCheck className="size-3.5 shrink-0 text-accent-text" aria-hidden />
        <span className="min-w-0 truncate">{done.text}</span>
        <button
          type="button"
          onClick={dismissUpNextDone}
          aria-label={`Dismiss: ${done.text}`}
          title="Hide this"
          className="grid size-7 shrink-0 place-items-center rounded-full text-ink-3 transition-colors hover:bg-surface-3 hover:text-ink"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    );
    return {
      id: "up-next-done",
      motionKey: `done-${done.eventId}`,
      kind: "upNextDone",
      group: "Up next",
      icon: CircleCheck,
      tone: "muted",
      text: done.text,
      tip: done.text,
      short: done.text,
      dismiss: { label: "Dismiss", name: `Dismiss: ${done.text}`, title: "Hide this", run: () => dismissUpNextDone() },
      full,
    };
  }

  return null;
}
