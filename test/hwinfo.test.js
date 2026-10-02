// HWiNFO (via Remote Sensor Monitor) as a second sensor source. The point of
// these tests is that its readings come out in exactly the shape parseLhm
// returns, so the monitor can't tell the two apps apart, and that the key
// spellings that differ between Remote Sensor Monitor builds all still work.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parse, flatten, hardwareOf, kindOf, vendorOf } = require('../src/main/health/hwinfo');
const { parseLhm } = require('../src/main/health/sensors');

// Shaped like Remote Sensor Monitor's own output: one flat array, every reading
// naming its hardware, values and units as strings.
const RSM = [
  { SensorClass: 'CPU [#0]: AMD Ryzen 9 3950X', SensorName: 'CPU (Tctl/Tdie)', SensorValue: '62.4', SensorUnit: '°C' },
  { SensorClass: 'CPU [#0]: AMD Ryzen 9 3950X', SensorName: 'CPU Die (average)', SensorValue: '58.1', SensorUnit: '°C' },
  { SensorClass: 'CPU [#0]: AMD Ryzen 9 3950X', SensorName: 'CPU Package Power', SensorValue: '88.5', SensorUnit: 'W' },
  { SensorClass: 'CPU [#0]: AMD Ryzen 9 3950X', SensorName: 'Core 0 Clock', SensorValue: '4210.5', SensorUnit: 'MHz' },
  { SensorClass: 'GPU [#0]: NVIDIA GeForce RTX 3080 Ti', SensorName: 'GPU Temperature', SensorValue: '71', SensorUnit: '°C' },
  { SensorClass: 'GPU [#0]: NVIDIA GeForce RTX 3080 Ti', SensorName: 'GPU Hot Spot Temperature', SensorValue: '84', SensorUnit: '°C' },
  { SensorClass: 'GPU [#0]: NVIDIA GeForce RTX 3080 Ti', SensorName: 'GPU Core Load', SensorValue: '97', SensorUnit: '%' },
  { SensorClass: 'GPU [#0]: NVIDIA GeForce RTX 3080 Ti', SensorName: 'GPU Memory Used', SensorValue: '6821', SensorUnit: 'MB' },
  { SensorClass: 'GPU [#0]: NVIDIA GeForce RTX 3080 Ti', SensorName: 'GPU Memory Size', SensorValue: '12288', SensorUnit: 'MB' },
  { SensorClass: 'GPU [#0]: NVIDIA GeForce RTX 3080 Ti', SensorName: 'GPU Power', SensorValue: '312.4', SensorUnit: 'W' },
  { SensorClass: 'GPU [#0]: NVIDIA GeForce RTX 3080 Ti', SensorName: 'GPU Fan1', SensorValue: '1890', SensorUnit: 'RPM' },
  { SensorClass: 'System: ASUS PRIME X570-P', SensorName: 'CPU Fan', SensorValue: '1243', SensorUnit: 'RPM' },
  { SensorClass: 'System: ASUS PRIME X570-P', SensorName: 'Chassis Fan2', SensorValue: '0', SensorUnit: 'RPM' },
  { SensorClass: 'System: ASUS PRIME X570-P', SensorName: 'Vcore', SensorValue: '1.39', SensorUnit: 'V' },
  { SensorClass: 'Drive: Samsung SSD 990 PRO 2TB', SensorName: 'Drive Temperature', SensorValue: '52', SensorUnit: '°C' },
  { SensorClass: 'Drive: Samsung SSD 990 PRO 2TB', SensorName: 'Remaining Life', SensorValue: '97', SensorUnit: '%' },
  { SensorClass: 'Battery: BAT1', SensorName: 'Charge Level', SensorValue: '74', SensorUnit: '%' },
  { SensorClass: 'Battery: BAT1', SensorName: 'Degradation Level', SensorValue: '11.5', SensorUnit: '%' },
  { SensorClass: 'Battery: BAT1', SensorName: 'Discharge Rate', SensorValue: '18.2', SensorUnit: 'W' },
];

test('parse reads the CPU, picking the package sensor over the die average', () => {
  const r = parse(RSM);
  assert.deepEqual(r.cpu, { name: 'AMD Ryzen 9 3950X', temp: 62.4, sensor: 'CPU (Tctl/Tdie)', power: 88.5 });
});

test('parse reads the GPU with its load, memory, power, hotspot and fan', () => {
  const r = parse(RSM);
  assert.equal(r.gpus.length, 1);
  assert.deepEqual(r.gpus[0], {
    index: 0, name: 'NVIDIA GeForce RTX 3080 Ti', vendor: 'nvidia',
    temp: 71, hotspot: 84, load: 97, memUsed: 6821, memTotal: 12288, power: 312.4, fan: 1890,
  });
});

test('parse reads drives, fans and the battery', () => {
  const r = parse(RSM);
  assert.deepEqual(r.storage, [{ name: 'Samsung SSD 990 PRO 2TB', temp: 52, life: 97 }]);
  assert.deepEqual(r.fans, [{ name: 'CPU Fan', rpm: 1243 }, { name: 'Chassis Fan2', rpm: 0 }, { name: 'GPU Fan1', rpm: 1890 }]);
  assert.deepEqual(r.battery, { name: 'BAT1', level: 74, health: 88.5, rate: -18.2 });
});

test('a HWiNFO snapshot has the same keys as a LibreHardwareMonitor one', () => {
  // The monitor merges whichever source answered, so the shapes must match.
  const lhmShape = parseLhm(null);
  const hw = parse(RSM);
  assert.deepEqual(Object.keys(hw).sort(), Object.keys(lhmShape).sort());
  const lhmGpu = { index: 0, name: '', vendor: '', temp: 0, hotspot: null, load: null, memUsed: null, memTotal: null, power: null, fan: null };
  assert.deepEqual(Object.keys(hw.gpus[0]).sort(), Object.keys(lhmGpu).sort());
  assert.deepEqual(Object.keys(hw.cpu).sort(), ['name', 'power', 'sensor', 'temp']);
});

test('flatten accepts the other key spellings and a wrapped array', () => {
  const lower = [{ sensor: 'CPU [#0]: Intel Core i7', name: 'CPU Package', value: 70, unit: '°C' }];
  assert.equal(parse(lower).cpu.temp, 70);
  assert.equal(parse({ readings: lower }).cpu.temp, 70);
  assert.equal(parse({ hwinfo: { nope: 1 }, sensors: lower }).cpu.temp, 70);
  // Numbers may arrive as numbers, and commas are a valid decimal point.
  assert.equal(parse([{ Sensor: 'CPU: Ryzen', Name: 'CPU Package', Value: '62,4', Unit: '°C' }]).cpu.temp, 62.4);
});

test('flatten drops entries with no number and survives junk', () => {
  assert.deepEqual(flatten(null), []);
  assert.deepEqual(flatten('nope'), []);
  assert.deepEqual(flatten([null, 5, { SensorName: 'x', SensorValue: 'N/A' }]), []);
  const empty = { cpu: null, gpus: [], storage: [], fans: [], battery: null };
  assert.deepEqual(parse(null), empty);
  assert.deepEqual(parse({}), empty);
});

test('hardwareOf classifies HWiNFO class strings', () => {
  assert.equal(hardwareOf('CPU [#0]: AMD Ryzen 9 3950X'), 'cpu');
  assert.equal(hardwareOf('GPU [#0]: NVIDIA GeForce RTX 3080 Ti'), 'gpu');
  assert.equal(hardwareOf('Drive: Samsung SSD 990 PRO'), 'storage');
  assert.equal(hardwareOf('Battery: BAT1'), 'battery');
  assert.equal(hardwareOf('System: ASUS PRIME X570-P'), 'board');
  assert.equal(hardwareOf('Network: Ethernet'), null);
  // A GPU on an APU still reads as a GPU, not the CPU it shares a die with.
  assert.equal(hardwareOf('GPU [#0]: AMD Radeon 780M'), 'gpu');
});

test('kindOf reads the unit, and tells a load percentage from a level', () => {
  assert.equal(kindOf('°C', 'GPU Temperature'), 'temperature');
  assert.equal(kindOf('RPM', 'CPU Fan'), 'fan');
  assert.equal(kindOf('W', 'GPU Power'), 'power');
  assert.equal(kindOf('MB', 'GPU Memory Used'), 'data');
  assert.equal(kindOf('%', 'GPU Core Load'), 'load');
  assert.equal(kindOf('%', 'Charge Level'), 'level');
  assert.equal(kindOf('%', 'Remaining Life'), 'level');
  assert.equal(kindOf('MHz', 'Core 0 Clock'), null);
  assert.equal(kindOf('V', 'Vcore'), null);
});

test('vendorOf names the badge from the card name', () => {
  assert.equal(vendorOf('NVIDIA GeForce RTX 3080 Ti'), 'nvidia');
  assert.equal(vendorOf('AMD Radeon RX 6800'), 'amd');
  assert.equal(vendorOf('Intel Arc A770'), 'intel');
  assert.equal(vendorOf('Something Else'), 'gpu');
});

test('two GPUs stay separate devices', () => {
  const two = [
    { SensorClass: 'GPU [#0]: NVIDIA GeForce RTX 3080 Ti', SensorName: 'GPU Temperature', SensorValue: '71', SensorUnit: '°C' },
    { SensorClass: 'GPU [#1]: Intel Arc A770', SensorName: 'GPU Temperature', SensorValue: '45', SensorUnit: '°C' },
  ];
  const gpus = parse(two).gpus;
  assert.deepEqual(gpus.map(g => [g.index, g.vendor, g.temp]), [[0, 'nvidia', 71], [1, 'intel', 45]]);
});

test('an implausible temperature is ignored, not shown as a reading', () => {
  const bad = [{ SensorClass: 'CPU: Ryzen', SensorName: 'CPU Package', SensorValue: '-999', SensorUnit: '°C' }];
  assert.equal(parse(bad).cpu, null);
});
