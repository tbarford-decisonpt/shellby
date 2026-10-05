// sticker-service.js: the parts that don't need a repo or a window.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStickers } = require('../src/main/sticker-service');

function setup(over = {}) {
  const data = { ...over.data };
  const calls = { sets: 0 };
  const d = {
    config: { get: k => data[k], set: patch => { calls.sets++; Object.assign(data, patch); } },
    critter: null, panel: null, workflows: null,
    CAPTURE: !!over.capture,
    log: { error: () => {} },
    send: () => {}, notify: () => {}, showPanel: () => {}, flashState: () => {}, sayText: () => {},
    broadcastSkin: () => {}, currentLevel: () => 1, activeSkin: () => null,
    githubEndpoints: () => ({ web: 'https://github.com' }), noteWeek: () => {},
    stickersView: () => ({ projects: [] }), stickerStats: () => {},
  };
  return { svc: createStickers(d), calls };
}

test('a project\'s sticker is drawn once and then reused', () => {
  const { svc } = setup();
  const p = { id: 'github.com/x/app', name: 'app', lang: 'js', custom: null };

  const first = svc.drawSticker(p);
  const again = svc.drawSticker({ ...p });

  assert.equal(again, first);
});

test('no skin, or no stickers, places nothing', () => {
  const { svc } = setup();

  assert.deepEqual(svc.placeStickers(null, null, [{ slot: 0, nudge: [0, 0] }]), []);
  assert.deepEqual(svc.placeStickers({}, null, []), []);
});

test('the home shell has its own id', () => {
  const { svc } = setup();

  assert.equal(svc.shellIdOf({ id: 'conch' }), 'conch');
  assert.equal(typeof svc.shellIdOf(null), 'string');
});

test('nothing ships during a screenshot run, or from a folder that isn\'t one', async () => {
  const capturing = setup({ capture: true });
  const normal = setup();

  await capturing.svc.shipped('C:\\code\\app', 'ship');
  await normal.svc.shipped('', 'ship');
  await normal.svc.shipped(null, 'ship');

  assert.equal(capturing.calls.sets + normal.calls.sets, 0);
});
