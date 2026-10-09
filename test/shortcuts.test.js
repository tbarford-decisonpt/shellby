// The panel's shortcut table (src/renderer/panel/shortcuts.js): the one list the
// cheat sheet, the Ctrl+K palette and the newer handlers all read, how a keydown
// is matched against it, the palette's ranking, and finding a conversation's project.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const K = require('../src/renderer/panel/shortcuts');

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...mods });

test('every shortcut has an id, a group, keys and words, and ids are unique', () => {
  const ids = new Set();
  for (const s of K.SHORTCUTS) {
    assert.ok(s.id && !ids.has(s.id), `unique id: ${s.id}`);
    ids.add(s.id);
    assert.ok(K.GROUPS.includes(s.group), s.id);
    assert.ok(Array.isArray(s.keys) && s.keys.length, s.id);
    assert.ok(s.what && s.what.length > 3, s.id);
  }
});

test('no two shortcuts can be pressed the same way', () => {
  const seen = new Map();
  for (const s of K.SHORTCUTS) {
    for (const combo of s.keys) {
      const c = K.parse(combo);
      if (!c) continue;
      const sig = `${c.ctrl}|${c.shift}|${c.alt}|${c.key.toLowerCase()}`;
      // Esc does one thing at a time (stop while working, otherwise back): that pair is meant.
      if (seen.has(sig) && c.key === 'Escape') continue;
      assert.ok(!seen.has(sig), `${combo} is both ${seen.get(sig)} and ${s.id}`);
      seen.set(sig, s.id);
    }
  }
});

test('the new shortcuts leave the text box and the browser alone', () => {
  // Text editing in the composer, and Chromium/Electron keys that mean something already.
  const taken = ['Ctrl+Z', 'Ctrl+Y', 'Ctrl+Shift+Z', 'Ctrl+A', 'Ctrl+C', 'Ctrl+X', 'Ctrl+Shift+I', 'Ctrl+Shift+R', 'Ctrl+Backspace', 'Ctrl+Delete'];
  const ours = K.SHORTCUTS.flatMap(s => s.keys.filter(k => s.id !== 'paste').map(k => k.toLowerCase()));
  for (const t of taken) assert.ok(!ours.includes(t.toLowerCase()), t);
});

test('parse reads modifiers, named keys and symbols, and skips ones only shown', () => {
  assert.deepEqual(K.parse('Ctrl+Shift+PgUp'), { ctrl: true, shift: true, alt: false, key: 'PageUp' });
  assert.deepEqual(K.parse('Ctrl+/'), { ctrl: true, shift: false, alt: false, key: '/' });
  assert.deepEqual(K.parse('?'), { ctrl: false, shift: false, alt: false, key: '?' });
  assert.deepEqual(K.parse('Esc'), { ctrl: false, shift: false, alt: false, key: 'Escape' });
  assert.equal(K.parse('Ctrl+1…6'), null);
  assert.equal(K.parse('Esc Esc'), null);
  assert.equal(K.parse(''), null);
});

test('matches a keydown against any of its ways, with exact modifiers', () => {
  assert.ok(K.matches(key('Tab', { ctrlKey: true }), 'nextTab'));
  assert.ok(K.matches(key('PageDown', { ctrlKey: true }), 'nextTab'));
  assert.ok(!K.matches(key('PageDown', { ctrlKey: true, shiftKey: true }), 'nextTab'), 'that one moves the tab');
  assert.ok(K.matches(key('PageDown', { ctrlKey: true, shiftKey: true }), 'moveTab'));
  assert.ok(K.matches(key('Tab', { ctrlKey: true, shiftKey: true }), 'prevTab'));
  assert.ok(K.matches(key('D', { ctrlKey: true, shiftKey: true }), 'showChanges'), 'a capital from Shift still matches');
  assert.ok(!K.matches(key('d', { ctrlKey: true }), 'showChanges'), 'Shift is part of it');
  assert.ok(!K.matches(key('d', { ctrlKey: true, shiftKey: true, altKey: true }), 'showChanges'), 'and Alt is not');
  assert.ok(!K.matches(key('t', { ctrlKey: true, metaKey: true }), 'newTab'));
  assert.ok(!K.matches(key('b', { ctrlKey: true, shiftKey: true, isComposing: true }), 'tryAgain'), 'not mid-IME');
  assert.ok(!K.matches(key('k', { ctrlKey: true }), 'nope'));
});

test('a symbol matches with or without Shift, since keyboards differ', () => {
  assert.ok(K.matches(key('?', { shiftKey: true }), 'shortcuts'));
  assert.ok(K.matches(key('/', { ctrlKey: true }), 'shortcuts'));
  assert.ok(K.matches(key('/', { ctrlKey: true, shiftKey: true }), 'shortcuts'));
  assert.ok(!K.matches(key('/'), 'shortcuts'), 'a bare / is for the box (skills)');
});

test('label and primary say how to press it', () => {
  assert.equal(K.label('nextTab'), 'Ctrl+Tab or Ctrl+PgDn');
  assert.equal(K.primary('nextTab'), 'Ctrl+Tab');
  assert.equal(K.label('nope'), '');
  assert.equal(K.primary('nope'), '');
});

test('grouped keeps the table order, every shortcut once', () => {
  const g = K.grouped();
  assert.deepEqual(g.map(x => x.group), K.GROUPS);
  assert.equal(g.flatMap(x => x.items).length, K.SHORTCUTS.length);
});

test('every shortcut the palette shows exists in the table', () => {
  const nav = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'panel', 'nav.js'), 'utf8');
  const used = [...nav.matchAll(/shortcut: '(\w+)'/g)].map(m => m[1]);
  assert.ok(used.length >= 2, `found ${used.length}`);
  for (const id of used) assert.ok(K.label(id), id);
  // The conversation's actions pass theirs to act() by position.
  for (const id of ['stop', 'rewind', 'tryAgain', 'showChanges', 'bringHome', 'closeTab']) {
    assert.ok(K.label(id), id);
    assert.match(nav, new RegExp(`\\(\\) => [^\\n]*, '${id}'`), `${id} is offered in the palette with its keys`);
  }
});

// ------------------------------------------------------------ the palette's ranking

const E = (title, group = 'Screens', extra = {}) => ({ title, group, sub: '', keys: '', ...extra });

test('a title that starts with the query beats one that only contains it', () => {
  const list = [E('Show every screen'), E('Stop', 'This conversation'), E('Settings › Stop sounds', 'Settings')];
  assert.deepEqual(K.rank(list, 'stop').map(e => e.title), ['Stop', 'Settings › Stop sounds']);
});

test('every word must appear somewhere: title, sub, keys or group', () => {
  const list = [E('Compact', 'This conversation', { keys: 'context full' }), E('Health', 'Screens', { sub: 'Temperatures' })];
  assert.deepEqual(K.rank(list, 'context compact').map(e => e.title), ['Compact']);
  assert.deepEqual(K.rank(list, 'temperatures').map(e => e.title), ['Health']);
  assert.deepEqual(K.rank(list, 'nothing here'), []);
});

test('among equal matches, what you ran lately comes first, then the group order', () => {
  const list = [E('Branch a', 'Conversations'), E('Branch b', 'This conversation'), E('Branch c', 'Screens')];
  const groupRank = { 'This conversation': 0, Screens: 1, Conversations: 2 };
  assert.deepEqual(K.rank(list, 'branch', { groupRank }).map(e => e.title), ['Branch b', 'Branch c', 'Branch a']);
  const recent = [K.idOf(list[0])];
  assert.deepEqual(K.rank(list, 'branch', { groupRank, recent }).map(e => e.title), ['Branch a', 'Branch b', 'Branch c']);
});

test('a better match still beats a recent one', () => {
  const list = [E('Rewind', 'This conversation'), E('Settings › Sounds', 'Settings', { keys: 'rewind chime' })];
  const recent = [K.idOf(list[1])];
  assert.equal(K.rank(list, 'rewind', { recent })[0].title, 'Rewind');
});

test('the query is matched literally, regex characters and all', () => {
  const list = [E('/fix(bug)', 'Skills'), E('Other', 'Skills', { keys: '(b' })];
  assert.deepEqual(K.rank(list, '(b').map(e => e.title), ['/fix(bug)', 'Other']);
});

test('limit caps the list', () => {
  const list = Array.from({ length: 60 }, (_, i) => E(`Item ${i}`));
  assert.equal(K.rank(list, 'item').length, 40);
  assert.equal(K.rank(list, 'item', { limit: 5 }).length, 5);
});

test('empty: pinned actions, then recent ones under Recent, then the rest to browse', () => {
  const stop = E('Stop', 'This conversation', { id: 'act:stop' });
  const health = E('Health');
  const routine = E('Run “Tidy” now', 'Routines', { id: 'routine:1' });
  const outfits = E('Shellby: outfits');
  const all = [stop, health, routine, outfits];
  const out = K.rank(all, '  ', { pinned: [stop], browse: [health, outfits], recent: ['routine:1', 'act:stop', 'Screens:Health', 'gone:1'] });
  assert.deepEqual(out.map(e => `${e.group}/${e.title}`), ['This conversation/Stop', 'Recent/Run “Tidy” now', 'Recent/Health', 'Screens/Shellby: outfits']);
  // Its id survives the move to "Recent", so running it again keeps the same place.
  assert.equal(K.idOf(out[1]), 'routine:1');
  assert.equal(K.idOf(out[2]), 'Screens:Health');
});

test('empty with recentShown caps how many recent ones show', () => {
  const list = Array.from({ length: 9 }, (_, i) => E(`R${i}`, 'Routines', { id: `r${i}` }));
  const out = K.rank(list, '', { recent: list.map(e => e.id), recentShown: 3 });
  assert.deepEqual(out.map(e => e.title), ['R0', 'R1', 'R2']);
});

test('noteRecent moves to the front, drops duplicates and keeps a few', () => {
  assert.deepEqual(K.noteRecent(['a', 'b', 'c'], 'b'), ['b', 'a', 'c']);
  assert.deepEqual(K.noteRecent(null, 'x'), ['x']);
  assert.equal(K.noteRecent(Array.from({ length: 20 }, (_, i) => `i${i}`), 'new').length, K.RECENT_MAX);
  const was = ['a'];
  K.noteRecent(was, 'b');
  assert.deepEqual(was, ['a'], 'a new list, the old one untouched');
});

// ------------------------------------------------------------ which project a conversation is in

test('cloneFor finds the clone that holds a folder, the deepest one if they nest', () => {
  const app = { name: 'app', local: [{ root: 'C:\\code\\app' }] };
  const inner = { name: 'inner', local: [{ root: 'C:\\code\\app\\packages\\inner' }] };
  const other = { name: 'other', local: [{ root: 'D:/work/other' }, { root: 'C:\\code\\other-copy' }] };
  const list = [app, inner, other];
  assert.equal(K.cloneFor(list, 'C:\\code\\app').project, app);
  assert.equal(K.cloneFor(list, 'c:/CODE/app/src').project, app, 'any case, either slash');
  assert.equal(K.cloneFor(list, 'C:\\code\\app\\packages\\inner\\lib').project, inner);
  assert.equal(K.cloneFor(list, 'D:\\work\\other\\').clone.root, 'D:/work/other');
  assert.equal(K.cloneFor(list, 'C:\\code\\other-copy').clone.root, 'C:\\code\\other-copy');
  assert.equal(K.cloneFor(list, 'C:\\code\\application'), null, 'a name that only starts the same is another folder');
  assert.equal(K.cloneFor(list, ''), null);
  assert.equal(K.cloneFor(null, 'C:\\code\\app'), null);
  assert.equal(K.cloneFor([{ name: 'x' }, null], 'C:\\x'), null, 'odd entries are skipped');
});

test('Alt+arrows go to the next pane; Ctrl+Alt+arrows move the conversation', () => {
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    assert.ok(K.matches(key(k, { altKey: true }), 'focusPane'), k);
    assert.ok(K.matches(key(k, { altKey: true, ctrlKey: true }), 'movePane'), k);
    assert.ok(!K.matches(key(k, { altKey: true, ctrlKey: true }), 'focusPane'), `${k}: Ctrl+Alt isn't Alt`);
    assert.ok(!K.matches(key(k), 'focusPane'), `${k} alone moves the caret`);
  }
});
