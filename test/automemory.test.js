const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const am = require('../src/main/automemory');

const tmpDir = () => fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-am-')));

const NOTE = '---\nname: use-pnpm\ndescription: "pnpm in this repo, never npm"\nmetadata:\n  type: feedback\n---\n\nUse pnpm here.\n\n**Why:** the lockfile is pnpm\'s.\n';

test("a project folder is named the way Claude Code names it", () => {
  const cwd = process.platform === 'win32' ? 'C:\\Users\\jacob\\OneDrive\\Desktop\\shellby' : '/home/jacob/shellby';
  assert.equal(am.slugOf(cwd), process.platform === 'win32' ? 'C--Users-jacob-OneDrive-Desktop-shellby' : '-home-jacob-shellby');
  assert.equal(am.memoryDir(cwd, '/cfg'), path.join('/cfg', 'projects', am.slugOf(cwd), 'memory'));
});

test('a write is a memory only inside the config folder’s projects/<folder>/memory', () => {
  const cfg = tmpDir();
  const inside = path.join(cfg, 'projects', 'C--proj', 'memory', 'use-pnpm.md');
  assert.deepEqual(am.memoryOf(inside, cfg), { file: 'use-pnpm.md', index: false });
  assert.deepEqual(am.memoryOf(path.join(cfg, 'projects', 'C--proj', 'memory', 'MEMORY.md'), cfg), { file: 'MEMORY.md', index: true });
  // A repo of your own with the same shape is not Claude's memory.
  assert.equal(am.memoryOf(path.join(os.tmpdir(), 'repo', 'projects', 'x', 'memory', 'notes.md'), cfg), null);
  assert.equal(am.memoryOf(path.join(cfg, 'projects', 'C--proj', 'memory', 'deep', 'a.md'), cfg), null);
  assert.equal(am.memoryOf(path.join(cfg, 'projects', 'C--proj', 'memory', 'a.txt'), cfg), null);
  assert.equal(am.memoryOf('relative.md', cfg), null);
  assert.equal(am.memoryOf(null, cfg), null);
});

test('frontmatter is read for name, description and type, nested or not', () => {
  assert.deepEqual(am.parse(NOTE), { name: 'use-pnpm', description: 'pnpm in this repo, never npm', type: 'feedback', body: "Use pnpm here.\n\n**Why:** the lockfile is pnpm's." });
  assert.equal(am.parse('---\nname: x\ntype: user\n---\nbody').type, 'user');
  assert.equal(am.parse('---\nname: x\ntype: mood\n---\nbody').type, 'other');
  assert.deepEqual(am.parse('just words'), { name: '', description: '', type: '', body: 'just words' });
  assert.equal(am.parse('---\r\nname: crlf\r\n---\r\nbody').name, 'crlf');
});

test('a new body keeps the frontmatter exactly; the index loses only that file’s line', () => {
  const out = am.withBody(NOTE, 'Use pnpm, and yarn in /legacy.');
  assert.ok(out.startsWith('---\nname: use-pnpm\ndescription: "pnpm in this repo, never npm"\nmetadata:\n  type: feedback\n---\n'));
  assert.ok(out.endsWith('\nUse pnpm, and yarn in /legacy.\n'));
  assert.equal(am.parse(out).body, 'Use pnpm, and yarn in /legacy.');
  assert.equal(am.withBody('no frontmatter', 'new'), 'new\n');

  const index = '- [Use pnpm](use-pnpm.md) — pnpm here\n- [Other](other.md) — x\n- [Dot](./use-pnpm.md) — again';
  assert.equal(am.dropFromIndex(index, 'use-pnpm.md'), '- [Other](other.md) — x');
  assert.equal(am.dropFromIndex(index, 'use+pnpm.md'), index, 'a file name is matched as it is, not as a pattern');
});

test('list reads every memory, newest first, from the folder that has them', async () => {
  const cfg = tmpDir();
  const proj = path.join(os.tmpdir(), 'proj-a');
  const copy = path.join(os.tmpdir(), 'copy-of-a');
  const dir = am.memoryDir(proj, cfg);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'use-pnpm.md'), NOTE);
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [Use pnpm](use-pnpm.md)\n');
  fs.writeFileSync(path.join(dir, 'bare.md'), 'no frontmatter at all');
  fs.writeFileSync(path.join(dir, 'skip.txt'), 'not a memory');
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(path.join(dir, 'bare.md'), later, later);

  // A copy of the repo has none of its own: the checkout it came from is read.
  const r = await am.list([copy, proj], cfg);
  assert.equal(r.dir, dir);
  assert.equal(r.exists, true);
  assert.match(r.index, /use-pnpm/);
  assert.deepEqual(r.memories.map(m => m.file), ['bare.md', 'use-pnpm.md']);
  assert.equal(r.memories[0].name, 'bare', 'no name: the file name');
  assert.equal(r.memories[1].type, 'feedback');

  const none = await am.list([path.join(os.tmpdir(), 'nothing-here')], cfg);
  assert.deepEqual([none.exists, none.memories.length], [false, 0]);
});

test('saving a body refuses anything but a memory, an empty one, or one Claude changed meanwhile', async () => {
  const cfg = tmpDir();
  const dir = am.memoryDir(path.join(os.tmpdir(), 'proj-b'), cfg);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'use-pnpm.md');
  fs.writeFileSync(file, NOTE);
  const { mtimeMs } = fs.statSync(file);

  assert.equal((await am.saveBody(dir, 'use-pnpm.md', 'Use pnpm everywhere.', mtimeMs)).ok, true);
  assert.equal(am.parse(fs.readFileSync(file, 'utf8')).body, 'Use pnpm everywhere.');
  assert.equal(am.parse(fs.readFileSync(file, 'utf8')).type, 'feedback');

  const old = await am.saveBody(dir, 'use-pnpm.md', 'stale', mtimeMs - 10000);
  assert.deepEqual([old.ok, old.conflict], [false, true]);
  assert.equal((await am.saveBody(dir, 'MEMORY.md', 'x')).ok, false);
  assert.equal((await am.saveBody(dir, '../evil.md', 'x')).ok, false);
  assert.equal((await am.saveBody(dir, 'use-pnpm.md', '   ')).ok, false);
  assert.equal((await am.saveBody(path.join(cfg, 'projects'), 'use-pnpm.md', 'x')).ok, false, 'only inside a memory folder');
  assert.equal((await am.saveBody(dir, 'gone.md', 'x')).ok, false);
});

test('forgetting a memory trashes its file and drops its line from the index', async () => {
  const cfg = tmpDir();
  const dir = am.memoryDir(path.join(os.tmpdir(), 'proj-c'), cfg);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'use-pnpm.md'), NOTE);
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [Use pnpm](use-pnpm.md) — x\n- [Keep](keep.md) — y\n');
  const trashed = [];
  const r = await am.forget(dir, 'use-pnpm.md', async p => { trashed.push(p); fs.rmSync(p); });
  assert.equal(r.ok, true);
  assert.deepEqual(trashed, [path.join(dir, 'use-pnpm.md')]);
  assert.equal(fs.readFileSync(path.join(dir, 'MEMORY.md'), 'utf8'), '- [Keep](keep.md) — y\n');

  assert.equal((await am.forget(dir, 'MEMORY.md', async () => {})).ok, false, 'the index itself is never forgotten');
  assert.equal((await am.forget(dir, 'keep.md', async () => { throw new Error('no bin'); })).ok, false);
});
