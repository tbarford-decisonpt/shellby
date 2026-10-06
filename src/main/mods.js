// Mods: Claude Code plugins whose hooks are code (a TypeScript or JavaScript
// module named under "modules" in hooks/hooks.json) rather than shell commands.
// They run inside every Claude Code conversation, Shellby's included, so the
// Toolbox lists them, says what each one can do, and asks before one is turned on.
//
// Where they come from:
//  - ~/.claude/skills/<name>/ with a .claude-plugin/plugin.json: Claude Code
//    loads it in every session as <name>@skills-dir. Mods you or Claude write.
//  - A plugin installed from a marketplace whose hooks are a module.
//  - A plugin a running conversation reports that's neither (a --plugin-dir one).
// A project's own .claude/skills/<name> plugin isn't loaded by Claude Code
// (2.1.288), so it isn't listed: it would only look like it worked.
//
// Pure but for reading files (fsImpl is injectable): see test/mods.test.js.
const fs = require('fs');
const path = require('path');

const MAX_JSON = 256 * 1024;
const MAX_MODS = 200;
const MAX_MODULES = 10;
const MAX_TESTS = 50;
const MAX_TEST_DEPTH = 4;
const MAX_NOTE = 2000;
const MAX_LIST = 60;
const NAME_RE = /^[A-Za-z0-9][\w.-]{0,79}$/;
// What Shellby will create: Claude Code's own plugin names are kebab-case.
const NEW_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const SKILLS_DIR = 'skills-dir';
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude-plugin']);

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
// One display line: no control, bidi-override or zero-width characters (they can disguise names).
const clean = (v, max) => (typeof v === 'string'
  ? v.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
  : '');

function readJson(file, fsImpl = fs) {
  try {
    const st = fsImpl.statSync(file);
    if (!st.isFile() || st.size > MAX_JSON) return null;
    return JSON.parse(fsImpl.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch { return null; }
}

function isDir(p, fsImpl = fs) {
  try { return fsImpl.statSync(p).isDirectory(); } catch { return false; }
}

/** A path relative to dir that stays inside it, or null. */
function inside(dir, rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || /^[\\/]/.test(rel)) return null;
  const full = path.resolve(dir, rel);
  const back = path.relative(dir, full);
  return back && !back.startsWith('..') && !path.isAbsolute(back) ? full : null;
}

// The hooks config: plugin.json's "hooks" (a file of the plugin, or the config
// itself), else hooks/hooks.json.
function hooksConfig(dir, manifest, fsImpl) {
  const h = manifest.hooks;
  if (isObj(h)) return h;
  if (typeof h === 'string') {
    const file = inside(dir, h);
    return file ? readJson(file, fsImpl) : null;
  }
  return readJson(path.join(dir, 'hooks', 'hooks.json'), fsImpl);
}

// Its *.test.ts / *.test.tsx files, which `claude plugin test` runs, and when
// its code last changed (stamp): what you said yes to is pinned to that. Not
// node_modules, .git or .claude-plugin, where Claude Code rewrites the types at
// every load; plugin.json's own time is added by the caller.
function walk(dir, fsImpl = fs, depth = 0, acc = { tests: 0, stamp: 0 }) {
  if (depth > MAX_TEST_DEPTH) return acc;
  let entries;
  try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(full, fsImpl, depth + 1, acc);
      continue;
    }
    if (/\.test\.tsx?$/i.test(e.name) && acc.tests < MAX_TESTS) acc.tests++;
    try { acc.stamp = Math.max(acc.stamp, fsImpl.statSync(full).mtimeMs || 0); } catch { /* gone mid-walk */ }
  }
  return acc;
}

function mtime(file, fsImpl) {
  try { return fsImpl.statSync(file).mtimeMs || 0; } catch { return 0; }
}

/**
 * The mod in a plugin folder: { name, version, description, author, modules, tests, stamp },
 * or null when it isn't a plugin, or is one whose hooks are only shell commands.
 */
function readMod(dir, fsImpl = fs) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
  const manifestFile = path.join(dir, '.claude-plugin', 'plugin.json');
  const manifest = readJson(manifestFile, fsImpl);
  if (!isObj(manifest) || typeof manifest.name !== 'string' || !NAME_RE.test(manifest.name)) return null;
  const hooks = hooksConfig(dir, manifest, fsImpl);
  const listed = isObj(hooks) && Array.isArray(hooks.modules) ? hooks.modules : [];
  const modules = listed.filter(m => typeof m === 'string' && m && m.length < 300).slice(0, MAX_MODULES);
  if (!modules.length) return null;
  const author = isObj(manifest.author) ? manifest.author.name : manifest.author;
  const files = walk(dir, fsImpl);
  return {
    name: manifest.name,
    version: clean(manifest.version, 24),
    description: clean(manifest.description, 240),
    author: clean(author, 80),
    modules,
    tests: files.tests,
    stamp: Math.max(files.stamp, mtime(manifestFile, fsImpl)),
  };
}

const SCOPES = ['user', 'project', 'local'];

/**
 * Whether a plugin is on, and which settings file decided it: the last of
 * user, project and local that names it, else fallback (from: null).
 * settings: parsed settings objects, in that order.
 */
function enabledWhere(id, settings = [], fallback = true) {
  let on = fallback;
  let from = null;
  settings.forEach((s, i) => {
    const v = isObj(s) && isObj(s.enabledPlugins) && Object.hasOwn(s.enabledPlugins, id) ? s.enabledPlugins[id] : undefined;
    if (typeof v === 'boolean') { on = v; from = SCOPES[i] || null; }
  });
  return { on, from };
}

const isEnabled = (id, settings, fallback = true) => enabledWhere(id, settings, fallback).on;

function samePath(a, b) {
  const norm = p => {
    const r = path.resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

const modItem = (mod, fields) => ({
  kind: 'mod', name: mod.name, description: mod.description, version: mod.version, author: mod.author,
  modules: mod.modules, tests: mod.tests, stamp: mod.stamp, problem: null, ...fields,
});

/**
 * Every mod Claude Code would load for this person, A to Z.
 *   home: their home folder (mods in ~/.claude/skills)
 *   installed: [{ id, marketplace, dir, enabled, scope }] marketplace plugins (marketplace.js)
 *   loaded: [{ name, path, source }] the plugins a running conversation reported (its init)
 *   settings: [user, project, local] settings objects, for which skills-dir mods are on
 * -> [{ kind: 'mod', id, name, description, version, author, modules, tests, stamp,
 *      source: 'user' | 'plugin' | 'session', marketplace, scope, enabled, setBy, problem, path }]
 * setBy: the settings scope that turned it on or off ('project', 'local'…), or null.
 * problem: why Shellby won't switch it (its folder and name disagree), or null.
 */
function scanMods({ home, installed = [], loaded = [], settings = [] } = {}, fsImpl = fs) {
  const out = [];
  const have = p => out.some(m => samePath(m.path, p));
  const add = item => { if (out.length < MAX_MODS && !have(item.path)) out.push(item); };

  const skills = home ? path.join(home, '.claude', 'skills') : null;
  let entries;
  try { entries = skills ? fsImpl.readdirSync(skills, { withFileTypes: true }) : []; } catch { entries = []; }
  for (const e of entries) {
    const dir = path.join(skills, e.name);
    if (!(e.isDirectory() || (e.isSymbolicLink() && isDir(dir, fsImpl)))) continue;
    const mod = readMod(dir, fsImpl);
    if (!mod) continue;
    const id = `${mod.name}@${SKILLS_DIR}`;
    const state = enabledWhere(id, settings, true);
    // Claude Code switches it by the name in its plugin.json. A folder named
    // otherwise (or two folders claiming one name) could have Shellby show you
    // one folder while Claude Code turns on another, so neither is switched here.
    const problem = e.name !== mod.name
      ? `Its folder is called ${clean(e.name, 80)} but its plugin.json calls it ${mod.name}. Rename one to match.`
      : null;
    add(modItem(mod, { id, source: 'user', marketplace: SKILLS_DIR, scope: 'user', enabled: state.on, setBy: state.from, problem, path: dir }));
  }
  const byId = new Map();
  for (const m of out) byId.set(m.id, (byId.get(m.id) || 0) + 1);
  for (const m of out) if (byId.get(m.id) > 1) m.problem = `More than one folder in ~/.claude/skills calls itself ${m.name}. Keep one.`;
  for (const p of Array.isArray(installed) ? installed : []) {
    if (!isObj(p) || typeof p.id !== 'string' || typeof p.dir !== 'string' || p.marketplace === SKILLS_DIR) continue;
    const mod = readMod(p.dir, fsImpl);
    if (!mod) continue;
    add(modItem(mod, { id: p.id, source: 'plugin', marketplace: clean(p.marketplace, 80), scope: typeof p.scope === 'string' ? p.scope : 'user', enabled: p.enabled !== false, setBy: null, path: p.dir }));
  }
  for (const p of Array.isArray(loaded) ? loaded : []) {
    if (!isObj(p) || typeof p.path !== 'string' || !path.isAbsolute(p.path)) continue;
    const mod = readMod(p.path, fsImpl);
    if (!mod) continue;
    const id = typeof p.source === 'string' && /^[\w.-]+@[\w.-]+$/.test(p.source) ? p.source : `${mod.name}@inline`;
    const marketplace = id.slice(id.indexOf('@') + 1);
    add(modItem(mod, { id, source: marketplace === SKILLS_DIR ? 'user' : marketplace === 'inline' ? 'session' : 'plugin', marketplace, scope: 'user', enabled: true, setBy: null, path: p.path }));
  }
  return out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
}

// ---- what a mod can do (claude plugin validate --json)

// "a, b{x=y,z}, c" -> ['a', 'b{x=y,z}', 'c']: commas inside a matcher's braces stay.
function splitList(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of String(s)) {
    if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && depth > 0) depth--;
    if (c === ',' && depth === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const messages = list => (Array.isArray(list) ? list : [])
  .map(x => (isObj(x) ? [clean(x.path, 80), clean(x.message, 300)].filter(Boolean).join(': ') : clean(x, 300)))
  .filter(Boolean);

/**
 * `claude plugin validate --json` -> { ok, errors, warnings, hooks, calls, callsKnown }.
 * hooks: the events the mod's modules hook ("tool.call{tool=Bash}"); calls: the
 * parts of Claude Code they reach ("$.process.run"). callsKnown: whether Claude
 * Code said what it calls at all; it reads the source, so a call spelled out at
 * run time can slip past it. null when it isn't that report.
 */
function parseValidate(json) {
  if (!isObj(json) || typeof json.success !== 'boolean') return null;
  const parts = [json.manifest, ...(Array.isArray(json.contents) ? json.contents : [])].filter(isObj);
  const hooks = new Set();
  const calls = new Set();
  let callsKnown = false;
  for (const p of parts) {
    for (const note of Array.isArray(p.notes) ? p.notes : []) {
      const m = /^\S+ (hooks|calls): (.*)$/.exec(clean(note, MAX_NOTE));
      if (!m) continue;
      if (m[1] === 'calls') callsKnown = true;
      for (const x of splitList(m[2])) (m[1] === 'hooks' ? hooks : calls).add(x.slice(0, 120));
    }
  }
  return {
    ok: json.success,
    errors: parts.flatMap(p => messages(p.errors)).slice(0, MAX_LIST),
    warnings: parts.flatMap(p => messages(p.warnings)).slice(0, MAX_LIST),
    hooks: [...hooks].slice(0, MAX_LIST),
    calls: [...calls].slice(0, MAX_LIST),
    callsKnown,
  };
}

// What a call or a hook lets a mod do, in a person's words. risk: 'high' is
// something that reaches past Claude Code (programs, files, the network, your
// plan); 'medium' changes what Claude does or sees; 'low' is just showing up.
const CALL_POWERS = [
  { re: /^\$\.process\./, text: 'Runs programs on your PC', risk: 'high' },
  { re: /^\$\.fs\.(write|remove|rm|mkdir|rename|move|copy|append|delete|unlink)/, text: 'Writes, moves or deletes files', risk: 'high' },
  { re: /^\$\.fs\./, text: 'Reads files on your PC', risk: 'medium' },
  { re: /^\$\.http\./, text: 'Sends and receives data over the internet', risk: 'high' },
  { re: /^\$\.session\.authorize/, text: 'Uses your Claude sign-in for its web requests', risk: 'high' },
  { re: /^\$\.prompt\.submit/, text: 'Starts turns on its own, which use your plan', risk: 'high' },
  { re: /^\$\.(model|agent\.spawn)/, text: 'Asks Claude things of its own, which uses your plan', risk: 'medium' },
  { re: /^\$\.session\.append/, text: "Adds to the conversation Claude reads", risk: 'medium' },
  { re: /^\$\.prompt\.fill/, text: 'Fills in the message box', risk: 'low' },
  { re: /^\$\.tool\.register/, text: 'Gives Claude new tools', risk: 'low' },
  { re: /^\$\.agent\.register/, text: 'Adds helper agents', risk: 'low' },
  { re: /^\$\.command\.register/, text: 'Adds slash commands', risk: 'low' },
  { re: /^\$\.(store|state)\./, text: 'Keeps its own notes between turns and sessions', risk: 'low' },
  { re: /^\$\.audio\./, text: 'Plays sounds', risk: 'low' },
  { re: /^\$\.clock\./, text: 'Runs on a timer', risk: 'low' },
  { re: /^\$\.ui\./, text: 'Shows messages, toasts and status lines', risk: 'low' },
];
const HOOK_POWERS = [
  { re: /^classic\.PermissionRequest/, text: 'Can answer permission questions for you', risk: 'high' },
  { re: /^(tool\.call|classic\.PreToolUse)/, text: "Can block or change what Claude's tools do", risk: 'medium' },
  { re: /^prompt\.submit/, text: 'Can change the messages you send', risk: 'medium' },
  { re: /^prompt\.compose/, text: "Can change Claude's instructions", risk: 'medium' },
  { re: /^session\.append/, text: 'Can change what the conversation keeps', risk: 'medium' },
  { re: /^turn\.step/, text: "Can change Claude's replies as they arrive", risk: 'medium' },
  { re: /^telemetry\./, text: "Reads Claude Code's usage reports", risk: 'medium' },
  { re: /^(\*|classic\.\*|!)/, text: 'Sees everything Claude Code does', risk: 'medium' },
];
const RISK_ORDER = { high: 0, medium: 1, low: 2 };

/**
 * The plain-words list for a validate report, worst first, each once:
 * [{ text, risk }], plus `other`, the calls none of those describe.
 */
function powers({ hooks = [], calls = [] } = {}) {
  const seen = new Map();
  const other = [];
  const note = (table, x) => {
    const hit = table.find(p => p.re.test(x));
    if (hit) { if (!seen.has(hit.text)) seen.set(hit.text, { text: hit.text, risk: hit.risk }); } else if (table === CALL_POWERS) other.push(x);
  };
  for (const h of hooks) note(HOOK_POWERS, String(h));
  for (const c of calls) note(CALL_POWERS, String(c));
  return { list: [...seen.values()].sort((a, b) => RISK_ORDER[a.risk] - RISK_ORDER[b.risk]), other: other.slice(0, 20) };
}

// ---- `claude plugin test`

/** The end of a test run's output, as lines a panel can show, and how it went. */
function summarizeTest({ ok, stdout = '', stderr = '' } = {}) {
  const text = `${stdout || ''}\n${stderr || ''}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\r/g, '');
  const lines = text.split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim());
  const noTests = /no \*\.test\.ts/i.test(text);
  const pass = Number((/(\d+)\s+pass(?:ed)?\b/i.exec(text) || [])[1]);
  const fail = Number((/(\d+)\s+fail(?:ed|ing)?\b/i.exec(text) || [])[1]);
  return {
    ok: !!ok && !noTests,
    noTests,
    passed: Number.isFinite(pass) ? pass : null,
    failed: Number.isFinite(fail) ? fail : null,
    tail: lines.slice(-30).map(l => l.slice(0, 300)),
  };
}

// ---- making and removing your own

/** A name for a new mod, or an error to show. */
function checkNewName(name, existing = []) {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) return { ok: false, error: 'Give it a name, like tidy-commits.' };
  if (!NEW_NAME_RE.test(n)) return { ok: false, error: 'Use lowercase letters, digits and dashes, like tidy-commits.' };
  if (existing.some(m => m.name === n)) return { ok: false, error: `There's already a mod called ${n}.` };
  return { ok: true, name: n };
}

/**
 * The folder removing a mod would move to the Recycle Bin: only one of your own,
 * right inside ~/.claude/skills, and not by way of a link. -> { ok, target } | { ok: false, error }
 */
function removalTarget(mod, home, fsImpl = fs) {
  if (!mod || mod.kind !== 'mod') return { ok: false, error: "Shellby can't remove that." };
  if (mod.source === 'plugin') return { ok: false, plugin: true, error: `It comes from the ${mod.marketplace} marketplace. Remove it in Get more.` };
  if (mod.source !== 'user' || !home || typeof mod.path !== 'string') return { ok: false, error: "It isn't one of yours, so Shellby leaves it alone." };
  const skills = path.join(home, '.claude', 'skills');
  if (!samePath(path.dirname(mod.path), skills)) return { ok: false, error: "It isn't where Claude Code keeps your own, so Shellby leaves it alone." };
  let st;
  try { st = fsImpl.lstatSync(mod.path); } catch { return { ok: false, error: "It's already gone." }; }
  const linked = { ok: false, error: "It's a linked folder kept somewhere else. Use Show folder to remove it yourself." };
  if (st.isSymbolicLink() || !st.isDirectory()) return linked;
  try {
    if (!samePath(fsImpl.realpathSync(mod.path), path.join(fsImpl.realpathSync(skills), path.basename(mod.path)))) return linked;
  } catch { return { ok: false, error: "It's already gone." }; }
  return { ok: true, target: mod.path };
}

/**
 * The first message of a conversation that builds a mod. Unsent: the person
 * reads it first. The plugin-authoring skill knows the API; this says where the
 * mod goes, so it loads in every session rather than the skill's own dev folder.
 */
function buildPrompt({ name, idea, home }) {
  const dir = path.join(home, '.claude', 'skills', name);
  return [
    `Make me a Claude Code mod called "${name}" that ${String(idea || '').trim() || 'does something useful'}`,
    '',
    'Use the plugin-authoring skill for the mod API and its types. Write it to',
    `${dir}`,
    "(not the skill's dev-mods folder), so Claude Code loads it in every session, Shellby's too.",
    '',
    `- .claude-plugin/plugin.json with "name": "${name}", a version and a one-line description`,
    '- hooks/hooks.json naming one module, and that module',
    '- at least one *.test.ts for what it does',
    '',
    `Then run \`claude plugin validate "${dir}"\` and \`claude plugin test "${dir}"\`, and fix anything they report.`,
    "In Shellby, a mod's log lines, toasts, status lines and slash commands show up; panes and bands above the prompt only draw in a terminal.",
  ].join('\n');
}

// ---- what a mod says in a conversation

// A mod that logs on every step would bury the conversation and its history:
// each one gets LINE_BUDGET lines (and toasts) a minute in a tab, then one note
// that it's being quiet, then nothing until the minute is up.
const LINE_BUDGET = 20;
const LINE_WINDOW_MS = 60 * 1000;

/**
 * budget: a Map the caller keeps per tab. -> 'show' | 'last' (show a "quietened"
 * note instead) | 'drop'.
 */
function modLineAllowed(budget, plugin, now = Date.now()) {
  const b = budget.get(plugin);
  if (!b || now - b.since >= LINE_WINDOW_MS) { budget.set(plugin, { since: now, n: 1 }); return 'show'; }
  b.n++;
  return b.n <= LINE_BUDGET ? 'show' : b.n === LINE_BUDGET + 1 ? 'last' : 'drop';
}

/** A path for the confirm window: one line, nothing that can reorder it, home as ~. */
const shownPath = (p, home) => clean(home && typeof p === 'string' && p.toLowerCase().startsWith(home.toLowerCase()) ? `~${p.slice(home.length)}` : p, 400);

module.exports = {
  readMod, scanMods, isEnabled, enabledWhere, parseValidate, powers, splitList, summarizeTest, checkNewName, removalTarget, buildPrompt,
  modLineAllowed, shownPath, clean, NEW_NAME_RE, SKILLS_DIR, LINE_BUDGET,
};
