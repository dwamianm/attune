/**
 * @attune/jev: the Jev question layer. The core questions are built from the
 * app's catalog (questions.ts), readers turn Jev's answers into the typed
 * judgments the layout code reads (answers.ts, normalize.ts), and askJev
 * sends one round with a total budget and the app's fallback (ask.ts), on a
 * client tuned for a real-time UI (client.ts).
 *
 * A package of its own, apart from @attune/server, so an app that holds a
 * model key but does not use Jev never installs the TypeSafe SDK. The SDK is
 * a peer dependency: the app creates the client (createRealtimeJevClient
 * helps) and passes it in.
 */
export * from "./answers.ts";
export * from "./ask.ts";
export * from "./client.ts";
export * from "./normalize.ts";
export * from "./questions.ts";
