/**
 * Notes panel: a scratch pad bound to data.notes. Typing is reported as a
 * write_note action at most once every 5 s, so a long note does not flood
 * the signal log.
 */
import { ListPlus } from "lucide-react";
import { useId } from "react";
import { useShallow } from "zustand/react/shallow";
import { useEngine } from "../../engine/store.ts";
import { useThrottleGate } from "@attune/react";
import { Button, Compact, type PanelProps } from "./common.tsx";

const NOTE_SIGNAL_GAP_MS = 5000;

function firstLine(text: string): string {
  return text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
}

export function NotesPanel({ size }: PanelProps) {
  const { notes, setNotes, track, perform } = useEngine(
    useShallow((s) => ({ notes: s.data.notes, setNotes: s.setNotes, track: s.track, perform: s.perform })),
  );
  const gate = useThrottleGate(NOTE_SIGNAL_GAP_MS);
  const id = useId();
  const words = notes.trim() ? notes.trim().split(/\s+/).length : 0;
  const line = firstLine(notes);

  if (size === "compact") {
    return <Compact value={words} label={words === 1 ? "word" : "words"} sub={line || "No notes yet"} />;
  }

  return (
    <div className="fl-pad flex h-full min-h-0 flex-col gap-2 pb-3">
      <label htmlFor={id} className="sr-only">
        Notes
      </label>
      <textarea
        id={id}
        value={notes}
        onChange={(e) => {
          setNotes(e.target.value);
          if (gate()) track({ type: "action", panel: "notes", detail: { actionId: "write_note", label: "Writing a note", via: "keyboard" } });
        }}
        placeholder="Jot down anything. Notes stay here while you work."
        className="fl-scroll min-h-0 w-full flex-1 resize-none rounded-lg border border-line bg-surface-2 p-2.5 text-sm leading-relaxed text-ink placeholder:text-ink-3 focus:border-accent focus:bg-surface focus:outline-none"
      />
      <div className="flex shrink-0 items-center gap-2 text-2xs text-ink-3">
        <span>
          {words} {words === 1 ? "word" : "words"}
        </span>
        {size === "hero" && line ? (
          <Button
            className="ml-auto"
            icon={ListPlus}
            onClick={() => perform("create_task", { taskTitle: line.slice(0, 80) })}
            title={`Add "${line.slice(0, 80)}" as a task`}
          >
            Make first line a task
          </Button>
        ) : null}
      </div>
    </div>
  );
}
