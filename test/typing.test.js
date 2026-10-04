const { test } = require('node:test');
const assert = require('node:assert/strict');
const { step, burstLine, createTyping, emptyRhythm, BURST_MS, STOPPED_MS, TICK_MS } = require('../src/main/typing');

// Keys let go every `gapMs` from `from` for `ms`, run through step(). -> the last result and every result.
function type(state, from, ms, gapMs) {
  let r = { state };
  const all = [];
  for (let t = from; t <= from + ms; t += gapMs) { r = step(r.state, t, { key: true }); all.push(r); }
  return { last: r, all };
}

// ---------------------------------------------------------------- the rhythm

test('no keys at all is no typing', () => {
  const r = step(emptyRhythm(), 1000);
  assert.equal(r.level, 'none');
  assert.equal(r.wpm, 0);
  assert.equal(r.burst, null);
});

test('steady unhurried typing reads as typing, not fast', () => {
  const { last } = type(emptyRhythm(), 0, 3000, 250); // 4 keys a second, ~48 wpm
  assert.equal(last.level, 'typing');
  assert.ok(last.wpm > 35 && last.wpm < 60, `wpm ${last.wpm}`);
});

test('two quick keys are not mistaken for a 200 wpm typist', () => {
  let r = step(emptyRhythm(), 0, { key: true });
  r = step(r.state, 80, { key: true });
  assert.equal(r.level, 'typing');
  assert.ok(r.wpm <= 24, `wpm ${r.wpm}`);
});

test('fast typing reads as fast', () => {
  const { last } = type(emptyRhythm(), 0, 3000, 100); // 10 keys a second, ~120 wpm
  assert.equal(last.level, 'fast');
  assert.ok(last.wpm >= 100, `wpm ${last.wpm}`);
});

test('stopping for a moment ends typing', () => {
  const { last } = type(emptyRhythm(), 0, 2000, 200);
  const r = step(last.state, 2000 + STOPPED_MS + 1);
  assert.equal(r.level, 'none');
});

test('a burst starts after BURST_MS of fast typing, and only once', () => {
  const { all } = type(emptyRhythm(), 0, BURST_MS + 2000, 100);
  const starts = all.filter(r => r.burst === 'start');
  assert.equal(starts.length, 1);
  const startAt = all.indexOf(starts[0]) * 100;
  assert.ok(startAt >= BURST_MS && startAt < BURST_MS + 3000, `started at ${startAt}`);
  assert.ok(all[all.length - 1].state.bursting);
});

test('slowing down mid-burst keeps it going; stopping ends it with the peak', () => {
  const fast = type(emptyRhythm(), 0, BURST_MS + 3000, 100).last;
  assert.ok(fast.state.bursting);
  const slow = type(fast.state, BURST_MS + 3300, 3000, 300).last; // ~40 wpm
  assert.equal(slow.level, 'typing');
  assert.ok(slow.state.bursting, 'still bursting while you slow down');
  const end = step(slow.state, BURST_MS + 3300 + 3000 + STOPPED_MS + 10);
  assert.equal(end.burst, 'end');
  assert.ok(end.peak >= 100, `peak ${end.peak}`);
  assert.equal(end.state.bursting, false);
  // ...and the next beat starts clean.
  assert.equal(step(end.state, BURST_MS + 9000).state.peak, 0);
});

test('a short sprint that never lasts BURST_MS is not a burst', () => {
  const sprint = type(emptyRhythm(), 0, BURST_MS - 2000, 100).last;
  const r = step(sprint.state, BURST_MS - 2000 + STOPPED_MS + 10);
  assert.equal(r.burst, null);
});

test('the rhythm never keeps more than a window of keys', () => {
  const { last } = type(emptyRhythm(), 0, 20000, 50);
  assert.ok(last.state.keys.length <= 64);
});

// ---------------------------------------------------------------- what he says

test('a burst line: the wpm, or a record once there is one to beat', () => {
  assert.deepEqual(burstLine(95, 0), { occasion: 'typingBurst', text: '95 wpm!' });
  assert.deepEqual(burstLine(95, 120), { occasion: 'typingBurst', text: '95 wpm!' });
  assert.deepEqual(burstLine(130, 120), { occasion: 'typingRecord', text: 'new record: 130 wpm!' });
  assert.equal(burstLine(0, 0), null);
  // Fits his bubble even at a silly speed.
  assert.ok(burstLine(999, 1).text.length <= 24);
});

// ---------------------------------------------------------------- the controller

function harness({ eligible = true, watchOk = true, settings = { enabled: true, remarks: true }, best = 0 } = {}) {
  const clock = { t: 0 };
  const sent = [];
  const said = [];
  const store = { best, settings };
  let onKey = null;
  let stopped = 0;
  let tickFn = null;
  const typing = createTyping({
    now: () => clock.t,
    rand: () => 0,
    every: fn => { tickFn = fn; return 1; },
    stopEvery: () => { tickFn = null; },
    watch: cb => { if (!watchOk) return null; onKey = cb; return () => { stopped++; }; },
    settings: () => store.settings,
    eligible: () => eligible,
    toCrab: (channel, payload) => sent.push({ channel, ...payload }),
    speak: (occasion, opts) => said.push({ occasion, ...opts }),
    best: () => store.best,
    setBest: wpm => { store.best = wpm; },
  });
  // Keys every gapMs, with his beat running alongside every TICK_MS as the real timer would.
  let sinceBeat = 0;
  const press = (n, gapMs) => {
    for (let i = 0; i < n; i++) {
      clock.t += gapMs;
      onKey();
      sinceBeat += gapMs;
      if (sinceBeat >= TICK_MS) { sinceBeat = 0; tickFn?.(); }
    }
  };
  const tick = ms => { clock.t += ms; tickFn?.(); };
  return { typing, clock, sent, said, store, press, tick, ticking: () => !!tickFn, stops: () => stopped };
}

test('he taps along once he can hear the keyboard', () => {
  const h = harness();
  h.typing.start();
  h.press(3, 250);
  assert.ok(h.sent.every(m => m.channel === 'critter:typing'));
  assert.equal(h.sent.filter(m => m.tap).length, 3);
  assert.equal(h.sent[h.sent.length - 1].level, 'typing');
  h.typing.stop();
});

test('busy with something else, he shows nothing', () => {
  const h = harness({ eligible: false });
  h.typing.start();
  h.press(5, 100);
  assert.ok(h.sent.every(m => m.level === 'none' && !m.tap && !m.impressed));
  h.typing.stop();
});

test("his window gets taps on a steady beat, never each key's own timing", () => {
  const h = harness();
  h.typing.start();
  h.press(4, 10); // four keys inside one beat
  assert.equal(h.sent.filter(m => m.tap).length, 0, 'nothing goes over between beats');
  h.tick(TICK_MS);
  assert.equal(h.sent.filter(m => m.tap).length, 1, 'one tap on the beat');
  // A payload says nothing but the level, the look and whether to tap.
  for (const m of h.sent) assert.deepEqual(Object.keys(m).sort(), ['channel', 'impressed', 'level', 'tap']);
  h.typing.stop();
});

test('a burst he could not see (busy, on a call) is not remarked or recorded', () => {
  const h = harness({ best: 40 });
  // Its own controller: the harness's clock and store, but never free to tap along.
  const typing = createTyping({
    now: () => h.clock.t, rand: () => 0,
    every: fn => { h.tickFn = fn; return 1; }, stopEvery: () => { h.tickFn = null; },
    watch: cb => { h.onKey = cb; return () => {}; },
    settings: () => ({ enabled: true, remarks: true }),
    eligible: () => false,
    toCrab: () => {}, speak: (o, opts) => h.said.push({ o, ...opts }),
    best: () => h.store.best, setBest: w => { h.store.best = w; },
  });
  typing.start();
  for (let i = 0; i < 90; i++) { h.clock.t += 100; h.onKey(); if (i % 2) h.tickFn?.(); }
  h.clock.t += STOPPED_MS + 200; h.tickFn?.();
  assert.equal(h.said.length, 0);
  assert.equal(h.store.best, 40);
});

test('after his window reloads, what he is doing is sent again', () => {
  const h = harness();
  h.typing.start();
  h.press(3, 200);
  const before = h.sent.length;
  h.typing.resend();
  h.tick(TICK_MS); // no key this beat: only the resend
  assert.equal(h.sent.length, before + 1);
  assert.equal(h.sent[h.sent.length - 1].level, 'typing');
  h.typing.stop();
});

test('switched off, he never listens; switched back on, he does', () => {
  const h = harness({ settings: { enabled: false, remarks: true } });
  h.typing.start();
  assert.equal(h.typing.view().listening, false);
  h.store.settings = { enabled: true, remarks: true };
  h.typing.sync();
  assert.equal(h.typing.view().listening, true);
  h.store.settings = { enabled: false, remarks: true };
  h.typing.sync();
  assert.equal(h.typing.view().listening, false);
  assert.equal(h.stops(), 1);
});

test('active while he is tapping along, so his idle habits wait', () => {
  const h = harness();
  h.typing.start();
  assert.equal(h.typing.active(), false);
  h.press(3, 200);
  assert.equal(h.typing.active(), true);
  h.tick(STOPPED_MS + 100);
  assert.equal(h.typing.active(), false);
  // Busy elsewhere, he isn't tapping, so nothing should wait for him.
  const busy = harness({ eligible: false });
  busy.typing.start();
  busy.press(3, 200);
  assert.equal(busy.typing.active(), false);
});

test('switching off mid-typing puts the keyboard away', () => {
  const h = harness();
  h.typing.start();
  h.press(3, 200);
  assert.equal(h.sent[h.sent.length - 1].level, 'typing');
  h.store.settings = { enabled: false, remarks: true };
  h.typing.sync();
  assert.equal(h.sent[h.sent.length - 1].level, 'none');
  assert.equal(h.ticking(), false);
});

test("a keyboard he can't hear is reported, not thrown", () => {
  const h = harness({ watchOk: false });
  h.typing.start();
  assert.equal(h.typing.view().available, false);
});

test('a burst: impressed while it lasts, then the wpm, then quiet', () => {
  const h = harness({ best: 0 });
  h.typing.start();
  h.press(Math.ceil((BURST_MS + 2000) / 100), 100); // ~120 wpm for long enough
  assert.ok(h.sent.some(m => m.impressed), 'impressed during the burst');
  h.tick(STOPPED_MS + 300);
  assert.equal(h.sent[h.sent.length - 1].level, 'none');
  assert.equal(h.sent[h.sent.length - 1].impressed, false);
  assert.equal(h.said.length, 1);
  assert.equal(h.said[0].occasion, 'typingBurst');
  assert.match(h.said[0].text, /^\d+ wpm!$/);
  assert.ok(h.store.best >= 100, `best ${h.store.best}`);
  assert.equal(h.ticking(), false, 'no timer left running once you stop');
});

test('beating your best is a record; remarks off keeps the record but says nothing', () => {
  const h = harness({ best: 60 });
  h.typing.start();
  h.press(Math.ceil((BURST_MS + 2000) / 100), 100);
  h.tick(STOPPED_MS + 300);
  assert.equal(h.said[0].occasion, 'typingRecord');
  assert.match(h.said[0].text, /^new record: \d+ wpm!$/);

  const quiet = harness({ best: 60, settings: { enabled: true, remarks: false } });
  quiet.typing.start();
  quiet.press(Math.ceil((BURST_MS + 2000) / 100), 100);
  quiet.tick(STOPPED_MS + 300);
  assert.equal(quiet.said.length, 0);
  assert.ok(quiet.store.best > 60);
});
