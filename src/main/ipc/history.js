// History's IPC: listing, opening, renaming and ticking off conversations,
// Recently deleted, and Clear all history. Kept out of main.js, which only
// wires it up.
const isStr = s => typeof s === 'string' && s.length > 0 && s.length < 10000;

/**
 * d: {
 *   history                       history.js's store
 *   manager                       the tab manager (tabs, close, rename)
 *   openTab({ tabId, historyEntry })
 *   isPoppedOut(id), showPopout(id)   a conversation in a window of its own (wiring/popouts.js)
 *   confirmClear(count, openCount) -> Promise<boolean>   asks first, Cancel by default
 *   onCleared()                   optional: what else goes with Clear all history (the per-turn ledger)
 *   log
 * }
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d
 */
function registerHistoryIpc(ipcMain, d) {
  const { history, manager } = d;

  ipcMain.handle('session:list', () => history.list());
  ipcMain.handle('session:open', (_e, id) => {
    const entry = isStr(id) && history.get(id);
    if (!entry) return null;
    // Already out in a window of its own: that window comes forward instead.
    if (d.isPoppedOut?.(id)) { d.showPopout(id); return { popped: true }; }
    if (!manager.tabs.has(id)) {
      try { d.openTab({ tabId: id, historyEntry: entry }); } catch (err) { return { error: err.message }; }
    }
    return { tabId: id, entry, items: history.load(id) };
  });
  // Deleting from History is a move to Recently deleted, not the end: the
  // transcript stays until it's restored, purged, or TRASH_DAYS pass.
  ipcMain.handle('session:delete', (_e, id) => {
    if (!isStr(id)) return history.list();
    manager.close(id);
    history.trash(id);
    return history.list();
  });
  ipcMain.handle('session:trash', () => history.trashed());
  // Answers with both lists: the row leaves one and lands in the other.
  ipcMain.handle('session:restore', (_e, id) => {
    if (isStr(id)) history.restore(id);
    return { sessions: history.list(), trash: history.trashed() };
  });
  // One id, or none for Empty bin.
  ipcMain.handle('session:purge', (_e, id) => {
    history.purge(isStr(id) ? [id] : null);
    return history.trashed();
  });
  // Clear all history. There's no undo after this, so it asks first, with
  // Cancel as the default, the way signing out with tasks running does.
  ipcMain.handle('session:clear', async () => {
    const count = history.list().length + history.trashed().length;
    const answer = (cleared) => ({ cleared, sessions: history.list(), trash: history.trashed() });
    if (!count) return answer(false);
    const open = history.list().filter(e => manager.tabs.has(e.id));
    if (!(await d.confirmClear(count, open.length))) return answer(false);
    for (const e of open) manager.close(e.id);
    const gone = history.clear();
    d.onCleared?.();
    d.log.info('history cleared', `${gone} conversation${gone === 1 ? '' : 's'}`);
    return answer(true);
  });
  // Both of these answer with the fresh list, so the renderer redraws History
  // from one round trip instead of guessing what changed.
  ipcMain.handle('session:done', (_e, { id, done } = {}) => {
    if (isStr(id)) history.setDone(id, !!done);
    return history.list();
  });
  // From the tab strip or a History row. An open tab goes through the manager so
  // its strip, notifications and (if not yet sent anything) first save agree.
  ipcMain.handle('session:rename', (_e, { id, title } = {}) => {
    if (isStr(id) && isStr(title)) {
      if (manager.tabs.has(id)) manager.rename(id, title); else history.rename(id, title);
    }
    return history.list();
  });
}

/** The words of the Clear all history question (main shows them in a message box). */
function clearQuestion(count, openCount) {
  return {
    message: `Are you sure? This deletes ${count === 1 ? 'your one conversation' : `all ${count} conversations`} for good.`,
    detail: 'Recently deleted is emptied too, and nothing can be brought back.'
      + (openCount ? ` ${openCount === 1 ? 'The open conversation closes' : `The ${openCount} open conversations close`}, stopping anything still running.` : ''),
  };
}

module.exports = { registerHistoryIpc, clearQuestion };
