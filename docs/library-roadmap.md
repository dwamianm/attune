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
| `scheduler.ts` | `@attune/core` | `AdaptScheduler`: debounce, max wait, one request in flight, commands first. The app decides which events are triggers. |
| `words.ts` | `@attune/core` | Numbers and ids as plain words, for the model and for people. |
| `hooks.ts` | `@attune/react` | Keyboard, debounce, throttle, clock, element size, roving lists, popovers. |
| `guard.ts` | `@attune/server` | Loopback and CDN-edge request checks, rate limiter. |

In `apps/demo` (still names the demo's panels, goals, or records):
everything else.

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
2. **Small engine modules that only need ids.** `usage.ts` (recent use) and
   `quiet.ts` (focus aid 1) loop over `PANEL_IDS`; pass the ids in.
   `choreography.ts` (stage timing and cues) needs panel titles for two
   strings; pass a title function. `assistFit.ts` (`fitRow`) is already
   pure; its slot kinds stay in the demo.
3. **The question layer.** `server/questions.ts` builds Jev questions from
   the catalog, and `server/normalize.ts` checks the answers against the
   questions sent. Split each into a generic part that reads a `Catalog`
   (into `@attune/server`, or a new `@attune/jev` if the TypeSafe SDK should
   stay optional) and the demo's own questions (record candidates, meeting
   prep).
4. **The Jev call.** `server/adapt.ts` and `server/jev.ts`: one request,
   a total time budget, one short retry, and a fallback answer on any
   failure. Make the fallback a function the app passes (the demo passes its
   heuristic).
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
