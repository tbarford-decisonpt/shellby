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
  assert.match(render('[docs](https://example.com/a?b=1&c=2)'), /<a data-href="https:\/\/example.com\/a\?b=1&amp;c=2" href="#">docs<\/a>/);
  assert.ok(!render('[x](javascript:alert(1))').includes('<a'));
  assert.ok(!render('[x](http://insecure.test)').includes('<a'));
  assert.ok(!render('[x](https://a.test" onmouseover="bad)').includes('onmouseover="'));
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
