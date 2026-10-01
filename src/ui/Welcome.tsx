/**
 * Welcome screen shown on a visitor's first load: who built Attune, why it
 * exists (an AI-native interface instead of pages and menus), the rules the
 * adaptive layout follows, and a short tour. "Show it to me" closes it.
 *
 * Decisions:
 * - Shown once per browser. Closing it stores WELCOME_KEY in localStorage.
 *   `?welcome=1` in the URL shows it again; `?welcome=0` hides it. The
 *   header's About button reopens it any time (openWelcome), and closing it
 *   then puts focus back on that button.
 * - A first-time visitor reads to the end before they can continue: "Show it
 *   to me" stays disabled (aria-disabled, so it keeps focus and its hint) and
 *   Escape does nothing until the content has been scrolled to within
 *   READ_END_SLACK_PX of the bottom. Content that fits without scrolling
 *   counts as read. Reopening from About after that is never locked.
 *   `?welcome=1` shows the first-visit (locked) version, for previewing it.
 * - A progress bar on the dialog's top edge and a "keep reading" chip over
 *   the bottom fade show how much is left. The chip scrolls one screen.
 * - Automated browsers (navigator.webdriver: Playwright, agent-browser) skip
 *   it unless `?welcome=1` is set, so scripted checks of the workspace are
 *   not blocked by a dialog they do not expect.
 * - Mounted from main.tsx next to App, so the app shell is untouched. It
 *   renders in a portal on <body> and makes #root inert while open, so Tab,
 *   the pointer, and screen readers stay in the dialog.
 * - The app's one-key shortcuts (".", "n", "b", Escape, Cmd+K) listen on
 *   window. While open, a capture-phase listener keeps every keydown from
 *   reaching them; Escape closes the dialog the same way the button does
 *   (once it is unlocked).
 * - The product was renamed from Floouid to Attune. The `floouid:` storage and
 *   event keys keep the old prefix on purpose, so saved settings and the
 *   "seen" flag survive the rename.
 * - It logs no signal. The engine never sees it, so Jev's first snapshot
 *   starts from the visitor's first real action in the workspace.
 */
import clsx from "clsx";
import {
  Anchor,
  ArrowRight,
  ChevronDown,
  Compass,
  ExternalLink,
  Eye,
  Funnel,
  Hand,
  MessageCircleQuestionMark,
  ShieldCheck,
  SlidersHorizontal,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MOD_K, useLatest } from "./hooks.ts";

/** localStorage key set once the visitor closes the welcome screen. */
export const WELCOME_KEY = "floouid:welcome-seen";
/** URL parameter that forces the welcome screen on ("1") or off ("0"). */
export const WELCOME_PARAM = "welcome";

const WELCOME_OPEN_EVENT = "floouid:welcome-open";
/** Distance from the bottom, in px, that counts as having read to the end. */
const READ_END_SLACK_PX = 24;
/** How far the "keep reading" chip scrolls, as a share of the visible height. */
const READ_STEP = 0.8;

const GITHUB_URL = "https://github.com/dwamianm";
const LINKEDIN_URL = "https://www.linkedin.com/in/dwamian";

function welcomeParam(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(WELCOME_PARAM);
}

function hasSeen(): boolean {
  try {
    return window.localStorage.getItem(WELCOME_KEY) !== null;
  } catch {
    // Storage blocked (private mode, strict settings): every visit is a first one.
    return false;
  }
}

function shouldShowOnLoad(): boolean {
  if (typeof window === "undefined") return false;
  const forced = welcomeParam();
  if (forced === "1") return true;
  if (forced === "0") return false;
  if (navigator.webdriver) return false;
  return !hasSeen();
}

/** Open the welcome screen again, for example from the header's About button. */
export function openWelcome(): void {
  window.dispatchEvent(new Event(WELCOME_OPEN_EVENT));
}

function rememberSeen(): void {
  try {
    window.localStorage.setItem(WELCOME_KEY, new Date().toISOString());
  } catch {
    // Nothing to do: it shows again next time.
  }
}

const PROBLEMS_INTRO =
  "Finding the right tools, piecing together context, and keeping track of AI can become work of their own.";

const PROBLEMS: { title: string; body: string }[] = [
  {
    title: "You have to find the tools before you can use them.",
    body: "When an app is organized around its features, completing a task means knowing which menus, tabs, and pages to visit. You navigate the software before you can get on with your work.",
  },
  {
    title: "One task is scattered across screens.",
    body: "The overdue invoice, the client’s email, and the meeting about it live in different places. You move between them, carrying the connections in your head.",
  },
  {
    title: "Switching views can mean rebuilding your place.",
    body: "When filters, selections, or scroll positions reset, returning to a task means reconstructing the context you already had.",
  },
  {
    title: "Chat alone leaves too much to explain.",
    body: "Conversation is useful for expressing intent and exploring ideas. But choosing an item, comparing options, or adjusting a value can become cumbersome when you have to describe what a control or view could make clear.",
  },
  {
    title: "AI can create another queue to manage.",
    body: "Suggestions, notifications, and proposed changes all ask for attention. When they arrive without a clear connection to your current task, you have to sort through the AI’s output before it becomes useful.",
  },
  {
    title: "Delegated work can be hard to follow.",
    body: "When an agent acts without showing meaningful progress, changes, or points that need your input, you have to investigate what happened. Delegation becomes another thing to monitor.",
  },
  {
    title: "You’re expected to learn the software.",
    body: "You learn its menus, remember where things live, and fit your work into its structure. The interface should learn how you work: your intent, your habits, and what matters in the moment. It should bring what you need into view without making you learn where to find it.",
  },
];

/** Four steps of AI interfaces, worst to best. */
const LADDER: { title: string; body: string }[] = [
  { title: "Chatbox on top", body: "A chat window added to the same old app. Most AI features are here." },
  { title: "Helpful assistant", body: "The AI drafts and suggests. You still do and check every step." },
  { title: "Supervised", body: "The AI proposes real actions with its evidence, sorted by what matters." },
  { title: "Trusted with rules", body: "You set clear rules, the AI handles the routine, and undo is plain." },
];

const FEATURES: { title: string; body: string }[] = [
  { title: "The right panels", body: "Brings in the panels your work needs and puts the rest in the dock." },
  { title: "The right layout", body: "Picks Focus, Compare, or Overview for what you are doing." },
  { title: "Next step", body: "Suggests the next action, and Up next offers the record you will likely open." },
  { title: "Back to", body: "Takes you back to earlier work, filters and all, in one click." },
  { title: "Plain words", body: `Press ${MOD_K} and ask, for example "who still owes us money?"` },
  { title: "Help when stuck", body: "Offers a tip, or brings in a guide, when you seem lost." },
];

// Each rule is stated as what Attune actually does today. A rule against
// showing confidence scores is left out on purpose: the header and Up next
// still show Jev's percentages.
const RULES: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Funnel,
    title: "Think broadly, show little.",
    body: "Jev weighs every panel and up to 12 likely next records. You see a few panels, one Up next card, and one next step.",
  },
  {
    icon: Anchor,
    title: "The furniture stays put.",
    body: "The header, command bar, and dock never move. The panel you clicked holds still, and the rest changes at most once every 2.5 seconds.",
  },
  {
    icon: ShieldCheck,
    title: "Match caution to the stakes.",
    body: "Layout changes are easy to undo, so they just happen, with a record. Real actions, like sending a reminder, always wait for your click.",
  },
  {
    icon: Hand,
    title: "When unsure, it does nothing.",
    body: "If Jev is not confident, the layout and suggestions stay as they are.",
  },
  {
    icon: MessageCircleQuestionMark,
    title: "Every change says why.",
    body: 'Each panel has "Why here?". Shared colors and "Linked to" tags show how a new panel relates to your click.',
  },
  {
    icon: Undo2,
    title: "Undo in plain terms.",
    body: 'Undo is one click. "Back to" returns you to earlier work by name, with its filters and selections.',
  },
  {
    icon: SlidersHorizontal,
    title: "You stay in charge.",
    body: "Pin, dock, or make a panel bigger, and your choice wins. Freeze the layout or switch Adaptive off at any time.",
  },
  {
    icon: Compass,
    title: "Nothing is out of reach.",
    body: "Every panel stays one click away in the dock, and the command bar finds what Jev did not pick.",
  },
];

const TOUR: ReactNode[] = [
  <>
    In <b>Invoices</b>, filter to Overdue and open an invoice. The panel stays still while linked panels arrive.
  </>,
  <>
    Press <Kbd>{MOD_K}</Kbd> and type "who still owes us money?"
  </>,
  <>
    Send a reminder on two overdue invoices, then press <Kbd>n</Kbd> to open the next one.
  </>,
  <>
    Click around in Calendar and Tasks, then press <Kbd>b</Kbd> to go back to your invoices.
  </>,
  <>
    Open the <b>Inspector</b> (top right) to see what Jev was asked and why the layout changed.
  </>,
];

const GOOD_TO_KNOW: string[] = [
  'All data is invented. "Fernhill Studio" is a fictional six-person design studio.',
  "Actions change demo data in memory only. Nothing is really sent, paid, or emailed, and a reload resets it.",
  'The dot in the header shows who is answering: "Live with Jev", or "Offline with heuristic" when no API key is set.',
  "The goal is to give attention back: less hunting for things, not more time in the app. The Inspector's Metrics tab counts navigation per 10 actions.",
  "It is a prototype, so expect rough edges.",
];

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="rounded-md border border-line-strong bg-surface-2 px-1.5 py-px font-mono text-[0.85em] text-ink">
      {children}
    </kbd>
  );
}

function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={clsx("shrink-0", className)} aria-hidden>
      <rect x="1" y="1" width="22" height="22" rx="6" fill="var(--color-accent)" />
      <rect x="5" y="5" width="8" height="14" rx="2.2" fill="var(--color-accent-fg)" />
      <rect x="15" y="5" width="4" height="6" rx="1.6" fill="var(--color-accent-fg)" opacity="0.75" />
      <rect x="15" y="13" width="4" height="6" rx="1.6" fill="var(--color-accent-fg)" opacity="0.5" />
    </svg>
  );
}

function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

/** Two tiny screens: pages with tabs, and one canvas arranged around a click. */
function PagesVsCanvas() {
  return (
    <div className="grid grid-cols-2 gap-3">
      <figure className="flex flex-col gap-2">
        <div aria-hidden className="flex aspect-[4/3] flex-col gap-1.5 rounded-xl border border-line bg-surface-2 p-2">
          <div className="flex gap-1">
            {[0, 1, 2, 3].map((i) => (
              <span key={i} className={clsx("h-2 flex-1 rounded-full", i === 1 ? "bg-ink-3" : "bg-line-strong")} />
            ))}
          </div>
          <div className="flex-1 rounded-md border border-line bg-surface" />
        </div>
        <figcaption className="text-xs leading-snug text-ink-2">
          <span className="font-medium text-ink">Today:</span> you go to the work, one page at a time.
        </figcaption>
      </figure>
      <figure className="flex flex-col gap-2">
        <div
          aria-hidden
          className="grid aspect-[4/3] grid-cols-3 grid-rows-3 gap-1.5 rounded-xl border border-line bg-surface-2 p-2"
        >
          <div className="col-span-2 row-span-2 rounded-md border-2 border-accent bg-accent-soft" />
          <div className="rounded-md border border-link bg-link-soft" />
          <div className="rounded-md border border-link bg-link-soft" />
          <div className="rounded-md border border-line bg-surface" />
          <div className="rounded-md border border-link bg-link-soft" />
          <div className="rounded-md border border-line bg-surface" />
        </div>
        <figcaption className="text-xs leading-snug text-ink-2">
          <span className="font-medium text-ink">Attune:</span> the work comes to you, around what you clicked.
        </figcaption>
      </figure>
    </div>
  );
}

function Ladder() {
  return (
    <div className="rounded-card border border-line bg-surface-2 p-4">
      <p className="text-sm font-semibold text-ink">The ladder, from worst to best</p>
      <ol className="mt-3 flex flex-col gap-2.5">
        {LADDER.map((step, i) => (
          <li key={step.title} className="flex gap-3 text-sm leading-relaxed">
            <span
              className={clsx(
                "grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold tabular-nums",
                i === 0 ? "bg-bad-soft text-bad-ink" : "bg-accent-soft text-accent-text",
              )}
            >
              {i + 1}
            </span>
            <p className="text-ink-2">
              <span className="font-medium text-ink">{step.title}.</span> {step.body}
            </p>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs leading-relaxed text-ink-3">
        Pick your step on purpose, and do not slide back to step 1 by accident. Attune is built to climb past it.
      </p>
    </div>
  );
}

function Section({ eyebrow, title, children }: { eyebrow: string; title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <p className="text-xs font-semibold tracking-wide text-accent-text uppercase">{eyebrow}</p>
        <h3 className="text-lg font-semibold tracking-tight text-ink sm:text-xl">{title}</h3>
      </div>
      {children}
    </section>
  );
}

function OutLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-sm font-medium text-ink transition-colors hover:border-line-strong hover:bg-surface-2"
    >
      {children}
    </a>
  );
}

export function Welcome() {
  const [open, setOpen] = useState(shouldShowOnLoad);
  // Locked until a first-time visitor has scrolled to the end.
  const [locked, setLocked] = useState(() => welcomeParam() === "1" || !hasSeen());
  const [atEnd, setAtEnd] = useState(false);
  // Said once to screen readers when reading to the end unlocks the button.
  const [unlockNote, setUnlockNote] = useState("");
  const lockedRef = useLatest(locked);
  const reduceMotion = useReducedMotion() ?? false;
  const titleRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const leadId = useId();
  const hintId = useId();

  const close = () => {
    if (locked) return;
    rememberSeen();
    setOpen(false);
  };
  const closeRef = useLatest(close);
  // The element that had focus when openWelcome() ran (the About button).
  const openerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const onOpen = () => {
      openerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setLocked(!hasSeen());
      setAtEnd(false);
      setUnlockNote("");
      setOpen(true);
    };
    window.addEventListener(WELCOME_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(WELCOME_OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!open) return;
    const root = document.getElementById("root");
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    root?.setAttribute("inert", "");
    html.style.overflow = "hidden";
    titleRef.current?.focus({ preventScroll: true });

    // Capture phase on window runs before every app shortcut listener.
    // stopPropagation keeps them from firing; default actions (Tab, Enter
    // on a button, scrolling keys) still happen.
    const onKey = (e: KeyboardEvent) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      root?.removeAttribute("inert");
      html.style.overflow = prevOverflow;
      const opener = openerRef.current;
      openerRef.current = null;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [open]);

  // Reading progress. The bar is written through a CSS variable, so a scroll
  // never re-renders the dialog; state changes only when "at the end" flips.
  // Layout effect: the bar is sized before the first paint.
  useLayoutEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const max = el.scrollHeight - el.clientHeight;
      const progress = max <= 0 ? 1 : Math.min(1, Math.max(0, el.scrollTop / max));
      barRef.current?.style.setProperty("--fl-read", String(progress));
      const end = max - el.scrollTop <= READ_END_SLACK_PX;
      setAtEnd(end);
      if (end && lockedRef.current) {
        setLocked(false);
        setUnlockNote("You reached the end. Show it to me is ready.");
      }
    };
    measure();
    el.addEventListener("scroll", measure, { passive: true });
    // A resize (window, fonts, a wrapped line) can bring the end into view.
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [open]);

  const readMore = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ top: el.clientHeight * READ_STEP, behavior: reduceMotion ? "auto" : "smooth" });
  };

  // The wrapper goes inert the moment the dialog closes, so the workspace
  // takes clicks at once, even while (or if) the exit fade is still running.
  return createPortal(
    <div inert={!open} className={clsx(!open && "pointer-events-none")}>
      <AnimatePresence>
        {open ? (
          <motion.div
            key="welcome"
            className="fixed inset-0 z-[70] flex items-center justify-center p-2 sm:p-5 lg:p-8"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.2 } }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
          >
            <div aria-hidden className="absolute inset-0 bg-canvas/75 backdrop-blur-sm" />
            <motion.div
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={leadId}
              className="relative flex h-full max-h-[1000px] w-full max-w-6xl flex-col overflow-hidden rounded-[20px] border border-line bg-surface shadow-pop"
              initial={reduceMotion ? false : { opacity: 0, y: 14, scale: 0.985 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.99, transition: { duration: 0.18 } }}
              transition={{ type: "spring", stiffness: 320, damping: 32 }}
            >
              <div aria-hidden className="absolute inset-x-0 top-0 z-10 h-1">
                <div
                  ref={barRef}
                  className="h-full origin-left bg-accent"
                  style={{ transform: "scaleX(var(--fl-read, 0))" }}
                />
              </div>
              <div className="relative flex min-h-0 flex-1 flex-col">
                <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                  <div>
                    {/* Intro */}
                    <div className="grid gap-8 border-b border-line bg-linear-to-b from-accent-soft/60 to-surface px-5 pt-6 pb-8 sm:px-8 sm:pt-8 lg:grid-cols-[1.25fr_1fr] lg:items-center lg:gap-12 lg:px-12 lg:pt-12 lg:pb-12">
                      <div className="flex flex-col gap-5">
                        <div className="flex items-center gap-2">
                          <Logo className="size-6" />
                          <span className="text-[15px] font-semibold tracking-tight text-ink">Attune</span>
                          <span className="rounded-full border border-accent/30 bg-surface px-2 py-0.5 text-2xs font-medium text-accent-text">
                            Prototype
                          </span>
                        </div>
                        <h2
                          id={titleId}
                          ref={titleRef}
                          tabIndex={-1}
                          className="text-3xl font-semibold tracking-tight text-ink outline-none sm:text-4xl"
                        >
                          Welcome to Attune.
                        </h2>
                        <p id={leadId} className="max-w-xl text-base leading-relaxed text-ink-2 sm:text-lg">
                          Attune is an AI-native, Adaptive UI library by Dwamian McLeish. Built for zero navigation, it
                          shapes the interface around your work, bringing what you need into view as you need it. And
                          when an AI agent acts on your behalf, its actions and progress stay visible.
                        </p>
                        <div className="flex flex-wrap gap-2">
                          <OutLink href={GITHUB_URL}>
                            <GitHubMark className="size-4" />
                            GitHub
                          </OutLink>
                          <OutLink href={LINKEDIN_URL}>
                            <ExternalLink className="size-4" aria-hidden />
                            LinkedIn
                          </OutLink>
                        </div>
                      </div>
                      <PagesVsCanvas />
                    </div>

                    <div className="flex flex-col gap-12 px-5 py-8 sm:px-8 lg:px-12 lg:py-12">
                      <div className="grid gap-12 lg:grid-cols-2 lg:gap-14">
                        <Section eyebrow="The idea" title="A truly AI-native interface">
                          <div className="flex flex-col gap-3 text-[15px] leading-relaxed text-ink-2">
                            <p>
                              AI does not save work by default. It moves the work around. Done badly, it does the easy
                              part and hands you the hard part: checking whether it got it right.
                            </p>
                            <p>
                              What people run out of is not clicks or screens. It is{" "}
                              <span className="font-medium text-ink">attention</span>. So Attune spends your attention
                              only on what is worth it, and makes everything easy to undo, so acting is not scary.
                            </p>
                            <p>
                              So in Attune the AI does not sit in a box beside the app. It is woven into the interface.
                              It reads what you do, understands the task, and shapes the screen around it: what to show,
                              what to put away, and what comes next.
                            </p>
                          </div>
                          <Ladder />
                        </Section>

                        <Section eyebrow="The problem" title="Software asks for too much of your attention">
                          <p className="text-[15px] leading-relaxed text-ink-2">{PROBLEMS_INTRO}</p>
                          <ul className="flex flex-col gap-3">
                            {PROBLEMS.map((p) => (
                              <li key={p.title} className="flex gap-3 text-[15px] leading-relaxed">
                                <span aria-hidden className="mt-2.5 size-1.5 shrink-0 rounded-full bg-bad" />
                                <p className="text-ink-2">
                                  <span className="font-medium text-ink">{p.title}</span> {p.body}
                                </p>
                              </li>
                            ))}
                          </ul>
                        </Section>
                      </div>

                      <Section eyebrow="The solution" title="One canvas that adapts to you">
                        <p className="max-w-3xl text-[15px] leading-relaxed text-ink-2">
                          Attune has no pages. Every part of a small studio app (invoices, inbox, calendar, tasks,
                          clients, and more) is a panel on one canvas. As you click, search, filter, or type a request,
                          the canvas rearranges itself around your work.
                        </p>
                        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {FEATURES.map((f) => (
                            <li key={f.title} className="rounded-card border border-line bg-surface-2 p-4">
                              <p className="text-sm font-semibold text-ink">{f.title}</p>
                              <p className="mt-1 text-sm leading-relaxed text-ink-2">{f.body}</p>
                            </li>
                          ))}
                        </ul>
                        <div className="grid gap-3 lg:grid-cols-2">
                          <div className="rounded-card border border-accent/25 bg-accent-soft p-4 text-sm leading-relaxed text-ink sm:p-5">
                            <p className="font-semibold">How it decides</p>
                            <p className="mt-1 text-ink-2">
                              Two parts share the work. <span className="font-medium text-ink">Jev</span>, TypeSafe's
                              System One model, makes the judgments: what you are trying to do, which panels help,
                              whether you are stuck, and what you will likely do next.{" "}
                              <span className="font-medium text-ink">Plain code</span> makes every layout decision, with
                              fixed weights, thresholds, and limits you can see in the Inspector. Jev never places a
                              panel.
                            </p>
                          </div>
                          <div className="rounded-card border border-link/30 bg-link-soft p-4 text-sm leading-relaxed text-ink sm:p-5">
                            <p className="flex items-center gap-1.5 font-semibold">
                              <Eye className="size-4 text-link-text" aria-hidden />
                              AI-agent-aware
                            </p>
                            <p className="mt-1 text-ink-2">
                              When an AI agent acts on your behalf, you should see the work being done, not trust a
                              black box. Attune is designed so an agent works in the open, on the same screen you use:
                              each step shows as it happens, says why, and can be undone, and anything hard to undo
                              still waits for you. In this demo the agent is Jev arranging your workspace. Every change
                              it makes is on screen and explained, and the Inspector shows exactly what Jev was asked.
                            </p>
                          </div>
                        </div>
                      </Section>

                      <Section eyebrow="The rules" title="What the interface promises">
                        <p className="max-w-3xl text-[15px] leading-relaxed text-ink-2">
                          Each rule applies that one idea, attention first and easy undo, to a specific moment.
                        </p>
                        <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                          {RULES.map((r, i) => (
                            <li
                              key={r.title}
                              className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4 shadow-card"
                            >
                              <div className="flex items-center gap-2">
                                <span className="grid size-7 place-items-center rounded-lg bg-accent-soft text-accent-text">
                                  <r.icon className="size-4" aria-hidden />
                                </span>
                                <span className="text-2xs font-medium text-ink-3 tabular-nums">Rule {i + 1}</span>
                              </div>
                              <p className="text-sm font-semibold text-ink">{r.title}</p>
                              <p className="text-sm leading-relaxed text-ink-2">{r.body}</p>
                            </li>
                          ))}
                        </ol>
                      </Section>

                      <div className="grid gap-12 lg:grid-cols-2 lg:gap-14">
                        <Section eyebrow="Try this" title="A two-minute tour">
                          <ol className="flex flex-col gap-3">
                            {TOUR.map((step, i) => (
                              <li key={i} className="flex gap-3 text-[15px] leading-relaxed text-ink-2">
                                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-fg tabular-nums">
                                  {i + 1}
                                </span>
                                <p className="min-w-0 [&_b]:font-medium [&_b]:text-ink">{step}</p>
                              </li>
                            ))}
                          </ol>
                          <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-ink-2">
                            <span className="font-medium text-ink">Shortcuts:</span>
                            <span>
                              <Kbd>{MOD_K}</Kbd> ask
                            </span>
                            <span>
                              <Kbd>.</Kbd> take the suggestion
                            </span>
                            <span>
                              <Kbd>n</Kbd> up next
                            </span>
                            <span>
                              <Kbd>b</Kbd> back to
                            </span>
                            <span>
                              <Kbd>Esc</Kbd> clear links
                            </span>
                          </p>
                        </Section>

                        <Section eyebrow="Good to know" title="Before you start">
                          <ul className="flex flex-col gap-3">
                            {GOOD_TO_KNOW.map((line) => (
                              <li key={line} className="flex gap-3 text-[15px] leading-relaxed text-ink-2">
                                <span aria-hidden className="mt-2.5 size-1.5 shrink-0 rounded-full bg-ink-3" />
                                <p>{line}</p>
                              </li>
                            ))}
                          </ul>
                        </Section>
                      </div>
                    </div>
                  </div>
                </div>
                <AnimatePresence>
                  {atEnd ? null : (
                    <motion.div
                      key="more"
                      className="pointer-events-none absolute inset-x-0 bottom-0 flex h-28 items-end justify-center bg-linear-to-t from-surface via-surface/80 to-transparent pb-4"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: reduceMotion ? 0 : 0.2 }}
                    >
                      <button
                        type="button"
                        onClick={readMore}
                        className="pointer-events-auto inline-flex h-9 items-center gap-1.5 rounded-full border border-line bg-surface px-3.5 text-sm font-medium text-ink shadow-pop transition-colors hover:bg-surface-2"
                      >
                        <motion.span
                          aria-hidden
                          className="grid"
                          animate={reduceMotion ? undefined : { y: [0, 3, 0] }}
                          transition={{ duration: 1.4, repeat: Infinity, ease: "easeInOut" }}
                        >
                          <ChevronDown className="size-4 text-accent-text" />
                        </motion.span>
                        {locked ? "Scroll to the end to continue" : "Scroll for more"}
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              <div className="flex shrink-0 flex-col-reverse gap-3 border-t border-line bg-surface px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-8 lg:px-12">
                <p className="text-center text-xs text-ink-3 sm:text-left">
                  A prototype by Dwamian McLeish ·{" "}
                  <a
                    href={GITHUB_URL}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-ink-2 underline-offset-2 hover:text-ink hover:underline"
                  >
                    github.com/dwamianm
                  </a>
                </p>
                <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:gap-3">
                  {locked ? (
                    <p id={hintId} className="text-center text-xs text-ink-3 sm:text-right">
                      Read to the end to continue
                    </p>
                  ) : null}
                  <button
                    type="button"
                    onClick={close}
                    aria-disabled={locked}
                    aria-describedby={locked ? hintId : undefined}
                    className={clsx(
                      "inline-flex h-11 items-center justify-center gap-2 rounded-xl px-5 text-[15px] font-semibold transition-colors",
                      locked
                        ? "cursor-not-allowed bg-surface-3 text-ink-3"
                        : "bg-accent text-accent-fg shadow-card hover:bg-accent-hover",
                    )}
                  >
                    Show it to me
                    <ArrowRight className="size-4" aria-hidden />
                  </button>
                </div>
                <p className="sr-only" aria-live="polite">
                  {unlockNote}
                </p>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>,
    document.body,
  );
}
