// Ctrl+F (src/renderer/panel/find.js) finds text in edit rows whose diff hasn't
// been built yet (feed.js builds each on first open). find.js is a browser
// script, so it runs here in a vm with just enough of a page to load.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const FIND = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel', 'find.js'), 'utf8');

const element = () => ({ hidden: true, value: '', textContent: '', classList: { toggle() {} }, addEventListener() {}, focus() {}, select() {} });

function loadFind(rows) {
  const ids = new Map();
  const root = {
    querySelectorAll: sel => (sel === 'details[data-edit]' ? rows.map(r => r.el) : []),
    getBoundingClientRect: () => ({ top: 0, bottom: 0 }),
  };
  const unbuiltDiffs = new Map(rows.map(r => [r.el, r.lazy]));
  const SB = {
    $: id => { if (!ids.has(id)) ids.set(id, element()); return ids.get(id); },
    state: { view: 'chat' },
    activeTab: () => ({ el: root }),
    unbuiltDiffs,
    setView() {},
    shortcuts: { matches: () => false },
  };
  const highlights = new Map();
  const context = {
    SB,
    document: { addEventListener() {}, createTreeWalker: () => ({ nextNode: () => false }) },
    NodeFilter: { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 },
    CSS: { highlights },
    Highlight: class {},
    Range: class {},
    MutationObserver: class { observe() {} disconnect() {} },
    setTimeout, clearTimeout,
  };
  vm.runInNewContext(FIND, context);
  return { find: SB.find, input: SB.$('findInput') };
}

function row(text) {
  const r = { el: {}, built: 0 };
  r.lazy = { text: text.toLowerCase(), build: () => { r.built++; } };
  return r;
}

test('an unopened edit row whose change holds the text has its diff built, so it can be found', () => {
  const hit = row('const Needle = 1;\nconst needle = 2;');
  const miss = row('nothing here');
  const { find, input } = loadFind([hit, miss]);
  input.value = 'needle';
  find.open();
  assert.equal(hit.built, 1);
  assert.equal(miss.built, 0, 'rows without it stay unbuilt');
});

test('a single letter builds nothing: it would build every row', () => {
  const r = row('n');
  const { find, input } = loadFind([r]);
  input.value = 'n';
  find.open();
  assert.equal(r.built, 0);
});
