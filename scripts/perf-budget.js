// "Shellby made this slower": the numbers that decide whether he's worth
// keeping on a laptop, measured on an isolated profile with the fake Claude CLI
// and held against scripts/perf-budgets.js. Exits 1 when one is over budget, and
// writes every number to a JSON file CI keeps as an artifact.
//
//   node scripts/perf-budget.js [--out file] [--cold N] [--samples N]
//                               [--settle S] [--idle S] [--only cold,latency,idle]
//
// What it measures, and how:
//
//   cold start   electron.exe spawned -> the frame after the crab's first drawing
//                (the 'shellby:crab-painted' mark in critter.js), and -> the panel
//                booted ('shellby:panel-ready' in boot.js). Median of --cold launches
//                (default 3), each a brand-new profile that has done onboarding,
//                so nothing opens the panel on its own.
//   panel open   the crab clicked -> the panel visible and focused, plus two frames
//                so it has painted. Median of --samples (default 5), after a first
//                open that's reported on its own: it lays out a never-shown panel.
//   first token  Enter in the box -> Claude's reply in the feed (painted), minus the
//                fake CLI's scripted delay: what Shellby adds between you and Claude
//                (today mostly the per-turn snapshot of the folder, for its diff).
//                One unbudgeted cold turn first (it starts the CLI), then --samples.
//   idle CPU     share of one core, every process added up, the idle-cost.js way:
//                two launches with NO debugger attached (one keeps the renderer
//                awake and turns 1% into 80%), each settled for --settle seconds
//                (default 20) and then measured for --idle seconds (default 20).
//                Panel closed: an onboarded profile. Panel open but unfocused: a
//                fresh profile opens it for onboarding, then Notepad takes focus.
//   memory       resident (working sets added up) at the end of each idle window.
//
// Wall clocks: the script's Date.now() and the renderers' performance.timeOrigin
// are both the system clock, so spawn-to-mark times line up across processes.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sampleTree, perProcess } = require('./process-tree');
const { summarize, evaluate, formatTable, resultFile, verdict, retryPhases } = require('./perf-report');
const BUDGETS = require('./perf-budgets');

const ROOT = path.join(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const FAKE_CLAUDE = path.join(ROOT, 'test', 'fixtures', 'fake-claude.js');
const PORT = 9395;
const SCRIPTED_DELAY_MS = 100;   // "wait 100 …": the fake CLI's own pause before it answers
const BOOT_TIMEOUT_MS = 60000;   // a cold runner can take a while for the first launch
const SHOW_TIMEOUT_MS = 8000;
const EVAL_TIMEOUT_MS = 30000;   // past the longest wait inside an evaluate (a reply, 20 s)
const REPLY_TIMEOUT_MS = 20000;
const THIEF_AFTER_MS = 6000;     // as idle-cost.js: the panel is up and focused by then

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const num = (name, fallback) => { const n = Number(arg(name)); return Number.isFinite(n) && n > 0 ? n : fallback; };
const OUT = path.resolve(arg('out', path.join(ROOT, 'perf-result.json')));
const COLD_RUNS = num('cold', 3);
const SAMPLES = num('samples', 5);
const SETTLE_S = num('settle', 20);
const IDLE_S = num('idle', 20);
const ONLY = String(arg('only', 'cold,latency,idle')).split(',');
const wait = ms => new Promise(r => setTimeout(r, ms));
const say = msg => console.log(`[perf] ${msg}`);

// ---------------------------------------------------------------- launching

/** A throwaway profile; `onboarded` skips the first-run panel. */
const profiles = [];
function makeProfile(onboarded) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-perf-'));
  if (onboarded) fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ onboarded: true }));
  profiles.push(dir);
  return dir;
}

/** Every profile this run made, once nothing is using them. Best effort. */
function removeProfiles() {
  for (const dir of profiles.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows still holding a file: temp gets cleaned anyway */ }
  }
}

const running = new Set();

function launch(profile, { cdp = false, foreground = false } = {}) {
  const args = [ROOT, ...(cdp ? [`--remote-debugging-port=${PORT}`] : [])];
  // SHELLBY_REAL_DESKTOP: the fake CLI alone makes it a test run (src/main/test-desktop.js), which would skip the savings measured here.
  const env = { ...process.env, SHELLBY_USER_DATA: profile, SHELLBY_FAKE_CLAUDE: FAKE_CLAUDE, SHELLBY_REAL_DESKTOP: '1' };
  if (foreground) env.SHELLBY_FOREGROUND = '1';
  const startedAt = Date.now();
  const child = spawn(ELECTRON, args, { stdio: 'ignore', env });
  running.add(child);
  child.once('exit', () => running.delete(child));
  return { child, startedAt };
}

/** End one process tree we started, and wait until Windows has let it go. */
async function stop(child) {
  if (!child || child.exitCode != null) return;
  const gone = new Promise(r => child.once('exit', r));
  spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  await Promise.race([gone, wait(10000)]);
  await wait(1500); // the profile, the port and the GPU cache, as e2e-ci.js settles
}

// ---------------------------------------------------------------- CDP

async function findTargets(deadline) {
  while (Date.now() < deadline) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const critter = list.find(t => t.url.endsWith('critter.html'));
      const panel = list.find(t => t.url.endsWith('panel.html'));
      if (critter && panel) return { critter, panel };
    } catch { /* starting */ }
    await wait(100);
  }
  throw new Error('no crab or panel window to attach to');
}

async function attach(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error(`couldn't attach to ${target.url}`)); });
  let id = 0;
  const pending = new Map();
  ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); pending.delete(m.id); };
  // A window that crashes or closes mid-run answers nothing: every waiting
  // evaluate resolves to undefined rather than hanging the CI step.
  const settleAll = () => { for (const done of pending.values()) done({}); pending.clear(); };
  ws.onclose = settleAll;
  ws.onerror = settleAll;
  const ev = expression => new Promise(resolve => {
    if (ws.readyState !== WebSocket.OPEN) return resolve(undefined);
    const i = ++id;
    const timer = setTimeout(() => { pending.delete(i); resolve(undefined); }, EVAL_TIMEOUT_MS);
    pending.set(i, m => { clearTimeout(timer); resolve(m.result?.result?.value); });
    ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
  return { ev, close: () => ws.close() };
}

async function until(page, expr, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await page.ev(expr);
    if (v != null && v !== false) return v;
    await wait(50);
  }
  return null;
}

// The epoch time a performance mark was made at, or null if it hasn't been.
const markAt = name => `(() => { const e = performance.getEntriesByName(${JSON.stringify(name)})[0]; return e ? performance.timeOrigin + e.startTime : null; })()`;

// ---------------------------------------------------------------- phases

/** One launch: spawn -> crab painted, spawn -> panel booted. Returns the pages for more. */
async function coldStart() {
  const { child, startedAt } = launch(makeProfile(true), { cdp: true, foreground: true });
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let critter, panel, crabAt, panelAt;
  try {
    const targets = await findTargets(deadline);
    critter = await attach(targets.critter);
    panel = await attach(targets.panel);
    crabAt = await until(critter, markAt('shellby:crab-painted'), deadline - Date.now());
    panelAt = await until(panel, markAt('shellby:panel-ready'), deadline - Date.now());
  } catch (e) {
    critter?.close();
    panel?.close();
    await stop(child);
    throw e;
  }
  return {
    child, critter, panel,
    coldStartMs: crabAt == null ? null : crabAt - startedAt,
    appReadyMs: panelAt == null ? null : panelAt - startedAt,
  };
}

// Resolves with the epoch time of the second frame after the panel is shown
// (visible, or focused if that comes first), or null after SHOW_TIMEOUT_MS.
const ARM_SHOWN = `window.__perfShown = new Promise(resolve => {
  let done = false;
  const fire = () => {
    if (done || document.visibilityState !== 'visible') return;
    done = true;
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.timeOrigin + performance.now())));
  };
  document.addEventListener('visibilitychange', fire);
  window.addEventListener('focus', fire);
  setTimeout(() => { if (!done) { done = true; resolve(null); } }, ${SHOW_TIMEOUT_MS});
}); true`;

/**
 * The crab clicked -> the panel shown and painted: { first, warm }. The first
 * open lays out a panel nobody has seen yet and is reported on its own
 * (unbudgeted); the budget is on the SAMPLES opens after it.
 */
async function panelOpen(critter, panel) {
  let first = null;
  const warm = [];
  for (let i = 0; i <= SAMPLES; i++) {
    if (await panel.ev("document.visibilityState === 'visible'")) {
      await panel.ev('shellby.hide()');
      if (!(await until(panel, "document.visibilityState === 'hidden'", 3000))) { say('the panel would not hide; skipping a sample'); continue; }
    }
    await wait(500);
    await panel.ev(ARM_SHOWN);
    const clickAt = await critter.ev('(() => { const t = performance.timeOrigin + performance.now(); shellby.critter.click(); return t; })()');
    const shownAt = await panel.ev('window.__perfShown');
    const ms = shownAt == null || clickAt == null ? null : shownAt - clickAt;
    // By index, not position: a skipped first sample mustn't turn a warm one into "first".
    if (i === 0) first = ms;
    else warm.push(ms);
  }
  return { first, warm };
}

// Types `text` and presses Enter; resolves with ms until a reply containing
// `marker` is in the feed and painted, or null.
const SEND = (text, marker) => `(async () => {
  const feed = SB.activeTab().el;
  const seen = new Promise(resolve => {
    const look = () => [...feed.querySelectorAll('.msg.assistant')].some(e => e.textContent.includes(${JSON.stringify(marker)}));
    const obs = new MutationObserver(() => { if (look()) { obs.disconnect(); requestAnimationFrame(() => resolve(performance.now())); } });
    obs.observe(feed, { childList: true, subtree: true, characterData: true });
    setTimeout(() => { obs.disconnect(); resolve(null); }, ${REPLY_TIMEOUT_MS});
  });
  const box = SB.$('input');
  box.value = ${JSON.stringify(text)};
  box.dispatchEvent(new Event('input'));
  const sentAt = performance.now();
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const at = await seen;
  return at == null ? null : at - sentAt;
})()`;

/** Shellby's own latency between Enter and Claude's first word. */
async function firstToken(panel) {
  await panel.ev("SB.setView('chat'); true");
  await wait(300);
  const cold = await panel.ev(SEND('perf-cold', 'perf-cold'));
  await until(panel, '!SB.activeTab().busy', REPLY_TIMEOUT_MS);
  const warm = [];
  for (let i = 0; i < SAMPLES; i++) {
    // Delimited, so perf-1 can't match the reply to perf-10.
    const ms = await panel.ev(SEND(`wait ${SCRIPTED_DELAY_MS} perf-${i}.`, `perf-${i}.`));
    warm.push(ms == null ? null : ms - SCRIPTED_DELAY_MS);
    await until(panel, '!SB.activeTab().busy', REPLY_TIMEOUT_MS);
    await wait(200);
  }
  return { cold, warm };
}

/** Idle with no debugger: settle, then two samples of the process tree. */
async function idle({ open }) {
  const { child } = launch(makeProfile(!open), { foreground: open });
  let thief = null;
  try {
    if (open) {
      // As idle-cost.js --unfocused: the panel opens for onboarding and is
      // focused, then something else takes focus, so it's open but calm.
      await wait(THIEF_AFTER_MS);
      thief = spawn('notepad.exe', [], { stdio: 'ignore' });
      running.add(thief);
      thief.once('exit', () => running.delete(thief));
    }
    await wait(SETTLE_S * 1000);
    const first = sampleTree(child.pid);
    const t0 = Date.now();
    await wait(IDLE_S * 1000);
    const last = sampleTree(child.pid);
    const seconds = (Date.now() - t0) / 1000;
    if (open && thief.exitCode != null) say('Notepad closed early, so the panel may still have had focus');
    const share = s => Math.round((s / seconds) * 1000) / 10;
    return {
      cpu: share(last.cpuSeconds - first.cpuSeconds),
      mb: Math.round(last.bytes / 1e6),
      procs: last.procs,
      byProcess: perProcess(first, last).map(p => ({ kind: p.kind, cpu: share(p.cpuSeconds), mb: Math.round(p.mb) })),
    };
  } finally {
    if (thief) await stop(thief);
    await stop(child);
  }
}

// ---------------------------------------------------------------- run

// Which launches each metric comes from, so a retry repeats only those.
const PHASE_OF = {
  coldStartMs: 'cold', appReadyMs: 'cold',
  panelOpenMs: 'latency', panelFirstOpenMs: 'latency', firstTokenMs: 'latency', firstTurnColdMs: 'latency',
  idleClosedCpu: 'idle', idleOpenCpu: 'idle', memClosedMB: 'idle', memOpenMB: 'idle',
};
const fmt = list => list.map(v => (v == null ? '—' : Math.round(v))).join(', ');

/** Run the asked-for phases -> { measured, raw, idle, errors }. */
async function measure(phases) {
  const raw = {};
  const idleRuns = {};
  const errors = [];
  const doCold = phases.includes('cold');
  const doLatency = phases.includes('latency');
  const launches = doCold ? COLD_RUNS : doLatency ? 1 : 0;
  if (doCold) Object.assign(raw, { coldStartMs: [], appReadyMs: [] });
  for (let i = 0; i < launches; i++) {
    let run = null;
    try {
      say(`launch ${i + 1} of ${launches}`);
      run = await coldStart();
      if (doCold) { raw.coldStartMs.push(run.coldStartMs); raw.appReadyMs.push(run.appReadyMs); }
      say(`  crab painted ${fmt([run.coldStartMs])} ms, panel ready ${fmt([run.appReadyMs])} ms after spawn`);
      // The latencies on the last launch: by then disk caches are as warm as they get.
      if (doLatency && i === launches - 1) {
        const open = await panelOpen(run.critter, run.panel);
        Object.assign(raw, { panelFirstOpenMs: [open.first], panelOpenMs: open.warm });
        say(`  panel open: ${fmt(open.warm)} ms (first ${fmt([open.first])} ms)`);
        const ft = await firstToken(run.panel);
        Object.assign(raw, { firstTurnColdMs: [ft.cold], firstTokenMs: ft.warm });
        say(`  first token overhead: ${fmt(ft.warm)} ms (cold turn ${fmt([ft.cold])} ms)`);
      }
    } catch (e) {
      errors.push(e.message);
      say(`  failed: ${e.message}`);
    } finally {
      run?.critter.close();
      run?.panel.close();
      if (run) await stop(run.child);
    }
  }
  if (phases.includes('idle')) {
    for (const [name, open] of [['closed', false], ['open', true]]) {
      try {
        say(`idle, panel ${open ? 'open behind Notepad' : 'closed'}: settling ${SETTLE_S}s, measuring ${IDLE_S}s`);
        idleRuns[name] = await idle({ open });
        say(`  ${idleRuns[name].cpu}% of one core, ${idleRuns[name].mb} MB`);
      } catch (e) {
        errors.push(e.message);
        say(`  failed: ${e.message}`);
      }
    }
  }
  const measured = {};
  for (const key of ['coldStartMs', 'appReadyMs', 'panelOpenMs', 'panelFirstOpenMs', 'firstTokenMs', 'firstTurnColdMs']) {
    if (phases.includes(PHASE_OF[key])) measured[key] = summarize(raw[key]);
  }
  if (phases.includes('idle')) {
    Object.assign(measured, {
      idleClosedCpu: idleRuns.closed?.cpu ?? null,
      idleOpenCpu: idleRuns.open?.cpu ?? null,
      memClosedMB: idleRuns.closed?.mb ?? null,
      memOpenMB: idleRuns.open?.mb ?? null,
    });
  }
  return { measured, raw, idle: idleRuns, errors };
}

(async () => {
  if (process.platform !== 'win32') { console.error('perf-budget measures Windows processes; run it on Windows.'); process.exit(2); }
  if (!fs.existsSync(ELECTRON)) { console.error('No Electron binary: run node node_modules/electron/install.js'); process.exit(2); }
  const t0 = Date.now();
  const phases = ['cold', 'latency', 'idle'].filter(p => ONLY.includes(p));
  // Only the budgets for what was asked for: --only idle shouldn't fail on cold start.
  const budgets = { ...BUDGETS, metrics: Object.fromEntries(Object.entries(BUDGETS.metrics).filter(([k]) => phases.includes(PHASE_OF[k]))) };
  const first = await measure(phases);
  let rows = evaluate(first.measured, budgets);

  // One retry, of only the phases that went over, reported as such (as e2e-ci.js
  // does): a shared runner has slow minutes, and a red build blocks a release.
  // A number that's over twice running is a real regression.
  const again = retryPhases(rows, PHASE_OF);
  let second = null;
  if (again.length) {
    say(`over budget: measuring ${again.join(', ')} once more`);
    second = await measure(again);
    const retried = new Set(Object.keys(second.measured));
    rows = evaluate({ ...first.measured, ...second.measured }, budgets).map(r => (retried.has(r.key) ? { ...r, retried: true } : r));
  }
  // The run that decides is the last one: a first attempt's error that the retry
  // measured past is kept in the artifact, but doesn't fail the job.
  const errors = second ? second.errors : first.errors;
  const allErrors = second ? [...first.errors.map(e => `first attempt: ${e}`), ...second.errors] : first.errors;
  const idleRuns = { ...first.idle, ...(second?.idle || {}) };

  console.log(`\n${'='.repeat(70)}\n  Shellby's performance budget (${os.cpus().length} threads, ${os.cpus()[0]?.model?.trim() || 'unknown CPU'})\n${'='.repeat(70)}`);
  console.log(formatTable(rows));
  for (const [name, r] of Object.entries(idleRuns)) {
    console.log(`\n  idle, panel ${name}, by process`);
    for (const p of r.byProcess) console.log(`    ${p.kind.padEnd(18)} ${p.cpu.toFixed(1).padStart(5)}% of a core   ${String(p.mb).padStart(4)} MB`);
  }
  if (again.length) console.log(`\n  ${again.join(', ')} needed a retry`);
  if (allErrors.length) console.log(`\n  errors: ${allErrors.join('; ')}`);

  const result = resultFile(rows, {
    at: new Date().toISOString(),
    seconds: Math.round((Date.now() - t0) / 1000),
    machine: { platform: process.platform, release: os.release(), cpu: os.cpus()[0]?.model?.trim() || null, threads: os.cpus().length, memGB: Math.round(os.totalmem() / 1024 ** 3), ci: !!process.env.CI },
    options: { coldRuns: COLD_RUNS, samples: SAMPLES, settleSeconds: SETTLE_S, idleSeconds: IDLE_S, scriptedDelayMs: SCRIPTED_DELAY_MS, phases },
    tolerance: BUDGETS.tolerance,
    retried: again,
    samples: { ...first.raw, ...(second?.raw || {}) },
    firstAttempt: second ? first.measured : undefined,
    idle: idleRuns,
    errors: allErrors,
  });
  fs.writeFileSync(OUT, `${JSON.stringify(result, null, 2)}\n`);
  removeProfiles();
  console.log(`\n  wrote ${OUT}`);
  process.exit(verdict(rows).ok && !errors.length ? 0 : 1);
})().catch(async e => {
  console.error(e);
  for (const c of [...running]) await stop(c);
  process.exit(2);
});
