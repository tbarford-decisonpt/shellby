const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { clampToDisplays, panelPosition } = require('../src/main/placement');
const { validate, loadSkins, BUILTIN_DIR } = require('../src/main/skins');
const { Config, CLI_MODE, MODES } = require('../src/main/config');
const { History } = require('../src/main/history');
const { claudeEnv, billingEnv, findClaude } = require('../src/main/claude-cli');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-test-'));

// ---- placement
const primary = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 1920, height: 1040 };

test('clamp: a window on an unplugged monitor comes home to the primary corner', () => {
  const r = clampToDisplays({ x: 5000, y: 300, width: 160, height: 120 }, [primary]);
  assert.deepEqual([r.x, r.y], [1920 - 160 - 24, 1040 - 120 - 24]);
});
test('clamp: a window hanging off an edge is pulled inside its own display', () => {
  const r = clampToDisplays({ x: 3800, y: 1000, width: 160, height: 120 }, [primary, second]);
  assert.deepEqual([r.x, r.y], [3840 - 160, 1040 - 120]);
});
test('panel sits left of the critter, or flips right when there is no room', () => {
  assert.deepEqual(panelPosition({ x: 1700, y: 900, width: 160, height: 120 }, { width: 440, height: 660 }, primary), { x: 1248, y: 360 });
  assert.equal(panelPosition({ x: 40, y: 900, width: 160, height: 120 }, { width: 440, height: 660 }, primary).x, 212);
});

// ---- skins
test('every built-in skin validates and shares the classic grid size', () => {
  const skins = loadSkins(tmp());
  assert.ok(skins.length >= 4);
  for (const s of skins) {
    assert.equal(s.source, 'builtin');
    assert.ok(s.pixels.length > 5, s.id);
  }
  const files = fs.readdirSync(BUILTIN_DIR);
  assert.equal(files.length, skins.length);
});
test('skins reject non-hex colours, oversized grids and unknown parts', () => {
  assert.ok(validate({ id: 'x', pixels: ['a'], palette: { a: 'red;}' } }).errors.length);
  assert.ok(validate({ id: 'x', pixels: Array(40).fill('a'), palette: { a: '#ffffff' } }).errors.length);
  const { skin } = validate({ id: 'x', pixels: ['ab'], palette: { a: '#ffffff' }, parts: { a: 'body', b: 'rocket' } });
  assert.deepEqual(skin.parts, { a: 'body' });
});
test('user skins override built-ins with the same id; broken files are skipped', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'classic.json'), JSON.stringify({ id: 'classic', name: 'Mine', pixels: ['a'], palette: { a: '#000000' } }));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{nope');
  const skins = loadSkins(dir);
  assert.equal(skins.find(s => s.id === 'classic').name, 'Mine');
  assert.ok(!skins.some(s => s.id === 'broken'));
});

// ---- config
test('config: defaults, bad mode reset, recent folders deduped case-insensitively', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ mode: 'yolo' }));
  const c = new Config(dir);
  assert.equal(c.get('mode'), 'ask');
  for (const d of ['C:\\a', 'C:\\b', 'c:\\A', 'C:\\c', 'C:\\d', 'C:\\e', 'C:\\f', 'C:\\g']) c.addRecentFolder(d);
  assert.equal(c.get('recentFolders').length, 6);
  assert.equal(c.get('recentFolders').filter(d => d.toLowerCase() === 'c:\\a').length, 1);
  assert.equal(new Config(dir).get('recentFolders')[0], 'C:\\g');
});
test('every UI mode maps to a Claude Code permission mode', () => {
  for (const m of MODES) assert.ok(CLI_MODE[m]);
  assert.equal(CLI_MODE.autonomous, 'bypassPermissions');
});

// ---- history
test('history: create, append (skipping transient items), load, remove', () => {
  const h = new History(tmp());
  const e = h.create({ title: 'x'.repeat(100), cwd: 'C:\\', mode: 'ask' });
  assert.ok(e.title.length <= 70);
  h.append(e.id, { kind: 'user', text: 'hi' });
  h.append(e.id, { kind: 'thinking' });
  h.append(e.id, { kind: 'usage', fiveHour: null });
  h.append(e.id, { kind: 'permission', requestId: 'r', input: { secret: 1 }, label: 'Ran' });
  const items = h.load(e.id);
  assert.deepEqual(items.map(i => i.kind), ['user', 'permission']);
  assert.equal(items[1].input, undefined);
  h.remove(e.id);
  assert.equal(h.list().length, 0);
});
test('history refuses path-traversal ids', () => {
  const h = new History(tmp());
  assert.throws(() => h.file('..\\..\\evil'), /bad session id/);
});

// ---- billing
const BILLING = { ANTHROPIC_API_KEY: 'sk', ANTHROPIC_AUTH_TOKEN: 't', ANTHROPIC_BASE_URL: 'u', CLAUDE_CODE_USE_BEDROCK: '1' };
test('claudeEnv leaves API keys and providers alone by default', () => {
  const env = claudeEnv({ PATH: 'x', ...BILLING }, { onlyPlan: false });
  assert.deepEqual(env, { PATH: 'x', ...BILLING, SHELLBY_OWNED: '1' }); // the marker tells the plugin's hooks to skip our own sessions
});
test('claudeEnv strips every variable that would switch to API billing when asked to use the plan', () => {
  const env = claudeEnv({ PATH: 'x', ...BILLING }, { onlyPlan: true });
  assert.deepEqual(env, { PATH: 'x', SHELLBY_OWNED: '1' });
});
test('billingEnv names only the billing variables that are actually set', () => {
  assert.deepEqual(billingEnv({ PATH: 'x', ANTHROPIC_API_KEY: 'sk', CLAUDE_CODE_USE_VERTEX: '' }), ['ANTHROPIC_API_KEY']);
  assert.deepEqual(billingEnv({ PATH: 'x' }), []);
});
test('findClaude honours SHELLBY_CLAUDE_PATH and returns null when missing', () => {
  const dir = tmp();
  const exe = path.join(dir, 'claude.exe');
  fs.writeFileSync(exe, '');
  assert.equal(findClaude({ SHELLBY_CLAUDE_PATH: exe }), exe);
  assert.equal(findClaude({ PATH: dir + '-nope' }), null);
});
