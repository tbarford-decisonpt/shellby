// What a phone notification says, on its own (channel-messages.js): no
// settings, no providers, no network. channels.js re-exports composeMessage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('../src/main/channel-messages');
const channels = require('../src/main/channels');

test('channels hands out the same composeMessage, duration and events', () => {
  assert.equal(channels.composeMessage, M.composeMessage);
  assert.equal(channels.duration, M.duration);
  assert.equal(channels.EVENTS, M.EVENTS);
});

test('every event has a label, a default and a known priority', () => {
  for (const [name, e] of Object.entries(M.EVENTS)) {
    assert.equal(typeof e.label, 'string', name);
    assert.equal(typeof e.default, 'boolean', name);
    assert.ok(channels.PRIORITIES.includes(e.priority), name);
  }
  assert.ok(Object.isFrozen(M.EVENTS));
});

test('an unknown event still has a title and a body', () => {
  const m = M.composeMessage({ kind: 'mystery' });
  assert.equal(m.title, 'Shellby');
  assert.equal(m.body, 'Shellby');
  assert.equal(m.priority, 'normal');
});

test('a reply nonce of the wrong shape gets no buttons', () => {
  assert.equal(M.composeMessage({ kind: 'asking', reply: { nonce: 'short' } }).reply, null);
  const nonce = 'A'.repeat(22);
  assert.deepEqual(M.composeMessage({ kind: 'asking', reply: { nonce } }).reply, { nonce });
});

test('clip flattens whitespace and caps length', () => {
  assert.equal(M.clip('  a\n\tb  ', 10), 'a b');
  assert.equal(M.clip('abcdef', 3), 'abc');
  assert.equal(M.clip(null, 5), '');
});

test('duration reads like a person would say it', () => {
  assert.equal(M.duration(4), '4s');
  assert.equal(M.duration(95), '1m 35s');
  assert.equal(M.duration(3720), '1h 2m');
  assert.equal(M.duration(-1), '');
});
