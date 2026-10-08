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
    contains(el) { return el === this || this.children.some(c => c === el || c.contains?.(el)); },
    focus() {},
  };
}

function loadCore({ storage, search = '' } = {}) {
  const byId = new Map();
  const docListeners = {};
  const body = element('body');
  const classes = new Set();
  body.classList = { toggle() {}, contains: c => classes.has(c), add: c => classes.add(c), remove: c => classes.delete(c) };
  const document = {
    listeners: docListeners,
    body,
    scrollingElement: {},
    activeElement: null,
    createElement: element,
    createElementNS: (_ns, tag) => element(tag),
    createTextNode: text => ({ nodeType: 3, text }),
    getElementById: id => { if (!byId.has(id)) byId.set(id, element('div')); return byId.get(id); },
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) { docListeners[type] = fn; },
  };
  const window = { shellby: {}, addEventListener() {}, localStorage: storage, innerWidth: 400, innerHeight: 600 };
  // The timers and clock as they are now, so a test's mock.timers reach in here too.
  // The page's address: a popped-out conversation's window says which tab it shows (?popout=).
  const context = vm.createContext({
    window, document, location: { search }, URLSearchParams,
    setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, Date: globalThis.Date,
  });
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

// ------------------------------------------------------------------ toasts

const toastText = t => (t.children[0] ? t.children[0].textContent : '');
const toastButtons = t => t.children.filter(c => c.className === 'toast-action');

function withClock(fn) {
  return t => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { SB, document } = loadCore();
    fn({ SB, document, slot: SB.$('toast'), tick: ms => t.mock.timers.tick(ms) });
  };
}

test('a plain toast replaces a plain toast', withClock(({ SB, slot }) => {
  SB.toast('Pushing…', { ms: 30000 });
  SB.toast('Pushed 2 commits.');
  assert.equal(toastText(slot), 'Pushed 2 commits.');
}));

test('a toast with a button keeps its slot when another one comes in', withClock(({ SB, slot }) => {
  SB.toast('It clashes with main.', { ms: 12000, action: 'Ask him to sort it out', onAction() {} });
  SB.toast('New to the Bugdex: Off-by-one', { action: 'Bugdex', ms: 4500, onAction() {} });
  assert.equal(toastText(slot), 'It clashes with main.');
  assert.equal(toastButtons(slot)[0].children[0].text, 'Ask him to sort it out');
}));

test('the one that waited shows once the button toast goes', withClock(({ SB, slot, tick }) => {
  SB.toast('It clashes with main.', { ms: 1000, action: 'Ask him to sort it out', onAction() {} });
  SB.toast('Tabs a and b both changed it.', { ms: 5000 });
  tick(1000 + 2500);
  assert.equal(toastText(slot), 'Tabs a and b both changed it.');
  tick(5000);
  assert.equal(slot.children.length, 0);
}));

test('a waiting toast that has gone stale is dropped', withClock(({ SB, slot, tick }) => {
  SB.toast('It clashes with main.', { ms: 20000, action: 'Ask him to sort it out', onAction() {} });
  SB.toast('Copied.', { ms: 1000 });
  tick(20000 + 2500);
  assert.equal(slot.children.length, 0);
}));

test('the toast stays while the pointer is on it, and lingers a moment after', withClock(({ SB, slot, tick }) => {
  SB.toast('It clashes with main.', { ms: 1000, action: 'Ask him to sort it out', onAction() {} });
  slot.listeners.pointerenter();
  tick(60000);
  assert.equal(toastText(slot), 'It clashes with main.');
  slot.listeners.pointerleave();
  tick(2999);
  assert.equal(toastText(slot), 'It clashes with main.');
  tick(1);
  assert.equal(slot.children.length, 0);
}));

test('clicking the button runs it, and what it says comes before what waited', withClock(({ SB, slot }) => {
  let asked = 0;
  SB.toast('It clashes with main.', { ms: 12000, action: 'Ask him to sort it out', onAction() { asked++; SB.toast('Sent.'); } });
  SB.toast('Tabs a and b both changed it.', { ms: 5000 });
  toastButtons(slot)[0].listeners.click();
  assert.equal(asked, 1);
  assert.equal(toastText(slot), 'Sent.');
}));

test('clicking elsewhere lets your own next toast through', withClock(({ SB, document, slot }) => {
  SB.toast('It clashes with main.', { ms: 12000, action: 'Ask him to sort it out', onAction() {} });
  document.listeners.pointerdown({ target: SB.h('button') });
  SB.toast('Copied.');
  assert.equal(toastText(slot), 'Copied.');
}));

test('picking a menu item runs it', () => {
  const { SB } = loadCore();
  let picked = 0;
  const item = SB.menuItem('Rename', () => { picked++; });
  item.listeners.click();
  assert.equal(picked, 1);
});

test('the panel is the panel; a popped-out window knows its one conversation from its address', () => {
  const panel = loadCore();
  assert.equal(panel.SB.solo, null);
  assert.equal(panel.document.body.classList.contains('solo'), false);
  const popout = loadCore({ search: '?popout=tab-123' });
  assert.equal(popout.SB.solo, 'tab-123');
  assert.equal(popout.document.body.classList.contains('solo'), true);
});
