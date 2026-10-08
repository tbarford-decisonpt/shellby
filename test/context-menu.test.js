const test = require('node:test');
const assert = require('node:assert');
const { contextTemplate, attachContextMenu, KNOWN_WORDS, MAX_SUGGESTIONS } = require('../src/main/context-menu');

const flags = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };

function fakeWc() {
  const calls = [];
  return {
    calls,
    replaceMisspelling: w => calls.push(['replace', w]),
    session: { addWordToSpellCheckerDictionary: w => calls.push(['add', w]) },
  };
}

test('misspelled word offers suggestions that replace it', () => {
  const wc = fakeWc();
  const items = contextTemplate({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'], isEditable: true, editFlags: flags }, wc);
  assert.deepStrictEqual(items.slice(0, 2).map(i => i.label), ['the', 'ten']);
  items[0].click();
  assert.deepStrictEqual(wc.calls, [['replace', 'the']]);
});

test('add to dictionary adds the word to the session', () => {
  const wc = fakeWc();
  const items = contextTemplate({ misspelledWord: 'Zorbly', dictionarySuggestions: [], isEditable: true, editFlags: flags }, wc);
  assert.strictEqual(items[0].label, 'No suggestions');
  assert.strictEqual(items[0].enabled, false);
  items.find(i => i.label.startsWith('Add')).click();
  assert.deepStrictEqual(wc.calls, [['add', 'Zorbly']]);
});

test('attaching the menu teaches the session Shellby\'s own name', () => {
  const wc = fakeWc();
  attachContextMenu({ webContents: { ...wc, on: () => {} } }, { on: () => {} });
  assert.ok(KNOWN_WORDS.includes('Shellby'));
  assert.deepStrictEqual(wc.calls, KNOWN_WORDS.map(w => ['add', w]));
});

// A window whose right-clicks and picks the test drives by hand.
function wired() {
  const wc = { ...fakeWc(), sent: [], handlers: {}, on(ev, fn) { this.handlers[ev] = fn; }, send(ch, p) { this.sent.push([ch, p]); } };
  const ipc = { handlers: {}, on(ch, fn) { this.handlers[ch] = fn; } };
  attachContextMenu({ webContents: wc }, ipc);
  wc.calls.length = 0; // forget teachKnownWords
  return { wc, rightClick: params => wc.handlers['context-menu']({}, params), pick: (index, sender = wc) => ipc.handlers['text-menu:pick']({ sender }, index) };
}

test('right-click sends the panel plain items to draw, no functions', () => {
  const { wc, rightClick } = wired();
  rightClick({ x: 40, y: 60, menuSourceType: 'mouse', misspelledWord: 'teh', dictionarySuggestions: ['the'], isEditable: true, editFlags: flags });
  const [[channel, payload]] = wc.sent;
  assert.strictEqual(channel, 'text-menu');
  assert.deepStrictEqual([payload.x, payload.y, payload.source], [40, 60, 'mouse']);
  assert.deepStrictEqual(payload.items[0], { label: 'the', enabled: true, fix: true, keys: '' });
  assert.ok(payload.items.some(i => i.separator));
  assert.ok(payload.items.find(i => i.label === 'Paste').keys);
  assert.doesNotThrow(() => structuredClone(payload));
});

test('nothing to offer sends nothing', () => {
  const { wc, rightClick } = wired();
  rightClick({ isEditable: false, selectionText: '', editFlags: flags });
  assert.deepStrictEqual(wc.sent, []);
});

test('picking an item by index runs it, once', () => {
  const { wc, rightClick, pick } = wired();
  rightClick({ misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten'], isEditable: true, editFlags: flags });
  pick(1);
  pick(1); // the menu is gone after the first pick
  assert.deepStrictEqual(wc.calls, [['replace', 'ten']]);
});

test('edit items run the webContents method they name', () => {
  const { wc, rightClick, pick } = wired();
  wc.paste = () => wc.calls.push(['paste']);
  rightClick({ misspelledWord: '', isEditable: true, editFlags: flags });
  const items = wc.sent[0][1].items;
  pick(items.findIndex(i => i.label === 'Paste'));
  assert.deepStrictEqual(wc.calls, [['paste']]);
});

test('picks from another window, disabled items and junk indexes do nothing', () => {
  const { wc, rightClick, pick } = wired();
  wc.cut = () => wc.calls.push(['cut']);
  const menu = () => rightClick({ misspelledWord: 'zz', dictionarySuggestions: [], isEditable: true, editFlags: { canCut: true } });
  menu(); pick(0, {});                           // not the panel
  menu(); pick(0);                               // "No suggestions"
  menu(); pick('3'); menu(); pick(99); menu(); pick(-1);
  assert.deepStrictEqual(wc.calls, []);
});

test('suggestions are capped', () => {
  const many = Array.from({ length: 12 }, (_, i) => `w${i}`);
  const items = contextTemplate({ misspelledWord: 'x', dictionarySuggestions: many, isEditable: true, editFlags: flags }, fakeWc());
  assert.strictEqual(items.filter(i => i.click && /^w\d+$/.test(i.label)).length, MAX_SUGGESTIONS);
});

test('editable field without a misspelling gets the edit items only', () => {
  const items = contextTemplate({ misspelledWord: '', isEditable: true, editFlags: { canPaste: true } }, fakeWc());
  assert.deepStrictEqual(items.filter(i => i.role).map(i => i.role), ['cut', 'copy', 'paste', 'selectAll']);
  assert.strictEqual(items.find(i => i.role === 'cut').enabled, false);
  assert.strictEqual(items.find(i => i.role === 'paste').enabled, true);
});

test('selected read-only text gets Copy; nothing selected gets no menu', () => {
  assert.deepStrictEqual(contextTemplate({ isEditable: false, selectionText: 'hi', editFlags: flags }, fakeWc()).map(i => i.role), ['copy']);
  assert.deepStrictEqual(contextTemplate({ isEditable: false, selectionText: '  ', editFlags: flags }, fakeWc()), []);
});
