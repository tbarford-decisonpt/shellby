// GitLab through glab: remotes, glab's errors, the merge request watcher,
// "Fix this build" / "Address the review" material, and how it all joins
// GitHub's (ci-hub.js, the inbox, a project's page). A pretend glab stands in.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { GlabApi, statusOf, checkHost } = require('../src/main/gitlab/glab');
const remote = require('../src/main/gitlab/remote');
const W = require('../src/main/gitlab/watcher');
const mrwork = require('../src/main/gitlab/mrwork');
const startfrom = require('../src/main/startfrom');
const { CiHub } = require('../src/main/ci-hub');
const inbox = require('../src/main/projects/inbox');
const { insightsFor } = require('../src/main/projects/insights');
const { merge } = require('../src/main/projects/merge');

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const err = (status, extra = {}) => Object.assign(new Error(`glab: ${status}`), { status, ...extra });

// A pretend GitLab on one host: path prefix -> answer (a function, or an Error to throw).
function fakeGl(routes, host = 'gitlab.com') {
  const calls = [];
  const answer = path => {
    calls.push(path);
    const hit = Object.entries(routes).find(([p]) => path === p || path.startsWith(`${p}?`) || path.startsWith(p));
    if (!hit) return Promise.reject(err(404));
    const v = typeof hit[1] === 'function' ? hit[1](path) : hit[1];
    return v instanceof Error ? Promise.reject(v) : Promise.resolve(v);
  };
  return { host, calls, get: answer, text: answer };
}

const mrRaw = (iid, extra = {}) => ({
  iid, project_id: 7, source_project_id: 7, title: `MR ${iid}`, sha: SHA, source_branch: `feat/${iid}`,
  references: { full: `team/app!${iid}` }, author: { username: 'me' }, updated_at: '2026-10-01T10:00:00Z', ...extra,
});

// ------------------------------------------------------------------ remotes and glab

test('forgeRepoOf reads the remote shapes git writes, nested groups included, and never GitHub or a token', () => {
  assert.deepEqual(remote.forgeRepoOf('https://gitlab.com/team/app.git'), { host: 'gitlab.com', path: 'team/app' });
  assert.deepEqual(remote.forgeRepoOf('git@gitlab.com:team/sub/app.git'), { host: 'gitlab.com', path: 'team/sub/app' });
  assert.deepEqual(remote.forgeRepoOf('ssh://git@gitlab.example.org:2222/a/b'), { host: 'gitlab.example.org', path: 'a/b' });
  assert.equal(remote.forgeRepoOf('https://github.com/me/site.git'), null);
  assert.equal(remote.forgeRepoOf('https://oauth2:glpat-secret@gitlab.com/team/app.git'), null, 'a token in the URL never parses');
  assert.equal(remote.forgeRepoOf('C:\\code\\app'), null);
  assert.equal(remote.forgeRepoOf('https://gitlab.com/onlyone'), null, 'a project path has a group');
  assert.equal(remote.forgeRepoOf('https://gitlab.com/team/../app'), null);
});

test('isGitLabHost: gitlab.com, hosts you listed, and hosts whose name says gitlab', () => {
  assert.equal(remote.isGitLabHost('gitlab.com'), true);
  assert.equal(remote.isGitLabHost('gitlab.example.org'), true);
  assert.equal(remote.isGitLabHost('code.example.org'), false);
  assert.equal(remote.isGitLabHost('code.example.org', ['code.example.org']), true);
  assert.equal(remote.gitlabRepoOf('git@bitbucket.org:me/app.git'), null);
});

test('merge request keys use "!", carry the host off gitlab.com, and never look like GitHub\'s', () => {
  assert.equal(remote.mrKey('gitlab.com', 'team/app', 3), 'team/app!3');
  assert.equal(remote.mrKey('gitlab.example.org', 'team/app', 3), 'gitlab.example.org/team/app!3');
  assert.equal(remote.isMrKey('team/app!3'), true);
  assert.equal(remote.isMrKey('me/site#3'), false);
  assert.equal(remote.mrUrl('gitlab.com', 'team/app', 3), 'https://gitlab.com/team/app/-/merge_requests/3');
});

test('statusOf reads HTTP statuses from glab, not port numbers', () => {
  assert.equal(statusOf('glab: 404 Not Found (HTTP 404)'), 404);
  assert.equal(statusOf('401 Unauthorized'), 401);
  assert.equal(statusOf('dial tcp 10.0.0.1:443: i/o timeout'), null);
  assert.equal(checkHost('GitLab.Example.org:8443'), 'gitlab.example.org:8443');
  assert.equal(checkHost('-bad'), null);
});

test('GlabApi runs `glab api` for one host, parses JSON, and says why it failed', async () => {
  const seen = [];
  const run = async args => {
    seen.push(args);
    if (args[1] === 'user') return { ok: true, out: '{"username":"me"}' };
    if (args[1] === 'gone') return { ok: false, error: 'glab: 404 Not Found (HTTP 404)' };
    if (args[1] === 'auth') return { ok: false, error: 'glab: 401 Unauthorized (HTTP 401)' };
    return { ok: false, error: 'spawn glab ENOENT', missing: true };
  };
  const gl = new GlabApi({ host: 'gitlab.example.org', run });
  assert.deepEqual(await gl.get('user'), { username: 'me' });
  assert.deepEqual(seen[0], ['api', 'user', '--hostname', 'gitlab.example.org']);
  await assert.rejects(gl.get('gone'), e => e.status === 404 && !e.signedOut);
  await assert.rejects(gl.get('auth'), e => e.status === 401 && e.signedOut);
  await assert.rejects(gl.get('x'), e => e.missing);
  await assert.rejects(gl.get('projects/:id'), e => e.status === 400, 'a placeholder glab would fill from a repository is refused');
  await assert.rejects(gl.get('--hostname=evil'), e => e.status === 400, 'never a flag');
  assert.throws(() => new GlabApi({ host: 'not a host' }));
});

// ------------------------------------------------------------------ the watcher's pure parts

test('pipelineState and failedJobs: GitLab statuses as GitHub verdicts, allowed failures left out', () => {
  assert.equal(W.pipelineState('success'), 'passing');
  assert.equal(W.pipelineState('failed'), 'failing');
  assert.equal(W.pipelineState('running'), 'pending');
  assert.equal(W.pipelineState('manual'), 'none');
  assert.equal(W.pipelineState(undefined), 'none');
  assert.deepEqual(W.failedJobs([{ name: 'test', status: 'failed' }, { name: 'lint', status: 'failed', allow_failure: true }, { name: 'build', status: 'success' }]), ['test']);
});

test('parseMr takes the project path from the reference, and refuses one that disagrees', () => {
  const mr = W.parseMr(mrRaw(4), 'gitlab.com');
  assert.equal(mr.key, 'team/app!4');
  assert.equal(mr.ref, 'team/app!4');
  assert.equal(mr.url, 'https://gitlab.com/team/app/-/merge_requests/4');
  assert.equal(mr.branch, 'feat/4');
  assert.equal(mr.forge, 'gitlab');
  assert.equal(W.parseMr(mrRaw(4, { references: { full: 'team/app!5' } }), 'gitlab.com'), null);
  assert.equal(W.parseMr({ iid: 1 }, 'gitlab.com'), null);
});

test('talkOf counts people, not system notes or bots on the conversation; open threads and verdicts', () => {
  const discussions = [
    { notes: [{ system: true, author: { username: 'ann' }, created_at: '2026-10-01T09:00:00Z' }] },
    { notes: [{ author: { username: 'ann' }, created_at: '2026-10-01T10:00:00Z', resolvable: true, resolved: false, type: 'DiffNote', position: { new_path: 'a.js', new_line: 3 } }] },
    { notes: [{ author: { username: 'project_7_bot_abc' }, created_at: '2026-10-01T11:00:00Z' }] },
    { notes: [{ author: { username: 'bob.smith' }, created_at: '2026-10-01T12:00:00Z', resolvable: true, resolved: true }] },
  ];
  const list = W.talkOf(discussions);
  assert.deepEqual(list.map(e => [e.by, e.kind]), [['ann', 'line'], ['bob.smith', 'comment']]);
  assert.equal(W.openDiscussions(discussions).length, 1);
  assert.equal(W.verdictOf([{ user: { username: 'ann' }, state: 'requested_changes' }, { user: { username: 'bob' }, state: 'approved' }], 'me'), 'changes');
  assert.equal(W.verdictOf([{ user: { username: 'me' }, state: 'requested_changes' }], 'me'), null, 'your own state is not a verdict');
});

// ------------------------------------------------------------------ the watcher

function watcherWith(routes, { hosts = ['gitlab.com'], apis = null } = {}) {
  let now = Date.parse('2026-10-02T00:00:00Z');
  const saved = [];
  const w = new W.GitLabWatcher({
    api: host => apis?.[host] || fakeGl(routes, host),
    hosts: async () => hosts,
    now: () => now,
    seen: { load: () => null, save: v => saved.push(v) },
  });
  const events = [];
  w.on('event', e => events.push(e));
  return { w, events, saved, tick: ms => { now += ms; } };
}

test('GitLabWatcher: a red pipeline, a fixed one, a review request and a merge, as GitHub\'s watcher says them', async () => {
  let status = 'failed';
  let open = [mrRaw(4)];
  let asked = [];
  const routes = {
    user: { id: 9, username: 'me' },
    'merge_requests?scope=created_by_me': () => open,
    'merge_requests?scope=all': () => asked,
    'projects/7/merge_requests/4/discussions': [],
    'projects/7/merge_requests/4/reviewers': [],
    'projects/7/merge_requests/4': () => ({ ...mrRaw(4), state: open.length ? 'opened' : 'merged', head_pipeline: { id: 50, status, project_id: 7 } }),
    'projects/7/pipelines/50/jobs': [{ name: 'test', status: 'failed' }],
  };
  const { w, events } = watcherWith(routes);
  let v = await w.poll();
  assert.equal(v.prs.length, 1);
  assert.equal(v.prs[0].state, 'failing');
  assert.deepEqual(v.prs[0].failing, ['test']);
  assert.equal(v.failing, 1);
  assert.deepEqual(events, [], 'the first poll only learns the lay of the land');

  status = 'success';
  asked = [mrRaw(8, { author: { username: 'ann' }, references: { full: 'team/app!8' } })];
  v = await w.poll();
  assert.equal(v.reviews[0].author, 'ann');
  assert.deepEqual(events.map(e => [e.type, e.key]), [['fixed', 'team/app!4'], ['review', 'team/app!8']]);
  assert.equal(events[0].pr.ref, 'team/app!4');

  open = [];
  await w.poll();
  assert.deepEqual(events.slice(2).map(e => [e.type, e.key]), [['merged', 'team/app!4']]);
  assert.equal(events[2].pr.forge, 'gitlab');
});

test('GitLabWatcher: new words on yours are unread until you open it; gitlab.com you aren\'t signed in to is no error', async () => {
  let notes = [];
  let updated = '2026-10-01T10:00:00Z';
  const routes = {
    user: { id: 9, username: 'me' },
    'merge_requests?scope=created_by_me': () => [mrRaw(4, { updated_at: updated })],
    'merge_requests?scope=all': [],
    'projects/7/merge_requests/4/discussions': () => notes,
    'projects/7/merge_requests/4/reviewers': [{ user: { username: 'ann' }, state: 'requested_changes' }],
    'projects/7/merge_requests/4': () => ({ ...mrRaw(4, { updated_at: updated }), head_pipeline: { id: 50, status: 'success' } }),
  };
  const signedOut = { host: 'gitlab.com', get: () => Promise.reject(err(401, { signedOut: true })) };
  const { w, events } = watcherWith(routes, { hosts: ['gitlab.com', 'gitlab.example.org'], apis: { 'gitlab.com': signedOut } });
  let v = await w.poll();
  assert.equal(v.error, null, 'one host answering is enough');
  assert.equal(v.prs[0].key, 'gitlab.example.org/team/app!4');
  notes = [{ notes: [{ author: { username: 'ann' }, created_at: '2026-10-01T12:00:00Z', resolvable: true, resolved: false, body: 'Rename this' }] }];
  updated = '2026-10-01T12:00:00Z';
  v = await w.poll();
  assert.equal(v.prs[0].talk.unread, 1);
  assert.equal(v.prs[0].talk.verdict, 'changes');
  assert.equal(v.prs[0].reviewComments, 1, 'one open thread to answer');
  assert.deepEqual(events.map(e => e.type), ['comment']);
  assert.equal(w.markSeen('gitlab.example.org/team/app!4'), true);
  assert.equal(w.view().prs[0].talk.unread, 0);
});

test('GitLabWatcher says what\'s wrong when no host answers: glab missing, or not signed in', async () => {
  const missing = { get: () => Promise.reject(Object.assign(new Error('glab isn\'t installed'), { missing: true })) };
  const a = watcherWith({}, { apis: { 'gitlab.com': missing } });
  assert.match((await a.w.poll()).error, /glab isn't installed/);
  const out = { get: () => Promise.reject(err(401, { signedOut: true })) };
  const b = watcherWith({}, { hosts: ['gitlab.example.org'], apis: { 'gitlab.example.org': out } });
  assert.match((await b.w.poll()).error, /glab auth login --hostname gitlab\.example\.org/);
});

// ------------------------------------------------------------------ Fix this build / Address the review

const MR = { host: 'gitlab.com', projectId: 7, number: 4, repo: 'team/app' };

test('failingBuild: the first failed job, its stage, and its trace', async () => {
  const gl = fakeGl({
    'projects/7/merge_requests/4': { ...mrRaw(4), head_pipeline: { id: 50, status: 'failed', project_id: 7 } },
    'projects/7/pipelines/50/jobs': [
      { id: 12, name: 'e2e', stage: 'test', status: 'failed', web_url: 'https://gitlab.com/team/app/-/jobs/12' },
      { id: 11, name: 'unit', stage: 'test', status: 'failed', web_url: 'https://gitlab.com/team/app/-/jobs/11' },
      { id: 10, name: 'lint', stage: 'test', status: 'failed', allow_failure: true },
    ],
    'projects/7/jobs/11/trace': 'the trace',
  });
  const r = await mrwork.failingBuild(gl, MR);
  assert.deepEqual(r.job, { id: 11, name: 'unit', url: 'https://gitlab.com/team/app/-/jobs/11', step: 'test' });
  assert.equal(r.log, 'the trace');
  assert.equal(r.pull.headRef, 'feat/4');
  assert.equal(r.pull.headRepo, 'team/app');
});

test('failingBuild follows a failed trigger job into its child pipeline, and says when nothing fails', async () => {
  const gl = fakeGl({
    'projects/7/merge_requests/4': { ...mrRaw(4), head_pipeline: { id: 50, status: 'failed', project_id: 7 } },
    'projects/7/pipelines/50/jobs': [],
    'projects/7/pipelines/50/bridges': [{ status: 'failed', downstream_pipeline: { id: 60, project_id: 7 } }],
    'projects/7/pipelines/60/jobs': [{ id: 30, name: 'child test', stage: 'test', status: 'failed' }],
    'projects/7/jobs/30/trace': err(403),
  });
  const r = await mrwork.failingBuild(gl, MR);
  assert.equal(r.job.name, 'child test');
  assert.equal(r.log, null);
  assert.match(r.why, /wouldn't share it/);
  const green = fakeGl({ 'projects/7/merge_requests/4': { ...mrRaw(4), head_pipeline: { id: 50, status: 'success' } } });
  assert.match((await mrwork.failingBuild(green, MR)).error, /Nothing is failing/);
});

test('reviewThreads: resolvable threads with where they are, plain comments left out', async () => {
  const gl = fakeGl({
    'projects/7/merge_requests/4/discussions': [
      { notes: [{ body: 'Rename x', author: { username: 'ann' }, resolvable: true, resolved: false, position: { new_path: 'src/a.js', new_line: 3, head_sha: SHA } }, { body: 'Will do', author: { username: 'me' }, resolvable: true, resolved: false }] },
      { notes: [{ body: 'Done one', author: { username: 'ann' }, resolvable: true, resolved: true, position: { new_path: 'b.js', new_line: 1, head_sha: SHA2 } }] },
      { notes: [{ body: 'Nice!', author: { username: 'bob' }, resolvable: false }] },
    ],
    'projects/7/merge_requests/4': mrRaw(4),
  });
  const r = await mrwork.reviewThreads(gl, MR);
  assert.equal(r.resolvedKnown, true);
  assert.equal(r.threads.length, 2);
  const open = startfrom.openThreads(r.threads);
  assert.deepEqual(open.map(t => [t.path, t.line, t.comments.length]), [['src/a.js', 3, 2]]);
});

test('mrChanges puts GitLab\'s lists in GitHub\'s shapes: oldest commit first, yours by email', async () => {
  const gl = fakeGl({
    'projects/7/merge_requests/4/diffs': [{ new_path: '.claude/settings.json', old_path: '.claude/settings.json' }, { new_path: 'b.js', old_path: 'a.js', renamed_file: true }],
    'projects/7/merge_requests/4/commits': [{ id: SHA, author_name: 'Eve', author_email: 'eve@x.org' }, { id: SHA2, author_name: 'Me', author_email: 'ME@x.org' }],
  });
  const c = await mrwork.mrChanges(gl, MR, { me: 'me.dev', emails: ['me@x.org'] });
  assert.deepEqual(c.commits.map(x => x.sha), [SHA2, SHA]);
  const risk = startfrom.prRisks({ ...c, login: 'me.dev', headSha: SHA, forge: 'gitlab' });
  assert.deepEqual(risk.files, ['.claude/settings.json']);
  assert.deepEqual(risk.authors, ['Eve (not one of your emails)']);
  assert.deepEqual(risk.unknown, []);
});

test('commitCi: the newest pipeline on a commit, for the Releases card', async () => {
  const gl = fakeGl({
    'projects/team%2Fapp/pipelines?sha=': [{ id: 5, status: 'failed' }],
    'projects/team%2Fapp/pipelines/5/jobs': [{ name: 'test', status: 'failed' }],
  });
  assert.deepEqual(await mrwork.commitCi(gl, 'team/app', SHA), { state: 'failing', failing: ['test'] });
  assert.deepEqual(await mrwork.commitCi(fakeGl({ 'projects/team%2Fapp/pipelines?sha=': [] }), 'team/app', SHA), { state: 'none', failing: [] });
  assert.equal(await mrwork.commitCi(fakeGl({}), 'team/app', SHA), null);
});

// ------------------------------------------------------------------ prompts and logs

test('trimLog reads a GitLab trace: the command that failed and its error, without section markers', () => {
  const log = [
    'section_start:1700000000:prepare_script\r\x1b[0KPreparing environment',
    'Running on runner-abc',
    'section_end:1700000001:prepare_script\r\x1b[0K',
    'section_start:1700000002:step_script\r\x1b[0KExecuting "step_script" stage of the job script',
    '\x1b[32;1m$ npm ci\x1b[0;m',
    'added 200 packages',
    '\x1b[32;1m$ npm test\x1b[0;m',
    '> test',
    'not ok 1 - adds',
    'Error: expected 2 to equal 3',
    '    at test.js:4',
    'section_end:1700000010:step_script\r\x1b[0K',
    'section_start:1700000011:cleanup_file_variables\r\x1b[0KCleaning up project directory and file based variables',
    'section_end:1700000012:cleanup_file_variables\r\x1b[0K',
    '\x1b[31;1mERROR: Job failed: exit code 1\x1b[0;m',
  ].join('\n');
  const t = startfrom.trimLog(log, { format: 'gitlab' });
  assert.equal(t.lines[0], '$ npm test');
  assert.ok(t.lines.includes('Error: expected 2 to equal 3'));
  assert.equal(t.lines[t.lines.length - 1], 'ERROR: Job failed: exit code 1');
  assert.ok(!t.lines.some(l => /section_|npm ci/.test(l)));
  assert.equal(t.truncated, true);
});

test('the prompts call a merge request one, write its reference GitLab\'s way, and point at glab', () => {
  const pr = { repo: 'team/app', number: 4, title: 'Add it', url: 'https://gitlab.com/team/app/-/merge_requests/4', forge: 'gitlab' };
  const copy = { headRef: 'feat/4', headRepo: 'team/app' };
  const build = startfrom.buildPrompt({ pr, job: { id: 11, name: 'unit', url: '', step: 'test' }, log: null, why: 'it was gone', copy });
  assert.match(build, /my merge request .* \(team\/app!4,/);
  assert.match(build, /in the stage "test"/);
  assert.match(build, /glab ci trace 11/);
  assert.match(build, /so the merge request picks it up/);
  assert.doesNotMatch(build, /pull request|gh run view/);
  const review = startfrom.reviewPrompt({ pr, threads: [{ path: 'a.js', line: 3, outdated: false, comments: [{ author: 'bob.smith', body: 'Rename' }] }], copy });
  assert.match(review, /My merge request .* has 1 unresolved review comment/);
  assert.match(review, /from @bob\.smith/);
});

// ------------------------------------------------------------------ joined with GitHub

class FakeWatcher extends EventEmitter {
  constructor(v) { super(); this.v = v; this.running = true; this.seen = []; }
  view() { return this.v; }
  markSeen(k) { this.seen.push(k); return true; }
  poll() { return Promise.resolve(this.v); }
  stop() { this.running = false; }
}

test('CiHub: one view of both, keys routed to their own watcher, every item named', async () => {
  const gh = new FakeWatcher({ prs: [{ key: 'me/site#2', repo: 'me/site', number: 2, state: 'failing' }], reviews: [], reviewsTotal: 3, lastPollAt: 1, error: null });
  const gl = new FakeWatcher({ prs: [{ key: 'team/app!4', ref: 'team/app!4', repo: 'team/app', number: 4, state: 'passing', forge: 'gitlab', talk: { unread: 1 } }], reviews: [], reviewsTotal: 0, lastPollAt: 5, error: 'x', hosts: [] });
  const hub = new CiHub({ github: gh, gitlab: gl });
  const v = hub.view();
  assert.deepEqual(v.prs.map(p => [p.ref, p.forge]), [['me/site#2', 'github'], ['team/app!4', 'gitlab']]);
  assert.equal(v.failing, 1);
  assert.equal(v.unread, 1);
  assert.equal(v.error, null, 'GitHub\'s error slot is GitHub\'s');
  assert.equal(v.gitlab.error, 'x');
  hub.markSeen('team/app!4');
  hub.markSeen('me/site#2');
  assert.deepEqual([gh.seen, gl.seen], [['me/site#2'], ['team/app!4']]);
  const got = [];
  hub.on('event', e => got.push(e));
  gh.emit('event', { type: 'failed', key: 'me/site#2', pr: { repo: 'me/site', number: 2 } });
  assert.equal(got[0].pr.ref, 'me/site#2');
});

test('the inbox lists merge requests with their reference and open threads, with GitHub off', () => {
  const ci = {
    enabled: true, githubEnabled: false, gitlab: { enabled: true, error: null, lastPollAt: 1 },
    reviews: [{ key: 'team/app!8', ref: 'team/app!8', forge: 'gitlab', repo: 'team/app', number: 8, title: 'Look' }],
    prs: [{ key: 'team/app!4', ref: 'team/app!4', forge: 'gitlab', repo: 'team/app', number: 4, title: 'Mine', reviewComments: 2, talk: { unread: 1, people: ['ann'], lastAt: 5, verdict: null } }],
  };
  const v = inbox.build({ ci });
  assert.equal(v.github.enabled, false);
  assert.equal(v.gitlab.enabled, true);
  assert.equal(v.reviews[0].ref, 'team/app!8');
  assert.equal(v.talk[0].threads, 2);
  assert.equal(v.total, 2);
});

test('a project cloned from GitLab gets its merge requests on its page, and never a GitHub repo\'s', () => {
  const [p] = merge([{ root: 'C:\\code\\app', name: 'app', remote: null, forge: { host: 'gitlab.com', path: 'team/app' }, branch: 'main' }]);
  assert.deepEqual(p.forge, { host: 'gitlab.com', path: 'team/app' });
  const prs = [
    { key: 'team/app!4', repo: 'team/app', host: 'gitlab.com', forge: 'gitlab', number: 4, state: 'failing' },
    { key: 'team/app#4', repo: 'team/app', forge: 'github', number: 4, state: 'passing' },
    { key: 'gitlab.example.org/team/app!4', repo: 'team/app', host: 'gitlab.example.org', forge: 'gitlab', number: 4, state: 'passing' },
  ];
  const i = insightsFor(p, { prs });
  assert.deepEqual(i.prs.map(x => x.key), ['team/app!4']);
});
