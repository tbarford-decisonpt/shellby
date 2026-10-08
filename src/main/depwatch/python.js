// Python projects for the dependency watch (depwatch.js): the pinned packages
// a project's lockfile names, as plain `name==version` lines for pip-audit.
//
// pip-audit is never pointed at the project itself: resolving a requirements
// file or a pyproject.toml can mean building packages, which runs their code.
// Shellby reads the lockfile here instead, keeps only exact pins that pass
// the name and version grammar, and hands pip-audit a file of those alone
// (--no-deps --disable-pip), so nothing is installed or built. Pure.
const { NAMES, VERSIONS, parseJson } = require('./parse');

const MAX_PINS = 2000;
// A line any longer is no pin (and long runs of spaces are what make a regex crawl).
const MAX_LINE = 1000;

// The files, best first: the first one a project has is the one read.
const LOCKFILES = ['uv.lock', 'poetry.lock', 'pylock.toml', 'Pipfile.lock', 'requirements.txt'];

const pin = (name, version) => (typeof name === 'string' && typeof version === 'string'
  && NAMES.python.test(name) && VERSIONS.python.test(version) ? { name: name.toLowerCase(), version } : null);

/**
 * TOML lockfiles: uv.lock and poetry.lock ([[package]]) and pylock.toml
 * ([[packages]]). Only each block's own name, version and (uv) source lines
 * matter, so this reads those and nothing else. Packages from the project
 * itself (uv's editable, virtual and path sources) or from git aren't on PyPI.
 */
function tomlPins(text) {
  const out = [];
  let cur = null;
  const flush = () => { if (cur && !cur.local) { const p = pin(cur.name, cur.version); if (p) out.push(p); } cur = null; };
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (raw.length > MAX_LINE) continue; // a wheel list: nothing wanted there
    const line = raw.trim();
    if (/^\[\[packages?\]\]$/.test(line)) { flush(); cur = {}; continue; }
    if (!cur) continue;
    if (/^\[/.test(line)) { // a sub-table: [package.source], [packages.vcs] and so on
      if (/^\[packages?\.(vcs|directory|archive)\]$/.test(line)) cur.local = true;
      if (/^\[\[?packages?\./.test(line)) continue;
      flush();
      continue;
    }
    const m = /^(name|version|source)\s*=\s*(.+)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'source') { if (/\b(editable|virtual|directory|path|git)\s*=/.test(m[2])) cur.local = true; continue; }
    if (cur[m[1]] === undefined) { const s = /^"([^"]*)"/.exec(m[2]); if (s) cur[m[1]] = s[1]; }
  }
  flush();
  return out;
}

/** Pipfile.lock: { default: { name: { version: '==1.2.3' } }, develop: {...} }. */
function pipfilePins(text) {
  const data = parseJson(text);
  if (!data || typeof data !== 'object') return [];
  const out = [];
  for (const group of ['default', 'develop']) {
    const g = data[group];
    if (!g || typeof g !== 'object') continue;
    for (const [name, v] of Object.entries(g)) {
      const m = /^==([^=].*)$/.exec(String(v?.version || ''));
      const p = m && pin(name, m[1]);
      if (p) out.push(p);
    }
  }
  return out;
}

/**
 * requirements.txt: only exact pins (`name==1.2.3`, extras and markers
 * dropped). Anything else (ranges, -r, -e, URLs, options) is left out: those
 * would need resolving.
 */
function requirementsPins(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (raw.length > MAX_LINE) continue;
    const hash = raw.indexOf('#');
    const line = (hash >= 0 ? raw.slice(0, hash) : raw).trim().replace(/\\$/, '').trim();
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9,._ -]*\])?\s*==\s*([^\s;,=]+)\s*(?:;.*|--hash=\S+.*)?$/.exec(line);
    const p = m && pin(m[1], m[2]);
    if (p) out.push(p);
  }
  return out;
}

/** -> [{ name, version }], one per name, from one of LOCKFILES. */
function pinsFrom(file, text) {
  const list = file === 'Pipfile.lock' ? pipfilePins(text)
    : file === 'requirements.txt' ? requirementsPins(text)
      : tomlPins(text);
  const seen = new Map();
  for (const p of list) if (!seen.has(p.name)) seen.set(p.name, p);
  return [...seen.values()].slice(0, MAX_PINS);
}

/** The file pip-audit reads: one exact pin a line, nothing else. */
const requirementsText = pins => pins.map(p => `${p.name}==${p.version}`).join('\n') + '\n';

module.exports = { LOCKFILES, pinsFrom, requirementsText, tomlPins, requirementsPins, pipfilePins };
