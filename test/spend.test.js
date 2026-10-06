const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const spend = require('../src/main/spend');
const { spendFrom } = require('../src/main/stream');
const { ClaudeSession } = require('../src/main/session');

const NOW = 1_790_000_000_000;
const MIN = 60 * 1000;
const H = 60 * MIN;
const tab = (key, label, project = 'shellby', kind = 'tab') => ({ key, kind, label, project });

test('a call weighs more on a bigger model, and output more than input', () => {
  const u = { input_tokens: 100, output_tokens: 100 };
  assert.ok(spend.weightOf(u, 'claude-opus-5-5') > spend.weightOf(u, 'claude-sonnet-5-5'));
  assert.ok(spend.weightOf(u, 'claude-sonnet-5-5') > spend.weightOf(u, 'claude-haiku-4-5'));
  assert.ok(spend.weightOf({ output_tokens: 10 }, 'x') > spend.weightOf({ input_tokens: 10 }, 'x'));
  assert.ok(spend.weightOf({ cache_read_input_tokens: 10 }, 'x') < spend.weightOf({ input_tokens: 10 }, 'x'), 'cache reads are cheap');
  assert.equal(spend.weightOf(null, 'x'), 0);
  assert.equal(spend.weightOf({ input_tokens: -5, output_tokens: 'lots' }, 'x'), 0);
});

test('calls from one source in the same 10 minutes share an entry', () => {
  let l = [];
  l = spend.record(l, tab('t:a', 'Fix tests'), 100, NOW);
  l = spend.record(l, tab('t:a', 'Fix tests'), 50, NOW + 1000);
  l = spend.record(l, tab('t:b', 'Docs'), 30, NOW + 2000);
  assert.equal(l.length, 2);
  assert.equal(l.find(e => e.k === 't:a').w, 150);
  l = spend.record(l, tab('t:a', 'Fix tests'), 10, NOW + spend.BUCKET_MS);
  assert.equal(l.length, 3);
});

test('record never mutates the ledger it was given', () => {
  const l = spend.record([], tab('t:a', 'A'), 100, NOW);
  const frozen = JSON.stringify(l);
  spend.record(l, tab('t:a', 'A'), 100, NOW);
  assert.equal(JSON.stringify(l), frozen);
});

test('entries older than the weekly window are dropped; zero spend is ignored', () => {
  let l = spend.record([], tab('t:a', 'A'), 100, NOW);
  l = spend.record(l, tab('t:b', 'B'), 0, NOW + 1000);
  assert.equal(l.length, 1);
  l = spend.record(l, tab('t:b', 'B'), 5, NOW + spend.KEEP_MS + spend.BUCKET_MS);
  assert.deepEqual(l.map(e => e.k), ['t:b']);
});

test('breakdown splits a window by task or by project, biggest first', () => {
  let l = [];
  l = spend.record(l, tab('t:a', 'Fix tests', 'shellby'), 300, NOW);
  l = spend.record(l, tab('r:1', 'Nightly sweep', 'shellby', 'routine'), 100, NOW);
  l = spend.record(l, tab('t:c', 'Rack page', 'rack-builder'), 600, NOW);
  const tasks = spend.breakdown(l, NOW - H, 'task');
  assert.deepEqual(tasks.map(r => [r.label, r.kind, r.share]), [['Rack page', 'tab', 0.6], ['Fix tests', 'tab', 0.3], ['Nightly sweep', 'routine', 0.1]]);
  const projects = spend.breakdown(l, NOW - H, 'project');
  assert.deepEqual(projects.map(r => [r.label, r.share]), [['rack-builder', 0.6], ['shellby', 0.4]]);
});

test('breakdown only counts spend since the window began', () => {
  let l = spend.record([], tab('t:old', 'Old'), 500, NOW - 6 * H);
  l = spend.record(l, tab('t:new', 'New'), 100, NOW);
  assert.deepEqual(spend.breakdown(l, NOW - 5 * H, 'task').map(r => r.label), ['New']);
  assert.deepEqual(spend.breakdown(l, NOW + H, 'task'), [], 'nothing yet');
});

test('a renamed tab shows its latest title', () => {
  let l = spend.record([], tab('t:a', 'New task'), 10, NOW);
  l = spend.record(l, tab('t:a', 'Fix the build'), 10, NOW + spend.BUCKET_MS);
  assert.equal(spend.breakdown(l, NOW - H)[0].label, 'Fix the build');
});

test('a long tail folds into one "more" row', () => {
  let l = [];
  for (let i = 0; i < 10; i++) l = spend.record(l, tab(`t:${i}`, `Task ${i}`), 100 - i, NOW);
  const rows = spend.breakdown(l, NOW - H);
  assert.equal(rows.length, 7);
  assert.deepEqual(rows.at(-1).kind, 'rest');
  assert.equal(rows.at(-1).label, '4 more');
  assert.ok(Math.abs(rows.reduce((n, r) => n + r.share, 0) - 1) < 1e-9);
  // ...and keeps the folded rows, biggest first, so the panel can unfold them.
  assert.deepEqual(rows.at(-1).rows.map(r => r.label), ['Task 6', 'Task 7', 'Task 8', 'Task 9']);
  assert.ok(Math.abs(rows.at(-1).rows.reduce((n, r) => n + r.share, 0) - rows.at(-1).share) < 1e-9);
});

test('a window starts at its reset minus its length, or looks back without one', () => {
  assert.equal(spend.windowStart('fiveHour', NOW + H, NOW), NOW - 4 * H);
  assert.equal(spend.windowStart('fiveHour', null, NOW), NOW - 5 * H);
  assert.equal(spend.windowStart('sevenDay', NOW - 50 * 24 * H, NOW), NOW - 7 * 24 * H, 'an old reset is no help');
  assert.equal(spend.windowStart('fiveHour', NOW - H, NOW), NOW - H, 'a reset just past starts a fresh window');
});

test('two folders with the same name stay apart by project', () => {
  let l = spend.record([], { ...tab('t:a', 'A', 'app'), pk: 'c:/work/app' }, 10, NOW);
  l = spend.record(l, { ...tab('t:b', 'B', 'app'), pk: 'c:/home/app' }, 30, NOW);
  assert.deepEqual(spend.breakdown(l, NOW - H, 'project').map(r => [r.label, r.detail]), [['app', 'c:/home/app'], ['app', 'c:/work/app']]);
});

test('normalize tolerates junk from disk', () => {
  const l = spend.normalize([null, 'x', { t: NOW, k: 't:a', w: 5, kind: 'evil', label: 'A\u0000B' }, { t: NOW, k: '', w: 5 }, { t: 'x', k: 't:b', w: 5 }]);
  assert.deepEqual(l, [{ t: NOW, k: 't:a', w: 5, kind: 'tab', label: 'A B', project: null, pk: null }]);
  assert.deepEqual(spend.normalize(null), []);
});

test('spendFrom reads an assistant message id, model and usage', () => {
  const ev = { type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 3, output_tokens: 9 }, content: [] } };
  assert.deepEqual(spendFrom(ev), { messageId: 'msg_1', model: 'claude-opus-5-5', usage: { input_tokens: 3, output_tokens: 9 } });
  assert.equal(spendFrom({ type: 'user', message: ev.message }), null);
  assert.equal(spendFrom({ type: 'assistant', message: { id: 'msg_2' } }), null);
  assert.equal(spendFrom(null), null);
});

test('a session reports each API call once, however many blocks it streams', () => {
  const s = new ClaudeSession({ exe: process.execPath, cwd: os.tmpdir(), mode: 'ask' });
  const seen = [];
  s.on('spend', x => seen.push([x.messageId, x.weight]));
  for (const id of ['m1', 'm1', 'm2', 'm1', 'm2', 'm3']) s.countSpend({ messageId: id, model: 'claude-haiku-4-5', usage: { input_tokens: 10 } });
  s.countSpend(null);
  assert.deepEqual(seen, [['m1', 10], ['m2', 10], ['m3', 10]]);
});

test('a later block with a bigger count adds only the difference', () => {
  const s = new ClaudeSession({ exe: process.execPath, cwd: os.tmpdir(), mode: 'ask' });
  const seen = [];
  s.on('spend', x => seen.push(x.weight));
  s.countSpend({ messageId: 'm1', model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 1 } });
  s.countSpend({ messageId: 'm1', model: 'claude-haiku-4-5', usage: { input_tokens: 10, output_tokens: 40 } });
  assert.deepEqual(seen, [15, 195]);
});
