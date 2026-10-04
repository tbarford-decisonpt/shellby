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
const fs = require('fs');
const path = require('path');
const tp = require('./teampack');

const NOTICE_DELAY_MS = 6000;
const HOOK_SCOPES = ['local', 'user'];
const RULE_SCOPES = ['local', 'user'];
const MAX_PICKS = 200;

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

/**
 * deps: { ipcMain, config, shell, home, panel(), send(win, channel, payload),
 *   currentCwd(), ownSnippets(), pushSnippets(), workflows() -> WorkflowService | null,
 *   setupView(), saveHook({ scope, hook }), saveRule({ scope, list, rule }), stat(event), log }
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
    });
    status.workflows = status.workflows.map(w => {
      const form = forms.get(w.name);
      if (!service) return { ...w, state: 'off', error: 'Workflows are off: Shellby is in just-the-crab mode.' };
      return form && !form.ok ? { ...w, state: 'broken', error: form.errors.slice(0, 2).map(e => e.message).join(' ') } : w;
    });
    return { ...base, problems: p.read.problems, ...status };
  }

  // The pack as it is now, for an action: refuses if it's gone or broken.
  function current() {
    const p = packAt(deps.currentCwd());
    if (!p?.hasPack) return { error: "This folder's repo has no team pack any more." };
    if (!p.read.ok) return { error: p.read.error };
    return { p, pack: p.read.pack };
  }
  const done = extra => ({ ...extra, view: view() });

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
    };
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
    } : { snippets: [], workflows: [], hooks: [], rules: [] };
    // Parts of the pack you don't have here would be dropped by a rewrite: say so.
    const kept = pack ? (pack.snippets.length - picked.snippets.length) + (pack.workflows.length - picked.workflows.length)
      + (pack.hooks.length - picked.hooks.length) + (pack.rules.length - picked.rules.length) : 0;
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
    if (fresh?.fileHash && fresh.read?.ok) setTrust(p.root, { seen: fresh.fileHash, snippets: tp.hashOf(fresh.read.pack.snippets) });
    deps.stat('team-pack-written');
    return { ok: true, notes: built.notes, file: `${tp.DIR}/${tp.FILE}`, view: view() };
  });

  return { snippetsFor, notice, folderChanged, view };
}

module.exports = { register };
