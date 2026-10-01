/**
 * @attune/core: the framework-free parts of Attune. No DOM, no React, no
 * network. An app brings its own catalog (panels, goals, actions), data, and
 * model questions; these modules check the catalog, decide where cards go,
 * when to ask the model, and how numbers read as words.
 */
export * from "./catalog.ts";
export * from "./grid.ts";
export * from "./layoutModes.ts";
export * from "./scheduler.ts";
export * from "./words.ts";
