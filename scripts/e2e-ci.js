// The end-to-end checks that CI can run: no Claude account, no GitHub sign-in,
// no network. Each one drives the real app over CDP with the fake Claude CLI,
// so this is the only automated coverage the renderer and main's wiring get.
//
//   node scripts/e2e-ci.js              all of them
//   node scripts/e2e-ci.js queue voice  just the ones whose name contains these
//   node scripts/e2e-ci.js --shard=2/6  the second of six shards that take about as long
//
// They run one at a time on purpose: each launches its own Electron and some
// share hook ports. CI splits them across machines with --shard instead.
//
// A script is one of these checks when its first line says what it covers:
// `// ci: queued messages: queue, edit, drain, stop`. Each check names itself,
// so adding one touches no shared list that every branch would merge over.
// Everything else in scripts/ needs a real Claude account, a real GitHub or the
// live registry, and stays a manual check (see docs/DEVELOPMENT.md).
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CI_MARK = /^\/\/ ci: \S/;

/** The checks in `dir`: scripts whose first line is a `// ci:` mark, by name. Sorted, so every machine shards alike. */
function discover(dir = __dirname) {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.js') && f !== path.basename(__filename))
    .filter(f => CI_MARK.test(fs.readFileSync(path.join(dir, f), 'utf8').split('\n', 1)[0]))
    .map(f => f.slice(0, -3))
    .sort();
}
const SUITE = discover();

const TIMEOUT_MS = 5 * 60 * 1000;

// Seconds each check took on CI (scripts/e2e-times.js writes it), to split the
// shards by time: by name, one ran 7.2 minutes while another was done in 3.6.
const TIMES = (() => { try { return require('./e2e-times.json'); } catch { return {}; } })();

/**
 * Splits checks into n shards that take about as long: the slowest first, each
 * onto the shard with the least so far. A check with no time yet counts as a
 * typical one. Ties go by name, so every machine splits alike. Pure.
 */
function balance(checks, n, times = TIMES) {
  const known = checks.map(c => times[c]).filter(Number.isFinite).sort((a, b) => a - b);
  const typical = known.length ? known[Math.floor(known.length / 2)] : 1;
  const secs = c => (Number.isFinite(times[c]) ? times[c] : typical);
  const shards = Array.from({ length: n }, () => ({ checks: [], secs: 0 }));
  for (const c of [...checks].sort((a, b) => secs(b) - secs(a) || (a < b ? -1 : a > b ? 1 : 0))) {
    const s = shards.reduce((min, x) => (x.secs < min.secs ? x : min));
    s.checks.push(c);
    s.secs += secs(c);
  }
  return shards.map(s => s.checks.sort());
}

/**
 * The checks to run: those whose name contains a word asked for (all, with
 * none), then, with --shard=i/n, the ith of n shards balanced by how long each
 * check takes on CI (balance).
 * -> { suite } | { error }. Pure.
 */
function pick(all, args, times = TIMES) {
  const wanted = args.filter(a => !a.startsWith('-'));
  const shardArg = args.find(a => a.startsWith('--shard'));
  const m = shardArg && /^--shard=(\d+)\/(\d+)$/.exec(shardArg);
  if (shardArg && (!m || +m[1] < 1 || +m[1] > +m[2])) return { error: `${shardArg}: use --shard=i/n, with i from 1 to n` };
  const matched = wanted.length ? all.filter(s => wanted.some(w => s.includes(w))) : all;
  if (!matched.length) return { error: `No checks match ${wanted.join(', ')}. Known: ${all.join(', ')}` };
  const suite = m ? balance(matched, +m[2], times)[+m[1] - 1] : matched;
  // Green with nothing run would read as a pass.
  if (!suite.length) return { error: `${shardArg} of ${matched.length} check${matched.length === 1 ? '' : 's'} leaves this shard none to run` };
  return { suite };
}

/**
 * PowerShell that stops what a check left running: every process descended
 * from the check's own (`rootPid`, gone by now), started since `sinceMs`. A
 * check that times out is killed alone, and its Electron and helpers carry on,
 * dozens of them by the end of a run. Windows keeps an orphan's parent pid, so
 * the tree can still be walked; the start time keeps most reused pids out of
 * it. In case one gets in anyway, a process is only stopped if it's also this
 * checkout's: its program is in the checkout (Electron, in node_modules), or
 * it's node running one of the checkout's files (the fake Claude CLI). Prints
 * the pids it stopped. Pure.
 */
function reapScript({ rootPid, sinceMs, root = path.join(__dirname, '..') }) {
  const q = s => `'${String(s).replace(/'/g, "''")}'`;
  return [
    `$since = [DateTimeOffset]::FromUnixTimeMilliseconds(${Number(sinceMs)}).LocalDateTime`,
    `$root = ${q(path.resolve(root) + path.sep)}`,
    '$all = @(Get-CimInstance Win32_Process | Where-Object { $_.CreationDate -ge $since })',
    '$keep = New-Object System.Collections.Generic.HashSet[int]',
    `[void]$keep.Add(${Number(rootPid)})`,
    'for ($i = 0; $i -lt 8; $i++) { foreach ($p in $all) { if ($keep.Contains([int]$p.ParentProcessId)) { [void]$keep.Add([int]$p.ProcessId) } } }',
    `[void]$keep.Remove(${Number(rootPid)})`,
    '$ours = { param($p) ($p.ExecutablePath -and $p.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) -or',
    '  ($p.Name -eq \'node.exe\' -and $p.CommandLine -and $p.CommandLine.IndexOf($root, [StringComparison]::OrdinalIgnoreCase) -ge 0) }',
    'foreach ($p in $all) { if ($keep.Contains([int]$p.ProcessId) -and (& $ours $p)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; $p.ProcessId } }',
  ].join('\n');
}

/** Stop what a check (its pid, and when it started) left behind. -> how many. */
function reap(rootPid, sinceMs) {
  if (process.platform !== 'win32' || !Number.isInteger(rootPid)) return 0;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', reapScript({ rootPid, sinceMs })], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return String(r.stdout || '').split(/\s+/).filter(s => /^\d+$/.test(s)).length;
}

if (require.main !== module) {
  module.exports = { SUITE, discover, pick, balance, reap, reapScript };
  return;
}

const picked = pick(SUITE, process.argv.slice(2));
if (picked.error) {
  console.error(picked.error);
  process.exit(2);
}
const { suite } = picked;

// Each check launches and kills its own Electron, and Windows takes a moment to
// let go of the profile, the ports and the GPU cache. Without a gap, a later
// check occasionally finds no window and sits there until its timeout.
//
// Synchronous on purpose (this script is a spawnSync pipeline, not async), and
// Atomics.wait rather than a spin loop so the gap is idle rather than a busy core.
const sleep = ms => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const SETTLE_MS = 2000;   // after the last Electron goes
const MAX_WAIT_MS = 20000; // ...but never hang on someone else's Electron

// Wait for the Electrons to actually be gone rather than guessing at a duration.
// Capped, because another window on the machine (a dev run, another session's
// checks) is not ours to wait for.
function settle() {
  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq electron.exe', '/NH'], { encoding: 'utf8' });
    if (!/electron\.exe/i.test(r.stdout || '')) break;
    sleep(1000);
  }
  sleep(SETTLE_MS);
}

const run = (name, attempt) => {
  const script = path.join(__dirname, `${name}.js`);
  console.log(`\n${'='.repeat(70)}\n  ${name}${attempt > 1 ? `  (attempt ${attempt})` : ''}\n${'='.repeat(70)}`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [script], { stdio: 'inherit', timeout: TIMEOUT_MS, env: { ...process.env, SHELLBY_E2E: '1' } }); // SHELLBY_E2E: see src/main/test-desktop.js
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const ok = !r.error && r.status === 0;
  console.log(`\n--- ${name}: ${ok ? 'PASS' : 'FAIL'} in ${secs}s`);
  const left = reap(r.pid, started);
  if (left) console.log(`--- ${name} left ${left} process${left === 1 ? '' : 'es'} running; stopped them`);
  return { ok, secs, why: r.error ? r.error.message : r.status === null ? `killed (${r.signal})` : `exit ${r.status}` };
};

const results = [];
for (const name of suite) {
  let r = run(name, 1);
  let flaky = false;
  // One retry, reported as such: these drive a real UI, and a check that only
  // passes on the second go is a problem of its own — but not a reason to fail
  // the build, and hiding it entirely would be worse than naming it.
  if (!r.ok) {
    settle();
    const again = run(name, 2);
    if (again.ok) { flaky = true; r = again; }
  }
  results.push({ name, ...r, flaky });
  settle();
}

console.log(`\n${'='.repeat(70)}`);
for (const r of results) {
  const mark = r.ok ? (r.flaky ? 'FLAKY' : 'PASS ') : 'FAIL ';
  console.log(`  ${mark} ${r.name.padEnd(18)} ${r.secs}s${r.ok ? (r.flaky ? '  (failed once, passed on retry)' : '') : `  (${r.why})`}`);
}
const failed = results.filter(r => !r.ok);
const flaky = results.filter(r => r.flaky);
console.log('='.repeat(70));
if (flaky.length) console.log(`${flaky.length} needed a retry: ${flaky.map(f => f.name).join(', ')}`);
console.log(failed.length ? `${failed.length} of ${results.length} FAILED: ${failed.map(f => f.name).join(', ')}` : `all ${results.length} passed`);
process.exit(failed.length ? 1 : 0);
