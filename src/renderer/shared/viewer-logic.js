/* The file viewer's pure parts (panel/viewer.js): a flat file list as a tree,
   a unified diff with both sides' line numbers, and a conversation's state in
   a word. No DOM, so node:test runs it. */
(function (root) {
  'use strict';

  const STATUS_WORDS = { A: 'Added', M: 'Modified', D: 'Deleted', T: 'Type changed', '?': 'New, not tracked yet' };
  const statusWord = s => STATUS_WORDS[s] || String(s || '');
  const statusClass = s => (s === '?' ? 'u' : String(s || 'm').toLowerCase());

  /** fileindex's list ('src/', 'src/a.js', …) and the changes -> a tree of { name, path, dir, status, children }. */
  function buildTree(entries, files = []) {
    const changed = new Map((files || []).map(f => [f.path, f.status]));
    const top = { name: '', path: '', dir: true, status: null, children: [] };
    const dirs = new Map([['', top]]);
    const seen = new Set();
    const parentOf = p => { const cut = p.lastIndexOf('/'); return cut < 0 ? '' : p.slice(0, cut); };
    const dirOf = p => {
      if (dirs.has(p)) return dirs.get(p);
      const node = { name: p.slice(p.lastIndexOf('/') + 1), path: p, dir: true, status: null, children: [] };
      dirOf(parentOf(p)).children.push(node);
      dirs.set(p, node);
      return node;
    };
    const addFile = p => {
      if (seen.has(p)) return;
      seen.add(p);
      dirOf(parentOf(p)).children.push({ name: p.slice(p.lastIndexOf('/') + 1), path: p, dir: false, status: changed.get(p) || null });
    };
    for (const e of entries || []) {
      if (typeof e !== 'string' || !e) continue;
      if (e.endsWith('/')) dirOf(e.slice(0, -1));
      else addFile(e);
    }
    // The index can be up to 20 s old, so a file the changes list knows (deleted, or made since) may be
    // missing from it: every changed file belongs in the tree.
    for (const f of files || []) addFile(f.path);
    const settle = node => {
      node.children.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })));
      for (const c of node.children) if (c.dir) { settle(c); if (c.children.some(k => k.status)) c.status = 'M'; }
    };
    settle(top);
    return top;
  }

  /** The rows to draw: [{ node, depth }]. Folders open when `open` has them; a filter shows every match and its folders. */
  function visibleRows(tree, open, filter = '') {
    const q = String(filter || '').trim().toLowerCase();
    const rows = [];
    const walk = (node, depth) => {
      for (const c of node.children) {
        if (q) {
          if (!c.dir) { if (c.path.toLowerCase().includes(q)) rows.push({ node: c, depth }); continue; }
          const at = rows.length;
          rows.push({ node: c, depth });
          walk(c, depth + 1);
          if (rows.length === at + 1) rows.pop(); // a folder with nothing in it that matches
          continue;
        }
        rows.push({ node: c, depth });
        if (c.dir && open && open.has(c.path)) walk(c, depth + 1);
      }
    };
    walk(tree, 0);
    return rows;
  }

  const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

  /** A unified diff -> [{ cls, text, oldNo, newNo }], each side numbered from its hunk header. */
  function numberDiff(patch) {
    const rows = [];
    // Everything before a file's first @@ is its header (diff --git, index, ---, +++, modes);
    // after it, a removed "-- note" is "--- note", and that's code.
    let a = 0, b = 0, inHeader = true;
    for (const raw of String(patch || '').replace(/\n$/, '').split('\n')) {
      const line = raw.replace(/\r$/, ''); // a CRLF file's lines end in \r in its patch
      if (line.startsWith('diff --git')) inHeader = true;
      const m = HUNK.exec(line);
      if (m) { inHeader = false; a = Number(m[1]); b = Number(m[2]); rows.push({ cls: 'hunk', text: line, oldNo: null, newNo: null }); continue; }
      if (inHeader) continue;
      if (line.startsWith('\\')) rows.push({ cls: 'meta', text: line, oldNo: null, newNo: null });
      else if (line.startsWith('+')) rows.push({ cls: 'add', text: line.slice(1), oldNo: null, newNo: b++ });
      else if (line.startsWith('-')) rows.push({ cls: 'del', text: line.slice(1), oldNo: a++, newNo: null });
      else rows.push({ cls: 'ctx', text: line.slice(1), oldNo: a++, newNo: b++ });
    }
    return rows;
  }

  /** A file's text as lines: CRLF or LF, and no empty line after a final newline. */
  function splitLines(text) {
    const lines = String(text ?? '').split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  }

  /**
   * The header's "where": name · branch (from base). The list is relative to HEAD instead when
   * git found no merge-base with the base, and then it says so rather than claim "(from main)".
   * against: from the last changes answer, null before the first; only: Just uncommitted is on
   * (relative to HEAD by choice, so the branch is still from its base).
   */
  function whereText({ name, branch, base, against, only } = {}) {
    const from = !branch || !base ? '' : against === 'HEAD' && !only ? ' (since the last commit)' : ` (from ${base})`;
    return [name, branch && branch + from].filter(Boolean).join(' · ');
  }

  // A folder the Files button would open that's the home folder or a whole drive. Main refuses
  // those (and any folder above home, or a dotfiles repo at ~), so the button hides for them.
  function tooWide(dir, home) {
    const norm = p => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
    const d = norm(dir);
    return !d || /^[a-z]:$/.test(d) || (!!home && d === norm(home));
  }

  /** The conversation's state for the viewer's header, from the panel's tab. */
  function liveState(tab) {
    if (!tab) return null;
    if (tab.pending > 0) return { word: 'Needs you', cls: 'needs' };
    if (tab.busy) return { word: 'Working', cls: 'busy' };
    return { word: 'Done', cls: 'done' };
  }

  const api = { buildTree, visibleRows, numberDiff, splitLines, whereText, tooWide, liveState, statusWord, statusClass, STATUS_WORDS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ShellbyViewer = api;
})(typeof window !== 'undefined' ? window : globalThis);
