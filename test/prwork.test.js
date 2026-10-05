const { test } = require('node:test');
const assert = require('node:assert/strict');
const { failingBuild, reviewThreads } = require('../src/main/github/prwork');
const { GitHubApi } = require('../src/main/github/api');

const SHA = 'e'.repeat(40);
const PULL = { title: 'Fix it', head: { sha: SHA, ref: 'fix/it', repo: { full_name: 'me/crab' } } };
const err = status => Object.assign(new Error(`GitHub answered ${status}`), { status });

// A pretend GitHub: routes -> answers (a function throws for an error status).
function fakeGh(routes) {
  const calls = [];
  const answer = (path, body) => {
    calls.push(path);
    const hit = Object.entries(routes).find(([p]) => path.startsWith(p));
    if (!hit) return Promise.reject(err(404));
    const v = typeof hit[1] === 'function' ? hit[1](body) : hit[1];
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  };
  return { calls, get: p => answer(p), post: (p, b) => answer(p, b), text: p => answer(p) };
}

const actionsRun = { id: 77, name: 'test', status: 'completed', conclusion: 'failure', app: { slug: 'github-actions' }, html_url: 'https://github.com/me/crab/actions/runs/5/job/77' };

test('failingBuild finds the failed Actions job, its failing step and its log', async () => {
  const gh = fakeGh({
    '/repos/me/crab/pulls/3': PULL,
    [`/repos/me/crab/commits/${SHA}/check-runs`]: { check_runs: [{ name: 'lint', status: 'completed', conclusion: 'success' }, actionsRun] },
    [`/repos/me/crab/commits/${SHA}/status`]: { statuses: [] },
    '/repos/me/crab/actions/jobs/77/logs': 'the log',
    '/repos/me/crab/actions/jobs/77': { steps: [{ name: 'Set up', conclusion: 'success' }, { name: 'Run npm test', conclusion: 'failure' }] },
  });
  const r = await failingBuild(gh, { repo: 'me/crab', number: 3 });
  assert.equal(r.log, 'the log');
  assert.deepEqual(r.job, { id: 77, name: 'test', url: 'https://github.com/me/crab/actions/runs/5/job/77', step: 'Run npm test' });
  assert.equal(r.pull.headRef, 'fix/it');
});

test('failingBuild falls back to the job name and link when the log is out of reach', async () => {
  const gh = fakeGh({
    '/repos/me/crab/pulls/3': PULL,
    [`/repos/me/crab/commits/${SHA}/check-runs`]: { check_runs: [actionsRun] },
    [`/repos/me/crab/commits/${SHA}/status`]: { statuses: [] },
    '/repos/me/crab/actions/jobs/77/logs': err(404),
  });
  const r = await failingBuild(gh, { repo: 'me/crab', number: 3 });
  assert.equal(r.log, null);
  assert.equal(r.job.name, 'test');
  assert.match(r.why, /Let Claude tasks push/);
});

test('failingBuild names another CI\'s failing status, with no log', async () => {
  const gh = fakeGh({
    '/repos/me/crab/pulls/3': PULL,
    [`/repos/me/crab/commits/${SHA}/check-runs`]: { check_runs: [] },
    [`/repos/me/crab/commits/${SHA}/status`]: { statuses: [{ context: 'ci/circleci', state: 'failure', target_url: 'https://circleci.com/x' }] },
  });
  const r = await failingBuild(gh, { repo: 'me/crab', number: 3 });
  assert.equal(r.job.name, 'ci/circleci');
  assert.equal(r.job.url, 'https://circleci.com/x');
  assert.equal(r.log, null);
  assert.match(r.why, /outside GitHub Actions/);
});

test('failingBuild says so when nothing is failing, or the pull request is unreadable', async () => {
  const green = fakeGh({
    '/repos/me/crab/pulls/3': PULL,
    [`/repos/me/crab/commits/${SHA}/check-runs`]: { check_runs: [{ name: 't', status: 'completed', conclusion: 'success' }] },
    [`/repos/me/crab/commits/${SHA}/status`]: { statuses: [] },
  });
  assert.match((await failingBuild(green, { repo: 'me/crab', number: 3 })).error, /Nothing is failing/);
  assert.match((await failingBuild(fakeGh({}), { repo: 'me/crab', number: 3 })).error, /Couldn't read the pull request/);
  assert.match((await failingBuild(fakeGh({}), { repo: '../x', number: 3 })).error, /didn't say which commit/);
});

test('reviewThreads asks GraphQL, which knows what is resolved', async () => {
  let asked = null;
  const gh = fakeGh({
    '/repos/me/crab/pulls/3': PULL,
    '/graphql': body => {
      asked = body.variables;
      return { data: { repository: { pullRequest: { reviewThreads: { nodes: [
        { isResolved: false, isOutdated: false, path: 'a.js', line: 2, originalLine: 2, comments: { nodes: [{ author: { login: 'alice' }, body: 'Hm' }] } },
        { isResolved: true, isOutdated: false, path: 'b.js', line: 1, originalLine: 1, comments: { nodes: [{ author: { login: 'bob' }, body: 'Ok' }] } },
      ] } } } } };
    },
  });
  const r = await reviewThreads(gh, { repo: 'me/crab', number: 3 });
  assert.deepEqual(asked, { owner: 'me', name: 'crab', number: 3 });
  assert.equal(r.resolvedKnown, true);
  assert.deepEqual(r.threads.map(t => [t.path, t.isResolved, t.comments[0].author]), [['a.js', false, 'alice'], ['b.js', true, 'bob']]);
});

test('reviewThreads falls back to REST and says resolution is unknown', async () => {
  const gh = fakeGh({
    '/repos/me/crab/pulls/3/comments': [{ id: 1, path: 'a.js', line: 5, user: { login: 'alice' }, body: 'Why?' }],
    '/repos/me/crab/pulls/3': PULL,
    '/graphql': err(403),
  });
  const r = await reviewThreads(gh, { repo: 'me/crab', number: 3 });
  assert.equal(r.resolvedKnown, false);
  assert.equal(r.threads[0].comments[0].body, 'Why?');
});

test('GitHubApi.text follows the redirect to storage without the token, and keeps the end', async () => {
  const seen = [];
  const headers = h => ({ get: k => h[k] ?? null });
  const fetchImpl = async (url, opts) => {
    seen.push({ url, auth: opts.headers.authorization || null });
    if (url.endsWith('/gone')) return { ok: false, status: 410, headers: headers({}), text: async () => '' };
    if (url.endsWith('/odd')) return { ok: false, status: 302, headers: headers({ location: 'file:///c:/x' }), text: async () => '' };
    if (url.endsWith('/log')) return { ok: false, status: 302, headers: headers({ location: 'https://blob.example/log?sig=1' }), text: async () => '' };
    return { ok: true, status: 200, headers: headers({}), text: async () => 'abcdef' };
  };
  const gh = new GitHubApi({ token: 't0k', api: 'https://api.example', fetchImpl });
  assert.equal(await gh.text('/log', { maxChars: 3 }), 'def');
  assert.deepEqual(seen, [{ url: 'https://api.example/log', auth: 'Bearer t0k' }, { url: 'https://blob.example/log?sig=1', auth: null }]);
  await assert.rejects(gh.text('/gone'), e => e.status === 410);
  await assert.rejects(gh.text('/odd'), /somewhere odd/);
});
