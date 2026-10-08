// The learned rules in a project's CLAUDE.md: exactly what's appended, edits
// and removals that leave the rest of the file alone, and the file itself
// (created when missing, never written over a change made in the meantime).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const lr = require('../src/main/learned-rules');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-learned-'));

// ---------------------------------------------------------------- the text

test('a new section goes at the end, after a blank line, under its heading', () => {
  const p = lr.appendPlan('# My project\n\nBuild with npm.\n', 'Keep functions pure.');
  assert.equal(p.added, '\n## Learned from your corrections\n\n- Keep functions pure.\n');
  assert.equal(p.text, '# My project\n\nBuild with npm.\n\n## Learned from your corrections\n\n- Keep functions pure.\n');
  assert.equal(p.fresh, true);
  assert.equal(lr.appendPlan('', 'Rule.').added, '## Learned from your corrections\n\n- Rule.\n');
  assert.equal(lr.appendPlan('no newline', 'Rule.').added, '\n\n## Learned from your corrections\n\n- Rule.\n');
});

test('a second rule joins the list, before whatever section comes next', () => {
  const md = '# P\n\n## Learned from your corrections\n\n- One.\n\n## Testing\n\nRun npm test.\n';
  const p = lr.appendPlan(md, 'Two.');
  assert.equal(p.added, '- Two.\n');
  assert.equal(p.fresh, false);
  assert.equal(p.text, '# P\n\n## Learned from your corrections\n\n- One.\n- Two.\n\n## Testing\n\nRun npm test.\n');
  assert.deepEqual(lr.rulesIn(p.text), ['One.', 'Two.']);
});

test('the same rule twice is refused, and so is a rule that is not one line', () => {
  const md = lr.appendPlan('', 'Keep functions pure.').text;
  assert.equal(lr.appendPlan(md, 'keep functions PURE.').ok, false);
  assert.equal(lr.appendPlan(md, '   ').ok, false);
  assert.equal(lr.appendPlan(md, 'x'.repeat(301)).ok, false);
  // A heading can't be smuggled in as a rule.
  assert.equal(lr.appendPlan('', '## Not a heading').added, '## Learned from your corrections\n\n- Not a heading\n');
});

test('editRule changes or removes one rule and leaves everything else as it was', () => {
  const md = '# P\n\nIntro.\n\n## Learned from your corrections\n\n- One.\n  - a note under it\n- **Two**, written by hand and well over the usual length of a rule.\n\n## Testing\n\nRun it.\n';
  assert.deepEqual(lr.rulesIn(md), ['One.', '**Two**, written by hand and well over the usual length of a rule.'], 'an indented bullet is not a rule');
  assert.equal(lr.editRule(md, 0, 'One, changed.'), md.replace('- One.', '- One, changed.'));
  assert.equal(lr.editRule(md, 0, null), md.replace('- One.\n', ''));
  assert.equal(lr.editRule(md, 5, null), md, 'an index that is not there changes nothing');
  const two = '# P\n\nIntro.\n\n## Learned from your corrections\n\n- One.\n\n## Testing\n\nRun it.\n';
  assert.equal(lr.editRule(two, 0, null), '# P\n\nIntro.\n\n## Testing\n\nRun it.\n', 'the last one takes the heading with it');
  assert.equal(lr.editRule(lr.appendPlan('# P\n', 'Only.').text, 0, null), '# P\n');
  assert.equal(lr.editRule(lr.appendPlan('', 'Only.').text, 0, null), '');
});

// ---------------------------------------------------------------- the file

test('preview then add creates CLAUDE.md with exactly what was shown', () => {
  const root = tmp();
  try {
    const p = lr.preview(root, 'Keep functions pure.');
    assert.equal(p.ok, true);
    assert.equal(p.exists, false);
    assert.equal(p.file, path.join(root, 'CLAUDE.md'));
    const r = lr.add(root, 'Keep functions pure.', p.added);
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(p.file, 'utf8'), p.added);
    assert.deepEqual(lr.list(root).rules, ['Keep functions pure.']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('nothing is written if CLAUDE.md changed since the preview', () => {
  const root = tmp();
  try {
    const file = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(file, '# P\n');
    const p = lr.preview(root, 'Rule one.');
    // Someone adds the section by hand in the meantime: the text that would go in is different now.
    fs.writeFileSync(file, '# P\n\n## Learned from your corrections\n\n- Old.\n');
    const r = lr.add(root, 'Rule one.', p.added);
    assert.equal(r.ok, false);
    assert.equal(r.changed, true);
    assert.equal(r.preview.added, '- Rule one.\n');
    assert.equal(fs.readFileSync(file, 'utf8'), '# P\n\n## Learned from your corrections\n\n- Old.\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Windows line endings are kept, and .claude/CLAUDE.md is used when it is the only one', () => {
  const root = tmp();
  try {
    fs.mkdirSync(path.join(root, '.claude'));
    const inner = path.join(root, '.claude', 'CLAUDE.md');
    fs.writeFileSync(inner, '# P\r\n\r\nBuild it.\r\n');
    assert.equal(lr.fileFor(root), inner);
    const p = lr.preview(root, 'Rule.');
    assert.equal(lr.add(root, 'Rule.', p.added).ok, true);
    assert.equal(fs.readFileSync(inner, 'utf8'), '# P\r\n\r\nBuild it.\r\n\r\n## Learned from your corrections\r\n\r\n- Rule.\r\n');
    assert.equal(fs.existsSync(path.join(root, 'CLAUDE.md')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('change edits or removes only the rule the list showed', () => {
  const root = tmp();
  try {
    const file = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(file, '# P\n\n## Learned from your corrections\n\n- One.\n- Two.\n');
    assert.equal(lr.change(root, 0, 'Not what it says', 'x').ok, false);
    assert.equal(lr.change(root, 1, 'Two.', 'One.').ok, false, 'no duplicates');
    assert.deepEqual(lr.change(root, 1, 'Two.', 'Two, better.').rules, ['One.', 'Two, better.']);
    assert.deepEqual(lr.change(root, 0, 'One.', null).rules, ['Two, better.']);
    assert.equal(fs.readFileSync(file, 'utf8'), '# P\n\n## Learned from your corrections\n\n- Two, better.\n');
    lr.change(root, 0, 'Two, better.', null);
    assert.equal(fs.readFileSync(file, 'utf8'), '# P\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a project folder that has gone is said plainly", () => {
  assert.equal(lr.preview(path.join(os.tmpdir(), 'shellby-not-here-xyz'), 'Rule.').ok, false);
  assert.equal(lr.preview('relative/path', 'Rule.').ok, false);
});
