// changes:undo-hunk (ipc/tabs.js): the guards around changes.undoHunk, and the
// item it notes so the turn's diff and Undo carry on from where it left them.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron } = require('./helpers/fake-ipc');

installFakeElectron();
const changes = require('../src/main/changes');
const { registerTabsIpc } = require('../src/main/ipc/tabs');

const ITEM = { kind: 'changes', turnId: 'turn1', root: 'C:\\repo', before: 'a'.repeat(40), after: 'b'.repeat(40), files: [{ path: 'src/a.js', status: 'M' }, { path: 'src/new.js', status: 'A' }] };

function setup({ items = [ITEM], busy = false } = {}) {
  const handlers = new Map();
  const notes = [];
  const list = items.slice();
  const tab = { id: 't1' };
  registerTabsIpc({ handle: (c, fn) => handlers.set(c, fn), on: () => {} }, {
    isStr: s => typeof s === 'string' && s.length > 0,
    manager: { tabs: new Map([['t1', tab]]), isBusy: () => busy, note: (id, item) => { notes.push(item); list.push(item); } },
    history: { load: () => list },
    changeRef: (r) => {
      const f = ITEM.files.find(x => x.path === r?.file);
      return r?.tabId === 't1' && r.after === ITEM.after && f ? { tabId: 't1', root: ITEM.root, before: ITEM.before, after: ITEM.after, file: f.path, status: f.status } : null;
    },
    log: { warn: () => {}, info: () => {} },
  });
  return { call: (c, arg) => handlers.get(c)({}, arg), notes, tab };
}

const ref = { tabId: 't1', root: ITEM.root, before: ITEM.before, after: ITEM.after, file: 'src/a.js', hunk: 1, header: '@@ -10,3 +10,3 @@' };
const real = { undoHunk: changes.undoHunk, patchFor: changes.patchFor };
let calls;
test.beforeEach(() => {
  calls = [];
  changes.undoHunk = async (r, h) => { calls.push({ r, h }); return { ok: true, to: 'c'.repeat(40) }; };
  changes.patchFor = async r => ({ patch: `diff of ${r.after.slice(0, 1)}`, truncated: false });
});
test.afterEach(() => Object.assign(changes, real));

test('a hunk goes back and the turn is noted as standing at the new tree', async () => {
  const { call, notes, tab } = setup();
  assert.deepEqual(await call('changes:undo-hunk', ref), { ok: true });
  assert.deepEqual(calls[0].h, { hunk: 1, header: ref.header });
  assert.equal(calls[0].r.file, 'src/a.js');
  assert.deepEqual(notes, [{ kind: 'undone-hunk', turnId: 'turn1', before: ITEM.before, after: ITEM.after, file: 'src/a.js', to: 'c'.repeat(40) }]);
  assert.equal(tab.undoingStep, false);
  // The file's diff now reads from the new tree; another file's still from the turn's end.
  assert.equal((await call('changes:diff', { ...ref })).patch, 'diff of c');
  assert.equal((await call('changes:diff', { ...ref, file: 'src/new.js' })).patch, 'diff of b');
});

test('the second hunk starts from where the first left the turn', async () => {
  const { call } = setup();
  await call('changes:undo-hunk', ref);
  await call('changes:undo-hunk', { ...ref, hunk: 0 });
  assert.equal(calls[1].r.after, 'c'.repeat(40));
});

test('refused: not this conversation\'s file, a new file, while he works, or after the whole turn went back', async () => {
  assert.equal((await setup().call('changes:undo-hunk', { ...ref, file: 'other.js' })).ok, false);
  assert.match((await setup().call('changes:undo-hunk', { ...ref, file: 'src/new.js' })).error, /changed file/);
  assert.match((await setup({ busy: true }).call('changes:undo-hunk', ref)).error, /finish first/);
  const undone = setup({ items: [ITEM, { kind: 'undone', after: ITEM.after }] });
  assert.match((await undone.call('changes:undo-hunk', ref)).error, /undone already/);
  assert.equal(calls.length, 0);
});

test('a refusal from git notes nothing', async () => {
  changes.undoHunk = async () => ({ ok: false, error: 'src/a.js has changed since this turn.', changedSince: ['src/a.js'] });
  const { call, notes } = setup();
  const r = await call('changes:undo-hunk', ref);
  assert.equal(r.ok, false);
  assert.deepEqual(notes, []);
});
