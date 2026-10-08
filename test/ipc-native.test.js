// The IPC for what Claude Code does by itself (src/main/ipc/native.js): a
// background job's output is only read from Claude Code's own temp files, Stop
// goes to the tab's session, a memory is only ever one of Claude's own files,
// the cloud list is kept a while and only asked for through Claude Code, and
// none of it is open to the crab's window or a stranger. Also: notes on a plan
// reach Claude whole (ipc/tabs.js task:permission), up to a page.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { installFakeElectron, createFakeIpc, fakeConfig, recorder, isStr } = require('./helpers/fake-ipc');

const electron = installFakeElectron();
electron.shell.trashItem = async p => fs.rmSync(p);
const { registerNativeIpc } = require('../src/main/ipc/native');
const { registerTabsIpc } = require('../src/main/ipc/tabs');
const jobs = require('../src/main/jobs');
const automemory = require('../src/main/automemory');

const FAKE = path.join(__dirname, 'fixtures', 'fake-claude.js');
const tmp = fs.realpathSync.native(os.tmpdir());
const work = fs.realpathSync.native(fs.mkdtempSync(path.join(tmp, 'shellby-native-ipc-')));
after(() => fs.rmSync(work, { recursive: true, force: true }));

function setup({ tabs = {}, extra = {} } = {}) {
  const ipc = createFakeIpc();
  const rec = recorder();
  const cfg = path.join(work, 'cfg');
  const d = {
    isStr, config: fakeConfig({}), FAKE_CLI: FAKE,
    manager: { tabs: new Map(Object.entries(tabs)) },
    currentCwd: () => path.join(work, 'proj'),
    claudeConfigDir: () => cfg,
    claudePath: () => null, claudeStatus: null,
    handoff: { ultraReview: rec.fn('ultraReview', async () => ({ ok: true, text: 'opened' })) },
    ...extra,
  };
  registerNativeIpc(ipc.ipcMain, d);
  return { ipc, rec, d, cfg };
}

function tabWithJob(outputFile) {
  const st = jobs.create();
  jobs.track(st, { kind: 'task', phase: 'started', taskId: 'j1', taskType: 'local_bash', description: 'build' }, 1);
  st.byId.get('j1').outputFile = outputFile;
  const stopped = [];
  return { tab: { session: { jobs: st, stopJob: async id => { stopped.push(id); return { ok: true }; } } }, stopped };
}

test("a job's output is read from Claude Code's temp file, its end if it's long", async () => {
  const file = path.join(work, 'claude', 'tasks', 'j1.output');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${'old line\n'.repeat(3000)}the newest line\n`);
  const { tab } = tabWithJob(file);
  const { ipc } = setup({ tabs: { t1: tab } });
  const r = await ipc.invoke('jobs:output', { tabId: 't1', jobId: 'j1' });
  assert.equal(r.ok, true);
  assert.equal(r.cut, true);
  assert.ok(r.text.endsWith('the newest line\n'));
  assert.ok(r.text.length <= 8000);
});

test('an output file outside temp, not .output, or gone is never read', async () => {
  const outside = path.join(os.homedir(), 'secrets.output');
  for (const file of [outside, path.join(work, 'notes.txt'), path.join(work, 'gone.output'), null]) {
    if (file?.endsWith('notes.txt')) fs.writeFileSync(file, 'private');
    const { tab } = tabWithJob(file);
    const { ipc } = setup({ tabs: { t1: tab } });
    const r = await ipc.invoke('jobs:output', { tabId: 't1', jobId: 'j1' });
    assert.equal(r.ok, false, String(file));
    assert.equal(r.text, undefined);
  }
  const { ipc } = setup();
  assert.equal((await ipc.invoke('jobs:output', { tabId: 'nope', jobId: 'j1' })).ok, false);
});

test("Stop goes to that tab's session; a closed tab says so", async () => {
  const { tab, stopped } = tabWithJob(null);
  const { ipc } = setup({ tabs: { t1: tab } });
  assert.equal((await ipc.invoke('jobs:stop', { tabId: 't1', jobId: 'j1' })).ok, true);
  assert.deepEqual(stopped, ['j1']);
  assert.equal((await ipc.invoke('jobs:stop', { tabId: 'gone', jobId: 'j1' })).ok, false);
});

test("memories are listed for the tab's project, saved and forgotten only by their own file names", async () => {
  const { ipc, cfg } = setup();
  const dir = automemory.memoryDir(path.join(work, 'proj'), cfg);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.md'), '---\nname: a\ndescription: about a\ntype: user\n---\n\nA.\n');
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [A](a.md)\n');
  const list = await ipc.invoke('memory:list', null);
  assert.deepEqual([list.exists, list.project, list.memories.map(m => m.name)], [true, 'proj', ['a']]);

  assert.equal((await ipc.invoke('memory:save', { file: 'a.md', body: 'A, changed.' })).ok, true);
  assert.match(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), /A, changed\./);
  for (const file of ['../a.md', 'a.txt', 'MEMORY.md', '', null]) assert.equal((await ipc.invoke('memory:save', { file, body: 'x' })).ok, false, String(file));

  assert.equal((await ipc.invoke('memory:forget', { file: '..\\a.md' })).ok, false);
  assert.equal((await ipc.invoke('memory:forget', { file: 'a.md' })).ok, true);
  assert.equal(fs.existsSync(path.join(dir, 'a.md')), false);
  assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), '');
});

test('the cloud list is asked of Claude Code once, then kept; Run now asks first', async () => {
  const { ipc } = setup();
  const first = await ipc.invoke('cloud:list', {});
  assert.equal(first.ok, true);
  assert.deepEqual(first.routines.map(r => r.id), ['trig_morning', 'trig_deps']);
  const again = await ipc.invoke('cloud:list', {});
  assert.equal(again.at, first.at, 'the kept list, no second call');
  const runs = await ipc.invoke('cloud:runs', 'trig_morning');
  assert.equal(runs.runs[0].status, 'completed');
  assert.equal((await ipc.invoke('cloud:runs', 'bad id')).ok, false);
  assert.equal((await ipc.invoke('cloud:run', '../x')).ok, false, 'a bad id is refused before anything is asked');
});

test('Just the crab keeps Claude Code out of it', async () => {
  const { ipc } = setup({ extra: { config: fakeConfig({ crabOnly: true }) } });
  assert.equal((await ipc.invoke('cloud:list', { fresh: true })).ok, false);
});

test('the ultra review is handed to the terminal launcher for that tab', async () => {
  const { ipc, rec } = setup();
  assert.equal((await ipc.invoke('review:ultra', 't1')).ok, true);
  assert.deepEqual(rec.of('ultraReview'), [['t1']]);
  assert.equal((await ipc.invoke('review:ultra', null)).ok, false);
});

test("none of it is open to the crab's window or a stranger", async () => {
  const { ipc } = setup();
  for (const c of ['jobs:output', 'jobs:stop', 'memory:list', 'memory:save', 'memory:forget', 'cloud:list', 'cloud:run', 'review:ultra']) {
    await assert.rejects(ipc.invokeAs(ipc.senders.critter, c, {}), undefined, c);
    await assert.rejects(ipc.invokeAs(ipc.senders.stranger, c, {}), undefined, c);
  }
});

test('notes on a plan reach Claude whole, up to a page, and no further', async () => {
  const ipc = createFakeIpc();
  const answered = [];
  registerTabsIpc(ipc.ipcMain, { isStr, answerPermission: (tabId, requestId, decision, opts) => { answered.push(opts.message); return true; } });
  const note = `> 2. Add a cache\nSkip it.\n${'x'.repeat(5000)}`;
  await ipc.invoke('task:permission', { tabId: 't', requestId: 'r', decision: 'deny', message: note });
  assert.equal(answered[0].length, 4000);
  assert.ok(answered[0].startsWith('> 2. Add a cache\nSkip it.'));
});
