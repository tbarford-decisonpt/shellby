// Conversations side by side in the chat view: up to four columns, each split
// into up to three panes, so anything from one pane to a 4x3 grid, a 4x1 strip
// across a wide screen included. The grid is an array of columns, each an
// array of tab ids, top to bottom:
//   [['a']]             one pane
//   [['a'], ['b']]      side by side
//   [['a', 'c'], ['b']] a on top of c, b down the right
// Sizes are weights keyed by tab id, so they go where a conversation goes:
// { w: { id: n }, h: { id: n } }. Every pane in a column carries the column's
// width; h is a pane's height within its column.
//
// Pure: no DOM, no state. The panel keeps them in SB.state.grid and SB.state.paneSizes.
(function (root) {
  const MAX_COLS = 4;
  const MAX_ROWS = 3;
  const MIN = { width: 280, height: 200 }; // px a pane needs: its header, a few lines, the box
  const EDGE = 0.3;   // share of a pane, from each side, that splits rather than replaces
  const MAX_ID = 200; // longer than any history id: junk

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

  // ------------------------------------------------------------ sizes

  const weight = x => (Number.isFinite(x) && x > 0 && x < 1e6 ? x : null);
  const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1);

  // Sizes for every pane in `grid`, from `sizes` as far as they go: a column
  // with no width yet gets the others' average, a pane with no height its
  // column's. Ids no longer in the grid, and junk, are dropped.
  function fitSizes(grid, sizes) {
    const w0 = sizes?.w || {}, h0 = sizes?.h || {};
    const colW = grid.map(col => col.map(id => weight(w0[id])).find(Boolean) ?? null);
    const avgW = mean(colW.filter(Boolean));
    const out = { w: {}, h: {} };
    grid.forEach((col, c) => {
      const hs = col.map(id => weight(h0[id]));
      const avgH = mean(hs.filter(Boolean));
      col.forEach((id, r) => { out.w[id] = colW[c] ?? avgW; out.h[id] = hs[r] ?? avgH; });
    });
    return out;
  }

  // The sizes once `id` is dropped on `target` (see place). `grid` is the grid
  // before the drop. A split halves the pane, or the column, it splits; a swap
  // leaves the slots their sizes.
  function placeSizes(grid, sizes, id, target, zone) {
    const s = fitSizes(grid, sizes);
    const out = { w: { ...s.w }, h: { ...s.h } };
    if (zone === 'center') {
      const tw = s.w[target], th = s.h[target];
      if (has(grid, id)) { out.w[target] = s.w[id]; out.h[target] = s.h[id]; }
      out.w[id] = tw; out.h[id] = th;
      return out;
    }
    delete out.w[id]; delete out.h[id];
    if (zone === 'left' || zone === 'right') {
      const half = s.w[target] / 2;
      for (const x of grid[find(grid, target).c]) out.w[x] = half;
      out.w[id] = half; out.h[id] = 1;
    } else {
      const half = s.h[target] / 2;
      out.h[target] = half; out.h[id] = half; out.w[id] = s.w[target];
    }
    return out;
  }

  // One column's width (axis 'w', every pane in column c), or one pane's height (axis 'h', grid[c][r]).
  function setWeight(grid, sizes, axis, c, r, w) {
    const s = fitSizes(grid, sizes);
    if (axis === 'w') for (const id of grid[c] || []) s.w[id] = w;
    else if (grid[c]?.[r] !== undefined) s.h[grid[c][r]] = w;
    return s;
  }

  // The line between two neighbours (columns, or panes in a column) dragged by
  // `delta` px: their new weights, neither going below `min` px. a, b: their
  // weights now; aPx, bPx: their sizes on screen now.
  function splitPair(a, b, aPx, bPx, delta, min) {
    const total = aPx + bPx;
    if (!(total > 0)) return [a, b];
    const lo = Math.min(min, total / 2);
    const next = Math.min(Math.max(aPx + delta, lo), total - lo);
    const sum = a + b;
    return [(sum * next) / total, (sum * (total - next)) / total];
  }

  // Double-clicking a line: the columns even (axis 'w'), or column c's panes (axis 'h').
  function even(grid, sizes, axis, c = 0) {
    const s = fitSizes(grid, sizes);
    if (axis === 'w') for (const id of ids(grid)) s.w[id] = 1;
    else for (const id of grid[c] || []) s.h[id] = 1;
    return s;
  }

  // A layout saved last time, made safe: only the open ids (any string id with
  // openIds null), each once, within the caps. null when nothing's left.
  function clean(saved, openIds = null) {
    if (!saved || typeof saved !== 'object' || !Array.isArray(saved.grid)) return null;
    const open = openIds && new Set(openIds);
    const seen = new Set();
    const grid = saved.grid
      .map(col => (Array.isArray(col) ? col : []).filter(id => {
        if (typeof id !== 'string' || !id || id.length > MAX_ID || seen.has(id) || (open && !open.has(id))) return false;
        seen.add(id);
        return true;
      }).slice(0, MAX_ROWS))
      .filter(col => col.length)
      .slice(0, MAX_COLS);
    return grid.length ? { grid, sizes: fitSizes(grid, saved.sizes) } : null;
  }

  // ------------------------------------------------------------ moving about

  // The pane next to `id` that way: above or below in its column, or in the
  // next column the one level with its middle.
  function neighbor(grid, id, dir) {
    const at = find(grid, id);
    if (!at) return null;
    if (dir === 'up' || dir === 'down') return grid[at.c][at.r + (dir === 'down' ? 1 : -1)] ?? null;
    const col = grid[at.c + (dir === 'right' ? 1 : -1)];
    if (!col) return null;
    const mid = (at.r + 0.5) / grid[at.c].length;
    return col[Math.min(col.length - 1, Math.floor(mid * col.length))];
  }

  // Ctrl+Alt+arrow: where `id` goes. A swap with its neighbour that way; at
  // the left or right edge, a column of its own if it shares one and there's
  // room. -> { target, zone } for place, or null.
  function moveToward(grid, id, dir) {
    const to = neighbor(grid, id, dir);
    if (to) return { target: to, zone: 'center' };
    const at = find(grid, id);
    if (!at || (dir !== 'left' && dir !== 'right') || grid[at.c].length < 2) return null;
    const target = grid[at.c].find(x => x !== id);
    return zones(grid, target, id).includes(dir) ? { target, zone: dir } : null;
  }

  // The weights as fractions for flex-grow: columns summing to 1, and each
  // column's panes summing to 1.
  function shares(grid, sizes) {
    const s = fitSizes(grid, sizes);
    const norm = xs => { const t = xs.reduce((a, b) => a + b, 0); return xs.map(x => x / t); };
    return { cols: norm(grid.map(col => s.w[col[0]])), rows: grid.map(col => norm(col.map(id => s.h[id]))) };
  }

  // px `grid` takes with every pane at MIN, plus `chrome` px per pane each way
  // (borders, gaps, the header).
  function needs(grid, chrome = { width: 0, height: 0 }) {
    const cols = Math.max(1, grid.length);
    const rows = Math.max(1, ...grid.map(col => col.length));
    return { width: cols * (MIN.width + chrome.width), height: rows * (MIN.height + chrome.height) };
  }

  const api = {
    MAX_COLS, MAX_ROWS, MIN, ids, has, keep, remove, find, replace, zones, place, zoneAt, previewRect, layout,
    fitSizes, placeSizes, setWeight, splitPair, even, clean, neighbor, moveToward, needs, shares,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyPanes = api;
})(typeof window !== 'undefined' ? window : globalThis);
