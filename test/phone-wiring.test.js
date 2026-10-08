// Your phone, wired up (wiring/channels.js and wiring/phone-tasks.js): a send
// that keeps failing is remembered for Settings and toasted once at the desk, a
// permission prompt gets one more go at a busy server, and a Telegram task that
// arrived too late to start says so, once.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { installFakeElectron } = require('./helpers/fake-ipc');

const electron = installFakeElectron();
electron.safeStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => String(b) };
const channels = require('../src/main/channels');
const pt = require('../src/main/phone-tasks');
const { wireChannels } = require('../src/main/wiring/channels');
const { wirePhoneTasks } = require('../src/main/wiring/phone-tasks');

const CHAT = '123456';
const FOLDER = 'C:\\Users\\me\\code\\shellby';

function fakeConfig(initial = {}) {
  const store = { ...initial };
  return { get: k => store[k], set: patch => Object.assign(store, patch), store };
}

// Every fetch, answered in turn from answers (then 200s).
function stubFetch(answers = []) {
  const sent = [];
  const before = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    sent.push({ url, body: opts.body });
    return answers.length ? answers.shift() : { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  };
  return { sent, restore: () => { globalThis.fetch = before; } };
}

const busy = status => ({ ok: false, status, headers: { get: k => (k === 'retry-after' ? '0' : null) }, text: async () => 'busy' });
const settle = async (n = 5) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

function wired(provider = 'ntfy', target = 'shellby-abcdefghjkmnpqrstuvw') {
  const notes = [];
  const d = {
    config: fakeConfig({ channels: channels.normalizeChannelSettings(null, { enabled: true, provider, target, replies: true }) }),
    channelSecret: provider === 'telegram' ? 'BOT:TOKEN' : '',
    log: { info: () => {}, warn: () => {} },
    notify: (title, body, onClick, opts) => notes.push({ title, body, onClick, opts }),
    showPanel: () => {}, send: () => {},
  };
  Object.assign(d, wireChannels(d));
  d.config.set({ channelsConfirmed: d.channelPlace() });
  return { d, notes };
}

test('three sends in a row that fail: remembered for Settings, one toast, cleared by the next that goes', async () => {
  const { d, notes } = wired();
  const net = stubFetch([busy(500), busy(500), busy(500), busy(500)]);
  try {
    for (let i = 0; i < 4; i++) { assert.equal(d.tellChannel({ kind: 'limit', at: Date.now() }), true); await settle(); }
    assert.equal(notes.length, 1, 'one toast, not one a failure');
    assert.match(notes[0].body, /ntfy was having trouble/);
    const v = d.channelsView();
    assert.equal(v.lastDeliveryError, 'ntfy was having trouble (it said 500).');
    assert.ok(v.lastDeliveryErrorAt > 0);
    d.tellChannel({ kind: 'limit', at: Date.now() });
    await settle();
    assert.equal(d.channelsView().lastDeliveryError, null, 'the next one that goes clears it');
    assert.equal(net.sent.length, 5, 'nothing but a permission prompt is retried');
  } finally { net.restore(); }
});

test('a permission prompt is retried once when the server is busy', async () => {
  const { d } = wired();
  const net = stubFetch([busy(503)]);
  try {
    d.remote = { register: () => 'n', sent: () => {}, forget: () => {} };
    d.tellChannel({ kind: 'asking', project: 'shellby', message: 'Bash wants to run npm test' });
    await settle(10);
    assert.equal(net.sent.length, 2);
    assert.equal(d.channelsView().lastDeliveryError, null, 'it went in the end');
  } finally { net.restore(); }
});

function phoneTasks() {
  const { d } = wired('telegram', CHAT);
  let inbox = null;
  Object.assign(d, {
    remote: { closed: false, listen: () => {}, setInbox: i => { inbox = i; } },
    isFolder: () => true, knownProjects: () => [], heldList: () => [],
  });
  d.config.set({ phoneTasks: { enabled: true, folder: FOLDER, enabledAt: Date.now() - 60 * 60 * 1000 } });
  d.config.set({ phoneTasksConfirmed: pt.consentKey(d.channelSettings(), d.channelSecret) });
  wirePhoneTasks(d).createPhoneTasks();
  return { d, inbox };
}

const tgMessage = (id, agoMs) => ({
  update_id: id,
  message: {
    message_id: id, date: Math.floor((Date.now() - agoMs) / 1000), text: 'fix the flaky test',
    chat: { id: Number(CHAT), type: 'private' }, from: { id: Number(CHAT), is_bot: false },
  },
});

test('a Telegram task that came in too late says so, once, and starts nothing', async () => {
  const { d, inbox } = phoneTasks();
  let started = 0;
  d.startTaskInCopy = async () => { started++; return { ok: true, tabId: 't' }; };
  d.startTask = () => { started++; return { ok: true, tabId: 't' }; };
  const net = stubFetch();
  try {
    inbox.onTelegram(tgMessage(7, 25 * 60 * 1000));
    inbox.onTelegram(tgMessage(7, 25 * 60 * 1000));
    await settle(10);
    assert.equal(started, 0);
    assert.equal(net.sent.length, 1, 'one reply, however often it is read');
    assert.match(JSON.parse(net.sent[0].body).text, /This came in 25 minutes late, so it didn't start.+Send it again if you still want it/);
  } finally { net.restore(); }
});

test('a message from before phone tasks were on stays silent', async () => {
  const { d, inbox } = phoneTasks();
  d.config.set({ phoneTasks: { ...d.config.get('phoneTasks'), enabledAt: Date.now() - 60 * 1000 } });
  const net = stubFetch();
  try {
    inbox.onTelegram(tgMessage(8, 25 * 60 * 1000));
    await settle(10);
    assert.equal(net.sent.length, 0);
  } finally { net.restore(); }
});
