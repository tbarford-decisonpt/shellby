const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { guardAllWebContents, BLOCKED } = require('../src/main/web-guard');

function fakeContents() {
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = fn => { contents.openHandler = fn; };
  return contents;
}

test('every new web contents refuses pop-ups, navigation, redirects and webviews', () => {
  const app = new EventEmitter();
  guardAllWebContents(app);
  const contents = fakeContents();

  app.emit('web-contents-created', {}, contents);

  assert.deepEqual(contents.openHandler({ url: 'https://example.com' }), { action: 'deny' });
  for (const event of BLOCKED) {
    let prevented = false;
    contents.emit(event, { preventDefault: () => { prevented = true; } }, 'https://example.com');
    assert.ok(prevented, `${event} is prevented`);
  }
});
