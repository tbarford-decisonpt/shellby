// What Shellby costs when he's doing nothing, which is nearly all the time.
// He sits on the wallpaper layer all day, so idle CPU is the number that decides
// whether a laptop user keeps him.
//
//   node scripts/idle-cost.js [seconds] [--unfocused]        default 60
//
// Default: the panel open and in front, which is the worst case.
// --unfocused: the panel open with another window in front — the common case,
// and the one the `calm` class in panel.css is for. Expect about half.
//
// There is no "panel hidden" mode: nothing can close the panel from out here
// without attaching a debugger, and a debugger keeps the renderer awake and
// inflates every number it touches (that mistake cost an afternoon). For the
// hidden figure, close the panel by hand and watch Task Manager — it is ~1%.
//
// Launches a dev Shellby on a throwaway profile, lets it settle, then samples
// the whole process tree's CPU time and working set over the window. Reports
// percent of ONE core (so 100% = one core saturated) across every process:
// main, the two renderers, the GPU process and the utility processes.
//
// Treat it as a budget: run it before and after anything that touches the
// critter's animation, the panel's timers or the health monitor's interval.
const { spawn, execFileSync } = require('child_process');
const { sampleTree: sample, perProcess } = require('./process-tree');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SECONDS = Number(process.argv.find(a => /^\d+$/.test(a))) || 60;
const UNFOCUSED = process.argv.includes('--unfocused');
const SETTLE_MS = 20000; // startup, the first health sample and the skin build are not "idle"
const wait = ms => new Promise(r => setTimeout(r, ms));

// The GPU process's average share of the 3D engine, sampled once a second for
// the whole window (so this also does the waiting). Every frame a transparent
// window presents lands here: his breathe at 60 fps was a quarter of a 3080 Ti.
// null when there's no GPU process or no counters (a VM, say).
function gpuBusy(byPid, seconds) {
  const pid = [...byPid].find(([, p]) => p.kind === 'gpu-process')?.[0];
  if (!pid) return null;
  try {
    const ps = `$s = (Get-Counter '\\GPU Engine(pid_${pid}_*engtype_3D)\\Utilization Percentage' -SampleInterval 1 -MaxSamples ${seconds} -ErrorAction Stop).CounterSamples
      ($s | Measure-Object CookedValue -Sum).Sum / ${seconds}`;
    return Number(execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim());
  } catch { return null; }
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-idle-'));
  // No --remote-debugging-port on purpose: an attached DevTools client keeps the
  // renderer and compositor awake, which showed up as 80% of a core and sent an
  // earlier version of this script chasing animations that were never the cost.
  // A fresh profile opens the panel for onboarding, which is the state measured.
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT], {
    stdio: 'ignore',
    // A dev run opens the panel behind your windows (main.js openBehind), and an
    // unfocused panel is calm: without this, "in front" measured the calm panel.
    env: { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FOREGROUND: '1' },
  });
  console.log(`pid ${app.pid}, profile ${profile}, panel open and ${UNFOCUSED ? 'behind another window' : 'in front'}`);
  let thief = null;
  try {
    if (UNFOCUSED) {
      // Something else takes focus, leaving the panel open but not in front:
      // notepad is small, always present, and costs nothing itself.
      await wait(6000);
      thief = spawn('notepad.exe', [], { stdio: 'ignore', detached: true });
      console.log('notepad has focus; the panel is open but unfocused');
    }
    console.log(`settling for ${SETTLE_MS / 1000}s…`);
    await wait(SETTLE_MS);
    const first = sample(app.pid);
    console.log(`${first.procs} processes, ${(first.bytes / 1e6).toFixed(0)} MB resident`);
    console.log(`measuring ${SECONDS}s of doing nothing…`);
    const started = Date.now();
    const gpu = gpuBusy(first.byPid, SECONDS);
    await wait(Math.max(0, SECONDS * 1000 - (Date.now() - started)));
    const elapsed = (Date.now() - started) / 1000;
    const last = sample(app.pid);

    const cpu = last.cpuSeconds - first.cpuSeconds;
    const percentOfOneCore = (cpu / elapsed) * 100;
    const percentOfMachine = percentOfOneCore / os.cpus().length;
    console.log('');
    console.log(`  CPU        ${cpu.toFixed(2)}s over ${elapsed.toFixed(0)}s`);
    console.log(`             ${percentOfOneCore.toFixed(1)}% of one core · ${percentOfMachine.toFixed(2)}% of this ${os.cpus().length}-thread machine`);
    console.log(`  Memory     ${(last.bytes / 1e6).toFixed(0)} MB resident (${last.bytes > first.bytes ? '+' : ''}${((last.bytes - first.bytes) / 1e6).toFixed(1)} MB over the window)`);
    console.log(`  Processes  ${last.procs}`);
    if (gpu != null) console.log(`  GPU        ${gpu.toFixed(1)}% of the 3D engine (what Task Manager shows)`);
    console.log('');
    // Where it went: a cost in the GPU process is the critter's animation being
    // composited; one in main is a timer; one in a renderer is script.
    const rows = perProcess(first, last).map(r => ({ ...r, cpu: r.cpuSeconds }));
    console.log('  by process');
    for (const r of rows) {
      console.log(`    ${r.kind.padEnd(18)} ${((r.cpu / elapsed) * 100).toFixed(1).padStart(5)}% of a core   ${r.mb.toFixed(0).padStart(4)} MB`);
    }
    console.log('');
  } finally {
    spawn('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    if (thief) spawn('taskkill', ['/PID', String(thief.pid), '/T', '/F'], { stdio: 'ignore' });
  }
  await wait(800);
  process.exit(0);
})();
