// Dependency checkups: `npm audit`, `npm outdated`, `pip-audit`, `cargo
// audit` and friends, run by Claude in one of Shellby's tabs (or a session the
// plugin reports). Shellby reads what the command printed, not only how it
// exited: `pip list --outdated` exits 0 with a page of updates, and
// `npm audit | tail` exits 0 whatever it found. A clean audit earns XP and the
// project's 🧼 Fresh mark (stickers.js); every result lands in a small per-
// project ledger the Routines page shows. Pure: no I/O, no clock (callers pass
// `now`). See test/checkup.test.js.
const os = require('os');
const path = require('path');

const DAY = 24 * 60 * 60 * 1000;
const FRESH_FOR = 30 * DAY;     // a clean audit keeps a project "fresh" this long
const PAY_GAP = 20 * 60 * 60 * 1000; // the same project's clean audit pays XP once a day, not every rerun
const MAX_PROJECTS = 60;
const STATUSES = ['clean', 'issues', 'unknown'];
const CHECKS = ['audit', 'outdated'];

// [ecosystem, check, pattern]. First match wins, so the more specific spelling
// (`yarn npm audit`) comes before the general one (`yarn audit`).
const COMMANDS = [
  ['yarn', 'audit', /\byarn\s+(npm\s+)?audit\b/i],
  ['yarn', 'outdated', /\byarn\s+(outdated|upgrade-interactive\s+--dry-run)\b/i],
  ['npm', 'audit', /\bnpm\s+audit\b(?!\s+(fix|signatures)\b)/i],
  ['npm', 'outdated', /\bnpm\s+(outdated|out(?!\w))\b/i],
  ['pnpm', 'audit', /\bpnpm\s+audit\b(?!.*\s--fix\b)/i],
  ['pnpm', 'outdated', /\bpnpm\s+outdated\b/i],
  ['bun', 'audit', /\bbun\s+(pm\s+)?audit\b/i],
  ['bun', 'outdated', /\bbun\s+(pm\s+)?outdated\b/i],
  ['pip', 'audit', /\b(pip-audit|python\d*(\.\d+)?\s+-m\s+pip_audit|safety\s+(check|scan))\b/i],
  ['pip', 'outdated', /\b(pip\d*(\.\d+)?|python\d*(\.\d+)?\s+-m\s+pip)\s+list\b[^\n|;&]*\s(--outdated|-o)\b|\b(poetry\s+show\s+(--outdated|-o)|uv\s+pip\s+list\s+--outdated|pdm\s+outdated)\b/i],
  ['cargo', 'audit', /\bcargo\s+(audit|deny\s+check(\s+advisories)?)\b(?!\s+fix\b)/i],
  ['cargo', 'outdated', /\bcargo\s+(outdated|update\s+--dry-run)\b/i],
  ['go', 'audit', /\bgovulncheck\b/i],
  ['go', 'outdated', /\bgo\s+list\s+[^\n|;&]*-u\b[^\n|;&]*-m\b|\bgo\s+list\s+[^\n|;&]*-m\b[^\n|;&]*-u\b/i],
  ['ruby', 'audit', /\b(bundle\s+audit|bundler-audit)\b/i],
  ['ruby', 'outdated', /\bbundle\s+outdated\b/i],
  ['php', 'audit', /\bcomposer\s+audit\b/i],
  ['php', 'outdated', /\bcomposer\s+outdated\b/i],
  ['dotnet', 'audit', /\bdotnet\s+list\s+[^\n|;&]*\bpackage\b[^\n|;&]*--vulnerable\b/i],
  ['dotnet', 'outdated', /\bdotnet\s+list\s+[^\n|;&]*\bpackage\b[^\n|;&]*--outdated\b/i],
  ['osv', 'audit', /\bosv-scanner\b/i],
];

// What the tools print. `clean` wins over `issues` only when nothing in the
// output says otherwise; a count is the first capture group when there is one.
const CLEAN = [
  /\bfound 0 vulnerabilities\b/i,                       // npm
  /\bno known vulnerabilities found\b/i,                // pnpm, pip-audit
  /\b0 vulnerabilities found\b/i,                       // yarn 1
  /\bno audit suggestions\b/i,                          // yarn berry
  /\bno vulnerabilities found\b/i,                      // govulncheck, bundle-audit, bun
  /\bno security vulnerability advisories found\b/i,    // composer
  /\bno issues found\b/i,                               // osv-scanner
  /\bhas no vulnerable packages\b/i,                    // dotnet --vulnerable
  /\bhas no updates\b/i,                                // dotnet --outdated
  /\ball dependencies are up to date\b/i,               // cargo outdated
  /\bbundle up to date\b/i,                             // bundle outdated
  /\bno vulnerable packages found\b/i,                  // cargo audit
  /\badvisories ok\b/i,                                 // cargo deny
  /\beverything up to date\b/i,
  /\bno (outdated|updates available)\b/i,
];
const ISSUES = [
  /\bfound ([1-9]\d*) (?:\w+ )?(?:severity )?vulnerabilit(?:y|ies)\b/i, // npm, pip-audit ("Found 2 known vulnerabilities")
  /\b([1-9]\d*) vulnerabilit(?:y|ies) found\b/i,                         // pnpm, yarn, cargo audit
  /\bfound ([1-9]\d*) security vulnerability advisor/i,                 // composer
  /\byour code is affected by ([1-9]\d*) vulnerabilit/i,                // govulncheck
  /^vulnerabilities found!/im,                                           // bundle-audit ("No vulnerabilities found" is clean)
  /^\s*([1-9]\d*)\s+(?:(?:low|moderate|high|critical)\s+severity\s+)?vulnerabilit(?:y|ies)\b/im, // npm 7+ ("3 vulnerabilities (1 low, 2 high)")
  /\bhas the following (?:vulnerable packages|updates)\b/i,             // dotnet
  /\boutdated gems included in the bundle\b/i,                          // bundle outdated
  /^\s*severity:\s*(?:low|moderate|high|critical)\b/im,                  // npm audit detail, if the summary was cut off
  /\b([1-9]\d*) (?:low|moderate|high|critical)\b.*vulnerabilit/i,
];

function firstMatch(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const c = command.slice(0, 2000);
  for (const [ecosystem, check, re] of COMMANDS) {
    const m = re.exec(c);
    if (m) return { ecosystem, check, rest: c.slice(m.index + m[0].length) };
  }
  return null;
}

/** Which checkup a shell command is, or null: { ecosystem, check }. */
function checkupOf(command) {
  const m = firstMatch(command);
  return m && { ecosystem: m.ecosystem, check: m.check };
}

// The command's exit code is the checkup's only when nothing after it could
// change that: no pipe (head, tail, Select-Object), no `|| true`, no `; echo`,
// no background `&`. `&&` and redirects like `2>&1` are fine.
function exitMeansNothing(command) {
  const m = firstMatch(command);
  if (!m) return true;
  const rest = m.rest.replace(/\d?>>?&\d/g, '').replace(/&&/g, '');
  return /[|;&\n]|\$LASTEXITCODE/i.test(rest);
}

/** A header-and-rows table: how many rows follow the header line. */
function tableRows(text, header) {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex(l => header.test(l));
  if (at < 0) return null;
  return lines.slice(at + 1).filter(l => l.trim() && !/^[\s\-─━=┌┐└┘├┤┬┴┼│|+]+$/.test(l)).length;
}

// How many packages an `outdated` listing names.
function outdatedCount(ecosystem, text) {
  if (ecosystem === 'npm' || ecosystem === 'yarn' || ecosystem === 'bun') return tableRows(text, /^\s*Package\s+Current\s+Wanted\s+Latest\b/i);
  if (ecosystem === 'pnpm') {
    const rows = text.split(/\r?\n/).filter(l => /^[│|]\s*[@\w]/.test(l) && !/^[│|]\s*Package\b/i.test(l)).length;
    return rows || null;
  }
  if (ecosystem === 'pip') return tableRows(text, /^\s*Package\s+Version\s+Latest\b/i);
  if (ecosystem === 'cargo') return tableRows(text, /^\s*Name\s+Project\s+Compat\s+Latest\b/i);
  if (ecosystem === 'go') return text.split(/\r?\n/).filter(l => /\s\[v[^\]]+\]/.test(l)).length;
  if (ecosystem === 'ruby') return text.split(/\r?\n/).filter(l => /^\s*\*\s+\S+\s+\(newest/.test(l)).length || tableRows(text, /^\s*Gem\s+Current\s+Latest\b/i);
  if (ecosystem === 'php') return text.split(/\r?\n/).filter(l => /^\S+\/\S+\s+\S+\s+[!~=]\s+\S+/.test(l)).length || null;
  if (ecosystem === 'dotnet') return text.split(/\r?\n/).filter(l => /^\s*>\s+\S+/.test(l)).length || null;
  return null;
}

/**
 * What a checkup found, from what it printed and how it exited:
 * { status: 'clean' | 'issues' | 'unknown', count: number | null }.
 *   check: from checkupOf; text: the command's output; isError: it exited non-zero
 */
function readCheckup(check, { text = '', isError = false, command = '' } = {}) {
  const none = { status: 'unknown', count: null };
  if (!check || !CHECKS.includes(check.check)) return none;
  const out = typeof text === 'string' ? text.slice(0, 20000) : '';
  // The tool isn't there at all: nothing was checked.
  if (/\b(command not found|is not recognized as|not installed|no such (sub)?command|unknown command|no such file or directory)\b/i.test(out)
    && !/vulnerabilit|outdated|package/i.test(out.replace(/no such file or directory/ig, ''))) return none;
  if (/\b(ENOLOCK|requires an existing lockfile|lockfile is required|no lockfile found|couldn't find a lockfile|ERR_PNPM_AUDIT_NO_LOCKFILE)\b/i.test(out)) return none;
  if (/\b(ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|network error|audit endpoint returned an error|request to .* failed)\b/i.test(out)) return none;

  for (const re of ISSUES) {
    const m = re.exec(out);
    if (m) {
      // An audit that found some but whose summary didn't say how many.
      const n = m[1] ? Number(m[1]) : null;
      return { status: 'issues', count: Number.isFinite(n) ? n : null };
    }
  }
  if (CLEAN.some(re => re.test(out))) return { status: 'clean', count: 0 };

  if (check.check === 'outdated') {
    // pip's "[notice] A new release of pip is available" isn't a listing.
    const body = out.split(/\r?\n/).filter(l => !/^\s*(\[notice\]|warning:|npm (warn|notice)\b)/i.test(l)).join('\n');
    const n = outdatedCount(check.ecosystem, body);
    if (n > 0) return { status: 'issues', count: n };
    // An empty listing is an up-to-date one, as long as the tool actually ran.
    if ((n === 0 || !body.trim()) && !isError) return { status: 'clean', count: 0 };
  }
  // Nothing recognisable printed: trust the exit code only when nothing could have hidden it.
  if (exitMeansNothing(command)) return none;
  if (check.check === 'audit') return isError ? { status: 'issues', count: null } : { status: 'clean', count: 0 };
  // npm, pnpm, yarn and bundle exit 1 when something is outdated; the rest exit 0 regardless.
  if (isError && ['npm', 'pnpm', 'yarn', 'ruby'].includes(check.ecosystem)) return { status: 'issues', count: null };
  return none;
}

// ------------------------------------------------------------------ where it ran

const unquote = s => s.replace(/^(['"])(.*)\1$/, '$2');

/**
 * The folder a command really runs in: Claude often checks a project from its
 * parent with `cd app && npm audit`, `Set-Location app; ...` or
 * `npm --prefix app audit`. Resolved against the tab's folder.
 */
function commandDir(command, cwd) {
  if (typeof command !== 'string' || typeof cwd !== 'string' || !cwd) return cwd || null;
  const c = command.trim().slice(0, 2000);
  const lead = /^(?:cd|pushd|Set-Location|sl|Push-Location)\s+(?:-(?:LiteralPath|Path)\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)\s*(?:&&|;|\n)/i.exec(c);
  const prefix = /\b(?:npm|pnpm)\s+(?:[^\n|;&]*\s)?(?:--prefix|-C|--dir)\s+("[^"]+"|'[^']+'|[^\s;&|]+)/i.exec(c);
  const manifest = /\bcargo\s+[^\n|;&]*--manifest-path\s+("[^"]+"|'[^']+'|[^\s;&|]+)/i.exec(c);
  let dir = null;
  if (lead) dir = unquote(lead[1]);
  else if (prefix) dir = unquote(prefix[1]);
  else if (manifest) dir = path.dirname(unquote(manifest[1]));
  if (!dir || dir === '-' || /[$`%]/.test(dir)) return cwd; // a variable or "cd -": can't tell, so the tab's folder
  if (/^~(?=[\\/]|$)/.test(dir)) dir = path.join(os.homedir(), dir.slice(1));
  // Git Bash spells C:\ as /c/.
  const drive = /^\/([a-z])(\/.*)?$/i.exec(dir);
  if (drive && process.platform === 'win32') dir = `${drive[1].toUpperCase()}:${drive[2] || '/'}`;
  return path.resolve(cwd, dir);
}

// ------------------------------------------------------------------ the ledger

const time = v => (Number.isFinite(v) && v > 0 ? v : null);
const clip = (s, n) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');
const ECOSYSTEMS = new Set(COMMANDS.map(c => c[0]));

function cleanResult(r) {
  if (!r || typeof r !== 'object' || !STATUSES.includes(r.status) || !time(r.at)) return null;
  const count = Number.isInteger(r.count) && r.count >= 0 && r.count < 100000 ? r.count : null;
  return { at: r.at, status: r.status, count, ecosystem: ECOSYSTEMS.has(r.ecosystem) ? r.ecosystem : null };
}

/** Tolerate anything read from disk. { projects: { [key]: { name, audit, outdated, cleanAt } } } */
function normalizeCheckups(raw) {
  const src = raw && typeof raw === 'object' && raw.projects && typeof raw.projects === 'object' ? raw.projects : {};
  const list = Object.entries(src).slice(0, MAX_PROJECTS * 3).map(([key, p]) => {
    if (!key || key.length > 400 || !p || typeof p !== 'object') return null;
    const audit = cleanResult(p.audit), outdated = cleanResult(p.outdated);
    if (!audit && !outdated) return null;
    return [key, { name: clip(p.name, 60) || path.basename(key) || 'project', audit, outdated, cleanAt: time(p.cleanAt) }];
  }).filter(Boolean);
  const latest = p => Math.max(p.audit?.at || 0, p.outdated?.at || 0);
  list.sort((a, b) => latest(b[1]) - latest(a[1]));
  return { projects: Object.fromEntries(list.slice(0, MAX_PROJECTS)) };
}

/** Is a project "fresh" now: its latest audit came back clean within FRESH_FOR? */
function isFresh(p, now) {
  return !!p?.audit && p.audit.status === 'clean' && now - p.audit.at < FRESH_FOR;
}

/**
 * Record one checkup. A result Shellby couldn't read never replaces a real
 * one. Returns { state, entry, clean, patched, pays }: clean when this was a
 * clean audit, patched when the project's previous audit had found something,
 * pays when it earns XP (a project's clean audit pays once a day).
 *   key: the project's folder (its repository root); result: from readCheckup
 */
function recordCheckup(stateIn, key, name, check, result, now) {
  const s = normalizeCheckups(stateIn);
  const none = { state: s, entry: null, clean: false, patched: false, pays: false };
  if (typeof key !== 'string' || !key || key.length > 400 || !check || !CHECKS.includes(check.check) || !result || !STATUSES.includes(result.status) || !time(now)) return none;
  const before = s.projects[key] || { name: '', audit: null, outdated: null, cleanAt: null };
  const prev = before[check.check];
  if (result.status === 'unknown' && prev && prev.status !== 'unknown') return { ...none, entry: before };
  const entry = {
    ...before,
    name: clip(name, 60) || before.name || path.basename(key) || 'project',
    [check.check]: { at: now, status: result.status, count: Number.isInteger(result.count) ? result.count : null, ecosystem: check.ecosystem },
  };
  const clean = check.check === 'audit' && result.status === 'clean';
  if (clean) entry.cleanAt = now;
  const patched = clean && before.audit?.status === 'issues';
  const pays = clean && (patched || !before.cleanAt || now - before.cleanAt >= PAY_GAP);
  return { state: normalizeCheckups({ projects: { ...s.projects, [key]: entry } }), entry, clean, patched, pays };
}

/** For the Routines page: every project checked, newest first. */
function checkupsView(stateIn, now) {
  const s = normalizeCheckups(stateIn);
  return Object.entries(s.projects).map(([key, p]) => ({
    key, name: p.name, audit: p.audit, outdated: p.outdated, cleanAt: p.cleanAt, fresh: isFresh(p, now),
    ecosystem: p.audit?.ecosystem || p.outdated?.ecosystem || null,
  }));
}

module.exports = {
  FRESH_FOR, MAX_PROJECTS,
  checkupOf, readCheckup, commandDir, normalizeCheckups, recordCheckup, isFresh, checkupsView,
};
