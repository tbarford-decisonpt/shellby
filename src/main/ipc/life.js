// His life between tasks: the Us and Finds pages (life.js), looking after him
// (care.js), games (playtime.js), the homes he moves into, and his XP.
// Kept out of main.js, which only wires it up.
const { dialog, shell } = require('electron');
const os = require('os');
const { sendToBottom } = require('../desktop-layer');
const { registerProjectsIpc } = require('../projects/ipc');
const shells = require('../shells');

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerLifeIpc(ipcMain, d) {
  // ---- his life between tasks: the Us and Finds pages (life.js), and games (playtime.js)
  ipcMain.handle('life:get', () => d.life?.view() || null);
  ipcMain.handle('life:birthday', (_e, bd) => d.life?.setBirthday(bd && typeof bd === 'object' ? { m: Number(bd.m), d: Number(bd.d) } : null) || null);
  ipcMain.handle('life:favourite', (_e, id) => d.life?.setFavourite(typeof id === 'string' ? id.slice(0, 40) : null) || null);
  ipcMain.on('life:finds-seen', () => d.life?.findsSeen());
  ipcMain.handle('life:play', (_e, kind) => {
    if (!d.life || !d.playtime) return { ok: false, error: 'Not ready yet.' };
    if (kind === 'hide') return d.playtime.startHide();
    if (kind === 'fetch') return d.playtime.startFetch();
    if (kind === 'dig') return d.life.digNow() ? { ok: true } : { ok: false, error: 'He dug not long ago. Give the sand a rest.' };
    if (kind === 'stop') { d.playtime.stop('aww, ok'); return { ok: true }; }
    return { ok: false, error: 'Unknown game.' };
  });
  // Looking after him (care.js): the Us page's Feed, Rinse and Tuck in.
  const careResult = r => ({ ...r, life: d.life?.view() || null });
  ipcMain.handle('needs:feed', (_e, kind) => (d.life ? careResult(d.life.feed(typeof kind === 'string' ? kind.slice(0, 12) : null)) : { ok: false, error: 'Not ready yet.' }));
  ipcMain.handle('needs:rinse', () => (d.life ? careResult(d.life.rinse()) : { ok: false, error: 'Not ready yet.' }));
  ipcMain.handle('needs:tuck', () => (d.life ? careResult(d.life.tuckIn()) : { ok: false, error: 'Not ready yet.' }));
  ipcMain.on('needs:intro-seen', () => d.life?.needsIntroSeen());
  // The pebble for fetch: its own window and bridge (toy-preload.js), dragged like he is.
  ipcMain.on('toy:drag-start', () => d.playtime?.toyDragStart());
  ipcMain.on('toy:drag-move', () => d.playtime?.toyDragMove()); // follows the real cursor, like he does
  ipcMain.on('toy:drag-end', () => d.playtime?.toyDragEnd());
  ipcMain.on('critter:click', () => {
    if (d.playtime?.found()) return; // hide and seek: you found him
    // "auth.spec flaked 3 times this week": a click goes to the list that says which.
    if (d.said?.occasion === 'flaky' && d.said.until > Date.now()) { d.wake(); d.reachedForShellby(); d.showFlaky(); sendToBottom(d.critter); return; }
    d.wake(); d.togglePanel(); sendToBottom(d.critter); // sendToBottom leaves a perched crab be
  });
  ipcMain.on('critter:crew-click', (_e, tabId) => { if (d.isStr(tabId)) { d.reachedForShellby(); d.showPanel({ focusInput: false, tabId }); } });
  // The badge for background work: straight to the list that says what it was.
  ipcMain.on('critter:bg-click', () => {
    d.reachedForShellby();
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'panel:view', 'settings');
    d.send(d.panel, 'panel:jump', 'Everywhere');
  });
  // The dev server pill or sign on the crab: that server's card.
  ipcMain.on('critter:servers-click', () => { d.reachedForShellby(); d.showServer(); });
  registerProjectsIpc(ipcMain, {
    projects: () => d.projects,
    devServers: () => d.devServers,
    pickFolder: async ({ title, defaultPath }) => {
      const r = await dialog.showOpenDialog(d.panel, { title, defaultPath: defaultPath || os.homedir(), properties: ['openDirectory'] });
      return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    },
    toPanel: (channel, payload) => d.send(d.panel, channel, payload),
    openPath: p => shell.openPath(p),
    showItem: p => shell.showItemInFolder(p),
    openExternal: url => shell.openExternal(url),
  });
  ipcMain.on('critter:menu', () => {
    d.reachedForShellby();
    d.buildMenu() // async: it checks the clipboard for a screenshot first
      .then(menu => menu.popup({ window: d.critter }))
      .catch(e => d.log.warn("couldn't open the crab's menu", e?.message));
  });
  ipcMain.on('critter:drop', (_e, paths) => {
    d.reachedForShellby();
    const files = (Array.isArray(paths) ? paths : []).filter(d.isStr).slice(0, 20);
    if (!files.length) return;
    d.stat('files-dropped');
    d.showPanel();
    d.send(d.panel, 'panel:attach', files);
  });

  // ---- XP and levels
  ipcMain.handle('xp:get', () => d.xpView());

  // ---- shells (homes he moves into as he levels up)
  ipcMain.handle('homes:get', () => d.homesView());
  ipcMain.handle('homes:wear', (_e, id) => {
    if (!d.isStr(id) || !shells.unlockedAt(id, d.currentLevel())) return { ok: false, error: 'He has to grow into that shell first.', view: d.homesView() };
    d.config.set({ home: { ...shells.normalizeHome(d.config.get('home')), worn: id } });
    d.broadcastSkin();
    d.send(d.panel, 'stickers', d.stickersView());
    return { ok: true, view: d.homesView() };
  });
  ipcMain.on('homes:seen', (_e, ids) => {
    if (!Array.isArray(ids)) return;
    const h = shells.normalizeHome(d.config.get('home'));
    const seen = [...new Set([...h.seen, ...ids.filter(d.isStr)])];
    if (seen.length !== h.seen.length) d.config.set({ home: shells.normalizeHome({ ...h, seen }) });
  });
}

module.exports = { registerLifeIpc };
