# Attune demo

This app is the Attune prototype. It lives in the monorepo at `apps/demo` and
uses the library packages in `packages/` (see the root README). Paths in this
file are relative to `apps/demo` unless they start with `packages/`.

Attune is a prototype of a UI that adapts to how you work, instead of making you
navigate between pages. Every capability of a small studio app is a panel on one
canvas. As you click, search, filter, rest the pointer, use shortcuts, or type in
the command bar, the canvas rearranges itself. It reorders and resizes panels,
switches between a Focus, Compare, and Overview layout, suggests a next step,
offers the record you will likely work on next ("Up next"), brings back what
you were doing before in one click ("Back to"), offers help when you seem
lost, and before a meeting with a client brings up what matters for it.

Two parts share the work:

- **Jev** (TypeSafe's System One model) makes the semantic judgments: what you
  are trying to do, which panels are useful for it, whether you are stuck,
  which layout fits, what you will likely do next, and which client the work
  is about.
- **Code** owns every policy decision: weights, thresholds, hysteresis, and the
  final layout. Jev never places a panel.

The demo data is "Fernhill Studio", a fictional six-person design studio
(`shared/fixtures.ts`). All names and companies are invented.

## Run it

Requirements: Node 20.19 or newer, or 22.12 or newer (the versions Vite 8
supports; vitest 5 officially wants 22.12 or newer; developed on Node 24), and
pnpm 10.

1. `pnpm install` (at the repo root; it installs every package)
2. Put your TypeSafe key in `apps/demo/.env` (copy `apps/demo/.env.example`):
   `JEV_API_KEY=...` (the server also accepts `TYPESAFE_API_KEY`). Get a key at
   https://console.typesafe.ai/keys.
3. `pnpm dev` (at the repo root, or in `apps/demo`) starts the API server on
   http://localhost:8790 and Vite on http://localhost:5173.
4. Open http://localhost:5173.

The key stays in the Node server. The browser only talks to `/api`, which Vite
proxies to the server. Without a key the app still runs: the server answers with
a labeled heuristic, and the header shows "Offline with heuristic" (a real Jev
failure shows "Error" instead).

If port 8790 is taken, set `PORT` in the shell or in `.env` (not `.env.local`:
the server does not read it). Both the server and the Vite proxy read the same
value. If 5173 is taken, Vite picks the next free port and prints it.

The server listens on `localhost` only (set `HOST` to change that), because
every request spends the Jev key. It answers only requests whose Host is a
loopback name, whose Origin (when sent) is a loopback page, and whose body is
declared `application/json`, and it allows at most 8 `/api/adapt` requests in
any 2 s (and, apart from those, 4 `/api/prep` requests in any 2 s). Commands longer than 300 characters are clipped, not rejected, and the
command box stops at 300.

Other scripts:

| Script | What it does |
| --- | --- |
| `pnpm dev:server` / `pnpm dev:web` | Run one half on its own |
| `pnpm typecheck` | `tsc --noEmit` over this app (at the root: every package) |
| `pnpm test` | Unit tests (vitest, no network; at the root: every package) |
| `pnpm build` | Production build of the web app into `apps/demo/dist/` |
| `pnpm eval` | Checks live Jev answers against scripted sessions (needs the key) |
| `pnpm deploy:aws` | Publishes the app to https://attuneui.com (see "Deploy to AWS") |

### Deploy to AWS

`pnpm deploy:aws` (`deploy/deploy.sh`) publishes the app to https://attuneui.com
with the AWS CLI profile `junction`. It needs the Jev key in `.env`, `zip`, and
`openssl`. Run it again after any change; it only changes what changed.

- **Web app.** `dist/` goes to a private S3 bucket in us-west-1. CloudFront
  serves it. Only CloudFront can read the bucket.
- **API.** CloudFront forwards `/api/*` to a Lambda (`attune-api`, us-west-1)
  that runs `server/lambda.ts`: the same routes, rate limits, and validation
  as the local server. The Jev key is a Lambda environment variable.
- **Password.** A CloudFront Function asks for a user name and password on
  every request, pages and API alike, so only people with the password can
  spend the Jev key. The first run makes the password and keeps it in
  `.env.deploy` (git-ignored). To change it, edit `SITE_PASSWORD` there and
  run `pnpm deploy:aws` again.
- **Guard.** Deployed, the Host is the Lambda URL, not loopback, so the API
  swaps the loopback checks for two others (`EdgeAccess` in
  `packages/server/src/guard.ts`): each request must carry the secret
  header CloudFront adds (`ORIGIN_SECRET` in `.env.deploy`), and an Origin
  must be https://attuneui.com. A call straight to the Lambda URL gets a 403. The
  local server never takes this path.
- **Spend cap.** The Lambda has 10 reserved instances, so at most 10 Jev calls
  run at once. Each instance also keeps the same rate limits as the local
  server.
- **Domain.** `www.attuneui.com` and the CloudFront default name redirect to
  https://attuneui.com, the one Origin the API accepts. The certificate lives
  in its own stack in us-east-1 (`deploy/cert.yaml`), because CloudFront only
  reads certificates from there.

Two CloudFormation stacks hold everything: `attune-cert` (us-east-1) and
`attune` (us-west-1). Logs are in CloudWatch under `/aws/lambda/attune-api`
for 14 days. `bash deploy/destroy.sh` deletes both stacks and the site files
(it asks first). It keeps the domain and its Route 53 zone.

Things to try: open Priya Nair's "Re: Invoice INV-1042" in Inbox (it asks to
resend the invoice): Invoices, Tasks, and Clients gather next to it, Invoices
first with "Next: resend INV-1042"; press `n` to open the invoice, `.` to
resend it, and `.` again to check off the matching to-do item. Filter
Invoices to Overdue and open an invoice; type "who still
owes us money?" or "who is away today?" in the command bar (Cmd+K or Ctrl+K);
press `.` (outside a text box) to accept the highlighted suggestion; send a
reminder on two overdue invoices, then press `n` to open the next one and keep
going; once every overdue invoice has a reminder, a minute into the work the
Done card says "Payments done" and offers the next task, and `n` starts it;
after a few clicks in Calendar and Tasks, press `b` to go back to the
invoices as you left them; open the Inspector and replay the "New user who is
lost" scenario from its Controls tab; in the Inspector's Habits tab, press
"Load a sample week", then open a message in Inbox and look at "Why here?"
on the panel you usually open next ("You usually open Invoices after Inbox
in the afternoon"); open the Focus settings (the gear) and press "Test:
simulate a meeting in 10 minutes", then press `p` on the prep chip to bring
up the client's records next to the meeting.

## How it works

```
UI signals            clicks, searches, filters, pointer rests, shortcuts, commands
  -> event log        src/engine/store.ts (track)
  -> snapshot         src/engine/snapshot.ts: recent activity and behavior facts, in words
  -> one Jev request  server/questions.ts (core questions from @attune/jev): small state, 16 questions, plus 2 with record candidates, 1 with the working goal, 1 with task candidates, 2 with a clicked record, and 5 with a command
  -> judgments        server/normalize.ts (core readers from @attune/jev): typed Choice, Score, and Noul answers
  -> policy           src/engine/policy.ts: weights, thresholds, hysteresis
  -> layout plan      mode, ordered placements with sizes, dock, suggestions, help
  -> place step       @attune/core packGrid: explicit grid cells, the clicked panel held still
  -> animated canvas  src/ui/Canvas.tsx and PanelFrame.tsx (staged motion layout animations)
```

1. **Signals.** Panels report what the user does through `track()`. Every event
   gets a one-sentence description (`describeEvent`), for example
   `Opened invoice INV-1042 for Harbor Coffee Co. (overdue)`.
2. **Snapshot in words.** Jev reads words better than numbers and cannot count,
   so code does the counting and timing and writes the result as sentences:
   repeated searches for the same word, searches that led nowhere, panels opened
   and closed within seconds, the same record opened three or more times
   without acting on it, a search phrased as a how-to question, switching back
   and forth, keyboard versus pointer use (panel searches count as neither),
   pace (pointer rests left out), idle time, undo, and accepted or dismissed
   suggestions. The snapshot keeps the last 15 activity lines.
3. **Scheduling.** Meaningful events (opening a record or panel, a filter, a
   search, an action, docking a panel, dismissing a suggestion, or clicking into
   another panel) schedule a request with a 700 ms debounce and a 2.5 s maximum
   wait. Moving focus with Tab alone does not. Only one request is in flight at
   a time. Commands skip the wait and cancel a pending background request.
   Pointer rests, scrolls, and shortcuts only refresh the suggestions from the
   last judgments; they never move a panel. Making a panel bigger or smaller
   never asks Jev by itself either; the next round reads it.
4. **One Jev request.** The server builds a small state (`earlier_activity`,
   `latest_activity`, `current_focus`, `visible_panels`,
   `behavior_observations`, plus `command` and `client_companies` when a command
   is set; the command-bar line for that same command is not repeated as
   `latest_activity`) and asks every question in one `systemOne` call, so they
   run in parallel. Typical latency is about 150 to 350 ms. adapt() gives Jev
   4.5 s in total, retry included (`askJev` in `@attune/jev`), and a server
   `Retry-After` longer than 300 ms falls back to the short backoff
   (`createRealtimeJevClient`), so the heuristic answer always arrives
   inside the browser's 6 s timeout.
5. **Typed judgments.** Answers are checked against the questions actually
   sent (Choice options must match; Score levels must match). Any failure falls
   back to the heuristic in `server/heuristic.ts`, with the reason in
   `meta.error` and `meta.fallback` set to `jev_error` (or `no_key` when no key
   is configured).
6. **Code policy.** `computePlan()` blends Jev's relevance with measured recent
   use and a goal-to-panel affinity table, then applies the rules below.
7. **Animated layout.** The canvas is a CSS grid, and the store gives every
   card an explicit cell (see Calm relayout below). Each card is a motion
   element, so it glides to its new cell and size. With reduced motion there is
   no movement. A panel keeps its list (and a search field its focus and text)
   when it grows or shrinks, and keyboard focus is put back if a re-plan moves
   the focused element. The change feed is one line in the canvas caption
   ("Layout changed: ...", "+N more" for the full list with evidence, and
   Undo), so it never covers a card; an aria-live region reads the same text to
   screen readers, plus the anchor note and the linked panels after a round
   that linked them. While link cues show, the same caption carries the links
   bar ("Links for INV-1047 · 3 panels · Clear all links"). Badges on the cards
   say New, Bigger, Smaller, Moved up, or Moved down.

### What Jev is asked, and what each answer drives

| Question id | Type | Asks | Drives |
| --- | --- | --- | --- |
| `goal` | Choice over 9 goals (including "Not sure yet") | What is the user trying to do? | Header goal chip, the goal part of each panel's priority (via `GOAL_PANEL_AFFINITY`), suggestion reasons |
| `rel_<panel>` (10) | Score, 4 levels | How useful is this panel for what the user is working on? (No repeated evidence block, to save tokens) | The relevance part of each panel's priority |
| `struggling` | Noul | Is the user stuck? | Help hint at 0.55 or more, Guide panel at 0.7 or more |
| `layout` | Choice: focus, compare, overview | Which arrangement fits the work? | Layout mode, with hysteresis |
| `expertise` | Score, 3 levels | Still finding their way, comfortable, or expert? | Density: guided (at most 5 panels, with example commands in the empty suggestion row), standard (7), or dense (9), within the mode's slot count |
| `next_action` | Choice over actions plus "none" | What will the user likely do next? | Primary or subtle suggestion |
| `target_client` | Choice over client names plus "none" | Which client is the work about? | Fills the suggestion's client and invoice |
| `next_record` | Choice over the client's record candidates (at most 12, each described by its label, kind, panel, client, and code hint) plus "none" | Which record will the user open or work on next, after what they are looking at now? | The "Up next" card, when Jev is sure enough: 0.5 or more, or 0.4 or more with a clear lead and little on "none" (`confidentRecord` in `src/engine/nextUp.ts`) |
| `list_work` | Noul | Is the user working through similar records one at a time? | Queue mode at `QUEUE_LISTWORK_AT` or more, where the card can fall back to code's next record in the list |
| `goal_done` | Noul, with the working goal in its instructions | Has the user finished their own part of the work in the working goal for now? | The Done card for goals the data cannot judge (planning the day, one client, the business, the team, notes): 0.75 or more for two rounds in a row, never in the goal's first minute. Goals with a code fact (payments, inbox, projects) follow the data only |
| `next_task` | Choice over at most 5 pending tasks of other goals (each described by what it is, how many, its first record, and its goal) plus "none" | Which one of these tasks will the user most likely start next, after finishing their current work? | The Done card's "Next", when Jev is sure enough (0.5, or 0.4 with a 0.15 lead and "none" under 0.2); else code's top-ranked task |
| `link_next` | Choice over the clicked record's linked records (at most 8, each described by its label, panel, and why it is linked) plus "none", with the clicked record in its instructions | Which linked record does the user need next to do what the clicked record asks for or needs? | The order of the linked panels next to the clicked one, and, when Jev is sure (0.5, or 0.4 with a 0.15 lead and "none" under 0.2), the "Next" tag, the Up next pick, and the step |
| `link_action` | Choice over actions plus "none", with the clicked record in its instructions | What does the clicked record ask the user to do? | The step's words ("Next: resend INV-1042") and its action once its record is open, at 0.5 or more when it fits that record |
| `cmd_panel` | Choice over panels plus "unclear" | Which panel answers the command? | Apply (make it the hero), ask "Did you mean", or give up |
| `cmd_action` | Choice | Does the command ask for an action? | A primary suggestion at 0.55 or more. Commands never perform actions by themselves |
| `cmd_invoice_status` | Choice | Which invoices? | Invoice filter (a "mark ... as paid" command keeps the bill it acts on in view instead of filtering to Paid) |
| `cmd_client` | Choice over client names | Which client? | Client filter or selection |
| `cmd_timeframe` | Choice | Today, this week, this month? | Calendar and Revenue range |

The five `cmd_` questions are only asked when the user typed a command.
`goal_done` is only asked when the client sends the working goal
(`workingGoal`, with the "Say when a task is done" focus aid on), and
`next_task` only when it also sends task candidates (`candidates.tasks`),
which it does only when the working goal might be done. The working goal
lives in the `goal_done` instructions and the tasks in the `next_task`
criteria, so the state stays the same for every other question.
`next_record` and `list_work` are only asked when the client sends record
candidates (`candidates.records`). The candidates live in the `next_record`
criteria, not in the state, so every other question reads the same state.
`link_next` and `link_action` are only asked on the first request after a
click on a message, an invoice, a task, a project, or an event, with
"Arrange linked panels by next step" on (`AdaptRequest.link`: the clicked
record in words and its linked records); the clicked record lives in their
instructions, never in the state.
The core questions (`goal`, `rel_<panel>`, `struggling`, `layout`,
`expertise`, `next_action`, `cmd_panel`, and `cmd_action`) and the state are
built by `@attune/jev` (`packages/jev/src/questions.ts`) from the demo's
catalog; each goal's `notFor` and each panel's `commandExamples` live in
`shared/catalog.ts`. The demo's own questions are in `server/questions.ts`.
The wording was tuned against live Jev; the comments in both files explain
the choices (for example, why the newest activity has its own field and why
relevance asks about "what the user is working on" rather than "the
task").

Meeting prep (focus aid 4) asks in its own request, POST /api/prep, behind
the same guard, validation, budget, and fallback, because its state is
different: the meeting (title, client, time in words, kind), not the
activity. It asks one Score per record the client code picked (at most 10:
the client's recent messages, open invoices, open projects, and open
tasks, each record in its own question's instructions), all with the same
question and three levels ("Not needed for this meeting", "Useful
background", "Should be reviewed before this meeting"), so the scores
compare, plus the Noul `anything_urgent` ("Does any record in `records`
need the user to do something before `meeting` starts?"). The client
orders the linked panels by each panel's best score and names one thing to
handle first when the Noul is at 0.6 or more.

### Policy rules

All thresholds are named constants at the top of each file, so they can be read
and tuned in one place.

`src/engine/policy.ts`:

- **Priority** = relevance x 0.5 + recent use x 0.25 + goal affinity x 0.25
  (weights are adjustable in the Inspector), plus 1 for a pinned panel, plus,
  with "Learn my habits" on, a habit part on top: 0.15 x the learned chance
  that the user goes to that panel next (see Focus aids below).
- **Canvas membership.** Pinned panels, panels the user made bigger, panels in
  use (focused, or any event in the last 4 s), panels opened from the dock in
  the last 60 s, while a panel
  is anchored, panels that show a record linked to it, and, while link cues
  show, their source panel and linked panels (at least standard size, so the
  clicked row and the tinted rows show) always stay.
  Dismissed panels stay in the dock for 3 minutes. Other panels fill up to the
  density cap with a band around the 0.18 dock threshold: a panel on the canvas
  stays until its priority falls below 0.14, and a docked one needs 0.22 to
  join. A panel already on the canvas keeps its seat unless a newcomer beats it
  by 0.08. A panel the policy added stays at least 30 s, and one it docked stays
  in the dock at least 30 s. At least 2 panels always stay on the canvas.
- **Order hysteresis.** A lower panel must beat the one above it by more than
  0.08 to swap places. Any move relative to the other panels is announced
  (in the dense grid one slot already changes a card's row or column); a panel
  entering or leaving does not count as moving the ones after it.
- **Sizes by slot.** Focus: one hero, two standard, then compact. Compare: two
  heroes, then compact. Overview: all standard. A panel with an event in the
  last 4 s is never shrunk; the focused panel keeps its size while its newest
  event is under 15 s old, then takes its slot's size (it keeps its seat). A
  panel the user made bigger is always the hero (see Make a panel bigger).
- **Mode hysteresis.** Switch when layout confidence is 0.8 or more, or 0.55 or
  more when the last two rounds judged the same mode.
- **Density** changes only with expertise confidence of 0.6 or more, after at
  least 5 events, and when two rounds in a row judged the same density.
- **Help.** A tip banner at struggling 0.55, the Guide at 0.7. The Guide goes in
  the second slot (after pins) at standard size. If the user docked the Guide
  in the last 3 minutes, the policy shows the tip banner instead.
- **Suggestions.** Primary at next-step confidence 0.7, subtle at 0.45, a
  runner-up needs probability 0.25. The client is filled in at confidence 0.5.
  Every suggestion names the record it acts on (the invoice, message, or
  project on screen when there is one, for example "Reply to Zoe Laurent"), and
  accepting it acts on exactly that record. A dismissed or just-performed
  action is not suggested again for 2 minutes; without a client from Jev, the
  action done for any client counts. A step whose result is already on screen
  ("Open Atlas Robotics" while Atlas is open, "Write a note" in Notes) is not
  suggested.

`src/engine/store.ts`:

- At most one layout change every 2.5 s (adjustable). A change that arrives
  sooner waits and is applied from the newest judgments when the interval ends.
- Commands skip the interval. A command's promotion (its panel first as the
  hero, in Focus) holds until a newer Jev round lands, or for 45 s, so local
  re-plans from the command round's own judgments cannot undo it. Asking for
  what is already shown changes nothing and says "Already showing ...".
- Pinning, unpinning, opening, docking, or making a panel bigger or smaller
  changes only that panel at once (a pin or a panel made bigger goes to the
  front; see Pin or make bigger below); the policy catches up at its normal
  pace. Opening a panel from the dock anchors it (see Calm relayout), so that
  catch-up keeps it and everything before it in place instead of sending it
  to the front. With the pointer on the canvas, a docked card's slot stays
  empty, and the catch-up waits, until the pointer leaves, the user acts, or
  10 s pass, so the next click does not land on a card that slid under the
  pointer. The dock keeps an opened icon's place the same way.
- While keyboard focus moves through the canvas (Tab, arrow keys), automatic
  changes wait until focus leaves or the user acts. Each list is one Tab stop
  (arrow keys, Home, and End move between rows), and skip links jump to the
  workspace or the dock.
- After an Undo, automatic changes are held for 15 s, and the undone change
  (its mode switch and the panels it added or docked) is not repeated until the
  judgments change materially (another goal, or a top panel that leads by 0.1
  of the relevance scale), or for at most 5 minutes. Undo restores the plan
  from before the first change the feed line lists, and pins follow it.
- An unclear command, or a "Did you mean" until the user picks, keeps the
  layout and the last good judgments, because the other answers in that round
  are about the stray text.
- Adaptive off shows a fixed traditional layout (signals are still logged and
  Jev is still asked). Freeze keeps asking Jev but does not move panels.
  Switching either one clears Undo.
- The health check retries with backoff (1, 2, 4, 8, 15, then every 30 s) until
  the server answers, so the status recovers if the server starts later.

Other thresholds: `src/engine/command.ts` (apply a command at panel confidence
0.6, ask at 0.35, set a filter at 0.55, suggest its action at 0.55, lower than
the 0.7 for passive steps because the user typed the request),
`AdaptScheduler` in `@attune/core` (debounce and gaps), `src/engine/snapshot.ts`
(what counts as a burst, a quick dismissal, a reopened record, idle), and
`src/engine/usage.ts` (what each event counts; `panelUsage` in `@attune/core`
fades recent use with a 90 s half-life). Pointer rests
are timed from the first real pointer movement in a card and capped at 15 s, so
a card that slides under a resting pointer does not log interest.

### Calm relayout

After a click, the canvas used to reorder around the new priorities, so the
panel the user was working in could jump to the front and new panels showed
up with no hint of why. Now the panel the user just worked in holds still and
the rest moves around it, in stages, with one shared "link" color that shows
how the new panels relate to the record that was clicked. Full design,
ownership, and constants: [docs/anchored-relayout.md](docs/anchored-relayout.md).

- **The anchor stays put.** A click or keystroke in a panel (opening a record,
  a filter, an action, typing a search, or clicking into it), or opening a
  panel from the dock, makes it the anchor. In the relayout that follows, its
  top-left does not move on screen. It grows only into cells that are free
  or that a leaving panel vacated (to the right or below), so it never
  covers or pushes a card; otherwise it keeps its size. It is never docked or
  shrunk; new panels go after, beside, or below it. A linked newcomer takes
  a cell a leaving panel vacated near the anchor first, and cards that stay
  slide up, then left, into holes. Cards before the anchor move only to
  close a hole or to gather linked panels (below); every card has an
  explicit cell, so that cannot push the anchor. On one column the canvas is
  a list, so the anchor may grow there and push the cards after it down
  (they move with the growth). `packGrid` in `@attune/core` packs explicit
  cells (a column counts as 3 row tracks when it looks for the free spot
  nearest the anchor).
- **Gathered by next step** ("Arrange linked panels by next step", on by
  default). In a round that links panels, the linked panels move into the
  cells nearest the clicked panel, the next step first: the same row right
  beside it, then directly below, then left, then above. The cards in the
  way take the cells they left; pinned, held, and bigger panels stay. Jev
  reads the clicked record (`link_next`, `link_action`) and picks the
  order; when it is not sure, code's order applies (the same record id
  first, then the same client) with no "Next" emphasis. When Jev is sure,
  that panel's tag reads "Next: resend INV-1042" in a stronger style and
  its line stays at full strength, Up next offers the record ("INV-1042 to
  resend it"), and once it is open the suggestion bar offers the action
  ("Resend INV-1042 to Harbor Coffee Co.", with a ring on the panel's
  Resend button). After it, a matching to-do item is offered as "Check off:
  ...". Nothing runs until the user presses it. Details:
  [docs/anchored-relayout.md](docs/anchored-relayout.md), "Next step".
- **No orphaned holes.** After every round, no empty spot is left that a
  card later in reading order would fit, unless filling it would move the
  anchor, a held card, a pinned or bigger panel, or a panel just resized:
  the next such card moves up into it. Free space after the last card, and
  a half-row gap no card fits, may stay.
- **Staged motion.** The anchor grows first (0 to 250 ms), leaving panels fly
  into their own dock icon (150 to 400 ms), moving panels glide (250 to
  600 ms), and new panels arrive one at a time from the anchor's side (from
  450 ms, 70 ms apart). With reduced motion there is no movement, only a short
  fade and the highlights.
- **Link color.** Code joins the data (client, invoice id, message, project,
  event, task, person) to find records linked to the clicked one; no model
  call is needed. The clicked row and the linked rows in other panels get the
  same tint, scrolled into view inside their own list (never the page),
  stopping on a row boundary, and brought back into view after a later round
  moves the card (moving a card resets its list's scroll). When the tint
  clears, each list glides back to where it was, unless the user scrolled,
  pressed, or focused in it since.
  Only records a panel shows under its current filter, search, or date range
  count, so a tag always has a tinted row under it. While a card shows the
  tint, its old selection color is muted, so the link is the only colored
  row in it. Screen readers hear "Linked to ..." (or "Opened") on a tinted row.
- **Tags, lines, and a note.** At most 3 linked panels get a header tag
  ("Linked to INV-1042", with the reason, such as "1 message from Harbor
  Coffee Co.", on hover or focus) with a small x beside it; a meeting prep
  view (focus aid 4) links up to 5, tagged "For the meeting". While a tag
  shows, "Why here?" is an icon, so the tag has room. Thin lines run from the
  clicked row through the gaps between cards to each linked panel's tag:
  drawn in over 350 ms, full strength for 2 s, then resting at 45 percent
  opacity. Hovering or focusing a tag brings its line back to full strength,
  and hovering the clicked row brings every line back. A line that would
  cross another card, or run off screen or under the app bar, is hidden until
  a clean route is back (after a scroll or a move); a tag no line reaches
  when its round settles gets a one-beat pulse, and so does every tag when
  there is no clicked row (a search, a filter, a command without a record).
  No lines or pulses with reduced motion; tags and tints stay. When the round
  added linked panels, a note on the anchor says "Added Team for Harbor
  Coffee Co. · Undo" for 6 s or until the next click (it stays short, so it
  does not cover the anchor's buttons). It sits at the card's bottom edge,
  over the top of the clicked row's list, or just below the header, whichever
  keeps the clicked row clear, and never over the header. After its Undo,
  focus goes to the clicked row. The change feed stays as the fuller record.
- **Links stay until you clear them.** The tags, tints, and lines outlive
  the anchor: the 20 s release lets the layout rebalance, but the links stay
  and follow their panels (the source and linked panels are never docked by
  the policy while their links show, though they may move to other cells).
  Lines are measured again, at most once a frame, on window scroll and
  resize, canvas resize, a scroll in any panel list, any user action or data
  change, and every frame for 1.2 s after a plan change, so they glide with
  the cards. Only a new click that links panels of its own replaces the
  links; a click, filter, or search that links nothing leaves them alone.
  To dismiss them: "Clear all links" in the links bar, Escape (unless focus
  is in a text field, a popover is open, or the command bar or inspector has
  it), or a tag's x ("Remove link to Inbox") for that one link. Docking the
  source panel clears them all, docking a linked panel removes its link, and
  an Undo of the round that made them clears them. Each dismissal is logged
  as a `links_dismiss` signal ("Cleared the links for INV-1047", "Removed
  the link to Inbox") for the inspector's Signals tab; it never asks Jev and
  is left out of the snapshot Jev reads. The inspector's Controls tab has a
  "Link lines" setting: "Stay until cleared" (the default) or "Fade after 2
  seconds", the older behavior, where the lines fade after about 2 s and the
  tags and tints go when the anchor is released.
- **Jev still decides.** Jev's judgments choose the panels. The top 3 linked
  panels get a small priority boost (0.12), linked panels are at least
  standard size so their rows show, and the relayout itself asks no
  question (the next step adds two, above). A panel
  already on the canvas that shows a linked record stays for the anchored
  round, tagged or not, so a bill for the client in view is not docked while
  other panels say they are linked to that client.
- **Calm timing.** The anchor is released by work in another panel, docking
  it, undo, reset, Adaptive off, Freeze on, or 20 s without work (the links
  stay; see above). A round
  without an anchor settles: when the cards that stay keep their order, each
  keeps its cell, newcomers fill holes, and cards float up into the rest; it
  rebalances from the top only when Jev's order changed. A filter or action
  logged within 1 s of a press in another card anchors the pressed card. The
  card under the pointer keeps its cell for up to 3 s and stays on the canvas
  for up to 5 s.
- **Commands** still put their panel at the front as the hero, with the same
  stages, tint, lines, and tags when the command names a record or client.
- **Pin and Make bigger go to the front.** These two explicit layout requests
  are the one exception to the anchor rule: the panel goes to the first cell
  (see Pin or make bigger below). Ordinary clicks never move the clicked panel.

### Make a panel bigger

Any panel can be made bigger by hand, and the other panels reflow around it.
The user decides, not Jev. Design and constants: the "Make bigger" section of
[docs/anchored-relayout.md](docs/anchored-relayout.md).

- **How.** The "Make bigger" button (two arrows, beside the pin) in every
  panel header, or a double-click on the header's title area (not on its
  buttons or tags). The button is a toggle: once pressed it reads "Make
  smaller" ("Make Invoices smaller" to a screen reader, with `aria-pressed`)
  and makes the panel smaller again. Tab reaches it, and Enter or Space
  presses it.
- **Size.** Bigger is the hero size: 2 columns by 2 rows on the 4 and 2
  column canvas, and taller on one column. It is not full screen.
- **Where it goes.** By default it goes to the front, the first cell, as the
  hero (see Pin or make bigger below). With "Keep in place" its top edge
  never moves: it grows to the right and down; in the last column, or in a
  2-column canvas's right column, it grows one column to the left instead.
  It never grows upward, and its new cell contains its old one. On one
  column it simply gets taller.
- **The rest reflow.** Panels before it that are not in its way stay put.
  Panels in its way glide to the next free cells after it (they move with
  the growth, so none sits hidden under it), cards float up into holes, and
  a hole still open takes the last card that fits it. Nothing is docked; the
  canvas gets taller. Made smaller, it keeps its top-left and the cards float
  back up into the space it frees.
- **It stays until you change it.** A panel the user made bigger stays at the
  hero size and on the canvas until the user makes it smaller or docks it:
  the policy treats it like a size pin, whatever Jev rates it, and so does a
  command. Making it smaller hands its size back to the policy (it first goes
  back to the size it had before, and never stays the hero); docking it
  clears it. Several panels can be bigger at once, and pins work with it.
  The set is saved with the pins in localStorage and survives a reload; Reset
  clears it, and an Undo of the change takes it back too.
- **At once.** It is a manual edit like a pin or a dock: it applies
  immediately, not after the minimum change interval. The panel becomes the
  anchor for that change, so it grows first and the next rounds keep it and
  everything before it still. The link tags, tints, links bar, and lines
  stay, and the lines follow the panels that moved.
- **Explained.** Its reason ("Why here?") is "Made bigger by you". The change
  feed and the screen reader line say "Made Invoices bigger" or "Made
  Invoices smaller", and the inspector's Decisions tab shows a "Made bigger"
  badge. The signals are `panel_maximize` and `panel_restore` ("Made Invoices
  bigger", "Made Invoices smaller"). They count toward recent use like a
  strong focus (as much as opening a panel from the dock) and appear in the
  snapshot, so the next Jev round knows, but they never start a Jev request
  by themselves and no Jev question changed.
- **Adaptive off.** The fixed layout gets explicit cells while a panel is
  bigger, so the same rule holds there; once nothing is bigger it goes back
  to the CSS flow.

### Predictive flow

The workspace also predicts what the user will work on next, so they never
have to go looking for it. Jev picks, code decides what shows, nothing is
ever done for the user, and nothing shows when Jev is not sure. Design,
rules, and constants: [docs/predictive-flow.md](docs/predictive-flow.md).

- **Record candidates.** Every request sends at most 12 records the user
  might work on next (`src/engine/nextUp.ts`): the next ones in the list they
  are in, records linked to what they clicked, unread client messages, tasks
  due today, the next event today, and overdue invoices without a reminder
  today, without the current record and records already handled this
  session. Jev picks one (`next_record`) and says whether the user is working
  through a list (`list_work`).
- **Up next.** A card in the row under the command bar ("Up next: Meridian
  Hotels · INV-1038 · 36 days overdue", "Jev 72%" or "Next in list", Open,
  up to two alternative chips, and a dismiss that hides it for 2 minutes). It
  shows Jev's pick when Jev is sure enough, else, while the user works through
  a list (the same action on two records of one kind in 3 minutes, three
  records of one kind opened in a row, or Jev's `list_work` at 0.6 or more),
  the next record in the current list. Right after an action the card moves
  on at once, so "act, then `n`" walks the list. While the user repeats one
  action, the card offers only records it still applies to (reminders:
  overdue invoices with no reminder yet; mark paid: sent or overdue
  invoices; replies: unread messages; status updates: projects at risk or
  blocked; checking off: open tasks), and when none is left it says so
  ("All overdue invoices have a reminder.") until dismissed or the next
  unrelated step. Opening selects the record
  the way a click does (the anchor, calm relayout, and links apply), opening
  its panel from the dock first if needed. The row keeps its height, so the
  card never moves a panel; when the row is short of room the card becomes a
  pill or waits in "+N" (see "The row under the command bar" below).
- **Back to.** When the work really changes (Jev judges another goal at 0.7
  or more for two rounds in a row, or a command goes to another area), the
  engine saves the context as it was: placements and cells, panels made
  bigger, filters and selections, and link cues. Chips in the canvas caption
  ("Back to: Collecting payments · Harbor Coffee Co.", `b` for the newest;
  the older ones wait behind "+N" beside it) bring it back at once, save the
  context being left, and hold the restored layout until the user does new
  work. Pins stay as they are. An Undo right
  after a restore puts back everything it replaced: the layout, filters,
  selections, links, and chips. At most 3, session memory only, cleared by Reset.
- **Signals.** `up_next_open` reads like a record open to Jev ("Opened
  invoice INV-1038 ... in Invoices from Up next"); `context_restore` reads
  "Went back to earlier work: ..."; `context_save` is the engine's own note,
  left out of what Jev reads and of recent use. A list scroll is logged only
  after a wheel, a touch drag, a scrolling key, or a press on the scrollbar
  in that card, because a card that moves or resizes resets its list's
  scroll and that is not the user navigating. Tasks and Calendar keep their
  selection in the view state now, so both features can select there too.

### The row under the command bar

The meeting prep card, the Done card or Up next, and the suggested next
steps share one row of a fixed height, so it never pushes the canvas (or the
panel just clicked) down. When they do not all fit
(`fitRow` in `@attune/core`, with the card order from `src/ui/assistFit.ts`,
measured with a ResizeObserver in `src/ui/AssistRow.tsx`):

- **Priority.** A meeting starting soon comes first, then the Done card (or
  Up next, or its completion line), then the primary suggestion, then the
  subtle ones.
- **Pills first.** "Next step" shrinks to its icon, then the lowest cards
  become pills: an icon, a short label, the key (`n`, `.`), and an x
  ("INV-1042 to resend it n", "Reply to Priya Nair ."), with the full line in
  the tip and the accessible name. Then "Next step" goes, then the first card
  shortens (the prep card shows the count of things to handle, "1", instead
  of the whole line) or, when there is room to spare, is cut short at the
  end of that line.
- **Then "+N".** What still has no room waits behind "+N" at the row's
  right end, a small list that shows those cards in full with all their
  buttons. Focus goes to its first button, Escape or a press outside closes
  it and puts focus back on "+N", and tabbing out of it closes it.
- **Keys** (`p`, `n`, `.`) work for their cards whether they show in full,
  as a pill, or in "+N". A card is measured before it is painted, so it
  never shows in one form and then jumps to another, and the row only goes
  back to a fuller form once it fits with 16 px to spare, so it does not flip
  back and forth.

The canvas caption follows the same rule: the newest Back to chip shows, the
older ones wait behind "+N"; while a change is fresh the change feed keeps
room for its first words and Undo, and shows "Layout changed:" and "+N more"
only where they fit; on a phone the layout reads "Overview" instead of
"Overview layout".

### Focus aids

Small features that keep the user's attention on the work, each a setting
the user can switch off. Design, rules, constants, and how a new aid plugs
in: [docs/focus-aids.md](docs/focus-aids.md).

- **Settings.** The gear button in the header ("Focus settings") opens a
  small dialog with one switch per aid, a one-line description, and whether
  it is on; the inspector's Controls tab has the same switches. They are
  saved with the other settings. Up next and Back to are switched here too:
  off hides the card or the chips and stops `n` or `b`. Each change is
  logged as a `setting_change` signal, which never asks Jev and is left out
  of what Jev reads.
- **Fade panels that do not matter now** (on by default). A panel Jev rates
  below 0.4 of its relevance scale for two rounds in a row (level 1 of 4 is
  "Background only") goes quiet, unless it is the panel the user works in,
  linked, pinned, bigger, focused, under the pointer, the Up next panel, the
  panel the user usually goes to next (with "Learn my habits" on), or used
  in the last minute. It comes back above 0.5, or when the user clicks
  into it. A quiet panel shows at 55 percent strength, a little
  desaturated, with a "Quiet" label and "Not needed for Collecting payments
  right now" in "Why here?"; hover or keyboard focus brings full strength at
  once. It also shrinks to its summary tile, except a panel the user
  resized (a card before the anchor shrinks in place, which cannot move the
  anchor). Nothing is hidden or docked by it, and no Jev question changed.
- **Pin or make bigger** ("Move pinned and bigger panels to the front", on
  by default). A panel the user pins or makes bigger goes to the first cell
  (top left) at once, even with the pointer on the canvas: a pin at its size,
  a panel made bigger as the hero. The most recent pin or "Make bigger" goes
  first, the earlier ones follow newest first, then the rest by the policy,
  and later Jev rounds keep that order and the pins' sizes, whatever Jev
  rates them. The other cards reflow with the usual staged motion; nothing is
  docked. If the page is scrolled so the front of the canvas is out of view,
  it scrolls up to the canvas top (at once with reduced motion), and the
  panel gets a short ring (1.2 s) when it lands. Unpin and "Make smaller"
  leave the panel where it is, and from the next round the policy places it
  again. Off ("Keep in place") brings back the older behavior: a pin under
  the pointer stays put, and a panel made bigger keeps its top edge. The
  order is saved with the pins.
- **Say when a task is done** (on by default). When the work of the
  working goal is finished, a Done card takes the Up next slot, for example
  "Payments done: every overdue invoice has a reminder." then "Next: 2
  unread client messages" with Start (`n`) and Not now. Code decides where
  the data can (no overdue invoice without a reminder this session, no
  unread client message, no project at risk or blocked); for the other
  goals Jev's `goal_done` must be 0.75 or more for two rounds in a row, and
  never in the goal's first minute. The next task is Jev's `next_task` when
  it is sure enough, else code's top-ranked pending task (a meeting soon,
  unread client messages, overdue invoices, tasks due today, projects at
  risk). Start saves the current work as a Back to chip, opens the task's
  panel (from the dock if needed), sets its filter, and selects its first
  record the way a click does; it never performs an action. Not now hides
  the card for 5 minutes. Off: no card and no new question, and the Up next
  completion line works as before. Details in
  [docs/focus-aids.md](docs/focus-aids.md), "Aid 2".
- **Arrange linked panels by next step** (on by default): the gathering and
  the next step above. Off: the links only draw, as before, and no link
  question is sent. Details in [docs/focus-aids.md](docs/focus-aids.md).
- **Learn my habits** (on by default). Attune counts, in this browser only
  (`floouid:habits:v1`), where the user goes next from each panel by time of
  day, where they start, which work follows which, and what they do after
  opening a record of each kind. Counts halve every two weeks, and a move is
  a habit only after about three recent times and at least 40% of the moves
  from there. Only work done by hand teaches it (not suggestions, the
  command bar, Up next, Start, replays, or the engine's own signals). With
  a habit, the usual next panel gets a small habit part (weight 0.15, a
  Controls slider) and, when that is its strongest part, the reason "You
  usually open Calendar after Inbox in the morning"; it is not faded; its
  records move up three places in code's Up next candidate order; the
  next-task ranking gets a boost under 1; when Jev is unsure of the next
  step, the usual action after the open record's kind may be a subtle
  "Habit" suggestion (never primary, never done on its own); and Jev reads
  at most two habits as behavior observations ("Usually opens Calendar after
  Inbox in the morning"). The inspector's Habits tab lists what was learned,
  loads a sample week, and forgets it all (with a second click); Metrics
  shows "Habit guess right". Off: it stops learning and using the habits,
  and every request and plan is exactly as with nothing learned. Details in
  [docs/focus-aids.md](docs/focus-aids.md), "Aid 3".
- **Prepare for meetings** (on by default). Before a meeting or call with
  a client (within the lead time, 15 minutes by default, 5 to 30 in the
  Controls tab, and up to 5 minutes after it starts), a chip in the Up next
  row says "Harbor rebrand review in 12 min" with a live countdown, the one
  thing to handle first when Jev says there is one ("1 thing to handle
  first: INV-1042 is 14 days overdue"), Prepare (`p`), and Not now (hides it
  for that meeting). Prepare saves the current work as a Back to chip and,
  as a manual edit, makes the meeting in Calendar the anchor and links the
  client's panels ("For the meeting" tags, tints, lines): the client in
  Clients, and the client's messages, open invoices, and open tasks,
  filtered to the client, and their project. They gather next to Calendar
  in order of usefulness, which Jev ranks in its own request, POST
  /api/prep: the meeting as the state, one Score per record, and a Noul
  for "anything urgent". It never performs an action; "Start meeting
  notes" in the suggestion row writes a heading into the notes and opens
  Notes only when pressed. The fixture meetings are at fixed times, so
  the Controls tab and the Focus popover have "Test: simulate a meeting in
  10 minutes". Off: no chip and no prep request. Details in
  [docs/focus-aids.md](docs/focus-aids.md), "Aid 4".

## The inspector

Click **Inspector** in the header to see why the UI changed (it loads on first
open). It is a drawer with eight tabs:

- **Now:** the last response (Jev or heuristic), model, latency, question
  count, tokens, and cost, then every judgment with its probabilities
  (including the next record, working through a list, the working goal
  done, and the next task, when asked).
- **Decisions:** the current plan: mode, density, help, each panel's priority
  broken into relevance, recent use, goal, and pin (and the habit part in a
  round that used a habit), a "Made bigger" badge on
  a panel the user made bigger, the reason in words, the
  dock, the suggestions, and the list of decisions with the evidence behind
  each.
- **Request:** exactly what was sent to Jev (state and questions), with Copy.
- **History:** the last 30 rounds; click one to see its judgments and decisions.
- **Signals:** the event log, newest first, with the sentence Jev read (link
  cue dismissals, saved contexts, focus aid switches, tasks marked done, and
  meeting prep offers are listed too, though Jev never reads them).
- **Metrics:** how well the workspace kept up this session, each as a number
  with a plain line: next-record and next-action hits at 1 and at 3,
  navigation per 10 actions (dock opens, searches, list scrolls, command bar,
  Back to), Up next picks taken by click or key out of those shown, undos per
  layout change, layout changes per minute, and quiet panels (how many now,
  and how many the user reopened), tasks marked done, next tasks
  started out of those offered, how often the habits' guess of the next
  panel was right, counted with "Learn my habits" on or off, meetings
  prepared out of those offered, and records opened from a prep view
  (`src/engine/metrics.ts`).
- **Habits:** the "Learn my habits" switch and every learned move in plain
  words with its strength and counts ("Calendar after Inbox, in the morning ·
  Almost always · about 4 of 5 times"), "Load a sample week" (marked as
  sample data), and "Forget my habits" (a second click confirms).
- **Controls:** Adaptive and Freeze switches, the Focus aids switches (with
  "Move pinned and bigger panels to the front", and the prep chip's lead
  time and "Test: simulate a meeting in 10 minutes"), the
  Link lines setting (stay until cleared, or fade after 2 seconds), the
  priority weights (Jev relevance, Recent use, Goal rule, and Your habits),
  the
  minimum time between layout changes, Adapt now, Undo, Reset, and scenario
  replays.

Each panel also has a **Why here?** popover with its reason and priority
breakdown.

## Eval

`pnpm eval` runs every scripted session and command case in
`shared/scenarios.ts` through the real code (`describeEvent`, `buildSnapshot`,
then the server's `adapt()`, no HTTP) against live Jev, and checks the
expectations: goal, top panels, layout, next step, client, struggling (at or
above the app's 0.55 help threshold for "stuck", at or below 0.4 for "not
stuck"), expertise, next record (the most probable record must be one the
session accepts), list work (at or above 0.6 for yes, at or below 0.4 for
no), goal done (the same 0.6 and 0.4), next task (the most probable task
must be one the session accepts), and the link answers (the most probable
link-next record and link-action must be ones the session accepts; the
output also says whether the pick passes the app's Next gate) for sessions;
panel, action, and arguments for commands. Sessions with a clicked record
send it with its linked records, built by the app's own code from the
fixtures. Sessions that list record candidates send them, and the
summary also reports top 3 for the next record: how often an accepted record
is among the three most probable. Sessions with a working goal send it, and
those that list task candidates send them, the way the app does.
Command requests are built the way the app builds them (the command event is
logged first, optionally after a scenario's steps), and the checks also require
the confidence the app acts on: panel 0.6, action 0.55. A prep section
(focus aid 4, `PREP_CASES`) sends four fixture meetings, as if they started
soon, through the server's `prep()` with the records the app's own code
picks (plus, for Harbor, a message about another client), and checks which
records Jev scores highest, which score at least the app's tint line (0.5)
or clearly under it (0.35), which ranks last, and anything urgent (0.6 or
more for yes, 0.4 or less for no); every record's score is printed, and
the prep checks are counted apart from the others. Full details of the
last run go to `eval-results/latest.json` (gitignored).

Flags: `--only <id>` (a scenario id, `cmd-N`, a prep id such as
`prep-harbor`, or a command's exact text), `--repeat <n>`,
`--scenarios-only`, `--commands-only`, `--prep-only`, `--verbose`, `--help`.
It exits 0 when every check passes, 1 when a check fails, and 2 when Jev did not
answer (no key, network, or timeout).

After "Prepare for meetings" (September 30, 2026, jev-1.13.0), with
`--repeat 2`: the adapt requests are byte-identical to before (every eval
request built at a fixed time, state and questions, compared with the code
before the change); 19 of 20 sessions passed in every run (20 of 20 in the
second), 9 of 9 commands, and 193 of 194 checks (96 and 97 of 97); the miss
is the known near tie in the keyboard session's next record (the to-do item
0.24 against the accepted messages at 0.18 and 0.20). The prep section
passed 4 of 4 cases and 24 of 24 checks in every run. Harbor rebrand
review: INV-1042 0.99 to 1.00, the project 1.00, Priya's message 0.89 to
0.91, the resend to-do 0.81 to 0.83, Riley's printer quote 0.00, anything
urgent 0.92. Solace onboarding critique: the project, Ava's message, and
the welcome screen task 0.92 to 0.99, the sent bill last at 0.85 to 0.86,
urgent 0.20 to 0.21. Juniper spring brief call (nothing urgent): Luis's
brief 0.96 to 0.97, the sent bill 0.53 to 0.54, urgent 0.14 to 0.15.
Meridian call (held out): Hannah's unread question 0.99, the overdue bill
0.81 to 0.84, the at-risk project 0.76 to 0.79, urgent 0.80 to 0.81. The
wording was tuned in four rounds on these cases (docs/focus-aids.md, "Aid
4"). Choices that changed between runs, all near ties: that next record,
the Harbor order of INV-1042 and the project (1.00 against 0.99), and six
unchecked or accepted readings (two next actions, one next record, one goal
at 0.52 against 0.48 that both passed, and two third panels). A prep request is about 2,500 input tokens and 150 ms; the
adapt requests stay at about 176 ms median and 254 ms p95.

After "Learn my habits" (September 30, 2026, jev-1.13.0): the eval sends
byte-identical requests (the eval builds snapshots without the store), and
the run passed 18 of 20 sessions, 9 of 9 command cases, and 95 of 97 checks.
The two misses are known near ties on identical requests: the keyboard
session's next record (see below; missed in 3 of 3 reruns) and the invoice
click's link-next (none 0.32, the message 0.27, the client 0.25; it changed
choice between reruns). Details in docs/focus-aids.md, "Aid 3".

Latest run before it (September 30, 2026, jev-1.13.0, after "Arrange linked panels by
next step"): 20 of 20 sessions and 9 of 9 command cases passed, 97 of 97
checks. With `--repeat 2`: 193 of 194 checks, 9 of 9 commands in every run,
and every link-action the same in both runs; the one miss is the known near
tie in the keyboard session's next record (Jev's top pick, about 0.23 to
0.26, is the to-do item about the open message, just ahead of the two
accepted unread messages at about 0.2; it is under the card's 0.5 gate, and
list work turns on queue mode, so the app falls back to the next record in
the list). The choices that changed were that near tie, one near tie among the
top panels (the morning session's third panel, 1.13 against 1.13), the call
request's link-next (the client at 0.56, then none at 0.52; not checked),
and one unchecked expertise reading near its line (0.75, then 0.81). Before this change,
the same day: 15 of 15 sessions, 9 of 9 commands, 90 of 90 checks (that
near tie went the right way once; the run before was 89 of 90).

Five sessions check the link questions. The user's own case, Priya Nair's
"Re: Invoice INV-1042" asking to resend the invoice: link-next INV-1042 at
0.95 to 1.00 (the to-do item "Resend INV-1042 to Harbor accounts team" is
accepted too) and link-action `resend_invoice` at 1.00, in every run, past
the Next gate. A message asking for a call: `schedule_meeting` at 0.97 to
0.98 (its link-next, not checked, is a near tie between the client and
none). A message that only says thanks: link-action none at 0.98, link-next
none at 0.95. An invoice click whose next step is the client's message:
the message first, but only at 0.31 to 0.35, just ahead of none and the
client, so under the Next gate (the app gathers it in code's order, the
message first). Held out, a message asking about the price: link-action
`reply_to_message` at 0.78 to 0.81 and link-next its invoice at 0.45 to
0.55. The wording was tuned in four rounds on these sessions (the last one
reverted; see docs/anchored-relayout.md, "Next step").

Next record: top 1 in 7 of 7 sessions that expect one in the single run
(13 of 14 over two runs), top 3 in all. List work: 6 of 6 (3 yes, 3 no).
Goal done: 9 of 9 (2 finished, 7 not). Next task: 1 of 1. Latency is about
175 to 181 ms median, with a p95 between 230 and 280 ms (the exact figures
change on every run; see `eval-results/latest.json`). Input tokens per
request are about 4,550 to 4,600 without record candidates or a command,
about 5,800 with 8 to 10 candidates (the two record questions add about
1,300, mostly the candidate descriptions), and about 6,300 with a command.
A working goal adds about 320 (the goal-done Noul), and task candidates
about 540 more with four of them, only on the rounds where the goal might be
done. A clicked record adds about 700 to 900 (the two link questions), only
on the first request after a click on a record, and the new action adds 32
to every request (64 with a command). That is about $0.00019 to $0.00030 per
request at $0.042 per million input tokens. Output tokens are free. The
sessions include two held-out "stuck" variants (the same bill reopened
between how-to searches, and a how-to search followed by an undo) next to
the productive ones, so the struggling question is checked in both
directions. Three more held-out sessions check the record questions:
replying to client messages one by one, checking off today's tasks one by
one, and jumping between unrelated records (list work no; its next-record
pick is printed but not checked). Three sessions send no candidates, so the
request without the record questions is covered too. Three held-out
sessions check the focus aid 2 questions: every overdue invoice reminded
(goal done yes, and a sensible next task), replying to the inbox midway
(goal done no), and every project at risk updated (goal done yes; its
next-task pick is printed but not checked).

## Project layout

```
shared/       Contract shared by browser and server: catalog, types, fixtures, scenarios
server/       Hono server holding the key: routes (app.ts), questions, Jev client, normalization, heuristic
src/engine/   Client engine: store, snapshot, usage, policy, relations, command, scheduler triggers, API,
              nextUp (Up next), contexts (Back to), metrics, focusAids (settings), quiet (aid 1),
              taskDone (aid 2), habits (aid 3), meetingPrep (aid 4), linkFlow (the next step after a click)
src/ui/       App shell, canvas, panel frame, the ten panels, command bar, dock, feeds
src/inspector The "why did the UI change" drawer
scripts/      eval.ts
deploy/       AWS deploy (CloudFormation, deploy.sh, destroy.sh)
docs/         Design notes: anchored relayout, focus aids, predictive flow
```

From the library (`packages/`): the catalog check (`CATALOG` in
`shared/catalog.ts` goes through `defineCatalog`), the layout modes, the
judgment and snapshot types, the grid packer, the request scheduler, recent
use, the quiet rule, the relayout timing, the row fit under the command bar,
and the plain-word helpers (`@attune/core`); the core Jev questions, the
answer readers, the real-time client, and the round with a budget and the
heuristic as its fallback (`@attune/jev`). The demo's `src/engine/usage.ts`, `src/engine/quiet.ts`,
and `src/ui/choreography.ts` bind them to its catalog and events; the generic React hooks
(`@attune/react`); the request guard and rate limiter (`@attune/server`).

## Known limits

- **Prototype data.** Actions change in-memory data only. Nothing is sent, and a
  page reload resets everything except settings, pins, the panels the
  user made bigger, and the learned habits.
- **Relevance leans toward the latest click.** Jev often rates the panel of the
  newest action as central and the panel where most of the work happened as only
  supporting. Recent use and goal affinity offset this, and the eval passes, but
  the per-panel scores are compressed (mostly 0.5 to 1.8 out of 3).
- **Run-to-run drift.** Identical requests can flip near ties (differences of a
  few points). Hysteresis hides most of it.
- **Undo memory is per session.** An undone change is avoided while the
  judgments stay the same (at most 5 minutes), and forgotten on reload.
- **Moves near the pointer.** The clicked panel holds still and the card under
  the pointer waits (up to 3 s to move, 5 s to leave), but a card next to the
  pointer can still move, and a held card moves once its cap runs out.
- **Closing holes moves cards.** The backfill pulls the next card into a
  hole, so the cards after a hole slide up one place each, before the
  anchor too. Free space after the last card stays, which can look like a
  gap under a card when compact tiles shift the next row by half a row.
- **Gathering versus closing holes.** When the anchor sits low on a sparse
  canvas, the only layout without a fillable hole may put the other cards
  above it, so the linked panels take the nearest slots in that layout
  rather than the cells right beside the anchor. A linked panel bigger than
  a standard card never moves for the gathering, and one that was a summary
  tile before the anchor stays a tile, so its tinted row does not show.
- **The next step in a narrow header.** "Next: resend INV-1042" fits a
  2-column card; a 4-column or phone header shows a shorter form ("Resend",
  or the record's name for an open-only step), with the full text in its
  accessible name and tip.
- **An invoice click's next step** is a near tie between the client's
  message, "none", and the client (about 0.22 to 0.35 each in the eval), so
  it stays under the Next gate: the panels gather in code's order (the
  message first) with no "Next" tag.
- **The header wraps at 1024 px.** Once Jev names a long goal ("Working
  through the inbox") and the status reads "Live with Jev", the header takes
  a second line, and the canvas moves down 36 px in that first round. It
  happens with the code before this change too.
- **Rebalance after release.** Once the anchor is released, a round whose Jev
  order differs from what is on screen reflows from the top, which can move
  several cards at once (with the same staged motion).
- **Narrow headers.** "Linked to" shows whenever the whole tag fits; a long
  name in a 4-column card or on a phone still drops "Linked to" or truncates
  ("Linked to Harbor Coff..."). The full text is in its tip and accessible
  name.
- **Fewer lines on small screens.** On one column, and whenever a card is in
  the way (for example beside a hero's detail pane), most linked panels get a
  tag pulse rather than a line.
- **Lines in motion.** While cards glide, a line is measured each frame and
  drawn one frame later, so it trails a fast card by a few pixels, and a line
  whose route crosses a moving card is hidden until the move ends. A line to
  a top-row card runs in the thin gap just above the canvas.
- **Links after later changes.** A link's records are the ones its panel
  showed when the link was made. A filter or search added later in a linked
  panel can hide its tinted rows while the tag stays; clear the links or
  make a new click to refresh them. Switching Adaptive off or on clears the
  links, since the fixed layout does not keep their panels.
- **Bigger panels and a later rebalance.** Making a panel bigger moves the
  cards in its way, so the screen order no longer matches the plan order.
  Once the anchor is released, a round without an anchor whose order differs
  from the screen reflows from the top (see Rebalance after release), which
  can move a bigger panel to another cell; it stays bigger.
- **Growing left, then smaller.** With "Keep in place", a panel that grew
  one column to the left keeps that left edge when it is made smaller (its
  top-left stays), so it ends one column left of where it started.
- **Reading order at the front.** The newest pin or "Make bigger" is always
  in the first cell, and the plan keeps the rest of the front group newest
  first, but a hero that does not fit beside the card before it goes to the
  next row, and an older, smaller front card can fill the gap it leaves (the
  dense flow), so on screen that card can come before the hero.
- **Unpinning one of several front panels.** The panel stays where it is at
  once; the next round puts the remaining front group back at the front, so
  it can move then (after the pointer leaves the canvas, or 10 s).
- **Moving the pointer's card.** A pin or "Make bigger" moves the cards even
  under the pointer, so the card now under it may be another one.
- **Filling holes after "Make smaller".** Cards float up into the space it
  frees, and a hole still open takes the last card that fits, so that card
  can jump up from the end of the canvas.
- **Panel-local state.** Selection inside Team is local to the component and
  resets when the panel leaves the canvas or shrinks to its summary, so team
  members are never Up next candidates.
- **Up next before a pattern.** The card narrows to records an action still
  applies to only once the same action has been done on two records. After
  one reminder, a Jev chip can still offer a sent invoice, and list work from
  opening records in a row (no action repeated) walks the panel's filter and
  order, skipping only paid invoices, done tasks, and past events.
- **Session memory.** Saved contexts, dismissed Up next records, the
  metrics, the quiet rule's round counts, and which completions the Done
  card already said are forgotten on reload.
- **Starting the inbox task.** The Inbox has no unread filter, so Start
  clears its search and client filter instead; the unread messages are the
  newest and marked.
- **Bundle.** React and motion ship as their own chunks and the inspector loads
  on first open; the app chunk is about 399 kB (119 kB gzipped), 23 kB more
  than before meeting prep.
- **A crowded row.** On a phone the first card (the prep card, the Done
  card, or Up next) takes most of the row under the command bar, so the
  others usually wait in "+N" (their keys still work on a keyboard). At
  1024 px the prep card shows the count of things to handle rather than the
  whole line, which stays in its tip and is read to screen readers.
- **Meeting prep.** The demo's meetings are at fixed times (use the
  simulated meeting), a sent bill for the meeting's own project still
  scores as worth reviewing, and the prep request is not shown in the
  inspector's Request tab. See docs/focus-aids.md, "Aid 4".

## Next ideas

- Learn per-user weights from accepted and undone changes instead of fixed
  sliders.
- Remember undone changes and dismissed suggestions across sessions.
- Ask relevance as one ranked Choice (or fewer Scores) to cut tokens, and
  compare the ranking quality in the eval.
- Use Jev's confidence for routing: skip the layout questions when nothing
  meaningful changed, and re-ask only the questions whose inputs changed.
- Let the command bar run confirmed actions, with an explicit confirm step.
- Add more held-out scenarios to `pnpm eval` so wording changes are checked
  against cases they were not tuned on.
