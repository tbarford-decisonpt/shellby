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
  // /clear is Shellby's own; the panel's Compact sends /compact through the box.
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

// ------------------------------------------------------------ 0.65: blanks, hints, sharing

const fix = { name: 'fix', text: 'Fix issue #$1. What is wrong: $2', hint: 'issue number, then what is wrong' };

test('slots finds $ARGUMENTS and $1 to $9, and leaves prices and $10 alone', () => {
  assert.deepEqual(sn.slots('Fix #$1: $2'), { all: false, count: 2 });
  assert.deepEqual(sn.slots('Only $2 here'), { all: false, count: 2 });
  assert.deepEqual(sn.slots('Tests for $ARGUMENTS'), { all: true, count: 0 });
  for (const plain of ['It costs $5.00', 'about US$5', '$10 off', '$1x', 'a $$1 thing', 'no blanks']) {
    assert.deepEqual(sn.slots(plain), { all: false, count: 0 }, plain);
  }
  assert.equal(sn.needsInput({ text: 'Fix $1, then rerun' }), true, 'a comma after it still counts');
});

test('expand fills $1 to $N a word at a time, the last taking what is left', () => {
  assert.deepEqual(sn.expand(fix, '42 the login page 500s'), { ok: true, prompt: 'Fix issue #42. What is wrong: the login page 500s' });
  assert.equal(sn.expand(fix, '"42 b" fine').prompt, 'Fix issue #42 b. What is wrong: fine', 'quotes keep words together');
  assert.equal(sn.expand(fix, "42 'quoted rest'").prompt, 'Fix issue #42. What is wrong: quoted rest');
  const both = { name: 'b', text: '$1 / $ARGUMENTS' };
  assert.equal(sn.expand(both, 'a b c').prompt, 'a b c / a b c', 'with one blank, $1 is the lot');
  assert.equal(sn.expand({ name: 'r', text: '$1 and $1' }, 'x').prompt, 'x and x');
  assert.equal(sn.expand({ name: 'p', text: 'Use $1' }, "$& $'").prompt, "Use $& $'");
});

test('expand says how many things a snippet needs, with its hint', () => {
  assert.match(sn.expand(fix, '42').error, /\/fix needs 2 things after it: issue number, then what is wrong\./);
  assert.match(sn.expand({ name: 'two', text: '$1 $2' }, 'a', { sigil: '@' }).error, /@two needs 2 things after it, with spaces between them/);
  assert.match(sn.expand(fix, '').error, /\/fix needs something after it, like: \/fix <issue number, then what is wrong>/);
});

test('a hint is kept only when there is a blank for it; newTab only when true', () => {
  assert.deepEqual(sn.check({ name: 'f', text: 'Fix $1', hint: '  <an issue>  ', newTab: true }).snippet, { name: 'f', text: 'Fix $1', hint: 'an issue', newTab: true });
  assert.deepEqual(sn.check({ name: 'f', text: 'No blanks', hint: 'ignored', newTab: 'yes' }).snippet, { name: 'f', text: 'No blanks' });
  assert.match(sn.check({ name: 'f', text: '$1', hint: 'x'.repeat(sn.MAX_HINT + 1) }).error, /hint under/);
  assert.ok(sn.STARTERS.filter(s => s.hint).every(s => sn.needsInput(s)), 'the starters that have hints need input');
});

test('duplicate puts a numbered copy straight after the original', () => {
  const r = sn.duplicate([review, tests], 'review');
  assert.deepEqual(r.list.map(s => s.name), ['review', 'review-2', 'tests']);
  assert.equal(r.list[1].text, review.text);
  assert.equal(sn.duplicate(r.list, 'review').name, 'review-3');
  assert.equal(sn.duplicate([review], 'gone').ok, false);
  assert.equal(sn.freeName([{ name: 'x'.repeat(32), text: 'a' }], 'x'.repeat(32)).length, 32, 'stays within the name limit');
  assert.equal(sn.freeName([], 'export'), 'export-2', 'not one of Shellby\'s own');
});

test('use counts go up, follow a rename and drop with the snippet', () => {
  let u = sn.noteUse({}, 'review', 1000);
  u = sn.noteUse(u, '/Review', 2000);
  assert.deepEqual(u, { review: { n: 2, at: 2000 } });
  assert.deepEqual(sn.keepUse(u, [{ name: 'check', text: 'x' }], { from: 'review', to: 'check' }), { check: { n: 2, at: 2000 } });
  assert.deepEqual(sn.keepUse(u, [tests]), {}, 'a deleted one is forgotten');
  assert.deepEqual(sn.keepUse({ review: 'junk' }, [review]), {});
  const v = sn.view([review, fix], u);
  assert.deepEqual(v.map(s => [s.uses, s.lastUsed, s.slots]), [[2, 2000, 0], [0, null, 2]]);
});

test('export and import go round, skipping what you have and renaming clashes', () => {
  const file = sn.exportJson([review, fix]);
  const parsed = sn.parseImport(file);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.snippets, [review, fix]);
  assert.equal(sn.parseImport(String.fromCharCode(0xFEFF) + JSON.stringify([review])).ok, true, 'a byte-order mark is fine');
  assert.match(sn.parseImport('not json').error, /isn't JSON/);
  assert.match(sn.parseImport('{"a":1}').error, /no list/);

  const mine = [review, { name: 'fix', text: 'Something else' }];
  const r = sn.merge(mine, [review, fix, { name: 'export', text: 'Mine now' }, { name: 'bad name', text: 'x' }]);
  assert.deepEqual(r.added, ['fix-2', 'export-2']);
  assert.deepEqual(r.renamed, [{ from: 'fix', to: 'fix-2' }]);
  assert.equal(r.skipped, 2, 'the identical one and the broken one');
  assert.equal(r.list.length, 4);
  assert.deepEqual(mine.map(s => s.name), ['review', 'fix'], 'the list passed in is left as it was');
  const full = Array.from({ length: sn.MAX_SNIPPETS }, (_, i) => ({ name: `s${i}`, text: `x${i}` }));
  assert.equal(sn.merge(full, [fix]).skipped, 1);
});

test('the terminal list shows what goes after the name', () => {
  assert.match(sn.cliText([review, fix]), /@fix <issue number, then what is wrong>\s+Fix issue/);
});

test('$$1 is a $1 sent as it is, blank or no blank', () => {
  const awk = { name: 'awk', text: "Run awk '{print $$1}' on $ARGUMENTS" };
  assert.deepEqual(sn.slots(awk.text), { all: true, count: 0 });
  assert.equal(sn.expand(awk, 'log.txt').prompt, "Run awk '{print $1}' on log.txt");
  assert.equal(sn.expand({ name: 'p', text: 'It costs $$1 each.' }).prompt, 'It costs $1 each.', 'no blanks, still unescaped');
  assert.equal(sn.expand({ name: 'p', text: 'Price $$1' }, '$$2').prompt, 'Price $1\n\n$$2', 'what you type is never unescaped');
  assert.equal(sn.expand({ name: 'p', text: 'Fix $1' }, '$$1').prompt, 'Fix $$1');
});

test('snippets saved before $1 was a blank keep sending what they did', () => {
  const old = [{ name: 'awk', text: "awk '{print $1, $2}' $ARGUMENTS" }, { name: 'cost', text: 'It costs $1 each' }, 'junk', { name: 'n' }];
  const now = sn.migrate(old);
  assert.equal(now[0].text, "awk '{print $$1, $$2}' $ARGUMENTS", '$ARGUMENTS is still a blank');
  assert.equal(sn.expand(now[0], 'f.txt').prompt, "awk '{print $1, $2}' f.txt");
  assert.equal(sn.needsInput(now[1]), false);
  assert.equal(sn.expand(now[1]).prompt, 'It costs $1 each');
  assert.deepEqual(now.slice(2), ['junk', { name: 'n' }], 'anything else is left for normalize to judge');
  assert.equal(sn.migrate(null), null, 'a fresh install still gets the starters');
  assert.equal(old[0].text, "awk '{print $1, $2}' $ARGUMENTS", 'the list passed in is left as it was');
});

test('only a single quoted thing loses its quotes', () => {
  assert.equal(sn.expand({ name: 'x', text: 'x $1' }, '"a" "b"').prompt, 'x "a" "b"');
  assert.equal(sn.expand({ name: 'x', text: 'x $1' }, '"a b"').prompt, 'x a b');
  assert.deepEqual(sn.splitArgs('"a b" c "d" "e"', 2), ['a b', 'c "d" "e"']);
});
