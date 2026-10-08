// The Crew page (wiring/crew.js, crew-roster.js): the roster, renaming a crew
// member and picking its hat. Kept out of main.js, which only wires it up.

const isType = t => typeof t === 'string' && t.trim().length > 0 && t.length <= 200;

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerCrewIpc(ipcMain, d) {
  ipcMain.handle('crew:get', () => d.crewRoster?.view() || null);
  ipcMain.handle('crew:rename', (_e, type, name) => (isType(type) && typeof name === 'string' ? d.crewRoster?.rename(type, name.slice(0, 200)) : null) || null);
  ipcMain.handle('crew:hat', (_e, type, hat) => (isType(type) && typeof hat === 'string' ? d.crewRoster?.setHat(type, hat.slice(0, 60)) : null) || null);
}

module.exports = { registerCrewIpc };
