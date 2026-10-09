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
- **Sizes.** Each column has a width share, and each pane a height share within
  its column. Shares are fractions that add up to 1, kept alongside the grid
  in `state.paneSizes`:

  ```js
  { cols: [0.25, 0.25, 0.25, 0.25], rows: [[1], [0.5, 0.5], [1], [1]] }
  ```

  New pure helpers in `panes.js`:
  - `fitSizes(grid, sizes)`: sizes matching the grid's shape. Keeps the shares
    of columns and panes that are still there, gives a new one an even share
    (a split halves the pane it splits), and renormalizes. Bad or missing
    input gives even shares.
  - `resize(sizes, axis, index, delta, minShares)`: moves the line after
    column (or pane) `index` by `delta`, never taking a neighbour below its
    minimum share.
  - `even(sizes, axis, col?)`: evens out the columns, or one column's panes.
  - `clean(saved, openIds)`: a saved `{ grid, sizes }` with unknown or
    duplicate ids dropped, empty columns removed, the caps enforced and
    `fitSizes` applied. Anything malformed gives `null`.
- **Rendering.** One CSS grid can't give each column its own row heights, so
  `#feeds` becomes a row of flex columns, each a column of panes, sized with
  `flex-grow` from the shares. `layout()` (the grid-template span math) goes.
  Each pane is a `.pane` wrapper holding its header, its feed (`t.el`) and its
  box slot. Feeds still move by DOM only; nothing re-renders.
- **Dividers.** A thin `.pane-divider` between columns and between panes in a
  column. Pointer drag calls `resize`; double-click calls `even`. The cursor
  shows the axis. Dividers exist only while there's more than one pane.

## Minimum size and making room

- A pane is at least **280 px wide and 200 px tall** (header, a few lines of
  feed, the box). `zones` and `splitPane` take the space available into
  account: a split that would leave any pane below the minimum at the
  window's largest possible size on its screen is refused with a toast that
  says why ("No room for another column on this screen").
- When a split fits on the screen but not in the window as it is, the panel
  **grows to fit**, toward the middle of its screen, the way **Make room**
  grows it for a workflow map. `grownBounds` gets an optional wanted size:
  columns × 280 by the tallest column × 200, plus the window's chrome (title
  bar, strip, subbar, pane headers and the box), measured from the DOM when
  the split is asked for.
- Growing is one way. Closing panes never shrinks the panel; you resize or
  maximize it yourself. `panelSize` is still only written when you resize it,
  so a grown panel opens at your size next time and grows again if the
  restored layout needs it.
- The split grow is separate from the workflow map's **Make room** state
  (`roomyFrom`), so one never puts back the other's size.
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
- The stand-ins update when a draft, queue or busy state changes:
  `refreshPaneHeads` already runs on every strip redraw and also refreshes them.
- The placeholder hint `Give "<title>" a task…` stays while split.

## Keys

- **Alt+←/→/↑/↓**: focus the neighbouring pane.
- **Ctrl+Alt+←/→/↑/↓**: move this conversation to the neighbouring pane,
  swapping with the one there. Into empty space (right of the last column,
  below the last pane), it splits if there's room.
- Both are added to `shortcuts.js`, so the cheat sheet and Ctrl+K list them.
  Neither is taken today.
- Ctrl+\\ keeps splitting right while there's room for another column, then
  down; the "Four is as many as fit" toast becomes the room-based one above.

## Saving the layout

- New config key `paneLayout: null` (`src/main/config.js`), holding
  `{ grid, sizes }`.
- The renderer sends it whenever the grid or sizes change, debounced 500 ms,
  over a new `panes:layout` IPC (panel only; the guard refuses pop-outs).
  Main validates the shape (arrays of strings, finite numbers, sizes capped)
  and writes it only when it changed, as `openTabs` does.
- At startup `paneLayout` comes back with `app:bootstrap`. After the tabs are
  restored, the panel runs `clean(paneLayout, open tab ids)` and uses the
  result. Open tabs the layout doesn't mention stay in the strip, off screen;
  with nothing usable, it's one pane, as today. The focused pane is the first
  one.
- Pop-outs are still never saved, so a popped-out tab comes back into the
  panel after a restart and shows wherever the layout had it, or off screen.
- This is new: until now the grid started fresh each time. The PR says so.

## Tests

- **Unit, `test/panes.test.js`**: the existing cases move to the new caps
  (a 2×2 can now split sideways; a full 4×3 only swaps), plus `fitSizes`,
  `resize` (never below the minimum), `even`, and `clean` (unknown and
  duplicate ids, empty columns, over the caps, garbage in).
- **Unit, `test/panel-wiring.test.js`**: `grownBounds` with a wanted size
  grows to it, clamps to the work area, and does nothing when it already fits.
- **Unit, IPC**: `panes:layout` rejects bad shapes and pop-out senders.
- **e2e, `scripts/e2e-panes.js`**: it isn't run by CI today (its first line has
  no `// ci:` mark). It gets one, and:
  - the 2×2 assertions change (a 2×2 still offers left and right);
  - a 4×1 strip by Ctrl+\\, with the panel grown to fit;
  - dragging a divider changes the sizes, and double-clicking evens them;
  - a draft typed in one pane, then another pane clicked: the first pane's
    stand-in shows its draft and the box now holds the second's;
  - a message sent from a box moved into a pane reaches that conversation's
    fake Claude and no other;
  - Alt+→ focuses the next pane; Ctrl+Alt+→ swaps;
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
