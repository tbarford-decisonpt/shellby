// Diagnoses the critter's z-order: where it sits among top-level windows, who
// owns it, and whether that matches the desktop host Shellby pins to.
//   node scripts/zorder-probe.js [seconds]   (samples once a second)
const koffi = require('koffi');
const { execSync } = require('child_process');

const user32 = koffi.load('user32.dll');
const EnumProc = koffi.proto('bool __stdcall EnumProc(intptr_t hwnd, intptr_t lParam)');
const EnumWindows = user32.func('bool __stdcall EnumWindows(EnumProc *cb, intptr_t lParam)');
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hwnd)');
const GetWindowThreadProcessId = user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)');
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hwnd, _Out_ uint16_t *buf, int max)');
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint16_t *buf, int max)');
const GetWindow = user32.func('intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t cmd)');
const GetWindowLongW = user32.func('int32_t __stdcall GetWindowLongW(intptr_t hwnd, int idx)');
const FindWindowW = user32.func('intptr_t __stdcall FindWindowW(str16 cls, str16 title)');
const FindWindowExW = user32.func('intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t after, str16 cls, str16 title)');
koffi.struct('RECT', { left: 'int', top: 'int', right: 'int', bottom: 'int' });
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ RECT *r)');

const str = (fn, h) => { const b = new Uint16Array(256); const n = fn(h, b, 256); return String.fromCharCode(...b.slice(0, n)); };
const pidOf = h => { const p = [0]; GetWindowThreadProcessId(h, p); return p[0]; };
const shellbyPids = new Set(execSync('powershell -NoProfile -Command "(Get-Process Shellby,electron -ErrorAction SilentlyContinue).Id"').toString().split(/\s+/).filter(Boolean).map(Number));

function desktopHost() {
  const progman = FindWindowW('Progman', null);
  if (progman && FindWindowExW(progman, 0, 'SHELLDLL_DefView', null)) return progman;
  let w = 0;
  while ((w = FindWindowExW(0, w, 'WorkerW', null))) if (FindWindowExW(w, 0, 'SHELLDLL_DefView', null)) return w;
  return progman;
}

function snapshot() {
  const wins = [];
  const cb = koffi.register((h) => { if (IsWindowVisible(h)) wins.push(h); return true; }, koffi.pointer(EnumProc));
  EnumWindows(cb, 0);
  koffi.unregister(cb);
  const host = desktopHost();
  const rows = wins.map((h, i) => {
    const r = {}; GetWindowRect(h, r);
    return { i, h, pid: pidOf(h), cls: str(GetClassNameW, h), title: str(GetWindowTextW, h), w: r.right - r.left, hgt: r.bottom - r.top, owner: GetWindow(h, 4), exStyle: GetWindowLongW(h, -20) };
  });
  const critter = rows.find(r => shellbyPids.has(r.pid) && r.title === 'Shellby' && r.w < 1200 && r.hgt < 400);
  const hostIdx = rows.findIndex(r => r.h === host);
  return { critter, host, hostIdx, rows };
}

const secs = Number(process.argv[2] || 0);
const s = snapshot();
if (!s.critter) { console.log('critter window not found'); process.exit(1); }
const above = s.rows.slice(0, s.critter.i).filter(r => r.w > 200 && r.hgt > 200 && !shellbyPids.has(r.pid));
console.log(`critter hwnd=${s.critter.h} z-index=${s.critter.i}/${s.rows.length} owner=${s.critter.owner} desktopHost=${s.host} (z ${s.hostIdx}) ownerMatches=${s.critter.owner === s.host}`);
console.log(`exStyle=0x${(s.critter.exStyle >>> 0).toString(16)} (TOPMOST=${!!(s.critter.exStyle & 0x8)}, LAYERED=${!!(s.critter.exStyle & 0x80000)}, TOOLWINDOW=${!!(s.critter.exStyle & 0x80)})`);
console.log(`big app windows above it: ${above.length}; below it: ${s.rows.slice(s.critter.i + 1).filter(r => r.w > 200 && r.hgt > 200 && !shellbyPids.has(r.pid)).length}`);
console.log('top of stack:', s.rows.slice(0, 6).map(r => `${r.i}:${r.cls}${r.title ? `"${r.title.slice(0, 20)}"` : ''}`).join(' | '));
if (secs) {
  let last = s.critter.i;
  const t0 = Date.now();
  const iv = setInterval(() => {
    const n = snapshot();
    if (n.critter && n.critter.i !== last) {
      console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s z-index ${last} -> ${n.critter.i} owner=${n.critter.owner} hostNow=${n.host}`);
      last = n.critter.i;
    }
    if (Date.now() - t0 > secs * 1000) { clearInterval(iv); console.log('done'); }
  }, 1000);
}
