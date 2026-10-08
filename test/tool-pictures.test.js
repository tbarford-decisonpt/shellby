// Pictures a tool handed Claude (src/main/tool-pictures.js), picked out of its
// result (stream.js) and saved apart by the session manager (sessions.js), so
// the chat shows them without base64 in the conversation's history.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const pictures = require('../src/main/tool-pictures');
const { toItems, resultImages } = require('../src/main/stream');
const { SessionManager } = require('../src/main/sessions');
const { History } = require('../src/main/history');

// A 1x1 PNG.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shellby-tool-pictures-'));

test('a tool result\'s base64 pictures are picked out, other blocks and types left alone', () => {
  assert.deepEqual(resultImages('just text'), []);
  assert.deepEqual(resultImages([
    { type: 'text', text: 'Took a screenshot' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
    { type: 'image', source: { type: 'url', url: 'https://example.com/x.png' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zy8+' } },
  ]), [{ mediaType: 'image/png', data: PNG }]);
});

test('a tool_result item carries its pictures for main, and still says [image] in its text', () => {
  const [r] = toItems({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG } },
  ] }] } });
  assert.equal(r.text, '[image]');
  assert.deepEqual(r.images, [{ mediaType: 'image/jpeg', data: PNG }]);
  const [plain] = toItems({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] } });
  assert.equal(plain.images, undefined);
});

test('saved pictures read back as data URLs of their own type, by ids Shellby made', () => {
  const dir = tmp();
  const ids = pictures.save(dir, 'tab1', 'toolu_1', [
    { mediaType: 'image/png', data: PNG },
    { mediaType: 'image/bmp', data: PNG },
    { mediaType: 'image/jpeg', data: PNG },
  ]);
  assert.deepEqual(ids, ['toolu_1-0.png', 'toolu_1-2.jpg']);
  assert.equal(pictures.read(dir, 'tab1', ids[0]), `data:image/png;base64,${PNG}`);
  assert.match(pictures.read(dir, 'tab1', ids[1]), /^data:image\/jpeg;base64,/);
  assert.equal(pictures.read(dir, 'tab1', 'toolu_9-0.png'), null, 'never saved');
});

test('nothing outside its own folder is read or written', () => {
  const dir = tmp();
  assert.deepEqual(pictures.save(dir, '..', 'toolu_1', [{ mediaType: 'image/png', data: PNG }]), []);
  assert.deepEqual(pictures.save(dir, 'tab1', '../x', [{ mediaType: 'image/png', data: PNG }]), []);
  for (const id of ['../tab1/toolu_1-0.png', 'toolu_1-0.png/..', 'x.exe', 'C:\\Windows\\win.ini']) assert.equal(pictures.read(dir, 'tab1', id), null, id);
  assert.equal(pictures.read(dir, '..\\..', 'toolu_1-0.png'), null);
});

test('at most four from one result, and none that are empty', () => {
  const dir = tmp();
  const many = Array.from({ length: 6 }, () => ({ mediaType: 'image/png', data: PNG }));
  assert.equal(pictures.save(dir, 'tab1', 'toolu_1', many).length, pictures.MAX_PER_RESULT);
  assert.deepEqual(pictures.save(dir, 'tab1', 'toolu_2', [{ mediaType: 'image/png', data: '' }]), []);
});

test('pruning drops the stale, then the oldest past the cap', () => {
  const now = 10_000_000_000;
  const entries = [
    { name: 'a-0.png', mtimeMs: now - pictures.MAX_AGE_MS - 1 },
    { name: 'b-0.png', mtimeMs: now - 3 },
    { name: 'c-0.png', mtimeMs: now - 2 },
    { name: 'd-0.png', mtimeMs: now - 1 },
  ];
  assert.deepEqual(pictures.toPrune(entries, { now, maxPerTab: 2 }), ['a-0.png', 'b-0.png']);
});

test('the manager saves a result\'s pictures and names them on the item, keeping base64 out of history', () => {
  const history = new History(tmp());
  const saved = [];
  const mgr = new SessionManager({
    getExe: () => process.execPath, argsPrefix: [path.join(__dirname, 'fixtures', 'fake-claude.js')], history, getMode: () => 'ask', getModel: () => '',
    savePictures: (tabId, toolId, images) => { saved.push({ tabId, toolId, n: images.length }); return [`${toolId}-0.png`]; },
  });
  const seen = [];
  mgr.on('item', (_tabId, item) => seen.push(item));
  try {
    const tab = mgr.open({ tabId: 't1', cwd: os.tmpdir() });
    tab.session.emit('item', { kind: 'tool_result', id: 'toolu_1', text: '[image]', images: [{ mediaType: 'image/png', data: PNG }] });
    assert.deepEqual(saved, [{ tabId: 't1', toolId: 'toolu_1', n: 1 }]);
    const r = seen.find(i => i.kind === 'tool_result');
    assert.deepEqual(r.pictures, ['toolu_1-0.png']);
    assert.equal(r.images, undefined);
  } finally { mgr.closeAll({ kill: true }); }
});
