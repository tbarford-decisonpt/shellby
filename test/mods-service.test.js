// The Toolbox's Mods service (src/main/mods-service.js): check, turn on and off,
// run tests, remove, and draft a new one, against fakes for the Toolbox, the
// Skill Shop, the confirm window and the Claude Code CLI.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createModsService } = require('../src/main/mods-service');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-mods-svc-')); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });

const mod = (over = {}) => ({
  kind: 'mod', id: 'tidy@skills-dir', name: 'tidy', version: '1.0.0', description: '', author: '', modules: ['./register.ts'], tests: 2,
  stamp: 100, setBy: null, problem: null, source: 'user', marketplace: 'skills-dir', scope: 'user', enabled: false, path: path.join(os.tmpdir(), 'nowhere', 'tidy'), ...over,
});

const report = ({ success = true, errors = [], calls = ['$.ui.log'], hooks = ['session.start'] } = {}) => JSON.stringify({
  success, manifest: { errors, warnings: [], notes: [] },
  contents: [{ errors: [], warnings: [], notes: [`./register.ts hooks: ${hooks.join(', ')}`, `./register.ts calls: ${calls.join(', ')}`] }],
});
const RISKY = report({ calls: ['$.process.run', '$.ui.log'] });

function rig(over = {}) {
  const log = { warns: [], warn: (...a) => log.warns.push(a) };
  const tb = { current: { mods: over.mods || [mod()] }, rescans: [], rescan(opts) { this.rescans.push(opts); } };
  const shop = {
    calls: [], listed: over.known ?? true,
    known(id) { this.calls.push(['known', id]); return this.listed; },
    invalidate() { this.calls.push(['invalidate']); },
    async list() { this.calls.push(['list']); this.listed = true; },
    async setEnabled(id, on) { this.calls.push(['setEnabled', id, on]); return over.setResult || { ok: true }; },
  };
  const asks = [];
  const claude = [];
  const trashed = [];
  const answers = over.answers ? [...over.answers] : [0];
  const deps = {
    toolbox: () => tb,
    shop: () => (over.noShop ? null : shop),
    blocked: over.blocked,
    askOnce: async spec => { asks.push(spec); if (over.onAsk) over.onAsk(tb); return answers.length > 1 ? answers.shift() : answers[0]; },
    runClaude: async (args, ms) => { claude.push({ args, ms }); return typeof over.claude === 'function' ? over.claude(args) : { ok: true, stdout: over.stdout ?? report(), stderr: '' }; },
    uninstallPlugin: async id => ({ ok: true, uninstalled: id }),
    trash: async p => { trashed.push(p); if (over.trashFails) throw new Error('locked'); },
    openFolder: dir => ({ ok: true, opened: dir }),
    reveal: dir => { rig.revealed = dir; },
    home: over.home || tmp(),
    log,
  };
  return { svc: createModsService(deps), tb, shop, asks, claude, trashed, log, deps };
}

// ---- check

test('check: parses the validate report and adds what the mod can do', async () => {
  const { svc, claude } = rig({ stdout: RISKY });
  const r = await svc.check('tidy@skills-dir');
  assert.equal(r.ok, true);
  assert.equal(r.id, 'tidy@skills-dir');
  assert.equal(r.report.ok, true);
  assert.deepEqual(r.report.hooks, ['session.start']);
  assert.equal(r.report.powers[0].risk, 'high');
  assert.equal(r.report.powers[0].text, 'Runs programs on your PC');
  assert.deepEqual(r.report.other, []);
  assert.deepEqual(claude[0].args, ['plugin', 'validate', '--json', mod().path]);
});

test('check: a report from a mod with problems still comes back, because the CLI exits 1 with it', async () => {
  const { svc } = rig({ claude: () => ({ ok: false, stdout: report({ success: false, errors: [{ message: 'module not found' }] }), stderr: '' }) });
  const r = await svc.check('tidy@skills-dir');
  assert.equal(r.ok, true);
  assert.equal(r.report.ok, false);
  assert.deepEqual(r.report.errors, ['module not found']);
});

test('check: output that is not a report says to bring Claude Code up to date, and logs it', async () => {
  const { svc, log } = rig({ stdout: 'error: unknown command validate' });
  const r = await svc.check('tidy@skills-dir');
  assert.equal(r.ok, false);
  assert.match(r.error, /up to date/);
  assert.equal(log.warns.length, 1);
});

test('check: no Claude Code, and a mod that is not in the Toolbox', async () => {
  const none = rig({ claude: () => ({ ok: false, notInstalled: true, stdout: '' }) });
  assert.match((await none.svc.check('tidy@skills-dir')).error, /needs Claude Code/);
  const r = await rig().svc.check('ghost@skills-dir');
  assert.equal(r.ok, false);
  assert.match(r.error, /isn't in the Toolbox/);
  assert.equal((await rig().svc.check(undefined)).ok, false);
});

// ---- setEnabled: on

test('setEnabled on: asks once, with danger when the mod can run programs, then turns it on and rescans', async () => {
  const { svc, asks, shop, tb } = rig({ stdout: RISKY });
  const r = await svc.setEnabled('tidy@skills-dir', true);
  assert.equal(r.ok, true);
  assert.equal(r.toolbox, tb.current);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].danger, true);
  assert.equal(asks[0].buttons[0].style, 'danger');
  assert.match(asks[0].title, /tidy/);
  assert.match(asks[0].detail, /Runs programs on your PC/);
  assert.deepEqual(shop.calls.at(-1), ['setEnabled', 'tidy@skills-dir', true]);
  assert.deepEqual(tb.rescans, [{ plugins: false }]);
});

test('setEnabled on: the question is always a danger one, even for a mod with only low-risk powers', async () => {
  const { svc, asks } = rig();
  assert.equal((await svc.setEnabled('tidy@skills-dir', true)).ok, true);
  assert.equal(asks[0].danger, true);
  assert.equal(asks[0].buttons[0].style, 'danger');
  assert.doesNotMatch(asks[0].detail, /couldn't say what it reaches for/, 'the report listed its calls');
});

test("setEnabled on: a report with no calls note says Claude Code couldn't say what it reaches for", async () => {
  const noCalls = JSON.stringify({ success: true, manifest: { errors: [], warnings: [], notes: [] }, contents: [] });
  const { svc, asks } = rig({ stdout: noCalls });
  await svc.setEnabled('tidy@skills-dir', true);
  assert.match(asks[0].detail, /couldn't say what it reaches for/);
});

test('setEnabled on: Cancel changes nothing', async () => {
  const { svc, shop, tb } = rig({ answers: [1] });
  const r = await svc.setEnabled('tidy@skills-dir', true);
  assert.deepEqual(r, { ok: false, cancelled: true });
  assert.equal(shop.calls.some(c => c[0] === 'setEnabled'), false);
  assert.deepEqual(tb.rescans, []);
});

test('setEnabled on: another question already open reports busy rather than cancelled', async () => {
  const { svc, shop } = rig({ answers: [null] });
  const r = await svc.setEnabled('tidy@skills-dir', true);
  assert.equal(r.ok, false);
  assert.equal(r.busy, true);
  assert.equal(shop.calls.some(c => c[0] === 'setEnabled'), false);
});

test('setEnabled on: a mod Claude Code would not load is refused without asking', async () => {
  const { svc, asks, shop } = rig({ stdout: report({ success: false, errors: [{ message: 'bad hook' }] }) });
  const r = await svc.setEnabled('tidy@skills-dir', true);
  assert.equal(r.ok, false);
  assert.match(r.error, /wouldn't load it: bad hook/);
  assert.ok(r.report);
  assert.equal(asks.length, 0);
  assert.equal(shop.calls.some(c => c[0] === 'setEnabled'), false);
});

test('setEnabled on: a mod that changed while the question was open is not turned on', async () => {
  const { svc, shop } = rig({ onAsk: tb => { tb.current = { mods: [mod({ modules: ['./other.ts'] })] }; } });
  const r = await svc.setEnabled('tidy@skills-dir', true);
  assert.equal(r.ok, false);
  assert.match(r.error, /changed while you were deciding/);
  assert.equal(shop.calls.some(c => c[0] === 'setEnabled'), false);
});

test('setEnabled on: a mod that vanished while the question was open is not turned on either', async () => {
  const { svc } = rig({ onAsk: tb => { tb.current = { mods: [] }; } });
  assert.match((await svc.setEnabled('tidy@skills-dir', true)).error, /changed while you were deciding/);
});

test('setEnabled on: one the shop has not listed yet is refreshed before it is switched', async () => {
  const { svc, shop } = rig({ known: false });
  assert.equal((await svc.setEnabled('tidy@skills-dir', true)).ok, true);
  const names = shop.calls.map(c => c[0]).filter(n => n !== 'known');
  assert.deepEqual(names, ['invalidate', 'list', 'setEnabled']);
});

test('setEnabled on: a list that was already under way gets one more try before giving up', async () => {
  const { svc, shop } = rig({ known: false });
  let lists = 0;
  shop.list = async function () { this.calls.push(['list']); if (++lists === 2) this.listed = true; };
  assert.equal((await svc.setEnabled('tidy@skills-dir', true)).ok, true);
  assert.equal(lists, 2);
  assert.equal(shop.calls.filter(c => c[0] === 'invalidate').length, 2);
  assert.deepEqual(shop.calls.at(-1), ['setEnabled', 'tidy@skills-dir', true]);
});

test("setEnabled on: a shop that still doesn't know it says Claude Code doesn't list it, and switches nothing", async () => {
  const { svc, shop, tb } = rig({ known: false });
  shop.list = async function () { this.calls.push(['list']); };
  const r = await svc.setEnabled('tidy@skills-dir', true);
  assert.equal(r.ok, false);
  assert.match(r.error, /doesn't list tidy/);
  assert.equal(shop.calls.some(c => c[0] === 'setEnabled'), false);
  assert.deepEqual(tb.rescans, []);
});

test('setEnabled on: a failed second listing surfaces its own error', async () => {
  const { svc, shop } = rig({ known: false });
  let n = 0;
  shop.list = async function () { this.calls.push(['list']); return ++n === 2 ? { ok: false, error: 'claude plugin list failed' } : { ok: true }; };
  const r = await svc.setEnabled('tidy@skills-dir', true);
  assert.deepEqual(r, { ok: false, error: 'claude plugin list failed' });
});

test('setEnabled: a mod with a problem is refused with that problem, after the already-in-that-state check', async () => {
  const problem = 'Its folder is called a but its plugin.json calls it b. Rename one to match.';
  const { svc, asks, shop } = rig({ mods: [mod({ problem })] });
  assert.deepEqual(await svc.setEnabled('tidy@skills-dir', true), { ok: false, error: problem });
  assert.equal(asks.length + shop.calls.length, 0);
  const same = rig({ mods: [mod({ problem, enabled: true })] });
  assert.equal((await same.svc.setEnabled('tidy@skills-dir', true)).already, true);
});

test('setEnabled: a mod switched in the project settings is refused, naming the file and enabledPlugins', async () => {
  for (const [setBy, file] of [['project', 'settings.json'], ['local', 'settings.local.json']]) {
    const { svc, asks, shop } = rig({ mods: [mod({ setBy, enabled: false })] });
    const r = await svc.setEnabled('tidy@skills-dir', true);
    assert.equal(r.ok, false, setBy);
    assert.ok(r.error.includes(file), r.error);
    assert.match(r.error, /enabledPlugins/);
    assert.equal(asks.length + shop.calls.length, 0);
  }
  const user = rig({ mods: [mod({ setBy: 'user' })] });
  assert.equal((await user.svc.setEnabled('tidy@skills-dir', true)).ok, true);
});

test('setEnabled on: a mod whose files changed (stamp) while the question was open is not turned on', async () => {
  const { svc, shop } = rig({ onAsk: tb => { tb.current = { mods: [mod({ stamp: 999 })] }; } });
  assert.match((await svc.setEnabled('tidy@skills-dir', true)).error, /changed while you were deciding/);
  assert.equal(shop.calls.some(c => c[0] === 'setEnabled'), false);
});

test('check: carries the stamp of the files it checked', async () => {
  const { svc } = rig({ mods: [mod({ stamp: 4242 })] });
  assert.equal((await svc.check('tidy@skills-dir')).stamp, 4242);
});

test('check, setEnabled, runTests and draft return what blocked() says first; remove does not ask it', async () => {
  const block = { ok: false, error: 'Busy.' };
  const home = tmp();
  const dir = path.join(home, '.claude', 'skills', 'tidy');
  fs.mkdirSync(dir, { recursive: true });
  const { svc, claude, asks, trashed } = rig({ home, mods: [mod({ path: dir })], blocked: () => block });
  assert.equal(await svc.check('tidy@skills-dir'), block);
  assert.equal(await svc.setEnabled('tidy@skills-dir', true), block);
  assert.equal(await svc.runTests('tidy@skills-dir'), block);
  assert.equal(svc.draft({ name: 'fresh', idea: 'x' }), block);
  assert.equal(claude.length, 0);
  assert.equal(asks.length, 0, 'nothing was asked while blocked');
  assert.equal((await svc.remove('tidy@skills-dir')).ok, true);
  assert.equal(asks.length, 1, 'remove goes ahead and asks');
  assert.deepEqual(trashed, [dir]);
});

test('setEnabled on: a failure from the shop is passed on and the Toolbox is not rescanned', async () => {
  const { svc, tb } = rig({ setResult: { ok: false, error: 'nope' } });
  const r = await svc.setEnabled('tidy@skills-dir', true);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'nope');
  assert.deepEqual(tb.rescans, []);
});

test('setEnabled: a session mod has no switch, and blocked or unknown ones are refused', async () => {
  const session = rig({ mods: [mod({ id: 'probe@inline', name: 'probe', source: 'session', enabled: true })] });
  assert.match((await session.svc.setEnabled('probe@inline', false)).error, /--plugin-dir/);
  const blocked = rig({ blocked: () => ({ ok: false, error: 'Busy.' }) });
  assert.deepEqual(await blocked.svc.setEnabled('tidy@skills-dir', true), { ok: false, error: 'Busy.' });
  assert.equal((await rig().svc.setEnabled('ghost@x', true)).ok, false);
  const noShop = await rig({ noShop: true, stdout: report() }).svc.setEnabled('tidy@skills-dir', true);
  assert.match(noShop.error, /still starting/);
});

test('setEnabled: asking for the state it is already in does nothing', async () => {
  const { svc, asks, claude, shop } = rig({ mods: [mod({ enabled: true })] });
  const r = await svc.setEnabled('tidy@skills-dir', true);
  assert.equal(r.ok, true);
  assert.equal(r.already, true);
  assert.equal(asks.length + claude.length + shop.calls.length, 0);
});

// ---- setEnabled: off

test('setEnabled off: never asks and never runs the mod', async () => {
  const { svc, asks, claude, shop, tb } = rig({ mods: [mod({ enabled: true })] });
  const r = await svc.setEnabled('tidy@skills-dir', false);
  assert.equal(r.ok, true);
  assert.equal(asks.length, 0);
  assert.equal(claude.length, 0);
  assert.deepEqual(shop.calls.at(-1), ['setEnabled', 'tidy@skills-dir', false]);
  assert.deepEqual(tb.rescans, [{ plugins: false }]);
});

test('setEnabled: two switches for the same mod at once do not both run', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { svc, deps } = rig({ mods: [mod({ enabled: true })] });
  deps.shop().setEnabled = async () => { await gate; return { ok: true }; };
  const first = svc.setEnabled('tidy@skills-dir', false);
  const second = await svc.setEnabled('tidy@skills-dir', false);
  assert.match(second.error, /Still working/);
  release();
  assert.equal((await first).ok, true);
});

// ---- runTests

test('runTests: asks the first time for a mod, then not again, and returns the summary', async () => {
  const { svc, asks, claude } = rig({ claude: () => ({ ok: true, stdout: '2 passed\n', stderr: '' }) });
  const first = await svc.runTests('tidy@skills-dir');
  assert.equal(first.ok, true);
  assert.equal(first.result.passed, 2);
  assert.equal(first.result.ok, true);
  assert.deepEqual(claude[0].args, ['plugin', 'test', mod().path]);
  await svc.runTests('tidy@skills-dir');
  assert.equal(asks.length, 1);
  assert.equal(asks[0].danger, true);
  assert.equal(claude.length, 2);
});

test("runTests: asks again once the mod's files change", async () => {
  const { svc, asks, tb } = rig({ claude: () => ({ ok: true, stdout: '1 passed' }) });
  await svc.runTests('tidy@skills-dir');
  await svc.runTests('tidy@skills-dir');
  assert.equal(asks.length, 1);
  tb.current = { mods: [mod({ stamp: 200 })] };
  await svc.runTests('tidy@skills-dir');
  assert.equal(asks.length, 2);
});

test('runTests: files that changed while the question was open run nothing', async () => {
  const { svc, claude } = rig({ onAsk: tb => { tb.current = { mods: [mod({ stamp: 777 })] }; } });
  const r = await svc.runTests('tidy@skills-dir');
  assert.equal(r.ok, false);
  assert.match(r.error, /changed while you were deciding/);
  assert.equal(claude.length, 0);
});

test('runTests: a declined or busy question runs nothing and is not remembered', async () => {
  const declined = rig({ answers: [1] });
  assert.deepEqual(await declined.svc.runTests('tidy@skills-dir'), { ok: false, cancelled: true });
  assert.equal(declined.claude.length, 0);
  const busy = rig({ answers: [null] });
  assert.equal((await busy.svc.runTests('tidy@skills-dir')).busy, true);
  const again = rig({ answers: [1, 0] });
  await again.svc.runTests('tidy@skills-dir');
  assert.equal((await again.svc.runTests('tidy@skills-dir')).ok, true);
  assert.equal(again.asks.length, 2);
});

test('runTests: a mod with no tests is refused before asking', async () => {
  const { svc, asks, claude } = rig({ mods: [mod({ tests: 0 })] });
  const r = await svc.runTests('tidy@skills-dir');
  assert.equal(r.ok, false);
  assert.match(r.error, /no tests yet/);
  assert.equal(asks.length + claude.length, 0);
});

test('runTests: a timeout and a missing Claude Code are reported, and the next run is allowed', async () => {
  let mode = 'timeout';
  const { svc } = rig({ claude: () => (mode === 'timeout' ? { ok: false, timedOut: true, stdout: '' } : mode === 'missing' ? { ok: false, notInstalled: true } : { ok: true, stdout: '1 passed' }) });
  assert.match((await svc.runTests('tidy@skills-dir')).error, /still going after 5 minutes/);
  mode = 'missing';
  assert.match((await svc.runTests('tidy@skills-dir')).error, /needs Claude Code/);
  mode = 'fine';
  assert.equal((await svc.runTests('tidy@skills-dir')).ok, true);
});

test('runTests: a second run while one is going is refused', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { svc } = rig({ mods: [mod(), mod({ id: 'two@skills-dir', name: 'two', path: path.join(os.tmpdir(), 'nowhere', 'two') })], claude: () => gate.then(() => ({ ok: true, stdout: '' })) });
  const first = svc.runTests('tidy@skills-dir');
  await new Promise(r => setImmediate(r));
  const second = await svc.runTests('two@skills-dir');
  assert.match(second.error, /still going/);
  release();
  await first;
});

// ---- remove

test('remove: a shop uninstall that was cancelled or busy maps to the cancelled shape', async () => {
  const shopMod = mod({ id: 'shopmod@shop', name: 'shopmod', source: 'plugin', marketplace: 'shop' });
  const a = rig({ mods: [shopMod] });
  a.deps.uninstallPlugin = async () => ({ ok: false, canceled: true });
  assert.deepEqual(await a.svc.remove('shopmod@shop'), { ok: false, cancelled: true });
  const b = rig({ mods: [shopMod] });
  b.deps.uninstallPlugin = async () => ({ ok: false, canceled: true, busy: true });
  assert.deepEqual(await b.svc.remove('shopmod@shop'), { ok: false, cancelled: true, busy: true });
});

test('remove: a user mod that stopped being one while the question was open is not trashed', async () => {
  const home = tmp();
  const dir = path.join(home, '.claude', 'skills', 'tidy');
  fs.mkdirSync(dir, { recursive: true });
  const { svc, trashed, tb } = rig({ home, mods: [mod({ path: dir })], onAsk: t => { t.current = { mods: [mod({ source: 'session', path: dir })] }; } });
  const r = await svc.remove('tidy@skills-dir');
  assert.equal(r.ok, false);
  assert.equal(trashed.length, 0);
  assert.deepEqual(tb.rescans, []);
});

test('remove: a busy question is told apart from Cancel', async () => {
  const home = tmp();
  const dir = path.join(home, '.claude', 'skills', 'tidy');
  fs.mkdirSync(dir, { recursive: true });
  const busy = rig({ home, mods: [mod({ path: dir })], answers: [null] });
  assert.deepEqual(await busy.svc.remove('tidy@skills-dir'), { ok: false, cancelled: true, busy: true });
});

test('remove: a marketplace plugin is handed to uninstallPlugin', async () => {
  const { svc, tb, trashed } = rig({ mods: [mod({ id: 'shopmod@shop', name: 'shopmod', source: 'plugin', marketplace: 'shop' })] });
  const r = await svc.remove('shopmod@shop');
  assert.deepEqual({ ok: r.ok, uninstalled: r.uninstalled }, { ok: true, uninstalled: 'shopmod@shop' });
  assert.equal(r.toolbox, tb.current);
  assert.equal(trashed.length, 0);
});

test('remove: one of your own is asked about, then moved to the Recycle Bin and the Toolbox rescanned', async () => {
  const home = tmp();
  const dir = path.join(home, '.claude', 'skills', 'tidy');
  fs.mkdirSync(dir, { recursive: true });
  const { svc, asks, trashed, tb } = rig({ home, mods: [mod({ path: dir })] });
  const r = await svc.remove('tidy@skills-dir');
  assert.equal(r.ok, true);
  assert.equal(asks.length, 1);
  assert.equal(asks[0].detail, `~${path.sep}.claude${path.sep}skills${path.sep}tidy`);
  assert.deepEqual(trashed, [dir]);
  assert.deepEqual(tb.rescans, [{ plugins: false }]);
});

test('remove: Cancel, or a folder Windows will not move, leaves a clear answer', async () => {
  const home = tmp();
  const dir = path.join(home, '.claude', 'skills', 'tidy');
  fs.mkdirSync(dir, { recursive: true });
  const cancel = rig({ home, mods: [mod({ path: dir })], answers: [1] });
  assert.deepEqual(await cancel.svc.remove('tidy@skills-dir'), { ok: false, cancelled: true });
  assert.equal(cancel.trashed.length, 0);
  const stuck = rig({ home, mods: [mod({ path: dir })], trashFails: true });
  const r = await stuck.svc.remove('tidy@skills-dir');
  assert.equal(r.ok, false);
  assert.match(r.error, /Recycle Bin/);
  assert.deepEqual(stuck.tb.rescans, []);
});

test('remove: a folder outside ~/.claude/skills, or a session mod, is never trashed and never asked about', async () => {
  const home = tmp();
  const outside = rig({ home, mods: [mod()] });
  assert.equal((await outside.svc.remove('tidy@skills-dir')).ok, false);
  const session = rig({ home, mods: [mod({ source: 'session', id: 'p@inline', name: 'p' })] });
  assert.equal((await session.svc.remove('p@inline')).ok, false);
  assert.equal(outside.asks.length + outside.trashed.length + session.asks.length + session.trashed.length, 0);
});

// ---- open, reveal

test('open and reveal act on the folder the Toolbox found, never on a path from the panel', () => {
  const { svc, deps } = rig();
  assert.deepEqual(svc.open('tidy@skills-dir'), { ok: true, opened: mod().path });
  assert.equal(svc.open('C:\\Windows').ok, false);
  svc.reveal('tidy@skills-dir');
  assert.equal(rig.revealed, mod().path);
  rig.revealed = null;
  svc.reveal('C:\\Windows');
  assert.equal(rig.revealed, null);
  assert.ok(deps);
});

// ---- draft

test('draft: a good name and idea give the prompt and the skills folder to start in', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  const { svc } = rig({ home, mods: [] });
  const r = svc.draft({ name: ' tidy-commits ', idea: ' tidies commit messages ' });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'tidy-commits');
  assert.equal(r.cwd, path.join(home, '.claude', 'skills'));
  assert.ok(r.prompt.includes(path.join(home, '.claude', 'skills', 'tidy-commits')));
  assert.match(r.prompt, /tidies commit messages/);
  assert.match(r.prompt, /plugin-authoring/);
});

test('draft: with no skills folder yet it starts in the home folder', () => {
  const home = tmp();
  const r = rig({ home, mods: [] }).svc.draft({ name: 'tidy', idea: 'x' });
  assert.equal(r.ok, true);
  assert.equal(r.cwd, home);
});

test('draft: refuses a bad name, a name in use, an existing folder, and a missing idea', () => {
  const home = tmp();
  fs.mkdirSync(path.join(home, '.claude', 'skills', 'taken'), { recursive: true });
  const { svc } = rig({ home, mods: [mod()] });
  assert.equal(svc.draft({ name: 'Bad Name', idea: 'x' }).ok, false);
  assert.match(svc.draft({ name: 'tidy', idea: 'x' }).error, /already a mod called tidy/);
  assert.match(svc.draft({ name: 'taken', idea: 'x' }).error, /already a folder called taken/);
  assert.match(svc.draft({ name: 'fresh', idea: '   ' }).error, /what it should do/);
  assert.equal(svc.draft().ok, false);
  assert.equal(svc.draft({ name: 'fresh', idea: 42 }).ok, false);
});

test('draft: blocked wins, and a very long idea is cut', () => {
  const home = tmp();
  const blocked = rig({ home, blocked: () => ({ ok: false, error: 'Busy.' }) });
  assert.deepEqual(blocked.svc.draft({ name: 'fresh', idea: 'x' }), { ok: false, error: 'Busy.' });
  const long = rig({ home, mods: [] }).svc.draft({ name: 'fresh', idea: 'y'.repeat(5000) });
  assert.equal(long.ok, true);
  assert.ok(long.prompt.includes('y'.repeat(2000)) && !long.prompt.includes('y'.repeat(2001)), 'the idea is cut at 2,000 characters');
  assert.ok(long.prompt.length < 4000);
});

// ---- register

test('register: wires every channel to the service', async () => {
  const handles = new Map();
  const ons = new Map();
  const ipcMain = { handle: (ch, fn) => handles.set(ch, fn), on: (ch, fn) => ons.set(ch, fn) };
  const { svc, shop } = rig({ mods: [mod({ enabled: true })] });
  svc.register(ipcMain);
  assert.deepEqual([...handles.keys()].sort(), ['mods:check', 'mods:draft', 'mods:open', 'mods:remove', 'mods:set-enabled', 'mods:test']);
  assert.deepEqual([...ons.keys()], ['mods:reveal']);
  assert.equal((await handles.get('mods:check')({}, 'tidy@skills-dir')).ok, true);
  const off = await handles.get('mods:set-enabled')({}, { id: 'tidy@skills-dir', on: false });
  assert.equal(off.ok, true);
  assert.deepEqual(shop.calls.at(-1), ['setEnabled', 'tidy@skills-dir', false]);
  assert.equal((await handles.get('mods:draft')({}, null)).ok, false, 'a junk request is an error, not a throw');
  assert.equal((await handles.get('mods:set-enabled')({}, 'junk')).ok, false);
  assert.equal(handles.get('mods:open')({}, 'ghost').ok, false);
});
