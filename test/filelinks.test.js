const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const E = require('../src/main/filelinks');

const CWD = 'C:\\work\\shellby';

test('a network path never opens: looking at it would log in to that host', () => {
  assert.equal(E.parseTarget('\\\\attacker\\share\\notes.txt', CWD), null);
  assert.equal(E.parseTarget('//attacker/share/notes.txt', CWD), null);
  assert.equal(E.parseTarget('`\\\\attacker\\share\\a.md:3`', CWD), null);
  assert.ok(E.parseTarget('C:\\work\\a.md', CWD));
});

test('auto picks the first editor that is installed; a named one only if it is', () => {
  const only = (...schemes) => s => schemes.includes(s);
  assert.equal(E.pickEditor('auto', only('vscode', 'cursor')), 'vscode');
  assert.equal(E.pickEditor('auto', only('cursor')), 'cursor');
  assert.equal(E.pickEditor('auto', only()), null);
  assert.equal(E.pickEditor('cursor', only('vscode', 'cursor')), 'cursor');
  assert.equal(E.pickEditor('windsurf', only('vscode')), null);
  assert.equal(E.pickEditor('system', only('vscode')), null);
  assert.equal(E.pickEditor(undefined, only('vscode')), 'vscode');
});

test('editor links: forward slashes, an upper-case drive, encoded names, line and column', () => {
  assert.equal(E.editorUrl('vscode', 'c:\\work\\shellby\\src\\main.js', 12, 3), 'vscode://file/C:/work/shellby/src/main.js:12:3');
  assert.equal(E.editorUrl('cursor', 'C:\\My Stuff\\a#b.txt', 4), 'cursor://file/C:/My%20Stuff/a%23b.txt:4');
  assert.equal(E.editorUrl('insiders', 'C:\\work'), 'vscode-insiders://file/C:/work');
});

test('parseTarget reads paths as Claude writes them', () => {
  assert.deepEqual(E.parseTarget('src/main.js:42', CWD), { file: path.resolve(CWD, 'src/main.js'), line: 42, col: null });
  assert.deepEqual(E.parseTarget('`src\\a.js:3:9`', CWD), { file: path.resolve(CWD, 'src/a.js'), line: 3, col: 9 });
  assert.deepEqual(E.parseTarget('C:\\other\\x.ts(10,2)', CWD), { file: 'C:\\other\\x.ts', line: 10, col: 2 });
  assert.deepEqual(E.parseTarget('@package.json', CWD), { file: path.resolve(CWD, 'package.json'), line: null, col: null });
  assert.deepEqual(E.parseTarget('C:\\', CWD), { file: 'C:\\', line: null, col: null });
  assert.equal(E.parseTarget('relative.js', null), null);
  assert.equal(E.parseTarget('', CWD), null);
  assert.equal(E.parseTarget('a|b', CWD), null);
  assert.equal(E.parseTarget(42, CWD), null);
});

test('files that would run when opened are recognised', () => {
  for (const f of ['setup.exe', 'x.BAT', 'a.ps1', 'b.lnk', 'c.js', 'd.msi', 'e.vbs', 'f.py', 'g.iso', 'h.xlsm']) assert.equal(E.runsWhenOpened(f), true, f);
  for (const f of ['notes.txt', 'a.md', 'b.json', 'c.png', 'README', 'd.ts']) assert.equal(E.runsWhenOpened(f), false, f);
});

test('the settings choices are the editors plus auto and system', () => {
  assert.deepEqual(E.CHOICES, ['auto', 'vscode', 'cursor', 'windsurf', 'insiders', 'system']);
});
