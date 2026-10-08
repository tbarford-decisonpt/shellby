// History's and the Wardrobe's IPC, moved out of main.js: what each channel
// does with good and bad input, without Electron.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { registerHistoryIpc, clearQuestion } = require('../src/main/ipc/history');
const { registerWardrobeIpc, readPack, packsFor } = require('../src/main/ipc/wardrobe');
const { itemHash } = require('../src/main/wardrobe/codes');

function fakeIpc() {
  const handlers = new Map();
  const on = new Map();
  return {
    handle: (ch, fn) => handlers.set(ch, fn),
    on: (ch, fn) => on.set(ch, fn),
    invoke: (ch, ...args) => handlers.get(ch)({}, ...args),
    send: (ch, ...args) => on.get(ch)({}, ...args),
    channels: () => [...handlers.keys(), ...on.keys()],
  };
}

function fakeHistory(ids, trashed = []) {
  let list = ids.map(id => ({ id, title: id }));
  let bin = trashed.map(id => ({ id }));
  return {
    list: () => list,
    trashed: () => bin,
    get: id => list.find(e => e.id === id) || null,
    load: id => [{ id, text: 'hi' }],
    trash: id => { bin = [...bin, ...list.filter(e => e.id === id)]; list = list.filter(e => e.id !== id); },
    restore: id => { list = [...list, ...bin.filter(e => e.id === id)]; bin = bin.filter(e => e.id !== id); },
    purge: idsIn => { bin = idsIn ? bin.filter(e => !idsIn.includes(e.id)) : []; },
    clear: () => { const n = list.length + bin.length; list = []; bin = []; return n; },
    setDone: (id, done) => { list = list.map(e => (e.id === id ? { ...e, done } : e)); },
    rename: (id, title) => { list = list.map(e => (e.id === id ? { ...e, title } : e)); },
  };
}

function historySetup({ ids = ['a', 'b'], trashed = [], openIds = [], confirm = true } = {}) {
  const ipc = fakeIpc();
  const history = fakeHistory(ids, trashed);
  const closed = [];
  const opened = [];
  const asked = [];
  const manager = {
    tabs: new Set(openIds),
    close: id => closed.push(id),
    rename: (id, title) => history.rename(id, `${title} (via tab)`),
  };
  registerHistoryIpc(ipc, {
    history, manager,
    openTab: o => opened.push(o.tabId),
    confirmClear: async (count, open) => { asked.push([count, open]); return confirm; },
    log: { info: () => {} },
  });
  return { ipc, history, closed, opened, asked };
}

test('History: opening a conversation opens its tab once, and only for a real entry', async () => {
  const { ipc, opened } = historySetup({ openIds: ['b'] });
  assert.equal((await ipc.invoke('session:open', 'a')).tabId, 'a');
  assert.deepEqual(opened, ['a']);
  await ipc.invoke('session:open', 'b');
  assert.deepEqual(opened, ['a'], 'an open tab is not opened again');
  assert.equal(await ipc.invoke('session:open', 'nope'), null);
  assert.equal(await ipc.invoke('session:open', 42), null);
});

test('History: delete moves to Recently deleted, restore brings it back, purge ends it', async () => {
  const { ipc, closed } = historySetup();
  assert.deepEqual((await ipc.invoke('session:delete', 'a')).map(e => e.id), ['b']);
  assert.deepEqual(closed, ['a'], 'its tab closes');
  assert.deepEqual((await ipc.invoke('session:trash')).map(e => e.id), ['a']);
  const back = await ipc.invoke('session:restore', 'a');
  assert.deepEqual(back.sessions.map(e => e.id).sort(), ['a', 'b']);
  assert.deepEqual(back.trash, []);
  await ipc.invoke('session:delete', 'b');
  assert.deepEqual(await ipc.invoke('session:purge'), [], 'no id empties the bin');
  assert.deepEqual((await ipc.invoke('session:delete', null)).map(e => e.id), ['a'], 'a bad id deletes nothing');
});

test('History: Clear all asks first and does nothing on Cancel', async () => {
  const { ipc, history, asked, closed } = historySetup({ ids: ['a', 'b'], trashed: ['c'], openIds: ['a'], confirm: false });
  const r = await ipc.invoke('session:clear');
  assert.equal(r.cleared, false);
  assert.deepEqual(asked, [[3, 1]], 'asked with every conversation, including the bin, and how many are open');
  assert.equal(history.list().length, 2);
  assert.deepEqual(closed, []);
});

test('History: Clear all, confirmed, closes open tabs and empties both lists', async () => {
  const { ipc, closed } = historySetup({ ids: ['a', 'b'], trashed: ['c'], openIds: ['a'] });
  const r = await ipc.invoke('session:clear');
  assert.deepEqual(r, { cleared: true, sessions: [], trash: [] });
  assert.deepEqual(closed, ['a']);
});

test('History: Clear all with nothing to clear asks nothing', async () => {
  const { ipc, asked } = historySetup({ ids: [] });
  assert.equal((await ipc.invoke('session:clear')).cleared, false);
  assert.deepEqual(asked, []);
});

test('History: rename goes through the tab when it is open', async () => {
  const { ipc } = historySetup({ openIds: ['a'] });
  const list = await ipc.invoke('session:rename', { id: 'a', title: 'New' });
  assert.equal(list.find(e => e.id === 'a').title, 'New (via tab)');
  const list2 = await ipc.invoke('session:rename', { id: 'b', title: 'Other' });
  assert.equal(list2.find(e => e.id === 'b').title, 'Other');
  await ipc.invoke('session:rename', {});
  assert.equal((await ipc.invoke('session:done', { id: 'b', done: 1 })).find(e => e.id === 'b').done, true);
});

test('History: the Clear all question says how much goes', () => {
  assert.match(clearQuestion(1, 0).message, /your one conversation/);
  assert.match(clearQuestion(5, 0).message, /all 5 conversations/);
  assert.doesNotMatch(clearQuestion(5, 0).detail, /close/);
  assert.match(clearQuestion(5, 1).detail, /The open conversation closes/);
  assert.match(clearQuestion(5, 3).detail, /The 3 open conversations close/);
});

// ------------------------------------------------------------------ wardrobe

function wardrobeSetup({ skin = 'classic', skins = [{ id: 'classic' }, { id: 'gold', locked: false }, { id: 'secret', locked: true }] } = {}) {
  const ipc = fakeIpc();
  const settings = { skin, voice: { on: true, recent: { a: 1 } } };
  const calls = [];
  const wardrobe = {
    userDir: path.join(os.tmpdir(), 'shellby-wardrobe-test'),
    view: () => ({ v: 1 }),
    setVoice: key => ({ ok: key === 'pirate' }),
    wearCode: text => (text === 'SHB-GOOD' ? { ok: true, skin: 'gold' } : text === 'SHB-LOCKED' ? { ok: true, skin: 'secret' } : { ok: false, error: 'bad' }),
    remove: id => calls.push(['remove', id]),
  };
  registerWardrobeIpc(ipc, {
    wardrobe: () => wardrobe,
    builtinSkins: () => skins,
    allSkins: () => skins,
    activeSkin: () => skins[0],
    reloadSkins: () => 'reloaded',
    config: { get: k => settings[k], set: patch => Object.assign(settings, patch) },
    voice: { normalize: v => ({ ...v }) },
    clearBackground: () => 'cleared',
    pickPackFile: async () => null,
    confirmAndInstallPackText: async text => ({ ok: true, text }),
    installFromRegistry: id => ({ ok: true, id }),
    registryUrl: () => 'http://localhost',
    broadcastSkin: () => calls.push(['broadcast']),
    openPath: p => calls.push(['open', p]),
    userSkinsDir: () => 'skins-dir',
  });
  return { ipc, settings, calls };
}

test('Wardrobe: a new voice forgets which lines he just said', async () => {
  const { ipc, settings } = wardrobeSetup();
  assert.deepEqual(await ipc.invoke('wardrobe:set-voice', 'pirate'), { ok: true, view: { v: 1 } });
  assert.deepEqual(settings.voice, { on: true, recent: {} });
  settings.voice = { on: true, recent: { b: 1 } };
  await ipc.invoke('wardrobe:set-voice', 'nope');
  assert.deepEqual(settings.voice.recent, { b: 1 }, "a voice that didn't change keeps them");
});

test('Wardrobe: an outfit code changes the skin only when it is unlocked', async () => {
  const { ipc, settings, calls } = wardrobeSetup();
  assert.equal((await ipc.invoke('wardrobe:code-wear', 'SHB-GOOD')).ok, true);
  assert.equal(settings.skin, 'gold');
  assert.deepEqual(calls, [['broadcast']]);
  await ipc.invoke('wardrobe:code-wear', 'SHB-LOCKED');
  assert.equal(settings.skin, 'gold', 'a locked skin is not put on');
  assert.deepEqual(await ipc.invoke('wardrobe:code-wear', 'SHB-BAD'), { ok: false, error: 'bad' });
  assert.match((await ipc.invoke('wardrobe:code-wear', 'x'.repeat(121))).error, /outfit code/);
  assert.match((await ipc.invoke('wardrobe:code-preview', 7)).error, /outfit code/);
});

test('Wardrobe: gallery installs take only a pack id', async () => {
  const { ipc } = wardrobeSetup();
  assert.deepEqual(await ipc.invoke('wardrobe:install-registry', 'cozy-hats'), { ok: true, id: 'cozy-hats' });
  assert.deepEqual(await ipc.invoke('wardrobe:install-registry', '../etc'), { ok: false });
  assert.deepEqual(await ipc.invoke('wardrobe:install-registry', 'A'), { ok: false });
});

test('Wardrobe: installing with the dialog cancelled installs nothing', async () => {
  const { ipc } = wardrobeSetup();
  assert.deepEqual(await ipc.invoke('wardrobe:install'), { ok: false, canceled: true });
});

test('Wardrobe: a pack file is read only when it is a small .json on this PC', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-pack-'));
  try {
    const good = path.join(dir, 'pack.json');
    fs.writeFileSync(good, '{"id":"x"}');
    assert.deepEqual(readPack(good), { ok: '{"id":"x"}' });
    assert.deepEqual(readPack(path.join(dir, 'pack.txt')), { errors: ['Packs are .json files.'] });
    assert.deepEqual(readPack(path.join(dir, 'missing.json')), { errors: ['File not found.'] });
    const big = path.join(dir, 'big.json');
    fs.writeFileSync(big, 'x'.repeat(512 * 1024 + 1));
    assert.match(readPack(big).errors[0], /too big/);
    assert.match(readPack('\\\\server\\share\\pack.json').errors[0], /from a file on this PC/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Wardrobe: an outfit code's missing items are grouped by the pack that has them", () => {
  const cat = { ok: true, items: [
    { slot: 'hat', key: 'p1:hat', packId: 'p1', packName: 'Pack one', name: 'Hat' },
    { slot: 'glasses', key: 'p1:specs', packId: 'p1', packName: 'Pack one', name: 'Specs' },
  ] };
  const missing = [
    { slot: 'hat', hash: itemHash('p1:hat') },
    { slot: 'glasses', hash: itemHash('p1:specs') },
    { slot: 'hat', hash: itemHash('gone:hat') },
  ];
  const r = packsFor(missing, cat);
  assert.deepEqual(r.packs, [{ id: 'p1', name: 'Pack one', items: [{ slot: 'hat', name: 'Hat' }, { slot: 'glasses', name: 'Specs' }] }]);
  assert.deepEqual(r.unknown, [missing[2]]);
  assert.deepEqual(packsFor(missing, { ok: false }).unknown.length, 3, 'no catalog: every item is unknown');
});

test('Wardrobe: every channel main used to register is still registered', () => {
  const { ipc } = wardrobeSetup();
  assert.deepEqual(ipc.channels().sort(), [
    'external:clear-background', 'skins:open-folder', 'skins:reload',
    'wardrobe:code', 'wardrobe:code-preview', 'wardrobe:code-wear', 'wardrobe:install', 'wardrobe:install-registry',
    'wardrobe:open-folder', 'wardrobe:options', 'wardrobe:randomize', 'wardrobe:remove-pack', 'wardrobe:seen',
    'wardrobe:set-outfit', 'wardrobe:set-voice', 'wardrobe:view', 'wardrobe:wear-season',
  ]);
});
