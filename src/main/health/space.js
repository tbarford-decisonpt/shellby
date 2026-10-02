// What Docker, WSL and the package managers are costing you. On a developer's
// PC these are usually the three biggest things on the drive, and none of them
// show up as something you can point at: Docker's layers live inside a virtual
// disk, WSL's too, and the npm/cargo/pip caches are scattered through AppData.
//
// Shellby reads them so he can overstuff his shell when there are tens of
// gigabytes sitting there to reclaim, and so "Ask Shellby why" knows where to
// look. Everything here is read-only: nothing is pruned, deleted or stopped.
//
// Parsers are pure (and tested); the readers below them do the I/O and never
// throw. A missing tool is just null, which is the normal case -- plenty of
// people have no Docker and no WSL.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const GB = 1024 ** 3;
const DOCKER_TIMEOUT_MS = 6000;   // the daemon can be slow to answer when it is starting
const WSL_TIMEOUT_MS = 5000;
const TASKLIST_TIMEOUT_MS = 4000;
const WALK_MS = 2000;             // per cache: a bounded walk beats an accurate one
const WALK_ENTRIES = 80000;
const REFRESH_MS = 6 * 60 * 60 * 1000;  // these move slowly; measuring them is not free

// ------------------------------------------------------------------ parsers

const UNITS = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4, pb: 1024 ** 5 };

/**
 * Docker's human-readable sizes -> bytes. "8.2GB", "512.3MB", "0B", and the
 * "4.1GB (50%)" that the Reclaimable column uses. null when there's no number.
 */
function parseSize(text) {
  const m = /(-?[\d.,]+)\s*([kmgtp]?i?b)\b/i.exec(String(text ?? '').trim());
  if (!m) return null;
  const n = parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const unit = m[2].toLowerCase().replace('i', '');  // GiB and GB are close enough here
  return Math.round(n * (UNITS[unit] ?? 1));
}

/**
 * `docker system df --format "{{json .}}"` (one JSON object per line) ->
 *   { rows: [{ type, count, active, size, reclaimable }], size, reclaimable }
 * Sizes are bytes. Returns null if nothing in the output looked like Docker.
 */
function parseDockerDf(text) {
  const rows = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (!o || typeof o.Type !== 'string') continue;
    rows.push({
      type: o.Type.slice(0, 40),
      count: Number.parseInt(o.TotalCount, 10) || 0,
      active: Number.parseInt(o.Active, 10) || 0,
      size: parseSize(o.Size) ?? 0,
      reclaimable: parseSize(o.Reclaimable) ?? 0,
    });
  }
  if (!rows.length) return null;
  return {
    rows,
    size: rows.reduce((a, r) => a + r.size, 0),
    reclaimable: rows.reduce((a, r) => a + r.reclaimable, 0),
  };
}

/**
 * `wsl --list --verbose` -> [{ name, state, version, default }].
 * The header line is localised, so it is recognised by shape (three columns,
 * the last a bare number) rather than by its text.
 */
function parseWslList(text) {
  const out = [];
  for (const raw of String(text || '').replace(/\0/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const isDefault = line.startsWith('*');
    const cols = line.replace(/^\*\s*/, '').split(/\s{2,}|\t+/).map(s => s.trim()).filter(Boolean);
    if (cols.length < 3) continue;
    const version = Number.parseInt(cols[cols.length - 1], 10);
    if (!Number.isInteger(version)) continue;           // the header row
    const name = cols[0].slice(0, 60);
    if (!name || /^name$/i.test(name)) continue;
    out.push({ name, state: cols[cols.length - 2].slice(0, 20), version, default: isDefault });
  }
  return out;
}

/**
 * `tasklist /NH /FO CSV` -> [{ name, pid, bytes }].
 * The memory column is localised ("253,476 K" / "253.476 K"), so the digits are
 * taken and the separators dropped.
 */
function parseTasklist(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const cells = [...line.matchAll(/"((?:[^"]|"")*)"/g)].map(m => m[1]);
    if (cells.length < 5) continue;
    const kb = Number.parseInt(cells[4].replace(/[^\d]/g, ''), 10);
    const pid = Number.parseInt(cells[1], 10);
    if (!Number.isFinite(kb) || !Number.isInteger(pid)) continue;
    out.push({ name: cells[0].slice(0, 60), pid, bytes: kb * 1024 });
  }
  return out;
}

// The WSL2 virtual machine holds its memory in one process, shared by every
// distro and by Docker Desktop's backend. Older Windows builds call it vmmem,
// newer ones vmmemWSL.
function vmMemory(processes) {
  const vm = (processes || []).filter(p => /^vmmem(wsl)?\.exe$/i.test(p.name));
  return vm.length ? vm.reduce((a, p) => a + p.bytes, 0) : null;
}

// ------------------------------------------------------------------ locations

/** The package manager caches worth measuring, as absolute paths. */
function cacheLocations(env = process.env, home = os.homedir()) {
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const app = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const defs = [
    ['npm', path.join(local, 'npm-cache')],
    ['pnpm', path.join(local, 'pnpm', 'store')],
    ['Yarn', path.join(local, 'Yarn', 'Cache')],
    ['pip', path.join(local, 'pip', 'Cache')],
    ['Cargo', path.join(home, '.cargo', 'registry')],
    ['Go modules', path.join(home, 'go', 'pkg', 'mod')],
    ['NuGet', path.join(home, '.nuget', 'packages')],
    ['Gradle', path.join(home, '.gradle', 'caches')],
    ['Electron', path.join(local, 'electron', 'Cache')],
    ['electron-builder', path.join(local, 'electron-builder', 'Cache')],
    ['Playwright', path.join(local, 'ms-playwright')],
    ['Puppeteer', path.join(home, '.cache', 'puppeteer')],
    ['uv', path.join(local, 'uv', 'cache')],
    ['Nuget (v2)', path.join(app, 'NuGet', 'v3-cache')],
  ];
  return defs.map(([name, dir]) => ({ name, dir }));
}

/**
 * The virtual disks Docker and WSL keep their filesystems in. Reclaiming space
 * inside them does not shrink these files, which is the part that surprises
 * people, so Shellby reports them separately from what Docker says it can free.
 */
function diskImageLocations(env = process.env, home = os.homedir()) {
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return [
    { name: 'Docker Desktop', file: path.join(local, 'Docker', 'wsl', 'disk', 'docker_desktop.raw') },
    { name: 'Docker Desktop', file: path.join(local, 'Docker', 'wsl', 'data', 'ext4.vhdx') },
    { name: 'Docker Desktop', file: path.join(local, 'Docker', 'wsl', 'main', 'ext4.vhdx') },
    { name: 'WSL', glob: path.join(local, 'Packages'), leaf: path.join('LocalState', 'ext4.vhdx') },
  ];
}

// ------------------------------------------------------------------ readers

function run(file, args, { timeout = 5000, env } = {}) {
  return new Promise(resolve => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024, env },
      (err, stdout) => resolve(err && !stdout ? null : String(stdout || '')));
  });
}

const system32 = (env = process.env) => path.join(env.SystemRoot || 'C:\\Windows', 'System32');

/**
 * Add up a directory tree, giving up early rather than stalling the app: a
 * package cache can hold hundreds of thousands of files. `partial` says the
 * budget ran out, and the caller shows the figure as "at least this much".
 * Symlinks and junctions are never followed (they would double-count a store
 * that hardlinks into projects).
 */
async function dirSize(dir, { ms = WALK_MS, entries = WALK_ENTRIES, now = () => Date.now() } = {}) {
  let bytes = 0, files = 0, seen = 0, partial = false;
  const deadline = now() + ms;
  const queue = [dir];
  while (queue.length) {
    if (now() > deadline || seen > entries) { partial = true; break; }
    const current = queue.pop();
    let list;
    try { list = await fs.promises.readdir(current, { withFileTypes: true }); } catch { continue; }
    const stats = [];
    for (const e of list) {
      seen++;
      if (e.isSymbolicLink()) continue;
      const p = path.join(current, e.name);
      if (e.isDirectory()) queue.push(p);
      else if (e.isFile()) stats.push(p);
    }
    const sizes = await Promise.all(stats.map(p => fs.promises.stat(p).then(s => s.size).catch(() => 0)));
    for (const s of sizes) { bytes += s; files++; }
  }
  return { bytes, files, partial };
}

async function fileSize(file) {
  try {
    const s = await fs.promises.stat(file);
    return s.isFile() ? s.size : null;
  } catch { return null; }
}

/**
 * The space probe used by the app. Each read resolves to data or null, and the
 * expensive measurements are cached: nothing here runs on the health poll loop.
 */
function createSpaceProbe({ platform = process.platform, env = process.env, home = os.homedir(), now = () => Date.now() } = {}) {
  let cache = null;
  let cachedAt = -Infinity;
  let inflight = null;

  async function readDocker() {
    // `docker` resolves through PATH; without Docker installed this is a fast ENOENT.
    const out = await run('docker', ['system', 'df', '--format', '{{json .}}'], { timeout: DOCKER_TIMEOUT_MS });
    return out ? parseDockerDf(out) : null;
  }

  async function readWsl() {
    if (platform !== 'win32') return null;
    // WSL_UTF8 stops wsl.exe answering in UTF-16; parseWslList strips the NULs
    // anyway, for the older builds that ignore it.
    const out = await run(path.join(system32(env), 'wsl.exe'), ['--list', '--verbose'],
      { timeout: WSL_TIMEOUT_MS, env: { ...env, WSL_UTF8: '1' } });
    if (!out) return null;
    const distros = parseWslList(out);
    return distros.length ? { distros } : null;
  }

  async function readVmMemory() {
    if (platform !== 'win32') return null;
    const out = await run(path.join(system32(env), 'tasklist.exe'), ['/NH', '/FO', 'CSV'], { timeout: TASKLIST_TIMEOUT_MS });
    return out ? vmMemory(parseTasklist(out)) : null;
  }

  async function readDiskImages() {
    if (platform !== 'win32') return [];
    const found = [];
    for (const loc of diskImageLocations(env, home)) {
      if (loc.file) {
        const size = await fileSize(loc.file);
        if (size != null) found.push({ name: loc.name, file: loc.file, size });
        continue;
      }
      // WSL stores each distro's disk under its own package folder.
      let pkgs;
      try { pkgs = await fs.promises.readdir(loc.glob); } catch { continue; }
      for (const pkg of pkgs.slice(0, 200)) {
        const file = path.join(loc.glob, pkg, loc.leaf);
        const size = await fileSize(file);
        if (size != null) found.push({ name: `${loc.name}: ${pkg.split('_')[0].slice(0, 40)}`, file, size });
      }
    }
    return found.sort((a, b) => b.size - a.size).slice(0, 12);
  }

  async function readCaches() {
    const locs = cacheLocations(env, home);
    const sizes = await Promise.all(locs.map(async loc => {
      try { if (!(await fs.promises.stat(loc.dir)).isDirectory()) return null; } catch { return null; }
      const { bytes, files, partial } = await dirSize(loc.dir, { now });
      return bytes > 0 ? { ...loc, size: bytes, files, partial } : null;
    }));
    return sizes.filter(Boolean).sort((a, b) => b.size - a.size);
  }

  async function measure() {
    const [docker, wsl, vm, images, caches] = await Promise.all([
      readDocker(), readWsl(), readVmMemory(), readDiskImages(), readCaches(),
    ]);
    return {
      at: now(),
      docker, wsl, images, caches,
      vmMemory: vm,
      // What a prune or a cache clean could plausibly give back. The virtual
      // disks are not counted: shrinking those is a separate, manual job.
      reclaimable: (docker?.reclaimable || 0) + caches.reduce((a, c) => a + c.size, 0),
    };
  }

  return {
    get latest() { return cache; },

    /** Measured at most every few hours unless `force`. Never throws. */
    async read({ force = false } = {}) {
      if (!force && cache && now() - cachedAt < REFRESH_MS) return cache;
      if (inflight) return inflight;
      inflight = measure().then(snap => {
        cache = snap; cachedAt = now();
        return snap;
      }).catch(() => cache).finally(() => { inflight = null; });
      return inflight;
    },

    // Exposed for the Health view's "measure again" button and for tests.
    readDocker, readWsl, readVmMemory, readDiskImages, readCaches,
  };
}

// ------------------------------------------------------------------ rules

// How much there has to be to get back before Shellby mentions it.
const SPACE_DEFAULTS = Object.freeze({ reclaimWarnGb: 40 });
const SPACE_LIMITS = Object.freeze({ reclaimWarnGb: [5, 500] });

/**
 * The space snapshot as readings in the shape health/rules.step consumes.
 * One check only: how much is sitting there to reclaim. The rest of the
 * snapshot is for the Health view and for the prompt below.
 */
function readings(snap) {
  if (!snap || !(snap.reclaimable > 0)) return [];
  return [{
    id: 'reclaim',
    kind: 'reclaim',
    label: 'Reclaimable',
    value: snap.reclaimable / GB,
    unit: 'GB',
    sources: topSources(snap).map(s => s.label),
  }];
}

/** The biggest things we could get back, largest first, for wording and prompts. */
function topSources(snap, limit = 4) {
  const out = [];
  if (snap?.docker?.reclaimable > 0) out.push({ label: 'Docker', bytes: snap.docker.reclaimable });
  for (const c of snap?.caches || []) out.push({ label: `${c.name} cache`, bytes: c.size });
  return out.sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

/**
 * A read-only Claude Code task that looks into the reclaimable space. It asks
 * for a plan and the exact commands, and explicitly does not run them: pruning
 * Docker or wiping a package cache is the user's call, not Shellby's.
 */
function spacePrompt(snap) {
  if (!snap) return null;
  const gb = b => `${(b / GB).toFixed(1)} GB`;
  const lines = [`On this PC, about ${gb(snap.reclaimable)} looks reclaimable from developer tooling.`, ''];
  if (snap.docker) {
    lines.push(`Docker reports ${gb(snap.docker.size)} in use, ${gb(snap.docker.reclaimable)} of it reclaimable:`);
    for (const r of snap.docker.rows) lines.push(`- ${r.type}: ${r.count} items, ${gb(r.size)}, ${gb(r.reclaimable)} reclaimable`);
    lines.push('');
  }
  if (snap.caches?.length) {
    lines.push('Package manager caches:');
    for (const c of snap.caches) lines.push(`- ${c.name}: ${gb(c.size)}${c.partial ? ' (at least)' : ''} at ${c.dir}`);
    lines.push('');
  }
  if (snap.images?.length) {
    lines.push('Virtual disks (these do not shrink on their own when you free space inside them):');
    for (const i of snap.images) lines.push(`- ${i.name}: ${gb(i.size)} at ${i.file}`);
    lines.push('');
  }
  lines.push(
    '1. Tell me which of these are safe to clear and what I would actually lose (a slower next build, or real data).',
    '2. Give me the exact command for each one, so I can run the ones I want.',
    '3. Say which single one would free the most for the least inconvenience.',
    '',
    "Don't run anything, prune anything or delete anything. Just report back.",
  );
  return lines.join('\n');
}

module.exports = {
  parseSize, parseDockerDf, parseWslList, parseTasklist, vmMemory,
  cacheLocations, diskImageLocations, dirSize, createSpaceProbe,
  readings, topSources, spacePrompt, SPACE_DEFAULTS, SPACE_LIMITS, REFRESH_MS,
};
