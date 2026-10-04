const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { IssueWatcher, queries, issueRef, fresh, see, combine, becameOurs } = require('../src/main/github/issues');
const { GitHubApi } = require('../src/main/github/api');

const api = 'https://api.github.com';
const web = 'https://github.com';

test('queries: assigned anywhere, the label only where you decide who labels', () => {
  const q = queries('me', ['other/tool', 'me/crab', 'bad repo', 'Me/Shell']);
  assert.deepEqual(q.map(x => x.reason), ['assigned', 'labelled', 'labelled']);
  assert.match(q[0].q, /is:issue is:open .*assignee:me$/);
  assert.match(q[1].q, /label:shellby user:me$/);
  assert.match(q[2].q, /label:shellby repo:other\/tool$/, 'your own repos are already covered, junk is dropped');
  assert.ok(q.every(x => !/label:shellby$/.test(x.q)), 'never a global label search');
  assert.deepEqual(queries('', ['a/b']), []);
  assert.deepEqual(queries('bad login!', []), []);
});

test('queries: many cloned repos are split under GitHub\'s length limit, and capped', () => {
  const repos = Array.from({ length: 40 }, (_, i) => `someone-${i}/a-rather-long-repository-name`);
  const q = queries('me', repos).filter(x => x.q.includes(' repo:'));
  assert.equal(q.length, 2);
  for (const x of q) assert.ok(x.q.length <= 240, `${x.q.length} chars`);
});

test('issueRef keeps what a workflow needs and nothing that isn\'t an issue', () => {
  const item = {
    number: 42, title: 'Crab\nfalls off\u202e the window', body: 'Steps:\r\n1. throw him\n2. \u200bwatch',
    repository_url: `${api}/repos/me/crab`, labels: [{ name: 'shellby' }, { name: 'bug' }], user: { login: 'pal' },
    html_url: 'https://evil.example/somewhere',
  };
  assert.deepEqual(issueRef(item, { api, web }), {
    key: 'me/crab#42', repo: 'me/crab', number: 42, title: 'Crab falls off the window',
    body: 'Steps:\n1. throw him\n2. watch', labels: ['shellby', 'bug'], author: 'pal',
    url: 'https://github.com/me/crab/issues/42',
  });
  assert.equal(issueRef({ ...item, pull_request: {} }, { api, web }), null, 'pull requests are issues to the search API');
  assert.equal(issueRef({ ...item, repository_url: 'https://evil.example/repos/a/b' }, { api, web }), null);
  assert.equal(issueRef({ ...item, number: 0 }, { api, web }), null);
  assert.equal(issueRef({ ...item, body: 'x'.repeat(10000) }, { api, web }).body.length, 4000);
});

test('fresh: the first poll only learns; then unseen ones, and memory is capped', () => {
  const i = n => ({ key: `a/b#${n}` });
  const one = fresh(null, [i(1), i(2)], 1000);
  assert.deepEqual(one.unseen, []);
  assert.deepEqual(one.state, { primed: true, primedAt: 1000, seen: ['a/b#1', 'a/b#2'] });
  const two = fresh(one.state, [i(2), i(3)], 2000);
  assert.deepEqual(two.unseen.map(x => x.key), ['a/b#3']);
  assert.equal(two.state.primedAt, 1000, 'still counts from when he started watching');
  const after = see(two.state, ['a/b#3']);
  assert.deepEqual(after.seen, ['a/b#3', 'a/b#1', 'a/b#2'], 'closed ones are still remembered');
  assert.deepEqual(fresh(after, [i(1), i(3)], 3000).unseen, [], 'reopened or re-found issues are not looked at again');
  assert.equal(fresh({ primed: true, seen: [] }, [], 5000).state.primedAt, 5000, 'state from before primedAt counts from now');
  let s = after;
  for (let n = 0; n < 500; n++) s = see(s, [`a/b#${1000 + n}`]);
  assert.equal(s.seen.length, 400);
});

test('becameOurs: only an assignment to you, or the label, since he started watching', () => {
  const since = Date.parse('2026-10-01T00:00:00Z');
  const ev = (event, at, extra) => ({ event, created_at: at, ...extra });
  const events = [
    ev('assigned', '2026-09-01T00:00:00Z', { assignee: { login: 'me' } }),
    ev('labeled', '2026-10-02T00:00:00Z', { label: { name: 'bug' } }),
    ev('assigned', '2026-10-02T00:00:00Z', { assignee: { login: 'pal' } }),
    ev('commented', '2026-10-03T00:00:00Z'),
  ];
  assert.deepEqual(becameOurs(events, ['assigned'], 'me', since), [], 'assigned long ago: an old issue, not a new one');
  const later = [...events, ev('labeled', '2026-10-03T00:00:00Z', { label: { name: 'Shellby' } }), ev('assigned', '2026-10-03T00:00:00Z', { assignee: { login: 'ME' } })];
  assert.deepEqual(becameOurs(later, ['assigned', 'labelled'], 'me', since), ['assigned', 'labelled']);
  assert.deepEqual(becameOurs(later, ['labelled'], 'me', since), ['labelled'], 'only the reasons it was found for');
  assert.deepEqual(becameOurs(null, ['assigned'], 'me', since), []);
});

test('combine merges the searches that found the same issue', () => {
  const x = { key: 'a/b#1', repo: 'a/b', number: 1 };
  const out = combine([{ reason: 'assigned', issues: [x] }, { reason: 'labelled', issues: [x, { ...x, key: 'a/b#2', number: 2 }] }]);
  assert.deepEqual(out.map(o => [o.key, o.reasons]), [['a/b#1', ['assigned', 'labelled']], ['a/b#2', ['labelled']]]);
});

test('IssueWatcher offers what became yours since it started watching, once, and forgets when stopped', async () => {
  const T0 = Date.parse('2026-10-03T12:00:00Z');
  let clock = T0;
  const at = ms => new Date(T0 + ms).toISOString();
  const gh = {
    assigned: [], mine: [], pal: [], events: {}, broken: new Set(), palPush: false, queries: [],
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('content-type', 'application/json');
    const send = d => res.end(JSON.stringify(d));
    const hit = (repo, n) => ({ number: n, title: `Issue ${n}`, body: 'Do it', repository_url: `${base}/repos/${repo}`, labels: [] });
    if (u.pathname === '/search/issues') {
      const q = u.searchParams.get('q');
      gh.queries.push(q);
      assert.equal(u.searchParams.get('sort'), 'updated', 'a new assignment brings an old issue into view');
      if (q.includes('assignee:me')) return send({ items: gh.assigned.map(n => hit('me/crab', n)) });
      if (q.includes('user:me')) return send({ items: gh.mine.map(n => hit('me/crab', n)) });
      if (q.includes('repo:pal/tool')) return send({ items: gh.pal.map(n => hit('pal/tool', n)) });
      return send({ items: [] });
    }
    const ev = /^\/repos\/(me\/crab|pal\/tool)\/issues\/(\d+)\/events$/.exec(u.pathname);
    if (ev && !gh.broken.has(Number(ev[2]))) return send(gh.events[`${ev[1]}#${ev[2]}`] || []);
    if (u.pathname === '/repos/pal/tool') return send({ permissions: { push: gh.palPush } });
    res.statusCode = 500; res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const assigned = (key, ms) => { gh.events[key] = [...(gh.events[key] || []), { event: 'assigned', created_at: at(ms), assignee: { login: 'me' } }]; };
  const labelled = (key, ms) => { gh.events[key] = [...(gh.events[key] || []), { event: 'labeled', created_at: at(ms), label: { name: 'shellby' } }]; };
  let stored = null;
  const watcher = () => {
    const w = new IssueWatcher({
      gh: () => new GitHubApi({ token: 't', api: base }), login: () => 'me', api: base, web, now: () => clock,
      repos: async () => ['pal/tool'], load: () => stored, save: v => { stored = v; },
    });
    w.offered = [];
    w.on('event', e => w.offered.push(e));
    return w;
  };
  const offered = w => w.offered.map(e => `${e.issue.key} ${e.issue.reasons.join('+')}`);
  const w = watcher();
  try {
    gh.assigned = [1];
    assigned('me/crab#1', -86400000);
    await w.poll();
    assert.deepEqual(offered(w), [], 'what was already there is not offered');
    assert.ok(gh.queries.some(q => q.includes('repo:pal/tool')), 'labels count in the repos cloned here');

    clock += 60000;
    gh.assigned = [1, 2]; gh.mine = [2];
    assigned('me/crab#2', 30000); labelled('me/crab#2', 31000);
    await w.poll();
    assert.deepEqual(offered(w), ['me/crab#2 assigned+labelled']);
    assert.equal(w.offered[0].type, 'assigned');
    assert.equal(w.offered[0].issue.url, 'https://github.com/me/crab/issues/2');
    assert.ok(w.view().issues.every(i => !('body' in i)), 'the panel never gets issue text');
    await w.poll();
    assert.equal(w.offered.length, 1, 'once only');

    // An old issue slides into view (another closed, or someone commented): not new, not offered.
    gh.assigned = [2, 5];
    assigned('me/crab#5', -5 * 86400000);
    await w.poll();
    assert.equal(w.offered.length, 1);

    // Labelled in someone else's repo: only where you can push.
    gh.pal = [9];
    labelled('pal/tool#9', 90000);
    await w.poll();
    assert.equal(w.offered.length, 1, 'no push access: not yours to take on');

    // GitHub doesn't answer about an issue: it's looked at again next time, not forgotten.
    gh.assigned = [2, 5, 4];
    assigned('me/crab#4', 120000);
    gh.broken.add(4);
    await w.poll();
    assert.equal(w.offered.length, 1);
    gh.broken.delete(4);
    await w.poll();
    assert.deepEqual(offered(w).slice(1), ['me/crab#4 assigned']);

    // A restart remembers: an issue assigned while Shellby was closed is still offered.
    clock += 3600000;
    gh.palPush = true;
    const again = watcher();
    gh.assigned = [2, 5, 4, 3]; gh.pal = [9, 10];
    assigned('me/crab#3', 3000000); labelled('pal/tool#10', 3100000);
    await again.poll();
    assert.deepEqual(offered(again), ['me/crab#3 assigned', 'pal/tool#10 labelled'], '#9 was already looked at');

    again.stop();
    assert.deepEqual(stored, { primed: false, seen: [] }, 'turned off: no backlog when it comes back on');
  } finally {
    w.stop();
    server.close();
  }
});

test('IssueWatcher fails the poll, rather than priming without them, when the cloned repos can\'t be listed', async () => {
  let stored = null;
  const gh = { get: async () => ({ items: [] }) };
  const w = new IssueWatcher({ gh: () => gh, login: () => 'me', repos: async () => { throw new Error('git broke'); }, load: () => stored, save: v => { stored = v; } });
  const v = await w.poll();
  assert.match(v.error, /git broke/);
  assert.equal(stored, null, 'not primed');
});

test('IssueWatcher reports a sign-out without throwing', async () => {
  const gh = { get: async () => { throw Object.assign(new Error('Bad credentials'), { status: 401 }); } };
  const w = new IssueWatcher({ gh: () => gh, login: () => 'me', load: () => null, save: () => {} });
  const v = await w.poll();
  assert.equal(v.error, 'GitHub signed Shellby out.');
});
