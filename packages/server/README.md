# @attuneui/server

Helpers for the server of an Attune app, the one that holds the model API
key. The browser never calls the model directly; it calls this server, and
these helpers keep anyone else from spending the key.

- `checkRequest` accepts a request only from the app on this machine (a
  loopback host and origin) or through a CDN edge that adds a shared secret
  header, and can require a JSON body.
- `createRateLimiter` allows a few requests per short window.
- `parseAdaptRequest` checks and clips an adapt request body (its version,
  snapshot, and command) before anything reaches the model.

```sh
npm install @attuneui/server
```

```ts
import { checkRequest, createRateLimiter, parseAdaptRequest } from "@attuneui/server";

const allow = createRateLimiter();
const refused = checkRequest({ host, origin, contentType }, { requireJson: true });
if (refused) return respond(refused.status, { error: refused.error });
if (!allow()) return respond(429, { error: "Too many requests." });
const parsed = parseAdaptRequest(body);
if (!parsed.ok) return respond(400, { error: parsed.error });
```

A full server is in
[apps/playground/server](https://github.com/dwamianm/attune/tree/main/apps/playground/server).

MIT license.
