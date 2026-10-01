# Attune

Attune is an AI-native UI library in progress: a canvas of panels that adapts
in real time to how the user works. A model (Jev, TypeSafe's System One)
makes the semantic judgments, such as what the user is trying to do and which
panels help. Code makes every layout decision, such as weights, thresholds,
and where each card goes.

This repo is a pnpm monorepo. The library lives in `packages/`. The prototype
that proves it out lives in `apps/demo`.

```
packages/
  core/     @attune/core    Framework-free: the catalog type and its check, the layout
                            modes, the anchored grid packer, the request scheduler,
                            recent use, the quiet rule, the staged relayout timing,
                            the row fit, plain-word helpers. No DOM, no React, no network.
  react/    @attune/react   React bindings. Today: generic hooks (keyboard, sizes,
                            roving lists, popovers).
  server/   @attune/server  For the server that holds the model key: request guard
                            (loopback or CDN edge) and a rate limiter.
apps/
  demo/     @attune/demo    The Attune prototype ("Fernhill Studio"): web app, API
                            server, eval, AWS deploy. See apps/demo/README.md.
docs/
  library-roadmap.md        What moves into the library next, and what blocks it.
```

## Run it

Requirements: Node 20.19 or newer, or 22.12 or newer (developed on Node 24),
and pnpm 10.

1. `pnpm install` at the repo root. It installs every package and links the
   library packages into the demo.
2. Put your TypeSafe key in `apps/demo/.env` (copy `apps/demo/.env.example`).
   Without a key the demo still runs on a labeled heuristic.
3. `pnpm dev` starts the demo's API server (http://localhost:8790) and Vite
   (http://localhost:5173).

Root scripts:

| Script | What it does |
| --- | --- |
| `pnpm dev` | Run the demo (API server and web app) |
| `pnpm test` | Every package's and app's unit tests in one vitest run |
| `pnpm typecheck` | `tsc --noEmit` in every package and app |
| `pnpm build` | Every package that has a build (today: the demo web app) |
| `pnpm eval` | The demo's live Jev eval (needs the key) |
| `pnpm deploy:aws` | Publish the demo to https://attuneui.com (see apps/demo/README.md) |

To work on one package: `pnpm --filter @attune/core test`, or `cd` into it
and run `pnpm test` or `pnpm typecheck`.

## Working on the library

- **Library code is source-first.** Each package's `exports` points at
  `src/index.ts`. Vite, vitest, tsx, and esbuild all read TypeScript, so an
  edit in `packages/` shows up in the demo at once, with no build step and no
  watch process.
- **Dependencies point one way.** Apps depend on packages. `@attune/react`
  and `@attune/server` may depend on `@attune/core`. Nothing in `packages/`
  imports from `apps/`.
- **No app vocabulary in the library.** Library code never names the demo's
  panels, goals, actions, or records. Where the demo needs its own ids, the
  library is generic over them: for example `packGrid<Id extends string>`,
  and the demo writes `PackItem<PanelId>`.
- **Shared versions.** `pnpm-workspace.yaml` holds one version of
  TypeScript, vitest, React, and the type packages in its `catalog`. A
  package.json takes it with `"catalog:"`.
- **Tests move with code.** A module that moves into a package takes its
  tests with it. App-specific cases stay in the app.
- **The app says what its events mean.** The library does not know an app's
  event types. Where a rule reads events, the app passes a small function,
  such as the weight of an event for recent use, or whether an event counts
  as use for the quiet rule.
- **Adapters bind once.** Where the demo needs a library function with its
  own vocabulary, a small demo file binds it (see "How the demo uses a moved
  module" in docs/library-roadmap.md). Everything else imports from the
  package directly.

### Add a package

1. Make `packages/<name>/` with `package.json` (name `@attune/<name>`,
   `"private": true`, `"type": "module"`, `exports` pointing at
   `./src/index.ts`, and `typecheck` and `test` scripts), a `tsconfig.json`
   that extends `../../tsconfig.base.json`, and a `vitest.config.ts` with a
   `name`.
2. Add it to the app that uses it: `"@attune/<name>": "workspace:*"`.
3. Run `pnpm install`.

## Decisions

These are the choices made when the prototype became a monorepo, and why.

- **Three packages, not one.** `core` must run anywhere, `react` needs
  React, and `server` needs Node (`node:crypto`). Separate packages make
  those limits real dependencies instead of a rule in a comment.
- **Source exports, not a build.** Nothing is published yet, so a build
  step would only slow down work on the library. Before the first publish,
  each package needs a build that emits JavaScript and `.d.ts` files (see
  the roadmap).
- **`private: true` on every package.** Publishing is a separate decision
  (npm scope, license, versioning). The `@attune` scope is a working name.
- **The app's vocabulary is a `Catalog`.** An app lists its panels, goals,
  actions, and goal-to-panel affinity once and passes the list through
  `defineCatalog`, which reports every mistake when the app starts. Two ids
  are fixed by the library, "unclear" (`UNCLEAR_GOAL`) and "none"
  (`NO_ACTION`), because every model choice needs an explicit no-match
  option. The three layout modes belong to the library, not the catalog,
  because the policy treats each one differently.
- **The demo keeps its vocabulary.** The demo's catalog, fixtures, Jev
  questions, policy, and store still live in `apps/demo`. They name the
  demo's panels directly, so they move only after the catalog becomes
  configuration (see the roadmap).
- **`@types/react` is hoisted.** motion's type files import `react`, and
  pnpm does not link `@types/react` beside motion. `publicHoistPattern` in
  `pnpm-workspace.yaml` puts it at the root, so TypeScript finds it the way
  it did before.
- **localStorage keys keep the `floouid:` prefix.** They predate the rename.
  Changing them would reset every saved setting.
