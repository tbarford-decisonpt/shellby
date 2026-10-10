// A conversation's outline (Ctrl+Shift+O): every message you sent, oldest
// first, with the files that turn touched. The files come from the turn's
// diff where there is one (changes.js), and from Claude's edits where there
// isn't (a folder that isn't a git repo). Pure: a transcript in, a list out.

const MAX_TEXT = 200;
const MAX_FILES = 40;
const MAX_POINTS = 500;

/**
 * -> [{ turnId, text, at, files: [{ path, status?, added?, removed? }], added, removed, tools }]
 * Only since the last /clear, as Rewind does: what came before is off screen.
 */
function outline(items) {
  const list = Array.isArray(items) ? items : [];
  const cleared = list.findLastIndex(i => i?.kind === 'cleared');
  const out = [];
  const byTurn = new Map();
  let current = null;
  for (const i of list.slice(cleared + 1)) {
    if (!i || typeof i !== 'object') continue;
    if (i.kind === 'user' && typeof i.turnId === 'string') {
      const text = String(i.text || (i.attachments?.length ? `${i.attachments.length} attached file${i.attachments.length === 1 ? '' : 's'}` : '')).replace(/\s+/g, ' ').trim();
      current = { turnId: i.turnId, text: text.slice(0, MAX_TEXT), at: i.t || null, files: [], added: 0, removed: 0, tools: 0, edits: new Map(), diffed: false };
      out.push(current);
      byTurn.set(i.turnId, current);
      continue;
    }
    // A diff says what the turn really changed, whatever ran.
    if (i.kind === 'changes') {
      const t = (i.turnId && byTurn.get(i.turnId)) || current;
      if (!t) continue;
      t.diffed = true;
      for (const f of Array.isArray(i.files) ? i.files : []) {
        if (typeof f?.path !== 'string' || t.files.some(x => x.path === f.path)) continue;
        t.files.push({ path: f.path, status: f.status || 'M', added: Number(f.added) || 0, removed: Number(f.removed) || 0 });
      }
      t.added += Number(i.added) || 0;
      t.removed += Number(i.removed) || 0;
      continue;
    }
    if (i.kind === 'tool' && current && !i.sub) {
      current.tools++;
      if (typeof i.filePath === 'string' && i.filePath) current.edits.set(i.filePath, true);
    }
  }
  return out.slice(-MAX_POINTS).map(({ edits, diffed, ...t }) => ({
    ...t,
    files: (diffed ? t.files : [...edits.keys()].map(p => ({ path: p }))).slice(0, MAX_FILES),
  }));
}

module.exports = { outline, MAX_TEXT, MAX_FILES };
