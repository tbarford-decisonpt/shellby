// keepwarm-service.js: arming and stopping, the tick that pings, receipts,
// drops, the 3-hour cap and coming back, with a fake clock and tab manager.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const kw = require('../src/main/keepwarm');
const { createKeepWarm } = require('../src/main/keepwarm-service');

const T0 = 1_790_000_000_000;
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const WARM = { ok: true, error: null, denied: false, tokens: { cacheRead: 40000, cacheWrite: 30 } };
const COLD = { ok: true, error: null, denied: false, tokens: { cacheRead: 0, cacheWrite: 40000 } };

// Cached ten minutes ago for an hour: due at T0 + 45 min, cold at T0 + 50 min.
function fakeTab(id, session = {}) {
  return { id, title: id.toUpperCase(), saved: true, inTerminal: null, session: { proc: {}, busy: false, pending: new Map(), runningCrew: () => [], cache: { at: T0 - 10 * MIN, ttlMs: HOUR }, context: { tokens: 250000 }, ...session } };
}

function setup({ tabs = [fakeTab('a')], reply = WARM } = {}) {
  let clock = T0;
  let interval = null;
  const calls = { pings: [], notes: [], sent: [], blocker: [], interrupted: [], touched: [] };
  const timeouts = [];
  const manager = {
    tabs: new Map(tabs.map(t => [t.id, t])),
    ping: async (id, text) => { calls.pings.push({ id, text }); return reply; },
    note: (id, item) => calls.notes.push({ id, item }),
    interrupt: id => calls.interrupted.push(id),
    touch: id => calls.touched.push(id),
  };
  const svc = createKeepWarm({
    manager, panel: {}, CAPTURE: false,
    log: { info: () => {}, warn: () => {} },
    send: (_win, channel, payload) => calls.sent.push({ channel, payload }),
    powerSaveBlocker: { start: kind => { calls.blocker.push(['start', kind]); return 7; }, stop: id => calls.blocker.push(['stop', id]) },
    now: () => clock,
    setInterval: fn => { interval = fn; return { unref() {} }; },
    clearInterval: () => { interval = null; },
    setTimeout: (fn, ms) => { const h = { fn, ms, live: true, unref() {} }; timeouts.push(h); return h; },
    clearTimeout: h => { if (h) h.live = false; },
  });
  const settle = () => new Promise(r => setImmediate(r));
  return { svc, manager, calls, settle, advance: ms => { clock += ms; }, tick: () => interval?.(), timeouts: () => timeouts, ticking: () => !!interval };
}

test('with nothing warm for an hour it does not turn on, and says why', () => {
  const { svc, calls, ticking } = setup({ tabs: [fakeTab('a', { cache: { at: T0, ttlMs: 5 * MIN } })] });
  const r = svc.set(true);
  assert.equal(r.ok, false);
  assert.match(r.error, /Nothing to keep warm/);
  assert.equal(svc.view().on, false);
  assert.deepEqual(calls.blocker, []);
  assert.equal(ticking(), false);
});

test('a warm conversation under 200k does not turn it on, and the toast names the floor', () => {
  const { svc, calls } = setup({ tabs: [fakeTab('a', { context: { tokens: 40000 } }), fakeTab('b', { context: null })] });
  const r = svc.set(true);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'Nothing to keep warm: no conversation of 200k or more has a warm one-hour cache.');
  assert.deepEqual(calls.pings, []);
});

test('while it is on the PC stays awake, and turning it off lets it sleep', () => {
  const { svc, calls, ticking } = setup();
  assert.equal(svc.set(true).ok, true);
  assert.deepEqual(calls.blocker, [['start', 'prevent-app-suspension']]);
  assert.equal(ticking(), true);
  svc.set(false);
  assert.deepEqual(calls.blocker, [['start', 'prevent-app-suspension'], ['stop', 7]]);
  assert.equal(ticking(), false);
  assert.equal(svc.view().on, false);
});

test('a tab is pinged five minutes before its cache would expire, and not before', async () => {
  const { svc, calls, advance, tick, settle } = setup();
  svc.set(true);
  advance(44 * MIN); tick(); await settle();
  assert.equal(calls.pings.length, 0);
  advance(1 * MIN); tick(); await settle();
  assert.deepEqual(calls.pings, [{ id: 'a', text: kw.PING_TEXT }]);
  const receipt = calls.notes.at(-1);
  assert.equal(receipt.id, 'a');
  assert.deepEqual({ ...receipt.item, at: 0 }, { kind: 'keepwarm', warm: true, endsTurn: true, at: 0, read: 40000, text: kw.keptText(T0 + 45 * MIN, 40000) });
  assert.equal(svc.isKept('a'), true);
});

// The ping's turn restamps the cache (session-accounting.js): the fake tab's has to be moved by hand.
const restamp = (tab, at) => { tab.session.cache = { ...tab.session.cache, at }; };

test('a ping that finds the cache cold keeps the tab once, and says what it wrote', async () => {
  const a = fakeTab('a');
  const { svc, calls, advance, tick, settle } = setup({ tabs: [a], reply: COLD });
  svc.set(true);
  advance(46 * MIN); tick(); await settle();
  assert.equal(calls.pings.length, 1);
  assert.deepEqual({ ...calls.notes.at(-1).item, at: 0 }, { kind: 'keepwarm', warm: true, endsTurn: true, at: 0, read: 0, wrote: 40000, text: kw.keptText(T0 + 46 * MIN, 0, 40000) });
  assert.match(calls.notes.at(-1).item.text, /wrote 40k back to the cache$/);
  assert.equal(svc.isKept('a'), true, 'the ping wrote it back, so the next one should read it');
});

test('a second cold ping in a row drops the tab and says so', async () => {
  const a = fakeTab('a');
  const { svc, calls, advance, tick, settle } = setup({ tabs: [a], reply: COLD });
  svc.set(true);
  advance(46 * MIN); tick(); await settle();
  restamp(a, T0 + 46 * MIN);
  advance(55 * MIN); tick(); await settle();
  assert.equal(calls.pings.length, 2);
  assert.equal(calls.notes.at(-1).item.text, 'Stopped keeping warm: the ping found it cold (read 0, wrote 40k)');
  assert.equal(calls.notes.at(-1).item.warm, false);
  assert.equal(calls.notes.at(-1).item.endsTurn, true);
  assert.equal(svc.isKept('a'), false);
  advance(30 * MIN); tick(); await settle();
  assert.equal(calls.pings.length, 2, 'never pinged again');
});

test('a warm ping between two cold ones starts the count again: the tab stays kept', async () => {
  const a = fakeTab('a');
  const { svc, manager, calls, advance, tick, settle } = setup({ tabs: [a] });
  const replies = [COLD, WARM, COLD];
  manager.ping = async id => { calls.pings.push({ id }); return replies[calls.pings.length - 1]; };
  svc.set(true);
  advance(46 * MIN); tick(); await settle();
  for (let i = 0; i < 2; i++) {
    restamp(a, T0 + (46 + 55 * i) * MIN);
    advance(55 * MIN); tick(); await settle();
  }
  assert.equal(calls.pings.length, 3);
  assert.deepEqual(calls.notes.map(n => n.item.warm), [true, true, true]);
  assert.match(calls.notes.at(-1).item.text, /wrote 40k back to the cache$/);
  assert.equal(svc.isKept('a'), true);
});

test('a ping that asked for a tool drops the tab', async () => {
  const { svc, calls, advance, tick, settle } = setup({ reply: { ok: false, error: null, denied: true, tokens: null } });
  svc.set(true);
  advance(46 * MIN); tick(); await settle();
  assert.equal(calls.notes.at(-1).item.text, 'Stopped keeping warm: the ping tried to use a tool');
  assert.equal(calls.notes.at(-1).item.endsTurn, true);
  assert.equal(svc.isKept('a'), false);
});

test('a working tab waits and stays kept, even past due', async () => {
  const a = fakeTab('a');
  const { svc, calls, advance, tick, settle } = setup({ tabs: [a] });
  svc.set(true);
  a.session.busy = true;
  advance(55 * MIN); tick(); await settle();
  assert.deepEqual([calls.pings.length, calls.notes.length, svc.isKept('a')], [0, 0, true]);
});

test('woken past the expiry, a kept tab is dropped, not pinged, and the line does not end a turn', async () => {
  const { svc, calls, advance, tick, settle } = setup();
  svc.set(true);
  advance(51 * MIN); tick(); await settle();
  assert.equal(calls.pings.length, 0);
  assert.equal(calls.notes.at(-1).item.text, `Stopped keeping warm: it went cold at ${kw.hhmm(T0 + 50 * MIN)}`);
  assert.equal(calls.notes.at(-1).item.endsTurn, false);
});

test('a kept tab whose process ended is dropped', async () => {
  const a = fakeTab('a');
  const { svc, calls, tick, settle } = setup({ tabs: [a] });
  svc.set(true);
  a.session.proc = null;
  tick(); await settle();
  assert.equal(calls.notes.at(-1).item.text, 'Stopped keeping warm: its Claude Code process ended');
});

test('a kept tab that is closed just leaves, with no ping and no line', async () => {
  const { svc, manager, calls, advance, tick, settle } = setup();
  svc.set(true);
  manager.tabs.delete('a');
  advance(46 * MIN); tick(); await settle();
  assert.deepEqual([calls.pings.length, calls.notes.length, svc.isKept('a')], [0, 0, false]);
});

test('a tab that warms up after it went on is kept from then on', () => {
  const b = fakeTab('b', { cache: null });
  const { svc, tick } = setup({ tabs: [fakeTab('a'), b] });
  svc.set(true);
  assert.equal(svc.isKept('b'), false);
  b.session.cache = { at: T0, ttlMs: HOUR };
  tick();
  assert.equal(svc.isKept('b'), true);
});

test('when it stops, each tab it was still keeping counts as just used, so idle stop spares it', () => {
  for (const off of [svc => svc.userSent(), svc => { svc.reading({ idleMs: 3 * MIN }); svc.reading({ idleMs: 0 }); }, svc => svc.set(false)]) {
    const b = fakeTab('b');
    const { svc, calls, tick } = setup({ tabs: [fakeTab('a'), b] });
    svc.set(true);
    b.session.proc = null; // dropped: back to the normal rule
    tick();
    assert.equal(svc.isKept('b'), false);
    off(svc);
    assert.equal(svc.view().on, false);
    assert.deepEqual(calls.touched, ['a']);
  }
});

test('with nothing left to keep warm it turns itself off, and lets the PC sleep', () => {
  const a = fakeTab('a');
  const { svc, calls, tick, ticking } = setup({ tabs: [a] });
  svc.set(true);
  a.session.proc = null;
  tick();
  assert.equal(calls.notes.at(-1).item.text, 'Stopped keeping warm: its Claude Code process ended', 'the drop is said first');
  assert.equal(svc.view().on, false);
  assert.deepEqual(calls.blocker.at(-1), ['stop', 7]);
  assert.equal(ticking(), false);
});

test('with nothing kept but a tab still working, it stays on: that tab may warm up yet', () => {
  const a = fakeTab('a');
  const b = fakeTab('b', { cache: null, busy: true }); // its first turn: no cache yet
  const { svc, tick } = setup({ tabs: [a, b] });
  svc.set(true);
  a.session.proc = null;
  tick();
  assert.equal(svc.isKept('a'), false);
  assert.equal(svc.view().on, true);
  b.session.busy = false;
  b.session.pending = new Map([['r1', {}]]); // waiting on you counts too
  tick();
  assert.equal(svc.view().on, true);
  b.session.pending = new Map();
  tick();
  assert.equal(svc.view().on, false);
});

test('three hours after it went on, it stops', () => {
  const { svc, calls, advance, tick } = setup();
  svc.set(true);
  advance(3 * HOUR); tick();
  assert.equal(svc.view().on, false);
  assert.deepEqual(calls.blocker.at(-1), ['stop', 7]);
});

test("coming back after stepping away turns it off; staying at the keyboard doesn't", () => {
  const { svc } = setup();
  svc.set(true);
  svc.reading({ idleMs: 0 });
  assert.equal(svc.view().on, true);
  svc.reading({ idleMs: 3 * MIN });
  assert.equal(svc.view().on, true);
  svc.reading({ idleMs: 10 * 1000 });
  assert.equal(svc.view().on, false);
});

test('a message you send turns it off', () => {
  const { svc } = setup();
  svc.set(true);
  svc.userSent();
  assert.equal(svc.view().on, false);
  svc.userSent(); // already off: nothing happens
  assert.equal(svc.view().on, false);
});

test('due tabs are pinged one at a time, and none twice in a row', async () => {
  let open = 0;
  let most = 0;
  const { svc, manager, calls, advance, tick, settle } = setup({ tabs: [fakeTab('a'), fakeTab('b'), fakeTab('c')] });
  manager.ping = async id => {
    open++; most = Math.max(most, open);
    calls.pings.push({ id });
    await new Promise(r => setImmediate(r));
    open--;
    return WARM;
  };
  svc.set(true);
  advance(46 * MIN); tick();
  for (let i = 0; i < 12; i++) await settle();
  assert.deepEqual(calls.pings.map(p => p.id), ['a', 'b', 'c']);
  assert.equal(most, 1);
  tick(); await settle();
  assert.equal(calls.pings.length, 3, 'a cache just read is not pinged again');
});

test('the panel hears each change, with a line for every tab', () => {
  const b = fakeTab('b', { cache: { at: T0, ttlMs: 5 * MIN } });
  const { svc, calls } = setup({ tabs: [fakeTab('a'), b] });
  svc.set(true);
  const last = calls.sent.filter(s => s.channel === 'keepwarm').at(-1).payload;
  assert.equal(last.on, true);
  assert.equal(last.endsAt, T0 + 3 * HOUR);
  assert.deepEqual(last.tabs, [
    { id: 'a', title: 'A', line: `next ping ${kw.hhmm(T0 + 45 * MIN)}` },
    { id: 'b', title: 'B', line: 'its cache only lasts 5 minutes' },
  ]);
  svc.set(false);
  assert.deepEqual(calls.sent.at(-1), { channel: 'keepwarm', payload: { on: false, endsAt: null, tabs: [] } });
});

test('a ping that never answers is interrupted after the lead time, then the tab is dropped and the next one goes', async () => {
  // a is due at T0 + 35 min; b (a longer-lived cache) is due at T0 + 41 min, while a's ping is still out.
  const a = fakeTab('a', { cache: { at: T0 - 20 * MIN, ttlMs: HOUR } });
  const b = fakeTab('b', { cache: { at: T0 - 20 * MIN, ttlMs: HOUR + 6 * MIN } });
  const { svc, manager, calls, advance, tick, settle, timeouts } = setup({ tabs: [a, b] });
  let release = null;
  manager.ping = id => {
    calls.pings.push({ id });
    manager.tabs.get(id).session.busy = true;
    return new Promise(r => { release = r; });
  };
  manager.interrupt = id => {
    calls.interrupted.push(id);
    manager.tabs.get(id).session.busy = false;
    release({ ok: false, error: null, denied: false, tokens: null });
  };
  svc.set(true);
  advance(36 * MIN); tick(); await settle();
  assert.deepEqual(calls.pings.map(p => p.id), ['a']);
  advance(5 * MIN); tick(); await settle();
  assert.deepEqual(calls.pings.map(p => p.id), ['a'], 'b is due, but one at a time: it waits behind the stuck ping');
  const fuse = timeouts().find(h => h.live);
  assert.equal(fuse.ms, kw.LEAD_MS);
  assert.deepEqual(calls.interrupted, []);
  advance(1);
  fuse.fn();
  assert.deepEqual(calls.interrupted, ['a']);
  await settle();
  const note = calls.notes.find(n => n.id === 'a');
  assert.equal(note.item.text, 'Stopped keeping warm: the ping got no reply');
  assert.equal(note.item.endsTurn, true);
  assert.equal(calls.notes.at(-1).id, 'a', 'the last line is the drop');
  assert.equal(svc.isKept('a'), false);
  assert.deepEqual(calls.pings.map(p => p.id), ['a', 'b'], 'the next due tab now gets its ping');
});

test('a ping that answers in time clears its fuse and never interrupts', async () => {
  const { svc, calls, advance, tick, settle, timeouts } = setup();
  svc.set(true);
  advance(46 * MIN); tick(); await settle();
  assert.equal(calls.pings.length, 1);
  assert.equal(timeouts().length, 1, 'one fuse was set');
  assert.equal(timeouts().filter(h => h.live).length, 0, 'and cleared');
  assert.deepEqual(calls.interrupted, []);
});

test('a tab closed while its ping is out leaves with no line, and the next due tab goes', async () => {
  const { svc, manager, calls, advance, tick, settle, timeouts } = setup({ tabs: [fakeTab('a'), fakeTab('b')] });
  let release = null;
  manager.ping = id => { calls.pings.push({ id }); return new Promise(r => { if (id === 'a') release = r; else r(WARM); }); };
  svc.set(true);
  advance(46 * MIN); tick(); await settle();
  assert.deepEqual(calls.pings.map(p => p.id), ['a']);
  manager.tabs.delete('a'); // the manager settles a ping of a closed tab with this
  release({ ok: false, error: 'the conversation was closed', tokens: null, denied: false });
  for (let i = 0; i < 5; i++) await settle();
  assert.equal(calls.notes.some(n => n.id === 'a'), false, 'no line for a closed tab');
  assert.deepEqual(calls.pings.map(p => p.id), ['a', 'b'], 'the next due tab gets its ping');
  assert.equal(timeouts().filter(h => h.live).length, 0, 'every fuse is cleared');
});
