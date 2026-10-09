// Notes (notes.js): ideas per project, plus one General list, each handed to
// Claude as Plan, Build or Ask. The Notes page; its IPC is ipc/notes.js.
// Kept out of main.js, which only wires it up.
const os = require('os');
const path = require('path');
const gitinfo = require('../gitinfo');
const notes = require('../notes');
const streaks = require('../streaks');

const foldPath = p => (process.platform === 'win32' ? p.toLowerCase() : p);

/** d: what main shares (main.js `shared`). */
function wireNotes(d) {
  // The project a folder belongs to: its git repo (a tab's own copy counts as
  // the repo it was made from), or else the folder itself. Your home folder
  // (where Shellby starts out) isn't a project, so notes go to General.
  async function noteProjectOf(dir) {
    const repo = await gitinfo.projectOf(dir);
    if (repo) return { root: repo.root, key: foldPath(repo.root), name: path.basename(repo.root) };
    if (typeof dir !== 'string' || !dir || !path.isAbsolute(dir)) return null;
    const root = path.resolve(dir);
    if (foldPath(root) === foldPath(os.homedir())) return null;
    return { root, key: foldPath(root), name: path.basename(root) || root };
  }

  // Every list you can pick: the project you're working in first, then the ones
  // with notes, then the projects streaks knows you've worked in recently.
  async function notesView() {
    const s = notes.normalize(d.config.get('notes'));
    const here = await noteProjectOf(d.currentCwd());
    const projects = new Map();
    if (here) projects.set(here.key, { key: here.key, name: here.name, root: here.root, notes: [] });
    for (const [key, p] of Object.entries(s.projects)) projects.set(key, { key, name: p.name, root: p.root, notes: p.notes });
    const recent = Object.entries(streaks.normalize(d.config.get('streaks')).projects).sort((a, b) => b[1].lastSeen - a[1].lastSeen);
    for (const [key, p] of recent) {
      if (projects.size >= 20) break;
      if (!projects.has(key)) projects.set(key, { key, name: p.name, root: key, notes: [] });
    }
    return { general: s.general, projects: [...projects.values()], current: here?.key || null, cwd: d.currentCwd() };
  }

  async function saveNotes(next) {
    d.config.set({ notes: next });
    const view = await notesView();
    d.send(d.panel, 'notes', view);
    return view;
  }

  // A project a note may be filed under: only ones the view offers, never a path
  // the renderer made up.
  async function knownNoteProject(key) {
    const p = (await notesView()).projects.find(x => x.key === key);
    return p ? { name: p.name, root: p.root } : null;
  }

  /** A project's open notes, for its Next up list (wiring/backlog.js): [{ id, text, scope, from }]. */
  function openNotesFor(root) {
    if (typeof root !== 'string' || !root) return [];
    const want = foldPath(path.resolve(root));
    const s = notes.normalize(d.config.get('notes'));
    const hit = Object.entries(s.projects).find(([key, p]) => key === want || foldPath(path.resolve(p.root)) === want);
    return hit ? hit[1].notes.filter(n => !n.done).map(n => ({ id: n.id, text: n.text, scope: hit[0], from: n.from })) : [];
  }

  /** A turn ended: if it was a note's Ask, its verdict goes on the note (timetrack.js onResult). */
  async function notesTurnEnded(tabId, reply) {
    const before = notes.normalize(d.config.get('notes'));
    const next = notes.markVerdict(before, tabId, reply);
    if (JSON.stringify(next) !== JSON.stringify(before)) await saveNotes(next);
  }

  /**
   * A note from a conversation (the crab's `note` tool, crab-api.js): onto the
   * list for the project that conversation is in, else General.
   * -> { ok, list } | { ok: false, error }
   */
  async function addNoteFrom(cwd, text) {
    const here = await noteProjectOf(cwd);
    const scope = here ? here.key : notes.GENERAL;
    const r = notes.add(d.config.get('notes'), scope, text, { id: d.randomUUID(), now: Date.now(), project: here || undefined, from: 'claude' });
    if (r.error) return { ok: false, error: r.error };
    await saveNotes(r.state);
    return { ok: true, list: here ? here.name : 'General' };
  }

  return { knownNoteProject, notesView, saveNotes, openNotesFor, notesTurnEnded, addNoteFrom };
}

module.exports = { wireNotes };
