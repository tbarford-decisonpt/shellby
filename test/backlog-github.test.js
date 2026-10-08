const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fetchBacklog, issueOf, milestoneOf, combine, errorText } = require('../src/main/backlog/github');

const api = 'https://api.github.com';
const web = 'https://github.com';
const deps = { api, web, login: 'me' };

const raw = (number, extra = {}) => ({
  number, title: `Issue ${number}`, body: 'body', repository_url: `${api}/repos/me/crab`,
  labels: [{ name: 'bug' }], user: { login: 'pal' }, assignees: [], comments: 0,
  updated_at: '2026-10-01T10:00:00Z', ...extra,
});

const milestone = (number, extra = {}) => ({ number, title: `v${number}`, due_on: null, open_issues: 1, closed_issues: 2, html_url: `${web}/me/crab/milestone/${number}`, ...extra });

// A pretend gh: answers by a substring of the path, records every path asked for.
function pretendGh(answers = {}) {
  const paths = [];
  return {
    paths,
    async get(path) {
      paths.push(path);
      const hit = Object.keys(answers).find(k => path.includes(k));
      if (!hit) return [];
      const a = answers[hit];
      if (a instanceof Error) throw a;
      return a;
    },
  };
}

const failure = (status, message = 'nope') => Object.assign(new Error(message), { status });

// ------------------------------------------------------------------ fetchBacklog

test('fetchBacklog drops pull requests', async () => {
  const gh = pretendGh({ 'sort=updated': [raw(1), raw(2, { pull_request: { url: 'x' } }), raw(3)] });

  const r = await fetchBacklog('me/crab', { gh, ...deps });

  assert.equal(r.ok, true);
  assert.deepEqual(r.issues.map(i => i.number).sort(), [1, 3]);
});

test('fetchBacklog combines the recent, assigned and milestone lists by key', async () => {
  const gh = pretendGh({
    '/milestones?': [milestone(5, { due_on: '2026-10-20T00:00:00Z' })],
    'sort=updated': [raw(1), raw(2)],
    'assignee=me': [raw(2), raw(3)],
    'milestone=5': [raw(3), raw(4)],
  });

  const r = await fetchBacklog('me/crab', { gh, ...deps });

  assert.deepEqual(r.issues.map(i => i.key).sort(), ['me/crab#1', 'me/crab#2', 'me/crab#3', 'me/crab#4']);
});

test('fetchBacklog asks for the open milestones soonest due first', async () => {
  const gh = pretendGh();

  await fetchBacklog('me/crab', { gh, ...deps });

  assert.ok(gh.paths.includes('/repos/me/crab/milestones?state=open&sort=due_on&direction=asc&per_page=20'));
});

test('fetchBacklog reads the nearest milestone\'s issues only when a milestone has a due date', async () => {
  const undated = pretendGh({ '/milestones?': [milestone(5)] });
  const dated = pretendGh({ '/milestones?': [milestone(5), milestone(6, { due_on: '2026-11-01T00:00:00Z' }), milestone(7, { due_on: '2026-10-15T00:00:00Z' })] });

  await fetchBacklog('me/crab', { gh: undated, ...deps });
  await fetchBacklog('me/crab', { gh: dated, ...deps });

  assert.ok(!undated.paths.some(p => p.includes('milestone=')));
  assert.equal(dated.paths.filter(p => p.includes('milestone=')).length, 1);
  assert.ok(dated.paths.some(p => p.includes('&milestone=7')), 'the one due soonest');
});

test('fetchBacklog reads the assigned list only for a valid login', async () => {
  const withLogin = pretendGh();
  const without = pretendGh();
  const bad = pretendGh();

  await fetchBacklog('me/crab', { gh: withLogin, ...deps });
  await fetchBacklog('me/crab', { gh: without, api, web });
  await fetchBacklog('me/crab', { gh: bad, api, web, login: 'bad login&x=1' });

  assert.ok(withLogin.paths.some(p => p.includes('assignee=me')));
  assert.ok(!without.paths.some(p => p.includes('assignee=')));
  assert.ok(!bad.paths.some(p => p.includes('assignee=')));
});

test('fetchBacklog asks for open issues, a hundred a page, newest update first', async () => {
  const gh = pretendGh();

  await fetchBacklog('me/crab', { gh, ...deps });

  assert.ok(gh.paths.includes('/repos/me/crab/issues?state=open&per_page=100&sort=updated&direction=desc'));
});

test('fetchBacklog returns the open milestones, mapped', async () => {
  const gh = pretendGh({ '/milestones?': [milestone(5, { due_on: '2026-10-20T00:00:00Z' }), 'junk', null] });

  const r = await fetchBacklog('me/crab', { gh, ...deps });

  assert.deepEqual(r.milestones, [{
    number: 5, title: 'v5', dueOn: Date.parse('2026-10-20T00:00:00Z'), open: 1, closed: 2, url: `${web}/me/crab/milestone/5`,
  }]);
});

test('fetchBacklog refuses an invalid repository without calling gh', async () => {
  const gh = pretendGh();

  for (const repo of ['', null, 'nope', 'a/b/c', 'a b/c', '../etc/passwd', 'me/crab?x=1']) {
    const r = await fetchBacklog(repo, { gh, ...deps });

    assert.equal(r.ok, false, String(repo));
    assert.equal(r.status, 400);
  }
  assert.deepEqual(gh.paths, []);
});

test('fetchBacklog refuses a repository that climbs out of /repos', async () => {
  const gh = pretendGh();

  const r = await fetchBacklog('../etc', { gh, ...deps });

  assert.equal(r.ok, false);
  assert.deepEqual(gh.paths, []);
});

test('fetchBacklog turns a failure into words and a status', async () => {
  const cases = [
    [failure(401), 401, /^GitHub signed Shellby out\.$/],
    [failure(404), 404, /Let Claude tasks push/],
    [failure(410), 410, /Issues are turned off/],
    [failure(403), 403, /limiting how often/],
    [failure(500, 'Server fell over'), 500, /^Couldn't read its issues: Server fell over$/],
  ];

  for (const [err, status, text] of cases) {
    const r = await fetchBacklog('me/crab', { gh: pretendGh({ '/milestones?': err }), ...deps });

    assert.equal(r.ok, false);
    assert.equal(r.status, status);
    assert.match(r.error, text);
  }
});

test('fetchBacklog reports status 0 for an error with none', async () => {
  const r = await fetchBacklog('me/crab', { gh: pretendGh({ 'sort=updated': new Error('socket hang up') }), ...deps });

  assert.deepEqual(r, { ok: false, error: "Couldn't read its issues: socket hang up", status: 0 });
});

test('fetchBacklog treats a reply that is not a list as empty', async () => {
  const gh = pretendGh({ '/milestones?': { message: 'odd' }, 'sort=updated': { message: 'odd' } });

  const r = await fetchBacklog('me/crab', { gh, ...deps });

  assert.deepEqual(r, { ok: true, issues: [], milestones: [], complete: true });
});

test('fetchBacklog says the list is incomplete when the recent page comes back full', async () => {
  const page = Array.from({ length: 100 }, (_, i) => raw(i + 1));
  const full = await fetchBacklog('me/crab', { gh: pretendGh({ '/milestones?': [], 'sort=updated': page }), ...deps });
  const short = await fetchBacklog('me/crab', { gh: pretendGh({ '/milestones?': [], 'sort=updated': page.slice(0, 99) }), ...deps });

  assert.equal(full.complete, false, 'there may be open issues past the first 100');
  assert.equal(short.complete, true);
});

// ------------------------------------------------------------------ issueOf

test('issueOf maps assignees, mine, milestone, thumbs, comments and updatedAt', () => {
  const item = issueOf(raw(42, {
    assignees: [{ login: 'Me' }, { login: 'pal' }, { login: 'bad login' }, null],
    milestone: milestone(5, { due_on: '2026-10-20T00:00:00Z' }),
    reactions: { '+1': 4, '-1': 9 },
    comments: 3,
  }), deps);

  assert.equal(item.key, 'me/crab#42');
  assert.deepEqual(item.assignees, ['Me', 'pal']);
  assert.equal(item.mine, true);
  assert.deepEqual(item.milestone, { number: 5, title: 'v5', dueOn: Date.parse('2026-10-20T00:00:00Z') });
  assert.equal(item.thumbs, 4);
  assert.equal(item.comments, 3);
  assert.equal(item.updatedAt, Date.parse('2026-10-01T10:00:00Z'));
});

test('issueOf has sensible defaults for what GitHub left out', () => {
  const item = issueOf({ ...raw(1), updated_at: 'not a date', assignees: undefined }, { api, web });

  assert.deepEqual(item.assignees, []);
  assert.equal(item.mine, false);
  assert.equal(item.milestone, null);
  assert.equal(item.thumbs, 0);
  assert.equal(item.comments, 0);
  assert.equal(item.updatedAt, null);
});

test('issueOf is not mine when the login is not an assignee', () => {
  assert.equal(issueOf(raw(1, { assignees: [{ login: 'pal' }] }), deps).mine, false);
});

test('issueOf gives null for a pull request or anything that is not an issue', () => {
  assert.equal(issueOf(raw(1, { pull_request: {} }), deps), null);
  assert.equal(issueOf(raw(1, { repository_url: 'https://evil.example/repos/a/b' }), deps), null);
  assert.equal(issueOf(null, deps), null);
});

// ------------------------------------------------------------------ milestoneOf, combine, errorText

test('milestoneOf names an untitled milestone and drops a link that is not https', () => {
  const m = milestoneOf({ number: 3, title: '', html_url: 'javascript:alert(1)' });

  assert.equal(m.title, 'Milestone 3');
  assert.equal(m.url, null);
  assert.equal(m.dueOn, null);
});

test('milestoneOf gives null for something without a number', () => {
  assert.equal(milestoneOf(null), null);
  assert.equal(milestoneOf({ title: 'x' }), null);
  assert.equal(milestoneOf({ number: '5' }), null);
});

test('combine keeps the first of each key', () => {
  const a = { key: 'me/crab#1', title: 'from a' };
  const b = { key: 'me/crab#1', title: 'from b' };
  const c = { key: 'me/crab#2', title: 'from c' };

  assert.deepEqual(combine([[a], [b, c]]), [a, c]);
  assert.deepEqual(combine([]), []);
});

test('errorText covers a missing error', () => {
  assert.equal(errorText(undefined), "Couldn't read its issues: GitHub didn't answer.");
});
