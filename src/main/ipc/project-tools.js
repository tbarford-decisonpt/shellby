// The project page's helpers (projects/tools.js): When did this break?, Check
// the docs (now, or as a weekly routine you save yourself) and Show me around.
//
// Each one opens a conversation with its prompt waiting in the box: nothing
// goes to Claude, and none of your usage is spent, until you press Send. The
// routine is only a draft for the routine editor; it runs on its own only once
// you've saved it there, through routines:save and its confirmation.
//
// The panel names a project by a root the Projects page listed (knowsRoot),
// never a folder of its own.
const tools = require('../projects/tools');
const worktrees = require('../worktrees');
const local = require('../projects/local');

const isRoot = r => typeof r === 'string' && r.length > 0 && r.length < 1000;
const text = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');

/**
 * @param {Pick<import('electron').IpcMain, 'handle' | 'on'>} ipcMain  main's, behind ipc-guard.js
 * @param d  what main shares with its IPC (main.js ipcDeps)
 * @param [opts]  git: worktrees.git, or a test's; readRepo(dir) and pickFolder() likewise
 */
function registerProjectToolsIpc(ipcMain, d, {
  git = worktrees.git,
  readRepo = dir => local.readRepo(dir),
  pickFolder = async () => {
    const { dialog } = require('electron');
    const r = await dialog.showOpenDialog(d.panel, { title: 'Which project should Shellby show you around?', defaultPath: d.currentCwd(), properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0] || null;
  },
} = {}) {
  const unknown = { ok: false, error: "That folder isn't on the Projects page." };
  /** -> { root, name } | null */
  const known = raw => {
    const root = isRoot(raw) ? d.projects?.knowsRoot(raw) : null;
    return root ? { root, name: d.projects.nameFor(root) } : null;
  };

  // The tags "the last version that worked" can be picked from, newest first.
  ipcMain.handle('tools:bisect-refs', async (_e, root) => {
    const p = known(root);
    if (!p) return unknown;
    const r = await git(p.root, ['tag', '--sort=-creatordate', '--format=%(refname:short)%1f%(creatordate:iso-strict)', '--merged', 'HEAD'], { timeout: 10000 });
    return { ok: true, tags: r.ok ? tools.parseTags(r.out) : [] };
  });

  // "When did this break?": a copy at your HEAD, git bisect in it.
  ipcMain.handle('tools:bisect', async (_e, raw = {}) => {
    const p = known(raw.root);
    if (!p) return unknown;
    const what = text(raw.what, tools.MAX_WHAT).trim();
    if (!what) return { ok: false, error: 'Say what broke first.' };
    const test = text(raw.test, tools.MAX_TEST).trim();
    let good = null;
    if (raw.good) {
      if (!tools.isRef(raw.good)) return { ok: false, error: "That isn't a tag, branch or commit Shellby can read." };
      const ok = await git(p.root, ['rev-parse', '--verify', '--quiet', `${raw.good}^{commit}`], { timeout: 10000 });
      if (!ok.ok) return { ok: false, error: `There's no ${raw.good} in this repository.` };
      const behind = await git(p.root, ['merge-base', '--is-ancestor', ok.out.trim(), 'HEAD'], { timeout: 10000 });
      if (!behind.ok) return { ok: false, error: `${raw.good} isn't behind where you are now, so it can't be the last version that worked.` };
      good = raw.good;
    }
    const res = await d.startTaskInCopy(p.root, 'When did this break?',
      w => tools.bisectPrompt({ what, test, good, project: p.name }, { branch: w.branch, base: w.base }), { draft: true });
    return res.ok ? { ok: true, tabId: res.tabId } : res;
  });

  // "Check the docs": fixes in a copy on its own branch, for you to look over.
  ipcMain.handle('tools:docs', async (_e, root) => {
    const p = known(root);
    if (!p) return unknown;
    const res = await d.startTaskInCopy(p.root, `Docs check: ${p.name}`.slice(0, 80),
      w => tools.docsPrompt({ project: p.name }, { branch: w.branch, base: w.base }), { draft: true });
    return res.ok ? { ok: true, tabId: res.tabId } : res;
  });

  // "Make it automatic…": a weekly report for the routine editor to fill in. Never saved here.
  ipcMain.handle('tools:docs-routine', (_e, root) => {
    const p = known(root);
    return p ? { ok: true, routine: tools.docsRoutine({ project: p.name, cwd: p.root }) } : unknown;
  });

  // "Show me around": Ask first, whatever mode you're in, in the folder as it is.
  ipcMain.handle('tools:tour', (_e, root) => {
    const p = known(root);
    if (!p) return unknown;
    return d.startDraft(p.root, `Tour of ${p.name}`.slice(0, 80), tools.tourPrompt({ project: p.name }), { mode: 'ask' });
  });

  // The same tour, offered once on a new install's first New task. The project
  // is the folder Shellby works in when that's a repository, or one you pick
  // here: the panel names no folder.
  ipcMain.handle('tools:first-tour', async () => {
    let repo = await readRepo(d.currentCwd());
    if (!repo) {
      const dir = await pickFolder();
      if (!dir) return { ok: false, cancelled: true };
      repo = await readRepo(dir);
      if (!repo) return { ok: false, error: "That folder isn't in a git repository. Pick a project's folder." };
    }
    return d.startDraft(repo.root, `Tour of ${repo.name}`.slice(0, 80), tools.tourPrompt({ project: repo.name }), { mode: 'ask' });
  });
}

module.exports = { registerProjectToolsIpc };
