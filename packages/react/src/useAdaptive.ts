/**
 * useAdaptive: read an adaptive store (createAdaptiveStore in @attune/core)
 * from React. The component re-renders when the selected value changes.
 *
 * The selector must return a value that is already in the state, or a
 * primitive: a new object on every call would re-render forever. Derive
 * objects with useMemo from the values you select.
 */
import { useCallback, useSyncExternalStore } from "react";

/** The part of a store useAdaptive reads. createAdaptiveStore returns one, and so does a zustand store. */
export interface Subscribable<S> {
  getState(): S;
  subscribe(listener: (state: S, previous: S) => void): () => void;
}

export function useAdaptive<S, V>(store: Subscribable<S>, selector: (state: S) => V): V {
  const subscribe = useCallback((onChange: () => void) => store.subscribe(() => onChange()), [store]);
  const read = () => selector(store.getState());
  return useSyncExternalStore(subscribe, read, read);
}
