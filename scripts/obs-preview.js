// Serve the OBS overlay with a real skin and a scripted crab, so you can see it
// without OBS: open the URL it prints in any browser.
//
//   node scripts/obs-preview.js [--port 47914] [--skin classic] [--state working]
//
// With no --state it cycles through them every three seconds, which is the
// quickest way to check the overlay reacts and stays transparent.
const fs = require('fs');
const path = require('path');
const { ObsServer } = require('../src/main/obs');

const ROOT = path.join(__dirname, '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const skinName = arg('skin', 'classic');
const skinFile = path.join(ROOT, 'src', 'skins', `${skinName}.json`);
if (!fs.existsSync(skinFile)) {
  console.error(`No skin called ${skinName}. Available: ${fs.readdirSync(path.join(ROOT, 'src', 'skins')).join(', ')}`);
  process.exit(1);
}
const skin = JSON.parse(fs.readFileSync(skinFile, 'utf8'));

const CYCLE = ['idle', 'working', 'asking', 'success', 'sleeping'];
const fixed = arg('state', null);
let i = 0;

const state = () => ({
  skin,
  outfit: { accessories: [], effect: null, crewAccessories: [], home: null },
  px: 6,
  state: fixed || CYCLE[i % CYCLE.length],
  busy: (fixed || CYCLE[i % CYCLE.length]) === 'working' ? 2 : 0,
  crew: [],
  say: null,
});

const server = new ObsServer({
  srcDir: path.join(ROOT, 'src'),
  assetsDir: path.join(ROOT, 'assets'),
  getState: state,
  port: Number(arg('port', 47914)),
});

server.on('status', v => {
  if (v.status !== 'listening') {
    console.error(`Could not listen on port ${v.port}: ${v.status}`);
    process.exit(1);
  }
  console.log(`Overlay at ${v.url}`);
  console.log(fixed ? `Showing "${fixed}".` : `Cycling: ${CYCLE.join(' -> ')}`);
  console.log('In OBS: add a Browser source, paste that URL, tick "Shutdown source when not visible".');
  console.log('Ctrl+C to stop.');
});
server.on('viewers', n => console.log(`${n} viewer${n === 1 ? '' : 's'}`));
server.start();

if (!fixed) {
  setInterval(() => { i++; server.broadcast(state()); }, 3000);
}

process.on('SIGINT', () => { server.stop(); process.exit(0); });
