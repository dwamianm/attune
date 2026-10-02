/**
 * @attuneui/core: the framework-free parts of Attune. No DOM, no React, no
 * network. An app brings its own catalog (panels, goals, actions), data, and
 * model questions; these modules check the catalog, decide where cards go,
 * when to ask the model, which panels are in use or quiet, how a relayout
 * is staged, and how numbers read as words.
 */
export * from "./adaptiveStore.ts";
export * from "./catalog.ts";
export * from "./choreography.ts";
export * from "./createPolicy.ts";
export * from "./fallback.ts";
export * from "./grid.ts";
export * from "./judgments.ts";
export * from "./layoutModes.ts";
export * from "./place.ts";
export * from "./plan.ts";
export * from "./policy.ts";
export * from "./quiet.ts";
export * from "./rowFit.ts";
export * from "./scheduler.ts";
export * from "./signals.ts";
export * from "./snapshot.ts";
export * from "./suggestions.ts";
export * from "./usage.ts";
export * from "./words.ts";
