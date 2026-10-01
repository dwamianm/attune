import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { useAdaptive, type Subscribable } from "./useAdaptive.ts";

function counter(start: number): Subscribable<{ count: number; label: string }> & { bump(): void } {
  let state = { count: start, label: "Drafts" };
  const listeners = new Set<(s: typeof state, p: typeof state) => void>();
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    bump() {
      const prev = state;
      state = { ...state, count: state.count + 1 };
      for (const l of listeners) l(state, prev);
    },
  };
}

describe("useAdaptive", () => {
  it("renders the selected value of the store", () => {
    const store = counter(3);
    function Count() {
      const count = useAdaptive(store, (s) => s.count);
      const label = useAdaptive(store, (s) => s.label);
      return createElement("p", null, `${label}: ${count}`);
    }
    expect(renderToString(createElement(Count))).toBe("<p>Drafts: 3</p>");
    store.bump();
    expect(renderToString(createElement(Count))).toBe("<p>Drafts: 4</p>");
  });
});
