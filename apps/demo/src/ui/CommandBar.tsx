/**
 * The command bar: one text box that replaces page navigation. The text is
 * judged by Jev together with the current activity snapshot in one call, and
 * the engine turns the answer into a layout change (or asks the user to pick
 * when Jev is unsure).
 */
import clsx from "clsx";
import { CircleAlert, CircleCheck, CircleQuestionMark, CornerDownLeft, LoaderCircle, Search, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { COMMAND_MAX_LENGTH } from "../../shared/types.ts";
import type { CommandOutcome } from "../engine/contract.ts";
import { useEngine } from "../engine/store.ts";
import { COMMAND_BAR_ATTR } from "./domHooks.ts";
import { useWindowKeydown } from "@attune/react";
import { MOD_K, useCommandFocusListener } from "./hooks.ts";

const OUTCOME_ICON: Record<CommandOutcome["status"], { icon: typeof CircleCheck; className: string }> = {
  applied: { icon: CircleCheck, className: "text-good" },
  confirm: { icon: CircleQuestionMark, className: "text-accent-text" },
  unclear: { icon: CircleAlert, className: "text-warn" },
};

export function CommandBar() {
  const { command, status, runCommand, chooseCommandOption, clearCommand, track } = useEngine(
    useShallow((s) => ({
      command: s.command,
      status: s.status,
      runCommand: s.runCommand,
      chooseCommandOption: s.chooseCommandOption,
      clearCommand: s.clearCommand,
      track: s.track,
    })),
  );
  const reduceMotion = useReducedMotion() ?? false;
  const inputRef = useRef<HTMLInputElement>(null);
  const outcomeId = useId();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  // Stays true from submit until an outcome arrives, in case runCommand
  // resolves before the judgment lands.
  const [awaiting, setAwaiting] = useState(false);

  useWindowKeydown((e) => {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
      track({ type: "shortcut", detail: { key: "mod+k", via: "keyboard", label: "Opened the command bar" } });
    }
  });

  useCommandFocusListener((prefill) => {
    if (prefill !== undefined) setText(prefill);
    inputRef.current?.focus();
  });

  useEffect(() => {
    if (!command) return;
    setAwaiting(false);
    // Clear the box once the command worked, unless the user already typed something new.
    if (command.status === "applied") setText((t) => (t.trim() === command.text.trim() ? "" : t));
  }, [command]);

  const submit = async (value: string) => {
    const q = value.trim();
    if (!q) return;
    setPending(true);
    setAwaiting(true);
    try {
      await runCommand(q);
    } catch {
      // The engine reports failures through status and lastError.
    } finally {
      setPending(false);
    }
  };

  const thinking = pending || (awaiting && status === "thinking");
  const Outcome = command ? OUTCOME_ICON[command.status] : null;

  return (
    <div {...{ [COMMAND_BAR_ATTR]: "" }}>
      <div
        className={clsx(
          "flex h-11 items-center gap-2 rounded-xl border bg-surface px-3 shadow-card transition-colors",
          "border-line focus-within:border-accent focus-within:ring-4 focus-within:ring-accent/15",
        )}
      >
        <Search className="size-4 shrink-0 text-ink-3" aria-hidden />
        <input
          ref={inputRef}
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit(text);
            } else if (e.key === "Escape") {
              e.preventDefault();
              setText("");
              setAwaiting(false);
              clearCommand();
              inputRef.current?.blur();
            }
          }}
          placeholder="Ask for anything, for example: who still owes us money?"
          aria-label="Command bar"
          maxLength={COMMAND_MAX_LENGTH}
          aria-describedby={command ? outcomeId : undefined}
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="go"
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-ellipsis text-ink placeholder:text-ink-3 focus:outline-none"
          style={{ outline: "none" }}
        />
        {thinking ? (
          <span className="flex shrink-0 items-center gap-1.5 text-2xs text-ink-3" role="status">
            <LoaderCircle className="size-4 animate-spin text-accent-text" aria-hidden />
            <span className="hidden sm:inline">Thinking</span>
            <span className="sr-only sm:hidden">Thinking</span>
          </span>
        ) : text.trim() ? (
          <button
            type="button"
            onClick={() => void submit(text)}
            className="grid size-7 shrink-0 place-items-center rounded-lg text-ink-2 hover:bg-surface-2 hover:text-ink"
            aria-label="Run command"
          >
            <CornerDownLeft className="size-4" aria-hidden />
          </button>
        ) : (
          <kbd className="hidden shrink-0 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-sans text-2xs text-ink-3 sm:inline">
            {MOD_K}
          </kbd>
        )}
      </div>

      <AnimatePresence initial={false} mode="wait">
        {command && Outcome ? (
          <motion.div
            key={`${command.status}:${command.text}:${command.message}`}
            id={outcomeId}
            role="status"
            aria-live="polite"
            initial={reduceMotion ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.12 } }}
            className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1.5 px-1 text-xs"
          >
            <Outcome.icon className={clsx("size-4 shrink-0", Outcome.className)} aria-hidden />
            <span className="min-w-0 text-ink-2">
              <span className="text-ink-3">&ldquo;{command.text}&rdquo;</span> {command.message}
            </span>
            {command.status !== "applied"
              ? command.options.map((o) => (
                  <button
                    key={o.panel}
                    type="button"
                    onClick={() => chooseCommandOption(o.panel)}
                    className="inline-flex h-7 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-xs font-medium text-ink hover:border-accent/40 hover:bg-accent-soft"
                  >
                    {o.label}
                    <span className="text-2xs font-normal text-ink-3 tabular-nums">{Math.round(o.probability * 100)}%</span>
                  </button>
                ))
              : null}
            <button
              type="button"
              onClick={() => {
                clearCommand();
                setAwaiting(false);
              }}
              className="grid size-6 place-items-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink"
              aria-label="Dismiss command result"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
