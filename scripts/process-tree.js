// CPU time and memory of one Electron's whole process tree, read from Windows
// (no debugger attached, so measuring doesn't change what's measured). Shared by
// scripts/idle-cost.js and scripts/perf-budget.js.
//
//   sampleTree(rootPid) -> { cpuSeconds, bytes, procs, byPid: Map(pid -> { kind, cpuSeconds, bytes }) }
//
// Two samples apart give CPU as a share of one core: (cpu2 - cpu1) / seconds.
// bytes is the working sets added up, which is what Task Manager's details tab
// shows per process. kind is the --type= switch (main has none), with the crab's
// renderer told apart from the panel's.
const { execFileSync } = require('child_process');

// Every electron.exe in our own tree, by walking parent pids up to ours.
function sampleTree(rootPid) {
  const ps = `
    $root = ${Number(rootPid)}
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
  // A cap, so a wedged WMI can't hang a CI step: a sample normally takes ~1 s.
  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', timeout: 30000 }).trim();
  const [cpu, ws, count, per = ''] = out.split(',');
  const byPid = new Map();
  for (const row of per.split(';').filter(Boolean)) {
    const [pid, kind, secs, bytes] = row.split(':');
    byPid.set(Number(pid), { kind, cpuSeconds: Number(secs), bytes: Number(bytes) });
  }
  return { cpuSeconds: Number(cpu), bytes: Number(ws), procs: Number(count), byPid };
}

/**
 * What each process cost between two samples, busiest first:
 *   [{ pid, kind, cpuSeconds, mb }]   (mb as of the second sample)
 */
function perProcess(first, last) {
  return [...last.byPid]
    .map(([pid, p]) => ({ pid, kind: p.kind, cpuSeconds: p.cpuSeconds - (first.byPid.get(pid)?.cpuSeconds ?? p.cpuSeconds), mb: p.bytes / 1e6 }))
    .sort((a, b) => b.cpuSeconds - a.cpuSeconds);
}

module.exports = { sampleTree, perProcess };
