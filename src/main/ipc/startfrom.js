// Starting a task from where the work already is (wiring/startfrom.js): a red
// build or a review on one of your pull requests, and loose ends in a project.
//
// The panel only names things: a pull request by the key the CI watcher gave
// it, a project by a root the Projects page listed, a loose end by the file
// and line the last scan found. Main looks each one up before using it.
const KINDS = new Set(['build', 'review']);
const KEY_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}#\d{1,9}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

const isKey = k => typeof k === 'string' && KEY_RE.test(k);
const noteOf = n => (typeof n === 'string' ? n.slice(0, 500) : '');
const isRoot = r => typeof r === 'string' && r.length > 0 && r.length < 1000;

/** d: what main shares with its IPC (main.js ipcDeps). */
function registerStartFromIpc(ipcMain, d) {
  const no = { ok: false, error: 'That isn\'t something Shellby can start from.' };
  ipcMain.handle('startfrom:draft', (_e, { kind, key, note, fresh } = {}) => (KINDS.has(kind) && isKey(key)
    ? d.startFromDraft({ kind, key, note: noteOf(note), fresh: fresh === true }) : no));
  // ack: the "I've looked at these" tick, when the draft named files or people to check.
  ipcMain.handle('startfrom:send', (_e, { kind, key, note, hash, ack } = {}) => (KINDS.has(kind) && isKey(key) && HASH_RE.test(String(hash))
    ? d.startFromSend({ kind, key, note: noteOf(note), hash, ack: ack === true }) : no));
  ipcMain.handle('startfrom:loose-ends', (_e, { root, fresh } = {}) => (isRoot(root) ? d.looseEnds(root, { fresh: fresh === true }) : no));
  ipcMain.handle('startfrom:loose-end', (_e, { root, file, line } = {}) => (isRoot(root) && typeof file === 'string' && file.length < 1000 && Number.isInteger(line)
    ? d.looseEndDraft({ root, file, line }) : no));
}

module.exports = { registerStartFromIpc };
