// Which dev servers a project can run: the scripts in its package.json, the
// package manager its lockfile says it uses, and a guess at the framework.
//
// package.json comes from a repository anyone could have written. A script's
// *name* is the only thing that ever reaches a command line (runner.js), so
// only plain names get through; a script's body is read only to guess the
// framework and is never run directly. Parsers are pure; read() does the I/O
// and never throws.
const fs = require('fs');
const path = require('path');

const SCRIPT_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;
const MANAGERS = Object.freeze(['npm', 'pnpm', 'yarn', 'bun']);
// Lockfile -> manager, first match wins (a repo with two is usually mid-switch to the first).
const LOCKFILES = [['pnpm-lock.yaml', 'pnpm'], ['bun.lockb', 'bun'], ['bun.lock', 'bun'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm']];
const LIKELY_RE = /^(dev|start|serve|preview|watch|develop)(:[A-Za-z0-9._-]+)?$/;
const NOT_A_SERVER_RE = /^(build|test|lint|format|typecheck|clean|prepare|postinstall|preinstall|install|release|deploy|publish)(:|$)/;
const MAX_SCRIPTS = 40;
const MAX_PKG_BYTES = 512 * 1024;

// The body of a script -> the framework it starts, or null.
const FRAMEWORKS = [
  [/\bnext\s+(dev|start)\b/, 'next'],
  [/\bnux[it]\s+dev\b/, 'nuxt'],
  [/\bastro\s+(dev|preview)\b/, 'astro'],
  [/\bremix\s+(vite:)?dev\b/, 'remix'],
  [/\bsvelte-kit\s+dev\b/, 'sveltekit'],
  [/\bvite(\s+(dev|serve|preview))?(\s|$)/, 'vite'],
  [/\bwebpack(-dev-server|\s+serve)\b/, 'webpack'],
  [/\bng\s+serve\b/, 'angular'],
  [/\breact-scripts\s+start\b/, 'create-react-app'],
  [/\bgatsby\s+develop\b/, 'gatsby'],
  [/\bexpo\s+start\b/, 'expo'],
  [/\bnodemon\b/, 'nodemon'],
  [/\btsx\s+watch\b/, 'tsx'],
  [/\bwrangler\s+dev\b/, 'wrangler'],
  [/\bnetlify\s+dev\b/, 'netlify'],
  [/\bvercel\s+dev\b/, 'vercel'],
  [/\b(node|bun|deno)\s+(--watch\s+)?\S*(server|index|app|main)\.[cm]?[jt]s\b/, 'node'],
];

function frameworkOf(body) {
  const b = String(body || '');
  for (const [re, name] of FRAMEWORKS) if (re.test(b)) return name;
  return null;
}

/** The package manager a folder uses, from the names of the files in it. */
function managerOf(files) {
  const has = files instanceof Set ? f => files.has(f) : f => (files || []).includes(f);
  for (const [file, manager] of LOCKFILES) if (has(file)) return manager;
  return 'npm';
}

/**
 * package.json text + the folder's file names -> { manager, scripts: [{ name, framework, likely }] }
 * or null when it isn't a package.json with any scripts. Likely servers first, then by name.
 */
function scriptsOf(pkgText, files = []) {
  let pkg;
  try { pkg = JSON.parse(String(pkgText || '')); } catch { return null; }
  const raw = pkg && typeof pkg === 'object' && pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : null;
  if (!raw) return null;
  const scripts = [];
  for (const [name, body] of Object.entries(raw)) {
    // A pre/post hook runs with its script, never on its own. Not "preview"
    // though, even when there's a "view" script: it's a server in its own right.
    const isHook = /^(pre|post)/.test(name) && !LIKELY_RE.test(name) && typeof raw[name.replace(/^(pre|post)/, '')] === 'string';
    if (!SCRIPT_RE.test(name) || typeof body !== 'string' || isHook) continue;
    const framework = frameworkOf(body);
    const likely = !NOT_A_SERVER_RE.test(name) && (LIKELY_RE.test(name) || (!!framework && !/\bbuild\b/.test(body)));
    scripts.push({ name, framework, likely });
    if (scripts.length >= MAX_SCRIPTS) break;
  }
  if (!scripts.length) return null;
  const rank = s => (s.likely ? 0 : 1) * 10 + (['dev', 'start', 'serve', 'preview', 'watch', 'develop'].indexOf(s.name.split(':')[0]) + 1 || 9);
  scripts.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  return { manager: managerOf(files), scripts };
}

/** A project folder -> { manager, scripts, installed } or null. Never throws. */
function read(root) {
  try {
    const file = path.join(root, 'package.json');
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_PKG_BYTES) return null;
    const files = new Set(fs.readdirSync(root));
    const found = scriptsOf(fs.readFileSync(file, 'utf8'), files);
    return found ? { ...found, installed: files.has('node_modules') } : null;
  } catch {
    return null;
  }
}

/** The command line for a script: the manager is one of four words, the name has passed SCRIPT_RE. */
function commandFor(manager, script, { install = false } = {}) {
  if (!MANAGERS.includes(manager)) return null;
  if (install) return `${manager} install`;
  if (!SCRIPT_RE.test(String(script || ''))) return null;
  return `${manager} run ${script}`;
}

module.exports = { scriptsOf, read, managerOf, frameworkOf, commandFor, SCRIPT_RE, MANAGERS };
