// The Skill Shop: a friendly face on Claude Code's own plugin marketplaces.
// Browsing, installing and removing all go through the `claude plugin` CLI, so
// Claude Code stays in charge of where plugins come from and how they load;
// Shellby never downloads or writes plugin files itself.
//
// Trust model: the renderer can only name a plugin id that the CLI itself just
// listed (see `known`), and only add a marketplace that normalizes to a GitHub
// repo or a public https URL. Every call is execFile with an argument array (no
// shell), and main.js asks in an isolated confirm window before anything is
// installed, because plugins can carry hooks and MCP servers that run programs.
//
// Pure (no Electron) so it's unit-tested; the CLI runner and file reads are injectable.
const fs = require('fs');
const path = require('path');
const net = require('net');

const PLUGIN_ID_RE = /^[A-Za-z0-9][\w.-]{0,79}@[A-Za-z0-9][\w.-]{0,79}$/;
const MAX_PLUGINS = 2000;
const MAX_DESC = 300;
const MAX_MANIFEST = 2 * 1024 * 1024;
const LIST_TTL_MS = 5 * 60 * 1000;
const REFRESH_MIN_MS = 30 * 1000;        // `marketplace update` pulls git repos: not on every click
const LIST_TIMEOUT_MS = 30 * 1000;
const CHANGE_TIMEOUT_MS = 3 * 60 * 1000; // installs clone git repos
const NOT_INSTALLED = 'Claude Code is not installed.';

// Marketplaces offered with one click when they aren't added yet. A marketplace
// counts as one of these only if both its name and its source match.
const SUGGESTED = [
  { name: 'claude-plugins-official', source: 'anthropics/claude-plugins-official', label: 'Official Claude plugins', by: 'Anthropic' },
  { name: 'anthropic-agent-skills', source: 'anthropics/skills', label: 'Agent Skills', by: 'Anthropic' },
];

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
// One display line: no control, bidi-override or zero-width characters (they can disguise names).
const str = (v, max) => (typeof v === 'string'
  ? v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  : '');

function cleanDesc(d) {
  const s = str(d, MAX_DESC + 1);
  return s.length > MAX_DESC ? s.slice(0, MAX_DESC - 1) + '…' : s;
}

/** "owner/repo" as GitHub allows it (no ".", ".." or ".git" tricks). */
function isGithubRepo(s) {
  const m = typeof s === 'string' && /^([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9._-]{1,100})$/.exec(s);
  return !!m && !/^\.+$/.test(m[2]) && !/\.git$/i.test(m[2]);
}

// A browsable https link for a plugin's source, if it has one. A relative path
// ("./plugins/x") lives inside its marketplace, so it links there when that
// marketplace is a GitHub repo.
function sourceUrl(src, marketplaceRepo = null) {
  if (typeof src === 'string') {
    const rel = /^\.\/([\w-][\w./-]{0,200})$/.exec(src);
    if (!rel || rel[1].split('/').includes('..') || !isGithubRepo(marketplaceRepo)) return null;
    return `https://github.com/${marketplaceRepo}/tree/HEAD/${rel[1].replace(/\/+$/, '')}`;
  }
  if (!isObj(src)) return null;
  if (isGithubRepo(src.repo)) return `https://github.com/${src.repo}`;
  if (typeof src.url === 'string') {
    try {
      const u = new URL(src.url);
      if (u.protocol !== 'https:' || u.username || u.password) return null;
      u.pathname = u.pathname.replace(/\.git$/i, '');
      return u.href;
    } catch { return null; }
  }
  return null;
}

/**
 * Normalize `claude plugin list --available --json` into one list.
 * repos: marketplace name -> "owner/repo", for linking relative plugin sources.
 * listings: plugin id -> { description, source } from the marketplaces' own
 * catalogs, because the CLI leaves installed plugins out of "available".
 * @returns {{ plugins: Array<{ id, name, marketplace, description, installs, url, installed, enabled, version, scope }> }}
 */
function parseCatalog(json, { repos = {}, listings = {}, pluginsRoot = null } = {}) {
  const out = new Map();
  const root = isObj(json) ? json : {};
  const repoOf = mk => (Object.hasOwn(repos, mk) ? repos[mk] : null);
  const available = Array.isArray(root.available) ? root.available.slice(0, MAX_PLUGINS) : [];
  const installed = Array.isArray(root.installed) ? root.installed.slice(0, MAX_PLUGINS) : [];

  for (const p of available) {
    if (!isObj(p) || typeof p.pluginId !== 'string' || !PLUGIN_ID_RE.test(p.pluginId)) continue;
    const [name, marketplace] = p.pluginId.split('@');
    out.set(p.pluginId, {
      id: p.pluginId, name, marketplace,
      description: cleanDesc(p.description),
      installs: Number.isFinite(p.installCount) && p.installCount >= 0 ? Math.floor(p.installCount) : null,
      url: sourceUrl(p.source, repoOf(marketplace)),
      installed: false, enabled: false, version: '', scope: null,
    });
  }
  for (const p of installed) {
    if (!isObj(p) || typeof p.id !== 'string' || !PLUGIN_ID_RE.test(p.id)) continue;
    // Plugins installed at project scope show up per project; the user-scope
    // entry (or the first one) is the one we describe.
    const prev = out.get(p.id);
    if (prev?.installed && p.scope !== 'user') continue;
    const [name, marketplace] = p.id.split('@');
    const listed = Object.hasOwn(listings, p.id) && isObj(listings[p.id]) ? listings[p.id] : {};
    out.set(p.id, {
      ...(prev || { id: p.id, name, marketplace, description: cleanDesc(listed.description), installs: null, url: sourceUrl(listed.source, repoOf(marketplace)) }),
      installed: true,
      enabled: p.enabled !== false,
      version: str(p.version, 24),
      installedAt: Number.isFinite(Date.parse(p.installedAt)) ? Date.parse(p.installedAt) : null,
      // Where it's unpacked, only inside Claude Code's plugins folder (lean.js reads its skill names).
      dir: underRoot(pluginsRoot, p.installPath),
      scope: ['user', 'project', 'local'].includes(p.scope) ? p.scope : 'user',
    });
  }
  return { plugins: [...out.values()] };
}

/** dir, when it's a local folder under pluginsRoot (Claude Code's own plugins folder); else null. */
function underRoot(pluginsRoot, dir) {
  if (!pluginsRoot || typeof dir !== 'string' || dir.startsWith('\\\\') || !path.isAbsolute(dir)) return null;
  const rel = path.relative(pluginsRoot, dir);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? dir : null;
}

/**
 * Configured marketplaces from `claude plugin marketplace list --json`. `dir`
 * (its local clone) is kept only when it sits under pluginsRoot.
 */
function parseMarketplaces(json, { pluginsRoot = null } = {}) {
  const under = dir => underRoot(pluginsRoot, dir);
  return (Array.isArray(json) ? json : [])
    .filter(m => isObj(m) && typeof m.name === 'string' && /^[\w.-]{1,80}$/.test(m.name))
    .map(m => ({
      name: m.name,
      source: str(m.repo || m.url || m.path || m.source, 200),
      repo: isGithubRepo(m.repo) ? m.repo : null,
      dir: under(m.installLocation),
    }));
}

/** Plugin id -> { description, source } from a marketplace's marketplace.json. */
function parseListing(json, marketplace) {
  const out = {};
  for (const p of isObj(json) && Array.isArray(json.plugins) ? json.plugins.slice(0, MAX_PLUGINS) : []) {
    if (!isObj(p) || typeof p.name !== 'string') continue;
    const id = `${p.name}@${marketplace}`;
    if (PLUGIN_ID_RE.test(id)) out[id] = { description: p.description, source: p.source };
  }
  return out;
}

// Read a small JSON file Claude Code keeps on disk; null on any problem.
function readJsonFile(file) {
  try {
    if (fs.statSync(file).size > MAX_MANIFEST) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch { return null; }
}

/**
 * Read the human output of `claude plugin details` (it has no --json yet).
 * Unknown lines are ignored; missing counts stay null.
 */
function parseDetails(text) {
  const out = { skills: null, agents: null, hooks: null, mcp: null, lsp: null, alwaysOnTokens: null };
  if (typeof text !== 'string') return out;
  const count = re => { const m = re.exec(text); return m ? Number(m[1]) : null; };
  out.skills = count(/^\s*Skills \((\d+)\)/m);
  out.agents = count(/^\s*Agents \((\d+)\)/m);
  out.hooks = count(/^\s*Hooks \((\d+)\)/m);
  out.mcp = count(/^\s*MCP servers \((\d+)\)/m);
  out.lsp = count(/^\s*LSP servers \((\d+)\)/m);
  const tok = /Always-on:\s*~?([\d.]+)(k?)\s*tok/i.exec(text);
  if (tok) out.alwaysOnTokens = Math.round(Number(tok[1]) * (tok[2] ? 1000 : 1));
  return out;
}

/** True when a plugin brings things that run programs (hooks, MCP or LSP servers). */
const runsCode = d => !!d && ((d.hooks || 0) + (d.mcp || 0) + (d.lsp || 0)) > 0;

/** The one JSON result line `--json` prints for install/uninstall. */
function parseResultLine(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try { const j = JSON.parse(t); if (isObj(j)) return j; } catch { /* keep looking */ }
  }
  return null;
}

/**
 * Accept "owner/repo", a github.com link, or a public https URL for a new
 * marketplace; anything else (local paths, flags, other schemes, IP addresses,
 * local hosts) is refused.
 * @returns {string|null} the normalized source, which is what's shown and what runs
 */
function normalizeSource(input) {
  const s = typeof input === 'string' ? input.trim() : '';
  if (!s || s.length > 300 || /[\s\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/.test(s)) return null;
  if (isGithubRepo(s)) return s;
  const gh = /^(?:https:\/\/)?github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?$/i.exec(s);
  if (gh) return isGithubRepo(gh[1]) ? gh[1] : null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
    // "localhost." is localhost: a trailing dot must not slip past the names below.
    const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
    // Defence in depth only: this is a name check, not a DNS check, so a public
    // name that resolves to a private address gets through. The CLI does the fetch.
    if (net.isIP(host) || !host.includes('.') || /(^|\.)(localhost|local|internal|lan|home|corp)$/i.test(host)) return null;
    return u.href;
  } catch { return null; }
}

const failed = (r, res) => (res ? res.outcome === 'failed' || !!res.failureCode : !r.ok);

class Marketplace {
  /**
   * @param {{
   *   run: (args: string[], timeoutMs: number) => Promise<{ ok, stdout, stderr, notInstalled? }>,
   *   now?: () => number, readJson?: (file: string) => any, pluginsRoot?: string,
   * }} opts
   */
  constructor({ run, now = Date.now, readJson = readJsonFile, pluginsRoot = null } = {}) {
    this.run = run;
    this.now = now;
    this.readJson = readJson;
    this.pluginsRoot = pluginsRoot;
    this.cache = null;       // { plugins, marketplaces, marketplacesKnown, at }
    this.queue = Promise.resolve(); // installs/removals one at a time
    this.listing = null;     // the list() in flight, shared by concurrent callers
    this.gen = 0;            // bumped by every change; a list that saw one is retried
    this.lastUpdate = 0;     // last `marketplace update`
  }

  /** Ids the CLI listed most recently: the only ones the renderer may act on. */
  known(id) {
    return typeof id === 'string' && PLUGIN_ID_RE.test(id) && !!this.cache?.plugins.some(p => p.id === id);
  }

  find(id) { return this.cache?.plugins.find(p => p.id === id) || null; }

  /** The configured marketplace by name, as the CLI reported it. */
  marketplace(name) { return this.cache?.marketplaces.find(m => m.name === name) || null; }

  /** A suggested (Anthropic) marketplace, matched on name AND source. */
  suggestedFor(name) {
    const m = this.marketplace(name);
    return (m && SUGGESTED.find(s => s.name === m.name && (s.source === m.repo || s.source === m.source))) || null;
  }

  // stale: any earlier list will do, so a caller that only needs what's installed
  // never waits behind a refresh (`marketplace update` can take minutes). The
  // cache is patched by every change, so what's installed in it stays right.
  list({ refresh = false, stale = false } = {}) {
    if (typeof this.run !== 'function') return Promise.resolve({ ok: false, notInstalled: true, error: NOT_INSTALLED });
    if (!refresh && this.cache && (stale || this.now() - this.cache.at < LIST_TTL_MS)) return Promise.resolve({ ok: true, ...this.view() });
    if (this.listing) return this.listing;
    this.listing = this.fetchList(refresh).finally(() => { this.listing = null; });
    return this.listing;
  }

  async fetchList(refresh, attempt = 0) {
    if (refresh && this.now() - this.lastUpdate >= REFRESH_MIN_MS) {
      this.lastUpdate = this.now();
      await this.run(['plugin', 'marketplace', 'update'], CHANGE_TIMEOUT_MS); // best effort
    }
    const gen = this.gen;
    const [cat, mk] = await Promise.all([
      this.run(['plugin', 'list', '--available', '--json'], LIST_TIMEOUT_MS),
      this.run(['plugin', 'marketplace', 'list', '--json'], LIST_TIMEOUT_MS),
    ]);
    if (cat.notInstalled) return { ok: false, notInstalled: true, error: NOT_INSTALLED };
    let catalog, marketplaces = [], marketplacesKnown = true;
    try {
      if (!mk.ok) throw new Error('marketplace list failed');
      marketplaces = parseMarketplaces(JSON.parse(mk.stdout), { pluginsRoot: this.pluginsRoot });
    } catch { marketplacesKnown = false; /* the plugin list still works */ }
    const repos = Object.fromEntries(marketplaces.filter(m => m.repo).map(m => [m.name, m.repo]));
    const listings = Object.assign({}, ...marketplaces.filter(m => m.dir)
      .map(m => parseListing(this.readJson(path.join(m.dir, '.claude-plugin', 'marketplace.json')), m.name)));
    try {
      if (!cat.ok) throw new Error('plugin list failed');
      catalog = parseCatalog(JSON.parse(cat.stdout), { repos, listings, pluginsRoot: this.pluginsRoot });
    } catch {
      return { ok: false, error: "Couldn't read the plugin list from Claude Code. Make sure it's up to date (2.1 or newer)." };
    }
    // A change finished while we were listing: this snapshot may predate it.
    if (gen !== this.gen && attempt < 2) return this.fetchList(false, attempt + 1);
    this.cache = { plugins: catalog.plugins, marketplaces, marketplacesKnown, at: this.now() };
    return { ok: true, ...this.view() };
  }

  view() {
    const c = this.cache || { plugins: [], marketplaces: [], marketplacesKnown: false, at: 0 };
    const have = new Set(c.marketplaces.map(m => m.name));
    return {
      plugins: c.plugins,
      marketplaces: c.marketplaces.map(m => ({ name: m.name, source: m.source })),
      // Unknown marketplaces (the list failed): don't offer ones that may already be added.
      suggested: c.marketplacesKnown ? SUGGESTED.filter(s => !have.has(s.name)) : [],
      fetchedAt: c.at,
    };
  }

  // Run one change at a time. Afterwards the cache is patched (so the UI is right
  // even if the next list fails) and marked stale.
  change(fn) {
    const job = this.queue.then(fn).finally(() => {
      this.gen++;
      if (this.cache) this.cache.at = 0;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  patch(id, fields) {
    if (!this.cache) return;
    this.cache = { ...this.cache, plugins: this.cache.plugins.map(p => (p.id === id ? { ...p, ...fields } : p)) };
  }

  install(id) {
    if (!this.known(id)) return Promise.resolve({ ok: false, error: "That plugin isn't in your marketplaces." });
    return this.change(async () => {
      // Never pass -y: a plugin that installs by running a marketplace-declared
      // command must be reviewed by a person in a terminal.
      const r = await this.run(['plugin', 'install', id, '--json'], CHANGE_TIMEOUT_MS);
      if (r.notInstalled) return { ok: false, error: NOT_INSTALLED };
      const res = parseResultLine(r.stdout);
      if (res?.shownCommand || res?.failureCode === 'command_confirmation_required') {
        return { ok: false, needsTerminal: true, command: `claude plugin install ${id}`, error: 'This plugin installs by running a command. To review that command first, install it from a terminal.' };
      }
      if (failed(r, res)) return { ok: false, error: str(res?.message, 300) || 'Claude Code could not install that plugin.' };
      this.patch(id, { installed: true, enabled: true, scope: 'user' });
      const d = await this.run(['plugin', 'details', id], LIST_TIMEOUT_MS);
      const details = d.ok ? parseDetails(d.stdout) : null;
      return { ok: true, id, details, runsCode: runsCode(details) };
    });
  }

  uninstall(id) {
    const p = this.find(id);
    if (!this.known(id) || !p?.installed) return Promise.resolve({ ok: false, error: "That plugin isn't installed." });
    // Project and local installs belong to a project folder Shellby doesn't know.
    if (p.scope !== 'user') {
      return Promise.resolve({ ok: false, needsTerminal: true, command: `claude plugin uninstall ${id} --scope ${p.scope}`, error: `This plugin is installed for one project. Remove it from a terminal in that project's folder.` });
    }
    return this.change(async () => {
      const r = await this.run(['plugin', 'uninstall', id, '--json'], CHANGE_TIMEOUT_MS);
      if (r.notInstalled) return { ok: false, error: NOT_INSTALLED };
      const res = parseResultLine(r.stdout);
      if (failed(r, res)) return { ok: false, error: str(res?.message, 300) || 'Claude Code could not remove that plugin.' };
      this.patch(id, { installed: false, enabled: false, version: '', scope: null });
      return { ok: true, id };
    });
  }

  // Turn an installed plugin off or back on. It stays installed, so either way
  // is one click to undo (the Lean tab offers this, never uninstall).
  setEnabled(id, on) {
    const p = this.find(id);
    if (!this.known(id) || !p?.installed) return Promise.resolve({ ok: false, error: "That plugin isn't installed." });
    if (p.scope !== 'user') {
      const verb = on ? 'enable' : 'disable';
      return Promise.resolve({ ok: false, needsTerminal: true, command: `claude plugin ${verb} ${id} --scope ${p.scope}`, error: `This plugin is installed for one project. Turn it ${on ? 'on' : 'off'} from a terminal in that project's folder.` });
    }
    return this.change(async () => {
      const r = await this.run(['plugin', on ? 'enable' : 'disable', id, '--scope', 'user', '--json'], CHANGE_TIMEOUT_MS);
      if (r.notInstalled) return { ok: false, error: NOT_INSTALLED };
      const res = parseResultLine(r.stdout);
      if (failed(r, res)) return { ok: false, error: str(res?.message, 300) || `Claude Code could not turn that plugin ${on ? 'on' : 'off'}.` };
      this.patch(id, { enabled: !!on });
      return { ok: true, id };
    });
  }

  /** `claude plugin details`: what a plugin brings and its always-on token estimate (null if it won't say). */
  async details(id) {
    if (!this.known(id)) return null;
    const r = await this.run(['plugin', 'details', id], LIST_TIMEOUT_MS);
    return r.ok ? parseDetails(r.stdout) : null;
  }

  addMarketplace(input) {
    const source = normalizeSource(input);
    if (!source) return Promise.resolve({ ok: false, error: 'Use a GitHub repo like owner/repo, or a public https:// link.' });
    return this.change(async () => {
      const r = await this.run(['plugin', 'marketplace', 'add', source], CHANGE_TIMEOUT_MS);
      if (r.notInstalled) return { ok: false, error: NOT_INSTALLED };
      if (!r.ok) return { ok: false, error: str(r.stderr || r.stdout, 300) || "Claude Code couldn't add that marketplace." };
      return { ok: true, source };
    });
  }
}

module.exports = {
  Marketplace, SUGGESTED, PLUGIN_ID_RE,
  parseCatalog, parseMarketplaces, parseListing, parseDetails, parseResultLine, normalizeSource, runsCode, sourceUrl, isGithubRepo,
};
