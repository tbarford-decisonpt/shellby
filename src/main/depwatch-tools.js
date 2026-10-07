// Which package manager a project uses, the checker that asks about it, and how
// to run that checker safely (depwatch.js runs it).
//
// These run inside your projects, unattended, and a project is a folder anyone
// could have written. So:
//   - nothing is run by bare name: Windows looks in the current folder before
//     PATH. Every program is found in absolute folders up front, and there's
//     no shell, and every argument is fixed (no project text in any of them).
//   - the environment is trimmed to what the tool needs, so nothing a project's
//     config could quote (${NPM_TOKEN}) is there to be sent anywhere.
//   - nothing the project ships gets to run. npm: no scripts, a pinned git.
//     pnpm: no .pnpmfile.cjs, and no switching to a pnpm the project names
//     (it would be downloaded from a registry the project picks). Yarn: no
//     yarnPath release and no plugins from the project (YARN_IGNORE_PATH, and
//     a .yarnrc.yml name that's never there), and the Yarn line is pinned so
//     its built-in commands can't fall through to the project's own scripts.
//     Python: pip-audit only reads a list of exact pins Shellby wrote; nothing
//     is installed or built. Go: no toolchain downloads, go.mod left as it is.
//   - a checker that isn't installed is a "needs X" for that project, never an error.
//
// detect, plan and the env builders are pure (test/depwatch-tools.test.js).
const path = require('path');
const fs = require('fs');

const MINUTE = 60000;
const TIMEOUT_MS = 2 * MINUTE;
const SLOW_TIMEOUT_MS = 5 * MINUTE;  // pip-audit asks PyPI once per package
const NO_YARNRC = '.shellby-ignores-yarnrc.yml';
const RUSTSEC_DB = 'https://github.com/RustSec/advisory-db.git';
const PYTHON_LOCKS = ['uv.lock', 'poetry.lock', 'pylock.toml', 'Pipfile.lock', 'requirements.txt'];

/**
 * The managers, in the order a folder is checked for them. label: what the
 * panel calls it. needs: what to install when its checker isn't there.
 */
const MANAGERS = {
  npm: { label: 'npm', ecosystem: 'node', lockfile: 'package-lock.json', needs: 'npm (it comes with Node.js)' },
  pnpm: { label: 'pnpm', ecosystem: 'node', lockfile: 'pnpm-lock.yaml', needs: 'pnpm' },
  yarn: { label: 'Yarn', ecosystem: 'node', lockfile: 'yarn.lock', needs: 'Yarn' },
  'yarn-berry': { label: 'Yarn', ecosystem: 'node', lockfile: 'yarn.lock', needs: 'Corepack (it comes with Node.js 24 and earlier, or `npm install -g corepack`)' },
  python: { label: 'Python', ecosystem: 'python', lockfile: null, needs: 'pip-audit (`pipx install pip-audit` or `uv tool install pip-audit`)' },
  cargo: { label: 'Rust', ecosystem: 'rust', lockfile: 'Cargo.lock', needs: 'cargo-audit (`cargo install cargo-audit --locked`)' },
  go: { label: 'Go', ecosystem: 'go', lockfile: 'go.mod', needs: 'Go' },
};

// ------------------------------------------------------------------ detecting

/**
 * The managers a folder uses, from its lockfiles. has(file) -> bool;
 * peek(file) -> the start of a file, or ''. One JavaScript manager at most:
 * a folder with two lockfiles uses one of them, and npm's is the usual leftover.
 * -> [{ manager, lockfile }]
 */
function detect({ has, peek }) {
  const out = [];
  if (has('package.json')) {
    if (has('package-lock.json')) out.push({ manager: 'npm', lockfile: 'package-lock.json' });
    else if (has('pnpm-lock.yaml')) out.push({ manager: 'pnpm', lockfile: 'pnpm-lock.yaml' });
    else if (has('yarn.lock')) out.push({ manager: /^__metadata:/m.test(peek('yarn.lock')) ? 'yarn-berry' : 'yarn', lockfile: 'yarn.lock' });
  }
  if (has('Cargo.lock')) out.push({ manager: 'cargo', lockfile: 'Cargo.lock' });
  if (has('go.mod')) out.push({ manager: 'go', lockfile: 'go.mod' });
  const py = PYTHON_LOCKS.find(f => has(f));
  if (py) out.push({ manager: 'python', lockfile: py });
  return out;
}

// "yarn@4.9.2+sha512.abc" -> { name: 'yarn', version: '4.9.2' }. Only plain versions.
function packageManagerOf(pkgText) {
  let pm;
  try { pm = JSON.parse(String(pkgText || '').replace(/^﻿/, '')).packageManager; } catch { return null; }
  const m = typeof pm === 'string' && /^(npm|pnpm|yarn)@(\d{1,4}\.\d{1,4}\.\d{1,4})(?:[+-][0-9A-Za-z.:-]*)?$/.exec(pm.trim());
  return m ? { name: m[1], version: m[2] } : null;
}

// ------------------------------------------------------------------ finding the tools

const absoluteDirs = env => String(env.PATH || env.Path || '').split(path.delimiter)
  .map(d => d.trim().replace(/^"|"$/g, '')).filter(d => d && path.isAbsolute(d));

/**
 * Every checker Shellby could use, found up front. -> { node, npm, pnpm, yarn,
 * corepack, pipAudit, cargoAudit, go, govulncheck }, each a launcher
 * { file, pre: [args before ours] } or null. npm also has git (see findNpm).
 */
function findTools(env = process.env, { exists = fs.existsSync, platform = process.platform, findNpm } = {}) {
  const win = platform === 'win32';
  const exe = name => (win ? `${name}.exe` : name);
  const dirs = absoluteDirs(env);
  const home = [env.USERPROFILE, env.HOME].find(h => typeof h === 'string' && path.isAbsolute(h)) || null;
  const abs = d => (typeof d === 'string' && path.isAbsolute(d) ? d : null);
  // Where their installers put them, when that isn't on PATH.
  const extra = {
    cargo: [abs(env.CARGO_HOME) && path.join(env.CARGO_HOME, 'bin'), home && path.join(home, '.cargo', 'bin')],
    go: [abs(env.GOBIN), ...String(env.GOPATH || '').split(path.delimiter).filter(abs).map(d => path.join(d, 'bin')), home && path.join(home, 'go', 'bin')],
    python: [home && path.join(home, '.local', 'bin')],
  };
  const firstIn = (list, name) => {
    for (const d of list.filter(Boolean)) { const f = path.join(d, name); if (exists(f)) return f; }
    return null;
  };
  const program = (name, more = []) => { const f = firstIn([...dirs, ...more], exe(name)); return f ? { file: f, pre: [] } : null; };

  const nodeFile = firstIn(dirs, exe('node'));
  const node = nodeFile ? { file: nodeFile, pre: [] } : null;
  // A JavaScript tool installed with npm -g (or alongside Node): run with node, never its .cmd.
  const script = rel => {
    if (!node) return null;
    for (const d of dirs) {
      const f = path.join(d, ...(win ? ['node_modules'] : ['..', 'lib', 'node_modules']), ...rel);
      if (exists(f)) return { file: node.file, pre: [f] };
    }
    return null;
  };
  return {
    node,
    npm: findNpm ? findNpm(env, { exists, platform }) : null,
    pnpm: script(['pnpm', 'bin', 'pnpm.cjs']) || script(['pnpm', 'bin', 'pnpm.mjs']) || program('pnpm'), // .mjs from pnpm 12
    yarn: script(['yarn', 'bin', 'yarn.js']),
    corepack: script(['corepack', 'dist', 'corepack.js']),
    pipAudit: program('pip-audit', extra.python),
    cargoAudit: program('cargo-audit', extra.cargo),
    go: program('go'),
    govulncheck: program('govulncheck', extra.go),
  };
}

// ------------------------------------------------------------------ environments

// What every checker gets of your environment: enough to run and reach its
// registry through your proxy, and nothing else.
const ENV_KEEP = ['PATH', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS'];
// Your own settings for a toolchain (where its caches and proxies are). A
// project can't set these: they come from your environment only.
const KEEP_FOR = {
  rust: ['CARGO_HOME'],
  go: ['GOPATH', 'GOMODCACHE', 'GOCACHE', 'GOENV', 'GOPROXY', 'GOPRIVATE', 'GONOPROXY', 'GONOSUMDB', 'GOSUMDB', 'GOINSECURE'],
  python: ['SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE'],
};

function baseEnv(env = process.env, more = []) {
  const keep = [...ENV_KEEP, ...more];
  return { ...Object.fromEntries(keep.filter(k => typeof env[k] === 'string').map(k => [k, env[k]])), NoDefaultCurrentDirectoryInExePath: '1' };
}

/** npm: no scripts, git pinned (a project's .npmrc could name its own program as npm's git). */
function npmEnv(npm, env = process.env) {
  return {
    ...baseEnv(env),
    // Settings from the environment beat a project's .npmrc. No git: one that isn't there.
    npm_config_git: npm.git || path.join(path.dirname(npm.file), 'no-git-here'),
    npm_config_ignore_scripts: 'true',
    npm_config_update_notifier: 'false', npm_config_fund: 'false', NO_UPDATE_NOTIFIER: '1',
  };
}

// Corepack: no prompt, nothing written into package.json, and no
// .corepack.env from the project (it could name its own registry to fetch
// Yarn or pnpm from).
const COREPACK_QUIET = { COREPACK_ENABLE_DOWNLOAD_PROMPT: '0', COREPACK_ENABLE_AUTO_PIN: '0', COREPACK_ENABLE_STRICT: '0', COREPACK_ENV_FILE: '0' };

// pnpm's settings that matter, on the command line: a project's
// pnpm-workspace.yaml beats the environment, but not these.
const PNPM_FLAGS = ['--config.ignore-pnpmfile=true', '--config.pm-on-fail=ignore'];

/**
 * pnpm: never the project's .pnpmfile.cjs (pnpm loads it for every command),
 * and never another pnpm. pnpm 10 switches to the version a project's
 * packageManager names unless Corepack runs it (it checks COREPACK_ROOT);
 * pnpm 11+ does unless pm-on-fail is ignore. That switch would download and
 * run a pnpm from whatever registry the project's .npmrc picks.
 * npm_config_* is pnpm 10's spelling, pnpm_config_* 11's.
 */
function pnpmEnv(tool, env = process.env) {
  return {
    ...npmEnv({ file: tool.file, git: null }, env),
    ...COREPACK_QUIET,
    COREPACK_ROOT: env.COREPACK_ROOT || path.join(path.dirname(tool.pre[0] || tool.file), 'shellby-runs-this-pnpm'),
    npm_config_ignore_pnpmfile: 'true', pnpm_config_ignore_pnpmfile: 'true',
    npm_config_manage_package_manager_versions: 'false', pnpm_config_pm_on_fail: 'ignore',
    pnpm_config_update_notifier: 'false',
  };
}

/** Yarn: never the project's yarnPath release, never its plugins. */
function yarnEnv(env = process.env) {
  return {
    ...baseEnv(env),
    ...COREPACK_QUIET,
    YARN_IGNORE_PATH: '1',            // Yarn 1 and 2+: not the release the project ships
    YARN_RC_FILENAME: NO_YARNRC,      // Yarn 2+: not its .yarnrc.yml, so no plugins from it
    YARN_ENABLE_TELEMETRY: '0', YARN_ENABLE_PROGRESS_BARS: '0', YARN_ENABLE_COLORS: '0',
  };
}

const pythonEnv = (env = process.env) => ({ ...baseEnv(env, KEEP_FOR.python), PYTHONNOUSERSITE: '1', PYTHONDONTWRITEBYTECODE: '1' });
const rustEnv = (env = process.env) => ({ ...baseEnv(env, KEEP_FOR.rust), CARGO_TERM_COLOR: 'never' });
// Go: GOTOOLCHAIN=local, or a go.mod's toolchain line downloads and runs another Go;
// -mod=readonly, or `go list` may write go.mod and go.sum.
const goEnv = (env = process.env) => ({ ...baseEnv(env, KEEP_FOR.go), GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly', GOWORK: 'off', CGO_ENABLED: '0' });

// ------------------------------------------------------------------ the plan

/**
 * How to check one project: { steps: [{ kind: 'outdated' | 'audit', file, args, env, cwd, timeout }], missing }
 * or { needs } when nothing can be checked. missing: a checker for one half
 * that isn't there (Go without govulncheck). requirements: the path of the
 * pins file Shellby writes for pip-audit (python only). pkg: package.json's text.
 */
function plan(project, tools, { env = process.env, requirements = null, pkg = '' } = {}) {
  const { key: cwd, manager } = project;
  const m = MANAGERS[manager];
  if (!m) return { needs: 'a package manager Shellby knows' };
  const step = (kind, tool, args, toolEnv, more = {}) => ({ kind, file: tool.file, args: [...tool.pre, ...args], env: toolEnv, cwd, timeout: TIMEOUT_MS, ...more });
  const pm = packageManagerOf(pkg);
  const t = tools;

  if (manager === 'npm') {
    if (!t.npm) return { needs: m.needs };
    const e = npmEnv(t.npm, env);
    return { steps: [step('outdated', t.npm, ['outdated', '--json'], e), step('audit', t.npm, ['audit', '--json'], e)] };
  }
  if (manager === 'pnpm') {
    // Corepack, only for the exact pnpm the project names.
    const tool = t.pnpm || (t.corepack && pm?.name === 'pnpm' ? { file: t.corepack.file, pre: [...t.corepack.pre, `pnpm@${pm.version}`] } : null);
    if (!tool) return { needs: m.needs };
    const e = pnpmEnv(tool, env);
    // Never --fix or --ignore: they write to the project.
    return { steps: [step('outdated', tool, ['outdated', '--format', 'json', ...PNPM_FLAGS], e), step('audit', tool, ['audit', '--json', ...PNPM_FLAGS], e)] };
  }
  if (manager === 'yarn') {
    // Yarn 1 itself, or Corepack asked for a 1.x: `yarn audit` in Yarn 2+ would run the project's "audit" script.
    const v1 = pm?.name === 'yarn' && pm.version.startsWith('1.') ? pm.version : '1';
    const tool = t.yarn || (t.corepack ? { file: t.corepack.file, pre: [...t.corepack.pre, `yarn@${v1}`] } : null);
    if (!tool) return { needs: 'Yarn 1 (`npm install -g yarn`), or Corepack' };
    const e = yarnEnv(env);
    return { steps: [step('outdated', tool, ['outdated', '--json', '--non-interactive'], e), step('audit', tool, ['audit', '--json', '--non-interactive'], e)] };
  }
  if (manager === 'yarn-berry') {
    // Always through Corepack, asked for a 2+ release: in Yarn 1, `yarn npm` would run the project's "npm" script.
    if (!t.corepack) return { needs: m.needs };
    const v = pm?.name === 'yarn' && !pm.version.startsWith('1.') ? pm.version : 'stable';
    const tool = { file: t.corepack.file, pre: [...t.corepack.pre, `yarn@${v}`] };
    return { steps: [step('audit', tool, ['npm', 'audit', '--all', '--recursive', '--json'], yarnEnv(env))] };
  }
  if (manager === 'python') {
    if (!t.pipAudit) return { needs: m.needs };
    if (!requirements) return { needs: m.needs };
    return {
      steps: [step('audit', t.pipAudit, ['-r', requirements, '--no-deps', '--disable-pip', '-f', 'json', '--progress-spinner', 'off'], pythonEnv(env),
        { cwd: path.dirname(requirements), timeout: SLOW_TIMEOUT_MS })],
    };
  }
  if (manager === 'cargo') {
    if (!t.cargoAudit) return { needs: m.needs };
    // The binary itself, never `cargo audit` (a project's .cargo/config.toml
    // can alias "audit"). --file always: with no lockfile it would run
    // `cargo update`, which builds. --db and --url beat a project's
    // .cargo/audit.toml, so it can't point the check at a database of its own.
    const home = [env.CARGO_HOME, env.USERPROFILE && path.join(env.USERPROFILE, '.cargo'), env.HOME && path.join(env.HOME, '.cargo')]
      .find(d => typeof d === 'string' && path.isAbsolute(d));
    if (!home) return { needs: m.needs };
    const args = ['audit', '--json', '--file', path.join(cwd, 'Cargo.lock'), '--db', path.join(home, 'advisory-db'), '--url', RUSTSEC_DB];
    return { steps: [step('audit', t.cargoAudit, args, rustEnv(env), { timeout: SLOW_TIMEOUT_MS })] };
  }
  if (manager === 'go') {
    if (!t.go) return { needs: m.needs };
    const e = goEnv(env);
    const steps = [step('outdated', t.go, ['list', '-m', '-u', '-json', 'all'], e)];
    if (t.govulncheck) steps.push(step('audit', t.govulncheck, ['-scan', 'module', '-format', 'json'], e, { timeout: SLOW_TIMEOUT_MS }));
    return { steps, missing: t.govulncheck ? null : 'govulncheck (`go install golang.org/x/vuln/cmd/govulncheck@latest`)' };
  }
  return { needs: m.needs };
}

module.exports = {
  MANAGERS, PYTHON_LOCKS, NO_YARNRC, detect, packageManagerOf, findTools, absoluteDirs, plan,
  baseEnv, npmEnv, pnpmEnv, yarnEnv, pythonEnv, rustEnv, goEnv,
};
