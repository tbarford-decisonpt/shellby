// Dependency watch: once a week Shellby asks each of your projects' package
// managers what's outdated and what has a known vulnerability, and offers one
// task that bumps them, runs the tests and opens a pull request, in a copy of
// the repository of its own (worktrees.js), so your checkout is left exactly
// as it was.
//
// Opt-in: the checkers ask their registries about your dependencies.
//   npm, pnpm, Yarn 1:  outdated + audit
//   Yarn 2+:            `yarn npm audit` (it has no non-interactive outdated)
//   Python:             pip-audit, over the exact pins in the lockfile
//   Rust:               cargo-audit
//   Go:                 `go list -m -u` + govulncheck
// A checker that isn't installed shows as "needs X" for that project.
//
// Parsers (depwatch-parse.js), projects, words and prompts (depwatch-prompts.js)
// are pure (test/depwatch*.test.js); depwatch-tools.js finds and runs the
// checkers with fixed arguments and never throws; DepWatch decides when.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { EventEmitter } = require('events');
const parse = require('./depwatch-parse');
const tools = require('./depwatch-tools');
const python = require('./depwatch-python');
const { bumpPrompt, routinePrompt } = require('./depwatch-prompts');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const FIRST_TICK_MS = 3 * 60 * 1000;   // not in the rush of startup
const TICK_MS = HOUR;                   // a sleeping PC skips timers: an hourly look catches up
const RETRY_MS = DAY;                   // after a scan that got nothing back (offline)
const MAX_PROJECTS = 12;                // folders; one may have more than one manager
const MAX_RESULTS = 24;
const PEEK_BYTES = 512;
const { SEVERITIES } = parse;
// What `npm init` writes when there are no tests.
const NO_TESTS_RE = /no test specified/i;

const clip = (s, n) => String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').trim().slice(0, n);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const managerOf = r => (typeof r?.manager === 'string' && tools.MANAGERS[r.manager] ? r.manager : 'npm');
const labelOf = r => tools.MANAGERS[managerOf(r)].label;

// npm's own, as they always were.
const parseOutdated = parse.npmOutdated;
const parseAudit = parse.npmAudit;
const { bumpKind } = parse;

/** Whether package.json has a real test script. */
function hasTests(pkgText) {
  const test = parse.parseJson(pkgText)?.scripts?.test;
  return typeof test === 'string' && !!test.trim() && !NO_TESTS_RE.test(test);
}

// ------------------------------------------------------------------ projects

/**
 * Which folders to check: the projects Shellby has seen you work in (streaks)
 * and your recent folders, with a lockfile a checker can read.
 *   projects: [{ key, name }]; recent: [path]; has: (dir, file) -> bool;
 *   peek: (dir, file) -> the start of a file ('' if it can't)
 *   exclude: folders whose insides are never projects (Shellby's own worktree copies)
 * -> [{ key, name, manager, lockfile }]
 */
function candidates({ projects = [], recent = [], has, peek = () => '', exclude = [] }) {
  const seen = new Set();
  const out = [];
  let folders = 0;
  const inside = exclude.filter(d => typeof d === 'string' && d).map(d => path.resolve(d).toLowerCase() + path.sep);
  const add = (key, name) => {
    if (folders >= MAX_PROJECTS || typeof key !== 'string' || !path.isAbsolute(key)) return;
    const k = path.resolve(key).toLowerCase();
    if (seen.has(k) || /[\\/](node_modules|\.venv|venv|target|vendor)([\\/]|$)/i.test(key) || inside.some(d => (k + path.sep).startsWith(d))) return;
    seen.add(k);
    const found = tools.detect({ has: f => has(key, f), peek: f => peek(key, f) });
    if (!found.length) return;
    folders++;
    for (const f of found) out.push({ key, name: clip(name, 60) || path.basename(key), manager: f.manager, lockfile: f.lockfile });
  };
  for (const p of projects) add(p?.key, p?.name);
  for (const dir of recent) add(dir, path.basename(String(dir || '')));
  return out.slice(0, MAX_RESULTS);
}

// ------------------------------------------------------------------ words

const needsAttention = r => !!r?.ok && (r.outdatedTotal > 0 || r.vulnTotal > 0);
const worstSeverity = r => SEVERITIES.find(s => r?.vulns?.[s] > 0) || (r?.vulns?.unrated > 0 ? 'unrated' : null);

function vulnWords(v) {
  const rated = SEVERITIES.filter(s => v[s]).map(s => `${v[s]} ${s}`);
  if (!v.unrated) return rated.join(', ');
  return [...rated, rated.length ? `${v.unrated} more` : plural(v.unrated, 'known vulnerability', 'known vulnerabilities')].join(', ');
}

/** One line for a project: "4 outdated (1 major) · 1 high, 2 moderate". */
function summaryOf(r) {
  if (r?.needs) return `Needs ${r.needs} to check`;
  if (!r?.ok) return r?.error || "Couldn't check";
  const parts = [];
  if (r.outdatedTotal) {
    const majors = (r.outdated || []).filter(p => p.kind === 'major').length;
    parts.push(`${r.outdatedTotal} outdated${majors ? ` (${majors} major)` : ''}`);
  }
  if (r.vulnTotal) parts.push(vulnWords(r.vulns || {}));
  if (!parts.length) {
    if (r.updates === false) return r.missing ? `No known vulnerabilities checked (needs ${r.missing})` : 'No known vulnerabilities';
    if (r.missing) return `All up to date (vulnerabilities need ${r.missing})`;
    return r.notInstalled ? 'No known vulnerabilities (not installed, so updates unchecked)' : 'All up to date';
  }
  if (r.notInstalled && !r.outdatedTotal) parts.push('updates unchecked (not installed)');
  if (r.missing) parts.push(`vulnerabilities need ${r.missing}`);
  return parts.join(' · ');
}

/** The weekly notification, or null when there's nothing to say. */
function noticeOf(results) {
  const flagged = (results || []).filter(needsAttention);
  if (!flagged.length) return null;
  const vulnerable = flagged.filter(r => r.vulnTotal > 0);
  const body = flagged.length === 1
    ? `${flagged[0].name}: ${summaryOf(flagged[0])}.`
    : `${plural(flagged.length, 'project')} could use updates${vulnerable.length ? `, ${vulnerable.length} with known vulnerabilities` : ''}.`;
  const worst = SEVERITIES.find(s => vulnerable.some(r => r.vulns[s] > 0));
  return { title: worst === 'critical' || worst === 'high' ? 'Dependency watch: vulnerable packages' : 'Dependency watch', body, urgent: worst === 'critical' };
}

// ------------------------------------------------------------------ reader

/** npm, found the way it always was: node + npm-cli.js (or Volta's npm.exe), and git. -> { file, pre, git } | null */
function findNpm(env = process.env, { exists = fs.existsSync, platform = process.platform } = {}) {
  const dirs = tools.absoluteDirs(env);
  const exe = platform === 'win32' ? '.exe' : '';
  const gitDir = dirs.find(d => exists(path.join(d, `git${exe}`)));
  const git = gitDir ? path.join(gitDir, `git${exe}`) : null;
  for (const dir of dirs) {
    const node = path.join(dir, `node${exe}`);
    const cli = path.join(dir, platform === 'win32' ? 'node_modules' : path.join('..', 'lib', 'node_modules'), 'npm', 'bin', 'npm-cli.js');
    if (exists(node) && exists(cli)) return { file: node, pre: [cli], git };
    // Volta and friends put a real npm.exe on PATH, which finds its own node.
    // An npm.cmd alone isn't enough: it runs `node` by bare name.
    if (platform === 'win32' && exists(path.join(dir, 'npm.exe'))) return { file: path.join(dir, 'npm.exe'), pre: [], git };
  }
  return null;
}

const findAll = () => tools.findTools(process.env, { findNpm });

/** Runs one step: { stdout, code, timedOut }. Never throws; exit codes are the parser's business. */
function runStep(step) {
  return new Promise(resolve => {
    try {
      execFile(step.file, step.args, {
        cwd: step.cwd, shell: false, windowsHide: true, timeout: step.timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', env: step.env,
      }, (err, stdout) => resolve({ stdout: String(stdout || ''), code: err ? (Number.isInteger(err.code) ? err.code : null) : 0, timedOut: !!err?.killed }));
    } catch {
      resolve({ stdout: '', code: null, timedOut: false });
    }
  });
}

const PARSERS = {
  npm: { outdated: parse.npmOutdated, audit: parse.npmAudit },
  pnpm: { outdated: parse.pnpmOutdated, audit: parse.pnpmAudit },
  yarn: { outdated: parse.yarnOutdated, audit: parse.yarnAudit },
  'yarn-berry': { audit: parse.berryAudit },
  python: { audit: parse.pipAudit },
  cargo: { audit: parse.cargoAudit },
  go: { outdated: parse.goOutdated, audit: parse.govulncheck },
};

const readText = (dir, file, max = 4 * 1024 * 1024) => {
  try {
    const p = path.join(dir, file);
    return fs.statSync(p).size <= max ? fs.readFileSync(p, 'utf8') : '';
  } catch { return ''; }
};

// pip-audit's list of exact pins, in a file of Shellby's own. -> path, or null with nothing pinned.
function writePins(project, read) {
  const pins = python.pinsFrom(project.lockfile, read(project.key, project.lockfile));
  if (!pins.length) return null;
  const file = path.join(os.tmpdir(), `shellby-pins-${crypto.randomBytes(6).toString('hex')}.txt`);
  fs.writeFileSync(file, python.requirementsText(pins), { flag: 'wx' });
  return file;
}

/**
 * One project's result. deps: { tools, run(step), read(dir, file), pins(project, read) -> path | null, now }.
 * Never throws.
 */
async function scanProject(project, { tools: found, run = runStep, read = readText, pins = writePins, now = Date.now(), env = process.env } = {}) {
  const manager = managerOf(project);
  const base = { key: project.key, name: project.name, manager, at: now };
  if (!fs.existsSync(project.key)) return { ...base, ok: false, error: "The folder isn't there any more" };
  const label = tools.MANAGERS[manager].label;
  let requirements = null;
  try {
    if (manager === 'python') {
      if (!found?.pipAudit) return { ...base, ok: false, needs: tools.MANAGERS.python.needs };
      requirements = pins(project, read);
      if (!requirements) return { ...base, ok: false, error: 'Nothing pinned to check: pip-audit needs exact versions (==) or a lockfile' };
    }
    const pkg = tools.MANAGERS[manager].ecosystem === 'node' ? read(project.key, 'package.json') : '';
    const p = tools.plan({ key: project.key, manager }, found || {}, { env, requirements, pkg });
    if (p.needs) return { ...base, ok: false, needs: p.needs };
    const answers = {};
    let timedOut = false;
    for (const step of p.steps) {
      const r = await run(step);
      timedOut = timedOut || !!r.timedOut;
      answers[step.kind] = PARSERS[manager][step.kind]?.(r.stdout, r.code) || null;
    }
    const checksUpdates = p.steps.some(s => s.kind === 'outdated');
    const checksVulns = p.steps.some(s => s.kind === 'audit');
    const { outdated, audit } = answers;
    if (!outdated && !audit) return { ...base, ok: false, error: timedOut ? `${label}'s check took too long` : `${label}'s check didn't answer (offline?)` };
    return {
      ...base, ok: true,
      error: checksUpdates && !outdated ? "Couldn't check for updates" : checksVulns && !audit ? "Couldn't check for vulnerabilities" : null,
      updates: checksUpdates, missing: p.missing || null,
      outdated: outdated?.packages || [], outdatedTotal: outdated?.total || 0, notInstalled: outdated?.notInstalled || 0,
      vulns: audit?.counts || { critical: 0, high: 0, moderate: 0, low: 0, unrated: 0 }, vulnTotal: audit?.total || 0, vulnerable: audit?.packages || [],
      hasTests: pkg ? hasTests(pkg) : null,
    };
  } catch (e) {
    return { ...base, ok: false, error: `Couldn't check: ${clip(e?.message, 120) || 'something went wrong'}` };
  } finally {
    if (requirements) fs.rm(requirements, { force: true }, () => {});
  }
}

// ------------------------------------------------------------------ service

function normalizeSettings(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const at = v => (Number.isFinite(v) && v > 0 ? v : null);
  return {
    enabled: s.enabled === true,
    lastScanAt: at(s.lastScanAt),
    lastAttemptAt: at(s.lastAttemptAt),
    results: Array.isArray(s.results) ? s.results.filter(r => r && typeof r.key === 'string').slice(0, MAX_RESULTS) : [],
    error: typeof s.error === 'string' ? s.error : null,
  };
}

class DepWatch extends EventEmitter {
  /**
   * deps: { config, projects: () => [{ key, name, manager, lockfile }], notify(notice), toPanel(channel, payload),
   *         isOff?: () => bool, findTools?: () => tools, run?: (step), now? }
   */
  constructor(deps) {
    super();
    this.deps = { isOff: () => false, toPanel: () => {}, findTools: findAll, run: runStep, now: () => Date.now(), ...deps };
    this.scanning = null;
    this.timer = null;
    this.first = null;
  }

  get settings() { return normalizeSettings(this.deps.config.get('depWatch')); }

  save(patch) {
    this.deps.config.set({ depWatch: { ...this.settings, ...patch } });
    this.changed();
  }

  changed() { this.deps.toPanel('depwatch', this.view()); }

  // A week after the last full check, or a day after a try that got nothing back.
  nextScanAt(s = this.settings) {
    if (!s.enabled) return null;
    const weekly = s.lastScanAt ? s.lastScanAt + WEEK : this.deps.now();
    const failedSince = s.lastAttemptAt && (!s.lastScanAt || s.lastAttemptAt > s.lastScanAt);
    return failedSince ? Math.max(weekly, s.lastAttemptAt + RETRY_MS) : weekly;
  }

  view() {
    const s = this.settings;
    return {
      enabled: s.enabled, scanning: !!this.scanning, lastScanAt: s.lastScanAt, error: s.error,
      nextScanAt: this.nextScanAt(s),
      results: s.results.map(r => ({ ...r, manager: managerOf(r), label: labelOf(r), summary: summaryOf(r), attention: needsAttention(r), worst: worstSeverity(r) })),
    };
  }

  start() {
    if (this.timer) return;
    this.first = setTimeout(() => this.tick(), FIRST_TICK_MS);
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.first.unref?.();
    this.timer.unref?.();
  }

  stop() {
    clearTimeout(this.first); clearInterval(this.timer);
    this.first = null; this.timer = null;
  }

  due() {
    const s = this.settings;
    const now = this.deps.now();
    if (!s.enabled || this.deps.isOff()) return false;
    if (s.lastAttemptAt && now - s.lastAttemptAt < RETRY_MS) return false;
    return !s.lastScanAt || now - s.lastScanAt >= WEEK;
  }

  tick() {
    if (this.due()) this.scan({ scheduled: true }).catch(() => {});
  }

  setEnabled(on) {
    this.save({ enabled: !!on });
    if (on && !this.settings.lastScanAt) this.scan().catch(() => {}); // turning it on is the first look
    return this.view();
  }

  /** Check every project now. A scheduled scan notifies when something needs doing. */
  scan({ scheduled = false } = {}) {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      await null; // this.scanning is set by now, so the panel hears "checking"
      this.changed();
      const now = this.deps.now();
      // Anything short of a full check counts as a try: the next one is tomorrow, not in an hour.
      const tried = error => this.save({ lastAttemptAt: now, error });
      try {
        const projects = this.deps.projects();
        if (!projects.length) return this.save({ lastAttemptAt: now, results: [], error: 'No projects with a lockfile yet. They show up once Shellby sees you working in one.' });
        const found = this.deps.findTools();
        const results = [];
        for (const p of projects) results.push(await scanProject(p, { tools: found, run: this.deps.run, now }));
        // Nothing answered at all (offline): keep last week's results. A checker
        // that isn't installed is an answer of its own: it says what to install.
        const asked = results.filter(r => !r.needs);
        if (asked.length && asked.every(r => !r.ok)) return tried("The checks couldn't reach their registries. Shellby will try again tomorrow.");
        this.save({ lastScanAt: now, lastAttemptAt: now, results, error: null });
        // Switched off while it was checking: it keeps the results, but says nothing.
        const notice = scheduled && this.settings.enabled ? noticeOf(results) : null;
        if (notice) this.deps.notify(notice);
      } catch (e) {
        tried(`Couldn't check: ${clip(e?.message, 120) || 'something went wrong'}`);
      }
    })().finally(() => { this.scanning = null; this.changed(); }).then(() => this.view());
    return this.scanning;
  }

  /** The last result for a project (and manager, when a folder has more than one), if it's one Shellby checked. */
  result(key, manager = null) {
    if (typeof key !== 'string') return null;
    const list = this.settings.results.filter(r => r.key === key);
    return (typeof manager === 'string' ? list.find(r => managerOf(r) === manager) : list.find(needsAttention) || list[0]) || null;
  }
}

module.exports = {
  DepWatch, parseOutdated, parseAudit, hasTests, bumpKind, candidates, summaryOf, noticeOf, needsAttention, worstSeverity,
  bumpPrompt, routinePrompt, findNpm, npmEnv: tools.npmEnv, scanProject, normalizeSettings, runStep, WEEK, PEEK_BYTES,
};
