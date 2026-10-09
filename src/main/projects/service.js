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
const { withInsights, sessionsFor, sessionsIn, inside } = require('./insights');
const todo = require('./todo');
const terminal = require('./terminal');
const branches = require('./branches');
const inbox = require('./inbox');
const standup = require('./standup');
const gitinfo = require('../gitinfo');
const scripts = require('../devservers/scripts');
const output = require('../devservers/output');

const LOCAL_TTL_MS = 60 * 1000;
// Each clone's git state (uncommitted, unpushed) is read after the list is
// drawn, a few at a time, and kept this long: a row's "3 unpushed" can wait.
const GIT_TTL_MS = 2 * 60 * 1000;
const GIT_AT_ONCE = 4;
const MAX_GIT_READS = 60;
const MAX_ADDED = 300;
const MAX_HIDDEN = 300;
// The inbox's branch reads (branches.js) cost a few git calls a branch: kept longer.
const BRANCH_TTL_MS = 10 * 60 * 1000;
const MAX_DISMISSED = 300;
const MAX_ID = 700; // a dismissal's id: a folder, a branch name and a time

const strList = (v, n) => (Array.isArray(v) ? v.filter(x => typeof x === 'string' && x.length <= 400).slice(0, n) : []);

/** config.projects -> { added: [root], hidden: [key], dismissed: [inbox id], lastCloneParent, todo: { [key]: [item] } } */
function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  return {
    added: strList(r.added, MAX_ADDED).filter(p => path.isAbsolute(p)),
    hidden: strList(r.hidden, MAX_HIDDEN),
    dismissed: (Array.isArray(r.dismissed) ? r.dismissed : []).filter(id => typeof id === 'string' && id.length <= MAX_ID && /^[bc]:/.test(id)).slice(-MAX_DISMISSED),
    lastCloneParent: typeof r.lastCloneParent === 'string' && path.isAbsolute(r.lastCloneParent) ? r.lastCloneParent : null,
    todo: todo.normalizeTodo(r.todo),
  };
}

class Projects extends EventEmitter {
  /**
   * deps: {
   *   config, devServers (devservers/service.js), now?()
   *   known() -> [{ key: folder, name }]        projects Shellby has seen (main.js knownProjects)
   *   lastWorked() -> Map(caseKey(root) -> ms)  when you last worked in each
   *   github() -> { signedIn, login, can(feature), gh(), claudeEnv() }
   *   insights?() -> what the rest of Shellby knows per project (insights.js's sources)
   *   sessions?() -> History's index, for a project's recent conversations
   *   ci?() -> github/ci.js's view (+ enabled), for the inbox's pull requests
   *   copies?() -> { home, open: [path] }: where Shellby's copies live, and the ones open tabs work in
   *   retireCopy?({ path, root, branch }) -> { ok, error? }: tidy a copy away, History and all
   *   journal?(roots, name) -> its handoff notes (wiring/journal.js), or null
   *   time?() -> the time tracker's state (timetrack.js), for reports
   *   weekly?() -> the weekly ledger (weekly.js), for Claude's tasks in reports
   *   commits?(root, fromMs, toMs) -> [{ at, subject }]  your commits (gitinfo.commitsBetween)
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
    this.keys = new Set(); // every project key in the last list: the only ones a to-do can go on
    this.scanned = new Map(); // caseKey(root) -> repo, from the last scan: the only ones addMany takes
    this.scanAbort = null;
    this.cloneAbort = null;
    this.gitCache = new Map(); // caseKey(root) -> { at, git }
    this.gitLoading = null;
    this.branchCache = new Map(); // caseKey(root) -> { at, read }: branches.read() for the inbox
    this.branchLoading = null;
    this.branchGen = new Map(); // caseKey(root) -> n, bumped by a delete: a read begun before it is thrown away
    this.branchAgain = new Set(); // roots to read again once the reads under way are done
    this.acting = new Map(); // caseKey(root) -> the delete or removal under way there: one at a time per repo
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

  /** Is this a GitHub repository the page was shown (owner/name)? For a project that's only on GitHub. */
  knowsRepo(repo) {
    return typeof repo === 'string' && !!this.repos?.has(repo.toLowerCase());
  }

  /** The GitHub repository a listed clone is of (its origin), or null. */
  async repoOf(root) {
    const want = caseKey(root);
    return (await this.localRepos()).find(r => caseKey(r.root) === want)?.remote || null;
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

  /**
   * -> { projects, github, servers } for the page. refresh: re-read local repos and GitHub now.
   * readGit: false when the caller reads the clones it cares about itself (detail).
   */
  async list({ refresh = false, readGit = true } = {}) {
    const [locals, remote] = await Promise.all([this.localRepos({ force: refresh }), this.githubRepos({ force: refresh })]);
    const running = new Set(this.deps.devServers.view().servers.filter(s => s.status === 'up' || s.status === 'starting').map(s => caseKey(s.root)));
    const projects = merge(locals, remote, { hidden: new Set(this.state.hidden), lastWorked: this.deps.lastWorked(), running });
    this.listed = new Map();
    this.names = new Map();
    this.repos = new Set(projects.map(p => p.github?.repo?.toLowerCase()).filter(Boolean));
    this.keys = new Set(projects.map(p => p.key));
    this.keyByRoot = new Map(); // caseKey(clone root) -> project key
    this.keyByRepo = new Map(); // owner/name (lower case) -> project key
    this.mainRoot = new Map();  // project key -> its first clone, where its .shellby/tasks.md is
    for (const p of projects) {
      if (p.github?.repo) this.keyByRepo.set(p.github.repo.toLowerCase(), p.key);
      if (p.local[0]) this.mainRoot.set(p.key, p.local[0].root);
      for (const c of p.local) {
        this.keyByRoot.set(caseKey(c.root), p.key);
        this.listed.set(caseKey(c.root), c.root);
        this.names.set(caseKey(c.root), p.name);
        Object.assign(c, this.cloneView(c.root));
      }
    }
    if (readGit) this.readGitSoon(projects.flatMap(p => p.local.map(c => c.root)), { force: refresh });
    return {
      projects: withInsights(projects, this.sources()).map(p => ({ ...p, todoCount: this.todoOf(p.key).length })),
      github: this.githubState(), servers: this.deps.devServers.view(), lastCloneParent: this.state.lastCloneParent,
    };
  }

  // Everything insights.js joins to the projects, read now.
  sources() {
    let given = {};
    try { given = this.deps.insights?.() || {}; } catch { /* a source that fails leaves its facts off the page */ }
    const git = new Map([...this.gitCache].map(([k, v]) => [k, v.git]));
    return { ...given, now: this.now(), servers: this.deps.devServers.view().servers, git };
  }

  // ------------------------------------------------------------------ git, after the list

  gitView(s) {
    if (!s?.ok) return null;
    const main = s.worktrees.find(w => w.main) || s.worktrees[0];
    const copies = s.worktrees.filter(w => !w.main);
    return {
      dirty: main ? (main.changed || 0) + (main.untracked || 0) : 0,
      unpushed: s.unpushed?.commits || 0,
      stashes: s.stashes || 0,
      copies: copies.length,
      copyList: copies.map(w => ({ path: w.path, branch: w.branch, changed: (w.changed || 0) + (w.untracked || 0) })).slice(0, 12),
    };
  }

  async readGit(root) {
    const s = await leaving.probe(root, this.run).catch(() => null);
    const git = this.gitView(s);
    const before = JSON.stringify(this.gitCache.get(caseKey(root))?.git ?? null);
    this.gitCache.set(caseKey(root), { at: this.now(), git });
    return JSON.stringify(git) !== before;
  }

  /** Read the clones whose git state is stale, a few at a time. -> did any change? */
  async readStale(roots, { force = false } = {}) {
    const stale = roots.filter(r => {
      const c = this.gitCache.get(caseKey(r));
      return force || !c || this.now() - c.at > GIT_TTL_MS;
    }).slice(0, MAX_GIT_READS);
    let changed = false;
    const queue = [...stale];
    const worker = async () => { while (queue.length) if (await this.readGit(queue.shift())) changed = true; };
    await Promise.all(Array.from({ length: Math.min(GIT_AT_ONCE, queue.length) }, worker));
    return changed;
  }

  /** The same, in the background, saying so when any changed. */
  readGitSoon(roots, { force = false } = {}) {
    if (this.gitLoading) return;
    this.gitLoading = this.readStale(roots, { force })
      .then(changed => { if (changed) this.emit('change'); })
      .catch(() => {}).finally(() => { this.gitLoading = null; });
  }

  /**
   * The list with git read first, for answers that can't be filled in later:
   * a terminal can't redraw, and "nothing unpushed" must not mean "not read yet".
   */
  async listWithGit() {
    await this.gitLoading;
    const first = await this.list({ readGit: false });
    const changed = await this.readStale(first.projects.flatMap(p => p.local.map(c => c.root))).catch(() => false);
    if (!changed) return first;
    this.emit('change');
    return this.list({ readGit: false });
  }

  // ------------------------------------------------------------------ the inbox

  /** Is this folder one of Shellby's copies (in its worktree folder)? */
  isCopy(p) {
    const home = this.deps.copies?.().home;
    return !!home && typeof p === 'string' && inside(p, home) && caseKey(p) !== caseKey(home);
  }

  /**
   * What's waiting on you across every project (inbox.js). The branch reads
   * happen after, a few at a time, and a 'change' says when they're in.
   */
  async inbox({ refresh = false } = {}) {
    if (!this.listed.size) await this.list();
    this.readBranchesSoon([...this.listed.values()], { force: refresh });
    return this.inboxView();
  }

  inboxView() {
    const roots = [...this.listed.values()];
    let sessions = [];
    try { sessions = this.deps.sessions?.() || []; } catch { /* no History, no titles */ }
    return inbox.build({
      now: this.now(),
      ci: this.deps.ci?.() || null,
      repos: roots.map(root => ({
        project: this.nameFor(root), root,
        read: this.branchCache.get(caseKey(root))?.read || null,
        git: this.gitCache.get(caseKey(root))?.git || null,
      })),
      sessions,
      open: this.deps.copies?.().open || [],
      dismissed: new Set(this.state.dismissed),
    });
  }

  async readBranches(root) {
    const gen = this.branchGen.get(caseKey(root)) || 0;
    const read = await branches.read(root, { run: this.run, now: this.now(), isCopy: p => this.isCopy(p) }).catch(() => null);
    if ((this.branchGen.get(caseKey(root)) || 0) !== gen) { this.branchAgain.add(root); return false; }
    const before = JSON.stringify(this.branchCache.get(caseKey(root))?.read ?? null);
    this.branchCache.set(caseKey(root), { at: this.now(), read });
    return JSON.stringify(read) !== before;
  }

  readBranchesSoon(roots, { force = false } = {}) {
    if (this.branchLoading) { if (force) for (const r of roots) this.branchAgain.add(r); return; }
    const stale = roots.filter(r => {
      const c = this.branchCache.get(caseKey(r));
      return force || !c || this.now() - c.at > BRANCH_TTL_MS;
    }).slice(0, MAX_GIT_READS);
    if (!stale.length) return;
    this.branchLoading = (async () => {
      let changed = false;
      const queue = [...stale];
      const worker = async () => { while (queue.length) if (await this.readBranches(queue.shift())) changed = true; };
      await Promise.all(Array.from({ length: Math.min(GIT_AT_ONCE, queue.length) }, worker));
      if (changed) this.emit('change');
    })().catch(() => {}).finally(() => {
      this.branchLoading = null;
      const again = [...this.branchAgain];
      this.branchAgain.clear();
      if (again.length) this.readBranchesSoon(again, { force: true });
    });
  }

  // Something changed a repo's branches: what's cached, and any read under way, is out of date.
  touchBranches(root) {
    this.branchGen.set(caseKey(root), (this.branchGen.get(caseKey(root)) || 0) + 1);
  }

  // One delete or removal at a time in each repository: two branches at the
  // same commit each look like "somewhere else" to the other.
  serial(root, fn) {
    const key = caseKey(root);
    const run = (this.acting.get(key) || Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    this.acting.set(key, tail);
    tail.then(() => { if (this.acting.get(key) === tail) this.acting.delete(key); });
    return run;
  }

  /** "Keep it": off the inbox until it moves (a new commit, more work in the copy). */
  dismiss(id) {
    if (typeof id !== 'string' || !/^[bc]:/.test(id) || id.length > MAX_ID) return { ok: false };
    // Not save(): nothing about the repos changed, so no need to read them all again.
    this.state = { ...this.state, dismissed: [...new Set([...this.state.dismissed, id])].slice(-MAX_DISMISSED) };
    this.deps.config.set({ projects: this.state });
    this.emit('change');
    return { ok: true };
  }

  // An item the inbox listed, found again by what the panel names (never a path it made up).
  listedBranch(root, name) {
    const known = this.knowsRoot(root);
    const b = known && this.branchCache.get(caseKey(known))?.read?.branches.find(x => x.name === name);
    return b ? { root: known, branch: b } : null;
  }

  listedCopy(p) {
    if (typeof p !== 'string' || !path.isAbsolute(p)) return null;
    for (const [key, { read }] of this.branchCache) {
      const c = read?.copies.find(x => caseKey(x.path) === caseKey(p));
      if (c && this.listed.has(key)) return { root: this.listed.get(key), copy: c };
    }
    return null;
  }

  /**
   * Delete a stale branch. One with nothing only here goes at once; one with
   * commits only here needs `confirmed`: the tip it asked about (main asks
   * first). Looked at again just before, so a commit made since isn't lost.
   * -> { ok, needsConfirm?, only?, error? }
   */
  async deleteBranch(root, name, { confirmed = null } = {}) {
    const found = this.listedBranch(root, name);
    if (!found) return { ok: false, error: "That branch isn't on the list any more." };
    return this.serial(found.root, async () => {
      const now = await branches.recheck(found.root, name, this.run);
      if (now.gone) return this.forgetBranch(found.root, name, { ok: true });
      if (!now.ok || !now.sha) return { ok: false, error: "git couldn't look at that branch just now." };
      if (now.checkedOut) return { ok: false, error: `${name} is checked out somewhere, so it stays.` };
      if (now.only > 0 && !confirmed) return { ok: false, needsConfirm: true, only: now.only, sha: now.sha };
      if (now.only > 0 && now.sha !== confirmed) return { ok: false, error: `${name} has moved since. Have another look first.` };
      // Only if it still points where it did a moment ago: a commit made since stops it.
      const r = await this.run(['-C', found.root, 'update-ref', '-d', `refs/heads/${name}`, now.sha]);
      if (r === null) return { ok: false, error: `git couldn't delete ${name}.` };
      await this.run(['-C', found.root, 'config', '--remove-section', `branch.${name}`]); // its upstream, if it had one
      this.touchBranches(found.root);
      return this.forgetBranch(found.root, name, { ok: true, only: now.only });
    });
  }

  forgetBranch(root, name, result) {
    const c = this.branchCache.get(caseKey(root));
    if (c?.read) this.branchCache.set(caseKey(root), { ...c, read: { ...c.read, branches: c.read.branches.filter(b => b.name !== name) } });
    this.emit('change');
    return result;
  }

  /**
   * Tidy away one of Shellby's copies nobody went back to. An empty one (no
   * uncommitted files, no commits only it has, no ignored files but its
   * dependencies) goes at once; one with work needs `confirmed`, the counts
   * the question showed: more than that since, and it asks again. Never one
   * an open tab is working in.
   */
  async removeCopy(p, { confirmed = null } = {}) {
    const found = this.listedCopy(p);
    if (!found || !this.isCopy(found.copy.path)) return { ok: false, error: "That copy isn't on the list any more." };
    const { root, copy } = found;
    const inUse = () => (this.deps.copies?.().open || []).some(o => inside(o, copy.path));
    if (inUse()) return { ok: false, error: 'A conversation is working in that copy right now.' };
    return this.serial(root, async () => {
      const [status, weight] = await Promise.all([
        this.run(['-C', copy.path, 'status', '--porcelain=v1', '--untracked-files=normal', '--ignored=matching']),
        branches.recheck(root, copy.branch, this.run),
      ]);
      if (weight.gone) return { ok: false, error: 'That copy has gone already.' };
      if (status === null || !weight.ok) return { ok: false, error: "git couldn't look at that copy just now." };
      const st = leaving.parseStatus(status);
      const changed = st.changed + st.untracked;
      // Ignored files go with the folder too (a .env.local, a local database): those are asked about.
      // Dependencies aren't: they come back with an install.
      const ignored = status.split('\n').filter(l => l.startsWith('!! ')).map(l => l.slice(3).trim())
        .filter(f => !/^node_modules\/?$/.test(f));
      const seen = { changed, only: weight.only, ignoredTotal: ignored.length };
      const grew = !confirmed || seen.changed > (confirmed.changed || 0) || seen.only > (confirmed.only || 0) || seen.ignoredTotal > (confirmed.ignoredTotal || 0);
      if ((changed || weight.only || ignored.length) && grew) {
        return { ok: false, needsConfirm: true, ...seen, ignored: ignored.slice(0, 3), moreIgnored: Math.max(0, ignored.length - 3) };
      }
      if (inUse()) return { ok: false, error: 'A conversation is working in that copy right now.' };
      if (!this.deps.retireCopy) return { ok: false, error: "Copies can't be removed from here." };
      const r = await this.deps.retireCopy({ path: copy.path, root, branch: copy.branch });
      if (!r?.ok) return { ok: false, error: r?.error || "Couldn't remove that copy." };
      this.touchBranches(root);
      this.forgetCopy(root, copy);
      this.readGitSoon([root], { force: true });
      this.readBranchesSoon([root], { force: true });
      return { ok: true };
    });
  }

  // Off the cached reads at once, the rest of the repo's list kept: dropping the
  // whole read emptied the inbox until git had looked again, and the next
  // Remove found nothing to remove.
  forgetCopy(root, copy) {
    const key = caseKey(root);
    const other = x => caseKey(x.path) !== caseKey(copy.path);
    const b = this.branchCache.get(key);
    if (b?.read) {
      this.branchCache.set(key, {
        ...b,
        read: { ...b.read, copies: (b.read.copies || []).filter(other), branches: (b.read.branches || []).filter(x => x.name !== copy.branch) },
      });
    }
    const g = this.gitCache.get(key);
    if (g?.git?.copyList) {
      const copyList = g.git.copyList.filter(other);
      const gone = g.git.copyList.length - copyList.length;
      this.gitCache.set(key, { ...g, git: { ...g.git, copyList, copies: Math.max(0, (g.git.copies || 0) - gone) } });
    }
    this.emit('change');
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

  /**
   * One project's page: its clones with uncommitted / unpushed work and
   * Shellby's copies, read fresh; its insights; and its recent conversations.
   * listed: that project from a list() just made, so it isn't listed twice.
   */
  async detail(key, { listed = null } = {}) {
    const found = listed?.key === key ? listed : (await this.list({ readGit: false })).projects.find(x => x.key === key);
    if (!found) return null;
    await Promise.all(found.local.map(c => this.readGit(c.root)));
    const local = found.local.map(c => ({ ...c, git: this.gitCache.get(caseKey(c.root))?.git || null }));
    const [p] = withInsights([{ ...found, local }], this.sources());
    let sessions = [];
    try {
      const copies = local.flatMap(c => (c.git?.copyList || []).map(w => w.path));
      sessions = sessionsFor(this.deps.sessions?.() || [], local.map(c => c.root), copies);
    } catch { /* no History, no list */ }
    let journal = null;
    try { journal = this.deps.journal?.(local.map(c => c.root), p.name) || null; } catch { /* no notes */ }
    return { ...p, sessions, journal, todo: this.todoOf(key) };
  }

  /**
   * A project's standup or weekly report (standup.js), in Slack's words and
   * an email's. kind: 'standup' | 'week' | 'last-week'. Only your own commits
   * count; time and Claude's tasks come from what Shellby already keeps.
   */
  async report(key, kind) {
    const k = standup.KINDS.includes(kind) ? kind : 'standup';
    const p = await this.detail(key);
    if (!p) return null;
    const now = this.now();
    const w = standup.windowOf(k, now);
    const roots = p.local.map(c => c.root);
    const copies = p.local.flatMap(c => (c.git?.copyList || []).map(x => x.path));
    const commitsOf = this.deps.commits || gitinfo.commitsBetween;
    const lists = await Promise.all(roots.map(r => Promise.resolve().then(() => commitsOf(r, w.from, w.to)).catch(() => [])));
    let sessions = [];
    try { sessions = sessionsIn(this.deps.sessions?.() || [], roots, copies); } catch { /* no History, no conversations */ }
    const input = standup.inputFrom(p, {
      commits: lists.flat(),
      sessions,
      time: standup.timeByDay(this.deps.time?.() || null, roots, w),
      tasks: standup.tasksByDay(this.deps.weekly?.() || null, roots.map(r => path.basename(r))),
    });
    const report = standup.build(k, input, now);
    return { ok: true, kind: k, name: p.name, report, slack: standup.toSlack(report), text: standup.toText(report) };
  }

  // ------------------------------------------------------------------ to-dos

  // Only the to-do list: unlike save(), the local repos needn't be read again.
  saveTodo(next) {
    this.state = { ...this.state, todo: next };
    this.deps.config.set({ projects: this.state });
    this.emit('change');
  }

  /** The project key for a listed clone or GitHub repository, or null (Next up names projects by those). */
  keyFor({ root = null, repo = null } = {}) {
    if (root) return this.keyByRoot?.get(caseKey(root)) || null;
    return repo ? this.keyByRepo?.get(String(repo).toLowerCase()) || null : null;
  }

  // A cloned project's to-dos are its .shellby/tasks.md (deps.repoTasks, wiring/backlog.js):
  // one list, in the repository, the one Next up shows. Only a project with no
  // clone here keeps them in config.
  repoTasksFor(key) {
    const root = this.mainRoot?.get(key);
    return root && this.deps.repoTasks ? { root, rt: this.deps.repoTasks } : null;
  }

  /** A project's to-dos: [{ id, text, from, at }]. */
  todoOf(key) {
    const r = this.repoTasksFor(key);
    return r ? r.rt.list(r.root) : todo.listFor(this.state.todo, key);
  }

  /** from: 'you' (the page) | 'claude' (add_task) | 'terminal' (shellby next add). -> { ok, item, count, existed } | { ok: false, error } */
  addTodo(key, text, from = 'you') {
    if (!this.keys.has(key)) return { ok: false, error: "That project isn't on the Projects page." };
    const repoBacked = this.repoTasksFor(key);
    if (repoBacked) {
      const r = repoBacked.rt.add(repoBacked.root, text, from);
      if (r.ok && !r.existed) this.emit('change');
      return r;
    }
    const r = todo.addTodo(this.state.todo, key, text, { from, now: this.now() });
    if (!r.ok) return r;
    if (!r.existed) this.saveTodo(r.todo);
    return { ok: true, item: r.item, existed: !!r.existed, count: todo.listFor(r.todo, key).length };
  }

  /** ref: the to-do's id, or its number on the list. -> { ok, item, left } | { ok: false, error } */
  finishTodo(key, ref) {
    const repoBacked = this.repoTasksFor(key);
    if (repoBacked) {
      const r = repoBacked.rt.finish(repoBacked.root, ref);
      if (r.ok) this.emit('change');
      return r;
    }
    const r = todo.finishTodo(this.state.todo, key, ref);
    if (!r.ok) return r;
    this.saveTodo(r.todo);
    return { ok: true, item: r.item, left: todo.listFor(r.todo, key).length };
  }

  // ------------------------------------------------------------------ from a terminal

  /**
   * Which project a terminal question means: the one named, else the one the
   * folder it came from is in. A folder in one of Shellby's copies (or any
   * worktree), named or asked from, is found through its repository's main
   * checkout: the copies live outside the repo.
   * -> { project } | { error }
   */
  async resolve({ project = '', cwd = '' } = {}) {
    const { projects } = await this.list({ readGit: false });
    const found = terminal.findProject(projects, { query: project, cwd });
    if (found.project) return found;
    const folder = !project ? cwd : path.isAbsolute(project) ? project : '';
    const root = folder ? await leaving.mainRoot(folder, this.run).catch(() => null) : null;
    const again = root ? terminal.findProject(projects, { cwd: root }) : {};
    if (again.project) return again;
    return found.error ? { error: found.error } : { error: terminal.notAProject(cwd) };
  }

  /**
   * The MCP tools and `shellby projects` / `shellby next`, answered.
   * intent: crabtools' checked { action, project?, cwd?, everywhere?, script?, lines?, text?, task?, via }.
   * -> { text } | { ok: false, error, status }
   */
  async forTerminal(intent) {
    const via = intent.via === 'cli' ? 'cli' : 'mcp';
    const now = this.now();
    const listOf = key => this.todoOf(key);

    if (intent.action === 'projects') {
      const { projects } = await this.listWithGit();
      return { text: terminal.projectsText(projects, { todoCounts: new Map(projects.map(p => [p.key, listOf(p.key).length])), via }) };
    }
    if (intent.action === 'next_up' && intent.everywhere) {
      const { projects } = await this.listWithGit();
      return { text: terminal.everywhereText(projects.map(p => ({ project: p, todo: listOf(p.key) })), { via }) };
    }

    // Not found is a 400, never a 404: the MCP server reads a 404 as "this Shellby is too old".
    const found = await this.resolve(intent);
    if (found.error) return { ok: false, error: found.error, status: 400 };
    const p = found.project;

    switch (intent.action) {
      case 'next_up': {
        const full = await this.detail(p.key, { listed: p });
        // Next up's issues and loose ends (wiring/backlog.js), after the rest. Best effort: none is fine.
        const backlog = this.deps.backlog
          ? await Promise.resolve(this.deps.backlog({ root: p.local[0]?.root || null, repo: p.github?.repo || null })).catch(() => [])
          : [];
        return { text: terminal.nextUpText(full || p, listOf(p.key), { now, via, backlog }) };
      }
      case 'server_log': {
        const pick = terminal.pickServer(p, intent.script);
        if (pick.error) return { ok: false, error: pick.error, status: 400 };
        const log = this.deps.devServers.log(pick.server.id);
        return { text: terminal.serverLogText(p, pick.server, output.tail(log?.lines || [], intent.lines)) };
      }
      case 'add_task': {
        const r = this.addTodo(p.key, intent.text, via === 'cli' ? 'terminal' : 'claude');
        return r.ok ? { text: terminal.todoAddedText(p, r, r.count) } : { ok: false, error: r.error, status: 400 };
      }
      case 'finish_task': {
        const r = this.finishTodo(p.key, intent.task);
        return r.ok ? { text: terminal.todoDoneText(p, r, r.left) } : { ok: false, error: r.error, status: 400 };
      }
      default:
        return { ok: false, error: 'Unknown question.', status: 400 };
    }
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
