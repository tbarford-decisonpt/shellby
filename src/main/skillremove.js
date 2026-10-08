// Removing (or editing) one of your own skills, slash commands or agents from the
// Toolbox. Only what lives in ~/.claude or the project's .claude: a plugin's come and go
// with the plugin (Lean turns one off, the Skill Shop uninstalls it), and Claude
// Code's built-in ones aren't files at all.
//
// The renderer names the thing ({ kind, name }); the path always comes from the
// Toolbox's own scan, and has to sit right where Claude Code looks for that kind.
// It's asked first, and goes to the Recycle Bin, never deleted outright, so a
// skill removed by mistake is one Restore away.
const fs = require('fs');
const path = require('path');
const { samePath } = require('./toolbox');
const eff = require('./efficiency');
const claudeSetup = require('./claude/setup');

const MAX_EDIT = 256 * 1024; // the Toolbox skips bigger files, so saving one would make it vanish

const LIST = { skill: 'skills', agent: 'agents', command: 'commands' };
const NOUN = { skill: 'skill', agent: 'agent', command: 'slash command' };
const USAGE_WAIT_MS = 1500;
const isStr = v => typeof v === 'string' && v.length > 0 && v.length < 300;

function isInside(file, dir) {
  const rel = path.relative(dir, file);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * What removing a Toolbox item would move to the Recycle Bin: { ok, target }
 * (a skill's whole folder, an agent's or command's file), or { ok: false, error }.
 * where: { home, cwd }, the same folders the Toolbox scans.
 */
function removalTarget(t, where = {}, fsImpl = fs) {
  if (!t || !LIST[t.kind]) return { ok: false, error: "Shellby can't remove that." };
  const src = typeof t.source === 'string' ? t.source : '';
  if (src.startsWith('plugin:')) {
    return { ok: false, plugin: src.slice(7), error: `It comes with the ${src.slice(7)} plugin. Turn the plugin off in the Lean tab, or uninstall it in the Skill Shop.` };
  }
  if (src === 'cli') return { ok: false, error: "It's built into Claude Code, so there's nothing to remove." };
  const base = src === 'user' ? where.home : src === 'project' ? where.cwd : null;
  if (!base || !isStr(t.path)) return { ok: false, error: "Shellby can't remove that." };
  const dir = path.join(base, '.claude', LIST[t.kind]);
  // A skill is a folder right inside skills/; agents and commands are files anywhere under theirs.
  const target = t.kind === 'skill' ? path.dirname(t.path) : t.path;
  const placed = t.kind === 'skill' ? samePath(path.dirname(target), dir) && /^skill\.md$/i.test(path.basename(t.path)) : isInside(target, dir);
  if (!placed) return { ok: false, error: "It isn't where Claude Code keeps your own, so Shellby leaves it alone." };
  let st;
  try { st = fsImpl.lstatSync(target); } catch { return { ok: false, error: "It's already gone." }; }
  // A link's target lives somewhere else, maybe shared: that's for you to sort out.
  // That goes for a link anywhere between .claude and the file (agents/shared ->
  // D:\team), which lstat on the file itself can't see: resolved, it has to land
  // exactly where it says it is. (The home or project folder may be a link.)
  const linked = { ok: false, error: "It's in a linked folder kept somewhere else. Use Show file to remove it yourself." };
  if (st.isSymbolicLink()) return linked;
  try {
    if (!samePath(fsImpl.realpathSync(target), path.join(fsImpl.realpathSync(base), path.relative(base, target)))) return linked;
  } catch { return { ok: false, error: "It's already gone." }; }
  return { ok: true, target, isDir: st.isDirectory() };
}

/**
 * The file the Toolbox's editor may open for an item: { ok, file } or { ok: false, error }.
 * The same places removal allows (your own, where Claude Code looks, not via a link).
 */
function editTarget(t, where = {}, fsImpl = fs) {
  const found = removalTarget(t, where, fsImpl);
  if (found.ok) {
    // For a skill, removal only checked its folder. The file itself must not be
    // a link either: saving follows links, and this one could point anywhere.
    const base = t.source === 'user' ? where.home : where.cwd;
    try {
      if (fsImpl.lstatSync(t.path).isSymbolicLink()
        || !samePath(fsImpl.realpathSync(t.path), path.join(fsImpl.realpathSync(base), path.relative(base, t.path)))) {
        return { ok: false, error: "It's a link to a file kept somewhere else. Use Show file to edit it yourself." };
      }
    } catch { return { ok: false, error: "It's already gone." }; }
    return { ok: true, file: t.path };
  }
  if (found.plugin) return { ok: false, error: `It comes with the ${found.plugin} plugin, which would put back its own copy on the next update. Use Show file to read it.` };
  if (t?.source === 'cli') return { ok: false, error: "It's built into Claude Code, so there's no file to edit." };
  return { ok: false, error: "Shellby only edits your own skills, agents and commands. Use Show file to open it in your editor." };
}

/**
 * deps: { toolbox(), where() -> { home, cwd }, askOnce(spec), trash(path) -> Promise,
 * usage() -> lean usage, unpin(kind, name), stat(name), log }
 */
function createSkillRemover(deps) {
  async function remove(kind, name) {
    const tb = deps.toolbox()?.current;
    const t = tb?.[LIST[kind]]?.find(x => x.kind === kind && x.name === name);
    if (!t) return { ok: false, error: "That isn't in the Toolbox any more." };
    const where = deps.where();
    const found = removalTarget(t, where);
    if (!found.ok) return found;

    // How often it's used, if that's quick to hand: a first transcript scan can
    // take a while, and the question makes sense without it.
    let u = null;
    let timer;
    try {
      const got = await Promise.race([deps.usage(), new Promise(resolve => { timer = setTimeout(resolve, USAGE_WAIT_MS, null); })]);
      u = got?.tools?.[`${kind}:${name}`] || null;
    } catch { /* ask without it */ } finally { clearTimeout(timer); }
    const cost = eff.toolTokens(t);
    const label = kind === 'agent' ? name : `/${name}`;
    const response = await deps.askOnce({
      icon: '🗑️', title: `Remove the ${NOUN[kind]} ${label}?`,
      message: `${found.isDir ? 'Its folder' : 'Its file'} goes to the Recycle Bin, so you can restore it from there. New conversations won't have it; open ones keep it until they end.`,
      detail: [
        found.target,
        cost.listTokens ? `Its name and description are about ${cost.listTokens.toLocaleString()} tokens in every conversation${cost.useTokens ? `, and Claude reads about ${cost.useTokens.toLocaleString()} more each time it's used` : ''}.` : null,
        u ? (u.uses ? `Used ${u.uses} time${u.uses === 1 ? '' : 's'} lately${Number.isFinite(u.lastUsed) ? `, last on ${new Date(u.lastUsed).toLocaleDateString()}` : ''}.` : "Shellby hasn't seen it used in this PC's recent Claude Code history.") : null,
        t.source === 'project' ? 'It belongs to this project, so anyone else working on it loses it too once the change is shared.' : null,
      ].filter(Boolean).join('\n'),
      buttons: [{ label: 'Move to Recycle Bin', style: 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response === null) return { ok: false, cancelled: true, busy: true };
    if (response !== 0) return { ok: false, cancelled: true };

    try {
      await deps.trash(found.target);
    } catch (err) {
      deps.log?.warn(`toolbox: couldn't move ${found.target} to the Recycle Bin: ${err.message}`);
      return { ok: false, error: "Windows wouldn't move it to the Recycle Bin. Is a file in it open somewhere?" };
    }
    deps.unpin?.(kind, name);
    deps.stat?.('tool-removed');
    deps.toolbox()?.rescan({ plugins: false });
    return { ok: true, toolbox: deps.toolbox()?.current || null };
  }

  // The editor names an item by its file, which stays put when its frontmatter
  // renames it; the path still has to be one the Toolbox's own scan reported.
  function find(kind, file) {
    if (!LIST[kind] || !isStr(file)) return null;
    return deps.toolbox()?.current?.[LIST[kind]]?.find(x => x.path && samePath(x.path, file)) || null;
  }

  function read(kind, file) {
    const t = find(kind, file);
    if (!t) return { ok: false, error: "That isn't in the Toolbox any more." };
    const target = editTarget(t, deps.where());
    return target.ok ? claudeSetup.readMemory(target.file) : target;
  }

  function write(kind, file, text, mtimeMs) {
    const t = find(kind, file);
    if (!t) return { ok: false, error: "That isn't in the Toolbox any more." };
    const target = editTarget(t, deps.where());
    if (!target.ok) return target;
    if (typeof text !== 'string' || !Number.isFinite(mtimeMs)) return { ok: false, error: "Couldn't save that file." };
    // Counted as if every line ending became \r\n: writeMemory keeps a CRLF file CRLF.
    if (Buffer.byteLength(text.replace(/\r?\n/g, '\r\n')) > MAX_EDIT) return { ok: false, error: 'That is too long for one file here. Open it in your editor instead.' };
    let r;
    try { r = claudeSetup.writeMemory(target.file, text, mtimeMs); } catch { r = { ok: false, error: "Couldn't save that file." }; }
    if (!r.ok) return r;
    deps.stat?.('tool-edited');
    deps.toolbox()?.rescan({ plugins: false });
    return { ...r, toolbox: deps.toolbox()?.current || null };
  }

  function register(ipcMain) {
    ipcMain.handle('toolbox:remove', (_e, a) => (LIST[a?.kind] && isStr(a?.name) ? remove(a.kind, a.name) : { ok: false, error: "Shellby can't remove that." }));
    ipcMain.handle('toolbox:read', (_e, a) => read(a?.kind, a?.path));
    ipcMain.handle('toolbox:write', (_e, a) => write(a?.kind, a?.path, a?.text, a?.mtimeMs));
  }

  return { remove, read, write, register };
}

module.exports = { removalTarget, editTarget, createSkillRemover };
