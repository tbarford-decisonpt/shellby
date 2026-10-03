// The Projects page: your projects (git repositories on this PC and on GitHub,
// as one list), what each clone can run, and its dev servers. See
// docs/plans/projects.md.
//
// The list starts with the projects Shellby already knows and grows only when
// you add to it: one folder, or the ones you tick after scanning a folder you
// chose. Cloning always asks where. The panel names folders only by picking
// from what this service listed (knowsRoot), never by handing in a path.
const path = require('path');
const { EventEmitter } = require('events');
const leaving = require('../leaving');
const local = require('./local');
const clone = require('./clone');
const { merge, caseKey, repoKey } = require('./merge');
const { RepoCache } = require('./github');
const scripts = require('../devservers/scripts');

const LOCAL_TTL_MS = 60 * 1000;
const MAX_ADDED = 300;
const MAX_HIDDEN = 300;

const strList = (v, n) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 400).slice(0, n) : []);

/** config.projects -> { added: [root], hidden: [key], lastCloneParent } */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    added: strList(r.added, MAX_ADDED).filter(p => path.isAbsolute(p)),
    hidden: strList(r.hidden, MAX_HIDDEN),
    lastCloneParent: typeof r.lastCloneParent === 'string' && path.isAbsolute(r.lastCloneParent) ? r.lastCloneParent : null,
  };
}

class Projects extends EventEmitter {
  /**
   * deps: {
   *   config, devServers (devservers/service.js), now?()
   *   known() -> [{ key: folder, name }]        projects Shellby has seen (main.js knownProjects)
   *   lastWorked() -> Map(caseKey(root) -> ms)  when you last worked in each
   *   github() -> { signedIn, login, can(feature), gh(), claudeEnv() }
   *   run?: git runner (tests)
   * }
   */
  constructor(deps) {
    super();
    this.deps = deps;
    this.now = deps.now || Date.now;
    this.run = deps.run || leaving.git;
    this.state = normalize(deps.config.get('projects'));
    this.repoCache = new RepoCache({ now: this.now });
    this.localCache = { at: 0, repos: [], loading: null };
    this.listed = new Map(); // caseKey(root) -> root, of every clone in the last list
    this.scanned = new Map(); // caseKey(root) -> repo, from the last scan: the only ones addMany takes
    this.scanAbort = null;
    this.cloneAbort = null;
  }

  save(patch) {
    this.state = { ...this.state, ...patch };
    this.deps.config.set({ projects: this.state });
    this.localCache.at = 0;
  }

  /** The listed project's name for one of its clones (never one the panel made up). */
  nameFor(root) {
    return this.names?.get(caseKey(root)) || path.basename(root);
  }

  /** Is this one of the folders the page was shown? Every root from the panel is checked with it. */
  knowsRoot(root) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) return null;
    return this.listed.get(caseKey(root)) || null;
  }

  // ------------------------------------------------------------------ the list

  async localRepos({ force = false } = {}) {
    if (!force && this.localCache.at && this.now() - this.localCache.at < LOCAL_TTL_MS) return this.localCache.repos;
    this.localCache.loading ||= (async () => {
      const dirs = [...this.deps.known().map(k => k.key), ...this.state.added];
      const repos = await local.readRepos(dirs, this.run);
      this.localCache = { at: this.now(), repos, loading: null };
      return repos;
    })().catch(() => { this.localCache.loading = null; return this.localCache.repos; });
    return this.localCache.loading;
  }

  githubState() {
    const g = this.deps.github();
    const enabled = !!g?.signedIn && g.can('projects');
    return { signedIn: !!g?.signedIn, enabled, privateRepos: !!g?.signedIn && g.can('claude'), error: enabled ? this.repoCache.error : null };
  }

  async githubRepos({ force = false } = {}) {
    const g = this.deps.github();
    if (!g?.signedIn || !g.can('projects')) { this.repoCache.clear(); return []; }
    return this.repoCache.get(g.gh(), g.login, { force });
  }

  /** -> { projects, github, servers } for the page. refresh: re-read local repos and GitHub now. */
  async list({ refresh = false } = {}) {
    const [locals, remote] = await Promise.all([this.localRepos({ force: refresh }), this.githubRepos({ force: refresh })]);
    const running = new Set(this.deps.devServers.view().servers.filter(s => s.status === 'up' || s.status === 'starting').map(s => caseKey(s.root)));
    const projects = merge(locals, remote, { hidden: new Set(this.state.hidden), lastWorked: this.deps.lastWorked(), running });
    this.listed = new Map();
    this.names = new Map();
    for (const p of projects) {
      for (const c of p.local) {
        this.listed.set(caseKey(c.root), c.root);
        this.names.set(caseKey(c.root), p.name);
        Object.assign(c, this.cloneView(c.root));
      }
    }
    return { projects, github: this.githubState(), servers: this.deps.devServers.view(), lastCloneParent: this.state.lastCloneParent };
  }

  // What a clone can run, and what it's running.
  cloneView(root) {
    const found = scripts.read(root);
    return {
      manager: found?.manager || null,
      installed: found ? found.installed : null,
      scripts: found?.scripts || [],
      lastScript: this.deps.devServers.lastScript(root),
      servers: this.deps.devServers.forRoot(root),
    };
  }

  /** One project's page: its clones with uncommitted / unpushed work. */
  async detail(key) {
    const { projects } = await this.list();
    const p = projects.find(x => x.key === key);
    if (!p) return null;
    const states = await Promise.all(p.local.map(c => leaving.probe(c.root, this.run).catch(() => null)));
    p.local = p.local.map((c, i) => {
      const s = states[i];
      const main = s?.ok ? s.worktrees.find(w => w.main) || s.worktrees[0] : null;
      return {
        ...c,
        git: s?.ok ? {
          dirty: main ? (main.changed || 0) + (main.untracked || 0) : 0,
          unpushed: s.unpushed?.commits || 0,
          copies: s.worktrees.filter(w => !w.main).map(w => ({ path: w.path, branch: w.branch })).slice(0, 12),
        } : null,
      };
    });
    return p;
  }

  // ------------------------------------------------------------------ adding and removing

  /** A folder you picked -> its repository on the list. */
  async add(dir) {
    const repo = await local.readRepo(dir, this.run);
    if (!repo) return { ok: false, error: "That folder isn't in a git repository." };
    this.include([repo]);
    return { ok: true, root: repo.root, name: repo.name };
  }

  /** repos: [{ root, remote? }] onto the added list. */
  include(repos) {
    const keys = new Set(this.state.added.map(caseKey));
    const added = [...this.state.added];
    for (const { root } of repos) if (!keys.has(caseKey(root))) { keys.add(caseKey(root)); added.push(root); }
    // Adding a repo you once removed brings it back, by whichever key it was hidden under.
    const unhide = new Set(repos.flatMap(r => [`local:${caseKey(r.root)}`, ...(r.remote ? [repoKey(r.remote)] : [])]));
    this.save({ added: added.slice(-MAX_ADDED), hidden: this.state.hidden.filter(k => !unhide.has(k)) });
    this.emit('change');
  }

  /**
   * Look through a folder you picked, once. -> { ok, parent, candidates: [{ root, name, remote, listed }], truncated }.
   * Nothing is added: you choose from the candidates (addMany).
   */
  async scan(parent) {
    this.scanAbort?.abort();
    const ac = new AbortController();
    this.scanAbort = ac;
    const { found, truncated } = await local.scanFolder(parent, { signal: ac.signal });
    if (ac.signal.aborted) return { ok: false, cancelled: true };
    const repos = await local.readRepos(found, this.run);
    if (this.scanAbort === ac) this.scanAbort = null;
    const listed = new Set((await this.localRepos()).map(r => caseKey(r.root)));
    this.scanned = new Map(repos.map(r => [caseKey(r.root), r]));
    const candidates = repos
      .map(r => ({ root: r.root, name: r.name, remote: r.remote, listed: listed.has(caseKey(r.root)) }))
      .sort((a, b) => Number(a.listed) - Number(b.listed) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return { ok: true, parent, candidates, truncated };
  }

  cancelScan() { this.scanAbort?.abort(); this.scanAbort = null; }

  /** The ones you ticked. Only roots the last scan found are taken. */
  addMany(roots) {
    const ok = (Array.isArray(roots) ? roots : []).filter(r => typeof r === 'string' && this.scanned.has(caseKey(r))).slice(0, 200);
    if (ok.length) this.include(ok.map(r => this.scanned.get(caseKey(r))));
    return { ok: true, added: ok.length };
  }

  /** Off the list. The folder is never touched. */
  remove(key) {
    if (typeof key !== 'string' || !/^(github|local):/.test(key) || key.length > 500) return { ok: false };
    const roots = new Set();
    // Its clones you added by hand come off the added list too.
    for (const r of this.state.added) {
      if (key === `local:${caseKey(r)}`) roots.add(caseKey(r));
    }
    this.save({ added: this.state.added.filter(r => !roots.has(caseKey(r))), hidden: [...new Set([...this.state.hidden, key])].slice(-MAX_HIDDEN) });
    this.emit('change');
    return { ok: true };
  }

  // ------------------------------------------------------------------ cloning

  /** Clone `repo` into a folder you chose. onProgress({ phase, percent }). */
  async clone(repo, parent, onProgress = () => {}) {
    if (this.cloneAbort) return { ok: false, error: 'A clone is already going.' };
    const g = this.deps.github();
    const ac = new AbortController();
    this.cloneAbort = ac;
    try {
      // The sign-in's credential helper only when `repo` was already granted (private repos).
      const env = g?.signedIn && g.can('claude') ? g.claudeEnv() : {};
      const r = await clone.clone(repo, parent, { env, onProgress, signal: ac.signal });
      if (r.ok) {
        this.save({ lastCloneParent: path.resolve(parent) });
        this.include([{ root: r.root, remote: repo }]);
      }
      return r;
    } finally {
      this.cloneAbort = null;
    }
  }

  cancelClone() { this.cloneAbort?.abort(); }

  /** Where a clone would go, to show on the sheet before anything happens. */
  cloneTarget(repo, parent) { return clone.target(repo, parent); }
}

module.exports = { Projects, normalize };
