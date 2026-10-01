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
| `src/engine.ts` | Words, links between records, the policy, the store | `createPolicy`, `basicSuggestions`, `basicRelation`, `panelUsage`, `eventWeight`, `createAdaptiveStore` |
| `src/App.tsx`, `src/panels.tsx` | The canvas (a CSS grid on the plan's cells), the four panels | `useAdaptive`, `useDebouncedCallback`, `columnsForWidth`, `spanOf`, `matchesQuery` |
| `server/app.ts` | `/api/health` and `/api/adapt` | `checkRequest`, `createRateLimiter`, `parseAdaptRequest`, `buildRound`, `readRound`, `askJev`, `neutralJudgments` |
| `server/index.ts` | Starts the server | `createRealtimeJevClient` |

The whole app is about 750 lines. About 320 are the app's own vocabulary,
data, words, links, and server (catalog, data, engine, server); about 430
are UI (App, panels, styles). None of it is adaptive logic: that is all in
the packages.

## What building it showed

Gaps found and filled in the library while building it:

- **Usage weights.** Every app needed the same weights for the core events.
  They are `CORE_USAGE_WEIGHTS` and `eventWeight` in `@attune/core` now (the
  demo builds its own on them).
- **Suggestions and link tags.** An app with no record-specific
  suggestions had none. `basicSuggestions` and `basicRelation` in
  `@attune/core` give the catalog's action label and a plain "Linked to ..."
  tag, with the demo's thresholds.
- **A fallback answer.** Without a key there was no answer at all. The calm
  fallback is `neutralJudgments` in `@attune/core`: every panel supporting,
  no goal, no next step, and a command's panel when it names one.
- **One-call rounds.** `buildRound` and `readRound` in `@attune/jev` build
  the state and every core question and read the answers back.
- **Request checks.** `parseAdaptRequest` in `@attune/server` checks and
  clips a request body.
- **The first plan had no cells.** The canvas showed every card one row
  tall until the first round. `createAdaptiveStore` now gives its first plan
  cells at once.
- **Long link tags.** The tag used the whole record label. An app can now
  name its anchor shortly (`anchorLabel` in the store config).

Still missing (see docs/library-roadmap.md):

- **The canvas components.** The playground draws its own grid with no
  staged motion: cards jump to their new cells. `Canvas`, `PanelFrame`, the
  dock, and the link lines are step 7.
- **Commands do only panels.** The store promotes the panel a command names;
  filters and records from a command (the demo's invoice status, client, and
  time period) have no library form yet.
- **The demo's focus aids** (Up next, Back to, the Done card, habits,
  meeting prep), the quiet rule in the store, the front group, and saved
  settings are not in the library store (step 6d).
