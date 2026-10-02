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
import { basicRelation, basicSuggestions, createAdaptiveStore, createPolicy, defineCatalog, eventWeight, panelUsage, type AdaptiveSpec } from "@attuneui/core";

const CATALOG = defineCatalog({ panelIds, panels, goalIds, goals, actionIds, actions, goalPanelAffinity });

interface MySpec extends AdaptiveSpec {
  panel: PanelId;
  goal: GoalId;
  action: ActionId;
  policyExtra: undefined;
}

const POLICY = createPolicy({
  catalog: CATALOG,
  usage: (events, now) => panelUsage(events, now, { panelIds: CATALOG.panelIds, weight: (e) => eventWeight(e) }),
  suggest: (input) => basicSuggestions(CATALOG, input.judgments),
  relationFor: (anchor, panel, records) => basicRelation(anchor, panel, records, CATALOG.panels),
});

const store = createAdaptiveStore<MySpec>({
  catalog: CATALOG,
  policy: POLICY,
  words: { panels: CATALOG.panels, itemWords: { ticket: "ticket" } },
  send: (request, { signal }) => fetch("/api/adapt", { method: "POST", body: JSON.stringify(request), signal }).then((r) => r.json()),
});

store.track({ type: "item_open", panel: "tickets", detail: { itemKind: "ticket", itemId: "T-201" } });
store.subscribe((state) => render(state.plan));
```

An app adds its own features to the loop through hooks and an `extend`
function instead of a second loop. A full app built only from the
packages is in
[apps/playground](https://github.com/dwamianm/attune/tree/main/apps/playground),
and the design is in
[docs/library-roadmap.md](https://github.com/dwamianm/attune/blob/main/docs/library-roadmap.md).

MIT license.
