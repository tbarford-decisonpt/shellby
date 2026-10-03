const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The panel's keyboard contract, checked in its markup and sources (the
// behaviour itself was driven by hand over the DevTools protocol).
const PANEL = path.join(__dirname, '..', 'src', 'renderer', 'panel');
const html = fs.readFileSync(path.join(PANEL, 'panel.html'), 'utf8');
const src = name => fs.readFileSync(path.join(PANEL, name), 'utf8');
const tags = re => [...html.matchAll(re)].map(m => m[0]);

test('a11y.js loads right after core.js, before any view', () => {
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(m => m[1]);
  const at = scripts.indexOf('a11y.js');
  assert.ok(at > 0, 'a11y.js is loaded');
  assert.equal(scripts[at - 1], 'core.js');
});

test('every roving group is a tab list, radio group or listbox with a name', () => {
  const groups = tags(/<[a-z]+[^>]*\bdata-roving\b[^>]*>/g);
  assert.ok(groups.length >= 9, `found ${groups.length}`);
  for (const g of groups) {
    assert.match(g, /role="(tablist|radiogroup|listbox)"/, g);
    assert.match(g, /aria-label="[^"]+"/, g);
  }
});

test('the Wardrobe and Sticker Book groups rove', () => {
  for (const id of ['wdSlots', 'wdGrid', 'stShells', 'stGrid', 'stCardMode']) {
    assert.match(html, new RegExp(`id="${id}"[^>]*data-roving`), id);
  }
});

test('radios say checked, not selected', () => {
  for (const r of tags(/<[a-z]+[^>]*role="radio"[^>]*>/g)) assert.doesNotMatch(r, /aria-selected/, r);
  assert.doesNotMatch(src('stickers.js'), /role: 'radio'[^\n]*aria-selected|setAttribute\('aria-selected'[^\n]*\n[^\n]*stCardMode/);
});

test('emoji-only buttons have a text name', () => {
  const buttons = [...html.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)];
  for (const [whole, attrs, text] of buttons) {
    // Words to read, or empty here and filled in by its script (the level badge, the Claude mode button).
    if (/[\p{L}\p{N}]/u.test(text) || !text.trim()) continue;
    assert.match(attrs, /aria-label="[^"]+"/, whole);
  }
});

test('mood buttons start with a pressed state', () => {
  const moods = tags(/<button[^>]*data-mood="[^"]+"[^>]*>/g);
  assert.equal(moods.length, 4);
  for (const m of moods) assert.match(m, /aria-pressed="(true|false)"/, m);
});
