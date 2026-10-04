const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const { matchEvent, byWebhook, patternTest, nextStart, RateLimit, ScheduleTicker, FolderWatch } = require('../src/main/workflows/triggers');
const { validateWorkflow, STEP_TYPES, TRIGGER_TYPES } = require('../src/main/workflows/schema');
const { templates } = require('../src/main/workflows/templates');
const draft = require('../src/main/workflows/draft');
const effects = require('../src/main/workflows/effects');

const wf = (when, over = {}) => validateWorkflow({ name: over.name || 'W', when, steps: [{ type: 'tell', text: 'x' }], ...over }).workflow;

test('events match triggers by kind, repo and outcome', () => {
  const a = wf([{ type: 'ci', on: 'failed', repo: 'X-Salmon/Shellby' }], { name: 'A' });
  const b = wf([{ type: 'ci', on: 'any' }], { name: 'B' });
  const c = wf([{ type: 'shipped', kind: 'release', project: 'shellby' }], { name: 'C' });
  const off = { ...wf([{ type: 'ci', on: 'any' }], { name: 'Off' }), enabled: false };
  const names = (type, data) => matchEvent([a, b, c, off], type, data).map(m => m.workflow.name);
  assert.deepEqual(names('ci', { event: 'failed', repo: 'x-salmon/shellby' }), ['A', 'B']);
  assert.deepEqual(names('ci', { event: 'failed', repo: 'other/repo' }), ['B']);
  assert.deepEqual(names('shipped', { kind: 'release', project: 'Shellby' }), ['C']);
  assert.deepEqual(names('shipped', { kind: 'push', project: 'shellby' }), []);
});

test('workflow chains stop after three hops and never self-trigger', () => {
  const next = wf([{ type: 'workflow', name: 'First', status: 'ok' }], { name: 'Next' });
  assert.equal(matchEvent([next], 'workflow', { name: 'first', status: 'ok', chain: 1 }).length, 1);
  assert.equal(matchEvent([next], 'workflow', { name: 'first', status: 'error', chain: 1 }).length, 0);
  assert.equal(matchEvent([next], 'workflow', { name: 'first', status: 'ok', chain: 3 }).length, 0);
});

test('web hook tokens are matched exactly', () => {
  const h = wf([{ type: 'webhook' }]);
  assert.equal(byWebhook([h], h.when[0].token).workflow, h);
  assert.equal(byWebhook([h], h.when[0].token.toUpperCase()), null);
  assert.equal(byWebhook([h], `${h.when[0].token}0`), null);
  assert.equal(byWebhook([h], undefined), null);
});

test('file patterns', () => {
  const t = patternTest('*.pdf, report-??.csv');
  assert.equal(t('Invoice.PDF'), true);
  assert.equal(t('report-01.csv'), true);
  assert.equal(t('report-001.csv'), false);
  assert.equal(t('x.pdf.exe'), false);
  assert.equal(patternTest('')('anything'), true);
  assert.equal(patternTest('a.b')('aXb'), false); // the dot is literal
});

test('the schedule ticker fires each slot once, and only the latest after a long sleep', () => {
  let now = new Date(2026, 9, 5, 8, 59).getTime();
  const fired = [];
  const w = wf([{ type: 'schedule', schedule: { type: 'minutes', every: 15 } }], { createdAt: new Date(2026, 9, 5, 8, 0).getTime() });
  const t = new ScheduleTicker({ getWorkflows: () => [w], onDue: (_w, _t, slot) => fired.push(new Date(slot).toTimeString().slice(0, 5)), now: () => now, timers: { setInterval: () => ({}), clearInterval: () => {} } });
  t.start();
  now += 2 * 60000; t.tick();          // 09:01: the 09:00 slot
  now += 60000; t.tick();              // 09:02: nothing new
  now += 3 * 60 * 60000; t.tick();     // after a 3-hour sleep: just the latest
  assert.deepEqual(fired, ['09:00', '12:00']);
  assert.equal(nextStart(w, new Date(2026, 9, 5, 12, 1).getTime()), new Date(2026, 9, 5, 12, 15).getTime());
});

test('rate limit counts starts per workflow per hour', () => {
  const r = new RateLimit({ limit: 2, windowMs: 1000 });
  assert.equal(r.allow('a', 0), true);
  assert.equal(r.allow('a', 1), true);
  assert.equal(r.allow('a', 2), false);
  assert.equal(r.allow('b', 2), true);
  assert.equal(r.allow('a', 5000), true);
});

test('folder watch: a burst of matching new files becomes one start', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-watch-'));
  const w = wf([{ type: 'folder', path: dir, pattern: '*.txt', events: 'added' }]);
  let emit;
  const watcher = Object.assign(new EventEmitter(), { close() {} });
  const got = [];
  const fw = new FolderWatch({ quietMs: 20, watch: (_p, _o, cb) => { emit = cb; return watcher; }, onFiles: (_w, _t, files) => got.push(files.map(f => path.basename(f))) });
  fw.sync([w]);
  for (const n of ['a.txt', 'b.txt', 'skip.pdf', 'c.txt.crdownload']) fs.writeFileSync(path.join(dir, n), 'x');
  emit('rename', 'a.txt'); emit('rename', 'b.txt'); emit('rename', 'skip.pdf'); emit('rename', 'c.txt.crdownload'); emit('change', 'a.txt'); emit('rename', 'gone.txt');
  await new Promise(r => setTimeout(r, 60));
  assert.deepEqual(got, [['a.txt', 'b.txt']]);
  fw.sync([]);
  assert.equal(fw.watchers.size, 0);
});

test('every template is a valid workflow', () => {
  for (const t of templates({ home: 'C:\\Users\\me' })) {
    const r = validateWorkflow(t.workflow);
    assert.equal(r.ok, true, `${t.key}: ${JSON.stringify(r.errors)}`);
  }
  assert.equal(templates({}).length, 7);
});

test('the draft format names every step and trigger type', () => {
  for (const t of STEP_TYPES) assert.match(draft.FORMAT, new RegExp(`"type": "${t}"`), t);
  for (const t of TRIGGER_TYPES) assert.match(draft.FORMAT, new RegExp(`"type": "${t}"`), t);
});

test('draft replies are parsed, and Autonomous never survives', () => {
  const ok = draft.parse(JSON.stringify({ structured_output: { workflow_json: JSON.stringify({ name: 'X', steps: [{ type: 'claude', prompt: 'p', mode: 'autonomous', __proto__: { evil: 1 } }] }), note: 'hi' } }));
  assert.equal(ok.ok, true);
  assert.equal(ok.workflow.steps[0].mode, 'acceptEdits');
  assert.equal(draft.parse('nonsense').ok, false);
  assert.match(draft.parse(JSON.stringify({ is_error: true, result: 'Please log in' })).error, /Sign in/);
  assert.equal(draft.parse(JSON.stringify({ structured_output: { workflow_json: 'not json' } })).ok, false);
  assert.equal(draft.checkDescription('  ').ok, false);
  assert.match(draft.args().join(' '), /--tools {2}--strict-mcp-config/);
  assert.ok(!draft.args().some(a => a.length > 2000), 'long text goes on stdin');
});

test('file effects refuse network paths and relative paths', async () => {
  assert.throws(() => effects.safePath('\\\\server\\share\\x.txt'), /Network/);
  assert.throws(() => effects.safePath('//server/share'), /Network/);
  assert.throws(() => effects.safePath('relative.txt'), /full path/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-fx-'));
  const f = path.join(dir, 'a.txt');
  await effects.writeFile(f, 'one\n', { append: true });
  await effects.writeFile(f, 'two\n', { append: true });
  assert.equal(await effects.readFile(f), 'one\ntwo\n');
  await assert.rejects(effects.writeFile(path.join(dir, 'missing', 'x.txt'), 'x'), /doesn't exist/);
  await assert.rejects(effects.readFile(path.join(dir, 'nope.txt')), /no file/);
});

test('http effect: redirects to another site drop the headers, and never downgrade', async () => {
  const seen = [];
  const routes = {
    'https://a.com/start': { status: 302, location: 'https://a.com/same' },
    'https://a.com/same': { status: 301, location: 'https://b.com/other' },
    'https://b.com/other': { status: 200, body: 'done' },
    'https://a.com/down': { status: 302, location: 'http://a.com/plain' },
    'https://a.com/post': { status: 303, location: '/got' },
    'https://a.com/got': { status: 200, body: 'ok' },
  };
  const fetchImpl = async (url, opts) => {
    seen.push({ url, auth: opts.headers.Authorization || null, method: opts.method, body: opts.body });
    const r = routes[url];
    return { status: r.status, headers: { get: k => (k === 'location' ? r.location : null) }, text: async () => r.body || '' };
  };
  const r = await effects.http({ method: 'GET', url: 'https://a.com/start', headers: { Authorization: 'Bearer s' }, fetchImpl });
  assert.equal(r.body, 'done');
  assert.deepEqual(seen.map(s => s.auth), ['Bearer s', 'Bearer s', null]);
  await assert.rejects(effects.http({ method: 'GET', url: 'https://a.com/down', fetchImpl }), /plain http/);
  seen.length = 0;
  await effects.http({ method: 'POST', url: 'https://a.com/post', body: '{}', fetchImpl });
  assert.deepEqual(seen.map(s => [s.method, s.body]), [['POST', '{}'], ['GET', undefined]]);
  await assert.rejects(effects.http({ method: 'GET', url: 'file:///c:/x', fetchImpl }), /http/);
});

test('abortable sleep', async () => {
  const c = new AbortController();
  const p = effects.sleep(10000, c.signal);
  c.abort();
  await assert.rejects(p, e => e.name === 'AbortError');
});

test('issue triggers match on why the issue came in, and the repository', () => {
  const any = wf([{ type: 'issue' }], { name: 'Any' });
  const mine = wf([{ type: 'issue', on: 'assigned', repo: 'Me/Crab' }], { name: 'Mine' });
  const tagged = wf([{ type: 'issue', on: 'labelled' }], { name: 'Tagged' });
  const names = data => matchEvent([any, mine, tagged], 'issue', data).map(m => m.workflow.name);
  assert.deepEqual(names({ reasons: ['assigned'], repo: 'me/crab' }), ['Any', 'Mine']);
  assert.deepEqual(names({ reasons: ['assigned', 'labelled'], repo: 'me/crab' }), ['Any', 'Mine', 'Tagged']);
  assert.deepEqual(names({ reasons: ['labelled'], repo: 'pal/tool' }), ['Any', 'Tagged']);
  assert.deepEqual(names({ repo: 'me/crab' }), ['Any'], 'no reasons, no assigned/labelled match');
  assert.equal(any.when[0].on, 'any');
  assert.equal(validateWorkflow({ name: 'X', when: [{ type: 'issue', on: 'closed' }], steps: [{ type: 'tell', text: 'x' }] }).ok, false);
  assert.equal(validateWorkflow({ name: 'X', when: [{ type: 'issue', repo: 'not a repo' }], steps: [{ type: 'tell', text: 'x' }] }).ok, false);
});
