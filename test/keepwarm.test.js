// Keep warm's rules (src/main/keepwarm.js): which tabs get a ping and when,
// what a ping's readback means, and when you're back.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const kw = require('../src/main/keepwarm');

const T0 = 1_790_000_000_000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

const tab = (over = {}) => ({
  id: 'a', title: 'A', saved: true, hasProc: true, inTerminal: false, busy: false, pending: 0, crew: 0,
  size: 250000, cache: { at: T0 - 10 * MIN, ttlMs: HOUR }, ...over,
});
const one = (t, kept = new Map(), now = T0, lead) => kw.plan([t], kept, now, lead)[0];

test('a warm one-hour cache is due five minutes before it would expire', () => {
  const expires = T0 - 10 * MIN + HOUR;
  assert.deepEqual(one(tab()), { id: 'a', title: 'A', action: 'wait', reason: null, dueAt: expires - 5 * MIN });
  assert.equal(one(tab(), new Map(), expires - 5 * MIN - 1).action, 'wait');
  assert.equal(one(tab(), new Map(), expires - 5 * MIN).action, 'ping');
  assert.equal(one(tab(), new Map(), expires - 1).action, 'ping');
});

test('the lead can be set, for the e2e run', () => {
  assert.equal(one(tab(), new Map(), T0, HOUR - 1000).action, 'ping');
});

test('a tab that is working, waiting on you or running helpers waits, even past due', () => {
  for (const over of [{ busy: true }, { pending: 1 }, { crew: 2 }]) {
    const p = one(tab(over), new Map(), T0 + HOUR);
    assert.equal(p.action, 'wait');
    assert.equal(p.reason, 'working');
  }
});

test('nothing to keep warm: unsaved, no process, in a terminal, or no cache yet', () => {
  for (const over of [{ saved: false }, { hasProc: false }, { inTerminal: true }, { cache: null }]) {
    assert.deepEqual([one(tab(over)).action, one(tab(over)).reason], ['skip', 'nothing to keep warm']);
  }
});

test('a five-minute cache is left alone, and says so', () => {
  const p = one(tab({ cache: { at: T0, ttlMs: 5 * MIN } }));
  assert.deepEqual([p.action, p.reason], ['skip', 'its cache only lasts 5 minutes']);
});

test('a conversation under 200k is too small to be worth it, and says how big it is', () => {
  for (const size of [40000, 199999, 0, undefined]) {
    assert.deepEqual([one(tab({ size })).action, one(tab({ size })).reason], ['skip', `too small to be worth it (${kw.tokensText(size)})`]);
  }
  assert.equal(one(tab({ size: 200000 })).action, 'wait', 'exactly 200k is kept');
  // Kept, then compacted: what's left isn't worth it either.
  const kept = new Map([['a', { state: 'kept', reason: null, lastPing: null }]]);
  assert.deepEqual([one(tab({ size: 30000 }), kept).action, one(tab({ size: 30000 }), kept).reason], ['drop', 'too small to be worth it (30k)']);
});

test('a cold cache is skipped when it was never kept, and dropped when it was', () => {
  const cold = tab({ cache: { at: T0 - 2 * HOUR, ttlMs: HOUR } });
  assert.deepEqual([one(cold).action, one(cold).reason], ['skip', 'its cache is already cold']);
  const kept = new Map([['a', { state: 'kept', reason: null, lastPing: null }]]);
  const p = one(cold, kept);
  assert.equal(p.action, 'drop');
  assert.equal(p.reason, `it went cold at ${kw.hhmm(T0 - HOUR)}`);
});

test('a kept tab whose process ended is dropped; a dropped one stays skipped', () => {
  const kept = new Map([['a', { state: 'kept', reason: null, lastPing: null }]]);
  assert.deepEqual([one(tab({ hasProc: false }), kept).action, one(tab({ hasProc: false }), kept).reason], ['drop', 'its Claude Code process ended']);
  const dropped = new Map([['a', { state: 'dropped', reason: 'the ping tried to use a tool', lastPing: null }]]);
  assert.deepEqual([one(tab(), dropped).action, one(tab(), dropped).reason], ['skip', 'the ping tried to use a tool']);
});

test('a ping that read the cache kept it warm', () => {
  assert.deepEqual(kw.receipt({ ok: true, tokens: { cacheRead: 214000, cacheWrite: 300 } }), { warm: true, read: 214000, wrote: 300, reason: null });
});

test('a ping that read nothing, or wrote a tenth or more of what it read (10k at least), found it cold', () => {
  assert.equal(kw.receipt({ ok: true, tokens: { cacheRead: 0, cacheWrite: 40000 } }).reason, 'the ping found it cold (read 0, wrote 40k)');
  assert.equal(kw.receipt({ ok: true, tokens: { cacheRead: 200000, cacheWrite: 20000 } }).warm, false);
  assert.equal(kw.receipt({ ok: true, tokens: { cacheRead: 200000, cacheWrite: 19999 } }).warm, true);
  assert.equal(kw.receipt({ ok: true, tokens: null }).warm, false);
  // cold, so the service can tell a cold cache (one more ping) from an error or a tool (dropped at once)
  assert.equal(kw.receipt({ ok: true, tokens: { cacheRead: 0, cacheWrite: 40000 } }).cold, true);
  assert.equal(kw.receipt({ ok: false, error: 'boom' }).cold, undefined);
  assert.equal(kw.receipt({ ok: false, denied: true }).cold, undefined);
});

test("a small tab's fixed per-ping write isn't mistaken for a cold cache", () => {
  // Task 0's spike: a warm ping on a 35k conversation read 35,083 and wrote 2,624.
  assert.equal(kw.receipt({ ok: true, tokens: { cacheRead: 35083, cacheWrite: 2624 } }).warm, true);
  assert.equal(kw.receipt({ ok: true, tokens: { cacheRead: 30000, cacheWrite: 9999 } }).warm, true);
  assert.equal(kw.receipt({ ok: true, tokens: { cacheRead: 30000, cacheWrite: 10000 } }).warm, false);
});

test('an error or a tool request ends keeping that tab warm, with the reason', () => {
  assert.equal(kw.receipt({ ok: false, error: 'Claude AI usage limit reached\nmore detail' }).reason, 'Claude AI usage limit reached');
  assert.equal(kw.receipt({ ok: false, error: null }).reason, 'the ping failed');
  assert.equal(kw.receipt({ ok: false, denied: true }).reason, 'the ping tried to use a tool');
});

test("you're back on the first short idle reading after a long one, and not before", () => {
  let s = kw.watchBack(false, { idleMs: 10 * 1000 });
  assert.deepEqual(s, { left: false, back: false }, 'still at the keyboard after pressing it');
  s = kw.watchBack(s.left, { idleMs: 2 * MIN });
  assert.deepEqual(s, { left: true, back: false });
  s = kw.watchBack(s.left, { idleMs: 40 * MIN });
  assert.deepEqual(s, { left: true, back: false });
  s = kw.watchBack(s.left, { idleMs: 5 * 1000 });
  assert.deepEqual(s, { left: false, back: true });
  assert.deepEqual(kw.watchBack(false, { idleMs: 0, locked: true }), { left: true, back: false }, 'locked counts as away');
});

test('the words: receipts, and a tooltip line per tab', () => {
  assert.equal(kw.tokensText(214321), '214k');
  assert.equal(kw.tokensText(950), '950');
  assert.equal(kw.keptText(T0, 214000), `Kept warm ${kw.hhmm(T0)} · read 214k from cache`);
  assert.equal(kw.keptText(T0, 21000, 16000), `Kept warm ${kw.hhmm(T0)} · read 21k from cache, wrote 16k`, 'a cold receipt says what it wrote');
  assert.equal(kw.keptText(T0, 0, 40000), `Kept warm ${kw.hhmm(T0)} · wrote 40k back to the cache`, 'a ping that read nothing does not say it read 0');
  assert.equal(kw.stoppedText('it went cold at 13:02'), 'Stopped keeping warm: it went cold at 13:02');
  const due = { id: 'a', title: 'A', action: 'wait', reason: null, dueAt: T0 };
  assert.equal(kw.tabLine(due, { state: 'kept', lastPing: null }), `next ping ${kw.hhmm(T0)}`);
  assert.equal(kw.tabLine(due, { state: 'kept', lastPing: { at: T0 - HOUR, read: 1 } }), `kept warm ${kw.hhmm(T0 - HOUR)} · next ping ${kw.hhmm(T0)}`);
  assert.equal(kw.tabLine({ ...due, reason: 'working' }, { state: 'kept' }), 'working');
  assert.equal(kw.tabLine({ ...due, action: 'skip', reason: 'its cache only lasts 5 minutes' }, undefined), 'its cache only lasts 5 minutes');
  assert.equal(kw.tabLine(due, { state: 'dropped', reason: 'x' }), 'stopped: x');
});

test('the ping text is the one the spec fixes', () => {
  assert.equal(kw.PING_TEXT, 'Keep-warm ping from Shellby. Reply with the single word: warm. Use no tools.');
  assert.deepEqual([kw.LEAD_MS, kw.MAX_MS, kw.TICK_MS, kw.AWAY_IDLE_MS, kw.COLD_SHARE, kw.COLD_MIN_WRITE, kw.MIN_KEEP_TOKENS], [5 * MIN, 3 * HOUR, 30 * 1000, 2 * MIN, 0.1, 10000, 200000]);
});
