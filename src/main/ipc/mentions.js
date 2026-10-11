// @ mentions for Shellby's own context (wiring/mention-context.js): the @
// menu's list, and a pick's snapshot. The panel names an item by the id the
// list gave it; main finds it again among that tab's own items, so a made-up
// id or another project's conversation gets nothing.
// Kept out of main.js, which only wires it up.

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerMentionsIpc(ipcMain, d) {
  const isStr = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
  ipcMain.handle('context:suggest', async (_e, { tabId, query } = {}) => {
    if (!isStr(tabId, 80) || !d.mentionContext) return [];
    try { return await d.mentionContext.suggest(tabId, typeof query === 'string' ? query.slice(0, 200) : ''); } catch { return []; }
  });
  ipcMain.handle('context:attach', async (_e, { tabId, id } = {}) => {
    if (!isStr(tabId, 80) || !isStr(id, 300) || !d.mentionContext) return { ok: false, error: 'Nothing to attach.' };
    try { return await d.mentionContext.attach(tabId, id); } catch (err) { return { ok: false, error: err.message }; }
  });
}

module.exports = { registerMentionsIpc };
