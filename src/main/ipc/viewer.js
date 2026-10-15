// The file viewer's channels (viewer.js): open a handle on a conversation's
// folder, or on a worktree of a project the Project page showed (or a place picked from its header's menu), then read
// inside it. Read-only. Kept out of main.js, which only wires it up.
const changes = require('../changes');
const fileIndex = require('../fileindex');
const leaving = require('../leaving');
const { createViewer, locate, branchOf, sameDir, writeWatch } = require('../viewer');

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps); this sets d.viewerNudge and d.viewerWrites
 */
function registerViewerIpc(ipcMain, d) {
  const viewer = createViewer();
  // A conversation's folder, when it's one on this PC (a remote tab's is only a stand-in).
  const folderOf = tabId => {
    const tab = d.isStr(tabId) ? d.manager.tabs.get(tabId) : null;
    if (!tab) return { error: 'That conversation is closed.' };
    const cwd = tab.session?.cwd;
    if (!leaving.okDir(cwd)) return { error: 'This conversation has no folder yet.' };
    if (d.remoteService?.placeOf(cwd)) return { error: 'That folder is on another computer.' };
    return { tab, cwd };
  };
  // The project's worktrees as git lists them, but only local folders that really are this repo's:
  // a record in .git/worktrees is the repo's own word, so the folder must point back to it.
  const isWorktreeOf = async (root, dir) => {
    if (!leaving.okDir(dir)) return false;
    const listed = leaving.parseWorktrees(await leaving.git(['-C', root, 'worktree', 'list', '--porcelain']));
    return listed.some(w => leaving.okDir(w.path) && sameDir(w.path, dir)) && changes.sameRepo(root, dir);
  };

  ipcMain.handle('viewer:open', async (_e, req) => {
    if (d.isStr(req?.tabId)) {
      const f = folderOf(req.tabId);
      if (f.error) return { ok: false, error: f.error };
      return viewer.open({ dir: f.cwd, base: f.tab.worktree?.base || null, tabId: f.tab.id });
    }
    if (d.isStr(req?.projectRoot)) {
      const root = d.projects?.knowsRoot(req.projectRoot);
      if (!root) return { ok: false, error: "That isn't a project Shellby knows." };
      const dir = d.isStr(req.worktreePath) ? req.worktreePath : root;
      if (!leaving.okDir(dir)) return { ok: false, error: "That isn't one of the project's worktrees." };
      if (!sameDir(dir, root) && !(await isWorktreeOf(root, dir))) return { ok: false, error: "That isn't one of the project's worktrees." };
      return viewer.open({ dir });
    }
    return { ok: false, error: 'Open what?' };
  });
  ipcMain.handle('viewer:tree', (_e, id, opts) => viewer.treeOf(id, { fresh: !!opts?.fresh })); // a folder's index (fresh: read again now), or a branch's own tree
  ipcMain.handle('viewer:status', (_e, id) => viewer.statusOf(id)); // the file tree's marks (viewer-status.js); a folder handle only
  ipcMain.handle('viewer:changes', (_e, id, opts) => viewer.changesOf(id, { uncommittedOnly: !!opts?.uncommittedOnly }));
  ipcMain.handle('viewer:read', (_e, id, rel) => viewer.read(id, rel));
  ipcMain.handle('viewer:diff', (_e, id, rel) => viewer.diffOf(id, rel));
  ipcMain.handle('viewer:locate', async (_e, tabId, target) => {
    const f = folderOf(tabId);
    return f.error ? { inside: false } : locate(f.cwd, target);
  });
  ipcMain.handle('viewer:branch', async (_e, tabId) => {
    const f = folderOf(tabId);
    return { branch: f.error ? null : await branchOf(f.cwd) };
  });
  ipcMain.handle('viewer:close', (_e, id) => { viewer.close(id); return true; });
  // The header's menu: the repo's worktrees and unmerged branches, each under a key main issued;
  // a pick names only a key, and main checks it again before it opens (viewer.js switchTo).
  ipcMain.handle('viewer:places', (_e, id) => viewer.placesOf(id));
  ipcMain.handle('viewer:switch', (_e, id, key) => viewer.switchTo(id, key));
  // Something in a folder may have changed: a nudge for each viewer open on it. commits: a turn
  // ended, a step was undone or a ! command ran, where a commit may have landed, so viewers on the
  // repo's branches look again too; each tool's result leaves them be.
  const nudge = d.viewerNudge = (dir, opts = {}) => {
    const ids = viewer.staleFor(dir, opts);
    if (ids.length && d.panel && !d.panel.isDestroyed()) d.send(d.panel, 'viewer:stale', { ids });
  };
  fileIndex.onForget(dir => nudge(dir, { commits: true })); // turn ends, ! commands, step undo
  d.viewerWrites = writeWatch(dir => nudge(dir));            // each tool that could have written (wiring/sessions.js)
  d.manager.on?.('tabs', summary => viewer.keepTabs(new Set(summary.map(t => t.id))));
  return viewer;
}

module.exports = { registerViewerIpc };
