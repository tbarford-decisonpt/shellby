// Mods (src/main/mods.js): Claude Code plugins whose hooks are code modules.
// Reading them from disk, the plain-words list of what they can do, and the
// checks before one is made or removed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../src/main/mods');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-mods-')); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

function put(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof text === 'string' ? text : JSON.stringify(text));
  return file;
}
// A plugin folder; hooks defaults to one module, and null leaves hooks.json out.
function plugin(dir, { manifest = {}, hooks = { modules: ['./register.ts'] } } = {}) {
  put(path.join(dir, '.claude-plugin', 'plugin.json'), { name: path.basename(dir), version: '1.0.0', description: 'Says hello', ...manifest });
  if (hooks) put(path.join(dir, 'hooks', 'hooks.json'), hooks);
  return dir;
}
const skillsOf = home => path.join(home, '.claude', 'skills');
const names = list => list.map(m => m.name);

// ---- readMod

test('readMod: null when there is no plugin.json, the name is bad, or the path is not absolute', () => {
  const root = tmp();
  assert.equal(M.readMod(path.join(root, 'nothing')), null);
  assert.equal(M.readMod('relative/dir'), null);
  assert.equal(M.readMod(undefined), null);
  const bad = plugin(path.join(root, 'bad'), { manifest: { name: '../evil' } });
  assert.equal(M.readMod(bad), null);
  const nameless = plugin(path.join(root, 'nameless'), { manifest: { name: 42 } });
  assert.equal(M.readMod(nameless), null);
});

test('readMod: a plugin whose hooks are only shell commands is not a mod', () => {
  const root = tmp();
  const classic = plugin(path.join(root, 'classic'), { hooks: { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } } });
  assert.equal(M.readMod(classic), null);
  assert.equal(M.readMod(plugin(path.join(root, 'nohooks'), { hooks: null })), null);
  assert.equal(M.readMod(plugin(path.join(root, 'empty'), { hooks: { modules: [] } })), null);
  assert.equal(M.readMod(plugin(path.join(root, 'junk'), { hooks: { modules: [1, '', null] } })), null);
});

test('readMod: a valid mod carries its name, version, description, author, modules and test count', () => {
  const dir = plugin(path.join(tmp(), 'tidy'), { manifest: { author: 'Ada' }, hooks: { modules: ['./register.ts', './other.ts'] } });
  put(path.join(dir, 'register.test.ts'), '');
  const { stamp, ...rest } = M.readMod(dir);
  assert.deepEqual(rest, { name: 'tidy', version: '1.0.0', description: 'Says hello', author: 'Ada', modules: ['./register.ts', './other.ts'], tests: 1 });
  assert.ok(stamp > 0, 'the stamp is the latest file time');
});

test('readMod: author can be an object with a name', () => {
  const dir = plugin(path.join(tmp(), 'tidy'), { manifest: { author: { name: 'Grace', email: 'g@x.y' } } });
  assert.equal(M.readMod(dir).author, 'Grace');
  const none = plugin(path.join(tmp(), 'plain'), { manifest: {} });
  assert.equal(M.readMod(none).author, '');
});

test('readMod: counts *.test.ts and *.test.tsx but skips node_modules, .git and .claude-plugin', () => {
  const dir = plugin(path.join(tmp(), 'tidy'));
  put(path.join(dir, 'a.test.ts'), '');
  put(path.join(dir, 'src', 'b.test.tsx'), '');
  put(path.join(dir, 'src', 'plain.ts'), '');
  put(path.join(dir, 'a.test.js'), '');
  put(path.join(dir, 'node_modules', 'dep', 'x.test.ts'), '');
  put(path.join(dir, '.git', 'y.test.ts'), '');
  put(path.join(dir, '.claude-plugin', 'types', 'z.test.ts'), '');
  assert.equal(M.readMod(dir).tests, 2);
});

test('readMod: hooks in plugin.json can be a relative file or the config itself', () => {
  const root = tmp();
  const file = plugin(path.join(root, 'filed'), { manifest: { hooks: './config/hooks.json' }, hooks: null });
  put(path.join(file, 'config', 'hooks.json'), { modules: ['./m.ts'] });
  assert.deepEqual(M.readMod(file).modules, ['./m.ts']);
  const inline = plugin(path.join(root, 'inline'), { manifest: { hooks: { modules: ['./i.ts'] } }, hooks: null });
  assert.deepEqual(M.readMod(inline).modules, ['./i.ts']);
});

test('readMod: a hooks path that leaves the plugin folder is not followed', () => {
  const root = tmp();
  put(path.join(root, 'x.json'), { modules: ['./sneaky.ts'] });
  const dir = plugin(path.join(root, 'escape'), { manifest: { hooks: '../x.json' }, hooks: null });
  assert.equal(M.readMod(dir), null);
  const abs = plugin(path.join(root, 'abs'), { manifest: { hooks: path.join(root, 'x.json') }, hooks: null });
  assert.equal(M.readMod(abs), null);
});

test('readMod: control and bidi characters in the description are cleaned', () => {
  const dir = plugin(path.join(tmp(), 'tidy'), { manifest: { description: 'Hi\u0007 there\u202Eevil\n\nline\u200Btwo' } });
  const d = M.readMod(dir).description;
  assert.equal(d, 'Hi there evil line two');
  assert.doesNotMatch(d, /[\u0000-\u001f\u202e\u200b]/);
});

// ---- scanMods

test('scanMods: finds mods in ~/.claude/skills as name@skills-dir, from the user, on by default', () => {
  const home = tmp();
  plugin(path.join(skillsOf(home), 'tidy'));
  const [mod] = M.scanMods({ home });
  assert.equal(mod.kind, 'mod');
  assert.equal(mod.id, 'tidy@skills-dir');
  assert.equal(mod.source, 'user');
  assert.equal(mod.marketplace, 'skills-dir');
  assert.equal(mod.scope, 'user');
  assert.equal(mod.enabled, true);
  assert.equal(mod.path, path.join(skillsOf(home), 'tidy'));
});

test('scanMods: plain skills, classic-hook plugins and loose files are not mods', () => {
  const home = tmp();
  put(path.join(skillsOf(home), 'just-skill', 'SKILL.md'), '---\ndescription: x\n---\n');
  put(path.join(skillsOf(home), 'loose.md'), 'hello');
  plugin(path.join(skillsOf(home), 'classic'), { hooks: { hooks: {} } });
  plugin(path.join(skillsOf(home), 'real'));
  assert.deepEqual(names(M.scanMods({ home })), ['real']);
});

test('scanMods: the last settings file that names a mod decides whether it is on', () => {
  const home = tmp();
  plugin(path.join(skillsOf(home), 'tidy'));
  const id = 'tidy@skills-dir';
  const on = (...settings) => M.scanMods({ home, settings })[0].enabled;
  assert.equal(on(), true);
  assert.equal(on({ enabledPlugins: { [id]: false } }), false);
  assert.equal(on({ enabledPlugins: { [id]: false } }, { enabledPlugins: { [id]: true } }), true);
  assert.equal(on({ enabledPlugins: { [id]: true } }, {}, { enabledPlugins: { [id]: false } }), false);
  assert.equal(on({ enabledPlugins: { [id]: false } }, { enabledPlugins: { [id]: 'yes' } }), false, 'a non-boolean does not count');
});

test('scanMods: includes installed marketplace plugins that hold modules, with their own enabled flag', () => {
  const home = tmp();
  const root = tmp();
  const dirOn = plugin(path.join(root, 'on'));
  const dirOff = plugin(path.join(root, 'off'));
  const classic = plugin(path.join(root, 'classic'), { hooks: { hooks: {} } });
  const shadow = plugin(path.join(root, 'shadow'));
  const installed = [
    { id: 'on@shop', marketplace: 'shop', dir: dirOn, enabled: true, scope: 'project' },
    { id: 'off@shop', marketplace: 'shop', dir: dirOff, enabled: false },
    { id: 'classic@shop', marketplace: 'shop', dir: classic, enabled: true },
    { id: 'shadow@skills-dir', marketplace: 'skills-dir', dir: shadow, enabled: true },
    { id: 'bad', dir: 5 },
  ];
  const mods = M.scanMods({ home, installed });
  assert.deepEqual(names(mods), ['off', 'on']);
  const on = mods.find(m => m.name === 'on');
  assert.equal(on.source, 'plugin');
  assert.equal(on.marketplace, 'shop');
  assert.equal(on.scope, 'project');
  assert.equal(on.enabled, true);
  assert.equal(mods.find(m => m.name === 'off').enabled, false);
  assert.equal(mods.find(m => m.name === 'off').scope, 'user');
});

test('scanMods: a plugin a conversation reported is a session mod when it came from --plugin-dir', () => {
  const home = tmp();
  const dir = plugin(path.join(tmp(), 'probe'));
  const [mod] = M.scanMods({ home, loaded: [{ name: 'probe', path: dir, source: 'probe@inline' }] });
  assert.equal(mod.id, 'probe@inline');
  assert.equal(mod.source, 'session');
  assert.equal(mod.enabled, true);
  const [named] = M.scanMods({ home, loaded: [{ name: 'probe', path: dir }] });
  assert.equal(named.id, 'probe@inline');
  const [shop] = M.scanMods({ home, loaded: [{ name: 'probe', path: dir, source: 'probe@shop' }] });
  assert.equal(shop.source, 'plugin');
  assert.equal(M.scanMods({ home, loaded: [{ name: 'x', path: 'relative' }, null] }).length, 0);
});

test('scanMods: one folder is listed once, and the list is sorted by name', () => {
  const home = tmp();
  plugin(path.join(skillsOf(home), 'zeta'));
  const alpha = plugin(path.join(skillsOf(home), 'Alpha'));
  plugin(path.join(skillsOf(home), 'mid'));
  const mods = M.scanMods({
    home,
    installed: [{ id: 'Alpha@shop', marketplace: 'shop', dir: alpha, enabled: true }],
    loaded: [{ name: 'Alpha', path: alpha, source: 'Alpha@inline' }],
  });
  assert.deepEqual(names(mods), ['Alpha', 'mid', 'zeta']);
  assert.equal(mods[0].source, 'user', 'the first way it was found wins');
});

test('scanMods: no home, or no skills folder, is an empty list', () => {
  assert.deepEqual(M.scanMods({}), []);
  assert.deepEqual(M.scanMods({ home: tmp() }), []);
  assert.deepEqual(M.scanMods(), []);
});

// ---- isEnabled, splitList

test('isEnabled: falls back when no settings name it, and ignores junk', () => {
  assert.equal(M.isEnabled('a@b'), true);
  assert.equal(M.isEnabled('a@b', [], false), false);
  assert.equal(M.isEnabled('a@b', [null, 'x', { enabledPlugins: null }, { enabledPlugins: { 'a@b': 0 } }], false), false);
  assert.equal(M.isEnabled('a@b', [{ enabledPlugins: { 'a@b': true } }], false), true);
});

test('splitList: splits on commas, but not inside braces or brackets', () => {
  assert.deepEqual(M.splitList('a, b{x=y,z}, c'), ['a', 'b{x=y,z}', 'c']);
  assert.deepEqual(M.splitList('tool.call{tool=[Bash,Read]},session.start'), ['tool.call{tool=[Bash,Read]}', 'session.start']);
  assert.deepEqual(M.splitList(' , ,x, '), ['x']);
  assert.deepEqual(M.splitList(''), []);
  assert.deepEqual(M.splitList('a}, b'), ['a}', 'b'], 'a stray closer does not break the split');
});

// ---- parseValidate

const REPORT = {
  success: true, strict: false, target: 'C:\\Users\\x\\.claude\\skills\\probe',
  manifest: { file: 'plugin.json', type: 'plugin', errors: [], warnings: [{ path: 'author', message: 'No author information provided...', code: null }], notes: [] },
  contents: [{
    file: 'hooks.json', type: 'hooks', errors: [], warnings: [],
    notes: ['./register.ts hooks: session.start, command.run{command=probe}', './register.ts calls: $.command.register, $.ui.log, $.ui.status, $.ui.toast'],
  }],
};

test('parseValidate: reads what claude plugin validate --json prints for a passing mod', () => {
  assert.deepEqual(M.parseValidate(REPORT), {
    ok: true,
    errors: [],
    warnings: ['author: No author information provided...'],
    hooks: ['session.start', 'command.run{command=probe}'],
    calls: ['$.command.register', '$.ui.log', '$.ui.status', '$.ui.toast'],
    callsKnown: true,
  });
});

test('parseValidate: a failing report keeps its errors, and ok is false', () => {
  const bad = {
    success: false,
    manifest: { errors: [{ path: 'name', message: 'Required' }, 'plain text error'], warnings: [], notes: [] },
    contents: [{ errors: [{ message: 'module not found' }], warnings: [], notes: [] }],
  };
  const r = M.parseValidate(bad);
  assert.equal(r.ok, false);
  assert.deepEqual(r.errors, ['name: Required', 'plain text error', 'module not found']);
  assert.deepEqual(r.hooks, []);
  assert.deepEqual(r.calls, []);
  assert.equal(r.callsKnown, false, 'no calls note, so what it can do is unknown');
});

test('parseValidate: the same hook named by two modules is listed once', () => {
  const r = M.parseValidate({ success: true, contents: [{ notes: ['./a.ts hooks: session.start', './b.ts hooks: session.start, turn.step'] }] });
  assert.deepEqual(r.hooks, ['session.start', 'turn.step']);
});

test('parseValidate: null for anything that is not that report', () => {
  for (const v of [null, undefined, 'text', 5, [], {}, { success: 'yes' }, { ok: true }]) assert.equal(M.parseValidate(v), null, JSON.stringify(v));
});

// ---- powers

test('powers: says in plain words what calls and hooks allow, worst first', () => {
  const p = M.powers({ hooks: ['tool.call{tool=Bash}', 'session.start'], calls: ['$.ui.log', '$.process.run', '$.fs.read'] });
  assert.deepEqual(p.list, [
    { text: 'Runs programs on your PC', risk: 'high' },
    { text: "Can block or change what Claude's tools do", risk: 'medium' },
    { text: 'Reads files on your PC', risk: 'medium' },
    { text: 'Shows messages, toasts and status lines', risk: 'low' },
  ]);
  assert.deepEqual(p.other, []);
});

test('powers: writing files and using the network are high, reading files is medium', () => {
  const risk = call => M.powers({ calls: [call] }).list[0].risk;
  assert.equal(risk('$.fs.write'), 'high');
  assert.equal(risk('$.fs.remove'), 'high');
  assert.equal(risk('$.fs.read'), 'medium');
  assert.equal(risk('$.http.fetch'), 'high');
  assert.equal(risk('$.process.spawn'), 'high');
  assert.equal(risk('$.mcp.call (via tell)'), 'medium', "MCP tools can be anyone's, Shellby's among them");
  assert.equal(M.powers({ hooks: ['classic.PermissionRequest'] }).list[0].risk, 'high');
  assert.equal(M.powers({ hooks: ['tool.call'] }).list[0].risk, 'medium');
});

test('powers: each power is listed once, and calls nothing describes go to other', () => {
  const p = M.powers({ calls: ['$.process.run', '$.process.spawn', '$.mystery.thing', '$.ui.log', '$.ui.toast'], hooks: ['not.a.known.hook'] });
  assert.equal(p.list.filter(x => x.text === 'Runs programs on your PC').length, 1);
  assert.equal(p.list.filter(x => x.risk === 'low').length, 1);
  assert.deepEqual(p.other, ['$.mystery.thing'], 'unknown hooks are not "other": only calls are');
});

test('powers: nothing in, nothing out', () => {
  assert.deepEqual(M.powers(), { list: [], other: [] });
});

// ---- summarizeTest

test('summarizeTest: a clean run is ok with its pass count', () => {
  const r = M.summarizeTest({ ok: true, stdout: 'running\n3 passed\n0 failed\n', stderr: '' });
  assert.equal(r.ok, true);
  assert.equal(r.noTests, false);
  assert.equal(r.passed, 3);
  assert.equal(r.failed, 0);
  assert.deepEqual(r.tail, ['running', '3 passed', '0 failed']);
});

test('summarizeTest: no test files is not ok, and says so', () => {
  const r = M.summarizeTest({ ok: true, stdout: 'claude plugin test: no *.test.ts or *.test.tsx under C:\\x\\tidy\n' });
  assert.equal(r.noTests, true);
  assert.equal(r.ok, false);
  assert.equal(r.passed, null);
  assert.equal(r.failed, null);
});

test('summarizeTest: a failing run reports its failure count', () => {
  const r = M.summarizeTest({ ok: false, stdout: '2 pass\n1 fail\n', stderr: 'error: boom' });
  assert.equal(r.ok, false);
  assert.equal(r.passed, 2);
  assert.equal(r.failed, 1);
  assert.equal(r.tail.at(-1), 'error: boom');
});

test('summarizeTest: ANSI colour is stripped and the tail is the last 30 lines, each capped', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `\x1b[32mline ${i}\x1b[0m`);
  const r = M.summarizeTest({ ok: true, stdout: lines.join('\r\n') });
  assert.equal(r.tail.length, 30);
  assert.equal(r.tail[0], 'line 20');
  assert.equal(r.tail.at(-1), 'line 49');
  assert.equal(M.summarizeTest({ ok: true, stdout: 'x'.repeat(1000) }).tail[0].length, 300);
  assert.deepEqual(M.summarizeTest().tail, []);
});

// ---- checkNewName

test('checkNewName: accepts kebab-case and trims it', () => {
  assert.deepEqual(M.checkNewName('tidy-commits'), { ok: true, name: 'tidy-commits' });
  assert.deepEqual(M.checkNewName('  a1  '), { ok: true, name: 'a1' });
  assert.deepEqual(M.checkNewName('x'), { ok: true, name: 'x' });
});

test('checkNewName: refuses empty, uppercase, spaces, a leading or trailing dash, and a name in use', () => {
  for (const bad of ['', '   ', undefined, 42, 'Tidy', 'two words', '-lead', 'trail-', 'under_score', 'a'.repeat(65)]) {
    const r = M.checkNewName(bad);
    assert.equal(r.ok, false, String(bad));
    assert.ok(r.error);
  }
  const taken = M.checkNewName('tidy', [{ name: 'tidy' }]);
  assert.equal(taken.ok, false);
  assert.match(taken.error, /already a mod called tidy/);
});

// ---- removalTarget

const userMod = (home, name) => ({ kind: 'mod', name, source: 'user', path: path.join(skillsOf(home), name) });

test('removalTarget: one of your own, right inside ~/.claude/skills, is fine', () => {
  const home = tmp();
  plugin(path.join(skillsOf(home), 'tidy'));
  assert.deepEqual(M.removalTarget(userMod(home, 'tidy'), home), { ok: true, target: path.join(skillsOf(home), 'tidy') });
});

test('removalTarget: a marketplace plugin is pointed at Get more', () => {
  const r = M.removalTarget({ kind: 'mod', name: 'x', source: 'plugin', marketplace: 'shop', path: '/p' }, tmp());
  assert.equal(r.ok, false);
  assert.equal(r.plugin, true);
  assert.match(r.error, /shop/);
});

test('removalTarget: leaves alone session mods, non-mods, and folders that are not directly in skills', () => {
  const home = tmp();
  const elsewhere = plugin(path.join(tmp(), 'tidy'));
  assert.equal(M.removalTarget(null, home).ok, false);
  assert.equal(M.removalTarget({ kind: 'skill', name: 'x' }, home).ok, false);
  assert.equal(M.removalTarget({ kind: 'mod', name: 'x', source: 'session', path: elsewhere }, home).ok, false);
  assert.equal(M.removalTarget({ kind: 'mod', name: 'x', source: 'user' }, home).ok, false);
  assert.equal(M.removalTarget({ kind: 'mod', name: 'tidy', source: 'user', path: elsewhere }, home).ok, false);
  assert.equal(M.removalTarget(userMod(home, 'tidy'), null).ok, false);
  const nested = plugin(path.join(skillsOf(home), 'group', 'inner'));
  assert.equal(M.removalTarget({ kind: 'mod', name: 'inner', source: 'user', path: nested }, home).ok, false);
});

test('removalTarget: a folder that is already gone says so', () => {
  const home = tmp();
  fs.mkdirSync(skillsOf(home), { recursive: true });
  const r = M.removalTarget(userMod(home, 'ghost'), home);
  assert.equal(r.ok, false);
  assert.match(r.error, /already gone/);
});

test('removalTarget: a linked folder is refused and left in place', t => {
  const home = tmp();
  const elsewhere = plugin(path.join(tmp(), 'tidy'));
  fs.mkdirSync(skillsOf(home), { recursive: true });
  const link = path.join(skillsOf(home), 'tidy');
  try { fs.symlinkSync(elsewhere, link, 'junction'); } catch { t.skip('cannot create a link here'); return; }
  const r = M.removalTarget(userMod(home, 'tidy'), home);
  assert.equal(r.ok, false);
  assert.match(r.error, /link/);
  assert.ok(fs.existsSync(path.join(elsewhere, '.claude-plugin', 'plugin.json')));
});

// ---- buildPrompt

test('buildPrompt: names the mod, where it goes, the authoring skill and the checks to run', () => {
  const home = path.join(tmp(), 'home');
  const p = M.buildPrompt({ name: 'tidy', idea: '  toasts when a turn ends ', home });
  const dir = path.join(home, '.claude', 'skills', 'tidy');
  assert.match(p, /called "tidy" that toasts when a turn ends/);
  assert.ok(p.includes(dir));
  assert.match(p, /plugin-authoring/);
  assert.match(p, /claude plugin validate/);
  assert.match(p, /claude plugin test/);
  assert.match(p, /"name": "tidy"/);
});

test('buildPrompt: says how a mod can make Shellby react, and that it must not depend on him', () => {
  const p = M.buildPrompt({ name: 'tidy', idea: 'cheers when CI goes green', home: tmp() });
  assert.match(p, /\$\.mcp\.call\('plugin:shellby:shellby'/);
  assert.match(p, /say.*celebrate.*wear.*status/);
  assert.match(p, /https:\/\/github\.com\/x-salmon\/shellby\/blob\/main\/docs\/MODS\.md/, 'a link that works from any folder');
});

test('buildPrompt: a missing idea still gives a usable first line', () => {
  assert.match(M.buildPrompt({ name: 'x', idea: '', home: tmp() }), /that does something useful/);
});

// ---- stamp, enabledWhere, problems, line budget

test('readMod: the stamp moves when a file of the mod changes, but not for node_modules', () => {
  const dir = plugin(path.join(tmp(), 'tidy'));
  const code = put(path.join(dir, 'register.ts'), 'a');
  const before = M.readMod(dir).stamp;
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(code, later, later);
  assert.ok(M.readMod(dir).stamp > before);
  const ignored = put(path.join(dir, 'node_modules', 'x.js'), 'x');
  const far = new Date(Date.now() + 3600000);
  fs.utimesSync(ignored, far, far);
  assert.ok(M.readMod(dir).stamp < far.getTime(), 'a file under node_modules does not move it');
});

test('enabledWhere: says which settings file decided, or null for the default', () => {
  const id = 'tidy@skills-dir';
  assert.deepEqual(M.enabledWhere(id, []), { on: true, from: null });
  assert.deepEqual(M.enabledWhere(id, [{ enabledPlugins: { [id]: false } }]), { on: false, from: 'user' });
  assert.deepEqual(M.enabledWhere(id, [{ enabledPlugins: { [id]: false } }, { enabledPlugins: { [id]: true } }]), { on: true, from: 'project' });
  assert.deepEqual(M.enabledWhere(id, [{}, {}, { enabledPlugins: { [id]: false } }]), { on: false, from: 'local' });
  assert.deepEqual(M.enabledWhere(id, [], false), { on: false, from: null });
});

test('scanMods: setBy names the settings scope that decided, and problem is null for a normal mod', () => {
  const home = tmp();
  plugin(path.join(skillsOf(home), 'tidy'));
  const [mod] = M.scanMods({ home, settings: [{}, { enabledPlugins: { 'tidy@skills-dir': false } }] });
  assert.equal(mod.enabled, false);
  assert.equal(mod.setBy, 'project');
  assert.equal(mod.problem, null);
  assert.equal(typeof mod.stamp, 'number');
  assert.equal(M.scanMods({ home })[0].setBy, null);
});

test('scanMods: a folder whose name differs from its manifest name is listed with a problem', () => {
  const home = tmp();
  plugin(path.join(skillsOf(home), 'folder-name'), { manifest: { name: 'other-name' } });
  const [mod] = M.scanMods({ home });
  assert.equal(mod.name, 'other-name');
  assert.equal(typeof mod.problem, 'string');
  assert.match(mod.problem, /folder-name/);
  assert.match(mod.problem, /other-name/);
});

test('scanMods: two folders claiming one manifest name both get a problem', () => {
  const home = tmp();
  plugin(path.join(skillsOf(home), 'one'), { manifest: { name: 'dup' } });
  plugin(path.join(skillsOf(home), 'two'), { manifest: { name: 'dup' } });
  const mods = M.scanMods({ home });
  assert.equal(mods.length, 2);
  assert.ok(mods.every(m => typeof m.problem === 'string' && m.problem));
});

test('modLineAllowed: the first 20 lines a minute show, then one last note, then they are dropped', () => {
  const budget = new Map();
  const t0 = 1000000;
  const got = Array.from({ length: 23 }, () => M.modLineAllowed(budget, 'probe', t0));
  assert.equal(M.LINE_BUDGET, 20);
  assert.deepEqual(got.slice(0, 20), Array(20).fill('show'));
  assert.equal(got[20], 'last');
  assert.deepEqual(got.slice(21), ['drop', 'drop']);
});

test('modLineAllowed: each plugin has its own budget, and a minute later it starts over', () => {
  const budget = new Map();
  for (let i = 0; i < 25; i++) M.modLineAllowed(budget, 'noisy', 0);
  assert.equal(M.modLineAllowed(budget, 'quiet', 0), 'show');
  assert.equal(M.modLineAllowed(budget, 'noisy', 59999), 'drop');
  assert.equal(M.modLineAllowed(budget, 'noisy', 60000), 'show');
});

test('shownPath: home becomes ~ and control characters are removed', () => {
  assert.equal(M.shownPath('C:\\Users\\x\\.claude\\skills\\tidy', 'C:\\Users\\x'), '~\\.claude\\skills\\tidy');
  assert.equal(M.shownPath('D:\\other\\tidy', 'C:\\Users\\x'), 'D:\\other\\tidy');
  assert.equal(M.shownPath('C:\\a\nb', null), 'C:\\a b');
});
