# Predictive flow

The goal: keep the user focused on what matters for the work in front of
them, and predict what they will do next, so they never have to think about
navigating. Three features serve it: an "Up next" card, automatic "Back to"
working contexts, and measurement in the inspector.

Three rules hold for all of them:

- **Never act for the user.** Each feature only makes the next step one click
  or one key away. Opening a record selects it; it never sends, marks, or
  replies.
- **Do nothing when Jev is not sure.** Below the gates, the card stays empty
  and no context is saved.
- **Every change says why and can be undone.** The card shows its reason
  ("Jev 72%", "Next in list"), a restore says "Went back to ..." in the change
  feed with Undo, and the context being left is saved, so going back is one
  more click.

Up next and Back to are focus aids the user can switch off in the header's
Focus settings or the inspector's Controls tab (docs/focus-aids.md). Off, the
card or the chips are gone and `n` or `b` does nothing; with Back to off no
context is saved.

## How Jev and code split the work

| Question | Who answers | Where |
| --- | --- | --- |
| Which records might come next? | Code builds at most 12 candidates | `src/engine/nextUp.ts` (`buildRecordCandidates`) |
| Which one will the user work on? | Jev, a Choice over those ids plus "none" (`nextRecord`) | `server/questions.ts` |
| Is the user working through a list? | Code (`detectListWork`) and Jev, a Noul (`listWork`) | `nextUp.ts`, `server/questions.ts` |
| What does the card show? | Code (`chooseUpNext`) | `nextUp.ts` |
| Did the work really change? | Jev's goal, confirmed by code's two-round rule | `src/engine/contexts.ts` (`judgeSwitch`) |
| What comes back on "Back to"? | Code | `contexts.ts` (`restoredPlan`), `src/engine/store.ts` |
| How well did it predict? | Code counters | `src/engine/metrics.ts` |

Every adapt request carries `candidates.records`. Each candidate has an id
(`invoice:INV-1038`), its panel, a label in the same words as the panels'
own open signals ("INV-1038 · Meridian Hotels · overdue 36 days · $12,800"),
and a reason in words. In a fixed order: the next records after the current
one in its panel's filtered and sorted list (while the user repeats one
action, only the ones it still applies to; see Up next), records linked to the anchor
(the link cues on screen, else the live anchor's joins), unread client
messages, tasks due today or late, the next event today, and overdue
invoices without a reminder today. The current record and records already
handled this session (a reminder sent, a reply drafted, a task checked off,
marked paid, a project updated) are left out. With "Learn my habits" on,
records in the panel the user usually goes to next move up three places in
this order, never ahead of the next records in the list, and rank a little
higher among the card's chips; Jev still picks, behind the same gate
(docs/focus-aids.md, "Aid 3").

## Up next

A card in the row under the command bar: "Up next: Meridian Hotels ·
INV-1038 · 36 days overdue", a reason, an Open button, and up to two
alternative chips. The row keeps one line's height whatever it shows, so the
card never moves a panel. When the row is short of room (README, "The row
under the command bar"), the card becomes a pill ("INV-1042 to resend it",
`n`, and an x) and then waits in the row's "+N" list, in full; `n` works
either way.

- **The pick.** Right after a click that links panels, the next step Jev
  read from the clicked record, when Jev is sure ("INV-1042 to resend it",
  "Arrange linked panels by next step", docs/anchored-relayout.md "Next
  step"); then Jev's `nextRecord` when Jev is sure enough (see the gate
  below); otherwise, in queue mode, code's next record in the current list
  ("Next in list"); otherwise nothing. Handled, dismissed, and current
  records never show. While the user repeats an action through a list and
  has just acted, the list walk comes before the step.
- **Queue mode** is on when code sees list work (the same action on two
  records of one kind in the last three minutes, or three different records
  of one kind opened in a row) or Jev's `listWork` is 0.6 or more.
- **Only records the action still applies to.** When list work comes from
  the same action, `detectListWork` remembers it (`ListWork.action`: the
  action id, or "Checked off task" for checking off tasks). The list walk,
  the "next in the list" candidates, Jev's pick, and the chips then offer
  only records it still applies to (`actionApplies` in `nextUp.ts`):
  reminders go to overdue invoices with no reminder sent this session,
  "Mark paid" to sent or overdue invoices, replies to unread messages,
  status updates to projects at risk or blocked, and checking off to tasks
  not done. Other actions keep the plain list walk. So with the Invoices
  filter on All, reminders stop at the last overdue invoice instead of
  moving on to sent and draft ones. Jev's gate is unchanged; a sure pick
  the action does not apply to is skipped.
- **Done.** When none of those records is left anywhere in the data, the
  card shows a short line instead of a pick ("All overdue invoices have a
  reminder."), with a dismiss button. It goes away on the next unrelated
  step (opening a record, a filter, a search, a command, or another
  action) and never acts; `n` does nothing while it shows. With the focus
  aid "Say when a task is done" on, once the whole working goal is done a
  Done card takes this slot instead and offers the next task
  (docs/focus-aids.md, "Aid 2").
- **Act, then n.** In queue mode, right after an action on a record, code's
  next record shows at once; the next Jev round refines it.
- **Open** (or `n`, when focus is not in a text field, the command bar, a
  popover, or the inspector) opens the panel from the dock if needed,
  selects the record through the view state as a click does (so the calm
  relayout, anchor, and links apply), and logs `up_next_open`, which Jev
  reads as "Opened invoice INV-1038 ... in Invoices from Up next".
- **Dismiss** hides that record for two minutes.

The gate comes from the September 30 eval: correct picks often sit just
under 0.5 (0.44 to 0.46) with a clear lead, while sessions with no clear
next record either tie (0.34 to 0.39, leading by 0.01 to 0.05) or give
"none" a real share (0.48 with "none" at 0.23). So a pick shows at 0.5 or
more, or at 0.4 or more when it leads the next record by 0.15 and "none" is
under 0.2.

## Back to

- **Saved** when the work really changes: Jev judges another goal with
  confidence 0.7 or more for two rounds in a row (the context is captured on
  the first of the two, before that round's layout lands), or a command
  sends the user to a panel outside the current goal's own panels. A context
  holds the goal, a label ("Collecting payments · Harbor Coffee Co.", the
  client being the newest one named in the goal's own panels), the plan
  (placements, sizes, cells, mode), the panels made bigger, the view state
  (filters and selections, including Tasks and Calendar), the link cues, and
  the time. The three most recent are kept, one per goal and client. The
  engine logs `context_save`, which is not user activity and never reaches
  Jev.
- **Shown** in the canvas caption for other goals than the current one: the
  most recent as a chip ("Back to: Collecting payments · Harbor Coffee Co."),
  which `b` also restores, and the older ones behind "+N" beside it, a small
  list (Escape or a press outside closes it and puts focus back on "+N"). On
  a phone only the most recent shows, as an icon.
- **Restored** at once, as a manual edit: placements, cells, bigger panels,
  filters, selections, and links come back; pins stay as they are. The
  context being left is saved first, so the user can go back and forth. The
  restored layout holds against Jev rounds until the user does new work
  (opens a record, filters, searches, acts, or uses the command bar), and
  answers to requests sent before the restore never count toward a switch.
  Logged as `context_restore`. Session memory only; Reset clears it.
- **Undone** in full: an Undo right after a restore (while its layout is
  still on screen) puts back everything the restore replaced, the same data
  a context holds (layout and cells, bigger panels, filters, selections, and
  link cues) plus the working goal and the chips, so the context just
  restored is offered again. It is a plain undo: it does not count as
  another Back to or save a new context.

## Metrics

The inspector's Metrics tab, per session: next-record hits at 1 and at 3
against the user's next open (from each round's top three, or code's pick
when Jev gave none), the same for the next action, navigation per 10 actions
(dock opens, searches, list scrolls, command bar uses, Back to uses), Up
next picks taken by click or key out of those shown, undos per layout
change, and layout changes per minute. A list scroll counts only after a
wheel, touch drag, scrolling key, or a press on the scrollbar in that card,
because a card that moves or resizes resets its list's scroll, and that is
not the user navigating (Jev no longer reads those scrolls either).

## Constants

| Constant | Value | Why |
| --- | --- | --- |
| `RECORD_CANDIDATES_MAX` | 12 | The contract's cap; the list and the day's loose ends fit |
| `LIST_NEXT_MAX` | 3 | The next few are what "next" means |
| `LINKED_CANDIDATES_MAX` | 3 | Matches the three link lines |
| `UNREAD_CANDIDATES_MAX`, `TASK_CANDIDATES_MAX`, `OVERDUE_CANDIDATES_MAX` | 3, 2, 3 | One source must not crowd out the rest |
| `LIST_WORK_WINDOW_MS` | 3 minutes | A few records at reading pace |
| `LIST_WORK_SAME_ACTION_MIN` | 2 | Once is a task, twice is a pattern |
| `LIST_WORK_OPEN_RUN_MIN` | 3 | Two is comparing, three is going down the list |
| `QUEUE_LISTWORK_AT` | 0.6 | A clear lean on a Noul |
| `UP_NEXT_JEV_MIN_P` | 0.5 | Shows on its own |
| `UP_NEXT_JEV_LEAN_P`, `UP_NEXT_JEV_MARGIN`, `UP_NEXT_JEV_NONE_MAX` | 0.4, 0.15, 0.2 | See the gate above |
| `UP_NEXT_ALTERNATIVES_MAX`, `UP_NEXT_ALT_MIN_P` | 2, 0.1 | A chip is never a long shot |
| `UP_NEXT_DISMISS_MS` | 2 minutes | As long as a dismissed suggestion |
| `CONTEXT_SWITCH_CONFIDENCE`, `CONTEXT_SWITCH_ROUNDS` | 0.7, 2 | One stray click never files the work away |
| `CONTEXTS_MAX` | 3 | Fits the caption |
| `CONTEXT_AREA_AFFINITY` | 0.5 | A goal's own panels, in `GOAL_PANEL_AFFINITY` |
| `PREDICTION_TOP_N` | 3 | One pick and two chips |
| `METRICS_MIN_MINUTES` | 1 | The first seconds are not a storm |
| `USER_SCROLL_INPUT_MS` (PanelFrame) | 1 second | A hand scroll's events follow its input |
