# Split panes: up to twelve, any size, a box in each

Since 0.73.0 the chat view can show conversations side by side: **Split**
(Ctrl+\\) or drag a tab onto the chat, up to a 2×2 grid, or drag it out into a
window of its own. This takes the grid further:

- **Up to twelve panes**: four columns, each up to three panes tall. That
  covers a 4×1 strip across an ultrawide monitor, 2×2, 3×3, 4×3, and shapes
  like one tall pane beside two stacked ones.
- **Sizes you set**: drag the line between two columns, or between two panes
  in a column. Double-click a line to even them out again.
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

- The tab strip stays shared: one strip for every conversation, with the
  on-screen ones lit. Each pane keeps its slim header (state, title, pop out,
  close), which hides while there's only one pane.
- Pop-outs, the drop zones, the drop preview and dragging a tab out of the
  window work as they do now.
- The folder, branch, effort and context chips under the strip belong to the
  focused pane's conversation, as now.
- One pane looks and behaves exactly as the chat view does today.

## The grid

The model stays an array of columns, each an array of tab ids, top to bottom
(`shared/panes.js`). It already expresses every shape above. The one shape it
can't is a pane spanning the full width above or below others; nobody needs
it, and supporting it would mean a different model.

- `MAX_COLS` goes from 2 to 4 and `MAX_ROWS` from 2 to 3. `zones`, `place`,
  `zoneAt` and `previewRect` keep working off those caps.
- **Sizes.** Sizes are weights keyed by tab id, so they go where a
  conversation goes. Every pane in a column carries the column's width, and
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
    column, it splits; a swap leaves the slots their sizes.
  - `setWeight(grid, sizes, axis, c, r, w)`: one column's width (axis `w`,
    every pane in column `c`), or one pane's height (axis `h`).
  - `splitPair(a, b, aPx, bPx, delta, min)`: the line between two neighbours
    dragged by `delta` px. Their new weights, neither going below `min` px.
  - `even(grid, sizes, axis, c?)`: evens out the columns, or column `c`'s
    panes.
  - `needs(grid, chrome)`: the px a grid takes with every pane at the
    minimum, plus `chrome` px per pane each way.
  - `clean(saved, openIds)`: a saved `{ grid, sizes }` with unknown or
    duplicate ids dropped, empty columns removed, the caps enforced and
    `fitSizes` applied. An id every object already has (`__proto__`,
    `constructor`) is junk. Anything malformed, or nothing left, gives
    `null`.
- **Rendering.** One CSS grid can't give each column its own row heights, so
  `#feeds` becomes a row of flex columns, each a column of panes, sized with
  `flex-grow` from `shares`. `layout()` (the grid-template span math) goes.
  Each pane is a `.pane` wrapper holding its header, its feed (`t.el`) and its
  box slot. Feeds still move by DOM only; nothing re-renders.
- **Dividers.** A thin `.pane-divider` between columns and between panes in a
  column. A pointer drag moves weight between the two with `splitPair` and
  `setWeight`; double-click calls `even`. The cursor shows the axis. Dividers exist only while there's more than one pane.

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

- the start of that conversation's draft (or the placeholder, dimmed),
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
- A press anywhere in an unfocused pane focuses it, except on a button or
  link in its feed (Allow on a permission card, an answer). Those focus the
  pane as they're clicked, because the box moving in can scroll the feed
  under the pointer before it's let go.
- The stand-ins update when a draft, queue or busy state changes:
  `refreshPaneHeads` already runs on every strip redraw and also refreshes them.
- The placeholder hint `Give "<title>" a task…` stays while split.

## Keys

- **Alt+←/→/↑/↓**: focus the neighbouring pane.
- **Ctrl+Alt+←/→/↑/↓**: move this conversation to the neighbouring pane,
  swapping with the one there. Ctrl+Alt+↑/↓ swap within a column and do
  nothing past its ends. Ctrl+Alt+←/→ at the left or right edge move a pane
  that shares its column into a column of its own when there's room; with
  four columns already, or no room, a toast says why.
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
  `{ grid, sizes }`.
- The renderer sends it only while split, 500 ms after the grid or sizes
  settle, over a new `panes:layout` IPC (panel only; the guard refuses
  pop-outs). Back to one pane it sends `null` once, so one pane writes
  nothing and starts as it always has. Main runs it through `clean` and
  writes it only when it changed, as `openTabs` does.
- At startup `paneLayout` comes back with `app:bootstrap`. After the tabs are
  restored, the panel runs `clean(paneLayout, open tab ids)` and uses the
  result if it's still a split. Open tabs the layout doesn't mention stay in
  the strip, off screen; with nothing usable, it's one pane, as today. The
  focused pane is the first one, unless a conversation the last run cut off
  mid-turn comes to the front.
- Pop-outs are still never saved, so a popped-out tab comes back into the
  panel after a restart and shows wherever the layout had it, or off screen.
- This is new: until now the grid started fresh each time. The PR says so.

## Tests

- **Unit, `test/panes.test.js`**: the existing cases move to the new caps
  (a 2×2 can now split sideways; a full 4×3 only swaps), plus `fitSizes`,
  `placeSizes`, `splitPair` (never below the minimum), `setWeight`,
  `even`, `neighbor`, `moveToward`, `shares`, `needs`, and `clean`
  (unknown and duplicate ids, empty columns, over the caps, garbage in).
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
  - Alt+→ focuses the next pane; Ctrl+Alt+→ swaps; Alt+↑ from an empty box
    with a message queued moves and leaves the queue alone;
  - a busy box (the Working bar and an open to-do list) in the top pane of
    three in a 760 px window stays inside its pane, and the feed keeps 40 px;
  - Allow at the bottom of an unfocused pane takes a real mouse click;
  - a stand-in takes Enter and AltGr characters, and a press on it closes an
    open menu;
  - a restart brings the layout and sizes back.
  Screenshots are raced against a 10 s wait, as in the other e2e checks.
- The existing checks stay green untouched: `npm run lint`, `typecheck`,
  `test` and `e2e:ci`, the tab drag in ui-regressions and e2e-tab-overview
  included.

## Out of scope

- A tab strip per pane (VS Code's editor groups). The shared strip stays.
- A real message box in every pane at once.
- A pane spanning the full width above or below others.
- Saving pop-out windows.

## Shipping

One branch and one pull request to upstream `main`, with a
`changes/split-panes.md` note (no version bump).
