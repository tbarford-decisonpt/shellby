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
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SECONDS = Number(process.argv.find(a => /^\d+$/.test(a))) || 60;
const UNFOCUSED = process.argv.includes('--unfocused');
const SETTLE_MS = 20000; // startup, the first health sample and the skin build are not "idle"
const wait = ms => new Promise(r => setTimeout(r, ms));

// Every electron.exe in our own tree, by walking parent pids up to ours.
function sample(rootPid) {
  const ps = `
    $root = ${rootPid}
    $all = Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'" |
      Select-Object ProcessId, ParentProcessId
    $keep = New-Object System.Collections.Generic.HashSet[int]
    [void]$keep.Add($root)
    for ($i = 0; $i -lt 6; $i++) {
      foreach ($p in $all) { if ($keep.Contains([int]$p.ParentProcessId)) { [void]$keep.Add([int]$p.ProcessId) } }
    }
    # Which kind each process is, from its --type= switch (main has none).
    $kind = @{}
    foreach ($p in (Get-CimInstance Win32_Process -Filter "Name = 'electron.exe'")) {
      if (-not $keep.Contains([int]$p.ProcessId)) { continue }
      $t = 'main'
      if ($p.CommandLine -match '--type=([a-z-]+)') { $t = $matches[1] }
      if ($t -eq 'renderer' -and $p.CommandLine -match 'critter') { $t = 'renderer(critter)' }
      $kind[[int]$p.ProcessId] = $t
    }
    $procs = @(Get-Process -Id ([int[]]$keep) -ErrorAction SilentlyContinue)
    # TotalProcessorTime is a TimeSpan, which Measure-Object won't sum in 5.1.
    $cpu = ($procs | ForEach-Object { $_.TotalProcessorTime.TotalSeconds } | Measure-Object -Sum).Sum
    $ws = ($procs | Measure-Object -Property WorkingSet64 -Sum).Sum
    $per = ($procs | ForEach-Object {
      $k = $kind[[int]$_.Id]; if (-not $k) { $k = 'gone' }
      "{0}:{1}:{2}:{3}" -f $_.Id, $k, $_.TotalProcessorTime.TotalSeconds, $_.WorkingSet64
    }) -join ';'
    "{0},{1},{2},{3}" -f $cpu, $ws, $procs.Count, $per
  `;
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).trim();
  const [cpu, ws, count, per = ''] = out.split(',');
  const byPid = new Map();
  for (const row of per.split(';').filter(Boolean)) {
    const [pid, kind, secs, bytes] = row.split(':');
    byPid.set(Number(pid), { kind, cpuSeconds: Number(secs), bytes: Number(bytes) });
  }
  return { cpuSeconds: Number(cpu), bytes: Number(ws), procs: Number(count), byPid };
}

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-idle-'));
  // No --remote-debugging-port on purpose: an attached DevTools client keeps the
  // renderer and compositor awake, which showed up as 80% of a core and sent an
  // earlier version of this script chasing animations that were never the cost.
  // A fresh profile opens the panel for onboarding, which is the state measured.
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'), [ROOT], {
    stdio: 'ignore',
    env: { ...process.env, SHELLBY_USER_DATA: profile },
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
    await wait(SECONDS * 1000);
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
    console.log('');
    // Where it went: a cost in the GPU process is the critter's animation being
    // composited; one in main is a timer; one in a renderer is script.
    const rows = [...last.byPid]
      .map(([pid, p]) => ({ pid, kind: p.kind, cpu: p.cpuSeconds - (first.byPid.get(pid)?.cpuSeconds ?? p.cpuSeconds), mb: p.bytes / 1e6 }))
      .sort((a, b) => b.cpu - a.cpu);
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
