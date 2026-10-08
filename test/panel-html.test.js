// The panel's page is built from src/renderer/panel/html/ (scripts/panel-html.js).
// The built panel.html is committed, so it has to match what its pieces say.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { build, OUT } = require('../scripts/panel-html');

test('panel.html is what html/ builds: after editing a piece, run npm run panel:html', () => {
  const { html } = build();
  assert.ok(fs.readFileSync(OUT, 'utf8') === html, 'panel.html is out of date: run npm run panel:html');
});

test('every piece in html/ is used, once', () => {
  const { used, unused } = build();
  assert.deepEqual(unused, []);
  assert.equal(new Set(used).size, used.length);
});

test('a screen per piece: each <main> view lives in a file of its own', () => {
  const frame = fs.readFileSync(require('path').join(__dirname, '..', 'src', 'renderer', 'panel', 'html', 'frame.html'), 'utf8');
  assert.doesNotMatch(frame, /<main class="view/);
  assert.ok(build().html.match(/<main class="view/g).length >= 20);
});
