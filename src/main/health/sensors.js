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

function hardwareKind(node) {
  const id = String(node.HardwareId || '').toLowerCase();
  const img = String(node.ImageURL || '').toLowerCase();
  if (id.startsWith('/amdcpu') || id.startsWith('/intelcpu') || img.endsWith('/cpu.png')) return 'cpu';
  if (id.startsWith('/gpu-nvidia') || img.endsWith('/nvidia.png')) return 'gpu-nvidia';
  if (id.startsWith('/gpu-amd') || img.endsWith('/ati.png') || img.endsWith('/amd.png')) return 'gpu-amd';
  if (id.startsWith('/gpu-intel') || img.endsWith('/intel.png')) return 'gpu-intel';
  return null;
}

function isTemperature(node, groupText) {
  if (node.Type) return /^temperature$/i.test(node.Type);
  if (node.SensorId) return /\/temperature\//i.test(node.SensorId);
  return /temperature/i.test(groupText || '') && /°\s*C$/i.test(String(node.Value || '').trim());
}

function pickBy(sensors, preferences) {
  for (const re of preferences) {
    const hit = sensors.find(s => re.test(s.name));
    if (hit) return hit;
  }
  return null;
}

/**
 * LibreHardwareMonitor's /data.json tree -> { cpu: { name, temp }, gpus: [...] }.
 * Works with and without the SensorId/Type fields (older versions lack them).
 */
function parseLhm(tree) {
  const hardware = []; // { kind, name, temps: [{ name, value }] }
  (function walk(node, hw, group) {
    if (!node || typeof node !== 'object') return;
    const kind = hardwareKind(node);
    if (kind) { hw = { kind, name: cleanName(node.Text), temps: [] }; hardware.push(hw); }
    const children = Array.isArray(node.Children) ? node.Children : [];
    if (hw && !children.length && isTemperature(node, group)) {
      const value = num(node.Value);
      if (value != null && value > -50 && value < 150) hw.temps.push({ name: cleanName(node.Text), value });
    }
    for (const c of children) walk(c, hw, children.length && !kind ? node.Text : group);
  })(tree, null, null);

  const cpuHw = hardware.find(h => h.kind === 'cpu' && h.temps.length);
  let cpu = null;
  if (cpuHw) {
    const chosen = pickBy(cpuHw.temps, CPU_TEMP_NAMES)
      || cpuHw.temps.reduce((a, b) => (b.value > a.value ? b : a));
    cpu = { name: cpuHw.name, temp: chosen.value, sensor: chosen.name };
  }
  const gpus = hardware.filter(h => h.kind.startsWith('gpu') && h.temps.length).map((h, i) => {
    const core = pickBy(h.temps, GPU_TEMP_NAMES) || h.temps[0];
    const hot = h.temps.find(t => /hot ?spot/i.test(t.name));
    return { index: i, name: h.name, vendor: h.kind.slice(4), temp: core.value, hotspot: hot ? hot.value : null };
  });
  return { cpu, gpus };
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
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), LHM_TIMEOUT_MS);
      try {
        const res = await fetch(`http://127.0.0.1:${lhmPort}/data.json`, { signal: ctrl.signal });
        if (res.status === 401) return { error: 'auth' };
        if (!res.ok || !res.body) return null;
        // The port is user-set, so cap the body while it streams in, not after.
        const chunks = [];
        let size = 0;
        for await (const chunk of res.body) {
          size += chunk.length;
          if (size > LHM_MAX_BYTES) { ctrl.abort(); return null; }
          chunks.push(chunk);
        }
        return parseLhm(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },

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

module.exports = { cleanName, parseNvidiaSmi, parseLhm, cpuPercent, parseDriveList, createSensors, findNvidiaSmi, LHM_DEFAULT_PORT };
