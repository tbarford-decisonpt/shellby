const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fileCommandLine } = require('../src/main/editor');
const { registerBacklogIpc, ID_RE } = require('../src/main/ipc/backlog');
const { templates } = require('../src/main/workflows/templates');
const { validateWorkflow } = require('../src/main/workflows/schema');
const { Engine } = require('../src/main/workflows/engine');
const { matchEvent } = require('../src/main/workflows/triggers');

// ------------------------------------------------------------------ editor

test('fileCommandLine builds the command cmd runs for code <folder> -g <file>:<line>', () => {
  assert.equal(fileCommandLine('C:\\code.cmd', 'C:\\p', 'C:\\p\\a.js', 4), '""C:\\code.cmd" "C:\\p" -g "C:\\p\\a.js:4""');
});

test('fileCommandLine refuses a relative path anywhere', () => {
  assert.equal(fileCommandLine('code.cmd', 'C:\\p', 'C:\\p\\a.js', 4), null);
  assert.equal(fileCommandLine('C:\\code.cmd', 'p', 'C:\\p\\a.js', 4), null);
  assert.equal(fileCommandLine('C:\\code.cmd', 'C:\\p', 'a.js', 4), null);
  assert.equal(fileCommandLine(null, 'C:\\p', 'C:\\p\\a.js', 4), null);
});

test('fileCommandLine refuses characters cmd would act on', () => {
  for (const bad of ['"', '%', '!', '^', '\n']) {
    assert.equal(fileCommandLine('C:\\code.cmd', 'C:\\p', `C:\\p\\a${bad}.js`, 4), null, JSON.stringify(bad));
    assert.equal(fileCommandLine('C:\\code.cmd', `C:\\p${bad}`, 'C:\\p\\a.js', 4), null, JSON.stringify(bad));
    assert.equal(fileCommandLine(`C:\\co${bad}de.cmd`, 'C:\\p', 'C:\\p\\a.js', 4), null, JSON.stringify(bad));
  }
});

test('fileCommandLine refuses a line that is not a whole number from 1', () => {
  for (const line of [0, -3, 1.5, '4', NaN, undefined, null]) {
    assert.equal(fileCommandLine('C:\\code.cmd', 'C:\\p', 'C:\\p\\a.js', line), null, String(line));
  }
  assert.ok(fileCommandLine('C:\\code.cmd', 'C:\\p', 'C:\\p\\a.js', 1));
});

// ------------------------------------------------------------------ ipc

function backlogIpc() {
  const handlers = {};
  const calls = [];
  const ipcMain = { handle(ch, fn) { handlers[ch] = fn; }, on() {} };
  const d = {};
  for (const name of ['View', 'Edit', 'AddIssue', 'Do', 'OpenDoing', 'OpenTodo', 'OpenIssue', 'Hide', 'Commit', 'Hand', 'TabInfo', 'OpenPr', 'Tick', 'Sentry', 'TrackerChoices', 'TrackerSet']) {
    d[`backlog${name}`] = (...args) => { calls.push([`backlog${name}`, ...args]); return { ok: true }; };
  }
  registerBacklogIpc(ipcMain, d);
  const call = (ch, raw) => handlers[ch]({}, raw);
  return { call, calls, handlers };
}

const GOOD_IDS = ['t:0123456789', 't:0123456789~2', 'gh:me/crab#42', 'todo:src/a.js:12', 'se:4815162342', 'tk:ENG-12', 'tk:MY_PROJ-7'];
const BAD_IDS = ['x', '', 'gh:me/crab#', 'gh:me/crab#1234567890', 't:xyz', 't:0123456789~', 'todo:a.js', 'todo:a\nb.js:1', 'se:', 'se:12a', 'se:123456789012345678901', 'tk:eng-1', 'tk:ENG-', 'tk:-1', 'tk:ENG-1/x', null, 5, {}];

test('backlog:sentry passes on only the ops and fields it knows', () => {
  const { call, calls } = backlogIpc();
  assert.equal(call('backlog:sentry', { op: 'connect', token: '  sntryu_abc  ', url: 'https://sentry.io' }).ok, true);
  assert.deepEqual(calls.pop(), ['backlogSentry', { op: 'connect', token: 'sntryu_abc', url: 'https://sentry.io' }]);
  call('backlog:sentry', { op: 'link', root: 'C:\\p', org: 'acme', slug: 'web' });
  assert.deepEqual(calls.pop(), ['backlogSentry', { root: 'C:\\p', op: 'link', org: 'acme', slug: 'web' }]);
  call('backlog:sentry', { op: 'link', root: 'C:\\p', slug: null });
  assert.deepEqual(calls.pop(), ['backlogSentry', { root: 'C:\\p', op: 'link', slug: null }]);
  call('backlog:sentry', { op: 'disconnect', root: 'C:\\p', token: 'x' });
  assert.deepEqual(calls.pop(), ['backlogSentry', { op: 'disconnect' }]);

  for (const bad of [
    { op: 'delete' }, { op: 'connect', token: 5 }, { op: 'connect', token: 'x'.repeat(700) }, { op: 'connect', token: 'abc', url: 7 },
    { op: 'link', root: 'C:\\p', org: '../x', slug: 'web' }, { op: 'link', root: 'C:\\p', org: 'acme' }, { op: 'snooze' },
  ]) assert.equal(call('backlog:sentry', bad).ok, false, JSON.stringify(bad));
  assert.equal(calls.length, 0);
});

test('ID_RE takes the ids the list gives out and nothing else', () => {
  for (const id of GOOD_IDS) assert.ok(ID_RE.test(id), id);
  for (const id of BAD_IDS.filter(x => typeof x === 'string')) assert.ok(!ID_RE.test(id), id);
});

test('backlog:view needs a root or a repository', async () => {
  const { call, calls } = backlogIpc();

  await call('backlog:view', { root: 'C:\\p', fresh: true });
  await call('backlog:view', { repo: 'me/crab' });
  const bad = [await call('backlog:view', {}), await call('backlog:view', { repo: 'nope' }), await call('backlog:view', { repo: '../../x/y' }), await call('backlog:view', { root: '' }), await call('backlog:view', { root: 5 }), await call('backlog:view')];

  assert.deepEqual(calls, [
    ['backlogView', { root: 'C:\\p', fresh: true }],
    ['backlogView', { repo: 'me/crab', fresh: false }],
  ]);
  for (const r of bad) assert.equal(r.ok, false);
});

test('a project named by a root wins over a repository, and fresh is only true for true', async () => {
  const { call, calls } = backlogIpc();

  await call('backlog:view', { root: 'C:\\p', repo: 'me/crab', fresh: 'yes' });

  assert.deepEqual(calls, [['backlogView', { root: 'C:\\p', fresh: false }]]);
});

test('backlog:edit add passes the title, cut to 1000, and a to of only now, next or later', async () => {
  const { call, calls } = backlogIpc();

  await call('backlog:edit', { root: 'C:\\p', op: 'add', title: 'x'.repeat(1500), to: 'later' });
  await call('backlog:edit', { root: 'C:\\p', op: 'add', title: 'a', to: 'done' });
  await call('backlog:edit', { root: 'C:\\p', op: 'add', title: 42 });

  assert.equal(calls[0][1].title.length, 1000);
  assert.equal(calls[0][1].to, 'later');
  assert.deepEqual(calls[1][1], { root: 'C:\\p', op: 'add', title: 'a', to: undefined });
  assert.equal(calls[2][1].title, '');
});

test('backlog:edit add does not need an id or a line', async () => {
  const { call, calls } = backlogIpc();

  await call('backlog:edit', { root: 'C:\\p', op: 'add', title: 'a' });

  assert.equal(calls.length, 1);
});

test('backlog:edit on an item needs a task id and a positive whole line', async () => {
  const { call, calls } = backlogIpc();
  const base = { root: 'C:\\p', op: 'tick', id: 't:0123456789', line: 3 };

  const ok = await call('backlog:edit', base);
  const refused = [
    await call('backlog:edit', { ...base, id: 'gh:me/crab#42' }),
    await call('backlog:edit', { ...base, id: 'todo:a.js:3' }),
    await call('backlog:edit', { ...base, id: 'x' }),
    await call('backlog:edit', { ...base, id: undefined }),
    await call('backlog:edit', { ...base, line: 0 }),
    await call('backlog:edit', { ...base, line: -1 }),
    await call('backlog:edit', { ...base, line: 2.5 }),
    await call('backlog:edit', { ...base, line: '3' }),
    await call('backlog:edit', { ...base, line: 1e7 }),
    await call('backlog:edit', { ...base, line: undefined }),
    await call('backlog:edit', { ...base, root: '' }),
    await call('backlog:edit', { ...base, op: 5 }),
  ];

  assert.equal(ok.ok, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][1], { root: 'C:\\p', op: 'tick', id: 't:0123456789', line: 3, title: '', to: undefined });
  for (const r of refused) assert.deepEqual(r, { ok: false, error: 'That isn\'t something on Next up.' });
});

test('backlog:edit move passes its destination', async () => {
  const { call, calls } = backlogIpc();

  await call('backlog:edit', { root: 'C:\\p', op: 'move', id: 't:0123456789', line: 3, to: 'now' });

  assert.equal(calls[0][1].to, 'now');
});

test('item actions refuse a bad id before main hears of it', async () => {
  const { call, calls } = backlogIpc();

  for (const ch of ['backlog:do', 'backlog:open-doing', 'backlog:open-issue']) {
    for (const id of BAD_IDS) {
      const r = await call(ch, { root: 'C:\\p', id });

      assert.equal(r.ok, false, `${ch} ${String(id)}`);
    }
    assert.equal((await call(ch, { id: 'gh:me/crab#1' })).ok, false, `${ch} needs a project`);
  }
  for (const ch of ['backlog:add-issue', 'backlog:open-todo']) {
    for (const id of BAD_IDS) assert.equal((await call(ch, { root: 'C:\\p', id })).ok, false, `${ch} ${String(id)}`);
  }
  assert.deepEqual(calls, []);
});

test('item actions pass a good id with its project', async () => {
  const { call, calls } = backlogIpc();

  await call('backlog:do', { root: 'C:\\p', id: 'gh:me/crab#42' });
  await call('backlog:open-issue', { repo: 'me/crab', id: 'gh:me/crab#42' });
  await call('backlog:open-todo', { root: 'C:\\p', id: 'todo:src/a.js:12' });
  await call('backlog:add-issue', { root: 'C:\\p', id: 'gh:me/crab#42' });

  assert.deepEqual(calls, [
    ['backlogDo', { root: 'C:\\p', id: 'gh:me/crab#42' }],
    ['backlogOpenIssue', { repo: 'me/crab', id: 'gh:me/crab#42' }],
    ['backlogOpenTodo', { root: 'C:\\p', id: 'todo:src/a.js:12' }],
    ['backlogAddIssue', { root: 'C:\\p', id: 'gh:me/crab#42' }],
  ]);
});

test('backlog:hide needs an id, or show: true to bring them all back', async () => {
  const { call, calls } = backlogIpc();

  await call('backlog:hide', { root: 'C:\\p', id: 'gh:me/crab#42' });
  await call('backlog:hide', { root: 'C:\\p', show: true });
  const refused = [await call('backlog:hide', { root: 'C:\\p' }), await call('backlog:hide', { root: 'C:\\p', id: 'x' }), await call('backlog:hide', { id: 'gh:me/crab#42' })];

  assert.deepEqual(calls, [
    ['backlogHide', { root: 'C:\\p', id: 'gh:me/crab#42' }],
    ['backlogHide', { root: 'C:\\p', show: true }],
  ]);
  for (const r of refused) assert.equal(r.ok, false);
});

test('backlog:hand needs a workflow id like wf-<uuid> as well as a good item', async () => {
  const { call, calls } = backlogIpc();
  const item = { root: 'C:\\p', id: 'gh:me/crab#42' };
  const uuid = '123e4567-e89b-12d3-a456-426614174000';

  await call('backlog:hand', { ...item, workflowId: `wf-${uuid}` });
  const refused = [
    await call('backlog:hand', { ...item, workflowId: '../../etc' }),
    await call('backlog:hand', { ...item, workflowId: 'wf id' }),
    await call('backlog:hand', { ...item, workflowId: '' }),
    await call('backlog:hand', { ...item, workflowId: 'a'.repeat(65) }),
    await call('backlog:hand', { root: 'C:\\p', id: 'x', workflowId: `wf-${uuid}` }),
  ];

  assert.deepEqual(calls, [['backlogHand', { ...item, workflowId: `wf-${uuid}` }]]);
  for (const r of refused) assert.equal(r.ok, false);
});

// Known gaps in src/main/ipc/backlog.js, kept as todos until fixed: WORKFLOW_ID_RE.test(String(x))
// lets a missing id through as "undefined", and ID_RE's owner part takes "..".
test('backlog:hand refuses a missing workflow id', async () => {
  const { call, calls } = backlogIpc();

  const r = await call('backlog:hand', { root: 'C:\\p', id: 'gh:me/crab#42' });

  assert.equal(r.ok, false);
  assert.deepEqual(calls, []);
});

test('ID_RE refuses an owner of ..', () => {
  assert.ok(!ID_RE.test('gh:../etc#1'));
});

test('backlog:commit needs a root', async () => {
  const { call, calls } = backlogIpc();

  await call('backlog:commit', { root: 'C:\\p' });
  const r = await call('backlog:commit', {});

  assert.equal(calls.length, 1);
  assert.equal(r.ok, false);
});

test('Linear or Jira setup: a project, and three short strings or off', async () => {
  const { call, calls } = backlogIpc();

  await call('backlog:tracker-choices', { root: 'C:\\p' });
  await call('backlog:tracker-set', { root: 'C:\\p', server: 'linear', kind: 'linear', scope: 'ENG', extra: 'dropped' });
  await call('backlog:tracker-set', { repo: 'me/crab', off: true });
  const bad = [
    await call('backlog:tracker-choices', {}),
    await call('backlog:tracker-set', { root: 'C:\\p', server: 'linear', kind: 'linear' }),
    await call('backlog:tracker-set', { root: 'C:\\p', server: 'linear', kind: 'linear', scope: 'x'.repeat(401) }),
    await call('backlog:tracker-set', { root: 'C:\\p', server: ['linear'], kind: 'linear', scope: 'ENG' }),
    await call('backlog:tracker-set', { server: 'linear', kind: 'linear', scope: 'ENG' }),
  ];

  assert.deepEqual(calls, [
    ['backlogTrackerChoices', { root: 'C:\\p' }],
    ['backlogTrackerSet', { root: 'C:\\p', server: 'linear', kind: 'linear', scope: 'ENG' }],
    ['backlogTrackerSet', { repo: 'me/crab', off: true }],
  ]);
  for (const r of bad) assert.equal(r.ok, false);
});

test('the conversation menu calls need a tab id', async () => {
  const { call, calls } = backlogIpc();

  await call('backlog:tab', 'tab-1');
  await call('backlog:open-pr', 'tab-1');
  await call('backlog:tick-linked', 'tab-1');

  assert.deepEqual(calls.map(c => c[0]), ['backlogTabInfo', 'backlogOpenPr', 'backlogTick']);
  assert.deepEqual(await call('backlog:tab', ''), { linked: false });
  assert.deepEqual(await call('backlog:tab', { x: 1 }), { linked: false });
  assert.equal((await call('backlog:open-pr', 'x'.repeat(300))).ok, false);
  assert.equal((await call('backlog:tick-linked', undefined)).ok, false);
  assert.equal(calls.length, 3);
});

// ------------------------------------------------------------------ the Issue helper

const issueHelper = () => {
  const template = templates({ home: 'C:\\Users\\me' }).find(t => t.key === 'issue-helper');
  assert.ok(template, 'the Issue helper template exists');
  const r = validateWorkflow(template.workflow, { allowAutonomous: true });
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  return r.workflow;
};

// The claude step's folder has to exist, so the pretend copy is a real empty one.
const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-backlog-'));
after(() => fs.rmSync(copyDir, { recursive: true, force: true }));

// Fake effects that log every call, with just what the Issue helper's steps use.
function helperEffects({ choice = 'Take a crack' } = {}) {
  const calls = [];
  const log = (name, result) => async args => { calls.push([name, args]); return typeof result === 'function' ? result(args) : result; };
  const effects = {
    ask: log('ask', choice),
    tell: log('tell', undefined),
    copy: log('copy', { ok: true, path: copyDir, branch: 'shellby/issue-7-ab12cd', base: 'main', repo: 'me/crab' }),
    claude: log('claude', { ok: true, reply: 'Done.\n```json\n{"summary":"Fixed it","left":""}\n```', tabId: 'tab-1' }),
    pullRequest: log('pullRequest', { ok: true, url: 'https://github.com/me/crab/pull/9', number: 9, branch: 'shellby/issue-7-ab12cd', repo: 'me/crab', draft: true }),
    sleep: async () => {},
  };
  return { effects, calls, names: () => calls.map(c => c[0]) };
}

const issueData = (event, reasons) => ({ event, reasons, repo: 'me/crab', number: 7, title: 'T', body: 'B' });
const runHelper = (data, fx) => new Engine({
  workflow: issueHelper(),
  record: { id: 'run-1', workflowId: 'wf', startedAt: Date.now(), trigger: { type: 'issue', data }, inputs: {} },
  effects: fx.effects,
}).run();

test('the Issue helper asks about an assigned issue and goes ahead on a yes', async () => {
  const fx = helperEffects();

  const r = await runHelper(issueData('assigned', ['assigned']), fx);

  assert.equal(r.status, 'ok', r.error);
  assert.deepEqual(fx.names().filter(n => n !== 'tell'), ['ask', 'copy', 'claude', 'pullRequest']);
  assert.match(fx.calls.find(c => c[0] === 'ask')[1].question, /me\/crab#7: T/);
  assert.equal(fx.calls.find(c => c[0] === 'copy')[1].repo, 'me/crab');
  assert.equal(fx.calls.find(c => c[0] === 'pullRequest')[1].folder, copyDir);
  assert.equal(fx.calls.find(c => c[0] === 'claude')[1].cwd, copyDir);
});

test('the Issue helper stops before the copy when you say Not now', async () => {
  const fx = helperEffects({ choice: 'Not now' });

  const r = await runHelper(issueData('assigned', ['assigned']), fx);

  assert.equal(r.status, 'ok', r.error);
  assert.ok(fx.names().includes('ask'));
  for (const later of ['copy', 'claude', 'pullRequest']) assert.ok(!fx.names().includes(later), later);
});

test('the Issue helper does not ask about an issue you picked: it makes the copy, works and opens the pull request', async () => {
  const fx = helperEffects({ choice: 'Not now' });

  const r = await runHelper(issueData('picked', ['picked']), fx);

  assert.equal(r.status, 'ok', r.error);
  assert.ok(!fx.names().includes('ask'));
  assert.deepEqual(fx.names().filter(n => n !== 'tell'), ['copy', 'claude', 'pullRequest']);
  const pr = fx.calls.find(c => c[0] === 'pullRequest')[1];
  assert.equal(pr.draft, true);
  assert.match(pr.body, /^Closes #7\n\nFixed it/);
  assert.match(fx.calls.find(c => c[0] === 'claude')[1].prompt, /GitHub issue #«7» in «me\/crab»/);
});

// ------------------------------------------------------------------ matchEvent

test('a picked issue matches a workflow on any issue, but not on assigned or labelled only', () => {
  const wf = on => ({ ...issueHelper(), id: `wf-${on}`, enabled: true, when: [{ type: 'issue', on, repo: '' }] });
  const picked = issueData('picked', ['picked']);

  const hit = type => matchEvent([wf(type)], 'issue', picked).length;

  assert.equal(hit('any'), 1);
  assert.equal(hit('assigned'), 0);
  assert.equal(hit('labelled'), 0);
});

test('an assigned issue still matches on assigned and on any', () => {
  const wf = on => ({ enabled: true, when: [{ type: 'issue', on, repo: '' }] });
  const assigned = issueData('assigned', ['assigned']);

  assert.equal(matchEvent([wf('assigned')], 'issue', assigned).length, 1);
  assert.equal(matchEvent([wf('any')], 'issue', assigned).length, 1);
  assert.equal(matchEvent([wf('labelled')], 'issue', assigned).length, 0);
});

test('a picked issue only matches a workflow watching its repository', () => {
  const wf = repo => ({ enabled: true, when: [{ type: 'issue', on: 'any', repo }] });
  const picked = issueData('picked', ['picked']);

  assert.equal(matchEvent([wf('ME/Crab')], 'issue', picked).length, 1);
  assert.equal(matchEvent([wf('other/repo')], 'issue', picked).length, 0);
});

test('a disabled workflow does not match a picked issue', () => {
  const wf = { enabled: false, when: [{ type: 'issue', on: 'any', repo: '' }] };

  assert.equal(matchEvent([wf], 'issue', issueData('picked', ['picked'])).length, 0);
});
