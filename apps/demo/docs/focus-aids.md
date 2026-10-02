# Focus aids

Focus aids are small features that help the user keep their attention on the
work in front of them. Each one is a setting the user can switch on or off,
and each one follows the rules of the rest of the app: Jev judges, code
decides, nothing is done for the user, and every change says why.

Four were planned and built one at a time, in this order:

1. **Fade panels that do not matter now** (built, below).
2. **Say when a task is done and offer the next task** (built, below).
3. **Learn the user's habits over time** (built, below).
4. **Prepare for meetings before they start** (built, below).

The two predictive flow features that already existed, **Up next** and
**Back to** (docs/predictive-flow.md), are switched on and off from the same
place, and so are two layout settings, **Pin or make bigger** (see "Pin or
make bigger: move to the front" below) and **Arrange linked panels by next
step** (see "Arrange linked panels by next step" below, and
docs/anchored-relayout.md, "Next step").

## The settings home

One source of truth: `EngineSettings.focusAids` in the store, one boolean
per aid. It is saved with the other settings in localStorage (`floouid:v1`,
key `settings.focusAids`). A save from before the focus aids, a bad value,
or unreadable JSON falls back flag by flag to the default, and storage that
is blocked or full never throws.

| Flag | Default | What it switches |
| --- | --- | --- |
| `fadeQuiet` | on | Aid 1: panels that do not matter now fade, and shrink where that keeps the calm relayout |
| `upNext` | on | The Up next card and its `n` key. Off: no card, and `n` does nothing |
| `backTo` | on | The Back to chips and their `b` key. Off: no chips, no contexts are saved, and `b` does nothing. The working goal is still followed, so switching it on works at once |
| `moveToFront` | on | "Pin or make bigger". On ("Move to front"): a panel the user pins or makes bigger goes to the first cell, newest first. Off ("Keep in place"): the older behavior |
| `taskDone` | on | Aid 2: when the work of the working goal is done, a Done card takes the Up next slot and offers the next task (`n` starts it). Off: no card, no goal-done or next-task question, and the Up next completion line works as before. The working goal is still followed, so switching it on works at once |
| `arrangeLinks` | on | "Arrange linked panels by next step": after a click that links panels, they gather next to the clicked panel, the next step first; Jev reads the clicked record (two link questions, once per click), the next step's panel gets a "Next: ..." tag, Up next offers its record, and once it is open the suggestion bar offers its action, then a check-off follow-up. Off: the links only draw, as before, and no link question is sent |
| `habits` | on | Aid 3, "Learn my habits": Attune learns, in this browser only, where the user usually goes next, where they start, which work follows which, and what they do after opening a record, and uses it a little (a habit part in the layout, the Up next and next-task order, a subtle suggestion, and at most two lines Jev reads). Off: it stops learning and stops using them; what it learned stays until the user forgets it |
| `meetingPrep` | on | Aid 4, "Prepare for meetings": before a meeting or call with a client, a prep chip offers Prepare (`p`), which saves the current work as a Back to chip and brings up the client's records next to the meeting in Calendar, ranked by Jev in its own request. Off: no chip, no prep request, and everything else as before |

Where the switches are:

- **Header.** A gear button, "Focus settings" ("Focus" beside the icon on a
  wide screen), opens a small dialog with one switch per aid, a one-line
  description, and whether it is On or Off. Tab reaches the gear; Enter or
  Space opens it with focus on the first switch; Tab moves through the
  switches; Escape or a click outside closes it and puts focus back on the
  gear; tabbing out of it closes it too. On a phone it spans the width
  under the header. While it is open, `n`, `b`, and `p` do nothing. Under
  "Prepare for meetings" it has a test button, "Test: simulate a meeting in
  10 minutes" (see "Aid 4").
- **Inspector, Controls tab.** A "Focus aids" section with the same
  switches, and under them the prep chip's lead time and the same test
  button (aid 4).

Both call `setFocusAid(id, on, via)`. Each change is logged as a
`setting_change` signal (`detail.setting`, `detail.enabled`,
`detail.label`), for example `Turned off "Up next"`. It shows in the
inspector's Signals tab, is not a trigger, adds no recent use, is not
counted as work in the Metrics tab, and is left out of the snapshot Jev
reads (the cue-only types in `SIGNAL_PROFILE`, `src/engine/snapshot.ts`, the same way
`links_dismiss` is), so it never asks Jev and never changes a Jev answer.

### How a new aid plugs in

1. Add its flag to `FocusAidSettings` in `src/engine/contract.ts`.
2. Add its default to `DEFAULT_FOCUS_AIDS` and its label and one-line
   description to `FOCUS_AID_TEXT` in `src/engine/focusAids.ts`. Both are
   typed by the flag, so an aid with no default or no text does not
   compile.
3. Read `settings.focusAids.<flag>` where the aid acts. For a feature that
   only works with Adaptive on, add a helper beside `upNextOn`, `backToOn`,
   `fadeQuietOn`, and `taskDoneOn` in `focusAids.ts`.
4. If switching it must change something at once (for example re-plan),
   handle the flag change in `setSettings` in `src/engine/store.ts`, next to
   `applyFadeQuiet`.

The header popover, the Controls tab, persistence, the defaults for older
saves, and the `setting_change` signal pick the new flag up with no other
change. The last one added this way is `meetingPrep` (aid 4); its lead time
is a separate optional setting, `EngineSettings.prepLeadMin`.

## Arrange linked panels by next step

The request, from the user after opening Priya Nair's "Re: Invoice
INV-1042": "The link relationship should reflow the UI and then determine
which of those will be the next step." The rules, the questions, the
constants, and the checks are in docs/anchored-relayout.md ("Next step").
As a setting:

- Label "Arrange linked panels by next step", one line: "Linked panels move
  next to what you clicked, the next step first, and Attune offers that
  step. Off: the links only draw." Flag `arrangeLinks`, on by default,
  saved and logged like the other switches (`setting_change`).
- It applies with Adaptive on (`arrangeLinksOn` in `focusAids.ts`); Freeze
  sets no anchor, so nothing gathers while frozen either.
- Off, every code path is the older one: the links draw, nothing gathers,
  no link question is asked, and there is no Next tag, step, or follow-up.
  Switching it off moves nothing; it drops the step, its tag, and its
  suggestion at once. The backfill (no orphaned holes) is not part of it
  and always runs.
- Tests: `src/engine/link-flow.test.ts` (the store: the user's case end to
  end, the order, the gate, the fallback, the resend, the follow-up, the
  switch), `src/engine/linkFlow.test.ts` (the pure parts), the gathering
  and hole tests in `packages/core/src/grid.test.ts`, and the server tests
  (`validate`, `questions`, `normalize`, `heuristic`).

## Pin or make bigger: move to the front

The request, from the user after using the app: "I think it may be better to
move a panel I expand or pin to the front of the stack." Ordinary clicks
still keep the calm relayout (the clicked panel holds still,
docs/anchored-relayout.md); only these two explicit layout requests go to the
front, the way a command's panel does.

The settings home has only on and off switches, so the two choices ("Move to
front", the default, and "Keep in place") are one switch, labeled "Move
pinned and bigger panels to the front", flag `moveToFront`. It is saved and
logged like the other switches (`setting_change`). It applies with Adaptive
on and Freeze off (`moveToFrontOn` in `focusAids.ts`); Freeze keeps every
panel where it is, as it does for a command, and the fixed layout (Adaptive
off) keeps its older rules. Switching it moves nothing at once; the next pin,
"Make bigger", or round uses it.

### The rules (on)

1. **Pin.** The panel goes to the first cell (top left) at once, at the size
   it has. The other cards reflow in plan order (the dense flow), with the
   existing staged motion. Nothing is docked for it.
2. **Make bigger.** The panel goes to the first cell as the hero
   (`BIGGER_SIZE`), and it is the anchor for the change, so its round plays
   the anchor's stages (the cards that move go with the growth) and the next
   rounds keep it there.
3. **Order at the front.** The most recent pin or "Make bigger" goes first,
   the earlier pinned or bigger panels follow, newest first, then the rest by
   the policy. `EngineState.front` keeps that recency (newest first, whatever
   the setting, persisted with the pins as `front` in `floouid:v1`; an older
   save has none, and its pins lead in pin order). `frontGroup(front, pinned,
   bigger)` is the group: every pinned or bigger panel, in that order. On
   screen the newest is always in the first cell; after it, a hero that does
   not fit beside the card before it goes to the next row, and an older,
   smaller card of the group can fill the gap it leaves (the dense flow), so
   the reading order there can differ from the group's order.
4. **Stable across Jev rounds.** The policy gets the group as
   `PolicyInput.front` and puts it first, in exactly that order, in every
   round, anchored or not. A pin in the group keeps its size in every round;
   a bigger panel is the hero. The panels after the group take the mode's
   slots as if they led, so Focus still has the policy's own hero. A
   command's panel still goes first while its promotion holds, then the
   group in its order (`applyPromotion`), then the rest.
5. **Unpin, Make smaller.** The panel stays where it is: an unpin changes no
   cell, and "Make smaller" keeps its top-left (the "Make bigger" rule). From
   the next round the policy places it again by the calm rules, since it is
   no longer in the group.
6. **The pointer.** A pin or "Make bigger" moves the panel at once even with
   the pointer on the canvas (the user just asked for it). The other holds
   stay: the policy's catch-up still waits for the pointer to leave, or
   `MANUAL_EDIT_HOLD_MS`, and automatic rounds still hold the card under the
   pointer.
7. **Following it (UI).** The store sets `EngineState.toFront` (the panel,
   the plan round that moved it, and an id) in the same update as the plan.
   In that round the canvas follows it once: when the front of the canvas is
   out of view (above the sticky app bar, or below the window), it scrolls
   the page so the canvas caption sits `FRONT_SCROLL_GAP_PX` under the app
   bar, smoothly, or at once with reduced motion. The card gets a ring for
   `FRONT_RING_MS` from when it lands (at once with reduced motion), marked
   `data-front-ring`. That round skips the anchor's scroll safety net and
   turns off the browser's own scroll anchoring, which otherwise jumped the
   page to keep the moved card still. The pin button's tip reads "Pin to the
   front".

Off ("Keep in place"), every code path is the older one: a pin under the
pointer stays put until the pointer leaves, a pin without it goes first with
its slot's size, and "Make bigger" keeps its top edge and grows right or down
(one column left in the last column). No `PolicyInput.front` is passed, so
the policy plans exactly as before.

### Constants

Since the monorepo split, `choreography.ts` and `quiet.ts` in the Where
column are in `packages/core/src/` (`@attuneui/core`); the demo's
`src/ui/choreography.ts` and `src/engine/quiet.ts` bind them to its catalog.

| Name | Where | Value | Why |
| --- | --- | --- | --- |
| `FRONT_RING_MS` | choreography.ts | 1,200 | Long enough to find the card after it lands, short enough not to read as a state |
| `FRONT_SCROLL_GAP_PX` | Canvas.tsx | 8 | The canvas caption does not touch the app bar after the page follows a panel |

### Contract (all additive)

- `src/engine/contract.ts`: `FocusAidSettings.moveToFront`;
  `EngineState.front` and `.toFront`; `PolicyInput.front`.
- `src/engine/policy.ts`: `TraditionalOptions.front`; `applyPromotion`
  argument `front`; `editPlan` option `front`.
- `src/engine/store.ts`: `loadPersisted` returns `front`; `persist` takes an
  optional `front`.
- `src/engine/focusAids.ts`: `moveToFrontOn`, `frontGroup`.
- `src/ui/domHooks.ts`: `FRONT_RING_ATTR` (`data-front-ring`).

### Checks

Unit tests: `src/engine/store.test.ts` ("move to front": a pin at 1, 2, and 4
columns with the pointer on it, a pin keeping its size in Focus, "Make
bigger" as the hero at 1, 2, and 4 columns, newest first, the group first
and in its cells over later rounds that rate it low, unpin and "Make
smaller" in place with the catch-up still waiting for the pointer, "Keep in
place", random sessions with no overlap and nothing outside the grid, and
the front order persisted), `src/engine/policy.test.ts` ("the front group"),
and `src/engine/focus-aids.test.ts` (the switch). The "make bigger" tests in
`store.test.ts` run under "Keep in place" and still pass unchanged. In the
browser at 1440x900, 1024x800, and 390x844: a last-column pin, a middle
panel made bigger, and a third pin each landed in the first cell, newest
first; the page followed from the bottom smoothly (and at once with reduced
motion); the ring showed; unpin and "Make smaller" left the panel in place;
"Keep in place" brought back the older behavior.

## Aid 1: Fade panels that do not matter now

The goal: the user's eyes go to what matters. Panels that do not matter now
get quiet, without hiding anything and without jarring moves.

### How Jev and code split the work

| Question | Who answers | Where |
| --- | --- | --- |
| How useful is each panel for the work right now? | Jev, the existing `rel_<panel>` Scores (no question changed) | `server/questions.ts` |
| Is a panel low, for how many rounds, and inside the band? | Code | `countQuietRound` in `@attuneui/core` (`packages/core/src/quiet.ts`) |
| Is it exempt right now? | Code | `quietPanels` in `@attuneui/core`, with the demo's `isQuietTouch` (`src/engine/quiet.ts`), and the policy's own checks |
| Does it shrink this round? | Code | `computePlan` in `src/engine/policy.ts` |
| How does it look? | UI | `PanelFrame.tsx`, `Canvas.tsx` |

### The rule

A panel on the canvas is **quiet** when Jev's normalized relevance (score /
max) is below `QUIET_BELOW` for `QUIET_ROUNDS` applied rounds in a row, and
it is none of these:

- the anchor (the panel the user is working in),
- linked: in the link cues (the source panel or a panel with a "Linked to"
  tag), or tagged by the policy this round. A panel that only holds a
  record joined to the anchor, with no tag, can be quiet, since nearly every
  panel shares a client with an invoice,
- pinned, or made bigger,
- focused, or under the pointer (these keep a panel from going quiet; they
  do not end it, see below),
- the panel of the record the Up next card offers,
- the panel the user usually goes to next, with "Learn my habits" on (aid
  3, below),
- used in the last `QUIET_RECENT_USE_MS` (any signal on it except a pointer
  rest, keyboard focus, or docking),
- the Guide the policy opened for a user who seems stuck.

It stops being quiet when Jev rates it above `QUIET_EXIT_ABOVE` (the band
between the two thresholds keeps drift from making it flicker) or when the
user touches it (clicks into it, opens a record, acts, scrolls, pins, or
resizes it). A touched panel needs `QUIET_ROUNDS` new low rounds to go
quiet again, and so does one whose quiet round the user undid.

Hover and keyboard focus do not end quiet: they only bring the panel to
full strength while they last. So a re-plan while the pointer passes over a
quiet panel never changes the layout.

Rounds are counted once per applied Jev round (`countQuietRound`), whether
or not the aid is on, so switching it on uses what Jev already said. The
store passes the quiet panels to the policy as `PolicyInput.quiet`.

### Fade

A quiet panel shows at `QUIET_OPACITY` and desaturated to `QUIET_SATURATE`,
with a small "Quiet" label beside its title (instead of the change badge).
Its "Why here?" says why: "Not needed for Collecting payments right now".
It fades in `QUIET_FADE_MS`; hover or keyboard focus inside it brings full
strength in `QUIET_LIGHT_MS`, with no layout change. The canvas also shows
it at full strength at once when something since its round exempts it
(it became focused, the Up next card now offers a record in it, it joined
the link cues, or it was pinned or made bigger), before the next round
catches up (`shownQuiet`).

Clicking into a quiet panel makes it a normal panel again at once, as a
manual edit (`editPlan` kind `"unquiet"`): it goes back to the size it had
(`PanelPlacement.unquietSize`), its top edge stays and it grows down, and
the cards in its way move, the way "Make bigger" does. That counts as
normal use, and the Metrics tab counts it as a reopen.

### Shrink

A quiet panel takes `QUIET_SIZE`, the existing summary tile (header plus a
one-line summary), in rounds where that keeps the calm relayout:

- a card locked in an anchored round (before the anchor, or starting
  before its top-left) shrinks in place: the packer keeps its top-left, and
  since every card has an explicit cell the anchor cannot move. (It used to
  only fade there, a rule from the CSS flow, where a card before the anchor
  that got shorter pulled the anchor up.)
- never a panel the user made bigger or smaller by hand this session,
- never a panel whose size is held by a recent event, unless it is already
  the summary tile.

The space it frees goes to the other panels through the existing packer
(cards float up into it, and the backfill pulls a later card into a spot it
fits) and the existing staged choreography.

With reduced motion, only opacity and color change; the shrink lands
without movement, like every other reduced-motion relayout.

### Off

With the aid off (or Adaptive off) no panel is quiet, and the policy plans
exactly as before. Switching it off re-plans at once from the last
judgments, after releasing the anchor, so every quiet size comes back (a
locked card keeps its size in an anchored round). Frozen, or on a layout
the user went "Back to", nothing is re-planned, so switching it off only
takes the quiet marks and sizes away.

### Metrics

The inspector's Metrics tab has "Quiet panels": how many are quiet now
("off" with the aid off), and how many of the panels that went quiet the
user reopened anyway, a sign the fade was wrong (`FlowMetrics.quiet`).

### Constants

Since the monorepo split, `choreography.ts` and `quiet.ts` in the Where
column are in `packages/core/src/` (`@attuneui/core`); the demo's
`src/ui/choreography.ts` and `src/engine/quiet.ts` bind them to its catalog.

| Name | Where | Value | Why |
| --- | --- | --- | --- |
| `QUIET_BELOW` | quiet.ts | 0.4 | Level 1 of Jev's 4 is "Background only: ... the user's current work does not need it" (0.33); this is that level with a little spread. Tuned from 0.3: live, panels on the canvas that invoice work did not need scored 0.27 to 0.38, and 0.3 faded almost nothing |
| `QUIET_EXIT_ABOVE` | quiet.ts | 0.5 | Halfway to "Supporting" (0.67); the band absorbs Jev's drift of a few hundredths per round |
| `QUIET_ROUNDS` | quiet.ts | 2 | One stray round never fades a panel |
| `QUIET_RECENT_USE_MS` | quiet.ts | 60,000 | A panel used in the last minute is still part of the work |
| `QUIET_SIZE` | quiet.ts | compact | The summary tile: nothing is hidden |
| `UNQUIET_REASON` | policy.ts | "Brought back by you" | The reason of a panel the user clicked back, until the policy's next round |
| `QUIET_OPACITY` | choreography.ts | 0.55 | Still readable, clearly behind the panels that matter |
| `QUIET_SATURATE` | choreography.ts | 0.6 | Slightly desaturated, so the eye goes to the colored panels first |
| `QUIET_FADE_MS`, `QUIET_LIGHT_MS` | choreography.ts | 400, 100 | Going quiet reads as calm; hover and focus bring it back at once |

### Contract (all additive)

- `shared/types.ts`: `SignalType` `"setting_change"`; `SignalDetail.setting`
  and `.enabled`; `PanelPlacement.quiet` and `.unquietSize`.
- `src/engine/contract.ts`: `EngineSettings.focusAids`,
  `FocusAidSettings`, `FocusAidId`; `EngineActions.setFocusAid`;
  `PolicyInput.quiet`; `FlowMetrics.quiet`.
- `src/engine/policy.ts`: `PlanEdit` kind `"unquiet"`.

### Checks

Unit tests: `src/engine/quiet.test.ts` (the rule, the band, every
exemption, the policy's sizes) and `src/engine/focus-aids.test.ts` (the
settings home, persistence and defaults, the signal kept out of the
snapshot, the Up next and Back to switches, and aid 1 in the store). In
the browser, at 1440x900 and 390x844, light and dark: working in Invoices,
Calendar and Tasks went quiet after two rounds and faded; the Invoices card
did not move (0 px) in the anchored rounds; Tasks shrank to its summary
tile in the next unanchored round and stayed small in later anchored
rounds; hover brought full strength within 200 ms with no layout change; a
click brought Tasks back to its size at the same top-left and counted one
reopen; switching the aid off by keyboard in the popover put every size
back; the Up next and Back to switches hid their card or chip and stopped
`n` and `b`.

## Aid 2: Say when a task is done, and offer the next task

The goal: when the work in front of the user is finished, Attune says so,
and offers the next piece of work in one key, so the user never has to go
looking for what comes next. As everywhere else: code facts first, Jev only
where the data cannot say it, nothing is ever done for the user, and the
old layout is one click away.

### How Jev and code split the work

| Question | Who answers | Where |
| --- | --- | --- |
| What is the user working on? | The working goal the store already follows (Jev's goal, two confident rounds, docs/predictive-flow.md) | `EngineState.working` |
| Is it done, where the data can say it? | Code: `goalFact` | `src/engine/taskDone.ts` |
| Is it done, where it cannot? | Jev, a Noul `goal_done`, two rounds in a row | `server/questions.ts`, `countDoneRound` |
| When does the card say so? | Code: `judgeTaskDone` | `taskDone.ts` |
| What else is pending? | Code: `buildNextTasks`, ranked by `TASK_PRIORITY` plus a boost | `taskDone.ts` |
| Which of those comes next? | Jev, a Choice `next_task`, past a gate; else code's top one | `server/questions.ts`, `chooseNextTask` |
| What does Start change? | Code: `taskViewPatch`, then the normal open path | `taskDone.ts`, `startNextTask` in `src/engine/store.ts` |

### The done rule

Done is judged against the working goal (`EngineState.working`).

- **Code facts first.** Where the data can say it, the data decides and
  Jev's answer is ignored:
  - Collecting payments: no overdue invoice is left without a reminder
    this session (or none is overdue). "This session" matters: INV-1038
    already had two reminders at load, so it still needs one.
  - Working through the inbox: no unread message from a client is left (a
    teammate's message is not client work).
  - Tracking projects: no project is at risk or blocked.
- **Jev for the rest** (planning the day, working on one client, reviewing
  the business, coordinating the team, writing notes): Jev's goal-done
  Noul at `TASK_DONE_JEV_AT` or more for `TASK_DONE_ROUNDS` applied rounds
  in a row. A round counts only when its request asked about this same
  working context (goal and start time), so an answer about the work before
  a goal switch, a Back to, or a Start never counts for the new one. A
  round below the threshold, or without a goal-done, breaks the streak.
  The heuristic caps goal-done at 0.6, so offline it never says a goal
  without a code fact is done.
- **Never in the first minute** of a working goal
  (`TASK_DONE_MIN_WORK_MS`). The store re-checks when the minute ends, so
  the card appears on time without new activity. Until then the older Up
  next completion line ("All overdue invoices have a reminder.") shows.

Once said, a completion is announced once (`task_done`). After Start, or a
dismiss of a card with nothing to offer, it does not come back until that
goal has open work again: its code fact turns false (a new unread
message, a new overdue invoice), or a round judges its goal-done below the
threshold. Then a later completion is said again.

### Next-task candidates

`buildNextTasks` lists the pending work of every goal other than the
working goal, one short item each, with a count and a first record, in the
same words the panels use for a record:

| Id | Goal | Card text | First record |
| --- | --- | --- | --- |
| `unread_messages` | Working through the inbox | "2 unread client messages" | The newest unread client message |
| `overdue_invoices` | Collecting payments | "3 overdue invoices without a reminder" | The most overdue one |
| `tasks_due_today` | Planning the day | "2 tasks due today" (or "due today or late") | The soonest due |
| `projects_at_risk` | Tracking projects | "1 blocked project", "2 projects at risk", "3 projects at risk or blocked" | The soonest deadline |
| `next_meeting` | Planning the day | "Meeting in 40 minutes: Harbor rebrand review" | The next meeting or call today that has not started (a focus block is not a task to start) |

They are ranked by `TASK_PRIORITY`, higher first, ties in the order above:

| Kind | Priority | Why (also the card's chip when code chose it) |
| --- | --- | --- |
| A meeting within `MEETING_SOON_MS` | 5 | "Starts soon": it has a set time, and getting ready cannot wait |
| Unread client messages | 4 | "Clients are waiting": a reply is quick |
| Overdue invoices without a reminder | 3 | "Money is owed": it gets later every day |
| Tasks due today | 2 | "Due today": there is still some time |
| Projects at risk or blocked | 1 | "Needs attention": usually a longer look, best after the quick items |
| A meeting later today | 0.5 | "Later today": on the list, but not the next thing |

**Extension point for aid 3 (learn habits).** `buildNextTasks` takes an
optional `boost: TaskBoost`, `(task, finished) => number`, added to each
task's priority before ranking; `finished` is the goal just finished, so a
habit score such as "after collecting payments this user usually opens
the inbox" can be added without touching the rest. Priorities are whole
numbers one apart, so a boost under 1 only reorders near neighbors and a
larger one lets a habit win outright. With "Learn my habits" on, the store
passes aid 3's goal-habit boost, under 1 (see "Aid 3" below), and
`boostWhy`: a task the boost moved ahead of one code ranked higher gets the
chip "You usually do this next".

The request carries the candidates (`AdaptRequest.candidates.tasks`, at
most `TASK_CANDIDATES_MAX`) only when the working goal might be done
(`mightBeDone`): its code fact is true, or, without one, the previous
round in this working context judged goal-done at `TASK_CANDIDATES_AT` or
more. So most requests carry none and pay nothing for them, and by the
round that says a goal without a code fact is done, Jev has already picked
a next task.

### What Jev is asked

Both questions ride in the same single request and never change the state
the other questions read: the working goal is in the Noul's instructions
(`working_goal`) and the candidates are in the Choice's criteria. No
existing question's wording changed.

- `goal_done` (Noul), asked only when the request carries
  `AdaptRequest.workingGoal` (its catalog label and description):
  - question: "Has the user finished their own part of the work in
    `working_goal` for now?"
  - note: "Their part is finished when the records they were working
    through have each been handled and they stopped opening new ones. The
    outcome can still depend on other people."
  - true: "The user has finished their part of that work for now." Signs:
    "The latest steps completed that kind of work: several records of that
    kind were handled one after another, for example replied to, reminded,
    checked off, or updated"; "After handling those records, the user
    stopped opening new records of that kind and turned to something else".
  - false: "The user is still doing that work, or has only started it."
    Signs: "The newest step opened a record of that kind that has not been
    handled yet"; "Records of that kind were opened or looked at, but none
    was handled"; "The work has only started: one or two steps so far";
    "Searching or looking around for something that work needs".
- `next_task` (Choice over the task ids plus "none"), asked only when the
  request carries task candidates:
  - question: "Which one of these tasks will the user most likely start
    next, after finishing their current work?", with `current_work` (the
    working goal's label), the usual evidence fields, likely: "A task that
    follows from the latest activity, for example one about a client,
    invoice, or project the user just worked on." and "A task with a set
    time that comes up soon, such as a meeting that starts shortly.", and
    the rule "Pick none when no listed task fits what the user has been
    doing."
  - each option: `task` (what the work is), `how_many` (in words),
    `first_record`, and `part_of` (its goal's label).

Tuning (September 30, one wording change over two eval rounds): the
first wording, "Has the user finished the work in `working_goal`?", was
read literally against the goal's outcome (clients paying, projects on
track), so the two held-out finished sessions scored 0.57 and 0.32.
Asking about the user's own part, with the note that the outcome can
depend on other people, moved them to 0.84 to 0.85 and 0.75 to 0.77, while
every session expected to be unfinished stayed at 0.31 or less. The
next-task wording passed as first written.

Cost: `goal_done` adds about 320 input tokens to every request with a
working goal; `next_task` adds about 540 more with four candidates, only on
the rounds where the goal might be done.

### The Done card

It takes the Up next slot (the Up next pick and completion line give way
while it shows), keeps the row's one-line height, and never moves a panel:

"Payments done: every overdue invoice has a reminder." then "Next: 2
unread client messages", a chip ("Jev 64%" when Jev chose, else code's
reason), **Start** (`n`), and **Not now**. A goal Jev judged reads
"Planning the day looks done." with its probability. With no pending task
elsewhere it only says the done line, with a dismiss button. After the prep
card and before the suggestions in the row's priority (README, "The row
under the command bar"): when the row is short of room it becomes a pill
("Payments done", `n`, and an x for Not now), and then waits in the row's
"+N" list, in full; `n` starts the next task either way. On a phone, as the
first card, it shows only the title ("Payments done") beside "Next"; the
full line is in its tip and read to screen readers.

The next task is Jev's `nextTask` when it passes the gate (`confidentTask`:
`NEXT_TASK_JEV_MIN_P` on its own, or `NEXT_TASK_JEV_LEAN_P` with a lead of
`NEXT_TASK_JEV_MARGIN` and "none" under `NEXT_TASK_JEV_NONE_MAX`, the
shape of the Up next gate) and is still one of the current candidates;
else code's top-ranked candidate.

**Start** (click, or `n` with the same key rules as Up next):

1. saves the current context as a Back to chip (with the Back to aid on),
   so `b` returns to it as it was;
2. makes the task's goal the working goal (answers to requests sent before
   it do not count toward a goal switch);
3. opens the task's panel from the dock when it is docked;
4. sets its filter through the view state: Inbox clears its search and
   client filter (it has no unread filter; the unread messages are the
   newest and marked), Invoices shows Overdue, Tasks clears the client
   filter and hides done tasks, Projects shows the one status its pending
   projects share (else All), Calendar shows Today;
5. selects the first record the way a click does, and logs `task_start`,
   which anchors the panel, so the calm relayout, the anchor, and the link
   cues apply, and asks Jev for a new read;
6. when the panel is out of view (a phone's one column), scrolls the page
   so it sits under the app bar (at once with reduced motion).

It never performs an action: no reply, reminder, or status change.

**Not now** hides the card for that goal for `TASK_DONE_SNOOZE_MS`; then it
comes back if the goal is still the working goal and still done, without a
second announcement.

### Signals and metrics

- `task_done` (engine-made): "Said "Collecting payments" is done, and
  offered the next task: four unread client messages". Left out of the
  snapshot (`SIGNAL_PROFILE.cueOnly`), not a trigger, no recent use, not the
  user's work in the Metrics tab.
- `task_start` (user): "Started the next task: four unread client
  messages, and opened message "Re: Invoice INV-1042" from Priya Nair at
  Harbor Coffee Co. in Inbox". Read by Jev, a trigger, and a record open
  for recent use, the next-record hit rates, and list work.
- Metrics tab: "Tasks marked done" (with how many offered a next task) and
  "Next task started" (started of offered); the Right now row shows the
  Done card when there is one. The Now tab shows "Working goal done" and
  "Next task" when they were asked.

### Off

With the aid off (or Adaptive off) there is no card, the requests carry no
working goal and no task candidates (so no new question is asked and the
request is exactly as before), no `task_done` is logged, and the Up next
completion line works as before. The working goal is still followed, so
switching it on shows a card at once when the work is already done.

### Constants

| Name | Where | Value | Why |
| --- | --- | --- | --- |
| `TASK_DONE_JEV_AT` | taskDone.ts | 0.75 | Well past the unsure middle: saying "done" too early is worse than a round late |
| `TASK_DONE_ROUNDS` | taskDone.ts | 2 | One stray round never says done, the same rule as a goal switch |
| `TASK_DONE_MIN_WORK_MS` | taskDone.ts | 60,000 | The work has barely started, and a fresh goal can arrive with its work already done |
| `TASK_DONE_SNOOZE_MS` | taskDone.ts | 5 minutes | Long enough to finish a thought, short enough to come back while it matters |
| `TASK_CANDIDATES_AT` | taskDone.ts | 0.5 | Send candidates a round early, below the done threshold, and not on most requests |
| `TASK_CANDIDATES_MAX` | taskDone.ts | 5 | One per goal with pending work fits (the contract's cap) |
| `NEXT_TASK_JEV_MIN_P` | taskDone.ts | 0.5 | Shows on its own |
| `NEXT_TASK_JEV_LEAN_P`, `NEXT_TASK_JEV_MARGIN`, `NEXT_TASK_JEV_NONE_MAX` | taskDone.ts | 0.4, 0.15, 0.2 | A lean with a clear lead and little on "none"; a near tie is a guess |
| `MEETING_SOON_MS` | taskDone.ts | 60 minutes | A meeting this soon ranks first; there is just enough time to get ready |
| `TASK_PRIORITY` | taskDone.ts | 5, 4, 3, 2, 1, 0.5 | See the ranking table above |
| `GOAL_DONE_BASE`, `GOAL_DONE_ACTED_STEP` (max 3), `GOAL_DONE_STILL_OPENING`, cap 0.6 | server/heuristic.ts | 0.2, 0.1, 0.25 | The fallback's modest goal-done: records handled raise it, a newest open keeps it low, and it never reaches the done threshold |
| `MAX_TASKS`, `MAX_TASK_ID`, `MAX_TASK_LABEL`, `MAX_TASK_COUNT`, `MAX_GOAL_LABEL`, `MAX_GOAL_DESCRIPTION` | server/validate.ts | 5, 64, 120, 20, 80, 200 | Caps for the new request fields; ids are dropped when too long, text is clipped |
| `START_SCROLL_GAP_PX`, `START_MIN_VISIBLE_PX` | src/ui/UpNext.tsx | 8, 160 | After Start the panel sits just under the app bar; it counts as in view when its header and first row show |

### Contract (all additive)

- `shared/types.ts`: `SignalType` `"task_done"` and `"task_start"`;
  `SignalDetail.task`; `TaskCandidate`; `WorkingGoalWords`;
  `AdaptRequest.workingGoal` and `AdaptRequest.candidates.tasks`;
  `Judgments.goalDone` and `Judgments.nextTask`.
- `shared/scenarios.ts`: `Scenario.workingGoal`, `Scenario.tasks`,
  `expect.goalDone`, `expect.nextTask`.
- `server/questions.ts`: `QUESTION_IDS.goalDone` (`goal_done`) and
  `.nextTask` (`next_task`); `NO_TASK`; `taskCandidates`; `workingGoalOf`.
- `src/engine/contract.ts`: `FocusAidSettings.taskDone`; `NextTask`;
  `TaskDoneState`; `EngineState.taskDone`; `EngineActions.startNextTask`,
  `.snoozeTaskDone`, `.dismissTaskDone`; `FlowMetrics.taskDone`.
- `src/engine/focusAids.ts`: `taskDoneOn`.
- `src/engine/taskDone.ts` (new).

### Checks

Unit tests: `src/engine/taskDone.test.ts` (the code facts, the candidates
and their order, the boost, the done rule with two rounds and the first
minute, when candidates are sent, the gate, Start's view change),
`src/engine/task-done.test.ts` (the store: the card after the first
minute, what the requests carry, Jev's pick, open work again, Start
saving a Back to context, opening from the dock, filtering, selecting,
and performing no action, Not now, dismiss, a goal Jev judges, the
heuristic, the switch off), and the server tests (`validate`, `questions`,
`normalize`, `heuristic`). Each new test fails with the new code removed.
`pnpm eval` checks goal-done in nine sessions (two held out as finished,
one held out midway) and the next task in one. In the browser at 1440x900:
three reminders sent with `n`, the Done card after the first minute
("Payments done ... Next: 4 unread client messages, Jev 60%"), `n`
started it (Priya's message selected, links shown, nothing sent), `b`
went back to the invoices as they were and the card did not return,
finishing the inbox showed "Inbox done ... Next: 2 tasks due today", Not
now hid it and it came back after five minutes; at 390x844, light and
dark, the card fit the row with no sideways scroll, the switch off showed
the older completion line, and Start scrolled the Tasks panel into view.

### Known limits

- **Inbox has no unread filter.** Start clears the Inbox search and client
  filter instead; the unread messages are the newest and marked.
- **Goal-done for the goals with a code fact** is asked and shown in the
  inspector, but only the data decides them; it costs its tokens on those
  rounds too.
- **The next task can lag a round.** Jev's pick comes from the newest round
  that carried candidates; between rounds, a pick no longer offered falls
  back to code's top candidate.
- **One completion per goal until it has open work again.** Finishing
  planning the day twice in a session without new work in between is said
  once.

## Aid 3: Learn my habits

The goal: Attune gets better at guessing what comes next the longer the
user works with it, from their own habits, without sending those habits
anywhere and without ever acting on them. Code learns and uses the habits;
Jev only reads at most two of them in words; nothing is done for the user;
and one switch turns it all off.

### How Jev and code split the work

| Question | Who answers | Where |
| --- | --- | --- |
| What did the user do, and does it teach a habit? | Code, from tracked events as they happen | `habitStep` in `src/engine/habits.ts`, called from `trackInternal` in `src/engine/store.ts` |
| Is it a habit yet? | Code: decayed counts and an evidence bar | `isHabit`, `nextPanels`, `nextGoals`, `actionsAfter` |
| Where will the user likely go next? | Code: the learned chance per panel | `habitHints` |
| How much does it move a panel? | Code: the habit weight, on top of the blend | `scorePanels` in `@attuneui/core`, called by the demo's `scorePanels` in `src/engine/policy.ts` with the habit weight |
| What will the user likely do next? | Jev, as before; the habit only when Jev is unsure | `buildSuggestions` |
| What does Jev read about it? | At most two habits, in words | `habitObservations`, `SnapshotContext.habits` |

No Jev question changed, and none was added.

### What is learned

Four kinds of decayed counts (`HabitMemory`):

- **Where the user goes next:** the panel they worked in, then the next
  different panel they worked in, by time of day (morning before 12,
  afternoon 12 to 17, evening from 17, by the browser's clock).
- **Where they start:** the first panel worked in per session, by time of
  day. A session is a page load, a Reset, or work after
  `HABIT_SESSION_GAP_MS` without any.
- **What work comes next:** the working goal, then the next working goal,
  when the user's own work moved it: a goal switch Jev judged twice, a
  command to another area, or Back to.
- **What they do after opening a record:** the first action about a record
  the user opened (in its panel, on it, or for its client; "Schedule
  meeting" in Clients is logged on Calendar), within
  `HABIT_ACTION_WINDOW_MS`, by the record's kind.

"Worked in" means a record opened, an action, a filter, or a search
(`HABIT_EVENT_TYPES`), done by hand. These never teach a habit, so Attune's
own offers cannot teach it: engine-made and cue-only signals (a saved
context, a task marked done, a settings switch, clearing links), looking
around (clicking into a panel, pointer rests, scrolls), anything done from
a suggestion or the command bar, records opened from Up next, a started
next task, an undo, and a replayed scenario.

Every count halves every `HABIT_HALF_LIFE_MS`, so an old habit fades on its
own, and each kind keeps at most `HABIT_MAX_ENTRIES` (the weakest go
first; a count below `HABIT_FORGET_BELOW` is dropped). A move is a habit
only with enough evidence: a decayed count of at least `HABIT_MIN_COUNT`
(three recent times; two can never reach it) and at least `HABIT_MIN_SHARE`
of the moves from the same place, so a spread of one-off moves is no habit
and at most two panels can be one.

### How the habits are used

Only with the switch on, Adaptive on, and a habit past the evidence bar.
With none, every code path is the older one.

- **Layout.** A new weight, `habit` (`HABIT_WEIGHT`, a slider "Your habits"
  in the inspector's Controls tab next to the other weights). Each panel's
  habit part is the weight times the learned chance that the user goes
  there next from the panel they work in now, at this time of day (or,
  before any work this session, where they usually start). It is added on
  top of the relevance, recent use, and goal parts, not blended with them,
  so without a habit every priority is exactly as before. It shows in
  `placement.breakdown.habit`, in "Why here?" ("You usually go here next"),
  and in the Decisions tab ("Habit"), and when it is the strongest part the
  reason says so: "You usually open Calendar after Inbox in the morning".
  The clicked panel still holds still: the anchor rules are unchanged.
- **Not faded.** The usual next panel is exempt from aid 1, the way the Up
  next panel is: fading the place the user is about to go works against the
  habit.
- **Up next.** Jev still picks, behind the same gate. In code's candidate
  order (which Jev reads, and which is cut at `RECORD_CANDIDATES_MAX`),
  records in the usual next panel move up `UP_NEXT_HABIT_LIFT` places, never
  ahead of the next records in the list the user is in. Among the card's
  alternative chips, one in the usual next panel ranks as if Jev gave it
  `UP_NEXT_HABIT_CHIP_BOOST` more.
- **Next task (aid 2).** The store passes a `TaskBoost` from the goal
  habits: `HABIT_TASK_BOOST_MAX` times the share of "after the goal just
  finished, this task's goal". Under 1, as the hook's contract asks, so it
  only reorders near neighbors; a task it moved ahead of one code ranked
  higher gets the chip "You usually do this next" (`HABIT_TASK_WHY`).
- **Suggestions.** When Jev offers no step of its own and gives "no next
  step" less than `HABIT_SUGGEST_NONE_BELOW`, the action the user usually
  takes after opening a record of this kind may be offered: always subtle,
  never primary, never performed on its own, with the chip "Habit" and the
  reason "You usually do this after opening an invoice". An action on a kind
  of record is offered only for the open record itself, never for another
  invoice of the client; one just done on that record, or dismissed, is not
  offered again.
- **Words for Jev.** At most `HABIT_OBSERVATIONS_MAX` habits that fit now,
  strongest first, after the other behavior observations: where the user
  usually goes from here ("Usually opens Calendar after Inbox in the
  morning", or "Usually starts in Inbox in the morning"), what they usually
  do after the open record's kind ("Usually replies after opening a
  message"), and what work usually follows the working goal ("Usually moves
  on to planning the day after working through the inbox"). `pnpm eval`
  builds its snapshots without the store, so its requests are unchanged.

### The Habits view and the metric

The inspector has a **Habits** tab: the switch, how many habits there are,
the habit guess count, and every learned move in plain words with its
strength ("Almost always", "Usually", "Often", or "Not a habit yet") and
its counts ("about 4 of 5 times"), in four lists (where you go next, where
you start, what work comes next, what you do after opening a record), the
strongest first and at most `HABIT_VIEW_MAX` each.

- **Load a sample week** adds a made-up week of a studio owner's use (mail
  then the day's plan in the morning, money in the afternoon, tomorrow's
  list in the evening), so the effect shows at once. It is marked "Sample
  data" until the user forgets it.
- **Forget my habits** asks for a second click ("Click again to forget",
  for `FORGET_CONFIRM_MS`), with no browser dialog, then clears the saved
  habits, the memory, the sample mark, and the guess count. The layout
  catches up at its normal pace.

The Metrics tab has **Habit guess right: X of Y**: the moves where the
habits had a guess (the top next panel, or where a session usually starts)
and how many matched where the user went. It is counted with the switch on
or off, so the user can judge the habits before trusting them.

### Saved in this browser

The habits are saved in localStorage under `floouid:habits:v1`, apart from
the settings (`floouid:v1`), so Forget clears only them. A missing,
unreadable, or hand-edited save gives no habits (each count is checked),
and storage that is blocked or full never throws: the habits then last for
the page. Reset keeps them, as it keeps the pins.

### Off

With the switch off (or Adaptive off) Attune stops learning and stops
using the habits, and every request and plan is exactly the one with
nothing learned (a store test compares them field by field). What it
learned stays until the user forgets it, and the habit guess count goes on.
Switching it either way re-plans at the normal pace; Up next and the Done
card update at once.

### Constants

| Name | Where | Value | Why |
| --- | --- | --- | --- |
| `HABIT_HALF_LIFE_MS` | habits.ts | 14 days | A habit from a normal week stays strong, and one unused for a month counts a quarter |
| `HABIT_MIN_COUNT` | habits.ts | 2.5 | Three recent times: counts decay, so three moves in the last three days reach it, and two never can |
| `HABIT_MIN_SHARE` | habits.ts | 0.4 | A spread of one-off moves is no habit, and at most two panels can be one |
| `HABIT_MAX_ENTRIES` | habits.ts | 100 per kind | Far more than the real pairs (10 panels, 3 times of day); the saved JSON stays a few kilobytes |
| `HABIT_FORGET_BELOW` | habits.ts | 0.05 | About two months unused: dropped, so the save does not grow forever |
| `HABIT_SESSION_GAP_MS` | habits.ts | 30 minutes | Work after this long without any starts a new session, as a page load does |
| `HABIT_ACTION_WINDOW_MS` | habits.ts | 5 minutes | An action later than this after an open is about something else |
| `MORNING_ENDS_HOUR`, `AFTERNOON_ENDS_HOUR` | habits.ts | 12, 17 | Morning before noon, afternoon to 17, evening after |
| `HABIT_WEIGHT` | habits.ts | 0.15 | On top of the blend: a strong habit lifts a panel past the dock line or a near neighbor (the swap margin is 0.08), never past a panel Jev rates central (about 0.4 from relevance alone) |
| `HABIT_OBSERVATIONS_MAX` | habits.ts | 2 | Enough to name the strongest habits, few enough not to crowd what the user is doing now |
| `HABIT_TASK_BOOST_MAX` | habits.ts | 0.9 | Times the share; under 1, so it reorders only near neighbors in `TASK_PRIORITY` |
| `HABIT_STRONG_SHARE`, `HABIT_USUAL_SHARE` | habits.ts | 0.75, 0.55 | "Almost always", "Usually"; below, down to the evidence bar, "Often" |
| `HABIT_VIEW_MAX` | habits.ts | 8 | Rows per list in the Habits view; the rest are counted |
| `HABIT_TASK_WHY` | habits.ts | "You usually do this next" | The Done card's chip for a task a habit moved up |
| `HABIT_SUGGEST_NONE_BELOW` | policy.ts | 0.5 | Jev is unsure, not sure that nothing comes next |
| `UP_NEXT_HABIT_LIFT` | nextUp.ts | 3 places | About one group of the day's loose ends; can bring a record inside the candidate cap |
| `UP_NEXT_HABIT_CHIP_BOOST` | nextUp.ts | 0.05 | Orders near-tie chips only; the gate uses Jev's own probability |
| `FORGET_CONFIRM_MS` | HabitsTab.tsx | 5 seconds | Long enough to read the new label, short enough not to linger armed |
| `REFRESH_MS` | HabitsTab.tsx | 10 seconds | The counts fade slowly, so a slow refresh is enough |

### Contract (all additive)

- `shared/types.ts`: `PolicyWeights.habit` (optional; absent means
  `HABIT_WEIGHT`); `PanelPlacement.breakdown.habit` (optional, only in a
  round that used a habit); `Suggestion.habit`.
- `src/engine/contract.ts`: `FocusAidSettings.habits`; `TimeOfDay`,
  `HabitCount`, `HabitMemory`, `HabitHints`; `EngineState.habits`;
  `EngineActions.forgetHabits`, `.loadSampleHabits`; `FlowMetrics.habits`;
  `PolicyInput.habit`; `SnapshotContext.habits`.
- `src/engine/policy.ts`: `PanelScore.parts.habit` and `.raw.habit`;
  `habitWeight`; `buildSuggestions` takes an optional fifth argument, the
  habit action; `HABIT_SUGGEST_NONE_BELOW`.
- `src/engine/nextUp.ts`: `CandidateInput.habitPanel`,
  `UpNextInput.habitPanel`; `UP_NEXT_HABIT_LIFT`, `UP_NEXT_HABIT_CHIP_BOOST`.
- `src/engine/taskDone.ts`: `NextTaskInput.boostWhy`.
- `src/engine/quiet.ts`: `QuietContext.usual`.
- `src/engine/metrics.ts`: `metricsOnHabitGuess`; the `habit-guess` line.
- `src/engine/focusAids.ts`: `habitsOn`.
- `src/engine/store.ts`: `DEFAULT_SETTINGS.weights.habit`.
- `src/engine/habits.ts` (new) and `src/inspector/HabitsTab.tsx` (new).

### Checks

Unit tests: `src/engine/habits.test.ts` (decay and the cap, the time of day,
moves per time of day and session starts, what never counts, the action
after a record kind, goal moves, the evidence bar, the guesses with
learning on or off, the hints and reasons, at most two habits in words,
the next-task boost under 1 and its chip, persistence with throwing
storage, the sample week and the Habits view's words, the policy's habit
part, slider, and reason, the subtle suggestion rule, and the Up next lift
and chips) and `src/engine/habits-store.test.ts` (the switch and the
slider saved, learning from tracked events and saving it, goal moves from a
switch and Back to, nothing from a replay, the sample week giving the
habit part, the reason, a still clicked panel, the lifted candidates, and
at most two habit lines in the request, the subtle suggestion, the guess
metric, the switch off giving exactly the requests and plans with nothing
learned, Forget, and storage that throws). Each new test fails with the
new module removed, and each fails when the one behavior it covers is
taken out. The store test files forget the habits before each test, since
the habits outlive Reset by design.

`pnpm eval` sends byte-identical requests before and after this change
(checked by building every eval request at a fixed time with the eval's
own code, and by comparing the 29 requests of the last run with the run
before the change). The run after the change: 18 of 20 sessions, 9 of 9
commands, 95 of 97 checks. Both misses are known near ties on identical
requests: the keyboard session's next record (missed in 1 of 2 runs before
the change and in 3 of 3 reruns after) and the invoice click's link-next
(none 0.32, the message 0.27, the client 0.25; it changed choice between
reruns).

In the browser at 1440x900, September 30 in the afternoon: "Load a sample
week" showed 19 habits marked "Sample data"; a click on a message in Inbox
gave Invoices a habit part of 0.12 and the reason "You usually open
Invoices after Inbox in the afternoon"; the Inbox card did not move (0 px,
twice); the request carried "Usually opens Invoices after Inbox in the
afternoon" and "Usually replies after opening a message", and its record
candidates had the three overdue invoices moved up three places each,
behind the next messages in the list; after the inbox was done, the Done
card offered "3 overdue invoices without a reminder" (Jev 90%), the request
carried "Usually moves on to planning the day after working through the
inbox", and the task order was unchanged (tasks due today at 2.72 stays
behind overdue invoices at 3); "Habit guess right 1 of 1" in Metrics;
Forget, after a second click, emptied the list and removed the saved key;
switched off, a message click left Invoices faded with no habit part and
the request had no habit line and code's plain order. At 390x844, light
and dark, the Habits tab, the canvas, and the popover's new switch fit with
no sideways scroll; in dark mode at 1440x900, "Why here?" and the Habits
tab read well. No console errors.

### Known limits

- **The next task moves little.** With `TASK_PRIORITY` whole numbers one
  apart, a boost under 1 can only lift "a meeting later today" (0.5) past
  "projects at risk" (1). In practice the goal habit reaches the Done card
  through the words Jev reads. `HABIT_TASK_BOOST_MAX` over 1 would let a
  strong habit win outright (the hook allows it).
- **The habit reason is rare with Jev's opinion.** With the default weight,
  a panel Jev rates useful keeps Jev's reason; the habit part still shows
  in "Why here?".
- **No habit-only Up next card.** Jev still picks behind its gate; the lift
  changes code's candidate order and the chips, not what shows when Jev is
  unsure.
- **One person per browser, by the browser's clock.** Habits are not
  synced, and a shared browser learns everyone's.
- **After a replay.** Replayed steps teach nothing, but a Jev round that
  lands after the replay ends can still count one goal move.
- **Forget removes everything.** The sample week cannot be removed apart
  from what the user taught.

## Aid 4: Prepare for meetings

The goal: when a meeting with a client is about to start, the user does not
have to go looking for what matters for it. Attune offers to prepare, and
one key brings up the client's records next to the meeting, the most useful
first, with the one thing to handle before the meeting named when there is
one. As everywhere else: Jev judges which records matter (in its own
request), code decides what shows and where, nothing is ever done for the
user, and the work being left is one click away.

### How Jev and code split the work

| Question | Who answers | Where |
| --- | --- | --- |
| Is a meeting coming up? | Code: `upcomingMeeting`, rechecked every `PREP_RECHECK_MS` | `src/engine/meetingPrep.ts`, `refreshPrep` in `src/engine/store.ts` |
| Which records might matter? | Code: `buildPrepRecords`, from the data | `meetingPrep.ts` |
| How much does the user need each one before the meeting? | Jev, one Score per record, in POST /api/prep | `server/questions.ts` (`buildPrepQuestions`) |
| Does anything need action before it starts? | Jev, the Noul `anything_urgent` | `server/questions.ts` |
| Which panels link, in which order, which rows are tinted? | Code: `prepPanels` | `meetingPrep.ts` |
| What is the one thing to handle first? | Code, when Jev's Noul is at least `PREP_URGENT_AT`: `urgentLine` | `meetingPrep.ts` |
| What does Prepare change? | Code: `prepViewPatches`, `buildPrepPlan`, then the gathering | `meetingPrep.ts`, `prepareMeeting` and `arrangePrep` in the store |

### The upcoming meeting

A calendar event is offered when it is a meeting or a call (never focus
time or an internal meeting), it has a client (a meeting without one has no
records to bring up), it starts within the lead time (5, 10, 15, or 30
minutes, `PREP_LEAD_DEFAULT` 15, chosen in the inspector's Controls tab),
it started no more than `PREP_STARTED_GRACE_MS` ago, and the user has not
prepared for it or said "Not now" to it this session. When two qualify, the
soonest start wins. `upcomingMeeting` reads the clock only from its `now`
argument; the store rechecks every `PREP_RECHECK_MS`, after a setting
changes, after a meeting is simulated, and after Reset.

### The chip

First in the row under the command bar (which keeps one line's height, so
it never moves a panel), before the Up next card: "Harbor rebrand review in
12 min" with a minute countdown (`PREP_TICK_MS`), the one thing to handle
first when Jev says there is one ("1 thing to handle first: INV-1042 is 14
days overdue", in warning colors), **Prepare** (`p`), and **Not now**, which
hides it for that meeting for the session. On a phone it shows the
countdown, the count of things to handle first, Prepare, and an x; the full
line is in its tip and read to screen readers. It is never a pill or in the
row's "+N": when the row is short of room, once the cards after it are
pills, it shows that count and an x on a wider screen too, or, with room to
spare, the line cut short. `p` works when focus is not in a text field,
the command bar, a popover, or the inspector (`flowKeyTaken`, the same
rules as `n` and `b`); no other key used `p`. The first time a meeting is
offered, the engine logs `prep_offer` and asks /api/prep for the ranking
ahead of time, so Prepare usually finds it ready.

### Prepare

Prepare (a click, or `p`) is a manual edit: it applies at once, not after
the minimum change interval.

1. Saves the current context as a Back to chip (with the Back to aid on),
   so `b` returns to it as it was.
2. Makes the meeting's client the working context: goal "Working on one
   client" with `WorkingGoal.client` set, so a saved context for the same
   goal and another client still shows as a chip (`backToList` takes the
   client).
3. Sets the views the way the user would: Calendar shows the meeting's day
   and selects the meeting; Inbox, Invoices (open ones: sent or overdue),
   and Tasks (open ones) show only the client's records; Projects and
   Clients clear a filter or search only when it would hide the client's
   rows. A panel with no record for the meeting is left alone.
4. Brings Calendar onto the canvas when it was docked, and makes the meeting
   in Calendar the anchor, so Calendar holds still.
5. Links the client's panels with the tag "For the meeting" (`LinkSet.prep`
   marks them): Clients (the client row), Inbox, Invoices, Projects, and
   Tasks, each with the records Jev rates at least useful tinted (its best
   one when none is). Linked panels that were docked come onto the canvas,
   at least standard size, and none is quiet. They gather next to Calendar
   through the existing gathering (`PackInput.gather`) in the prep view's
   own order: by the best score of each panel's records, highest first,
   Clients at `PREP_CLIENT_SCORE`; before Jev answers, code's order (the
   records with an action due first, Clients last). Lines run from the
   meeting's row to each tag. An answer that lands after Prepare re-orders
   the view at once while its anchor holds.
6. Logs `prep_start`, and holds the prep view until the user does new work,
   the way a layout they went back to holds.

It never performs an action and never edits the notes. The card that
replaces the chip says "Ready: Harbor rebrand review in 11 min", with the
same thing to handle first and a close button (the panels stay as they
are). It goes when the meeting is more than `PREP_STARTED_GRACE_MS` in.

While the prep view's links show, work on a record of the meeting's client
in Calendar or in a linked panel keeps them (and gathers nothing, since the
view is already arranged), so the user can open its records one after
another; work for another client makes its own links, which replace them.
Later rounds for the prep view's anchor keep its links and its order.

### Start meeting notes

After Prepare the suggestion row offers "Start meeting notes" (subtle, with
a "Meeting" chip; `Suggestion.meetingNotes`). Only when the user presses it
does the heading go into the notes ("Harbor rebrand review, 11:00, notes:",
after a blank line when there are notes already), Notes opens (from the
dock when needed, at least standard size), and the cursor goes to the end
of the notes. Dismissed, it is not offered again for that meeting.

### What Jev is asked

Its own request, POST /api/prep (`prep()` in `server/adapt.ts`), because
its state is different: the meeting, not the user's activity. It goes
through the same guard as /api/adapt (loopback Host and Origin, a JSON
body), its own rate limit (`PREP_RATE_MAX` in `PREP_RATE_WINDOW_MS`), the
same body cap, validation (`parsePrepRequest`), budget, heuristic fallback,
error labels (`no_key`, `jev_error`), and source labels. The routes live in
`server/app.ts` now, so tests call them through the guard.

- State: `{ meeting: { title, client, time, kind } }`, for example
  "Harbor rebrand review", "Harbor Coffee Co.", "starts in 12 minutes, at
  11:00 today", "meeting". Code does the clock math.
- Records: at most `PREP_RECORDS_MAX`, built by code (`buildPrepRecords`):
  the client's messages from the last `PREP_MESSAGE_DAYS` (at most
  `PREP_MESSAGES_MAX`, text clipped to `PREP_TEXT_MAX` characters, with
  when it arrived and whether it is read), open invoices with status words,
  the client's open projects with status, progress, and deadline, and open
  tasks with due words. Every record carries its client.
- One Score per record (`prep_record_<n>`), the record in its own
  instructions as `record`, never in the state, with the same question and
  levels for every record, so the scores compare (the re-ranking
  cookbook's pattern):
  - question: "How much does the user need `record` before `meeting`
    starts?", with the note "The user runs Fernhill Studio, a small design
    studio, and is about to go into `meeting` with one of the studio's
    clients. `record` is one of the studio's records."
  - level 0: "Not needed for this meeting: the record belongs to another
    client or to no client, or it is finished and needs nothing from
    anyone." Examples: "a message about another client's job", "a record
    for a different client".
  - level 1: "Useful background: the record is about this client and could
    come up, but it is not part of the work the meeting is about, and
    nothing in it is waiting on the user." Examples: "a bill that is sent
    and not due yet", "a message that only shares information or says
    there is no rush".
  - level 2: "Should be reviewed before this meeting: the record is part of
    the work the meeting is about (the project, an open task for it, or a
    message about it), or something in it is waiting on the user."
    Examples: "a request or question from the client that has not been
    answered", "a bill past its due date", "the project the meeting is
    about, or an open task for it".
- The Noul `anything_urgent`, with every record in its instructions as
  `records`: "Does any record in `records` need the user to do something
  before `meeting` starts?" True: "At least one record needs the user to
  act before the meeting starts." (signs: an invoice for this client
  overdue and still unpaid; a message from the client that asks for
  something not done yet; a task for this client due today or late).
  False: "Nothing in these records needs the user to act before the
  meeting; it can wait, or be discussed in the meeting." (signs: invoices
  sent and not due yet; messages that only share information or say there
  is no rush; tasks due on a later day).

`normalizePrepJudgments` checks every answer against the questions sent and
keys each Score back to its record id; anything missing or out of shape
falls back to the heuristic (`heuristicPrepJudgments`): an action due
(overdue, unread, due today or late) or the project the meeting's title
names is "should be reviewed", other business of the client is background,
a record of another client is not needed, and anything urgent is the
heuristic's cap (0.6, which just reaches the urgent line, since an overdue
bill is a fact) when a record of the client has an action due, else 0.2.

Tuning (September 30, four rounds on the four eval cases, general
principles only):

1. The first wording ("the record is about other work, or it is settled
   business") put Priya's message about INV-1042 at 0.39 for the rebrand
   review, the at-risk Meridian project at 0.24, and its overdue bill at
   0.15: 1 of 4 cases, 9 of 12 checks.
2. Every record now carries its client (the project and the bill did not,
   so Jev could not tie them to the meeting), and the levels say "belongs
   to another client or to no client" and "waiting on the user": Priya's
   message 0.87, Meridian's project 0.76; 2 of 4, 9 of 12.
3. Structured levels, each with examples of general patterns: 3 of 4, 10
   of 12; a sent Solace bill still scored 0.88, over the matching task.
4. Level 1 says the record "is not part of the work the meeting is about",
   and level 2 names that work (the project, an open task for it, or a
   message about it): 4 of 4, 12 of 12.

After round 1 the Solace case's expectation changed from "the sent bill
scores at most 0.35" to "the sent bill ranks last": its project is the
meeting's topic, so a low absolute score was the wrong thing to ask for. It
still scores 0.85 to 0.89, above the tint line (see Known limits).

### Signals and metrics

- `prep_offer` (engine-made): "Offered to prepare for Harbor rebrand
  review, 11:00 today". Left out of the snapshot (`SIGNAL_PROFILE.cueOnly`), not a
  trigger, no recent use, not counted toward density, not the user's work
  in the Metrics tab.
- `prep_start` (user): "Started preparing for calendar event Harbor rebrand
  review, 11:00 today in Calendar, using the keyboard". Read by Jev, a
  record open for recent use and the next-record hit rates, never a
  trigger (the prep view holds until new work, which asks), and it teaches
  no habit (Attune offered it).
- Metrics tab: "Meetings prepared" (prepared of offered, with both
  counts) and "Records opened from a prep view" (each record once); the
  Right now row shows the chip or the card, and whether a Jev or heuristic
  ranking is in.

### The simulated meeting

The fixture meetings are at fixed times today, so "Test: simulate a meeting
in 10 minutes" (inspector Controls, and under the switch in the Focus
popover, marked as a test) adds a meeting `SIMULATED_MEETING_IN_MS` from now
with the client of the newest thing the user did about a client (else the
client with the newest message), named after their open project ("Harbor
rebrand check-in"). Reset removes it with the rest of the session's data.

### Off

With the aid off (or Adaptive off) there is no chip, no card, no prep
request, no timer, no signal, and `p` does nothing; every adapt request is
exactly the one with the aid on (a store test compares them). Switching it
off while a prep view shows takes the card and the notes offer away at
once, and its links become ordinary links; nothing moves.

### Constants

| Name | Where | Value | Why |
| --- | --- | --- | --- |
| `PREP_LEAD_OPTIONS`, `PREP_LEAD_DEFAULT` | meetingPrep.ts | 5, 10, 15, 30; 15 minutes | From a quick look to time for a real read; the default leaves room to read a few records and handle one small thing |
| `PREP_STARTED_GRACE_MS` | meetingPrep.ts | 5 minutes | The user may be joining late, and the records still help |
| `PREP_RECHECK_MS` | meetingPrep.ts | 30 s | Twice a minute keeps the minute countdown right and costs nothing |
| `PREP_KINDS` | meetingPrep.ts | meeting, call | Focus time and internal meetings have no client records to bring up |
| `PREP_RECORDS_MAX` | meetingPrep.ts | 10 | Each is one Score in one request, and ten cover a client's open business |
| `PREP_MESSAGE_DAYS`, `PREP_MESSAGES_MAX` | meetingPrep.ts | 14 days, 3 | Older messages are settled or answered; the newest three show where the thread is |
| `PREP_INVOICES_MAX`, `PREP_PROJECTS_MAX`, `PREP_TASKS_MAX` | meetingPrep.ts | 3, 2, 3 | What the client owes now, their open work, and what is still owed to them |
| `PREP_TEXT_MAX` | meetingPrep.ts | 200 | A request fits, and ten Scores stay small |
| `PREP_TINT_AT` | meetingPrep.ts | 0.5 | "Useful background" of three levels: at least useful is tinted |
| `PREP_CLIENT_SCORE` | meetingPrep.ts | 0.5 | Clients has no scored record; the contact and notes help in any meeting |
| `PREP_URGENT_AT` | meetingPrep.ts | 0.6 | Past the unsure middle; the heuristic's cap, so offline an overdue bill still shows |
| `SIMULATED_MEETING_IN_MS`, `SIMULATED_MEETING_LENGTH_MS` | meetingPrep.ts | 10 minutes, 30 minutes | Inside the default lead, so the chip shows at once |
| `PREP_TICK_MS` | MeetingPrep.tsx | 15 s | The minute shown is never more than a quarter minute late |
| `LINK_SET_MAX` | relations.ts | 5 | A click links at most 3 panels; a prep view links every record kind of one client |
| `PREP_RATE_MAX`, `PREP_RATE_WINDOW_MS` | server/app.ts | 4 in 2 s | One request per meeting, again only when its records change: this only stops a loop |
| `MAX_PREP_RECORDS`, `MAX_PREP_TEXT`, `MAX_PREP_FIELD` | server/validate.ts | 10, 200, 120 | Caps for the prep body; text is clipped, a bad record dropped |
| `PREP_DUE_LEVEL`, `PREP_TOPIC_LEVEL`, `PREP_BACKGROUND_LEVEL`, `PREP_RECENT_MESSAGE_LEVEL`, `PREP_OTHER_CLIENT_LEVEL`, `PREP_URGENT_YES`, `PREP_URGENT_NO` | server/heuristic.ts | 2, 2, 1, 1.4, 0.2, 0.6, 0.2 | The fallback's humble levels and anything urgent |
| `MAX_BODY_BYTES` | server/app.ts | 64 kB | The cap both Jev routes read (moved from index.ts) |

### Contract (all additive)

- `shared/types.ts`: `SignalType` `"prep_offer"` and `"prep_start"`;
  `Suggestion.meetingNotes`; `PrepMeetingWords`, `PrepRecord`,
  `PrepRequest`, `PrepJudgments`, `PrepResponse`.
- `shared/scenarios.ts`: `PrepCase`, `PREP_CASES`.
- `src/engine/contract.ts`: `FocusAidSettings.meetingPrep`;
  `EngineSettings.prepLeadMin` (optional); `LinkSet.prep`;
  `WorkingGoal.client` (optional); `PrepRanking`, `MeetingPrepState`;
  `EngineState.prep`; `EngineActions.prepareMeeting`, `.snoozePrep`,
  `.dismissPrep`, `.simulateMeeting`; `FlowMetrics.prep`.
- `src/engine/contexts.ts`: `backToList` takes an optional third argument,
  the working client.
- `src/engine/focusAids.ts`: `meetingPrepOn`.
- `src/engine/api.ts`: `postPrep`.
- `src/engine/metrics.ts`: `metricsOnPrepOpened`; the `meeting-prep` and
  `prep-opened` lines.
- `src/engine/relations.ts`: `LINK_SET_MAX`.
- `src/ui/UpNext.tsx`: `revealPanel` is exported.
- `server/questions.ts`: `PREP_QUESTION_IDS`, `MAX_PREP_RECORDS`,
  `prepRecordsOf`, `buildPrepState`, `buildPrepQuestions`;
  `SCORE_LEVELS.prep`.
- `server/normalize.ts`: `normalizePrepJudgments`. `server/heuristic.ts`:
  `heuristicPrepJudgments`. `server/validate.ts`: `parsePrepRequest`,
  `ParsedPrep`. `server/adapt.ts`: `prep`. `server/guard.ts`:
  `PREP_RATE_MAX`, `PREP_RATE_WINDOW_MS` (now in `server/app.ts`; the guard
  itself moved to `packages/server`).
- New: `src/engine/meetingPrep.ts`, `src/ui/MeetingPrep.tsx`,
  `server/app.ts` (the routes, moved out of `server/index.ts`, which now
  only serves them).

### Checks

Unit tests: `src/engine/meetingPrep.test.ts` (the upcoming rule with the
lead time, the started window, focus time and meetings without a client
skipped, prepared and dismissed skipped, any clock; the records, their
words, the caps, and the signature; the order, tints, and reasons with and
without a ranking; the thing to handle first; the view changes; the plan;
the notes heading; the simulated meeting), `src/engine/meeting-prep.test.ts`
(the store: the offer at the lead time, the prefetch, the offer logged once
and kept out of the snapshot, the lead setting, Not now, the meeting
underway; Prepare saving a Back to context, Calendar anchored and still,
the filters, the links in Jev's order with their tags and tints, the most
useful panel gathered beside Calendar, nothing performed, the notes
untouched, no adapt round; a docked Calendar and a ranking that lands
later; Start meeting notes only when pressed; a dismissed notes offer;
Back to; opening records inside the prep view; closing the card; the
simulated meeting and Reset; the switch off, and every adapt request the
same with it off), and the server tests (`validate`, `questions`,
`normalize`, `heuristic`, `adapt` for `prep()`, and `app.test.ts` for the
route behind the guard, the validation, and its own rate limit). Each new
test fails on the code before this change, and twenty mutations of the
behaviors they cover were each caught.

`pnpm eval` has a prep section (`--prep-only` runs it alone), counted apart
from the session and command checks. The adapt requests are byte-identical
to before (every eval request built at a fixed time, state and questions,
compared with the code from before this change). The run with `--repeat
2` (September 30, jev-1.13.0): 4 of 4 prep cases and 24 of 24 prep checks
in every run, the same order and urgent verdict in both runs except the
Harbor near tie between INV-1042 and the project (both 0.99 to 1.00):

| Case | Scores, run 1 / run 2 | Anything urgent |
| --- | --- | --- |
| Harbor rebrand review | INV-1042 1.00 / 0.99, project 1.00 / 1.00, Priya's message 0.89 / 0.91, the resend to-do 0.83 / 0.81, Riley's printer quote (another client) 0.00 / 0.00 | 0.92 / 0.92 |
| Solace onboarding critique | project 0.99 / 0.99, Ava's message 0.98 / 0.99, the welcome screen task 0.92 / 0.92, the sent bill 0.86 / 0.85 | 0.20 / 0.21 |
| Juniper spring brief call | Luis's brief 0.97 / 0.96, the sent bill 0.53 / 0.54 | 0.15 / 0.14 |
| Call with Meridian (held out) | Hannah's unread question 0.99 / 0.99, INV-1038 0.81 / 0.84, project 0.79 / 0.76, revise sizes 0.65 / 0.68, book printer 0.55 / 0.56 | 0.81 / 0.80 |

A prep request is about 2,500 input tokens (about $0.0001) and 150 ms.

In the browser at 1440x900 (September 30, in the afternoon, so the demo's
meetings were past): after opening Priya's message, "Test: simulate a
meeting in 10 minutes" added "Harbor rebrand check-in"; the chip read
"Harbor rebrand check-in in 10 min" with "1 thing to handle first: INV-1042
is 14 days overdue" (Jev's ranking), and a minute later "in 9 min"; `p`
arranged the prep view with Calendar at the same cell, the meeting selected
and the lines drawn from it, and the panels in Jev's order (Invoices beside
Calendar, Projects below it, Inbox on its other side, then Tasks and
Clients), each tagged "For the meeting", Invoices, Inbox, and Tasks
filtered to Harbor, and a "Back to" chip; "Start meeting notes" wrote
"Harbor rebrand check-in, 16:30, notes:" and put the cursor after it in
Notes; opening Priya's message kept the prep view and counted one record
opened; `b` went back; Not now hid a second simulated meeting; the Metrics
tab said "Meetings prepared 1 of 2"; switched off, the card and the notes
offer went, a new simulated meeting showed no chip, and `p` did nothing. At
390x844 the chip fit the row (the countdown, the count, Prepare, an x) with
no sideways scroll, and Prepare left Calendar where it was with Projects
above it and Invoices below. Dark mode read well. No console errors.

### Known limits

- **The demo's meetings are at fixed times.** Outside those minutes, use the
  simulated meeting.
- **A sent bill for the meeting's own project** scores as "should be
  reviewed" (0.85 to 0.89 for Solace), just under the work itself: it is
  tinted, and Invoices gathers after the other panels.
- **Near ties at the top.** When the bill, the project, and the client's
  message all score about 0.9 to 1.0, their order can change between runs;
  the panels gather in whichever order Jev gave.
- **One chip at a time.** While the card after Prepare shows, the next
  meeting's chip waits until the card is closed or its meeting is underway.
- **"For the meeting" in a narrow header** truncates ("For the me...") in a
  4-column card; the full text is in its tip and accessible name.
- **Gathering only trades cells.** A linked panel moves into a cell another
  card holds, never into empty space, so beside a Calendar in the last
  column the second panel may land diagonally.
- **The inspector shows adapt rounds only.** The prep request and its
  ranking are in the Metrics tab's Right now row and the store, not in the
  Request or Now tabs.
- **Session memory.** Prepared and dismissed meetings, the rankings, and the
  counts are forgotten on reload.
