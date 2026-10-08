// Cloning a GitHub repository onto this PC, into a folder you chose. Nothing is
// downloaded until you've picked where it goes, and nothing runs afterwards
// (no install, no server): that's for you to start.
//
// git runs with fixed arguments and no shell; the URL is built from a checked
// "owner/name", never taken from an API answer; and a clone that fails or is
// cancelled removes the folder it made, and only that folder.
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { cloneUrl, checkRepo } = require('./remote');
const { okDir } = require('../leaving');
const { TASKKILL } = require('../system32');

// Names Windows won't make a folder with, whatever follows the dot.
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Where a clone of `repo` into `parent` goes, or { error }. Pure apart from the existence checks. */
function target(repo, parent, { exists = p => fs.existsSync(p), isDir = p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } } } = {}) {
  const r = checkRepo(repo);
  if (!r) return { error: "That isn't a GitHub repository name." };
  if (!parent) return { error: 'Choose a folder to clone into first.' };
  if (!okDir(parent) || !isDir(parent)) return { error: "That folder isn't there any more." };
  const name = r.split('/')[1];
  if (RESERVED.test(name) || /[. ]$/.test(name)) return { error: `Windows can't make a folder called "${name}".` };
  const dest = path.join(path.resolve(parent), name);
  if (exists(dest)) return { error: `${dest} already exists. Choose another folder, or add that one instead.` };
  return { repo: r, url: cloneUrl(r), dest };
}

/** git's arguments for a clone: the URL and folder come after `--`, so neither can be read as an option. */
function cloneArgs(url, dest) {
  return ['-c', 'core.fsmonitor=false', 'clone', '--progress', '--', url, dest];
}

/** "Receiving objects:  45% (450/1000)" -> { phase: 'Receiving objects', percent: 45 }, or null. */
function parseProgress(line) {
  const m = /^(?:remote:\s*)?([A-Za-z ]{3,40}):\s+(\d{1,3})%/.exec(String(line || '').trim());
  return m ? { phase: m[1].trim(), percent: Math.min(100, Number(m[2])) } : null;
}

/**
 * Clone. -> Promise<{ ok: true, root } | { ok: false, error, cancelled? }>. Never rejects.
 * env: extra environment (the GitHub sign-in's credential helper, for private repos).
 * onProgress({ phase, percent }); signal: an AbortSignal that cancels it.
 */
function clone(repo, parent, { env = {}, onProgress = () => {}, signal = null, spawnImpl = spawn, killTree = null, removeDir = null } = {}) {
  const t = target(repo, parent);
  if (t.error) return Promise.resolve({ ok: false, error: t.error });
  const remove = removeDir || (dir => fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {}));
  // Claim the folder first, without recursive: this fails if anything got
  // there since target() looked (a folder, a file, a junction), so cleanup can
  // only ever remove the empty folder made here and what git put in it.
  try {
    fs.mkdirSync(t.dest);
  } catch (e) {
    return Promise.resolve({ ok: false, error: e.code === 'EEXIST' ? `${t.dest} already exists. Choose another folder, or add that one instead.` : `Couldn't make ${t.dest}: ${e.message}` });
  }
  return new Promise(resolve => {
    let child;
    try {
      child = spawnImpl('git', cloneArgs(t.url, t.dest), {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        // No prompts: a private repo without access fails instead of waiting on a password nobody can type.
        env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      });
    } catch (e) {
      remove(t.dest).then(() => resolve({ ok: false, error: e.message }));
      return;
    }
    let tail = '';
    let cancelled = false;
    child.stderr?.on('data', d => {
      const text = String(d);
      tail = (tail + text).slice(-2000);
      for (const part of text.split(/[\r\n]+/)) {
        const p = parseProgress(part);
        if (p) onProgress(p);
      }
    });
    const kill = killTree || (pid => execFile(TASKKILL, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {}));
    const onAbort = () => { cancelled = true; if (child.pid) kill(child.pid); };
    if (signal?.aborted) onAbort(); else signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', e => { tail += `\n${e.message}`; });
    child.on('close', async code => {
      signal?.removeEventListener('abort', onAbort);
      if (code === 0 && !cancelled) { resolve({ ok: true, root: t.dest }); return; }
      // The folder was made just for this clone (above), so whatever is in it is ours.
      await remove(t.dest);
      if (cancelled) { resolve({ ok: false, cancelled: true, error: 'Clone cancelled.' }); return; }
      resolve({ ok: false, error: cloneError(tail) });
    });
  });
}

/** git's last words -> one plain sentence. */
function cloneError(stderr) {
  const s = String(stderr || '');
  if (/could not read Username|Authentication failed|Repository not found/i.test(s)) {
    return "GitHub wouldn't let Shellby clone it. For a private repository, turn on \"Let Claude tasks push code\" in GitHub settings, or clone it yourself and add the folder.";
  }
  if (/Could not resolve host|unable to access/i.test(s)) return "Couldn't reach GitHub. Check the connection and try again.";
  if (/ENOENT|not recognized|spawn git/i.test(s)) return "Git isn't installed, or Shellby can't find it.";
  const last = s.split(/[\r\n]+/).map(l => l.trim()).filter(l => /^(fatal|error):/i.test(l)).pop();
  return last ? last.replace(/^(fatal|error):\s*/i, '').slice(0, 200) : 'The clone failed.';
}

module.exports = { clone, target, cloneArgs, parseProgress, cloneError };
