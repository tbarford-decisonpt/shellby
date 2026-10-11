// @ mentions for Shellby's own context (mention-context.js): what a tab's
// project has that Claude can't see. Its dev servers' output, its red pull
// requests' build logs, its other conversations and its open notes.
//
// suggest() lists them from what's already in memory (no network). attach()
// takes the snapshot: a text file under context/<random>/ holding exactly the
// block Claude will get, returned as a path the panel attaches like any other
// file. readForClaude() is how composePrompt (wiring/timetrack.js) finds them
// again: only a file Shellby wrote there, never a path a renderer made up.
// Kept out of main.js, which only wires it up.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const gitinfo = require('../gitinfo');
const mc = require('../mention-context');

const ROOT_TTL_MS = 10000;
const MAX_CHATS = 8;
const MAX_NOTES = 6;
const MAX_FILE_BYTES = 128 * 1024;
const KEEP_DAYS = 30;

const fold = p => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
const inside = (p, root) => {
  const a = fold(path.resolve(p));
  const r = fold(path.resolve(root));
  return a === r || a.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
};

/**
 * d: what main shares (main.js `shared`).
 * opts.dir() -> where snapshots go; opts.projectOf(dir) (tests); opts.now().
 */
function wireMentionContext(d, opts = {}) {
  const dir = opts.dir || (() => path.join(require('electron').app.getPath('userData'), 'context'));
  const projectOf = opts.projectOf || gitinfo.projectOf;
  const now = opts.now || Date.now;
  const roots = new Map(); // tabId -> { at, home }
  let pruned = false;

  // The project a tab works in: a copy counts as the clone it came from.
  async function homeOf(tab) {
    const hit = roots.get(tab.id);
    if (hit && now() - hit.at < ROOT_TTL_MS) return hit.home;
    const cwd = tab.worktree?.originalCwd || tab.session.cwd;
    const p = await projectOf(cwd).catch(() => null);
    const home = { root: p?.root || path.resolve(cwd), remote: p?.remote || null };
    roots.set(tab.id, { at: now(), home });
    if (roots.size > 50) roots.delete(roots.keys().next().value);
    return home;
  }

  // Every item for a tab, each with what attach() needs to make its body.
  async function sources(tabId) {
    const tab = d.manager.tabs.get(tabId);
    if (!tab) return [];
    const { root, remote } = await homeOf(tab);
    const out = [];
    for (const s of d.devServers?.forRoot(root) || []) {
      if (!s.hasLog) continue;
      const state = s.status === 'up' && s.port ? `up on :${s.port}` : s.status || 'stopped';
      out.push({ id: `server:${s.id}`, kind: 'server', label: mc.clip(`${s.project} ${s.script || 'dev server'}`, mc.MAX_LABEL), sub: `dev server, ${state}`, ref: s });
    }
    const want = remote ? fold(remote) : null;
    for (const pr of d.ci?.view().prs || []) {
      if (pr.state !== 'failing' || !want || !want.endsWith(`/${fold(pr.repo)}`)) continue;
      out.push({ id: `ci:${pr.key}`, kind: 'ci', label: mc.clip(`Failing build ${pr.ref}`, mc.MAX_LABEL), sub: mc.clip(pr.title, 60), ref: pr });
    }
    for (const n of (d.openNotesFor?.(root) || []).slice(0, MAX_NOTES)) {
      out.push({ id: `note:${n.id}`, kind: 'note', label: mc.clip(n.text, mc.MAX_LABEL), sub: 'note', ref: n });
    }
    const chats = (d.history?.list() || [])
      .filter(e => e.id !== tabId && inside(e.worktree?.originalCwd || e.cwd || '', root))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, MAX_CHATS);
    for (const e of chats) out.push({ id: `chat:${e.id}`, kind: 'chat', label: mc.clip(e.title || 'Untitled', mc.MAX_LABEL), sub: `chat, ${mc.ago(e.updatedAt || 0, now())}`, ref: e });
    return out;
  }

  /** For the @ menu: [{ id, kind, glyph, label, sub }]. */
  async function suggest(tabId, query) {
    return mc.suggest(await sources(tabId), query).map(({ id, kind, label, sub }) => ({ id, kind, glyph: mc.KINDS[kind].glyph, label, sub }));
  }

  async function bodyOf(item) {
    if (item.kind === 'server') {
      const log = d.devServers.log(item.ref.id);
      return log ? { ok: true, from: `Dev server: ${item.label}`, body: mc.serverBody(item.ref, log.lines) } : { ok: false, error: 'That server has gone.' };
    }
    if (item.kind === 'ci') {
      const r = await d.ciLog(item.ref.key);
      if (!r.ok) return r;
      return { ok: true, from: `Build log: ${item.ref.ref}`, body: mc.ciBody({ ref: item.ref.ref, title: item.ref.title, job: r.job, lines: r.lines, why: r.why }) };
    }
    if (item.kind === 'note') return { ok: true, from: 'Note', body: item.ref.text };
    const e = item.ref;
    return { ok: true, from: `Conversation: ${e.title || 'Untitled'}`, body: mc.chatBody(e.title, d.history.load(e.id)) };
  }

  /** A pick: its snapshot saved. -> { ok, path } | { ok: false, error } */
  async function attach(tabId, id) {
    const item = (await sources(tabId)).find(i => i.id === id);
    if (!item) return { ok: false, error: "That isn't there any more. Type @ again." };
    const b = await bodyOf(item);
    if (!b.ok) return b;
    if (!pruned) { pruned = true; prune(); }
    try {
      const folder = path.join(dir(), crypto.randomBytes(4).toString('hex'));
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, mc.fileName(item.kind, item.label));
      fs.writeFileSync(file, mc.block(b.from, b.body));
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: `Couldn't save it: ${err.message}` };
    }
  }

  /** A context file's block, for composePrompt; null for any other file. */
  function readForClaude(file) {
    try {
      if (typeof file !== 'string' || !mc.NAME_RE.test(path.basename(file))) return null;
      const base = fs.realpathSync.native(dir());
      const real = fs.realpathSync.native(file);
      if (!/^[0-9a-f]{8}$/.test(path.basename(path.dirname(real))) || fold(path.dirname(path.dirname(real))) !== fold(base)) return null;
      const st = fs.statSync(real);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      return mc.parse(fs.readFileSync(real, 'utf8'));
    } catch { return null; }
  }

  // Snapshots older than KEEP_DAYS go: their chips in old chats just stop opening.
  function prune() {
    let names;
    try { names = fs.readdirSync(dir()); } catch { return; }
    for (const name of names) {
      if (!/^[0-9a-f]{8}$/.test(name)) continue;
      const p = path.join(dir(), name);
      try { if (now() - fs.statSync(p).mtimeMs > KEEP_DAYS * 86400000) fs.rmSync(p, { recursive: true, force: true }); } catch { /* next time */ }
    }
  }

  return { suggest, attach, readForClaude };
}

module.exports = { wireMentionContext };
