const { test } = require('node:test');
const assert = require('node:assert/strict');
const { render } = require('../src/renderer/shared/markdown');

test('escapes raw HTML everywhere', () => {
  const out = render('<script>alert(1)</script> <img src=x onerror=alert(1)>');
  assert.ok(!out.includes('<script'));
  assert.ok(!out.includes('<img'));
  assert.match(out, /&lt;script&gt;/);
});

test('escapes HTML inside code spans and fences', () => {
  assert.match(render('`<b>`'), /<code>&lt;b&gt;<\/code>/);
  const out = render('```html\n<div onclick="x">\n```');
  assert.match(out, /<pre><code data-lang="html">&lt;div onclick=&quot;x&quot;&gt;<\/code><\/pre>/);
});

test('only https links become (inert) anchors', () => {
  assert.match(render('[docs](https://example.com/a?b=1&c=2)'), /<a data-href="https:\/\/example.com\/a\?b=1&amp;c=2" href="#" title="https:\/\/example.com\/a\?b=1&amp;c=2">docs<\/a>/);
  assert.ok(!render('[x](javascript:alert(1))').includes('<a'));
  assert.ok(!render('[x](http://insecure.test)').includes('<a'));
  assert.ok(!render('[x](https://a.test" onmouseover="bad)').includes('onmouseover="'));
});

test('emphasis and code markers inside a link URL leave the URL alone', () => {
  const out = render('[doc](https://ex.com/_draft_/x*y*z) and [**bold** text](https://ex.com/a_b_c)');
  assert.match(out, /data-href="https:\/\/ex.com\/_draft_\/x\*y\*z" href="#" title="https:\/\/ex.com\/_draft_\/x\*y\*z">doc<\/a>/);
  assert.match(out, /data-href="https:\/\/ex.com\/a_b_c" href="#" title="https:\/\/ex.com\/a_b_c"><strong>bold<\/strong> text<\/a>/);
  assert.match(render('[x](https://ex.com/`v`)'), /data-href="https:\/\/ex.com\/`v`"/);
});

test('placeholder characters in the text are dropped, not taken as placeholders', () => {
  const [code, url] = [String.fromCharCode(0), String.fromCharCode(1)];
  const out = render(`a ${code}0${code} b ${url}0${url} [x](https://ex.com/y)`);
  assert.equal(out.includes(code) || out.includes(url), false);
  assert.match(out, /a 0 b 0 <a data-href="https:\/\/ex.com\/y"/);
});

test('lists, headings, emphasis and paragraphs', () => {
  const out = render('# Title\n\n- **one**\n- *two*\n\n1. first\n2. second\n\nplain `code`');
  assert.match(out, /<h3>Title<\/h3>/);
  assert.match(out, /<ul><li><strong>one<\/strong><\/li><li><em>two<\/em><\/li><\/ul>/);
  assert.match(out, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
  assert.match(out, /<p>plain <code>code<\/code><\/p>/);
});

test('does not italicise snake_case or math', () => {
  assert.ok(!render('my_var_name').includes('<em>'));
  assert.ok(!render('2 * 3 * 4').includes('<em>'));
});

// ---------------------------------------------------------------- tables
// Claude summarises changes as GFM tables. Before these, every row fell through
// to a paragraph and the whole table arrived as one run of pipes.

test('a table becomes a real table, header split from body', () => {
  const out = render('| Change | File |\n|---|---|\n| reorder(tabId) | sessions.js:89 |\n| moveTab bridge | preload.js:45 |');
  assert.match(out, /^<div class="md-table"><table>/);
  assert.match(out, /<thead><tr><th>Change<\/th><th>File<\/th><\/tr><\/thead>/);
  assert.match(out, /<tbody><tr><td>reorder\(tabId\)<\/td><td>sessions\.js:89<\/td><\/tr>/);
  assert.match(out, /<tr><td>moveTab bridge<\/td><td>preload\.js:45<\/td><\/tr><\/tbody><\/table><\/div>$/);
  assert.ok(!out.includes('<p>'));
});

test('outer pipes are optional and cells are trimmed', () => {
  const out = render('Change | File\n--- | ---\nreorder | sessions.js');
  assert.match(out, /<th>Change<\/th><th>File<\/th>/);
  assert.match(out, /<td>reorder<\/td><td>sessions\.js<\/td>/);
});

test('alignment rides on data-align, never an inline style (CSP forbids them)', () => {
  const out = render('| L | C | R |\n|:---|:---:|---:|\n| a | b | c |');
  assert.match(out, /<th>L<\/th><th data-align="center">C<\/th><th data-align="right">R<\/th>/);
  assert.match(out, /<td>a<\/td><td data-align="center">b<\/td><td data-align="right">c<\/td>/);
  assert.ok(!out.includes('style='));
});

test('cells render inline markdown and escape HTML', () => {
  const out = render('| What | Where |\n|---|---|\n| **bold** `code` | [docs](https://example.com) |\n| <img src=x> | *em* |');
  assert.match(out, /<td><strong>bold<\/strong> <code>code<\/code><\/td>/);
  assert.match(out, /<td><a data-href="https:\/\/example.com" href="#" title="https:\/\/example.com">docs<\/a><\/td>/);
  assert.match(out, /<td>&lt;img src=x&gt;<\/td>/);
  assert.ok(!out.includes('<img'));
});

test('an escaped pipe stays inside its cell', () => {
  const out = render('| Code | Note |\n|---|---|\n| a \\| b | two cells only |');
  assert.match(out, /<td>a \| b<\/td><td>two cells only<\/td>/);
  assert.ok(!/<td>b<\/td>/.test(out));
});

test('ragged rows are padded and truncated to the header', () => {
  const out = render('| A | B |\n|---|---|\n| only |\n| x | y | z |');
  assert.match(out, /<tr><td>only<\/td><td><\/td><\/tr>/);
  assert.match(out, /<tr><td>x<\/td><td>y<\/td><\/tr>/);
  assert.ok(!out.includes('<td>z</td>'));
});

test('pipes in prose are not a table without a delimiter row', () => {
  const out = render('run a | b to pipe it\nand c | d as well');
  assert.ok(!out.includes('<table'));
  assert.match(out, /<p>run a \| b to pipe it\nand c \| d as well<\/p>/);
});

test('a table ends at a blank line and what follows renders normally', () => {
  const out = render('| A |\n|---|\n| 1 |\n\nAfter the table.\n\n- a list');
  assert.match(out, /<\/table><\/div><p>After the table\.<\/p><ul><li>a list<\/li><\/ul>/);
});

test('a table interrupts a paragraph and a list cleanly', () => {
  const para = render('Here is the summary:\n| A |\n|---|\n| 1 |');
  assert.match(para, /<p>Here is the summary:<\/p><div class="md-table">/);
  const list = render('- one\n- two\n\n| A |\n|---|\n| 1 |');
  assert.match(list, /<\/ul><div class="md-table">/);
});
