const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createToolBatch, parseBundle, cleanRefs, countWords, importDest } = require('../src/main/toolbatch');
const { scanToolbox } = require('../src/main/toolbox');

const dirs = [];
const tmp = () => { const d = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-batch-'))); dirs.push(d); return d; };
process.on('exit', () => { for (const d of dirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {} });
function put(file, text = '---\ndescription: x\n---\nbody') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

// A batch over a real home folder, scanned the way the Toolbox scans it.
function setup({ answer = 0, saveTo = null, openFrom = null } = {}) {
  const home = tmp();
  const cwd = tmp();
  const parkDir = path.join(tmp(), 'parked-tools');
  const toolbox = { current: null, rescan() { this.current = scanToolbox({ home, cwd }); } };
  const asked = [];
  const trashed = [];
  const unpinned = [];
  const batch = createToolBatch({
    toolbox: () => toolbox, where: () => ({ home, cwd }), parkDir,
    askOnce: async spec => { asked.push(spec); return answer; },
    trash: async p => { trashed.push(p); fs.rmSync(p, { recursive: true, force: true }); },
    unpin: (kind, name) => unpinned.push(`${kind}:${name}`),
    saveFile: async () => saveTo, openFile: async () => openFrom,
  });
  return { home, cwd, parkDir, toolbox, batch, asked, trashed, unpinned };
}

test('cleanRefs drops junk and duplicates', () => {
  assert.deepEqual(cleanRefs([{ kind: 'skill', name: 'a' }, { kind: 'skill', name: 'a' }, { kind: 'mcp', name: 'x' }, null, { kind: 'agent', name: '' }]),
    [{ kind: 'skill', name: 'a' }]);
  assert.deepEqual(cleanRefs('nope'), []);
  assert.equal(countWords([{ kind: 'skill' }, { kind: 'skill' }, { kind: 'agent' }]), '2 skills, 1 agent');
});

test('removeMany asks once, trashes your own, and leaves a plugin\'s alone', async () => {
  const s = setup();
  put(path.join(s.home, '.claude', 'skills', 'one', 'SKILL.md'));
  put(path.join(s.home, '.claude', 'agents', 'helper.md'));
  s.toolbox.rescan();
  s.toolbox.current.skills.push({ kind: 'skill', name: 'p:x', source: 'plugin:p', path: path.join(s.home, 'elsewhere', 'SKILL.md') });
  const r = await s.batch.removeMany([{ kind: 'skill', name: 'one' }, { kind: 'agent', name: 'helper' }, { kind: 'skill', name: 'p:x' }]);
  assert.equal(r.ok, true);
  assert.equal(s.asked.length, 1);
  assert.match(s.asked[0].title, /1 skill, 1 agent/);
  assert.match(s.asked[0].detail, /Left alone: \/p:x comes with the p plugin/);
  assert.equal(r.removed.length, 2);
  assert.equal(r.skipped.length, 1);
  assert.deepEqual(s.unpinned.sort(), ['agent:helper', 'skill:one']);
  assert.equal(r.toolbox.skills.length, 0);
});

test('removeMany does nothing when you cancel', async () => {
  const s = setup({ answer: 1 });
  const file = put(path.join(s.home, '.claude', 'commands', 'deploy.md'));
  s.toolbox.rescan();
  const r = await s.batch.removeMany([{ kind: 'command', name: 'deploy' }]);
  assert.deepEqual(r, { ok: false, cancelled: true });
  assert.ok(fs.existsSync(file));
});

test('park moves it out of Claude Code\'s sight, and restore puts it back', () => {
  const s = setup();
  const skill = put(path.join(s.home, '.claude', 'skills', 'idle', 'SKILL.md'), '---\ndescription: rarely used\n---\nbody');
  put(path.join(s.home, '.claude', 'skills', 'idle', 'notes.txt'), 'extra');
  s.toolbox.rescan();
  const r = s.batch.park([{ kind: 'skill', name: 'idle' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.parked, [{ kind: 'skill', name: 'idle' }]);
  assert.ok(!fs.existsSync(skill));
  assert.equal(r.toolbox.skills.length, 0);
  assert.equal(r.parkedList.length, 1);
  const list = s.batch.listParked();
  assert.equal(list.length, 1);
  assert.equal(list[0].description, 'rarely used');
  assert.ok(!('to' in list[0]), "the panel never sees Shellby's own folder");
  assert.deepEqual(s.unpinned, ['skill:idle']);

  const back = s.batch.restore([list[0].id]);
  assert.deepEqual(back.restored, [{ kind: 'skill', name: 'idle' }]);
  assert.ok(fs.existsSync(skill));
  assert.equal(fs.readFileSync(path.join(path.dirname(skill), 'notes.txt'), 'utf8'), 'extra');
  assert.equal(s.batch.listParked().length, 0);
  assert.equal(back.toolbox.skills.length, 1);
});

test("restore keeps it parked when a new one took its place", () => {
  const s = setup();
  const agent = put(path.join(s.home, '.claude', 'agents', 'helper.md'), 'old');
  s.toolbox.rescan();
  s.batch.park([{ kind: 'agent', name: 'helper' }]);
  put(agent, 'new');
  const [p] = s.batch.listParked();
  const r = s.batch.restore([p.id]);
  assert.equal(r.restored.length, 0);
  assert.match(r.failed[0].why, /new one/);
  assert.equal(fs.readFileSync(agent, 'utf8'), 'new');
  assert.equal(s.batch.listParked().length, 1);
});

test('restore refuses a manifest entry pointing outside the parked folder', () => {
  const s = setup();
  const outside = put(path.join(tmp(), 'secret', 'x.md'));
  fs.mkdirSync(s.parkDir, { recursive: true });
  fs.writeFileSync(path.join(s.parkDir, 'parked.json'), JSON.stringify([
    { id: 'evil', kind: 'agent', name: 'x', from: path.join(s.home, '.claude', 'agents', 'x.md'), to: outside },
  ]));
  s.toolbox.rescan();
  const r = s.batch.restore(['evil']);
  assert.equal(r.restored.length, 0);
  assert.ok(fs.existsSync(outside));
});

test('scanToolbox notes a copy the project hides from your own', () => {
  const s = setup();
  const mine = put(path.join(s.home, '.claude', 'skills', 'review', 'SKILL.md'));
  put(path.join(s.cwd, '.claude', 'skills', 'review', 'SKILL.md'));
  s.toolbox.rescan();
  const [t] = s.toolbox.current.skills;
  assert.equal(t.source, 'project');
  assert.deepEqual(t.hides, [{ source: 'user', path: mine }]);
});

test('export then import round-trips into another home, skipping ones you have', async () => {
  const out = path.join(tmp(), 'tools.json');
  const a = setup({ saveTo: out });
  put(path.join(a.home, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\ndescription: ships it\n---\n');
  put(path.join(a.home, '.claude', 'skills', 'deploy', 'scripts', 'go.sh'), 'echo go');
  put(path.join(a.home, '.claude', 'commands', 'ops', 'check.md'), 'check');
  put(path.join(a.home, '.claude', 'agents', 'helper.md'), 'helper');
  a.toolbox.rescan();
  const ex = await a.batch.exportMany([{ kind: 'skill', name: 'deploy' }, { kind: 'command', name: 'ops:check' }, { kind: 'agent', name: 'helper' }]);
  assert.equal(ex.ok, true);
  assert.equal(ex.count, 3);

  const b = setup({ openFrom: out });
  put(path.join(b.home, '.claude', 'agents', 'helper.md'), 'mine');
  b.toolbox.rescan();
  const im = await b.batch.importBundle();
  assert.equal(im.ok, true);
  assert.equal(im.added.length, 2);
  assert.deepEqual(im.skipped, [{ kind: 'agent', name: 'helper' }]);
  assert.equal(fs.readFileSync(path.join(b.home, '.claude', 'skills', 'deploy', 'scripts', 'go.sh'), 'utf8'), 'echo go');
  assert.equal(fs.readFileSync(path.join(b.home, '.claude', 'commands', 'ops', 'check.md'), 'utf8'), 'check');
  assert.equal(fs.readFileSync(path.join(b.home, '.claude', 'agents', 'helper.md'), 'utf8'), 'mine');
  assert.match(b.asked[0].detail, /Already yours/);
});

test('parseBundle rejects paths that would land outside their folder', () => {
  const b64 = Buffer.from('x').toString('base64');
  const bundle = tools => JSON.stringify({ format: 'shellby-tools', version: 1, tools });
  assert.equal(parseBundle('nope').ok, false);
  assert.equal(parseBundle(bundle([{ kind: 'skill', name: '..', files: [{ path: 'SKILL.md', data: b64 }] }])).ok, false);
  assert.equal(parseBundle(bundle([{ kind: 'skill', name: 'a', files: [{ path: '../../evil.md', data: b64 }, { path: 'SKILL.md', data: b64 }] }])).ok, false);
  assert.equal(parseBundle(bundle([{ kind: 'agent', name: 'a\\..\\b', files: [{ path: 'a.md', data: b64 }] }])).ok, false);
  assert.equal(parseBundle(bundle([{ kind: 'agent', name: 'con', files: [{ path: 'con.md', data: b64 }] }])).ok, false);
  assert.equal(parseBundle(bundle([{ kind: 'skill', name: 'nofile', files: [{ path: 'README.md', data: b64 }] }])).ok, false);
  assert.match(parseBundle(JSON.stringify({ format: 'shellby-tools', version: 99, tools: [] })).error, /newer Shellby/);
  const ok = parseBundle(bundle([{ kind: 'command', name: 'ops:check', files: [{ path: 'check.md', data: b64 }] }]));
  assert.equal(ok.ok, true);
  assert.equal(importDest('H', ok.tools[0]), path.join('H', '.claude', 'commands', 'ops', 'check.md'));
});

test('parseBundle drops a skill or agent whose frontmatter declares hooks or MCP servers', () => {
  const b64 = s => Buffer.from(s).toString('base64');
  const bundle = tools => JSON.stringify({ format: 'shellby-tools', version: 1, tools });
  const hooked = '---\nname: a\nhooks:\n  PreToolUse:\n    - hooks: [{ type: command, command: calc }]\n---\nbody';
  const mcp = '---\nname: b\nmcpServers:\n  x: { command: calc }\n---\nbody';
  const plain = '---\nname: c\ndescription: mentions hooks: in its text\n---\nhooks: down here is only text';
  assert.equal(parseBundle(bundle([{ kind: 'skill', name: 'a', files: [{ path: 'SKILL.md', data: b64(hooked) }] }])).ok, false);
  assert.equal(parseBundle(bundle([{ kind: 'agent', name: 'b', files: [{ path: 'b.md', data: b64(mcp) }] }])).ok, false);
  const ok = parseBundle(bundle([{ kind: 'agent', name: 'c', files: [{ path: 'c.md', data: b64(plain) }] }]));
  assert.equal(ok.ok, true);
});

test("restore won't send a parked one anywhere but a .claude folder, and keeps it on the list", () => {
  const s = setup();
  const id = 'abc';
  const kept = put(path.join(s.parkDir, id, 'x.md'), 'parked');
  const elsewhere = path.join(tmp(), 'Startup', 'x.md');
  const ok = { id, kind: 'agent', name: 'x', from: path.join(s.home, '.claude', 'agents', 'x.md'), to: kept };
  fs.writeFileSync(path.join(s.parkDir, 'parked.json'), JSON.stringify([
    { ...ok, id: 'away', from: elsewhere, to: path.join(s.parkDir, 'away', 'x.md') },
    { ...ok, id: 'up', to: path.join(s.parkDir, 'up', '..') },
    { odd: 'an entry Shellby doesn\'t know' },
  ]));
  s.toolbox.rescan();
  const r = s.batch.restore(['away', 'up']);
  assert.equal(r.ok, false);
  assert.equal(r.restored.length, 0);
  assert.ok(!fs.existsSync(elsewhere));
  assert.ok(fs.existsSync(kept));
  const after = JSON.parse(fs.readFileSync(path.join(s.parkDir, 'parked.json'), 'utf8'));
  assert.equal(after.length, 3, 'nothing is forgotten, the unknown entry included');
});

test('a parked list that will not parse stops park and restore rather than being overwritten', () => {
  const s = setup();
  const agent = put(path.join(s.home, '.claude', 'agents', 'helper.md'));
  fs.mkdirSync(s.parkDir, { recursive: true });
  fs.writeFileSync(path.join(s.parkDir, 'parked.json'), '{ broken');
  s.toolbox.rescan();
  assert.match(s.batch.park([{ kind: 'agent', name: 'helper' }]).error, /couldn't be read/);
  assert.ok(fs.existsSync(agent));
  assert.equal(fs.readFileSync(path.join(s.parkDir, 'parked.json'), 'utf8'), '{ broken');
  assert.equal(s.batch.restore(['x']).ok, false);
});

test('parking across drives copies then deletes, and a failed copy leaves nothing half done', () => {
  const s = setup();
  const skill = put(path.join(s.home, '.claude', 'skills', 'far', 'SKILL.md'));
  s.toolbox.rescan();
  const exdev = () => { const e = new Error('cross-device'); e.code = 'EXDEV'; throw e; };
  const across = createToolBatch({
    toolbox: () => s.toolbox, where: () => ({ home: s.home, cwd: s.cwd }), parkDir: s.parkDir,
    fs: { ...fs, renameSync: (a, b) => (String(b).endsWith('.tmp') || String(a).endsWith('.tmp') ? fs.renameSync(a, b) : exdev()) },
  });
  const r = across.park([{ kind: 'skill', name: 'far' }]);
  assert.equal(r.ok, true);
  assert.ok(!fs.existsSync(skill));
  const [p] = across.listParked();
  assert.ok(fs.existsSync(path.join(s.parkDir, p.id, 'far', 'SKILL.md')));

  put(skill.replace('far', 'half'));
  s.toolbox.rescan();
  const broken = createToolBatch({
    toolbox: () => s.toolbox, where: () => ({ home: s.home, cwd: s.cwd }), parkDir: s.parkDir,
    fs: { ...fs, renameSync: exdev, cpSync: (a, b) => { fs.mkdirSync(b, { recursive: true }); fs.writeFileSync(path.join(b, 'partial'), ''); throw new Error('disk full'); } },
  });
  const bad = broken.park([{ kind: 'skill', name: 'half' }]);
  assert.equal(bad.ok, false);
  assert.ok(fs.existsSync(skill.replace('far', 'half')), 'the original stays put');
  const left = fs.readdirSync(s.parkDir).filter(d => d !== p.id && d !== 'parked.json');
  assert.ok(left.every(d => !fs.existsSync(path.join(s.parkDir, d, 'half'))), 'no partial copy left behind');
});

test('import leaves a linked Claude folder alone', async () => {
  const out = path.join(tmp(), 'tools.json');
  fs.writeFileSync(out, JSON.stringify({ format: 'shellby-tools', version: 1, tools: [{ kind: 'agent', name: 'a', files: [{ path: 'a.md', data: Buffer.from('x').toString('base64') }] }] }));
  const s = setup({ openFrom: out });
  const real = tmp();
  fs.mkdirSync(path.join(s.home, '.claude'), { recursive: true });
  fs.symlinkSync(real, path.join(s.home, '.claude', 'agents'), 'junction');
  const r = await s.batch.importBundle();
  assert.match(r.error, /link/);
  assert.deepEqual(fs.readdirSync(real), []);
});

test('parseBundle turns away a skill that is really a mod', () => {
  const b64 = Buffer.from('x').toString('base64');
  const skill = extra => JSON.stringify({ format: 'shellby-tools', version: 1, tools: [{ kind: 'skill', name: 'm', files: [{ path: 'SKILL.md', data: b64 }, { path: extra, data: b64 }] }] });
  assert.equal(parseBundle(skill('.claude-plugin/plugin.json')).ok, false);
  assert.equal(parseBundle(skill('hooks/hooks.json')).ok, false);
  assert.equal(parseBundle(skill('hooks.json')).ok, false);
  assert.equal(parseBundle(skill('scripts/run.sh')).ok, true);
});
