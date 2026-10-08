const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// Text that went through a UTF-8 -> Windows-1252 round-trip shows up in the UI as
// three junk letters instead of one glyph (0.3 shipped a spinning "a-hat, dash, OE"
// in place of the "◌" tool spinner). A UTF-8 lead byte read
// as cp1252 is one of Â-ô followed by as many continuation chars as that lead
// byte promises (Â-ß one, à-ï two, ð-ô three), which real prose never has. Just
// one is not enough: French has "é…" (0xE9 would lead a three-byte character).
const CONT = '[\\u0080-¿ŒœŠšŸŽžƒˆ˜–—‘-„†-•…‰‹›€™]';
const MOJIBAKE = new RegExp(`[Â-ß]${CONT}|[à-ï]${CONT}{2}|[ð-ô]${CONT}{3}`);

test('the mojibake check catches round-tripped text and lets real accents through', () => {
  // Built from char codes, or this file would fail its own scan: é, ◌, … and 🦀 read as cp1252.
  const cp = (...codes) => String.fromCharCode(...codes);
  const bads = [cp(0xC3, 0xA9), cp(0xE2, 0x2014, 0x152), cp(0xE2, 0x20AC, 0xA6), cp(0xF0, 0x178, 0xA6, 0x20AC)];
  for (const bad of bads) assert.ok(MOJIBAKE.test(bad), bad);
  for (const good of ['la marée a apporté…', 'Ça va ?', 'naïve – café', 'Größe']) assert.ok(!MOJIBAKE.test(good), good);
});
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const ROOT = path.join(__dirname, '..');
const EXTS = new Set(['.js', '.css', '.html', '.json', '.md']);

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (EXTS.has(path.extname(e.name))) yield p;
  }
}

test('source and docs are clean UTF-8 (no mojibake, no stray control chars)', () => {
  const problems = [];
  for (const dir of ['src', 'docs', 'scripts', 'test']) {
    for (const file of files(path.join(ROOT, dir))) {
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const where = `${path.relative(ROOT, file)}:${i + 1}`;
        if (MOJIBAKE.test(line)) problems.push(`${where} mojibake: ${line.trim().slice(0, 80)}`);
        if (CONTROL.test(line.replace(/\r$/, ''))) problems.push(`${where} control character`);
      });
    }
  }
  for (const f of ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md']) {
    if (MOJIBAKE.test(fs.readFileSync(path.join(ROOT, f), 'utf8'))) problems.push(`${f} mojibake`);
  }
  assert.deepEqual(problems, []);
});
