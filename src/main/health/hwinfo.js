// A second sensor app Shellby can read: HWiNFO, through the companion
// "Remote Sensor Monitor" that publishes HWiNFO's shared memory as JSON over
// HTTP on this PC. Lots of people already run HWiNFO instead of
// LibreHardwareMonitor, and this way Shellby doesn't care which one it is.
//
// Why HTTP and not HWiNFO's shared memory directly: the shared-memory block
// needs an FFI struct read whose layout differs between HWiNFO builds, and a
// wrong guess reads garbage. A JSON document over 127.0.0.1 is the same shape
// of problem as LibreHardwareMonitor's /data.json, which Shellby already
// handles, and it fails loudly instead of silently.
//
// Remote Sensor Monitor's JSON is a flat list of readings, each naming the
// hardware it came from. Builds differ in how they spell the keys and whether
// the list is the whole document or sits under one, so flatten() accepts the
// variants rather than pinning one exact schema. parse() is pure and tested;
// read() does the I/O and never throws.
const { cleanName, fetchLocalJson, pickBy, plausibleTemp, NAME_PREFS } = require('./sensors');

const DEFAULT_PORT = 60000;   // Remote Sensor Monitor's own default
const MAX_READINGS = 4000;    // a fully-populated HWiNFO reports a few hundred

// Key spellings seen across Remote Sensor Monitor builds, best first.
const CLASS_KEYS = ['SensorClass', 'Sensor', 'sensorClass', 'sensor', 'class', 'Class', 'Group'];
const NAME_KEYS = ['SensorName', 'Name', 'sensorName', 'name', 'label', 'Label'];
const VALUE_KEYS = ['SensorValue', 'Value', 'sensorValue', 'value', 'SensorValueRaw'];
const UNIT_KEYS = ['SensorUnit', 'Unit', 'sensorUnit', 'unit'];

const num = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const n = parseFloat(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

const firstKey = (obj, keys) => {
  for (const k of keys) if (obj[k] != null && obj[k] !== '') return obj[k];
  return null;
};

/**
 * Any of the shapes Remote Sensor Monitor serves -> [{ cls, name, value, unit }].
 * Accepts the bare array, or an object with the array under some key (the
 * builds that wrap it call it "readings", "sensors" or "hwinfo"), and ignores
 * entries that carry no number.
 */
function flatten(payload) {
  let list = null;
  if (Array.isArray(payload)) list = payload;
  else if (payload && typeof payload === 'object') {
    // The array is whichever value is a non-empty array of objects.
    for (const v of Object.values(payload)) {
      if (Array.isArray(v) && v.some(e => e && typeof e === 'object')) { list = v; break; }
    }
  }
  if (!list) return [];
  const out = [];
  for (const e of list.slice(0, MAX_READINGS)) {
    if (!e || typeof e !== 'object') continue;
    const value = num(firstKey(e, VALUE_KEYS));
    if (value == null) continue;
    out.push({
      cls: cleanName(firstKey(e, CLASS_KEYS)),
      name: cleanName(firstKey(e, NAME_KEYS)),
      value,
      unit: String(firstKey(e, UNIT_KEYS) ?? '').trim().slice(0, 8),
    });
  }
  return out;
}

// Which piece of hardware a reading's class string describes. HWiNFO class
// names look like "CPU [#0]: AMD Ryzen 9 3950X" or "GPU [#0]: NVIDIA ...".
function hardwareOf(cls) {
  const c = cls.toLowerCase();
  if (/\b(gpu|video)\b|geforce|radeon|intel arc|quadro|\brtx\b|\bgtx\b/.test(c)) return 'gpu';
  if (/^cpu\b|\bcpu \[|ryzen|core i\d|threadripper|xeon|\bapu\b/.test(c)) return 'cpu';
  if (/\b(drive|nvme|ssd|hdd|disk)\b/.test(c)) return 'storage';
  if (/batter|\bups\b/.test(c)) return 'battery';
  if (/system|motherboard|mainboard|nuvoton|ite it\d|aquacomputer|corsair|\bfan\b/.test(c)) return 'board';
  return null;
}

// HWiNFO always reports a unit, so the unit says what kind of reading it is.
function kindOf(unit, name) {
  const u = unit.replace(/\s/g, '');
  if (/°?C$/i.test(u) && u.length <= 3) return 'temperature';
  if (/^RPM$/i.test(u)) return 'fan';
  if (/^W$/i.test(u)) return 'power';
  if (/^(MB|GB)$/i.test(u)) return 'data';
  // Percentages are usage ("GPU Core Load") or a level ("Charge Level").
  if (u === '%') return /level|remaining|health|degrad/i.test(name) ? 'level' : 'load';
  return null;
}

// HWiNFO's names differ a little from LibreHardwareMonitor's; these come first,
// then the shared preferences so both sources agree on what to show.
const HW_CPU_TEMP = [/^cpu \(tctl\/tdie\)$/i, /^cpu package$/i, /^core temperatures? \(?avg\)?$/i];
const HW_GPU_TEMP = [/^gpu temperature$/i, /^gpu core temperature$/i];
const HW_GPU_HOTSPOT = [/^gpu hot ?spot/i, /hot ?spot/i];
const HW_GPU_LOAD = [/^gpu core load$/i, /^gpu utilization$/i, /^gpu d3d usage$/i];
const HW_GPU_MEM_USED = [/^gpu memory (used|allocated)$/i, /^gpu d3d memory dedicated$/i];
const HW_GPU_MEM_TOTAL = [/^(gpu )?memory (size|total)$/i];
const HW_GPU_POWER = [/^gpu (power|package power|asic power|ppt)$/i, /^gpu rail power/i];
const HW_CPU_POWER = [/^cpu package power$/i, /^cpu package$/i, /^cpu ppt$/i];

const both = (own, shared) => [...own, ...shared];

/** Readings of one kind for one piece of hardware. */
const group = (readings, kind) => readings.filter(r => r.kind === kind);
const valueOf = s => (s ? s.value : null);
const mb = s => (s == null ? null : /^GB$/i.test(s.unit) ? s.value * 1024 : s.value);

/**
 * Remote Sensor Monitor's JSON -> the same snapshot shape parseLhm returns:
 *   { cpu, gpus: [...], storage: [...], fans: [...], battery }
 * so the monitor can't tell which app the readings came from.
 */
function parse(payload) {
  const flat = flatten(payload);
  // Group by the exact class string: that is one physical device.
  const devices = new Map();
  for (const r of flat) {
    const hw = hardwareOf(r.cls);
    const kind = kindOf(r.unit, r.name);
    if (!hw || !kind) continue;
    if (!devices.has(r.cls)) devices.set(r.cls, { hw, cls: r.cls, readings: [] });
    devices.get(r.cls).readings.push({ ...r, kind });
  }
  const list = [...devices.values()];
  // "GPU [#0]: NVIDIA GeForce RTX 3080 Ti" -> "NVIDIA GeForce RTX 3080 Ti".
  const deviceName = cls => cleanName(cls.replace(/^[^:]{0,40}:\s*/, '')) || cleanName(cls);
  const temps = d => group(d.readings, 'temperature').filter(t => plausibleTemp(t.value));

  const cpuDev = list.find(d => d.hw === 'cpu' && temps(d).length);
  let cpu = null;
  if (cpuDev) {
    const t = temps(cpuDev);
    const chosen = pickBy(t, both(HW_CPU_TEMP, NAME_PREFS.cpuTemp)) || t.reduce((a, b) => (b.value > a.value ? b : a));
    cpu = {
      name: deviceName(cpuDev.cls), temp: chosen.value, sensor: chosen.name,
      power: valueOf(pickBy(group(cpuDev.readings, 'power'), both(HW_CPU_POWER, NAME_PREFS.cpuPower))),
    };
  }

  const gpus = list.filter(d => d.hw === 'gpu' && temps(d).length).map((d, i) => {
    const t = temps(d);
    const core = pickBy(t, both(HW_GPU_TEMP, NAME_PREFS.gpuTemp)) || t[0];
    const hot = pickBy(t, HW_GPU_HOTSPOT);
    const fan = group(d.readings, 'fan')[0];
    const name = deviceName(d.cls);
    return {
      index: i, name, vendor: vendorOf(name),
      temp: core.value, hotspot: hot ? hot.value : null,
      load: valueOf(pickBy(group(d.readings, 'load'), both(HW_GPU_LOAD, NAME_PREFS.gpuLoad))),
      memUsed: mb(pickBy(group(d.readings, 'data'), both(HW_GPU_MEM_USED, NAME_PREFS.gpuMemUsed))),
      memTotal: mb(pickBy(group(d.readings, 'data'), both(HW_GPU_MEM_TOTAL, NAME_PREFS.gpuMemTotal))),
      power: valueOf(pickBy(group(d.readings, 'power'), both(HW_GPU_POWER, NAME_PREFS.gpuPower))),
      fan: fan ? Math.round(fan.value) : null,
    };
  });

  const storage = list.filter(d => d.hw === 'storage' && temps(d).length).map(d => ({
    name: deviceName(d.cls),
    temp: temps(d)[0].value,
    life: valueOf(group(d.readings, 'level').find(s => /remaining life|health|life left/i.test(s.name))),
  }));

  const fans = list.filter(d => d.hw === 'board' || d.hw === 'cpu').flatMap(d => group(d.readings, 'fan'))
    .concat(list.filter(d => d.hw === 'gpu').flatMap(d => group(d.readings, 'fan')))
    .filter(f => f.value >= 0 && f.value < 30000)
    .map(f => ({ name: f.name, rpm: Math.round(f.value) }))
    .slice(0, 12);

  const batDev = list.find(d => d.hw === 'battery');
  let battery = null;
  if (batDev) {
    const levels = group(batDev.readings, 'level');
    const level = valueOf(levels.find(s => /charge level|charge remaining/i.test(s.name)));
    const wear = valueOf(levels.find(s => /degrad|wear/i.test(s.name)));
    const health = valueOf(levels.find(s => /^battery health|^health/i.test(s.name)));
    const powers = group(batDev.readings, 'power');
    const charge = valueOf(powers.find(s => /^charge rate/i.test(s.name)));
    const discharge = valueOf(powers.find(s => /^discharge rate/i.test(s.name)));
    if (level != null || charge != null || discharge != null) {
      battery = {
        name: deviceName(batDev.cls), level,
        health: health != null ? health : wear != null ? Math.round((100 - wear) * 10) / 10 : null,
        rate: charge ? charge : discharge ? -discharge : 0,
      };
    }
  }

  return { cpu, gpus, storage, fans, battery };
}

// The monitor shows an NVIDIA/AMD/Intel badge; HWiNFO only gives us the name.
function vendorOf(name) {
  if (/nvidia|geforce|quadro|tesla|\brtx\b|\bgtx\b/i.test(name)) return 'nvidia';
  if (/\bamd\b|radeon|\brx \d/i.test(name)) return 'amd';
  if (/intel|\barc\b|\biris\b|\buhd\b/i.test(name)) return 'intel';
  return 'gpu';
}

/** Ask Remote Sensor Monitor for the current readings; null if it isn't there. */
async function read(port = DEFAULT_PORT) {
  const got = await fetchLocalJson(`http://127.0.0.1:${port}/`);
  if (!got || got.error) return got;
  const snap = parse(got.json);
  // An answer from something that isn't a sensor app parses to nothing.
  return snap.cpu || snap.gpus.length || snap.storage.length ? snap : null;
}

module.exports = { parse, flatten, hardwareOf, kindOf, vendorOf, read, DEFAULT_PORT };
