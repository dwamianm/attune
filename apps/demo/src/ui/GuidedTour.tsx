import { ArrowLeft, ArrowRight, Check, Compass, LocateFixed, X } from "lucide-react";
import { useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { PanelId } from "../../shared/catalog.ts";
import { useEngine } from "../engine/store.ts";
import { appBarSelector, itemSelector, panelSelector } from "./domHooks.ts";
import { GUIDE_START_EVENT, GUIDE_STORAGE_KEY } from "./guideEvents.ts";

const STEPS = [
  { title: "Start with the work", panel: "inbox", target: itemSelector("message", "m-1"), instruction: "Open Priya’s message about invoice INV-1042 in Inbox." },
  { title: "Notice the context", panel: "invoices", target: panelSelector("invoices"), instruction: "Look for the related Harbor invoice and the links between panels." },
  { title: "Follow the connection", panel: "invoices", target: itemSelector("invoice", "INV-1042"), instruction: "Open Harbor Coffee Co.’s invoice INV-1042." },
  { title: "You choose the action", panel: "invoices", target: '[data-guide-resend="INV-1042"]', instruction: "Choose Resend on INV-1042. This only updates the sample data." },
  { title: "Finish the follow-up", panel: "tasks", target: `${itemSelector("task", "t-1")} input`, instruction: "Check off “Resend INV-1042 to Harbor accounts team” in Tasks." },
  { title: "Make it work for you", target: '[aria-label="Focus settings"]', instruction: "Keep exploring, or open Focus to choose how much the workspace adapts." },
] satisfies { title: string; panel?: PanelId; target: string; instruction: string }[];

/**
 * A non-modal guide through the real demo. It observes selections and data,
 * never fabricates a model response or performs an invoice/task action.
 * Advancing is explicit so an asynchronous relayout cannot race the reader.
 */
export function GuidedTour() {
  const [active, setActive] = useState(false);
  const [step, setStep] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const card = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const target = useRef<HTMLElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const reducedMotion = useReducedMotion() ?? false;
  const { message, invoice, resent, taskDone, links, source, status, adaptive, behavior } = useEngine(useShallow((s) => ({
    message: s.view.inbox.selectedId,
    invoice: s.view.invoices.selectedId,
    resent: Boolean(s.data.invoices.find((i) => i.id === "INV-1042")?.resentAt),
    taskDone: Boolean(s.data.tasks.find((t) => t.id === "t-1")?.done),
    links: Boolean(s.links?.relations.invoices),
    source: s.last?.source,
    status: s.status,
    adaptive: s.settings.adaptive,
    behavior: s.settings.layoutBehavior,
  })));
  const current = STEPS[step]!;
  const ready = step === 0 ? message === "m-1" : step === 2 ? invoice === "INV-1042" : step === 3 ? resent : step === 4 ? taskDone : true;

  function prepare(index: number) {
    const s = useEngine.getState();
    const panel = STEPS[index]?.panel;
    // These are the user's explicit Next/Show-me navigation requests. They
    // expose the sample, but never change task completion or invoice data.
    if (index === 0) s.setView("inbox", { query: "", client: null });
    if (index === 2) s.setView("invoices", { status: "all", client: null });
    if (index === 4) s.setView("tasks", { client: null, showDone: true });
    if (panel && index !== 1) {
      const p = s.plan.placements.find((p) => p.id === panel);
      if (!p) s.open(panel);
      else if (p.size === "compact") s.maximize(panel);
    }
  }

  useEffect(() => {
    const start = () => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setStep(0);
      setActive(true);
      prepare(0);
      requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
    };
    window.addEventListener(GUIDE_START_EVENT, start);
    return () => window.removeEventListener(GUIDE_START_EVENT, start);
  }, []);

  useEffect(() => {
    if (!active) return;
    if (body.current) body.current.scrollTop = 0;
    heading.current?.focus({ preventScroll: true });
    const update = () => {
      const next = document.querySelector<HTMLElement>(current.target);
      if (next === target.current) return;
      target.current?.removeAttribute("data-guide-highlight");
      target.current = next;
      next?.setAttribute("data-guide-highlight", "");
    };
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.getElementById("root")!, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      target.current?.removeAttribute("data-guide-highlight");
      target.current = null;
    };
  }, [active, current.target]);

  useEffect(() => {
    if (!active) return;
    const bar = document.querySelector<HTMLElement>(appBarSelector());
    const update = () => {
      card.current?.style.setProperty("--guide-top", `${(bar?.offsetHeight ?? 56) + 8}px`);
      document.documentElement.style.setProperty("--guide-offset", `${(bar?.offsetHeight ?? 56) + (card.current?.offsetHeight ?? 200) + 24}px`);
    };
    const observer = new ResizeObserver(update);
    if (bar) observer.observe(bar);
    if (card.current) observer.observe(card.current);
    update();
    return () => { observer.disconnect(); document.documentElement.style.removeProperty("--guide-offset"); };
  }, [active]);

  function move(index: number) {
    prepare(index);
    setStep(index);
  }

  function finish(completed: boolean) {
    if (completed) {
      try { localStorage.setItem(GUIDE_STORAGE_KEY, new Date().toISOString()); } catch { /* Optional browser storage. */ }
    }
    setActive(false);
    requestAnimationFrame(() => {
      const button = document.querySelector<HTMLElement>('[data-start-guide]');
      (opener.current?.isConnected ? opener.current : button)?.focus({ preventScroll: true });
    });
  }

  function reveal() {
    prepare(step);
    if (step === 1 && !document.querySelector(current.target)) useEngine.getState().open("invoices");
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(current.target) ?? (current.panel ? document.querySelector<HTMLElement>(panelSelector(current.panel)) : null);
      el?.scrollIntoView({ block: "center", behavior: reducedMotion ? "instant" : "smooth" });
      if (el?.matches("button, input, [tabindex]")) el.focus({ preventScroll: true });
    });
  }

  if (!active) return null;
  const explanations = [
    "Each panel is a tool in the same workspace. This message asks you to resend an invoice. Start by reading it, just as you would during your day.",
    !adaptive ? "You have adaptation off, so the arrangement stays fixed. The same records remain available through the panels and dock. You can enable adaptation in Focus to compare the experience."
      : behavior === "suggestions" ? "Suggestions only keeps the arrangement you chose. Assistance can update while you use the same panel controls to bring related work into view."
      : links ? `The highlighted records belong to the message you opened. Code knows which records are related; ${source === "heuristic" ? "demo rules are judging" : "the model helps judge"} what is useful. Your current panel holds its place while the workspace adapts.`
      : status === "thinking" ? "Attune is considering your recent activity. When a useful connection is found, related panels can appear beside your work. You can also open Invoices yourself without waiting."
      : "Attune uses your activity to decide what could help next. Related records can be highlighted and brought into view, while your current panel holds its place. You can always open a panel yourself.",
    "The invoice and the message share a client and invoice number. You can follow that connection here without opening a separate page and rebuilding the context.",
    "The interface can suggest a next step, but you decide when to act. Resend is a demo action: it records a timestamp here and sends no email. Layout Undo changes the arrangement, not invoice actions.",
    "The related task closes the loop between the request and your work. Check it off after resending the invoice. Your selections stay in their panels as you move between tools.",
    "Pin a panel to keep it available, use Undo after a layout change, or choose Suggestions only in Focus. Density is your preference. When you switch tasks, Back to can restore saved work with its filters and selections.",
  ];
  return (
    <section ref={card} aria-label="Guided walkthrough" data-guide-card className="fl-guide sticky z-20 flex flex-col rounded-xl border border-accent/30 bg-surface p-4 shadow-card sm:px-5" style={{ top: "var(--guide-top, 4rem)" }} onKeyDown={(e) => { e.stopPropagation(); if (e.key === "Escape") { e.preventDefault(); finish(false); } }}>
      <div className="flex shrink-0 items-center gap-2 text-xs font-medium text-accent-text">
        <Compass className="size-4" aria-hidden />
        <span>Guide me</span><span className="text-ink-3">{step + 1} of {STEPS.length}</span>
        <button type="button" onClick={() => finish(false)} className="ml-auto flex items-center gap-1 rounded-lg px-2 py-1 text-ink-2 hover:bg-surface-2" aria-label="End walkthrough">End tour <X className="size-3.5" aria-hidden /></button>
      </div>
      <div ref={body} className="mt-2 min-h-0 overflow-y-auto">
        <div className="grid gap-3 md:grid-cols-[1fr_1fr] md:gap-8">
          <div>
            <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold tracking-tight outline-none" aria-live="polite">{current.title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-ink-2">{explanations[step]}</p>
          </div>
          <div className="flex flex-col justify-between gap-3">
            <p className="text-sm font-medium text-ink">{current.instruction}</p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={reveal} className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-2.5 text-xs font-medium hover:bg-surface-2"><LocateFixed className="size-3.5" aria-hidden />Show me where</button>
              <span className="text-xs text-ink-2" role="status">{ready && [0, 2, 3, 4].includes(step) ? <span className="inline-flex items-center gap-1 text-good"><Check className="size-3.5" aria-hidden />{step === 3 ? "Invoice resent" : step === 4 ? "Task complete" : "Opened"}</span> : null}</span>
            </div>
          </div>
        </div>
        <p className="mt-3 text-xs text-ink-3">{source === "heuristic" ? "Using demo rules. With a connected model, suggestions can differ." : "Sample studio data. Nothing is sent or paid."}</p>
      </div>
      <div className="mt-3 flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line pt-3">
        {step > 0 && <button type="button" onClick={() => move(step - 1)} className="inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium hover:bg-surface-2"><ArrowLeft className="size-3.5" aria-hidden />Back</button>}
        {!ready && <button type="button" onClick={() => move(step + 1)} className="h-8 rounded-lg px-2 text-xs text-ink-2 hover:bg-surface-2">Skip step</button>}
        <button type="button" disabled={!ready} onClick={() => step === STEPS.length - 1 ? finish(true) : move(step + 1)} className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-3 text-sm font-semibold text-accent-fg hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40">{step === STEPS.length - 1 ? "Keep exploring" : "Continue"}<ArrowRight className="size-4" aria-hidden /></button>
      </div>
    </section>
  );
}
