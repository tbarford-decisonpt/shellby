/* Shellby panel — zooming a pane, and layouts you name (a project's own
   among them). The panes themselves are tab-panes.js; the shapes are
   shared/panes.js (shapeOf, fromShape), and main keeps the list
   (ipc/tabs.js panes:shapes). */
'use strict';
(function () {
  const { api, state, $ } = SB;
  const P = SB.panes;
  const focusedPane = () => SB.focusedPane();
  const activeOf = paneId => P.byId(state.grid, paneId)?.active ?? null;
  const paneRow = () => $('feeds').querySelector(':scope > .pane-row') || $('feeds');

  // ------------------------------------------------------------ zoom

  // One pane fills the chat for a while (Ctrl+Alt+Enter, or its header's
  // button) and the others wait, hidden, as they were. Only the focused pane
  // zooms: the box is there. Focusing another pane (a click, Alt+arrow, a tab
  // from Every conversation), splitting, a drop or the grid going down to one
  // pane brings the rest back.
  state.zoomPane = null;
  function applyZoom() {
    const panes = SB.paneEls;
    if (state.zoomPane && (panes.size < 2 || state.zoomPane !== focusedPane())) state.zoomPane = null;
    const z = state.zoomPane;
    $('feeds').classList.toggle('pane-zoomed', !!z);
    for (const [id, p] of panes) {
      p.el.classList.toggle('zoomed', id === z);
      p.head.querySelector('.pane-zoom')?.setAttribute('aria-pressed', String(id === z));
    }
    const col = z ? panes.get(z)?.el.parentElement : null;
    for (const c of paneRow().querySelectorAll(':scope > .pane-col')) c.classList.toggle('zoomed-col', c === col);
  }
  function unzoom() {
    if (!state.zoomPane) return;
    state.zoomPane = null;
    SB.refreshPaneHeads(); // applyZoom, and the headers that say what needs you
  }
  // -> zoomed now?
  SB.toggleZoom = () => {
    if (SB.solo || state.view !== 'chat') return false;
    if (state.zoomPane) { unzoom(); return false; }
    if (SB.paneEls.size < 2) { SB.toast('Zoom is for side by side: split first (Ctrl+\\).'); return false; }
    state.zoomPane = focusedPane();
    SB.refreshPaneHeads(); // applyZoom, and the headers that say what needs you
    return !!state.zoomPane;
  };
  // A header's button: that pane takes the focus first, so it's the one that fills the chat.
  SB.zoomFrom = (paneId) => {
    if (state.zoomPane === paneId) return unzoom();
    const id = activeOf(paneId);
    if (id && id !== state.activeTab) SB.activate(id);
    if (focusedPane() === paneId) { state.zoomPane = paneId; SB.refreshPaneHeads(); }
  };

  // ------------------------------------------------------------ layouts you name

  // Shapes only (shared/panes.js shapeOf): using one puts the conversations
  // open now into it, with new ones for any pane short. Main keeps the list
  // (ipc/tabs.js panes:shapes); state.paneShapes is the copy the palette reads.
  state.paneShapes = [];
  const loadShapes = list => { state.paneShapes = Array.isArray(list) ? list : []; };
  // Once they're in, the conversation on screen may be in a project with one of its own.
  if (!SB.solo) api.paneShapes?.().then(list => { loadShapes(list); lastProject = null; SB.offerProjectLayout(); }, () => {});

  // How a shape reads in a list: "3 columns, 4 panes".
  SB.shapeSummary = shape => {
    const n = shape.cols.reduce((a, c) => a + c.rows.length, 0);
    return `${shape.cols.length} column${shape.cols.length === 1 ? '' : 's'}, ${n} panes`;
  };

  // The split as it is now, under `name` (a layout already by that name is replaced).
  SB.saveLayout = async (name) => {
    if (SB.solo || P.count(state.grid) < 2) return SB.toast('Split first: a layout is two panes or more.');
    const taken = new Set(state.paneShapes.map(s => s.name.toLowerCase()));
    let n = state.paneShapes.length + 1;
    while (!name && taken.has(`layout ${n}`)) n++;
    const named = String(name || `Layout ${n}`).trim().slice(0, 40);
    const shape = P.shapeOf(state.grid, state.paneSizes, named);
    const rest = state.paneShapes.filter(s => s.name.toLowerCase() !== named.toLowerCase());
    if (rest.length >= P.MAX_SHAPES) return SB.toast(`${P.MAX_SHAPES} layouts is as many as there are. Forget one first.`);
    loadShapes(await api.paneShapes([...rest, shape]));
    SB.toast(`Saved the "${named}" layout: ${SB.shapeSummary(shape)}.`);
  };

  SB.forgetLayout = async (name) => {
    loadShapes(await api.paneShapes(state.paneShapes.filter(s => s.name !== name)));
    SB.toast(`Forgot the "${name}" layout.`);
  };

  // A new conversation for a layout's pane, not yet shown: in `cwd`, or the usual folder. -> its id.
  async function freshIn(cwd) {
    if (!cwd) return (await SB.newTab({ focus: false, reuse: false }))?.id;
    const r = await api.newTab({ cwd });
    if (!r?.ok) { SB.toast(r?.error || "Couldn't open a new conversation."); return null; }
    SB.ensureTab({ id: r.tabId, title: 'New task', cwd });
    return r.tabId;
  }

  // ------------------------------------------------------------ a project's own layout

  // The project a conversation is in, as its folder: the one it was started in,
  // not its own copy's. A project's layout is kept under it (panes.projectKey).
  const folderOf = tab => tab?.worktree?.originalCwd || tab?.cwd || state.cwd || '';
  SB.projectOf = tab => P.projectKey(folderOf(tab));
  SB.projectName = tab => folderOf(tab).split(/[\\/]/).filter(Boolean).pop() || 'this project';
  SB.projectLayout = (tab = SB.activeTab()) => {
    const key = tab && SB.projectOf(tab);
    return (key && state.paneShapes.find(s => s.project === key)) || null;
  };

  // The split as it is now, as the project's own layout, replacing the one it had.
  SB.saveProjectLayout = async () => {
    const tab = SB.activeTab();
    if (SB.solo || !tab || P.count(state.grid) < 2) return SB.toast('Split first: a layout is two panes or more.');
    const project = SB.projectOf(tab);
    const name = SB.projectName(tab).slice(0, 40);
    const shape = { ...P.shapeOf(state.grid, state.paneSizes, name), project };
    const rest = state.paneShapes.filter(s => s.project !== project && s.name.toLowerCase() !== name.toLowerCase());
    if (rest.length >= P.MAX_SHAPES) return SB.toast(`${P.MAX_SHAPES} layouts is as many as there are. Forget one first.`);
    loadShapes(await api.paneShapes([...rest, shape]));
    SB.toast(`${name}'s layout: ${SB.shapeSummary(shape)}. Go to ${name} with the panel in one pane and it's offered.`, { ms: 7000 });
  };

  // Going to a conversation in another project, with the panel in one pane:
  // that project's layout, if it has one, is offered once a session.
  let lastProject = null;
  const offered = new Set();
  SB.offerProjectLayout = () => {
    const tab = SB.activeTab();
    if (SB.solo || !tab || state.view !== 'chat') return;
    const key = SB.projectOf(tab);
    if (key === lastProject) return;
    lastProject = key;
    const shape = SB.projectLayout(tab);
    if (!shape || P.count(state.grid) > 1 || offered.has(key)) return;
    offered.add(key);
    SB.toast(`${shape.name} has a layout of its own: ${SB.shapeSummary(shape)}.`, { action: 'Lay it out', onAction: () => SB.useLayout(shape), ms: 9000 });
  };

  // The conversations open now, put into `shape`. Room first (the window grows
  // if it can), then a new conversation for each pane short, then the grid.
  // The one you're typing to keeps the box. -> used?
  // A project's own layout: its conversations open now take the first panes,
  // one each (the one you're in first), and new ones open in its folder.
  SB.useLayout = async (shape) => {
    if (SB.solo || !shape || !(await SB.chatShowing())) return false;
    unzoom();
    const here = SB.activeTab();
    const lead = shape.project
      ? [...new Set([state.activeTab, ...P.tabIds(state.grid)])].filter(id => state.tabs.has(id) && SB.projectOf(state.tabs.get(id)) === shape.project)
      : [];
    const cwd = shape.project ? (SB.projectOf(here) === shape.project ? folderOf(here) : shape.project) : null;
    const need = P.shapeNeeds(shape, state.grid, lead);
    const dry = P.fromShape(shape, state.grid, Array.from({ length: need }, (_, i) => `(new ${i})`), lead);
    const asSaved = SB.roomFor(dry.grid, dry.sizes);
    const room = asSaved.ok ? asSaved : SB.roomFor(dry.grid);
    if (!room.ok) { SB.toast(SB.NO_ROOM); return false; }
    if (room.want) await api.fitPanel(room.want);
    const fresh = [];
    for (let i = 0; i < need; i++) {
      const id = await freshIn(cwd);
      if (id) fresh.push(id);
    }
    const next = P.fromShape(shape, state.grid, fresh, lead);
    if (!next) { for (const id of fresh) SB.closeTab(id); SB.toast("Couldn't open the conversations that layout needs."); return false; }
    const keep = state.activeTab;
    state.grid = next.grid;
    state.paneSizes = room.space ? SB.atLeastMin(next.grid, next.sizes, room.space) : next.sizes;
    SB.activate(state.tabs.has(keep) ? keep : P.shownTabs(next.grid)[0]);
    if (need) SB.toast(`"${shape.name}": ${need} new conversation${need === 1 ? '' : 's'} for the panes short.`);
    return true;
  };
  SB.applyZoom = applyZoom;
  SB.unzoom = unzoom;
})();
