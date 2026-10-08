// What Claude Code does by itself, made visible: the commands a conversation
// left running in the background (jobs.js), what Claude remembers about you and
// a project (automemory.js), your cloud routines (cloud-routines.js) and the
// ultra review of a branch (wiring/handoff.js). Shellby runs none of these: it
// reads them, and asks Claude Code to act. Kept out of main.js, which only wires it up.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shell } = require('electron');
const confirm = require('../confirm');
const jobs = require('../jobs');
const automemory = require('../automemory');
const cloud = require('../cloud-routines');
const { findClaude, run: runCli } = require('../claude-cli');

const OUTPUT_TAIL = 8000;              // characters of a job's output the panel shows
const CLOUD_FRESH_MS = 10 * 60 * 1000; // a list asked for again within this is the one already fetched
const ID = /^[\w-]{1,120}$/;
const MEMORY_FILE = /^[\w.-]{1,120}\.md$/i;

const realTmp = () => { try { return fs.realpathSync.native(os.tmpdir()); } catch { return os.tmpdir(); } };

/** The last part of a file as text: { text, cut }, or null. */
async function tail(file, chars) {
  let fh;
  try {
    fh = await fs.promises.open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, chars * 2); // a few bytes a character at most, and output is mostly ASCII
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    const text = buf.toString('utf8');
    return { text: text.length > chars ? text.slice(-chars) : text, cut: size > len || text.length > chars };
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerNativeIpc(ipcMain, d) {
  const claudeExe = () => d.claudeStatus?.exe || findClaude(process.env, d.claudePath());
  // Cloud routines through Claude Code: the real CLI, or the fake one a test run starts Shellby with.
  const cloudAsk = input => (d.FAKE_CLI
    ? cloud.ask(process.env.SHELLBY_NODE || 'node', input, { cwd: os.homedir(), runner: (exe, args, t, o) => runCli(exe, [d.FAKE_CLI, ...args], t, o) })
    : cloud.ask(claudeExe(), input, { cwd: os.homedir() }));
  const tabOf = tabId => (d.isStr(tabId) ? d.manager.tabs.get(tabId) : null);

  // ---- background commands and watches

  ipcMain.handle('jobs:output', async (_e, { tabId, jobId } = {}) => {
    const tab = tabOf(tabId);
    const job = tab && d.isStr(jobId) ? tab.session.jobs.byId.get(jobId) : null;
    if (!job) return { ok: false, error: "Shellby doesn't know that one any more." };
    if (!job.outputFile) return { ok: false, error: "Claude Code hasn't said where its output goes." };
    let file;
    try { file = fs.realpathSync.native(job.outputFile); } catch { return { ok: false, error: 'Its output is gone: Claude Code tidies those away.' }; }
    if (!jobs.outputPathOk(file, realTmp())) return { ok: false, error: "That output isn't somewhere Shellby reads." };
    const t = await tail(file, OUTPUT_TAIL);
    return t ? { ok: true, text: t.text, cut: t.cut } : { ok: false, error: "Couldn't read its output." };
  });

  ipcMain.handle('jobs:stop', async (_e, { tabId, jobId } = {}) => {
    const tab = tabOf(tabId);
    if (!tab || !d.isStr(jobId)) return { ok: false, error: 'That conversation is closed.' };
    return tab.session.stopJob(jobId);
  });

  // ---- what Claude remembers (auto memory)

  // The project folders a tab's memories may be under: its own, and the checkout its copy came from.
  function cwdsOf(tabId) {
    const tab = tabOf(tabId);
    return [tab?.session?.cwd || d.currentCwd(), tab?.worktree?.originalCwd].filter(d.isStr);
  }
  const dirOf = tabId => automemory.pickDir(cwdsOf(tabId), d.claudeConfigDir());

  ipcMain.handle('memory:list', async (_e, tabId) => {
    const cwds = cwdsOf(tabId);
    const r = await automemory.list(cwds, d.claudeConfigDir());
    // Named after its project; a conversation in your home folder has none to name.
    const where = cwds[cwds.length - 1] || '';
    return { ...r, project: where && path.resolve(where) !== path.resolve(os.homedir()) ? path.basename(where) : null };
  });

  ipcMain.handle('memory:save', (_e, { tabId, file, body, mtimeMs } = {}) => {
    if (!d.isStr(file) || !MEMORY_FILE.test(file) || typeof body !== 'string') return { ok: false, error: "That isn't one of Claude's memories." };
    return automemory.saveBody(dirOf(tabId), file, body, Number.isFinite(mtimeMs) ? mtimeMs : undefined);
  });

  ipcMain.handle('memory:forget', (_e, { tabId, file } = {}) => {
    if (!d.isStr(file) || !MEMORY_FILE.test(file)) return { ok: false, error: "That isn't one of Claude's memories." };
    return automemory.forget(dirOf(tabId), file, p => shell.trashItem(p));
  });

  ipcMain.handle('memory:open-folder', async (_e, tabId) => {
    const dir = dirOf(tabId);
    if (!dir || !fs.existsSync(dir)) return { ok: false, error: "Claude hasn't written anything down for this project yet." };
    const err = await shell.openPath(dir);
    return err ? { ok: false, error: err } : { ok: true };
  });

  // ---- cloud routines (/schedule)

  /** @type {{ at: number, result: { ok: true, routines: { id: string, name: string, prompt: string }[], more: boolean } } | null} the last list, kept CLOUD_FRESH_MS */
  let cached = null;
  /** @type {Promise<any> | null} */
  let asking = null;
  ipcMain.handle('cloud:list', async (_e, { fresh = false } = {}) => {
    if (d.config.get('crabOnly')) return { ok: false, error: 'Cloud routines need Claude Code. Turn it on in Settings.' };
    if (!fresh && cached && Date.now() - cached.at < CLOUD_FRESH_MS) return { ...cached.result, at: cached.at };
    asking ??= cloudAsk({ action: 'list' }).finally(() => { asking = null; });
    const r = await asking;
    if (!r.ok) return { ok: false, error: r.error, signedOut: !!r.signedOut };
    cached = { at: Date.now(), result: { ok: true, routines: r.routines, more: r.more } };
    return { ...cached.result, at: cached.at };
  });

  ipcMain.handle('cloud:runs', async (_e, id) => {
    if (!d.isStr(id) || !ID.test(id)) return { ok: false, error: "That isn't a routine." };
    const r = await cloudAsk({ action: 'list_runs', trigger_id: id });
    return r.ok ? { ok: true, runs: r.runs } : { ok: false, error: r.error };
  });

  // Running one starts a session in Anthropic's cloud on your plan: asked in the confirm window first.
  ipcMain.handle('cloud:run', async (_e, id) => {
    if (!d.isStr(id) || !ID.test(id)) return { ok: false, error: "That isn't a routine." };
    const routine = cached?.result.routines?.find(r => r.id === id);
    const response = await confirm.ask(d.panel, {
      ...d.dialogLook(), icon: '☁️',
      title: `Run ${routine ? `“${routine.name}”` : 'this routine'} now?`,
      message: "It starts a session in Claude's cloud straight away, as if its schedule had come round.",
      detail: routine?.prompt ? `It's asked:\n\n${routine.prompt.slice(0, 300)}` : undefined,
      note: 'It uses your Claude plan like any other session. Its schedule carries on as before.',
      buttons: [{ label: 'Run it now', style: 'primary' }, { label: 'Cancel' }], defaultId: 0, cancelId: 1,
    });
    if (response !== 0) return { ok: false, cancelled: true };
    const r = await cloudAsk({ action: 'run', trigger_id: id });
    return r.ok ? { ok: true, url: cloud.routineUrl(id) } : { ok: false, error: r.error };
  });

  ipcMain.on('cloud:open', (_e, id) => { shell.openExternal(d.isStr(id) && ID.test(id) ? cloud.routineUrl(id) : cloud.ROUTINES_URL); });

  // ---- the ultra review: Claude Code's own, in a terminal of its own
  ipcMain.handle('review:ultra', (_e, tabId) => (d.isStr(tabId) ? d.handoff.ultraReview(tabId) : { ok: false, error: 'That conversation is closed.' }));
}

module.exports = { registerNativeIpc, tail };
