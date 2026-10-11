// Your own keys for the panel's shortcuts (src/renderer/panel/shortcuts.js):
// what can change, what's refused and why, and how a keypress is written.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const K = require('../src/renderer/panel/shortcuts');

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

test.afterEach(() => K.useOverrides(null));

test('a changed shortcut answers to its new keys only, and says so everywhere', () => {
  K.useOverrides({ outline: ['Ctrl+Alt+O'] });
  assert.ok(K.matches(key('o', { ctrlKey: true, altKey: true }), 'outline'));
  assert.ok(!K.matches(key('O', { ctrlKey: true, shiftKey: true }), 'outline'));
  assert.equal(K.primary('outline'), 'Ctrl+Alt+O');
  const row = K.grouped().flatMap(g => g.items).find(s => s.id === 'outline');
  assert.deepEqual([row.keys, row.changed, row.changeable], [['Ctrl+Alt+O'], true, true]);
});

test('the getter is read again only when it hands back a new object', () => {
  let settings = { keybindings: { newTab: ['Ctrl+Alt+N'] } };
  K.useOverrides(() => settings.keybindings);
  assert.equal(K.primary('newTab'), 'Ctrl+Alt+N');
  settings = { keybindings: {} };
  assert.equal(K.primary('newTab'), 'Ctrl+T');
});

test('the keys Esc, Enter and typing depend on can\'t change', () => {
  for (const id of ['back', 'stop', 'send', 'newline', 'slash', 'mention', 'askKeys', 'dock', 'moveTab', 'shortcuts']) {
    assert.equal(K.changeable(id), false, id);
    assert.ok(K.checkBinding(id, 'Ctrl+Alt+J'), id);
  }
  K.useOverrides({ send: ['Ctrl+J'] });
  assert.equal(K.primary('send'), 'Enter');
});

test('checkBinding says why not: no modifier, already taken, or meaning something else', () => {
  assert.match(K.checkBinding('outline', 'O'), /Ctrl or Alt/);
  assert.match(K.checkBinding('outline', 'Shift+O'), /Ctrl or Alt/);
  assert.match(K.checkBinding('outline', 'Ctrl+T'), /already “New conversation”/);
  assert.match(K.checkBinding('outline', 'Ctrl+C'), /already means something/);
  assert.match(K.checkBinding('outline', 'Ctrl+3'), /already means something/);
  assert.equal(K.checkBinding('outline', 'Ctrl+Alt+O'), null);
  assert.equal(K.checkBinding('outline', 'F7'), null, 'a function key alone is fine');
  assert.match(K.checkBinding('nope', 'Ctrl+Alt+O'), /can’t be changed/);
});

test('a key moved off one shortcut is free for another, whichever comes first in the table', () => {
  const clean = K.sanitizeOverrides({ reopenTab: ['Ctrl+T'], newTab: ['Ctrl+Alt+N'] });
  assert.deepEqual(clean, { newTab: ['Ctrl+Alt+N'], reopenTab: ['Ctrl+T'] });
  // Two wanting the same key: the one later in the table gives way.
  const both = K.sanitizeOverrides({ outline: ['Ctrl+Alt+X'], problems: ['Ctrl+Alt+X'] });
  assert.deepEqual(both, { outline: ['Ctrl+Alt+X'] });
});

test('sanitizeOverrides drops anything that isn\'t a real change', () => {
  assert.deepEqual(K.sanitizeOverrides({
    send: ['Ctrl+J'],                       // fixed
    made_up: ['Ctrl+Alt+Q'],                // no such shortcut
    find: 'Ctrl+Alt+F',                     // not a list
    newTab: ['Ctrl+T'],                     // the same as it came
    outline: ['Ctrl+Alt+O', 'Ctrl+Alt+O'],  // twice the same
    problems: ['Ctrl+Alt+1', 'Ctrl+Alt+2', 'Ctrl+Alt+3'], // too many ways
    tabList: [`Ctrl+${'x'.repeat(40)}`],    // too long
  }), {});
  assert.deepEqual(K.sanitizeOverrides(null), {});
  assert.deepEqual(K.sanitizeOverrides(['x']), {});
});

test('comboOf writes a keypress the table\'s way', () => {
  assert.equal(K.comboOf(key('o', { ctrlKey: true, shiftKey: true })), 'Ctrl+Shift+O');
  assert.equal(K.comboOf(key('PageDown', { altKey: true })), 'Alt+PgDn');
  assert.equal(K.comboOf(key(' ', { ctrlKey: true })), 'Ctrl+Space');
  assert.equal(K.comboOf(key('?', { ctrlKey: true, shiftKey: true })), 'Ctrl+?', 'Shift is part of a symbol already');
  assert.equal(K.comboOf(key('Control', { ctrlKey: true })), null);
  // And what it writes, matches reads.
  K.useOverrides({ find: [K.comboOf(key('PageDown', { altKey: true }))] });
  assert.ok(K.matches(key('PageDown', { altKey: true }), 'find'));
});
