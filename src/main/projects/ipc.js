// The Projects page's IPC: projects (projects/service.js) and dev servers
// (devservers/service.js). Kept out of main.js, which only wires it up.
//
// The panel never hands in a path: folders come from a dialog main opens, or
// are picked from what the service listed (knowsRoot); servers are named by id.
const { checkRepo } = require('./remote');
const { ID } = require('./todo');

const isStr = s => typeof s === 'string' && s.length > 0 && s.length < 2000;
const isId = s => typeof s === 'string' && /^srv-[a-z0-9]{8}$/.test(s);
const isTodoId = s => typeof s === 'string' && ID.test(s);
const LOCAL_URL = /^https?:\/\/localhost:\d{1,5}\/\S*$/;

/**
 * d: {
 *   projects(), devServers()        the services (null until created)
 *   pickFolder({ title, defaultPath }) -> Promise<string | null>
 *   toPanel(channel, payload)
 *   openPath(p), showItem(p), openExternal(url)
 * }
 */
function registerProjectsIpc(ipcMain, d) {
  const P = () => d.projects();
  const S = () => d.devServers();
  let pickedCloneParent = null; // the folder the clone sheet's dialog returned: the only one clone takes

  ipcMain.handle('projects:list', (_e, opts) => P()?.list({ refresh: !!opts?.refresh }) ?? null);
  ipcMain.handle('projects:detail', (_e, key) => (isStr(key) ? P()?.detail(key) ?? null : null));

  ipcMain.handle('projects:add', async () => {
    const dir = await d.pickFolder({ title: 'Add a repository' });
    return dir ? P().add(dir) : { ok: false, cancelled: true };
  });
  ipcMain.handle('projects:scan', async () => {
    const dir = await d.pickFolder({ title: 'Which folder should Shellby look through?' });
    return dir ? P().scan(dir) : { ok: false, cancelled: true };
  });
  ipcMain.handle('projects:scan-cancel', () => { P()?.cancelScan(); return true; });
  ipcMain.handle('projects:add-many', (_e, roots) => P()?.addMany(roots) ?? { ok: false });
  ipcMain.handle('projects:remove', (_e, key) => (isStr(key) ? P()?.remove(key) : { ok: false }));

  // Cloning: the folder comes from this dialog, never from the panel.
  ipcMain.handle('projects:clone-folder', async () => {
    const dir = await d.pickFolder({ title: 'Where should the clone go?', defaultPath: P()?.state.lastCloneParent || undefined });
    if (!dir) return { ok: false, cancelled: true };
    pickedCloneParent = dir;
    return { ok: true, parent: dir };
  });
  // "Use C:\code again": the last folder you cloned into, offered, never filled in.
  ipcMain.handle('projects:clone-again', () => {
    const last = P()?.state.lastCloneParent;
    if (!last) return { ok: false };
    pickedCloneParent = last;
    return { ok: true, parent: last };
  });
  ipcMain.handle('projects:clone-target', (_e, repo) => {
    if (!pickedCloneParent) return { error: 'Choose a folder to clone into first.' };
    const t = P()?.cloneTarget(repo, pickedCloneParent);
    return t?.error ? { error: t.error } : { dest: t?.dest || null, parent: pickedCloneParent };
  });
  ipcMain.handle('projects:clone', async (_e, repo) => {
    if (!checkRepo(repo)) return { ok: false, error: "That isn't a GitHub repository name." };
    if (!pickedCloneParent) return { ok: false, error: 'Choose a folder to clone into first.' };
    const r = await P().clone(repo, pickedCloneParent, p => d.toPanel('projects:clone-progress', { repo, ...p }));
    if (r.ok) pickedCloneParent = null;
    return r;
  });
  ipcMain.handle('projects:clone-cancel', () => { P()?.cancelClone(); return true; });

  ipcMain.handle('projects:open-folder', (_e, root) => {
    const known = P()?.knowsRoot(root);
    if (known) d.openPath(known);
    return !!known;
  });
  ipcMain.handle('projects:open-github', (_e, repo) => {
    const r = checkRepo(repo);
    if (r) d.openExternal(`https://github.com/${r}`);
    return !!r;
  });
  // The project's to-do list. The key must be one the page was shown (addTodo checks).
  ipcMain.handle('projects:todo-add', (_e, { key, text } = {}) => (isStr(key) && typeof text === 'string'
    ? P()?.addTodo(key, text, 'you') ?? { ok: false } : { ok: false }));
  ipcMain.handle('projects:todo-done', (_e, { key, id } = {}) => (isStr(key) && isTodoId(id)
    ? P()?.finishTodo(key, id) ?? { ok: false } : { ok: false }));
  ipcMain.handle('projects:install', (_e, root) => {
    const known = P()?.knowsRoot(root);
    return known ? S().start({ root: known, kind: 'install', project: P().nameFor(known) }) : { ok: false, error: 'Unknown project folder.' };
  });

  // ---------------------------------------------------------------- servers

  ipcMain.handle('servers:get', () => S()?.view() ?? null);
  ipcMain.handle('servers:start', (_e, { root, script } = {}) => {
    const known = P()?.knowsRoot(root);
    if (!known) return { ok: false, error: 'Unknown project folder.' };
    // The name goes into toasts and the prompt, so it's the listed project's, never the panel's.
    return S().start({ root: known, script: typeof script === 'string' ? script : '', project: P().nameFor(known) });
  });
  ipcMain.handle('servers:stop', (_e, id) => (isId(id) ? S().stop(id) : { ok: false }));
  ipcMain.handle('servers:restart', (_e, id) => (isId(id) ? S().restart(id) : { ok: false }));
  ipcMain.handle('servers:dismiss', (_e, id) => (isId(id) ? S().dismiss(id) : { ok: false }));
  ipcMain.handle('servers:seen', (_e, id) => { if (isId(id)) S()?.markSeen(id); return true; });
  ipcMain.handle('servers:log', (_e, id) => (isId(id) ? S().log(id) : null));
  ipcMain.handle('servers:fix-draft', (_e, { id, note } = {}) => (isId(id) ? S().fixDraft(id, typeof note === 'string' ? note : '') : null));
  // The only way a server's output reaches Claude: you pressed Send on its card.
  // hash: the draft the card showed; a prompt that has changed since isn't sent.
  ipcMain.handle('servers:fix-send', (_e, { id, note, hash } = {}) => (isId(id) && typeof hash === 'string'
    ? S().sendFix(id, typeof note === 'string' ? note : '', hash) : { ok: false }));
  ipcMain.handle('servers:open', (_e, id) => {
    const s = isId(id) ? S()?.view().servers.find(x => x.id === id) : null;
    if (!s?.url || !LOCAL_URL.test(s.url)) return false;
    d.openExternal(s.url);
    return true;
  });
  ipcMain.handle('servers:open-log', (_e, id) => {
    const s = isId(id) ? S()?.servers.get(id) : null;
    if (!s?.log) return false;
    d.showItem(s.log);
    return true;
  });
  ipcMain.handle('servers:stop-all', async () => { await S()?.stopAll(); return S()?.view(); });
  ipcMain.handle('servers:settings', (_e, patch) => S()?.setSettings(patch && typeof patch === 'object' ? patch : {}));
}

module.exports = { registerProjectsIpc };
