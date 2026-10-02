// Hardware readings for the health monitor. Parsers are pure (and tested);
// the readers below them do the I/O and never throw: a missing sensor is
// just `null`, and the Health view explains how to enable it.
//
// Sources, all readable without admin rights:
//   GPU (NVIDIA)  nvidia-smi, which ships with the driver
//   CPU temp      LibreHardwareMonitor's local web server (Options > Remote Web Server),
//                 because Windows exposes no CPU temperature to normal programs
//   CPU load      os.cpus() time deltas
//   RAM           os.totalmem / os.freemem (free = "available" on Windows)
//   Disks         drive list from CIM (cached), free space from fs.statfs
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
// hwinfo.js reuses the helpers below, so it is required where it is used rather
// than here: requiring it at load time would be a cycle, and one of the two
// modules would see the other half-built.

const NVIDIA_QUERY = 'index,name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw';
const LHM_DEFAULT_PORT = 8085;
const LHM_TIMEOUT_MS = 1500;
const LHM_MAX_BYTES = 4 * 1024 * 1024;  // a big rig's data.json is ~100 KB

// ------------------------------------------------------------------ parsers

// Hardware names end up in the UI and in Claude prompts: one line, bounded length.
const cleanName = s => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80);

const num = s => {
  const v = parseFloat(String(s ?? '').replace(',', '.'));
  return Number.isFinite(v) ? v : null;
};

/** `nvidia-smi --query-gpu=<NVIDIA_QUERY> --format=csv,noheader,nounits` -> GPUs. */
function parseNvidiaSmi(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const [index, name, temp, load, memUsed, memTotal, power] = line.split(',').map(s => s.trim());
    return {
      index: num(index) ?? 0, name: cleanName(name) || 'NVIDIA GPU', vendor: 'nvidia',
      temp: num(temp), load: num(load), memUsed: num(memUsed), memTotal: num(memTotal), power: num(power),
    };
  }).filter(g => g.name && !/^\[?(N\/A|Not Supported)\]?$/i.test(g.name));
}

// Preferred CPU temperature sensors, best first (AMD then Intel naming).
const CPU_TEMP_NAMES = [/^core \(tctl\/tdie\)$/i, /^cpu package$/i, /^tctl$/i, /^tdie$/i, /^core \(tctl\)$/i, /^package$/i, /^core average$/i];
const GPU_TEMP_NAMES = [/^gpu core$/i, /^gpu$/i, /^core$/i];
// Whole-chip power, best first: AMD reports "Package" or "PPT", Intel "CPU Package".
const CPU_POWER_NAMES = [/^cpu package$/i, /^package$/i, /^ppt$/i, /^cpu ppt$/i];
const GPU_POWER_NAMES = [/^gpu package$/i, /^gpu power$/i, /^gpu total$/i, /^gpu ppt$/i, /^package$/i, /^gpu core$/i];
const GPU_LOAD_NAMES = [/^gpu core$/i, /^gpu total$/i, /^d3d 3d$/i];
const GPU_MEM_USED_NAMES = [/^gpu memory used$/i, /^d3d dedicated memory used$/i, /^gpu memory dedicated$/i];
const GPU_MEM_TOTAL_NAMES = [/^gpu memory total$/i];

function hardwareKind(node) {
  const id = String(node.HardwareId || '').toLowerCase();
  const img = String(node.ImageURL || '').toLowerCase();
  if (id.startsWith('/amdcpu') || id.startsWith('/intelcpu') || img.endsWith('/cpu.png')) return 'cpu';
  if (id.startsWith('/gpu-nvidia') || img.endsWith('/nvidia.png')) return 'gpu-nvidia';
  if (id.startsWith('/gpu-amd') || img.endsWith('/ati.png') || img.endsWith('/amd.png')) return 'gpu-amd';
  if (id.startsWith('/gpu-intel') || img.endsWith('/intel.png')) return 'gpu-intel';
  if (/^\/(nvme|hdd|ssd|storage)/.test(id) || /\/(hdd|ssd|nvme)\.png$/.test(img)) return 'storage';
  if (id.startsWith('/battery') || img.endsWith('/battery.png')) return 'battery';
  // The SuperIO chip (and the board it sits on) is where the case fans are.
  if (id.startsWith('/lpc/') || id.startsWith('/mainboard') || img.endsWith('/mainboard.png') || img.endsWith('/chip.png')) return 'board';
  return null;
}

/**
 * Which group of readings a leaf node belongs to: 'temperature', 'load', 'fan',
 * 'power', 'data', 'level', ... Newer LibreHardwareMonitor builds say so in
 * `Type`, slightly older ones only in the `SensorId` path, and the oldest just
 * file the sensors under a heading ("Temperatures", "Fans").
 */
function sensorKind(node, groupText) {
  const fromPath = String(node.SensorId || '').match(/\/([a-z]+)\/\d+$/i);
  const raw = node.Type || (fromPath && fromPath[1]) || groupText || '';
  const k = String(raw).toLowerCase().replace(/[^a-z]/g, '').replace(/s$/, '');
  return k === 'smalldata' ? 'data' : k;
}

// "63.0 °C" -> { value: 63, unit: '°C' }, "4115 MB" -> { value: 4115, unit: 'MB' }.
// LHM localises the decimal separator, so "62,4 °C" has to work too.
function parseSensorValue(raw) {
  const text = String(raw ?? '').trim();
  const value = num(text);
  if (value == null) return null;
  const unit = (text.match(/[^\d\s.,+-]+.*$/) || [''])[0].trim().slice(0, 8);
  return { value, unit };
}

// Memory sizes arrive as MB on GPUs and GB on drives; normalise to MB.
const toMb = s => (s == null ? null : /^GB$/i.test(s.unit) ? s.value * 1024 : s.value);

function pickBy(sensors, preferences) {
  for (const re of preferences) {
    const hit = sensors.find(s => re.test(s.name));
    if (hit) return hit;
  }
  return null;
}

const valueOf = s => (s ? s.value : null);
const plausibleTemp = v => v != null && v > -50 && v < 150;

// The naming preferences above, shared with the other sensor apps Shellby can
// read (see hwinfo.js) so every source picks the same sensor for the same gauge.
const NAME_PREFS = Object.freeze({
  cpuTemp: CPU_TEMP_NAMES, gpuTemp: GPU_TEMP_NAMES,
  cpuPower: CPU_POWER_NAMES, gpuPower: GPU_POWER_NAMES, gpuLoad: GPU_LOAD_NAMES,
  gpuMemUsed: GPU_MEM_USED_NAMES, gpuMemTotal: GPU_MEM_TOTAL_NAMES,
});

/**
 * LibreHardwareMonitor's /data.json tree -> everything Shellby shows:
 *   { cpu, gpus: [...], storage: [...], fans: [...], battery }
 * Works with and without the SensorId/Type fields (older versions lack them).
 */
function parseLhm(tree) {
  const hardware = []; // { kind, name, sensors: { [sensorKind]: [{ name, value, unit }] } }
  (function walk(node, hw, group) {
    if (!node || typeof node !== 'object') return;
    const kind = hardwareKind(node);
    if (kind) { hw = { kind, name: cleanName(node.Text), sensors: {} }; hardware.push(hw); }
    const children = Array.isArray(node.Children) ? node.Children : [];
    if (hw && !children.length) {
      const parsed = parseSensorValue(node.Value);
      const sk = parsed && sensorKind(node, group);
      if (sk) (hw.sensors[sk] ||= []).push({ name: cleanName(node.Text), ...parsed });
    }
    for (const c of children) walk(c, hw, children.length && !kind ? node.Text : group);
  })(tree, null, null);

  const temps = hw => (hw.sensors.temperature || []).filter(t => plausibleTemp(t.value));
  const of = (hw, kind) => hw.sensors[kind] || [];

  const cpuHw = hardware.find(h => h.kind === 'cpu' && temps(h).length);
  let cpu = null;
  if (cpuHw) {
    const list = temps(cpuHw);
    const chosen = pickBy(list, CPU_TEMP_NAMES) || list.reduce((a, b) => (b.value > a.value ? b : a));
    cpu = {
      name: cpuHw.name, temp: chosen.value, sensor: chosen.name,
      power: valueOf(pickBy(of(cpuHw, 'power'), CPU_POWER_NAMES)),
    };
  }

  const gpus = hardware.filter(h => h.kind.startsWith('gpu') && temps(h).length).map((h, i) => {
    const list = temps(h);
    const core = pickBy(list, GPU_TEMP_NAMES) || list[0];
    const hot = list.find(t => /hot ?spot/i.test(t.name));
    const fan = of(h, 'fan')[0];
    return {
      index: i, name: h.name, vendor: h.kind.slice(4),
      temp: core.value, hotspot: hot ? hot.value : null,
      load: valueOf(pickBy(of(h, 'load'), GPU_LOAD_NAMES)),
      memUsed: toMb(pickBy(of(h, 'data'), GPU_MEM_USED_NAMES)),
      memTotal: toMb(pickBy(of(h, 'data'), GPU_MEM_TOTAL_NAMES)),
      power: valueOf(pickBy(of(h, 'power'), GPU_POWER_NAMES)),
      fan: fan ? Math.round(fan.value) : null,
    };
  });

  const storage = hardware.filter(h => h.kind === 'storage' && temps(h).length).map(h => ({
    name: h.name,
    temp: temps(h)[0].value,
    life: valueOf(of(h, 'level').find(s => /remaining life/i.test(s.name))),
  }));

  // Case and CPU fans (the board's), then whatever the GPUs reported.
  const fans = [
    ...hardware.filter(h => h.kind === 'board' || h.kind === 'cpu').flatMap(h => of(h, 'fan')),
    ...hardware.filter(h => h.kind.startsWith('gpu')).flatMap(h => of(h, 'fan')),
  ].filter(f => f.value >= 0 && f.value < 30000).map(f => ({ name: f.name, rpm: Math.round(f.value) })).slice(0, 12);

  const batHw = hardware.find(h => h.kind === 'battery');
  let battery = null;
  if (batHw) {
    const level = valueOf(of(batHw, 'level').find(s => /charge level/i.test(s.name)));
    const degraded = valueOf(of(batHw, 'level').find(s => /degradation/i.test(s.name)));
    // Anchored: "Discharge Rate" contains "charge rate".
    const charge = valueOf(of(batHw, 'power').find(s => /^charge rate/i.test(s.name)));
    const discharge = valueOf(of(batHw, 'power').find(s => /^discharge rate/i.test(s.name)));
    if (level != null || charge != null || discharge != null) {
      battery = {
        name: batHw.name, level,
        health: degraded == null ? null : Math.round((100 - degraded) * 10) / 10,
        // One signed figure: charging is positive, running down is negative.
        rate: charge ? charge : discharge ? -discharge : 0,
      };
    }
  }

  return { cpu, gpus, storage, fans, battery };
}

/** CPU busy % between two os.cpus() snapshots. */
function cpuPercent(prev, cur) {
  if (!Array.isArray(prev) || !Array.isArray(cur) || prev.length !== cur.length) return null;
  let idle = 0, total = 0;
  cur.forEach((c, i) => {
    const p = prev[i].times, t = c.times;
    const sum = x => x.user + x.nice + x.sys + x.idle + x.irq;
    idle += t.idle - p.idle;
    total += sum(t) - sum(p);
  });
  return total > 0 ? Math.min(100, Math.max(0, 100 * (1 - idle / total))) : null;
}

/** CIM Win32_LogicalDisk JSON -> local fixed drives [{ id: 'C:', label }]. */
function parseDriveList(text) {
  let data;
  try { data = JSON.parse(String(text || '').trim() || '[]'); } catch { return []; }
  const list = Array.isArray(data) ? data : [data];
  return list
    .filter(d => d && d.DriveType === 3 && /^[A-Z]:$/i.test(d.DeviceID))
    .map(d => ({ id: d.DeviceID.toUpperCase(), label: typeof d.VolumeName === 'string' ? d.VolumeName.slice(0, 40) : '' }));
}

// ------------------------------------------------------------------ readers

function run(file, args, timeout = 4000) {
  return new Promise(resolve => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

/**
 * GET a small JSON document from a sensor app on this PC.
 *   { json } on success, { error: 'auth' } if it wants a password, null otherwise.
 * The port is user-set, so the body is capped while it streams in, not after.
 */
async function fetchLocalJson(url, { timeoutMs = LHM_TIMEOUT_MS, maxBytes = LHM_MAX_BYTES } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (res.status === 401) return { error: 'auth' };
    if (!res.ok || !res.body) return null;
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > maxBytes) { ctrl.abort(); return null; }
      chunks.push(chunk);
    }
    return { json: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function findNvidiaSmi(env = process.env) {
  const sys = path.join(env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe');
  const legacy = path.join(env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe');
  return [sys, legacy].find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
}

/**
 * The real sensor set used by the app. Each read*() resolves to data or null.
 * `lhmPort` may change at runtime via setLhmPort.
 */
function createSensors({ platform = process.platform } = {}) {
  const nvidiaSmi = platform === 'win32' ? findNvidiaSmi() : null;
  let lastCpus = os.cpus();
  let lhmPort = LHM_DEFAULT_PORT;
  let hwinfoPort = require('./hwinfo').DEFAULT_PORT;
  let drives = null;
  let drivesAt = 0;

  return {
    hasNvidia: !!nvidiaSmi,
    setLhmPort(p) { lhmPort = p; },
    get lhmPort() { return lhmPort; },

    async readNvidia() {
      if (!nvidiaSmi) return null;
      const out = await run(nvidiaSmi, [`--query-gpu=${NVIDIA_QUERY}`, '--format=csv,noheader,nounits']);
      const gpus = out ? parseNvidiaSmi(out) : [];
      return gpus.length ? gpus : null;
    },

    async readLhm() {
      const got = await fetchLocalJson(`http://127.0.0.1:${lhmPort}/data.json`);
      if (!got || got.error) return got;
      return parseLhm(got.json);
    },

    // HWiNFO, through Remote Sensor Monitor, for the people who run that
    // instead. Same snapshot shape, so the monitor can't tell them apart.
    async readHwinfo() {
      return require('./hwinfo').read(hwinfoPort);
    },

    setHwinfoPort(p) { hwinfoPort = p; },
    get hwinfoPort() { return hwinfoPort; },

    readCpuLoad() {
      const cur = os.cpus();
      const pct = cpuPercent(lastCpus, cur);
      lastCpus = cur;
      return pct;
    },

    readMemory() {
      const total = os.totalmem();
      const free = os.freemem();
      return total > 0 ? { total, used: total - free, pct: (100 * (total - free)) / total } : null;
    },

    async readDisks(now = Date.now()) {
      if (platform !== 'win32') return null;
      // The drive list rarely changes; refresh it every 15 minutes.
      if (!drives || now - drivesAt > 15 * 60 * 1000) {
        // Absolute path: never pick up a powershell.exe from PATH or the working dir.
        const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const out = await run(ps, ['-NoProfile', '-NonInteractive', '-Command',
          'Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID,DriveType,VolumeName | ConvertTo-Json -Compress'], 10000);
        if (out) { drives = parseDriveList(out); drivesAt = now; }
      }
      if (!drives?.length) return null;
      const results = await Promise.all(drives.map(d => fs.promises.statfs(`${d.id}\\`).then(s => ({
        ...d, total: s.blocks * s.bsize, free: s.bavail * s.bsize,
      })).catch(() => null)));
      return results.filter(Boolean);
    },
  };
}

module.exports = {
  cleanName, parseNvidiaSmi, parseLhm, parseSensorValue, sensorKind, cpuPercent, parseDriveList,
  createSensors, findNvidiaSmi, fetchLocalJson, pickBy, plausibleTemp, NAME_PREFS,
  LHM_DEFAULT_PORT, LHM_TIMEOUT_MS, LHM_MAX_BYTES,
};
