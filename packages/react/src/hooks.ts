/**
 * Small React helpers for an adaptive UI: keyboard listeners, debouncing,
 * throttling, a ticking clock, element size, roving tabindex for lists, and
 * small popovers. No app state: an app keeps its own buses and stores.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from "react";

export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** True when a key press should type text instead of triggering a shortcut. */
export function isTextField(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(type);
  }
  return false;
}

export function hasModifier(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey || e.altKey;
}

/** Keeps a ref pointing at the latest value, so listeners never go stale. */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useLayoutEffect(() => {
    ref.current = value;
  });
  return ref;
}

/** A window keydown listener that always calls the latest handler. */
export function useWindowKeydown(handler: (e: KeyboardEvent) => void, enabled = true): void {
  const ref = useLatest(handler);
  useEffect(() => {
    if (!enabled) return;
    const fn = (e: KeyboardEvent) => ref.current(e);
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, [ref, enabled]);
}

/**
 * Debounced callback. A pending call is flushed on unmount, so a search typed
 * just before a panel moves to the dock is still reported.
 */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  const fnRef = useLatest(fn);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<A | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) fnRef.current(...pending.current);
    },
    [fnRef],
  );

  return useCallback(
    (...args: A) => {
      if (timer.current) clearTimeout(timer.current);
      pending.current = args;
      timer.current = setTimeout(() => {
        pending.current = null;
        timer.current = null;
        fnRef.current(...args);
      }, ms);
    },
    [fnRef, ms],
  );
}

/** Returns a gate that opens at most once per `ms`. */
export function useThrottleGate(ms: number): () => boolean {
  const last = useRef(0);
  return useCallback(() => {
    const now = Date.now();
    if (now - last.current < ms) return false;
    last.current = now;
    return true;
  }, [ms]);
}

/** Current time, refreshed every `intervalMs`, for relative dates. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Layout size of an element, kept current with ResizeObserver. */
export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // offset sizes ignore transforms, so a card mid-way through a layout
    // animation (scaled) still reports its real size.
    const measure = () => {
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      setSize((s) => (s.width === width && s.height === height ? s : { width, height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

// ---------------------------------------------------------------------------
// Roving tabindex for lists
// ---------------------------------------------------------------------------

const ROW_CONTROLS = "button, input, select, textarea, a[href]";

/**
 * Makes a list one Tab stop: only the active row (elements marked
 * data-roving, plus the other controls in the same <li>) is tabbable, and
 * the arrow keys, Home, and End move between rows. Without it every row was
 * its own Tab stop, and a keyboard user could not get past the Inbox.
 */
export function useRovingList<T extends HTMLElement>(): {
  ref: RefObject<T | null>;
  onKeyDown: (e: ReactKeyboardEvent<T>) => void;
  onFocus: (e: FocusEvent<T>) => void;
} {
  const ref = useRef<T | null>(null);
  const active = useRef<HTMLElement | null>(null);

  const rows = useCallback(() => Array.from(ref.current?.querySelectorAll<HTMLElement>("[data-roving]") ?? []), []);

  const apply = useCallback(() => {
    const all = rows();
    if (all.length === 0) return;
    const current =
      active.current && all.includes(active.current) ? active.current : (all.find((r) => r.getAttribute("aria-current") === "true") ?? all[0]);
    for (const r of all) {
      const on = r === current;
      r.tabIndex = on ? 0 : -1;
      r.closest("li")
        ?.querySelectorAll<HTMLElement>(ROW_CONTROLS)
        .forEach((el) => {
          if (el !== r && !el.hasAttribute("data-roving")) el.tabIndex = on ? 0 : -1;
        });
    }
  }, [rows]);

  // Rows come and go with filters and selection; re-apply after every render.
  useLayoutEffect(() => {
    apply();
  });

  const onFocus = useCallback(
    (e: FocusEvent<T>) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-roving]");
      if (row && ref.current?.contains(row) && row !== active.current) {
        active.current = row;
        apply();
      }
    },
    [apply],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<T>) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
      const target = e.target as HTMLElement;
      if (isTextField(target)) return;
      const all = rows();
      if (all.length === 0) return;
      const from = target.closest<HTMLElement>("[data-roving]") ?? active.current;
      const i = from ? all.indexOf(from) : -1;
      const next =
        e.key === "Home" ? 0 : e.key === "End" ? all.length - 1 : Math.min(all.length - 1, Math.max(0, (i === -1 ? -1 : i) + (e.key === "ArrowDown" ? 1 : -1)));
      e.preventDefault();
      active.current = all[next];
      apply();
      all[next].focus();
    },
    [apply, rows],
  );

  return { ref, onKeyDown, onFocus };
}

// ---------------------------------------------------------------------------
// Small popovers opened by a button
// ---------------------------------------------------------------------------

/**
 * A small popover opened by a button (the "+N" list in the row under the
 * command bar, the older Back to chips): opening puts focus on its first
 * button, Escape or a press outside closes it and puts focus back on the
 * button, and tabbing out of it closes it. While it is open its button says
 * aria-expanded="true", so flowKeyTaken and the links bar's Escape leave the
 * keys alone. Spread `onBlur` on the wrapper that holds both.
 */
export function usePopover(): {
  open: boolean;
  setOpen: (open: boolean | ((was: boolean) => boolean)) => void;
  wrapRef: RefObject<HTMLDivElement | null>;
  buttonRef: RefObject<HTMLButtonElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  onBlur: (e: FocusEvent<HTMLDivElement>) => void;
  closeAfterAction: () => void;
} {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) panelRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [open]);

  // A press anywhere else closes it (the press itself still does its job).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (e.target instanceof Node && wrapRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open]);

  useWindowKeydown((e) => {
    if (e.key !== "Escape") return;
    // Ours: the links bar leaves an Escape alone once it is handled.
    e.preventDefault();
    e.stopPropagation();
    setOpen(false);
    buttonRef.current?.focus();
  }, open);

  const onBlur = useCallback(
    (e: FocusEvent<HTMLDivElement>) => {
      // Tabbing out closes it; focus moving inside it does not.
      const to = e.relatedTarget;
      if (open && to instanceof Node && !wrapRef.current?.contains(to)) setOpen(false);
    },
    [open],
  );

  /** After a button in it did its job: close it. That button may be gone, so focus goes back to the opener, or to the workspace when that went too. */
  const closeAfterAction = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body) return;
      if (buttonRef.current?.isConnected) buttonRef.current.focus();
      else document.getElementById("canvas-start")?.focus({ preventScroll: true });
    });
  }, []);

  return { open, setOpen, wrapRef, buttonRef, panelRef, onBlur, closeAfterAction };
}
