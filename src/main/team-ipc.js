// Toolbox → Team: the repo's team pack (teampack.js), joined to the panel and
// to the parts of Shellby it hands things to. Kept out of main.js, which is
// long enough.
//
// Nothing here lets the panel choose what's added or where it's written: it
// names an item of the pack main has just read (by index or name), or one of
// your own things by name, and main looks it up. Adding a workflow, a hook or
// an allow rule goes through the confirm windows those already have; turning
// on the team's snippets is one click, since they're only prompts you send
// yourself, and the Team tab lists every word of them first.
//
// "Set it all up" (a new hire's first visit, or after the pack changed) takes
// everything waiting in one go: one confirm window, shown here in main, that
// lists every part in full (teampack.setupDetail), and nothing is written
// unless the file is still the one that window described. MCP servers need
// each person's own values: the panel sends what was typed, and it goes
// straight into `claude mcp add` (never into the pack, the config or the log).
const fs = require('fs');
const path = require('path');
const tp = require('./teampack');
const claudeSetup = require('./claude-setup');
const mcpAdmin = require('./mcpadmin');
const mcpServers = require('./mcpservers');

const NOTICE_DELAY_MS = 6000;
const HOOK_SCOPES = ['local', 'user'];
const RULE_SCOPES = ['local', 'user'];
const MAX_PICKS = 200;
const MCP_TIMEOUT_MS = 60000;
const MAX_LISTED = 30; // names per kind in "already shared by the repo"
const MAX_MCP_JSON = 256 * 1024;

const isStr = s => typeof s === 'string' && s.length > 0 && s.length < 400;
const keyOf = root => path.resolve(root).toLowerCase();

// A pack that's a link (or sits in a linked .shellby) is never followed: a repo
// could point it at another file on this PC, or at a share on someone's server,
// which Windows would try to sign in to. lstat only, so even looking is safe.
const isLink = p => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
function exists(p) {
  try {
    if (path.basename(p) === tp.FILE && isLink(path.dirname(p))) return true; // refused when read
    fs.lstatSync(p);
    return true;
  } catch { return false; }
}
const linked = file => isLink(path.dirname(file)) || isLink(file);

// Names in a folder of the repo, never through a link. (kind: 'file' ending in
// ext, or 'dir' holding `inside`.)
function namesIn(dir, { ext = null, inside = null } = {}) {
  if (isLink(dir)) return [];
  let list;
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return list
    .filter(e => (ext ? e.isFile() && e.name.toLowerCase().endsWith(ext) : e.isDirectory() && exists(path.join(dir, e.name, inside))))
    .map(e => (ext ? e.name.slice(0, -ext.length) : e.name))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_LISTED);
}

/**
 * What the repo already shares through Claude Code itself, with no team pack:
 * its CLAUDE.md, and the agents, skills, commands and .mcp.json servers
 * committed in it. Claude Code loads (and asks about) those on its own; the
 * Team tab only lists them, so a new hire sees the whole setup in one place.
 */
function repoShares(root) {
  const claude = path.join(root, '.claude');
  const json = (() => {
    const f = path.join(root, '.mcp.json');
    try {
      const st = fs.lstatSync(f);
      if (!st.isFile() || st.size > MAX_MCP_JSON) return null;
      return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
    } catch { return null; }
  })();
  const inClaude = !isLink(claude);
  const mcp = json?.mcpServers && typeof json.mcpServers === 'object' ? Object.keys(json.mcpServers).filter(n => mcpServers.NAME.test(n)).slice(0, MAX_LISTED) : [];
  const memory = ['CLAUDE.md', ...(inClaude ? [path.join('.claude', 'CLAUDE.md')] : [])].filter(f => exists(path.join(root, f)) && !isLink(path.join(root, f)));
  const out = {
    memory: memory.map(f => f.replace(/\\/g, '/')),
    agents: inClaude ? namesIn(path.join(claude, 'agents'), { ext: '.md' }) : [],
    skills: inClaude ? namesIn(path.join(claude, 'skills'), { inside: 'SKILL.md' }) : [],
    commands: inClaude ? namesIn(path.join(claude, 'commands'), { ext: '.md' }) : [],
    mcp,
  };
  return Object.values(out).some(l => l.length) ? out : null;
}

/**
 * deps: { ipcMain, config, shell, home, panel(), send(win, channel, payload),
 *   currentCwd(), ownSnippets(), pushSnippets(), workflows() -> WorkflowService | null,
 *   setupView(), setupWhere() -> { home, cwd }, saveHook({ scope, hook }), saveRule({ scope, list, rule }),
 *   confirm(spec) -> button index (the isolated confirm window),
 *   runClaude(args, timeout, { cwd }) -> { ok, stdout, stderr, notInstalled },
 *   now(), stat(event), log }
 */
function register(deps) {
  const { ipcMain, config } = deps;
  const cache = new Map(); // file -> { mtimeMs, size, read }

  // ---- reading

  /** The pack for a folder: { root, file, hasPack, read: parse() result | null, fileHash }. Cached on size and time. */
  function packAt(cwd) {
    const where = tp.locate(cwd, { home: deps.home, exists });
    if (!where) return null;
    if (!where.hasPack) return { ...where, read: null };
    if (linked(where.file)) return { ...where, read: { ok: false, error: `${tp.DIR}/${tp.FILE} is a link to somewhere else, so Shellby won't read it. A team pack has to be a file in the repo.` } };
    let st;
    try { st = fs.lstatSync(where.file); } catch { return { ...where, hasPack: false, read: null }; }
    const hit = cache.get(where.file);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return { ...where, ...hit.out };
    let out;
    if (!st.isFile() || st.size > tp.MAX_BYTES) out = { read: { ok: false, error: st.isFile() ? `The team pack is too big (over ${tp.MAX_BYTES / 1024} KB).` : "The team pack isn't a file." } };
    else {
      try {
        const text = fs.readFileSync(where.file, 'utf8');
        out = { read: tp.parse(text), fileHash: tp.hashOf(text) };
      } catch (e) { out = { read: { ok: false, error: `Couldn't read the team pack: ${e.code || e.message}` } }; }
    }
    cache.set(where.file, { mtimeMs: st.mtimeMs, size: st.size, out });
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    return { ...where, ...out };
  }

  const trustOf = root => (config.get('teamPacks') || {})[keyOf(root)] || {};
  function setTrust(root, patch) {
    const all = { ...(config.get('teamPacks') || {}) };
    const next = { ...all[keyOf(root)], ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    all[keyOf(root)] = next;
    config.set({ teamPacks: all });
  }

  /** The team's snippets that are on, for a folder (yours are `own`). */
  function snippetsFor(cwd, own) {
    const p = packAt(cwd);
    if (!p?.read?.ok) return [];
    return tp.liveSnippets(p.read.pack, own, trustOf(p.root).snippets || null);
  }

  // ---- comparing with what you have

  // As Shellby would save it, then made portable: a pack workflow and your copy
  // of it compare equal only if adding it again would change nothing.
  function savedForm(service, wf, root) {
    const v = service.validate(tp.localize(wf, root));
    return v.ok ? { ok: true, workflow: v.workflow, hash: tp.hashOf(tp.portable(v.workflow, root).workflow) } : { ok: false, errors: v.errors };
  }

  function view() {
    const cwd = deps.currentCwd();
    const p = packAt(cwd);
    if (!p) return { where: null };
    const base = { where: { root: p.root, file: p.file, name: path.basename(p.root) }, hasPack: p.hasPack };
    if (!p.hasPack) return base;
    if (!p.read.ok) return { ...base, error: p.read.error };
    const { pack } = p.read;
    const service = deps.workflows();
    const forms = new Map();
    const installed = [];
    if (service) {
      for (const w of pack.workflows) {
        const form = savedForm(service, w, p.root);
        forms.set(w.name, form);
        const mine = service.byName(w.name);
        if (mine) installed.push({ name: mine.name, same: form.ok && tp.hashOf(tp.portable(mine, p.root).workflow) === form.hash });
      }
    }
    const setup = deps.setupView();
    const status = tp.status(pack, {
      snippets: deps.ownSnippets(), trusted: trustOf(p.root).snippets || null,
      workflows: installed,
      hooks: setup.hooks.filter(h => ['user', 'project', 'local'].includes(h.source)),
      rules: setup.permissions.rules,
      mcp: pack.mcpServers.length ? mcpHere() : [],
    });
    status.workflows = status.workflows.map(w => {
      const form = forms.get(w.name);
      if (!service) return { ...w, state: 'off', error: 'Workflows are off: Shellby is in just-the-crab mode.' };
      return form && !form.ok ? { ...w, state: 'broken', error: form.errors.slice(0, 2).map(e => e.message).join(' ') } : w;
    });
    const trust = trustOf(p.root);
    return {
      ...base, problems: p.read.problems, ...status,
      // The welcome card: what "Set it all up" would take, when you said yes
      // last, and whether the team has changed the pack since.
      plan: tp.setupPlan(status),
      accepted: Number.isFinite(trust.accepted?.at) ? trust.accepted.at : null,
      changed: tp.changedSince(trust.accepted, p.fileHash, status.waiting),
      shared: repoShares(p.root),
    };
  }

  // The MCP servers Claude Code has for the folder you're working in (yours, its
  // .mcp.json, just-you-here): the same folder whose settings hooks and rules go
  // in, so "added" means the same thing for all three.
  const workDir = () => deps.setupWhere().cwd;
  function mcpHere() {
    try { return mcpServers.listServers({ home: deps.setupWhere().home, cwd: workDir() }); } catch { return []; }
  }

  // The pack as it is now, for an action: refuses if it's gone or broken.
  function current() {
    const p = packAt(deps.currentCwd());
    if (!p?.hasPack) return { error: "This folder's repo has no team pack any more." };
    if (!p.read.ok) return { error: p.read.error };
    return { p, pack: p.read.pack };
  }
  // You've taken everything in this version of the pack: remembered, so a
  // later change to the file can be told apart from what you said yes to.
  const now = () => (deps.now ? deps.now() : Date.now());
  function markAccepted() {
    const p = packAt(deps.currentCwd());
    if (p?.fileHash && p.read?.ok) setTrust(p.root, { accepted: { hash: p.fileHash, at: now() } });
  }
  function done(extra) {
    if (extra?.ok && view().waiting === 0) markAccepted();
    return { ...extra, view: view() };
  }

  // ---- noticing one

  /** First time Shellby sees this pack (or a change to it): say so, once. */
  function notice(cwd = deps.currentCwd()) {
    const p = packAt(cwd);
    if (!p?.read?.ok || !p.fileHash) return;
    if (trustOf(p.root).seen === p.fileHash) return;
    const first = !trustOf(p.root).seen;
    setTrust(p.root, { seen: p.fileHash });
    const v = view();
    if (!v.waiting) return;
    const panel = deps.panel();
    deps.send(panel, 'team:notice', {
      repo: path.basename(p.root), name: p.read.pack.name, first, contents: tp.contents(p.read.pack), waiting: v.waiting,
    });
  }
  setTimeout(() => { try { notice(); } catch (e) { deps.log.warn(`team pack notice: ${e.message}`); } }, NOTICE_DELAY_MS).unref?.();

  /** Shellby's folder changed: another repo, another pack (or none). */
  function folderChanged(dir) {
    const panel = deps.panel();
    deps.send(panel, 'team', view());
    notice(dir);
  }

  // ---- IPC

  ipcMain.handle('team:get', () => view());

  // The yes is for exactly the list the panel showed: if the file changed since, ask again.
  ipcMain.handle('team:use-snippets', (_e, hash) => {
    const c = current();
    if (c.error) return done({ ok: false, error: c.error });
    if (typeof hash !== 'string' || hash !== tp.hashOf(c.pack.snippets)) return done({ ok: false, error: 'The team pack changed while you were looking. Have another look.' });
    setTrust(c.p.root, { snippets: hash });
    deps.pushSnippets();
    deps.stat('team-snippets-on');
    return done({ ok: true });
  });

  ipcMain.handle('team:stop-snippets', () => {
    const p = packAt(deps.currentCwd());
    if (p) { setTrust(p.root, { snippets: undefined }); deps.pushSnippets(); }
    return done({ ok: true });
  });

  ipcMain.handle('team:add-workflow', async (_e, name) => {
    const c = current();
    if (c.error) return done({ ok: false, error: c.error });
    const service = deps.workflows();
    if (!service) return done({ ok: false, error: 'Workflows are off: Shellby is in just-the-crab mode.' });
    const wf = isStr(name) ? c.pack.workflows.find(w => w.name === name) : null;
    if (!wf) return done({ ok: false, error: "That workflow isn't in the team pack any more." });
    const form = savedForm(service, wf, c.p.root);
    if (!form.ok) return done({ ok: false, error: `It doesn't fit: ${form.errors.slice(0, 2).map(e => e.message).join(' ')}` });
    const mine = service.byName(wf.name);
    // An update keeps your copy's id, so its runs, approval and on/off stay with it.
    const input = mine ? { ...form.workflow, id: mine.id, createdAt: mine.createdAt, enabled: mine.enabled } : { ...form.workflow, id: undefined };
    const r = await service.save(input, { source: 'team' });
    if (r.ok) deps.stat('team-workflow-added');
    return done({ ok: !!r.ok, cancelled: !!r.declined, error: r.ok || r.declined ? null : (r.errors || []).map(e => e.message).join(' ') });
  });

  // By what it is, not where it was in the list: the file may have changed since the panel drew it.
  ipcMain.handle('team:add-hook', async (_e, { key, scope } = {}) => {
    const c = current();
    if (c.error) return done({ ok: false, error: c.error });
    const hook = typeof key === 'string' ? c.pack.hooks.find(h => tp.hookKey(h) === key) : null;
    if (!hook) return done({ ok: false, error: "That hook isn't in the team pack any more." });
    if (!HOOK_SCOPES.includes(scope)) return done({ ok: false, error: 'Pick where to add it.' });
    const { about: _a, ...plain } = hook;
    const r = await deps.saveHook({ scope, hook: plain });
    if (r.ok) deps.stat('team-hook-added');
    return done({ ok: !!r.ok, cancelled: !!r.cancelled, error: r.ok || r.cancelled ? null : r.error });
  });

  ipcMain.handle('team:add-rule', async (_e, { key, scope } = {}) => {
    const c = current();
    if (c.error) return done({ ok: false, error: c.error });
    const rule = typeof key === 'string' ? c.pack.rules.find(r => tp.ruleKey(r) === key) : null;
    if (!rule) return done({ ok: false, error: "That rule isn't in the team pack any more." });
    if (!RULE_SCOPES.includes(scope)) return done({ ok: false, error: 'Pick where to add it.' });
    const r = await deps.saveRule({ scope, list: rule.list, rule: rule.rule });
    if (r.ok) deps.stat('team-rule-added');
    return done({ ok: !!r.ok, cancelled: !!r.cancelled, error: r.ok || r.cancelled ? null : r.error });
  });

  // ---- MCP servers, and setting it all up at once

  // `claude mcp add` for a pack server with your values, just you, in the repo.
  async function addMcp(server, values) {
    const filled = tp.mcpInput(server, values);
    if (filled.error) return { ok: false, error: filled.error, missing: filled.missing };
    const built = mcpAdmin.addArgs(filled.input);
    if (built.error) return { ok: false, error: built.error };
    const r = await deps.runClaude(built.args, MCP_TIMEOUT_MS, { cwd: workDir() });
    if (r.notInstalled) return { ok: false, error: 'Claude Code needs to be installed first.' };
    // What Claude Code said, minus anything you typed in (as it was sent: trimmed).
    if (!r.ok) {
      const said = (r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' ');
      const secrets = [...Object.values(values?.env || {}), ...Object.values(values?.headers || {})]
        .map(v => (typeof v === 'string' ? v.trim() : '')).filter(Boolean).sort((a, b) => b.length - a.length);
      const clean = secrets.reduce((s, v) => s.split(v).join('…'), said);
      deps.log.warn(`team pack MCP ${server.name}: ${clean.slice(0, 300)}`);
      return { ok: false, error: `Claude Code didn't add "${server.name}"${clean ? `: ${clean.slice(0, 200)}` : '.'}` };
    }
    return { ok: true };
  }

  // Values typed in the panel: { env: { NAME: value }, headers: { Name: value } } per server.
  const valuesFor = (all, name) => {
    const v = all && typeof all === 'object' ? all[name] : null;
    return v && typeof v === 'object' ? { env: v.env, headers: v.headers } : {};
  };

  ipcMain.handle('team:add-mcp', async (_e, { name, values } = {}) => {
    const c = current();
    if (c.error) return done({ ok: false, error: c.error });
    const server = isStr(name) ? c.pack.mcpServers.find(s => s.name === name) : null;
    if (!server) return done({ ok: false, error: "That MCP server isn't in the team pack any more." });
    const filled = tp.mcpInput(server, valuesFor({ [name]: values }, name));
    if (filled.error) return done({ ok: false, error: filled.error, missing: filled.missing });
    const blanks = [...server.env, ...server.headers];
    const response = await deps.confirm({
      icon: '🔌', danger: server.transport === 'stdio',
      title: `Add the MCP server "${server.name}"?`,
      message: `From ${path.basename(c.p.root)}'s team pack. Claude Code will ${server.transport === 'stdio' ? 'start this program' : 'connect to this server'} by itself in every session, for just you in this project.`,
      detail: `${server.transport === 'stdio' ? server.command : server.url}${blanks.length ? `\n\nWith your own ${blanks.join(', ')} (not shown)` : ''}`,
      note: server.transport === 'stdio' ? "It runs with your Windows account's permissions. Only add servers you trust." : 'Only add servers you trust: Claude will see what they send back.',
      buttons: [{ label: 'Add it', style: server.transport === 'stdio' ? 'danger' : 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response !== 0) return done({ ok: false, cancelled: true });
    const r = await addMcp(server, valuesFor({ [name]: values }, name));
    if (r.ok) deps.stat('team-mcp-added');
    return done(r);
  });

  // Everything waiting, after one window that shows every part of it.
  ipcMain.handle('team:setup-all', async (_e, { values } = {}) => {
    const c = current();
    if (c.error) return done({ ok: false, error: c.error });
    const v = view();
    const plan = v.plan;
    if (!plan?.count) return done({ ok: true, added: 0 });
    // A server whose blanks are all empty is left for later; half-filled is a slip.
    const servers = c.pack.mcpServers.filter(s => plan.mcp.includes(s.name));
    const later = [];
    for (const s of servers) {
      const typed = valuesFor(values, s.name);
      const filled = tp.mcpInput(s, typed);
      if (!filled.error) continue;
      const blanks = [...s.env, ...s.headers];
      if (filled.missing?.length === blanks.length) later.push(s.name);
      else return done({ ok: false, error: filled.error, missing: filled.missing });
    }
    const go = { ...plan, mcp: plan.mcp.filter(n => !later.includes(n)) };
    // Workflows as Shellby would save them, and what each one's own window would say.
    const service = deps.workflows();
    const wfInputs = new Map();
    const workflowDetail = {};
    for (const name of go.workflows) {
      const wf = c.pack.workflows.find(w => w.name === name);
      const form = service && wf ? savedForm(service, wf, c.p.root) : null;
      if (!form?.ok) continue;
      const mine = service.byName(name);
      const input = mine ? { ...form.workflow, id: mine.id, createdAt: mine.createdAt, enabled: mine.enabled } : { ...form.workflow, id: undefined };
      const said = service.saveDetail(input, { source: 'team' });
      if (!said.ok) continue;
      wfInputs.set(name, input);
      workflowDetail[name] = said.detail;
    }
    go.workflows = go.workflows.filter(n => wfInputs.has(n));
    if (!go.snippets && !go.workflows.length && !go.hooks.length && !go.rules.length && !go.mcp.length) {
      return done({ ok: false, error: later.length ? `Fill in the values for ${later.join(', ')} first.` : 'Nothing here can be set up in one go. Add the parts one at a time below.' });
    }
    const words = tp.setupDetail(c.pack, go, { repo: path.basename(c.p.root), workflowDetail });
    if (words.error) return done({ ok: false, error: words.error });
    const response = await deps.confirm({
      icon: '🧰', danger: words.danger, title: words.title, message: words.message, detail: words.detail,
      note: `${later.length ? `Left for later, until you fill in their values: ${later.join(', ')}. ` : ''}Settings files get a backup beside them. Anything can be removed again from the Toolbox.`,
      buttons: [{ label: 'Set it all up', style: words.danger ? 'danger' : 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
    });
    if (response !== 0) return done({ ok: false, cancelled: true });
    // The yes was for that file: if it changed while the window was up, nothing happens.
    const again = current();
    if (again.error || again.p.fileHash !== c.p.fileHash) return done({ ok: false, error: 'The team pack changed while you were deciding, so nothing was added. Have another look.' });

    const failed = [];
    let added = 0;
    const tally = (r, what) => { if (r?.ok) added++; else failed.push(`${what}: ${r?.error || 'it didn\'t go in'}`); };
    if (go.snippets) { setTrust(c.p.root, { snippets: tp.hashOf(c.pack.snippets) }); deps.pushSnippets(); added++; }
    // Your own settings for this folder, never through a link: a repo could
    // commit .claude (or the file) as one pointing at your global settings.
    const target = (scope) => {
      const file = claudeSetup.settingsFiles(deps.setupWhere()).find(f => f.scope === scope)?.file;
      return file && !linked(file) ? file : null;
    };
    const noFile = { ok: false, error: "your settings for this folder are a link to somewhere else, so Shellby won't write through it" };
    for (const r of c.pack.rules.filter(x => go.rules.includes(tp.ruleKey(x)))) {
      const file = target('local');
      tally(file ? claudeSetup.changeSettings(file, s => claudeSetup.withRule(s, r.list, r.rule)) : noFile, `The rule ${r.rule}`);
    }
    for (const h of c.pack.hooks.filter(x => go.hooks.includes(tp.hookKey(x)))) {
      const file = target('local');
      const checked = claudeSetup.validateHook(h);
      tally(!file ? noFile : checked.error ? { ok: false, error: checked.error } : claudeSetup.changeHooks(file, s => claudeSetup.withHook(s, checked.hook)), `The hook ${h.event}`);
    }
    for (const s of servers.filter(x => go.mcp.includes(x.name))) tally(await addMcp(s, valuesFor(values, s.name)), `The MCP server ${s.name}`);
    for (const [name, input] of wfInputs) {
      const r = await service.save(input, { source: 'team', confirmed: true });
      tally(r.ok ? r : { ok: false, error: (r.errors || []).map(e => e.message).join(' ') }, `The workflow "${name}"`);
    }
    if (added) {
      setTrust(c.p.root, { accepted: { hash: c.p.fileHash, at: now() } });
      deps.stat('team-setup-all');
    }
    const r = { ok: !failed.length, added, failed, later };
    if (failed.length) r.error = `Set up ${added} of ${added + failed.length}. ${failed[0]}${failed.length > 1 ? ` (and ${failed.length - 1} more)` : ''}`;
    return { ...r, view: view() };
  });

  ipcMain.on('team:reveal', () => {
    const p = packAt(deps.currentCwd());
    if (p?.hasPack) deps.shell.showItemInFolder(p.file);
  });

  // ---- making one: what you could share, and writing the file

  function shareable() {
    const setup = deps.setupView();
    const service = deps.workflows();
    return {
      snippets: deps.ownSnippets().map(s => ({ name: s.name, text: s.text, hint: s.hint })),
      workflows: service ? service.workflows.map(w => ({ id: w.id, name: w.name, description: w.description })) : [],
      // Your own command hooks, from any of the three settings files (a project's
      // already reach the team, but might be worth making optional).
      hooks: setup.hooks.filter(h => ['user', 'project', 'local'].includes(h.source) && h.type === 'command' && h.known)
        .map(h => ({ key: tp.hookKey(h), event: h.event, matcher: h.matcher, command: h.command, summary: h.summary, source: h.source })),
      rules: setup.permissions.rules.map(r => ({ key: tp.ruleKey(r), list: r.list, rule: r.rule, scope: r.scope })),
      // Your own servers (a .mcp.json one is already in the repo), as the pack
      // would have them: names for their values, which stay on this PC.
      mcpServers: portableServers().map(({ server, blanks, scope }) => ({
        name: server.name, transport: server.transport, target: server.command || server.url, blanks, scope,
      })),
    };
  }

  function portableServers() {
    const where = { home: deps.setupWhere().home, cwd: workDir() };
    return mcpHere().filter(s => s.scope === 'local' || s.scope === 'user').flatMap((s) => {
      const found = mcpServers.resolveServer(s.name, where);
      const r = found.ok ? tp.portableMcp(s.name, found.def) : null;
      return r?.ok ? [{ ...r, scope: s.scope }] : [];
    });
  }

  ipcMain.handle('team:draft', () => {
    const p = packAt(deps.currentCwd());
    if (!p) return { ok: false, error: "This folder isn't in a git repository, so there's nowhere to keep a team pack. Pick a project folder first." };
    const all = shareable();
    const pack = p.read?.ok ? p.read.pack : null;
    // What's in the pack now starts ticked, so editing it doesn't drop anything by surprise.
    const service = deps.workflows();
    const picked = pack ? {
      snippets: pack.snippets.map(s => s.name).filter(n => all.snippets.some(s => s.name === n)),
      workflows: service ? pack.workflows.map(w => service.byName(w.name)?.id).filter(Boolean) : [],
      hooks: pack.hooks.map(tp.hookKey).filter(k => all.hooks.some(h => h.key === k)),
      rules: pack.rules.map(tp.ruleKey).filter(k => all.rules.some(r => r.key === k)),
      mcpServers: pack.mcpServers.map(s => s.name).filter(n => all.mcpServers.some(s => s.name === n)),
    } : { snippets: [], workflows: [], hooks: [], rules: [], mcpServers: [] };
    // Parts of the pack you don't have here would be dropped by a rewrite: say so.
    const kept = pack ? (pack.snippets.length - picked.snippets.length) + (pack.workflows.length - picked.workflows.length)
      + (pack.hooks.length - picked.hooks.length) + (pack.rules.length - picked.rules.length)
      + (pack.mcpServers.length - picked.mcpServers.length) : 0;
    return {
      ok: true, repo: path.basename(p.root), exists: p.hasPack, broken: p.hasPack && !p.read?.ok,
      name: pack?.name || path.basename(p.root), about: pack?.about || '', all, picked, missing: kept,
    };
  });

  ipcMain.handle('team:write', (_e, req = {}) => {
    const p = packAt(deps.currentCwd());
    if (!p) return { ok: false, error: "This folder isn't in a git repository." };
    const names = (list, max = MAX_PICKS) => (Array.isArray(list) ? list.filter(isStr).slice(0, max) : []);
    const all = shareable();
    const service = deps.workflows();
    const pick = names(req.snippets);
    const mcpNames = new Set(names(req.mcpServers));
    const wfIds = names(req.workflows);
    const hookKeys = new Set(names(req.hooks));
    const ruleKeys = new Set(names(req.rules));
    const own = deps.ownSnippets();
    const setupHooks = deps.setupView().hooks;
    const built = tp.build({
      name: typeof req.name === 'string' ? req.name : '',
      about: typeof req.about === 'string' ? req.about : '',
      snippets: own.filter(s => pick.includes(s.name)),
      workflows: service ? service.workflows.filter(w => wfIds.includes(w.id)) : [],
      hooks: all.hooks.filter(h => hookKeys.has(h.key)).map(h => {
        const full = setupHooks.find(x => tp.hookKey(x) === h.key);
        return { event: h.event, matcher: h.matcher, command: h.command, ...(Number.isFinite(full?.timeout) ? { timeout: full.timeout } : {}) };
      }),
      rules: all.rules.filter(r => ruleKeys.has(r.key)).map(r => ({ list: r.list, rule: r.rule })),
      mcpServers: mcpNames.size ? portableServers().filter(x => mcpNames.has(x.server.name)).map(x => x.server) : [],
    }, p.root);
    if (!built.ok) return built;
    if (linked(p.file)) return { ok: false, error: `${tp.DIR} or ${tp.DIR}/${tp.FILE} is a link to somewhere else, so Shellby won't write through it.` };
    try {
      fs.mkdirSync(path.dirname(p.file), { recursive: true });
      const tmp = `${p.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, built.text);
      fs.renameSync(tmp, p.file);
    } catch (e) { return { ok: false, error: `Couldn't write ${tp.DIR}/${tp.FILE}: ${e.code || e.message}` }; }
    // You wrote it: it's seen, and its snippets are your own, so they count as looked at.
    const fresh = packAt(deps.currentCwd());
    if (fresh?.fileHash && fresh.read?.ok) setTrust(p.root, { seen: fresh.fileHash, snippets: tp.hashOf(fresh.read.pack.snippets), accepted: { hash: fresh.fileHash, at: now() } });
    deps.stat('team-pack-written');
    return { ok: true, notes: built.notes, file: `${tp.DIR}/${tp.FILE}`, view: view() };
  });

  return { snippetsFor, notice, folderChanged, view };
}

module.exports = { register };
