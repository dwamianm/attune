/**
 * The row under the command bar: the meeting prep card (focus aid 4), the
 * Done card or Up next, and the suggested next steps, on one line whose
 * height never changes, so nothing above the canvas moves while the user
 * works (docs/anchored-relayout.md, "Canvas top stays put").
 *
 * The priority order and the fitting are pure (./assistFit.ts): lower cards
 * become pills (icon, short label, key hint, and a dismiss) first, then the
 * most time-sensitive card, first on the row, takes its shorter form, and
 * what still has no room waits in "+N", a small list that shows those cards
 * in full. This file measures and
 * renders. Every card is also rendered, invisible and inert, in a measuring
 * layer in its full and compact forms; a layout effect and a ResizeObserver
 * read those widths and the row's, and fitRow picks the forms. The measuring
 * layer never depends on that choice, so there is no loop, and state is set
 * only when a width changed. A card that appears is measured before it is
 * painted, so it never shows in one form and then jumps to another.
 *
 * The keys ("p", "n", ".") belong to the hooks called once here, so they
 * work whether a card shows in full, as a pill, or in "+N". The "+N" list is
 * a small dialog (usePopover): focus goes to its first button, Escape or a
 * press outside closes it and puts focus back on "+N", and tabbing out of it
 * closes it.
 */
import clsx from "clsx";
import { ChevronDown, X, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion, type Variants } from "motion/react";
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { assistSlots, FIT_SLACK_PX, fitRow, type AssistKind, type FitItem, type FitMode, type RowFit } from "./assistFit.ts";
import { usePopover } from "./hooks.ts";
import { useMeetingPrepEntry } from "./MeetingPrep.tsx";
import { NextStepLabel, useSuggestionEntries } from "./SuggestionBar.tsx";
import { useUpNextEntry } from "./UpNext.tsx";

export type Via = "pointer" | "keyboard";
export type AssistTone = "link" | "good" | "accent" | "muted" | "primary" | "subtle";

export interface AssistAction {
  /** The button's words in the "+N" list: "Open", "Start", "Not now". */
  label: string;
  /** Its accessible name, which holds the words it shows (on a pill, the card's `short`). */
  name: string;
  title?: string;
  run: (via: Via) => void;
}

/** One card on the row, as the hooks describe it: its full card, and what the pill and the "+N" list need. */
export interface AssistEntry {
  /** The slot id from assistSlots ("prep", "up-next"), or the suggestion's key. */
  id: string;
  /** Changes when it is another card in the same slot (another record, another stage), so the new one fades in. */
  motionKey: string;
  kind: Exclude<AssistKind, "label" | "hint">;
  /** A suggestion's prominence: true for the primary one. */
  prominent?: boolean;
  /** The group's accessible name: "Up next", "Task done". */
  group: string;
  icon: LucideIcon;
  tone: AssistTone;
  /** The whole line: the heading in the "+N" list. */
  text: string;
  /** Small print under it in the list: the reason, the probability, what comes next. */
  detail?: string;
  /** The tip on the pill: what the pill leaves out. */
  tip: string;
  /** The pill's words. */
  short: string;
  /** Its key, shown on the pill and on the list's button. */
  hotkey?: "p" | "n" | ".";
  /** What the pill (and the key) does. A card without one has no pill: it goes from full straight to "+N". */
  primary?: AssistAction;
  /** More buttons in the list (Up next's alternatives). */
  others?: AssistAction[];
  dismiss?: AssistAction;
  /** The full card on the row. */
  full: ReactNode;
  /** A shorter card with fewer words, for when this card is first on a crowded row (the first card is never a pill). */
  narrow?: ReactNode;
}

/** Tailwind's gap-2, the space between two things on the row. */
const GAP_PX = 8;
/** The least room the empty state ("Suggestions show up here", the examples) takes after "Next step"; with less, both give way. */
const HINT_MIN_PX = 160;

const TONE: Record<AssistTone, { pill: string; press: string; icon: string; divider: string; kbd: string; button: string; buttonKbd: string; listIcon: string }> = {
  link: {
    pill: "border border-link/35 bg-link-soft text-ink",
    press: "hover:bg-link/10",
    icon: "text-link-text",
    divider: "border-link/25",
    kbd: "border-link/35 text-link-text",
    button: "bg-link text-link-fg hover:opacity-90",
    buttonKbd: "border-white/35",
    listIcon: "text-link-text",
  },
  good: {
    pill: "border border-good/35 bg-good-soft text-ink",
    press: "hover:bg-good/10",
    icon: "text-good-ink",
    divider: "border-good/25",
    kbd: "border-good/35 text-good-ink",
    button: "bg-accent text-accent-fg hover:bg-accent-hover",
    buttonKbd: "border-white/35",
    listIcon: "text-good-ink",
  },
  accent: {
    pill: "border border-accent/35 bg-accent-soft text-ink",
    press: "hover:bg-accent/10",
    icon: "text-accent-text",
    divider: "border-accent/25",
    kbd: "border-accent/35 text-accent-text",
    button: "bg-accent text-accent-fg hover:bg-accent-hover",
    buttonKbd: "border-white/35",
    listIcon: "text-accent-text",
  },
  muted: {
    pill: "border border-line bg-surface-2 text-ink-2",
    press: "hover:bg-surface-3 hover:text-ink",
    icon: "text-accent-text",
    divider: "border-line",
    kbd: "border-line text-ink-3",
    button: "border border-line bg-surface text-ink hover:border-accent/40",
    buttonKbd: "border-line text-ink-3",
    listIcon: "text-accent-text",
  },
  primary: {
    pill: "bg-accent text-accent-fg shadow-card",
    press: "hover:bg-accent-hover",
    icon: "",
    divider: "border-white/20",
    kbd: "border-white/30",
    button: "bg-accent text-accent-fg hover:bg-accent-hover",
    buttonKbd: "border-white/35",
    listIcon: "text-accent-text",
  },
  subtle: {
    pill: "border border-line bg-surface text-ink-2",
    press: "hover:bg-surface-2 hover:text-ink",
    icon: "text-ink-3",
    divider: "border-line",
    kbd: "border-line text-ink-3",
    button: "border border-line bg-surface text-ink hover:border-accent/40",
    buttonKbd: "border-line text-ink-3",
    listIcon: "text-ink-3",
  },
};

/** detail 0: Enter or Space, not a pointer click. */
const viaOf = (e: MouseEvent): Via => (e.detail === 0 ? "keyboard" : "pointer");

/** A card that does not fit in full: its icon, its short words, its key, and a dismiss. The tip and the names hold the rest. */
function Pill({ entry }: { entry: AssistEntry }) {
  const primary = entry.primary;
  if (!primary) return null;
  const tone = TONE[entry.tone];
  const Icon = entry.icon;
  const dismiss = entry.dismiss;
  return (
    <div role="group" aria-label={entry.group} title={entry.tip} className={clsx("flex h-8 min-w-0 items-center rounded-full text-sm", tone.pill)}>
      <button
        type="button"
        onClick={(e) => primary.run(viaOf(e))}
        aria-label={primary.name}
        className={clsx(
          "flex h-full min-w-0 items-center gap-1.5 font-medium transition-colors",
          entry.kind === "suggestion" ? "pl-3" : "pl-2.5",
          dismiss ? "rounded-l-full pr-2" : "rounded-full pr-3",
          tone.press,
        )}
      >
        {/* A suggestion has "Next step" and its sparkle before it, as in full. */}
        {entry.kind === "suggestion" ? null : <Icon className={clsx("size-3.5 shrink-0", tone.icon)} aria-hidden />}
        <span className="max-w-36 min-w-0 truncate">{entry.short}</span>
        {entry.hotkey ? (
          <kbd className={clsx("hidden shrink-0 rounded border px-1 font-sans text-2xs sm:inline", tone.kbd)} aria-hidden>
            {entry.hotkey}
          </kbd>
        ) : null}
      </button>
      {dismiss ? (
        <button
          type="button"
          onClick={(e) => dismiss.run(viaOf(e))}
          aria-label={dismiss.name}
          title={dismiss.title ?? dismiss.label}
          className={clsx("grid h-full w-7 shrink-0 place-items-center rounded-r-full border-l transition-colors", tone.divider, tone.press, entry.tone === "primary" ? "" : "text-ink-3")}
        >
          <X className="size-3.5" aria-hidden />
        </button>
      ) : null}
    </div>
  );
}

/** A card in the "+N" list, in full: every word wraps instead of being cut, and every button is there. */
function ListEntry({ entry, onAct }: { entry: AssistEntry; onAct: () => void }) {
  const tone = TONE[entry.tone];
  const Icon = entry.icon;
  const act = (a: AssistAction) => (e: MouseEvent) => {
    a.run(viaOf(e));
    onAct();
  };
  return (
    <li role="group" aria-label={entry.group} className="flex items-start gap-2.5 px-2 py-2">
      <Icon className={clsx("mt-0.5 size-3.5 shrink-0", tone.listIcon)} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug font-medium [overflow-wrap:anywhere] text-ink">{entry.text}</p>
        {entry.detail ? <p className="mt-0.5 text-2xs leading-snug [overflow-wrap:anywhere] text-ink-3">{entry.detail}</p> : null}
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {entry.primary ? (
            <button
              type="button"
              onClick={act(entry.primary)}
              aria-label={entry.primary.name}
              title={entry.primary.title}
              className={clsx("inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-2xs font-semibold transition-colors", tone.button)}
            >
              {entry.primary.label}
              {entry.hotkey ? (
                <kbd className={clsx("hidden rounded border px-1 font-sans text-2xs sm:inline", tone.buttonKbd)} aria-hidden>
                  {entry.hotkey}
                </kbd>
              ) : null}
            </button>
          ) : null}
          {entry.others?.map((a) => (
            <button
              key={a.name}
              type="button"
              onClick={act(a)}
              aria-label={a.name}
              title={a.title}
              className="inline-flex min-h-6 max-w-full items-center rounded-full border border-line bg-surface px-2 py-0.5 text-left text-2xs text-ink-2 transition-colors hover:border-accent/40 hover:text-ink"
            >
              {a.label}
            </button>
          ))}
          {entry.dismiss ? (
            <button
              type="button"
              onClick={act(entry.dismiss)}
              aria-label={entry.dismiss.name}
              title={entry.dismiss.title}
              className="inline-flex h-6 shrink-0 items-center rounded-full px-2 text-2xs font-medium text-ink-2 transition-colors hover:bg-surface-2 hover:text-ink"
            >
              {entry.dismiss.label}
            </button>
          ) : null}
        </div>
      </div>
    </li>
  );
}

const MORE_BUTTON = "flex h-8 shrink-0 items-center gap-0.5 rounded-full border px-2.5 text-xs font-semibold tabular-nums transition-colors";

function MoreFace({ count }: { count: number }) {
  return (
    <>
      +{count}
      <ChevronDown className="size-3.5" aria-hidden />
    </>
  );
}

/** The name a card goes by in the "+N" button's accessible name. */
function listName(e: AssistEntry): string {
  return e.kind === "suggestion" ? e.text : `${e.group}: ${e.short}`;
}

/** "+N" at the end of the row, and the list it opens. It sits at the row's right edge, so the list lines up with it on any width. */
function MoreList({ entries }: { entries: AssistEntry[] }) {
  const { open, setOpen, wrapRef, buttonRef, panelRef, onBlur, closeAfterAction } = usePopover();
  const baseId = useId();
  const count = entries.length;
  return (
    <div ref={wrapRef} className="ml-auto flex shrink-0" onBlur={onBlur}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${baseId}-list` : undefined}
        aria-label={`${count} more: ${entries.map(listName).join(", ")}`}
        title={`${count} more that do not fit on this line`}
        className={clsx(MORE_BUTTON, open ? "border-accent/40 bg-accent-soft text-accent-text" : "border-line bg-surface text-ink-2 hover:border-accent/40 hover:text-ink")}
      >
        <MoreFace count={count} />
      </button>
      {open ? (
        <div
          ref={panelRef}
          id={`${baseId}-list`}
          role="dialog"
          aria-label={`${count} more next ${count === 1 ? "step" : "steps"}`}
          // Anchored to the row (its positioned ancestor), right edge to right edge, so it fits on a phone.
          className="absolute top-full right-0 z-40 mt-1.5 max-h-[min(26rem,70dvh)] w-[min(24rem,calc(100vw-2rem))] overflow-y-auto rounded-xl border border-line bg-surface p-1 text-ink shadow-pop"
        >
          <ul className="divide-y divide-line">
            {entries.map((e) => (
              <ListEntry key={e.motionKey} entry={e} onAct={closeAfterAction} />
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** One card on the row, in full or as a pill. It fades in; a card that is gone fades out, and one moving into "+N" goes at once. */
function RowCard({ entry, mode, first, cut, reduceMotion }: { entry: AssistEntry; mode: FitMode; first: boolean; cut: boolean; reduceMotion: boolean }) {
  const variants: Variants = {
    hidden: { opacity: 0, y: 4 },
    shown: { opacity: 1, y: 0, transition: { duration: 0.18 } },
    // `offered` is AnimatePresence's custom value: the cards still offered, on the row or in "+N".
    gone: (offered: ReadonlySet<string>) => ({ opacity: 0, transition: { duration: reduceMotion || offered.has(entry.motionKey) ? 0 : 0.12 } }),
  };
  return (
    <motion.div
      layout={reduceMotion ? false : "position"}
      variants={variants}
      initial={reduceMotion ? false : "hidden"}
      animate="shown"
      exit="gone"
      transition={{ layout: { type: "spring", stiffness: 380, damping: 34 } }}
      // The first card may give up words (truncate): cut short, or when even it alone is too wide. The others keep the width they were measured at.
      className={clsx("flex min-w-0", !first && "shrink-0")}
    >
      {mode !== "compact" || cut ? entry.full : first ? (entry.narrow ?? entry.full) : <Pill entry={entry} />}
    </motion.div>
  );
}

interface Sizes {
  /** The row's width. */
  row: number;
  /** Measured widths by `data-measure` name: "full:<id>", "narrow:<id>", "compact:<id>", "label:full", "label:icon", "more". */
  parts: Record<string, number>;
}

function sameSizes(a: Sizes, row: number, parts: Record<string, number>): boolean {
  if (a.row !== row) return false;
  const keys = Object.keys(parts);
  return keys.length === Object.keys(a.parts).length && keys.every((k) => a.parts[k] === parts[k]);
}

export function AssistRow() {
  const prep = useMeetingPrepEntry();
  const flow = useUpNextEntry();
  const { entries: suggestions, hint } = useSuggestionEntries();
  const reduceMotion = useReducedMotion() ?? false;

  const slots = assistSlots({
    prep: prep !== null,
    taskDone: flow?.kind === "taskDone",
    upNext: flow?.kind === "upNext",
    upNextDone: flow?.kind === "upNextDone",
    suggestions: suggestions.map((s) => ({ id: s.id, primary: s.prominent === true })),
    hint: hint !== null,
  });
  const byId = new Map<string, AssistEntry>();
  for (const e of [prep, flow, ...suggestions]) if (e) byId.set(e.id, e);
  const ranked = slots.flatMap((slot) => byId.get(slot.id) ?? []);
  const decor = slots.find((s) => s.kind === "label" || s.kind === "hint")?.kind ?? null;

  const rowRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Sizes>({ row: 0, parts: {} });

  const measure = useCallback(() => {
    const row = rowRef.current;
    const box = measureRef.current;
    if (!row || !box) return;
    const parts: Record<string, number> = {};
    for (const el of box.querySelectorAll<HTMLElement>("[data-measure]")) {
      const name = el.dataset.measure;
      if (name) parts[name] = Math.ceil(el.getBoundingClientRect().width);
    }
    const width = Math.floor(row.getBoundingClientRect().width);
    setSizes((prev) => (sameSizes(prev, width, parts) ? prev : { row: width, parts }));
  }, []);

  // After every render, before the paint: a card came, went, or changed its words.
  useLayoutEffect(() => {
    measure();
  });
  // The window or the fonts changed.
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    if (rowRef.current) ro.observe(rowRef.current);
    if (measureRef.current) ro.observe(measureRef.current);
    return () => ro.disconnect();
  }, [measure]);

  // A card not measured yet is left out for this render; the layout effect measures it and it shows before the paint.
  const items: FitItem[] = [];
  for (const e of ranked) {
    const full = sizes.parts[`full:${e.id}`];
    if (full === undefined) continue;
    // The first card's compact form is its shorter card; the others' is a pill.
    const compact = items.length === 0 ? (e.narrow ? sizes.parts[`narrow:${e.id}`] : undefined) : e.primary ? sizes.parts[`compact:${e.id}`] : undefined;
    items.push({ id: e.id, full, compact: compact ?? null });
  }
  const labelFull = sizes.parts["label:full"];
  if (decor === "label" && labelFull !== undefined) items.push({ id: "label", full: labelFull, compact: sizes.parts["label:icon"] ?? null, decor: true });
  if (decor === "hint" && labelFull !== undefined) items.push({ id: "hint", full: labelFull + GAP_PX + HINT_MIN_PX, compact: null, decor: true });

  const lastFit = useRef<RowFit | null>(null);
  const fit = fitRow(items, { available: sizes.row, gap: GAP_PX, more: sizes.parts.more ?? 0, slack: FIT_SLACK_PX }, lastFit.current);
  useLayoutEffect(() => {
    lastFit.current = fit;
  });

  const modeOf = (id: string): FitMode | undefined => fit.modes[id];
  const onRow = (e: AssistEntry) => modeOf(e.id) === "full" || modeOf(e.id) === "compact";
  const firstId = items[0]?.id;
  const cards = ranked.filter((e) => e.kind !== "suggestion" && onRow(e));
  const chips = ranked.filter((e) => e.kind === "suggestion" && onRow(e));
  const listed = fit.more.flatMap((id) => byId.get(id) ?? []);
  const labelMode = modeOf("label");
  const hintShown = modeOf("hint") === "full";
  const offered: ReadonlySet<string> = new Set(ranked.map((e) => e.motionKey));

  const card = (e: AssistEntry) => (
    <RowCard key={e.motionKey} entry={e} mode={modeOf(e.id) ?? "full"} first={e.id === firstId} cut={e.id === firstId && fit.cut} reduceMotion={reduceMotion} />
  );

  return (
    <div ref={rowRef} className="relative flex h-9 min-w-0 items-center gap-2">
      <AnimatePresence initial={false} mode="popLayout" custom={offered}>
        {cards.map(card)}
      </AnimatePresence>
      {chips.length > 0 || hintShown ? (
        <section
          aria-label="Suggested next steps"
          // Only the first card gives up room: the section shrinks only when that card is in it, and the empty state fills what is left.
          className={clsx("flex min-w-0 items-center gap-2", hintShown ? "flex-1" : chips[0]?.id !== firstId && "shrink-0")}
        >
          {hintShown ? <NextStepLabel compact={false} /> : labelMode === "full" || labelMode === "compact" ? <NextStepLabel compact={labelMode === "compact"} /> : null}
          {hintShown ? hint : null}
          <AnimatePresence initial={false} mode="popLayout" custom={offered}>
            {chips.map(card)}
          </AnimatePresence>
        </section>
      ) : null}
      {listed.length > 0 ? <MoreList entries={listed} /> : null}

      {/* The measuring layer: every card in full and as a pill, at its natural width, never seen, focused, or read. */}
      <div aria-hidden inert className="pointer-events-none invisible absolute top-0 left-0 h-0 w-0 overflow-hidden">
        <div ref={measureRef} className="flex w-max items-center gap-2">
          {ranked.map((e) => (
            <Fragment key={e.id}>
              <div data-measure={`full:${e.id}`} className="flex shrink-0">
                {e.full}
              </div>
              {e.narrow ? (
                <div data-measure={`narrow:${e.id}`} className="flex shrink-0">
                  {e.narrow}
                </div>
              ) : null}
              {e.primary ? (
                <div data-measure={`compact:${e.id}`} className="flex shrink-0">
                  <Pill entry={e} />
                </div>
              ) : null}
            </Fragment>
          ))}
          {decor ? (
            <>
              <div data-measure="label:full" className="flex shrink-0">
                <NextStepLabel compact={false} />
              </div>
              <div data-measure="label:icon" className="flex shrink-0">
                <NextStepLabel compact />
              </div>
            </>
          ) : null}
          <div data-measure="more" className="flex shrink-0">
            <span className={clsx(MORE_BUTTON, "border-line")}>
              <MoreFace count={Math.max(1, ranked.length)} />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
