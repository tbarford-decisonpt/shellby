// The Claude Code abilities cli-coverage.js listed as gaps, built: review
// findings, Claude's own notifications and worktrees, background sessions and
// purge. Event shapes are Claude Code 2.1.296's, from a real run.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toItems } = require('../src/main/stream');
const bg = require('../src/main/bg-sessions');
const { purgePlan, purgeArgs } = require('../src/main/projects/purge');
const M = require('../src/main/channels/messages');

const toolUse = (name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name, input }] } });
const toolResult = (result, text = 'ok') => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: text }] }, tool_use_result: result });

test('ReportFindings becomes a findings item, cleaned and capped', () => {
  const [item] = toItems(toolUse('ReportFindings', {
    level: 'low',
    findings: [
      { file: 'a.txt', line: 1, summary: 'It breaks.', failure_scenario: 'Empty input → crash', verdict: 'CONFIRMED', short_summary: 'Breaks' },
      { file: 'b.js', line: 'x', summary: 'Odd', verdict: 'MAYBE' },
      { nothing: true },
      'not an object',
    ],
  }));
  assert.equal(item.label, 'Reported findings');
  assert.equal(item.detail, '4 findings');
  assert.equal(item.findings.level, 'low');
  assert.deepEqual(item.findings.list[0], { file: 'a.txt', line: 1, summary: 'It breaks.', short: 'Breaks', scenario: 'Empty input → crash', verdict: 'CONFIRMED', category: '' });
  assert.equal(item.findings.list[1].line, null, 'a line that is not a number is dropped');
  assert.equal(item.findings.list[1].verdict, null);
  assert.equal(item.findings.list.length, 2, 'a finding with nothing to say is left out');
  const many = toItems(toolUse('ReportFindings', { findings: Array.from({ length: 50 }, (_, i) => ({ summary: `f${i}` })) }))[0];
  assert.equal(many.findings.list.length, 32);
});

test('PushNotification says its message, and the worktree tools what they did', () => {
  assert.deepEqual(pick(toItems(toolUse('PushNotification', { message: 'Build is green', status: 'proactive' }))[0]), { label: 'Notified you', detail: 'Build is green' });
  assert.deepEqual(pick(toItems(toolUse('EnterWorktree', { name: 'probe-wt' }))[0]), { label: 'Moved into a worktree', detail: 'probe-wt' });
  assert.deepEqual(pick(toItems(toolUse('ExitWorktree', { action: 'remove' }))[0]), { label: 'Left the worktree', detail: 'and removed it' });
});
const pick = i => ({ label: i.label, detail: i.detail });

test('EnterWorktree and ExitWorktree results say where the session went', () => {
  const [entered] = toItems(toolResult({ worktreePath: 'C:\\r\\.claude\\worktrees\\probe-wt', worktreeBranch: 'worktree-probe-wt', message: 'Created' }));
  assert.deepEqual(entered.worktree, { entered: 'C:\\r\\.claude\\worktrees\\probe-wt', branch: 'worktree-probe-wt' });
  const [left] = toItems(toolResult({ action: 'remove', originalCwd: 'C:\\r', worktreePath: 'C:\\r\\.claude\\worktrees\\probe-wt', worktreeBranch: 'worktree-probe-wt', restoredCwd: 'C:\\r', discardedFiles: 0 }));
  assert.deepEqual(left.worktree, { left: 'C:\\r', removed: true });
  const [other] = toItems(toolResult({ count: 1 }));
  assert.equal(other.worktree, undefined);
});

test('a phone message for Claude\'s own notification', () => {
  assert.ok(M.EVENTS.claude.default, 'on by default: Claude asked for it by name');
  const m = M.composeMessage({ kind: 'claude', project: 'shellby', body: 'Tests pass\nall of them' });
  assert.equal(m.title, 'Claude, in shellby');
  assert.equal(m.body, 'Tests pass all of them');
});

// `claude agents --json --all`, as Claude Code 2.1.296 printed it (names changed).
const AGENTS = JSON.stringify([
  { id: '378070a6', cwd: 'C:\\games\\server', kind: 'background', startedAt: 1782923871520, sessionId: '378070a6-752d-4d65-84e3-81c3bd78c0e3', name: 'Set up a dev server', state: 'blocked' },
  { pid: 11212, cwd: 'C:\\code\\shellby', kind: 'interactive', startedAt: 1791934606176, sessionId: 'ecfdd82b-dbaa-4174-8cbd-76484f65c16c', name: 'Shellby itself', status: 'busy' },
  { id: 'abcdef12', cwd: 'C:\\code\\x', kind: 'background', startedAt: 1791000000000, sessionId: 'nope', name: 'Newer', state: 'working' },
  { id: '../evil', kind: 'background', state: 'done' },
]);

test('background sessions: only background ones, newest first, ids checked', () => {
  const list = bg.parseAgents(AGENTS);
  assert.deepEqual(list.map(s => s.id), ['abcdef12', '378070a6']);
  assert.equal(list[0].sessionId, null, 'a session id of the wrong shape is dropped');
  assert.equal(list[1].sessionId, '378070a6-752d-4d65-84e3-81c3bd78c0e3');
  assert.equal(bg.stateLabel('blocked'), 'Needs input');
  assert.equal(bg.stateLabel('sleeping'), 'Sleeping');
  assert.deepEqual(bg.parseAgents('not json'), []);
  assert.deepEqual(bg.parseAgents('{"a":1}'), []);
});

test('background sessions: news only when one changes into needing you or finishing', () => {
  const a = { id: 'aaaaaa01', state: 'working' };
  const b = { id: 'bbbbbb02', state: 'working' };
  assert.deepEqual(bg.newsBetween(null, [{ ...a, state: 'blocked' }]), [], 'the first listing is a baseline');
  assert.deepEqual(bg.newsBetween([a], [a, { ...b, state: 'done' }]), [], 'new, and already done: nothing');
  const news = bg.newsBetween([a, b], [{ ...a, state: 'blocked' }, { ...b, state: 'done' }]);
  assert.deepEqual(news.map(n => [n.session.id, n.kind]), [['aaaaaa01', 'needs'], ['bbbbbb02', 'finished']]);
  assert.deepEqual(bg.newsBetween([{ ...a, state: 'blocked' }], [{ ...a, state: 'blocked' }]), []);
  assert.ok(bg.isRunning({ state: 'blocked' }));
  assert.ok(!bg.isRunning({ state: 'done' }));
});

// `claude purge --dry-run` (2.1.296), stdout only: the notes go to stderr, but either way they aren't deletions.
const PLAN = `Purge plan for C:\\code\\shellby:

  dir:    C:\\Users\\me\\.claude\\projects\\C--code-shellby
           project transcripts (.jsonl) and memory/

shell-snapshots/ are not project-scoped and will not be touched
Dry run: 1 item(s) would be deleted.
`;

test('purge: what the dry run listed, and the arguments', () => {
  const p = purgePlan(PLAN);
  assert.equal(p.items, 1);
  assert.deepEqual(p.lines, ['dir: C:\\Users\\me\\.claude\\projects\\C--code-shellby', 'project transcripts (.jsonl) and memory/']);
  assert.ok(p.memory, 'the dialog says memory goes too');
  assert.deepEqual(purgePlan(''), { items: 0, lines: [], memory: false });
  assert.deepEqual(purgeArgs('C:\\x', { dryRun: true }), ['purge', '--dry-run', '--', 'C:\\x']);
  assert.deepEqual(purgeArgs('-rf', { dryRun: false }), ['purge', '--yes', '--', '-rf'], 'a folder is never read as a flag');
});
