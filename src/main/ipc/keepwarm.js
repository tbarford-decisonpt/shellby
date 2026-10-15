// Keep warm's channels (keepwarm-service.js): the tab strip's button turns it
// on and off, and the panel asks where it is when it opens. Kept out of main.js.

/**
 * @param {Pick<import('electron').IpcMain, 'handle'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC: d.keepWarm, once wireServices has made it
 */
function registerKeepWarmIpc(ipcMain, d) {
  const off = { on: false, endsAt: null, tabs: [] };
  ipcMain.handle('keepwarm:set', (_e, on) => d.keepWarm?.set(!!on) || { ok: false, error: "Keep warm isn't ready yet.", ...off });
  ipcMain.handle('keepwarm:get', () => d.keepWarm?.view() || off);
}

module.exports = { registerKeepWarmIpc };
