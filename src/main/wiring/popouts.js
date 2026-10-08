// A conversation in a window of its own. Dragged out of the panel (or sent out
// with its button), a tab gets a window showing the same panel page with just
// that conversation (the renderer's SB.solo), so it can be snapped, maximized
// or put on another screen. The panel drops the tab while it's out; closing the
// window hands it back. Never saved: a restart brings every conversation back
// into the panel. Kept out of main.js, which only wires it up.
const { BrowserWindow, app } = require('electron');
const path = require('path');
const { clampToDisplays } = require('../placement');

const PANEL_DEFAULT = { width: 460, height: 700 };
const MIN = { width: 360, height: 420 };
// Dropped outside the panel: the window's title bar lands under the pointer.
const GRAB = { x: 120, y: 18 };
// From the button: a step down and right of the panel, so it's plainly a new window.
const STEP = 36;
const MAX_QUEUED = 20;
const MAX_FILES = 20;

/**
 * Typed-but-unsent words that travel with a conversation between windows:
 * the box, its attachments, and the queue behind a running turn (with the ids
 * main's steering knows them by). Anything else is dropped. Pure.
 */
function cleanCarry(c, { maxText = 50000, isStr = s => typeof s === 'string' && s.length > 0 && s.length < 10000 } = {}) {
  if (!c || typeof c !== 'object') return null;
  const files = a => (Array.isArray(a) ? a.filter(isStr).slice(0, MAX_FILES) : []);
  return {
    draft: typeof c.draft === 'string' ? c.draft.slice(0, maxText) : '',
    attachments: files(c.attachments),
    turnId: isStr(c.turnId) && c.turnId.length <= 64 ? c.turnId : null,
    queue: (Array.isArray(c.queue) ? c.queue : []).slice(0, MAX_QUEUED)
      .filter(m => m && typeof m.text === 'string' && isStr(m.id) && m.id.length <= 64)
      .map(m => ({ id: m.id, text: m.text.slice(0, maxText), attachments: files(m.attachments), ...(m.taken === true ? { taken: true } : {}) })),
  };
}

/** d: what main shares (main.js `shared`). */
function wirePopouts(d) {
  const popouts = new Map();  // tabId -> BrowserWindow
  const carries = new Map();  // tabId -> cleanCarry(), on its way between windows

  const isPoppedOut = tabId => popouts.has(tabId);
  // The window a tab's live items go to.
  const tabWindow = tabId => popouts.get(tabId) || d.panel;
  // For ipc-guard.js: a popped-out window is the panel's own page, with its bridge.
  const isPopout = wc => [...popouts.values()].some(w => !w.isDestroyed() && w.webContents === wc);
  const popoutTabOf = wc => [...popouts].find(([, w]) => !w.isDestroyed() && w.webContents === wc)?.[0] || null;

  function setCarry(tabId, carry) {
    const c = cleanCarry(carry, { maxText: d.PANEL_MAX_TEXT, isStr: d.isStr });
    if (c) carries.set(tabId, c); else carries.delete(tabId);
  }
  function takeCarry(tabId) {
    const c = carries.get(tabId) || null;
    carries.delete(tabId);
    return c;
  }

  function popOut(tabId, { x, y } = {}) {
    if (!d.manager.tabs.has(tabId)) return false;
    if (popouts.has(tabId)) { showPopout(tabId); return true; }
    const size = d.config.get('panelSize') || PANEL_DEFAULT;
    const at = Number.isFinite(x) && Number.isFinite(y)
      ? { x: Math.round(x) - GRAB.x, y: Math.round(y) - GRAB.y }
      : (() => { const [px, py] = d.panel.getPosition(); return { x: px + STEP, y: py + STEP }; })();
    const bounds = clampToDisplays({ ...at, ...size }, d.workAreas(), 0);
    const win = new BrowserWindow({
      ...bounds, minWidth: MIN.width, minHeight: MIN.height,
      show: false, frame: false, backgroundColor: '#0c1719', title: d.manager.tabs.get(tabId).title || 'Shellby', icon: d.ICON, webPreferences: d.webPreferences,
    });
    d.secureWindow(win);
    popouts.set(tabId, win);
    win.loadFile(path.join(d.RENDERER, 'panel', 'panel.html'), { query: { popout: tabId } });
    win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(d.config.get('panelZoom') || 1)); // the panel's zoom (ipc/files.js)
    win.once('ready-to-show', () => { win.show(); win.focus(); });
    win.on('closed', () => {
      if (popouts.get(tabId) !== win) return; // closed with its conversation: nothing to hand back
      popouts.delete(tabId);
      if (app.isQuitting || !d.manager.tabs.has(tabId)) { carries.delete(tabId); return; }
      const summary = d.manager.summary.find(t => t.id === tabId);
      d.send(d.panel, 'tab:returned', { summary, items: d.history.load(tabId), carry: takeCarry(tabId) });
      sendTabs();
      if (win.backToPanel) d.showPanel({ tabId });
    });
    return true;
  }

  function showPopout(tabId) {
    const win = popouts.get(tabId);
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }

  // Its own × (tab:pop-in): back into the panel, and the panel comes forward with it.
  function popIn(tabId) {
    const win = popouts.get(tabId);
    if (!win || win.isDestroyed()) return;
    win.backToPanel = true;
    win.close();
  }

  // The conversation itself closed: its window goes too, handing nothing back.
  function closePopout(tabId) {
    const win = popouts.get(tabId);
    if (!win) return;
    popouts.delete(tabId);
    carries.delete(tabId);
    if (!win.isDestroyed()) win.destroy();
  }

  // The panel and every popped-out conversation, for what isn't one tab's:
  // the usage meter, the outlook, the zoom.
  const everyWindow = () => [d.panel, ...popouts.values()].filter(w => w && !w.isDestroyed());
  function sendEveryWindow(channel, payload) {
    for (const win of everyWindow()) d.send(win, channel, payload);
  }

  // Every window hears about every tab; the panel leaves out the ones marked `popped`.
  function sendTabs(summary = d.manager.summary) {
    for (const id of popouts.keys()) if (!d.manager.tabs.has(id)) closePopout(id);
    const list = summary.map(t => (popouts.has(t.id) ? { ...t, popped: true } : t));
    d.send(d.panel, 'tabs', list);
    for (const win of popouts.values()) d.send(win, 'tabs', list);
  }

  return { closePopout, everyWindow, isPoppedOut, isPopout, popIn, popOut, popoutTabOf, sendEveryWindow, sendTabs, setCarry, showPopout, tabWindow, takeCarry };
}

module.exports = { wirePopouts, cleanCarry };
