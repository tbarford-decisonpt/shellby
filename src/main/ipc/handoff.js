// Moving a conversation between Shellby and a terminal (wiring/handoff.js).
// Kept out of main.js, which only wires it up.

/** d: what main shares (main.js `shared`); d.handoff is wireHandoff's. */
function registerHandoffIpc(ipcMain, d) {
  // A tab, or a History row that may not be open.
  ipcMain.handle('handoff:terminal', (_e, id) => (d.isStr(id) ? d.handoff.continueInTerminal(id) : { ok: false, error: 'Which conversation?' }));
  ipcMain.handle('handoff:pickup', (_e, tabId) => (d.isStr(tabId) ? d.handoff.pickUp(tabId) : { ok: false, error: 'Which conversation?' }));
  // An outside session, by its Claude Code id. force: you've said it's closed there.
  ipcMain.handle('handoff:bring', (_e, { id, force } = {}) => d.handoff.bringIn({ id: d.isStr(id) ? id : null, force: force === true }));
}

module.exports = { registerHandoffIpc };
