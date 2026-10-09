// Notes (notes.js, wiring/notes.js): add, edit, tick off, pin, move and delete
// (and undo a delete), and hand one to Claude as Plan, Build or Ask.
// Kept out of main.js, which only wires it up.
const fs = require('fs');
const path = require('path');
const notes = require('../notes');

const NOTE_MODE = { plan: 'plan', build: null, ask: 'ask' }; // build: whatever mode you're in

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 */
function registerNotesIpc(ipcMain, d) {
  // A payload that should be an object: null or a string from the panel reads as {} rather than throwing.
  const obj = v => (v && typeof v === 'object' ? v : {});
  const noteScope = async scope => {
    if (scope === notes.GENERAL) return { ok: true };
    const project = d.isStr(scope) ? await d.knownNoteProject(scope) : null;
    return project ? { ok: true, project } : { ok: false };
  };

  ipcMain.handle('notes:list', () => d.notesView());
  ipcMain.handle('notes:add', async (_e, req) => {
    const { scope, text } = obj(req);
    const where = await noteScope(scope);
    if (!where.ok) return { ok: false, error: "Shellby doesn't know that project." };
    const r = notes.add(d.config.get('notes'), scope, text, { id: d.randomUUID(), now: Date.now(), project: where.project });
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, note: r.note, view: await d.saveNotes(r.state) };
  });
  ipcMain.handle('notes:update', (_e, req) => {
    const { scope, id, text, done, pinned } = obj(req);
    const patch = {};
    if (typeof text === 'string') patch.text = text;
    if (typeof done === 'boolean') patch.done = done;
    if (typeof pinned === 'boolean') patch.pinned = pinned;
    return d.saveNotes(notes.update(d.config.get('notes'), scope, id, patch));
  });
  // Delete and Clear done hand back what they took, for the toast's Undo (notes:restore).
  // Taking a project's last note takes the project out of the store, and it may
  // not be one the page offers any more, so main keeps its name and folder for
  // the Undo: the panel only ever names the list.
  const emptied = new Map(); // project key -> { name, root }, while an Undo may come
  const took = async (scope, r) => {
    const before = notes.normalize(d.config.get('notes')).projects[scope];
    if (before) emptied.set(scope, { name: before.name, root: before.root });
    return { ok: true, removed: r.removed, view: await d.saveNotes(r.state) };
  };
  ipcMain.handle('notes:delete', (_e, req) => {
    const { scope, id } = obj(req);
    return took(scope, notes.remove(d.config.get('notes'), scope, id));
  });
  ipcMain.handle('notes:clear-done', (_e, req) => {
    const { scope } = obj(req);
    return took(scope, notes.clearDone(d.config.get('notes'), scope));
  });
  ipcMain.handle('notes:restore', async (_e, req) => {
    const { scope, removed } = obj(req);
    const where = await noteScope(scope);
    const project = where.project || (d.isStr(scope) ? emptied.get(scope) : null);
    if (!where.ok && !project) return { ok: false, error: "Shellby doesn't know that project." };
    const r = notes.restore(d.config.get('notes'), scope, removed, { project });
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, view: await d.saveNotes(r.state) };
  });
  ipcMain.handle('notes:move', async (_e, req) => {
    const { from, id, to } = obj(req);
    const where = await noteScope(to);
    if (!where.ok) return { ok: false, error: "Shellby doesn't know that project." };
    const r = notes.move(d.config.get('notes'), from, id, to, { project: where.project });
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, view: await d.saveNotes(r.state) };
  });
  // Plan and Build send the note exactly as written, in a copy of the project on
  // a branch of its own (as Next up's Do this does), so nothing lands in your
  // checkout until you bring it home; a folder that isn't a git repository has
  // no copy, so it runs there. A copy that fails for any other reason says so
  // rather than quietly working in your checkout. Ask wraps it in a read-only
  // "should I do this?" (notes.js) and runs in place. A project's note runs in
  // that project's folder; a General one where you pick (where: a project key,
  // or 'here' for the folder you're working in).
  // A note Claude put there (the `note` tool) could carry words from anything
  // Claude read, so it opens as a draft: the prompt waits in the box until you send it.
  ipcMain.handle('notes:run', async (_e, req) => {
    const { scope, id, kind, where } = obj(req);
    const note = notes.find(d.config.get('notes'), scope, id);
    if (!note || !notes.KINDS.includes(kind)) return { ok: false, error: "Shellby can't find that note any more." };
    const dir = await runDir(scope, where);
    if (!dir.ok) return dir;
    const short = note.text.split('\n')[0].slice(0, 50);
    const title = kind === 'plan' ? `Plan: ${short}` : kind === 'ask' ? `Ask: ${short}` : short;
    const prompt = kind === 'ask' ? notes.askPrompt(note.text, dir.name) : note.text;
    const draft = note.from === 'claude';
    const mode = NOTE_MODE[kind];
    let r = kind === 'ask' ? null : await d.startTaskInCopy(dir.cwd, title, () => prompt, { mode, draft });
    if (!r || (!r.ok && r.notRepo)) r = draft ? d.startDraft(dir.cwd, title, prompt, { mode }) : d.startTask(prompt, title, { mode, cwd: dir.cwd });
    if (!r.ok) return r;
    const view = await d.saveNotes(notes.markRun(d.config.get('notes'), scope, id, { kind, tabId: r.tabId, at: Date.now() }));
    d.showPanel({ focusInput: false, tabId: r.tabId });
    return { ...r, view, copy: !!r.worktree, draft };
  });

  /** The folder a note runs in. -> { ok, cwd, name } | { ok: false, error } */
  async function runDir(scope, where) {
    if (scope === notes.GENERAL && (!where || where === 'here')) {
      const cwd = d.currentCwd();
      return { ok: true, cwd, name: path.basename(cwd) };
    }
    // A General note's project must be one the page offered, never a path the panel made up.
    const p = scope === notes.GENERAL
      ? (d.isStr(where) ? await d.knownNoteProject(where) : null)
      : notes.normalize(d.config.get('notes')).projects[scope];
    if (!p || !fs.existsSync(p.root)) return { ok: false, error: "Shellby can't find that folder any more." };
    return { ok: true, cwd: p.root, name: p.name };
  }
}

module.exports = { registerNotesIpc };
