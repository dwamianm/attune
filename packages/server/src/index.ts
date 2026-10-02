/**
 * @attuneui/server: helpers for the server that holds the model API key. The
 * browser never talks to the model directly; it calls this server, and these
 * guards keep anyone else from spending the key. parseAdaptRequest checks
 * a request body before anything reaches the model.
 */
export * from "./guard.ts";
export * from "./request.ts";
