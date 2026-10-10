// Conversations side by side in the chat view: up to four columns, each split
// into up to three panes, so anything from one pane to a 4x3 grid, a 4x1 strip
// across a wide screen included. Each pane is a group of tabs, as editor groups
// are in VS Code. The grid is an array of columns, each an array of panes, top
// to bottom; a pane is { id, tabs: [tabId, ...], active }:
//   [[p1]]             one pane
//   [[p1], [p2]]       side by side
//   [[p1, p3], [p2]]   p1 on top of p3, p2 down the right
// A pane's id ('p1', 'p2', ...) is its own for as long as it lives, and every
// open conversation is in exactly one pane. Sizes are weights keyed by pane id,
// so they stay with a pane whichever of its tabs shows: { w: { id: n }, h: { id: n } }.
// Every pane in a column carries the column's width; h is a pane's height
// within its column.
//
// Pure: no DOM, no state. The panel keeps them in SB.state.grid and SB.state.paneSizes.
(function (root) {
  const MAX_COLS = 4;
  const MAX_ROWS = 3;
  const MIN = { width: 280, height: 200 }; // px a pane needs: its header, a few lines, the box
  const EDGE = 0.3;   // share of a pane, from each side, that splits rather than joins
  const MAX_ID = 200; // longer than any history id: junk
  const PANE_ID = /^p[1-9]\d{0,5}$/;
  const EDGES = ['left', 'right', 'top', 'bottom'];

  // ------------------------------------------------------------ reading a grid

  const panesOf = grid => grid.flat();
  const paneIds = grid => panesOf(grid).map(p => p.id);
  const count = grid => panesOf(grid).length;
  // Each pane's tabs in turn: the order main keeps (and openTabs is saved in).
  const tabIds = grid => panesOf(grid).flatMap(p => p.tabs);
  const shownTabs = grid => panesOf(grid).map(p => p.active);
  const byId = (grid, id) => panesOf(grid).find(p => p.id === id) || null;
  const paneWith = (grid, tabId) => panesOf(grid).find(p => p.tabs.includes(tabId)) || null;
  // Which panes there are and the tab each shows: what the pane elements are built from.
  const layoutKey = grid => JSON.stringify(grid.map(col => col.map(p => [p.id, p.active])));

  function find(grid, id) {
    for (let c = 0; c < grid.length; c++) {
      const r = grid[c].findIndex(p => p.id === id);
      if (r >= 0) return { c, r };
    }
    return null;
  }

  function nextId(grid) {
    const n = paneIds(grid).map(id => Number(id.slice(1)) || 0);
    return `p${Math.max(0, ...n) + 1}`;
  }

  // ------------------------------------------------------------ tabs in panes

  const withPane = (grid, id, patch) => grid.map(col => col.map(p => (p.id === id ? { ...p, ...patch } : p)));
  const prune = grid => grid.map(col => col.filter(p => p.tabs.length)).filter(col => col.length);

  // `tabId` out of its pane. A pane showing it shows the next tab, else the
  // one before; a pane left with none closes, and its column if that empties.
  function leave(grid, tabId) {
    const p = paneWith(grid, tabId);
    if (!p) return grid;
    const i = p.tabs.indexOf(tabId);
    const tabs = p.tabs.filter(x => x !== tabId);
    const active = p.active === tabId ? tabs[i] ?? tabs[i - 1] ?? null : p.active;
    return prune(withPane(grid, p.id, { tabs, active }));
  }

  // `tabId` on screen: shown in its pane, or, in no pane yet, joining pane
  // `into` (else the first) after the tab it shows. With no panes, the first.
  function show(grid, tabId, into = null) {
    const own = paneWith(grid, tabId);
    if (own) return own.active === tabId ? grid : withPane(grid, own.id, { active: tabId });
    if (!grid.length) return [[{ id: 'p1', tabs: [tabId], active: tabId }]];
    const p = byId(grid, into) || grid[0][0];
    const tabs = [...p.tabs];
    const at = tabs.indexOf(p.active);
    tabs.splice(at < 0 ? tabs.length : at + 1, 0, tabId);
    return withPane(grid, p.id, { tabs, active: tabId });
  }

  // `tabId` into pane `paneId`, in front of `before` (null: the end). From
  // another pane it shows there (its old pane closes if emptied); along its own
  // pane's strip it only moves. The same grid back when it's no move at all.
  function join(grid, tabId, paneId, before = null) {
    if (!byId(grid, paneId) || before === tabId) return grid;
    const own = paneWith(grid, tabId);
    const same = own?.id === paneId;
    const g = own && !same ? leave(grid, tabId) : grid;
    const target = byId(g, paneId);
    const tabs = target.tabs.filter(x => x !== tabId);
    const at = before === null ? tabs.length : tabs.indexOf(before);
    if (at < 0) return grid;
    tabs.splice(at, 0, tabId);
    if (same && tabs.every((x, i) => x === target.tabs[i])) return grid;
    return withPane(g, paneId, { tabs, active: same ? target.active : tabId });
  }

  // One place along its pane's strip (Ctrl+Shift+PgUp/PgDn), never past its ends.
  function nudge(grid, tabId, step) {
    const p = paneWith(grid, tabId);
    if (!p) return grid;
    const i = p.tabs.indexOf(tabId);
    const j = i + step;
    if (j < 0 || j >= p.tabs.length) return grid;
    const tabs = [...p.tabs];
    [tabs[i], tabs[j]] = [tabs[j], tabs[i]];
    return withPane(grid, p.id, { tabs });
  }

  // A pane's x: it goes, and its tabs move into the pane beside it (above,
  // else below, else level with it to the left, else to the right): in front
  // of that pane's tabs if it came first in reading order, after them if not.
  // When the two sit next to each other in reading order (always so for the
  // pane above or below) every tab keeps its place in tabIds; a level
  // neighbour further off takes them next to its own. -> { grid, into }
  // (into: null when it's the last pane, or not there).
  function merge(grid, paneId) {
    const at = find(grid, paneId);
    if (!at || count(grid) < 2) return { grid, into: null };
    const gone = grid[at.c][at.r];
    const into = grid[at.c][at.r - 1]?.id ?? grid[at.c][at.r + 1]?.id ?? neighbor(grid, paneId, 'left') ?? neighbor(grid, paneId, 'right');
    const order = paneIds(grid);
    const first = order.indexOf(paneId) < order.indexOf(into);
    const out = grid
      .map(col => col.filter(p => p.id !== paneId).map(p => (p.id !== into ? p : { ...p, tabs: first ? [...gone.tabs, ...p.tabs] : [...p.tabs, ...gone.tabs] })))
      .filter(col => col.length);
    return { grid: out, into };
  }

  // Every open conversation in exactly one pane: closed ones leave theirs, and
  // ones in no pane (opened elsewhere, back from a window of their own) join
  // pane `into`, else the first. No panes yet: one with them all.
  function settle(grid, openIds, into = null) {
    const open = new Set(openIds);
    let g = grid;
    for (const id of tabIds(grid)) if (!open.has(id)) g = leave(g, id);
    const missing = openIds.filter(id => !paneWith(g, id));
    if (!missing.length) return g;
    if (!g.length) return [[{ id: 'p1', tabs: [...missing], active: missing[0] }]];
    const target = byId(g, into) || g[0][0];
    return withPane(g, target.id, { tabs: [...target.tabs, ...missing] });
  }

  // One pane holds its tabs in the strip's own order (main's); a split keeps its own.
  function follow(grid, openIds) {
    if (count(grid) !== 1) return grid;
    const p = grid[0][0];
    const tabs = openIds.filter(id => p.tabs.includes(id));
    return tabs.length === p.tabs.length && tabs.every((x, i) => x === p.tabs[i]) ? grid : [[{ ...p, tabs }]];
  }

  // ------------------------------------------------------------ dropping a tab

  // `tabId` into a pane of its own beside `paneId` (zone: an edge).
  function splitOff(grid, tabId, paneId, zone) {
    const id = nextId(grid);
    const g = leave(grid, tabId);
    const at = find(g, paneId);
    if (!at) return grid;
    const fresh = { id, tabs: [tabId], active: tabId };
    if (zone === 'left' || zone === 'right') {
      const out = [...g];
      out.splice(zone === 'left' ? at.c : at.c + 1, 0, [fresh]);
      return out;
    }
    return g.map((col, c) => {
      if (c !== at.c) return col;
      const out = [...col];
      out.splice(zone === 'top' ? at.r : at.r + 1, 0, fresh);
      return out;
    });
  }

  // Where `tabId` can land on pane `paneId`. Worked out as if it had already
  // left its own pane, so a pane's only tab can't split that pane, and pulling
  // one of two stacked panes out to the side is allowed. The middle joins the
  // pane, or, on its own pane, shows it there (not for the tab it already shows).
  function zones(grid, paneId, tabId) {
    const target = byId(grid, paneId);
    if (!target) return [];
    const own = paneWith(grid, tabId);
    const g = own ? leave(grid, tabId) : grid;
    const at = find(g, paneId);
    if (!at) return [];
    const z = [];
    if (own?.id !== paneId || target.active !== tabId) z.push('center');
    if (g.length < MAX_COLS) z.push('left', 'right');
    if (g[at.c].length < MAX_ROWS) z.push('top', 'bottom');
    return z;
  }

  // Drop `tabId` on pane `paneId`. 'strip': it joins there, in front of
  // `before`; the middle: it joins at the end (its own pane: shows it); an
  // edge: it splits off into a pane of its own on that side (a whole column
  // for left and right). The same grid back when refused.
  function place(grid, tabId, paneId, zone, before = null) {
    if (zone === 'strip') return join(grid, tabId, paneId, before);
    if (!zones(grid, paneId, tabId).includes(zone)) return grid;
    if (zone === 'center') return paneWith(grid, tabId)?.id === paneId ? withPane(grid, paneId, { active: tabId }) : join(grid, tabId, paneId);
    return splitOff(grid, tabId, paneId, zone);
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
  // takes half of `view`, the column it splits (see placeSizes); a new row,
  // half of the pane it splits.
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

  // ------------------------------------------------------------ sizes

  const weight = x => (Number.isFinite(x) && x > 0 && x < 1e6 ? x : null);
  // A pane's id; a tab id where a pane goes, until the panel catches up (see the end).
  const idOf = p => (typeof p === 'string' ? p : p.id);
  const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1);

  // Sizes for every pane in `grid`, from `sizes` as far as they go: a column
  // with no width yet gets the others' average, a pane with no height its
  // column's. Ids no longer in the grid, and junk, are dropped.
  function fitSizes(grid, sizes) {
    const w0 = sizes?.w || {}, h0 = sizes?.h || {};
    const colW = grid.map(col => col.map(p => weight(w0[idOf(p)])).find(Boolean) ?? null);
    const avgW = mean(colW.filter(Boolean));
    const out = { w: {}, h: {} };
    grid.forEach((col, c) => {
      const hs = col.map(p => weight(h0[idOf(p)]));
      const avgH = mean(hs.filter(Boolean));
      col.forEach((p, r) => { out.w[idOf(p)] = colW[c] ?? avgW; out.h[idOf(p)] = hs[r] ?? avgH; });
    });
    return out;
  }

  // The sizes once `tabId` is dropped on pane `paneId` (see place). `grid` is
  // the grid before the drop. A split halves the pane, or the column, it
  // splits, and the new pane takes the other half; joining leaves them as they are.
  function placeSizes(grid, sizes, tabId, paneId, zone) {
    const s = fitSizes(grid, sizes);
    if (!EDGES.includes(zone) || !zones(grid, paneId, tabId).includes(zone)) return s;
    const id = nextId(grid);
    const out = { w: { ...s.w }, h: { ...s.h } };
    if (zone === 'left' || zone === 'right') {
      const half = s.w[paneId] / 2;
      for (const p of grid[find(grid, paneId).c]) out.w[p.id] = half;
      out.w[id] = half; out.h[id] = 1;
    } else {
      const half = s.h[paneId] / 2;
      out.h[paneId] = half; out.h[id] = half; out.w[id] = s.w[paneId];
    }
    return out;
  }

  // One column's width (axis 'w', every pane in column c), or one pane's height (axis 'h', grid[c][r]).
  function setWeight(grid, sizes, axis, c, r, w) {
    const s = fitSizes(grid, sizes);
    if (axis === 'w') for (const p of grid[c] || []) s.w[p.id] = w;
    else if (grid[c]?.[r]) s.h[grid[c][r].id] = w;
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
    if (axis === 'w') for (const id of paneIds(grid)) s.w[id] = 1;
    else for (const p of grid[c] || []) s.h[p.id] = 1;
    return s;
  }

  // The weights as fractions for flex-grow: columns summing to 1, and each
  // column's panes summing to 1.
  function shares(grid, sizes) {
    const s = fitSizes(grid, sizes);
    const norm = xs => { const t = xs.reduce((a, b) => a + b, 0); return xs.map(x => x / t); };
    return { cols: norm(grid.map(col => s.w[idOf(col[0])])), rows: grid.map(col => norm(col.map(p => s.h[idOf(p)]))) };
  }

  // px `grid` takes with every pane at MIN, plus `chrome` px per pane each way
  // (borders, gaps, the header).
  function needs(grid, chrome = { width: 0, height: 0 }) {
    const cols = Math.max(1, grid.length);
    const rows = Math.max(1, ...grid.map(col => col.length));
    return { width: cols * (MIN.width + chrome.width), height: rows * (MIN.height + chrome.height) };
  }

  // ------------------------------------------------------------ moving about

  // The pane next to pane `id` that way: above or below in its column, or in
  // the next column the one level with its middle.
  function neighbor(grid, id, dir) {
    const at = find(grid, id);
    if (!at) return null;
    if (dir === 'up' || dir === 'down') return grid[at.c][at.r + (dir === 'down' ? 1 : -1)]?.id ?? null;
    const col = grid[at.c + (dir === 'right' ? 1 : -1)];
    if (!col) return null;
    const mid = (at.r + 0.5) / grid[at.c].length;
    return col[Math.min(col.length - 1, Math.floor(mid * col.length))].id;
  }

  // Ctrl+Alt+arrow: where `tabId` goes. Into the neighbouring pane that way,
  // where it joins; at the left or right edge, a column of its own if it has
  // something to leave (other tabs in its pane, or a pane it shares a column
  // with) and there's room. Up and down stop at the column's ends.
  // -> { target, zone } for place, or null.
  function moveToward(grid, tabId, dir) {
    const own = paneWith(grid, tabId);
    if (!own) return null;
    const to = neighbor(grid, own.id, dir);
    if (to) return { target: to, zone: 'center' };
    if (dir !== 'left' && dir !== 'right') return null;
    const at = find(grid, own.id);
    const target = own.tabs.length > 1 ? own.id : grid[at.c].find(p => p.id !== own.id)?.id;
    return target && zones(grid, target, tabId).includes(dir) ? { target, zone: dir } : null;
  }

  // ------------------------------------------------------------ saving

  // An own property of a plain object, or undefined: never one it inherits.
  const own = (o, k) => (o && typeof o === 'object' && typeof k === 'string' && Object.hasOwn(o, k) ? o[k] : undefined);

  // A layout saved last time, made safe: only the open tab ids (any string id
  // with openIds null), each once, within the caps; a pane's active put right
  // if it's gone; pane ids that aren't pN, or are taken, renewed. A layout
  // saved with one tab per pane (a tab id where a pane goes) reads as panes of
  // one tab each, its sizes kept. null when nothing's left. An id every object
  // already has (__proto__, constructor) is junk: the sizes are plain objects
  // keyed by pane id, and it would read or set their prototype.
  function clean(saved, openIds = null) {
    if (!saved || typeof saved !== 'object' || !Array.isArray(saved.grid)) return null;
    const open = openIds && new Set(openIds);
    const seenTabs = new Set();
    const okTab = id => typeof id === 'string' && !!id && id.length <= MAX_ID && !(id in Object.prototype) && !seenTabs.has(id) && (!open || open.has(id));
    const keyOf = new Map();   // a pane -> what its sizes were saved under
    const toPane = entry => {
      const old = typeof entry === 'string';
      const raw = old ? { tabs: [entry], active: entry } : entry;
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tabs)) return null;
      const tabs = raw.tabs.filter(id => { if (!okTab(id)) return false; seenTabs.add(id); return true; });
      if (!tabs.length) return null;
      const pane = { id: old ? null : raw.id, tabs, active: tabs.includes(raw.active) ? raw.active : tabs[0] };
      keyOf.set(pane, old ? entry : raw.id);
      return pane;
    };
    const grid = saved.grid
      .map(col => (Array.isArray(col) ? col : []).map(toPane).filter(Boolean).slice(0, MAX_ROWS))
      .filter(col => col.length)
      .slice(0, MAX_COLS);
    if (!grid.length) return null;
    const ids = new Set();
    for (const p of grid.flat()) {
      if (typeof p.id === 'string' && PANE_ID.test(p.id) && !ids.has(p.id)) ids.add(p.id);
      else { if (p.id !== null) keyOf.set(p, null); p.id = null; }
    }
    let n = Math.max(0, ...[...ids].map(id => Number(id.slice(1))));
    for (const p of grid.flat()) if (!p.id) p.id = `p${++n}`;
    const src = { w: {}, h: {} };
    for (const p of grid.flat()) {
      src.w[p.id] = own(saved.sizes?.w, keyOf.get(p));
      src.h[p.id] = own(saved.sizes?.h, keyOf.get(p));
    }
    return { grid, sizes: fitSizes(grid, src) };
  }

  // ------------------------------------------------------------ until the panel catches up
  // tab-panes.js keeps a grid of tab ids until it moves to panes; these read
  // either shape (a pane counts as the tab it shows), so one pane runs as it
  // always has in between. Deleted with the callers.
  const shownIn = x => (typeof x === 'string' ? x : x.active);
  const ids = grid => grid.flat().map(shownIn);
  const has = (grid, id) => ids(grid).includes(id);
  const keep = (grid, ok) => grid.map(col => col.map(shownIn).filter(ok)).filter(col => col.length);
  const remove = (grid, id) => keep(grid, x => x !== id);
  function replace(grid, oldId, id) {
    if (has(grid, id)) return grid;
    if (!grid.length) return [[id]];
    let at = { c: 0, r: 0 };
    grid.forEach((col, c) => col.forEach((x, r) => { if (shownIn(x) === oldId) at = { c, r }; }));
    return grid.map((col, c) => col.map((x, r) => (c === at.c && r === at.r ? id : shownIn(x))));
  }

  const api = {
    MAX_COLS, MAX_ROWS, MIN,
    paneIds, count, tabIds, shownTabs, byId, paneWith, find, nextId, layoutKey,
    leave, show, join, nudge, merge, settle, follow,
    zones, place, zoneAt, previewRect,
    fitSizes, placeSizes, setWeight, splitPair, even, shares, needs,
    neighbor, moveToward, clean,
    ids, has, keep, remove, replace, // until the panel catches up
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyPanes = api;
})(typeof window !== 'undefined' ? window : globalThis);
