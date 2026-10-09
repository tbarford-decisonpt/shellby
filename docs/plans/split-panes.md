# Split panes: up to twelve, any size, tabs and a box in each

Since 0.73.0 the chat view can show conversations side by side: **Split**
(Ctrl+\\) or drag a tab onto the chat, up to a 2×2 grid, or drag it out into a
window of its own. This takes the grid further:

- **Up to twelve panes**: four columns, each up to three panes tall. That
  covers a 4×1 strip across an ultrawide monitor, 2×2, 3×3, 4×3, and shapes
  like one tall pane beside two stacked ones.
- **Sizes you set**: drag the line between two columns, or between two panes
  in a column. Double-click a line to even them out again.
- **Tabs in every pane**: each pane has its own tab strip and can hold
  several conversations, as editor groups do in VS Code. Drag a tab onto a
  pane to put it there.
- **A box in every pane**: each pane shows its own message box with its own
  draft. The focused pane has the real one; click or type into any other to
  carry on there.
- **The layout comes back** after a restart.

Why: one conversation per task is how Shellby is meant to be used, and four
on screen at once runs out quickly. On a wide monitor there's room for twice
that, but only if the panes can be shaped to it and each one can be typed
into without hunting for which conversation the one box is talking to.

This file is the contract between `src/renderer/shared/panes.js`,
`src/renderer/panel/tab-panes.js`, the panel's window code
(`src/main/wiring/panel.js`) and the tests.

## What stays as it is

- Pop-outs, the edge drop zones, the drop preview and dragging a tab out of the
  window work as they do now.
- The folder, branch, effort and context chips under the strip belong to the
  focused pane's conversation, as now.
- One pane looks and behaves exactly as the chat view does today: one strip
  at the top, holding every conversation.

## The grid

The model stays an array of columns, each an array of panes, top to bottom
(`shared/panes.js`), and each pane is now a group of tabs:
`{ id, tabs: [tabId, …], active }`. The id is the pane's own (`p1`, `p2`,
…), kept for as long as the pane lives. Every open conversation is in exactly
one pane. The model already expresses every shape above. The one shape it
can't is a pane spanning the full width above or below others; nobody needs
it, and supporting it would mean a different model.

- `MAX_COLS` goes from 2 to 4 and `MAX_ROWS` from 2 to 3. `zones`, `place`,
  `zoneAt` and `previewRect` keep working off those caps.
- **Sizes.** Sizes are weights keyed by pane id, so they stay with a pane
  whichever of its tabs is showing. Every pane in a column carries the column's width, and
  `h` is a pane's height within its column. They're kept alongside the grid
  in `state.paneSizes`:

  ```js
  { w: { a: 1, b: 1, c: 1 }, h: { a: 1, b: 1, c: 1 } }
  ```

  Weights don't have to add up to anything. `shares(grid, sizes)` turns them
  into the fractions `flex-grow` gets: the columns summing to 1, and each
  column's panes summing to 1.

  New pure helpers in `panes.js`:
  - `fitSizes(grid, sizes)`: a weight for every pane in the grid, from
    `sizes` as far as they go. A column with no width yet gets the other
    columns' average, a pane with no height its column's. Ids no longer in the
    grid, and junk, are dropped.
  - `placeSizes(grid, sizes, id, target, zone)`: the sizes once `id` is
    dropped on `target` (see `place`). A split halves the pane, or the
    column, it splits; joining a pane leaves the sizes as they are.
  - `setWeight(grid, sizes, axis, c, r, w)`: one column's width (axis `w`,
    every pane in column `c`), or one pane's height (axis `h`).
  - `splitPair(a, b, aPx, bPx, delta, min)`: the line between two neighbours
    dragged by `delta` px. Their new weights, neither going below `min` px.
  - `even(grid, sizes, axis, c?)`: evens out the columns, or column `c`'s
    panes.
  - `needs(grid, chrome)`: the px a grid takes with every pane at the
    minimum, plus `chrome` px per pane each way.
  - `clean(saved, openIds)`: a saved `{ grid, sizes }` with unknown or
    duplicate tab ids dropped, empty panes and columns removed, a pane's
    `active` put right if it's gone, the caps enforced and
    `fitSizes` applied. An id every object already has (`__proto__`,
    `constructor`) is junk. Anything malformed, or nothing left, gives
    `null`.
- **Rendering.** One CSS grid can't give each column its own row heights, so
  `#feeds` becomes a row of flex columns, each a column of panes, sized with
  `flex-grow` from `shares`. `layout()` (the grid-template span math) goes.
  Each pane is a `.pane` wrapper holding its tab strip, its active tab's
  feed (`t.el`) and its box slot; its other tabs' feeds stay hidden. Feeds still move by DOM only; nothing re-renders.
- **Dividers.** A thin `.pane-divider` between columns and between panes in a
  column. A pointer drag moves weight between the two with `splitPair` and
  `setWeight`; double-click calls `even`. The cursor shows the axis. Dividers exist only while there's more than one pane.

## Tabs in a pane

- **One strip, drawn once per pane.** `tab-strip.js` draws a strip for a
  pane rather than for the window. With one pane it draws into the top strip,
  with the same elements and ids as today, so the one-pane e2e scripts keep
  working untouched. While split, the top strip hides and each pane's header
  is its strip: its tabs, a "+", and the pane's pop out and close. Tabs look
  and act as they do today: the busy or asking mark, rename (F2 or a
  double-click), middle-click to close, the right-click menu and the context
  line.
- **A narrow pane.** At 280 px a strip shows two or three tabs. It scrolls
  sideways with the wheel, keeps its active tab in view, and has its own edge
  pills for tabs out of view.
- **Every conversation** (Ctrl+Shift+A) stays one list. While split its
  button sits at the end of the subbar; it lists every pane's tabs, and
  picking one focuses its pane.
- **New tab** (Ctrl+T, or a strip's "+") opens in that pane, after its active
  tab.
- **Dragging a tab**:
  - onto a pane's strip: it joins that pane, where it's dropped;
  - onto the middle of a pane: it joins that pane at the end and shows there;
  - onto a pane's edge: it splits off into a pane of its own, as before;
  - out of the window: it gets a window of its own, as before.
  A pane whose last tab is dragged away closes.
- **Split** (Ctrl+\\) takes the focused pane's active tab into a new pane
  when the pane has more than one; otherwise the new pane starts a new
  conversation.
- **Closing.** A tab's × closes that conversation, as now; closing a pane's
  last tab closes the pane. The pane's own × closes the pane and moves its
  tabs into the pane beside it, so no conversation is closed by accident.
- **Clicking a tab** in an unfocused pane shows it there and focuses the
  pane.
- **A pop-out** leaves its pane. When it comes back, it joins the focused
  pane.
- The subbar (folder, branch, effort, context, Split, pop out) stays one bar
  and follows the focused pane's active tab.

## Minimum size and making room

- A pane is at least **280 px wide and 200 px tall** (header, a few lines of
  feed, the box). The drop zones a dragged tab is offered and `splitPane`
  take the space available into account (`SB.roomFor`): a split that would
  leave any pane below the minimum at the window's largest possible size on
  its screen is refused with a toast that says why: "No room for another pane
  on this screen. Close one, or make the window bigger." With all twelve on
  screen, Split says "Twelve is as many as there are. Close a pane first."
- When a split fits on the screen but not in the window as it is, the panel
  **grows to fit**, toward the middle of its screen, the way **Make room**
  grows it for a workflow map. `grownBounds` gets an optional wanted size,
  which the renderer works out from the DOM when the split is asked for. N
  columns of M panes take N × 286 + 6 by M × 206 + 6 CSS px (each pane's
  minimum plus its gap and margin, and the feeds' padding). What `#feeds` is
  short of that, times the page's zoom, is added to the window's content size
  times the zoom. That's the size in DIP that main's `fitPanel` grows the
  panel to, over `panel:fit`.
- Growing is one way. Closing panes never shrinks the panel; you resize or
  maximize it yourself. `panelSize` is still only written when you resize it,
  so a grown panel opens at your size next time and grows again if the
  restored layout needs it.
- The split grow takes over from the workflow map's **Make room**. If the map
  had room, it's told it lost it (`panel:roomy-lost`), as when you resize
  the panel yourself, so Make room never puts back a size the panes need.
- Split from another view (the shortcut from Settings, the palette's Split
  over a workflow map) switches to the chat first and lets the map's Make
  room go back before anything is measured, so the map's width is never taken
  for room the chat has.
- A split brought back at startup that needs more room than the panel has
  grows it the same way once the chat shows: room for the panes at the sizes
  they were left at, or, on a screen too small for that, evened out as far as
  they have to be.
- The palette's Maximize entry and the `#maxBtn` stay; the hint changes from
  "Room for a 2×2 grid" to "Room for more panes".

## A box in every pane

There's still one real message box (`#composer` with `#input`). It **moves**
into the focused pane's box slot. Every other pane shows a stand-in in its
slot:

- the start of that pane's active conversation's draft (or the placeholder, dimmed),
- how many messages are queued,
- whether he's working or asking.

Clicking the stand-in, or focusing it and typing, activates that pane:
`SB.activate` already saves the old draft to the old tab and loads the new
one, and the box moves. The keystroke that started it lands in the box. With
one pane there is no stand-in and the box sits where it always has.

Why one box and not twelve: the box is wired to fixed element ids across
about fifteen panel modules (send, queue, slash menu, pick menu, outlook,
tries, line comments, chips) and 23 e2e scripts find it by id. Moving one box
keeps all of them working. You can only type in one place at a time anyway,
and every pane still shows its own draft, one click away.

Details:

- Moving the box closes its open menus (slash, pick, history search), as
  switching tabs does now.
- In a pane the box has a ceiling. The feed above it keeps at least 40 px,
  and what stacks up over the input row (the to-do list, background jobs,
  queued messages, the outlook and review bars, attachments) scrolls instead
  of pushing the box out of the bottom of its pane. The Working bar and the
  input row stay in view. The box itself never clips, because the slash and
  pick menus open upward out of it.
- Pressing a stand-in, or typing on it, hands its pane the box. Enter and
  Space do too, and AltGr characters (`@`, `{`, `\` on many keyboards)
  type. A stand-in's name for a screen reader is what it shows.
- A press anywhere in an unfocused pane focuses it, except on a control in
  its feed: a button, link, text field, drop-down, label, summary, menu item
  or option (Allow on a permission card, an answer, a typed answer of your
  own). Those focus the pane as they're clicked, because the box moving in
  can scroll the feed under the pointer before it's let go. A text field
  clicked that way keeps the keyboard, so what's typed next goes into it and
  not into the box.
- The stand-ins update when a draft, queue or busy state changes:
  `refreshPaneHeads` already runs on every strip redraw and also refreshes them.
- The placeholder hint `Give "<title>" a task…` stays while split.

## Keys

- **Alt+←/→/↑/↓**: focus the neighbouring pane.
- **Ctrl+Alt+←/→/↑/↓**: move this conversation into the neighbouring pane,
  where it joins that pane's tabs. Past a column's ends ↑/↓ do nothing.
  Ctrl+Alt+←/→ at the left or right edge move it into a column of its own
  when there's room; with four columns already, or no room, a toast says why.
  A pane left with no tabs closes.
- **Ctrl+Tab, Ctrl+PgUp/PgDn** go through the focused pane's tabs, and
  **Ctrl+Shift+PgUp/PgDn** move a tab along its pane's strip.
- Neither works while there's one pane, behind the palette, a dialog or an
  open menu, or while a tab's name is being typed. A key the box has already
  used is left alone: a bare ↑ in an empty box pulls back a queued message,
  and Alt+↑ there moves to the pane above.
- Both are added to `shortcuts.js`, so the cheat sheet and Ctrl+K list them.
  Neither is taken today.
- Ctrl+\\ keeps splitting right while there's room for another column, then
  down; the "Four is as many as fit" toast becomes the room-based one above.
  From another view it shows the chat first.

## Saving the layout

- New config key `paneLayout: null` (`src/main/config.js`), holding
  `{ grid, sizes }`: every pane's id, tabs in order and active tab, and the
  sizes by pane id. A layout saved with one tab per pane (a tab id where a
  pane goes) reads as panes of one tab each.
- The renderer sends it only while split, 500 ms after the grid or sizes
  settle, over a new `panes:layout` IPC (panel only; the guard refuses
  pop-outs). Back to one pane it sends `null` once, so one pane writes
  nothing and starts as it always has. Main runs it through `clean` and
  writes it only when it changed, as `openTabs` does.
- Main keeps its tab order (the order `openTabs` is saved in) as each
  pane's tabs in turn, so a start with no usable layout opens every
  conversation in one pane in a sensible order.
- At startup `paneLayout` comes back with `app:bootstrap`. After the tabs are
  restored, the panel runs `clean(paneLayout, open tab ids)` and uses the
  result if it's still a split. Open tabs the layout doesn't mention join
  the first pane; with nothing usable, it's one pane, as today. The
  focused pane is the first one, unless a conversation the last run cut off
  mid-turn comes to the front.
- Pop-outs are still never saved, so a popped-out tab comes back into the
  panel after a restart, in the pane the layout had it in, or the first.
- This is new: until now the grid started fresh each time. The PR says so.

## Tests

- **Unit, `test/panes.test.js`**: the existing cases move to the new caps
  (a 2×2 can now split sideways; a full 4×3 only joins), plus `fitSizes`,
  `placeSizes`, `splitPair` (never below the minimum), `setWeight`,
  `even`, `neighbor`, `moveToward`, `shares`, `needs`, and `clean`
  (unknown and duplicate ids, empty columns, over the caps, garbage in, a
  layout saved with one tab per pane), and tabs in a pane: joining, leaving,
  splitting one off, closing a pane into its neighbour, moving with keys.
- **Unit, `test/panel-wiring.test.js`**: `grownBounds` with a wanted size
  grows to it, clamps to the work area, and does nothing when it already fits.
- **Unit, IPC, `test/ipc-panes.test.js`**: `panes:layout` cleans bad shapes
  and refuses pop-out senders.
- **e2e, `scripts/e2e-panes.js`**: it isn't run by CI today (its first line has
  no `// ci:` mark). It gets one, and:
  - the 2×2 assertions change (a 2×2 still offers left and right);
  - a 4×1 strip by Ctrl+\\, with the panel grown to fit;
  - dragging a divider changes the sizes, and double-clicking evens them;
  - a draft typed in one pane, then another pane clicked: the first pane's
    stand-in shows its draft and the box now holds the second's;
  - a message sent from a box moved into a pane reaches that conversation's
    fake Claude and no other;
  - Alt+→ focuses the next pane; Ctrl+Alt+→ moves the tab into the next pane; Alt+↑ from an empty box
    with a message queued moves and leaves the queue alone;
  - a busy box (the Working bar and an open to-do list) in the top pane of
    three in a 760 px window stays inside its pane, and the feed keeps 40 px;
  - Allow at the bottom of an unfocused pane takes a real mouse click;
  - a stand-in takes Enter and AltGr characters, and a press on it closes an
    open menu;
  - each pane has its own strip and the top strip hides; a tab dropped on a
    strip, on the middle of a pane and on an edge goes where it should;
    Ctrl+Tab stays in its pane; a pane's × moves its tabs next door; a tab
    clicked in an unfocused pane shows there and focuses it;
  - a restart brings the layout, sizes, and every pane's tabs and active tab
    back.
  Screenshots are raced against a 10 s wait, as in the other e2e checks.
- The existing checks stay green untouched: `npm run lint`, `typecheck`,
  `test` and `e2e:ci`, the tab drag in ui-regressions and e2e-tab-overview
  included.

## Out of scope

- A real message box in every pane at once.
- A pane spanning the full width above or below others.
- Saving pop-out windows.

## Shipping

One branch and one pull request to upstream `main`, with a
`changes/split-panes.md` note (no version bump).
