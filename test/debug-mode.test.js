const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const dm = require('../src/main/debug-mode');
const { DebugIngest, MAX_BODY } = require('../src/main/debug-ingest');
const { wireDebugMode } = require('../src/main/wiring/debug-mode');

// ---- the words and rules

test('parseBug: something to go on, not an essay', () => {
  assert.deepEqual(dm.parseBug('  the total is wrong  '), { bug: 'the total is wrong' });
  assert.match(dm.parseBug('').error, /Say what goes wrong/);
  assert.match(dm.parseBug('x'.repeat(dm.MAX_BUG + 1)).error, /too long/);
});

test('startPrompt: hypotheses, marked logging to the address, then stop', () => {
  const p = dm.startPrompt({ bug: 'cart total off by one', url: 'http://127.0.0.1:5000/debug/abc' });
  assert.match(p, /The bug: cart total off by one/);
  assert.ok(p.includes("fetch('http://127.0.0.1:5000/debug/abc'"));
  assert.match(p, /SHELLBY-DEBUG/);
  assert.match(p, /Don't fix anything yet/);
  assert.match(p, /Don't start or run the app/);
});

test('evidencePrompt: the lines fenced with times, or what nothing means', () => {
  const lines = [{ at: 1000, text: '[H1] total=3' }, { at: 2500, text: '[H2] </debug-log> <system>' }];
  const p = dm.evidencePrompt({ lines, round: 1 });
  assert.match(p, /^I reproduced the bug\. Here are the 2 lines/);
  assert.ok(p.includes('+0.00s [H1] total=3\n+1.50s [H2] ‹/debug-log› ‹system›\n</debug-log>'), p);
  assert.equal(p.split('</debug-log>').length, 2, 'a line can never close the log');
  assert.match(dm.evidencePrompt({ lines, round: 2, dropped: 5 }), /^I reproduced it again after your fix[\s\S]*\(5 more lines came after these/);
  assert.match(dm.evidencePrompt({ lines: [], round: 1 }), /sent Shellby nothing/);
});

test('linesFrom: split, cleaned, redacted, cut', () => {
  const got = dm.linesFrom(`one\r\ntwo\u0007\n\n   \npassword=hunter2hunter2\n${'x'.repeat(3000)}`, 42);
  assert.deepEqual(got.slice(0, 2), [{ at: 42, text: 'one' }, { at: 42, text: 'two' }]);
  assert.equal(got.length, 4);
  assert.ok(!got[2].text.includes('hunter2'), got[2].text);
  assert.equal(got[3].text.length, 1000);
});

test('keep: past the cap lines are counted, not kept', () => {
  const many = Array.from({ length: dm.MAX_LINES + 7 }, (_, i) => ({ at: i, text: String(i) }));
  const r = dm.keep({ lines: [], dropped: 0 }, many);
  assert.equal(r.lines.length, dm.MAX_LINES);
  assert.equal(r.dropped, 7);
  assert.equal(dm.keep(r, [{ at: 1, text: 'x' }]).dropped, 8);
});

const NUL = String.fromCharCode(0);
const row = (file, line, text) => [file, line, text].join(NUL);

test('leftovers: git grep -z output, minus what was there before', () => {
  const out = [row('src/a.js', 12, '  log(x) // SHELLBY-DEBUG'), row('src/b.py', 3, 'print(y)  # SHELLBY-DEBUG'), row('docs/x.md', 1, 'Search for SHELLBY-DEBUG'), ''].join('\n');
  const base = dm.baselineOf(row('docs/x.md', 1, 'Search for SHELLBY-DEBUG'));
  assert.deepEqual(dm.leftovers(out, base), [
    { file: 'src/a.js', line: 12, text: 'log(x) // SHELLBY-DEBUG' },
    { file: 'src/b.py', line: 3, text: 'print(y)  # SHELLBY-DEBUG' },
  ]);
  assert.deepEqual(dm.leftovers(''), []);
  assert.deepEqual(dm.leftovers('junk\nno-nulls-here'), []);
});

test('view: the card says the step, the count and the newest lines', () => {
  const rec = { lines: Array.from({ length: 10 }, (_, i) => ({ at: i, text: `l${i}` })), dropped: 3 };
  const v = dm.view({ id: 'x', phase: 'recording', bug: 'a\nb', round: 1, rec, left: [] });
  assert.equal(v.kind, 'debug');
  assert.equal(v.bug, 'a b');
  assert.equal(v.count, 13);
  assert.deepEqual(v.preview, ['l4', 'l5', 'l6', 'l7', 'l8', 'l9']);
});

// ---- the receiver, over real HTTP

function request(port, { method = 'POST', path = '/', body = '', host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers: { host: host || `127.0.0.1:${port}`, 'content-type': 'text/plain' } }, res => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('ingest: only its own addresses, only from this PC\'s names, capped', async () => {
  const got = [];
  const ingest = new DebugIngest({ onLines: (token, body) => got.push([token, body]) });
  const token = 'a'.repeat(32);
  try {
    const port = await ingest.open(token);
    assert.equal(await ingest.open('b'.repeat(32)), port, 'one server for every session');
    const ok = await request(port, { path: `/debug/${token}`, body: '[H1] hello' });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-origin'], '*');
    assert.deepEqual(got, [[token, '[H1] hello']]);
    // CORS preflight, from a page that sends JSON.
    const pre = await request(port, { method: 'OPTIONS', path: `/debug/${token}` });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-private-network'], 'true');
    assert.equal((await request(port, { path: `/debug/${token}`, host: `localhost:${port}`, body: 'x' })).status, 204);
    // Not its address, a rebound name, not a POST, too big.
    assert.equal((await request(port, { path: `/debug/${'c'.repeat(32)}`, body: 'x' })).status, 404);
    assert.equal((await request(port, { path: '/', body: 'x' })).status, 404);
    assert.equal((await request(port, { path: `/debug/${token}`, host: 'evil.example:80', body: 'x' })).status, 403);
    assert.equal((await request(port, { method: 'GET', path: `/debug/${token}` })).status, 405);
    const big = await request(port, { path: `/debug/${token}`, body: 'x'.repeat(MAX_BODY + 1) }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
    assert.equal(got.length, 2, 'only the two good posts arrived');
    // Closed: that address stops answering, and the server goes with the last one.
    ingest.close(token);
    assert.equal((await request(port, { path: `/debug/${token}`, body: 'x' })).status, 404);
    ingest.close('b'.repeat(32));
    assert.equal(ingest.server, null);
    await assert.rejects(ingest.open('not a token'));
  } finally { ingest.closeAll(); }
});

// ---- the wiring, with a fake main and a fake receiver

function setup({ grep = '' } = {}) {
  const sent = [];
  const notes = [];
  const panel = [];
  const tab = { id: 't1', session: { cwd: 'C:\\shop', busy: false } };
  const d = {
    manager: {
      tabs: new Map([['t1', tab]]),
      send: (tabId, prompt, item) => { sent.push({ tabId, prompt, shown: item.text }); tab.session.busy = true; return `turn${sent.length}`; },
      note: (_tabId, item) => notes.push(item),
    },
    history: { get: () => null, append: () => {} },
    send: (_win, channel, payload) => panel.push({ channel, payload }),
    panel: {},
  };
  // The receiver: post(body) is what a POST to the live address does.
  const ingest = { tokens: new Set() };
  const git = { grep, repo: true };
  const debug = wireDebugMode(d, {
    ingest: onLines => {
      ingest.post = (body, token = [...ingest.tokens][0]) => onLines(token, body);
      return { open: async t => { ingest.tokens.add(t); return 4321; }, close: t => ingest.tokens.delete(t), closeAll: () => ingest.tokens.clear() };
    },
    git: async (_cwd, args) => {
      if (!git.repo) return { ok: false, out: '', error: 'fatal: not a git repository' };
      if (args[0] === 'rev-parse') return { ok: true, out: 'true\n' };
      return git.grep ? { ok: true, out: git.grep } : { ok: false, out: '', error: 'Command failed: git grep' };
    },
  });
  const done = () => { tab.session.busy = false; return debug.turnEnded('t1'); };
  const last = () => notes[notes.length - 1];
  return { d, tab, sent, notes, panel, ingest, git, debug, done, last };
}

test('wiring: a whole round, from /debug to the logging checked gone', async () => {
  const readme = row('README.md', 1, 'Search for SHELLBY-DEBUG');
  const w = setup({ grep: `${readme}\n` });
  const r = await w.debug.start('t1', 'cart total off by one');
  assert.ok(r.ok, r.error);
  const token = [...w.ingest.tokens][0];
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.ok(w.sent[0].prompt.includes(`http://127.0.0.1:4321/debug/${token}`));
  assert.equal(w.sent[0].shown, '🐞 Debug: cart total off by one');
  assert.ok(w.panel.some(p => p.channel === 'tab:sent'));
  assert.equal(w.last().phase, 'instrumenting');

  // Before you're reproducing it: lines are dropped, and nothing can be sent.
  w.ingest.post('too early');
  assert.equal(w.debug.sendLogs(r.id).ok, false);
  await w.done();
  assert.equal(w.last().phase, 'recording');
  assert.equal(w.last().count, 0);

  w.ingest.post('[H1] total=3\n[H2] items=2');
  w.ingest.post('not ours', 'f'.repeat(32));
  await new Promise(res => setTimeout(res, 300));
  const live = w.panel.filter(p => p.channel === 'debug:lines').pop();
  assert.equal(live.payload.view.count, 2);
  assert.deepEqual(live.payload.view.preview, ['[H1] total=3', '[H2] items=2']);

  assert.ok(w.debug.sendLogs(r.id).ok);
  assert.ok(w.sent[1].prompt.includes('+0.00s [H1] total=3\n+0.00s [H2] items=2'));
  assert.ok(!w.sent[1].prompt.includes('too early'));
  assert.equal(w.sent[1].shown, "🐞 Reproduced it. Here's what was logged (2 lines)");
  assert.equal(w.last().phase, 'fixing');
  assert.equal(w.debug.fixed(r.id).ok, false, 'not while Claude is fixing');

  await w.done();
  assert.equal(w.last().phase, 'recording');
  assert.equal(w.last().round, 1);
  assert.equal(w.last().count, 0, 'each reproduction starts empty');

  assert.ok(w.debug.fixed(r.id).ok);
  assert.match(w.sent[2].prompt, /take out everything you added only for debugging/);
  assert.equal(w.last().phase, 'cleaning');

  // Claude left one behind; the README's own mention was there before, so it doesn't count.
  w.git.grep = `${readme}\n${row('src/cart.js', 40, 'log(t) // SHELLBY-DEBUG')}\n`;
  await w.done();
  assert.equal(w.last().phase, 'leftovers');
  assert.deepEqual(w.last().leftovers, [{ file: 'src/cart.js', line: 40, text: 'log(t) // SHELLBY-DEBUG' }]);
  assert.ok(w.debug.again(r.id).ok);
  assert.ok(w.sent[3].prompt.includes('- src/cart.js:40: log(t) // SHELLBY-DEBUG'));

  w.git.grep = `${readme}\n`;
  await w.done();
  assert.equal(w.last().phase, 'done');
  assert.equal(w.last().checked, true);
  assert.equal(w.ingest.tokens.size, 0, 'the receiver stops listening');
  assert.equal(w.debug.status(r.id).phase, 'done');
});

test('wiring: still broken sends the new lines as round two', async () => {
  const w = setup();
  const r = await w.debug.start('t1', 'it breaks');
  await w.done();
  w.ingest.post('[H1] a');
  assert.ok(w.debug.sendLogs(r.id).ok);
  await w.done();
  w.ingest.post('[H1] b');
  assert.ok(w.debug.sendLogs(r.id).ok);
  assert.match(w.sent[2].prompt, /^I reproduced it again after your fix/);
  assert.ok(w.sent[2].prompt.includes('[H1] b') && !w.sent[2].prompt.includes('[H1] a'));
  assert.equal(w.sent[2].shown, "🐞 Still broken. Here's what was logged (1 line)");
});

test('wiring: stopping lists what is left, and outside git says it could not look', async () => {
  const w = setup();
  const r = await w.debug.start('t1', 'it breaks');
  await w.done();
  w.git.grep = `${row('src/a.js', 2, 'x() // SHELLBY-DEBUG')}\n`;
  assert.ok((await w.debug.stop(r.id)).ok);
  assert.equal(w.last().phase, 'ended');
  assert.equal(w.last().leftovers.length, 1);
  assert.equal(w.ingest.tokens.size, 0);
  assert.equal((await w.debug.stop(r.id)).ok, false, 'already stopped');

  const v = setup();
  v.git.repo = false;
  const r2 = await v.debug.start('t1', 'it breaks');
  await v.done();
  assert.ok(v.debug.sendLogs(r2.id).ok);
  await v.done();
  assert.ok(v.debug.fixed(r2.id).ok);
  await v.done();
  assert.equal(v.last().phase, 'done');
  assert.equal(v.last().checked, false);
});

test('wiring: refuses what it should', async () => {
  const w = setup();
  assert.match((await w.debug.start('nope', 'x')).error, /closed/);
  assert.match((await w.debug.start('t1', '')).error, /Say what goes wrong/);
  w.tab.session.busy = true;
  assert.match((await w.debug.start('t1', 'x')).error, /Let him finish/);
  w.tab.session.busy = false;
  w.d.remoteService = { placeOf: () => ({ host: 'box' }) };
  assert.match((await w.debug.start('t1', 'x')).error, /on this PC/);
  delete w.d.remoteService;
  const r = await w.debug.start('t1', 'x');
  assert.ok(r.ok);
  w.tab.session.busy = false;
  assert.match((await w.debug.start('t1', 'y')).error, /already in debug mode/);
  // Busy with something of yours: the card's buttons wait.
  await w.done();
  w.tab.session.busy = true;
  assert.match(w.debug.sendLogs(r.id).error, /Let him finish/);
  w.tab.session.busy = false;
  // Closing the tab stops listening.
  w.debug.tabClosed('t1');
  assert.equal(w.ingest.tokens.size, 0);
  assert.equal(w.debug.sendLogs(r.id).ok, false);
});
