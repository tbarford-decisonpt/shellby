// The other half of setting Claude Code up, next to the toolbox's skills, agents
// and MCP servers: the hooks in its settings files (and plugins', read-only) and
// the CLAUDE.md memory files that load for the current folder.
//
// Unlike the toolbox this module can write, but only when main.js asks it to,
// only to paths it listed itself, and (for hooks, which run programs on their
// own) only after the confirm window says yes. Hook edits are pure functions of
// the settings object (withHook / withoutHook / replaceHook) — see
// test/claude-setup.test.js.
const fs = require('fs');
const path = require('path');
const { walkMd, samePath } = require('./toolbox');
const { writeJson } = require('./statusline');
const { RECIPES, GROUPS: RECIPE_GROUPS, describeHook } = require('./hook-recipes');

const MAX_MEMORY = 512 * 1024;   // a CLAUDE.md bigger than this isn't one we should edit in a textarea
const MAX_SETTINGS = 1024 * 1024;
const MAX_HOOKS = 500;
const MAX_RULES = 100;
const MAX_PARENTS = 12;          // CLAUDE.md files above the project folder
const MAX_COMMAND = 1000;      // the confirm window shows all of it, so it can't hide a tail
const MAX_MATCHER = 200;
const MAX_TIMEOUT = 3600;
// Anything that would break a line, so what a confirm window shows is all there is.
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/;
// Characters that look like nothing or like something else (right-to-left
// overrides, zero-width joiners, odd spaces): a command shown in the confirm
// window has to read as what runs.
const HIDDEN_CHARS = /[\p{Cf}\p{Zs}]/u;

// Claude Code's hook events, in the order a session meets them. `matcher` says
// whether the event filters on something: a tool name (`tools`), one of a few
// fixed values (`choices`), or an agent type. `label` heads its group in the
// panel; `blocks` is what exit code 2 stops (null: it can't stop anything), and
// `context` means what the command prints is added to what Claude knows.
const HOOK_EVENTS = [
  { name: 'SessionStart', label: 'When a session starts', when: 'when a session starts or resumes', matcher: true, context: true, blocks: null,
    choices: [['startup', 'New sessions'], ['resume', 'Resumed ones'], ['clear', 'After /clear'], ['compact', 'After compacting']] },
  { name: 'UserPromptSubmit', label: 'When you send a message', when: 'when you send a prompt', matcher: false, context: true, blocks: 'your message from being sent' },
  { name: 'PreToolUse', label: 'Before Claude uses a tool', when: 'before Claude uses a tool', matcher: true, tools: true, blocks: 'Claude from using the tool' },
  { name: 'PermissionRequest', label: 'When Claude asks for permission', when: 'when Claude asks for permission', matcher: true, tools: true, blocks: 'the request, turning it down' },
  { name: 'PostToolUse', label: 'After a tool works', when: 'after a tool call succeeds', matcher: true, tools: true, blocks: null, feedback: true },
  { name: 'PostToolUseFailure', label: 'After a tool fails', when: 'after a tool call fails', matcher: true, tools: true, blocks: null, feedback: true },
  { name: 'Notification', label: 'When Claude Code wants your attention', when: 'when Claude Code sends a notification', matcher: true, blocks: null,
    choices: [['permission_prompt', 'Asking for permission'], ['idle_prompt', 'Waiting for your reply']] },
  { name: 'SubagentStart', label: 'When a helper agent starts', when: 'when a helper agent starts', matcher: true, blocks: null },
  { name: 'SubagentStop', label: 'When a helper agent finishes', when: 'when a helper agent finishes', matcher: true, blocks: 'the agent from stopping' },
  { name: 'Stop', label: 'When Claude finishes replying', when: 'when Claude finishes a turn', matcher: false, blocks: 'Claude from stopping' },
  { name: 'PreCompact', label: 'Before the conversation is compacted', when: 'before the conversation is compacted', matcher: true, blocks: null,
    choices: [['manual', 'When you run /compact'], ['auto', 'When it happens on its own']] },
  { name: 'SessionEnd', label: 'When a session ends', when: 'when a session ends', matcher: false, blocks: null },
];
const EVENT = new Map(HOOK_EVENTS.map(e => [e.name, e]));
const SCOPES = ['user', 'project', 'local'];

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const str = v => (typeof v === 'string' ? v : '');

// ---- where things live

function settingsFiles({ home, cwd }) {
  const out = [];
  if (home) out.push({ scope: 'user', file: path.join(home, '.claude', 'settings.json') });
  // In the home folder, "the project's .claude" is the user's own: list it once.
  if (cwd && !(home && samePath(cwd, home))) {
    out.push({ scope: 'project', file: path.join(cwd, '.claude', 'settings.json') });
    out.push({ scope: 'local', file: path.join(cwd, '.claude', 'settings.local.json') });
  }
  return out;
}

/** { state: 'none' | 'ok' | 'unreadable', data, raw } */
function readSettings(file) {
  let raw;
  try {
    if (fs.statSync(file).size > MAX_SETTINGS) return { state: 'unreadable', data: null, raw: null };
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) { return e.code === 'ENOENT' ? { state: 'none', data: {}, raw: '' } : { state: 'unreadable', data: null, raw: null }; }
  let data;
  try { data = JSON.parse(raw.replace(/^﻿/, '') || '{}'); } catch { return { state: 'unreadable', data: null, raw }; }
  return isObj(data) ? { state: 'ok', data, raw } : { state: 'unreadable', data: null, raw };
}

// ---- hooks: reading

const hookText = h => str(h.command) || str(h.prompt) || str(h.url);
const fingerprint = (group, hook) => JSON.stringify([str(group.matcher), hook]);

function hookAt(settings, at) {
  if (!isObj(settings) || !isObj(settings.hooks) || !at) return null;
  const groups = settings.hooks[at.event];
  const group = Array.isArray(groups) ? groups[at.group] : null;
  const hook = isObj(group) && Array.isArray(group.hooks) ? group.hooks[at.hook] : null;
  return isObj(hook) ? { group, hook } : null;
}

// One flat row per hook command in a settings (or plugin hooks.json) object.
function flattenHooks(hooks, base) {
  const out = [];
  if (!isObj(hooks)) return out;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    groups.forEach((group, gi) => {
      if (!isObj(group) || !Array.isArray(group.hooks)) return;
      group.hooks.forEach((hook, hi) => {
        if (!isObj(hook) || out.length >= MAX_HOOKS) return;
        const type = str(hook.type) || 'command';
        const command = hookText(hook).slice(0, MAX_COMMAND);
        out.push({
          ...base,
          ...describeHook({ type, command }),
          id: `${base.source}:${event}:${gi}:${hi}`,
          event, matcher: str(group.matcher), type, command,
          timeout: Number.isFinite(hook.timeout) ? hook.timeout : null,
          known: EVENT.has(event),
          editable: base.editable && type === 'command' && EVENT.has(event),
          at: { event, group: gi, hook: hi },
          fp: fingerprint(group, hook),
        });
      });
    });
  }
  return out;
}

function scanHooks({ home, cwd, plugins = [] } = {}) {
  const files = [];
  const hooks = [];
  for (const { scope, file } of settingsFiles({ home, cwd })) {
    const s = readSettings(file);
    files.push({ scope, path: file, state: s.state });
    if (s.state === 'ok') hooks.push(...flattenHooks(s.data.hooks, { source: scope, path: file, editable: true }));
  }
  for (const p of Array.isArray(plugins) ? plugins : []) {
    if (!p || !str(p.name) || !str(p.path)) continue;
    const file = path.join(p.path, 'hooks', 'hooks.json');
    const s = readSettings(file);
    if (s.state === 'ok') hooks.push(...flattenHooks(s.data.hooks, { source: `plugin:${p.name}`, path: file, editable: false }));
  }
  // Capped before sorting: settings hooks were collected first, so a plugin with
  // hundreds of hooks can't push the user's own off the list.
  const order = name => (EVENT.has(name) ? HOOK_EVENTS.indexOf(EVENT.get(name)) : HOOK_EVENTS.length);
  const kept = hooks.slice(0, MAX_HOOKS).sort((a, b) => order(a.event) - order(b.event) || a.event.localeCompare(b.event));
  return { hooks: kept, files };
}

// ---- hooks: editing (pure)

/** Checks a hook from the panel. { hook } or { error }. */
function validateHook(input) {
  const i = isObj(input) ? input : {};
  const event = str(i.event);
  if (!EVENT.has(event)) return { error: 'Pick when the hook should run.' };
  const command = str(i.command).trim();
  if (!command) return { error: 'The hook needs a command to run.' };
  if (command.length > MAX_COMMAND) return { error: `Keep the command under ${MAX_COMMAND} characters. For more, put it in a script and run that.` };
  // One line, no control characters: what the confirm window shows is exactly what runs.
  if (CONTROL_CHARS.test(command)) return { error: 'Keep the command on one line. For more, put it in a script and run that.' };
  if (HIDDEN_CHARS.test(command.replace(/ /g, ''))) return { error: 'The command has an invisible or unusual character in it (a special space, say). Retype it with plain characters.' };
  const matcher = EVENT.get(event).matcher ? str(i.matcher).trim() : '';
  if (matcher.length > MAX_MATCHER) return { error: 'That matcher is too long.' };
  let timeout = null;
  if (i.timeout !== null && i.timeout !== undefined && i.timeout !== '') {
    timeout = Number(i.timeout);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT) return { error: `The timeout is in whole seconds, 1 to ${MAX_TIMEOUT}.` };
  }
  return { hook: { event, matcher, command, timeout } };
}

const commandEntry = (hook, base = {}) => {
  const { timeout: _old, ...rest } = base;
  return { ...rest, type: 'command', command: hook.command, ...(hook.timeout ? { timeout: hook.timeout } : {}) };
};

// `entry` is what goes in the file: a new command entry, or a paused hook put
// back exactly as it was (any type, any extra keys).
function withHook(settings, hook, entry = commandEntry(hook)) {
  const hooks = isObj(settings.hooks) ? settings.hooks : {};
  const groups = Array.isArray(hooks[hook.event]) ? hooks[hook.event] : [];
  const gi = groups.findIndex(g => isObj(g) && Array.isArray(g.hooks) && str(g.matcher) === hook.matcher);
  const next = gi >= 0
    ? groups.map((g, i) => (i === gi ? { ...g, hooks: [...g.hooks, entry] } : g))
    : [...groups, { ...(hook.matcher ? { matcher: hook.matcher } : {}), hooks: [entry] }];
  return { ...settings, hooks: { ...hooks, [hook.event]: next } };
}

/** Is this exact entry already in the file under that event and matcher? (Resume twice, or after a crash.) */
function hasHook(settings, { event, matcher }, entry) {
  const groups = isObj(settings?.hooks) && Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  const same = JSON.stringify(entry);
  return groups.some(g => isObj(g) && str(g.matcher) === matcher && Array.isArray(g.hooks) && g.hooks.some(h => JSON.stringify(h) === same));
}

/** The raw entry at `at` and its group's matcher, for pausing. null if it isn't there. */
function hookEntry(settings, at) {
  const found = hookAt(settings, at);
  return found ? { event: at.event, matcher: str(found.group.matcher), entry: found.hook } : null;
}

function withoutHook(settings, at) {
  if (!hookAt(settings, at)) return settings;
  const groups = settings.hooks[at.event]
    .map((g, gi) => (gi === at.group ? { ...g, hooks: g.hooks.filter((_, hi) => hi !== at.hook) } : g))
    .filter((g, gi) => gi !== at.group || g.hooks.length);
  const { [at.event]: _gone, ...others } = settings.hooks;
  const hooks = groups.length ? { ...others, [at.event]: groups } : others;
  const { hooks: _old, ...rest } = settings;
  return Object.keys(hooks).length ? { ...rest, hooks } : rest;
}

// Same event and matcher: edit in place (keeps its position and any extra keys).
function replaceHook(settings, at, hook) {
  const found = hookAt(settings, at);
  if (!found) return settings;
  if (at.event !== hook.event || str(found.group.matcher) !== hook.matcher) return withHook(withoutHook(settings, at), hook);
  const groups = settings.hooks[at.event].map((g, gi) => (gi !== at.group ? g
    : { ...g, hooks: g.hooks.map((h, hi) => (hi === at.hook ? commandEntry(hook, h) : h)) }));
  return { ...settings, hooks: { ...settings.hooks, [at.event]: groups } };
}

// ---- hooks: writing

/**
 * Read a settings file, apply change(settings) and write it back, keeping a
 * one-time backup beside it (the same one the status line uses). `expect` is
 * { at, fp }: the hook the panel was looking at must still be there, unchanged.
 */
function changeHooks(named, change, expect = null) {
  // Through a symlinked settings file to the real one, rather than replacing the link.
  let file = named;
  try { file = fs.realpathSync(named); } catch { /* new file */ }
  const s = readSettings(file);
  if (s.state === 'unreadable') return { ok: false, error: `Couldn't read ${path.basename(file)}, so Shellby left it alone.` };
  if (expect) {
    const found = hookAt(s.data, expect.at);
    if (!found || fingerprint(found.group, found.hook) !== expect.fp) {
      return { ok: false, conflict: true, error: 'That hook changed on disk since this list was made. Rescan and try again.' };
    }
  }
  const next = change(s.data);
  if (str(s.raw).trim() && !fs.existsSync(`${file}.shellby-backup`)) fs.writeFileSync(`${file}.shellby-backup`, s.raw);
  writeJson(file, next);
  return { ok: true };
}

// ---- permission rules (what /permissions shows in the terminal)

// allow: never asks. ask: always asks, even when a mode wouldn't. deny: never
// lets it run. Claude Code checks deny first, then ask, then allow.
const RULE_LISTS = ['allow', 'ask', 'deny'];
const MAX_RULE = 500;
const MAX_RULE_ROWS = 1000;

// Tool, Tool(specifier) or an MCP name: Bash(npm run test:*), Read(./.env),
// WebFetch(domain:example.com), mcp__github, mcp__github__create_issue.
const RULE = /^[A-Za-z][\w-]*(\(.+\))?$/s;

// What a rule covers, as the end of "Claude doesn't ask before …".
const WHOLE_TOOL = {
  Bash: 'running any shell command', PowerShell: 'running any PowerShell command',
  Read: 'reading any file', Edit: 'editing any file', Write: 'writing any file',
  MultiEdit: 'editing any file', NotebookEdit: 'editing any notebook',
  Glob: 'searching for files', Grep: 'searching inside files',
  WebFetch: 'fetching any web page', WebSearch: 'searching the web',
  Skill: 'using any skill', Agent: 'starting any helper agent', Task: 'starting any helper agent',
};
const PATH_VERB = { Read: 'reading', Edit: 'editing', Write: 'writing', MultiEdit: 'editing', NotebookEdit: 'editing', Glob: 'searching', Grep: 'searching in' };

function shellTarget(kind, spec) {
  const prefix = spec.match(/^(.*?)(?::\*| \*)$/s);
  if (prefix && !prefix[1].includes('*')) return `running any ${kind} command that starts with "${prefix[1]}"`;
  if (spec.includes('*')) return `running any ${kind} command matching "${spec}" (* stands for anything)`;
  return `running the ${kind} command "${spec}"`;
}

function ruleTarget(rule) {
  const mcp = rule.match(/^mcp__([^_]+(?:_[^_]+)*?)(?:__(.+))?$/);
  if (mcp) {
    return !mcp[2] || mcp[2] === '*'
      ? `using any tool from the ${mcp[1]} MCP server`
      : `using the ${mcp[2]} tool from the ${mcp[1]} MCP server`;
  }
  const m = rule.match(/^([^(]+)(?:\((.*)\))?$/s);
  const tool = m ? m[1] : rule;
  const spec = m?.[2];
  if (spec === undefined || spec === '' || spec === '*') return WHOLE_TOOL[tool] || `using the ${tool} tool`;
  if (tool === 'Bash') return shellTarget('shell', spec);
  if (tool === 'PowerShell') return shellTarget('PowerShell', spec);
  if (PATH_VERB[tool]) return `${PATH_VERB[tool]} files matching "${spec}"`;
  if (tool === 'WebFetch') return spec.startsWith('domain:') ? `fetching pages from ${spec.slice(7)}` : `fetching "${spec}"`;
  if (tool === 'Skill') return `using the ${spec} skill`;
  if (tool === 'Agent' || tool === 'Task') return `handing work to the ${spec} agent`;
  return `using the ${tool} tool for "${spec}"`;
}

/** One plain sentence saying what a permission rule does. */
function explainRule(list, rule) {
  const what = ruleTarget(str(rule));
  if (list === 'deny') return `Claude is blocked from ${what}, even if you'd say yes.`;
  if (list === 'ask') return `Claude always asks you before ${what}, whatever your permission mode.`;
  return `Claude doesn't ask before ${what}.`;
}

function scanPermissions({ home, cwd } = {}) {
  const rules = [];
  const files = [];
  for (const { scope, file } of settingsFiles({ home, cwd })) {
    const s = readSettings(file);
    const perms = s.state === 'ok' && isObj(s.data.permissions) ? s.data.permissions : {};
    files.push({ scope, path: file, state: s.state, defaultMode: str(perms.defaultMode) || null });
    for (const list of RULE_LISTS) {
      const arr = Array.isArray(perms[list]) ? perms[list] : [];
      for (const rule of arr) {
        if (typeof rule !== 'string' || rules.length >= MAX_RULE_ROWS) continue;
        rules.push({ scope, path: file, list, rule: rule.slice(0, MAX_RULE), what: explainRule(list, rule) });
      }
    }
  }
  return { rules, files };
}

/** Checks a rule from the panel. { list, rule } or { error }. */
function validateRule(list, rule) {
  if (!RULE_LISTS.includes(list)) return { error: 'Pick allow, ask or deny.' };
  const r = str(rule).trim();
  if (!r) return { error: 'Type a rule, like Bash(npm run test:*) or Read(./secrets/**).' };
  if (r.length > MAX_RULE) return { error: 'That rule is too long.' };
  if (CONTROL_CHARS.test(r)) return { error: 'Keep the rule on one line.' };
  if (!RULE.test(r)) return { error: 'A rule is a tool name, maybe with what it applies to in brackets: Bash(git push:*), Edit(src/**), WebFetch(domain:github.com).' };
  return { list, rule: r };
}

function withRule(settings, list, rule) {
  const perms = isObj(settings.permissions) ? settings.permissions : {};
  const arr = Array.isArray(perms[list]) ? perms[list] : [];
  if (arr.includes(rule)) return settings;
  return { ...settings, permissions: { ...perms, [list]: [...arr, rule] } };
}

function withoutRule(settings, list, rule) {
  const perms = isObj(settings.permissions) ? settings.permissions : null;
  if (!perms || !Array.isArray(perms[list]) || !perms[list].includes(rule)) return settings;
  const left = perms[list].filter(r => r !== rule);
  const { [list]: _gone, ...others } = perms;
  const next = left.length ? { ...others, [list]: left } : others;
  const { permissions: _old, ...rest } = settings;
  return Object.keys(next).length ? { ...rest, permissions: next } : rest;
}

/** Same as changeHooks, for any change to a settings file (permissions included). */
function changeSettings(named, change) {
  return changeHooks(named, change, null);
}

// ---- memory (CLAUDE.md)

function fileInfo(file) {
  try {
    const st = fs.statSync(file);
    return st.isFile() ? { exists: true, size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch { return { exists: false, size: 0, mtimeMs: 0 }; }
}

function scanMemory({ home, cwd, ceiling = null } = {}) {
  const out = [];
  const add = (scope, file, always = false) => {
    const info = fileInfo(file);
    if (!info || (!info.exists && !always) || out.some(m => samePath(m.path, file))) return;
    out.push({ scope, path: file, ...info });
  };
  const rules = (scope, dir) => {
    for (const { file } of walkMd(dir).slice(0, MAX_RULES)) add(scope, file);
  };
  const inHome = !cwd || (home && samePath(cwd, home));
  if (home) {
    add('user', path.join(home, '.claude', 'CLAUDE.md'), true);
    rules('user-rule', path.join(home, '.claude', 'rules'));
  }
  if (!inHome) {
    const dotClaude = path.join(cwd, '.claude', 'CLAUDE.md');
    // Either spot works for a project; offer the root one when neither exists yet.
    add('project', path.join(cwd, 'CLAUDE.md'), !fileInfo(dotClaude)?.exists);
    add('project', dotClaude);
    add('local', path.join(cwd, 'CLAUDE.local.md'));
    rules('project-rule', path.join(cwd, '.claude', 'rules'));
    // Claude Code also loads CLAUDE.md from every folder above this one.
    let dir = path.dirname(cwd);
    // (`ceiling` stops the walk early: isolated test runs never look above their pretend home.)
    for (let i = 0; i < MAX_PARENTS && dir && dir !== path.dirname(dir); i++, dir = path.dirname(dir)) {
      add('parent', path.join(dir, 'CLAUDE.md'));
      if (ceiling && samePath(dir, ceiling)) break;
    }
  }
  return out;
}

// Follow a symlinked CLAUDE.md to the file it points at (dotfiles setups do this),
// so a save edits that file rather than replacing the link. The target must still
// be markdown: a planted CLAUDE.md -> ~/.ssh/id_rsa is neither read nor written.
function realMemoryPath(file) {
  let real = file;
  try { real = fs.realpathSync(file); } catch { /* doesn't exist yet: created as named */ }
  return /\.md$/i.test(real) ? real : null;
}

/** { ok, text, mtimeMs } — a file that doesn't exist yet reads as empty. */
function readMemory(named) {
  const file = realMemoryPath(named);
  if (!file) return { ok: false, error: "That isn't a markdown file, so Shellby won't open it." };
  const info = fileInfo(file);
  if (!info) return { ok: false, error: "That isn't a file." };
  if (!info.exists) return { ok: true, text: '', mtimeMs: 0 };
  if (info.size > MAX_MEMORY) return { ok: false, error: 'That file is too big to edit here. Open it in your editor instead.' };
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n/g, '\n'), mtimeMs: info.mtimeMs };
  } catch { return { ok: false, error: "Couldn't read that file." }; }
}

/**
 * Save a memory file, refusing if it changed on disk since it was read
 * (expectMtime, 0 for "didn't exist"). Keeps Windows line endings if it had them.
 */
function writeMemory(named, text, expectMtime) {
  const file = realMemoryPath(named);
  if (!file) return { ok: false, error: "That isn't a markdown file, so Shellby won't save it." };
  if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_MEMORY) return { ok: false, error: 'That is too much text for one memory file.' };
  const info = fileInfo(file);
  if (!info) return { ok: false, error: "That isn't a file." };
  if (info.mtimeMs !== expectMtime) {
    return { ok: false, conflict: true, error: 'This file changed on disk since you opened it. Reload to see the new version, or copy your text first.' };
  }
  let before = '';
  if (info.exists) { try { before = fs.readFileSync(file, 'utf8'); } catch { /* treat as LF, no BOM */ } }
  const bom = before.startsWith('﻿') ? '﻿' : '';
  const body = bom + (before.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.shellby-tmp`;
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  return { ok: true, mtimeMs: fs.statSync(file).mtimeMs };
}

// ---- together

function scanSetup({ home, cwd, plugins, ceiling } = {}) {
  const { hooks, files } = scanHooks({ home, cwd, plugins });
  return {
    hooks, settings: files, memory: scanMemory({ home, cwd, ceiling }),
    permissions: scanPermissions({ home, cwd }),
    events: HOOK_EVENTS, recipes: RECIPES, recipeGroups: RECIPE_GROUPS, scannedAt: Date.now(),
  };
}

module.exports = {
  HOOK_EVENTS, SCOPES, scanSetup, scanHooks, scanMemory, settingsFiles,
  validateHook, withHook, withoutHook, replaceHook, hookEntry, hasHook, changeHooks, readSettings,
  RULE_LISTS, scanPermissions, explainRule, validateRule, withRule, withoutRule, changeSettings,
  readMemory, writeMemory,
};
