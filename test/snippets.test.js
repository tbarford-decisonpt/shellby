// Prompt snippets: /review in the panel, `shellby do @review` in a terminal.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const sn = require('../src/main/snippets');

const review = { name: 'review', text: 'Review my diff.' };
const tests = { name: 'tests', text: 'Write tests for $ARGUMENTS, and run them.' };

test('names are short, lowercase and safe to type in any shell', () => {
  assert.equal(sn.normalizeName('review'), 'review');
  assert.equal(sn.normalizeName('  Fix-CI '), 'fix-ci');
  assert.equal(sn.normalizeName('/review'), 'review', 'typed with its slash');
  assert.equal(sn.normalizeName('@review'), 'review', 'typed with its @');
  assert.equal(sn.normalizeName('pr2'), 'pr2');
  for (const bad of ['', '-x', 'a b', 'a.b', 'a/b', '..', 'x'.repeat(33), 'naïve', null, 7, {}]) {
    assert.equal(sn.normalizeName(bad), null, JSON.stringify(bad));
  }
});

test('check refuses what could never run', () => {
  assert.deepEqual(sn.check({ name: 'Review', text: '  Review my diff.\r\n' }), { ok: true, snippet: { name: 'review', text: 'Review my diff.' } });
  assert.match(sn.check({ name: 'export', text: 'x' }).error, /Shellby's own commands/);
  assert.match(sn.check({ name: 'snippets', text: 'x' }).error, /Shellby's own commands/);
  // The panel's Compact and Start fresh send these through the box.
  assert.equal(sn.check({ name: 'compact', text: 'x' }).ok, false);
  assert.equal(sn.check({ name: 'clear', text: 'x' }).ok, false);
  assert.match(sn.check({ name: 'ok', text: '   ' }).error, /What should it ask/);
  assert.match(sn.check({ name: 'ok', text: 'x'.repeat(sn.MAX_TEXT + 1) }).error, /under/);
  assert.match(sn.check({ name: 'a b', text: 'x' }).error, /short name/);
  for (const bad of [null, 'review', [], { name: 'ok', text: 5 }]) assert.equal(sn.check(bad).ok, false);
});

test('a fresh install gets the starters; an emptied list stays empty', () => {
  const first = sn.normalize(null);
  assert.deepEqual(first.map(s => s.name), sn.STARTERS.map(s => s.name));
  assert.ok(first.every(s => sn.check(s).ok), 'every starter passes its own checks');
  first[0].text = 'changed';
  assert.notEqual(sn.STARTERS[0].text, 'changed', 'the starters are copied, not shared');
  assert.deepEqual(sn.normalize([]), []);
  assert.deepEqual(sn.normalize('nonsense'), []);
});

test('normalize drops broken and repeated snippets from settings', () => {
  const list = sn.normalize([review, { name: 'REVIEW', text: 'again' }, { name: 'x y', text: 'z' }, null, tests]);
  assert.deepEqual(list, [review, tests]);
  const many = Array.from({ length: sn.MAX_SNIPPETS + 5 }, (_, i) => ({ name: `s${i}`, text: 'x' }));
  assert.equal(sn.normalize(many).length, sn.MAX_SNIPPETS);
});

test('save adds, edits in place, renames and refuses a clash', () => {
  const added = sn.save([review], tests);
  assert.deepEqual(added, { ok: true, list: [review, tests], name: 'tests' });

  const edited = sn.save(added.list, { name: 'review', text: 'Look over my changes.' }, 'review');
  assert.deepEqual(edited.list[0], { name: 'review', text: 'Look over my changes.' });

  const renamed = sn.save(added.list, { name: 'check', text: 'Review my diff.' }, 'review');
  assert.deepEqual(renamed.list.map(s => s.name), ['check', 'tests'], 'keeps its place');

  assert.match(sn.save(added.list, { name: 'tests', text: 'x' }).error, /already have/);
  assert.match(sn.save(added.list, { name: 'tests', text: 'x' }, 'review').error, /already have/, "can't rename onto another");

  const full = Array.from({ length: sn.MAX_SNIPPETS }, (_, i) => ({ name: `s${i}`, text: 'x' }));
  assert.match(sn.save(full, { name: 'more', text: 'x' }).error, /Delete one/);
  assert.equal(sn.save(full, { name: 's0', text: 'y' }, 's0').ok, true, 'editing still works when full');
});

test('remove and find go by name, however it was typed', () => {
  assert.deepEqual(sn.remove([review, tests], '/Review'), [tests]);
  assert.deepEqual(sn.remove([review], 'nope'), [review]);
  assert.equal(sn.find([review, tests], '@tests'), tests);
  assert.equal(sn.find([review], 'nope'), null);
  assert.equal(sn.find([review], '../x'), null);
});

test('expand fills in $ARGUMENTS, or puts the extra words on the end', () => {
  assert.deepEqual(sn.expand(review), { ok: true, prompt: 'Review my diff.' });
  assert.deepEqual(sn.expand(review, 'Just the auth bits.'), { ok: true, prompt: 'Review my diff.\n\nJust the auth bits.' });
  assert.deepEqual(sn.expand(tests, 'src/app.js'), { ok: true, prompt: 'Write tests for src/app.js, and run them.' });
  const twice = { name: 'two', text: '$ARGUMENTS then $ARGUMENTS' };
  assert.equal(sn.expand(twice, 'a').prompt, 'a then a');
});

test("expand takes what you typed literally, $ patterns and all", () => {
  // String.replace would read these as replacement patterns.
  assert.equal(sn.expand(tests, "$& $' $` $$").prompt, "Write tests for $& $' $` $$, and run them.");
});

test('expand says what a snippet still needs, in the sigil you used', () => {
  assert.match(sn.expand(tests, '').error, /\/tests needs something after it/);
  assert.match(sn.expand(tests, '   ', { sigil: '@' }).error, /@tests needs something after it/);
  assert.match(sn.expand(review, 'x'.repeat(50), { max: 40 }).error, /longer than 40/);
});

test('parseShortcut reads /name and @name with what follows', () => {
  assert.deepEqual(sn.parseShortcut('/review'), { name: 'review', args: '' });
  assert.deepEqual(sn.parseShortcut('/Review  just auth\nand more '), { name: 'review', args: 'just auth\nand more' });
  assert.deepEqual(sn.parseShortcut('@tests src/a.js', '@'), { name: 'tests', args: 'src/a.js' });
  assert.equal(sn.parseShortcut('@Makefile', '@'), null, 'a capital is a file for Claude, not a snippet');
  assert.equal(sn.parseShortcut('/src/app.js'), null);
  assert.equal(sn.parseShortcut('review'), null);
  assert.equal(sn.parseShortcut('please /review'), null);
  assert.equal(sn.parseShortcut(null), null);
});

test('the panel view and the terminal list', () => {
  const v = sn.view([review, tests]);
  assert.deepEqual(v.map(s => [s.name, s.needsInput]), [['review', false], ['tests', true]]);
  assert.equal(sn.summary({ name: 'x', text: `${'a'.repeat(200)}\nsecond` }, 20).length, 20);
  assert.equal(sn.summary({ name: 'x', text: 'first\nsecond' }), 'first');

  const text = sn.cliText([review, tests]);
  assert.match(text, /@review\s+Review my diff\./);
  assert.match(text, /@tests\s+Write tests for/);
  assert.match(sn.cliText([]), /No snippets yet/);
});

test('an unknown @name is answered with the ones there are', () => {
  assert.match(sn.unknownText('reveiw', [review, tests]), /No snippet called @reveiw\. Yours: @review, @tests\./);
  assert.match(sn.unknownText('x', []), /No snippet called @x\. \(shellby snippets/);
});
