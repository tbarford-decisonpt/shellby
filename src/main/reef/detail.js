// Where a reef signal's count comes from (docs/REEF.md): the top files, rules,
// tests, packages, jobs or nests behind a reading, so "Fix this" (reef/prompts.js)
// can name them. Only names and counts are kept, never a line of the code.
// Pure: it reads text and ledgers it's handed. See test/reef-detail.test.js.
//
// Whole-text patterns use [ \t], never \s, so none can run across lines.

const { SUPPRESS_ADD } = require('../bugdex/cheats');

const TOP = 10;           // places kept per signal
const MAX_NAME = 200;
const MAX_TEXT = 256 * 1024;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const name = v => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_NAME) : '');
const n = v => (Number.isFinite(v) && v >= 0 ? Math.round(v * 10) / 10 : null);

/** A Map of name -> count, as [[name, count]] with the biggest first (ties by name), top `max`. */
function topOf(counts, max = TOP) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, max);
}
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

/** A path the way the project sees it: relative to `root` when it's inside, forward slashes. */
function relTo(file, root) {
  let f = String(file || '').replace(/\\/g, '/');
  const r = String(root || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (r && f.toLowerCase().startsWith(`${r.toLowerCase()}/`)) f = f.slice(r.length + 1);
  return name(f.replace(/^\.\//, ''));
}

// ------------------------------------------------------------------ escape hatches

// What kind of escape a line holds, first match wins.
const KINDS = [
  ['ts-ignore', /@ts-ignore/], ['ts-expect-error', /@ts-expect-error/], ['ts-nocheck', /@ts-nocheck/],
  ['eslint-disable', /eslint-disable/], ['biome-ignore', /biome-ignore/], ['noqa', /noqa/],
  ['type: ignore', /type:[ \t]*ignore/], ['pylint: disable', /pylint:[ \t]*disable/], ['nolint', /nolint/],
  ['#[allow]', /allow\(/], ['SuppressWarnings', /SuppressWarnings/], ['pragma warning disable', /pragma warning disable/],
  ['any', /\bany\b/],
];
const kindOf = line => KINDS.find(([, re]) => re.test(line))?.[0] || 'other';

/**
 * `git grep` lines over a commit ("<commit>:<path>:<text>") -> { count, files, kinds }:
 * how many are escape hatches (held to SUPPRESS_ADD, as countEscapes is), and the
 * files and kinds with the most. Lines without a path still count.
 */
function escapeScan(text, head = '') {
  const files = new Map();
  const kinds = new Map();
  let count = 0;
  const prefix = head ? `${head}:` : '';
  for (const raw of String(text || '').split('\n')) {
    if (!raw) continue;
    let line = raw;
    let file = '';
    if (prefix && line.startsWith(prefix)) {
      const rest = line.slice(prefix.length);
      const at = rest.indexOf(':');
      if (at > 0) { file = rest.slice(0, at); line = rest.slice(at + 1); }
    }
    if (!SUPPRESS_ADD.test(line)) continue;
    count++;
    if (file) bump(files, name(file));
    bump(kinds, kindOf(line));
  }
  return { count, files: topOf(files), kinds: topOf(kinds, 8) };
}

// ------------------------------------------------------------------ lint output

const ESLINT_FILE = /^(?!.*:\d+:)((?:[A-Za-z]:[\\/]|\/)[^\t]*?)[ \t]*$/;
const ESLINT_ROW = /^[ \t]+\d+:\d+[ \t]+(?:error|warning)[ \t]+.*?(?:[ \t]{2,}(\S+))?[ \t]*$/;
const UNIX_ROW = /^((?:[A-Za-z]:)?[^\s:][^:\n]*?\.[A-Za-z0-9]{1,6}):(\d+):(?:\d+:?)?[ \t]+(?:(?:error|warning)[ \t:]+)?([A-Z]+[0-9]+|[a-z][\w-]*\/[\w-]+)?/;
const ARROW_ROW = /^[ \t]*-->[ \t]+([^:\n]+):\d+:\d+/;

/**
 * The files and rules a lint run complained about most, from its output:
 * eslint's stylish blocks (a path, then "  3:5  error  msg  rule"), the
 * "path:line:col: CODE msg" lines ruff, eslint's unix format and many others
 * print, and clippy's "--> src/x.rs:3:5". -> { files, rules } (both may be empty).
 */
function lintDetail(output, root = '') {
  const t = String(output || '').slice(-MAX_TEXT).replace(ANSI_RE, '');
  const files = new Map();
  const rules = new Map();
  let current = '';
  for (const line of t.split(/\r?\n/)) {
    const row = current && line.match(ESLINT_ROW);
    if (row) {
      bump(files, current);
      if (row[1] && /[a-z]/.test(row[1])) bump(rules, name(row[1]));
      continue;
    }
    const file = line.match(ESLINT_FILE);
    if (file) { current = relTo(file[1], root); continue; }
    if (line.trim()) current = current && /^[ \t]/.test(line) ? current : '';
    const unix = line.match(UNIX_ROW);
    if (unix) {
      bump(files, relTo(unix[1], root));
      if (unix[3]) bump(rules, name(unix[3]));
      continue;
    }
    const arrow = line.match(ARROW_ROW);
    if (arrow) bump(files, relTo(arrow[1].trim(), root));
  }
  return { files: topOf(files), rules: topOf(rules, 8) };
}

// ------------------------------------------------------------------ coverage

/**
 * The files with the most uncovered lines, from the coverage file the probe
 * already read: -> [[path, pct, uncovered]] (worst first). Cobertura's XML
 * isn't broken down (it's only read for its total).
 */
function coverageFiles(rel, text, root = '') {
  const rows = [];
  const s = String(text || '');
  if (rel.endsWith('.json')) {
    let j;
    try { j = JSON.parse(s); } catch { return []; }
    if (!isObj(j)) return [];
    for (const [file, v] of Object.entries(j)) {
      if (file === 'total' || !isObj(v?.lines)) continue;
      const total = Number(v.lines.total);
      const covered = Number(v.lines.covered);
      if (!(total > 0) || !(covered >= 0)) continue;
      rows.push([relTo(file, root), n((covered / total) * 100), total - covered]);
    }
  } else if (rel.endsWith('lcov.info')) {
    let file = '';
    let found = 0;
    let hit = 0;
    for (const line of s.split(/\r?\n/)) {
      if (line.startsWith('SF:')) { file = line.slice(3); found = 0; hit = 0; } else if (line.startsWith('LF:')) found = Number(line.slice(3)) || 0;
      else if (line.startsWith('LH:')) hit = Number(line.slice(3)) || 0;
      else if (line === 'end_of_record' && file && found > 0) rows.push([relTo(file, root), n((hit / found) * 100), found - hit]);
    }
  }
  return rows.filter(r => r[0] && r[2] > 0).sort((a, b) => b[2] - a[2] || a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, TOP);
}

// ------------------------------------------------------------------ ledgers Shellby keeps anyway

const CLOSED = new Set(['fixed', 'dismissed']);

/** The open flaky tests in one project, the most flakes first: -> [[test, flakes]]. */
function flakyTests(flakyState, id) {
  const tests = flakyState?.projects?.[id]?.tests;
  if (!isObj(tests)) return [];
  const m = new Map();
  for (const [t, v] of Object.entries(tests)) {
    if (v && Array.isArray(v.flakes) && v.flakes.length && !CLOSED.has(v.status)) m.set(name(t), v.flakes.length);
  }
  return topOf(m);
}

const SEVERITY = ['critical', 'high', 'moderate', 'low', 'unrated'];

/** depwatch's results for a project's clones -> { manager, packages: [{ name, severity, direct, fix }] }, worst first. */
function vulnPackages(results, roots) {
  const want = new Set((roots || []).map(r => String(r).toLowerCase()));
  const mine = (Array.isArray(results) ? results : []).filter(r => r?.ok && typeof r.key === 'string' && want.has(r.key.toLowerCase()));
  const seen = new Map();
  for (const r of mine) {
    for (const p of Array.isArray(r.vulnerable) ? r.vulnerable : []) {
      const pkg = name(p?.name);
      if (!pkg || seen.has(pkg)) continue;
      seen.set(pkg, {
        name: pkg, severity: SEVERITY.includes(p.severity) ? p.severity : 'unrated',
        direct: p.direct === false ? false : p.direct === true ? true : null,
        fix: ['none', 'major', 'minor', 'patch'].includes(p.fix) ? p.fix : null,
      });
    }
  }
  const packages = [...seen.values()].sort((a, b) => SEVERITY.indexOf(a.severity) - SEVERITY.indexOf(b.severity) || a.name.localeCompare(b.name)).slice(0, TOP);
  return { manager: name(mine.find(r => r.manager)?.manager || '').slice(0, 20), packages };
}

/** The failing checks on a repo's pull requests (CI's view): -> { jobs: [[job, prs]], prs: ['#12 title'] }. */
function ciFailing(prs, repo) {
  const want = String(repo || '').toLowerCase();
  const jobs = new Map();
  const list = [];
  for (const pr of Array.isArray(prs) ? prs : []) {
    if (!want || String(pr?.repo || '').toLowerCase() !== want || pr.state !== 'failing') continue;
    for (const j of Array.isArray(pr.failing) ? pr.failing : []) if (name(j)) bump(jobs, name(j));
    if (Number.isInteger(pr.number)) list.push(name(`#${pr.number}${pr.title ? ` ${pr.title}` : ''}`));
  }
  return { jobs: topOf(jobs, 8), prs: list.slice(0, 5) };
}

/**
 * A project's open bug nests (bugdex/nests.js state), the biggest first:
 * -> [{ name, species, count, since, cleared }]. `speciesName` turns an id into its name.
 */
function openNests(nestState, project, speciesName = id => id) {
  const out = [];
  for (const r of Object.values(isObj(nestState) ? nestState : {})) {
    if (!r || r.project !== project || !r.nest) continue;
    out.push({
      name: name(speciesName(r.species) || r.species), species: name(r.species),
      count: Number(r.nest.count) || 1, since: Number(r.nest.since) || 0,
      cleared: Array.isArray(r.cleared) ? r.cleared.length : 0,
    });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, TOP);
}

// ------------------------------------------------------------------ what's stored

const pairs = (v, max) => (Array.isArray(v) ? v : [])
  .filter(e => Array.isArray(e) && name(e[0]) && n(Number(e[1])) !== null)
  .slice(0, max).map(e => (e.length > 2 && n(Number(e[2])) !== null ? [name(e[0]), n(Number(e[1])), n(Number(e[2]))] : [name(e[0]), n(Number(e[1]))]));

/** A stored detail made safe: only the keys a prompt reads, capped. Never throws. */
function normalizeDetail(raw) {
  if (!isObj(raw)) return null;
  const out = {};
  for (const k of ['files', 'kinds', 'rules', 'tests', 'jobs']) {
    const p = pairs(raw[k], TOP);
    if (p.length) out[k] = p;
  }
  if (Array.isArray(raw.prs)) out.prs = raw.prs.map(name).filter(Boolean).slice(0, 5);
  if (Array.isArray(raw.packages)) {
    out.packages = raw.packages.filter(p => isObj(p) && name(p.name)).slice(0, TOP).map(p => ({
      name: name(p.name), severity: SEVERITY.includes(p.severity) ? p.severity : 'unrated',
      ...(typeof p.direct === 'boolean' ? { direct: p.direct } : {}),
      ...(['none', 'major', 'minor', 'patch'].includes(p.fix) ? { fix: p.fix } : {}),
    }));
  }
  if (Array.isArray(raw.nests)) {
    out.nests = raw.nests.filter(x => isObj(x) && name(x.name)).slice(0, TOP).map(x => ({
      name: name(x.name), species: name(x.species), count: Math.max(1, Math.floor(Number(x.count) || 1)),
      since: Number(x.since) > 0 ? Number(x.since) : 0, cleared: Math.max(0, Math.floor(Number(x.cleared) || 0)),
    }));
  }
  for (const k of ['file', 'cmd', 'manager']) if (name(raw[k])) out[k] = name(raw[k]);
  return Object.keys(out).length ? out : null;
}

module.exports = {
  TOP, topOf, relTo, kindOf, escapeScan, lintDetail, coverageFiles,
  flakyTests, vulnPackages, ciFailing, openNests, normalizeDetail,
};
