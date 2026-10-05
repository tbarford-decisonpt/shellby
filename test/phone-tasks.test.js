// Starting a task from the phone. The text that arrives is untrusted, so what
// matters most is what *doesn't* start anything: someone else's chat, a
// forward, an edit, an old message, a post without the passphrase, a ! or /
// command, and the hundredth task in an hour.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pt = require('../src/main/phone-tasks');
const channels = require('../src/main/channels');

const NOW = 1_800_000_000_000;
const SINCE = NOW - 5 * 60 * 1000;
const CHAT = '123456';
const PASS = 'abcd-efgh-jkmn-pqrs';

const tgUpdate = (patch = {}, msg = {}) => ({
  update_id: 7,
  ...patch,
  message: {
    message_id: 42, date: Math.floor((NOW - 30_000) / 1000), text: 'fix the flaky test',
    chat: { id: Number(CHAT), type: 'private' }, from: { id: Number(CHAT), is_bot: false },
    ...msg,
  },
});

// ------------------------------------------------------------------ Telegram

test('a fresh message in your own private chat is read', () => {
  assert.deepEqual(pt.parseTelegramMessage(tgUpdate(), CHAT, { since: SINCE, now: NOW }),
    { text: 'fix the flaky test', at: NOW - 30_000, messageId: 42 });
});

test('nobody else, and nothing second-hand, starts a task over Telegram', () => {
  const read = (u, chat = CHAT) => pt.parseTelegramMessage(u, chat, { since: SINCE, now: NOW });
  assert.equal(read(tgUpdate({}, { chat: { id: 999, type: 'private' } })), null, 'another chat');
  assert.equal(read(tgUpdate({}, { from: { id: 999, is_bot: false } })), null, 'someone else in it');
  assert.equal(read(tgUpdate({}, { chat: { id: -100, type: 'group' }, from: { id: 5 } }), '-100'), null, 'a group');
  assert.equal(read(tgUpdate({}, { chat: { id: Number(CHAT), type: 'group' } })), null, 'not private');
  assert.equal(read(tgUpdate({}, { from: { id: Number(CHAT), is_bot: true } })), null, 'a bot');
  assert.equal(read(tgUpdate({}, { forward_origin: { type: 'user' } })), null, 'forwarded');
  assert.equal(read(tgUpdate({}, { forward_from: { id: 1 } })), null, 'forwarded (old field)');
  assert.equal(read(tgUpdate({}, { forward_date: 1 })), null, 'forwarded (date only)');
  assert.equal(read(tgUpdate({}, { via_bot: { id: 3 } })), null, 'sent via an inline bot');
  assert.equal(read({ update_id: 1, edited_message: tgUpdate().message }), null, 'an edit');
  assert.equal(read({ update_id: 1, channel_post: tgUpdate().message }), null, 'a channel post');
  assert.equal(read(tgUpdate({}, { text: undefined, photo: [{}] })), null, 'no text');
  assert.equal(read({ update_id: 1, callback_query: { data: 'a:x' } }), null, 'a button press');
});

test('only messages from after you turned it on, and from the last ten minutes', () => {
  const at = ms => tgUpdate({}, { date: Math.floor(ms / 1000) });
  const read = u => pt.parseTelegramMessage(u, CHAT, { since: SINCE, now: NOW });
  assert.equal(read(at(SINCE - 1000)), null, 'sent before it was on');
  assert.equal(read(at(NOW - pt.MAX_AGE_MS - 1000)), null, 'too old');
  assert.equal(read(at(NOW + 5 * 60 * 1000)), null, 'from the future');
  assert.ok(read(at(NOW - 1000)));
  // Turned on long ago: still only the last ten minutes.
  assert.equal(pt.parseTelegramMessage(at(NOW - 20 * 60 * 1000), CHAT, { since: 0, now: NOW }), null);
});

test('a group chat id is never one tasks can come from', () => {
  assert.equal(pt.isPrivateChatId('123'), true);
  assert.equal(pt.isPrivateChatId('-100123'), false);
  assert.equal(pt.isPrivateChatId('0'), false);
  assert.equal(pt.isPrivateChatId(''), false);
  assert.equal(pt.parseTelegramMessage(tgUpdate({}, { chat: { id: -5, type: 'private' }, from: { id: -5 } }), '-5', { since: SINCE, now: NOW }), null);
});

// ------------------------------------------------------------------ ntfy

const ntfyMsg = (message, patch = {}) => ({ id: 'abc123', event: 'message', time: Math.floor((NOW - 10_000) / 1000), message, ...patch });

test('an ntfy post counts only with the passphrase in front', () => {
  const read = m => pt.parseNtfyTask(m, PASS, { since: SINCE, now: NOW });
  assert.deepEqual(read(ntfyMsg(`${PASS} tidy the README`)), { text: 'tidy the README', at: NOW - 10_000, id: 'abc123' });
  assert.deepEqual(read(ntfyMsg(`  ${PASS}\nline one\nline two`)), { text: 'line one\nline two', at: NOW - 10_000, id: 'abc123' });
  assert.deepEqual(read(ntfyMsg('tidy the README')), { refused: true });
  assert.deepEqual(read(ntfyMsg(`${PASS.slice(0, -1)}x tidy`)), { refused: true }, 'one character off');
  assert.deepEqual(read(ntfyMsg(`${PASS}x tidy`)), { refused: true }, 'one character more');
  assert.deepEqual(read(ntfyMsg(PASS)), { refused: true }, 'passphrase and nothing else');
  assert.deepEqual(pt.parseNtfyTask(ntfyMsg(` tidy`), '', { since: SINCE, now: NOW }), { refused: true }, 'no passphrase set: nothing counts');
  assert.equal(read(ntfyMsg(`${PASS} x`, { event: 'open' })), null);
  assert.equal(read(ntfyMsg(`${PASS} x`, { time: Math.floor((SINCE - 1000) / 1000) })), null, 'before it was on');
  assert.equal(read(ntfyMsg(`${PASS} x`, { time: Math.floor((NOW - pt.MAX_AGE_MS - 1000) / 1000) })), null, 'too old');
});

test('passphrases are long, readable, and compared whole', () => {
  const a = pt.newPassphrase();
  assert.match(a, pt.PASSPHRASE);
  assert.notEqual(a, pt.newPassphrase());
  assert.equal(pt.samePassphrase(a, a), true);
  assert.equal(pt.samePassphrase(a, a.toUpperCase()), false);
  assert.equal(pt.samePassphrase('', ''), false);
  assert.equal(pt.samePassphrase(a, undefined), false);
});

test('ntfy tasks go to a topic of their own beside yours', () => {
  assert.equal(pt.ntfyTasksUrl('shellby-abc'), 'https://ntfy.sh/shellby-abc-tasks');
  assert.equal(pt.ntfyTasksUrl('https://ntfy.example.com/' + 'x'.repeat(64)), `https://ntfy.example.com/${'x'.repeat(58)}-tasks`);
  assert.equal(pt.ntfyTasksUrl('not a topic!'), null);
});

// ------------------------------------------------------------------ what it says

const PROJECTS = [
  { name: 'shellby', path: 'C:\\code\\shellby' },
  { name: 'shell-scripts', path: 'C:\\code\\shell-scripts' },
  { name: 'rack-builder', path: 'C:\\code\\rack-builder' },
];

test('plain text and /task are tasks in the default folder', () => {
  assert.deepEqual(pt.parseCommand('fix the flaky test'), { kind: 'task', prompt: 'fix the flaky test', project: null });
  assert.deepEqual(pt.parseCommand('/task fix it'), { kind: 'task', prompt: 'fix it', project: null });
  assert.deepEqual(pt.parseCommand('/task@ShellbyBot fix it'), { kind: 'task', prompt: 'fix it', project: null });
  assert.equal(pt.parseCommand('/task').kind, 'reply');
});

test('/help, /start and /status are answered, other commands refused', () => {
  assert.deepEqual(pt.parseCommand('/help'), { kind: 'help' });
  assert.deepEqual(pt.parseCommand('/start'), { kind: 'help' });
  assert.deepEqual(pt.parseCommand('/STATUS'), { kind: 'status' });
  assert.match(pt.parseCommand('/mode autonomous').reply, /only knows/);
  assert.match(pt.parseCommand('/settings').reply, /only knows/);
});

test('a project can be named, exactly or by the only name it starts', () => {
  assert.deepEqual(pt.parseCommand('in Shellby: bump deps', { projects: PROJECTS }), { kind: 'task', prompt: 'bump deps', project: PROJECTS[0] });
  assert.deepEqual(pt.parseCommand('@rack add a test', { projects: PROJECTS }), { kind: 'task', prompt: 'add a test', project: PROJECTS[2] });
  assert.deepEqual(pt.parseCommand('/task @rack-builder: add a test', { projects: PROJECTS }), { kind: 'task', prompt: 'add a test', project: PROJECTS[2] });
  assert.deepEqual(pt.parseCommand('@shellby fix it', { projects: PROJECTS }).project, PROJECTS[0], 'exact beats a longer name it starts');
});

test('an ambiguous or unknown project asks instead of guessing', () => {
  const amb = pt.parseCommand('@shel fix it', { projects: PROJECTS });
  assert.equal(amb.kind, 'reply');
  assert.match(amb.reply, /shellby, shell-scripts/);
  const none = pt.parseCommand('in nowhere: fix it', { projects: PROJECTS });
  assert.equal(none.kind, 'reply');
  assert.match(none.reply, /doesn't know a project called "nowhere"/);
  const twins = pt.matchProject('app', [{ name: 'app', path: 'C:\\a\\app' }, { name: 'app', path: 'C:\\b\\app' }]);
  assert.deepEqual(twins, { ambiguous: ['app in a', 'app in b'] });
  assert.match(pt.parseCommand('in shellby:', { projects: PROJECTS }).reply, /Say what/);
});

test('! and / never come from the phone', () => {
  for (const text of ['!rm -rf C:\\', 'tidy up\n  !del *.*', '/task !whoami', 'in shellby: !npm publish']) {
    const r = pt.parseCommand(text, { projects: PROJECTS });
    assert.equal(r.kind, 'reply', text);
    assert.match(r.reply, /!/, text);
  }
  assert.match(pt.parseCommand('/task /config set theme').reply, /\/ commands/);
  assert.match(pt.parseCommand('@shellby /permissions', { projects: PROJECTS }).reply, /\/ commands/);
  assert.equal(pt.parseCommand('explain why "!important" is in the CSS').kind, 'task', 'a ! inside a line is just text');
});

test('text is cleaned and capped', () => {
  const bidi = String.fromCharCode(0x202e);
  const zw = String.fromCharCode(0x200b);
  const bell = String.fromCharCode(7);
  assert.equal(pt.cleanText(`a${bidi}b${zw}c${bell}d\r\ne\tf`), 'abcd\ne  f');
  assert.equal(pt.parseCommand(`fix${bidi} it`).prompt, 'fix it');
  assert.match(pt.parseCommand('x'.repeat(pt.MAX_TEXT + 1)).reply, /too long/);
  assert.equal(pt.parseCommand('x'.repeat(pt.MAX_TEXT)).kind, 'task');
  assert.equal(pt.parseCommand('   ').kind, 'reply');
  assert.equal(pt.parseCommand(null).kind, 'reply');
});

// ------------------------------------------------------------------ how many

test('at most three phone tasks at once', () => {
  assert.equal(pt.startGate({ open: pt.MAX_OPEN - 1, now: NOW }).ok, true);
  const full = pt.startGate({ open: pt.MAX_OPEN, now: NOW });
  assert.equal(full.ok, false);
  assert.match(full.reply, /already going/);
});

test('at most ten an hour, and the count rolls off', () => {
  const starts = Array.from({ length: pt.MAX_STARTS_PER_HOUR }, (_, i) => NOW - 50 * 60 * 1000 + i * 1000);
  const full = pt.startGate({ starts, now: NOW });
  assert.equal(full.ok, false);
  assert.match(full.reply, /this hour.*10 minutes/);
  assert.equal(pt.startGate({ starts, now: NOW + 11 * 60 * 1000 }).ok, true, 'the oldest fell out of the hour');
  assert.equal(pt.startGate({ starts: starts.slice(1), now: NOW }).ok, true);
  assert.equal(pt.startGate({ starts: ['x', NaN, NOW + 1e9], now: NOW }).ok, true, 'junk never counts');
});

test('a flood of messages is dropped past the hourly cap', () => {
  const seen = Array.from({ length: pt.MAX_MESSAGES_PER_HOUR }, () => NOW - 1000);
  assert.equal(pt.messageGate(seen, NOW), false);
  assert.equal(pt.messageGate(seen.slice(1), NOW), true);
  assert.equal(pt.messageGate(seen, NOW + 60 * 60 * 1000), true);
});

// ------------------------------------------------------------------ who may

const ch = (provider, target, patch = {}) => channels.normalizeChannelSettings(null, { enabled: true, replies: true, provider, target, ...patch });

test('the yes is bound to the bot, the chat and the topic', () => {
  const key = pt.consentKey(ch('telegram', CHAT), 'TOKEN');
  assert.equal(pt.consentKey(ch('telegram', CHAT), 'TOKEN'), key, 'same place, same key');
  assert.equal(pt.consentKey(ch('telegram', CHAT, { replies: true }), 'TOKEN'), key, 'answers on or off is not a new place');
  assert.notEqual(pt.consentKey(ch('telegram', CHAT), 'OTHER-TOKEN'), key, 'another bot');
  assert.notEqual(pt.consentKey(ch('telegram', '999'), 'TOKEN'), key, 'another chat');
  assert.notEqual(pt.consentKey(ch('ntfy', 'shellby-abcdefghjkmnpqrstu'), ''), pt.consentKey(ch('ntfy', 'shellby-abcdefghjkmnpqrsx'), ''), 'another topic');
  assert.doesNotMatch(key, /TOKEN/, 'never the token itself');
});

test('only Telegram and ntfy, set up and confirmed, with a folder', () => {
  const ok = { hasSecret: true, confirmed: true, hasFolder: true };
  assert.equal(pt.tasksProblem(ch('telegram', CHAT), ok), null);
  assert.match(pt.tasksProblem(ch('slack', 'https://hooks.slack.com/x'), ok), /Only Telegram and ntfy/);
  assert.match(pt.tasksProblem(ch('telegram', CHAT, { enabled: false }), ok), /Turn on/);
  assert.match(pt.tasksProblem(ch('telegram', CHAT), { ...ok, confirmed: false }), /Confirm/);
  assert.match(pt.tasksProblem(ch('telegram', CHAT, { replies: false }), ok), /Allow or Deny/);
  assert.match(pt.tasksProblem(ch('telegram', CHAT), { ...ok, hasSecret: false }), /bot token/);
  assert.match(pt.tasksProblem(ch('telegram', '-100123'), ok), /private chat/);
  assert.match(pt.tasksProblem(ch('telegram', CHAT), { ...ok, hasFolder: false }), /folder/);
  assert.match(pt.tasksProblem(ch('ntfy', 'mytopic'), { ...ok, hasSecret: false }), /nobody will guess/);
  assert.equal(pt.tasksProblem(ch('ntfy', channels.randomTopic()), { ...ok, hasSecret: false }), null);
  assert.match(pt.tasksProblem(ch('ntfy', channels.randomTopic()), { ...ok, canEncrypt: false }), /passphrase/);
  assert.ok(pt.tasksProblem(null));
});

// ------------------------------------------------------------------ what goes back

test('the tab is titled for the phone, short and on one line', () => {
  assert.equal(pt.titleFor('fix it\nplease'), '📱 fix it');
  assert.ok(pt.titleFor('x'.repeat(200)).length <= 53);
  assert.equal(pt.MODE, 'ask', 'never anything that acts without asking');
});

test('/status says titles and states, nothing more', () => {
  const text = pt.statusReply([
    { title: '📱 fix it', busy: true, waiting: false },
    { title: 'Review', busy: false, waiting: true },
    { title: 'Idle one', busy: false, waiting: false },
  ], { held: 2 });
  assert.equal(text, '⏳ 📱 fix it\n✋ Review: waiting for you\n🌙 2 queued for after the usage reset.');
  assert.equal(pt.statusReply([]), 'Nothing running. Shellby is free.');
});

test('help says how, and the passphrase only on ntfy', () => {
  assert.match(pt.helpReply({ provider: 'ntfy', folderName: 'shellby' }), /passphrase/);
  assert.doesNotMatch(pt.helpReply({ provider: 'telegram', folderName: 'shellby' }), /passphrase/);
  assert.match(pt.helpReply({ provider: 'telegram', projects: PROJECTS }), /Projects: shellby, shell-scripts, rack-builder/);
});

test('replies to the phone keep their lines, and phone tasks always hear back', () => {
  const m = channels.composeMessage({ kind: 'phone', title: 'Shellby', body: 'one\ntwo' });
  assert.equal(m.body, 'one\ntwo');
  assert.equal(m.emoji, '📱');
  const s = ch('ntfy', 'shellby-abc', { events: { done: false, asking: false }, minSeconds: 600 });
  assert.equal(channels.shouldSend({ kind: 'done', seconds: 5 }, s), false);
  assert.equal(channels.shouldSend({ kind: 'done', seconds: 5 }, s, { always: true }), true);
  assert.equal(channels.shouldSend({ kind: 'asking' }, s, { always: true }), true);
  assert.equal(channels.shouldSend({ kind: 'done' }, s, { focused: true, always: true }), true);
  assert.equal(channels.shouldSend({ kind: 'health' }, s, { always: true }), false, 'only about the task itself');
  assert.equal(channels.shouldSend({ kind: 'done' }, { ...s, enabled: false }, { always: true }), false, 'never when off');
});
