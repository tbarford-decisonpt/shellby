// Scripted sensors for screenshots, e2e runs and dev (SHELLBY_FAKE_HEALTH=<scenario>,
// never in packaged builds). Same shape as sensors.createSensors().
const GB = 1024 ** 3;

const SCENARIOS = {
  calm: { cpuT: 52, gpuT: 58, cpu: 14, gpu: 9, ram: 41, disks: { 'C:': 317, 'S:': 1602 } },
  hot: { cpuT: 71, gpuT: 84, cpu: 38, gpu: 97, ram: 63, disks: { 'C:': 317, 'S:': 1602 } },
  scorching: { cpuT: 94, gpuT: 79, cpu: 100, gpu: 61, ram: 70, disks: { 'C:': 317, 'S:': 1602 } },
  dizzy: { cpuT: 60, gpuT: 61, cpu: 45, gpu: 12, ram: 94, disks: { 'C:': 317, 'S:': 1602 } },
  stuffed: { cpuT: 55, gpuT: 57, cpu: 11, gpu: 6, ram: 48, disks: { 'C:': 8.4, 'S:': 1602 } },
  nocpu: { cpuT: null, gpuT: 58, cpu: 14, gpu: 9, ram: 41, disks: { 'C:': 317, 'S:': 1602 } },
};
const SIZES = { 'C:': 930.8, 'S:': 7452 };
const LABELS = { 'C:': 'Windows', 'S:': 'Storage' };

function createFakeSensors(name = 'calm') {
  let scenario = SCENARIOS[name] ? name : 'calm';
  let tick = 0;
  // A little wobble so the sparklines look alive; deterministic for screenshots.
  const wob = (v, amp) => (v == null ? null : Math.round((v + Math.sin(tick * 0.9) * amp + Math.cos(tick * 0.37) * amp * 0.6) * 10) / 10);
  const s = () => SCENARIOS[scenario];
  return {
    fake: true,
    hasNvidia: true,
    lhmPort: 8085,
    setLhmPort() {},
    setHwinfoPort() {},
    async readHwinfo() { return null; },
    setScenario(n) { if (SCENARIOS[n]) scenario = n; },
    get scenario() { return scenario; },
    async readNvidia() {
      tick++;
      return [{ index: 0, name: 'NVIDIA GeForce RTX 3080 Ti', vendor: 'nvidia', temp: wob(s().gpuT, 1.2), load: Math.max(0, Math.min(100, wob(s().gpu, 4))), memUsed: 4115, memTotal: 12288, power: 99 + s().gpu * 2.5 }];
    },
    async readLhm() {
      return s().cpuT == null ? null : { cpu: { name: 'AMD Ryzen 9 3950X 16-Core Processor', temp: wob(s().cpuT, 1.5), sensor: 'Core (Tctl/Tdie)' }, gpus: [] };
    },
    readCpuLoad() { return Math.max(0, Math.min(100, wob(s().cpu, 5))); },
    readMemory() { const total = 32 * GB; const pct = wob(s().ram, 0.6); return { total, used: total * pct / 100, pct }; },
    async readDisks() {
      return Object.entries(s().disks).map(([id, freeGb]) => ({ id, label: LABELS[id], total: SIZES[id] * GB, free: freeGb * GB }));
    },
  };
}

// The processes behind each scenario, for "What's hogging it". Same shape as
// hogs.createProcessReader(); ending one only drops it from the list.
const MB = 1024 ** 2;
const PROCS = [
  { pid: 18244, name: 'Cyberpunk2077', cpu: 21.4, gpu: 88, mem: 9120 * MB },
  { pid: 9012, name: 'chrome', cpu: 6.2, gpu: 4, mem: 2310 * MB },
  { pid: 9388, name: 'chrome', cpu: 2.1, gpu: 0, mem: 1480 * MB },
  { pid: 23110, name: 'obs64', cpu: 8.9, gpu: 12, mem: 640 * MB },
  { pid: 4410, name: 'Code', cpu: 3.4, gpu: 1, mem: 1210 * MB },
  { pid: 7720, name: 'Discord', cpu: 1.2, gpu: 2, mem: 520 * MB },
  { pid: 31008, name: 'node', cpu: 14.8, gpu: 0, mem: 3960 * MB },
  { pid: 2216, name: 'dwm', cpu: 1.6, gpu: 6, mem: 180 * MB },
  { pid: 5460, name: 'MsMpEng', cpu: 4.1, gpu: 0, mem: 420 * MB },
  { pid: 12880, name: 'Spotify', cpu: 0.8, gpu: 1, mem: 310 * MB },
];

function createFakeProcesses() {
  const ended = new Set();
  return {
    fake: true,
    async read() { return PROCS.filter(p => !ended.has(p.pid)).map(p => ({ ...p })); },
    async nameOf(pid) { return ended.has(pid) ? null : PROCS.find(p => p.pid === pid)?.name ?? null; },
    async end(pid) { ended.add(pid); return { ok: true }; },
  };
}

const STARTUP = [
  { name: 'Discord', command: '"C:\\Users\\you\\AppData\\Local\\Discord\\Update.exe" --processStart Discord.exe', location: 'Run key (you)', off: false },
  { name: 'Steam', command: '"C:\\Program Files (x86)\\Steam\\steam.exe" -silent', location: 'Run key (you)', off: false },
  { name: 'OneDrive', command: '"C:\\Program Files\\Microsoft OneDrive\\OneDrive.exe" /background', location: 'Run key (you)', off: false },
  { name: 'Spotify', command: '"C:\\Users\\you\\AppData\\Roaming\\Spotify\\Spotify.exe" --autostart --minimized', location: 'Run key (you)', off: false },
  { name: 'EpicGamesLauncher', command: '"C:\\Program Files (x86)\\Epic Games\\Launcher\\Portal\\Binaries\\Win32\\EpicGamesLauncher.exe" -silent', location: 'Run key (you)', off: false },
  { name: 'SecurityHealth', command: '%windir%\\system32\\SecurityHealthSystray.exe', location: 'Run key (everyone)', off: false },
  { name: 'NZXT.CAM', command: '"C:\\Program Files\\NZXT CAM\\NZXT CAM.exe" --startup', location: 'Run key (you)', off: false },
  { name: 'Shellby', command: '"C:\\Users\\you\\AppData\\Local\\Programs\\Shellby\\Shellby.exe"', location: 'Run key (you)', off: false },
  { name: 'Tailscale', command: 'Tailscale.lnk', location: 'Startup folder (everyone)', off: false },
  { name: 'Teams', command: '"C:\\Users\\you\\AppData\\Local\\Microsoft\\Teams\\Update.exe" --processStart Teams.exe', location: 'Run key (you)', off: true },
];

function createFakeStartup() {
  return { async read() { return STARTUP.map(i => ({ ...i })); } };
}

module.exports = { createFakeSensors, createFakeProcesses, createFakeStartup, FAKE_SCENARIOS: Object.keys(SCENARIOS) };
