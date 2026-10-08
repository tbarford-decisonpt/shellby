// The Projects page's IPC: projects (projects/service.js) and dev servers
// (devservers/service.js). Kept out of main.js, which only wires it up.
//
// The panel never hands in a path: folders come from a dialog main opens, or
// are picked from what the service listed (knowsRoot); servers are named by id.
const { checkRepo } = require('./remote');
const doctorIo = require('../devservers/doctor-io');
const runner = require('../devservers/runner');
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
 *   ask(spec) -> Promise<button index>: Shellby's own confirm dialog (confirm.js)
 *   journal()                       wiring/journal.js (null until created)
 *   processInfo(pid), imageOf(pid)  native-windows: is it the same process, and what is it
 *   ownPids() -> Set                Shellby's own processes, never offered to stop
 *   doctor?                         doctor-io.js, or a test's
 * }
 */
function registerProjectsIpc(ipcMain, d) {
  const P = () => d.projects();
  const S = () => d.devServers();
  const io = d.doctor || doctorIo;
  // What the card was last shown for each server: who held its port and the
  // free one offered. Stopping or moving only ever acts on these.
  const portLooks = new Map(); // server id -> { port, holders: [{ pid, name, createdAt }], free }
  let pickedCloneParent = null; // the folder the clone sheet's dialog returned: the only one clone takes

  ipcMain.handle('projects:list', (_e, opts) => P()?.list({ refresh: !!opts?.refresh }) ?? null);
  ipcMain.handle('projects:detail', (_e, key) => (isStr(key) ? P()?.detail(key) ?? null : null));
  // A standup or weekly report for one project (standup.js), as text to copy.
  ipcMain.handle('projects:report', (_e, a) => (isStr(a?.key) ? P()?.report(a.key, typeof a.kind === 'string' ? a.kind : 'standup') ?? null : null));

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

  // ---------------------------------------------------------------- the inbox (inbox.js)
  // Deleting work that exists nowhere else is asked here, in main's own dialog,
  // never on the panel's say-so.
  ipcMain.handle('projects:inbox', (_e, opts) => P()?.inbox({ refresh: !!opts?.refresh }) ?? null);
  ipcMain.handle('projects:inbox-dismiss', (_e, id) => (isStr(id) ? P()?.dismiss(id) : { ok: false }));
  ipcMain.handle('projects:delete-branch', async (_e, arg) => {
    const { root, name } = arg && typeof arg === 'object' ? arg : {};
    if (!isStr(root) || !isStr(name) || !P()) return { ok: false };
    const r = await P().deleteBranch(root, name);
    if (!r.needsConfirm) return r;
    const yes = await d.ask({
      icon: '🌿', danger: true,
      title: `Delete ${name.slice(0, 80)}?`,
      message: `It has ${r.only === 1 ? 'a commit' : `${r.only} commits`} that no other branch, and no remote, has. Deleting it throws ${r.only === 1 ? 'that' : 'them'} away.`,
      note: 'git keeps unreachable commits for a while (git reflog), but Shellby can\'t bring them back for you.',
      buttons: [{ label: 'Delete it', style: 'danger' }, { label: 'Keep it' }], defaultId: 1, cancelId: 1,
    });
    return yes === 0 ? P().deleteBranch(root, name, { confirmed: r.sha }) : { ok: false, cancelled: true };
  });
  ipcMain.handle('projects:remove-copy', async (_e, copyPath) => {
    if (!isStr(copyPath) || !P()) return { ok: false };
    const r = await P().removeCopy(copyPath);
    if (!r.needsConfirm) return r;
    const ignored = r.ignored?.length ? `files git ignores (${r.ignored.join(', ')}${r.moreIgnored ? ` and ${r.moreIgnored} more` : ''})` : null;
    const lost = [r.changed && `${r.changed} uncommitted file${r.changed === 1 ? '' : 's'}`, r.only && `${r.only} commit${r.only === 1 ? '' : 's'} no other branch has`, ignored]
      .filter(Boolean);
    const lostText = lost.length > 1 ? `${lost.slice(0, -1).join(', ')} and ${lost[lost.length - 1]}` : lost[0];
    const yes = await d.ask({
      icon: '🐚', danger: true,
      title: 'Throw this copy away?',
      message: `It still has ${lostText}. Removing the copy deletes its folder and its branch, and that work with them.`,
      note: 'To keep the work, open its conversation and bring it home instead.',
      buttons: [{ label: 'Throw it away', style: 'danger' }, { label: 'Keep it' }], defaultId: 1, cancelId: 1,
    });
    // What you were told: more than that by now, and it asks again rather than taking it.
    if (yes !== 0) return { ok: false, cancelled: true };
    const done = await P().removeCopy(copyPath, { confirmed: { changed: r.changed, only: r.only, ignoredTotal: r.ignoredTotal } });
    return done.needsConfirm ? { ok: false, error: 'There is more in that copy than a moment ago, so it stays. Have another look.' } : done;
  });

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
  // The handoff notes on a project's page: pin a line of your own, or take one off.
  ipcMain.handle('projects:journal-pin', (_e, { root, kind, text } = {}) => {
    const known = P()?.knowsRoot(root);
    if (!known || typeof text !== 'string') return { ok: false, error: 'Unknown project folder.' };
    return d.journal()?.pinFor(known, { kind, text }, { fromPanel: true }) ?? { ok: false };
  });
  ipcMain.handle('projects:journal-remove', (_e, { root, pinId, sessionId } = {}) => {
    const known = P()?.knowsRoot(root);
    if (!known) return { ok: false };
    const id = v => (typeof v === 'string' && /^[\w-]{1,64}$/.test(v) ? v : null);
    if (!id(pinId) && !id(sessionId)) return { ok: false };
    return d.journal()?.remove(known, { pinId: id(pinId), sessionId: id(sessionId) }) ?? { ok: false };
  });
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

  // ---------------------------------------------------------------- the port and environment doctor (doctor.js)

  // A crashed server's port was taken: who has it, and a free one to move to.
  ipcMain.handle('servers:port-look', async (_e, id) => {
    const s = isId(id) ? S()?.servers.get(id) : null;
    if (!s?.portTaken) return null;
    const own = d.ownPids?.() || new Set();
    const holders = (await io.whoHasPort(s.portTaken, { info: d.processInfo, image: d.imageOf }))
      .map(h => ({ ...h, canStop: h.canStop && !own.has(h.pid) }));
    const free = await io.freePort(s.portTaken);
    portLooks.set(id, { port: s.portTaken, holders, free });
    return { port: s.portTaken, free, holders: holders.map(({ pid, name, canStop }) => ({ pid, name, canStop })) };
  });

  // "Stop it": the program the card named, if it's still the same one, after
  // Shellby's own window has asked. Then the server starts again.
  ipcMain.handle('servers:port-stop', async (_e, { id, pid } = {}) => {
    const look = isId(id) ? portLooks.get(id) : null;
    const h = look?.holders.find(x => x.pid === pid && x.canStop);
    if (!h) return { ok: false, error: "Look again: that program isn't the one holding the port any more." };
    const now = d.processInfo?.(h.pid);
    if (!now?.alive || (h.createdAt && now.createdAt && Math.abs(now.createdAt - h.createdAt) > 3000)) {
      return { ok: false, stale: true, error: 'That program has already closed. Try starting the server again.' };
    }
    const name = h.name || 'a program';
    const yes = await d.ask({
      icon: '🔌', danger: true,
      title: `Stop ${name}?`,
      message: `${name} (process ${h.pid}) is using port ${look.port}. Stopping it ends it and anything it started, the way Task Manager's End task does.`,
      note: "Anything unsaved in it is lost. If you don't know what it is, use another port instead.",
      buttons: [{ label: `Stop ${name}`, style: 'danger' }, { label: 'Leave it' }], defaultId: 1, cancelId: 1,
    });
    if (yes !== 0) return { ok: false, cancelled: true };
    await runner.stop(h.pid);
    // Wait for the port to come free (a few seconds at most), then start again.
    for (let i = 0; i < 20; i++) {
      if (!(await io.whoHasPort(look.port, { info: d.processInfo, image: d.imageOf })).length) break;
      await new Promise(r => setTimeout(r, 250));
    }
    portLooks.delete(id);
    return S().restart(id);
  });

  // "Use :5174": the free port the card offered, remembered for this script.
  // port null: back to the usual one.
  ipcMain.handle('servers:use-port', (_e, { id, port } = {}) => {
    if (!isId(id)) return { ok: false };
    if (port === null) return S().usePort(id, null);
    const look = portLooks.get(id);
    if (!look?.free || look.free !== port) return { ok: false, error: 'Look again: that port was never offered.' };
    portLooks.delete(id);
    return S().usePort(id, port);
  });

  // Before a start: .env keys the example has and yours doesn't, and the Node version it wants.
  ipcMain.handle('servers:doctor', (_e, root) => {
    const known = P()?.knowsRoot(root);
    return known ? io.checkProject(known) : null;
  });
  // ".env from the example": only where there's no .env at all.
  ipcMain.handle('servers:make-env', (_e, root) => {
    const known = P()?.knowsRoot(root);
    return known ? io.makeEnv(known) : { ok: false, error: 'Unknown project folder.' };
  });
  ipcMain.handle('servers:settings', (_e, patch) => S()?.setSettings(patch && typeof patch === 'object' ? patch : {}));
}

module.exports = { registerProjectsIpc };
