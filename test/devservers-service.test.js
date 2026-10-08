// The dev server state machine (src/main/devservers/service.js), with a fake
// runner and real log files: up, crashed, stopped, picked back up after a
// restart, the crash toast (once, and once per loop), and the fix flow, where
// nothing reaches Claude except through sendFix.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const realRunner = require('../src/main/devservers/runner');
const { DevServers, normalize, MAX_RUNNING } = require('../src/main/devservers/service');

const ROOT = path.resolve('C:\\code\\site');

// saved: what settings.json remembers, or a function of the log folder that returns it.
function setup({ saved = null, focused = false, scripts = [{ name: 'dev', framework: 'vite', likely: true }] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-srv-'));
  let data = { devServers: typeof saved === 'function' ? saved(dir) : saved };
  const config = { get: k => data[k], set: p => { data = { ...data, ...p }; } };
  const alive = new Map();
  let nextPid = 100;
  let now = 1_000_000;
  const toasts = [];
  const tasks = [];
  const opened = [];
  const runner = {
    ...realRunner,
    start: ({ logFile }) => { fs.writeFileSync(logFile, ''); const pid = nextPid++; alive.set(pid, true); return { ok: true, pid }; },
    stop: async pid => { alive.set(pid, false); },
    isAlive: pid => alive.get(pid) === true,
    trimLog: () => false,
  };
  const svc = new DevServers({
    config, dir, runner, now: () => now,
    info: pid => ({ alive: alive.get(pid) === true, createdAt: 5 }),
    readScripts: () => (scripts ? { manager: 'npm', scripts, installed: true } : null),
    notify: n => toasts.push(n),
    startTask: (prompt, title, opts) => { tasks.push({ prompt, title, opts }); return { ok: true, tabId: `tab-${tasks.length}` }; },
    panelFocused: () => focused,
    openCard: id => opened.push(id),
  });
  // Like the real supervisor: once it has written its exit marker, it's gone.
  const say = (id, text) => {
    const s = svc.servers.get(id);
    fs.appendFileSync(s.log, text);
    if (/\[shellby-exit -?\d+\]/.test(text)) alive.set(s.pid, false);
  };
  // What a server prints itself: the supervisor is still there.
  const forge = (id, text) => fs.appendFileSync(svc.servers.get(id).log, text);
  const poll = (id, checkAlive = false) => svc.poll(id, { checkAlive });
  const done = () => { svc.shutdown(); fs.rmSync(dir, { recursive: true, force: true }); };
  return { svc, dir, data: () => data, alive, toasts, tasks, opened, say, forge, poll, done, tick: ms => { now += ms; }, now: () => now };
}

test('start, then up when it says where it is', () => {
  const t = setup();
  try {
    const r = t.svc.start({ root: ROOT, script: 'dev', project: 'site' });
    assert.equal(r.ok, true);
    const { id } = r.server;
    assert.equal(r.server.status, 'starting');
    assert.equal(r.server.command, 'npm run dev');
    assert.equal(r.server.pid, undefined, 'the pid stays in main');
    t.say(id, '  ➜  Local:   http://localhost:5173/\n');
    t.poll(id);
    const s = t.svc.view().servers[0];
    assert.equal(s.status, 'up');
    assert.equal(s.port, 5173);
    assert.deepEqual(t.svc.summary(), { up: 1, upPort: 5173, down: 0, downId: null, firstId: id });
    assert.deepEqual(t.svc.runningList(), [{ project: 'site', port: 5173 }]);
    // Starting it again is the same server.
    assert.equal(t.svc.start({ root: ROOT, script: 'dev' }).already, true);
    assert.equal(t.data().devServers.last[ROOT.toLowerCase()] ?? t.data().devServers.last[ROOT], 'dev');
  } finally { t.done(); }
});

test('a crash: one toast, a sign until you look, and the exit code', () => {
  const t = setup();
  try {
    const { id } = t.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server;
    t.say(id, 'Local: http://localhost:5173/\nError: boom\n\n[shellby-exit 1]\n');
    t.poll(id);
    const s = t.svc.view().servers[0];
    assert.equal(s.status, 'crashed');
    assert.equal(s.exitCode, 1);
    assert.equal(s.canFix, true);
    assert.equal(t.toasts.length, 1);
    assert.equal(t.toasts[0].title, 'site dev server crashed');
    assert.equal(t.toasts[0].body, 'vite exited with code 1.');
    assert.equal(t.toasts[0].action, 'See the error');
    t.toasts[0].onClick();
    assert.deepEqual(t.opened, [id], 'the toast opens the card, it never sends anything');
    assert.equal(t.tasks.length, 0);
    assert.equal(t.svc.summary().down, 1);
    t.svc.markSeen(id);
    assert.equal(t.svc.summary().down, 0);
  } finally { t.done(); }
});

test("one that dies before it's ever up didn't start", () => {
  const t = setup();
  try {
    const { id } = t.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server;
    t.say(id, "'vite' is not recognized\n[shellby-exit 1]\n");
    t.poll(id);
    assert.equal(t.toasts[0].title, "site dev server didn't start");
    assert.match(t.svc.fixDraft(id).prompt, /didn't start/);
  } finally { t.done(); }
});

test('gone without a marker is a crash with no exit code', () => {
  const t = setup();
  try {
    const { id } = t.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server;
    t.alive.set(t.svc.servers.get(id).pid, false);
    t.poll(id, true);
    const s = t.svc.view().servers[0];
    assert.equal(s.status, 'crashed');
    assert.equal(s.exitCode, null);
    assert.equal(t.toasts[0].body, 'vite exited.');
  } finally { t.done(); }
});

test('stop is not a crash: no toast, and it is gone from the list', async () => {
  const t = setup();
  try {
    const { id } = t.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server;
    await t.svc.stop(id);
    assert.deepEqual(t.svc.view().servers, []);
    assert.equal(t.toasts.length, 0);
    assert.equal(t.svc.liveCount(), 0);
  } finally { t.done(); }
});

test('no toast while the panel is in front, or with toasts off; the sign still goes up', () => {
  const t = setup({ focused: true });
  try {
    const { id } = t.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server;
    t.say(id, '[shellby-exit 1]\n');
    t.poll(id);
    assert.equal(t.toasts.length, 0);
    assert.equal(t.svc.summary().down, 1);
  } finally { t.done(); }
  const u = setup({ saved: { toast: false, sign: false } });
  try {
    const { id } = u.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server;
    u.say(id, '[shellby-exit 1]\n');
    u.poll(id);
    assert.equal(u.toasts.length, 0);
    assert.equal(u.svc.summary().down, 0, 'the sign is a setting too');
  } finally { u.done(); }
});

test('a crash loop gets one "keeps crashing" toast, not one per lap', async () => {
  const t = setup();
  try {
    let id = t.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server.id;
    for (let i = 0; i < 6; i++) {
      t.say(id, 'Local: http://localhost:5173/\n');
      t.poll(id);
      t.say(id, '[shellby-exit 1]\n');
      t.poll(id);
      t.tick(30 * 1000);
      id = (await t.svc.restart(id)).server.id;
    }
    const titles = t.toasts.map(x => x.title);
    assert.deepEqual(titles, ['site dev server crashed', 'site dev server crashed', 'site dev server crashed', 'site dev server keeps crashing']);
  } finally { t.done(); }
});

test('picked back up after Shellby restarts: running ones carry on, ended ones show without a toast', () => {
  const base = { kind: 'server', root: ROOT, project: 'site', manager: 'npm', script: 'dev', pidStartedAt: 5, status: 'up', startedAt: 1 };
  const t = setup({
    saved: dir => {
      const log = id => path.join(dir, `${id}.log`);
      fs.writeFileSync(log('srv-aaaaaaaa'), 'Local: http://localhost:3000/\n[shellby-exit 0]\n'); // a forged marker: it's still running
      fs.writeFileSync(log('srv-bbbbbbbb'), 'Error: boom\n[shellby-exit 2]\n');
      return { servers: [
        { ...base, id: 'srv-aaaaaaaa', pid: 1, log: log('srv-aaaaaaaa') },
        { ...base, id: 'srv-bbbbbbbb', pid: 2, log: log('srv-bbbbbbbb'), script: 'start' },
        { ...base, id: 'srv-cccccccc', pid: 3, log: log('srv-cccccccc'), script: 'serve' },
      ] };
    },
  });
  try {
    t.alive.set(1, true);
    t.svc.reattach();
    const byId = Object.fromEntries(t.svc.view().servers.map(s => [s.id, s]));
    assert.equal(byId['srv-aaaaaaaa'].status, 'up', 'Windows says it is running, whatever its log says');
    assert.equal(byId['srv-aaaaaaaa'].port, 3000);
    assert.equal(byId['srv-bbbbbbbb'].status, 'crashed');
    assert.equal(byId['srv-bbbbbbbb'].exitCode, 2);
    assert.equal(byId['srv-bbbbbbbb'].missed, true);
    assert.equal(byId['srv-bbbbbbbb'].seen, false, 'a real crash still gets the sign');
    assert.equal(byId['srv-cccccccc'].status, 'crashed', 'no marker and no process: it stopped while Shellby was closed');
    assert.equal(byId['srv-cccccccc'].seen, true, '...which may have been on purpose, so no sign for it');
    assert.equal(t.toasts.length, 0, 'no toast for something that happened while Shellby was closed');
    assert.deepEqual(t.svc.log('srv-bbbbbbbb').lines, ['Error: boom']);
  } finally { t.done(); }
});

test('a server printing an exit marker itself is not believed while it runs', async () => {
  const t = setup();
  try {
    const { id } = t.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server;
    t.forge(id, 'Local: http://localhost:5173/\n[shellby-exit 0]\n');
    t.poll(id, true);
    assert.equal(t.svc.view().servers[0].status, 'up');
    assert.equal(t.toasts.length, 0);
    // Stop still reaches the real process.
    const pid = t.svc.servers.get(id).pid;
    assert.equal((await t.svc.stop(id)).ok, true);
    assert.equal(t.alive.get(pid), false);
  } finally { t.done(); }
});

test('two restarts at once start one server, and a stop during a restart wins', async () => {
  const t = setup();
  try {
    const { id } = t.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server;
    const first = t.svc.servers.get(id).pid;
    const [a, b] = await Promise.all([t.svc.restart(id), t.svc.restart(id)]);
    assert.equal(a.ok && b.ok, true);
    const live = [...t.alive.entries()].filter(([, up]) => up).map(([pid]) => pid);
    assert.equal(live.length, 1, `one running server, not ${live.length}`);
    assert.equal(t.alive.get(first), false);
    // A restart and a stop together: it ends stopped, not brought back.
    const r = t.svc.restart(id);
    const s = t.svc.stop(id);
    await Promise.all([r, s]);
    assert.deepEqual(t.svc.view().servers, []);
    assert.equal([...t.alive.values()].filter(Boolean).length, 0);
  } finally { t.done(); }
});

test("a stop that doesn't take keeps the server on the list", async () => {
  const t = setup();
  try {
    const { id } = t.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server;
    t.svc.deps.runner.stop = async () => {}; // taskkill refused: still there after the 5 s wait
    const r = await t.svc.stop(id);
    assert.equal(r.ok, false);
    assert.equal(t.svc.view().servers.length, 1);
  } finally { t.done(); }
});

test('quitting with "Stop them": killed on their own, and saved as gone straight away', async () => {
  const t = setup();
  try {
    const calls = [];
    t.svc.deps.runner.stop = (pid, opts) => { calls.push({ pid, ...opts }); return Promise.resolve(); };
    t.svc.start({ root: ROOT, script: 'dev', project: 'site' });
    await t.svc.stopAll({ detached: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].detached, true);
    assert.deepEqual(t.data().devServers.servers, []);
  } finally { t.done(); }
});

test('an update stops servers first and the new version starts them again', async () => {
  const t = setup();
  try {
    t.svc.start({ root: ROOT, script: 'dev', project: 'site' });
    await t.svc.stopForUpdate();
    const saved = t.data().devServers;
    assert.deepEqual(saved.servers, []);
    assert.deepEqual(saved.resume, [{ root: ROOT, script: 'dev', project: 'site' }]);
    const next = new DevServers({ ...t.svc.deps, config: { get: () => saved, set: () => {} } });
    next.reattach();
    assert.equal(next.view().servers[0].status, 'starting');
    assert.equal(next.view().servers[0].script, 'dev');
    next.shutdown();
  } finally { t.done(); }
});

test('settings.json is not trusted: bad entries are dropped, and nothing in it names a file or a process', () => {
  const dir = path.resolve('C:\\shellby-data\\devservers');
  const n = normalize({ onQuit: 'explode', crab: 'yes', servers: [
    { id: 'srv-aaaaaaaa', root: 'relative', manager: 'npm', script: 'dev' },
    { id: 'x', root: ROOT, manager: 'npm', script: 'dev' },
    { id: 'srv-bbbbbbbb', root: ROOT, manager: 'cmd', script: 'dev' },
    { id: 'srv-cccccccc', root: ROOT, manager: 'npm', script: 'dev && calc' },
    { id: 'srv-eeeeeeee', root: '\\\\server\\share\\site', manager: 'npm', script: 'dev' },
    { id: 'srv-dddddddd', root: ROOT, manager: 'npm', script: 'dev', url: 'http://evil.example/', log: 'C:\\Windows\\win.ini', status: 'up', pid: 4 },
    { id: 'srv-ffffffff', root: ROOT, manager: 'npm', script: 'dev', url: 'https://localhost:5173/', log: path.join(dir, 'srv-ffffffff.log'), status: 'up', pid: 9, pidStartedAt: 7 },
  ] }, dir);
  assert.equal(n.onQuit, 'keep');
  assert.equal(n.crab, true);
  assert.deepEqual(n.servers.map(s => s.id), ['srv-dddddddd', 'srv-ffffffff']);
  const [d, f] = n.servers;
  assert.equal(d.url, null);
  assert.equal(d.log, null, 'a log anywhere but its own is not its log');
  assert.equal(d.status, 'crashed', 'running with no start time to check: not ours to touch');
  assert.equal(f.status, 'up');
  assert.equal(f.url, 'https://localhost:5173/');
  assert.equal(f.log, path.join(dir, 'srv-ffffffff.log'));
});

test('crashes count toward a loop even while the panel is in front', () => {
  const t = setup({ focused: true });
  try {
    for (let i = 0; i < 4; i++) {
      const { id } = t.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server;
      t.say(id, 'Local: http://localhost:1/\n[shellby-exit 1]\n');
      t.poll(id);
    }
    assert.equal(t.svc.crashes.values().next().value.length, 4);
  } finally { t.done(); }
});

test('starting a crashed one again forgets the old fix conversation', () => {
  const t = setup();
  try {
    const { id } = t.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server;
    t.say(id, '[shellby-exit 1]\n');
    t.poll(id);
    const d = t.svc.fixDraft(id);
    t.svc.sendFix(id, '', d.hash);
    t.svc.start({ root: ROOT, script: 'dev' });
    t.svc.onTabDone('tab-1', true);
    assert.equal(t.svc.view().servers[0].fixedAt, 0);
  } finally { t.done(); }
});

test('the fix flow: a draft you can read, sent only by sendFix, then Restart on offer', async () => {
  const t = setup();
  try {
    const { id } = t.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server;
    t.say(id, 'Local: http://localhost:5173/\nDATABASE_PASSWORD=hunter22\nError: boom\n[shellby-exit 1]\n');
    t.poll(id);
    const d = t.svc.fixDraft(id, 'It broke after the upgrade.');
    assert.ok(d.lines.includes('DATABASE_PASSWORD=[redacted]'));
    assert.ok(!d.prompt.includes('hunter22'));
    assert.match(d.prompt, /It broke after the upgrade\./);
    assert.equal(t.tasks.length, 0, 'a draft sends nothing');
    // Only the draft that was shown: no hash, a stale one, or a different note sends nothing.
    assert.equal(t.svc.sendFix(id, 'It broke after the upgrade.').ok, false);
    assert.equal(t.svc.sendFix(id, 'It broke after the upgrade.', 'nope').stale, true);
    assert.equal(t.svc.sendFix(id, 'A different note.', d.hash).stale, true);
    assert.equal(t.tasks.length, 0);
    const r = t.svc.sendFix(id, 'It broke after the upgrade.', d.hash);
    assert.deepEqual(r, { ok: true, tabId: 'tab-1' });
    assert.equal(t.tasks[0].prompt, d.prompt, 'what was shown is what was sent');
    assert.equal(t.tasks[0].title, 'Fix site dev server');
    assert.deepEqual(t.tasks[0].opts, { cwd: ROOT });
    assert.equal(t.svc.summary().down, 0, 'sending counts as looking');
    // Another tab finishing changes nothing.
    t.svc.onTabDone('tab-other', true);
    assert.equal(t.svc.view().servers[0].fixedAt, 0);
    t.svc.onTabDone('tab-1', true);
    assert.ok(t.svc.view().servers[0].fixedAt > 0);
    const offer = t.toasts.at(-1);
    assert.equal(offer.title, "Claude's done with site");
    assert.equal(offer.action, 'Restart');
    offer.onClick();
    await new Promise(r => setImmediate(r));
    assert.equal(t.svc.view().servers[0].status, 'starting');
    assert.equal(t.svc.view().servers[0].fixTabId, null);
  } finally { t.done(); }
});

test('nothing to send for a server that is running', () => {
  const t = setup();
  try {
    const { id } = t.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server;
    assert.equal(t.svc.fixDraft(id), null);
    assert.equal(t.svc.sendFix(id, '', 'anything').ok, false);
    assert.equal(t.tasks.length, 0);
  } finally { t.done(); }
});

test('only scripts package.json has, and at most eight at once', () => {
  const t = setup({ scripts: Array.from({ length: 10 }, (_, i) => ({ name: `s${i}`, framework: null, likely: true })) });
  try {
    assert.match(t.svc.start({ root: ROOT, script: 'nope' }).error, /no "nope" script/);
    assert.match(t.svc.start({ root: 'relative', script: 's0' }).error, /Unknown project folder/);
    for (let i = 0; i < MAX_RUNNING; i++) assert.equal(t.svc.start({ root: ROOT, script: `s${i}` }).ok, true);
    assert.match(t.svc.start({ root: ROOT, script: 's9' }).error, /8 are running already/);
  } finally { t.done(); }
  const u = setup({ scripts: null });
  try { assert.match(u.svc.start({ root: ROOT, script: 'dev' }).error, /package\.json/); } finally { u.done(); }
});

test('an install: gone when it works, kept with its log when it fails, never a crash toast', () => {
  const t = setup();
  try {
    const events = [];
    t.svc.on('installed', e => events.push(e));
    const ok = t.svc.start({ root: ROOT, kind: 'install', project: 'site' }).server;
    assert.equal(ok.command, 'npm install');
    t.say(ok.id, 'added 300 packages\n[shellby-exit 0]\n');
    t.poll(ok.id);
    assert.deepEqual(t.svc.view().servers, []);
    assert.deepEqual(events, [{ root: ROOT, project: 'site' }]);
    const bad = t.svc.start({ root: ROOT, kind: 'install', project: 'site' }).server;
    t.say(bad.id, 'npm ERR! code E404\n[shellby-exit 1]\n');
    t.poll(bad.id);
    assert.equal(t.svc.view().servers[0].status, 'failed');
    assert.equal(t.toasts.length, 0);
    assert.equal(t.svc.summary().down, 0, 'a failed install is not a crashed server');
  } finally { t.done(); }
});

test('settings: when Shellby quits, and the crab', () => {
  const t = setup();
  try {
    assert.equal(t.svc.view().settings.onQuit, 'keep');
    t.svc.setSettings({ onQuit: 'stop', quitNoteSeen: true, crab: false, bogus: 1 });
    assert.deepEqual(t.svc.view().settings, { onQuit: 'stop', quitNoteSeen: true, crab: false, sign: true, toast: true });
    t.svc.setSettings({ onQuit: 'later' });
    assert.equal(t.svc.view().settings.onQuit, 'stop');
    const { id } = t.svc.start({ root: ROOT, script: 'dev', project: 'site' }).server;
    t.say(id, 'Local: http://localhost:5173/\n');
    t.poll(id);
    assert.equal(t.svc.summary().up, 0, 'the pill is a setting');
  } finally { t.done(); }
});
