// Lean Shell, the main-process side (efficiency.js has the rules). Keeps the
// prompt-cache ledger, each project's setup weight and what Claude Code has
// used lately, and answers the Toolbox's Lean tab.
//
// The only change it ever makes is turning a plugin off or back on through
// `claude plugin`, and turning one off is asked in the confirm window first.
// It never edits a prompt, a setting or a file: the CLAUDE.md "suggest a trim"
// button only puts a prompt in a new tab for you to read and send.
const fs = require('fs');
const path = require('path');
const eff = require('./efficiency');
const mcpAdmin = require('./mcpadmin');
const { scanTranscripts, totalUses } = require('./usage/scan');
const { scanToolbox } = require('./toolbox');

const SAVE_MS = 5000;                        // calls come in bursts; one write when they settle
const RESCAN_MS = 6 * 60 * 60 * 1000;        // transcripts: at most this often, unless asked
const LOOKBACK_MS = 45 * 24 * 60 * 60 * 1000;
const COST_BATCH = 4;                        // `claude plugin details` at a time (~2 s each)
const MAX_COSTS = 300;
const REPORT_MS = 2 * 60 * 1000;             // past this the panel gets an answer, not a spinner
const TOO_SLOW = 'Claude Code is taking too long to answer. Try "Check again" in a minute.';
const MAX_TIDIED = 300;
const MAX_SEEN = 300;                        // MCP servers whose first sighting is kept
const MAX_MANIFEST = 1024 * 1024;
const PLUGIN_ID_RE = /^[A-Za-z0-9][\w.-]{0,79}@[A-Za-z0-9][\w.-]{0,79}$/;
const isStr = v => typeof v === 'string' && v.length > 0 && v.length < 300;
const HEAD_BYTES = 4096;                     // enough of a memory file to see its frontmatter

// A memory file's first few KB, for its frontmatter ('' if it can't be read).
function head(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, HEAD_BYTES, 0));
  } catch { return ''; } finally { if (fd !== null) fs.closeSync(fd); }
}

// Parts of a plugin that work without Claude ever calling them, so no
// transcript shows them: hooks, output styles, a status line, monitors,
// programs on the PATH, language servers, settings (a main agent). A plugin with
// any of them is never idle.
const QUIET_PATHS = ['hooks', 'output-styles', 'bin', 'monitors', 'settings.json'];
const QUIET_KEYS = ['hooks', 'outputStyles', 'statusLine', 'monitors', 'lspServers'];
function worksQuietly(dir) {
  try {
    if (QUIET_PATHS.some(d => fs.existsSync(path.join(dir, d)))) return true;
    const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifest)) return false;
    if (fs.statSync(manifest).size > MAX_MANIFEST) return true;
    const json = JSON.parse(fs.readFileSync(manifest, 'utf8').replace(/^﻿/, ''));
    return QUIET_KEYS.some(k => json && json[k] != null);
  } catch { return true; } // can't tell: assume it does
}

function createdAt(dir) {
  if (!dir) return null;
  try { return fs.statSync(dir).birthtimeMs || null; } catch { return null; }
}

function cleanUsed(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(Object.entries(src).filter(([k, v]) => k.length <= 200 && Number.isFinite(v)));
}

// Per-transcript use counts from config.json: { file: { key: n } }.
function cleanCounts(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(Object.entries(src)
    .filter(([file, per]) => file.length <= 1000 && per && typeof per === 'object' && !Array.isArray(per))
    .map(([file, per]) => [file, cleanUsed(per)]));
}

// Your own skills, commands and agents (a plugin's come and go with the plugin),
// with when each arrived: one added lately hasn't had the chance to be used yet.
function mine(tb) {
  return ['skills', 'commands', 'agents'].flatMap(k => (Array.isArray(tb?.[k]) ? tb[k] : []))
    .filter(t => (t.source === 'user' || t.source === 'project') && t.path)
    .map(t => ({ ...t, addedAt: createdAt(t.kind === 'skill' ? path.dirname(t.path) : t.path) }));
}

/**
 * deps: { config, shop, shopBlocked, askOnce, toolbox, memory, setupWhere,
 * configDir, projectOf(tab), currentProject(), awardXp, log }
 */
function createLean(deps) {
  const { config } = deps;
  let days = null;
  let setups = null;
  let saveTimer = null;
  let scan = null;        // { used, from, seen, at }: seen (files already read) lives in memory only
  let scanning = null;
  let last = null;        // the last report, for judging what a tidy-up was worth

  function load() {
    days ??= eff.normalizeDays(config.get('cacheDays'));
    setups ??= eff.normalizeSetups(config.get('setupWeights'));
  }

  function save() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (days) config.set({ cacheDays: days, setupWeights: setups });
  }

  /** One API call's growth (session 'call'), and a new conversation's setup weight with it. */
  function onCall(c, tab) {
    load();
    const now = Date.now();
    days = eff.recordCall(days, c, now);
    if (c.setup) setups = eff.recordSetup(setups, deps.projectOf(tab), c.setup, now);
    if (!saveTimer) saveTimer = setTimeout(save, SAVE_MS);
  }

  function used(force) {
    if (scanning) return scanning;
    if (!scan) {
      const stored = config.get('leanUsed') || {};
      scan = { used: cleanUsed(stored.used), from: Number.isFinite(stored.from) ? stored.from : null, counts: cleanCounts(stored.counts), seen: {}, at: 0 };
    }
    if (!force && Date.now() - scan.at < RESCAN_MS) return Promise.resolve(scan);
    scanning = scanTranscripts({ configDir: deps.configDir(), since: Date.now() - LOOKBACK_MS, used: scan.used, from: scan.from, seen: scan.seen, counts: scan.counts })
      .then(r => {
        scan = { ...r, at: Date.now() };
        config.set({ leanUsed: { used: r.used, from: r.from, counts: r.counts } });
        return scan;
      })
      .catch(err => { deps.log?.info(`lean: transcript scan failed: ${err.message}`); return scan; })
      .finally(() => { scanning = null; });
    return scanning;
  }

  // `claude plugin details` per plugin version, asked once and kept: its
  // always-on estimate, and whether it works in the background (hooks or a
  // language server), which no transcript shows. A version it wouldn't
  // describe is asked again only on a refresh.
  async function withDetails(plugins, refresh) {
    let known = { ...(config.get('pluginCosts') || {}) };
    const key = p => `${p.id}#${p.version}`;
    const todo = plugins.filter(p => p.enabled && (!Object.hasOwn(known, key(p)) || (refresh && known[key(p)] === null)));
    for (let i = 0; i < todo.length; i += COST_BATCH) {
      const batch = todo.slice(i, i + COST_BATCH);
      const got = await Promise.all(batch.map(p => deps.shop().details(p.id).catch(() => null)));
      batch.forEach((p, j) => {
        const d = got[j];
        known[key(p)] = d ? { tokens: Number.isFinite(d.alwaysOnTokens) ? d.alwaysOnTokens : null, background: ((d.hooks || 0) + (d.lsp || 0)) > 0 } : null;
      });
      // Kept as it goes: with dozens of plugins this takes a while, and a report
      // that's cut short (or Shellby closing) shouldn't have to start over.
      known = Object.fromEntries(Object.entries(known).slice(-MAX_COSTS));
      config.set({ pluginCosts: known });
    }
    const turnedOn = config.get('pluginEnabledAt') || {};
    return plugins.map(p => {
      const d = known[key(p)];
      // Not described, or a folder Shellby can't look in: assume it works out of sight.
      const background = !d || !p.dir || d.background || worksQuietly(p.dir);
      return {
        ...p, alwaysOnTokens: d?.tokens ?? null, background,
        // Plugins synced from claude.ai come with no install date: when their folder
        // appeared on this PC is the next best thing (never earlier than the truth).
        installedAt: Number.isFinite(p.installedAt) ? p.installedAt : createdAt(p.dir),
        enabledAt: Number.isFinite(turnedOn[p.id]) ? turnedOn[p.id] : null,
      };
    });
  }

  // Every installed plugin's skills, agents and commands, read from the folders
  // the CLI reported, so a skill Claude called by its bare name finds its plugin
  // even before a conversation has told the Toolbox which plugins there are.
  function pluginTools(plugins) {
    const dirs = plugins.filter(p => p.dir).map(p => ({ name: p.name, path: p.dir }));
    let scanned = { skills: [], agents: [], commands: [] };
    try { scanned = scanToolbox({ plugins: dirs }); } catch { /* the Toolbox's own list still helps */ }
    const tb = deps.toolbox()?.current || {};
    const both = k => [...(Array.isArray(tb[k]) ? tb[k] : []), ...scanned[k]];
    return { skills: both('skills'), agents: both('agents'), commands: both('commands') };
  }

  // When Shellby first saw each MCP server: Claude Code doesn't say when one was
  // added, and one that's new can't be idle yet.
  function mcpSeen(servers, now) {
    const seen = { ...(config.get('mcpSeen') || {}) };
    const fresh = servers.filter(s => typeof s?.name === 'string' && !Number.isFinite(seen[s.name]));
    if (!fresh.length) return seen;
    for (const s of fresh) seen[s.name] = now;
    const kept = Object.fromEntries(Object.entries(seen).filter(([, at]) => Number.isFinite(at)).slice(-MAX_SEEN));
    config.set({ mcpSeen: kept });
    return kept;
  }

  // One report at a time: the panel asking twice shares the first one's work.
  // One that runs past REPORT_MS answers with an error and lets go, so a call
  // into Claude Code that never comes back can't keep the tab waiting for good.
  let reporting = null;
  function report(opts = {}) {
    if (reporting) return reporting;
    let timer;
    const mine = Promise.race([
      buildReport(opts),
      new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false, error: TOO_SLOW }), deps.reportMs ?? REPORT_MS); }),
    ]).finally(() => {
      clearTimeout(timer);
      if (reporting === mine) reporting = null;
    });
    reporting = mine;
    return mine;
  }

  async function buildReport({ refresh = false } = {}) {
    const blocked = deps.shopBlocked();
    if (blocked) return blocked;
    load();
    // Only what's installed matters here, so the last list does unless asked
    // to check again: a Skill Shop refresh can take minutes.
    const [list, u] = await Promise.all([deps.shop().list({ stale: !refresh }), used(refresh)]);
    if (!list.ok) return list;
    const plugins = await withDetails(list.plugins.filter(p => p.installed), refresh);
    const now = Date.now();
    const mcp = deps.toolbox()?.current?.mcp || [];
    last = eff.leanReport({
      plugins, mcp, mcpSeen: mcpSeen(mcp, now), tools: pluginTools(plugins), mine: mine(deps.toolbox()?.current), uses: totalUses(u.counts),
      memory: deps.memory().map(m => (m.exists ? { ...m, onDemand: eff.loadsOnDemand(head(m.path), m.scope) } : m)),
      used: u.used, watchedSince: u.from, setups, projectKey: deps.currentProject(), days, now,
    });
    return { ok: true, ...last, off: plugins.filter(p => !p.enabled).map(p => ({ id: p.id, name: p.name })) };
  }

  // XP for turning off something that sat idle, once per thing ever, so turning
  // it back on and off again pays nothing.
  function tidied(key, label) {
    const done = config.get('leanTidied') || [];
    if (done.includes(key)) return;
    config.set({ leanTidied: [...done, key].slice(-MAX_TIDIED) });
    deps.awardXp('tidy', { label });
  }

  async function setPlugin(id, on) {
    const blocked = deps.shopBlocked();
    if (blocked) return blocked;
    if (!PLUGIN_ID_RE.test(id)) return { ok: false, error: "That plugin isn't installed." };
    const p = deps.shop().known(id) ? deps.shop().find(id) : null;
    if (!p?.installed) return { ok: false, error: "That plugin isn't installed." };
    if (!on) {
      const row = last?.plugins.find(r => r.id === id);
      const response = await deps.askOnce({
        icon: '🧹', title: `Turn off "${p.name}"?`,
        message: "New conversations won't load its skills, agents, commands or servers. It stays installed, so you can turn it back on from the Lean tab any time.",
        detail: [
          id,
          row?.tokens ? `Claude Code estimates it adds about ${row.tokens.toLocaleString()} tokens to every conversation.` : null,
          row?.idle ? `Shellby saw no use of it in ${last.idleDays} days of this PC's Claude Code history. Use on another PC or in WSL doesn't show here.` : null,
        ].filter(Boolean).join('\n'),
        buttons: [{ label: 'Turn it off', style: 'primary' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
      if (response === null) return { ok: false, cancelled: true, busy: true };
      if (response !== 0) return { ok: false, cancelled: true };
    }
    const wasIdle = !on && !!last?.plugins.find(r => r.id === id)?.idle;
    const r = await deps.shop().setEnabled(id, on);
    if (!r.ok) return r;
    // Turned back on: it gets a fresh three weeks before it can be called idle again.
    if (on) config.set({ pluginEnabledAt: Object.fromEntries(Object.entries({ ...(config.get('pluginEnabledAt') || {}), [id]: Date.now() }).slice(-MAX_SEEN)) });
    deps.toolbox()?.rescan();
    if (wasIdle) tidied(`plugin:${id}`, `Turned off ${p.name}`);
    return buildReport(); // fresh, not one that started before the change
  }

  // The Toolbox removes MCP servers (parity.js asks first); this only pays for
  // one that the last report called idle and that really is gone now.
  function removedMcp(name) {
    const row = last?.mcp.find(r => r.name === name);
    if (!row?.idle) return { ok: true };
    const where = deps.setupWhere();
    if (mcpAdmin.findServer(name, { home: where.home, cwd: where.cwd })) return { ok: true };
    tidied(`mcp:${name}`, `Removed ${name}`);
    return { ok: true };
  }

  // For the Toolbox's rows: how often and how lately each skill, command and
  // agent was used, and what it costs. Only the transcripts: no plugin details,
  // so it doesn't wait on Claude Code.
  async function usage(force = false) {
    const u = await used(force);
    const tb = deps.toolbox()?.current || {};
    const counts = eff.toolUsage(tb, u.used, totalUses(u.counts));
    const tools = {};
    for (const t of ['skills', 'commands', 'agents'].flatMap(k => (Array.isArray(tb[k]) ? tb[k] : []))) {
      const key = `${t.kind}:${t.name}`;
      tools[key] = { ...counts[key], ...eff.toolTokens(t) };
    }
    return { ok: true, tools, watchedFrom: Number.isFinite(u.from) ? u.from : null, lookbackDays: Math.round(LOOKBACK_MS / (24 * 60 * 60 * 1000)) };
  }

  function register(ipcMain) {
    ipcMain.handle('lean:report', (_e, a) => report({ refresh: !!a?.refresh }));
    ipcMain.handle('lean:usage', (_e, a) => usage(!!a?.refresh));
    ipcMain.handle('lean:plugin', (_e, a) => (isStr(a?.id) ? setPlugin(a.id, !!a.on) : { ok: false, error: "That plugin isn't installed." }));
    ipcMain.handle('lean:mcp-removed', (_e, name) => (isStr(name) ? removedMcp(name) : { ok: false }));
  }

  return { onCall, report, usage, register, save, last: () => last };
}

module.exports = { createLean, worksQuietly, mine };
