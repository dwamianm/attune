/**
 * App header: identity, what Jev thinks the user is doing, whether Jev or the
 * offline heuristic is answering, the two switches a demo needs (Adaptive on
 * or off, and the inspector), the focus aids' settings (FocusSettings), and
 * About, which reopens the welcome screen.
 */
import clsx from "clsx";
import { Compass, Info, ScanEye } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import { GOALS } from "../../shared/catalog.ts";
import { STUDIO_NAME } from "../../shared/fixtures.ts";
import type { EngineStatus } from "../engine/contract.ts";
import { useEngine } from "../engine/store.ts";
import { APP_BAR_ATTR } from "./domHooks.ts";
import { FocusSettings } from "./FocusSettings.tsx";
import { openWelcome } from "./Welcome.tsx";
import { startGuide } from "./guideEvents.ts";

type StatusView = { label: string; dot: string; pulse?: boolean };

function statusView(status: EngineStatus, source: "jev" | "heuristic" | null): StatusView {
  if (status === "thinking") return { label: "Updating", dot: "bg-accent", pulse: true };
  if (status === "error") return { label: "Error", dot: "bg-bad" };
  if (status === "offline" || source === "heuristic") return { label: "Demo rules", dot: "bg-warn" };
  if (source === "jev") return { label: "AI connected", dot: "bg-good" };
  // Before the first answer arrives.
  return { label: "Ready", dot: "bg-ink-3" };
}

function Logo() {
  return (
    <svg viewBox="0 0 24 24" className="size-6 shrink-0" aria-hidden>
      <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--color-accent)" />
      <rect x="5" y="5" width="8" height="14" rx="2.2" fill="var(--color-accent-fg)" />
      <rect x="15" y="5" width="4" height="6" rx="1.6" fill="var(--color-accent-fg)" opacity="0.75" />
      <rect x="15" y="13" width="4" height="6" rx="1.6" fill="var(--color-accent-fg)" opacity="0.5" />
    </svg>
  );
}

export function Header() {
  const { goal, status, source, model, latencyMs, lastError, adaptive, behavior, inspectorOpen, setSettings, setInspectorOpen } = useEngine(
    useShallow((s) => ({
      goal: s.goal,
      status: s.status,
      source: s.last?.source ?? null,
      model: s.last?.meta.model ?? null,
      latencyMs: s.last?.meta.latencyMs ?? null,
      lastError: s.lastError,
      adaptive: s.settings.adaptive,
      behavior: s.settings.layoutBehavior,
      inspectorOpen: s.inspectorOpen,
      setSettings: s.setSettings,
      setInspectorOpen: s.setInspectorOpen,
    })),
  );
  const reduceMotion = useReducedMotion() ?? false;
  const sv = statusView(status, source);
  const statusTitle =
    status === "error" && lastError
      ? `Error: ${lastError}`
      : model
        ? `Last answer from ${model}${latencyMs !== null ? ` in ${Math.round(latencyMs)} ms` : ""}`
        : sv.label;

  const known = goal && goal.id !== "unclear";
  const goalLabel = goal ? GOALS[goal.id].label : GOALS.unclear.label;

  return (
    <header {...{ [APP_BAR_ATTR]: "" }} className="sticky top-0 z-30 border-b border-line bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 md:px-6">
        <div className="flex min-w-0 items-center gap-2">
          <Logo />
          <span className="text-[15px] font-semibold tracking-tight text-ink">Attune</span>
          <span className="hidden text-sm text-ink-3 sm:inline" aria-hidden>
            /
          </span>
          <span className="hidden truncate text-sm text-ink-2 sm:inline">{STUDIO_NAME}</span>
        </div>

        <div
          className="order-last flex h-7 w-full min-w-0 items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 text-xs md:order-none md:ml-2 md:w-auto md:max-w-sm"
          title={
            goal
              ? "Suggested from your recent activity. Open Inspector for the evidence."
              : undefined
          }
        >
          <span className="shrink-0 text-ink-3">Looks like:</span>
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={goal?.id ?? "none"}
              initial={reduceMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={reduceMotion ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, y: -4, transition: { duration: 0.12 } }}
              className={clsx("min-w-0 truncate font-medium", known ? "text-ink" : "text-ink-3")}
            >
              {goalLabel}
            </motion.span>
          </AnimatePresence>
        </div>

        <div className="ml-auto flex shrink-0 items-center gap-1 sm:gap-2">
          <span className="flex h-8 items-center gap-1.5 px-1.5 text-xs text-ink-2" title={statusTitle}>
            <span className={clsx("size-2 rounded-full", sv.dot, sv.pulse && "fl-pulse")} aria-hidden />
            <span className="hidden whitespace-nowrap lg:inline">{sv.label}</span>
            <span className="sr-only lg:hidden">Status: {sv.label}</span>
          </span>

          <button
            type="button"
            role="switch"
            aria-checked={adaptive}
            onClick={() => setSettings({ adaptive: !adaptive })}
            className="flex h-8 items-center gap-2 rounded-lg px-2 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
            title={!adaptive ? "Fixed layout. Activity is still logged." : behavior === "suggestions" ? "Suggestions update; your layout stays in place. Change behavior in Focus." : "The layout adapts to how you work"}
          >
            Adaptive
            <span className={clsx("relative h-5 w-9 shrink-0 rounded-full transition-colors", adaptive ? "bg-accent" : "bg-line-strong")}>
              <span
                className={clsx(
                  "absolute top-0.5 left-0.5 size-4 rounded-full bg-white shadow-sm transition-transform",
                  adaptive ? "translate-x-4" : "translate-x-0",
                )}
              />
            </span>
          </button>

          <FocusSettings />

          <button type="button" data-start-guide onClick={startGuide} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-accent-text hover:bg-accent-soft">
            <Compass className="size-4" aria-hidden />
            Guide me
          </button>

          <button
            type="button"
            onClick={() => setInspectorOpen(!inspectorOpen)}
            aria-pressed={inspectorOpen}
            aria-label="Inspector"
            className={clsx(
              "flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition-colors",
              inspectorOpen ? "bg-accent-soft text-accent-text" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
            )}
          >
            <ScanEye className="size-4" aria-hidden />
            <span className="hidden sm:inline">Inspector</span>
          </button>

          <button
            type="button"
            onClick={openWelcome}
            aria-haspopup="dialog"
            aria-label="About Attune"
            title="Who built Attune, why, and the rules it follows"
            className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
          >
            <Info className="size-4" aria-hidden />
            <span className="hidden sm:inline">About</span>
          </button>
        </div>
      </div>
    </header>
  );
}
