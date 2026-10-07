// The Health screen's words and numbers (src/renderer/panel/health-logic.js):
// sizes, the hero, the gauges, the graphs, clutter, sensors, what's using the
// machine, startup and the alert log.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const L = require('../src/renderer/panel/health-logic');

const GB = 1024 ** 3;
const T = { gpuWarn: 80, cpuWarn: 85, storageWarn: 60, ramWarn: 90 };
const ok = () => ({ level: 'ok', pending: null });
const sample = (o = {}) => ({
  gpus: [{ name: 'NVIDIA GeForce RTX 4080', vendor: 'nvidia', temp: 61.4, hotspot: 70.2, load: 30, memUsed: 4096, memTotal: 16384, power: 120 }],
  cpu: { name: 'AMD Ryzen 9 7950X 16-Core Processor', temp: 55.6, load: 12, power: 65 },
  ram: { pct: 41.2, used: 13 * GB, total: 32 * GB },
  storage: [], fans: [], disks: [],
  ...o,
});

test('gb picks GB with one decimal under ten, whole GB from a hundred, and TB from a thousand', () => {
  assert.equal(L.gb(2.5 * GB), '2.5 GB');
  assert.equal(L.gb(42 * GB), '42 GB');
  assert.equal(L.gb(512 * GB), '512 GB');
  assert.equal(L.gb(2048 * GB), '2.0 TB');
  assert.equal(L.gb(undefined), '?');
});

test('fmt shows a dash for anything that is not a number', () => {
  assert.equal(L.fmt(41.26, 1), '41.3');
  assert.equal(L.fmt(41.26), '41');
  assert.equal(L.fmt(null), '—');
  assert.equal(L.fmt(NaN), '—');
});

test('heroWords says checks are off, then waits for a first reading', () => {
  assert.equal(L.heroWords({ settings: { enabled: false } }).title, 'Health checks are off');
  assert.deepEqual(L.heroWords(null), { eyebrow: 'Vitals', title: 'Taking a first reading…', sub: '', ask: null });
  assert.equal(L.heroWords({ settings: { enabled: true } }).title, 'Taking a first reading…');
});

test('heroWords is all calm with the headline numbers when nothing is wrong', () => {
  const w = L.heroWords({ settings: { enabled: true }, sample: sample() });
  assert.equal(w.title, 'All calm');
  assert.equal(w.sub, "GPU 61°C · CPU 56°C · memory 41%. Shellby's keeping an eye on things.");
  assert.equal(w.ask, null);
});

test('calmLine leaves out what is not reported', () => {
  assert.equal(L.calmLine({ gpus: [], cpu: {}, ram: null }), "Shellby's keeping an eye on things.");
});

test('heroWords words a mood from its check and offers to ask about it', () => {
  const view = {
    settings: { enabled: true }, sample: sample(), thresholds: T,
    mood: { id: 'gpu-temp:0', mood: 'scorching', level: 'critical' },
    checks: { 'gpu-temp:0': { reading: { value: 93.2, kind: 'gpu-temp', label: 'GPU' } } },
  };
  const w = L.heroWords(view);
  assert.equal(w.eyebrow, 'Needs attention');
  assert.equal(w.title, 'Overheating!');
  assert.equal(w.sub, "GPU is at 93°C, 13°C past your warning. Check what's using it.");
  assert.deepEqual(w.ask, { check: 'gpu-temp:0', text: 'Ask Shellby why' });
});

test('heroCopy names a hot drive by model and a full drive by letter', () => {
  const hot = L.heroCopy({ mood: 'hot' }, { value: 64, kind: 'storage-temp', label: 'Drive 1', model: 'Samsung 990' }, T);
  assert.equal(hot.line, 'Drive 1 (Samsung 990) is at 64°C, over your 60°C line. Shellby is fanning himself.');
  const full = L.heroCopy({ mood: 'stuffed' }, { value: 3.5, drive: 'C:' }, T);
  assert.deepEqual(full, { title: 'C: is filling up', line: 'Only 3.5 GB left. Junk is spilling out of his shell.', ask: 'Ask Shellby what to clean up' });
});

test('heroCopy tells developer clutter apart from a full drive', () => {
  const c = L.heroCopy({ mood: 'stuffed' }, { kind: 'reclaim', value: 40, sources: ['Docker', 'npm', 'pip', 'cargo'] }, T);
  assert.equal(c.title, '40 GB of developer clutter');
  assert.equal(c.line, 'Mostly Docker, npm, pip. Junk is spilling out of his shell.');
  assert.equal(c.ask, "Ask Shellby what's safe to clear");
});

test('gaugeSpecs lists GPU, CPU, memory and load cards with shortened names', () => {
  const specs = L.gaugeSpecs(sample(), T, ok);
  assert.deepEqual(specs.map(s => s.key), ['gpu-temp:0', 'cpu-temp', 'ram', 'cpu-load', 'gpu-load:0']);
  assert.equal(specs[0].sub, 'RTX 4080 · hotspot 70°');
  assert.equal(specs[1].sub, 'Ryzen 9 7950X · 65 W');
  assert.equal(specs[2].sub, '13 GB of 32 GB');
  assert.equal(specs[4].sub, 'VRAM 4.0 / 16 GB · 120 W');
  assert.deepEqual(specs[0].spark, { key: 'gpuT', min: 25, max: 100, warn: 80 });
});

test('gaugeSpecs sends you to set up CPU temperature when there is none, and copes with no GPU', () => {
  const specs = L.gaugeSpecs(sample({ gpus: [], cpu: { load: 3 } }), T, ok);
  assert.equal(specs[0].missing, 'No supported GPU found');
  assert.equal(specs.find(s => s.key === 'cpu-temp').missing, 'setup');
  assert.equal(specs.find(s => s.key === 'cpu-temp').spark, null);
  assert.ok(!specs.some(s => s.key.startsWith('gpu-load')));
});

test('gaugeSpecs numbers several GPUs and drives, and adds the battery', () => {
  const g = sample().gpus[0];
  const specs = L.gaugeSpecs(sample({
    gpus: [g, { ...g, temp: null }],
    storage: [{ name: 'A', temp: 40, life: 97.6 }, { name: 'B', temp: null }],
    battery: { level: 80, health: 91.2, rate: -7.25 },
  }), T, key => ({ level: key === 'ram' ? 'warn' : 'ok', pending: null }));
  const by = Object.fromEntries(specs.map(s => [s.key, s]));
  assert.equal(by['gpu-temp:1'].label, 'GPU 2 temp');
  assert.equal(by['gpu-temp:1'].missing, 'No temperature reading');
  assert.equal(by['gpu-temp:1'].spark, null);
  assert.equal(by['gpu-load:1'].spark.key, 'gpu1');
  assert.equal(by['storage-temp:0'].sub, 'A · 98% life left');
  assert.equal(by['storage-temp:0'].spark.min, 20);
  assert.equal(by['storage-temp:1'].label, 'Drive 2 temp');
  assert.equal(by.battery.sub, '91% health · using 7.3 W');
  assert.equal(by.ram.level, 'warn');
});

test('windowOf keeps the finite points inside the range, ending at the newest', () => {
  const points = [{ at: 0, t: 1 }, { at: 400, t: 2 }, { at: 700, t: NaN }, { at: 1000, t: 3 }];
  const { now, pts } = L.windowOf(points, 't', 600);
  assert.equal(now, 1000);
  assert.deepEqual(pts.map(p => p.at), [400, 1000]);
});

test('sparkX and sparkY map time and value into the 100 by 30 view box, clamped', () => {
  assert.equal(L.sparkX(1000, 1000, 600), 100);
  assert.equal(L.sparkX(400, 1000, 600), 0);
  assert.equal(L.sparkY(0, 0, 100), 29);
  assert.equal(L.sparkY(100, 0, 100), 1);
  assert.equal(L.sparkY(500, 0, 100), 1);
});

test('sparkPaths draws the line and closes the area, and needs two points', () => {
  const pts = [{ at: 400, v: 0 }, { at: 1000, v: 100 }];
  assert.deepEqual(L.sparkPaths(pts, 'v', 1000, { min: 0, max: 100 }, 600), {
    line: 'M0.00,29.00 L100.00,1.00',
    area: 'M0.00,29.00 L100.00,1.00 L100.00,30 L0.00,30 Z',
  });
  assert.equal(L.sparkPaths(pts.slice(1), 'v', 1000, { min: 0, max: 100 }, 600), null);
});

test('stats gives the lowest and highest in the window', () => {
  const points = [{ at: 0, t: 99 }, { at: 500, t: 52.4 }, { at: 800, t: 84.6 }, { at: 1000, t: 60 }];
  assert.equal(L.stats(points, 't', '°', 600), '↓52° ↑85°');
  assert.equal(L.stats(points.slice(-1), 't', '°', 600), '');
});

test('sparkKeyOf finds the graph an alert belongs on', () => {
  assert.equal(L.sparkKeyOf('cpu-temp'), 'cpuT');
  assert.equal(L.sparkKeyOf('ram'), 'ram');
  assert.equal(L.sparkKeyOf('gpu-temp:0'), 'gpuT');
  assert.equal(L.sparkKeyOf('gpu-temp:2'), 'gpuT2');
  assert.equal(L.sparkKeyOf('storage-temp:1'), 'stT1');
  assert.equal(L.sparkKeyOf('disk:C:'), null);
});

test('spaceRows lists reclaimable Docker, then caches, then virtual disks', () => {
  const rows = L.spaceRows({
    docker: { reclaimable: 2 * GB, size: 10 * GB, rows: [{ type: 'Images', reclaimable: 2 * GB, size: 8 * GB }] },
    caches: [{ name: 'npm', dir: 'C:\\Users\\me\\AppData\\npm-cache', size: GB, partial: true }],
    images: [{ name: 'Ubuntu', size: 20 * GB, file: 'ext4.vhdx' }],
  }, dir => dir.replace('C:\\Users\\me', '~'));
  assert.deepEqual(rows.map(r => r.name), ['Docker', 'npm cache', 'Ubuntu']);
  assert.equal(rows[0].detail, 'unused, of 10 GB in all');
  assert.equal(rows[0].title, 'Images: 2.0 GB of 8.0 GB');
  assert.equal(rows[1].detail, '~\\AppData\\npm-cache');
  assert.equal(rows[2].image, true);
  assert.deepEqual(L.spaceRows({ docker: { reclaimable: 0 } }, x => x), []);
});

test('sources asks for CPU setup until LibreHardwareMonitor answers', () => {
  const view = { sample: sample({ cpu: { name: 'CPU' } }), sources: { gpuTemp: true, nvidia: true, lhm: 'off' } };
  const s = L.sources(view);
  assert.equal(s.needsSetup, true);
  assert.equal(s.summary, 'CPU temperature needs setting up');
  assert.deepEqual(s.rows[1], [false, 'CPU temperature', 'needs LibreHardwareMonitor']);
  assert.equal(s.rows[0][2], 'NVIDIA GeForce RTX 4080 · via nvidia-smi');
});

test('sources reads from HWiNFO when that is the app, and counts drives and fans', () => {
  const view = { sample: sample({ storage: [{}], fans: [{}, {}] }), sources: { app: 'hwinfo', cpuTemp: true, storage: true, lhm: 'ok' } };
  const s = L.sources(view);
  assert.equal(s.needsSetup, false);
  assert.equal(s.summary, 'reading from HWiNFO');
  assert.equal(s.rows[2][2], '1 drive, 2 fans · reading from HWiNFO');
  assert.equal(L.sources(null).summary, '');
});

test('hogsAuto follows a hot, scorching or dizzy mood to its metric', () => {
  const v = (mood, id) => ({ settings: { enabled: true }, mood: { mood, id } });
  assert.equal(L.hogsAuto(v('hot', 'gpu-temp:1')), 'gpu');
  assert.equal(L.hogsAuto(v('scorching', 'cpu-temp')), 'cpu');
  assert.equal(L.hogsAuto(v('dizzy', 'ram')), 'mem');
  assert.equal(L.hogsAuto(v('stuffed', 'disk:C:')), null);
  assert.equal(L.hogsAuto({ settings: { enabled: false }, mood: { mood: 'hot', id: 'cpu-temp' } }), null);
});

test('size and pct keep small numbers readable', () => {
  assert.equal(L.size(100), '1 MB');
  assert.equal(L.size(300 * 1024 ** 2), '300 MB');
  assert.equal(L.size(3 * GB), '3.0 GB');
  assert.equal(L.pct(4.25), '4.3%');
  assert.equal(L.pct(42.5), '43%');
  assert.equal(L.pct(0), '0%');
});

test('hogWords describes an app of several processes, part of it Shellby\'s', () => {
  const w = L.hogWords({ name: 'Code', count: 3, owned: 1, cpu: 25, gpu: 2.5, mem: 512 * 1024 ** 2 }, 'cpu', true, 0);
  assert.equal(w.key, 'app:code');
  assert.equal(w.title, 'Code: 3 processes');
  assert.equal(w.who, 'all 3 Code processes');
  assert.equal(w.rest, 'GPU 2.5% · 512 MB');
  assert.equal(w.value, '25%');
  assert.equal(w.share, 0.25);
  assert.equal(w.ownedText, '1 Shellby task');
  assert.equal(w.end, 'End all');
});

test('hogWords describes a single process by its pid, sized against memory', () => {
  const w = L.hogWords({ name: 'node', pid: 42, owned: true, cpu: 1, gpu: null, mem: 4 * GB }, 'mem', false, 16 * GB);
  assert.equal(w.key, 'pid:42');
  assert.equal(w.who, 'node (process 42)');
  assert.equal(w.rest, 'CPU 1.0%');
  assert.equal(w.value, '4.0 GB');
  assert.equal(w.share, 0.25);
  assert.equal(w.owned, 1);
  assert.equal(w.ownedText, 'Shellby task');
  assert.equal(w.end, 'End task');
});

test('hogWords keeps the bar between empty and full', () => {
  assert.equal(L.hogWords({ name: 'x', count: 1, cpu: 250, mem: 0 }, 'cpu', true, 0).share, 1);
  assert.equal(L.hogWords({ name: 'x', count: 1, mem: 5 }, 'mem', true, 0).share, 0);
});

test('endedLine says what ending an app did, or that it was gone', () => {
  assert.equal(L.endedLine('Code', { ended: 2, gone: 1, failed: 1 }), "Ended 2 Code, 1 had already closed, 1 wouldn't end");
  assert.equal(L.endedLine('Code', {}), 'Code had already closed');
});

test('startupSummary counts what starts and what you switched off', () => {
  assert.equal(L.startupSummary([{}, { off: true }]), "1 thing starts when you sign in, and 1 you've switched off.");
  assert.equal(L.startupSummary([{}, {}]), '2 things start when you sign in.');
  assert.equal(L.startupSummary([{ off: true }]), 'Nothing starts when you sign in (1 switched off).');
  assert.equal(L.startupSummary([]), 'Nothing starts when you sign in.');
});

test('settingsSummary sums up the alert lines, or says off', () => {
  assert.equal(L.settingsSummary(null), '');
  assert.equal(L.settingsSummary({ settings: { enabled: false } }), 'off');
  assert.equal(L.settingsSummary({ settings: { enabled: true, gpuWarn: 80, cpuWarn: 85, ramWarn: 90, notify: false } }), 'GPU 80° · CPU 85° · memory 90% · no notifications');
});

test('logEntry says whether an alert got worse and where it can be shown', () => {
  assert.deepEqual(L.logEntry({ id: 'ram', from: 'ok', to: 'warn' }), { up: true, where: 'on its graph' });
  assert.deepEqual(L.logEntry({ id: 'disk:C:', kind: 'disk', from: 'critical', to: 'ok' }), { up: false, where: 'in Drives' });
  assert.deepEqual(L.logEntry({ id: 'reclaim', kind: 'reclaim', from: 'ok', to: 'warn' }).where, 'in Developer clutter');
  assert.equal(L.logEntry({ id: 'battery', kind: 'battery', from: 'ok', to: 'warn' }).where, null);
});
