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
  core/     @attuneui/core    Framework-free: createAdaptiveStore (the whole loop), the
                            catalog type and its check, the signal vocabulary, the
                            snapshot in words, the layout policy (createPolicy) and
                            its rules, the place step, the layout modes, the anchored
                            grid packer, the request scheduler, recent use, the quiet
                            rule, the staged relayout timing, the row fit, plain-word
                            helpers. No DOM, no React, no network.
  react/    @attuneui/react   React bindings: the adaptive canvas with staged relayouts
                            (AdaptiveCanvas, PanelCard, Dock, ChangeLine), useAdaptive
                            and useStoreCanvas for a library store, and generic hooks.
  jev/      @attuneui/jev     The Jev question layer: the core questions built from the
                            catalog, readers that turn answers into typed judgments,
                            and one round with a time budget and the app's fallback.
  server/   @attuneui/server  For the server that holds the model key: request guard
                            (loopback or CDN edge) and a rate limiter.
apps/
  demo/     @attuneui/demo    The Attune prototype ("Fernhill Studio"): web app, API
                            server, eval, AWS deploy. See apps/demo/README.md.
  playground/ @attuneui/playground  A second app, a small help desk, built only from
                            the packages. See apps/playground/README.md.
  docs/     @attuneui/docs    The documentation site (Nextra on Next.js): getting
                            started, concepts, the packages, and guides, plus
                            llms.txt and llms-full.txt for AI assistants.
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
| `pnpm dev:playground` | Run the playground (API on 8791, web on 5174), next to the demo if you like |
| `pnpm dev:docs` | Run the documentation site on http://localhost:5175 |
| `pnpm test` | Every package's and app's unit tests in one vitest run |
| `pnpm typecheck` | `tsc --noEmit` in every package and app |
| `pnpm build` | Every package and app that has a build: the four packages, the demo and playground web apps, and the docs site |
| `pnpm build:packages` | Only the four library packages |
| `pnpm eval` | The demo's live Jev eval (needs the key) |
| `pnpm deploy:aws` | Publish the demo to https://attuneui.com (see apps/demo/README.md) |
| `pnpm deploy:docs` | Publish the docs to https://attuneui.dev (see apps/docs/README.md) |

To work on one package: `pnpm --filter @attuneui/core test`, or `cd` into it
and run `pnpm test` or `pnpm typecheck`.

## Working on the library

- **Library code is source-first.** Each package's `exports` points at
  `src/index.ts`. Vite, vitest, tsx, and esbuild all read TypeScript, so an
  edit in `packages/` shows up in the demo at once, with no build step and no
  watch process.
- **Dependencies point one way.** Apps depend on packages. `@attuneui/react`
  and `@attuneui/server` may depend on `@attuneui/core`. Nothing in `packages/`
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
- **The app says what its events mean.** The library knows only the core
  signal types (`CoreSignalType`). An app adds its own types and says how
  they count in a `SignalProfile` (as record opens, work, pointer use, or
  cue-only), or passes a small function where a rule needs more, such as the
  weight of an event for recent use.
- **One loop, with hooks.** The adaptive loop lives once, in
  `@attuneui/core` (`createAdaptiveEngine`, `createAdaptiveStore`). An app's
  own features join it through hooks at fixed points and an `extend`
  function, the way the demo adds its focus aids, instead of a second loop
  (docs/library-roadmap.md, step 6d).
- **Adapters bind once.** Where the demo needs a library function with its
  own vocabulary, a small demo file binds it (see "How the demo uses a moved
  module" in docs/library-roadmap.md). Everything else imports from the
  package directly.

### Add a package

1. Make `packages/<name>/` with `package.json` (name `@attuneui/<name>`,
   `"type": "module"`, `"license": "MIT"`, `exports` pointing at
   `./src/index.ts`, `publishConfig` pointing at `./dist`, `files`, and
   `build`, `prepack`, `typecheck`, and `test` scripts; copy them from
   `packages/server/package.json`), a `tsconfig.json` that extends
   `../../tsconfig.base.json`, a `tsconfig.build.json` like the other
   packages', a `vitest.config.ts` with a `name`, a `README.md`, and a copy
   of `LICENSE`.
2. Add it to the app that uses it: `"@attuneui/<name>": "workspace:^"`, and
   to the `fixed` group in `.changeset/config.json`.
3. Run `pnpm install`.

## Publish

The four packages are public on npm under the `@attuneui` scope, MIT
licensed, and always released together at one version. Nothing is
published yet. The first release needs the owner:

1. On npmjs.com, create the free organization `attuneui` (for public
   packages), and log in here with `npm login`.
2. Run `pnpm release`. It builds the four packages and runs `changeset
   publish`, which publishes each package whose version is not on npm yet
   and tags it in git.
3. Push the tags: `git push --follow-tags`.

Later releases:

1. With each change users should know about, run `pnpm changeset` and
   describe it in one line.
2. To release, run `pnpm version-packages`. It bumps the version and writes
   each package's CHANGELOG.md from the changesets. Commit that.
3. Run `pnpm release` and push the tags.

What goes out: `dist/` (JavaScript, `.d.ts` files, and their maps), `src/`
without the tests (for the maps), `README.md`, and `LICENSE`. In the
monorepo, apps and tests still import each package's source
(`exports` is `./src/index.ts`); `publishConfig` switches the published
`exports` to `./dist`, and pnpm turns `workspace:^` and `catalog:` into
real versions. To see a package exactly as it would go out, run `pnpm
pack` in its folder.

## Decisions

These are the choices made when the prototype became a monorepo, and why.

- **Four packages, not one.** `core` must run anywhere, `react` needs
  React, `server` needs Node (`node:crypto`), and `jev` needs the TypeSafe
  SDK. Separate packages make those limits real dependencies instead of a
  rule in a comment, and an app that does not use Jev never installs the
  SDK. The SDK is a peer dependency of `jev`, because the app owns the
  client that sends the request.
- **Source in the repo, a build on npm.** Inside the monorepo every
  package exports its TypeScript source, so work on the library needs no
  build step. The published packages get a build from plain `tsc`
  (`scripts/build-package.mjs`): JavaScript and `.d.ts` files in `dist/`,
  with no bundler and no extra build tool, because each package is a few
  small modules that apps bundle anyway.
- **One scope, one version, MIT.** The packages are `@attuneui/*`
  (`@attune` was the working name; the plain name `attune` is taken on
  npm), MIT licensed, and versioned together with changesets, so an app
  never mixes versions of the parts.
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
