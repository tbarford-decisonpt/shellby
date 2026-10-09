'use strict';

// .shellby/tasks.md: read and written only here, in your checkout (wiring/backlog.js).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const worktrees = require('../worktrees');

const MAX_FILE_BYTES = 256 * 1024;
const BOM = String.fromCharCode(0xfeff);
const TASKS_PARTS = ['.shellby', 'tasks.md'];

const hashOf = s => crypto.createHash('sha256').update(s).digest('hex');
const lower = s => String(s || '').toLowerCase();
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** reads: wireBacklog's root (lower case) -> hash of tasks.md as last listed (shared, by reference). */
function makeTasksFile({ reads }) {
  const tasksPath = root => path.join(root, ...TASKS_PARTS);

  /** The file as it is now. -> { ok, exists, text, bom, hash } | { ok: false, error } */
  function readTasks(root) {
    const dir = path.join(root, TASKS_PARTS[0]);
    const file = tasksPath(root);
    try {
      if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) return { ok: false, error: '.shellby is a link, so Shellby leaves it alone.' };
      if (!fs.existsSync(file)) return { ok: true, exists: false, text: '', bom: false, hash: hashOf('') };
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink() || !st.isFile()) return { ok: false, error: '.shellby/tasks.md isn\'t a plain file, so Shellby leaves it alone.' };
      if (!inside(fs.realpathSync.native(file), fs.realpathSync.native(root))) return { ok: false, error: '.shellby/tasks.md isn\'t inside the project.' };
      if (st.size > MAX_FILE_BYTES) return { ok: false, error: '.shellby/tasks.md is too big for Shellby to read (over 256 KB).' };
      const raw = fs.readFileSync(file, 'utf8');
      const bom = raw.startsWith(BOM);
      const text = bom ? raw.slice(1) : raw;
      return { ok: true, exists: true, text, bom, hash: hashOf(raw) };
    } catch (e) {
      return { ok: false, error: `Couldn't read .shellby/tasks.md: ${e.message}` };
    }
  }

  /** Write it, only if it's still what `expect` hashed, through a temp file. */
  function writeTasks(root, text, { expect, bom = false }) {
    const now = readTasks(root);
    if (!now.ok) return now;
    if (now.hash !== expect) return { ok: false, stale: true, error: 'That list has changed since Shellby read it. Look again.' };
    const dir = path.join(root, TASKS_PARTS[0]);
    const file = tasksPath(root);
    const tmp = path.join(dir, `.tasks.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.lstatSync(dir).isSymbolicLink()) return { ok: false, error: '.shellby is a link, so Shellby leaves it alone.' };
      fs.writeFileSync(tmp, (bom ? BOM : '') + text, 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* it never got made */ }
      return { ok: false, error: `Couldn't save .shellby/tasks.md: ${e.message}` };
    }
    reads.set(lower(root), readTasks(root).hash);
    return { ok: true };
  }

  /** Is tasks.md ignored, or changed since the last commit? Best effort: unknown is false. */
  async function tasksGit(root) {
    const rel = TASKS_PARTS.join('/');
    const [ignored, status] = await Promise.all([
      worktrees.git(root, ['check-ignore', '-q', '--', rel], { timeout: 5000 }),
      worktrees.git(root, ['status', '--porcelain', '--', rel], { timeout: 5000 }),
    ]);
    return { ignored: ignored.ok, uncommitted: status.ok && !!status.out.trim() };
  }

  return { readTasks, writeTasks, tasksGit, tasksPath };
}

module.exports = { makeTasksFile, hashOf, BOM, TASKS_PARTS, inside };
