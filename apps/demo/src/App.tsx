/**
 * The whole app is one screen. There are no routes: the header, command bar,
 * suggestions, and canvas stay put while the canvas rearranges itself from
 * the engine's current layout plan.
 */
import { MotionConfig } from "motion/react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useEngine } from "./engine/store.ts";
import { AssistRow } from "./ui/AssistRow.tsx";
import { Canvas } from "./ui/Canvas.tsx";
import { CommandBar } from "./ui/CommandBar.tsx";
import { Dock } from "./ui/Dock.tsx";
import { Header } from "./ui/Header.tsx";
import { HelpHint } from "./ui/HelpHint.tsx";
import { Notice } from "./ui/Notice.tsx";
import { useHeldWhile, useWorkAnchorLive } from "./ui/linking.tsx";

// The inspector is a developer drawer most people never open; loading it on
// first open keeps the main bundle under Vite's 500 kB warning.
const Inspector = lazy(() => import("./inspector/Inspector.tsx").then((m) => ({ default: m.Inspector })));

function LazyInspector() {
  const open = useEngine((s) => s.inspectorOpen);
  const [loaded, setLoaded] = useState(open);
  useEffect(() => {
    if (open) setLoaded(true);
  }, [open]);
  if (!loaded && !open) return null;
  return (
    <Suspense fallback={null}>
      <Inspector />
    </Suspense>
  );
}

export function App() {
  // Density changes every gap and padding, which would shift the panel the
  // user is working in; it waits until the anchor is released.
  const density = useHeldWhile(
    useEngine((s) => s.plan.density),
    useWorkAnchorLive(),
  );

  return (
    // reducedMotion="user" turns off transform and layout animation for
    // people who ask their OS for less motion; components also check it.
    <MotionConfig reducedMotion="user">
      <div className="fl-density min-h-dvh bg-canvas text-ink" data-density={density}>
        <nav aria-label="Skip links" className="contents">
          <a
            href="#canvas-start"
            className="sr-only z-50 rounded-lg bg-surface px-3 py-2 text-sm font-medium text-ink shadow-pop focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
          >
            Skip to the workspace
          </a>
          <a
            href="#dock"
            className="sr-only z-50 rounded-lg bg-surface px-3 py-2 text-sm font-medium text-ink shadow-pop focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
          >
            Skip to the dock
          </a>
        </nav>
        <Header />
        <main className="mx-auto w-full max-w-[1600px] px-4 pt-4 pb-32 md:px-6">
          <h1 className="sr-only">Attune workspace</h1>
          <div className="flex flex-col gap-3">
            <CommandBar />
            {/* One line whatever it shows: the prep card, Up next, and the suggestions never push the canvas down. */}
            <AssistRow />
            <HelpHint />
            <div id="canvas-start" tabIndex={-1} className="outline-none">
              <Canvas />
            </div>
          </div>
        </main>
        <Dock />
        <Notice />
        <LazyInspector />
      </div>
    </MotionConfig>
  );
}

export default App;
