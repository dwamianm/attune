/**
 * The demo's own UI helpers: the command bar shortcut label, and two tiny
 * event buses, one for focusing the command bar from anywhere (help hint,
 * guide tips, example chips) and one for opening an inspector tab. The
 * generic hooks (keyboard, debounce, sizes, roving lists, popovers) are in
 * @attune/react.
 */
import { useEffect } from "react";
import { IS_MAC, useLatest } from "@attune/react";

/** Display label for the command bar shortcut. */
export const MOD_K = IS_MAC ? "⌘K" : "Ctrl K";

// ---------------------------------------------------------------------------
// Command bar bus
// ---------------------------------------------------------------------------

const COMMAND_FOCUS_EVENT = "floouid:focus-command";

/** Focus the command bar, optionally with text already typed in. */
export function focusCommandBar(prefill?: string): void {
  window.dispatchEvent(new CustomEvent<string | undefined>(COMMAND_FOCUS_EVENT, { detail: prefill }));
}

export function useCommandFocusListener(handler: (prefill: string | undefined) => void): void {
  const ref = useLatest(handler);
  useEffect(() => {
    const fn = (e: Event) => ref.current((e as CustomEvent<string | undefined>).detail);
    window.addEventListener(COMMAND_FOCUS_EVENT, fn);
    return () => window.removeEventListener(COMMAND_FOCUS_EVENT, fn);
  }, [ref]);
}

// ---------------------------------------------------------------------------
// Inspector tab bus (the inspector loads lazily, so it may not be mounted yet)
// ---------------------------------------------------------------------------

const INSPECTOR_TAB_EVENT = "floouid:inspector-tab";
let pendingInspectorTab: string | null = null;

/** Ask the inspector to show a tab, now if it is mounted or when it first mounts. */
export function requestInspectorTab(tab: string): void {
  pendingInspectorTab = tab;
  window.dispatchEvent(new CustomEvent<string>(INSPECTOR_TAB_EVENT, { detail: tab }));
}

/** The tab requested before the inspector mounted, once. */
export function takePendingInspectorTab(): string | null {
  const tab = pendingInspectorTab;
  pendingInspectorTab = null;
  return tab;
}

export function useInspectorTabListener(handler: (tab: string) => void): void {
  const ref = useLatest(handler);
  useEffect(() => {
    const fn = (e: Event) => {
      pendingInspectorTab = null;
      ref.current((e as CustomEvent<string>).detail);
    };
    window.addEventListener(INSPECTOR_TAB_EVENT, fn);
    return () => window.removeEventListener(INSPECTOR_TAB_EVENT, fn);
  }, [ref]);
}
