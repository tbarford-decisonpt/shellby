// The file viewer's reads (main's viewer.js): only inside the folder it was
// opened on, links followed, and never a file too big or not text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readInside, sameDir, isUnder, MAX_BYTES } = require('../src/main/viewer');

function folder() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-viewer-read-')));
  const root = path.join(base, 'proj');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, 'src', 'b.js'), '\uFEFFconst b = 1;\n');
  fs.mkdirSync(path.join(base, 'outside'));
  fs.writeFileSync(path.join(base, 'outside', 'secret.txt'), 'not yours\n');
  return { base, root, done: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('reads a file inside the folder, with any BOM stripped', async () => {
  const f = folder();
  try {
    assert.deepEqual(await readInside(f.root, 'a.txt'), { ok: true, text: 'one\ntwo\n', size: 8 });
    const b = await readInside(f.root, 'src/b.js');
    assert.equal(b.ok, true);
    assert.equal(b.text, 'const b = 1;\n');
  } finally { f.done(); }
});

test('refuses .., an absolute path outside, and a junction that leads out', async () => {
  const f = folder();
  try {
    assert.equal((await readInside(f.root, '../outside/secret.txt')).ok, false);
    assert.equal((await readInside(f.root, path.join(f.base, 'outside', 'secret.txt'))).ok, false);
    fs.symlinkSync(path.join(f.base, 'outside'), path.join(f.root, 'link'), 'junction');
    const r = await readInside(f.root, 'link/secret.txt');
    assert.equal(r.ok, false);
    assert.equal(r.text, undefined, 'nothing of the file comes back');
  } finally { f.done(); }
});

test('the folder named any way: different case, or not yet resolved', async () => {
  const f = folder();
  try {
    assert.equal((await readInside(f.root.toUpperCase(), 'A.TXT')).ok, true);
    // On CI the temp folder is an 8.3 short name (RUNNER~1); the unresolved form must still work.
    const unresolved = path.join(os.tmpdir(), path.relative(fs.realpathSync.native(os.tmpdir()), f.root));
    assert.equal((await readInside(unresolved, 'a.txt')).ok, true);
  } finally { f.done(); }
});

test('network, drive and stream paths are refused before anything touches the disk', async () => {
  const f = folder();
  try {
    // A UNC path would make Windows log in to that host; it must never reach realpath.
    const fsReal = fs.realpathSync.native;
    const seen = [];
    fs.realpathSync.native = p => { seen.push(p); return fsReal(p); };
    try {
      for (const rel of ['\\\\attacker.example\\share\\x', '//attacker.example/share/x', 'C:x.txt', 'a.txt:secret', 'src/../../outside/secret.txt', 'D:\\other\\x']) {
        assert.deepEqual(await readInside(f.root, rel), { ok: false, missing: true }, rel);
      }
      assert.ok(!seen.some(p => /attacker|other/.test(p)), `realpath never saw them (${seen.join(' | ')})`);
    } finally { fs.realpathSync.native = fsReal; }
  } finally { f.done(); }
});

test('outside the folder answers exactly as missing does: no telling what exists elsewhere', async () => {
  const f = folder();
  try {
    fs.symlinkSync(path.join(f.base, 'outside'), path.join(f.root, 'link'), 'junction');
    const there = await readInside(f.root, 'link/secret.txt');
    const absent = await readInside(f.root, 'link/no-such.txt');
    assert.deepEqual(there, absent);
    assert.deepEqual(there, { ok: false, missing: true });
  } finally { f.done(); }
});

test('missing, gone, too big and binary say so instead of reading', async () => {
  const f = folder();
  try {
    assert.deepEqual(await readInside(f.root, 'nope.txt'), { ok: false, missing: true });
    assert.deepEqual(await readInside(path.join(f.base, 'vanished'), 'a.txt'), { ok: false, gone: true });
    fs.writeFileSync(path.join(f.root, 'big.log'), Buffer.alloc(MAX_BYTES + 1, 0x61));
    assert.equal((await readInside(f.root, 'big.log')).tooBig, true);
    fs.writeFileSync(path.join(f.root, 'img.png'), Buffer.from([0x89, 0x50, 0x00, 0x47]));
    assert.equal((await readInside(f.root, 'img.png')).binary, true);
    assert.equal((await readInside(f.root, 'src')).ok, false, 'a folder is not a file');
    assert.equal((await readInside(f.root, '')).ok, false);
    assert.equal((await readInside(f.root, 'a\0.txt')).ok, false);
  } finally { f.done(); }
});

test('sameDir and isUnder compare resolved paths', () => {
  const f = folder();
  try {
    assert.equal(sameDir(f.root, f.root.toUpperCase()), true);
    assert.equal(sameDir(f.root, path.join(f.root, 'src')), false);
    assert.equal(isUnder(f.root, path.join(f.root, 'src', 'b.js')), true);
    assert.equal(isUnder(f.root, f.root), false);
    assert.equal(isUnder(f.root, path.join(f.base, 'outside')), false);
  } finally { f.done(); }
});
