// Lean Shell: getting more out of a Claude plan without asking Claude to do
// less. Nothing here ever touches a prompt, the model, the effort level or what
// Claude reads and writes. It measures three things, and the panel shows them:
//
//   - The prompt cache. Each API call says how much of it was read from the
//     cache (a tenth of the price of fresh input), written to it, or sent
//     fresh. Summed per day, and per tab: when the cache was last touched and
//     how long it stays warm (5 minutes or an hour, read off the call itself).
//   - Setup weight. A brand-new conversation's first call carries the system
//     prompt, every tool, the skill and agent listings and the CLAUDE.md files
//     before your first word; that call's size, less the prompt, is the setup.
//   - What gets used. Skills, agents, commands and MCP servers seen in Claude
//     Code's transcripts, how often and how lately, so ones that sit idle can
//     be pointed out. Turning one off or removing it is always the user's call.
//
// Pure: callers pass `now` (test/efficiency.test.js). usagescan.js reads the
// transcripts; lean.js wires it to the panel.

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const DEFAULT_TTL_MS = 5 * MIN;   // Claude Code's cache, unless a call says it wrote for an hour
const COOLING_SHARE = 0.2;        // the last fifth of the cache's life is "cooling"
const KEEP_DAYS = 21;             // this week, last week and a spare
const MAX_SETUPS = 30;            // projects whose setup weight is kept
const MAX_USED = 2000;
const IDLE_MS = 21 * DAY;         // unused this long (and watched this long) is idle
const CHARS_PER_TOKEN = 4;        // rough, for prompts and CLAUDE.md sizes
const CACHE_READ_PRICE = 0.1;     // a cache read costs a tenth of fresh input
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const num = v => (Number.isFinite(v) && v > 0 ? v : 0);
const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');
const dayKey = t => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const daysBack = (now, n) => { const d = new Date(now); return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime()); };

// ---- the prompt cache

/**
 * One API call's token counts from an assistant event, or null. Claude Code
 * repeats a call's usage on every content block, so callers count each
 * messageId once (session.js). main: not inside a subagent.
 */
function callFrom(ev) {
  const m = ev?.type === 'assistant' ? ev.message : null;
  const u = m?.usage;
  if (!m || typeof m.id !== 'string' || !u || typeof u !== 'object') return null;
  const cc = u.cache_creation && typeof u.cache_creation === 'object' ? u.cache_creation : {};
  const ttlMs = num(cc.ephemeral_1h_input_tokens) ? HOUR : num(cc.ephemeral_5m_input_tokens) ? 5 * MIN : null;
  return {
    messageId: m.id, main: !ev.parent_tool_use_id, ttlMs,
    input: num(u.input_tokens), write: num(u.cache_creation_input_tokens), read: num(u.cache_read_input_tokens),
  };
}

/** Tolerate anything read from disk: { 'YYYY-MM-DD': { input, write, read, calls } }, the last few weeks. */
function normalizeDays(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const k of Object.keys(src).filter(k => DAY_RE.test(k)).sort().slice(-KEEP_DAYS)) {
    const d = src[k] || {};
    const day = { input: num(d.input), write: num(d.write), read: num(d.read), calls: Math.floor(num(d.calls)) };
    if (day.input || day.write || day.read) out[k] = day;
  }
  return out;
}

/** Add one call's growth ({ input, write, read, isNew }) to its day. Returns a new ledger. */
function recordCall(days, delta, now) {
  const add = { input: num(delta?.input), write: num(delta?.write), read: num(delta?.read) };
  if (!add.input && !add.write && !add.read) return days;
  const k = dayKey(now);
  const d = days[k] || { input: 0, write: 0, read: 0, calls: 0 };
  const next = { ...days, [k]: { input: d.input + add.input, write: d.write + add.write, read: d.read + add.read, calls: d.calls + (delta.isNew ? 1 : 0) } };
  const keys = Object.keys(next).sort();
  return keys.length > KEEP_DAYS ? Object.fromEntries(keys.slice(-KEEP_DAYS).map(x => [x, next[x]])) : next;
}

function stats(days, keys) {
  const s = { input: 0, write: 0, read: 0, calls: 0 };
  for (const k of keys) for (const f of Object.keys(s)) s[f] += days[k]?.[f] || 0;
  const total = s.input + s.write + s.read;
  // What the reads would have cost as fresh input, less what they did cost.
  return { ...s, total, rate: total ? s.read / total : null, saved: Math.round(s.read * (1 - CACHE_READ_PRICE)) };
}

/** Today, the last seven days and the seven before, for the Lean tab. */
function cacheSummary(days, now) {
  const span = (from, n) => Array.from({ length: n }, (_, i) => daysBack(now, from + i));
  return { today: stats(days, span(0, 1)), week: stats(days, span(0, 7)), lastWeek: stats(days, span(7, 7)) };
}

/**
 * A tab's cache as of now: 'warm', 'cooling' (in its last fifth) or 'cold'.
 * cache is { at, ttlMs } from the tab's last main-thread call.
 */
function cacheState(cache, now) {
  if (!cache || !Number.isFinite(cache.at)) return null;
  const ttl = num(cache.ttlMs) || DEFAULT_TTL_MS;
  const leftMs = cache.at + ttl - now;
  if (leftMs <= 0) return { state: 'cold', leftMs: 0, ttlMs: ttl };
  return { state: leftMs <= ttl * COOLING_SHARE ? 'cooling' : 'warm', leftMs, ttlMs: ttl };
}

// ---- setup weight

/** Characters of text in a prompt, or null when it carries more than text (an image can't be sized). */
function promptChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return null;
  let n = 0;
  for (const b of content) {
    if (b?.type !== 'text' || typeof b.text !== 'string') return null;
    n += b.text.length;
  }
  return n;
}

/** A new conversation's first call, less its prompt: what it carried before your first word. */
function setupTokens(call, chars) {
  if (!call || !Number.isFinite(chars) || chars < 0) return null;
  const total = num(call.input) + num(call.write) + num(call.read);
  return total ? Math.max(0, Math.round(total - chars / CHARS_PER_TOKEN)) : null;
}

/** Tolerate anything read from disk: { [projectKey]: { name, tokens, at } }, newest MAX_SETUPS. */
function normalizeSetups(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const rows = Object.entries(src)
    .filter(([k, v]) => k && k.length <= 400 && v && num(v.tokens) && Number.isFinite(v.at))
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_SETUPS);
  return Object.fromEntries(rows.map(([k, v]) => [k, { name: clip(v.name, 80) || 'No folder', tokens: Math.round(v.tokens), at: v.at }]));
}

function recordSetup(setups, project, tokens, now) {
  if (!project?.key || !num(tokens)) return setups;
  return normalizeSetups({ ...setups, [project.key]: { name: project.name, tokens, at: now } });
}

// ---- what gets used

const SKILL_CALL = /<command-name>\/?([^<\s]{1,120})<\/command-name>/g;

/** A tool's server segment as Claude Code writes it in tool names (mcp__<server>__<tool>). */
const mcpKey = name => `mcp:${String(name).replace(/[^\w-]/g, '_')}`;

/**
 * What one transcript line used: { at, keys } with keys like 'skill:name',
 * 'agent:name' and 'mcp:server', or null. Slash commands and skills share
 * 'skill:' because a skill can be called either way.
 */
function usedIn(line) {
  if (typeof line !== 'string' || !(line.includes('"tool_use"') || line.includes('<command-name>'))) return null;
  let ev;
  try { ev = JSON.parse(line); } catch { return null; }
  const at = Date.parse(ev?.timestamp);
  const content = ev?.message?.content;
  const keys = new Set();
  const blocks = Array.isArray(content) ? content : typeof content === 'string' ? [{ type: 'text', text: content }] : [];
  for (const b of blocks) {
    if (b?.type === 'tool_use' && typeof b.name === 'string') {
      const input = b.input && typeof b.input === 'object' ? b.input : {};
      if (b.name.startsWith('mcp__')) keys.add(`mcp:${b.name.split('__')[1]}`);
      else if (b.name === 'Skill' && typeof input.skill === 'string') keys.add(`skill:${input.skill.replace(/^\//, '')}`);
      else if ((b.name === 'Agent' || b.name === 'Task') && typeof input.subagent_type === 'string') keys.add(`agent:${input.subagent_type}`);
      else if (b.name === 'SlashCommand' && typeof input.command === 'string') {
        const m = /^\/?(\S{1,120})/.exec(input.command);
        if (m) keys.add(`skill:${m[1]}`);
      }
    } else if (b?.type === 'text' && typeof b.text === 'string' && b.text.includes('<command-name>')) {
      for (const m of b.text.matchAll(SKILL_CALL)) keys.add(`skill:${m[1]}`);
    }
  }
  return keys.size && Number.isFinite(at) ? { at, keys: [...keys].filter(k => k.length <= 200) } : null;
}

/** Note that keys were used at `at`. used is { key: lastUsedAt }; returns a new map. */
function recordUse(used, keys, at) {
  const next = { ...used };
  for (const k of keys) if (!(next[k] >= at)) next[k] = at;
  const entries = Object.entries(next);
  return entries.length > MAX_USED ? Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, MAX_USED)) : next;
}

/**
 * The plugin a used key belongs to ('ecc:plan' -> 'ecc', 'mcp:plugin_github_github'
 * -> 'github'), or null. A plugin's server is named plugin_<plugin>_<server>, and
 * a plugin's name can have underscores in it, so given the plugins there are,
 * the longest one that fits wins.
 */
function ownerOf(key, plugins = []) {
  const at = key.indexOf(':');
  const kind = key.slice(0, at);
  const name = key.slice(at + 1);
  if (kind === 'mcp') {
    if (!name.startsWith('plugin_')) return null;
    const rest = name.slice(7);
    const fits = plugins.map(p => p.replace(/[^\w-]/g, '_')).filter(p => rest.startsWith(`${p}_`)).sort((a, b) => b.length - a.length)[0];
    return fits ? plugins.find(p => p.replace(/[^\w-]/g, '_') === fits) : /^([^_]+)_/.exec(rest)?.[1] || null;
  }
  const i = name.indexOf(':');
  return i > 0 ? name.slice(0, i) : null;
}

/**
 * Plugins that bring a skill, command or agent by its bare name: Claude usually
 * calls a plugin's skill as "frontend-design", not "frontend-design:frontend-design".
 * tools is the Toolbox ({ skills, agents, commands } with name 'plugin:thing' and
 * source 'plugin:plugin'). -> Map('skill:thing' | 'agent:thing' -> [plugin names])
 */
function bareNames(tools) {
  const out = new Map();
  const add = (kind, list) => {
    for (const t of Array.isArray(list) ? list : []) {
      if (typeof t?.name !== 'string' || typeof t.source !== 'string' || !t.source.startsWith('plugin:')) continue;
      const bare = t.name.slice(t.name.lastIndexOf(':') + 1);
      const key = `${kind}:${bare}`;
      out.set(key, [...new Set([...(out.get(key) || []), t.source.slice(7)])]);
    }
  };
  add('skill', tools?.skills);
  add('skill', tools?.commands);
  add('agent', tools?.agents);
  return out;
}

/**
 * When anything a plugin brings was last used: { pluginName: at }. A bare name
 * that more than one plugin could have answered counts for all of them: better
 * to miss an idle plugin than to call a used one idle.
 */
function lastUsedByPlugin(used, tools = null, plugins = []) {
  const out = {};
  const bare = bareNames(tools);
  const note = (owner, at) => { if (!(out[owner] >= at)) out[owner] = at; };
  for (const [k, at] of Object.entries(used || {})) {
    const owner = ownerOf(k, plugins);
    if (owner) note(owner, at);
    else for (const p of bare.get(k) || []) note(p, at);
  }
  return out;
}

/**
 * How often each Toolbox item was used, and when last: { 'kind:name': { uses, lastUsed } }.
 * tools: the Toolbox; used: { key: lastUsedAt }; uses: { key: count }. Skills and
 * commands share 'skill:' keys. A plugin's 'plugin:thing' is usually called by its
 * bare name, which counts for it too, unless something else answers to that name.
 */
function toolUsage(tools, used = {}, uses = {}) {
  const out = {};
  const ns = kind => (kind === 'agent' ? 'agent' : 'skill');
  // The same item can arrive twice (the Toolbox and a plugin folder scanned again).
  const items = [...new Map(['skills', 'commands', 'agents'].flatMap(k => (Array.isArray(tools?.[k]) ? tools[k] : []))
    .filter(t => typeof t?.name === 'string' && typeof t.kind === 'string')
    .map(t => [`${t.kind}:${t.name}`, t])).values()];
  const named = new Map();
  for (const t of items) {
    const bare = `${ns(t.kind)}:${t.name.slice(t.name.lastIndexOf(':') + 1)}`;
    named.set(bare, (named.get(bare) || 0) + 1);
  }
  for (const t of items) {
    const keys = [`${ns(t.kind)}:${t.name}`];
    const bare = `${ns(t.kind)}:${t.name.slice(t.name.lastIndexOf(':') + 1)}`;
    if (bare !== keys[0] && named.get(bare) === 1) keys.push(bare);
    const last = Math.max(...keys.map(k => used[k]).filter(Number.isFinite), -Infinity);
    out[`${t.kind}:${t.name}`] = {
      uses: keys.reduce((n, k) => n + num(uses[k]), 0),
      lastUsed: Number.isFinite(last) ? last : null,
    };
  }
  return out;
}

/** What a skill, command or agent costs: listed in every conversation, and read in full each time it's called. */
function toolTokens(t) {
  return { listTokens: Math.round(num(t?.listChars) / CHARS_PER_TOKEN), useTokens: Math.round(num(t?.bodyChars) / CHARS_PER_TOKEN) };
}

// ---- memory files

/**
 * Does a rule file load only for matching files? A `paths:` list in its
 * frontmatter means Claude Code adds it when Claude works on one of them, not
 * to every conversation. Only rules work that way: a CLAUDE.md always loads.
 * head: the file's first few KB.
 */
function loadsOnDemand(head, scope = 'user-rule') {
  if (!/-rule$/.test(scope)) return false;
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(typeof head === 'string' ? head : '');
  return !!m && /^paths\s*:/m.test(m[1]);
}

// ---- the Lean tab

/**
 * Everything the Lean tab shows. plugins: installed and enabled, with Claude
 * Code's own always-on estimate and whether it works in the background
 * (`claude plugin details`), and when they were installed or turned back on.
 * mcp: the servers a conversation reported (plugin ones are counted with their
 * plugin), and mcpSeen when Shellby first saw each one. memory:
 * the CLAUDE.md and rule files that load here. tools: the Toolbox, to tell
 * which plugin a bare skill name came from. used/watchedSince: from the
 * transcripts. Something counts as idle only once the transcripts cover
 * IDLE_MS, so a fresh install never calls everything idle. mine: your own
 * skills, commands and agents (not a plugin's), each with addedAt from its file,
 * and uses: how many times each key was used (usagescan.totalUses).
 */
function leanReport({ plugins = [], mcp = [], mcpSeen = {}, tools = null, mine = [], memory = [], used = {}, uses = {}, watchedSince = null, setups = {}, projectKey = null, days = {}, now }) {
  const watched = Number.isFinite(watchedSince) && now - watchedSince >= IDLE_MS;
  // Something added (or turned back on) lately hasn't had the chance to be used
  // yet, and something with no known start can't be judged at all.
  const idle = (last, since) => watched
    && Number.isFinite(since) && now - since >= IDLE_MS
    && !(Number.isFinite(last) && now - last < IDLE_MS);
  const byPlugin = lastUsedByPlugin(used, tools, plugins.map(p => p?.name).filter(n => typeof n === 'string'));

  const pluginRows = plugins
    .filter(p => p && p.enabled && typeof p.id === 'string')
    .map(p => {
      const last = byPlugin[p.name] ?? null;
      // Hooks and language servers work without ever showing up in a transcript,
      // and a plugin Claude Code wouldn't describe might too: neither is idle.
      const background = p.background !== false;
      const since = Math.max(...[p.installedAt, p.enabledAt].filter(Number.isFinite), -Infinity);
      return { id: p.id, name: p.name, scope: p.scope, tokens: Number.isFinite(p.alwaysOnTokens) ? p.alwaysOnTokens : null, lastUsed: last, background, idle: !background && idle(last, since) };
    })
    .sort((a, b) => (b.idle - a.idle) || ((b.tokens || 0) - (a.tokens || 0)) || a.name.localeCompare(b.name));

  const mcpRows = mcp
    .filter(s => s && typeof s.name === 'string' && !s.name.startsWith('plugin:'))
    .map(s => {
      const last = used[mcpKey(s.name)] ?? null;
      // Claude Code doesn't say when a server was added: from when Shellby first saw it.
      return { name: s.name, status: s.status || null, lastUsed: last, idle: idle(last, mcpSeen[s.name]) };
    })
    .sort((a, b) => (b.idle - a.idle) || a.name.localeCompare(b.name));

  // Against everything there is, so a bare name a plugin also answers to isn't
  // credited to yours here when the Toolbox wouldn't.
  const all = k => [...(Array.isArray(tools?.[k]) ? tools[k] : []), ...mine.filter(t => `${t?.kind}s` === k)];
  const usage = toolUsage({ skills: all('skills'), commands: all('commands'), agents: all('agents') }, used, uses);
  const skillRows = mine
    .filter(t => t && usage[`${t.kind}:${t.name}`])
    .map(t => {
      const u = usage[`${t.kind}:${t.name}`];
      return { kind: t.kind, name: t.name, source: t.source, ...toolTokens(t), uses: u.uses, lastUsed: u.lastUsed, idle: idle(u.lastUsed, t.addedAt) };
    })
    .sort((a, b) => (b.idle - a.idle) || (b.listTokens - a.listTokens) || a.name.localeCompare(b.name));

  const memoryRows = memory
    .filter(m => m && m.exists && num(m.size))
    .map(m => ({ path: m.path, scope: m.scope, tokens: Math.round(m.size / CHARS_PER_TOKEN), onDemand: !!m.onDemand }))
    .sort((a, b) => (a.onDemand - b.onDemand) || b.tokens - a.tokens);

  const setupRows = Object.entries(setups).map(([key, s]) => ({ key, ...s })).sort((a, b) => b.at - a.at);
  const setup = setupRows.find(s => s.key === projectKey) || setupRows[0] || null;
  const sum = (rows, pick = r => r.tokens || 0) => rows.reduce((n, r) => n + pick(r), 0);

  return {
    setup,
    plugins: pluginRows,
    mcp: mcpRows,
    skills: skillRows,
    memory: memoryRows,
    totals: {
      plugins: sum(pluginRows),
      idlePlugins: sum(pluginRows.filter(r => r.idle)),
      memory: sum(memoryRows.filter(r => !r.onDemand)),
      memoryOnDemand: sum(memoryRows.filter(r => r.onDemand)),
      skills: sum(skillRows, r => r.listTokens),
      idleCount: pluginRows.filter(r => r.idle).length + mcpRows.filter(r => r.idle).length + skillRows.filter(r => r.idle).length,
    },
    watched,
    watchedFrom: Number.isFinite(watchedSince) ? watchedSince : null,
    idleDays: Math.round(IDLE_MS / DAY),
    cache: cacheSummary(days, now),
  };
}

module.exports = {
  callFrom, normalizeDays, recordCall, cacheSummary, cacheState,
  promptChars, setupTokens, normalizeSetups, recordSetup,
  usedIn, recordUse, ownerOf, lastUsedByPlugin, mcpKey, loadsOnDemand, leanReport, toolUsage, toolTokens,
  DEFAULT_TTL_MS, IDLE_MS, CHARS_PER_TOKEN, COOLING_SHARE,
};
