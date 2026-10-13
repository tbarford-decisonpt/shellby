/* All files' pure parts (panel/files-dock.js): which rows are lit, and in what tone, as Claude
   reads, writes and commits; the folders a flash opens and closes again; the rows that pin to
   the top; and the git marks rolled up into each folder. No DOM, so node:test runs it.
   Paths are relative to the tree's root, with forward slashes. A row's key is its path in lower
   case: a tool call, the file index and git can each spell a path's case their own way. */
(function (root) {
  'use strict';
  const T = typeof module !== 'undefined' && module.exports ? require('./trail') : root.ShellbyTrail;

  const AFTERGLOW_MS = 2700; // a burst stays lit this long after its last step
  const MAX_REVEAL = 12;     // files a burst opens folders for
  const MAX_FLASH = 200;     // files one shell command lights
  const ROW_CAP = 1500;      // rows drawn; past this, "… N more"
  const TONES = { read: 1, write: 2, commit: 3 }; // the stronger stays on a row for the burst
  const READS = new Set(['Read', 'NotebookRead']);
  const WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  const SEARCHES = new Set(['Grep', 'Glob']);
  const RUNS = new Set(['Bash', 'PowerShell']);

  const keyOf = rel => String(rel || '').toLowerCase();
  const isAbs = p => /^([a-z]:[\\/]|[\\/])/i.test(String(p || ''));
  const ancestors = rel => String(rel).split('/').slice(0, -1).map((_s, i, parts) => parts.slice(0, i + 1).join('/'));

  /** A tool's path relative to the tree's root, or null (none, outside it, or the root itself). cwd: for a relative path. */
  function relOf(p, rootDir, cwd = null) {
    if (typeof p !== 'string' || !p || !rootDir) return null;
    const abs = isAbs(p) ? p : cwd ? `${cwd}/${p}` : null;
    const rel = abs ? T.relTo(abs, rootDir) : null;
    return rel || null;
  }

  function create() {
    return { lit: new Map(), running: new Set(), runs: new Set(), until: 0, revealed: new Set(), touched: new Set(), reveals: 0, newest: null, ranShell: false };
  }

  /** Light rows; the burst then lasts until AFTERGLOW_MS after its last step (for ever while one runs). */
  function light(s, rels, tone, now) {
    const list = (rels || []).filter(Boolean).slice(0, MAX_FLASH);
    for (const rel of list) {
      const k = keyOf(rel);
      const had = s.lit.get(k);
      if (!had || TONES[tone] > TONES[had.tone]) s.lit.set(k, { rel, tone });
      s.newest = rel;
    }
    if (list.length) s.until = s.running.size ? Infinity : now + AFTERGLOW_MS;
    return list.length > 0;
  }

  /**
   * One of the conversation's items (feed.js, beside the trail). A file lights while its tool
   * runs; its result starts the afterglow. Bash and PowerShell don't say what they'll touch:
   * their result asks for the next status read to be compared with the one before (ranShell).
   * -> whether anything changed
   */
  function take(s, item, { root: rootDir, cwd = null, now = Date.now(), replay = false } = {}) {
    if (replay || !item || typeof item !== 'object') return false;
    if (item.kind === 'tool') {
      if (item.agent) return false;
      if (RUNS.has(item.name)) { if (item.id) s.runs.add(item.id); return false; }
      const t = item.target && typeof item.target === 'object' ? item.target : {};
      const tone = READS.has(item.name) || SEARCHES.has(item.name) ? 'read' : WRITES.has(item.name) ? 'write' : null;
      const p = SEARCHES.has(item.name) ? t.path : item.filePath || t.path;
      const rel = tone ? relOf(p, rootDir, cwd) : null;
      if (!rel) return false;
      if (item.id) s.running.add(item.id);
      return light(s, [rel], tone, now);
    }
    if (item.kind === 'tool_result') {
      if (s.runs.delete(item.id)) { s.ranShell = true; return false; }
      if (!s.running.delete(item.id)) return false;
      if (!s.running.size) s.until = now + AFTERGLOW_MS;
      return true;
    }
    if (item.kind === 'result') { // the turn is over: nothing is running any more
      const had = s.running.size > 0;
      s.running.clear();
      s.runs.clear();
      if (had) s.until = now + AFTERGLOW_MS;
      return had;
    }
    return false;
  }

  /** The burst is over at `now`: all dark, and the folders it opened close unless you touched them. -> keys to close | null */
  function expire(s, now = Date.now()) {
    if (!s.lit.size || now < s.until) return null;
    s.lit.clear();
    s.newest = null;
    s.reveals = 0;
    const close = [...s.revealed].filter(k => !s.touched.has(k));
    s.revealed.clear();
    s.touched.clear();
    return close;
  }

  /** The folders to open so a lit file shows, for at most MAX_REVEAL files a burst. isOpen(key). -> keys to open */
  function reveal(s, rel, isOpen) {
    if (s.reveals >= MAX_REVEAL) return [];
    const want = ancestors(keyOf(rel)).filter(k => !isOpen(k));
    if (!want.length) return [];
    s.reveals++;
    for (const k of want) s.revealed.add(k);
    return want;
  }

  /** You opened or closed a folder yourself: a flash never closes it on you. */
  function touch(s, p) { s.touched.add(keyOf(p)); }

  /**
   * The marks rolled up into each folder, by key ('' is the whole repo): lines added and removed,
   * and how many files carry each mark. An untracked folder git lists whole ('new/') counts once
   * in its parents.
   */
  function totals(files) {
    const out = new Map();
    const at = k => {
      if (!out.has(k)) out.set(k, { added: 0, removed: 0, M: 0, A: 0, D: 0, R: 0, U: 0, '?': 0 });
      return out.get(k);
    };
    at('');
    for (const f of files || []) {
      const p = keyOf(f.path).replace(/\/$/, '');
      for (const d of ['', ...ancestors(p)]) {
        const t = at(d);
        t[f.status] = (t[f.status] || 0) + 1;
        t.added += f.added || 0;
        t.removed += f.removed || 0;
      }
    }
    return out;
  }

  /** A folder's totals in a few words: "+12 −3 M:2 ?:1", or '' when nothing changed under it. */
  function totalsText(t) {
    if (!t) return '';
    const bits = [];
    if (t.added || t.removed) bits.push(`+${t.added} −${t.removed}`);
    for (const k of ['M', 'A', 'R', '?', 'D', 'U']) if (t[k]) bits.push(`${k}:${t[k]}`);
    return bits.join(' ');
  }

  /** A row's mark: its own, or '?' inside a folder git lists as untracked whole. */
  function markOf(marks, rel) {
    const k = keyOf(rel);
    if (marks.has(k)) return marks.get(k);
    if (marks.has(`${k}/`)) return marks.get(`${k}/`);
    for (const d of ancestors(k)) if (marks.get(`${d}/`) === '?') return '?';
    return null;
  }

  /** What changed between two status answers (a shell command's doing): paths, at most MAX_FLASH. */
  function changedBetween(before, after) {
    const sig = f => `${f.status}|${f.added ?? ''}|${f.removed ?? ''}`;
    const was = new Map((before || []).map(f => [keyOf(f.path), sig(f)]));
    const now = new Set((after || []).map(f => keyOf(f.path)));
    const out = [];
    for (const f of after || []) if (was.get(keyOf(f.path)) !== sig(f)) out.push(f.path);
    for (const f of before || []) if (!now.has(keyOf(f.path))) out.push(f.path);
    return out.map(p => p.replace(/\/$/, '')).slice(0, MAX_FLASH);
  }

  /** The lit rows above the view (first: the first row in view), newest last, at most `fit`. */
  function pins(litIdx, first, fit) {
    if (fit <= 0) return [];
    return litIdx.filter(i => i < first).slice(-fit);
  }

  /**
   * The whole @path the caret is in or just after (fileindex.js's mention form: @a/b.js or @"a b/c.js"),
   * even when the caret sits mid-token. An unclosed quote runs to the end of the text.
   */
  function mentionAt(text, caret) {
    const s = String(text || '');
    const re = /(?:^|\s)@(?:"([^"]*)"?|(\S*))/g;
    for (let m; (m = re.exec(s));) {
      const at = m.index + m[0].indexOf('@');
      const end = m.index + m[0].length;
      if (caret > at && caret <= end + (s[end] === ' ' ? 1 : 0)) return (m[1] ?? m[2]).replace(/\\/g, '/') || null;
    }
    return null;
  }

  const api = {
    create, take, light, expire, reveal, touch, totals, totalsText, markOf, changedBetween, pins, mentionAt, relOf, keyOf, ancestors,
    AFTERGLOW_MS, MAX_REVEAL, MAX_FLASH, ROW_CAP, TONES,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyFiles = api;
})(typeof window !== 'undefined' ? window : globalThis);
