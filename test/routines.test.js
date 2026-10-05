const { test } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');

const { nextRun, previousRun, dueRoutines, missedOnStartup, validateRoutine, describeSchedule, Scheduler } = require('../src/main/routines');

// All dates are local wall-clock so the tests pass in any timezone.
// Wed 30 Sep 2026; Fri 2 Oct 2026.
const at = (d, h = 0, m = 0, mon = 9, y = 2026) => new Date(y, mon, d, h, m).getTime();
const H = 3600000;
const CREATED = at(1, 8); // Thu 1 Oct 08:00

const make = (schedule, extra = {}) => ({
  id: 'r1', name: 'Tidy', prompt: 'tidy', cwd: null, mode: 'smart', schedule,
  enabled: true, catchUp: true, createdAt: CREATED, lastRunAt: null, lastStatus: null, ...extra,
});
const daily = make({ type: 'daily', time: '09:00' });
const fridays = make({ type: 'weekly', time: '17:00', days: [5] });

// ---- nextRun
test('nextRun daily: before, after, and exactly at the time', () => {
  assert.equal(nextRun(daily, at(2, 8)), at(2, 9));
  assert.equal(nextRun(daily, at(2, 10)), at(3, 9));
  assert.equal(nextRun(daily, at(2, 9)), at(3, 9)); // strictly after
});
test('nextRun daily wraps across month and year ends', () => {
  assert.equal(nextRun(daily, at(31, 12, 0, 11)), new Date(2027, 0, 1, 9, 0).getTime());
});
test('nextRun weekly: right weekday, wraps to next week, multiple days', () => {
  assert.equal(nextRun(fridays, at(1, 12)), at(2, 17));       // Thu -> Fri
  assert.equal(nextRun(fridays, at(2, 17)), at(9, 17));       // exactly at -> next Fri
  assert.equal(nextRun(fridays, at(3, 9)), at(9, 17));        // Sat -> next Fri
  const mwf = make({ type: 'weekly', time: '17:00', days: [1, 3, 5] });
  assert.equal(nextRun(mwf, at(2, 18)), at(5, 17));           // Fri eve -> Mon
  assert.equal(nextRun(mwf, at(5, 18)), at(7, 17));           // Mon eve -> Wed
});
test('nextRun interval is anchored on createdAt and strictly after', () => {
  const r = make({ type: 'interval', everyHours: 4 });
  assert.equal(nextRun(r, CREATED - H), CREATED + 4 * H);
  assert.equal(nextRun(r, CREATED), CREATED + 4 * H);
  assert.equal(nextRun(r, CREATED + 4 * H), CREATED + 8 * H);
  assert.equal(nextRun(r, CREATED + 5 * H), CREATED + 8 * H);
});
test('nextRun: disabled or invalid -> null', () => {
  assert.equal(nextRun({ ...daily, enabled: false }, at(2)), null);
  assert.equal(nextRun(make({ type: 'daily', time: '25:00' }), at(2)), null);
  assert.equal(nextRun(make({ type: 'weekly', time: '09:00', days: [] }), at(2)), null);
  assert.equal(nextRun(make({ type: 'interval', everyHours: 0 }), at(2)), null);
  assert.equal(nextRun(make({ type: 'cron' }), at(2)), null);
  assert.equal(nextRun(null, at(2)), null);
  assert.equal(nextRun(daily, NaN), null);
});

// ---- previousRun
test('previousRun daily: before, after, exactly at', () => {
  assert.equal(previousRun(daily, at(2, 8)), at(1, 9));
  assert.equal(previousRun(daily, at(2, 10)), at(2, 9));
  assert.equal(previousRun(daily, at(2, 9)), at(2, 9)); // inclusive
});
test('previousRun weekly wraps back to last week', () => {
  assert.equal(previousRun(fridays, at(2, 16)), at(25, 17, 0, 8)); // Fri 25 Sep
  assert.equal(previousRun(fridays, at(8, 12)), at(2, 17));
});
test('previousRun interval needs at least one full interval since createdAt', () => {
  const r = make({ type: 'interval', everyHours: 4 });
  assert.equal(previousRun(r, CREATED + 3 * H), null);
  assert.equal(previousRun(r, CREATED + 4 * H), CREATED + 4 * H);
  assert.equal(previousRun(r, CREATED + 11 * H), CREATED + 8 * H);
  assert.equal(previousRun({ ...r, enabled: false }, CREATED + 11 * H), null);
});

// ---- dueRoutines
test('dueRoutines: exclusive start, inclusive end, skips disabled', () => {
  const off = { ...daily, id: 'off', enabled: false };
  assert.deepEqual(dueRoutines([daily, off], at(2, 8), at(2, 9)).map(r => r.id), ['r1']);
  assert.deepEqual(dueRoutines([daily], at(2, 9), at(2, 10)), []);
  assert.deepEqual(dueRoutines([daily], at(2, 8), at(2, 8, 59)), []);
  assert.deepEqual(dueRoutines(null, 0, 1), []);
});

// ---- missedOnStartup
test('missedOnStartup: missed within window, already ran, outside window, catchUp off', () => {
  const now = at(2, 12);
  assert.equal(missedOnStartup(daily, now), true);
  assert.equal(missedOnStartup({ ...daily, lastRunAt: at(2, 9, 1) }, now), false);
  assert.equal(missedOnStartup(daily, at(2, 22)), false); // 13h after the slot
  assert.equal(missedOnStartup(daily, at(2, 22), 14 * H), true);
  assert.equal(missedOnStartup({ ...daily, catchUp: false }, now), false);
  assert.equal(missedOnStartup({ ...daily, enabled: false }, now), false);
  // a slot before the routine even existed is not "missed"
  assert.equal(missedOnStartup({ ...daily, createdAt: at(2, 10) }, now), false);
});

// ---- validateRoutine
const good = () => ({ name: '  Tidy   downloads ', prompt: '  clean up  ', schedule: { type: 'weekly', time: '7:05', days: [5, 1] } });

test('validateRoutine normalises good input and fills defaults', () => {
  const before = Date.now();
  const { routine, errors } = validateRoutine(good());
  assert.deepEqual(errors, []);
  assert.match(routine.id, /^[\w-]{1,64}$/);
  assert.ok(routine.createdAt >= before);
  assert.equal(routine.name, 'Tidy downloads');
  assert.equal(routine.prompt, 'clean up');
  assert.deepEqual(routine.schedule, { type: 'weekly', time: '07:05', days: [1, 5] });
  assert.equal(routine.mode, 'smart');
  assert.equal(routine.cwd, null);
  assert.equal(routine.enabled, true);
  assert.equal(routine.catchUp, true);
  assert.equal(routine.lastRunAt, null);
  assert.equal(routine.lastStatus, null);
});
test('validateRoutine runs on the usual model unless it names one Shellby offers', () => {
  assert.equal(validateRoutine(good()).routine.model, '');
  assert.equal(validateRoutine({ ...good(), model: null }).routine.model, '');
  assert.equal(validateRoutine({ ...good(), model: 'sonnet' }).routine.model, 'sonnet');
  assert.equal(validateRoutine({ ...good(), model: 'claude-haiku-4-5' }).routine.model, 'claude-haiku-4-5');
});
test('validateRoutine refuses a model Shellby doesn\'t offer', () => {
  for (const model of ['gpt-5', 'opus --dangerously-skip-permissions', 42, {}]) {
    const res = validateRoutine({ ...good(), model });
    assert.equal(res.routine, null, String(model));
    assert.ok(res.errors.includes('Unknown model'));
  }
});
test('validateRoutine keeps valid id, createdAt, lastRunAt, lastStatus; drops junk fields', () => {
  const cwd = path.resolve(os.tmpdir());
  const { routine } = validateRoutine({ ...good(), id: 'abc-1', createdAt: 5, lastRunAt: 10, lastStatus: 'ok', cwd, evil: 1,
    schedule: { type: 'daily', time: '09:00', extra: 1 } });
  assert.equal(routine.id, 'abc-1');
  assert.equal(routine.createdAt, 5);
  assert.equal(routine.lastRunAt, 10);
  assert.equal(routine.lastStatus, 'ok');
  assert.equal(routine.cwd, cwd);
  assert.equal(routine.evil, undefined);
  assert.deepEqual(routine.schedule, { type: 'daily', time: '09:00' });
  const { routine: r2 } = validateRoutine({ ...good(), lastRunAt: 'x', lastStatus: 'weird' });
  assert.equal(r2.lastRunAt, null);
  assert.equal(r2.lastStatus, null);
});
test('validateRoutine rejects bad input with readable errors', () => {
  const bad = patch => {
    const res = validateRoutine({ ...good(), ...patch });
    assert.equal(res.routine, null, JSON.stringify(patch));
    assert.ok(res.errors.length > 0);
    return res.errors;
  };
  bad({ schedule: { type: 'daily', time: '24:00' } });
  bad({ schedule: { type: 'daily', time: '12:60' } });
  bad({ schedule: { type: 'daily', time: 'noon' } });
  bad({ prompt: '   ' });
  bad({ prompt: 'x'.repeat(8001) });
  bad({ schedule: { type: 'weekly', time: '09:00', days: [] } });
  bad({ schedule: { type: 'weekly', time: '09:00', days: [7] } });
  bad({ schedule: { type: 'weekly', time: '09:00', days: [1, 1] } });
  bad({ schedule: { type: 'weekly', time: '09:00', days: [0, 1, 2, 3, 4, 5, 6, 0] } });
  bad({ schedule: { type: 'interval', everyHours: 0 } });
  bad({ schedule: { type: 'interval', everyHours: 169 } });
  bad({ schedule: { type: 'interval', everyHours: 1.5 } });
  bad({ schedule: null });
  bad({ name: 'x'.repeat(61) });
  bad({ name: '' });
  bad({ mode: 'yolo' });
  bad({ id: '..\\..\\evil' });
  bad({ id: 'x'.repeat(65) });
  bad({ cwd: 'relative\\dir' });
  bad({ enabled: 'yes' });
  assert.deepEqual(validateRoutine('nope').errors, ['Routine must be an object']);
  assert.ok(bad({ mode: 'autonomous' }).some(e => /autonomous/i.test(e)));
});
test('validateRoutine: autonomous only when allowed; long name trimmed to fit is fine', () => {
  assert.equal(validateRoutine({ ...good(), mode: 'autonomous' }, { allowAutonomous: true }).routine.mode, 'autonomous');
  const { routine } = validateRoutine({ ...good(), name: `   ${'x'.repeat(60)}   ` });
  assert.equal(routine.name.length, 60);
  assert.equal(validateRoutine({ ...good(), schedule: { type: 'interval', everyHours: 168 } }).routine.schedule.everyHours, 168);
});

// ---- describeSchedule
test('describeSchedule formats every schedule shape', () => {
  assert.equal(describeSchedule({ type: 'daily', time: '09:00' }), 'Every day at 9:00 AM');
  assert.equal(describeSchedule({ type: 'daily', time: '00:05' }), 'Every day at 12:05 AM');
  assert.equal(describeSchedule({ type: 'daily', time: '12:00' }), 'Every day at 12:00 PM');
  assert.equal(describeSchedule({ type: 'weekly', time: '18:30', days: [1, 2, 3, 4, 5] }), 'Weekdays at 6:30 PM');
  assert.equal(describeSchedule({ type: 'weekly', time: '10:00', days: [6, 0] }), 'Weekends at 10:00 AM');
  assert.equal(describeSchedule({ type: 'weekly', time: '17:00', days: [5, 1, 3] }), 'Mon, Wed, Fri at 5:00 PM');
  assert.equal(describeSchedule({ type: 'weekly', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6] }), 'Every day at 8:00 AM');
  assert.equal(describeSchedule({ type: 'interval', everyHours: 1 }), 'Every hour');
  assert.equal(describeSchedule({ type: 'interval', everyHours: 4 }), 'Every 4 hours');
  assert.equal(describeSchedule({ type: 'bogus' }), 'Invalid schedule');
});

// ---- Scheduler
function harness(routines, start) {
  let t = start;
  const s = new Scheduler({ getRoutines: () => routines, now: () => t });
  const fired = [];
  s.on('due', r => fired.push([r.id, t]));
  return { s, fired, set: v => { t = v; } };
}

test('Scheduler: first tick fires nothing for past slots, then once per slot', () => {
  const { s, fired, set } = harness([daily], at(2, 12)); // 9:00 slot already passed
  s.tick();
  assert.equal(fired.length, 0);
  set(at(3, 8, 59)); s.tick();
  assert.equal(fired.length, 0);
  set(at(3, 9, 0)); s.tick();
  set(at(3, 9, 0)); s.tick();
  set(at(3, 9, 1)); s.tick();
  assert.deepEqual(fired.map(f => f[0]), ['r1']);
  set(at(4, 9, 1)); s.tick();
  assert.equal(fired.length, 2);
});
test('Scheduler: clock jumping back never re-fires a slot', () => {
  const { s, fired, set } = harness([daily], at(3, 8, 59));
  s.tick();
  set(at(3, 9, 1)); s.tick();
  set(at(3, 8, 30)); s.tick(); // clock went back
  set(at(3, 9, 5)); s.tick();
  assert.equal(fired.length, 1);
});
test('Scheduler: a big forward jump (sleep) fires once, for the latest slot', () => {
  const hourly = make({ type: 'interval', everyHours: 1 }, { id: 'h' });
  const { s, fired, set } = harness([daily, hourly], at(2, 8));
  s.tick();
  set(at(5, 10)); s.tick(); // three days asleep
  assert.deepEqual(fired.map(f => f[0]).sort(), ['h', 'r1']);
  set(at(5, 10, 1)); s.tick();
  assert.equal(fired.length, 2);
});
test('Scheduler: disabled routines never fire; getRoutines throwing is survived', () => {
  const s1 = harness([{ ...daily, enabled: false }], at(2, 8));
  s1.s.tick(); s1.set(at(2, 10)); s1.s.tick();
  assert.equal(s1.fired.length, 0);
  let boom = true;
  const s2 = new Scheduler({ getRoutines: () => { if (boom) throw new Error('x'); return []; }, now: () => 0 });
  assert.doesNotThrow(() => { s2.tick(); s2.tick(); });
  boom = false;
});
test('Scheduler: start() ticks soon, stop() clears timers', async () => {
  let calls = 0;
  const s = new Scheduler({ getRoutines: () => { calls++; return []; }, tickMs: 60000, now: () => at(2, 8) });
  s.start();
  s.start(); // idempotent
  assert.ok(s.timer);
  await new Promise(r => setImmediate(r));
  s.tick(); // baseline set by the immediate tick, so this one reads routines
  assert.ok(calls >= 1);
  s.stop();
  assert.equal(s.timer, null);
  assert.equal(s.immediate, null);
  assert.throws(() => new Scheduler({}), /getRoutines/);
});

test('a routine can name MCP servers it may use without asking', () => {
  const base = { name: 'Digest', prompt: 'post it', schedule: { type: 'daily', time: '17:00' } };
  const { routine } = validateRoutine({ ...base, mcp: ['slack', 'slack', 'linear'], mcpOnly: true });
  assert.deepEqual(routine.mcp, ['slack', 'linear']);
  assert.equal(routine.mcpOnly, true);
  // None named: neither field is kept, so an old routine looks exactly as it did.
  const none = validateRoutine({ ...base, mcp: [], mcpOnly: true }).routine;
  assert.equal('mcp' in none, false);
  assert.equal('mcpOnly' in none, false);
  assert.match(validateRoutine({ ...base, mcp: ['bad name'] }).errors[0], /isn't an MCP server name/);
});
