// One command from a fresh clone to a running dev crab:
//
//   npm install
//   npm run setup        checks Node, fetches Electron if npm skipped it, builds panel.html
//   npm run dev:crab     a dev Shellby beside any installed one, on the fake Claude CLI
//
// Safe to run again: each step skips itself when there's nothing to do.
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const MIN_NODE = 22;
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

function step(name, fn) {
  process.stdout.write(`- ${name}... `);
  console.log(fn());
}

function fail(message) {
  console.error(`\n${message}`);
  process.exit(1);
}

const major = Number(process.versions.node.split('.')[0]);
if (major < MIN_NODE) fail(`Shellby needs Node ${MIN_NODE} or newer (this is ${process.versions.node}).`);
if (process.platform !== 'win32') fail('Shellby runs on Windows only. npm test works elsewhere, but the app does not.');
if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron'))) fail('Run npm install first.');

step('Electron binary', () => {
  if (fs.existsSync(electron)) return 'already there';
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules', 'electron', 'install.js')], { cwd: ROOT, stdio: 'inherit' });
  if (!fs.existsSync(electron)) fail('Electron still missing. Try: node node_modules/electron/install.js');
  return 'downloaded';
});

step('panel.html', () => {
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'panel-html.js')], { cwd: ROOT, stdio: 'pipe' });
  return 'built';
});

console.log(`
Ready. Next:
  npm run dev:crab     run a dev crab (fake Claude CLI, own profile, own hook port)
  npm test             the unit tests (no Electron needed)
  npm run lint && npm run typecheck
More in docs/DEVELOPMENT.md.`);
