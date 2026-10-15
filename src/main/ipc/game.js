// The game screens' one bridge (game-hub.js): game:get reads a view, game:act
// changes one. Names outside the hub's list, and actions that aren't short
// lowercase words, come back null.
const { ACTION_RE, isView } = require('../game-hub');

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps): d.gameHub
 */
function registerGameIpc(ipcMain, d) {
  ipcMain.handle('game:get', (_e, what, arg) => (isView(what) ? d.gameHub.get(what, arg) : null));
  ipcMain.handle('game:act', (_e, what, action, payload) => {
    if (!isView(what) || typeof action !== 'string' || !ACTION_RE.test(action)) return null;
    return d.gameHub.act(what, action, payload);
  });
}

module.exports = { registerGameIpc };
