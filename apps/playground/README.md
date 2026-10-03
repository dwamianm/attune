# Attune playground

A second Attune app, built only from the library packages: a small help desk
with four panels (Tickets, Customers, Articles, Macros), its own made-up data,
and its own small Jev server. It exists to show what the library can do on
its own, and what it still lacks. Nothing here is copied from `apps/demo`.

## Run it

1. `pnpm install` at the repo root.
2. Put a TypeSafe key in `apps/playground/.env` (copy `.env.example`), or run
   without one: the server then answers with the calm fallback, and the
   header says "Offline: calm fallback".
3. `pnpm dev:playground` at the root (or `pnpm dev` here) starts the API on
   http://localhost:8791 and Vite on http://localhost:5174. It can run next
   to the demo (8790 and 5173).

Things to try: open "Cannot reset my password" in Tickets. Tickets holds
still, Customers and Articles get "Linked to T-201" with Larkspur Bakery and
"Reset a password" tinted, and "Reply to the ticket" is suggested. Then type
"show me the saved replies" in the command bar: Macros becomes the hero.

## What it is made of

| File | What | From the library |
| --- | --- | --- |
| `src/catalog.ts` | Panels, goals, next steps, goal-to-panel affinity | `defineCatalog` |
| `src/data.ts` | Tickets, customers, articles, macros | none |
| `src/engine.ts` | Words, links between records, the store | `createAdaptiveWorkspace` |
| `src/App.tsx`, `src/panels.tsx` | The page, each card's header, and the four panels | `AdaptiveCanvas`, `Dock`, `ChangeLine`, `useStoreCanvas`, `useAdaptive`, `useDebouncedCallback`, `matchesQuery` |
| `server/app.ts` | `/api/health` and `/api/adapt` | `checkRequest`, `createRateLimiter`, `parseAdaptRequest`, `buildRound`, `readRound`, `askJev`, `neutralJudgments` |
| `server/index.ts` | Starts the server | `createRealtimeJevClient` |

The app owns its vocabulary, data joins, transport and UI.
`createAdaptiveWorkspace` supplies the standard policy and infers the catalog
types. The adaptive logic stays in the packages; there is no local policy
factory to wire up. Mounting the canvas in an existing page lets an app adopt
it for one workflow first.

## What building it showed

Gaps found and filled in the library while building it:

- **Usage weights.** Every app needed the same weights for the core events.
  They are `CORE_USAGE_WEIGHTS` and `eventWeight` in `@attuneui/core` now (the
  demo builds its own on them).
- **Suggestions and link tags.** An app with no record-specific
  suggestions had none. `basicSuggestions` and `basicRelation` in
  `@attuneui/core` give the catalog's action label and a plain "Linked to ..."
  tag, with the demo's thresholds.
- **A fallback answer.** Without a key there was no answer at all. The calm
  fallback is `neutralJudgments` in `@attuneui/core`: every panel supporting,
  no goal, no next step, and a command's panel when it names one.
- **One-call rounds.** `buildRound` and `readRound` in `@attuneui/jev` build
  the state and every core question and read the answers back.
- **Request checks.** `parseAdaptRequest` in `@attuneui/server` checks and
  clips a request body.
- **The first plan had no cells.** The canvas showed every card one row
  tall until the first round. `createAdaptiveStore` now gives its first plan
  cells at once.
- **Long link tags.** The tag used the whole record label. An app can now
  name its anchor shortly (`anchorLabel` in the store config).

Still missing (see docs/library-roadmap.md):

- **Commands do only panels.** The store promotes the panel a command names;
  filters and records from a command (the demo's invoice status, client, and
  time period) come from an app's own `resolveCommand` hook, and the
  playground has none yet.
- **No focus aids of its own.** The demo's (Up next, Back to, the Done
  card, habits, meeting prep, quiet panels, the front group, saved
  settings) are its extension of the same loop, in apps/demo, not library
  parts. The loop's hooks are where a second app would add its own.
