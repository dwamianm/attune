# @attuneui/jev

The model layer for Attune apps that use Jev (TypeSafe's System One) to
judge what the user is doing.

- `buildRound` builds the state and every core question for one round from
  the app's catalog: the goal, each panel's relevance, whether the user is
  struggling, the layout, expertise, the next action, and, with a command,
  the panel and action it names.
- `readRound` checks each answer against the question sent and the catalog,
  and returns the typed judgments `@attuneui/core` reads.
- `askJev` sends one round with a total time budget and always answers: on
  any failure it returns the app's fallback.
- `createRealtimeJevClient` makes a client tuned for a real-time UI.

```sh
npm install @attuneui/jev @attuneui/core @typesafe-ai/sdk
```

```ts
import { neutralJudgments } from "@attuneui/core";
import { askJev, buildRound, readRound } from "@attuneui/jev";

const { state, questions } = buildRound(CATALOG, { app: "A help desk for a small software company.", snapshot, command: null });
const round = await askJev({
  client,
  state,
  questions,
  read: (answers) => readRound(answers, questions, CATALOG),
  // The calm answer on any failure: every panel supporting, no goal, no next step.
  fallback: { name: "fallback", answer: () => neutralJudgments(CATALOG) },
  budgetMs: 4_500,
  logTag: "[adapt]",
});
```

Use it only on a server: the model key must never reach the browser.
`@typesafe-ai/sdk` is a peer dependency, because the app creates the
client. A full server is in
[apps/playground/server](https://github.com/dwamianm/attune/tree/main/apps/playground/server).

MIT license.
