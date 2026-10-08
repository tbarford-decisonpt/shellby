// Next up: a ranked backlog on each project's page (docs/plans/next-up.md).
// Your tasks in .shellby/tasks.md, the repository's open issues and
// milestones, the loose ends in its code and, once Sentry is connected, its
// new production errors (wiring/sentry.js), in one list (backlog/rank.js),
// each with "Do this": a copy on its own branch, a conversation in it, and the
// prompt waiting in the box for you to read and send.
//
// The panel only names things: a project by a root the Projects page listed
// (or a repository it listed, for one only on GitHub), an item by the id the
// last list gave it. Main looks each one up before using it.
//
// A project can add its Linear or Jira issues too (backlog/trackers.js): read
// through an MCP server you already have, by one short Claude call in the
// background, so the card never waits for it. It says so when they arrive.
//
// tasks.md is only ever written here, in your checkout, never in a copy:
// copies start from a commit, so a tick made on a branch would collide with
// your uncommitted list when it came home. Kept out of main.js, which only
// wires it up.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tasks = require('../backlog/tasks');
const { rank } = require('../backlog/rank');
const { fetchBacklog } = require('../backlog/github');
const prompts = require('../backlog/prompts');
const trackers = require('../backlog/trackers');
const mcpServers = require('../mcpservers');
const confirm = require('../confirm');
const editor = require('../editor');
const worktrees = require('../worktrees');

const ISSUES_TTL_MS = 5 * 60 * 1000;
const TICKETS_TTL_MS = 30 * 60 * 1000; // each read is a Claude call: kept longer than GitHub's
const MAX_FILE_BYTES = 256 * 1024;
const DOING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_HIDDEN = 200;
const MAX_LINKS = 100;      // per project
const MAX_LISTED = 200;     // items the panel gets
const MAX_TEXT_ITEMS = 15;  // in `shellby next` and the MCP tool
const BOM = String.fromCharCode(0xfeff);
const TASKS_PARTS = ['.shellby', 'tasks.md'];

const hashOf = s => crypto.createHash('sha256').update(s).digest('hex');
const lower = s => String(s || '').toLowerCase();
const firstLine = s => String(s || '').trim().split('\n').filter(Boolean).pop() || '';
const inside = (child, parent) => {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

/** d: what main shares (main.js `shared`). */
function wireBacklog(d) {
  const issueCache = new Map(); // repo (lower case) -> { at, data }
  const lists = new Map();      // project key -> { items, root, repo, name }
  const reads = new Map();      // root (lower case) -> hash of tasks.md as last listed
  const ticketCache = new Map(); // project key -> { at, sig, tickets, error }
  const ticketReads = new Map(); // project key -> the read in flight

  const keyOf = p => (p.root ? `root:${lower(p.root)}` : `repo:${lower(p.repo)}`);
  const login = () => d.github?.view().login || null;
  // A question in Shellby's own window (confirm.js). d.askConfirm stands in for it in tests.
  const askUser = spec => (d.askConfirm ? d.askConfirm(spec) : confirm.ask(d.panel, { ...d.dialogLook(), ...spec }));
  const claudeReady = () => !d.config.get('crabOnly') && !!d.claudeStatus?.installed && !!d.claudeStatus?.loggedIn;

  // ---- which project

  /** A project the panel named -> { ok, root, repo, name, key } | { ok: false, error }. */
  async function resolve({ root, repo } = {}) {
    if (!d.projects) return { ok: false, error: 'Shellby is still starting up. Try again in a moment.' };
    if (typeof root === 'string' && root) {
      const known = path.isAbsolute(root) ? d.projects.knowsRoot(root) : null;
      if (!known || !fs.existsSync(known)) return { ok: false, error: "That folder isn't on the Projects page." };
      const remote = await d.projects.repoOf(known);
      const p = { ok: true, root: known, repo: remote, name: d.projects.nameFor(known) };
      return { ...p, key: keyOf(p) };
    }
    if (typeof repo === 'string' && d.projects.knowsRepo(repo)) {
      const p = { ok: true, root: null, repo, name: repo.split('/')[1] };
      return { ...p, key: keyOf(p) };
    }
    return { ok: false, error: "That project isn't on the Projects page." };
  }

  // ---- .shellby/tasks.md

  const tasksPath = root => path.join(root, ...TASKS_PARTS);

  /** The file as it is now. -> { ok, exists, text, bom, hash } | { ok: false, error } */
  function readTasks(root) {
    const dir = path.join(root, TASKS_PARTS[0]);
    const file = tasksPath(root);
    try {
      if (fs.existsSync(dir) && fs.lstatSync(dir).isSymbolicLink()) return { ok: false, error: '.shellby is a link, so Shellby leaves it alone.' };
      if (!fs.existsSync(file)) return { ok: true, exists: false, text: '', bom: false, hash: hashOf('') };
      const st = fs.lstatSync(file);
      if (st.isSymbolicLink() || !st.isFile()) return { ok: false, error: '.shellby/tasks.md isn\'t a plain file, so Shellby leaves it alone.' };
      if (!inside(fs.realpathSync.native(file), fs.realpathSync.native(root))) return { ok: false, error: '.shellby/tasks.md isn\'t inside the project.' };
      if (st.size > MAX_FILE_BYTES) return { ok: false, error: '.shellby/tasks.md is too big for Shellby to read (over 256 KB).' };
      const raw = fs.readFileSync(file, 'utf8');
      const bom = raw.startsWith(BOM);
      const text = bom ? raw.slice(1) : raw;
      return { ok: true, exists: true, text, bom, hash: hashOf(raw) };
    } catch (e) {
      return { ok: false, error: `Couldn't read .shellby/tasks.md: ${e.message}` };
    }
  }

  /** Write it, only if it's still what `expect` hashed, through a temp file. */
  function writeTasks(root, text, { expect, bom = false }) {
    const now = readTasks(root);
    if (!now.ok) return now;
    if (now.hash !== expect) return { ok: false, stale: true, error: 'That list has changed since Shellby read it. Look again.' };
    const dir = path.join(root, TASKS_PARTS[0]);
    const file = tasksPath(root);
    const tmp = path.join(dir, `.tasks.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.mkdirSync(dir, { recursive: true });
      if (fs.lstatSync(dir).isSymbolicLink()) return { ok: false, error: '.shellby is a link, so Shellby leaves it alone.' };
      fs.writeFileSync(tmp, (bom ? BOM : '') + text, 'utf8');
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* it never got made */ }
      return { ok: false, error: `Couldn't save .shellby/tasks.md: ${e.message}` };
    }
    reads.set(lower(root), readTasks(root).hash);
    return { ok: true };
  }

  /** Is tasks.md ignored, or changed since the last commit? Best effort: unknown is false. */
  async function tasksGit(root) {
    const rel = TASKS_PARTS.join('/');
    const [ignored, status] = await Promise.all([
      worktrees.git(root, ['check-ignore', '-q', '--', rel], { timeout: 5000 }),
      worktrees.git(root, ['status', '--porcelain', '--', rel], { timeout: 5000 }),
    ]);
    return { ignored: ignored.ok, uncommitted: status.ok && !!status.out.trim() };
  }

  // ---- GitHub

  /** The repository's issues and milestones, cached. -> { state, issues?, milestones?, error?, stale? } */
  async function issuesFor(repo, fresh) {
    if (!repo) return { state: 'none' };
    const g = d.github;
    if (!g?.signedIn) return { state: 'signedOut' };
    if (!g.can('projects')) return { state: 'off' };
    const id = lower(repo);
    const hit = issueCache.get(id);
    if (!fresh && hit && Date.now() - hit.at < ISSUES_TTL_MS) return hit.data;
    const r = await fetchBacklog(repo, { gh: g.gh(), login: login(), ...d.githubEndpoints() });
    if (r.ok) {
      const data = { state: 'ok', issues: r.issues, milestones: r.milestones, complete: r.complete !== false };
      issueCache.set(id, { at: Date.now(), data });
      return data;
    }
    // Offline or limited: the last list, marked as old.
    if (hit && r.status !== 401 && r.status !== 404) return { ...hit.data, stale: true, error: r.error };
    return { state: 'error', error: r.error };
  }

  // ---- Linear and Jira (backlog/trackers.js)

  const trackersAll = () => ({ ...(d.config.get('backlogTrackers') || {}) });
  const trackerReady = () => claudeReady() && !!d.workflows;
  const folderFor = p => p.root || os.homedir();

  /** Your MCP servers for this project, each with what it looks like: [{ name, kind, direct }]. */
  function serversFor(p) {
    if (!trackerReady()) return [];
    const cwd = folderFor(p);
    return d.workflows.mcpServerList(cwd).map(sv => {
      const r = sv.direct ? mcpServers.resolveServer(sv.name, { home: os.homedir(), cwd }) : null;
      return { name: sv.name, kind: trackers.kindOf(sv.name, r?.ok ? r.def : null), direct: !!sv.direct };
    });
  }

  /** One read through Claude. -> { ok, tickets } | { ok: false, error } */
  async function readTickets(p, setup) {
    const cwd = folderFor(p);
    const servers = serversFor(p);
    const server = servers.find(sv => sv.name === setup.server);
    if (!server) return { ok: false, error: `There's no MCP server called “${setup.server}” any more. Pick another with ${trackers.KINDS[setup.kind].label}… under the list.` };
    // A server Shellby can start itself says which of its tools only read; the rest go by the kind's known names.
    const listed = server.direct ? await d.workflows.mcpTools(setup.server, cwd).catch(() => null) : null;
    const allowed = trackers.allowedFor(setup, listed?.ok ? listed.tools : null);
    if (!allowed.length) return { ok: false, error: `“${setup.server}” has no tools that only read, so Shellby won't use it for this.` };
    const denied = trackers.deniedFor(setup, servers.map(sv => sv.name));
    const res = await d.runClaudeOnce(trackers.fetchArgs(setup, { allowed, denied }), trackers.FETCH_TIMEOUT_MS, { cwd });
    if (res.timedOut) return { ok: false, error: `${trackers.KINDS[setup.kind].label} took too long to answer. Look again in a bit.` };
    if (!String(res.stdout || '').trim()) {
      d.log?.warn('Next up: reading tickets failed', String(res.stderr || res.err?.message || '').slice(-400));
      return { ok: false, error: 'Claude Code didn\'t answer. Check it\'s signed in, in Settings.' };
    }
    return trackers.parseTickets(res.stdout, setup);
  }

  /** Start a read in the background, unless one's going; the panel hears when it's done. */
  function refreshTickets(p, setup, sig) {
    if (ticketReads.has(p.key)) return;
    const read = readTickets(p, setup).catch(e => ({ ok: false, error: e.message })).then(r => {
      ticketReads.delete(p.key);
      // Changed or turned off while it was reading: this answer is for something else.
      if (JSON.stringify(trackersAll()[p.key] || null) !== sig) return;
      const hit = ticketCache.get(p.key);
      const kept = hit?.sig === sig ? hit.tickets : null;
      ticketCache.set(p.key, r.ok ? { at: Date.now(), sig, tickets: r.tickets, error: null } : { at: Date.now(), sig, tickets: kept, error: r.error });
      d.send(d.panel, 'backlog:changed', { root: p.root, repo: p.repo });
    });
    ticketReads.set(p.key, read);
  }

  /**
   * This project's Linear or Jira issues, as last read (never waits for Claude).
   * kick: start a read if they're old. -> { state, setup?, tickets?, error?, at?, loading? }
   */
  function ticketsFor(p, { fresh = false, kick = false } = {}) {
    const setup = trackersAll()[p.key];
    if (!setup) return { state: 'none' };
    if (!trackerReady()) return { state: 'off', setup };
    const sig = JSON.stringify(setup);
    const hit = ticketCache.get(p.key)?.sig === sig ? ticketCache.get(p.key) : null;
    if (kick && (fresh || !hit || Date.now() - hit.at > TICKETS_TTL_MS)) refreshTickets(p, setup, sig);
    const loading = ticketReads.has(p.key);
    if (!hit) return { state: 'loading', setup, loading };
    if (!hit.tickets) return { state: 'error', setup, error: hit.error, loading };
    return { state: 'ok', setup, tickets: hit.tickets, at: hit.at, error: hit.error, stale: !!hit.error, loading };
  }

  /**
   * What the card says about it. null when the project has none and you have no
   * Linear or Jira server, so nobody without one ever sees any of this.
   * offer: what the link under the list says ('Linear', 'Jira' or 'Linear or Jira').
   */
  function trackerView(p, t) {
    if (t.state === 'none') {
      const kinds = trackerReady() ? [...new Set(serversFor(p).map(sv => sv.kind).filter(Boolean))].sort((a, b) => b.localeCompare(a)) : [];
      return kinds.length ? { state: 'none', offer: kinds.map(k => trackers.KINDS[k].label).join(' or ') } : null;
    }
    const { kind, server, scope } = t.setup;
    return {
      state: t.state, kind, label: trackers.KINDS[kind].label, server, scope,
      error: t.error || null, stale: !!t.stale, loading: !!t.loading, at: t.at || null,
      count: t.tickets?.length || 0,
    };
  }

  /** For the Linear or Jira form: the servers to pick from (likely ones first) and what's set now. */
  async function trackerChoices({ root, repo } = {}) {
    const p = await resolve({ root, repo });
    if (!p.ok) return p;
    if (!trackerReady()) return { ok: false, error: 'That needs Claude Code: Shellby reads them through it.' };
    const servers = serversFor(p).map(({ name, kind }) => ({ name, kind }))
      .sort((a, b) => (!!b.kind - !!a.kind) || a.name.localeCompare(b.name));
    const hints = Object.fromEntries(Object.entries(trackers.KINDS).map(([k, v]) => [k, v.scopeHint]));
    return { ok: true, servers, setup: trackersAll()[p.key] || null, hints };
  }

  /** Save the setup ({ server, kind, scope }), or { off: true } to stop. */
  async function trackerSet({ root, repo, off = false, ...raw } = {}) {
    const p = await resolve({ root, repo });
    if (!p.ok) return p;
    const all = trackersAll();
    ticketCache.delete(p.key);
    if (off) {
      delete all[p.key];
      d.config.set({ backlogTrackers: all });
      return { ok: true };
    }
    const c = trackers.checkSetup(raw);
    if (!c.ok) return c;
    if (!serversFor(p).some(sv => sv.name === c.setup.server)) return { ok: false, error: `There's no MCP server called “${c.setup.server}” here. Add it in Toolbox → MCP first.` };
    all[p.key] = c.setup;
    d.config.set({ backlogTrackers: all });
    return { ok: true };
  }

  // ---- what's being worked on, and what's hidden (this PC only)

  const doingAll = () => ({ ...(d.config.get('backlogDoing') || {}) });
  const hiddenAll = () => ({ ...(d.config.get('backlogHidden') || {}) });

  /** This project's links, without ones whose conversation is gone or that are a month old. */
  function linksFor(key) {
    const all = doingAll();
    const mine = all[key] || {};
    const kept = {};
    for (const [id, link] of Object.entries(mine)) {
      if (copyAlive(link.tabId) && Date.now() - (link.at || 0) < DOING_TTL_MS) kept[id] = link;
    }
    if (Object.keys(kept).length !== Object.keys(mine).length) saveLinks(key, kept);
    return kept;
  }

  // Something is only being worked on while its copy is: thrown away, brought home
  // and finished, or deleted, and the row goes back to Do this.
  function copyAlive(tabId) {
    const tab = d.manager?.tabs.get(tabId);
    if (tab) return !!tab.worktree;
    const w = d.history?.get(tabId)?.worktree;
    return !!w?.path && fs.existsSync(w.path);
  }

  function saveLinks(key, links) {
    const all = doingAll();
    const entries = Object.entries(links).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, MAX_LINKS);
    if (entries.length) all[key] = Object.fromEntries(entries); else delete all[key];
    d.config.set({ backlogDoing: all });
  }

  /** The link for a conversation, wherever it is. -> { key, id, link } | null */
  function linkOfTab(tabId) {
    for (const [key, links] of Object.entries(doingAll())) {
      for (const [id, link] of Object.entries(links || {})) if (link?.tabId === tabId) return { key, id, link };
    }
    return null;
  }

  /** Drop the link for an item, and any link that came from that task (an issue's row keyed by its gh: id). */
  function dropLink(key, id) {
    const links = { ...(doingAll()[key] || {}) };
    const gone = Object.keys(links).filter(k => k === id || links[k]?.taskId === id);
    if (!gone.length) return;
    for (const k of gone) delete links[k];
    saveLinks(key, links);
  }

  /** A task's id changed (renamed, or moved to another section): its link follows it. */
  function rekeyTask(key, oldId, newId) {
    if (!newId || oldId === newId) return;
    const links = { ...(doingAll()[key] || {}) };
    let changed = false;
    for (const [k, link] of Object.entries(links)) {
      if (link?.taskId !== oldId) continue;
      links[k === oldId ? newId : k] = { ...link, taskId: newId };
      if (k === oldId) delete links[k];
      changed = true;
    }
    if (changed) saveLinks(key, links);
  }

  // ---- the list

  /** An item as the panel sees it: no issue body (it's big, and only the prompt needs it). */
  function publicItem(it, links) {
    const link = links[it.id];
    const { body: _body, ...issue } = it.issue || {};
    return {
      id: it.id, kind: it.kind, tier: it.tier, title: it.title, reason: it.reason, reasons: it.reasons.slice(0, 4),
      ...(it.issue ? { issue } : {}),
      ...(it.ticket ? { ticket: (({ body: _body, ...t }) => t)(it.ticket) } : {}),
      ...(it.task ? { task: it.task } : {}),
      ...(it.note ? { note: it.note } : {}),
      ...(it.todo ? { todo: it.todo } : {}),
      ...(it.todos?.length ? { todos: it.todos } : {}),
      ...(it.error ? { error: it.error } : {}),
      ...(link ? { doing: { tabId: link.tabId, branch: link.branch, open: !!d.manager?.tabs.has(link.tabId), pr: link.pr || null } } : {}),
    };
  }

  /** The workflows "Hand it to …" can start: enabled, with an Issue trigger for any issue here. */
  function helpersFor(repo) {
    if (!repo || !d.workflows || d.config.get('crabOnly')) return [];
    return (d.workflows.workflows || [])
      .filter(wf => wf.enabled && (wf.when || []).some(t => t.type === 'issue' && t.on === 'any' && (!t.repo || lower(t.repo) === lower(repo))))
      .slice(0, 5).map(wf => ({ id: wf.id, name: wf.name }));
  }

  /** Everything for one project, ranked, with what was hidden taken out (raw: for the CLI and MCP). */
  async function build(p, { fresh = false, kick = false } = {}) {
    const tk = ticketsFor(p, { fresh, kick });
    const [read, ends, gh, se] = await Promise.all([
      p.root ? readTasks(p.root) : null,
      p.root ? d.looseEnds(p.root, { fresh }) : null,
      issuesFor(p.repo, fresh),
      d.sentryFor ? d.sentryFor(p, { fresh }).catch(() => ({ state: 'none' })) : { state: 'none' },
    ]);
    const parsed = read?.ok ? tasks.parse(read.text) : { items: [], done: 0, more: 0 };
    const projectKey = d.projects?.keyFor?.(p) || null;
    const ranked = rank({
      tasks: parsed.items,
      notes: !p.root && projectKey ? d.projects.todoOf(projectKey) : [],
      issues: gh.state === 'ok' ? gh.issues : null,
      complete: gh.complete !== false,
      milestones: gh.state === 'ok' ? gh.milestones : [],
      todos: ends?.ok ? ends.items : [],
      tickets: tk.state === 'ok' ? tk.tickets : [],
      errors: se.errors || [],
      repo: p.repo, login: login(), now: Date.now(),
    });
    const hidden = new Set(hiddenAll()[p.key] || []);
    const items = ranked.items.filter(it => !hidden.has(it.id));
    lists.set(p.key, { items, root: p.root, repo: p.repo, name: p.name });
    if (p.root && read?.ok) reads.set(lower(p.root), read.hash);
    return { read, ends, gh, se, tk, parsed, ranked, items, projectKey, hiddenCount: ranked.items.length - items.length };
  }

  /**
   * The Next up card for a project. -> { ok, items, milestone, milestones, github,
   * tasks, looseEnds, done, hidden, helpers, cloned, project, repo } | { ok: false, error }
   */
  async function view({ root, repo, fresh = false } = {}) {
    const p = await resolve({ root, repo });
    if (!p.ok) return p;
    const b = await build(p, { fresh, kick: true });
    const links = linksFor(p.key);
    const tasksFile = p.root
      ? (b.read.ok ? { exists: b.read.exists, ...(b.read.exists ? await tasksGit(p.root) : { ignored: false, uncommitted: false }) } : { error: b.read.error })
      : null;
    return {
      ok: true,
      project: p.name, repo: p.repo, cloned: !!p.root, key: b.projectKey,
      items: b.items.slice(0, MAX_LISTED).map(it => publicItem(it, links)),
      more: Math.max(0, b.items.length - MAX_LISTED),
      milestone: b.ranked.milestone,
      milestones: b.gh.state === 'ok' ? b.gh.milestones.slice(0, 10) : [],
      github: { state: b.gh.state, error: b.gh.error || null, stale: !!b.gh.stale },
      tracker: trackerView(p, b.tk),
      // none: not a Sentry project (nothing shows). offer, pick, ok, error: wiring/sentry.js forProject.
      sentry: { state: b.se.state, error: b.se.error || null, stale: !!b.se.stale, project: b.se.project || null, projects: b.se.projects || [], url: d.sentryUrl?.() || null },
      tasks: tasksFile,
      looseEnds: b.ends ? { error: b.ends.ok ? null : b.ends.error, more: b.ends.more || 0 } : null,
      done: b.parsed.done,
      hidden: b.hiddenCount,
      helpers: helpersFor(p.repo),
      canPr: !!p.repo && !!d.github?.can('claude'),
    };
  }

  // ---- editing tasks

  const OPS = new Set(['add', 'tick', 'rename', 'remove', 'move']);

  /**
   * One edit to tasks.md. add: { title, to? }. tick/remove: { id, line }.
   * rename: { id, line, title }. move: { id, line, to }. -> { ok } | { ok: false, error, stale? }
   */
  async function editTask({ root, op, id, line, title, to } = {}) {
    if (!OPS.has(op)) return { ok: false, error: 'That isn\'t something Shellby can do to a task.' };
    const p = await resolve({ root });
    if (!p.ok) return p;
    if (!p.root) return { ok: false, error: 'Clone it first: your tasks live in the repository.' };
    const cur = readTasks(p.root);
    if (!cur.ok) return cur;
    // Anything but adding works on what you were shown: changed since, and it's refused.
    const seen = reads.get(lower(p.root));
    if (op !== 'add' && seen && seen !== cur.hash) return { ok: false, stale: true, error: 'That list has changed since Shellby read it. Look again.' };
    const ref = { id, line };
    const r = op === 'add' ? tasks.add(cur.text, title, { to: to || 'next' })
      : op === 'tick' ? tasks.tick(cur.text, ref, today())
        : op === 'rename' ? tasks.rename(cur.text, ref, title)
          : op === 'remove' ? tasks.remove(cur.text, ref)
            : tasks.move(cur.text, ref, to);
    if (!r.ok) return r;
    const w = writeTasks(p.root, r.text, { expect: cur.hash, bom: cur.bom });
    if (!w.ok) return w;
    if (op === 'tick' || op === 'remove') dropLink(p.key, id);
    if (op === 'rename' || op === 'move') rekeyTask(p.key, id, movedId(r.text, op, { line, to }));
    return { ok: true };
  }

  /** Where an edited task is now: renamed in place, or the last item of the section it moved to. */
  function movedId(text, op, { line, to }) {
    const items = tasks.parse(text).items;
    if (op === 'rename') return items.find(i => i.line === line)?.id || null;
    return items.filter(i => i.section === to).pop()?.id || null;
  }

  const today = () => {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  };

  /** "Add to my tasks" on an issue: `- [ ] #42` (or `- [ ] ENG-123`) in ## Next, so you can put it where you want it. */
  async function addIssueTask({ root, id } = {}) {
    const p = await resolve({ root });
    if (!p.ok) return p;
    const item = lists.get(p.key)?.items.find(i => i.id === id && (i.kind === 'issue' || i.kind === 'ticket'));
    if (!item) return { ok: false, stale: true, error: 'That one isn\'t in the list any more. Look again.' };
    if (item.task) return { ok: false, error: 'It\'s on your list already.' };
    return editTask({ root: p.root, op: 'add', title: item.ticket ? item.ticket.key : `#${item.issue.number}` });
  }

  // ---- Do this

  /** A short branch slug from some words: "panel flickers on" -> "panel-flickers-on". */
  const slugOf = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).slice(0, 4).join('-') || 'task';

  /**
   * "Do this": a copy on its own branch, a conversation in it, the prompt in its
   * box. -> { ok, tabId, warn? } | { ok: false, error, needsClaude?, needsClone?, stale? }
   */
  const starting = new Set(); // `${key}\n${id}` while its copy is being made: a second click waits its turn

  async function doThis({ root, repo, id } = {}) {
    if (!claudeReady()) return { ok: false, needsClaude: true, error: 'That needs Claude Code: set it up first.' };
    const p = await resolve({ root, repo });
    if (!p.ok) return p;
    const flight = `${p.key}\n${id}`;
    if (starting.has(flight)) return { ok: false, busy: true, error: 'Already making a copy for that one.' };
    starting.add(flight);
    try {
      return await startItem(p, id);
    } finally {
      starting.delete(flight);
    }
  }

  async function startItem(p, id) {
    const item = lists.get(p.key)?.items.find(i => i.id === id);
    if (!item) return { ok: false, stale: true, error: 'That one isn\'t in the list any more. Look again.' };
    const link = linksFor(p.key)[id];
    if (link) return { ok: false, doing: true, tabId: link.tabId, error: 'There\'s a conversation on that already.' };

    let res;
    let warn = null;
    if (item.kind === 'issue') {
      if (!p.root) return { ok: false, needsClone: true, repo: p.repo, error: 'Clone it first, so Claude has somewhere to work.' };
      const issue = item.issue;
      // The Issue helper's "Make a copy" step: from the default branch as GitHub has it (github/pullrequest.js).
      const copy = await d.makeIssueCopy({ repo: p.repo, slug: `issue-${issue.number}` });
      if (!copy.ok) return { ok: false, error: copy.error };
      const prompt = w => prompts.issuePrompt({ issue, todos: item.todos || [], login: login(), notes: item.task?.notes || [], copy: { branch: w.branch, base: copy.base } });
      res = await d.startTaskInCopy(copy.worktree.root, `#${issue.number} ${issue.title}`.slice(0, 80), prompt, { copy: copy.worktree, draft: true });
      if (!res.ok) await worktrees.remove(copy.worktree, { force: true }).catch(() => {});
      if (issue.author && lower(issue.author) !== lower(login())) warn = `Written by @${issue.author}, not you: read it before sending.`;
    } else if (item.kind === 'ticket') {
      if (!p.root) return { ok: false, needsClone: true, repo: p.repo, error: 'Clone it first, so Claude has somewhere to work.' };
      const t = item.ticket;
      const notes = item.task?.notes || [];
      // The key in the branch's name: Linear and Jira link a branch (and its pull request) by it.
      const slug = `${t.key.toLowerCase()}-${slugOf(t.title).split('-').slice(0, 3).join('-')}`;
      if (p.repo) {
        // On GitHub, from the default branch as GitHub has it, like an issue.
        const copy = await d.makeIssueCopy({ repo: p.repo, slug });
        if (!copy.ok) return { ok: false, error: copy.error };
        res = await d.startTaskInCopy(copy.worktree.root, `${t.key} ${t.title}`.slice(0, 80), w => prompts.ticketPrompt({ ticket: t, notes, copy: { branch: w.branch, base: copy.base, fromGitHub: true } }), { copy: copy.worktree, draft: true });
        if (!res.ok) await worktrees.remove(copy.worktree, { force: true }).catch(() => {});
      } else {
        res = await d.startTaskInCopy(p.root, slug, w => prompts.ticketPrompt({ ticket: t, notes, copy: { branch: w.branch, base: w.base } }), { draft: true });
      }
    } else if (item.kind === 'task') {
      if (!p.root) return { ok: false, needsClone: true, repo: p.repo, error: 'Clone it first, so Claude has somewhere to work.' };
      const task = { title: item.title, notes: item.task.notes || [] };
      res = await d.startTaskInCopy(p.root, slugOf(item.title), w => prompts.taskPrompt({ project: p.name, task, copy: { branch: w.branch, base: w.base } }), { draft: true });
    } else if (item.kind === 'error') {
      if (!p.root) return { ok: false, needsClone: true, repo: p.repo, error: 'Clone it first, so Claude has somewhere to work.' };
      const error = item.error;
      const more = await d.sentryDetails(p, error);
      const slug = `sentry-${slugOf(error.shortId)}`;
      const title = `${error.shortId} ${error.title}`.slice(0, 80);
      // Production runs what GitHub has: start there when it's on GitHub, else from your HEAD.
      const copy = p.repo && d.github?.signedIn ? await d.makeIssueCopy({ repo: p.repo, slug }) : null;
      const prompt = (w, base, fromGitHub) => prompts.errorPrompt({ project: p.name, error, ...more, copy: { branch: w.branch, base, fromGitHub } });
      if (copy?.ok) {
        res = await d.startTaskInCopy(copy.worktree.root, title, w => prompt(w, copy.base, true), { copy: copy.worktree, draft: true });
        if (!res.ok) await worktrees.remove(copy.worktree, { force: true }).catch(() => {});
      } else {
        res = await d.startTaskInCopy(p.root, title, w => prompt(w, w.base, false), { draft: true });
      }
      warn = 'Error messages can carry what your users sent: read it before sending.';
    } else {
      const t = item.todo;
      const r = d.looseEndDraft({ root: p.root, file: t.file, line: t.line });
      if (!r.ok) return r;
      res = await d.startTaskInCopy(p.root, `todo-${slugOf(path.basename(t.file).replace(/\.[^.]+$/, ''))}`, w => prompts.todoPrompt({ draft: r.draft, copy: { branch: w.branch, base: w.base } }), { draft: true });
    }
    if (!res.ok) return res;

    const tab = d.manager.tabs.get(res.tabId);
    saveLinks(p.key, {
      ...linksFor(p.key),
      [id]: {
        tabId: res.tabId, branch: res.worktree?.branch || '', at: Date.now(), kind: item.kind,
        title: item.title.slice(0, 200), root: p.root, repo: p.repo,
        start: tab?.unsentCopy?.head || null,
        ...(item.issue ? { issue: item.issue.number } : {}),
        ...(item.ticket ? { ticket: { key: item.ticket.key, url: item.ticket.url, tracker: item.ticket.tracker } } : {}),
        ...(item.error ? { fixes: item.error.shortId } : {}),
        ...(item.task ? { taskId: item.task.id } : {}),
      },
    });
    return { ok: true, tabId: res.tabId, warn };
  }

  /** "Open conversation": the tab if it's open, else back from History. */
  function openDoing({ root, repo, id } = {}) {
    return resolve({ root, repo }).then(p => {
      if (!p.ok) return p;
      const link = linksFor(p.key)[id];
      if (!link) return { ok: false, stale: true, error: 'That conversation has gone. Look again.' };
      return { ok: true, tabId: link.tabId, open: !!d.manager.tabs.has(link.tabId) };
    });
  }

  /** "Open file" on a loose end: its project's window at the line. */
  async function openTodo({ root, id } = {}) {
    const p = await resolve({ root });
    if (!p.ok || !p.root) return p.ok ? { ok: false, error: 'Clone it first.' } : p;
    const t = lists.get(p.key)?.items.find(i => i.id === id && i.kind === 'todo')?.todo;
    if (!t) return { ok: false, stale: true, error: 'That one isn\'t in the list any more. Look again.' };
    const full = path.resolve(p.root, ...t.file.split('/'));
    try {
      if (!inside(fs.realpathSync.native(full), fs.realpathSync.native(p.root)) || fs.lstatSync(full).isSymbolicLink()) return { ok: false, error: 'That file isn\'t in the project.' };
    } catch {
      return { ok: false, error: 'That file isn\'t there any more.' };
    }
    return editor.openFileAt(p.root, full, t.line);
  }

  /** "Open on GitHub" for an issue the list showed. */
  async function openIssue({ root, repo, id } = {}) {
    const p = await resolve({ root, repo });
    if (!p.ok) return p;
    const issue = lists.get(p.key)?.items.find(i => i.id === id && i.issue)?.issue;
    if (!issue) return { ok: false, stale: true, error: 'That one isn\'t in the list any more. Look again.' };
    d.openGitHubUrl(issue.url);
    return { ok: true };
  }

  // ---- hiding

  async function hide({ root, repo, id, show = false } = {}) {
    const p = await resolve({ root, repo });
    if (!p.ok) return p;
    const all = hiddenAll();
    const list = all[p.key] || [];
    if (show) delete all[p.key];
    else {
      if (typeof id !== 'string' || !lists.get(p.key)?.items.some(i => i.id === id)) return { ok: false, stale: true, error: 'That one isn\'t in the list any more. Look again.' };
      all[p.key] = [id, ...list.filter(x => x !== id)].slice(0, MAX_HIDDEN);
    }
    d.config.set({ backlogHidden: all });
    return { ok: true };
  }

  // ---- Sentry (wiring/sentry.js): connecting, and which Sentry project this is

  /** op: connect { token, url } | link { org, slug } (slug null: not a Sentry project) | unlink | snooze | disconnect. */
  async function sentryOp({ root, op, token, url, org, slug } = {}) {
    if (!d.sentryConnect) return { ok: false, error: 'Sentry isn\'t ready yet.' };
    if (op === 'disconnect') return d.sentryDisconnect();
    if (op === 'connect') return d.sentryConnect({ token, url });
    const p = await resolve({ root });
    if (!p.ok) return p;
    if (op === 'link') return d.sentryLink(p, { org, slug });
    if (op === 'unlink') return d.sentryUnlink(p);
    if (op === 'snooze') return d.sentrySnooze(p);
    return { ok: false, error: 'That isn\'t something Shellby can do with Sentry.' };
  }

  // ---- the finish line (Phase 2)

  /** What a conversation's copy menu offers, if the conversation came from Next up. */
  function tabInfo(tabId) {
    const found = typeof tabId === 'string' ? linkOfTab(tabId) : null;
    if (!found || !d.manager.tabs.get(tabId)?.worktree) return { linked: false };
    const { link } = found;
    return {
      linked: true, kind: link.kind, title: link.title, issue: link.issue || null, ticket: link.ticket?.key || null, pr: link.pr || null,
      canPr: !!link.repo && !!d.github?.can('claude') && !link.pr,
      needsPush: !!link.repo && !d.github?.can('claude'),
    };
  }

  /** "Open a draft pull request" from a Next up conversation's copy (github/pullrequest.js, through openIssuePr). */
  async function openPr(tabId) {
    const found = typeof tabId === 'string' ? linkOfTab(tabId) : null;
    const tab = d.manager.tabs.get(tabId);
    if (!found || !tab?.worktree) return { ok: false, error: 'That conversation didn\'t come from Next up.' };
    const { key, id, link } = found;
    if (link.pr) return { ok: false, error: `There's a pull request for it already: ${link.pr.url}` };
    if (!link.repo) return { ok: false, error: 'That project isn\'t on GitHub.' };
    if (d.manager.isBusy(tabId)) return { ok: false, error: 'Let him finish first.' };
    const w = tab.worktree;
    const range = /^[0-9a-f]{40}$/.test(link.start || '') ? `${link.start}..HEAD` : `${w.base}..HEAD`;
    const log = await worktrees.git(w.path, ['log', '--format=%s', '-n', '20', range], { timeout: 10000 });
    const commits = log.ok ? log.out.split('\n').map(s => s.trim()).filter(Boolean) : [];
    // Linear and Jira link a pull request by the key in its title.
    const title = link.ticket ? `${link.ticket.key}: ${link.title}`.slice(0, 200) : link.title;
    const body = prompts.prBody({ issue: link.issue ? { number: link.issue } : null, ticket: link.ticket || null, title: link.issue ? '' : title, commits, fixes: link.fixes || '' });
    const r = await d.openIssuePr({ folder: w.path, title, body, draft: true });
    if (!r.ok) return r;
    const links = { ...(doingAll()[key] || {}) };
    if (links[id]) saveLinks(key, { ...links, [id]: { ...links[id], pr: { url: r.url, number: r.number, repo: r.repo } } });
    return r;
  }

  /** A task's work came home or merged: offer to tick it off, in the panel. */
  function offerTick(key, id, link, why) {
    if (!link.taskId || !link.root) return;
    d.send(d.panel, 'backlog:offer-tick', { tabId: link.tabId, title: link.title, why });
  }

  /** Brought home (ipc/repo.js): a task's copy merged into your checkout. */
  function onHome(tabId) {
    const found = linkOfTab(tabId);
    if (found) offerTick(found.key, found.id, found.link, 'home');
  }

  /** A pull request merged (github/ci.js): one opened from Next up offers its task's tick, and its link is done. */
  function onMerged(pr) {
    for (const [key, links] of Object.entries(doingAll())) {
      for (const [id, link] of Object.entries(links || {})) {
        if (!link?.pr || link.pr.number !== pr?.number || lower(link.pr.repo) !== lower(pr?.repo)) continue;
        offerTick(key, id, link, 'merged');
        if (!link.taskId) dropLink(key, id);
      }
    }
  }

  /** "Tick it off" from that offer: the task by its id, wherever it is in the file now. */
  async function tickLinked(tabId) {
    const found = typeof tabId === 'string' ? linkOfTab(tabId) : null;
    if (!found?.link.taskId || !found.link.root) return { ok: false, error: 'That task isn\'t linked to this conversation any more.' };
    const root = d.projects?.knowsRoot(found.link.root) || found.link.root;
    if (!fs.existsSync(root)) return { ok: false, error: 'That project has moved.' };
    const cur = readTasks(root);
    if (!cur.ok) return cur;
    const task = tasks.parse(cur.text).items.find(i => i.id === found.link.taskId);
    if (!task) { dropLink(found.key, found.id); return { ok: false, error: 'That task isn\'t on the list any more.' }; }
    const r = tasks.tick(cur.text, { id: task.id, line: task.line }, today());
    if (!r.ok) return r;
    const w = writeTasks(root, r.text, { expect: cur.hash, bom: cur.bom });
    if (w.ok) dropLink(found.key, found.id);
    return w.ok ? { ok: true, title: task.title } : w;
  }

  /** A Next up conversation was closed and its empty copy went with it (ipc/tabs.js): nothing's being done. */
  function onTabGone(tabId) {
    const found = linkOfTab(tabId);
    if (found) dropLink(found.key, found.id);
  }

  /** "Commit tasks.md": only that file, never pushed. */
  async function commitTasks({ root } = {}) {
    const p = await resolve({ root });
    if (!p.ok) return p;
    if (!p.root) return { ok: false, error: 'Clone it first.' };
    const rel = TASKS_PARTS.join('/');
    const read = readTasks(p.root);
    if (!read.ok) return read;
    if (!read.exists) return { ok: false, error: 'There\'s no .shellby/tasks.md to commit yet.' };
    if (!(await tasksGit(p.root)).uncommitted) return { ok: false, error: 'Nothing new in it to commit.' };
    // Added first, so a new file can be committed; --only leaves everything else you've staged where it is.
    const add = await worktrees.git(p.root, ['add', '--', rel], { timeout: 15000 });
    if (!add.ok) return { ok: false, error: `git wouldn't add it: ${firstLine(add.error)}` };
    const r = await worktrees.git(p.root, ['commit', '--only', '-m', 'chore: update tasks', '--', rel], { timeout: 60000 });
    // A hook that refused says why on stderr; git's own refusals go to stdout.
    if (!r.ok) return { ok: false, error: `git wouldn't commit it: ${firstLine(r.error.startsWith('Command failed') ? r.out : r.error) || 'it gave no reason.'}` };
    return { ok: true };
  }

  // ---- Hand it to the Issue helper (Phase 3)

  /** Start one workflow with an Issue trigger for this issue, without it asking again (event: picked). */
  async function handToWorkflow({ root, repo, id, workflowId } = {}) {
    if (d.config.get('crabOnly') || !d.workflows) return { ok: false, error: 'Workflows are off: Shellby is in just-the-crab mode.' };
    const p = await resolve({ root, repo });
    if (!p.ok) return p;
    const issue = lists.get(p.key)?.items.find(i => i.id === id && i.kind === 'issue')?.issue;
    if (!issue) return { ok: false, stale: true, error: 'That one isn\'t in the list any more. Look again.' };
    if (!helpersFor(p.repo).some(h => h.id === workflowId)) return { ok: false, error: 'That workflow can\'t take this issue (it needs an enabled Issue trigger for any issue here).' };
    const wf = d.workflows.workflows.find(w => w.id === workflowId);
    // It works by itself in Auto-edit and pushes a draft: someone else's words get a question first.
    if (issue.author && lower(issue.author) !== lower(login())) {
      const yes = await askUser({
        icon: '🦀', danger: true,
        title: `Hand #${issue.number} to ${wf.name}?`.slice(0, 120),
        message: issue.title.slice(0, 200),
        detail: `@${issue.author} wrote this issue, not you. ${wf.name} works on it by itself, with the issue's words as its brief, and pushes a draft pull request, without you reading the prompt first.`,
        note: 'Do this instead puts the prompt in a conversation for you to read before anything happens.',
        buttons: [{ label: `Hand it to ${wf.name}`.slice(0, 60), style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
      if (yes !== 0) return { ok: false, cancelled: true };
    }
    const r = d.workflows.trigger(wf, {
      type: 'issue',
      data: { event: 'picked', reasons: ['picked'], repo: issue.repo, number: issue.number, title: issue.title, body: issue.body, labels: issue.labels, author: issue.author, url: issue.url },
    });
    if (!r.ok && !r.queued) return { ok: false, error: r.error || 'It didn\'t start.' };
    return { ok: true, queued: !!r.queued, name: wf.name };
  }

  // ---- the projects service's to-do list (projects/service.js)
  //
  // add_task, finish_task, `shellby next add|done` and the page all keep a
  // project's to-dos. Where it's cloned here, that list is its tasks.md: one
  // list, in the repository, the same one Next up ranks. Numbers count the open
  // tasks in file order and ids look like projects/todo.js's (t-xxxxxxxx), so
  // finish_task means the same whichever list is behind it.

  const todoId = taskId => `t-${taskId.slice(2, 10)}`;
  const asTodo = t => ({ id: todoId(t.id), text: t.title, from: t.from || 'you', at: 0 });
  const rootKeyOf = root => keyOf({ root });

  /** The open tasks, as to-dos: [{ id, text, from, at }] (none when tasks.md can't be read). */
  function repoTodos(root) {
    const r = readTasks(root);
    return r.ok ? tasks.parse(r.text).items.map(asTodo) : [];
  }

  /** A to-do onto ## Next. -> { ok, item, count, existed } | { ok: false, error } */
  function repoTodoAdd(root, text, from = 'you') {
    const cur = readTasks(root);
    if (!cur.ok) return cur;
    const before = tasks.parse(cur.text).items;
    const want = tasks.clean(text, tasks.MAX_TITLE).toLowerCase();
    // The same note twice is the same to-do (a retried call, a double press), as projects/todo.js has it.
    const same = want && before.find(t => t.title.toLowerCase() === want);
    if (same) return { ok: true, item: asTodo(same), existed: true, count: before.length };
    const r = tasks.add(cur.text, text, { from });
    if (!r.ok) return r;
    const w = writeTasks(root, r.text, { expect: cur.hash, bom: cur.bom });
    if (!w.ok) return w;
    const after = tasks.parse(r.text).items;
    const added = after.filter(t => t.section === 'next').pop() || after[after.length - 1];
    return { ok: true, item: asTodo(added), existed: false, count: after.length };
  }

  /** Tick one off. ref: its number (1 = first open task) or its id. -> { ok, item, left } | { ok: false, error } */
  function repoTodoFinish(root, ref) {
    const cur = readTasks(root);
    if (!cur.ok) return cur;
    const list = tasks.parse(cur.text).items;
    if (!list.length) return { ok: false, error: 'That project has nothing on its to-do list.' };
    const n = typeof ref === 'number' ? ref : /^[0-9]{1,3}$/.test(String(ref ?? '')) ? Number(ref) : NaN;
    const t = Number.isInteger(n) ? list[n - 1] : list.find(x => todoId(x.id) === ref);
    if (!t) return { ok: false, error: `There's no to-do ${Number.isInteger(n) ? `number ${n}` : 'with that id'}. The list has ${list.length}.` };
    const r = tasks.tick(cur.text, { id: t.id, line: t.line }, today());
    if (!r.ok) return r;
    const w = writeTasks(root, r.text, { expect: cur.hash, bom: cur.bom });
    if (!w.ok) return w;
    dropLink(rootKeyOf(root), t.id);
    return { ok: true, item: asTodo(t), left: list.length - 1 };
  }

  /**
   * What next_up adds to its own answer (projects/terminal.js): the issues and
   * loose ends Next up ranks, which the to-dos above don't cover.
   * -> [{ kind: 'issue' | 'todo', text, reason }]
   */
  async function forTerminal({ root = null, repo = null } = {}, { max = MAX_TEXT_ITEMS } = {}) {
    const p = root ? { root, repo, name: '' } : repo ? { root: null, repo, name: '' } : null;
    if (!p) return [];
    const b = await build({ ...p, key: keyOf(p) }, {}).catch(() => null);
    return (b?.items || []).filter(it => it.kind === 'issue' || it.kind === 'ticket' || it.kind === 'todo').slice(0, max).map(it => ({
      kind: it.kind === 'ticket' ? 'issue' : it.kind,
      text: it.kind === 'issue' ? `#${it.issue.number} ${it.title}` : it.kind === 'ticket' ? `${it.ticket.key} ${it.title}` : `${it.todo.tag} in ${it.todo.file}:${it.todo.line}: ${it.title}`,
      reason: it.reason,
    }));
  }

  return {
    backlogView: view, backlogEdit: editTask, backlogAddIssue: addIssueTask, backlogDo: doThis,
    backlogOpenDoing: openDoing, backlogOpenTodo: openTodo, backlogOpenIssue: openIssue, backlogHide: hide,
    backlogTabInfo: tabInfo, backlogOpenPr: openPr, backlogTick: tickLinked, backlogCommit: commitTasks,
    backlogHand: handToWorkflow, backlogHome: onHome, backlogMerged: onMerged, backlogTabClosed: onTabGone,
    backlogSentry: sentryOp,
    backlogRepoTasks: { list: repoTodos, add: repoTodoAdd, finish: repoTodoFinish }, backlogForTerminal: forTerminal,
    backlogTrackerChoices: trackerChoices, backlogTrackerSet: trackerSet,
  };
}

module.exports = { wireBacklog };
