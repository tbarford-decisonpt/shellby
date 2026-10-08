// The end-to-end checks that CI can run: no Claude account, no GitHub sign-in,
// no network. Each one drives the real app over CDP with the fake Claude CLI,
// so this is the only automated coverage the renderer and main's wiring get.
//
//   node scripts/e2e-ci.js              all of them
//   node scripts/e2e-ci.js queue voice  just the ones whose name contains these
//   node scripts/e2e-ci.js --shard=2/4  every fourth one, starting with the second
//
// They run one at a time on purpose: each launches its own Electron and some
// share hook ports. CI splits them across machines with --shard instead. Everything else in scripts/ needs a real Claude account, a
// real GitHub or the live registry, and stays a manual check (see
// docs/DEVELOPMENT.md).
const { spawnSync } = require('child_process');
const path = require('path');

const SUITE = [
  'e2e-queue',        // queued messages: queue, edit, drain, stop, error pauses
  'e2e-context',      // the context meter per tab, what each turn cost, the filling-up and crowded offer, Compact and Start fresh
  'e2e-attachments',  // screenshots as tasks: paste a snip, drop a picture, Claude sees it
  'e2e-feed-scroll',  // your prompt stays visible as the Working bar appears
  'e2e-feed-cap',     // a very long conversation stops growing the DOM
  'e2e-tab-overview', // lots of tabs: edge markers, the list of every open one, closing the quiet ones
  'e2e-questions',    // Claude's multiple-choice questions
  'e2e-editor',       // an edit's diff on its card and row, file links, Ctrl+F, zoom, Ctrl+Shift+P, Settings → Editor
  'e2e-xp',           // XP, levels, the desktop float and the level-up
  'e2e-flaky',        // flaky tests: fail then pass on the same code, the list, his line, Fix it in a copy
  'e2e-bugdex',       // the Bugdex: a failure seen, a fix caught into a jar, no catch for no change, a deleted test or a grep
  'e2e-flaky-issue',  // a flaky test filed as a GitHub issue: no button without GitHub, asks first, labelled and linked
  'e2e-surprises',    // crit hits: red, a fix and green in one turn; the badge, the note, the trophy; cooldown; off
  'e2e-acknowledge',  // new badges: hover to see, Mark all seen, closing unlock cards, Dismiss all
  'e2e-voice',        // what he says, his idle habits, and what outranks him
  'e2e-sound',        // footsteps, bumps, ta-das and the background: on, off, on guard and on a call
  'e2e-life',         // his life between tasks: scenes, gifts, the Finds and Us pages, your day, birthdays, hide and seek, fetch
  'e2e-needs',        // snacks and naps: how a neglected crab looks, the Us card, feed, rinse, tuck in, switching it off
  'e2e-health',       // every health mood, with scripted sensors
  'e2e-tank',         // his tank: decorating by keyboard, what main refuses, the Health porthole, kept after a restart
  'e2e-tank-gauges',  // his tank's gauges in disguise, saved layouts and the seasons, the tidying switch
  'e2e-crab-only',    // "just the crab": Health as home, Claude features hidden
  'e2e-work-mode',    // Work mode: the tools first, a quiet crab, your own settings back when you leave
  'e2e-history-done', // the Done tick in History: filter tabs, Undo, un-ticking
  'e2e-changes',      // a turn's diff and Undo, a worktree per tab, answering from the phone
  'e2e-push',         // Push from the folder menu: take in the remote's work, send yours, a hook's refusal
  'e2e-stickers',     // shell stickers: a push earns one, the slap, a release's marks, the Sticker Book's editor, the crab card
  'e2e-stickers-molt', // stickers through a molt: the favourites move house, the old shell keeps the rest
  'e2e-usage-breakdown', // the meters' breakdown by tab, routine and project
  'e2e-forecast',     // the usage forecast, and messages and routines held for after the reset
  'e2e-notes',        // Notes per project and General: add, edit, move, and Plan / Build / Ask
  'e2e-github-workflows', // the workflow-scope toggle: gated, never on by default
  'e2e-background',   // work a turn left running: the badge, the list, clearing it
  'e2e-settings-tabs', // Settings' four tabs: what's on each, the arrow keys, jumps by name
  'e2e-updates',      // the update button, with a scripted updater standing in for GitHub
  'e2e-integrations', // MCP actions, the shellby command's token, the browser source, editor names
  'e2e-setup',        // Toolbox → Hooks and Memory: confirm-gated hook edits, CLAUDE.md saves and conflicts
  'e2e-snippets',     // prompt snippets: the Toolbox tab, /name in the box, pinned chips, shellby do @name
  'e2e-toolbox',      // the skill list: labelled tabs, a page at a time, where-from and order, editing your own
  'e2e-mods',         // Toolbox → Mods: what one can do, the confirm before it's on, its lines in a conversation (skips without Claude Code)
  'e2e-parity',       // the terminal's conveniences: rewind, ! commands, @ files, Up and Ctrl+R, effort, Rules, MCP
  'e2e-branch',       // try again from any turn: a new tab in its own copy, the fence, compare, keep one
  'e2e-workflows',    // workflows: typed Claude output, the confirm window, ask/stop/resume, a web hook
  'e2e-routine-chat', // Build it with Claude on routines: fill the form, test in a tab, read it, Save switches it on; the workflow chat too
  'e2e-routines',     // Fix with Claude on a failed routine, and a request that needs a workflow handed to the workflow builder
  'e2e-projects',     // projects and dev servers: start, the crab's pill, a crash's approval card, restart, the quit choice
  'e2e-inbox',        // the Projects inbox: stale branches in a throwaway repo, Delete a merged one, Keep the other
  'e2e-streaks',      // streaks and nudges in a throwaway git repo: the streak, the nudge, Pick it up
  'e2e-rooms',        // rooms: a newcomer's short bar, rooms opening as they're earned, Show every screen
  'e2e-quests',       // quests: the card after his first task, a real review finishing one, the line complete, hide and bring back
  'e2e-recap',        // While you were away, from scripted idle readings: finished, failed and asking
  'e2e-team',         // team packs in throwaway repos: noticed, listed, snippets scoped to the repo, Make a team pack
  'e2e-statusline',   // the Claude Code status line, with an isolated status file and settings.json
  'e2e-card',         // the crab card: Share, the preview, the 1200x630 PNG, the Show-Off trophy
  'ui-regressions',   // closing the last tab, themed tooltips, no native titles
  'titlebar-fit',     // the title bar fits at every width in every mode
];

const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The checks to run: those whose name contains a word asked for (all, with
 * none), then, with --shard=i/n, every nth of those starting at the ith. Taking
 * every nth rather than a block spreads the slow checks across the shards.
 * -> { suite } | { error }. Pure.
 */
function pick(all, args) {
  const wanted = args.filter(a => !a.startsWith('-'));
  const shardArg = args.find(a => a.startsWith('--shard'));
  const m = shardArg && /^--shard=(\d+)\/(\d+)$/.exec(shardArg);
  if (shardArg && (!m || +m[1] < 1 || +m[1] > +m[2])) return { error: `${shardArg}: use --shard=i/n, with i from 1 to n` };
  const matched = wanted.length ? all.filter(s => wanted.some(w => s.includes(w))) : all;
  if (!matched.length) return { error: `No checks match ${wanted.join(', ')}. Known: ${all.join(', ')}` };
  const suite = m ? matched.filter((_, k) => k % +m[2] === +m[1] - 1) : matched;
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
  module.exports = { SUITE, pick, reap, reapScript };
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
