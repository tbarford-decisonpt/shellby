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

  return { knownNoteProject, notesView, saveNotes };
}

module.exports = { wireNotes };
