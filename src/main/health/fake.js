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

module.exports = { createFakeSensors, FAKE_SCENARIOS: Object.keys(SCENARIOS) };
