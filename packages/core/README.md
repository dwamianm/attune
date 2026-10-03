# @attuneui/core

The framework-free part of Attune, an adaptive UI library: a canvas of
panels that rearranges itself around what the user is doing. A model
judges what the user is working on and which panels help; this package
makes every layout decision from those judgments, in code.

It holds the whole adaptive loop (`createAdaptiveStore`): the event log,
the snapshot of recent activity in words, request scheduling, the layout
policy (`createPolicy`), the anchored grid that keeps the panel the user
just worked in still, the staged relayout timing, and undo. No DOM, no
React, no network: the app passes a `send` function that calls its own
server.

```sh
npm install @attuneui/core
```

```ts
import { createAdaptiveWorkspace, defineCatalog } from "@attuneui/core";

const catalog = defineCatalog({ panelIds, panels, goalIds, goals, actionIds, actions, goalPanelAffinity });
const store = createAdaptiveWorkspace({
  catalog,
  // Your transport returns an AdaptiveResponse with typed judgments.
  send: postAdapt,
  words: { itemWords: { ticket: "ticket" } },
});

store.track({ type: "item_open", panel: "tickets", detail: { itemKind: "ticket", itemId: "T-201" } });
store.subscribe((state) => render(state.plan));
store.setSettings({ layoutBehavior: "suggestions", density: "standard" });
```

`createAdaptiveWorkspace` infers the IDs from the catalog and supplies the
standard policy, usage weights, suggestions and link labels. Pass `linked`
for your record joins. Density defaults to `standard`; `auto` opts into
inferred density. Suggestions-only keeps the arrangement while updating
assistance; explicit commands and panel controls still work. Settings stay
in memory unless your app supplies a `persist` hook.

Use `createAdaptiveStore` and `createPolicy` directly for a custom engine.
The `send` boundary works with any model or a local rules-based answer.

An app adds its own features to the loop through hooks and an `extend`
function instead of a second loop. A full app built only from the
packages is in
[apps/playground](https://github.com/dwamianm/attune/tree/main/apps/playground),
and the design is in
[docs/library-roadmap.md](https://github.com/dwamianm/attune/blob/main/docs/library-roadmap.md).

MIT license.
