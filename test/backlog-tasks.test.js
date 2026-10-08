const { test } = require('node:test');
const assert = require('node:assert/strict');
const tasks = require('../src/main/backlog/tasks');

const { parse, add, tick, rename, remove, move, MAX_ITEMS, TEMPLATE } = tasks;

const SAMPLE = [
  '# Tasks',
  '',
  'Some prose that is not a task.',
  '',
  '| a | b |',
  '| - | - |',
  '| 1 | 2 |',
  '',
  '## Now',
  '- [ ] Fix the flicker',
  '  Only on the second monitor.',
  '    - [ ] sub item',
  '',
  '## Next',
  '- [ ] #42 start with the parser',
  '- [ ] me/crab#7: other repo note',
  '- [x] Already done (2026-01-01)',
  '',
  '## Later',
  '- [ ] Polish the icons',
  '',
  '## Someday',
  '- [ ] Learn Rust',
  '',
  '## Ideas',
  '- [ ] Under an unknown heading',
  '',
  '## Done',
  '- [x] Old one (2026-02-02)',
  '',
].join('\n');

const byTitle = (text, title) => parse(text).items.find(i => i.title === title);
const ref = i => ({ id: i.id, line: i.line });

// ------------------------------------------------------------------ parse

test('parse puts items in their sections and any other heading in next', () => {
  const { items } = parse(SAMPLE);

  assert.deepEqual(items.map(i => [i.title, i.section]), [
    ['Fix the flicker', 'now'],
    ['#42 start with the parser', 'next'],
    ['me/crab#7: other repo note', 'next'],
    ['Polish the icons', 'later'],
    ['Learn Rust', 'later'],
    ['Under an unknown heading', 'next'],
  ]);
  assert.equal(items[5].heading, 'Ideas');
  assert.equal(items[0].line, 10);
});

test('parse counts done items without listing them', () => {
  const r = parse(SAMPLE);

  assert.equal(r.done, 2);
  assert.ok(!r.items.some(i => /Already done|Old one/.test(i.title)));
});

test('parse keeps notes under an item and sub-items keep their indent', () => {
  const item = byTitle(SAMPLE, 'Fix the flicker');

  assert.deepEqual(item.notes, ['Only on the second monitor.', '  - [ ] sub item']);
});

test('parse reads #42 and owner/name#42 references with the trailing note', () => {
  const a = byTitle(SAMPLE, '#42 start with the parser');
  const b = byTitle(SAMPLE, 'me/crab#7: other repo note');

  assert.deepEqual(a.ref, { repo: null, number: 42, note: 'start with the parser' });
  assert.deepEqual(b.ref, { repo: 'me/crab', number: 7, note: 'other repo note' });
  assert.equal(byTitle(SAMPLE, 'Polish the icons').ref, null);
});

test('parse does not take #42abc or #42-x for a reference', () => {
  const { items } = parse('## Next\n- [ ] #42abc nope\n- [ ] #7-beta nope\n');

  assert.deepEqual(items.map(i => i.ref), [null, null]);
});

test('parse reads a CRLF file the same as an LF one', () => {
  const lf = parse(SAMPLE);
  const crlf = parse(SAMPLE.replace(/\n/g, '\r\n'));

  assert.deepEqual(crlf, lf);
});

test('parse reads a file with no trailing newline', () => {
  const { items } = parse('## Now\n- [ ] last one');

  assert.deepEqual(items.map(i => i.title), ['last one']);
});

test('parse gives nothing for an empty file, null, or only prose', () => {
  assert.deepEqual(parse(''), { items: [], done: 0, more: 0 });
  assert.deepEqual(parse(null), { items: [], done: 0, more: 0 });
  assert.deepEqual(parse('# Title\n\nJust words.\n\n| a | b |\n').items, []);
});

test('parse caps the list at MAX_ITEMS and says how many more there were', () => {
  const text = `## Next\n${Array.from({ length: MAX_ITEMS + 5 }, (_, i) => `- [ ] task ${i}`).join('\n')}\n`;

  const r = parse(text);

  assert.equal(r.items.length, MAX_ITEMS);
  assert.equal(r.more, 5);
});

test('parse strips invisible and bidi characters from titles and notes', () => {
  const rlo = String.fromCharCode(0x202e);
  const zwsp = String.fromCharCode(0x200b);
  const bell = String.fromCharCode(7);
  const text = `## Next\n- [ ] re${rlo}ad${zwsp} me${bell}\n  note${rlo} here\n`;

  const [item] = parse(text).items;

  assert.equal(item.title, 'read me');
  assert.deepEqual(item.notes, ['note here']);
});

test('parse does not list an item whose text is only invisible characters', () => {
  const text = `## Next\n- [ ] ${String.fromCharCode(0x200b)}\n- [ ] real\n`;

  assert.deepEqual(parse(text).items.map(i => i.title), ['real']);
});

// ------------------------------------------------------------------ ids

test('ids stay the same when lines above the item move', () => {
  const before = byTitle(SAMPLE, 'Polish the icons');
  const moved = byTitle(`Extra line\nAnd another\n${SAMPLE}`, 'Polish the icons');

  assert.equal(moved.id, before.id);
  assert.equal(moved.line, before.line + 2);
  assert.match(before.id, /^t:[0-9a-f]{10}$/);
});

test('ids differ for the same title in different sections', () => {
  const { items } = parse('## Now\n- [ ] same\n## Later\n- [ ] same\n');

  assert.notEqual(items[0].id, items[1].id);
});

test('duplicates in one section get ~2, ~3', () => {
  const { items } = parse('## Next\n- [ ] same\n- [ ] Same\n- [ ] same\n');

  assert.ok(!items[0].id.includes('~'));
  assert.equal(items[1].id, `${items[0].id}~2`);
  assert.equal(items[2].id, `${items[0].id}~3`);
});

// ------------------------------------------------------------------ edits round-trip


const linesOf = text => text.replace(/\r?\n$/, '').split(/\r?\n/);

// Non-blank lines left once the given lines are dropped.
const rest = (text, drop) => linesOf(text).filter(l => l.trim() && !drop.includes(l));

test('tick changes only the item and where it sits, keeping the rest byte for byte', () => {
  const item = byTitle(SAMPLE, 'Polish the icons');

  const r = tick(SAMPLE, ref(item), '2026-10-06');

  assert.ok(r.ok);
  const block = ['- [ ] Polish the icons'];
  assert.deepEqual(rest(r.text, ['- [x] Polish the icons (2026-10-06)']), rest(SAMPLE, block));
});

test('rename changes one line and nothing else', () => {
  const item = byTitle(SAMPLE, 'Fix the flicker');

  const r = rename(SAMPLE, ref(item), 'Fix the flicker for real');

  assert.ok(r.ok);
  const before = linesOf(SAMPLE);
  const after = linesOf(r.text);
  assert.equal(after.length, before.length);
  after.forEach((l, i) => { if (i !== item.line - 1) assert.equal(l, before[i]); });
  assert.equal(after[item.line - 1], '- [ ] Fix the flicker for real');
});

test('remove drops the item and its notes and nothing else', () => {
  const item = byTitle(SAMPLE, 'Fix the flicker');

  const r = remove(SAMPLE, ref(item));

  assert.ok(r.ok);
  const before = linesOf(SAMPLE);
  const expected = [...before.slice(0, 9), ...before.slice(12)];
  assert.deepEqual(linesOf(r.text), expected);
});

test('add only adds one line to a file that has a Next section', () => {
  const r = add(SAMPLE, 'Brand new');

  assert.ok(r.ok);
  const after = linesOf(r.text);
  const before = linesOf(SAMPLE);
  assert.equal(after.length, before.length + 1);
  assert.deepEqual(after.filter(l => l !== '- [ ] Brand new'), before);
});

test('move takes the item and its notes and leaves the rest alone', () => {
  const item = byTitle(SAMPLE, 'Fix the flicker');

  const r = move(SAMPLE, ref(item), 'later');

  assert.ok(r.ok);
  assert.deepEqual(rest(r.text, []).sort(), rest(SAMPLE, []).sort());
  assert.equal(byTitle(r.text, 'Fix the flicker').section, 'later');
  assert.deepEqual(byTitle(r.text, 'Fix the flicker').notes, ['Only on the second monitor.', '  - [ ] sub item']);
});

test('every edit keeps CRLF line endings', () => {
  const crlf = SAMPLE.replace(/\n/g, '\r\n');
  const item = byTitle(crlf, 'Polish the icons');
  const results = [
    add(crlf, 'new one'),
    tick(crlf, ref(item), '2026-10-06'),
    rename(crlf, ref(item), 'renamed'),
    remove(crlf, ref(item)),
    move(crlf, ref(item), 'now'),
  ];

  for (const r of results) {
    assert.ok(r.ok);
    assert.ok(!/(^|[^\r])\n/.test(r.text), 'no bare LF');
    assert.ok(r.text.endsWith('\r\n'));
  }
});

test('every edit keeps a missing trailing newline missing, and a present one present', () => {
  const noEnd = SAMPLE.replace(/\n$/, '');
  const item = byTitle(noEnd, 'Polish the icons');
  const withEnd = byTitle(SAMPLE, 'Polish the icons');
  const edits = [
    t => add(t, 'new one'),
    t => tick(t, ref(byTitle(t, 'Polish the icons')), '2026-10-06'),
    t => rename(t, ref(byTitle(t, 'Polish the icons')), 'renamed'),
    t => remove(t, ref(byTitle(t, 'Polish the icons'))),
    t => move(t, ref(byTitle(t, 'Polish the icons')), 'now'),
  ];

  assert.ok(item && withEnd);
  for (const run of edits) {
    assert.ok(!run(noEnd).text.endsWith('\n'));
    assert.ok(run(SAMPLE).text.endsWith('\n'));
  }
});

// ------------------------------------------------------------------ add

test('add to empty or null text builds the file from the template', () => {
  for (const empty of ['', null, undefined]) {
    const r = add(empty, 'First');

    assert.ok(r.ok);
    assert.equal(r.text, TEMPLATE.replace(/## Next\n$/, '## Next\n- [ ] First\n'));
  }
});

test('add puts the task at the end of Next, before the next heading', () => {
  const r = add('## Next\n- [ ] a\n\n## Later\n- [ ] b\n', 'c');

  assert.equal(r.text, '## Next\n- [ ] a\n- [ ] c\n\n## Later\n- [ ] b\n');
});

test('add makes a Next section after Now when only Now exists', () => {
  const r = add('# Tasks\n\n## Now\n- [ ] a\n\n## Done\n- [x] z (2026-01-01)\n', 'b');

  assert.equal(r.text, '# Tasks\n\n## Now\n- [ ] a\n\n## Next\n- [ ] b\n\n## Done\n- [x] z (2026-01-01)\n');
});

test('add appends a Next section when the file has no headings', () => {
  const r = add('just words\n', 'b');

  assert.equal(r.text, 'just words\n\n## Next\n- [ ] b\n');
});

test('add with to: now makes Now before the first section', () => {
  const r = add('# Tasks\n\n## Next\n- [ ] a\n', 'urgent', { to: 'now' });

  assert.equal(r.text, '# Tasks\n\n## Now\n- [ ] urgent\n\n## Next\n- [ ] a\n');
});

test('add refuses an empty title', () => {
  for (const t of ['', '   ', null, String.fromCharCode(0x200b)]) {
    const r = add(SAMPLE, t);

    assert.equal(r.ok, false);
    assert.match(r.error, /Write the task first/);
  }
});

test('add clips a long title to MAX_TITLE', () => {
  const r = add('', 'x'.repeat(500));

  assert.equal(parse(r.text).items[0].title.length, tasks.MAX_TITLE);
});

test('add refuses once the list has MAX_ITEMS tasks', () => {
  const text = `## Next\n${Array.from({ length: MAX_ITEMS }, (_, i) => `- [ ] task ${i}`).join('\n')}\n`;

  const r = add(text, 'one too many');

  assert.equal(r.ok, false);
  assert.match(r.error, new RegExp(String(MAX_ITEMS)));
});

// ------------------------------------------------------------------ tick

test('tick moves the item and its notes under Done with a date and [x]', () => {
  const item = byTitle(SAMPLE, 'Fix the flicker');

  const r = tick(SAMPLE, ref(item), '2026-10-06');

  assert.ok(r.ok);
  const lines = linesOf(r.text);
  const done = lines.indexOf('## Done');
  assert.deepEqual(lines.slice(done + 1, done + 5), [
    '- [x] Old one (2026-02-02)',
    '- [x] Fix the flicker (2026-10-06)',
    '  Only on the second monitor.',
    '    - [ ] sub item',
  ]);
  assert.equal(parse(r.text).done, 3);
  assert.ok(!parse(r.text).items.some(i => i.title === 'Fix the flicker'));
});

test('tick creates a Done section when there is none', () => {
  const r = tick('## Next\n- [ ] a\n- [ ] b\n', ref(parse('## Next\n- [ ] a\n- [ ] b\n').items[0]), '2026-10-06');

  assert.equal(r.text, '## Next\n- [ ] b\n\n## Done\n- [x] a (2026-10-06)\n');
});

test('tick replaces an earlier date instead of stacking two', () => {
  const text = '## Next\n- [ ] a (2020-01-01)\n';

  const r = tick(text, ref(parse(text).items[0]), '2026-10-06');

  assert.match(r.text, /- \[x\] a \(2026-10-06\)\n$/);
  assert.ok(!r.text.includes('2020-01-01'));
});

test('tick uses today when it is not given a valid date', () => {
  const text = '## Next\n- [ ] a\n';

  const r = tick(text, ref(parse(text).items[0]), 'tomorrow-ish');

  assert.match(r.text, /- \[x\] a \(\d{4}-\d\d-\d\d\)\n$/);
});

// ------------------------------------------------------------------ move

test('move to later creates a Later section before Done', () => {
  const text = '## Next\n- [ ] a\n\n## Done\n- [x] z (2026-01-01)\n';

  const r = move(text, ref(parse(text).items[0]), 'later');

  assert.equal(r.text, '## Next\n\n## Later\n- [ ] a\n\n## Done\n- [x] z (2026-01-01)\n');
});

test('move refuses anywhere but now, next and later', () => {
  const item = parse(SAMPLE).items[0];

  const r = move(SAMPLE, ref(item), 'done');

  assert.equal(r.ok, false);
  assert.ok(!r.stale);
});

test('move re-indents an indented item to sit at the left of its section', () => {
  const text = '## Next\n  - [ ] a\n    note\n\n## Later\n';

  const r = move(text, ref(parse(text).items[0]), 'later');

  assert.ok(r.ok);
  assert.ok(r.text.includes('## Later\n- [ ] a\n  note\n'));
});

// ------------------------------------------------------------------ rename / remove

test('rename keeps the notes and the item\'s indent', () => {
  const text = '## Next\n  - [ ] old\n    note\n';

  const r = rename(text, ref(parse(text).items[0]), 'new');

  assert.equal(r.text, '## Next\n  - [ ] new\n    note\n');
});

test('rename refuses an empty title', () => {
  const r = rename(SAMPLE, ref(parse(SAMPLE).items[0]), '  ');

  assert.equal(r.ok, false);
  assert.ok(!r.stale);
});

// ------------------------------------------------------------------ stale

test('an edit that names the wrong line is stale', () => {
  const item = byTitle(SAMPLE, 'Polish the icons');
  const wrong = { id: item.id, line: item.line + 1 };

  for (const r of [
    tick(SAMPLE, wrong, '2026-10-06'),
    rename(SAMPLE, wrong, 'x'),
    remove(SAMPLE, wrong),
    move(SAMPLE, wrong, 'now'),
  ]) {
    assert.equal(r.ok, false);
    assert.equal(r.stale, true);
  }
});

test('an edit that names an unknown id is stale', () => {
  const r = remove(SAMPLE, { id: 't:0000000000', line: 10 });

  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
});

test('an edit is stale after the file changed under it', () => {
  const item = byTitle(SAMPLE, 'Polish the icons');
  const changed = `Added above\n${SAMPLE}`;

  const r = remove(changed, ref(item));

  assert.equal(r.stale, true);
});
