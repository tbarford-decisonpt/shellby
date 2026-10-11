/* Shellby panel — room for the panes: whether a grid of them fits this
   window as it is, once the panel grows to make room (main's fitPanel, over
   panel:fit), or not on this screen at all; sizes that keep every pane at
   its minimum; and a split brought back at startup growing the panel once
   the chat shows. tab-panes.js lays the panes out. */
'use strict';
(function () {
  const { api, state, $ } = SB;
  const P = SB.panes;
  const box = $('composer');
  const home = $('chatView');

  SB.NO_ROOM = 'No room for another pane on this screen. Close one, or make the window bigger.';

  // What the panes take beyond P.MIN, measured from components.css with the
  // panes split: #feeds has 6 px of padding left, right and top; each column
  // after the first has a 6 px line before it, and each pane a 6 px margin
  // under it (the line between two in a column sits in that margin). So N
  // columns of M panes take N x 286 + 6 by M x 206 + 6 px. A pane's header
  // (28 px), border and stand-in or box are inside its MIN.
  const PANE_CHROME = { width: 6, height: 6 };
  const FEEDS_PAD = 6;
  // Main keeps a grown panel this far inside the screen's work area (wiring/panel.js ROOMY.gap).
  const SCREEN_GAP = 8 * 2;

  // CSS px `grid` takes with its smallest pane at P.MIN, at `sizes`: the
  // forward of atLeastMin below. Even sizes come to P.needs plus the padding.
  function needAt(grid, sizes) {
    const { cols, rows } = P.shares(grid, sizes);
    return {
      width: Math.ceil(FEEDS_PAD + grid.length * PANE_CHROME.width + P.MIN.width / Math.min(...cols)),
      height: Math.ceil(FEEDS_PAD + Math.max(...grid.map((col, c) => col.length * PANE_CHROME.height + P.MIN.height / Math.min(...rows[c])))),
    };
  }

  // Room for `grid` in this window: { ok: true } as it is, { ok: true, want }
  // once the window grows to `want` ({ width, height } in DIP, what main's
  // fitPanel takes), or { ok: false }: not on this screen. `space`: the CSS px
  // the panes get then. The DOM measures in CSS px, which the page's zoom
  // scales; the window and screen are in DIP. With `sizes`, room for the
  // panes at those sizes; without, evened out.
  SB.roomFor = (grid, sizes = null) => {
    const f = $('feeds').getBoundingClientRect();
    const n = P.needs(grid, PANE_CHROME);
    const need = sizes ? needAt(grid, sizes) : { width: n.width + FEEDS_PAD, height: n.height + FEEDS_PAD };
    // Split, the box moves into a pane and the feeds take its place.
    // Shown again from another view, the chat can have a scrollbar for a frame
    // or two (10 px of the feeds' width); the panes never scroll it, so count it in.
    const bar = Math.max(0, home.offsetWidth - home.clientWidth);
    const avail = { width: f.width + bar, height: f.height + (box.parentElement === home ? box.offsetHeight : 0) };
    const space = { width: Math.max(avail.width, need.width), height: Math.max(avail.height, need.height) };
    if (need.width <= avail.width && need.height <= avail.height) return { ok: true, space };
    const zoom = api.zoomFactor?.() || 1;
    // innerWidth x zoom is the window's own size (outerWidth adds Windows' invisible resize frame).
    const want = {
      width: Math.round(window.innerWidth * zoom) + Math.ceil(Math.max(0, need.width - avail.width) * zoom),
      height: Math.round(window.innerHeight * zoom) + Math.ceil(Math.max(0, need.height - avail.height) * zoom),
    };
    if (want.width > window.screen.availWidth - SCREEN_GAP || want.height > window.screen.availHeight - SCREEN_GAP) return { ok: false };
    return { ok: true, want, space };
  };

  // `sizes` for `grid`, with any axis that would leave a pane under P.MIN in
  // `space` px evened out. A split halves what it splits, so in a window only
  // just big enough the halves can come out under the minimum though the
  // panes fit side by side evenly (roomFor's sum).
  SB.atLeastMin = (grid, sizes, space) => {
    const { cols, rows } = P.shares(grid, sizes);
    const across = space.width - FEEDS_PAD - grid.length * PANE_CHROME.width;
    let s = sizes;
    if (cols.some(f => f * across < P.MIN.width - 0.5)) s = P.even(grid, s, 'w');
    grid.forEach((col, c) => {
      const down = space.height - FEEDS_PAD - col.length * PANE_CHROME.height;
      if (rows[c].some(f => f * down < P.MIN.height - 0.5)) s = P.even(grid, s, 'h', c);
    });
    return s;
  };

  // The chat on screen at the size it will stay, for measuring the room in it.
  // From another view (the split shortcut, the palette) it's shown first, and a
  // map's Make room (wf-kit.js) is let go before anything's measured. -> shows?
  SB.chatShowing = async () => {
    if (state.view !== 'chat') SB.setView('chat');
    await null; // the map's observer of the view change runs before this goes on
    await SB.roomSettled?.();
    return state.view === 'chat'; // just the crab has no chat
  };

  // A split brought back at boot (boot.js) that needs more room than the panel
  // has grows it, as a split would. Measured with the chat on screen only: from
  // another view (first run, a deep link) it waits until the chat shows.
  let growWanted = false;
  SB.growForPanes = () => { growWanted = true; if (state.view === 'chat') growNow(); };
  SB.views.chat = { render: () => { if (growWanted) growNow(); } };
  // Room for the panes at the sizes they were left at; on a screen too small
  // for that, room for them evened out, and the sizes evened as far as they
  // have to be, so no pane comes back under P.MIN.
  async function growNow() {
    growWanted = false;
    await null; // the map's observer of the view change runs before this goes on
    await SB.roomSettled?.();
    await new Promise(requestAnimationFrame);
    if (state.view !== 'chat') { growWanted = true; return; }
    if (P.count(state.grid) < 2) return;
    const asLeft = SB.roomFor(state.grid, state.paneSizes);
    const room = asLeft.ok ? asLeft : SB.roomFor(state.grid);
    if (!room.ok) return; // not even evened out on this screen: as it is, then
    if (room.want) await api.fitPanel(room.want);
    if (asLeft.ok) return;
    state.paneSizes = SB.atLeastMin(state.grid, state.paneSizes, room.space);
    SB.applyPaneSizes();
    SB.savePanes();
  }
})();
