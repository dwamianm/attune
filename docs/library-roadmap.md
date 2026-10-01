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
| `judgments.ts`, `snapshot.ts` | `@attune/core` | The typed answers the layout code reads (`ChoiceJudgment`, `ScoreJudgment`, `CoreJudgments`, `CoreCommandJudgments`) and the words-only `InteractionSnapshot`, with the one command activity line both sides must agree on. |
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
panel ids, and the goal labels), and `src/ui/choreography.ts` (panel titles).
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
5. **Snapshot and policy.** `snapshot.ts` (events into sentences) and
   `policy.ts` (blend relevance, use, and goal affinity; hysteresis;
   anchors) are the core of the library and the largest step. Split the
   generic rules from the demo's record-specific ones (invoices, messages).
6. **The store.** `store.ts` (3,700 lines) ties everything together with
   zustand. Make a `createAdaptiveStore(config)` in the library, and keep
   the demo's actions (send reminder, resend invoice) in the demo.
7. **React components.** `Canvas`, `PanelFrame`, `Dock`, `ChangeFeed`, and
   `LinkLines` into `@attune/react`, with a panel registry (panel id to
   component). Tailwind v4 only scans the app by default, so the demo's CSS
   then needs `@source "../../../packages/react/src";` for the classes in
   the library components.
8. **A second app.** `apps/playground` (or similar) with three or four
   panels of its own, built only from the packages. Anything it cannot do
   without copying demo code shows what is still missing.
9. **Publish.** A build per package (for example tsdown) that emits
   JavaScript and `.d.ts` into `dist/`, `exports` that point there,
   versioning (for example changesets), a license, and an npm scope. This
   needs the owner's decision before any package goes public.

## Rules that carry over

- Jev only judges. Code owns every threshold, weight, and placement.
- The panel the user just worked in does not move during a relayout.
- Every change on screen has a reason the user can see.
- The model key stays on the server, behind the guard.
