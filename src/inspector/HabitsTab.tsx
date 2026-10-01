/**
 * "Habits" tab: what focus aid 3, "Learn my habits", has learned
 * (docs/focus-aids.md, "Aid 3"). Each learned move in plain words with its
 * strength and counts, strongest first; "Load a sample week" to see the
 * effect at once (marked as sample data); and "Forget my habits", which
 * asks for a second click instead of a browser dialog. The switch is the
 * same field the header popover and the Controls tab set (setFocusAid).
 * The words come from describeHabits in src/engine/habits.ts.
 */
import { useEffect, useState } from "react";
import { CalendarRange, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { FOCUS_AID_TEXT } from "../engine/focusAids.ts";
import { describeHabits, habitCount, type HabitSection } from "../engine/habits.ts";
import { useEngine } from "../engine/store.ts";
import { Badge, Button, Section, Stat, Switch } from "./ui.tsx";
import { useNow } from "./useNow.ts";

/** "Forget my habits" waits this long for the second click, then asks again: long enough to read the new label, short enough not to linger armed. */
const FORGET_CONFIRM_MS = 5_000;
/** The counts fade slowly (a half-life of two weeks), so a slow refresh is enough. */
const REFRESH_MS = 10_000;

const SECTIONS: { key: "panel" | "start" | "goal" | "action"; title: string }[] = [
  { key: "panel", title: "Where you go next" },
  { key: "start", title: "Where you start" },
  { key: "goal", title: "What work comes next" },
  { key: "action", title: "What you do after opening a record" },
];

function HabitList({ title, section }: { title: string; section: HabitSection }) {
  if (section.rows.length === 0) return null;
  return (
    <Section title={title}>
      <ul className="divide-y divide-neutral-100 dark:divide-neutral-900">
        {section.rows.map((r) => (
          <li key={r.key} className="flex items-baseline gap-2 py-1.5">
            <span className="min-w-0 flex-1 text-sm text-neutral-800 dark:text-neutral-200">{r.text}</span>
            <Badge tone={r.habit ? "accent" : "neutral"}>{r.strength}</Badge>
            <span className="shrink-0 text-[11px] text-neutral-500 tabular-nums dark:text-neutral-400">{r.counts}</span>
          </li>
        ))}
      </ul>
      {section.more > 0 ? (
        <p className="text-[11px] text-neutral-500 dark:text-neutral-400">
          And {section.more} more {section.more === 1 ? "move" : "moves"}, weaker than these.
        </p>
      ) : null}
    </Section>
  );
}

export function HabitsTab() {
  const { habits, on, guess } = useEngine(useShallow((s) => ({ habits: s.habits, on: s.settings.focusAids.habits, guess: s.metrics.habits })));
  const { setFocusAid, forgetHabits, loadSampleHabits } = useEngine(
    useShallow((s) => ({ setFocusAid: s.setFocusAid, forgetHabits: s.forgetHabits, loadSampleHabits: s.loadSampleHabits })),
  );
  const now = useNow(REFRESH_MS);
  const [confirming, setConfirming] = useState(false);
  const [forgot, setForgot] = useState(false);

  // An armed "Forget" goes back to its first label after a while.
  useEffect(() => {
    if (!confirming) return;
    const id = setTimeout(() => setConfirming(false), FORGET_CONFIRM_MS);
    return () => clearTimeout(id);
  }, [confirming]);

  const learned = describeHabits(habits, now);
  const count = habitCount(habits, now);
  const anything = SECTIONS.some((x) => learned[x.key].rows.length > 0);

  function forget() {
    if (!confirming) {
      setConfirming(true);
      setForgot(false);
      return;
    }
    setConfirming(false);
    forgetHabits();
    setForgot(true);
  }

  return (
    <div className="space-y-6">
      <Section title="Learn my habits">
        <Switch checked={on} onChange={(next) => setFocusAid("habits", next)} label={FOCUS_AID_TEXT.habits.label} description={FOCUS_AID_TEXT.habits.description} />
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {on
            ? "Attune counts where you go next, where you start, which work follows which, and what you do after opening a record. Counts fade by half every two weeks, and a move counts as a habit only after three times and at least 40% of the moves from there."
            : "Off: Attune does not learn or use your habits. What it learned stays in this browser until you forget it."}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Habits" value={count === 0 ? "None yet" : String(count)} hint={habits.sample ? "Includes the sample week" : undefined} />
          <Stat
            label="Habit guess right"
            value={guess.guessed > 0 ? `${guess.right} of ${guess.guessed}` : "None yet"}
            hint="This session, with the switch on or off"
          />
        </div>
        {habits.sample ? (
          <p className="flex flex-wrap items-center gap-2 text-xs text-neutral-600 dark:text-neutral-300">
            <Badge tone="warn">Sample data</Badge>
            These habits include a made-up week of use. Forget my habits removes it.
          </p>
        ) : null}
      </Section>

      {anything ? (
        SECTIONS.map((x) => <HabitList key={x.key} title={x.title} section={learned[x.key]} />)
      ) : (
        <p className="rounded-lg border border-dashed border-neutral-300 px-4 py-6 text-center text-sm text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          Nothing learned yet. Work in the app for a few days, or load a sample week to see the effect now.
        </p>
      )}

      <Section title="Your data">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => loadSampleHabits()} title="Add a made-up week of use, marked as sample data">
            <CalendarRange className="h-4 w-4" aria-hidden />
            Load a sample week
          </Button>
          <Button onClick={forget} disabled={!anything && !habits.sample && !confirming} title="Clear everything Attune learned about your habits in this browser">
            <Trash2 className="h-4 w-4" aria-hidden />
            {confirming ? "Click again to forget" : "Forget my habits"}
          </Button>
        </div>
        <p className="text-xs text-neutral-500 dark:text-neutral-400" aria-live="polite">
          {confirming
            ? "This clears every habit, the sample week included. Click again to confirm."
            : forgot
              ? "Forgot your habits. Attune starts learning again from your next move."
              : "Your habits are saved only in this browser."}
        </p>
      </Section>
    </div>
  );
}
