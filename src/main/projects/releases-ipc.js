// The Releases card on a project's page (release-git.js): what's unreleased,
// the draft, "Cut release", "Push" and "Write it with Claude". Kept out of
// main.js, which only wires it up.
//
// The panel names a clone only by a root the Projects page listed (knowsRoot),
// and a release only by the commit it read: a clone that has moved since isn't
// released. Nothing is pushed unless the push box was ticked or Push pressed.
const { caseKey } = require('./merge');
const rg = require('./release-git');
const R = require('./releases');
const { secretGate } = require('../secret-gate');
const worktrees = require('../worktrees');

const CI_TTL_MS = 60 * 1000;
const isRoot = r => typeof r === 'string' && r.length > 0 && r.length < 1000;
const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const no = { ok: false, error: 'That folder isn\'t on the Projects page.' };

/**
 * d: what main shares (main.js `shared`): projects, github, shipped(root, kind, meta), githubEndpoints()
 * git: the runner (tests pass a fake)
 */
function registerReleasesIpc(ipcMain, d, { git = worktrees.git } = {}) {
  const busy = new Set();     // roots with a cut or push under way
  const ci = new Map();       // `${repo}@${sha}` -> { at, value }

  const known = root => (isRoot(root) ? d.projects?.knowsRoot(root) || null : null);
  const signedIn = () => !!d.github?.signedIn;
  // Your GitHub sign-in helps a push only to GitHub; any other remote never sees the token.
  const envFor = repo => () => (repo && signedIn() ? d.github.claudeEnv() : {});
  // Every commit the push would send is looked over for secrets first, as every push is (secret-gate.js).
  const gate = (root, o) => secretGate(d, root, o);

  // The clone's GitHub repository, from what the Projects page read.
  async function repoOf(root) {
    const repos = await d.projects.localRepos().catch(() => []);
    return repos.find(r => caseKey(r.root) === caseKey(root))?.remote || null;
  }

  // CI on the commit to be released, when GitHub has it (this clone is pushed). Kept a minute.
  async function ciFor(repo, state) {
    if (!repo || !signedIn() || !state.upstream || state.upstream.ahead) return null;
    const id = `${repo}@${state.head}`;
    const hit = ci.get(id);
    if (hit && Date.now() - hit.at < CI_TTL_MS) return hit.value;
    const value = await rg.ciOf(d.github.gh(), repo, state.head).catch(() => null);
    ci.set(id, { at: Date.now(), value });
    return value;
  }

  async function view(root) {
    const state = await rg.readRelease(root, { git });
    if (!state.ok) return state;
    const repo = await repoOf(root);
    const web = d.githubEndpoints?.().web || 'https://github.com';
    return {
      ...state,
      blocker: rg.blocker(state),
      ci: await ciFor(repo, state),
      repo,
      releasesUrl: repo ? `${web}/${repo}/releases` : null,
      busy: busy.has(caseKey(root)),
    };
  }

  // Shipped: his sticker for the project learns of the release (stickers.js).
  const released = (root, version) => { try { d.shipped?.(root, 'release', { version }); } catch { /* a sticker that can't be saved mustn't undo a release */ } };

  async function once(root, fn) {
    const k = caseKey(root);
    if (busy.has(k)) return { ok: false, error: 'A release is already under way here.' };
    busy.add(k);
    try { return await fn(); } finally { busy.delete(k); }
  }

  ipcMain.handle('releases:get', (_e, { root } = {}) => {
    const r = known(root);
    return r ? view(r) : no;
  });

  ipcMain.handle('releases:cut', (_e, o = {}) => {
    const root = known(o.root);
    if (!root) return no;
    if (!/^[0-9a-f]{40}$/.test(String(o.head))) return { ok: false, error: 'Look again: the draft is missing what it was read from.' };
    return once(root, async () => {
      const repo = await repoOf(root);
      // Over red or unfinished CI only with the card's "Release it anyway" ticked.
      const now = await rg.readRelease(root, { git });
      const checks = now.ok ? await ciFor(repo, now) : null;
      if ((checks?.state === 'failing' || checks?.state === 'pending') && o.ack !== true) {
        return { ok: false, error: checks.state === 'failing' ? 'CI failed on this commit. Tick "Release it anyway" to go ahead.' : 'CI hasn\'t finished on this commit. Tick "Release it anyway" to go ahead.' };
      }
      const r = await rg.cutRelease(root, {
        version: str(o.version, 60), title: str(o.title, 300), notes: str(o.notes, R.NOTES_MAX + 1000),
        head: o.head, push: o.push === true,
      }, { git, env: envFor(repo), gate });
      if (r.ok && r.pushed) released(root, r.version);
      d.projects.emit?.('change');
      return r;
    });
  });

  ipcMain.handle('releases:push', (_e, { root: given, tag } = {}) => {
    const root = known(given);
    if (!root) return no;
    const t = R.parseTag(str(tag, 80));
    if (!t) return { ok: false, error: 'That isn\'t a release tag.' };
    return once(root, async () => {
      const r = await rg.pushRelease(root, { tag: t.tag }, { git, env: envFor(await repoOf(root)), gate });
      if (r.ok) released(root, t.version);
      return r;
    });
  });

  // "Write it with Claude": the ask for a new conversation's box. You read it and send it.
  ipcMain.handle('releases:polish', async (_e, { root: given, version } = {}) => {
    const root = known(given);
    if (!root) return no;
    const state = await rg.readRelease(root, { git });
    if (!state.ok) return state;
    const v = R.isVersion(version) ? version : state.next.suggested;
    return {
      ok: true, cwd: root,
      draft: R.polishPrompt({
        project: d.projects.nameFor(root), version: v, since: state.last?.tag || null,
        groups: state.groups, changelog: state.changelog.name, style: state.changelog.style,
        notes: state.notes.length ? state.draft.notes : '',
      }),
    };
  });
}

module.exports = { registerReleasesIpc };
