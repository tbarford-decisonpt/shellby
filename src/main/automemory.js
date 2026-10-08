// Claude Code's auto memory: what Claude writes down to remember about you and
// a project, one Markdown file per thing under
//   <config dir>/projects/<project folder, as a name>/memory/
// with a MEMORY.md index of one line per file that loads into every
// conversation there. Shellby doesn't remember anything itself: it shows what
// Claude has written (Toolbox → Setup), lets you correct or drop it, and
// notices when Claude writes a new one (session.js memoryOf).
//
// A memory file:
//   ---
//   name: some-slug
//   description: one line
//   metadata:
//     type: user | feedback | project | reference
//   ---
//   the fact
//
// The pure half (parse, slug, the index line) is tested in test/automemory.test.js;
// list/read/save touch the disk.
const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_FILES = 200;
const MAX_BYTES = 64 * 1024;     // one memory file; past this it isn't a note any more
const INDEX = 'MEMORY.md';
const FILE_NAME = /^[\w.-]{1,120}\.md$/i;
const TYPES = ['user', 'feedback', 'project', 'reference'];

const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** A folder as Claude Code names its project folder: every other character a '-'. */
const slugOf = cwd => path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');

/** The memory folder for a project folder. */
const memoryDir = (cwd, dir = configDir()) => path.join(dir, 'projects', slugOf(cwd), 'memory');

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

/**
 * A file Claude wrote, if it's one of its memories: { file, index } (index:
 * it's MEMORY.md itself), or null. Only inside Claude Code's own config folder.
 */
function memoryOf(filePath, dir = configDir()) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null;
  const full = path.resolve(filePath);
  const memDir = path.dirname(full);
  const projects = path.dirname(path.dirname(memDir));
  if (path.basename(memDir).toLowerCase() !== 'memory' || !same(projects, path.join(path.resolve(dir), 'projects'))) return null;
  const file = path.basename(full);
  if (!FILE_NAME.test(file)) return null;
  return { file, index: same(file, INDEX) };
}

const unquote = v => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1).replace(/\\"/g, '"');
  return t;
};

/**
 * A memory file's text as { name, description, type, body }. Frontmatter is the
 * little YAML Claude writes (top-level keys, and type either at the top or
 * under metadata:); anything else in it is left alone. No frontmatter: all body.
 */
function parse(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  const out = { name: '', description: '', type: '', body: (m ? src.slice(m[0].length) : src).trim() };
  if (!m) return out;
  let inMeta = false;
  for (const line of m[1].split('\n')) {
    const top = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (top) {
      inMeta = top[1] === 'metadata' && !top[2].trim();
      if (['name', 'description', 'type'].includes(top[1])) out[top[1]] = unquote(top[2]);
      continue;
    }
    const nested = /^\s+([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (inMeta && nested && nested[1] === 'type') out.type = unquote(nested[2]);
  }
  if (!TYPES.includes(out.type)) out.type = out.type ? 'other' : '';
  return out;
}

/** The text with its body replaced, frontmatter kept exactly as it was. */
function withBody(text, body) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const m = /^---\n[\s\S]*?\n---\n?/.exec(src);
  const clean = String(body || '').replace(/\r\n/g, '\n').trim();
  return `${m ? `${m[0].replace(/\n?$/, '\n')}\n` : ''}${clean}\n`;
}

/** MEMORY.md without its line for one file (a "- [Title](file.md) — hook" pointer). */
function dropFromIndex(index, file) {
  const lines = String(index || '').split('\n');
  const esc = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const points = new RegExp(`\\]\\((?:\\./)?${esc}\\)`, 'i');
  return lines.filter(l => !points.test(l)).join('\n');
}

/**
 * The first of these project folders that has memories, or the first one when
 * none has: a copy of a repo (worktrees.js) may keep its memories under the
 * checkout it came from.
 */
function pickDir(cwds, dir = configDir()) {
  const dirs = cwds.filter(c => typeof c === 'string' && c).map(c => memoryDir(c, dir));
  return dirs.find(d => fs.existsSync(d)) || dirs[0] || null;
}

/**
 * Everything Claude remembers for a project:
 * { dir, exists, index, memories: [{ file, name, description, type, body, mtimeMs, size }] }
 * newest first. Never throws.
 */
async function list(cwds, dir = configDir()) {
  const memDir = pickDir(Array.isArray(cwds) ? cwds : [cwds], dir);
  const out = { dir: memDir, exists: false, index: null, memories: [] };
  if (!memDir) return out;
  let names;
  try { names = await fs.promises.readdir(memDir); } catch { return out; }
  out.exists = true;
  try { out.index = await fs.promises.readFile(path.join(memDir, INDEX), 'utf8'); } catch { /* no index yet */ }
  for (const file of names.filter(n => FILE_NAME.test(n) && !same(n, INDEX)).slice(0, MAX_FILES)) {
    try {
      const full = path.join(memDir, file);
      const st = await fs.promises.stat(full);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
      const m = parse(await fs.promises.readFile(full, 'utf8'));
      out.memories.push({ file, ...m, name: m.name || file.replace(/\.md$/i, ''), mtimeMs: st.mtimeMs, size: st.size });
    } catch { /* gone, or unreadable: leave it out */ }
  }
  out.memories.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** A memory file inside a memory folder, or null for anything else. */
function fileIn(memDir, file) {
  if (typeof memDir !== 'string' || typeof file !== 'string' || !FILE_NAME.test(file)) return null;
  if (path.basename(memDir).toLowerCase() !== 'memory') return null;
  const full = path.join(memDir, file);
  return path.dirname(full) === path.resolve(memDir) ? full : null;
}

/**
 * Replace a memory's body. mtimeMs: when it was read, so a change Claude made
 * meanwhile isn't overwritten. -> { ok } | { ok: false, error, conflict? }
 */
async function saveBody(memDir, file, body, mtimeMs) {
  const full = fileIn(memDir, file);
  if (!full || same(file, INDEX)) return { ok: false, error: "That isn't one of Claude's memories." };
  if (typeof body !== 'string' || !body.trim()) return { ok: false, error: 'A memory needs some words. Forget it instead?' };
  if (body.length > MAX_BYTES) return { ok: false, error: 'That is too long for a memory.' };
  let text, st;
  try { [text, st] = await Promise.all([fs.promises.readFile(full, 'utf8'), fs.promises.stat(full)]); } catch { return { ok: false, error: 'That memory is gone. Claude may have dropped it.' }; }
  if (Number.isFinite(mtimeMs) && Math.abs(st.mtimeMs - mtimeMs) > 1) return { ok: false, conflict: true, error: 'Claude changed this memory since you opened it. Have a look at the new one first.' };
  await fs.promises.writeFile(full, withBody(text, body), 'utf8');
  return { ok: true };
}

/**
 * Forget a memory: trash(full) takes the file (the Recycle Bin, so it can come
 * back), and its line goes from MEMORY.md. -> { ok } | { ok: false, error }
 */
async function forget(memDir, file, trash) {
  const full = fileIn(memDir, file);
  if (!full || same(file, INDEX)) return { ok: false, error: "That isn't one of Claude's memories." };
  try { await trash(full); } catch { return { ok: false, error: "Couldn't move it to the Recycle Bin." }; }
  const index = path.join(memDir, INDEX);
  try {
    const before = await fs.promises.readFile(index, 'utf8');
    const after = dropFromIndex(before, file);
    if (after !== before) await fs.promises.writeFile(index, after, 'utf8');
  } catch { /* no index: nothing points at it */ }
  return { ok: true };
}

module.exports = { configDir, slugOf, memoryDir, memoryOf, parse, withBody, dropFromIndex, pickDir, list, fileIn, saveBody, forget, TYPES, INDEX };
