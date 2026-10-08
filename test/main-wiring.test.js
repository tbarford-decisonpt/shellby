// main.js under a stand-in Electron (boot itself never runs): every area wires
// without two of them giving the same name, every name main takes from an area
// is one that area gives, and every d.X a wiring/ or ipc/ module reads is on
// shared. A name taken from the wrong area is undefined until boot calls it,
// which lint can't see.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { installFakeElectron } = require('./helpers/fake-ipc');

const MAIN = path.join(__dirname, '..', 'src', 'main');
const userData = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-main-')));
const electron = installFakeElectron({ userData });
const noop = () => {};
Object.assign(electron.app, {
  on: noop, once: noop, quit: noop, exit: noop, setPath: noop, setAppUserModelId: noop, setAsDefaultProtocolClient: noop,
  requestSingleInstanceLock: () => true, getVersion: () => '0.0.0', whenReady: () => new Promise(noop),
});
electron.powerMonitor = { on: noop };
electron.session = { defaultSession: {} };
electron.globalShortcut = {};

// wireQuit is the last thing main does: stand in for it to catch shared.
let shared = null;
const quitPath = path.join(MAIN, 'wiring', 'quit.js');
const stub = new Module(quitPath);
stub.filename = quitPath;
stub.loaded = true;
stub.exports = { wireQuit: d => { shared = d; } };

function loadMain() {
  require.cache[quitPath] = stub;
  const listeners = ['uncaughtException', 'unhandledRejection', 'SIGINT', 'SIGTERM'].map(e => [e, process.listeners(e)]);
  try {
    require(path.join(MAIN, 'main.js'));
  } finally {
    // main hangs snag() and quit() on the process: not on this test runner's.
    for (const [e, before] of listeners) for (const fn of process.listeners(e)) if (!before.includes(fn)) process.removeListener(e, fn);
    delete require.cache[quitPath];
    fs.rmSync(userData, { recursive: true, force: true });
  }
  return shared;
}

test('main wires every area, and what it takes from each is a function there', () => {
  const d = loadMain();
  assert.ok(d, 'main.js reached wireQuit');
  const src = fs.readFileSync(path.join(MAIN, 'main.js'), 'utf8');
  const taken = [...src.matchAll(/const \{([^}]*)\} = share\(wire\w+\(shared\)\)/g)]
    .flatMap(m => m[1].split(',').map(s => s.trim()).filter(Boolean));
  assert.ok(taken.length > 40, `only found ${taken.length} names; has main.js changed shape?`);
  for (const name of taken) assert.notEqual(d[name], undefined, `main takes ${name}, which no area gives`);
});

test('every d.X a wiring/ or ipc/ module reads is on shared', () => {
  const d = shared || loadMain();
  // Modules handed their own deps object rather than shared, and optional hooks.
  const notShared = new Set(['askConfirm', 'journalDir', 'confirmClear', 'onCleared', 'level', 'cardChanged','builtinSkins', 'clearBackground',
    'openPath', 'pickPackFile', 'reloadSkins', 'voice', 'day', 'workArea', 'toLowerCase', 'getDate', 'getFullYear', 'getMonth',
    'homeTurnEnded']); // set by ipc/repo.js once the IPC is registered, after this test's load stops
  const dirs = ['wiring', 'ipc'].map(dir => path.join(MAIN, dir));
  const files = dirs.flatMap(dir => fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => path.join(dir, f)));
  files.push(path.join(MAIN, 'projects', 'releases-ipc.js'));
  const missing = [];
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/\bd\.([A-Za-z_]\w*)/g)) {
      if (!(m[1] in d) && !notShared.has(m[1])) missing.push(`${path.relative(MAIN, f)}: d.${m[1]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
