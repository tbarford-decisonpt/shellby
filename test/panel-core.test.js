// The panel's shared helpers (src/renderer/panel/core.js): plural, the stored
// preferences and the menu item. core.js is a browser script, so it runs here in
// a vm with just enough of a page to load: elements that record what they're
// given, and nothing that draws.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CORE = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel', 'core.js'), 'utf8');

function element(tag) {
  return {
    nodeType: 1, tagName: String(tag).toUpperCase(), children: [], attrs: {}, listeners: {}, dataset: {}, style: { setProperty() {} },
    classList: { toggle() {}, contains: () => false, add() {}, remove() {} },
    append(...kids) { this.children.push(...kids); },
    replaceChildren(...kids) { this.children = kids; },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    removeAttribute(k) { delete this.attrs[k]; },
    hasAttribute(k) { return k in this.attrs; },
    closest: () => null,
    focus() {},
  };
}

function loadCore({ storage } = {}) {
  const byId = new Map();
  const document = {
    body: element('body'),
    scrollingElement: {},
    activeElement: null,
    createElement: element,
    createElementNS: (_ns, tag) => element(tag),
    createTextNode: text => ({ nodeType: 3, text }),
    getElementById: id => { if (!byId.has(id)) byId.set(id, element('div')); return byId.get(id); },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const window = { shellby: {}, addEventListener() {}, localStorage: storage, innerWidth: 400, innerHeight: 600 };
  const context = vm.createContext({ window, document, setTimeout, clearTimeout });
  vm.runInContext(CORE, context, { filename: 'core.js' });
  return { SB: window.SB, document };
}

function memoryStorage() {
  const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('plural says one or many, with "s" unless told the plural', () => {
  const { SB } = loadCore();
  assert.equal(SB.plural(1, 'file'), '1 file');
  assert.equal(SB.plural(0, 'file'), '0 files');
  assert.equal(SB.plural(3, 'file'), '3 files');
  assert.equal(SB.plural(2, 'copy', 'copies'), '2 copies');
  assert.equal(SB.plural(1, 'copy', 'copies'), '1 copy');
});

test('plural writes the number through format when given one', () => {
  const { SB } = loadCore();
  const comma = n => n.toLocaleString('en-US');
  assert.equal(SB.plural(12000, 'castle', undefined, comma), '12,000 castles');
  assert.equal(SB.plural(1, 'castle', undefined, comma), '1 castle');
  assert.equal(SB.plural(2, 'trophy', 'trophies', n => `#${n}`), '#2 trophies');
});

test('pref reads back what was set, and the fallback when there is nothing', () => {
  const { SB } = loadCore({ storage: memoryStorage() });
  assert.equal(SB.pref('shellby.test', 'map'), 'map');
  assert.equal(SB.pref('shellby.test'), null);
  SB.pref.set('shellby.test', 'list');
  assert.equal(SB.pref('shellby.test', 'map'), 'list');
  SB.pref.set('shellby.n', 3600000);
  assert.equal(SB.pref('shellby.n'), '3600000');
  SB.pref.set('shellby.test', '');
  assert.equal(SB.pref('shellby.test', 'map'), 'map', 'an empty value reads as none');
});

test('pref never throws when storage refuses', () => {
  const refusing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const { SB } = loadCore({ storage: refusing });
  assert.equal(SB.pref('shellby.test', 'on'), 'on');
  assert.doesNotThrow(() => SB.pref.set('shellby.test', 'off'));
});

test('menuItem takes (title, onPick) and (title, sub, onPick, options)', () => {
  const { SB } = loadCore();
  const plain = SB.menuItem('Project page', () => {});
  assert.equal(plain.tagName, 'BUTTON');
  assert.equal(plain.attrs.role, 'menuitem');
  assert.equal(plain.className, 'menu-item');
  assert.equal(plain.children.length, 1, 'no check column unless a glyph is given');

  const full = SB.menuItem('Delete', 'Gone for good', () => {}, { tone: 'danger', glyph: '', disabled: true });
  assert.equal(full.className, 'menu-item danger');
  assert.equal(full.attrs.disabled, '');
  assert.equal(full.children.length, 2);
  assert.equal(full.children[0].className, 'mi-check');
  const [title, sub] = full.children[1].children;
  assert.equal(title.textContent, 'Delete');
  assert.equal(sub.textContent, 'Gone for good');
});

test('picking a menu item runs it', () => {
  const { SB } = loadCore();
  let picked = 0;
  const item = SB.menuItem('Rename', () => { picked++; });
  item.listeners.click();
  assert.equal(picked, 1);
});
