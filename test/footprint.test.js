const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readMetrics, footprintBetween, describe, isHeavy, pct, size, FootprintTracker, HEAVY } = require('../src/main/health/footprint');
const { HealthService } = require('../src/main/health/service');

const MB = 1024 * 1024;
// One app.getAppMetrics() entry: cpu seconds so far, working set in MB.
const metric = (pid, cpuSeconds, mb, { type = 'Tab', created = 1000, percent = 0 } = {}) => ({
  pid, type, creationTime: created,
  cpu: { percentCPUUsage: percent, cumulativeCPUUsage: cpuSeconds, idleWakeupsPerSecond: 0 },
  memory: { workingSetSize: mb * 1024, peakWorkingSetSize: mb * 1024 },
});

test('readMetrics keys by pid and creation time, and skips junk', () => {
  const m = readMetrics([metric(10, 1.5, 100), metric(10, 0.1, 20, { created: 5000 }), { pid: 'x' }, null]);
  assert.equal(m.size, 2, 'a reused pid is a different process');
  assert.deepEqual(m.get('10:1000'), { pid: 10, type: 'Tab', created: 1000, cpuSeconds: 1.5, percent: 0, bytes: 100 * MB });
  assert.equal(readMetrics(undefined).size, 0);
});

test('footprintBetween turns cpu seconds into a share of one core and of the machine', () => {
  const before = readMetrics([metric(1, 10, 200, { type: 'Browser' }), metric(2, 4, 150)]);
  const after = readMetrics([metric(1, 10.5, 210, { type: 'Browser' }), metric(2, 4.3, 150)]);
  const fp = footprintBetween(before, after, { prevAt: 0, at: 10000, cores: 8 });
  assert.equal(fp.cpuCore, 8, '0.8 s of CPU over 10 s is 8% of one core');
  assert.equal(fp.cpu, 1, '...and 1% of an 8-thread machine');
  assert.equal(fp.mem, 360 * MB);
  assert.equal(fp.procs, 2);
});

test('footprintBetween: a process born in the window counts all its time, an old stranger none', () => {
  const before = readMetrics([metric(1, 10, 100)]);
  const after = readMetrics([metric(1, 10, 100), metric(3, 0.5, 50, { created: 5000 }), metric(4, 99, 50, { created: 10 })]);
  const fp = footprintBetween(before, after, { prevAt: 1000, at: 11000, cores: 1 });
  assert.equal(fp.cpuCore, 5, 'only the newborn\'s 0.5 s counts');
  assert.equal(fp.mem, 200 * MB, 'memory counts everyone running now');
});

test('footprintBetween falls back to percentCPUUsage when there is no cumulative figure', () => {
  const old = m => ({ ...m, cpu: { percentCPUUsage: m.cpu.percentCPUUsage } });
  const fp = footprintBetween(new Map(), readMetrics([old(metric(1, 0, 10, { percent: 12 }))]), { prevAt: 0, at: 5000, cores: 4 });
  assert.equal(fp.cpuCore, 12);
  assert.equal(fp.cpu, 3);
});

test('pct and size read like the hogs list', () => {
  assert.equal(pct(0.42), '0.4%');
  assert.equal(pct(1), '1%');
  assert.equal(pct(12.6), '13%');
  assert.equal(pct(0), '0%');
  assert.equal(size(450 * MB), '450 MB');
  assert.equal(size(1.5 * 1024 * MB), '1.5 GB');
  assert.equal(size(0), '0 MB');
});

test('describe: the line in plain words, and no hint while he is light', () => {
  const d = describe({ cpu: 1, cpuCore: 8, mem: 450 * MB, procs: 6 });
  assert.equal(d.line, 'Shellby himself: 1% CPU, 450 MB');
  assert.match(d.detail, /6 processes/);
  assert.match(d.detail, /8% of one core/);
  assert.equal(d.heavy, false);
  assert.equal(d.hint, null);
  assert.equal(d.jump, null);
  assert.equal(describe(null), null);
});

test('describe: heavy on CPU points at the panel and Moving around, with this PC\'s closed figure', () => {
  const fp = { cpu: 9.4, cpuCore: 75, mem: 580 * MB, procs: 7 };
  const known = describe(fp, { whenClosed: 0.2 });
  assert.equal(known.heavy, true);
  assert.match(known.hint, /about 0\.2% on this PC/);
  assert.equal(known.jump, 'Moving around');
  assert.match(describe(fp).hint, /almost nothing/, 'no closed figure yet: no number made up');
  assert.match(describe(fp, { whenClosed: 20 }).hint, /almost nothing/, 'a closed figure that is no better is not quoted');
});

test('describe: heavy on memory alone says so, and points nowhere', () => {
  const d = describe({ cpu: 0.5, cpuCore: 4, mem: 1.2 * 1024 * MB, procs: 7 });
  assert.equal(d.heavy, true);
  assert.match(d.hint, /memory/);
  assert.equal(d.jump, null);
});

test('isHeavy uses the thresholds given', () => {
  assert.equal(isHeavy({ cpu: HEAVY.cpu, mem: 0 }), true);
  assert.equal(isHeavy({ cpu: 0, mem: HEAVY.mem - 1 }), false);
  assert.equal(isHeavy({ cpu: 2, mem: 0 }, { cpu: 1, mem: Infinity }), true);
  assert.equal(isHeavy(null), false);
});

test('FootprintTracker: nothing until two readings, then the figure, and a closed-panel average', () => {
  let now = 0;
  let open = false;
  let cpu = 0;
  const t = new FootprintTracker({ metrics: () => [metric(1, cpu, 400)], panelOpen: () => open, now: () => now, cores: 1 });
  assert.equal(t.sample(), null, 'one reading is no interval');
  now += 5000; cpu += 0.05;
  assert.equal(t.sample().cpu, 1, 'closed: 1%');
  now += 1000;
  assert.equal(t.sample().cpu, 1, 'too soon after the last: the same figure, no new interval');
  open = true;
  now += 4000; cpu += 3.75;
  const busy = t.sample();
  assert.equal(busy.cpu, 75, 'panel open: 75%');
  assert.match(busy.hint, /about 1% on this PC/, 'the closed figure comes from the closed interval only');
  now += 5000; cpu += 3.75;
  assert.equal(t.whenClosed(), 1, 'an interval with the panel open at either end is not "closed"');
});

test('FootprintTracker survives getAppMetrics throwing', () => {
  let now = 0;
  let fail = false;
  const t = new FootprintTracker({ metrics: () => { if (fail) throw new Error('gone'); return [metric(1, 0, 10)]; }, now: () => now, cores: 1 });
  t.sample(); now += 5000; t.sample();
  fail = true; now += 5000;
  assert.doesNotThrow(() => t.sample());
});

test('HealthService.view() carries his footprint only when given appMetrics', () => {
  const make = extra => new HealthService({
    config: { get: () => undefined, set() {} },
    send() {}, getPanel: () => null, stat() {}, onMood() {}, showHealth() {}, notify() {},
    startTask: () => ({ ok: true }), fakeScenario: 'calm', ...extra,
  });
  assert.equal(make().view().self, null);
  let cpu = 0;
  const svc = make({ appMetrics: () => [metric(1, (cpu += 0.1), 300)] });
  svc.footprint.now = (() => { let t = 0; return () => (t += 5000); })();
  svc.view();
  const self = svc.view().self;
  assert.equal(self.mem, 300 * MB);
  assert.match(self.line, /^Shellby himself: .+ CPU, 300 MB$/);
});
