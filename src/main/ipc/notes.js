// Notes (notes.js, wiring/notes.js): add, edit, tick off, move and delete, and
// hand one to Claude as Plan, Build or Ask.
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
    const { scope, id, text, done } = obj(req);
    const patch = {};
    if (typeof text === 'string') patch.text = text;
    if (typeof done === 'boolean') patch.done = done;
    return d.saveNotes(notes.update(d.config.get('notes'), scope, id, patch));
  });
  ipcMain.handle('notes:delete', (_e, req) => {
    const { scope, id } = obj(req);
    return d.saveNotes(notes.remove(d.config.get('notes'), scope, id));
  });
  ipcMain.handle('notes:move', async (_e, req) => {
    const { from, id, to } = obj(req);
    const where = await noteScope(to);
    if (!where.ok) return { ok: false, error: "Shellby doesn't know that project." };
    const r = notes.move(d.config.get('notes'), from, id, to, { project: where.project });
    if (r.error) return { ok: false, error: r.error };
    return { ok: true, view: await d.saveNotes(r.state) };
  });
  // Plan and Build send the note exactly as written; Ask wraps it in a read-only
  // "should I do this?" (notes.js). A project's note runs in that project's
  // folder; a General one runs wherever you're working now.
  ipcMain.handle('notes:run', async (_e, req) => {
    const { scope, id, kind } = obj(req);
    const note = notes.find(d.config.get('notes'), scope, id);
    if (!note || !notes.KINDS.includes(kind)) return { ok: false, error: "Shellby can't find that note any more." };
    let cwd = d.currentCwd(), name = path.basename(cwd);
    if (scope !== notes.GENERAL) {
      const p = notes.normalize(d.config.get('notes')).projects[scope];
      if (!p || !fs.existsSync(p.root)) return { ok: false, error: "Shellby can't find that folder any more." };
      cwd = p.root; name = p.name;
    }
    const short = note.text.split('\n')[0].slice(0, 50);
    const title = kind === 'plan' ? `Plan: ${short}` : kind === 'ask' ? `Ask: ${short}` : short;
    const r = d.startTask(kind === 'ask' ? notes.askPrompt(note.text, name) : note.text, title, { mode: NOTE_MODE[kind], cwd });
    if (!r.ok) return r;
    const view = await d.saveNotes(notes.markRun(d.config.get('notes'), scope, id, { kind, tabId: r.tabId, at: Date.now() }));
    d.showPanel({ focusInput: false, tabId: r.tabId });
    return { ...r, view };
  });
}

module.exports = { registerNotesIpc };
