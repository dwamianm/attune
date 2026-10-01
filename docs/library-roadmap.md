# Library roadmap

Goal: a library another project can install to get an adaptive canvas. The
other project brings its own panels, data, and model questions. Attune brings
the event log, the snapshot in words, the request scheduling, the layout
policy, the anchored grid, and the staged relayout.

The test that the library is real: a second app in `apps/`, with different
panels and different data, built only from `packages/`.

## Where things are now

In `packages/` (generic, tested, used by the demo):

| Module | Package | What it does |
| --- | --- | --- |
| `catalog.ts` | `@attune/core` | The `Catalog` type (panels, goals, actions, goal-to-panel affinity, generic over their ids) and `defineCatalog`, which checks one when the app starts. Fixes the no-match ids `UNCLEAR_GOAL` ("unclear") and `NO_ACTION` ("none"). |
| `layoutModes.ts` | `@attune/core` | The three layouts (focus, compare, overview) and their model descriptions. Library-owned: the policy treats each one differently. |
| `grid.ts` | `@attune/core` | `packGrid` (anchored packer), `lockedPanels`, `summarizeChanges`, cell spans and breakpoints. Generic over the panel id. |
| `usage.ts` | `@attune/core` | Recent use per panel: each event's weight halves every 90 s, normalized so the busiest panel is 1. The app gives the panel ids and each event's weight. |
| `quiet.ts` | `@attune/core` | The quiet rule: which panels fade because the model rated them low two rounds in a row, with a band against flicker and every exemption. The app gives the panel ids and says which events count as use. |
| `choreography.ts` | `@attune/core` | The staged relayout: timing for grow, exit, move, and enter, which card plays which stage, and the sentences for the anchor note and screen readers. The app gives a panel title function. |
| `rowFit.ts` | `@attune/core` | Fits a row of cards on one line: full, compact pill, or "+N". The app decides the cards and their order. |
| `scheduler.ts` | `@attune/core` | `AdaptScheduler`: debounce, max wait, one request in flight, commands first. The app decides which events are triggers. |
| `words.ts` | `@attune/core` | Numbers and ids as plain words, for the model and for people. |
| `plan.ts` | `@attune/core` | The layout plan and its parts (`LayoutPlan`, `PanelPlacement`, `AnchorRef`, `PanelRelation`, `CoreSuggestion`), generic over the panel ids, the suggestion type, and the record kinds. |
| `createPolicy.ts` | `@attune/core` | The whole policy round, bound to an app once: `computePlan` (membership, docking with its band, order with hysteresis, sizes, anchors and links, quiet panels, the decisions in words) and the plan edits (a command's hero, pins, "Make bigger", undo marks). The app gives its suggestions, link words, help panel, and habit words. |
| `place.ts` | `@attune/core` | The place step: `placePlan` packs explicit cells with the anchor held still, keeps the pointer's card from moving, and counts the rounds. |
| `adaptiveStore.ts` | `@attune/core` | `createAdaptiveStore`: the adaptive loop in one framework-free store (event log, scheduler, request and answer, policy, place step, the anchor, pointer and canvas holds, the minimum change interval, undo, commands). Tested with a small writing app; the demo does not use it yet (step 6d). |
| `suggestions.ts`, `fallback.ts` | `@attune/core` | Defaults for an app with nothing of its own: `basicSuggestions` (the model's next step with the demo's thresholds), `basicRelation` (a plain link tag), and `neutralJudgments` (the calm fallback answer). |
| `round.ts` | `@attune/jev` | `buildRound` and `readRound`: the state and every core question for one round, and the judgments back. |
| `request.ts` | `@attune/server` | `parseAdaptRequest`: checks and clips an adapt request body. |
| `useAdaptive.ts` | `@attune/react` | `useAdaptive(store, selector)`: read an adaptive store (or any store with `getState` and `subscribe`) from React. |
| `canvas.tsx` | `@attune/react` | The canvas: `AdaptiveCanvas` (each card in its plan cell, the staged round from `roundCues`, reduced motion as a fade), `PanelCard` (one animated card; it reports pointer, focus, and pointer rests), `Dock` (leaving cards fly into its items), `ChangeLine` (the last change, with Undo), `useCanvasColumns`, and `useStoreCanvas`, which wires all of it to a library store. Unstyled except for the layout; apps style it with class names and data attributes. `motion` is a peer dependency. |
| `judgments.ts` | `@attune/core` | The typed answers the layout code reads: `ChoiceJudgment`, `ScoreJudgment`, `CoreJudgments`, `CoreCommandJudgments`. |
| `signals.ts` | `@attune/core` | The core signal vocabulary (`CoreSignalType`: focus, open, dismiss, pin, dwell, item open, search, filter, action, command, shortcut, scroll, suggestions, undo, resize) and `SignalProfile`, which says how an app's own types count: as record opens, work, pointer use, or cue-only. |
| `snapshot.ts` | `@attune/core` | Events into the words-only `InteractionSnapshot`: the sentences for the core types, the behavior observations and their thresholds, collapsing repeats, the focus fallback. The app gives its words (panel titles, record kinds, its actions in the past tense) and its own sentences. |
| `policy.ts` | `@attune/core` | The general layout rules: the priority blend (`scorePanels`), the mode and density changes with their hysteresis, the help level, and the panels in use that must not move away or shrink, with their thresholds and the slot sizes. |
| `questions.ts` | `@attune/jev` | The core Jev questions and state, built from the catalog: goal, relevance per panel, struggling, layout, expertise, next action, and with a command the panel and action. |
| `ask.ts`, `client.ts` | `@attune/jev` | `askJev`: one round with a total budget that always answers, using the app's fallback on any failure and logging one line. `createRealtimeJevClient`: a 4 s attempt timeout and one quick retry. |
| `answers.ts`, `normalize.ts` | `@attune/jev` | The readers that check each answer against the question sent and the catalog, and turn it into typed judgments. |
| `hooks.ts` | `@attune/react` | Keyboard, debounce, throttle, clock, element size, roving lists, popovers. |
| `guard.ts` | `@attune/server` | Loopback and CDN-edge request checks, rate limiter. |

In `apps/demo` (still names the demo's panels, goals, or records):
everything else.

### How the demo uses a moved module

Demo files import general names straight from `@attune/core`. Where a
library function needs the app's vocabulary, the demo has a small adapter at
the old path that binds it once: `src/engine/usage.ts` (the demo's event
weights and `CATALOG.panelIds`), `src/engine/quiet.ts` (`isQuietTouch`, the
panel ids, and the goal labels), and `src/ui/choreography.ts` (panel titles), `src/engine/snapshot.ts` (the
demo's signal profile, words, its own event sentences, and what its focused
panel shows), and `src/engine/policy.ts` (`createPolicy` with the demo's
suggestions, link words, Guide, habit words, and engine notes). The demo's
`src/engine/store.ts` calls `placePlan` for its place step.
An adapter holds only that binding and types narrowed to the demo's ids.

## The main blocker: the catalog is a module, not configuration

`apps/demo/shared/catalog.ts` exports `PANEL_IDS`, `PANELS`, `GOALS`,
`ACTIONS`, and `GOAL_PANEL_AFFINITY` as constants. Most engine and server
modules import them directly. A library cannot do that: it must receive the
catalog from the app.

Step 1 is done. `@attune/core` has the `Catalog` type and `defineCatalog`,
and the demo builds `CATALOG` from its constants (checked when the module
loads). The layout modes moved into the library; the demo re-exports them,
so existing imports still work. Nothing reads `CATALOG` yet: from step 2 on,
each module that moves takes the catalog (or only the ids it needs) as an
argument or through a factory such as `createEngine(catalog, ...)`.

The demo still writes the no-match ids as the literals "unclear" and "none"
(about 125 places). Switch them to `UNCLEAR_GOAL` and `NO_ACTION` as each
module moves, not in one bulk rename.

## Next moves, in order

Each step keeps `pnpm test` green and the demo working.

1. **Catalog as configuration.** Done. Add the `Catalog` type to core. Make
   the demo's `shared/catalog.ts` build a value of it. No behavior change.
2. **Small engine modules that only need ids.** Done. `usage.ts` and
   `quiet.ts` take the panel ids, and the app says what its events mean
   (each event's weight; which events count as use). `choreography.ts` takes
   a panel title function. The row fit from `assistFit.ts` is `rowFit.ts`;
   the demo's card kinds and order stay in `src/ui/assistFit.ts`.
3. **The question layer.** Done. The core questions, the state, and the
   answer readers are in a new `@attune/jev`, so `@attune/server` stays free
   of the TypeSafe SDK (a peer dependency of `@attune/jev`). Each goal's
   `notFor` and each panel's `commandExamples` moved into the catalog. The
   demo keeps its own questions: clients, the next record and list work,
   goal done and next task, the link questions, invoice status, time
   period, and meeting prep. A dump of the state, questions, read answers,
   and heuristic answers for all 35 eval requests was byte for byte the
   same before and after.
   Left as is: the expertise levels still say "opening the guide", and the
   command panel's no-match examples are fixed English. Both are fine for
   the demo; a second app may need them to be options.
4. **The Jev call.** Done. `askJev` sends one request with a total time
   budget and answers with the app's fallback on any failure (the demo
   passes its heuristic, named "heuristic", so its responses and log lines
   read as before). `createRealtimeJevClient` holds the client tuning. The
   demo's `server/adapt.ts` and `server/jev.ts` are now short bindings. The
   timeout message reads the attempt timeout from the SDK error instead of
   a copied constant.
5. **Snapshot and policy.** Mostly done, in two parts. 5a: the snapshot
   rules and the core signal vocabulary are in `@attune/core`; the demo
   keeps its own event types and sentences. 5b: the general policy rules
   (the blend, mode, density, help, panels in use) are in `@attune/core`.
   Dumps of 18,792 event sentences, every snapshot of 37 event sets, and
   four full `computePlan` rounds for 20 scenarios were byte for byte the
   same before and after.
   Still in the demo: `computePlan` itself (placements, docking with its
   hysteresis, order, sizes, anchors and links), the suggestions with their
   record arguments, and `traditionalPlan`. They read `LayoutPlan` and
   `Suggestion`, whose fields name the demo's records, so they move with
   step 6, once the plan has a generic part. The demo still has two tables
   of record kinds in words (`ITEM_WORDS` in `src/engine/snapshot.ts` and
   `RECORD_KIND_WORDS` in `server/questions.ts`); they could become one
   catalog field.
6. **The store.** Done in three parts; a fourth is next.
   6a: the plan types and the whole policy round are in `@attune/core`
   (`createPolicy`), with the demo's suggestions and words as hooks.
   6b: the place step is `placePlan` in `@attune/core`; the demo's store
   calls it. 6c: `createAdaptiveStore` in `@attune/core` runs the whole
   loop for an app, and `useAdaptive` in `@attune/react` reads it. Dumps of
   the demo store over every scenario and eight seeded random sessions
   (pointer moves, pins, resizes, commands, undo, column changes), and the
   policy over four rounds of 20 scenarios with every plan edit, were byte
   for byte the same before and after.
6d. **The demo on the library store.** The demo still runs its own store
   (`apps/demo/src/engine/store.ts`), built from the library's parts, because
   its focus aids hook into the loop in many places: Up next and Back to,
   the Done card, habits, meeting prep, the link cues that outlive the
   anchor, the quiet rule, the front group, saved settings, the metrics, and
   the command view patches. Moving it onto `createAdaptiveStore` needs
   extension hooks in the store (on track, before a request, on an answer,
   extra policy input, after the plan, commit gates) and extra state for each
   aid. Until then the two loops share every pure part but not the loop
   itself, so a fix to one must be checked in the other.
7. **React components.** Done for apps on the library store:
   `AdaptiveCanvas`, `PanelCard`, `Dock`, and `ChangeLine` in
   `@attune/react`, with the demo's stage timing, the dock flight, and
   reduced motion. The playground uses them and shows the staged rounds.
   They draw no look of their own (no Tailwind classes), so an app's CSS
   needs no `@source` for them. The app renders each card's content
   (`renderCard`), which is the panel registry.
   Still the demo's own, until it moves onto the library store (6d): its
   `Canvas` and `PanelFrame` with the link lines, the anchor note, the ghost
   slot after a dock, quiet fades, keyboard focus restore, the scroll safety
   net, the front ring, and the "Why here?" popover. Those are the next
   additions to the library canvas, as the demo moves over.
8. **A second app.** Done: `apps/playground`, a help desk with four panels
   of its own, built only from the packages on `createAdaptiveStore` and
   `useAdaptive`, with its own Jev server. It ran live with Jev. Building it
   added to the library: `CORE_USAGE_WEIGHTS` and `eventWeight`,
   `basicSuggestions` and `basicRelation`, the calm fallback
   (`neutralJudgments`), `buildRound` and `readRound`, `parseAdaptRequest`,
   cells for the store's first plan, and the store's `anchorLabel`. Still
   missing, from its README: the canvas components with staged motion (step
   7), commands that set filters or name records, and the demo's focus aids
   in the store (6d).
9. **Publish.** A build per package (for example tsdown) that emits
   JavaScript and `.d.ts` into `dist/`, `exports` that point there,
   versioning (for example changesets), a license, and an npm scope. This
   needs the owner's decision before any package goes public.

## Rules that carry over

- Jev only judges. Code owns every threshold, weight, and placement.
- The panel the user just worked in does not move during a relayout.
- Every change on screen has a reason the user can see.
- The model key stays on the server, behind the guard.
