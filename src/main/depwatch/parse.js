// What each package manager's checker says, read into one shape (depwatch.js):
//   outdated: { packages: [{ name, current, wanted, latest, kind }], total, notInstalled } | null
//   audit:    { counts: { critical, high, moderate, low, unrated }, total, packages: [{ name, severity, direct, fix }] } | null
// null means "that wasn't an answer" (offline, an error, junk). All pure: test/depwatch-parse.test.js
// runs each one over real output saved in test/fixtures/depwatch.
//
// Every name and version comes from a project anyone could have written and
// ends up in a Claude prompt, so only each ecosystem's own name grammar and
// plain versions get through.
const SEVERITIES = ['critical', 'high', 'moderate', 'low'];
const MAX_PACKAGES = 40;

const NAMES = {
  // npm's grammar (old packages may have capitals).
  npm: /^(@[a-z0-9][a-z0-9._~-]{0,100}\/)?[a-z0-9_][a-z0-9._~-]{0,213}$/i,
  // PEP 508 names.
  python: /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/,
  // crates.io names.
  rust: /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/,
  // Go module paths: no spaces, no quotes, no "..".
  go: /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._~/-]{0,250}$/,
};
const VERSIONS = {
  semver: /^\d{1,9}\.\d{1,9}\.\d{1,9}(?:[-+][0-9A-Za-z.-]{1,40})?$/,
  // PEP 440, loosely: digits first, then only what a version may hold.
  python: /^\d{1,9}(?:\.\d{1,9}){0,5}(?:[A-Za-z0-9.+_-]{0,30})?$/,
  // v1.2.3, v0.0.0-20240101000000-abcdef123456, v2.0.0+incompatible.
  go: /^v\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,60})?(?:\+incompatible)?$/,
};

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const semver = v => (typeof v === 'string' && VERSIONS.semver.test(v) ? v : null);

function parseJson(text) {
  try { return JSON.parse(String(text || '').replace(/^﻿/, '').trim() || 'null'); } catch { return null; }
}

// One JSON value per line (yarn, govulncheck's stream is handled on its own).
function parseLines(text) {
  const out = [];
  for (const line of String(text || '').replace(/^﻿/, '').split(/\r?\n/)) {
    const s = line.trim();
    if (!s.startsWith('{')) continue;
    try { out.push(JSON.parse(s)); } catch { /* a stray line */ }
  }
  return out;
}

/** 'major' | 'minor' | 'patch' between two versions. 0.x minors break things, so count as major. */
function bumpKind(from, to) {
  const [a, b] = [from, to].map(v => String(v).replace(/^v/, '').split(/[-+]/)[0].split('.').map(Number));
  if (b[0] !== a[0] || (a[0] === 0 && b[1] !== a[1])) return 'major';
  return b[1] !== a[1] ? 'minor' : 'patch';
}

const rank = s => (SEVERITIES.includes(s) ? SEVERITIES.indexOf(s) : SEVERITIES.length);
const worse = (a, b) => (rank(a) <= rank(b) ? a : b);

function outdatedOf(list) {
  const packages = list.sort((a, b) => a.name.localeCompare(b.name));
  return { packages: packages.slice(0, MAX_PACKAGES), total: packages.length, notInstalled: 0 };
}

/** One entry per package, its worst advisory: -> audit shape. byName: Map name -> { severity, direct, fix }. */
function auditOf(byName) {
  const packages = [...byName.entries()].map(([name, p]) => ({ name, ...p }));
  packages.sort((a, b) => rank(a.severity) - rank(b.severity) || a.name.localeCompare(b.name));
  const counts = { critical: 0, high: 0, moderate: 0, low: 0, unrated: 0 };
  for (const p of packages) counts[SEVERITIES.includes(p.severity) ? p.severity : 'unrated']++;
  return { counts, total: packages.length, packages: packages.slice(0, MAX_PACKAGES) };
}

// Adds an advisory to its package's entry, keeping the worst severity and the best fix.
const FIX_RANK = { yes: 0, major: 1, none: 2 };
/**
 * @param {Map<string, any>} byName
 * @param {string} name
 * @param {{ severity: string, direct?: boolean | null, fix?: string }} entry
 */
function note(byName, name, { severity, direct = null, fix = 'none' }) {
  const was = byName.get(name);
  if (!was) { byName.set(name, { severity, direct, fix }); return; }
  byName.set(name, {
    severity: worse(was.severity, severity),
    direct: was.direct === true || direct === true ? true : was.direct ?? direct,
    fix: FIX_RANK[fix] < FIX_RANK[was.fix] ? fix : was.fix,
  });
}

const severityOf = s => {
  const v = String(s || '').toLowerCase();
  if (v === 'medium') return 'moderate';
  return SEVERITIES.includes(v) ? v : 'unrated';
};

// ------------------------------------------------------------------ npm

/**
 * `npm outdated --json`. Packages that aren't installed (no node_modules) have
 * no current version: they're counted, not listed.
 */
function npmOutdated(text) {
  const data = parseJson(text);
  if (!isObj(data) || data.error) return null;
  const packages = [];
  let notInstalled = 0;
  for (const [name, raw] of Object.entries(data)) {
    const v = Array.isArray(raw) ? raw[0] : raw; // a workspace project lists a package once per workspace
    if (!NAMES.npm.test(name) || !isObj(v)) continue;
    const current = semver(v.current), wanted = semver(v.wanted), latest = semver(v.latest);
    if (!latest) continue;
    if (v.current === undefined) { notInstalled++; continue; }
    if (!current || current === latest) continue;
    packages.push({ name, current, wanted: wanted || current, latest, kind: bumpKind(current, latest) });
  }
  return { ...outdatedOf(packages), notInstalled };
}

/** fixAvailable: true, false, or { name, version, isSemVerMajor } -> 'yes' | 'major' | 'none'. */
function fixOf(f) {
  if (f === true) return 'yes';
  if (isObj(f)) return f.isSemVerMajor ? 'major' : 'yes';
  return 'none';
}

/**
 * `npm audit --json`: npm 7+'s report (vulnerabilities by package), or the
 * older advisories report npm 6, pnpm and Yarn 1 still give (legacyAudit).
 */
function npmAudit(text) {
  const data = parseJson(text);
  if (!isObj(data) || data.error) return null;
  if (isObj(data.advisories)) return legacyAudit(data);
  const meta = data.metadata?.vulnerabilities;
  if (!isObj(meta)) return null;
  const byName = new Map();
  for (const [name, v] of Object.entries(isObj(data.vulnerabilities) ? data.vulnerabilities : {})) {
    if (!NAMES.npm.test(name) || !SEVERITIES.includes(v?.severity)) continue;
    note(byName, name, { severity: v.severity, direct: v.isDirect === true, fix: fixOf(v.fixAvailable) });
  }
  return auditOf(byName);
}

// ------------------------------------------------------------------ the advisories report (npm 6, pnpm, Yarn 1)

// patched_versions "<0.0.0" is how the registry says there is no fix.
const legacyFix = a => (typeof a?.patched_versions === 'string' && a.patched_versions.trim() && !/^<\s*0\.0\.0/.test(a.patched_versions.trim()) ? 'yes' : 'none');

// A path is how the project reaches the package: "lodash" or ".>lodash" is
// direct (Yarn 1, pnpm), "a>b>lodash" isn't.
const isDirectPath = p => typeof p === 'string' && p.replace(/^\.>/, '').split('>').length === 1;

function legacyAdvisory(byName, a) {
  const name = a?.module_name;
  if (typeof name !== 'string' || !NAMES.npm.test(name)) return;
  const paths = (Array.isArray(a.findings) ? a.findings : []).flatMap(f => (Array.isArray(f?.paths) ? f.paths : []));
  note(byName, name, { severity: severityOf(a.severity), direct: paths.length ? paths.some(isDirectPath) : null, fix: legacyFix(a) });
}

/** `{ advisories: { id: advisory }, metadata }`: pnpm audit --json, npm 6. */
function legacyAudit(data) {
  if (!isObj(data) || !isObj(data.advisories) || !isObj(data.metadata)) return null;
  const byName = new Map();
  for (const a of Object.values(data.advisories)) legacyAdvisory(byName, a);
  return auditOf(byName);
}

// ------------------------------------------------------------------ pnpm

/** `pnpm outdated --format json`: like npm's, but every package is installed or it isn't listed. */
function pnpmOutdated(text) {
  return npmOutdated(text);
}

/** `pnpm audit --json`: the advisories report. */
function pnpmAudit(text) {
  return legacyAudit(parseJson(text));
}

// ------------------------------------------------------------------ Yarn 1 (classic)

/** `yarn outdated --json`: lines, one of them { type: 'table', data: { head, body } }. */
function yarnOutdated(text) {
  const lines = parseLines(text);
  const table = lines.find(l => l?.type === 'table' && isObj(l.data) && Array.isArray(l.data.body));
  if (!table) {
    // Nothing outdated prints no table at all, only what it was doing.
    return lines.length && !lines.some(l => l?.type === 'error') ? outdatedOf([]) : null;
  }
  const head = Array.isArray(table.data.head) ? table.data.head.map(h => String(h).toLowerCase()) : [];
  const col = name => head.indexOf(name);
  const [iName, iCur, iWant, iLatest] = ['package', 'current', 'wanted', 'latest'].map(col);
  if ([iName, iCur, iLatest].some(i => i < 0)) return null;
  const packages = [];
  for (const row of table.data.body) {
    if (!Array.isArray(row)) continue;
    const name = row[iName], current = semver(row[iCur]), latest = semver(row[iLatest]);
    if (typeof name !== 'string' || !NAMES.npm.test(name) || !current || !latest || current === latest) continue;
    packages.push({ name, current, wanted: semver(row[iWant]) || current, latest, kind: bumpKind(current, latest) });
  }
  return outdatedOf(packages);
}

/** `yarn audit --json`: an auditAdvisory line per advisory, then an auditSummary. */
function yarnAudit(text) {
  const lines = parseLines(text);
  if (!lines.some(l => l?.type === 'auditSummary')) return null;
  const byName = new Map();
  for (const l of lines) if (l?.type === 'auditAdvisory') legacyAdvisory(byName, l.data?.advisory);
  return auditOf(byName);
}

// ------------------------------------------------------------------ Yarn 2+ (berry)

/**
 * `yarn npm audit --all --recursive --json`: a line per advisory,
 * { value: name, children: { Severity, 'Vulnerable Versions', Dependents, ... } }.
 * A clean project prints nothing and exits 0, so code is needed to tell that
 * from a failure.
 */
function berryAudit(text, code) {
  const lines = parseLines(text);
  if (!lines.length) return code === 0 && !String(text || '').trim() ? auditOf(new Map()) : null;
  const byName = new Map();
  let seen = 0;
  for (const l of lines) {
    const name = l?.value, c = l?.children;
    if (typeof name !== 'string' || !isObj(c)) continue;
    seen++;
    // Yarn 4 lists deprecated packages too ("ID": "<name> (deprecation)"): not vulnerabilities.
    if (!NAMES.npm.test(name) || typeof c.ID === 'string') continue;
    // Dependents name the workspaces that ask for it directly ("app@workspace:.").
    const deps = Array.isArray(c.Dependents) ? c.Dependents : [];
    // Berry's report has no fixed version: one is assumed, as npm audit fix would find it.
    note(byName, name, { severity: severityOf(c.Severity), direct: deps.length ? deps.some(d => /@workspace:/.test(String(d))) : null, fix: 'yes' });
  }
  return seen ? auditOf(byName) : null;
}

// ------------------------------------------------------------------ Python (pip-audit)

/**
 * `pip-audit -f json`: { dependencies: [{ name, version, vulns: [{ id, fix_versions, aliases }] }] }.
 * PyPI's advisories carry no severity, so they count as unrated.
 */
function pipAudit(text) {
  const data = parseJson(text);
  if (!isObj(data) || !Array.isArray(data.dependencies)) return null;
  const byName = new Map();
  for (const d of data.dependencies) {
    if (!isObj(d) || typeof d.name !== 'string' || !NAMES.python.test(d.name) || !Array.isArray(d.vulns) || !d.vulns.length) continue;
    const fix = d.vulns.some(v => Array.isArray(v?.fix_versions) && v.fix_versions.length) ? 'yes' : 'none';
    note(byName, d.name.toLowerCase(), { severity: 'unrated', direct: null, fix });
  }
  return auditOf(byName);
}

// ------------------------------------------------------------------ Rust (cargo-audit)

// CVSS 3.x base score (first.org's specification), for RustSec advisories,
// which carry a vector but no severity. Anything else (CVSS 4.0) is unrated.
const CVSS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 }, AC: { L: 0.77, H: 0.44 }, UI: { N: 0.85, R: 0.62 },
  PR: { U: { N: 0.85, L: 0.62, H: 0.27 }, C: { N: 0.85, L: 0.68, H: 0.5 } }, CIA: { H: 0.56, L: 0.22, N: 0 },
};
const roundUp = x => { const n = Math.round(x * 100000); return n % 10000 === 0 ? n / 100000 : (Math.floor(n / 10000) + 1) / 10; };

/** "CVSS:3.1/AV:N/..." -> its base score, or null. */
function cvssScore(vector) {
  const m = /^CVSS:3\.[01]\/(.+)$/.exec(String(vector || '').trim());
  if (!m) return null;
  const v = Object.fromEntries(m[1].split('/').map(p => p.split(':')));
  const S = v.S === 'C' ? 'C' : v.S === 'U' ? 'U' : null;
  const w = [CVSS.AV[v.AV], CVSS.AC[v.AC], S && CVSS.PR[S][v.PR], CVSS.UI[v.UI], CVSS.CIA[v.C], CVSS.CIA[v.I], CVSS.CIA[v.A]];
  if (w.some(x => x === undefined || x === null)) return null;
  const [av, ac, pr, ui, c, i, a] = w;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = S === 'U' ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
  if (impact <= 0) return 0;
  const exploit = 8.22 * av * ac * pr * ui;
  return roundUp(Math.min((S === 'U' ? 1 : 1.08) * (impact + exploit), 10));
}

function cvssSeverity(vector) {
  const s = cvssScore(vector);
  if (s === null) return 'unrated';
  return s >= 9 ? 'critical' : s >= 7 ? 'high' : s >= 4 ? 'moderate' : s > 0 ? 'low' : 'unrated';
}

/** `cargo-audit audit --json`: { vulnerabilities: { list: [{ advisory, versions: { patched }, package }] } }. */
function cargoAudit(text) {
  const data = parseJson(text);
  const list = data?.vulnerabilities?.list;
  if (!isObj(data) || !Array.isArray(list)) return null;
  const byName = new Map();
  for (const v of list) {
    const name = v?.package?.name;
    if (typeof name !== 'string' || !NAMES.rust.test(name)) continue;
    const patched = Array.isArray(v.versions?.patched) && v.versions.patched.length > 0;
    note(byName, name, { severity: cvssSeverity(v.advisory?.cvss), direct: null, fix: patched ? 'yes' : 'none' });
  }
  return auditOf(byName);
}

// ------------------------------------------------------------------ Go

/** Concatenated JSON objects, pretty-printed or not (go list -json, govulncheck -format json). */
function parseStream(text) {
  const s = String(text || '').replace(/^﻿/, '');
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { if (depth > 0) inStr = true; continue; }
    if (ch === '{') { if (depth++ === 0) start = i; continue; }
    if (ch === '}' && depth > 0 && --depth === 0) {
      try { out.push(JSON.parse(s.slice(start, i + 1))); } catch { /* a broken one */ }
    }
  }
  return out;
}

const goVersion = v => (typeof v === 'string' && VERSIONS.go.test(v) ? v : null);

/** `go list -m -u -json all`: the modules go.mod requires directly that have an Update. */
function goOutdated(text) {
  const mods = parseStream(text).filter(m => isObj(m) && typeof m.Path === 'string');
  if (!mods.length) return null;
  const packages = [];
  for (const m of mods) {
    if (m.Main || m.Indirect || !NAMES.go.test(m.Path)) continue;
    const current = goVersion(m.Version), latest = goVersion(m.Update?.Version);
    if (!current || !latest || current === latest) continue;
    packages.push({ name: m.Path, current, wanted: latest, latest, kind: bumpKind(current, latest) });
  }
  return outdatedOf(packages);
}

/**
 * `govulncheck -scan module -format json`: a stream of config, progress, osv
 * and finding objects. Only findings mean you're affected (osv entries are
 * every advisory it looked at). The Go database carries no severity.
 */
function govulncheck(text) {
  const items = parseStream(text);
  if (!items.some(x => isObj(x?.config))) return null;
  const byName = new Map();
  for (const x of items) {
    const f = x?.finding;
    const mod = Array.isArray(f?.trace) ? f.trace[0]?.module : null;
    if (typeof mod !== 'string' || !NAMES.go.test(mod)) continue;
    note(byName, mod, { severity: 'unrated', direct: null, fix: goVersion(f.fixed_version) ? 'yes' : 'none' });
  }
  return auditOf(byName);
}

module.exports = {
  SEVERITIES, MAX_PACKAGES, NAMES, VERSIONS, parseJson, parseLines, parseStream, bumpKind, auditOf, outdatedOf, note, severityOf,
  npmOutdated, npmAudit, legacyAudit, pnpmOutdated, pnpmAudit, yarnOutdated, yarnAudit, berryAudit, pipAudit,
  cvssScore, cvssSeverity, cargoAudit, goOutdated, govulncheck,
};
