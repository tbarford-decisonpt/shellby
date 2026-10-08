const { test } = require('node:test');
const assert = require('node:assert/strict');
const tt = require('../src/main/timetrack');
const ts = require('../src/main/timesync');

// Saturday 3 October 2026, evening (local time).
const NOW = new Date(2026, 9, 3, 18, 0).getTime();
const DAY = '2026-10-03';
const SITE = 'c:\\work\\acme-site';
const API = 'c:\\work\\acme-api';
const TOOL = 'c:\\work\\side-tool';

// Two hours on the site with a note, 45 minutes on the API, half an hour on a project with no match.
function books() {
  let s = tt.setSettings(null, { enabled: true, roundMinutes: 15 });
  for (const [key, name] of [[SITE, 'acme-site'], [API, 'acme-api'], [TOOL, 'side-tool']]) s = tt.ensureProject(s, key, name);
  s = tt.setProject(s, API, { client: 'Acme', billable: false });
  s = tt.setProject(s, SITE, { client: 'Acme' });
  s = tt.adjust(s, DAY, SITE, 2 * 3600);
  s = tt.setNote(s, DAY, SITE, 'Checkout page');
  s = tt.adjust(s, DAY, API, 45 * 60);
  s = tt.adjust(s, DAY, TOOL, 30 * 60);
  return s;
}

function fakeConfig(data = {}) {
  return { data, get(k) { return this.data[k]; }, set(o) { Object.assign(this.data, o); } };
}

const tracker = state => ({ state, summary: async ({ from, to }) => ({ summary: tt.summarize(state, { from, to }) }) });

// A tracker over HTTP: routes are [method, RegExp, (body, url) -> [status, json]].
function fakeFetch(routes) {
  const calls = [];
  const fetch = async (url, opts) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, method: opts.method, headers: opts.headers, body });
    const r = routes.find(([m, re]) => m === opts.method && re.test(url));
    const [status, json] = r ? r[2](body, url) : [500, {}];
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) };
  };
  return { fetch, calls };
}

function service(routes, state = books()) {
  const http = fakeFetch(routes);
  const vault = { token: '' };
  const config = fakeConfig();
  const sync = new ts.TimeSync({
    config, fetch: http.fetch, now: () => NOW, tracker: tracker(state),
    secret: { get: () => vault.token, set: t => { vault.token = t || ''; return true; } },
  });
  return { sync, http, vault, config };
}

const TOGGL_ROUTES = () => {
  let next = 100;
  return [
    ['GET', /\/me$/, () => [200, { fullname: 'Sam', default_workspace_id: 42 }]],
    ['GET', /\/workspaces\/42\/projects/, () => [200, [{ id: 1, name: 'Acme Site', client_id: 9 }, { id: 2, name: 'Acme API', client_id: 9 }, { id: 3, name: 'Internal', client_id: null }]]],
    ['GET', /\/workspaces\/42\/clients/, () => [200, [{ id: 9, name: 'ACME' }]]],
    ['POST', /\/workspaces\/42\/time_entries$/, () => [200, { id: next++ }]],
    ['PUT', /\/workspaces\/42\/time_entries\/\d+$/, (_b, url) => [200, { id: Number(url.split('/').pop()) }]],
  ];
};

// ------------------------------------------------------------------ pure parts

test('anything read from disk comes back sane, and half a connection is none', () => {
  assert.deepEqual(ts.normalize({ provider: 'toggl' }), { provider: null, account: null, links: {}, sent: {} });
  assert.deepEqual(ts.normalize({ provider: 'nope', account: { id: '1' } }).provider, null);
  const s = ts.normalize({
    provider: 'clockify', account: { id: 'ws1', name: 'Sam' },
    links: { [SITE]: 'p1', constructor: 'p2', [API]: 'bad id!' },
    sent: { nope: {}, [DAY]: { [SITE]: { id: 7, seconds: 'x' }, [API]: { id: '' } } },
  });
  assert.deepEqual(s.links, { [SITE]: 'p1' });
  assert.deepEqual(s.sent, { [DAY]: { [SITE]: { id: '7', seconds: 0 } } });
});

test('a project matches by name, else by its client, and never by a guess that isn’t clear', () => {
  const options = [
    { id: '1', project: '1', name: 'Acme Site', client: 'ACME' },
    { id: '2', project: '2', name: 'Acme API', client: 'ACME' },
    { id: '3', project: '3', name: 'Blog', client: 'Bloggo' },
  ];
  assert.equal(ts.guessLink({ name: 'acme site ' }, options), '1');
  assert.equal(ts.guessLink({ name: 'blog-v2', client: 'bloggo' }, options), '3');
  assert.equal(ts.guessLink({ name: 'x', client: 'Acme' }, options), null, 'two projects for that client');
  assert.equal(ts.guessLink({ name: 'x' }, options), null);
  // A Harvest project's tasks are one project: its first task.
  const harvest = [{ id: '5:1', project: '5', name: 'Site', task: 'Design' }, { id: '5:2', project: '5', name: 'Site', task: 'Development' }];
  assert.equal(ts.guessLink({ name: 'site' }, harvest), '5:1');
  // Your pick wins, unless it's gone from the tracker.
  const state = { links: { [SITE]: '2' } };
  assert.deepEqual(ts.linkFor(state, SITE, { name: 'Acme Site' }, options), { id: '2', guessed: false });
  assert.deepEqual(ts.linkFor({ links: { [SITE]: '99' } }, SITE, { name: 'Acme Site' }, options), { id: '1', guessed: true });
});

test('a day goes over as billed hours, end to end from 9:00, with what it was for', () => {
  const summary = tt.summarize(books(), { from: DAY, to: DAY });
  const state = { links: { [API]: '2' } };
  const options = [{ id: '1', project: '1', name: 'acme-site', client: '' }, { id: '2', project: '2', name: 'Other', client: '' }];
  const { entries, unmatched } = ts.planDay(summary, DAY, state, options);
  assert.deepEqual(unmatched, ['side-tool']);
  assert.deepEqual(entries.map(e => [e.name, e.target, e.seconds, e.billable]), [['acme-site', '1', 7200, true], ['acme-api', '2', 2700, false]]);
  assert.equal(entries[0].start, new Date(2026, 9, 3, 9, 0).getTime());
  assert.equal(entries[1].start, new Date(2026, 9, 3, 11, 0).getTime());
  assert.equal(entries[0].description, 'Checkout page');
  assert.equal(entries[1].description, 'Work on acme-api');
});

// ------------------------------------------------------------------ the service

test('Toggl: connect, match, send a day, then send it again as an update', async () => {
  const { sync, http, vault, config } = service(TOGGL_ROUTES());
  assert.deepEqual(await sync.connect('toggl', ' tok-123456 '), { ok: true });
  assert.equal(vault.token, 'tok-123456');
  assert.equal(http.calls[0].headers.authorization, `Basic ${Buffer.from('tok-123456:api_token').toString('base64')}`);
  assert.deepEqual(sync.view().provider, 'toggl');
  assert.equal(JSON.stringify(config.data).includes('tok-123456'), false, 'the token is never in settings');

  const list = await sync.projects();
  assert.equal(list.options.find(o => o.id === '1').client, 'ACME');
  assert.equal(list.links[SITE], undefined, 'acme-site isn’t "Acme Site"');
  sync.link(SITE, '1');
  sync.link(API, '2');

  const r = await sync.sendDay(DAY);
  assert.equal(r.ok, true);
  assert.equal(r.sent, 2);
  assert.equal(r.hours, 2.75);
  assert.deepEqual(r.unmatched, ['side-tool']);
  const posts = http.calls.filter(c => c.method === 'POST');
  assert.deepEqual(posts.map(c => [c.body.project_id, c.body.duration, c.body.billable, c.body.workspace_id]), [[1, 7200, true, 42], [2, 2700, false, 42]]);
  assert.equal(posts[0].body.created_with, 'Shellby');
  assert.deepEqual(sync.view().sentDays, [DAY]);

  await sync.sendDay(DAY);
  const puts = http.calls.filter(c => c.method === 'PUT');
  assert.deepEqual(puts.map(c => c.url.split('/').pop()), ['100', '101'], 'the same entries, updated');
  assert.equal(http.calls.filter(c => c.method === 'POST').length, 2, 'nothing doubled');
});

test('an entry deleted over there is sent again as a new one', async () => {
  const routes = TOGGL_ROUTES();
  routes.unshift(['PUT', /time_entries\/100$/, () => [404, {}]]);
  const { sync, http } = service(routes);
  await sync.connect('toggl', 'tok-123456');
  sync.link(SITE, '1');
  await sync.sendDay(DAY);
  const r = await sync.sendDay(DAY);
  assert.equal(r.ok, true);
  assert.equal(http.calls.filter(c => c.method === 'POST').length, 2);
  assert.equal(sync.state.sent[DAY][SITE].id, '101');
});

test('a token that doesn’t work is never kept', async () => {
  const { sync, vault, config } = service([['GET', /\/me$/, () => [403, {}]]]);
  const r = await sync.connect('toggl', 'tok-123456');
  assert.equal(r.ok, false);
  assert.match(r.error, /didn't take that token/);
  assert.equal(vault.token, '');
  assert.equal(config.data.timeSync, undefined);
  assert.equal((await sync.connect('toggl', 'a b')).ok, false);
  assert.equal((await sync.connect('nope', 'tok-123456')).ok, false);
});

test('nothing goes for a day still to come, or one with nothing matched', async () => {
  const { sync } = service(TOGGL_ROUTES());
  await sync.connect('toggl', 'tok-123456');
  assert.match((await sync.sendDay('2026-10-04')).error, /hasn't happened/);
  const r = await sync.sendDay(DAY);
  assert.equal(r.ok, false);
  assert.deepEqual(r.unmatched, ['acme-site', 'acme-api', 'side-tool']);
});

test('Clockify: times without milliseconds, its own key header', async () => {
  const { sync, http } = service([
    ['GET', /\/user$/, () => [200, { name: 'Sam', activeWorkspace: 'ws1' }]],
    ['GET', /\/workspaces\/ws1\/projects/, () => [200, [{ id: 'p1', name: 'acme-site', clientName: 'Acme' }]]],
    ['POST', /\/workspaces\/ws1\/time-entries$/, () => [201, { id: 'e1' }]],
  ]);
  await sync.connect('clockify', 'ck-123456');
  const r = await sync.sendDay(DAY);
  assert.equal(r.sent, 2, 'acme-site by its name, acme-api by its client');
  const post = http.calls.find(c => c.method === 'POST');
  assert.equal(post.headers['x-api-key'], 'ck-123456');
  assert.match(post.body.start, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(Date.parse(post.body.end) - Date.parse(post.body.start), 7200 * 1000);
});

test('Harvest: the account from the token, a task with the project, hours by the day', async () => {
  const { sync, http } = service([
    ['GET', /id\.getharvest\.com\/api\/v2\/accounts$/, () => [200, { user: { first_name: 'Sam' }, accounts: [{ id: 11, name: 'Forecast', product: 'forecast' }, { id: 77, name: 'Sam Co', product: 'harvest' }] }]],
    ['GET', /project_assignments\?.*page=1$/, () => [200, { next_page: 2, project_assignments: [{ project: { id: 5, name: 'Website' }, client: { name: 'Acme' }, task_assignments: [{ task: { id: 1, name: 'Design' } }, { task: { id: 2, name: 'Development' } }] }] }]],
    ['GET', /project_assignments\?.*page=2$/, () => [200, { next_page: null, project_assignments: [{ project: { id: 6, name: 'side-tool' }, client: { name: 'Me' }, task_assignments: [{ task: { id: 3, name: 'Dev' }, is_active: false }, { task: { id: 4, name: 'Build' } }] }] }]],
    ['POST', /\/v2\/time_entries$/, () => [201, { id: 900 }]],
  ]);
  await sync.connect('harvest', 'hv-123456');
  assert.match(sync.view().account, /Sam Co/);
  const list = await sync.projects();
  assert.deepEqual(list.options.map(o => o.id), ['5:1', '5:2', '6:4']);
  sync.link(SITE, '5:2');
  const r = await sync.sendDay(DAY);
  assert.equal(r.sent, 3);
  const posts = http.calls.filter(c => c.method === 'POST');
  // acme-api: Acme's only project, at its first task.
  assert.deepEqual(posts.map(c => [c.body.project_id, c.body.task_id, c.body.hours, c.body.spent_date]), [[5, 2, 2, DAY], [5, 1, 0.75, DAY], [6, 4, 0.5, DAY]]);
  assert.equal(posts[0].headers['harvest-account-id'], '77');
  assert.match(posts[0].headers['user-agent'], /^Shellby/);
});

test('disconnecting forgets the token and every match', async () => {
  const { sync, vault } = service(TOGGL_ROUTES());
  await sync.connect('toggl', 'tok-123456');
  sync.link(SITE, '1');
  sync.disconnect();
  assert.equal(vault.token, '');
  assert.deepEqual(sync.state, { provider: null, account: null, links: {}, sent: {} });
  assert.equal((await sync.projects()).ok, false);
});
