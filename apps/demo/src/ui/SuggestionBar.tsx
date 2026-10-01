/**
 * Suggested next steps from the plan. Jev picks the action and the client;
 * code decides whether it is shown and how prominently (primary or subtle).
 * They sit at the end of the row under the command bar (AssistRow.tsx),
 * after "Next step", below the meeting prep card and Up next in priority:
 * when the row is short of room they become pills (the label cut short, "."
 * on the primary one, and a dismiss) and then wait in the row's "+N" list,
 * the subtle ones first. "." accepts the primary one wherever it shows.
 *
 * The row keeps one line's height whatever it shows, so the canvas below
 * never jumps: suggestions change with every relayout, and a bar that wrapped
 * to a second line pushed the whole canvas, and the panel just clicked, down.
 * With no suggestion it says so, or in the guided density offers example
 * commands on the same line, instead of a new row.
 */
import clsx from "clsx";
import { Sparkles, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Suggestion } from "../../shared/types.ts";
import { useEngine } from "../engine/store.ts";
import type { AssistEntry } from "./AssistRow.tsx";
import { panelSelector } from "./domHooks.ts";
import { hasModifier, isTextField, useWindowKeydown } from "@attune/react";

function key(s: Suggestion): string {
  return `${s.actionId}:${s.args.client ?? ""}:${s.args.invoiceId ?? ""}:${s.args.taskId ?? ""}`;
}

const EXAMPLES = ["unpaid invoices", "today's meetings", "Harbor Coffee Co.", "who is away today?"];

/**
 * After "Start meeting notes" (focus aid 4) the cursor goes to the end of
 * the notes, under the heading just added, once Notes is on the canvas (two
 * frames: the card may mount or grow first).
 */
function focusNotesEnd(): void {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const box = document.querySelector<HTMLTextAreaElement>(`${panelSelector("notes")} textarea`);
      if (!box) return;
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }),
  );
}

/**
 * The example commands (guided density, no suggestions), on one line that
 * scrolls sideways. While more of it is past the right edge, that edge fades,
 * so a cut chip reads as "scroll for more"; Tab brings each chip into view.
 * Toggling the fade changes no size, so the observer cannot loop.
 */
function ExampleStrip({ onRun }: { onRun: (text: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    check();
    el.addEventListener("scroll", check, { passive: true });
    if (typeof ResizeObserver === "undefined") return () => el.removeEventListener("scroll", check);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", check);
    };
  }, []);
  return (
    <div
      ref={ref}
      className={clsx(
        "fl-scroll flex h-8 min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-x-auto text-xs text-ink-3",
        more && "[mask-image:linear-gradient(to_right,black_calc(100%-2.5rem),transparent)]",
      )}
    >
      <span className="shrink-0">Try asking:</span>
      {EXAMPLES.map((ex) => (
        <button
          key={ex}
          type="button"
          onClick={() => onRun(ex)}
          className="h-6 shrink-0 rounded-full border border-line bg-surface px-2.5 text-2xs text-ink-2 hover:border-accent/40 hover:text-ink"
        >
          {ex}
        </button>
      ))}
    </div>
  );
}

/** "Next step" before the suggestions; just the icon when the row is short of room (the words stay for screen readers). */
export function NextStepLabel({ compact }: { compact: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-2xs font-medium text-ink-3" title={compact ? "Next step" : undefined}>
      <Sparkles className="size-3.5" aria-hidden />
      <span className={compact ? "sr-only" : undefined}>Next step</span>
    </span>
  );
}

/**
 * The suggestions as row cards, and what the row shows when there are none
 * (`hint`), plus the "." key. Call it once (the row does): the key listener
 * lives here, not in a chip, so "." works however the row shows the chip.
 */
export function useSuggestionEntries(): { entries: AssistEntry[]; hint: ReactNode | null } {
  const { suggestions, source, density, acceptSuggestion, dismissSuggestion, track, runCommand } = useEngine(
    useShallow((s) => ({
      suggestions: s.plan.suggestions,
      source: s.last?.source ?? null,
      density: s.plan.density,
      acceptSuggestion: s.acceptSuggestion,
      dismissSuggestion: s.dismissSuggestion,
      track: s.track,
      runCommand: s.runCommand,
    })),
  );
  const judge = source === "heuristic" ? "Heuristic" : "Jev";

  useWindowKeydown((e) => {
    if (e.key !== "." || hasModifier(e) || isTextField(e.target)) return;
    // Read the plan now, not the last render: right after the same action was
    // done by hand, the chip on screen can be a moment out of date.
    const primary = useEngine.getState().plan.suggestions.find((s) => s.prominence === "primary");
    if (!primary) return;
    e.preventDefault();
    track({ type: "shortcut", detail: { key: ".", via: "keyboard", actionId: primary.actionId, label: `Accepted suggestion: ${primary.label}` } });
    // Does nothing if that step is no longer offered.
    acceptSuggestion(primary);
  });

  if (suggestions.length === 0) {
    const hint =
      density === "guided" ? (
        <ExampleStrip onRun={(ex) => void runCommand(ex).catch(() => {})} />
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs text-ink-3" title="Suggestions show up here as you work.">
          Suggestions show up here as you work.
        </span>
      );
    return { entries: [], hint };
  }

  const entries = suggestions.map((s): AssistEntry => {
    const isPrimary = s.prominence === "primary";
    // A follow-up comes from code matching the step just done, and a habit step from the user's habits (focus aid 3), not from a judge.
    // "Start meeting notes" is focus aid 4's offer after Prepare, not a judged step either.
    const badge = s.task ? "Follow-up" : s.habit ? "Habit" : s.meetingNotes ? "Meeting" : `${judge} ${Math.round(s.confidence * 100)}%`;
    const accept = () => {
      acceptSuggestion(s);
      if (s.meetingNotes) focusNotesEnd();
    };
    const full = (
      <div
        className={clsx(
          // No overflow clipping: the buttons are rounded themselves, so their focus rings show.
          "flex h-8 min-w-0 items-center rounded-full text-sm",
          isPrimary ? "bg-accent text-accent-fg shadow-card" : "border border-line bg-surface text-ink-2",
        )}
        title={s.reason}
      >
        <button
          type="button"
          onClick={accept}
          className={clsx(
            "flex h-full min-w-0 items-center gap-2 rounded-l-full pr-2 pl-3.5 font-medium transition-colors",
            isPrimary ? "hover:bg-accent-hover" : "hover:bg-surface-2 hover:text-ink",
          )}
        >
          <span className="min-w-0 truncate">{s.label}</span>
          <span className={clsx("shrink-0 rounded-full px-1.5 py-px text-2xs font-medium tabular-nums", isPrimary ? "bg-white/20" : "bg-surface-3 text-ink-3")}>
            {badge}
          </span>
          {isPrimary && density !== "dense" ? (
            <kbd className="hidden shrink-0 rounded border border-white/30 px-1 font-sans text-2xs sm:inline" aria-hidden>
              .
            </kbd>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => dismissSuggestion(s)}
          aria-label={`Dismiss suggestion: ${s.label}`}
          className={clsx(
            "grid h-full w-8 shrink-0 place-items-center rounded-r-full border-l transition-colors",
            isPrimary ? "border-white/20 hover:bg-accent-hover" : "border-line text-ink-3 hover:bg-surface-2 hover:text-ink",
          )}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    );
    return {
      id: key(s),
      motionKey: key(s),
      kind: "suggestion",
      prominent: isPrimary,
      group: "Suggested next step",
      icon: Sparkles,
      tone: isPrimary ? "primary" : "subtle",
      text: s.label,
      detail: `${badge} · ${s.reason}`,
      tip: `${s.label} (${badge}). ${s.reason}`,
      short: s.label,
      ...(isPrimary ? { hotkey: "." as const } : {}),
      primary: { label: "Accept", name: `Accept: ${s.label}, ${badge}`, title: s.reason, run: accept },
      dismiss: { label: "Dismiss", name: `Dismiss suggestion: ${s.label}`, run: () => dismissSuggestion(s) },
      full,
    };
  });
  return { entries, hint: null };
}
