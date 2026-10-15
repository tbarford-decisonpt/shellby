// Reef health per project (reef/index.js, docs/REEF.md): the readings, where they
// come from, and what a new best pays. Kept out of main.js, which only wires it up.
//
// Readings come from:
//   - lint and test commands Claude already ran (d.onCommandResult)
//   - a `git grep` for escape hatches, once a day per watched project, while
//     you're away from the keyboard (reef/probe.js)
//   - coverage files a test run already wrote, when they change
//   - the flaky ledger, the dependency check and CI, which Shellby keeps anyway
//   - bug nests, which the Bugdex sends (d.reefNote)
// Nothing here runs a project's code.
const path = require('path');
const reef = require('../reef');
const probe = require('../reef/probe');
const gitinfo = require('../gitinfo');
const flaky = require('../flaky');
const nests = require('../bugdex/nests');
const { speciesById } = require('../bugdex/species');

const TICK_MS = 10 * 60 * 1000;   // how often the scheduler looks
const IDLE_MS = 10 * 60 * 1000;   // away this long before the daily grep runs
const PROJECT_CACHE_MS = 10 * 60 * 1000;
const ID_RE = /^[0-9a-f]{12}$/;

/** d: what main shares (main.js `shared`). */
function wireReef(d) {
  const now = () => Date.now();
  const state = () => reef.normalize(d.config?.get('reef'));
  const save = s => d.config.set({ reef: s });
  const testRun = () => !!d.FAKE_CLI || process.env.SHELLBY_E2E === '1';

  // ---------------------------------------------------------------- which project a folder is

  const projects = new Map(); // caseKey(dir) -> { at, p: Promise<{ id, root, name, remote } | null> }
  function projectOf(dir) {
    if (typeof dir !== 'string' || !dir) return Promise.resolve(null);
    const key = path.resolve(dir).toLowerCase();
    const hit = projects.get(key);
    if (hit && now() - hit.at < PROJECT_CACHE_MS) return hit.p;
    const p = gitinfo.projectOf(dir).catch(() => null);
    projects.set(key, { at: now(), p });
    if (projects.size > 200) projects.delete(projects.keys().next().value);
    return p;
  }

  // ---------------------------------------------------------------- a reading, and what it pays

  let lastThriving = null;
  function view() { return reef.reefView(d.config?.get('reef'), now()); }
  function push(event) { d.gameHub.push('reef', view(), event); }

  function note(id, sig, value, ctx = {}) {
    if (!d.config || d.CAPTURE) return null;
    const r = reef.reading(d.config.get('reef'), id, sig, value, now(), ctx);
    if (r.reason === 'off' || r.reason === 'unknown' || r.reason === 'unreadable') return r;
    save(r.state);
    const p = r.state.projects[id];
    if (r.best) {
      d.stat('reef-best');
      const label = `${p.name}: ${reef.signals.SIGNALS[sig].label.toLowerCase()} reached a new best`;
      if (r.paid) d.awardXp('reef', { project: p.name, label });
      push({ kind: 'best', id, sig, name: p.name, polyps: p.polyps, paid: r.paid });
    } else push();
    const n = reef.thrivingCount(r.state, now());
    if (n !== lastThriving) { lastThriving = n; d.stat('reef-thriving', { n }); }
    return r;
  }

  // Where a reading's count came from, for Fix this (reef/detail.js): kept only
  // when the reading itself counted (not another lint command, say).
  const SKIPPED = new Set(['off', 'unknown', 'unreadable', 'other-command']);
  function keepDetail(id, sig, r, det) {
    if (!det || !r || SKIPPED.has(r.reason)) return;
    save(reef.setDetail(d.config.get('reef'), id, sig, det));
  }

  // A reading for whatever project `dir` belongs to, if its reef is watched.
  async function noteFor(dir, sig, value, ctx, det) {
    const proj = await projectOf(dir);
    if (!proj || !state().projects[proj.id]?.on) return null;
    const r = note(proj.id, sig, value, ctx);
    if (det) keepDetail(proj.id, sig, r, det(proj));
    return r;
  }

  // A reading and where it came from, for a project already known to be watched.
  function noteWith(id, sig, value, ctx, det) {
    const r = note(id, sig, value, ctx);
    keepDetail(id, sig, r, det);
    return r;
  }

  // ---------------------------------------------------------------- the commands Claude ran

  d.onCommandResult?.(r => {
    try {
      const dir = r?.dir || r?.cwd || r?.root;
      const output = `${r?.output || ''}\n${r?.tail || ''}`;
      if (!dir || typeof r.command !== 'string') return;
      if (r.kind === 'lint') {
        const n = reef.signals.lintCount(output, { ok: !!r.ok });
        const cmd = r.command.trim().replace(/\s+/g, ' ');
        const where = proj => ({ ...reef.detail.lintDetail(output, proj.root || dir), cmd });
        if (n !== null) noteFor(dir, 'lint', n, { cmd }, where).catch(e => d.log.warn('reef lint', e?.message));
      } else if (r.kind === 'tests') {
        const n = reef.signals.testCount(output);
        if (n !== null) noteFor(dir, 'tests', n).catch(e => d.log.warn('reef tests', e?.message));
        // A test run may have written a fresh coverage file.
        projectOf(dir).then(p => p && state().projects[p.id]?.on && readCoverage(p.id)).catch(() => {});
      }
    } catch (e) { d.log.warn('reef command', e?.message || String(e)); }
  });

  // Bug nests and anything else that has a number for a reef: (project, sig, value).
  // project: its id, { id } or a folder in it.
  // The Bugdex sends ('nest', { open, cleared }): the reef's nests signal is the open count.
  d.onReefNote?.((project, rawSig, rawValue) => {
    const isNest = rawSig === 'nest' || rawSig === 'nests';
    const sig = isNest ? 'nests' : rawSig;
    const value = isNest && rawValue && typeof rawValue === 'object' ? rawValue.open : rawValue;
    const id = typeof project === 'string' && ID_RE.test(project) ? project : project && typeof project === 'object' && ID_RE.test(project.id) ? project.id : null;
    if (id) { if (state().projects[id]?.on) noteWith(id, sig, value, {}, isNest ? nestDetail(id) : null); return; }
    const dir = typeof project === 'string' ? project : project?.root;
    if (dir) noteFor(dir, sig, value, {}, isNest ? proj => nestDetail(proj.id) : null).catch(() => {});
  });

  // The open nests behind the count, from the Bugdex's own ledger (config bugNests).
  function nestDetail(id) {
    const raw = d.config.get('bugNests')?.nests;
    return { nests: reef.detail.openNests(nests.normalizeNests(raw), id, sp => speciesById(sp)?.name || sp) };
  }

  // ---------------------------------------------------------------- what's read from the folder

  async function readCoverage(id) {
    const p = state().projects[id];
    if (!p?.on || !p.root) return;
    const c = await probe.coverage(p.root, p.covMtime);
    if (!c) return;
    save(reef.mark(d.config.get('reef'), id, { covMtime: c.mtime }));
    noteWith(id, 'coverage', c.pct, {}, { file: c.file, files: c.files || [] });
  }

  async function readEscapes(id) {
    const p = state().projects[id];
    if (!p?.on || !p.root) return;
    save(reef.mark(d.config.get('reef'), id, { grepDay: reef.dayKey(now()) })); // once a day, even when it can't
    const r = await probe.escapes(p.root);
    if (r.skipped) { if (r.skipped !== 'no-repo') d.log.info('reef', `escape count skipped for ${p.name}: ${r.skipped}`); return; }
    const sig = p.signals.escapes;
    // Only worth asking git how much was deleted when this would be a new best.
    const better = sig && reef.signals.beats('escapes', sig.best, r.count);
    const deletedShare = better && p.head ? await probe.deletedShare(p.root, p.head, r.head) : 0;
    noteWith(id, 'escapes', r.count, { head: r.head, deletedShare }, r.detail);
  }

  // The ledgers Shellby keeps anyway: open flaky tests, vulnerable packages, CI runs.
  function readLedgers(id) {
    const p = state().projects[id];
    if (!p?.on) return;
    const flakyState = flaky.normalizeFlaky(d.config.get('flaky'));
    const fl = reef.signals.openFlaky(flakyState, id);
    if (fl !== null) noteWith(id, 'flaky', fl, {}, { tests: reef.detail.flakyTests(flakyState, id) });
    const results = d.depWatch?.view?.()?.results;
    const roots = p.root ? [p.root] : [];
    const vulns = reef.signals.vulnsFor(results, roots);
    if (vulns !== null) noteWith(id, 'deps', vulns, {}, reef.detail.vulnPackages(results, roots));
    readCi(id);
  }

  function readCi(id) {
    const p = state().projects[id];
    if (!p?.on || !p.remote) return;
    const repo = p.remote.split('/').slice(1).join('/').toLowerCase();
    let s = d.config.get('reef');
    let changed = false;
    const prs = d.ci?.view?.()?.prs || [];
    // The checks failing now, kept for Fix this (the last ones seen stay once they pass).
    const failing = reef.detail.ciFailing(prs, repo);
    if (failing.jobs.length) { s = reef.setDetail(s, id, 'ci', failing); changed = true; }
    let runs = false;
    for (const pr of prs) {
      if (String(pr.repo || '').toLowerCase() !== repo || !pr.sha || (pr.state !== 'passing' && pr.state !== 'failing')) continue;
      const r = reef.noteCiRun(s, id, pr.sha, pr.state === 'passing');
      if (r.changed) { s = r.state; changed = true; runs = true; }
    }
    if (!changed) return;
    save(s);
    if (!runs) return;
    const rate = reef.signals.ciRate(reef.normalize(s).projects[id].ciRuns);
    if (rate !== null) note(id, 'ci', rate);
  }

  async function readAll(id, { grep = false } = {}) {
    readLedgers(id);
    await readCoverage(id);
    if (grep) await readEscapes(id);
  }

  // ---------------------------------------------------------------- once a day, while you're away

  let busy = false;
  function idleMs() {
    try { return require('electron').powerMonitor.getSystemIdleTime() * 1000; } catch { return 0; }
  }
  async function tick({ force = false } = {}) {
    if (busy || !d.config || d.CAPTURE) return;
    busy = true;
    try {
      const today = reef.dayKey(now());
      const idle = force || idleMs() >= IDLE_MS;
      for (const [id, p] of Object.entries(state().projects)) {
        if (!p.on) continue;
        await readAll(id, { grep: idle && p.grepDay !== today });
      }
    } catch (e) {
      d.log.warn('reef', e?.message || String(e));
    } finally { busy = false; }
  }
  if (!testRun()) { const t = setInterval(() => tick(), TICK_MS); t.unref?.(); }

  // ---------------------------------------------------------------- the panel

  async function watch(payload) {
    const root = typeof payload?.root === 'string' ? payload.root : null;
    const proj = root && await projectOf(root);
    if (!proj) return { ...view(), error: "That isn't a git repository on this PC." };
    const on = payload.on !== false;
    const r = reef.enable(d.config.get('reef'), proj.id, { name: proj.name, root: proj.root, remote: proj.remote }, on, now());
    if (r.full) return { ...view(), error: `A reef can be watched in up to ${reef.MAX_PROJECTS} projects.` };
    save(r.state);
    if (on) {
      d.questDone?.('reef-on');
      // A first look straight away, so the page shows where it starts.
      readAll(proj.id, { grep: !reef.normalize(r.state).projects[proj.id].grepDay }).catch(e => d.log.warn('reef', e?.message));
    }
    push();
    return view();
  }

  function act(action, payload) {
    if (action === 'watch') return watch(payload);
    if (action === 'unwatch') return watch({ ...payload, on: false });
    if (action === 'check') {
      const id = payload?.id;
      if (!ID_RE.test(id || '') || !state().projects[id]?.on) return view();
      return readAll(id, { grep: state().projects[id].grepDay !== reef.dayKey(now()) }).then(view);
    }
    // Fix this (a signal) or Fix the worst ('worst'): the prompt and the folder
    // to open a conversation in. Nothing is sent from here.
    if (action === 'fix') {
      const id = payload?.id;
      const sig = payload?.sig;
      if (!ID_RE.test(id || '') || !(sig === 'worst' || reef.signals.isSignal(sig))) return { error: 'Nothing to fix there.' };
      const p = state().projects[id];
      const f = p && reef.fixPrompt(d.config.get('reef'), id, sig);
      if (!f) return { error: 'That one is already at its best.' };
      return { sig: f.sig, prompt: f.prompt, root: p.root, name: p.name };
    }
    // Test runs only: a reading as if it had come in (scripts/e2e-reef.js).
    if (action === 'dev-reading' && testRun()) {
      const r = noteWith(payload?.id, payload?.sig, payload?.value, payload?.ctx || {}, payload?.detail || null);
      return { ...view(), result: r && { best: r.best, paid: r.paid, baseline: r.baseline, reason: r.reason } };
    }
    return null;
  }

  d.gameHub.register('reef', { get: () => view(), act });

  /** For the tank (ipc/tank.js): each reef's coral as tank.library({ coral }) wants it. */
  const reefCorals = () => reef.corals(d.config?.get('reef'), now());

  return { reefCorals, reefTick: tick };
}

module.exports = { wireReef };
