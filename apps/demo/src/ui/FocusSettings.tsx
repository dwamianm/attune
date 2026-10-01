/**
 * The focus aids' settings popover in the header (docs/focus-aids.md): a
 * gear button, "Focus settings", that opens a small dialog with one switch
 * per aid, its one-line description, and whether it is on. The switches call
 * setFocusAid, which sets EngineSettings.focusAids, the same field the
 * inspector's Controls tab shows, so there is one source of truth. An aid
 * added to FOCUS_AID_TEXT gets its switch here with no change to this file.
 * "Prepare for meetings" (aid 4) also gets a test button under its switch,
 * "Test: simulate a meeting in 10 minutes", since the demo's meetings are at
 * fixed times.
 *
 * Keyboard: Tab reaches the gear, Enter or Space opens the dialog with focus
 * on the first switch, Tab moves through the switches, and Escape (or a
 * click outside) closes it and puts focus back on the gear. Tabbing out of
 * the dialog closes it too. While it is open, "n" and "b" do nothing
 * (flowKeyTaken sees the open dialog).
 */
import clsx from "clsx";
import { FlaskConical, Settings } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { FOCUS_AID_IDS, FOCUS_AID_TEXT } from "../engine/focusAids.ts";
import { useEngine } from "../engine/store.ts";
import { useWindowKeydown } from "@attune/react";

export function FocusSettings() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const { aids, setFocusAid, simulateMeeting } = useEngine(
    useShallow((s) => ({ aids: s.settings.focusAids, setFocusAid: s.setFocusAid, simulateMeeting: s.simulateMeeting })),
  );

  // Opening puts focus on the first switch, so the keyboard is already inside.
  useEffect(() => {
    if (open) boxRef.current?.querySelector<HTMLElement>('[role="switch"]')?.focus();
  }, [open]);

  // A press anywhere else closes it (the press itself still does its job).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && wrapRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  useWindowKeydown((e) => {
    if (e.key !== "Escape") return;
    // Ours: the links bar leaves an Escape alone once it is handled.
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    buttonRef.current?.focus();
  }, open);

  return (
    <div
      ref={wrapRef}
      // On a phone the gear is not at the edge, so the dialog spans the sticky header (its positioned ancestor) instead.
      className="sm:relative"
      onBlur={(e) => {
        // Tabbing out of the dialog closes it; focus moving inside it does not.
        const to = e.relatedTarget;
        if (open && to instanceof Node && !wrapRef.current?.contains(to)) setOpen(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${baseId}-dialog` : undefined}
        aria-label="Focus settings"
        title="Focus settings"
        className={clsx(
          "flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors",
          open ? "bg-accent-soft text-accent-text" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
        )}
      >
        <Settings className="size-4" aria-hidden />
        <span className="hidden sm:inline">Focus</span>
      </button>

      {open ? (
        <div
          ref={boxRef}
          id={`${baseId}-dialog`}
          role="dialog"
          aria-labelledby={`${baseId}-title`}
          className="absolute top-full right-4 left-4 z-40 mt-2 rounded-xl border border-line bg-surface p-2 text-ink shadow-pop sm:right-0 sm:left-auto sm:w-[22rem]"
        >
          <p id={`${baseId}-title`} className="px-2 pt-1 pb-1.5 text-2xs font-medium tracking-wide text-ink-3 uppercase">
            Focus aids
          </p>
          <ul className="space-y-0.5">
            {FOCUS_AID_IDS.map((id) => {
              const on = aids[id];
              const text = FOCUS_AID_TEXT[id];
              const descId = `${baseId}-${id}-description`;
              return (
                <li key={id}>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={on}
                    aria-label={text.label}
                    aria-describedby={descId}
                    // detail 0: Enter or Space, not a pointer click.
                    onClick={(e) => setFocusAid(id, !on, e.detail === 0 ? "keyboard" : "pointer")}
                    className="flex w-full items-start gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium text-ink">{text.label}</span>
                      <span id={descId} className="mt-0.5 block text-xs leading-snug text-ink-3">
                        {text.description}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2 pt-0.5" aria-hidden>
                      <span className={clsx("w-6 text-right text-2xs font-medium", on ? "text-accent-text" : "text-ink-3")}>{on ? "On" : "Off"}</span>
                      <span className={clsx("relative h-5 w-9 shrink-0 rounded-full transition-colors", on ? "bg-accent" : "bg-line-strong")}>
                        <span
                          className={clsx(
                            "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform",
                            on ? "translate-x-4" : "translate-x-0",
                          )}
                        />
                      </span>
                    </span>
                  </button>
                  {id === "meetingPrep" ? (
                    <button
                      type="button"
                      onClick={simulateMeeting}
                      disabled={!on}
                      title={on ? "Adds a test meeting with a client you worked on, starting in 10 minutes. Reset removes it." : "Turn on Prepare for meetings to try it."}
                      className="mb-1 ml-2 inline-flex h-6 items-center gap-1.5 rounded-full border border-dashed border-line-strong px-2 text-2xs font-medium text-ink-2 transition-colors hover:border-link/50 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <FlaskConical className="size-3" aria-hidden />
                      Test: simulate a meeting in 10 minutes
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
