const { test } = require('node:test');
const assert = require('node:assert/strict');
const { rank, scoreIssue, nearestMilestone, dueText } = require('../src/main/backlog/rank');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);

let n = 0;
const issue = (number, extra = {}) => ({
  key: `me/crab#${number}`, repo: 'me/crab', number, title: `Issue ${number}`, body: '', labels: [], author: 'pal',
  url: `https://github.com/me/crab/issues/${number}`, assignees: [], mine: false, milestone: null,
  comments: 0, thumbs: 0, updatedAt: NOW - 30 * DAY + (n++), ...extra,
});

const task = (title, extra = {}) => {
  const r = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)(?:\s+(.*))?$/.exec(title);
  return {
    id: `t:${title.replace(/\W/g, '').padEnd(10, '0').slice(0, 10)}`, line: 1, title, notes: [], section: 'next', heading: '', done: false,
    ref: r ? { repo: r[1] || null, number: Number(r[2]), note: r[3] || '' } : null, ...extra,
  };
};

const run = (o = {}) => rank({ login: 'me', now: NOW, repo: 'me/crab', ...o });
const tierOf = (r, id) => r.items.find(i => i.id === id).tier;

// ------------------------------------------------------------------ dueText

test('dueText says today, tomorrow, in N days and N days overdue', () => {
  assert.equal(dueText(NOW, NOW), 'due today');
  assert.equal(dueText(NOW + DAY, NOW), 'due tomorrow');
  assert.equal(dueText(NOW + 6 * DAY, NOW), 'due in 6 days');
  assert.equal(dueText(NOW - DAY, NOW), '1 day overdue');
  assert.equal(dueText(NOW - 4 * DAY, NOW), '4 days overdue');
});

test('dueText counts calendar days, not 24 hour spans', () => {
  const lateNight = Date.UTC(2026, 9, 6, 23, 59, 0);
  const earlyMorning = Date.UTC(2026, 9, 7, 0, 1, 0);

  assert.equal(dueText(earlyMorning, lateNight), 'due tomorrow');
});

// ------------------------------------------------------------------ nearestMilestone

test('nearestMilestone is the one due soonest, overdue included, ignoring undated ones', () => {
  const a = { number: 1, title: 'A', dueOn: NOW + 9 * DAY };
  const b = { number: 2, title: 'B', dueOn: NOW - 2 * DAY };
  const c = { number: 3, title: 'C', dueOn: null };

  assert.equal(nearestMilestone([a, c, b]), b);
  assert.equal(nearestMilestone([c]), null);
  assert.equal(nearestMilestone([]), null);
  assert.equal(nearestMilestone(null), null);
});

test('nearestMilestone does not reorder the list it was given', () => {
  const list = [{ number: 1, dueOn: NOW + 2 * DAY }, { number: 2, dueOn: NOW + DAY }];

  nearestMilestone(list);

  assert.deepEqual(list.map(m => m.number), [1, 2]);
});

// ------------------------------------------------------------------ tiers

test('tasks under Now come first, in file order', () => {
  const r = run({
    tasks: [task('first now', { section: 'now', line: 3 }), task('a next', { line: 5 }), task('second now', { section: 'now', line: 7 })],
    issues: [issue(1, { labels: ['p0'] })],
  });

  assert.deepEqual(r.items.filter(i => i.tier === 'now').map(i => i.title), ['first now', 'second now', 'Issue 1']);
});

test('an unassigned issue in a milestone due within 3 days is now', () => {
  const m = { number: 5, title: 'v1', dueOn: NOW + 2 * DAY };
  const r = run({ issues: [issue(1, { milestone: m })], milestones: [m] });

  assert.equal(r.items[0].tier, 'now');
  assert.match(r.items[0].reason, /v1 · due in 2 days/);
});

test('an overdue milestone puts its issues in now too', () => {
  const m = { number: 5, title: 'v1', dueOn: NOW - 2 * DAY };
  const r = run({ issues: [issue(1, { milestone: m, assignees: ['me'], mine: true })], milestones: [m] });

  assert.equal(r.items[0].tier, 'now');
});

test('a milestone due in more than 3 days is next, not now', () => {
  const m = { number: 5, title: 'v1', dueOn: NOW + 6 * DAY };
  const r = run({ issues: [issue(1, { milestone: m })], milestones: [m] });

  assert.equal(r.items[0].tier, 'next');
});

test('an issue due soon but assigned to someone else stays out of now', () => {
  const m = { number: 5, title: 'v1', dueOn: NOW + DAY };
  const r = run({ issues: [issue(1, { milestone: m, assignees: ['x'] })], milestones: [m] });

  assert.notEqual(r.items[0].tier, 'now');
});

test('an urgent label puts an issue in now', () => {
  for (const label of ['p0', 'P1', 'priority: high', 'priority/critical', 'urgent', 'critical']) {
    const r = run({ issues: [issue(1, { labels: [label] })] });

    assert.equal(r.items[0].tier, 'now', label);
    assert.equal(r.items[0].reason, label);
  }
});

test('an urgent issue someone else is working on is not now', () => {
  const r = run({ issues: [issue(1, { labels: ['p0'], assignees: ['x'] })] });

  assert.equal(r.items[0].tier, 'later');
});

test('issues assigned to you, in the nearest milestone, or labelled shellby are next', () => {
  const m = { number: 5, title: 'v1', dueOn: NOW + 20 * DAY };
  const r = run({
    issues: [
      issue(1, { assignees: ['Me'] }),
      issue(2, { milestone: m }),
      issue(3, { labels: ['shellby'] }),
      issue(4),
    ],
    milestones: [m],
  });

  assert.deepEqual(r.items.map(i => [i.issue.number, i.tier]).sort(), [[1, 'next'], [2, 'next'], [3, 'next'], [4, 'later']]);
});

test('a milestone that is not the nearest does not make an issue next', () => {
  const near = { number: 5, title: 'near', dueOn: NOW + 20 * DAY };
  const far = { number: 6, title: 'far', dueOn: NOW + 90 * DAY };
  const r = run({ issues: [issue(1, { milestone: far })], milestones: [near, far] });

  assert.equal(r.items[0].tier, 'later');
  assert.match(r.items[0].reason, /far · due in 90 days/);
});

test('FIXME loose ends are next, HACK and TODO later', () => {
  const todo = (tag, line) => ({ file: 'a.js', line, tag, text: `${tag} text`, ref: null });
  const r = run({ todos: [todo('TODO', 1), todo('FIXME', 2), todo('HACK', 3)] });

  assert.deepEqual(r.items.map(i => [i.todo.tag, i.tier]), [['FIXME', 'next'], ['HACK', 'later'], ['TODO', 'later']]);
  assert.equal(r.items[0].kind, 'todo');
  assert.equal(r.items[0].id, 'todo:a.js:2');
  assert.equal(r.items[0].reason, 'FIXME in a.js');
});

// ------------------------------------------------------------------ order

test('your tasks come first in their tier in file order, ahead of higher scoring issues', () => {
  const r = run({
    tasks: [task('zebra', { line: 2 }), task('apple', { line: 4 })],
    issues: [issue(1, { assignees: ['me'], mine: true, labels: ['bug', 'shellby'] })],
  });

  assert.deepEqual(r.items.map(i => i.title), ['zebra', 'apple', 'Issue 1']);
});

test('tiers run now, next, later with your tasks first in each', () => {
  const r = run({
    tasks: [task('later task', { section: 'later' }), task('now task', { section: 'now' }), task('next task')],
    issues: [issue(1, { labels: ['p0'] }), issue(2), issue(3, { assignees: ['me'] })],
  });

  assert.deepEqual(r.items.map(i => `${i.tier}:${i.title}`), [
    'now:now task', 'now:Issue 1', 'next:next task', 'next:Issue 3', 'later:later task', 'later:Issue 2',
  ]);
});

test('issues in a tier go by score, highest first', () => {
  const r = run({
    issues: [
      issue(1, { assignees: ['me'] }),
      issue(2, { assignees: ['me'], labels: ['bug'] }),
      issue(3, { assignees: ['me'], thumbs: 7 }),
    ],
  });

  assert.deepEqual(r.items.map(i => i.issue.number), [3, 2, 1]);
});

test('equal scores go by most recently updated, then by lowest number', () => {
  const r = run({
    issues: [
      issue(9, { updatedAt: NOW - 40 * DAY }),
      issue(5, { updatedAt: NOW - 50 * DAY }),
      issue(7, { updatedAt: NOW - 40 * DAY }),
      issue(3, { updatedAt: NOW - 40 * DAY + 1 }),
    ],
  });

  assert.deepEqual(r.items.map(i => i.issue.number), [3, 7, 9, 5]);
});

test('rank does not change the tasks or issues it was given', () => {
  const tasks = [task('b'), task('a')];
  const issues = [issue(2), issue(1)];
  const before = JSON.stringify({ tasks, issues });

  run({ tasks, issues });

  assert.equal(JSON.stringify({ tasks, issues }), before);
});

// ------------------------------------------------------------------ a task standing in for an issue

test('a #42 task replaces issue 42 in the list, keeping the task\'s place and note', () => {
  const t = task('#42 start with the parser', { line: 6, notes: ['second line'] });
  const r = run({
    tasks: [task('before', { line: 3 }), t, task('after', { line: 9 })],
    issues: [issue(42, { title: 'Parser rewrite', labels: ['shellby'] }), issue(43, { assignees: ['me'] })],
  });

  assert.equal(r.items.filter(i => i.issue?.number === 42).length, 1);
  assert.deepEqual(r.items.slice(0, 3).map(i => i.title), ['before', 'Parser rewrite', 'after']);
  const item = r.items[1];
  assert.equal(item.kind, 'issue');
  assert.equal(item.id, 'gh:me/crab#42');
  assert.deepEqual(item.task, { id: t.id, line: 6, notes: ['start with the parser', 'second line'] });
  assert.equal(item.reasons[0], 'On your list');
});

test('a #42 task with no note keeps only its own notes', () => {
  const t = task('#42', { notes: ['only this'] });

  const r = run({ tasks: [t], issues: [issue(42)] });

  assert.deepEqual(r.items[0].task.notes, ['only this']);
});

test('a #42 task under Later stays in later', () => {
  const r = run({ tasks: [task('#42', { section: 'later' })], issues: [issue(42), issue(43)] });

  assert.equal(tierOf(r, 'gh:me/crab#42'), 'later');
});

test('a #42 task lands in now when the issue itself is urgent', () => {
  const r = run({ tasks: [task('#42', { section: 'later' })], issues: [issue(42, { labels: ['p0'] })] });

  assert.equal(tierOf(r, 'gh:me/crab#42'), 'now');
});

test('a #99 task whose issue is not open is a closed task', () => {
  const r = run({ tasks: [task('#99 old thing')], issues: [issue(1)] });

  const item = r.items.find(i => i.kind === 'task');
  assert.equal(item.task.closed, true);
  assert.equal(item.reason, '#99 is closed');
  assert.equal(item.tier, 'next');
});

test('a #99 task is a plain task when GitHub was not read', () => {
  const r = run({ tasks: [task('#99 old thing')], issues: null });

  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].kind, 'task');
  assert.equal(r.items[0].task.closed, false);
  assert.equal(r.items[0].reason, 'On your list');
});

test('a task naming another repository does not match this one\'s issue', () => {
  const r = run({ tasks: [task('other/repo#42 elsewhere')], issues: [issue(42)] });

  const taskItem = r.items.find(i => i.kind === 'task');
  assert.equal(taskItem.task.closed, false);
  assert.ok(r.items.some(i => i.id === 'gh:me/crab#42'), 'this repository\'s issue 42 is still listed on its own');
});

test('a task naming this repository by name matches, whatever the case', () => {
  const r = run({ tasks: [task('ME/Crab#42')], issues: [issue(42)] });

  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].kind, 'issue');
});

test('task reasons say which section the task is in', () => {
  const r = run({ tasks: [task('a', { section: 'now' }), task('b', { section: 'later' }), task('c')] });

  assert.deepEqual(r.items.map(i => i.reason), ['Now, on your list', 'On your list', 'Later, on your list']);
});

// ------------------------------------------------------------------ loose ends

test('TODO(#42) folds into issue 42 and is not listed on its own', () => {
  const r = run({
    issues: [issue(42)],
    todos: [
      { file: 'a.js', line: 3, tag: 'TODO', text: 'handle it', ref: { repo: null, number: 42 } },
      { file: 'b.js', line: 8, tag: 'FIXME', text: 'and this', ref: { repo: 'me/crab', number: 42 } },
    ],
  });

  assert.equal(r.items.length, 1);
  assert.deepEqual(r.items[0].todos, [
    { file: 'a.js', line: 3, tag: 'TODO', text: 'handle it' },
    { file: 'b.js', line: 8, tag: 'FIXME', text: 'and this' },
  ]);
  assert.equal(r.items[0].reasons.at(-1), '2 loose ends in the code');
});

test('one loose end is worded in the singular', () => {
  const r = run({ issues: [issue(42)], todos: [{ file: 'a.js', line: 3, tag: 'TODO', text: 'x', ref: { repo: null, number: 42 } }] });

  assert.equal(r.items[0].reasons.at(-1), '1 loose end in the code');
});

test('a loose end folds into an issue that a task stands in for', () => {
  const r = run({
    tasks: [task('#42')],
    issues: [issue(42)],
    todos: [{ file: 'a.js', line: 3, tag: 'TODO', text: 'x', ref: { repo: null, number: 42 } }],
  });

  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].todos.length, 1);
});

test('a loose end naming an issue that is not open is listed on its own', () => {
  const r = run({ issues: [issue(1)], todos: [{ file: 'a.js', line: 3, tag: 'TODO', text: 'x', ref: { repo: null, number: 77 } }] });

  assert.deepEqual(r.items.map(i => i.kind).sort(), ['issue', 'todo']);
});

test('a loose end naming another repository\'s issue does not fold into this one\'s', () => {
  const r = run({ issues: [issue(42)], todos: [{ file: 'a.js', line: 3, tag: 'TODO', text: 'x', ref: { repo: 'other/repo', number: 42 } }] });

  assert.equal(r.items.find(i => i.kind === 'issue').todos.length, 0);
  assert.ok(r.items.some(i => i.kind === 'todo'));
});

test('a loose end with no text is titled by its tag', () => {
  const r = run({ todos: [{ file: 'a.js', line: 3, tag: 'HACK', text: '', ref: null }] });

  assert.equal(r.items[0].title, 'HACK with no note');
});

// ------------------------------------------------------------------ scoring

test('an issue assigned to someone else loses 3 and says so only when nothing speaks for it', () => {
  const quiet = scoreIssue(issue(1, { assignees: ['x'], updatedAt: NOW - 30 * DAY }), { login: 'me', nearest: null, now: NOW });
  const loud = scoreIssue(issue(2, { assignees: ['x'], labels: ['bug'], updatedAt: NOW - 30 * DAY }), { login: 'me', nearest: null, now: NOW });

  assert.equal(quiet.score, -3);
  assert.deepEqual(quiet.reasons, ['@x has it']);
  assert.equal(loud.score, -1);
  assert.deepEqual(loud.reasons, ['Bug', '@x has it'], 'the penalty comes after what speaks for it');
});

test('an issue assigned to you scores for it and names it', () => {
  const s = scoreIssue(issue(1, { assignees: ['ME'] }), { login: 'me', nearest: null, now: NOW });

  assert.equal(s.mine, true);
  assert.equal(s.reasons[0], 'Assigned to you');
});

test('an issue updated in the last two weeks is active, one untouched for half a year is stale', () => {
  const active = scoreIssue(issue(1, { updatedAt: NOW - DAY }), { login: 'me', nearest: null, now: NOW });
  const stale = scoreIssue(issue(2, { updatedAt: NOW - 200 * DAY }), { login: 'me', nearest: null, now: NOW });

  assert.equal(active.score, 1);
  assert.deepEqual(active.reasons, ['Active lately']);
  assert.equal(stale.score, -1);
  assert.deepEqual(stale.reasons, [], 'a stale mark has no words');
});

test('reasons are strongest first', () => {
  const s = scoreIssue(issue(1, { assignees: ['me'], labels: ['bug', 'p0'], updatedAt: NOW }), { login: 'me', nearest: null, now: NOW });

  assert.deepEqual(s.reasons, ['p0', 'Assigned to you', 'Bug', 'Active lately']);
});

test('a missing login means nothing is yours', () => {
  const s = scoreIssue(issue(1, { assignees: ['me'] }), { login: null, nearest: null, now: NOW });

  assert.equal(s.mine, false);
});

// ------------------------------------------------------------------ milestone

test('the result names the nearest milestone with its due text', () => {
  const near = { number: 5, title: 'v1', dueOn: NOW + 2 * DAY };
  const far = { number: 6, title: 'v2', dueOn: NOW + 30 * DAY };

  const r = run({ milestones: [far, near] });

  assert.deepEqual(r.milestone, { ...near, due: 'due in 2 days' });
});

test('the milestone is null when none has a due date', () => {
  assert.equal(run({ milestones: [{ number: 1, title: 'x', dueOn: null }] }).milestone, null);
  assert.equal(run().milestone, null);
});

test('rank with nothing gives an empty list', () => {
  assert.deepEqual(rank(), { items: [], milestone: null });
});

test('an issue is listed under gh: and its key', () => {
  const r = run({ issues: [issue(1)] });

  assert.deepEqual(r.items.map(i => i.id), ['gh:me/crab#1']);
});

// ------------------------------------------------------------------ partial lists and repeated references

test('a #7 task is not called closed when GitHub only gave the first page of open issues', () => {
  const r = run({ tasks: [task('#7')], issues: [issue(42)], complete: false });

  const t = r.items.find(i => i.kind === 'task');
  assert.equal(t.task.closed, false);
  assert.equal(t.reason, 'On your list');
});

test('only the first task naming an issue claims it, so the issue is never listed twice', () => {
  const r = run({ tasks: [task('#42 first'), task('#42 second', { id: 't:second0000', line: 2 })], issues: [issue(42)] });

  assert.equal(r.items.filter(i => i.id === 'gh:me/crab#42').length, 1);
  assert.equal(r.items.filter(i => i.kind === 'task').length, 1, 'the second stays a plain task');
});

test('to-dos kept in Shellby for a project with no clone follow your tasks, saying who added them', () => {
  const r = run({ tasks: [task('From the file')], notes: [{ id: 't-abcd1234', text: 'Kept in Shellby', from: 'claude' }, { id: 't-abcd1235', text: 'Mine', from: 'you' }] });

  const titles = r.items.filter(i => i.kind === 'task').map(i => i.title);
  assert.deepEqual(titles, ['From the file', 'Kept in Shellby', 'Mine']);
  const kept = r.items.find(i => i.id === 'n:t-abcd1234');
  assert.equal(kept.reason, 'From Claude Code');
  assert.deepEqual(kept.note, { id: 't-abcd1234', from: 'claude' });
  assert.equal(r.items.find(i => i.id === 'n:t-abcd1235').reason, 'On your to-do list');
});

test('open notes from the Notes page follow your tasks, first line as the title', () => {
  const r = run({
    tasks: [task('From the file')],
    ideas: [
      { id: 'abc', text: 'Add a dark mode\nmatch the OS setting', scope: 'crab' },
      { id: 'cla', text: 'Cache the parser', scope: 'crab', from: 'claude' },
      { id: 'bad', text: '   ' }, { text: 'no id' }, null,
    ],
  });

  const titles = r.items.filter(i => i.kind === 'task').map(i => i.title);
  assert.deepEqual(titles, ['From the file', 'Add a dark mode', 'Cache the parser']);
  const idea = r.items.find(i => i.id === 'idea:abc');
  assert.equal(idea.reason, 'From your Notes');
  assert.deepEqual(idea.idea, { id: 'abc', scope: 'crab', notes: ['match the OS setting'], from: 'you' });
  assert.equal(idea.task, undefined, 'not a tasks.md task: no line to edit');
  // One Claude put there says so.
  const claude = r.items.find(i => i.id === 'idea:cla');
  assert.equal(claude.reason, 'From Claude Code');
  assert.equal(claude.idea.from, 'claude');
});
