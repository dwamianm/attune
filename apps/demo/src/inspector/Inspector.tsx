/**
 * The "why did the UI change" inspector: a right-side drawer that shows what
 * Jev judged, what the code policy decided from it, the exact request, the
 * history of rounds, the raw signals, and the policy knobs.
 *
 * The shell renders <Inspector /> with no props; visibility comes from
 * `inspectorOpen` in the engine store.
 */
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import clsx from "clsx";
import { LoaderCircle, X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useEngine } from "../engine/store.ts";
import type { EngineStatus } from "../engine/contract.ts";
import { takePendingInspectorTab, useInspectorTabListener } from "../ui/hooks.ts";
import { ControlsTab } from "./ControlsTab.tsx";
import { DecisionsTab } from "./DecisionsTab.tsx";
import { HabitsTab } from "./HabitsTab.tsx";
import { HistoryTab } from "./HistoryTab.tsx";
import { MetricsTab } from "./MetricsTab.tsx";
import { NowTab } from "./NowTab.tsx";
import { RequestTab } from "./RequestTab.tsx";
import { SignalsTab } from "./SignalsTab.tsx";
import { Badge, type Tone } from "./ui.tsx";

type TabId = "now" | "decisions" | "request" | "history" | "signals" | "metrics" | "habits" | "controls";

const TABS: { id: TabId; label: string; Component: ComponentType }[] = [
  { id: "now", label: "Now", Component: NowTab },
  { id: "decisions", label: "Decisions", Component: DecisionsTab },
  { id: "request", label: "Request", Component: RequestTab },
  { id: "history", label: "History", Component: HistoryTab },
  { id: "signals", label: "Signals", Component: SignalsTab },
  { id: "metrics", label: "Metrics", Component: MetricsTab },
  { id: "habits", label: "Habits", Component: HabitsTab },
  { id: "controls", label: "Controls", Component: ControlsTab },
];

const STATUS: Record<EngineStatus, { label: string; tone: Tone }> = {
  idle: { label: "Idle", tone: "neutral" },
  thinking: { label: "Asking Jev", tone: "accent" },
  error: { label: "Error", tone: "bad" },
  offline: { label: "Offline", tone: "warn" },
};

function StatusBadge() {
  const { status, lastError } = useEngine(useShallow((s) => ({ status: s.status, lastError: s.lastError })));
  const s = STATUS[status] ?? STATUS.idle;
  return (
    <Badge tone={s.tone} title={lastError ?? undefined}>
      {status === "thinking" && <LoaderCircle className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />}
      {s.label}
    </Badge>
  );
}

function TabBar({ tab, onChange }: { tab: TabId; onChange: (t: TabId) => void }) {
  const refs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  // On phones the tab row scrolls sideways; keep the selected tab visible.
  useEffect(() => {
    refs.current[tab]?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [tab]);

  // Arrow keys move between tabs, as the WAI-ARIA tabs pattern expects.
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const i = TABS.findIndex((t) => t.id === tab);
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const id = TABS[next].id;
    onChange(id);
    refs.current[id]?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label="Inspector sections"
      onKeyDown={onKeyDown}
      className="flex gap-0.5 overflow-x-auto border-b border-neutral-200 px-3 dark:border-neutral-800"
    >
      {TABS.map((t) => {
        const selected = t.id === tab;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[t.id] = el;
            }}
            type="button"
            role="tab"
            id={`inspector-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`inspector-panel-${t.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(t.id)}
            className={clsx(
              "-mb-px shrink-0 border-b-2 px-2 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-violet-500",
              selected
                ? "border-violet-600 font-medium text-neutral-900 dark:border-violet-400 dark:text-neutral-50"
                : "border-transparent text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

export function Inspector() {
  const open = useEngine((s) => s.inspectorOpen);
  const setInspectorOpen = useEngine((s) => s.setInspectorOpen);
  const isTab = (t: string | null): t is TabId => TABS.some((x) => x.id === t);
  // The change feed can ask for a tab before this lazily loaded drawer exists.
  const [tab, setTab] = useState<TabId>(() => {
    const pending = takePendingInspectorTab();
    return isTab(pending) ? pending : "now";
  });
  useInspectorTabListener((t) => {
    if (isTab(t)) setTab(t);
  });
  const reduceMotion = useReducedMotion();
  const drawerRef = useRef<HTMLElement | null>(null);

  // Escape closes the drawer from anywhere. A handler that already used the
  // key (for example the command bar clearing itself) can preventDefault.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setInspectorOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setInspectorOpen]);

  // Move focus into the drawer on open and give it back on close.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    drawerRef.current?.focus({ preventScroll: true });
    return () => previous?.focus({ preventScroll: true });
  }, [open]);

  const Active = (TABS.find((t) => t.id === tab) ?? TABS[0]).Component;

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          key="inspector"
          ref={drawerRef}
          tabIndex={-1}
          aria-labelledby="inspector-title"
          initial={reduceMotion ? { opacity: 0 } : { x: "100%" }}
          animate={reduceMotion ? { opacity: 1 } : { x: 0 }}
          exit={reduceMotion ? { opacity: 0 } : { x: "100%" }}
          transition={{ type: "tween", duration: 0.22, ease: "easeOut" }}
          className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-neutral-200 bg-white text-neutral-900 shadow-2xl outline-none sm:w-[440px] dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-100"
        >
          <header className="flex items-center gap-3 px-4 pt-4 pb-3">
            <div className="min-w-0 flex-1">
              <h2 id="inspector-title" className="text-base font-semibold">
                Inspector
              </h2>
              <p className="text-xs text-neutral-500 dark:text-neutral-400">Why the layout changed</p>
            </div>
            <StatusBadge />
            <button
              type="button"
              onClick={() => setInspectorOpen(false)}
              aria-label="Close inspector"
              title="Close (Esc)"
              className="rounded-lg p-1.5 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 focus-visible:outline-2 focus-visible:outline-violet-500 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100"
            >
              <X className="h-5 w-5" aria-hidden />
            </button>
          </header>
          <TabBar tab={tab} onChange={setTab} />
          <div
            key={tab}
            role="tabpanel"
            id={`inspector-panel-${tab}`}
            aria-labelledby={`inspector-tab-${tab}`}
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
          >
            <Active />
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
