// History sync between PCs (history-sync.js, github/history-gist.js): what
// travels, how two PCs' copies merge, and two PCs syncing through one fake gist.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const hs = require('../src/main/history-sync');
const { syncHistory, whereFrom } = require('../src/main/github/history-gist');
const { History: Batched } = require('../src/main/history');

class History extends Batched {
  append(id, item) { super.append(id, item); this.flush(id); }
}

const tmp = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-hsync-')));
const tick = () => new Promise(r => setTimeout(r, 5));
const A = { pc: 'pc-a', name: 'DESK' };
const B = { pc: 'pc-b', name: 'LAPTOP' };

// ------------------------------------------------------------ pure

test('the copy that travels clips tool output, drops pictures and blanks secrets', () => {
  const items = hs.travel([
    { kind: 'user', text: 'use ghp_abcdefghijklmnopqrstuvwxyz0123456789 please' },
    { kind: 'tool_result', content: 'x'.repeat(5000) },
    { kind: 'shots', image: 'data:image/png;base64,AAAA' },
    { kind: 'thinking', text: 'not replayed, so not sent' },
  ]);
  assert.equal(items.length, 3);
  assert.doesNotMatch(items[0].text, /ghp_/);
  assert.ok(items[1].content.length < 700);
  assert.equal(items[2].image, '');
});

test('pack and unpack round-trip, and junk unpacks as nothing', () => {
  const items = [{ kind: 'user', text: 'hi' }, { kind: 'text', text: 'hello' }];
  assert.deepEqual(hs.unpack(hs.pack(items)), items);
  assert.deepEqual(hs.unpack('not base64 gzip'), []);
  assert.deepEqual(hs.unpack(hs.pack([{ kind: 'evil' }, { kind: 'text', text: 'ok' }])), [{ kind: 'text', text: 'ok' }]);
});

const e = (id, at, more = {}) => ({ id, title: id, createdAt: 1, updatedAt: at, ...more });

test('the plan: new here goes up, new there comes down, the newer side wins', () => {
  const remote = { entries: [e('there', 5), e('newer-there', 9), e('newer-here', 3)] };
  const local = [e('here', 4), e('newer-there', 2, { syncedAt: 2 }), e('newer-here', 8, { syncedAt: 3 })];
  const p = hs.plan({ local, remote });
  assert.deepEqual(p.push.sort(), ['here', 'newer-here']);
  assert.deepEqual(p.pull.sort(), ['newer-there', 'there']);
  assert.deepEqual(p.fork, []);
});

test('the plan: changed on both sides since they last agreed is a fork, never a lost turn', () => {
  const p = hs.plan({ local: [e('c', 8, { syncedAt: 3 })], remote: { entries: [e('c', 9)] } });
  assert.deepEqual(p.fork, ['c']);
  assert.deepEqual(p.pull, []);
});

test('the plan: an open conversation is never replaced under you', () => {
  const p = hs.plan({ local: [e('c', 2, { syncedAt: 2 })], remote: { entries: [e('c', 9)] }, open: new Set(['c']) });
  assert.deepEqual([p.pull, p.fork], [[], []]);
});

test('the plan: a rename or a tick counts as a change (editedAt)', () => {
  const p = hs.plan({ local: [e('c', 5, { syncedAt: 5, editedAt: 7 })], remote: { entries: [e('c', 5)] } });
  assert.deepEqual(p.push, ['c']);
});

test('the plan: deleted on another PC goes to Recently deleted here, unless changed since', () => {
  const now = Date.now();
  const remote = { entries: [], gone: { old: now - 10, kept: now - 10 } };
  const p = hs.plan({ local: [e('old', now - 20, { syncedAt: now - 20 }), e('kept', now - 5, { syncedAt: now - 20 })], remote, now });
  assert.deepEqual(p.trash, ['old']);
  assert.deepEqual(p.push, ['kept']);
});

test('the plan: deleted here takes it off the gist and leaves a marker', () => {
  const now = Date.now();
  const p = hs.plan({ local: [], bin: [{ ...e('c', now - 20), deletedAt: now - 10 }], remote: { entries: [e('c', now - 20)] }, now });
  assert.deepEqual(p.drop, ['c']);
  assert.equal(p.gone.c, now - 10);
  assert.deepEqual(p.pull, []);
});

test('only the newest MAX_SYNCED travel, and one trimmed off stays off until it changes', () => {
  const remote = { entries: Array.from({ length: hs.MAX_SYNCED }, (_, i) => e(`r${i}`, 100 + i)) };
  const p = hs.plan({ local: [e('old', 50, { syncedAt: 50 })], remote });
  assert.deepEqual(p.push, []);
  const next = hs.nextIndex(remote, [hs.cleanEntry(e('fresh', 500))], [], {});
  assert.equal(next.index.entries.length, hs.MAX_SYNCED);
  assert.equal(next.index.entries[0].id, 'fresh');
  assert.deepEqual(next.removed, ['r0']);
});

test('routine runs stay on their PC', () => {
  assert.deepEqual(hs.eligible([e('chat', 2), e('run', 3, { routineId: 'r' })]).map(x => x.id), ['chat']);
});

test('one from another PC starts Claude afresh with a recap; one you last worked on here keeps its session', () => {
  const re = hs.cleanEntry({ ...e('c', 9), pc: 'pc-b', pcName: 'LAPTOP', lastPc: 'pc-b', lastPcName: 'LAPTOP' });
  const fresh = hs.entryIn(re, { ...e('c', 2), claudeSessionId: 'old' }, { me: A, cwd: 'C:\\w', recapText: 'RECAP' });
  assert.equal(fresh.claudeSessionId, null);
  assert.equal(fresh.preamble, 'RECAP');
  assert.equal(fresh.elsewhere, 'LAPTOP');
  const mine = hs.entryIn({ ...re, lastPc: 'pc-a' }, { ...e('c', 2), claudeSessionId: 'kept' }, { me: A, cwd: 'C:\\w', recapText: 'RECAP' });
  assert.equal(mine.claudeSessionId, 'kept');
  assert.equal(mine.preamble, undefined);
});

test('a folder from another PC: its own path, else the same place in your clone, else home', () => {
  const where = whereFrom([{ root: 'D:\\code\\app', remote: 'Me/App' }], { exists: p => p.startsWith('D:\\code\\app'), home: 'C:\\Users\\me' });
  assert.deepEqual(hs.place({ cwd: 'D:\\code\\app\\web' }, where), { cwd: 'D:\\code\\app\\web', moved: false });
  assert.deepEqual(hs.place({ cwd: 'E:\\x\\app\\web', repo: 'me/app', rel: 'web' }, where), { cwd: path.join('D:\\code\\app', 'web'), moved: false });
  assert.deepEqual(hs.place({ cwd: 'E:\\other' }, where), { cwd: 'C:\\Users\\me', moved: true });
  assert.deepEqual(where.placeOf('D:\\code\\app\\web\\src'), { repo: 'me/app', rel: 'web/src' });
});

test('the recap keeps the newest messages and says where it came from', () => {
  const items = [{ kind: 'user', text: 'first ' + 'a'.repeat(20000) }, { kind: 'text', text: 'reply' }, { kind: 'user', text: 'latest ask' }];
  const r = hs.recap(items, { from: 'LAPTOP' });
  assert.match(r, /^\[Shellby: .*LAPTOP/);
  assert.match(r, /You: latest ask/);
  assert.match(r, /Claude: reply/);
  assert.ok(r.length <= 12100);
});

test('the recap leaves out what came before a /clear', () => {
  const items = [{ kind: 'user', text: 'forget me' }, { kind: 'text', text: 'old reply' }, { kind: 'cleared' }, { kind: 'user', text: 'after the clear' }];
  const r = hs.recap(items, { from: 'LAPTOP' });
  assert.match(r, /You: after the clear/);
  assert.ok(!/forget me|old reply/.test(r), 'Claude is never told what was cleared');
});

test('a remote index of junk cleans to nothing harmful', () => {
  const c = hs.cleanIndex({ entries: [{ id: '../x' }, { id: 'ok', cwd: '\\\\host\\share', repo: 'a/b/c', rel: '../up' }, 'str'], gone: { 'bad id': 1 } });
  assert.equal(c.entries.length, 1);
  assert.deepEqual([c.entries[0].cwd, c.entries[0].repo, c.entries[0].rel], ['', null, '']);
  assert.deepEqual(c.gone, {});
});

// ------------------------------------------------------------ History

test('History: deleting tells sync, a sync-made delete does not, and restoring counts as a change', () => {
  const told = [];
  const h = new History(tmp(), { onGone: ids => told.push(...ids) });
  h.create({ id: 'a', title: 'a', cwd: 'C:/w', mode: 'ask' });
  h.create({ id: 'b', title: 'b', cwd: 'C:/w', mode: 'ask' });
  h.trash('a');
  h.trash('b', Date.now(), { quiet: true });
  assert.deepEqual(told, ['a']);
  assert.ok(h.restore('a').editedAt > 0);
});

test('History: rekey moves the transcript with the entry', () => {
  const dir = tmp();
  const h = new History(dir);
  h.create({ id: 'a', title: 'a', cwd: 'C:/w', mode: 'ask' });
  h.append('a', { kind: 'user', text: 'hi' });
  h.rekey('a', 'b', { title: 'b' });
  assert.equal(h.get('a'), null);
  assert.deepEqual(h.load('b').map(i => i.text), ['hi']);
});

// ------------------------------------------------------------ two PCs, one gist

function fakeGitHub() {
  const gists = new Map();
  let n = 0, rev = 0;
  const view = g => ({ id: g.id, files: Object.fromEntries(Object.entries(g.files).map(([k, c]) => [k, { content: c, size: c.length }])) });
  const idOf = p => decodeURIComponent(p.split('/')[2]);
  const gh = {
    gists, gets: 0, notModified: 0,
    async getFresh(p, etag) {
      const g = gists.get(idOf(p));
      if (!g) throw Object.assign(new Error('Not Found'), { status: 404 });
      if (etag && etag === `"${g.rev}"`) { gh.notModified++; return { notModified: true, data: null, etag }; }
      gh.gets++;
      return { data: view(g), etag: `"${g.rev}"` };
    },
    async get(p) {
      if (p.startsWith('/gists?')) return [...gists.values()].map(g => ({ id: g.id, files: Object.fromEntries(Object.keys(g.files).map(k => [k, {}])) }));
      return view(gists.get(idOf(p)));
    },
    async post(_p, body) {
      const id = `g${++n}`;
      gists.set(id, { id, rev: ++rev, files: Object.fromEntries(Object.entries(body.files).map(([k, v]) => [k, v.content])) });
      return { id };
    },
    async patch(p, body) {
      const g = gists.get(idOf(p));
      for (const [k, v] of Object.entries(body.files)) { if (v === null) delete g.files[k]; else g.files[k] = v.content; }
      g.rev = ++rev;
      return view(g);
    },
  };
  return gh;
}

function pc(me) {
  let st = {};
  const history = new History(tmp(), { onGone: (ids, at) => state.save({ gone: Object.fromEntries(ids.map(id => [id, at])) }) });
  const state = {
    load: () => JSON.parse(JSON.stringify(st)),
    save: patch => { st = { ...st, ...patch, gone: hs.mergeGone(st.gone, patch.gone) }; },
  };
  const where = whereFrom([], { exists: p => p === 'C:\\work', home: 'C:\\Users\\me' });
  return { me, history, state, sync: (gh, open) => syncHistory(gh, { history, state, me, where, open }) };
}

test('two PCs: a conversation started on one shows on the other, and carrying it on there works', async () => {
  const gh = fakeGitHub();
  const a = pc(A), b = pc(B);
  a.history.create({ id: 'c1', title: 'Fix the login', cwd: 'C:\\work', mode: 'ask' });
  a.history.update('c1', { claudeSessionId: 'sess-a' });
  a.history.append('c1', { kind: 'user', text: 'fix the login' });
  a.history.append('c1', { kind: 'text', text: 'Done: it was the redirect.' });

  const ra = await a.sync(gh);
  assert.equal(ra.pushed, 1);
  const rb = await b.sync(gh);
  assert.equal(rb.pulled, 1);
  const got = b.history.get('c1');
  assert.equal(got.title, 'Fix the login');
  assert.equal(got.cwd, 'C:\\work');
  assert.equal(got.claudeSessionId, null);
  assert.equal(got.elsewhere, 'DESK');
  assert.match(got.preamble, /Done: it was the redirect/);
  assert.deepEqual(b.history.load('c1').map(i => i.kind), ['user', 'text']);

  // Nothing changed: the next sync on either is a 304 and sends nothing.
  const quiet = await b.sync(gh);
  assert.deepEqual([quiet.pushed, quiet.pulled], [0, 0]);
  assert.ok(gh.notModified >= 1);

  // B carries it on; A takes B's turns, and drops its own Claude session for a recap.
  await tick();
  b.history.update('c1', { claudeSessionId: 'sess-b', preamble: null });
  b.history.append('c1', { kind: 'user', text: 'and the logout' });
  assert.equal((await b.sync(gh)).pushed, 1);
  assert.equal((await a.sync(gh)).pulled, 1);
  const back = a.history.get('c1');
  assert.equal(back.claudeSessionId, null);
  assert.match(back.preamble, /LAPTOP/);
  assert.equal(back.elsewhere, null, 'it started here');
  assert.equal(a.history.load('c1').length, 3);
});

test('two PCs: a rename travels without replacing the transcript', async () => {
  const gh = fakeGitHub();
  const a = pc(A), b = pc(B);
  a.history.create({ id: 'c1', title: 'one', cwd: 'C:\\work', mode: 'ask' });
  a.history.append('c1', { kind: 'user', text: 'x'.repeat(5000) });
  await a.sync(gh); await b.sync(gh);
  await tick();
  b.history.rename('c1', 'Better name');
  await b.sync(gh);
  await a.sync(gh);
  assert.equal(a.history.get('c1').title, 'Better name');
  assert.equal(a.history.load('c1')[0].text.length, 5000, "A's own full transcript stays");
});

test('two PCs: deleting on one bins it on the other', async () => {
  const gh = fakeGitHub();
  const a = pc(A), b = pc(B);
  a.history.create({ id: 'c1', title: 'one', cwd: 'C:\\work', mode: 'ask' });
  a.history.append('c1', { kind: 'user', text: 'hi' });
  await a.sync(gh); await b.sync(gh);
  await tick();
  a.history.trash('c1');
  await a.sync(gh);
  const r = await b.sync(gh);
  assert.equal(r.trashed, 1);
  assert.equal(b.history.get('c1'), null);
  assert.deepEqual(b.history.trashed().map(x => x.id), ['c1']);
  // And it doesn't come back on the next round.
  await a.sync(gh); await b.sync(gh);
  assert.equal(a.history.get('c1'), null);
});

test('two PCs: changed on both at once keeps both', async () => {
  const gh = fakeGitHub();
  const a = pc(A), b = pc(B);
  a.history.create({ id: 'c1', title: 'one', cwd: 'C:\\work', mode: 'ask' });
  a.history.append('c1', { kind: 'user', text: 'start' });
  await a.sync(gh); await b.sync(gh);
  await tick();
  a.history.update('c1', {}); a.history.append('c1', { kind: 'user', text: 'from A' });
  await tick();
  b.history.update('c1', {}); b.history.append('c1', { kind: 'user', text: 'from B' });
  await b.sync(gh);
  const r = await a.sync(gh);
  assert.equal(r.forked, 1);
  await b.sync(gh);
  for (const side of [a, b]) {
    const texts = side.history.list().map(x => side.history.load(x.id).map(i => i.text).join('|')).sort();
    assert.deepEqual(texts, ['start|from A', 'start|from B']);
  }
});

test('an open conversation is left alone until it closes', async () => {
  const gh = fakeGitHub();
  const a = pc(A), b = pc(B);
  a.history.create({ id: 'c1', title: 'one', cwd: 'C:\\work', mode: 'ask' });
  await a.sync(gh); await b.sync(gh);
  await tick();
  a.history.rename('c1', 'renamed on A');
  await a.sync(gh);
  await b.sync(gh, new Set(['c1']));
  assert.equal(b.history.get('c1').title, 'one');
  await b.sync(gh);
  assert.equal(b.history.get('c1').title, 'renamed on A');
});
