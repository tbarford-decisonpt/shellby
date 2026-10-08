// Output styles: how Claude talks while it works (what /output-style picks in
// the terminal). Claude Code's own three, plus any you or the project wrote as
// markdown files in an output-styles folder. Shellby passes the chosen one as a
// flag setting when a conversation starts (session.js), so your own settings
// files are never edited for it.
const fs = require('fs');
const path = require('path');

const BUILT_IN = [
  { name: '', title: 'Default', description: 'Claude Code as it comes: gets the work done and keeps it brief.', source: 'built-in' },
  { name: 'Explanatory', title: 'Explanatory', description: 'Explains its choices and the codebase as it goes, with short "Insight" notes.', source: 'built-in' },
  { name: 'Learning', title: 'Learning', description: 'Works with you: leaves small pieces for you to write, marked TODO(human).', source: 'built-in' },
];
const MAX_STYLES = 50;

// name: and description: from a style file's frontmatter, if it has them.
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

function fromDir(dir, source) {
  let names;
  try { names = fs.readdirSync(dir).filter(n => /\.md$/i.test(n)); } catch { return []; }
  return names.slice(0, MAX_STYLES).map(n => {
    let fm = {};
    try { fm = frontmatter(fs.readFileSync(path.join(dir, n), 'utf8').slice(0, 4000)); } catch { /* unreadable: name from the file */ }
    const name = (fm.name || n.replace(/\.md$/i, '')).slice(0, 60);
    return { name, title: name, description: (fm.description || '').slice(0, 200), source };
  });
}

/** Every style a conversation in `cwd` could use; the first with a name wins. */
function list({ home, cwd } = {}) {
  const all = [
    ...BUILT_IN,
    ...(cwd ? fromDir(path.join(cwd, '.claude', 'output-styles'), 'project') : []),
    ...(home ? fromDir(path.join(home, '.claude', 'output-styles'), 'user') : []),
  ];
  const seen = new Set();
  return all.filter(s => { const k = s.name.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** A saved choice is kept if it's a plain, short name; '' means Default. */
function clean(name) {
  const n = typeof name === 'string' ? name.trim() : '';
  return /^[\w .()-]{1,60}$/.test(n) && n.toLowerCase() !== 'default' ? n : '';
}

module.exports = { list, clean, frontmatter, BUILT_IN };
