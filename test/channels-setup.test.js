// Setting notifications up for you: the ntfy topic Shellby picks, the QR code
// that subscribes a phone to it, and reading a Telegram chat id off the bot.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomTopic, chatFromUpdates, findTelegramChat, ntfyUrl, view, normalizeChannelSettings } = require('../src/main/channels');
const { qrRows } = require('../src/main/qr');

// ------------------------------------------------------------------ ntfy

test('randomTopic is a valid ntfy topic, hard to guess and easy to read', () => {
  const t = randomTopic();
  assert.match(t, /^shellby-[a-z2-9]{14}$/);
  assert.doesNotMatch(t.slice(8), /[01ilo]/, 'no characters that read as each other');
  assert.equal(ntfyUrl(t), `https://ntfy.sh/${t}`);
  assert.equal(new Set(Array.from({ length: 200 }, () => randomTopic())).size, 200);
});

test('randomTopic maps every byte into the alphabet', () => {
  assert.equal(randomTopic(Buffer.from([0, 255, 30, 31])), 'shellby-ah9a');
});

test('the view carries a subscribe link for ntfy only', () => {
  const ntfy = view(normalizeChannelSettings(null, { provider: 'ntfy', target: 'shellby-abcdefg' }));
  assert.equal(ntfy.subscribeUrl, 'https://ntfy.sh/shellby-abcdefg');
  assert.equal(view(normalizeChannelSettings(null, { provider: 'ntfy', target: '' })).subscribeUrl, null);
  assert.equal(view(normalizeChannelSettings(null, { provider: 'telegram', target: '123' })).subscribeUrl, null);
  const tg = view(normalizeChannelSettings(null, { provider: 'telegram' })).providers.find(p => p.name === 'telegram');
  assert.equal(tg.findsTarget, true);
});

test('qrRows gives a square code with the three finder squares in the corners', () => {
  const rows = qrRows('https://ntfy.sh/shellby-abcdefghjkmnpq');
  assert.ok(rows && rows.length >= 21);
  assert.ok(rows.every(r => r.length === rows.length && /^[01]+$/.test(r)));
  const n = rows.length;
  for (const [y, x] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    assert.equal(rows[y].slice(x, x + 7), '1111111', 'finder top edge');
    assert.equal(rows[y + 1].slice(x, x + 7), '1000001', 'finder ring');
  }
});

test('qrRows refuses nothing or far too much', () => {
  assert.equal(qrRows(''), null);
  assert.equal(qrRows(null), null);
  assert.equal(qrRows('x'.repeat(1000)), null);
});

// ------------------------------------------------------------------ telegram

const update = (id, chat) => ({ update_id: id, message: { message_id: id, chat, text: 'hi' } });

test('chatFromUpdates picks the newest private chat', () => {
  const r = chatFromUpdates({ ok: true, result: [
    update(1, { id: 111, type: 'private', first_name: 'Old' }),
    update(2, { id: 222, type: 'private', first_name: 'Sam', last_name: 'Reef' }),
    update(3, { id: -333, type: 'group', title: 'Team' }),
  ] });
  assert.deepEqual(r, { chatId: '222', name: 'Sam Reef' });
});

test('chatFromUpdates falls back to a group when that is all there is', () => {
  assert.deepEqual(chatFromUpdates({ ok: true, result: [update(1, { id: -42, type: 'group', title: 'Team' })] }), { chatId: '-42', name: 'Team' });
});

test('chatFromUpdates explains the empty and failing cases', () => {
  assert.match(chatFromUpdates({ ok: true, result: [] }).error, /Send your bot any message/);
  assert.match(chatFromUpdates({ ok: false, error_code: 401, description: 'Unauthorized' }).error, /doesn't recognise that bot token/);
  assert.match(chatFromUpdates({ ok: false, error_code: 409, description: 'Conflict: can\'t use getUpdates while webhook is active' }).error, /webhook/);
  assert.ok(chatFromUpdates(null).error);
  assert.ok(chatFromUpdates({ ok: true, result: [{ update_id: 1 }, null, update(2, { id: 'x' })] }).error, 'junk updates are skipped');
});

test('findTelegramChat asks getUpdates with the token and never follows redirects', async () => {
  let seen;
  const fetchImpl = async (url, opts) => { seen = { url, opts }; return { json: async () => ({ ok: true, result: [update(5, { id: 9, type: 'private', username: 'crab' })] }) }; };
  const r = await findTelegramChat('123:ABC', { fetchImpl });
  assert.deepEqual(r, { chatId: '9', name: 'crab' });
  assert.equal(seen.url, 'https://api.telegram.org/bot123%3AABC/getUpdates');
  assert.equal(seen.opts.redirect, 'error');
});

test('findTelegramChat needs a token, and reports a network failure', async () => {
  assert.match((await findTelegramChat('')).error, /token first/);
  const r = await findTelegramChat('t', { fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  assert.match(r.error, /ENOTFOUND/);
});

test('switching provider drops the old target instead of reusing it', () => {
  const tg = normalizeChannelSettings(null, { enabled: true, provider: 'telegram', target: '123456789' });
  const ntfy = normalizeChannelSettings(tg, { provider: 'ntfy' });
  assert.equal(ntfy.target, '', 'a chat id would be a public, guessable ntfy topic');
  assert.equal(normalizeChannelSettings(tg, { provider: 'telegram' }).target, '123456789', 'the same provider keeps it');
  assert.equal(normalizeChannelSettings(tg, { provider: 'discord', target: 'https://discord.com/api/webhooks/1/x' }).target,
    'https://discord.com/api/webhooks/1/x', 'a target sent with the switch is kept');
});
