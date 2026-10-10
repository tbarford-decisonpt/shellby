// Debug mode's IPC (wiring/debug-mode.js): /debug starts it, and the card's
// buttons move it on. Each message to Claude goes from one of these, pressed
// by you; the panel names a debug session by the id main gave it.
// Kept out of main.js, which only wires it up.

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerDebugIpc(ipcMain, d) {
  const isId = v => typeof v === 'string' && v.length > 0 && v.length <= 80;
  const off = { ok: false, error: 'Debug mode isn\'t ready yet.' };
  ipcMain.handle('debug:start', (_e, { tabId, bug } = {}) => {
    if (!isId(tabId)) return { ok: false, error: 'That conversation is closed.' };
    return d.debugMode ? d.debugMode.start(tabId, typeof bug === 'string' ? bug : '') : off;
  });
  // what: 'send' (what was logged), 'fixed' (take the logging out), 'again' (what's left), 'stop'.
  ipcMain.handle('debug:act', (_e, { id, what } = {}) => {
    if (!isId(id) || !d.debugMode) return off;
    if (what === 'send') return d.debugMode.sendLogs(id);
    if (what === 'fixed') return d.debugMode.fixed(id);
    if (what === 'again') return d.debugMode.again(id);
    if (what === 'stop') return d.debugMode.stop(id);
    return { ok: false, error: 'Unknown step.' };
  });
  ipcMain.handle('debug:status', (_e, id) => (isId(id) && d.debugMode ? d.debugMode.status(id) : null));
}

module.exports = { registerDebugIpc };
