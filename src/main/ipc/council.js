// The Council screen (council/*.js): convene it, read back old sessions, and
// change who sits at the table. One council at a time; each seat's progress is
// pushed to the panel as 'council:progress' so the chamber can light them up.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');
const P = require('../council/prompts');
const { convene } = require('../council/run');
const { gather } = require('../council/context');
const { CouncilStore, summary } = require('../council/store');
const { run: runCli, skipSettings } = require('../claude/cli');

const GIT_TIMEOUT_MS = 5000;

function git(cwd, args) {
  return new Promise(resolve => {
    // The project may be someone else's clone: none of its config gets to run anything.
    execFile('git', ['-C', cwd, '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=NUL', ...args], {
      windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024, encoding: 'utf8',
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout) => resolve({ ok: !err, stdout: err ? '' : stdout }));
  });
}

// The start of a project file: never a link (a clone's README could point at a
// secret elsewhere), and never more than READ_BYTES of it.
const READ_BYTES = 8 * 1024;
function readHead(file) {
  if (!fs.lstatSync(file).isFile()) throw new Error('not a plain file');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(READ_BYTES);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, READ_BYTES, 0));
  } finally { fs.closeSync(fd); }
}

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerCouncilIpc(ipcMain, d) {
  const store = new CouncilStore({ dir: app.getPath('userData') });
  const settings = () => P.normalize(d.config.get('council'));
  const view = () => ({ settings: settings(), defaults: P.DEFAULT_SEATS, limits: { custom: P.MAX_CUSTOM, seated: P.MAX_SEATED, min: P.MIN_SEATED, question: P.MAX_QUESTION } });
  let sitting = false;

  ipcMain.handle('council:view', () => view());
  ipcMain.handle('council:save', (_e, raw) => {
    d.config.set({ council: P.normalize(raw) });
    return view();
  });
  ipcMain.handle('council:history', () => store.list().map(summary));
  ipcMain.handle('council:get', (_e, id) => (d.isStr(id) ? store.get(id) : null));
  ipcMain.handle('council:forget', (_e, id) => (d.isStr(id) ? store.remove(id).map(summary) : store.list().map(summary)));

  ipcMain.handle('council:convene', async (_e, req) => {
    const r = req && typeof req === 'object' ? req : {};
    if (d.config.get('crabOnly')) return { ok: false, error: 'The Council needs Claude Code. Turn it on in Settings.' };
    if (sitting) return { ok: false, error: 'The council is already sitting. Wait for its verdict.' };
    const exe = d.FAKE_CLI ? process.env.SHELLBY_NODE || 'node' : d.claudeExe();
    if (!exe) return { ok: false, error: "Claude Code isn't installed. Set it up in Settings." };
    const prefix = d.FAKE_CLI ? [d.FAKE_CLI] : [];
    const s = { ...settings(), ...(P.MODES.includes(r.mode) ? { mode: r.mode } : {}) };
    const cwd = d.currentCwd?.() || os.homedir();
    const progress = ev => { try { d.send(d.panel, 'council:progress', ev); } catch { /* the panel closed mid-sitting */ } };
    sitting = true;
    let out, context, prior;
    try {
      context = r.project ? await gather(cwd, { read: readHead, git: a => git(cwd, a) }) : '';
      prior = d.isStr(r.followUp) ? store.get(r.followUp) : null;
      out = await convene({
        question: r.question, settings: s, context, cwd: os.homedir(), lean: skipSettings(os.homedir()),
        prior: prior?.chair ? `${prior.question} -> ${prior.chair.verdict}` : '',
      }, (args, timeout, opts) => runCli(exe, [...prefix, ...args], timeout, opts),
      progress);
    } catch (e) {
      d.log.warn(`council: ${e?.message || e}`);
      return { ok: false, error: "The council couldn't sit. Try again." };
    } finally { sitting = false; }
    if (out.detail) d.log.warn(`council: ${out.detail}`);
    if (!out.ok) return { ok: false, error: out.error };
    const session = {
      id: d.randomUUID(), at: Date.now(), question: P.cleanQuestion(r.question), project: context ? path.basename(cwd) : '',
      followUp: prior?.id || null, ...out, detail: undefined,
    };
    store.add(session);
    return { ok: true, session };
  });
}

module.exports = { registerCouncilIpc };
