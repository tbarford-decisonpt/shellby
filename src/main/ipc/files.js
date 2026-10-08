// File links and the panel's zoom: opening a path from a conversation in your
// editor (filelinks.js), which editors there are, and Ctrl+= / Ctrl+-.
// Kept out of main.js, which only wires it up.
const { app, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const links = require('../filelinks');

const ZOOM_STEPS = [0.8, 0.9, 1, 1.1, 1.25, 1.4, 1.5];
// VS Code and friends register a URL scheme when they install.
const isInstalled = scheme => !!app.getApplicationNameForProtocol(`${scheme}://`);

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerFilesIpc(ipcMain, d) {
  const tabCwd = tabId => (d.isStr(tabId) && d.manager.tabs.get(tabId)?.session.cwd) || d.currentCwd();

  // Only a file that's there, and never one that would run: see filelinks.js.
  ipcMain.handle('file:open', async (_e, { tabId, target, line, reveal } = {}) => {
    const t = links.parseTarget(target, tabCwd(tabId));
    if (!t) return { ok: false, error: "That doesn't look like a file." };
    let st;
    try { st = await fs.promises.stat(t.file); } catch { return { ok: false, error: `Couldn't find ${path.basename(t.file)}.` }; }
    if (Number.isInteger(line) && line > 0) t.line = line;
    if (reveal) { shell.showItemInFolder(t.file); return { ok: true, how: 'folder' }; }
    const id = links.pickEditor(d.config.get('editor'), isInstalled);
    if (id) {
      shell.openExternal(links.editorUrl(id, t.file, st.isFile() ? t.line : null, st.isFile() ? t.col : null));
      return { ok: true, how: links.EDITORS[id].label };
    }
    if (st.isFile() && links.runsWhenOpened(t.file)) { shell.showItemInFolder(t.file); return { ok: true, how: 'folder' }; }
    const err = await shell.openPath(t.file);
    return err ? { ok: false, error: err } : { ok: true, how: 'default' };
  });

  ipcMain.handle('editors:get', () => {
    const using = links.pickEditor(d.config.get('editor'), isInstalled);
    return {
      choice: d.config.get('editor'),
      installed: Object.keys(links.EDITORS).filter(id => isInstalled(links.EDITORS[id].scheme)),
      using: using ? links.EDITORS[using].label : null,
    };
  });

  ipcMain.handle('panel:zoom', (_e, step) => {
    const wc = d.panel.webContents;
    const now = wc.getZoomFactor();
    const at = ZOOM_STEPS.reduce((best, z, i) => (Math.abs(z - now) < Math.abs(ZOOM_STEPS[best] - now) ? i : best), 0);
    const next = step === 0 ? 1 : ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, at + Math.sign(Number(step) || 0)))];
    wc.setZoomFactor(next);
    d.config.set({ panelZoom: next });
    return next;
  });
}

module.exports = { registerFilesIpc, ZOOM_STEPS };
