// A dev Shellby in one command, beside the one you have installed: its own
// profile, the fake Claude CLI (no account, no usage), its own hook port, and
// the dev hooks (SHELLBY_MOTION_TEST) switched on.
//
//   npm run dev:crab                  start it; Ctrl+C closes it
//   npm run dev:crab -- --fresh       start from an empty profile
//   npm run dev:crab -- --real        the real Claude CLI instead of the fake one
//   npm run dev:crab -- --poses       walk him through every work pose and habit, then close
//   npm run dev:crab -- --poses --loop    ...over and over until Ctrl+C
//   SHELLBY_SHOTS=<folder> with --poses saves a PNG of each one, mid-move
//
// The profile lives in %TEMP%\shellby-dev-crab (SHELLBY_DEV_PROFILE moves it).
// --poses drives the crab window over CDP: the poses come from
// src/main/work-pose.js, the habits from src/main/voice.js, never a list here.
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { POSES } = require('../src/main/work-pose');
const { BITS } = require('../src/main/voice');
const { savePng } = require('./lib/shot');

const ROOT = path.join(__dirname, '..');
const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const args = new Set(process.argv.slice(2));
const PORT = 9390;
const HOOK_PORT = '47990';
const STEP_MS = 2600;
// Moments that aren't idle habits but play the same way (a body class for a beat).
const MOMENTS = ['pack'];
const wait = ms => new Promise(r => setTimeout(r, ms));

if (!fs.existsSync(electron)) {
  console.error('No Electron binary. Run: node node_modules/electron/install.js');
  process.exit(1);
}

const profile = process.env.SHELLBY_DEV_PROFILE || path.join(os.tmpdir(), 'shellby-dev-crab');
if (args.has('--fresh')) fs.rmSync(profile, { recursive: true, force: true });
fs.mkdirSync(profile, { recursive: true });

const env = { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_HOOK_PORT: HOOK_PORT, SHELLBY_MOTION_TEST: '1' };
if (!args.has('--real')) env.SHELLBY_FAKE_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const poses = args.has('--poses');
const flags = poses ? [`--remote-debugging-port=${PORT}`, '--force-prefers-no-reduced-motion'] : [];

console.log(`dev crab: profile ${profile}${env.SHELLBY_FAKE_CLAUDE ? ', fake CLI' : ', real CLI'}`);
const app = spawn(electron, [ROOT, ...flags], { stdio: 'inherit', env });
let closing = false;
const close = () => { if (closing) return; closing = true; app.kill(); };
process.on('SIGINT', close);
app.on('exit', code => process.exit(closing ? 0 : code ?? 0));

async function critterTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = list.find(x => x.url.endsWith('critter.html'));
      if (t) return t;
    } catch { /* not up yet */ }
    await wait(500);
  }
  throw new Error('the crab window never appeared');
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  await new Promise(r => { ws.onopen = r; });
  const send = (method, params = {}) => new Promise(r => {
    const i = ++id;
    pending.set(i, m => r(m.result));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true }))?.result?.value;
  return { ev, send };
}

// critter.js is a classic script, so its top-level state, poses, flags and
// paintBody are reachable from the page's global scope.
const showPose = pose => `state = 'working'; poses.set(${JSON.stringify(pose)}, true); paintBody(); true`;
const showBit = bit => `state = 'idle'; poses.set(null, false); flags.add('bit-${bit}'); paintBody(); true`;
const endBit = bit => `flags.delete('bit-${bit}'); paintBody(); true`;

async function walk() {
  const { ev, send } = await connect((await critterTarget()).webSocketDebuggerUrl);
  const shots = process.env.SHELLBY_SHOTS;
  if (shots) fs.mkdirSync(shots, { recursive: true });
  // Partway through, so a move is caught in the middle rather than at rest.
  const hold = async name => {
    if (!shots) return wait(STEP_MS);
    await wait(STEP_MS / 3);
    await savePng(send, path.join(shots, `${name}.png`));
    await wait(STEP_MS * 2 / 3);
  };
  for (let i = 0; i < 40 && !(await ev('typeof paintBody === "function" && !!document.body')); i++) await wait(250);
  do {
    for (const pose of POSES) {
      console.log(`  pose  ${pose}`);
      await ev(showPose(pose));
      await hold(`pose-${pose}`);
    }
    for (const bit of [...BITS, ...MOMENTS]) {
      console.log(`  habit ${bit}`);
      await ev(showBit(bit));
      await hold(`habit-${bit}`);
      await ev(endBit(bit));
      await wait(300);
    }
  } while (args.has('--loop') && !closing);
  await ev(`state = 'idle'; poses.set(null, false); paintBody(); true`);
}

if (poses) {
  walk().then(() => { if (!args.has('--loop')) close(); }, err => { console.error(err.message); close(); });
}
