const { test } = require('node:test');
const assert = require('node:assert/strict');
const { laneState, parseNumstat, lanes, mergeOrder, groupPrompts } = require('../src/main/lanes');
const { runTrain, trainLine } = require('../src/main/merge-train');

const wt = branch => ({ branch, base: 'main', originalCwd: 'C:/r' });
const diff = (n, added = 10, removed = 2) => ({ files: Array.from({ length: n }, (_, i) => `f${i}.js`), added, removed });

test('lane state: asking beats working beats red beats ready', () => {
  assert.equal(laneState({ pending: 1, busy: true, checks: { status: 'fail' } }, diff(1)), 'waiting');
  assert.equal(laneState({ busy: true, checks: { status: 'fail' } }), 'working');
  assert.equal(laneState({ checks: { status: 'timeout' }, worktree: wt('a') }, diff(1)), 'red');
  assert.equal(laneState({ checks: { status: 'pass' }, worktree: wt('a') }, diff(2)), 'ready');
  assert.equal(laneState({ worktree: wt('a') }, diff(0)), 'idle', 'nothing changed is nothing to merge');
  assert.equal(laneState({}, diff(3)), 'idle', 'no copy of its own is nothing to merge');
});

test('numstat adds up lines, binary files count as changed', () => {
  assert.deepEqual(parseNumstat('3\t1\ta.js\n-\t-\timg.png\n\n10\t0\tsrc/b.js\n'), { files: ['a.js', 'img.png', 'src/b.js'], added: 13, removed: 1 });
  assert.deepEqual(parseNumstat(''), { files: [], added: 0, removed: 0 });
});

test('lanes carry size and who else changed the same files', () => {
  const tabs = [
    { id: 'a', title: 'Login', worktree: wt('sb/a') },
    { id: 'b', title: 'Signup', worktree: wt('sb/b'), busy: true },
    { id: 'c', title: 'Chat' },
  ];
  const clashes = [{ root: 'C:/r', base: 'main', files: ['x.js'], copies: [{ tabId: 'a', title: 'Login' }, { tabId: 'b', title: 'Signup' }, { checkout: true, tabId: null, title: 'your checkout' }] }];
  const out = lanes({ tabs, diffs: new Map([['a', diff(2, 5, 1)], ['b', diff(1)]]), clashes, roots: new Map([['a', 'C:/r'], ['b', 'C:/r']]) });
  assert.deepEqual(out.map(l => [l.tabId, l.state, l.files, l.size]), [['a', 'ready', 2, 6], ['b', 'working', 1, 12], ['c', 'idle', 0, 0]]);
  assert.deepEqual(out[0].overlaps.map(o => [o.tabId, o.checkout, o.files]), [['b', false, ['x.js']], [null, true, ['x.js']]]);
  assert.deepEqual(out[2].overlaps, []);
});

const lane = (tabId, size, overlaps = [], extra = {}) => ({
  tabId, title: tabId, branch: `sb/${tabId}`, base: 'main', root: 'C:/r', state: 'ready', files: 1, size,
  overlaps: overlaps.map(id => ({ tabId: id, title: id, checkout: false, files: ['x'] })), ...extra,
});

test('merge order: fewest overlaps first, then smallest; only ready lanes, per repository and branch', () => {
  const g = mergeOrder([
    lane('big', 500),
    lane('clashy', 5, ['other']),
    lane('other', 50, ['clashy']),
    lane('small', 10),
    lane('busy', 1, [], { state: 'working' }),
    lane('elsewhere', 1, [], { root: 'C:/q' }),
  ]);
  assert.equal(g.length, 2);
  const r = g.find(x => x.root === 'C:/r');
  // small and big have no overlap; then clashy and other overlap each other until one has gone.
  assert.deepEqual(r.lanes.map(l => l.tabId), ['small', 'big', 'clashy', 'other']);
  assert.deepEqual(mergeOrder([]), []);
});

const prompt = (tabId, requestId, toolName, input, extra = {}) => ({ tabId, requestId, toolName, input, ...extra });

test('identical prompts across conversations are one group, biggest first', () => {
  const groups = groupPrompts([
    prompt('a', '1', 'Bash', { command: 'npm test' }),
    prompt('b', '2', 'Bash', { command: 'rm -rf dist' }),
    prompt('c', '3', 'Bash', { command: 'npm test' }),
    prompt('d', '4', 'Bash', { command: 'npm test' }),
  ]);
  assert.deepEqual(groups.map(g => [g.what, g.count, g.look]), [['npm test', 3, false], ['rm -rf dist', 1, false]]);
  assert.deepEqual(groups[0].prompts, [{ tabId: 'a', requestId: '1' }, { tabId: 'c', requestId: '3' }, { tabId: 'd', requestId: '4' }]);
});

test('prompts that only look the same on one line are never grouped', () => {
  const long = `echo ${'x'.repeat(300)}`;
  const groups = groupPrompts([
    prompt('a', '1', 'Bash', { command: 'npm test' }),
    prompt('b', '2', 'Bash', { command: 'npm  test' }),
    prompt('c', '3', 'Bash', { command: 'npm test', run_in_background: true }),
    prompt('d', '4', 'Bash', { command: long }),
    prompt('e', '5', 'Bash', { command: long }),
  ]);
  assert.equal(groups.length, 5);
  assert.ok(groups.filter(g => g.what.startsWith('echo')).every(g => g.look));
});

test('a prompt that has to be read at the desk is never grouped', () => {
  const groups = groupPrompts([
    prompt('a', '1', 'ExitPlanMode', {}),
    prompt('b', '2', 'ExitPlanMode', {}),
    prompt('c', '3', 'Bash', { command: 'node made.js' }, { runsCreated: ['made.js'] }),
    prompt('d', '4', 'Bash', { command: 'node made.js' }, { runsCreated: ['made.js'] }),
  ]);
  assert.equal(groups.length, 4);
  assert.ok(groups.every(g => g.look && g.count === 1));
  assert.deepEqual(groupPrompts([null, { tabId: 'x' }]), []);
});

// ---- the merge train, with a pretend git

function fakeGit({ dirty = new Set(), conflictAt = null } = {}) {
  const calls = [];
  const git = async (cwd, args) => {
    calls.push([cwd, args.filter(a => !a.startsWith('core.') && a !== '-c').join(' ')]);
    if (args[0] === 'status') return { ok: true, out: dirty.has(cwd) ? ' M a.js\n' : '' };
    if (args.includes('rebase') && !args.includes('--abort') && cwd === conflictAt) return { ok: false, out: 'CONFLICT (content): Merge conflict in a.js', error: 'could not apply' };
    return { ok: true, out: '' };
  };
  return { git, calls };
}
const steps = ['a', 'b', 'c'].map(id => ({ tabId: id, title: id, path: `/w/${id}`, branch: `sb/${id}`, base: 'main' }));

test('the train rebases each onto the one before, checking between', async () => {
  const { git, calls } = fakeGit();
  const checked = [];
  const r = await runTrain(steps, { git, check: async s => { checked.push(s.tabId); return { status: 'pass' }; } });
  assert.deepEqual(r, { ok: true, done: ['a', 'b', 'c'] });
  assert.deepEqual(calls.filter(c => c[1].includes('rebase')).map(c => c.join(': ')), [
    '/w/a: rebase --no-autostash main', '/w/b: rebase --no-autostash sb/a', '/w/c: rebase --no-autostash sb/b',
  ]);
  assert.deepEqual(checked, ['a', 'b', 'c']);
});

test('a conflict is aborted and stops the train there', async () => {
  const { git, calls } = fakeGit({ conflictAt: '/w/b' });
  const r = await runTrain(steps, { git, check: async () => ({ status: 'pass' }) });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'conflict');
  assert.equal(r.at, 'b');
  assert.deepEqual(r.done, ['a']);
  assert.ok(calls.some(c => c[0] === '/w/b' && c[1] === 'rebase --abort'));
  assert.ok(!calls.some(c => c[0] === '/w/c'), 'never reaches the next');
  assert.match(trainLine(r), /conflicts/);
});

test('red checks or uncommitted work stop it before going on', async () => {
  const red = await runTrain(steps, { git: fakeGit().git, check: async s => ({ status: s.tabId === 'a' ? 'pass' : 'fail' }) });
  assert.deepEqual([red.reason, red.at, red.done], ['red', 'b', ['a']]);
  const { git, calls } = fakeGit({ dirty: new Set(['/w/a']) });
  const dirty = await runTrain(steps, { git, check: async () => ({ status: 'pass' }) });
  assert.deepEqual([dirty.reason, dirty.at], ['dirty', 'a']);
  assert.ok(!calls.some(c => c[1].includes('rebase')), 'nothing rewritten');
  const none = await runTrain(steps, { git: fakeGit().git, check: async () => ({ status: 'none' }) });
  assert.equal(none.ok, true, 'a project without checks still lines up');
  const declined = await runTrain(steps, { git: fakeGit().git, check: async () => ({ status: 'declined' }) });
  assert.equal(declined.reason, 'stopped');
});
