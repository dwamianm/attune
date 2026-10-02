/**
 * Thin lines from the record the user clicked to the "Linked to" tag of each
 * panel linked to it (docs/anchored-relayout.md, "Lines"). They draw in once
 * the round has settled and stay at full strength for about 2 s. Then, by
 * default, they rest faintly until the user clears the links, and come back
 * to full strength while the pointer or focus is on a tag (its line) or the
 * pointer is on the clicked row (every line). In "fade" mode they fade out
 * instead, as they used to. The line to the panel that holds the next step
 * ("Arrange linked panels by next step") stays at full strength.
 *
 * Lines that stay must stay right: they are measured again, at most once a
 * frame, when the window scrolls or resizes, the canvas resizes, a list in a
 * card scrolls, the user does something, and every frame for a moment after
 * a plan change, so they glide with the cards. A line whose clicked row or
 * tag is out of sight (scrolled out of its list, under the app bar, off
 * screen) is hidden until it is back.
 *
 * A line never crosses another card: it leaves the clicked row's side, runs
 * through the grid gutters (the gaps between cards), and drops into the tag
 * from just above the target card. A target no such route reaches, or one
 * off screen, gets a one-beat pulse on its tag instead, and so does every
 * target when the anchor has no clicked row (a search, a filter, a command
 * without a record): a line from a header explains nothing.
 *
 * Purely decorative: aria-hidden, pointer-events none, and skipped with
 * reduced motion. The tags and the tint carry the same meaning.
 */
import { motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { PanelId } from "../../shared/catalog.ts";
import type { AnchorRef } from "../../shared/types.ts";
import { useEngine } from "../engine/store.ts";
import { LINK_SET_MAX } from "../engine/relations.ts";
import {
  LINK_FOLLOW_MS,
  LINK_LINE_DRAW_MS,
  LINK_LINE_FADE_MS,
  LINK_LINE_REST_OPACITY,
  LINK_LINE_SHOW_MS,
  LINK_TAG_PULSE_MS,
  STAGE_EASE,
} from "@attuneui/core";
import {
  appBarSelector,
  itemSelector,
  LINK_ATTR,
  LINK_LINE_ATTR,
  LINK_LINES_ATTR,
  LINK_PULSE_ATTR,
  LINK_REMOVE_ATTR,
  LINK_TAG_ATTR,
  linkTagSelector,
  PANEL_ATTR,
  panelSelector,
} from "./domHooks.ts";
import { useLatest } from "@attuneui/react";
import { anchorItem } from "./linking.tsx";

/** Lines leaving together run this far apart in a gutter, so three fit side by side in the 10 to 16 px gap. */
const LINE_SPREAD_PX = 3;
/** Corner radius where a line turns, so it reads as one soft stroke rather than a wiring diagram. */
const LINE_CORNER_PX = 8;
/** A row this close to its card's side (the card's padding) may leave through that side without crossing its own card's content. */
const ROW_EDGE_SLACK_PX = 24;
/** Obstacle cards are shrunk by this much, so a line in a gutter that grazes a border does not count as crossing it. */
const OBSTACLE_INSET_PX = 2;
/** Points along a route are checked this far apart for crossings and visibility. */
const SAMPLE_STEP_PX = 4;
/** A box needs this much of itself on screen to count as visible. */
const MIN_VISIBLE_PX = 8;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface Point {
  x: number;
  y: number;
}

interface Line {
  id: PanelId;
  d: string;
  start: Point;
  end: Point;
}

function relative(r: DOMRect, base: DOMRect): Box {
  return { left: r.left - base.left, top: r.top - base.top, right: r.right - base.left, bottom: r.bottom - base.top };
}

/** The top of the visible page: the bottom of the sticky app bar, since nothing under it can be seen. */
function visibleTop(): number {
  return Math.max(0, document.querySelector<HTMLElement>(appBarSelector())?.getBoundingClientRect().bottom ?? 0);
}

/** The part of `el` that shows in the window below the app bar and in every clipping box between it and `stop`. */
function shownSpan(el: HTMLElement, stop: HTMLElement, top0: number): { rect: DOMRect; top: number; bottom: number } {
  const rect = el.getBoundingClientRect();
  let top = Math.max(rect.top, top0);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  let node = el.parentElement;
  while (node && node !== stop.parentElement) {
    const style = getComputedStyle(node);
    if (style.overflowY !== "visible") {
      const c = node.getBoundingClientRect();
      top = Math.max(top, c.top);
      bottom = Math.min(bottom, c.bottom);
    }
    node = node.parentElement;
  }
  return { rect, top, bottom };
}

/** True when enough of `el` shows (see shownSpan). */
function inView(el: HTMLElement, stop: HTMLElement, top0: number): boolean {
  const { rect, top, bottom } = shownSpan(el, stop, top0);
  return bottom - top >= Math.min(MIN_VISIBLE_PX, rect.height);
}

/** True when the middle of the clicked row shows, where its line starts: a row half scrolled out of its list would start the line over the search box. */
function rowInView(row: HTMLElement, card: HTMLElement, top0: number): boolean {
  const { rect, top, bottom } = shownSpan(row, card, top0);
  const mid = (rect.top + rect.bottom) / 2;
  return mid >= top && mid <= bottom;
}

/** An svg path through `points` with rounded corners. */
function roundedPath(points: Point[]): string {
  let d = `M ${points[0].x} ${points[0].y}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [a, p, b] = [points[i - 1], points[i], points[i + 1]];
    const la = Math.hypot(p.x - a.x, p.y - a.y);
    const lb = Math.hypot(b.x - p.x, b.y - p.y);
    const r = Math.min(LINE_CORNER_PX, la / 2, lb / 2);
    if (r < 0.5) {
      d += ` L ${p.x} ${p.y}`;
      continue;
    }
    const inPt = { x: p.x + ((a.x - p.x) / la) * r, y: p.y + ((a.y - p.y) / la) * r };
    const outPt = { x: p.x + ((b.x - p.x) / lb) * r, y: p.y + ((b.y - p.y) / lb) * r };
    d += ` L ${inPt.x} ${inPt.y} Q ${p.x} ${p.y}, ${outPt.x} ${outPt.y}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last.x} ${last.y}`;
}

/** Points every SAMPLE_STEP_PX along one segment, both ends included. */
function samples(a: Point, b: Point): Point[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / SAMPLE_STEP_PX));
  return Array.from({ length: n + 1 }, (_, k) => ({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n }));
}

const inside = (p: Point, b: Box) => p.x > b.left && p.x < b.right && p.y > b.top && p.y < b.bottom;

/**
 * The route from the clicked row to one tag: out of the row's `side` into
 * the gutter beside the anchor card, along it to the gutter just above the
 * target card, across to the tag, and down into the tag's top edge.
 */
function route(s: Box, a: Box, t: Box, tag: Box, gap: number, side: "left" | "right", slot: number): Point[] {
  const spread = slot * LINE_SPREAD_PX;
  const right = side === "right";
  const sy = (s.top + s.bottom) / 2 + spread;
  const sx = right ? s.right : s.left;
  const xg = right ? a.right + gap / 2 + spread : a.left - gap / 2 - spread;
  const yh = t.top - gap / 2 + spread;
  const tx = (tag.left + tag.right) / 2;
  return [
    { x: sx, y: sy },
    { x: xg, y: sy },
    { x: xg, y: yh },
    { x: tx, y: yh },
    { x: tx, y: tag.top },
  ];
}

interface Measured {
  lines: Line[];
  /** Targets that get a pulse on their tag instead of a line. */
  pulse: PanelId[];
}

/** Lines for `ids` that cross no other card and stay on screen; the rest pulse. */
function measure(canvas: HTMLElement, anchor: AnchorRef, ids: PanelId[]): Measured {
  const card = canvas.querySelector<HTMLElement>(panelSelector(anchor.panel));
  const item = anchorItem(anchor);
  const row = card && item ? card.querySelector<HTMLElement>(itemSelector(item.kind, item.id)) : null;
  const top0 = visibleTop();
  // No clicked row on screen: a line from nowhere, or from a header, explains nothing.
  if (!card || !row || !rowInView(row, card, top0)) return { lines: [], pulse: ids };
  const base = canvas.getBoundingClientRect();
  const a = relative(card.getBoundingClientRect(), base);
  const s = relative(row.getBoundingClientRect(), base);
  const gap = parseFloat(getComputedStyle(canvas).rowGap) || 12;
  // A row may leave through a side it nearly touches; in a hero the detail pane is on one side.
  const sides = { left: s.left - a.left <= ROW_EDGE_SLACK_PX, right: a.right - s.right <= ROW_EDGE_SLACK_PX };
  const cards = [...canvas.querySelectorAll<HTMLElement>(`:scope > [${PANEL_ATTR}]`)].filter((el) => !el.hasAttribute("data-motion-pop-id"));
  const boxes = new Map(cards.map((el) => [el.getAttribute(PANEL_ATTR) as PanelId, relative(el.getBoundingClientRect(), base)]));
  const visible = { top: top0 - base.top, bottom: window.innerHeight - base.top, left: -base.left, right: window.innerWidth - base.left };

  const targets = ids.flatMap((id) => {
    const t = boxes.get(id);
    const tagEl = canvas.querySelector<HTMLElement>(`${panelSelector(id)} ${linkTagSelector(anchor.panel)}`);
    return t && tagEl ? [{ id, t, tagEl, tag: relative(tagEl.getBoundingClientRect(), base) }] : [];
  });
  // Nearer targets take the inner lane of a shared gutter, so lines do not cross each other.
  const dist = (t: Box) => Math.abs(t.top - a.top) + Math.abs((t.left + t.right) / 2 - (a.left + a.right) / 2);
  targets.sort((x, y) => dist(x.t) - dist(y.t));
  const mid = (targets.length - 1) / 2;

  const lines: Line[] = [];
  const pulse: PanelId[] = ids.filter((id) => !targets.some((x) => x.id === id));
  const shrunk = (b: Box): Box => ({ left: b.left + OBSTACLE_INSET_PX, top: b.top + OBSTACLE_INSET_PX, right: b.right - OBSTACLE_INSET_PX, bottom: b.bottom - OBSTACLE_INSET_PX });
  targets.forEach(({ id, t, tagEl, tag }, i) => {
    // Every card is in the way, except the anchor for the first segment (out
    // of the row to its card's edge) and the target for the last (the drop
    // into its tag), so a line never runs across the anchor's own content.
    const others = [...boxes].filter(([other]) => other !== anchor.panel && other !== id).map(([, b]) => shrunk(b));
    const anchorBox = shrunk(a);
    const targetBox = shrunk(t);
    const clean = (points: Point[]) =>
      points.slice(1).every((b, k) => {
        const blockers = [...others, ...(k === 0 ? [] : [anchorBox]), ...(k === points.length - 2 ? [] : [targetBox])];
        return samples(points[k], b).every(
          (p) => p.y >= visible.top && p.y <= visible.bottom && p.x >= visible.left && p.x <= visible.right && blockers.every((box) => !inside(p, box)),
        );
      });
    // The side facing the target first, then the other; the first route that crosses nothing wins.
    const facing: "left" | "right" = (t.left + t.right) / 2 >= (a.left + a.right) / 2 ? "right" : "left";
    const order: ("left" | "right")[] = facing === "right" ? ["right", "left"] : ["left", "right"];
    const points = inView(tagEl, tagEl, top0)
      ? order
          .filter((side) => sides[side])
          .map((side) => route(s, a, t, tag, gap, side, i - mid))
          .find(clean)
      : undefined;
    if (!points) {
      pulse.push(id);
      return;
    }
    lines.push({ id, d: roundedPath(points), start: points[0], end: points[points.length - 1] });
  });
  return { lines, pulse };
}

/** One beat on each tag: the panel is linked, but no clean line reaches it. */
function pulseTags(canvas: HTMLElement, anchor: AnchorRef, ids: PanelId[]): ReturnType<typeof setTimeout> | null {
  const tags = ids.flatMap((id) => {
    const el = canvas.querySelector<HTMLElement>(`${panelSelector(id)} ${linkTagSelector(anchor.panel)}`);
    return el ? [el] : [];
  });
  if (tags.length === 0) return null;
  for (const el of tags) {
    el.style.setProperty("--fl-pulse-ms", `${LINK_TAG_PULSE_MS}ms`);
    el.setAttribute(LINK_PULSE_ATTR, "");
  }
  return setTimeout(() => {
    for (const el of tags) el.removeAttribute(LINK_PULSE_ATTR);
  }, LINK_TAG_PULSE_MS);
}

/** Where a line is in its life: drawing in and shown at full strength, resting faintly, fading out, or gone ("fade" mode). */
type Phase = "strong" | "rest" | "fading" | "gone";

/** What the pointer or keyboard is on: one linked panel's tag (its line), or the clicked row (every line). */
type Hot = PanelId | "all" | null;

/** Per link set: the targets whose round has settled (their line may show), each line's phase, and the phase timers. */
interface Track {
  ready: Set<PanelId>;
  phase: Map<PanelId, Phase>;
  timers: ReturnType<typeof setTimeout>[];
}

const sameLines = (a: Line[], b: Line[]) => a.length === b.length && a.every((l, i) => l.id === b[i].id && l.d === b[i].d);

export function LinkLines({
  canvasRef,
  source,
  targets,
  round,
  settleMs,
  reduceMotion,
  persist,
  strong = null,
}: {
  canvasRef: RefObject<HTMLDivElement | null>;
  /** The anchor of the click that made the links on screen, or null when none show. */
  source: AnchorRef | null;
  /** Linked panels on the canvas, in plan order. */
  targets: PanelId[];
  round: number;
  /** When the round's last card lands, in ms after the commit. */
  settleMs: number;
  reduceMotion: boolean;
  /** True: lines rest faintly until the links are cleared. False ("fade"): they fade out after about 2 s, as before. */
  persist: boolean;
  /** The linked panel that holds the next step (LinkSet.next): its line does not rest faintly. */
  strong?: PanelId | null;
}) {
  const key = source?.at ?? null;
  const targetsKey = targets.join(",");
  const [lines, setLines] = useState<Line[]>([]);
  const [phases, setPhases] = useState<Partial<Record<PanelId, Phase>>>({});
  const [hot, setHot] = useState<Hot>(null);
  const track = useRef<Track>({ ready: new Set(), phase: new Map(), timers: [] });
  const latest = useLatest({ source, targets, persist });
  /** Re-measure every frame for LINK_FOLLOW_MS (set while the link set is on screen). */
  const follow = useRef<() => void>(() => {});
  // Rows move when the data or a panel's view changes, or the user does something; the lines follow.
  const activity = useEngine((s) => s.events.at(-1)?.id ?? 0);
  const data = useEngine((s) => s.data);
  const view = useEngine((s) => s.view);

  const setPhase = useCallback((id: PanelId, phase: Phase) => {
    track.current.phase.set(id, phase);
    setPhases((p) => ({ ...p, [id]: phase }));
  }, []);

  /** A line shows for the first time: it draws in, stays at full strength, then rests (or fades). */
  const born = useCallback(
    (id: PanelId) => {
      const t = track.current;
      const keep = latest.current.persist;
      setPhase(id, "strong");
      t.timers.push(setTimeout(() => setPhase(id, keep ? "rest" : "fading"), LINK_LINE_DRAW_MS + LINK_LINE_SHOW_MS));
      if (!keep) t.timers.push(setTimeout(() => setPhase(id, "gone"), LINK_LINE_DRAW_MS + LINK_LINE_SHOW_MS + LINK_LINE_FADE_MS));
    },
    [latest, setPhase],
  );

  /** Targets whose line may show now: settled, not gone, and in "fade" mode only those that got a line when they settled. */
  const trackedIds = useCallback((): PanelId[] => {
    const t = track.current;
    const { targets: all, persist: keep } = latest.current;
    return all.filter((id) => t.ready.has(id) && t.phase.get(id) !== "gone" && (keep || t.phase.has(id)));
  }, [latest]);

  const recompute = useCallback(() => {
    const canvas = canvasRef.current;
    const src = latest.current.source;
    const ids = trackedIds();
    if (!canvas || !src || ids.length === 0) {
      setLines((l) => (l.length > 0 ? [] : l));
      return;
    }
    const next = measure(canvas, src, ids).lines;
    for (const l of next) if (!track.current.phase.has(l.id)) born(l.id);
    setLines((cur) => (sameLines(cur, next) ? cur : next));
  }, [born, canvasRef, latest, trackedIds]);

  // A new link set (or none) starts over.
  useEffect(() => {
    track.current = { ready: new Set(), phase: new Map(), timers: [] };
    setLines([]);
    setPhases({});
    return () => {
      for (const t of track.current.timers) clearTimeout(t);
    };
  }, [key]);

  // Measure again when anything that moves a card, a row, or a tag happens, at most once a frame.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (key === null || reduceMotion || !canvas) return;
    let frame = 0;
    let until = 0;
    const run = () => {
      frame = 0;
      recompute();
      if (performance.now() < until) frame = requestAnimationFrame(run);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(run);
    };
    follow.current = () => {
      until = performance.now() + LINK_FOLLOW_MS;
      schedule();
    };
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(canvas);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, { passive: true });
    // Lists scroll inside their cards, and scroll does not bubble: listen in the capture phase.
    canvas.addEventListener("scroll", schedule, { capture: true, passive: true });

    // A tag (or its x) brings its line back to full strength, and the clicked row brings every line.
    const hotOf = (el: EventTarget | null): Hot => {
      if (!(el instanceof Element)) return null;
      const card = el.closest(`[${LINK_TAG_ATTR}], [${LINK_REMOVE_ATTR}]`)?.closest(`[${PANEL_ATTR}]`);
      if (card) return card.getAttribute(PANEL_ATTR) as PanelId;
      return el.closest(`[${LINK_ATTR}="anchor"]`) ? "all" : null;
    };
    let pointerHot: Hot = null;
    let focusHot: Hot = null;
    const show = () => setHot(pointerHot ?? focusHot);
    const onOver = (e: PointerEvent) => {
      pointerHot = hotOf(e.target);
      show();
    };
    const onLeave = () => {
      pointerHot = null;
      show();
    };
    const onFocusIn = (e: FocusEvent) => {
      focusHot = hotOf(e.target);
      show();
    };
    const onFocusOut = (e: FocusEvent) => {
      focusHot = hotOf(e.relatedTarget);
      show();
    };
    canvas.addEventListener("pointerover", onOver);
    canvas.addEventListener("pointerleave", onLeave);
    canvas.addEventListener("focusin", onFocusIn);
    canvas.addEventListener("focusout", onFocusOut);
    return () => {
      cancelAnimationFrame(frame);
      follow.current = () => {};
      resize?.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule);
      canvas.removeEventListener("scroll", schedule, { capture: true });
      canvas.removeEventListener("pointerover", onOver);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.removeEventListener("focusin", onFocusIn);
      canvas.removeEventListener("focusout", onFocusOut);
      setHot(null);
    };
  }, [key, reduceMotion, canvasRef, recompute]);

  // Each target's line (or pulse) starts once the round that brought it has settled.
  useEffect(() => {
    if (key === null || reduceMotion) return;
    const t = track.current;
    const fresh = targets.filter((id) => !t.ready.has(id)).slice(0, LINK_SET_MAX);
    if (fresh.length === 0) return;
    const timer = setTimeout(() => {
      const canvas = canvasRef.current;
      const src = latest.current.source;
      if (!canvas || !src) return;
      for (const id of fresh) t.ready.add(id);
      const ids = latest.current.targets.filter((id) => t.ready.has(id) && t.phase.get(id) !== "gone");
      const { lines: now, pulse } = measure(canvas, src, ids);
      for (const l of now) if (!t.phase.has(l.id)) born(l.id);
      // No clean route yet: one beat on the tag. A line that stays may still show once a route opens (a scroll, a move).
      const beat = pulseTags(canvas, src, pulse.filter((id) => fresh.includes(id)));
      if (beat) t.timers.push(beat);
      if (!latest.current.persist) for (const id of fresh) if (!t.phase.has(id)) t.phase.set(id, "gone");
      setLines(now.filter((l) => t.phase.get(l.id) !== "gone"));
    }, settleMs);
    return () => clearTimeout(timer);
    // targetsKey stands for targets; the link set is keyed on its identity (key).
  }, [key, targetsKey, round, settleMs, reduceMotion, canvasRef, latest, born]);

  // A plan change, the user's work, or new data can move the cards and rows: follow them for a moment.
  useEffect(() => {
    follow.current();
  }, [key, round, targetsKey, activity, data, view]);

  if (reduceMotion || key === null) return null;
  const shown = lines.filter((l) => {
    const phase = phases[l.id];
    return phase !== undefined && phase !== "gone";
  });
  if (shown.length === 0) return null;
  return (
    <svg {...{ [LINK_LINES_ATTR]: "" }} aria-hidden className="pointer-events-none absolute inset-0 z-10 size-full overflow-visible">
      <g fill="none" stroke="var(--fl-link)" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        {shown.map((l) => {
          const phase = phases[l.id];
          const drawing = phase === "strong";
          const opacity = phase === "strong" ? 1 : phase === "rest" ? (hot === "all" || hot === l.id || strong === l.id ? 1 : LINK_LINE_REST_OPACITY) : 0;
          return (
            <motion.g
              key={l.id}
              {...{ [LINK_LINE_ATTR]: l.id }}
              // A line that comes back after being out of sight fades in; only a new one draws in.
              initial={{ opacity: drawing ? 1 : 0 }}
              animate={{ opacity }}
              transition={{ duration: LINK_LINE_FADE_MS / 1000 }}
            >
              <motion.path
                d={l.d}
                initial={{ pathLength: drawing ? 0 : 1 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: LINK_LINE_DRAW_MS / 1000, ease: [...STAGE_EASE] }}
              />
              <circle cx={l.start.x} cy={l.start.y} r={3} fill="var(--fl-link)" stroke="none" />
              <motion.circle
                cx={l.end.x}
                cy={l.end.y}
                r={3}
                fill="var(--fl-link)"
                stroke="none"
                initial={{ opacity: drawing ? 0 : 1 }}
                animate={{ opacity: 1 }}
                transition={{ delay: drawing ? LINK_LINE_DRAW_MS / 1000 : 0, duration: 0.12 }}
              />
            </motion.g>
          );
        })}
      </g>
    </svg>
  );
}
