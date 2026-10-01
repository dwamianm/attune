/**
 * "Controls" tab: the knobs that belong to code, not to Jev.
 *
 * Turning adaptation off, freezing it, and moving the blend weights are how a
 * reviewer checks that the model only judges while the policy decides. The
 * "Focus aids" switches mirror the header's Focus settings popover: both set
 * the same store field (EngineSettings.focusAids) through setFocusAid.
 * Under them, "Prepare for meetings" (aid 4) has its lead time (how many
 * minutes before a meeting the prep chip shows) and a test button that adds
 * a meeting starting in 10 minutes.
 */
import { useState } from "react";
import { FlaskConical, LoaderCircle, Play, RotateCcw, Undo2, Zap } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { LinkLinesMode } from "../engine/contract.ts";
import { FOCUS_AID_IDS, FOCUS_AID_TEXT } from "../engine/focusAids.ts";
import { HABIT_WEIGHT } from "../engine/habits.ts";
import { PREP_LEAD_DEFAULT, PREP_LEAD_OPTIONS } from "../engine/meetingPrep.ts";
import { useEngine } from "../engine/store.ts";
import type { PolicyWeights } from "../../shared/types.ts";
import { SCENARIOS } from "../../shared/scenarios.ts";
import { formatFixed, formatMs } from "./format.ts";
import { Button, Section, Slider, Switch } from "./ui.tsx";

const LINK_LINE_OPTIONS: { value: LinkLinesMode; label: string; description: string }[] = [
  { value: "stay", label: "Stay until cleared", description: "Lines, tags, and tints stay until you clear them: the links bar, Escape, or a tag's x." },
  { value: "fade", label: "Fade after 2 seconds", description: "Lines fade after about 2 seconds; tags and tints go when the clicked panel is released." },
];

const WEIGHTS: { key: keyof PolicyWeights; label: string }[] = [
  { key: "relevance", label: "Jev relevance" },
  { key: "usage", label: "Recent use" },
  { key: "goal", label: "Goal rule" },
  // Focus aid 3: added on top of the three above, only with "Learn my habits" on and a habit with enough evidence.
  { key: "habit", label: "Your habits" },
];

function weightPatch(key: keyof PolicyWeights, value: number): Partial<PolicyWeights> {
  const patch: Partial<PolicyWeights> = {};
  patch[key] = value;
  return patch;
}

function ScenarioList() {
  const replayScenario = useEngine((s) => s.replayScenario);
  const [replaying, setReplaying] = useState<string | null>(null);

  async function replay(id: string) {
    setReplaying(id);
    try {
      await replayScenario(id);
    } catch {
      // The engine reports failures through status and lastError.
    } finally {
      setReplaying(null);
    }
  }

  return (
    <Section title="Replay a scenario">
      <ul className="space-y-2">
        {SCENARIOS.map((sc) => {
          const active = replaying === sc.id;
          return (
            <li key={sc.id}>
              <button
                type="button"
                onClick={() => replay(sc.id)}
                disabled={replaying != null}
                className="flex w-full items-start gap-3 rounded-lg border border-neutral-200 px-3 py-2 text-left hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-violet-500 dark:border-neutral-800 dark:hover:bg-neutral-900"
              >
                <Play className="mt-0.5 h-4 w-4 shrink-0 text-violet-600 dark:text-violet-400" aria-hidden />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-100">
                    {sc.name}
                    {active && <span className="ml-2 text-xs font-normal text-violet-600 dark:text-violet-400">Replaying</span>}
                  </span>
                  <span className="block text-xs text-neutral-500 dark:text-neutral-400">{sc.description}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

export function ControlsTab() {
  const { settings, canUndo, thinking } = useEngine(
    useShallow((s) => ({ settings: s.settings, canUndo: s.previousPlan != null, thinking: s.status === "thinking" })),
  );
  const { setSettings, setFocusAid, setWeights, adaptNow, undo, reset, simulateMeeting } = useEngine(
    useShallow((s) => ({
      setSettings: s.setSettings,
      setFocusAid: s.setFocusAid,
      simulateMeeting: s.simulateMeeting,
      setWeights: s.setWeights,
      adaptNow: s.adaptNow,
      undo: s.undo,
      reset: s.reset,
    })),
  );

  return (
    <div className="space-y-6">
      <Section title="Adaptation">
        <Switch
          checked={settings.adaptive}
          onChange={(adaptive) => setSettings({ adaptive })}
          label="Adaptive layout. Off shows a traditional fixed layout"
        />
        <Switch
          checked={settings.frozen}
          onChange={(frozen) => setSettings({ frozen })}
          label="Freeze layout"
          description="Keep asking Jev and show answers here, but do not move panels."
        />
      </Section>

      <Section title="Focus aids">
        {FOCUS_AID_IDS.map((id) => (
          <Switch
            key={id}
            checked={settings.focusAids[id]}
            onChange={(on) => setFocusAid(id, on)}
            label={FOCUS_AID_TEXT[id].label}
            description={FOCUS_AID_TEXT[id].description}
          />
        ))}
        <fieldset className="space-y-1 rounded-lg border border-neutral-200 px-3 py-2 dark:border-neutral-800" disabled={!settings.focusAids.meetingPrep}>
          <legend className="px-1 text-xs font-medium text-neutral-700 dark:text-neutral-300">Prepare for meetings: show the prep chip</legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {PREP_LEAD_OPTIONS.map((m) => (
              <label key={m} className="flex cursor-pointer items-center gap-1.5 text-sm text-neutral-900 dark:text-neutral-100">
                <input
                  type="radio"
                  name="inspector-prep-lead"
                  value={m}
                  checked={(settings.prepLeadMin ?? PREP_LEAD_DEFAULT) === m}
                  onChange={() => setSettings({ prepLeadMin: m })}
                  className="h-4 w-4 shrink-0 accent-violet-600 dark:accent-violet-400"
                />
                {m} minutes before
              </label>
            ))}
          </div>
          <div className="pt-1">
            <Button onClick={() => simulateMeeting()} title="Adds a test meeting with a client you worked on, starting in 10 minutes. Reset removes it.">
              <FlaskConical className="h-4 w-4" aria-hidden />
              Test: simulate a meeting in 10 minutes
            </Button>
          </div>
        </fieldset>
      </Section>

      <Section title="Link lines">
        <fieldset className="space-y-1">
          <legend className="sr-only">Link lines</legend>
          {LINK_LINE_OPTIONS.map((o) => (
            <label key={o.value} className="flex cursor-pointer items-start gap-3 rounded-lg px-1 py-1">
              <input
                type="radio"
                name="inspector-link-lines"
                value={o.value}
                checked={settings.linkLines === o.value}
                onChange={() => setSettings({ linkLines: o.value })}
                className="mt-1 h-4 w-4 shrink-0 accent-violet-600 dark:accent-violet-400"
              />
              <span className="min-w-0">
                <span className="block text-sm text-neutral-900 dark:text-neutral-100">{o.label}</span>
                <span className="block text-xs text-neutral-500 dark:text-neutral-400">{o.description}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </Section>

      <Section title="Priority weights">
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          Code blends the first three parts into each panel's priority. Jev only supplies the relevance scores. Your habits are added on top, only with
          "Learn my habits" on.
        </p>
        {WEIGHTS.map((w) => (
          <Slider
            key={w.key}
            id={`inspector-weight-${w.key}`}
            label={w.label}
            value={settings.weights[w.key] ?? HABIT_WEIGHT}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => setWeights(weightPatch(w.key, v))}
            format={(v) => formatFixed(v, 2)}
          />
        ))}
        <Slider
          id="inspector-min-interval"
          label="Min time between layout changes"
          value={settings.minChangeIntervalMs}
          min={500}
          max={6000}
          step={100}
          onChange={(minChangeIntervalMs) => setSettings({ minChangeIntervalMs })}
          format={formatMs}
        />
      </Section>

      <Section title="Actions">
        <div className="flex flex-wrap gap-2">
          <Button primary onClick={() => void adaptNow("manual").catch(() => {})}>
            {thinking ? (
              <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden />
            ) : (
              <Zap className="h-4 w-4" aria-hidden />
            )}
            Adapt now
          </Button>
          <Button onClick={() => undo()} disabled={!canUndo} title="Go back to the previous layout">
            <Undo2 className="h-4 w-4" aria-hidden />
            Undo
          </Button>
          <Button onClick={() => reset()} title="Clear signals and return to the default layout">
            <RotateCcw className="h-4 w-4" aria-hidden />
            Reset
          </Button>
        </div>
      </Section>

      <ScenarioList />
    </div>
  );
}
