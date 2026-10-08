// Checks the Win32 behaviour window perching relies on, against a real Notepad:
//   npx electron scripts/perch-probe.js
// 1. a transparent window owned by another process's window sits just above it,
// 2. it survives that window closing (owned windows die with a *same-thread* owner),
// 3. what happens to it while the owner is minimized,
// 4. how far GetWindowRect's invisible border is from the visible DWM frame.
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const native = require('../src/main/native-windows');

native.dpiAware();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = (name, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);

async function findWindowOf(pid, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = native.topLevelWindows().find(h => native.describe(h)?.pid === pid);
    if (hit) return hit;
    await sleep(100);
  }
  return 0;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 160, height: 136, frame: false, transparent: true, focusable: false, skipTaskbar: true, show: false });
  await win.loadURL('data:text/html,<body style="background:transparent"></body>');
  win.showInactive();
  const self = native.hwndOf(win);

  const pad = spawn('notepad.exe', [], { detached: true });
  const target = await findWindowOf(pad.pid);
  if (!target) { console.log('notepad window not found'); app.exit(1); return; }
  native.focus(target);
  await sleep(400);

  const info = native.describe(target);
  console.log('target', JSON.stringify({ cls: info.cls, exe: info.exe, frame: info.frame, rect: info.rect, captioned: info.captioned }));
  report('DWM frame is inside the window rect', info.frame.left >= info.rect.left && info.frame.top >= info.rect.top,
    `border l=${info.frame.left - info.rect.left} t=${info.frame.top - info.rect.top}`);

  report('owner set', native.ownBy(self, target));
  report('raised above owner', native.raiseAbove(self, target));
  await sleep(200);
  const order = native.topLevelWindows();
  const iSelf = order.indexOf(self), iTarget = order.indexOf(target);
  report('owned window sits above its owner', iSelf >= 0 && iSelf < iTarget, `self z=${iSelf} target z=${iTarget}`);

  // An always-on-top window directly above the owner: he must not become topmost too.
  const pinned = new BrowserWindow({ width: 200, height: 120, alwaysOnTop: true, focusable: false, show: false, frame: false });
  pinned.showInactive();
  await sleep(200);
  native.ownBy(self, target);
  native.raiseAbove(self, target);
  await sleep(150);
  report('never topmost, even under an always-on-top window', !native.describe(self).topmost);
  pinned.destroy();

  native.minimize(target);
  await sleep(600);
  report('minimized owner: reported as minimized', native.describe(target).minimized);
  console.log(`info  owned window visible while owner minimized: ${native.isVisible(self)}`);
  native.restore(target);
  await sleep(600);
  console.log(`info  owned window visible after restore: ${native.isVisible(self)}`);

  // Ask it to close, the way the user's ✕ does.
  console.log(`info  WM_CLOSE posted: ${native.close(target)}`);
  for (let i = 0; i < 80 && native.isWindow(target); i++) await sleep(100);
  report('critter survives its owner closing', !win.isDestroyed() && native.isWindow(self));
  report('owner is gone', !native.isWindow(target));
  // A crash rather than a close: the owner's process is killed outright.
  const pad2 = spawn('notepad.exe', [], { detached: true });
  const t2 = await findWindowOf(pad2.pid);
  native.ownBy(self, t2); native.raiseAbove(self, t2);
  process.kill(pad2.pid);
  for (let i = 0; i < 30 && native.isWindow(t2); i++) await sleep(100);
  report('critter survives its owner being killed', !win.isDestroyed() && native.isWindow(self) && !native.isWindow(t2));
  console.log(`info  visible after owner killed: ${native.isVisible(self)}`);
  native.ownByDesktop(self);
  report('back on the desktop', native.ownerOf(self) !== target);
  console.log(`info  visible after re-own: ${native.isVisible(self)}`);
  app.exit(0);
});
