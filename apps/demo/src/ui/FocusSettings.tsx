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
 * on the workspace behavior control, Tab moves through the controls, and Escape (or a
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
import { useWindowKeydown } from "@attuneui/react";

export function FocusSettings() {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const { settings, aids, setSettings, setFocusAid, simulateMeeting } = useEngine(
    useShallow((s) => ({ settings: s.settings, aids: s.settings.focusAids, setSettings: s.setSettings, setFocusAid: s.setFocusAid, simulateMeeting: s.simulateMeeting })),
  );

  // Opening puts focus on the first control, so the keyboard is already inside.
  useEffect(() => {
    if (open) boxRef.current?.querySelector<HTMLElement>('select, [role="switch"]')?.focus();
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
          className="absolute top-full right-4 left-4 z-40 mt-2 max-h-[75dvh] overflow-y-auto rounded-xl border border-line bg-surface p-2 text-ink shadow-pop sm:right-0 sm:left-auto sm:w-[22rem]"
        >
          <p id={`${baseId}-title`} className="px-2 pt-1 pb-1.5 text-2xs font-medium tracking-wide text-ink-3 uppercase">
            Your workspace
          </p>
          <div className="mb-2 grid gap-3 border-b border-line px-2 pb-3">
            <label className="grid gap-1.5 text-sm font-medium">
              Workspace behavior
              <select
                value={!settings.adaptive ? "fixed" : settings.frozen ? "paused" : settings.layoutBehavior ?? "adaptive"}
                onChange={(e) => setSettings({ adaptive: e.target.value !== "fixed", frozen: false, layoutBehavior: e.target.value === "suggestions" ? "suggestions" : "adaptive" })}
                className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm font-normal"
                aria-describedby={`${baseId}-behavior`}
              >
                <option value="adaptive">Full adaptation</option>
                <option value="suggestions">Suggestions only</option>
                <option value="fixed">Fixed workspace</option>
                {settings.frozen && <option value="paused">Paused in Inspector</option>}
              </select>
            </label>
            <p id={`${baseId}-behavior`} className="text-xs leading-relaxed text-ink-2">
              {!settings.adaptive ? "Arrange the workspace yourself. Automatic assistance is off."
                : settings.frozen ? "Automatic changes are paused. Choose a behavior to resume."
                : settings.layoutBehavior === "suggestions" ? "Suggestions update while panels keep their places. Commands and your panel controls still work."
                : "Related panels can move, resize, and appear as you work. Your current panel stays anchored."}
            </p>
            <label className="grid gap-1.5 text-sm font-medium">
              Display density
              <select value={settings.density ?? "standard"} onChange={(e) => setSettings({ density: e.target.value as "guided" | "standard" | "dense" | "auto" })} className="h-9 w-full rounded-lg border border-line bg-surface-2 px-2 text-sm font-normal">
                <option value="guided">Spacious</option>
                <option value="standard">Comfortable</option>
                <option value="dense">Compact</option>
                <option value="auto">Let Attune adjust</option>
              </select>
            </label>
            <p className="text-xs text-ink-2">Your choices are saved in this browser.</p>
          </div>
          <p className="px-2 pb-1 text-2xs font-medium tracking-wide text-ink-3 uppercase">Focus aids</p>
          {settings.adaptive && settings.layoutBehavior === "suggestions" && <p className="px-2 pb-2 text-xs text-ink-2">Automatic fading, shrinking, and rearranging wait until Full adaptation is on.</p>}
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
