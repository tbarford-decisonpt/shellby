// The repos on this PC (src/main/projects/local.js) and the Projects service's
// rules about them (src/main/projects/service.js): nothing is scanned unless
// you ask, a scan adds nothing by itself, and the panel can only name folders
// the service listed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const local = require('../src/main/projects/local');
const { Projects } = require('../src/main/projects/service');

function tree() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-projects-')));
  const repo = (...p) => { const d = path.join(base, ...p); fs.mkdirSync(path.join(d, '.git'), { recursive: true }); return d; };
  return { base, repo, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// A git that knows the repos made by tree(): each folder with a .git is its own root.
function fakeGit(calls = []) {
  return async args => {
    calls.push(args);
    const dir = args[1];
    if (args[2] === 'rev-parse' && args[3] === '--show-toplevel') return fs.existsSync(path.join(dir, '.git')) ? `${dir}\n` : null;
    if (args[2] === 'rev-parse' && args[3] === '--git-common-dir') return '.git\n';
    if (args[2] === 'remote') return `https://github.com/me/${path.basename(dir)}.git\n`;
    if (args[2] === 'rev-parse' && args[3] === '--abbrev-ref') return 'main\n';
    return null;
  };
}

function config(initial = {}) {
  let data = { ...initial };
  return { get: k => data[k], set: patch => { data = { ...data, ...patch }; }, data: () => data };
}

const devServers = { view: () => ({ servers: [], settings: {}, running: 0 }), lastScript: () => null, forRoot: () => [] };

function service(t, { known = [], cfg = config() } = {}) {
  const calls = [];
  const p = new Projects({
    config: cfg, devServers, known: () => known.map(key => ({ key, name: path.basename(key) })), lastWorked: () => new Map(),
    github: () => ({ signedIn: false, can: () => false }), run: fakeGit(calls),
  });
  return { p, calls, cfg };
}

test('readRepo: root, name, GitHub remote and branch', async () => {
  const t = tree();
  try {
    const dir = t.repo('site');
    assert.deepEqual(await local.readRepo(dir, fakeGit()), { root: path.resolve(dir), name: 'site', remote: 'me/site', forge: null, branch: 'main' });
    assert.equal(await local.readRepo(path.join(t.base), fakeGit()), null);
    assert.equal(await local.readRepo('\\\\server\\share\\x', fakeGit()), null, 'never a network share');
    assert.equal(await local.readRepo('relative\\path', fakeGit()), null);
  } finally { t.done(); }
});

test('scanFolder: two levels deep, not into a repo once found, not into node_modules or dot folders', async () => {
  const t = tree();
  try {
    const a = t.repo('a');
    t.repo('a', 'nested-inside-a');
    const b = t.repo('group', 'b');
    t.repo('group', 'deeper', 'too-deep');
    t.repo('node_modules', 'pkg');
    t.repo('.cache', 'thing');
    const { found } = await local.scanFolder(t.base);
    assert.deepEqual(found.sort(), [a, b].sort());
  } finally { t.done(); }
});

test('scanFolder stops at its cap and when cancelled', async () => {
  const t = tree();
  try {
    for (let i = 0; i < 5; i++) t.repo(`r${i}`);
    const capped = await local.scanFolder(t.base, { max: 3 });
    assert.equal(capped.found.length, 3);
    assert.equal(capped.truncated, true);
    const ac = new AbortController();
    ac.abort();
    assert.deepEqual((await local.scanFolder(t.base, { signal: ac.signal })).found, []);
  } finally { t.done(); }
});

test('the list starts with known projects only: no folder is looked through', async () => {
  const t = tree();
  try {
    const known = t.repo('known');
    t.repo('not-known');
    const { p, calls } = service(t, { known: [known] });
    const { projects } = await p.list();
    assert.deepEqual(projects.map(x => x.name), ['known']);
    assert.ok(!calls.some(a => a.includes(path.join(t.base, 'not-known'))), 'nothing else was asked about');
  } finally { t.done(); }
});

test('a scan returns candidates and adds nothing until you pick', async () => {
  const t = tree();
  try {
    const one = t.repo('one');
    const two = t.repo('two');
    const { p, cfg } = service(t);
    const r = await p.scan(t.base);
    assert.equal(r.ok, true);
    assert.deepEqual(r.candidates.map(c => c.name), ['one', 'two']);
    assert.deepEqual(cfg.data().projects, undefined, 'scanning saved nothing');
    assert.deepEqual((await p.list()).projects, []);
    // Only roots the scan found are taken.
    assert.equal(p.addMany([one, 'C:\\Windows', path.join(t.base, 'elsewhere')]).added, 1);
    assert.deepEqual(cfg.data().projects.added, [one]);
    const { projects } = await p.list({ refresh: true });
    assert.deepEqual(projects.map(x => x.name), ['one']);
    assert.ok(two);
  } finally { t.done(); }
});

test('add: a folder in a repo adds that repo; anything else is refused', async () => {
  const t = tree();
  try {
    const dir = t.repo('mine');
    const { p } = service(t);
    assert.equal((await p.add(dir)).ok, true);
    assert.equal((await p.add(path.join(t.base))).ok, false);
    assert.deepEqual((await p.list({ refresh: true })).projects.map(x => x.name), ['mine']);
  } finally { t.done(); }
});

test('knowsRoot: only folders the page was shown', async () => {
  const t = tree();
  try {
    const dir = t.repo('mine');
    const { p } = service(t, { known: [dir] });
    assert.equal(p.knowsRoot(dir), null, 'not before the list is drawn');
    await p.list();
    assert.equal(p.knowsRoot(dir), path.resolve(dir));
    assert.equal(p.knowsRoot(dir.toUpperCase()) !== null, process.platform === 'win32');
    assert.equal(p.knowsRoot('C:\\Windows\\System32'), null);
    assert.equal(p.knowsRoot('relative'), null);
    assert.equal(p.knowsRoot(42), null);
  } finally { t.done(); }
});

test('remove takes it off the list and never touches the folder', async () => {
  const t = tree();
  try {
    const dir = t.repo('mine');
    const { p, cfg } = service(t, { known: [dir] });
    const { projects } = await p.list();
    assert.equal(p.remove(projects[0].key).ok, true);
    assert.deepEqual((await p.list({ refresh: true })).projects, []);
    assert.ok(fs.existsSync(path.join(dir, '.git')));
    assert.deepEqual(cfg.data().projects.hidden, ['github:me/mine']);
    assert.equal(p.remove('../../etc').ok, false);
    // Adding it again brings it back.
    await p.add(dir);
    assert.equal((await p.list({ refresh: true })).projects.length, 1);
  } finally { t.done(); }
});
