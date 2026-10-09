// The Toolbox's actions on many items at once: remove a selection (asked once,
// to the Recycle Bin), park and restore (turn one off without losing it), and
// export or import a set as one file to keep or share.
//
// The renderer names items ({ kind, name }); every path comes from the Toolbox's
// own scan and passes skillremove.js's removalTarget, so the same rules hold as
// for removing one: your own only, where Claude Code looks, never through a link.
//
// Parking moves the file (or a skill's folder) into Shellby's own folder, out of
// Claude Code's sight, and writes down where it came from. Restoring moves it
// back, unless something new took its place in the meantime.
const fs = require('fs');
const path = require('path');
const { removalTarget } = require('./skillremove');
const { samePath } = require('./toolbox');

const LIST = { skill: 'skills', agent: 'agents', command: 'commands' };
const MAX_BATCH = 500;
const MAX_PARKED = 1000;
const BUNDLE_FORMAT = 'shellby-tools';
const BUNDLE_VERSION = 1;
const MAX_BUNDLE = 8 * 1024 * 1024;      // the whole export file
const MAX_BUNDLE_FILE = 1024 * 1024;     // one file inside it
const MAX_BUNDLE_FILES = 200;            // files in one skill folder
const MAX_DETAIL_LINES = 12;
const isStr = v => typeof v === 'string' && v.length > 0 && v.length < 300;
// One path segment Windows and Claude Code both accept: no separators, dots-only or reserved names.
const SAFE_SEGMENT = /^(?!\.{1,2}$)(?!(con|prn|aux|nul|com\d|lpt\d)(\..*)?$)[^<>:"/\\|?*\x00-\x1f]{1,120}$/i;
const label = (kind, name) => (kind === 'agent' ? name : `/${name}`);

/** The items a request names, deduplicated and capped: [{ kind, name }]. */
function cleanRefs(refs) {
  if (!Array.isArray(refs)) return [];
  const seen = new Set();
  const out = [];
  for (const r of refs.slice(0, MAX_BATCH)) {
    if (!r || !LIST[r.kind] || !isStr(r.name)) continue;
    const key = `${r.kind}:${r.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: r.kind, name: r.name });
  }
  return out;
}

/** "3 skills, 1 agent": a count per kind, for a question or a toast. */
function countWords(items) {
  const n = { skill: 0, agent: 0, command: 0 };
  for (const t of items) n[t.kind]++;
  const word = { skill: 'skill', agent: 'agent', command: 'command' };
  return Object.keys(n).filter(k => n[k]).map(k => `${n[k]} ${word[k]}${n[k] === 1 ? '' : 's'}`).join(', ');
}

// Rename when it can; across drives (a project on D:, Shellby's folder on C:) copy, then delete.
function move(from, to, fsImpl = fs) {
  fsImpl.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fsImpl.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    try {
      fsImpl.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    } catch (copyErr) {
      // Never leave half a copy behind: at the far end it would pass for the whole thing.
      try { fsImpl.rmSync(to, { recursive: true, force: true }); } catch { /* reported below */ }
      throw copyErr;
    }
    fsImpl.rmSync(from, { recursive: true, force: true });
  }
}

// ---- export bundle

// Every file a tool brings: a skill's whole folder, an agent's or command's one file.
function bundleFiles(target, isDir, fsImpl = fs) {
  if (!isDir) {
    const st = fsImpl.statSync(target);
    if (st.size > MAX_BUNDLE_FILE) throw new Error('too big');
    return [{ path: path.basename(target), data: fsImpl.readFileSync(target).toString('base64') }];
  }
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fsImpl.readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        if (out.length >= MAX_BUNDLE_FILES) throw new Error('too many files');
        if (fsImpl.statSync(abs).size > MAX_BUNDLE_FILE) throw new Error('too big');
        out.push({ path: r, data: fsImpl.readFileSync(abs).toString('base64') });
      }
    }
  };
  walk(target, '');
  return out;
}

/**
 * A bundle someone gave you, checked before anything touches the disk:
 * { ok, tools: [{ kind, name, files: [{ path, data }] }] } or { ok: false, error }.
 * Every name and file path has to be plain segments, so nothing lands outside its folder.
 */
function parseBundle(raw) {
  let b;
  try { b = JSON.parse(raw); } catch { return { ok: false, error: "That isn't a Shellby tools file." }; }
  if (!b || b.format !== BUNDLE_FORMAT || !Array.isArray(b.tools)) return { ok: false, error: "That isn't a Shellby tools file." };
  if (b.version > BUNDLE_VERSION) return { ok: false, error: 'That file is from a newer Shellby. Update Shellby to import it.' };
  const tools = [];
  for (const t of b.tools.slice(0, MAX_BATCH)) {
    if (!t || !LIST[t.kind] || !isStr(t.name) || !Array.isArray(t.files) || !t.files.length) continue;
    // Commands may sit in folders (a:b is commands/a/b.md); everything else is one segment.
    const nameParts = t.kind === 'command' ? t.name.split(':') : [t.name];
    if (!nameParts.every(s => SAFE_SEGMENT.test(s))) continue;
    if (t.kind !== 'skill' && t.files.length !== 1) continue;
    const files = [];
    let bad = false;
    for (const f of t.files.slice(0, MAX_BUNDLE_FILES)) {
      const parts = typeof f?.path === 'string' ? f.path.split('/') : [];
      if (!parts.length || !parts.every(s => SAFE_SEGMENT.test(s)) || typeof f.data !== 'string') { bad = true; break; }
      files.push({ path: parts.join('/'), data: f.data });
    }
    if (bad) continue;
    if (t.kind === 'skill' && !files.some(f => /^skill\.md$/i.test(f.path))) continue;
    // A skills folder with a plugin manifest or hooks is a mod, which runs code in every
    // conversation: that goes through Toolbox → Mods and its own question, never an import.
    if (files.some(f => f.path.split('/').some(s => /^(\.claude-plugin|hooks)$/i.test(s)) || /^(plugin|hooks)\.json$/i.test(f.path))) continue;
    if (t.kind !== 'skill' && !/\.md$/i.test(files[0].path)) continue;
    tools.push({ kind: t.kind, name: t.name, files });
  }
  if (!tools.length) return { ok: false, error: 'There was nothing in that file Shellby could import.' };
  return { ok: true, tools };
}

// Where an imported tool goes under <home>/.claude.
function importDest(home, t) {
  const root = path.join(home, '.claude', LIST[t.kind]);
  if (t.kind === 'skill') return path.join(root, t.name);
  if (t.kind === 'agent') return path.join(root, `${t.name}.md`);
  return path.join(root, ...t.name.split(':').slice(0, -1), `${t.name.split(':').pop()}.md`);
}

// ---- the service

/**
 * deps: { toolbox(), where() -> { home, cwd }, askOnce(spec), trash(path) -> Promise,
 * unpin(kind, name), parkDir, saveFile(opts) -> path|null, openFile(opts) -> path|null,
 * stat(name), log }
 */
function createToolBatch(deps) {
  const fsImpl = deps.fs || fs;
  const manifestFile = () => path.join(deps.parkDir, 'parked.json');

  function findAll(refs) {
    const tb = deps.toolbox()?.current;
    const where = deps.where();
    const ok = [];
    const skipped = [];
    for (const r of cleanRefs(refs)) {
      const t = tb?.[LIST[r.kind]]?.find(x => x.kind === r.kind && x.name === r.name);
      if (!t) { skipped.push({ ...r, why: "isn't in the Toolbox any more" }); continue; }
      const found = removalTarget(t, where, fsImpl);
      if (!found.ok) { skipped.push({ ...r, why: found.plugin ? `comes with the ${found.plugin} plugin` : t.source === 'cli' ? 'is built in' : "isn't one of your own" }); continue; }
      ok.push({ t, ...found });
    }
    return { ok, skipped };
  }

  const skippedNote = skipped => (skipped.length
    ? `Left alone: ${skipped.slice(0, MAX_DETAIL_LINES).map(s => `${label(s.kind, s.name)} ${s.why}`).join('; ')}${skipped.length > MAX_DETAIL_LINES ? `; and ${skipped.length - MAX_DETAIL_LINES} more` : ''}.`
    : null);

  // What changed, with a fresh scan. None of them done (each one failed) is not ok,
  // with the first reason, so the panel says why rather than "0 restored".
  const done = (extra, didAny) => {
    deps.toolbox()?.rescan({ plugins: false });
    const failed = extra.failed || [];
    const ok = didAny || !failed.length;
    const why = failed[0] ? `${label(failed[0].kind, failed[0].name)}: ${failed[0].why || "Windows wouldn't move it. Is a file in it open somewhere?"}` : '';
    return { ok, ...(ok ? {} : { error: `Nothing changed. ${why}` }), ...extra, toolbox: deps.toolbox()?.current || null, parkedList: listParked() };
  };

  // ---- remove many

  async function removeMany(refs) {
    const { ok, skipped } = findAll(refs);
    if (!ok.length) return { ok: false, error: skipped.length ? `Nothing there Shellby can remove: ${skipped.length === 1 ? `${label(skipped[0].kind, skipped[0].name)} ${skipped[0].why}` : "they're plugins' or built in"}.` : 'Nothing picked.' };
    const names = ok.map(f => label(f.t.kind, f.t.name));
    const response = await deps.askOnce({
      icon: '🗑️', title: `Remove ${countWords(ok.map(f => f.t))}?`,
      message: 'They go to the Recycle Bin, so you can restore them from there. New conversations won\'t have them; open ones keep them until they end. Parking them instead keeps them in Shellby, one click from back.',
      detail: [
        names.slice(0, MAX_DETAIL_LINES).join(', ') + (names.length > MAX_DETAIL_LINES ? `, and ${names.length - MAX_DETAIL_LINES} more` : ''),
        ok.some(f => f.t.source === 'project') ? "Some belong to this project, so anyone else working on it loses them too once the change is shared." : null,
        skippedNote(skipped),
      ].filter(Boolean).join('\n'),
      buttons: [{ label: 'Move to Recycle Bin', style: 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response === null) return { ok: false, cancelled: true, busy: true };
    if (response !== 0) return { ok: false, cancelled: true };
    const removed = [];
    const failed = [];
    for (const f of ok) {
      try {
        await deps.trash(f.target);
        removed.push({ kind: f.t.kind, name: f.t.name });
        deps.unpin?.(f.t.kind, f.t.name);
      } catch (err) {
        deps.log?.warn(`toolbox: couldn't move ${f.target} to the Recycle Bin: ${err.message}`);
        failed.push({ kind: f.t.kind, name: f.t.name });
      }
    }
    if (removed.length) deps.stat?.('tool-removed');
    return done({ removed, failed, skipped }, removed.length > 0);
  }

  // ---- park and restore

  // The list exactly as written, entries Shellby doesn't recognise included, so a
  // rewrite never forgets where something was parked. A file that won't parse is
  // { ok: false }: nothing is parked or restored over it until it's sorted out.
  function readManifest() {
    let raw;
    try { raw = fsImpl.readFileSync(manifestFile(), 'utf8'); } catch (err) {
      return err.code === 'ENOENT' ? { ok: true, list: [] } : { ok: false };
    }
    try {
      const list = JSON.parse(raw);
      return Array.isArray(list) ? { ok: true, list } : { ok: false };
    } catch { return { ok: false }; }
  }
  const BAD_MANIFEST = { ok: false, error: `Shellby's list of parked tools couldn't be read, so it won't change anything. It's parked.json in Shellby's parked-tools folder.` };

  const isEntry = p => !!p && isStr(p.id) && SAFE_SEGMENT.test(p.id) && !!LIST[p.kind] && isStr(p.name) && typeof p.from === 'string' && typeof p.to === 'string';

  // Where a parked one sits must be exactly <parkDir>/<id>/<its own name>, and where it
  // goes back to must be inside a .claude/<kind> folder under that same name.
  function safeWay(p) {
    if (!isEntry(p)) return null;
    const to = path.resolve(p.to);
    const from = path.resolve(p.from);
    const base = path.basename(to);
    if (!SAFE_SEGMENT.test(base) || !samePath(to, path.join(deps.parkDir, p.id, base))) return null;
    if (path.basename(from).toLowerCase() !== base.toLowerCase()) return null;
    const parts = from.split(path.sep).map(s => s.toLowerCase());
    const at = parts.lastIndexOf(LIST[p.kind]);
    if (at < 1 || parts[at - 1] !== '.claude' || at >= parts.length - 1) return null;
    return { to, from };
  }

  function writeManifest(list) {
    fsImpl.mkdirSync(deps.parkDir, { recursive: true });
    const tmp = `${manifestFile()}.tmp`;
    fsImpl.writeFileSync(tmp, JSON.stringify(list, null, 1));
    fsImpl.renameSync(tmp, manifestFile());
  }

  // What the panel sees: never the folder Shellby keeps them in.
  function listParked() {
    const m = readManifest();
    if (!m.ok) return [];
    return m.list.filter(isEntry).map(p => ({ id: p.id, kind: p.kind, name: p.name, source: p.source, description: typeof p.description === 'string' ? p.description : '', from: p.from, at: p.at }));
  }

  function park(refs) {
    const { ok, skipped } = findAll(refs);
    if (!ok.length) return { ok: false, error: skipped.length ? `Nothing there Shellby can park: ${skipped[0].why === 'is built in' ? "they're built in" : "they're plugins' (turn a plugin off in Lean)"}.` : 'Nothing picked.' };
    const m = readManifest();
    if (!m.ok) return BAD_MANIFEST;
    if (m.list.length + ok.length > MAX_PARKED) return { ok: false, error: `Shellby keeps up to ${MAX_PARKED} parked. Restore or remove some first.` };
    let list = m.list;
    const parked = [];
    const failed = [];
    const movedIds = new Set();
    for (const f of ok) {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const to = path.join(deps.parkDir, id, path.basename(f.target));
      try {
        move(f.target, to, fsImpl);
      } catch (err) {
        deps.log?.warn(`toolbox: couldn't park ${f.target}: ${err.message}`);
        failed.push({ kind: f.t.kind, name: f.t.name });
        continue;
      }
      list = [...list, { id, kind: f.t.kind, name: f.t.name, source: f.t.source, description: f.t.description || '', from: f.target, to, isDir: f.isDir, at: Date.now() }];
      parked.push({ kind: f.t.kind, name: f.t.name });
      movedIds.add(id);
    }
    if (parked.length) {
      try { writeManifest(list); } catch (err) {
        // The files moved but where they came from wasn't written down: put them back.
        deps.log?.warn(`toolbox: couldn't save the parked list: ${err.message}`);
        for (const p of list.filter(x => movedIds.has(x.id))) {
          try { move(p.to, p.from, fsImpl); } catch { /* left in the parked folder; logged above */ }
        }
        return { ok: false, error: "Shellby couldn't keep track of them, so nothing was parked." };
      }
      for (const p of parked) deps.unpin?.(p.kind, p.name);
      deps.stat?.('tool-parked');
    }
    return done({ parked, failed, skipped }, parked.length > 0);
  }

  function restore(ids) {
    const want = new Set((Array.isArray(ids) ? ids : []).filter(isStr).slice(0, MAX_BATCH));
    const m = readManifest();
    if (!m.ok) return BAD_MANIFEST;
    const restored = [];
    const failed = [];
    const keep = [];
    for (const p of m.list) {
      if (!isEntry(p) || !want.has(p.id)) { keep.push(p); continue; }
      // The way back must still be a place Shellby would have taken it from.
      const way = safeWay(p);
      if (!way) { keep.push(p); failed.push({ ...p, why: "Shellby can't be sure where it goes back" }); continue; }
      if (fsImpl.existsSync(way.from)) { keep.push(p); failed.push({ ...p, why: 'a new one with that name is there now' }); continue; }
      const to = way.to;
      try {
        move(to, way.from, fsImpl);
        try { fsImpl.rmSync(path.dirname(to), { recursive: true, force: true }); } catch { /* an empty folder left behind */ }
        restored.push({ kind: p.kind, name: p.name });
      } catch (err) {
        deps.log?.warn(`toolbox: couldn't restore ${p.from}: ${err.message}`);
        keep.push(p);
        failed.push({ ...p, why: "it couldn't be moved back" });
      }
    }
    try { writeManifest(keep); } catch (err) { deps.log?.warn(`toolbox: couldn't save the parked list: ${err.message}`); }
    return done({ restored, failed: failed.map(f => ({ kind: f.kind, name: f.name, why: f.why })) }, restored.length > 0);
  }

  // ---- export and import

  async function exportMany(refs) {
    const { ok, skipped } = findAll(refs);
    if (!ok.length) return { ok: false, error: 'Only your own skills, agents and commands can be exported. A plugin\'s comes with its plugin.' };
    const tools = [];
    let size = 0;
    for (const f of ok) {
      let files;
      try { files = bundleFiles(f.target, f.isDir, fsImpl); } catch { skipped.push({ kind: f.t.kind, name: f.t.name, why: 'is too big to export' }); continue; }
      size += files.reduce((n, x) => n + x.data.length, 0);
      if (size > MAX_BUNDLE) return { ok: false, error: 'That is too much for one file. Pick fewer.' };
      tools.push({ kind: f.t.kind, name: f.t.name, files });
    }
    if (!tools.length) return { ok: false, error: skippedNote(skipped) || 'Nothing to export.' };
    const file = await deps.saveFile({ title: 'Export these tools', name: 'shellby-tools.json' });
    if (!file) return { ok: false, cancelled: true };
    try {
      fsImpl.writeFileSync(file, JSON.stringify({ format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: new Date().toISOString(), tools }));
    } catch (err) { return { ok: false, error: `Couldn't write it: ${err.code || err.message}` }; }
    return { ok: true, path: file, count: tools.length, skipped };
  }

  async function importBundle() {
    const file = await deps.openFile({ title: 'Import tools' });
    if (!file) return { ok: false, cancelled: true };
    let raw;
    try {
      if (fsImpl.statSync(file).size > MAX_BUNDLE * 1.5) return { ok: false, error: 'That file is too big to be a Shellby tools file.' };
      raw = fsImpl.readFileSync(file, 'utf8');
    } catch (err) { return { ok: false, error: `Couldn't read it: ${err.code || err.message}` }; }
    const parsed = parseBundle(raw);
    if (!parsed.ok) return parsed;
    const { home } = deps.where();
    // ~/.claude and its skills/agents/commands folders have to be real folders: written
    // through a link, an import would land wherever the link points.
    const linked = Object.values(LIST).concat('').some(sub => {
      try { return fsImpl.lstatSync(path.join(home, '.claude', sub)).isSymbolicLink(); } catch { return false; }
    });
    if (linked) return { ok: false, error: 'Your Claude folder (or a folder in it) is a link to somewhere else, so Shellby leaves importing to you.' };
    // One per destination: a bundle naming the same one twice adds the first.
    const seen = new Set();
    const fresh = parsed.tools.filter(t => {
      const dest = importDest(home, t).toLowerCase();
      if (seen.has(dest) || fsImpl.existsSync(importDest(home, t))) return false;
      seen.add(dest);
      return true;
    });
    const taken = parsed.tools.filter(t => !fresh.includes(t));
    if (!fresh.length) return { ok: false, error: `You already have ${parsed.tools.length === 1 ? 'that one' : 'all of them'}.` };
    const names = fresh.map(t => label(t.kind, t.name));
    // Scripts and other files a skill brings, named, since they can do more than words can.
    const extras = fresh.flatMap(t => (t.kind === 'skill' ? t.files.filter(f => !/\.md$/i.test(f.path)).map(f => `${t.name}/${f.path}`) : []));
    const response = await deps.askOnce({
      icon: '📦', title: `Add ${countWords(fresh)} to your Claude folder?`,
      message: 'They go in ~/.claude, so every project has them from the next conversation. Skills and agents tell Claude what to do: add only ones from someone you trust.',
      detail: [
        names.slice(0, MAX_DETAIL_LINES).join(', ') + (names.length > MAX_DETAIL_LINES ? `, and ${names.length - MAX_DETAIL_LINES} more` : ''),
        extras.length ? `Files besides instructions, which Claude may run: ${extras.slice(0, MAX_DETAIL_LINES).join(', ')}${extras.length > MAX_DETAIL_LINES ? `, and ${extras.length - MAX_DETAIL_LINES} more` : ''}.` : null,
        taken.length ? `Already yours (or named twice), left as they are: ${taken.map(t => label(t.kind, t.name)).join(', ')}.` : null,
      ].filter(Boolean).join('\n'),
      buttons: [{ label: 'Add them', style: 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response === null) return { ok: false, cancelled: true, busy: true };
    if (response !== 0) return { ok: false, cancelled: true };
    const added = [];
    const failed = [];
    for (const t of fresh) {
      const dest = importDest(home, t);
      try {
        if (t.kind === 'skill') {
          // Written in ~/.claude but outside skills/ (where the Toolbox would spot it half
          // done), then renamed into place, so a failure never leaves half a skill.
          const staging = path.join(home, '.claude', `.shellby-importing-${process.pid}`, t.name);
          fsImpl.mkdirSync(path.dirname(dest), { recursive: true });
          try {
            for (const f of t.files) {
              const to = path.join(staging, ...f.path.split('/'));
              fsImpl.mkdirSync(path.dirname(to), { recursive: true });
              fsImpl.writeFileSync(to, Buffer.from(f.data, 'base64'), { flag: 'wx' });
            }
            fsImpl.renameSync(staging, dest);
          } finally {
            try { fsImpl.rmSync(path.dirname(staging), { recursive: true, force: true }); } catch { /* nothing left to clean */ }
          }
        } else {
          fsImpl.mkdirSync(path.dirname(dest), { recursive: true });
          fsImpl.writeFileSync(dest, Buffer.from(t.files[0].data, 'base64'), { flag: 'wx' });
        }
        added.push({ kind: t.kind, name: t.name });
      } catch (err) {
        deps.log?.warn(`toolbox: couldn't import ${t.kind} ${t.name}: ${err.message}`);
        failed.push({ kind: t.kind, name: t.name, why: "it couldn't be written" });
      }
    }
    if (added.length) deps.stat?.('tools-imported');
    return done({ added, failed, skipped: taken.map(t => ({ kind: t.kind, name: t.name })) }, added.length > 0);
  }

  function register(ipcMain) {
    ipcMain.handle('toolbox:remove-many', (_e, refs) => removeMany(refs));
    ipcMain.handle('toolbox:park', (_e, refs) => park(refs));
    ipcMain.handle('toolbox:restore', (_e, ids) => restore(ids));
    ipcMain.handle('toolbox:parked', () => listParked());
    ipcMain.handle('toolbox:export', (_e, refs) => exportMany(refs));
    ipcMain.handle('toolbox:import', () => importBundle());
  }

  return { removeMany, park, restore, listParked, exportMany, importBundle, register };
}

module.exports = { createToolBatch, parseBundle, cleanRefs, countWords, importDest, BUNDLE_FORMAT };
