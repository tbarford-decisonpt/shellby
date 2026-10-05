// Prompt snippets (snippets.js): /name in the box, and Toolbox → Snippets.
// Kept out of main.js, which only wires it up.
const { app, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const snippets = require('../snippets');

/** d: what main shares (main.js `shared`). */
function wireSnippets(d) {
  // ---- prompt snippets

  const PANEL_MAX_TEXT = 50000; // the longest message the box sends (task:send)

  function snippetList() {
    // Once: a list saved before $1 to $9 were blanks keeps sending what it did.
    if (d.config.get('snippetFormat') !== snippets.FORMAT) {
      d.config.set({ snippets: snippets.migrate(d.config.get('snippets')), snippetFormat: snippets.FORMAT });
    }
    return snippets.normalize(d.config.get('snippets'));
  }
  /** Yours, then the team pack's for that folder (if you've turned them on there; yours win a name). */
  function allSnippets(cwd = d.currentCwd()) {
    const own = snippetList();
    return [...own, ...(d.teamIpc?.snippetsFor(cwd, own) || [])];
  }
  const snippetsView = () => ({ snippets: snippets.view(allSnippets(), d.config.get('snippetUse')), pinned: d.pinnedTools() });

  /** Save the list and tell the panel. A rename or delete carries its pin and its use count along. */
  function setSnippets(list, renamed = null) {
    const pins = (d.config.get('pinnedTools') || []).flatMap(p => {
      if (p?.kind !== 'snippet') return [p];
      const name = renamed && p.name === renamed.from ? renamed.to : p.name;
      return list.some(s => s.name === name) ? [{ kind: 'snippet', name }] : [];
    });
    d.config.set({ snippets: list, pinnedTools: pins, snippetUse: snippets.keepUse(d.config.get('snippetUse'), list, renamed) });
    const view = snippetsView();
    d.send(d.panel, 'snippets', view);
    return view;
  }

  /**
   * A snippet, filled in and ready to send: /review from the panel, @review from a
   * terminal. null when there's no snippet by that name. `cwd` is where it'll
   * run, for that repo's team snippets.
   */
  function expandSnippet(name, args, { sigil = '/', max, cwd } = {}) {
    const s = snippets.find(allSnippets(cwd), name);
    if (!s) return null;
    const r = snippets.expand(s, args, { sigil, max });
    return r.ok ? { ...r, name: s.name, newTab: !!s.newTab } : r;
  }

  /** Counted once it has gone (or is queued to go), not when it's filled in. */
  function noteSnippetUse(name) {
    if (!snippets.find(snippetList(), name)) return;
    d.config.set({ snippetUse: snippets.noteUse(d.config.get('snippetUse'), name) });
    d.send(d.panel, 'snippets', snippetsView());
  }

  /** Toolbox > Snippets > Export: the whole list, as a file to keep or share. */
  async function exportSnippets() {
    const list = snippetList();
    if (!list.length) return { ok: false, error: 'There are no snippets to export.' };
    const r = await dialog.showSaveDialog(d.panel, {
      title: 'Export your snippets',
      defaultPath: path.join(app.getPath('documents'), 'shellby-snippets.json'),
      filters: [{ name: 'Shellby snippets', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, cancelled: true };
    try { fs.writeFileSync(r.filePath, snippets.exportJson(list)); } catch (e) { return { ok: false, error: `Couldn't write it: ${e.code || e.message}` }; }
    return { ok: true, path: r.filePath, count: list.length };
  }

  /** Toolbox > Snippets > Import: someone's export, or your own from another PC. */
  async function importSnippets() {
    const r = await dialog.showOpenDialog(d.panel, {
      title: 'Import snippets', properties: ['openFile'],
      filters: [{ name: 'Shellby snippets', extensions: ['json'] }, { name: 'All files', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths?.[0]) return { ok: false, cancelled: true };
    let raw;
    try {
      if (fs.statSync(r.filePaths[0]).size > 1024 * 1024) return { ok: false, error: "That file is too big to be snippets (over 1 MB)." };
      raw = fs.readFileSync(r.filePaths[0], 'utf8');
    } catch (e) { return { ok: false, error: `Couldn't read it: ${e.code || e.message}` }; }
    const parsed = snippets.parseImport(raw);
    if (!parsed.ok) return parsed;
    return mergeSnippets(parsed.snippets);
  }

  function mergeSnippets(incoming) {
    const m = snippets.merge(snippetList(), incoming);
    return { ok: true, added: m.added, renamed: m.renamed, skipped: m.skipped, ...(m.added.length ? setSnippets(m.list) : snippetsView()) };
  }

  return {
    PANEL_MAX_TEXT, allSnippets, expandSnippet, exportSnippets, importSnippets, mergeSnippets,
    noteSnippetUse, setSnippets, snippetList, snippetsView,
  };
}

module.exports = { wireSnippets };
