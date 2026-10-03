const { test } = require('node:test');
const assert = require('node:assert/strict');
const tt = require('../src/main/timetrack');
const { timesheetHtml, exportName } = require('../src/main/timesheet');
const { parseArgs } = require('../src/cli/shellby');

// Saturday 3 October 2026, mid-morning (local time).
const NOW = new Date(2026, 9, 3, 10, 0).getTime();
const at = (daysBack, hour = 10, min = 0) => new Date(2026, 9, 3 - daysBack, hour, min).getTime();
const MIN = 60 * 1000;
const SHELLBY = { key: 'c:\\users\\jacob\\documents\\github\\shellby', name: 'shellby' };
const SHELLBY_API = { key: 'c:\\users\\jacob\\documents\\github\\shellby-api', name: 'shellby-api' };
const RACK = { key: 'c:\\users\\jacob\\documents\\github\\3d-rack', name: '3d-rack' };
const API = { key: 'c:\\work\\api', name: 'api' };
const PROJECTS = [SHELLBY, SHELLBY_API, RACK, API];

const on = (state = null) => tt.setSettings(state, { enabled: true });
const withProjects = (state, ...ps) => ps.reduce((s, p) => tt.ensureProject(s, p.key, p.name), state);

// ------------------------------------------------------------------ state

test('anything read from disk comes back sane', () => {
  const s = tt.normalize({
    enabled: 'yes', idleMinutes: 7, roundMinutes: 13, roundMode: 'down', currency: 'euro',
    projects: { [SHELLBY.key]: { name: 'x'.repeat(100), rate: -5, client: 3, billable: undefined }, '': { name: 'nope' } },
    days: { nope: { a: 5 }, '2026-10-01': { [SHELLBY.key]: 90000, bad: -1, [RACK.key]: 'x' } },
    manual: { '2026-10-01': { [SHELLBY.key]: 0, [RACK.key]: -600 } },
    notes: { '2026-10-01': { [SHELLBY.key]: 'Fixed\nthe build', [RACK.key]: '' } },
  });
  assert.equal(s.enabled, true);
  assert.equal(s.idleMinutes, tt.DEFAULTS.idleMinutes);
  assert.equal(s.roundMinutes, tt.DEFAULTS.roundMinutes);
  assert.equal(s.roundMode, 'nearest');
  assert.equal(s.currency, 'USD');
  assert.deepEqual(Object.keys(s.projects), [SHELLBY.key]);
  assert.equal(s.projects[SHELLBY.key].name.length, 60);
  assert.equal(s.projects[SHELLBY.key].rate, null);
  assert.equal(s.projects[SHELLBY.key].client, '');
  assert.equal(s.projects[SHELLBY.key].billable, true);
  assert.deepEqual(s.days, { '2026-10-01': { [SHELLBY.key]: 24 * 3600 } });
  assert.deepEqual(s.manual, { '2026-10-01': { [RACK.key]: -600 } });
  assert.deepEqual(s.notes, { '2026-10-01': { [SHELLBY.key]: 'Fixed the build' } });
  assert.deepEqual(tt.normalize(null).days, {});
  assert.equal(tt.normalize(null).enabled, false, 'off until you turn it on');
});

test('settings only take the choices on offer', () => {
  let s = tt.setSettings(null, { enabled: true, idleMinutes: 10, roundMinutes: 6, roundMode: 'up', currency: 'eur' });
  assert.deepEqual([s.enabled, s.idleMinutes, s.roundMinutes, s.roundMode, s.currency], [true, 10, 6, 'up', 'EUR']);
  s = tt.setSettings(s, { idleMinutes: 999, currency: 'dollars' });
  assert.equal(s.idleMinutes, tt.DEFAULTS.idleMinutes);
  assert.equal(s.currency, 'EUR', 'a bad currency leaves the old one');
});

// ------------------------------------------------------------------ which project is in front

test('knows editors, terminals and browsers by their exe, and nothing else', () => {
  assert.equal(tt.appKind('Code.exe'), 'editor');
  assert.equal(tt.appKind('idea64.exe'), 'editor');
  assert.equal(tt.appKind('WindowsTerminal.exe'), 'terminal');
  assert.equal(tt.appKind('mintty.exe'), 'terminal');
  assert.equal(tt.appKind('chrome.exe'), 'browser');
  assert.equal(tt.appKind('GitHubDesktop.exe'), 'tool');
  assert.equal(tt.appKind('spotify.exe'), null);
  assert.equal(tt.appKind('discord.exe'), null);
  assert.equal(tt.appKind(''), null);
});

test('finds the project in an editor title', () => {
  assert.equal(tt.matchTitle('● main.js - shellby - Visual Studio Code', 'editor', PROJECTS), SHELLBY.key);
  assert.equal(tt.matchTitle('server.ts - shellby-api - Cursor', 'editor', PROJECTS), SHELLBY_API.key, 'the longer name, not its prefix');
  assert.equal(tt.matchTitle('3d-rack – RackView.tsx', 'editor', PROJECTS), RACK.key, 'JetBrains puts the project first');
  assert.equal(tt.matchTitle('index.js - api - Visual Studio Code', 'editor', PROJECTS), API.key, 'an editor title is trusted even for a plain name');
  assert.equal(tt.matchTitle('Welcome - Visual Studio Code', 'editor', PROJECTS), null);
  assert.equal(tt.matchTitle('notshellby - Visual Studio Code', 'editor', PROJECTS), null, 'not inside another word');
});

test('finds the project in a terminal by its folder', () => {
  assert.equal(tt.matchTitle('PS C:\\Users\\jacob\\Documents\\GitHub\\3d-rack\\src>', 'terminal', PROJECTS), RACK.key);
  assert.equal(tt.matchTitle('MINGW64:/c/Users/jacob/Documents/GitHub/shellby', 'terminal', PROJECTS), SHELLBY.key, 'Git Bash paths too');
  assert.equal(tt.matchTitle('npm run dev in api', 'terminal', PROJECTS), null, 'a generic name alone is not enough outside an editor');
  assert.equal(tt.matchTitle('C:\\work\\api> npm test', 'terminal', PROJECTS), API.key, '...but its folder is');
  assert.equal(tt.matchTitle('Windows PowerShell', 'terminal', PROJECTS), null);
});

test('a folder in the title beats a name, and ties go to the most recent', () => {
  const nested = { key: 'c:\\users\\jacob\\documents\\github\\shellby\\packages\\3d-rack', name: 'inner' };
  assert.equal(tt.matchTitle('C:\\Users\\jacob\\Documents\\GitHub\\shellby\\packages\\3d-rack', 'terminal', [...PROJECTS, nested]), nested.key, 'the deepest folder');
  const twin = { key: 'd:\\forks\\shellby', name: 'shellby' };
  assert.equal(tt.matchTitle('shellby - Visual Studio Code', 'editor', [SHELLBY, twin], { [twin.key]: 2, [SHELLBY.key]: 1 }), twin.key);
});

test('names that are really object properties are never projects', () => {
  for (const key of ['constructor', 'toString', '__proto__', 'valueOf']) {
    let s = tt.ensureProject(on(), key, 'evil');
    assert.deepEqual(s.projects, {}, `${key} is not a folder`);
    s = tt.setProject(s, key, { rate: 500 });
    s = tt.adjust(s, '2026-10-01', key, 3600);
    s = tt.credit(s, key, 30, NOW);
    assert.deepEqual([s.projects, s.days, s.manual], [{}, {}, {}]);
  }
  // A settings file someone edited by hand can't break the summary either.
  const s = tt.normalize({ projects: { constructor: { name: 'x' } }, days: { '2026-10-01': { toString: 60 } } });
  assert.deepEqual(s.projects, {});
  const sum = tt.summarize(s, { from: '2026-09-28', to: '2026-10-03' }, { commits: { constructor: 'nope', [SHELLBY.key]: 'nope' }, names: {} });
  assert.deepEqual(sum.projects, []);
});

test('commit messages lose control and invisible characters', () => {
  const evil = 'Fix\u009b31m red‮exe.txt​';
  const s = withProjects(on(), SHELLBY);
  const sum = tt.summarize(s, { from: '2026-10-03', to: '2026-10-03' }, { commits: { [SHELLBY.key]: [{ at: at(0), subject: evil }] } });
  assert.equal(sum.projects[0].days[0].commits[0].subject, 'Fix 31m red exe.txt');
});

test('in a browser, only a repository page counts', () => {
  assert.equal(tt.matchTitle('Fix the build · Pull Request #12 · x-salmon/shellby · GitHub - Google Chrome', 'browser', PROJECTS), SHELLBY.key);
  assert.equal(tt.matchTitle('cheap-ads/shellby | Totally real - Google Chrome', 'browser', PROJECTS), null, 'any site can put owner/name in its title');
  assert.equal(tt.matchTitle('x-salmon/3d-rack · GitLab - Mozilla Firefox', 'browser', PROJECTS), RACK.key);
  assert.equal(tt.matchTitle('shellby - Google Search - Google Chrome', 'browser', PROJECTS), null);
  assert.equal(tt.matchTitle('YouTube - Mozilla Firefox', 'browser', PROJECTS), null);
});

test('attribute: away, other apps, windows, Claude and the recent project', () => {
  const base = { now: NOW, projects: PROJECTS, idleMinutes: 5 };
  const code = { exe: 'code.exe', title: 'a.js - shellby - Visual Studio Code' };
  assert.deepEqual(tt.attribute({ ...base, win: code, idleMs: 6 * MIN }), { key: null, why: 'idle' });
  assert.deepEqual(tt.attribute({ ...base, win: code, locked: true }), { key: null, why: 'idle' });
  assert.deepEqual(tt.attribute({ ...base, win: code }), { key: SHELLBY.key, why: 'window' });
  assert.deepEqual(tt.attribute({ ...base, win: { exe: 'spotify.exe', title: 'shellby' }, claude: RACK.key }), { key: null, why: 'other' }, "music isn't work, even with Claude busy");
  assert.deepEqual(tt.attribute({ ...base, win: null }), { key: null, why: 'none' });

  const pwsh = { exe: 'windowsterminal.exe', title: 'PowerShell' };
  const recent = { key: RACK.key, at: NOW - 10 * MIN };
  assert.deepEqual(tt.attribute({ ...base, win: pwsh, recent }), { key: RACK.key, why: 'recent' });
  assert.deepEqual(tt.attribute({ ...base, win: pwsh, recent: { ...recent, at: NOW - 20 * MIN } }), { key: null, why: 'none' }, 'not forever');
  const chrome = { exe: 'chrome.exe', title: 'MDN Web Docs - Google Chrome' };
  assert.deepEqual(tt.attribute({ ...base, win: chrome, recent }), { key: null, why: 'none' }, 'a browser holds on for less time');
  assert.deepEqual(tt.attribute({ ...base, win: chrome, recent: { ...recent, at: NOW - 3 * MIN } }), { key: RACK.key, why: 'recent' });

  assert.deepEqual(tt.attribute({ ...base, win: chrome, claude: SHELLBY.key }), { key: SHELLBY.key, why: 'claude' }, 'reading while Claude works');
  assert.deepEqual(tt.attribute({ ...base, win: { self: true, exe: 'shellby.exe', title: 'Shellby' }, claude: SHELLBY.key }), { key: SHELLBY.key, why: 'shellby' });
  assert.deepEqual(tt.attribute({ ...base, win: code, claude: RACK.key }), { key: SHELLBY.key, why: 'window' }, 'the window in front wins');
});

// ------------------------------------------------------------------ counting

test('credit adds up per day, never too much at once, and skips ignored projects', () => {
  let s = withProjects(on(), SHELLBY, RACK);
  s = tt.credit(s, SHELLBY.key, 15, at(0));
  s = tt.credit(s, SHELLBY.key, 15, at(0));
  s = tt.credit(s, SHELLBY.key, 3600, at(0)); // a stall: capped
  s = tt.credit(s, SHELLBY.key, 15, at(1));
  assert.equal(s.days[tt.dayKey(at(0))][SHELLBY.key], 30 + tt.MAX_CREDIT_S);
  assert.equal(s.days[tt.dayKey(at(1))][SHELLBY.key], 15);
  s = tt.setProject(s, RACK.key, { ignored: true });
  assert.equal(tt.credit(s, RACK.key, 15, at(0)).days[tt.dayKey(at(0))][RACK.key], undefined);
  assert.deepEqual(tt.credit(s, SHELLBY.key, -5, at(0)), tt.normalize(s), 'nothing for negative time');
});

test('time by hand: added, taken off, never below zero, with a note', () => {
  const day = tt.dayKey(at(0));
  let s = withProjects(on(), SHELLBY);
  s = tt.credit(s, SHELLBY.key, 60, at(0));
  s = tt.adjust(s, day, SHELLBY.key, 30 * 60);
  assert.equal(s.manual[day][SHELLBY.key], 1800);
  s = tt.adjust(s, day, SHELLBY.key, -10 * 3600);
  assert.equal(s.manual[day][SHELLBY.key], -60, 'only as much as there was');
  s = tt.setNote(s, day, SHELLBY.key, 'Client call about the launch');
  assert.equal(s.notes[day][SHELLBY.key], 'Client call about the launch');
  s = tt.setNote(s, day, SHELLBY.key, '');
  assert.equal(s.notes[day]?.[SHELLBY.key], undefined);
  assert.deepEqual(tt.adjust(s, day, 'c:\\not\\on\\books', 600), s, 'only projects on the books');
  assert.deepEqual(tt.adjust(s, 'today', SHELLBY.key, 600), s);
});

test('a project can be named, billed and forgotten', () => {
  let s = withProjects(on(), SHELLBY);
  s = tt.setProject(s, SHELLBY.key, { name: 'Shellby app', client: 'Harbor Tree', rate: '85.555', billable: false, evil: 1 });
  assert.deepEqual(s.projects[SHELLBY.key], { name: 'Shellby app', client: 'Harbor Tree', rate: 85.56, billable: false, ignored: false, added: false });
  s = tt.setProject(s, SHELLBY.key, { rate: '' });
  assert.equal(s.projects[SHELLBY.key].rate, null);
  s = tt.credit(s, SHELLBY.key, 30, at(0));
  s = tt.removeProject(s, SHELLBY.key);
  assert.deepEqual(s.projects, {});
  assert.deepEqual(s.days, {});
});

test('rounding: nearest or up, real work is one step, a glance is nothing', () => {
  assert.equal(tt.roundSeconds(0, 15), 0);
  assert.equal(tt.roundSeconds(10, 15), 0, 'ten seconds is not fifteen minutes');
  assert.equal(tt.roundSeconds(90, 15), 0);
  assert.equal(tt.roundSeconds(90, 15, 'up'), 15 * 60, 'rounding up bills from a minute');
  assert.equal(tt.roundSeconds(3 * 60, 15), 15 * 60, 'a few minutes is still billed as one step');
  assert.equal(tt.roundSeconds(22 * 60, 15), 15 * 60);
  assert.equal(tt.roundSeconds(23 * 60, 15), 30 * 60);
  assert.equal(tt.roundSeconds(16 * 60, 15, 'up'), 30 * 60);
  assert.equal(tt.roundSeconds(1234, 0), 1234, 'off');
});

test('estimates time from commits the git-hours way', () => {
  assert.equal(tt.estimateFromCommits([]), 0);
  assert.equal(tt.estimateFromCommits([at(0, 9)]), 30 * 60, 'one commit: half an hour');
  assert.equal(tt.estimateFromCommits([at(0, 9), at(0, 10), at(0, 11)]), (30 + 120) * 60, 'one sitting');
  assert.equal(tt.estimateFromCommits([at(0, 9), at(0, 14)]), 60 * 60, 'two sittings, half an hour each');
});

test('ranges start weeks on Monday', () => {
  const r = Object.fromEntries(tt.ranges(NOW).map(x => [x.id, x]));
  assert.deepEqual([r.today.from, r.today.to], ['2026-10-03', '2026-10-03']);
  assert.deepEqual([r.week.from, r.week.to], ['2026-09-28', '2026-10-03']);
  assert.deepEqual([r['last-week'].from, r['last-week'].to], ['2026-09-21', '2026-09-27']);
  assert.deepEqual([r.month.from, r['last-month'].from, r['last-month'].to], ['2026-10-01', '2026-09-01', '2026-09-30']);
  assert.equal(tt.daysBetween('2026-09-28', '2026-10-03').length, 6);
  assert.deepEqual(tt.daysBetween('2026-10-03', '2026-09-28'), []);
});

// ------------------------------------------------------------------ summaries and exports

function billedWeek() {
  let s = withProjects(tt.setSettings(null, { enabled: true, roundMinutes: 15 }), SHELLBY, RACK);
  s = tt.setProject(s, SHELLBY.key, { client: 'Harbor Tree', rate: 100 });
  s = tt.setProject(s, RACK.key, { client: 'Rack Co', rate: 50, billable: false });
  for (let i = 0; i < 80; i++) s = tt.credit(s, SHELLBY.key, 60, at(1)); // 80 min -> 1h 15m
  for (let i = 0; i < 30; i++) s = tt.credit(s, RACK.key, 60, at(0));
  s = tt.setNote(s, tt.dayKey(at(1)), SHELLBY.key, 'Launch prep');
  return s;
}

test('summarize: rounded hours, amounts, commits and the days', () => {
  const commits = { [SHELLBY.key]: [{ at: at(1, 9), subject: 'Fix the build' }, { at: at(2, 9), subject: '=HYPERLINK("x")' }] };
  const sum = tt.summarize(billedWeek(), { from: '2026-09-28', to: '2026-10-03' }, { commits });
  const [a, b] = sum.projects;
  assert.equal(a.key, SHELLBY.key);
  assert.equal(a.seconds, 80 * 60);
  assert.equal(a.billed, 75 * 60);
  assert.equal(a.amount, 125);
  assert.equal(a.commitCount, 2);
  assert.equal(a.unfilled, 30 * 60, "a day with a commit and no time shows what it'd be");
  assert.equal(b.key, RACK.key);
  assert.equal(b.amount, 0, 'not billable');
  assert.equal(sum.totals.billed, 75 * 60, 'only billable hours count toward the total');
  assert.equal(sum.totals.amount, 125);
  assert.equal(sum.days.length, 6);
  assert.deepEqual(sum.clients, ['Harbor Tree', 'Rack Co']);
  assert.equal(tt.lineText(a.days.find(r => r.day === tt.dayKey(at(1)))), 'Launch prep', 'the note beats the commits');

  const filled = tt.summarize(billedWeek(), { from: '2026-09-28', to: '2026-10-03' }, { commits, estimates: true });
  const day2 = filled.projects[0].days.find(r => r.day === tt.dayKey(at(2)));
  assert.equal(day2.estimated, true);
  assert.equal(day2.total, 30 * 60);

  const one = tt.summarize(billedWeek(), { from: '2026-09-28', to: '2026-10-03' }, { only: { client: 'Rack Co' } });
  assert.deepEqual(one.projects.map(p => p.key), [RACK.key]);
});

test('a day you took back to nothing is never filled in from commits', () => {
  const day = tt.dayKey(at(1));
  let s = withProjects(on(), SHELLBY);
  for (let i = 0; i < 10; i++) s = tt.credit(s, SHELLBY.key, 60, at(1));
  s = tt.adjust(s, day, SHELLBY.key, -600);
  const commits = { [SHELLBY.key]: [{ at: at(1, 9), subject: 'x' }, { at: at(2, 9), subject: 'y' }] };
  const sum = tt.summarize(s, { from: '2026-09-28', to: '2026-10-03' }, { commits, estimates: true });
  const rows = Object.fromEntries(sum.projects[0].days.map(r => [r.day, r]));
  assert.equal(rows[day].total, 0, 'you said nothing, so nothing');
  assert.equal(rows[day].estimated, false);
  assert.equal(rows[tt.dayKey(at(2))].estimated, true, 'an untouched day still fills in');
});

test('summarize shows commits for a known project with no time yet', () => {
  const other = { key: 'c:\\code\\new-site', name: 'new-site' };
  const commits = { [other.key]: [{ at: at(1), subject: 'Start' }] };
  assert.equal(tt.summarize(on(), { from: '2026-09-28', to: '2026-10-03' }, { commits }).projects.length, 0, 'not without a name');
  const sum = tt.summarize(on(), { from: '2026-09-28', to: '2026-10-03' }, { commits, names: { [other.key]: other.name } });
  assert.equal(sum.projects[0].name, 'new-site');
  assert.equal(sum.projects[0].onBooks, false);
});

test('CSV: one row per day, and a commit message can never be a formula', () => {
  const commits = { [SHELLBY.key]: [{ at: at(0, 9), subject: '=cmd|"/c calc"!A1' }] };
  let s = billedWeek();
  s = tt.credit(s, SHELLBY.key, 60, at(0));
  const csv = tt.toCsv(tt.summarize(s, { from: '2026-09-28', to: '2026-10-03' }, { commits }));
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], 'Date,Client,Project,Hours,Billed hours,Rate,Amount,Currency,Billable,Source,Description');
  assert.ok(lines.includes('2026-10-02,Harbor Tree,shellby,1.33,1.25,100,125.00,USD,yes,tracked,Launch prep'));
  const evil = lines.find(l => l.startsWith('2026-10-03,Harbor Tree'));
  assert.match(evil, /,"'=cmd\|""\/c calc""!A1"$/);
  assert.equal(tt.csvCell('+1'), "'+1");
  assert.equal(tt.csvCell('a,b'), '"a,b"');
});

test('text summary for pasting into an invoice', () => {
  const text = tt.toText(tt.summarize(billedWeek(), { from: '2026-09-28', to: '2026-10-03' }), 'This week');
  assert.match(text, /^Time, this week \(2026-09-28 to 2026-10-03\)/);
  assert.match(text, /Harbor Tree: shellby: 1\.25 h x \$100\.00\/h = \$125\.00/);
  assert.match(text, /Rack Co: 3d-rack: 0\.50 h \(not billable\)/);
  assert.match(text, /Total: 1\.25 billable hours, \$125\.00/);
});

test('the timesheet escapes everything it shows', () => {
  let s = billedWeek();
  s = tt.setProject(s, SHELLBY.key, { name: '<script>alert(1)</script>' });
  s = tt.setNote(s, tt.dayKey(at(1)), SHELLBY.key, '<img src=x onerror=alert(1)>');
  const html = timesheetHtml(tt.summarize(s, { from: '2026-09-28', to: '2026-10-03' }), { preparedBy: 'Jo "&" Co', label: 'This week' });
  assert.ok(!html.includes('<script>alert'));
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('Jo &quot;&amp;&quot; Co'));
  assert.match(html, /default-src 'none'/, 'and allows nothing to load or run');
  assert.match(html, /\$125\.00/);
});

test('export names are safe file names', () => {
  const sum = tt.summarize(billedWeek(), { from: '2026-09-28', to: '2026-10-03' });
  assert.equal(exportName(sum, { client: 'Harbor/Tree: "Inc"' }), 'Timesheet - Harbor Tree Inc - 2026-09-28 to 2026-10-03');
});

test('shellby time takes a range and --git', () => {
  assert.deepEqual(parseArgs(['time']), { cmd: 'time', range: 'week', estimates: false });
  assert.deepEqual(parseArgs(['time', 'last-month', '--git']), { cmd: 'time', range: 'last-month', estimates: true });
  assert.ok(parseArgs(['time', 'yesterday']).error);
});
