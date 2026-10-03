const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { CiWatcher, verdict, transitions, prRef } = require('../src/main/github/ci');
const { GitHubApi } = require('../src/main/github/api');

const run = (name, status, conclusion = null) => ({ name, status, conclusion });

test('verdict rolls check runs and commit statuses into one state', () => {
  assert.deepEqual(verdict([], []), { state: 'none', failing: [] });
  assert.equal(verdict([run('build', 'completed', 'success'), run('lint', 'completed', 'skipped')]).state, 'passing');
  assert.equal(verdict([run('build', 'in_progress')]).state, 'pending');
  assert.deepEqual(verdict([run('build', 'completed', 'failure'), run('e2e', 'queued')]), { state: 'failing', failing: ['build'] });
  assert.equal(verdict([run('x', 'completed', 'cancelled')]).state, 'passing', 'a cancelled run is not a failure');
  assert.deepEqual(verdict([], [{ context: 'ci/circleci', state: 'error' }]), { state: 'failing', failing: ['ci/circleci'] });
  assert.equal(verdict(null, [{ context: 'vercel', state: 'pending' }]).state, 'pending');
});

test('transitions: the first poll is quiet, then red, green and reviews are events', () => {
  const one = transitions(null, { prs: { 'a/b#1': { state: 'failing' } }, reviews: ['c/d#9'] });
  assert.deepEqual(one.events, []);
  const two = transitions(one.memory, { prs: { 'a/b#1': { state: 'pending' }, 'a/b#2': { state: 'pending' } }, reviews: ['c/d#9', 'c/d#10'] });
  assert.deepEqual(two.events, [{ type: 'review', key: 'c/d#10' }]);
  assert.equal(two.memory.prs['a/b#1'].wasFailing, true, 'a pending re-run still remembers the red build');
  const three = transitions(two.memory, { prs: { 'a/b#1': { state: 'passing' }, 'a/b#2': { state: 'failing' } }, reviews: [] });
  assert.deepEqual(three.events, [{ type: 'fixed', key: 'a/b#1' }, { type: 'failed', key: 'a/b#2' }]);
  const four = transitions(three.memory, { prs: { 'a/b#1': { state: 'passing' }, 'a/b#2': { state: 'failing' } }, reviews: [] });
  assert.deepEqual(four.events, [], 'no repeats while nothing changes');
  const five = transitions({ prs: { 'x/y#3': { state: 'pending', wasFailing: false } }, reviews: [] }, { prs: { 'x/y#3': { state: 'passing' } }, reviews: [] });
  assert.deepEqual(five.events, [{ type: 'passed', key: 'x/y#3' }]);
});

test('prRef only accepts GitHub-shaped search hits', () => {
  const api = 'https://api.github.com';
  assert.deepEqual(prRef({ number: 4, title: 'Fix\nit', repository_url: `${api}/repos/x-salmon/shellby` }, api), { key: 'x-salmon/shellby#4', repo: 'x-salmon/shellby', number: 4, title: 'Fix it' });
  assert.equal(prRef({ number: 4, repository_url: 'https://evil.example/repos/a/b' }, api), null);
  assert.equal(prRef({ number: 4, repository_url: `${api}/repos/a/b/../../c` }, api), null);
  assert.equal(prRef({ number: -1, repository_url: `${api}/repos/a/b` }, api), null);
});

test('CiWatcher polls a GitHub-like API and emits what changed', async () => {
  const sha = 'a'.repeat(40);
  let conclusion = 'failure';
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const json = d => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(d)); };
    if (u.pathname === '/search/issues') {
      const q = u.searchParams.get('q');
      if (q.includes('author:me')) return json({ items: [{ number: 7, title: 'Add molting', repository_url: `${api}/repos/me/crab` }] });
      return json({ items: [] });
    }
    if (u.pathname === '/repos/me/crab/pulls/7') return json({ head: { sha } });
    if (u.pathname === `/repos/me/crab/commits/${sha}/check-runs`) return json({ check_runs: [run('test', 'completed', conclusion)] });
    if (u.pathname === `/repos/me/crab/commits/${sha}/status`) return json({ statuses: [] });
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const api = `http://127.0.0.1:${server.address().port}`;
  try {
    const w = new CiWatcher({ gh: () => new GitHubApi({ token: 't', api }), login: () => 'me', api, web: 'https://github.com' });
    const events = [];
    w.on('event', e => events.push(e));
    let v = await w.poll();
    assert.equal(v.failing, 1);
    assert.deepEqual(v.prs[0].failing, ['test']);
    assert.equal(v.prs[0].url, 'https://github.com/me/crab/pull/7');
    assert.deepEqual(events, []);
    conclusion = 'success';
    v = await w.poll();
    assert.equal(v.failing, 0);
    assert.deepEqual(events.map(e => [e.type, e.pr.key]), [['fixed', 'me/crab#7']]);
  } finally {
    server.close();
  }
});

test('a stop() while a poll is in flight wins, and one unreadable PR does not sink the rest', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const sha = 'b'.repeat(40);
  const api = 'https://api.github.com';
  const gh = {
    get: async p => {
      if (p.startsWith('/search/issues') && p.includes('author')) {
        await gate;
        return { items: [1, 2].map(n => ({ number: n, title: `PR ${n}`, repository_url: `${api}/repos/me/crab` })) };
      }
      if (p.startsWith('/search/issues')) return { items: [] };
      if (p === '/repos/me/crab/pulls/1') { const e = new Error('Resource protected by SSO'); e.status = 403; throw e; }
      if (p === '/repos/me/crab/pulls/2') return { head: { sha } };
      if (p.endsWith('/check-runs?per_page=100')) return { check_runs: [{ name: 'test', status: 'completed', conclusion: 'failure' }] };
      return { statuses: [] };
    },
  };
  const w = new CiWatcher({ gh: () => gh, login: () => 'me', api });
  const changes = [];
  w.on('change', v => changes.push(v));
  const inFlight = w.poll();
  w.stop();
  release();
  await inFlight;
  assert.deepEqual(w.view().prs, [], 'signed out mid-poll: nothing comes back');
  const v = await w.poll();
  assert.deepEqual(v.prs.map(p => [p.number, p.state]), [[1, 'none'], [2, 'failing']]);
  assert.equal(v.error, null);
});

test('transitions: a fixed PR stays fixed, and PRs that leave the open list are gone', () => {
  const one = transitions(null, { prs: { 'a/b#1': { state: 'failing' }, 'a/b#2': { state: 'passing' } }, reviews: [] });
  assert.deepEqual(one.gone, []);
  const two = transitions(one.memory, { prs: { 'a/b#1': { state: 'passing' }, 'a/b#2': { state: 'passing' } }, reviews: [] });
  assert.equal(two.memory.prs['a/b#1'].fixed, true);
  const three = transitions(two.memory, { prs: { 'a/b#1': { state: 'pending' } }, reviews: [] });
  assert.equal(three.memory.prs['a/b#1'].fixed, true, 'a later re-run does not forget it was fixed');
  assert.deepEqual(three.gone, [{ key: 'a/b#2', fixed: false, tries: 0 }]);
  const four = transitions(three.memory, { prs: {}, reviews: [] });
  assert.deepEqual(four.gone, [{ key: 'a/b#1', fixed: true, tries: 0 }]);
});

test('a PR that leaves the open list is reported once, and only if it was merged', async () => {
  const sha = 'c'.repeat(40);
  const api = 'https://api.github.com';
  let open = [1, 2];
  const merged = new Set();
  const gh = {
    get: async p => {
      if (p.startsWith('/search/issues') && p.includes('author')) return { items: open.map(n => ({ number: n, title: `PR ${n}`, repository_url: `${api}/repos/me/crab` })) };
      if (p.startsWith('/search/issues')) return { items: [] };
      const pr = /\/pulls\/(\d+)$/.exec(p);
      if (pr) return { head: { sha }, title: `PR ${pr[1]}`, merged_at: merged.has(Number(pr[1])) ? '2026-10-02T00:00:00Z' : null };
      if (p.includes('/check-runs')) return { check_runs: [{ name: 'test', status: 'completed', conclusion: 'success' }] };
      if (p.endsWith('/status')) return { statuses: [] };
      return null;
    },
  };
  const w = new CiWatcher({ gh: () => gh, login: () => 'me', api, web: 'https://github.com' });
  const events = [];
  w.on('event', e => events.push(e));
  await w.poll();
  open = [];
  merged.add(1); // #1 merged, #2 just closed
  await w.poll();
  assert.deepEqual(events.map(e => [e.type, e.key]), [['merged', 'me/crab#1']]);
  assert.deepEqual(events[0].pr, { key: 'me/crab#1', repo: 'me/crab', number: 1, title: 'PR 1', url: 'https://github.com/me/crab/pull/1', fixed: false });
  await w.poll();
  assert.equal(events.length, 1, 'reported once');
});

test('a closed PR GitHub would not tell us about is asked about again, a few times', async () => {
  const sha = 'd'.repeat(40);
  const api = 'https://api.github.com';
  let open = [5];
  let down = false;
  let asked = 0;
  const gh = {
    get: async p => {
      if (p.startsWith('/search/issues') && p.includes('author')) return { items: open.map(n => ({ number: n, title: 'PR', repository_url: `${api}/repos/me/crab` })) };
      if (p.startsWith('/search/issues')) return { items: [] };
      if (p.endsWith('/pulls/5')) {
        if (!open.length) asked++;
        if (down) throw Object.assign(new Error('boom'), { status: 502 });
        return { head: { sha }, title: 'PR', merged_at: open.length ? null : '2026-10-02T00:00:00Z' };
      }
      if (p.includes('/check-runs')) return { check_runs: [] };
      if (p.endsWith('/status')) return { statuses: [] };
      return null;
    },
  };
  const w = new CiWatcher({ gh: () => gh, login: () => 'me', api });
  const events = [];
  w.on('event', e => events.push(e));
  await w.poll();
  open = [];
  down = true;
  await w.poll();
  assert.deepEqual(events, []);
  down = false;
  await w.poll();
  assert.deepEqual(events.map(e => [e.type, e.key]), [['merged', 'me/crab#5']], 'the retry finds the merge');
  down = true;
  open = [5]; await w.poll(); open = [];
  for (let i = 0; i < 5; i++) await w.poll();
  assert.ok(asked <= 2 + 3, `gives up after a few tries (asked ${asked} times)`);
});
