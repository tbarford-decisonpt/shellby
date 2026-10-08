// Conversations side by side in the chat view: up to two columns, each split
// into up to two rows, so one pane, a side-by-side pair, or a 2x2 grid. The
// grid is an array of columns, each an array of tab ids, top to bottom:
//   [['a']]             one pane
//   [['a'], ['b']]      side by side
//   [['a', 'c'], ['b']] a on top of c, b down the right
//
// Pure: no DOM, no state. The panel keeps the grid in SB.state.grid.
(function (root) {
  const MAX_COLS = 2;
  const MAX_ROWS = 2;
  const EDGE = 0.3;   // share of a pane, from each side, that splits rather than replaces

  const ids = grid => grid.flat();
  const has = (grid, id) => grid.some(col => col.includes(id));
  const keep = (grid, ok) => grid.map(col => col.filter(ok)).filter(col => col.length);
  const remove = (grid, id) => keep(grid, x => x !== id);

  function find(grid, id) {
    for (let c = 0; c < grid.length; c++) {
      const r = grid[c].indexOf(id);
      if (r >= 0) return { c, r };
    }
    return null;
  }

  // Put `id` where `oldId` is showing. With `oldId` gone (just closed), it
  // takes the first pane; with nothing showing, it's the only one.
  function replace(grid, oldId, id) {
    if (has(grid, id)) return grid;
    if (!grid.length) return [[id]];
    const at = find(grid, oldId) || { c: 0, r: 0 };
    return grid.map((col, c) => col.map((x, r) => (c === at.c && r === at.r ? id : x)));
  }

  // Where `moving` can land on `target`'s pane. Worked out as if `moving` had
  // already left the grid, so pulling one of two stacked panes out to the side
  // is allowed.
  function zones(grid, target, moving) {
    const g = moving === target ? grid : remove(grid, moving);
    const at = find(g, target);
    if (!at) return [];
    const z = ['center'];
    if (g.length < MAX_COLS) z.push('left', 'right');
    if (g[at.c].length < MAX_ROWS) z.push('top', 'bottom');
    return z;
  }

  // Drop `id` on `target`'s pane. The middle swaps the two (or shows `id`
  // there, if it wasn't on screen); an edge splits the pane, or the whole
  // view for left/right, and `id` takes the new half.
  function place(grid, id, target, zone) {
    if (id === target || !zones(grid, target, id).includes(zone)) return grid;
    if (zone === 'center') {
      const from = find(grid, id);
      const to = find(grid, target);
      return grid.map((col, c) => col.map((x, r) => {
        if (c === to.c && r === to.r) return id;
        if (from && c === from.c && r === from.r) return target;
        return x;
      }));
    }
    const g = remove(grid, id);
    const at = find(g, target);
    if (zone === 'left' || zone === 'right') {
      const out = [...g];
      out.splice(zone === 'left' ? at.c : at.c + 1, 0, [id]);
      return out;
    }
    return g.map((col, c) => {
      if (c !== at.c) return col;
      const out = [...col];
      out.splice(zone === 'top' ? at.r : at.r + 1, 0, id);
      return out;
    });
  }

  // Which part of a pane the pointer is over: the nearest edge it can split
  // along, if the pointer is close enough to it, otherwise the middle.
  function zoneAt(rect, x, y, allowed) {
    const fx = (x - rect.left) / rect.width;
    const fy = (y - rect.top) / rect.height;
    const near = [['left', fx], ['right', 1 - fx], ['top', fy], ['bottom', 1 - fy]]
      .filter(([z]) => allowed.includes(z))
      .sort((a, b) => a[1] - b[1])[0];
    return near && near[1] < EDGE ? near[0] : 'center';
  }

  // Where a split will put the new pane, for the drop preview. A new column
  // takes half the whole view; a new row, half of its column (which is one
  // pane tall, or there'd be no room for it).
  function previewRect(zone, pane, view) {
    const half = (r, side) => ({
      left: side === 'right' ? r.left + r.width / 2 : r.left,
      top: side === 'bottom' ? r.top + r.height / 2 : r.top,
      width: side === 'left' || side === 'right' ? r.width / 2 : r.width,
      height: side === 'top' || side === 'bottom' ? r.height / 2 : r.height,
    });
    if (zone === 'left' || zone === 'right') return half(view, zone);
    if (zone === 'top' || zone === 'bottom') return half(pane, zone);
    return { left: pane.left, top: pane.top, width: pane.width, height: pane.height };
  }

  // CSS grid placement. Every pane gets two grid rows, a header and the feed;
  // a column with one pane in a two-row grid runs its feed the full height.
  function layout(grid) {
    const rows = Math.max(1, ...grid.map(col => col.length));
    const cells = grid.flatMap((col, c) => col.map((id, r) => {
      const span = col.length === 1 ? rows : 1;
      return { id, col: c + 1, head: r * 2 + 1, feed: `${r * 2 + 2} / span ${span * 2 - 1}` };
    }));
    return { cols: Math.max(1, grid.length), rows, cells };
  }

  const api = { MAX_COLS, MAX_ROWS, ids, has, keep, remove, find, replace, zones, place, zoneAt, previewRect, layout };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyPanes = api;
})(typeof window !== 'undefined' ? window : globalThis);
