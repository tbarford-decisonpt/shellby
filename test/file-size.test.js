const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

// Every source file stays under 800 lines (CONTRIBUTING.md): split one before
// it grows past that, not after. Tests and scripts may run long.
const MAX_LINES = 800;
const ROOTS = ['src', path.join('claude-plugin', 'mcp')];
const ROOT = path.join(__dirname, '..');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : jsFiles(p);
    return e.name.endsWith('.js') ? [p] : [];
  });
}

test(`no source file is longer than ${MAX_LINES} lines`, () => {
  const long = ROOTS.flatMap(r => jsFiles(path.join(ROOT, r)))
    .map(f => ({ f: path.relative(ROOT, f), n: fs.readFileSync(f, 'utf8').split('\n').length }))
    .filter(x => x.n > MAX_LINES)
    .map(x => `${x.f} (${x.n})`);
  assert.deepEqual(long, [], `split these: ${long.join(', ')}`);
});
