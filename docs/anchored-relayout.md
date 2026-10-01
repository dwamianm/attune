# Anchored relayout

The problem: after a click, the panel the user was working in could jump to
the front of the stack, and new panels appeared with no hint of why. The fix:
the panel the user just worked in stays still, the change plays in stages
around it, and one shared "link" color shows how the new panels relate to the
record that was clicked.

## The design

1. **Anchor stays still.** A real click or keystroke in a panel (item_open,
   filter, action, search typing, pointer focus), or opening a panel from
   the dock, makes it the anchor. In the relayout that follows, its top-left
   does not move on screen. It may grow, only into free or vacated space to
   the right or below; if it cannot, it keeps its size. It is never docked or
   shrunk while anchored. New panels go after, beside, or below it. Cards
   before it may still move in two cases: the backfill closes a hole a later
   card fits (see "No orphaned holes"), and in a round that links panels the
   linked panels gather next to it (see "Next step"). That is safe because
   every card has an explicit cell (on one column the rows are explicit
   too), so a card that moves before the anchor cannot push it. (An explicit
   pin or "Make bigger" is the exception: it goes to the front; see "Pin and
   Make bigger go to the front". With "Keep in place" a panel made bigger
   follows its own rule instead; see Make bigger.)
2. **Staged changes.** The anchor grows, leaving panels fly into their dock
   icon, moving panels glide, then new panels enter one at a time from the
   anchor's direction. Reduced motion: no movement, a short crossfade, the
   highlights only.
3. **Shared link color.** The clicked record in the anchor and the linked
   records in other panels get the same tint, scrolled into view inside their
   panel (never the page).
4. **Link lines.** A thin line runs from the clicked row through the gaps
   between cards to the tag of each linked panel (at most 3). It draws in,
   stays at full strength for about 2 s, then rests faintly until the user
   clears the links. A line that would cross a card is hidden (with a tag
   pulse when its round settles) until a clean route is back.
5. **Labels say why.** A header tag ("Linked to INV-1042") with the reason on
   hover or focus and an x that removes that link, a links bar in the canvas
   caption ("Links for INV-1042 · 3 panels · Clear all links"), and a short
   note on the anchor ("Added Inbox and Clients for Harbor Coffee Co. ·
   Undo"). The change feed stays as the secondary record.
6. **Calm timing.** A panel under the pointer, or under a press, waits to move
   (3 s cap) or leave (5 s cap). The anchor is released by work in another
   panel or 20 s without work. The links are not: they stay until the user
   clears them (see Links).
7. **Commands** still make their panel the hero at the front, with the same
   choreography and highlights when the command names a record or client.
   An explicit pin or "Make bigger" goes to the front too (see "Pin and Make
   bigger go to the front"); ordinary clicks never do.
8. **Jev still decides** which panels are useful. Code joins the data to find
   linked records, and a small named boost helps linked panels. The
   relayout itself asks no question; "Arrange linked panels by next step"
   adds two, only on the first request after a click on a record (see
   "Next step"), and `pnpm eval` must still pass as is.
9. **No orphaned holes** after any round (see "No orphaned holes").
10. **Next step.** With "Arrange linked panels by next step" on (the
    default), the linked panels gather next to the clicked panel, the next
    step first, and Attune offers that step (see "Next step").

## Who owns what

| Module | Owner | Does |
| --- | --- | --- |
| `shared/types.ts` | contract | `AnchorRef`, `RelatedRecord`, `PanelRelation`, `GridCell`, `GridColumns`, `PlanGrid`, `ChangeSummary`; optional `LayoutPlan.anchor`, `.changeSummary`, `.round`, `.grid`; `PanelPlacement.anchor`, `.relation`; `SignalType` `"links_dismiss"`, `SignalDetail.linkedPanel` |
| `src/engine/contract.ts` | contract | `EngineState.anchor`, `.pointer`, `.columns`, `.links`; `LinkSet`, `LinkLinesMode`, `EngineSettings.linkLines`; `setPointer`, `setColumns`, `clearLinks`, `removeLink`; `PolicyInput.anchor`, `.linked`, `.hold`, `.linkHold`; `PackItem`, `PackInput`, `PackResult` |
| `shared/types.ts`, `src/engine/contract.ts` | contract (Make bigger) | `SignalType` `"panel_maximize"`, `"panel_restore"`; `PanelPlacement.bigger`; `EngineState.bigger`; `maximize`, `restore`; `PolicyInput.bigger`; `PackInput.userResized` |
| `src/engine/contract.ts`, `src/engine/focusAids.ts` | contract (move to the front) | `FocusAidSettings.moveToFront`; `EngineState.front`, `.toFront`; `PolicyInput.front`; `moveToFrontOn`, `frontGroup` (docs/focus-aids.md) |
| `src/engine/grid.ts` | engine | `packGrid`, `lockedPanels`, `summarizeChanges` (stubs today); `CELL_SPANS`, `GRID_BREAKPOINTS`, `spanOf`, `columnsForWidth`, `cellsOverlap`, `cellFits` (done) |
| `src/engine/relations.ts` | engine | `findLinked`, `anchorLabel`, `relationFor` (stubs today); `linkWhy` (how a linked record relates, for the next step) |
| `src/engine/linkFlow.ts` (new) | engine | the next step: the clicked record in words, the link candidates, the Next gate, the order of the linked panels, the step, and the follow-up |
| `src/engine/policy.ts` | engine | anchored-round rules, link boost, relations on placements |
| `src/engine/store.ts` | engine | anchor lifecycle, link set lifecycle, pointer holds, the place step (pack, round, summary) |
| `src/ui/domHooks.ts` | UI | attribute names and selectors (done) |
| `src/ui/choreography.ts` (new) | UI | stage timing constants |
| `Canvas`, `PanelFrame`, `LinkLines`, `LinksBar`, `Dock`, panels, `index.css` | UI | explicit cells, stages, tint, tags, note, lines, links bar, reporting pointer and columns |

The UI reads only plan and state fields and never calls the packer or the
relations functions. Until the engine side lands, `plan.grid` is absent and
the canvas keeps today's CSS flow, so both sides can work at once.

## Anchor lifecycle (store.ts)

- **Set** on `item_open`, `filter`, `action`, `search`, `panel_open`, and
  `panel_focus` with `via: "pointer"`, unless `via` is `"suggestion"` or
  `"command"`. Keyboard Tab focus, dwell, scroll, shortcuts, pin, dock, and
  undo never anchor.
- **Panel**: for a `filter` or an `action`, the card the pointer pressed
  within `ANCHOR_PRESS_WINDOW_MS` before the event, else the event's panel. So
  "Invoices" in Clients (it logs a filter on Invoices) anchors Clients, and
  Invoices becomes a linked panel. A focus, an opened row, or a search always
  anchors its own panel, so an older press elsewhere cannot take it. Opening a
  panel from the dock (`panel_open`) anchors the opened card with no record:
  it lands in the first free spot, and the Jev round the open asked for then
  keeps it and everything before it in place instead of sending it to the
  front. Asking for a panel that is already on the canvas logs a focus and
  does not anchor.
- **Record**: `itemKind` (or the kind read from the id prefix, for actions),
  `itemId`, `client` from the event; a search whose words name one client by
  the first word of its name ("harbor invoice") anchors on that client
  (`clientNamedIn`). `label` from `anchorLabel`. More work in the same panel
  with no new record or client keeps the anchor (same `at`) and only resets
  the idle timer.
- **Release**: work in another panel replaces it. It clears after
  `ANCHOR_IDLE_RELEASE_MS` with no anchoring event, and on docking the anchor
  panel, undo, reset, Adaptive off, or Freeze on. Release does not re-plan by
  itself; the next round without an anchor settles (see Place step). Release
  does not clear the links either (see Links), unless `settings.linkLines`
  is `"fade"`.
- **Commands**: an applied command sets `{ panel: promoted, source: "command",
  client, itemId (an invoice id named in the text), label, at }`.
- **Anchored round**: a work anchor that was on the canvas in the previous plan,
  whose `grid.columns` equals the current count.

## Links (store.ts)

The link cues (tints, tags, lines, links bar) read `EngineState.links`, a
`LinkSet`: the `source` anchor (its panel holds the clicked row), one
relation per linked panel, and the plan `round` that made it. The UI never
reads `placement.relation` for the cues; the policy still sets relations
each anchored round, and `syncLinks` turns them into the link set after
every plan or anchor change.

- **Made or replaced** by a plan built for the live anchor
  (`plan.anchor.at === anchor.at`) whose placements carry relations: a new
  click (a new `at`) replaces the set, and later rounds for the same click
  refresh it. What the user dismissed from that click (`linkDrops`) is left
  out, so a later round for the same click does not bring it back.
- **Kept** by a round that links nothing (a click, filter, or search with no
  linked records), by the anchor's release, and by Freeze. Relations for
  panels that left the canvas drop out; the set goes when its source panel
  leaves or no link is left.
- **Cleared** by `clearLinks` (the links bar, or Escape when focus is not in
  a text field, an open popover, the command bar, or the inspector), by
  docking the source panel, by an undo of the round that made it (the undone
  plan was built for its click, or the undo goes back past its round), by
  reset, and by switching Adaptive. `removeLink(panel)` (a tag's x) and
  docking a linked panel remove one link.
- **Held.** While a set shows, `PolicyInput.linkHold` (its source and linked
  panels) keeps them on the canvas at `LINKED_MIN_SIZE` or more, in
  `computePlan` and in `applyPromotion` past a command's cap. They may move
  once the anchor is released, and the lines follow.
- **Logged.** `clearLinks` and `removeLink` log a `links_dismiss` signal
  ("Cleared the links for INV-1047", with ", using the keyboard" for Escape;
  "Removed the link to Inbox"). It is not a trigger, re-plans nothing, adds
  no recent use, and `buildSnapshot` leaves it out (`CUE_ONLY_TYPES`), so it
  cannot change a Jev request or its answers.
- **"fade" mode** (`settings.linkLines`, persisted with the other settings):
  the older behavior. The set is the live anchor's round's relations and goes
  with the anchor, `linkHold` is not passed, and lines fade after about 2 s.
  The links bar, the tag x, and Escape still work while the set shows.

## Policy rules in an anchored round (policy.ts)

1. The anchor stays on the canvas at no less than its previous size; it may
   ask for the size its slot would have in the order it would get without an
   anchor (so a top panel asks for hero), and the packer decides.
2. `lockedPanels(previous order, previous.grid.cells, anchor)` keep membership,
   order, and size. Locked means before the anchor in order, or starting
   before its top-left in reading order (a row above it, or its top row to its
   left). A quiet locked card may still take the summary size: the packer
   shrinks it in place (its top-left stays), which cannot move the anchor.
3. Order: pins (or, with `PolicyInput.front`, the whole front group in its
   order), locked panels before the anchor, the anchor, the other locked
   panels, then the rest by `orderWithHysteresis`, a forced Guide first among
   them. Pins keep their size and the packer keeps their cells, so listing
   them first changes nothing on screen until an unanchored round.
4. Rank the panels in `input.linked` that may join (not dismissed, not held in
   the dock) by priority; the top `LINKED_PANELS_MAX` get `LINK_PRIORITY_BOOST`
   before selection. After selection, up to `LINKED_PANELS_MAX` panels on the
   canvas that hold linked records get `relation = relationFor(...)`: panels
   this round added first, then by priority. They are at least
   `LINKED_MIN_SIZE` unless locked. A panel that joined for the link says so in
   its reason ("Linked to INV-1042: 1 message from Harbor Coffee Co.").
5. Set `plan.anchor`, and `anchor: true` on the anchor's placement. Command
   rounds keep `applyPromotion` and get steps 4 and 5 without locking; there,
   linked panels come right after the hero and pins. `applyPromotion` never
   drops a work anchor past its cap (a command hold re-applied after new work).
6. `input.hold` (the pointer's card that would leave) is required this round.
7. With a work anchor, every panel already on the canvas that holds shown
   linked records (`input.linked`) is required this round, tagged or not, so
   a fourth linked panel is not docked while three others say "Linked to".
8. In any round, anchored or not, the panels in `input.linkHold` that were on
   the canvas and are not dismissed are required and at least
   `LINKED_MIN_SIZE` (unless locked), so links on screen keep their panels.

## Place step (store.ts)

Every plan the store sets while Adaptive is on goes through one place step:
build `PackItem`s (`anchor` only for the live work anchor, `linked` for
placements with a relation), call `packGrid` with the current plan's cells
when its columns match (else `null`) and `unanchored: "settle"`, or
`"reflow"` for a command's round and a pin sent to the front, put the previous size back on
`keptSize` and held panels, re-mark the badges and change-feed lines from the
cells (`remarkPanels`: a card that kept its cell did not move, whatever its
order), then set `grid`, `changeSummary = summarizeChanges(current, next)`,
and `round` (+1 when membership, a size, a cell, a relation, or `anchor.at`
changed, including an otherwise quiet plan; rounds keep counting up after a
reset). `planSignature` includes cells, so a move is never applied as quiet.

- A plan without cells (the first plan, a reset, Adaptive just turned on)
  counts as showing the dense flow, which is exactly what the CSS draws, so
  the first click after load or reset is anchored too. The policy gets the
  same cells as `previous.grid`.
- Manual edits change only the edited card: every other card keeps its cell
  (a docked card leaves a hole), except that a pin without the pointer on the
  canvas reflows so the pin moves to the front, where the user asked for it,
  and a panel made bigger or smaller moves the cards in its way (see Make
  bigger). With "Move pinned and bigger panels to the front" on, a pin or
  "Make bigger" reflows with the front group first, even with the pointer on
  the canvas (`PlaceOptions.toFront`, which also sets `EngineState.toFront`
  in the same update).
- Undo releases the anchor, drops relations, and restores the target plan's
  grid as is when the columns match.
- `setColumns` re-packs by reflow with an empty summary and clears the badges,
  so a resize plays no stages (the round goes up when cells changed).
- With Adaptive off, plans keep the CSS flow (no grid) as before.

**Pointer holds.** When a round would move `pointer.panel` (never the anchor),
pass it in `PackInput.hold`; if it would leave, pass it in `PolicyInput.hold`.
When the pointer leaves it, or `POINTER_MOVE_HOLD_MS` or
`POINTER_LEAVE_HOLD_MS` after the first deferred round, re-plan locally (a new
round). Commands, undo, reset, and the Adaptive and Freeze switches ignore
holds. A manual pin or dock under the pointer holds every remaining panel, so
nothing slides and the docked card leaves a hole (the ghost goes there). A pin
or "Make bigger" with "Move pinned and bigger panels to the front" on is the
exception: the user just asked for the move, so it applies at once; only the
policy's catch-up still waits for the pointer.

## Grid packer (grid.ts)

`packGrid` is pure and deterministic. Spans come from `CELL_SPANS`. A
previous cell is usable when it exists and fits the columns. "Free" means not
taken by a cell placed earlier in the same call. Searches scan rows top to
bottom, then columns left to right; rows are unbounded, so every search ends.

Anchored round (the anchor item has a usable previous cell). In steps 1 to
8, nothing that was not already there may start before the anchor in
reading order (the two final passes below may move cards there):

1. **Fixed.** Held, locked (before the anchor in plan order, or starting
   before its top-left), and pinned panels keep their previous cells. A
   locked card that is not held or pinned and asks for a smaller span (a
   quiet panel) shrinks in place: same top-left, the new span.
2. **Anchor.** Keeps its previous top-left. It takes its requested span only if
   that span covers the previous one, fits the columns, and overlaps no fixed
   cell and no stayer (neither its previous cell nor its cell at its new
   span), so it grows only into free or vacated cells; otherwise it keeps its
   previous span (listed in `keptSize`). It never shrinks.
3. **Stayers.** Other panels with a usable previous cell, in previous (row, col)
   order, keep their top-left with their new span (shifted left if it would
   pass the last column) when that is free.
4. **Linked newcomers**, highest priority first, take a cell a card leaving
   this round vacated (after the anchor), the one nearest the anchor, else
   the free spot nearest the anchor: smallest gap between the rectangles (a
   column counts as `COLUMN_TRACK_WEIGHT` rows, so distance compares as it
   looks on screen), then right, below, left, diagonal, then lower row, then
   lower column.
5. **Displaced stayers** (a neighbor grew over them) flow forward to the first
   free spot from their previous row, the way the dense flow would place
   them, so growth leaves no staircase of holes.
6. **Other newcomers**, in plan order, take the first vacated cell after the
   anchor, else the first free spot after it.
7. **Float up.** Stayers, top first, slide up in their column into holes,
   stopping at the first card above them (gravity, never a jump), and never
   to a spot before the anchor.
8. **Slide left.** Then stayers slide left in their row into holes that are
   still open, the same way, never to a spot before the anchor.

On one column the canvas is a list: linked newcomers go right under the
anchor, then the other cards follow in their old order, so a linked card is
not left at the far end of a phone page. The anchor may grow there, pushing
the cards after it down; the choreography moves them with the growth.

Every call, in every kind of round, then ends with these passes
(`finish()` in grid.ts):

9. **Backfill** (see "No orphaned holes"): while an empty spot has a card
   later in reading order that fits it, the next such card moves there,
   unless it stays put. In a gathering round a spot next to the anchor
   takes a linked panel first.
10. **Gathering** (only with `PackInput.gather`, see "Next step"): each
    linked panel, in next-step order, trades cells with the block of cards
    nearest the anchor that has exactly its shape, then a second backfill
    runs that leaves the gathered panels where they are.

User-resized round (`PackInput.userResized`, a panel the user just made
bigger or smaller, with a usable previous cell). It replaces the anchor rules
for that call; see Make bigger.

Unanchored round: held panels keep their cells. With `"settle"` (automatic
rounds), when the stayers keep their reading order, each keeps its top-left
at its new span, newcomers take vacated cells and then the first free spot,
and stayers float up and slide left into what is left; when the order
changed, it falls back to reflow. With `"reflow"` (commands, a pin sent to
the front, a resize), everything in plan order takes the first free spot
from row 0 (the CSS `row dense` rule). The backfill runs after both.

Tests check at 1, 2, and 4 columns: `cellFits` for every cell, no
`cellsOverlap`, the anchor's (col, row) unchanged, held and pinned cells
unchanged, and no fillable hole (random sessions, with and without
gathering).

## No orphaned holes

The report: "Sometimes the reflow leaves orphaned gaps in the UI." After
working in Calendar, the user opened Marcus Webb's "Annual report numbers"
in Inbox (4 columns). The older packer left Calendar a hero at the top
left, Invoices alone at (3, 0), Projects at (2, 2), Inbox (the anchor) at
(0, 4), Tasks at (1, 4), and Clients at (0, 6): holes at (2, 0), (3, 2),
(2..3, 4), and (1..3, 6) that later cards would fit, kept round after round,
because nothing new or moved could start before the anchor.

The rule now, after every round (anchored, link, command, front, manual
edit, resize): no empty spot that a card later in reading order would fit
into, unless filling it would move a card that stays put. Those are the
anchor, held cards (the pointer's, or every card after a manual edit under
the pointer, until the catch-up round), pinned and bigger panels (the front
group), and a panel the user just resized; in a gathering round, also the
gathered linked panels.

- **How.** The backfill scans spots in reading order. For the first empty
  spot that some later card fits, the next such card (in reading order)
  moves there; then it starts again. A spot next to the anchor takes a
  linked panel first in a gathering round. Every move goes earlier in
  reading order, so it ends. It prefers the next card over the last one, so
  the cards after a hole slide up one place each, as the dense flow would.
- **What may stay.** Free space after the last card in reading order, and a
  half-row gap that no remaining card fits (under a compact tile).
- **The reported layout** (a regression test in grid.test.ts). Before and
  after, in row tracks (`.` is empty, `*` the anchor):

  ```
  Before (older packer)          After, aid off                 After, gathering
  0 calen calen   .   invoi      0 calen calen invoi proje      0 calen calen clien proje
  1 calen calen   .   invoi      1 calen calen invoi proje      1 calen calen clien proje
  2 calen calen proje   .        2 calen calen tasks clien      2 calen calen tasks invoi
  3 calen calen proje   .        3 calen calen tasks clien      3 calen calen tasks invoi
  4 inbox* tasks  .     .        4 inbox*  .     .     .        4 inbox*  .     .     .
  5 inbox* tasks  .     .        5 inbox*  .     .     .        5 inbox*  .     .     .
  6 clien   .     .     .
  7 clien   .     .     .
  ```

  With the anchor held at (0, 4), a hero, and five standard cards, the only
  layout with no fillable hole puts the four other cards beside the hero,
  so the linked Tasks and Clients take the free slots nearest the anchor
  in that closed-up layout instead of the cells right beside it.

## Relations (relations.ts)

The anchor's subject is its record plus that record's client and project: an
invoice (client, project, id), a message (client), a client, a project
(client, name), a task (client, project), an event (client), or a person (the
projects they lead or work on, from `TEAM`). With no record, the client alone.

| Panel | Linked records | Most useful first |
| --- | --- | --- |
| Inbox | messages from the subject client | naming the invoice id or project, then unread, then newest |
| Invoices | the client's or the project's invoices | overdue, sent, draft, paid, then by due date |
| Clients | the client row (`c-...`) | |
| Projects | the named project, else the client's open projects | |
| Tasks | tasks for the project or client | open, naming the invoice id |
| Calendar | the client's events | soonest upcoming |
| Team | people on the subject's project | |

Only records a panel shows now count: the store passes the panels' view
(`findLinked(anchor, data, { view, now })`), so an Inbox search, an invoice
status or client filter, a project status filter, a client search, hidden
done tasks, and the Calendar's Today or This week range all drop the records
they hide. A panel whose linked records are all hidden gets no tag and no
boost, so every tag has a tinted row under it.

Revenue, Notes, and the Guide never link (Revenue shows client rows only at
hero size, so its tint could not show). Tag: `Linked to {anchor.label}`,
where the label is the invoice id, the sender of a message, the client,
project, or person name, or for a task or an event its client (event titles
such as "Focus: Vantage report layout" truncate in a tag).
Reason: count, noun, and subject, singular for one: "2 messages from Harbor
Coffee Co.", "1 invoice for Harbor rebrand", "Harbor Coffee Co. is the
client", "2 open tasks for Harbor Coffee Co.", "1 event with Harbor Coffee
Co.", "1 person on Harbor rebrand".

## Choreography (UI)

One choreography per `plan.round`. Roles come from `changeSummary`:

| Stage | Who | Starts | Lasts |
| --- | --- | --- | --- |
| Grow | the anchor, when in `grew` | 0 ms | 250 ms |
| Exit | `docked`, flying to its `[data-dock-id]` icon | 150 ms | 250 ms |
| Move | `moved`, `shrank`, and `grew` other than the anchor | 250 ms (0 ms for cards a growing anchor pushes down on one column, and for every card that moves when the anchor is a panel the user made bigger) | 350 ms |
| Enter | `added`, nearest the anchor first, from its direction | 450 ms, then +70 ms each | 300 ms |
| Lines | new links (at most 3) | when the last entry ends | draw 350 ms, full strength 2 s, then rest at 45 percent opacity (fade out in 300 ms in "fade" mode), or a 700 ms tag pulse |

- **Cells.** When `plan.grid.columns` equals the reported count, each card
  gets inline `grid-column` and `grid-row` from its cell; otherwise today's
  `data-size` spans. DOM order follows (row, col), so Tab order matches the
  screen. The anchor sits above other cards during the round.
- **Canvas top stays put.** While a work anchor is live, nothing above the
  canvas changes height: the row under the command bar (the prep card, Up
  next, and the suggestions) is one line of a fixed height whose cards
  collapse into pills and then into "+N" rather than wrap
  (`src/ui/assistFit.ts`), the canvas caption is one line whose Back to chips
  past the newest wait behind "+N", and a new help hint waits for the
  release. The canvas keeps a min height of the larger of the old and new
  rows until the round ends, so the page never shrinks and clamps the
  scroll. As a safety net, compare the anchor card's
  page offset (offsetTop chain, which ignores transforms) before and after the
  commit, and `window.scrollBy` any difference in the same layout effect.
- **Tint.** Rows spread `itemAttrs(kind, id)`. The UI sets `data-link` to
  `"anchor"` on the clicked row and `"linked"` on each shown `relation.records`
  row: `--color-link-soft` fill with a 2 px `--color-link` bar. Tints and tags
  show while `state.links` holds the panel (the source's row, and each linked
  panel's `relation.records`). The first tinted row per card is scrolled into
  view by setting `scrollTop` on its scrolling ancestor inside the card, never
  `scrollIntoView`, snapped to the top of a row of the same kind so no half
  row is left at the top, and again after a later round moves the card
  (moving it in the DOM resets the list's scroll) unless the user has taken
  the list. When the tint clears (the user cleared the links, an undo, a new
  set), the list glides back to its old `scrollTop`, unless the user scrolled
  it, pressed in it, or moved focus into it since (so the row just clicked
  does not slide away). A tinted row carries
  `aria-description` ("Linked to INV-1042", or "Opened" for the clicked row).
  While a card shows a tint, CSS mutes its other selected row (background,
  bar, and project border), so the link is the only colored row; the
  selection itself stays.
- **Tag and note.** The tag sits after the header title, truncates, and has the
  reason in its accessible name (one period between tag and reason, even
  when the tag ends in "Co.") and in a hover and focus tip. It shows "Linked
  to" whenever the whole tag fits (measured, the x included), else only below
  a 9rem container. While it shows, "Why here?" is an icon button with that
  accessible name. An x after the tag ("Remove link to Inbox") calls
  `removeLink`; focus moves to "Why here?" in the same header. The note is absolutely positioned inside the anchor card
  (it changes no layout) and spans only the clicked row's list, so a hero's
  detail pane keeps its buttons. It takes the first place that keeps the
  clicked row clear: the card's bottom edge, over the top of that list, or
  just below the header (over the search box or filters). It is never over
  the header, so the panel keeps its name and frame controls; if nothing
  clears the row it stays at the bottom edge. Positions come from layout
  offsets, not rects, because the anchor may still be growing. It appears
  only when the round added a linked panel: "Added {titles} for {client or
  label} · Undo", titles joined as "A", "A and B", "A, B, and C". It has no
  status role: the canvas's always-mounted polite live region reads the same
  sentence and "Linked panels: A, B, and C" with that round's decisions
  (`linkAnnouncement`). Undo moves focus to the clicked row (or the card's
  first list row) and calls `undo(before)` with the plan from before the
  round. It hides after `ANCHOR_NOTE_MS` or the next pointerdown outside it;
  it stays short on purpose, since a lasting note would cover the anchor's
  buttons. Undo also clears the links that round made.
- **Links bar.** `LinksBar` in the canvas caption, after the change feed:
  "Links for {label} · {n} panels · Clear all links" ("{n} links" and an x
  on a phone), shown while `state.links` is set. The button (accessible name
  "Clear all links") calls `clearLinks`, and so does Escape unless the key
  belongs to something else first: `defaultPrevented`, the open inspector,
  focus in a text field or the command bar (`[data-command-bar]`), or an
  open popover (`[role="dialog"]` or `[aria-expanded="true"]`). A polite live
  region reads the dismissal's sentence.
- **Lines.** An aria-hidden svg overlay in the canvas with pointer-events none.
  Each line leaves the clicked row's side (a side the row nearly touches, so
  not across a hero's detail pane) into the gutter beside the anchor card,
  runs along it to the gutter just above the target card, across to the
  tag, and down into the tag's top edge, with rounded corners. Lines leaving
  together sit `LINE_SPREAD_PX` apart. The side facing the target is tried
  first, then the other; a route is used only if no point of it is inside
  another card (or inside the anchor after its first segment, or the target
  before its last), off screen, or under the sticky app bar. A target no
  route reaches when its round settles gets `data-link-pulse` on its tag for
  `LINK_TAG_PULSE_MS` (an outline beat), and so does every target when the
  anchor has no row (a search, a filter, or a command without a record).
  With reduced motion, no lines and no pulses; tags and tints stay.
  Each line has a phase: it draws in (`LINK_LINE_DRAW_MS`), stays at full
  strength for `LINK_LINE_SHOW_MS`, then rests at `LINK_LINE_REST_OPACITY`
  (in "fade" mode it fades out in `LINK_LINE_FADE_MS` instead and does not
  come back). Hovering or focusing a tag or its x brings that line back to
  full strength, and hovering the clicked row brings every line back.
  Resting lines are measured again, at most once a frame (one pending
  `requestAnimationFrame`), on window scroll and resize, a `ResizeObserver`
  on the canvas, a capture-phase scroll listener on the canvas (panel
  lists), any new event, data, or view change, and every frame for
  `LINK_FOLLOW_MS` after a plan change, so they glide with the cards. A line
  is hidden while the middle of the clicked row is scrolled out of its list
  or hidden, while its tag is out of sight, or while no clean route exists,
  and shows again (fading in, not drawing in) when it is back. Each group
  carries `data-link-line` with the target panel id.
- **Reduced motion.** No transforms: changed and new cards crossfade in
  `REDUCED_FADE_MS`, leaving cards fade out, tint, tags, and note as usual, no lines.
- **Reporting.** `setColumns` from `matchMedia` with `GRID_BREAKPOINTS`, in a
  layout effect so the first paint is packed right; `setPointer` from each
  card's pointerenter, pointerleave, pointerdown, and pointerup.

## Next step: linked panels in the order of what comes next

The report: the user opened Priya Nair's "Re: Invoice INV-1042" ("Sorry
for the delay. Can you resend the invoice to our accounts team? The old
email bounced."). The links to the invoice, the client, and the task
showed, but the panels stayed where they were, far from the message, and
nothing said which one came next. The aid "Arrange linked panels by next
step" (on by default, docs/focus-aids.md) fixes both: the linked panels
gather next to the clicked panel, in the order of the next step, and
Attune offers that step. Jev reads the clicked record; code decides where
panels go; nothing is ever done for the user.

### What happens after the click

1. **One request, two more questions.** The first request after a click on
   a message, an invoice, a task, a project, or an event carries
   `AdaptRequest.link`: the clicked record in words and its linked records
   (the first record of each linked panel that shows it, at most 8, each
   with why it is linked). Jev answers `link_next` and `link_action` with
   the other questions. A click on the step's own record, or more work on
   the same click after its answer, asks nothing.
2. **The gathering.** In a round that links panels, the linked panels move
   into the cells nearest the anchor, ordered by next-step relevance: the
   most relevant one takes the best cell, preferring the same row right
   beside the anchor, then directly below, then left, then above, then the
   nearest other cell. The cards in the way take the cells the linked
   panels left (an exact swap of same-shaped blocks, so no hole opens). The
   anchor never moves, and neither do pinned, held, or bigger panels, or a
   linked panel bigger than a standard card. It is the same round and the
   same staged motion as the rest of the relayout, not a second one.
3. **The order.** Jev's `link_next` probabilities for each panel's linked
   records, highest first, when Jev is sure (the gate below); else code's
   order (`linkPanelOrder`): the same record id first (the invoice the
   message names), then a record that names it (a to-do item or a message
   about the invoice), then the same project, then the same client, then
   the plan priority.
4. **The Next tag.** When Jev is sure, the panel that holds the chosen
   record gets a stronger tag instead of "Linked to ...": "Next: resend
   INV-1042", built from `link_action` and the record ("Next: open ..."
   when the action does not fit the record or Jev is unsure of it), and its
   link line stays at full strength. The other tags stay as they are. In a
   narrow header the tag shows its longest form that fits ("resend
   INV-1042", then "Resend"; an open-only step keeps the record's name),
   and the full text is in its accessible name and tip.
5. **Up next** offers the record ("INV-1042 to resend it", "Jev 95%"), so
   `n` selects INV-1042 in Invoices through the normal view state (a
   click's anchor, links, and gathering apply there too).
6. **The action.** Once that record is open, the suggestion bar offers the
   action as the primary suggestion ("Resend INV-1042 to Harbor Coffee
   Co."), and the matching button in the panel gets a soft ring (the
   Invoices "Resend" button). Only "." or a click performs it.
7. **The follow-up.** When the step's action is done on its record (by "."
   or by the button), and an open to-do item says the same work and names
   the record or its client ("Resend INV-1042 to Harbor accounts team"),
   the next suggestion is "Check off: Resend INV-1042 to Harbor accounts
   team". Only pressing it checks the item off.
8. **When Jev is not sure** (or the heuristic answered): the panels gather
   in code's order, with no Next tag, no Up next pick, and no step.

The step ends when its action is done, its suggestion is dismissed, a new
click's answer replaces it, its record no longer fits the action (paid),
after `LINK_STEP_MS`, or when the aid goes off.

### What Jev is asked

Both questions carry the clicked record in their instructions as
`clicked_record` (structured data: a message's from, client, subject, and
text clipped to about 300 characters; an invoice's id, client, status,
amount, and due words; a task's title and due words; a project's name and
status; an event's title and time words), never in the state, so every
other question and its eval results are unchanged.

- `link_next` (Choice over the linked record ids plus `none`): question
  "Which one of these linked records does the user need next to do what
  `clicked_record` asks for or needs?"; note "The user just opened
  `clicked_record`. Each option is a record in another panel that is linked
  to it."; likely "A linked record that `clicked_record` names, when what it
  asks for is done to that record." and "When `clicked_record` is not a
  message: a linked message that names it, since the message says what the
  other side needs."; rule "Pick none when `clicked_record` asks for
  nothing, or when none of these records is needed for it." Each option:
  `record` (its label), `panel` (its title), `linked_because` (why, from
  `linkWhy`: "the clicked message names this invoice", "this task names
  INV-1042, which the clicked message names", "same client: Harbor Coffee
  Co.").
- `link_action` (Choice over `ACTION_IDS`): question "Which one of these
  actions does `clicked_record` ask the user to take?"; rule "Pick none
  when `clicked_record` does not ask the user to do anything."; none: "No
  action: `clicked_record` does not ask the user to do any of these."

Tuning (September 30, four rounds on the five link sessions): the first
wording read an overdue invoice as asking for nothing, so the client's
message about it scored 0.10; the two `likely` lines moved it first (round
2). Round 3 ("asks for nothing and needs nothing") changed nothing; round 4
(none only for messages, "an unpaid invoice asks to be paid") moved the
invoice click to its to-do item and pushed the held-out price question and
the call request toward none, so it was reverted. The invoice click stays a
near tie (the message at 0.31 to 0.35 against none and the client at 0.22
to 0.29), under the Next gate, so the app gathers it in code's order.

Cost: the two questions add about 700 to 900 input tokens, only on the
first request after a click on a record; the new action adds 32 to every
request (64 with a command).

### The new action

`resend_invoice` ("Resend {invoice} to {client}"; "Send an invoice to the
client again, for example to a new address after an email bounced."; panel
Invoices) is a catalog action like the others: Jev's `next_action` and
`cmd_action` may pick it, the suggestion names the invoice ("Resend
INV-1042 to Harbor Coffee Co."), and `perform()` records it on the invoice
(`Invoice.resentAt`, shown as "Resent" in the detail) with the notice
"Invoice INV-1042 resent to Harbor Coffee Co." Nothing is emailed. It
works on sent or overdue invoices (a draft was never sent, a paid one is
done), makes the invoice handled for Up next, and the Invoices detail and
the row actions have a "Resend" button next to Send reminder and Mark paid.

### Off

With the aid off (or Adaptive off) the links draw as before, nothing
gathers, no link question is sent, and there is no Next tag, step, or
follow-up. Switching it off drops the step, its tag, and its suggestion at
once and moves nothing. The backfill is not part of the aid: it always runs.

### Contract (all additive)

- `shared/catalog.ts`: `ACTION_IDS` and `ACTIONS` gain `resend_invoice`;
  `ActionDef.label` may hold `{invoice}`.
- `shared/fixtures.ts`: `Invoice.resentAt`.
- `shared/types.ts`: `ClickedRecord`, `LinkRequest`, `AdaptRequest.link`,
  `Judgments.linkNext` and `.linkAction`, `Suggestion.args.taskId`,
  `Suggestion.nextStep`, `Suggestion.task`.
- `shared/scenarios.ts`: `Scenario.link`, `expect.linkNext`,
  `expect.linkAction`.
- `src/engine/contract.ts`: `FocusAidSettings.arrangeLinks`, `LinkSet.next`,
  `UpNextPick.source` value `"link"` and `UpNextPick.step`,
  `PackItem.bigger`, `PackInput.gather`.
- `src/engine/focusAids.ts`: `arrangeLinksOn`. `src/engine/relations.ts`:
  `linkWhy`, `LinkWhy`. `src/engine/policy.ts`: `suggestionBlocked`.
  `src/engine/nextUp.ts`: `UpNextInput.link`. `src/engine/linkFlow.ts` (new).
- `server/questions.ts`: `QUESTION_IDS.linkNext` (`link_next`) and
  `.linkAction` (`link_action`), `NO_LINK_RECORD`, `linkOf`.
- `src/ui/domHooks.ts`: `LINK_NEXT_ATTR` (`data-link-next`),
  `STEP_ACTION_ATTR` (`data-step-action`); `src/ui/linking.tsx`:
  `useStepAction`; `src/ui/panels/common.tsx`: `Button` prop `step`;
  `src/index.css`: `--color-link-fg`.

## Constants

| Name | Where | Value | Why |
| --- | --- | --- | --- |
| `GRID_BREAKPOINTS` | grid.ts | 768, 1280 px | the `.fl-grid` media queries, so engine and CSS agree on columns |
| `CELL_SPANS` | grid.ts | 4 and 2 columns: hero 2x4, large 2x2, standard 1x2, compact 1x1; 1 column: hero 1x5, large and standard 1x3, compact 1x1 | today's CSS spans in 104 px row tracks, so a compact tile stays short |
| `COLUMN_TRACK_WEIGHT` | grid.ts | 3 | a column is 330 to 480 px wide and a row track 104 px, so "nearest the anchor" compares screen distance |
| `LINKED_PANELS_MAX` | relations.ts | 3 | three lines are easy to follow; one click must not flood the canvas |
| `RELATED_RECORDS_MAX` | relations.ts | 5 | a cue, not a wall of color |
| `LINK_PRIORITY_BOOST` | policy.ts | 0.12 | lifts a panel Jev rates a little useful past the 0.22 join line; alone it stays below, so Jev decides |
| `LINKED_MIN_SIZE` | policy.ts | standard | compact tiles show no rows, so a tint could not show |
| `CLIENT_WORD_MIN` | relations.ts | 4 | a search names a client only by a real word of its name, never "co" or "and" |
| `ANCHOR_PRESS_WINDOW_MS` | store.ts | 1,000 | a filter or action this soon after a press elsewhere belongs to the pressed panel |
| `ANCHOR_IDLE_RELEASE_MS` | store.ts | 20,000 | time to read the linked panels before the canvas may rebalance |
| `POINTER_MOVE_HOLD_MS` | store.ts | 3,000 | the next click must not land on a card that slid in; a resting mouse must not freeze it |
| `POINTER_LEAVE_HOLD_MS` | store.ts | 5,000 | taking away what the user points at is worse than moving it |
| `STAGE_GROW`, `STAGE_EXIT`, `STAGE_MOVE`, `STAGE_ENTER` | choreography.ts | `{ delayMs, durationMs }` from the stage table | the anchor first, then what leaves, moves, and arrives |
| `ENTER_STAGGER_MS` | choreography.ts | 70 | one at a time, and the round still ends near 1 s |
| `ENTER_OFFSET_PX` | choreography.ts | 24 | reads as coming from the anchor without crossing another card |
| `STAGE_EASE` | choreography.ts | [0.2, 0, 0, 1] | quick start, soft landing, one curve so the round reads as one motion |
| `LINK_LINE_DRAW_MS`, `LINK_LINE_SHOW_MS`, `LINK_LINE_FADE_MS` | choreography.ts | 350, 2,000, 300 | long enough to follow as it draws and to see where each line goes; then a quick step to resting (or gone, in "fade" mode) |
| `LINK_LINE_REST_OPACITY` | choreography.ts | 0.45 | easy to find again, quiet enough to work beside for minutes |
| `LINK_FOLLOW_MS` | choreography.ts | 1,200 | a staged round ends near 1 s and the plain spring settles sooner, so lines glide with the cards |
| `ANCHOR_NOTE_MS` | choreography.ts | 6,000 | the change feed's `FRESH_MS`, so both fade together |
| `LINK_TAG_PULSE_MS` | choreography.ts | 700 | one beat on a tag that no clean line reaches |
| `LINE_SPREAD_PX`, `LINE_CORNER_PX` | LinkLines.tsx | 3, 8 | three lines fit side by side in a 10 to 16 px gutter; soft corners read as one stroke |
| `ROW_EDGE_SLACK_PX` | LinkLines.tsx | 24 | a row this close to its card's side leaves through it without crossing its own card |
| `OBSTACLE_INSET_PX`, `SAMPLE_STEP_PX` | LinkLines.tsx | 2, 4 | a line in a gutter that grazes a border does not count as crossing; checked every 4 px |
| `RESTORE_SCROLL_MS` | PanelFrame.tsx | 700 | the smooth scroll back is ours, not a user scroll signal |
| `REMOVE_GAP_PX` | PanelFrame.tsx | 2 | the gap between a tag and its x, counted when checking whether "Linked to" fits |
| `BAR_FADE_MS` | LinksBar.tsx | 150 | the links bar enters and leaves as part of the caption, not as a new thing |
| `NOTE_ROW_GAP_PX`, `NOTE_INSET_PX` | AnchorNote.tsx | 8, 8 | clear space around the clicked row; the note's inset from the edge it sits on |
| `REDUCED_FADE_MS` | choreography.ts | 150 | shows a change without motion |
| `BIGGER_SIZE` | policy.ts | hero | "Make bigger" is the biggest card there is (2 by 2 cells, taller on one column), not full screen |
| `BIGGER_REASON` | policy.ts | "Made bigger by you" | the user decided its size, not Jev |
| `RESTORE_FALLBACK_SIZE` | policy.ts | standard | "Make smaller" of a panel that was already the hero still makes it smaller |
| `RESIZE_USAGE_WEIGHT` | usage.ts | 1.5 | a strong focus: more than a click into the panel (1), as much as opening it from the dock |
| `LINK_KINDS` | linkFlow.ts | message, invoice, task, project, event | the clicked records whose words say what they ask for (a client or person row does not) |
| `CLICKED_TEXT_MAX` | linkFlow.ts | 300 | a request fits, and the two questions stay small |
| `LINK_CANDIDATES_MAX` | linkFlow.ts | 8 | one per linked panel fits well under it, and the Choice stays sharp |
| `LINK_NEXT_MIN_P` | linkFlow.ts | 0.5 | the Next gate, the Up next gate's shape: Jev puts more on it than on everything else together |
| `LINK_NEXT_LEAN_P`, `LINK_NEXT_MARGIN`, `LINK_NEXT_NONE_MAX` | linkFlow.ts | 0.4, 0.15, 0.2 | a lean with a clear lead and little on none; a near tie is a guess |
| `LINK_ACTION_MIN_P` | linkFlow.ts | 0.5 | the step names its action only when Jev puts more on it than on every other action together |
| `LINK_STEP_MS` | linkFlow.ts | 5 minutes | long enough to read and act; past it the step is stale |
| `FOLLOW_UP_MS` | linkFlow.ts | 2 minutes | as long as a dismissed suggestion stays away |
| `ACTION_TASK_WORDS` | linkFlow.ts | resend: resend, re-send, send again; reply: reply, respond, answer, write back; and so on | a to-do item that says the same work as the action just done |
| `MAX_LINK_RECORDS`, `MAX_CLICKED_TEXT`, `MAX_CLICKED_FIELD` | server/validate.ts | 8, 300, 120 | caps for the new request field; unknown fields are dropped |
| `LINK_NEXT_PICK_WEIGHT`, `LINK_NEXT_NONE_WEIGHT` | server/heuristic.ts | 1, 1 | the fallback's pick never beats none, so offline nothing says Next |
| `--color-link-fg` | index.css | light #ffffff, dark #06232a | text on the solid Next tag: about 5.4:1 (light) and 7:1 (dark) |
| `--color-link`, `-soft`, `-text` | index.css | light #0e7490, #e0f4f8, #0b6680; dark #22b8d6, #0f2d35, #67d3e8 | cyan sits between the green "good" and the indigo accent, so it reads as neither; text is about 5.7:1 (light) and 8.3:1 (dark) on the fill |

## Make bigger

The request: a way to make any panel bigger by hand (not full screen), with
the other panels reflowing around it. The user decides its size, not Jev.

1. **Controls.** A toggle button in every panel header, beside the pin
   (lucide `Maximize2`, `Minimize2` while pressed), with `aria-pressed` and
   the accessible name "Make Invoices bigger" or "Make Invoices smaller"
   (tooltip "Make bigger" or "Make smaller"). A double-click on the header's
   title area does the same; a double-click on a button or tag in the header
   does not (`button, [data-frame-control]` is skipped). Enter and Space
   press the button like any button; a click with `detail` 0 is logged with
   `via: "keyboard"`.
2. **Size.** `BIGGER_SIZE`, the hero: `CELL_SPANS` 2 by 4 tracks on the 4 and
   2 column canvas (2 by 2 cells), 1 by 5 on one column.
3. **Where it goes (grid.ts, `userResizedCell`).** With "Move pinned and
   bigger panels to the front" on (the default) it goes to the first cell
   instead (see "Pin and Make bigger go to the front"); the rest of this
   item and item 4 are the "Keep in place" choice. The same top row; the
   same left column when the new span fits there, else shifted left just
   enough, which is one column for a one-wide card in the last column or in
   a 2-column grid's right column. Never upward. So a panel made bigger
   contains its old cell, and one made smaller keeps its top-left. "Make
   smaller" always keeps its top-left, whatever the setting.
4. **Everyone else (grid.ts, `userResized`).** On 2 and 4 columns: cards
   whose previous cell starts before its new cell in reading order and does
   not overlap it keep their cells, and so do pinned cards not in its way.
   Other cards not in its way keep their top-left. Cards in its way (their
   previous cell overlaps the new one, pinned or not) flow forward to the
   first free spot after it, from their old row. Then the cards that may
   move float up in their column (gravity), and while a hole before the last
   card is still open, the last card that fits one moves into the first such
   hole (one card moves, nothing cascades). Nothing moves to a spot before
   it in reading order. On one column the canvas is a list: the cards after
   it follow it in their old order. Every card gets a cell, so nothing is
   docked; the canvas grows. The result says `anchored: true`.
5. **The flag (store.ts, policy.ts).** `EngineState.bigger` lists the panels
   the user made bigger, persisted with the pins (`floouid:v1`, key
   `bigger`, read with the same try/catch as the pins; older saves have
   none). The policy gets it as `PolicyInput.bigger`: those panels are
   required (never docked) and always `BIGGER_SIZE`, over every other size
   rule, with the reason `BIGGER_REASON` and `placement.bigger`.
   `applyPromotion` keeps them past the cap at `BIGGER_SIZE` too, a pin sent
   to the front does not resize them (`editPlan`), and the fixed layout
   (`traditionalPlan`) shows them at `BIGGER_SIZE`. "Make smaller" removes
   the flag and puts back the size the panel had before it was made bigger
   (`restoredSize`: that size when known, else its slot's size, never the
   hero, `RESTORE_FALLBACK_SIZE` instead); from the next round the policy
   decides. Docking it clears the flag, Reset clears the list, and an Undo
   of the change takes the flag back with the layout (like pins, the list
   follows the restored plan's `placement.bigger`).
6. **At once (store.ts).** `maximize` and `restore` log `panel_maximize` and
   `panel_restore` and apply a manual edit (`manualReplan`, `editPlan` kinds
   `"bigger"` and `"smaller"`) through the place step with
   `PlaceOptions.userResized`, which passes `PackInput.userResized`. It is
   not held by the minimum change interval, and with the pointer on the
   canvas it still moves the cards in its way (the user asked for the room);
   only the policy's catch-up waits, as after a pin. A catch-up that agrees
   with the edit and lands quietly in the same tick keeps the edit's
   decisions and badges, so the feed still says "Made Invoices bigger".
7. **Anchor and links.** The resized panel becomes the anchor for the
   change (`anchorResized`; it keeps the current anchor, with its record
   and links, when that is already the same panel). The edited plan is
   re-anchored on it (`anchoredOn`), and the relations of an older anchor
   come off the plan, so the link set is not re-sourced; the store's link
   set keeps them, and the lines are measured again every frame for
   `LINK_FOLLOW_MS`, so they follow the cards that moved. In "fade" mode a
   new anchor clears the links, as work in another panel does.
8. **Choreography.** The anchor grows first (`STAGE_GROW`); when the anchor
   is a panel the user made bigger, every card that moves in that round
   moves with the growth (delay 0, `STAGE_MOVE` duration), since they make
   room for it and would otherwise sit under it for 250 ms.
9. **Signals.** `panel_maximize` ("Made Invoices bigger") and
   `panel_restore` ("Made Invoices smaller") are not triggers: they never
   start a Jev request by themselves. They weigh `RESIZE_USAGE_WEIGHT` in
   recent use, count as pointer (or keyboard) use in the input style, and
   appear in the snapshot's recent activity, so the next round reads them.
   No Jev question changed.
10. **Adaptive off.** The fixed layout gets explicit cells while a panel is
    bigger (`packedLayout`), so the same rule holds; once nothing is bigger
    the next plan drops its cells and goes back to the CSS flow, in a round
    with nothing to stage.

## Pin and Make bigger go to the front

The user asked for a panel they pin or make bigger to go to the front of the
stack. It is the one exception to "the anchor stays still", and only for
these two explicit layout requests; full rules, constants, and tests are in
docs/focus-aids.md ("Pin or make bigger: move to the front").

- The panel goes to the first cell at once: a pin at its size, a panel made
  bigger as the hero (and the anchor for the change). The front group (every
  pinned or bigger panel, the most recent pin or "Make bigger" first) leads,
  and the other cards reflow in plan order with the usual staged motion.
  Nothing is docked for it.
- The policy keeps the group first, in its order, in every later round
  (`PolicyInput.front`), a pin at its size; the rest take the mode's slots
  after it. In an anchored round the group is before the anchor, so it is
  locked and pinned cards keep their cells.
- Unpin and "Make smaller" leave the panel where it is; from the next round
  the policy places it by the calm rules.
- The move applies even with the pointer on the canvas; the catch-up still
  waits for the pointer.
- The canvas follows it: when the front is out of view it scrolls the page to
  the canvas top (at once with reduced motion) and rings the card for
  `FRONT_RING_MS` once it lands. That round skips the anchor's scroll safety
  net and the browser's own scroll anchoring.
- "Keep in place" (the switch off) restores every rule above this section
  exactly.

## Checks

A1 and A2: the anchor's top-left moves 4 px or less at 1440x900, 1024x800,
and 390x844. A3: added linked panels show a tag and a tinted row, and the
anchor shows the note. A4: no overlap and no cell outside the grid. A5:
`pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm eval` pass. A6: with
"Stay until cleared", lines, tags, and tints are still there 30 s after a
click and after the 20 s release, follow a page scroll, a list scroll, a
resize, and a rebalance, and go with the links bar, Escape, or a tag's x
(that one link only).

B1 (with "Keep in place"): "Make bigger" on a first-column, a last-column,
and a middle panel at 1440x900, 1024x800, and 390x844: the top edge moves 0 to 4 px, the left edge
moves only in the last-column case (by one column), no two cards overlap,
and every card stays inside the canvas. B2: the others glide, "Make smaller"
puts it back at its top-left, two panels can be bigger at once, and both are
still bigger after a reload. B3: the link lines follow a bigger panel's
pushed linked panels. B4: the keyboard path (Tab, Enter, Space) and dark
mode work, and the console has no errors.

D1 (next step, September 30, on a local server, live Jev): at 1440x900,
opening Priya Nair's "Re: Invoice INV-1042" left Inbox at the same place
(0 px over about 590 sampled frames); Invoices (right beside it, "Next:
resend INV-1042", shown as "Resend" in the 4-column header, its line at
full strength), Tasks (directly below), and Clients (diagonal) gathered in
that order, and Calendar and Projects took the cells they left; Up next read
"INV-1042 to resend it, Jev 100%"; `n` selected INV-1042 in Invoices; the
suggestion bar offered "Resend INV-1042 to Harbor Coffee Co." with a ring on
the Resend button; "." showed "Invoice INV-1042 resent to Harbor Coffee
Co." and then "Check off: Resend INV-1042 to Harbor accounts team", which
checked off t-1 only when pressed. With Inbox in the last column (three
pins in front of it) it held still (0 px) and the pinned linked panels kept
their cells. At 1024x800 the full tag showed; at 390x844 the linked panels
went right under Inbox in order with no sideways scroll, and `n` and "."
worked; dark mode read well. No console errors. D2 (no orphaned holes):
after working in Calendar, opening Marcus Webb's message left no fillable
hole and Inbox still (0 px).

C1 (move to the front, the default): at 1440x900, 1024x800, and 390x844, a
pin in the last column, a middle panel made bigger, and a third pin each land
in the first cell (the bigger one as the hero), newest first; scrolled to the
bottom, the page follows to the canvas top (smoothly, or at once with reduced
motion) and the card rings; unpin and "Make smaller" leave the panel in
place; no two cards overlap and nothing is docked; with "Keep in place" a pin
under the pointer stays put and "Make bigger" grows from its top edge.
