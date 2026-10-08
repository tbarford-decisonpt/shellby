// Settings → Other computers (wiring/remote.js, remote/service.js).
// Kept out of main.js, which only wires it up.
//
// What the panel names is checked here before anything runs: a computer must
// be one you've added (or one in your ssh config, to add it), a folder must be
// one ssh.js accepts, and a key a file name in ~/.ssh. Nothing the panel sends
// is ever put on a command line as it came.
const ssh = require('../remote/ssh');

const MAX_ANSWER = 1024;

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares (main.js `shared`); d.remoteService is wireRemote's
 */
function registerRemoteIpc(ipcMain, d) {
  const svc = () => d.remoteService;
  const host = v => (ssh.isHost(v) ? v : null);
  const nope = { ok: false, error: 'Which computer?' };
  // A payload object from the panel, or {} for anything else (null included).
  const obj = (/** @type {unknown} */ v) => /** @type {Record<string, any>} */ (v && typeof v === 'object' ? v : {});
  /** @param {(alias: string) => any} fn */
  const forHost = fn => (/** @type {any} */ _e, /** @type {unknown} */ alias) => (host(alias) ? fn(/** @type {string} */ (alias)) : nope);

  ipcMain.handle('remote:view', () => svc().view());
  ipcMain.handle('remote:add', forHost(alias => svc().addComputer(alias)));
  ipcMain.handle('remote:create', (_e, form) => {
    if (!form || typeof form !== 'object') return { ok: false, error: 'Fill in the form first.' };
    const { alias, address, user, port, jump } = obj(form);
    const str = (/** @type {unknown} */ v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    const portNo = port === '' || port === null || port === undefined ? null : Number(port);
    return svc().createComputer({ alias: str(alias), address: str(address), user: str(user), port: portNo, jump: str(jump) });
  });
  ipcMain.handle('remote:remove', forHost(alias => svc().removeComputer(alias)));
  ipcMain.handle('remote:check', forHost(alias => svc().check(alias)));
  ipcMain.handle('remote:install', forHost(alias => svc().installClaude(alias)));
  ipcMain.handle('remote:sign-in', forHost(alias => svc().signInClaude(alias)));
  ipcMain.handle('remote:setup-key', forHost(alias => svc().setupKey(alias)));
  ipcMain.handle('remote:agent-on', () => svc().enableAgent());
  ipcMain.handle('remote:unlock', (_e, name) => (typeof name === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(name) ? svc().unlockKey(name) : { ok: false, error: 'Which key?' }));
  ipcMain.handle('remote:browse', (_e, p) => {
    const { alias, dir } = obj(p);
    return host(alias) ? svc().browse(alias, typeof dir === 'string' ? dir : '~') : nope;
  });
  ipcMain.handle('remote:add-folder', (_e, p) => {
    const { alias, dir } = obj(p);
    return host(alias) && typeof dir === 'string' ? svc().addFolder(alias, dir) : nope;
  });
  ipcMain.handle('remote:remove-folder', (_e, anchor) => (typeof anchor === 'string' ? svc().removeFolder(anchor) : { ok: false, error: 'Which folder?' }));
  // Work there from now on: only ever one of its folders' stand-ins.
  ipcMain.handle('remote:work-here', (_e, anchor) => {
    const place = typeof anchor === 'string' ? svc().placeOf(anchor) : null;
    return place ? d.setFolder(place.anchor) : { error: 'That folder is no longer one of yours.' };
  });
  // The answer to a question ssh asked through the panel (remote:ask). null: Cancel.
  ipcMain.handle('remote:answer', (_e, p) => {
    const { id, answer } = obj(p);
    if (typeof id !== 'string') return false;
    const text = typeof answer === 'string' && answer.length <= MAX_ANSWER ? answer : null;
    return d.answerRemote(id, text);
  });
}

module.exports = { registerRemoteIpc };
