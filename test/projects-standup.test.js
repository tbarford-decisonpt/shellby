// A project's standup and weekly report (src/main/projects/standup.js): which
// day is "yesterday", what goes under Today and Blockers, how a week groups its
// commits, the Slack and email words, and Projects.report() gathering it all.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const s = require('../src/main/projects/standup');
const { sessionsIn } = require('../src/main/projects/insights');
const { Projects } = require('../src/main/projects/service');

const at = (day, hh = 12) => new Date(`${day}T${String(hh).padStart(2, '0')}:00:00`).getTime();
const MONDAY = at('2026-10-05', 12);
const ROOT = path.resolve('C:\\code\\site');

const detail = (extra = {}) => ({ key: 'github:me/site', name: 'site', local: [{ root: ROOT, servers: [] }], insights: {}, ...extra });
const input = (sources = {}, d = detail()) => s.inputFrom(d, sources);
const section = (r, id) => r.sections.find(x => x.id === id);

// ------------------------------------------------------------------ commits

test('reads a conventional commit as what it did, and drops merge noise', () => {
  assert.deepEqual(s.readCommit('feat(ui): rack units ruler'), { kind: 'built', text: 'Rack units ruler' });
  assert.deepEqual(s.readCommit('fix: an expired sign-in says so'), { kind: 'fixed', text: 'An expired sign-in says so' });
  assert.deepEqual(s.readCommit('chore: scoop manifest for 0.70.1'), { kind: 'chore', text: 'Scoop manifest for 0.70.1' });
  assert.deepEqual(s.readCommit('0.70.2: An expired sign-in says so'), { kind: 'release', text: 'Released 0.70.2: An expired sign-in says so' });
  assert.deepEqual(s.readCommit('v1.2.0'), { kind: 'release', text: 'Released 1.2.0' });
  assert.deepEqual(s.readCommit('tidy up the readme'), { kind: 'other', text: 'Tidy up the readme' });
  assert.equal(s.readCommit('Merge pull request #25 from me/branch'), null);
  assert.equal(s.readCommit('fixup! feat: thing'), null);
  assert.equal(s.readCommit(''), null);
});

test('an unknown prefix is part of the message, not a type', () => {
  assert.deepEqual(s.readCommit('Note: this is fine'), { kind: 'other', text: 'Note: this is fine' });
});

// ------------------------------------------------------------------ windows

test('a standup reads the last week; a week runs Monday to today; last week is all of it', () => {
  const tue = at('2026-10-06', 9);
  assert.deepEqual(s.windowOf('standup', tue), { from: at('2026-09-29', 0), to: at('2026-10-07', 0) });
  assert.deepEqual(s.windowOf('week', tue), { from: at('2026-10-05', 0), to: at('2026-10-07', 0) });
  assert.deepEqual(s.windowOf('last-week', tue), { from: at('2026-09-28', 0), to: at('2026-10-05', 0) });
  // Sunday still belongs to the week that started on Monday.
  assert.deepEqual(s.windowOf('week', at('2026-10-11', 20)), { from: at('2026-10-05', 0), to: at('2026-10-12', 0) });
});

// ------------------------------------------------------------------ the standup

test("on a Monday, yesterday is Friday's work, notes first, then commits, then conversations", () => {
  const r = s.standup(input({
    commits: [{ at: at('2026-10-02', 10), subject: 'feat: rack units ruler' }, { at: at('2026-10-02', 15), subject: 'fix: trays clip through 1U panels' }],
    sessions: [{ title: 'Ruler ticks', createdAt: at('2026-10-02', 11), updatedAt: at('2026-10-02', 16), done: true }],
    time: { '2026-10-02': { seconds: 3 * 3600 + 20 * 60, notes: ['Client demo prep'] } },
  }), MONDAY);
  const y = section(r, 'yesterday');
  assert.equal(y.meta, 'Fri, Oct 2 · 3h 20m tracked');
  assert.deepEqual(y.items, ['Client demo prep', 'Rack units ruler', 'Trays clip through 1U panels', 'Worked with Claude on "Ruler ticks" (done)']);
  assert.equal(r.title, 'site standup, Mon, Oct 5');
});

test('when yesterday really was yesterday, its heading needs no date', () => {
  const r = s.standup(input({ commits: [{ at: at('2026-10-05', 10), subject: 'feat: a' }] }), at('2026-10-06', 9));
  assert.equal(section(r, 'yesterday').meta, '');
  assert.deepEqual(section(r, 'yesterday').items, ['A']);
});

test('a week with nothing in it says so instead of reaching further back', () => {
  const r = s.standup(input({ commits: [{ at: at('2026-09-20'), subject: 'feat: long ago' }] }), MONDAY);
  assert.deepEqual(section(r, 'yesterday').items, []);
  assert.match(s.toText(r), /Yesterday\n- Nothing logged/);
});

test("today: what's done so far, reviews to answer, and unfinished conversations it hasn't touched", () => {
  const d = detail({ insights: { prs: [{ number: 12, title: 'Ruler', state: 'passing', reviewComments: 2 }] } });
  const r = s.standup(input({
    commits: [{ at: at('2026-10-05', 9), subject: 'refactor: one scene graph' }],
    sessions: [
      { title: 'Snap cables', createdAt: at('2026-10-02'), updatedAt: at('2026-10-03'), done: false },
      { title: 'Build is slow', createdAt: at('2026-10-02'), updatedAt: at('2026-10-02'), done: true },
      { title: 'Today thing', createdAt: at('2026-10-05', 8), updatedAt: at('2026-10-05', 10), done: false },
      { title: 'Ancient', createdAt: at('2026-09-20'), updatedAt: at('2026-09-20'), done: false },
    ],
  }, d), MONDAY);
  assert.deepEqual(section(r, 'today').items, [
    'One scene graph',
    'Worked with Claude on "Today thing"',
    'Address the review on #12 Ruler',
    'Carry on with "Snap cables"',
  ]);
});

test('routines ran by themselves: they are not your work', () => {
  const r = s.standup(input({ sessions: [{ title: 'Nightly deps', routineId: 'r1', createdAt: at('2026-10-02'), updatedAt: at('2026-10-02') }] }), MONDAY);
  assert.deepEqual(section(r, 'yesterday').items, []);
});

test('the same commit seen from two clones is listed once', () => {
  const c = { at: at('2026-10-02'), subject: 'feat: once' };
  const r = s.standup(input({ commits: [c, { ...c }] }), MONDAY);
  assert.deepEqual(section(r, 'yesterday').items, ['Once']);
});

test('blockers: failing checks, a crashed server, serious vulnerabilities, flaky tests', () => {
  const d = detail({
    local: [{ root: ROOT, servers: [{ status: 'crashed', script: 'dev' }, { status: 'crashed', script: 'old', missed: true }, { status: 'up' }] }],
    insights: {
      prs: [{ number: 7, title: 'Trays', state: 'failing', failing: ['lint', 'test'] }, { number: 8, title: 'Docs', state: 'passing' }],
      deps: { ok: true, vulns: { critical: 1, high: 2, moderate: 5 } },
      flaky: [{ label: 'saves a rack', status: 'watching', week: 3 }, { label: 'old one', status: 'quarantined', week: 1 }],
    },
  });
  assert.deepEqual(s.blockersOf(d), [
    '#7 Trays: checks failing (lint, test)',
    'Dev server "dev" crashed',
    '3 high or critical vulnerabilities in dependencies',
    'Flaky test: saves a rack (3 flakes this week)',
  ]);
  assert.match(s.toText(s.standup(input({}), MONDAY)), /Blockers\n- None$/);
});

// ------------------------------------------------------------------ the week

test('a week groups what shipped, was built and was fixed, with totals and hours a day', () => {
  const r = s.weekly(input({
    commits: [
      { at: at('2026-10-05', 9), subject: 'feat: ruler' },
      { at: at('2026-10-06', 9), subject: 'fix: trays' },
      { at: at('2026-10-06', 10), subject: '0.9.0: Ruler and trays' },
      { at: at('2026-10-06', 11), subject: 'docs: readme' },
      { at: at('2026-09-30', 9), subject: 'feat: last week' },
    ],
    sessions: [{ title: 'Ruler ticks', createdAt: at('2026-10-05'), updatedAt: at('2026-10-06'), done: false }],
    time: { '2026-10-05': { seconds: 2 * 3600 + 600, notes: [] }, '2026-10-06': { seconds: 45 * 60, notes: ['Call with Ana'] } },
    tasks: { '2026-10-05': 3, '2026-10-06': 1 },
  }), at('2026-10-06', 18));
  assert.equal(r.title, 'site, week of Oct 5 – Oct 6');
  assert.equal(r.summary, '2h 55m tracked · 2 days active · 4 commits · 1 conversation with Claude · 4 tasks Claude finished');
  assert.equal(r.perDay, 'Mon 2h 10m · Tue 45m');
  assert.deepEqual(section(r, 'shipped').items, ['Released 0.9.0: Ruler and trays']);
  assert.deepEqual(section(r, 'built').items, ['Ruler']);
  assert.deepEqual(section(r, 'fixed').items, ['Trays']);
  assert.deepEqual(section(r, 'other').items, ['Readme']);
  assert.deepEqual(section(r, 'notes').items, ['Call with Ana']);
  assert.deepEqual(section(r, 'claude').items, ['Ruler ticks']);
  assert.deepEqual(section(r, 'open').items, ['Conversation "Ruler ticks"']);
  assert.equal(r.quiet, false);
});

test('last week covers Monday to Sunday, and an empty section is left out', () => {
  const r = s.build('last-week', input({ commits: [{ at: at('2026-09-30'), subject: 'fix: last week' }] }), MONDAY);
  assert.equal(r.kind, 'last-week');
  assert.equal(r.title, 'site, week of Sep 28 – Oct 4');
  assert.deepEqual(r.sections.map(x => x.id), ['fixed', 'blockers']);
});

test('a quiet week says so', () => {
  const r = s.weekly(input({}), MONDAY);
  assert.equal(r.quiet, true);
  assert.equal(r.summary, 'A quiet week: nothing logged');
});

// ------------------------------------------------------------------ the words

test('Slack: bold headings and bullets, and a commit can never ping the channel', () => {
  const r = s.standup(input({ commits: [{ at: at('2026-10-02'), subject: 'fix: tell @here and @channel, not me@here.com' }] }), MONDAY);
  const text = s.toSlack(r);
  assert.match(text, /^\*site standup, Mon, Oct 5\*\n\n\*Yesterday\* \(Fri, Oct 2\)\n• Tell `@here` and `@channel`, not me@here\.com/);
  assert.match(text, /\*Blockers\*\n• _None_$/);
});

test('long sections end in "and N more"', () => {
  const commits = Array.from({ length: s.MAX_ITEMS + 3 }, (_, n) => ({ at: at('2026-10-02', 8) + n * 60000, subject: `feat: thing ${n}` }));
  const text = s.toText(s.standup(input({ commits }), MONDAY));
  assert.match(text, /- Thing 7\n- and 3 more\n/);
  assert.doesNotMatch(text, /Thing 8/);
});

test('control and invisible characters in a commit message are gone', () => {
  const zw = String.fromCharCode(0x200b);
  const esc = String.fromCharCode(27);
  const r = s.standup(input({ commits: [{ at: at('2026-10-02'), subject: `feat: a${zw}b${esc}[31mred` }] }), MONDAY);
  assert.deepEqual(section(r, 'yesterday').items, ['A b [31mred']);
});

// ------------------------------------------------------------------ the sources

test("time by day: tracked plus what you added, and the day's note, for any clone's case", () => {
  const key = ROOT.toLowerCase();
  const state = {
    projects: { [key]: { name: 'site' }, 'c:\\code\\other': { name: 'other' } },
    days: { '2026-10-02': { [key]: 3600, 'c:\\code\\other': 999 } },
    manual: { '2026-10-02': { [key]: 600 } },
    notes: { '2026-10-02': { [key]: 'Demo prep' } },
  };
  const w = s.windowOf('standup', MONDAY);
  assert.deepEqual(s.timeByDay(state, [ROOT.toUpperCase()], w), { '2026-10-02': { seconds: 4200, notes: ['Demo prep'] } });
  assert.deepEqual(s.timeByDay({ ...state, projects: { [key]: { name: 'site', ignored: true } } }, [ROOT], w), {});
  assert.deepEqual(s.timeByDay(null, [ROOT], w), {});
});

test("Claude's tasks by day, by the repo's folder name", () => {
  const weekly = { days: { '2026-10-02': { work: { Site: 2, other: 5 } }, bad: { work: { site: 1 } } } };
  assert.deepEqual(s.tasksByDay(weekly, ['site']), { '2026-10-02': 2 });
  assert.deepEqual(s.tasksByDay(null, ['site']), {});
});

test("a conversation in a copy that's since been cleaned up still counts for its project", () => {
  const list = [
    { id: 'a', cwd: path.join(ROOT, 'src'), updatedAt: 3 },
    { id: 'b', cwd: 'C:\\Users\\me\\AppData\\Roaming\\Shellby\\worktrees\\x\\site', worktree: { originalCwd: ROOT }, updatedAt: 5 },
    { id: 'c', cwd: 'C:\\code\\other', updatedAt: 9 },
  ];
  assert.deepEqual(sessionsIn(list, [ROOT]).map(e => e.id), ['b', 'a']);
});

// ------------------------------------------------------------------ Projects.report

function service({ found = detail(), commits = [], sessions = [], time = null, weekly = null } = {}) {
  const asked = [];
  const svc = new Projects({
    config: { get: () => null, set: () => {} },
    devServers: { view: () => ({ servers: [] }) },
    known: () => [], lastWorked: () => new Map(), github: () => null,
    now: () => MONDAY,
    sessions: () => sessions, time: () => time, weekly: () => weekly,
    commits: async (root, from, to) => { asked.push({ root, from, to }); return commits; },
  });
  svc.detail = async key => (key === found?.key ? found : null);
  return { svc, asked };
}

test('report() gathers commits, conversations, time and tasks, and words them both ways', async () => {
  const { svc, asked } = service({
    commits: [{ at: at('2026-10-02', 10), subject: 'feat: ruler' }],
    sessions: [{ id: 's1', title: 'Ruler ticks', cwd: ROOT, createdAt: at('2026-10-02'), updatedAt: at('2026-10-02'), done: true }],
    time: { projects: { [ROOT.toLowerCase()]: { name: 'site' } }, days: { '2026-10-02': { [ROOT.toLowerCase()]: 5400 } } },
    weekly: { days: { '2026-10-02': { work: { site: 4 } } } },
  });
  const r = await svc.report('github:me/site', 'standup');
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'standup');
  assert.deepEqual(asked, [{ root: ROOT, ...s.windowOf('standup', MONDAY) }]);
  assert.deepEqual(section(r.report, 'yesterday').items, ['Ruler', 'Worked with Claude on "Ruler ticks" (done)']);
  assert.match(r.slack, /^\*site standup/);
  assert.match(r.text, /Yesterday \(Fri, Oct 2 · 1h 30m tracked\)\n- Ruler/);
});

test('report(): an unknown kind is a standup; an unknown project is null; git failing is no commits', async () => {
  const { svc } = service();
  assert.equal((await svc.report('github:me/site', 'nonsense')).kind, 'standup');
  assert.equal(await svc.report('github:me/gone', 'week'), null);
  const broken = service();
  broken.svc.deps.commits = async () => { throw new Error('git is busy'); };
  assert.equal((await broken.svc.report('github:me/site', 'week')).ok, true);
});
