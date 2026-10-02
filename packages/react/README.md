# @attuneui/react

React bindings for Attune: the adaptive canvas with staged relayouts.

- `AdaptiveCanvas` shows a layout plan with every card in the cell the plan
  gives it, so the panel the user just worked in holds still, and stages
  each change: the anchor grows first, leaving cards fly into their dock
  item, moved cards glide, and new cards arrive one at a time. Reduced
  motion turns every move into a short fade.
- `PanelCard` is one animated card. An app can draw its own card around it.
- `Dock`, `ChangeLine` (the last change, with Undo), `useAdaptive`, and
  `useStoreCanvas`, which wires the canvas to a store from
  `createAdaptiveStore` in `@attuneui/core`.

The components draw no look of their own, only the layout they need. Style
them with class names and data attributes (`data-panel`, `data-anchor`,
`data-linked`, `data-quiet`, and others).

```sh
npm install @attuneui/react @attuneui/core motion react
```

```tsx
import { AdaptiveCanvas, Dock, useStoreCanvas } from "@attuneui/react";

function App() {
  const canvas = useStoreCanvas(store);
  return (
    <>
      <AdaptiveCanvas {...canvas} renderCard={(p) => <Panel id={p.id} size={p.size} />} />
      <Dock docked={canvas.plan.docked} label={(id) => CATALOG.panels[id].title} onOpen={(id) => store.open(id)} />
    </>
  );
}
```

One rule an app's CSS needs: give `[data-canvas] > [data-motion-pop-id]`
`grid-area: auto !important`, so a card leaving the grid flies to the dock
from where it was.

A full example is in
[apps/playground](https://github.com/dwamianm/attune/tree/main/apps/playground).
`motion` and `react` are peer dependencies.

MIT license.
