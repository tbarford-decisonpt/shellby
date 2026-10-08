// scripts/release-cut.js: reading what you typed. The release itself is
// release-git.js's cutRelease, tested in projects-release-git.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../scripts/release-cut');

test('a version first, then the title in as many words as you typed', () => {
  assert.deepEqual(parseArgs(['0.72.0', 'Change', 'notes']), { version: '0.72.0', title: 'Change notes', dryRun: false });
  assert.deepEqual(parseArgs(['0.72.0', 'Change notes']), { version: '0.72.0', title: 'Change notes', dryRun: false });
});

test('no version means the suggested one, and --dry-run can go anywhere', () => {
  assert.deepEqual(parseArgs(['The', 'inbox', '--dry-run']), { version: null, title: 'The inbox', dryRun: true });
  assert.deepEqual(parseArgs(['--dry-run']), { version: null, title: '', dryRun: true });
  assert.equal(parseArgs(['v0.72.0', 'x']).version, null, 'a tag is not a version: it becomes part of the title');
});
