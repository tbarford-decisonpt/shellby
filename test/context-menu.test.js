const test = require('node:test');
const assert = require('node:assert');
const { contextTemplate, MAX_SUGGESTIONS } = require('../src/main/context-menu');

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
  const items = contextTemplate({ misspelledWord: 'Shellby', dictionarySuggestions: [], isEditable: true, editFlags: flags }, wc);
  assert.strictEqual(items[0].label, 'No suggestions');
  assert.strictEqual(items[0].enabled, false);
  items.find(i => i.label.startsWith('Add')).click();
  assert.deepStrictEqual(wc.calls, [['add', 'Shellby']]);
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
