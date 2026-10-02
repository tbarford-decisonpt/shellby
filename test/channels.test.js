// Getting told when you're not at the desk. Every provider's exact request is
// asserted here rather than mocked loosely: these are other people's APIs, a
// wrong field name means a notification that silently never arrives, and the
// only way to notice is to pin the request shape.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  PROVIDER_NAMES, EVENT_NAMES, CHANNEL_DEFAULTS,
  normalizeChannelSettings, checkSettings, shouldSend, composeMessage,
  buildRequest, deliver, view, ntfyUrl, localOrHttps, duration,
} = require('../src/main/channels');

const asking = { kind: 'asking', project: 'shellby', message: 'Bash wants to run npm test' };
const settingsFor = (provider, target, patch = {}) => normalizeChannelSettings(null, { enabled: true, provider, target, ...patch });

// ------------------------------------------------------------------ settings

test('defaults are off, with the prompts and finishes already ticked', () => {
  assert.equal(CHANNEL_DEFAULTS.enabled, false, 'nothing leaves the PC until you ask');
  assert.equal(CHANNEL_DEFAULTS.events.asking, true);
  assert.equal(CHANNEL_DEFAULTS.events.done, true);
  assert.equal(CHANNEL_DEFAULTS.events.health, false);
});

test('normalizeChannelSettings clamps and ignores nonsense', () => {
  const s = normalizeChannelSettings(null, {
    enabled: 'yes', provider: 'rm -rf', target: ' topic ', minSeconds: 99999, events: { asking: 0, nope: true },
  });
  assert.equal(s.enabled, true);
  assert.equal(s.provider, 'ntfy', 'an unknown provider leaves the old one alone');
  assert.equal(s.target, 'topic');
  assert.equal(s.minSeconds, 3600);
  assert.equal(s.events.asking, false);
  assert.ok(!('nope' in s.events));
  assert.equal(normalizeChannelSettings(null, { minSeconds: -5 }).minSeconds, 0);
  assert.equal(normalizeChannelSettings(null, { minSeconds: 'x' }).minSeconds, CHANNEL_DEFAULTS.minSeconds);
});

test('a long target is cut rather than carried around', () => {
  assert.equal(normalizeChannelSettings(null, { target: 'x'.repeat(900) }).target.length, 300);
});

// ------------------------------------------------------------------ checking

test('checkSettings explains exactly what is missing', () => {
  assert.match(checkSettings(settingsFor('ntfy', '')), /needs topic or full topic url/i);
  assert.match(checkSettings(settingsFor('ntfy', 'has spaces')), /topic name, or an https/i);
  assert.equal(checkSettings(settingsFor('ntfy', 'shellby-a7f3b2')), null);
  assert.match(checkSettings(settingsFor('pushover', 'u'.repeat(30))), /needs application token/i);
  assert.equal(checkSettings(settingsFor('pushover', 'u'.repeat(30)), { hasSecret: true }), null);
  assert.match(checkSettings(settingsFor('telegram', 'not-a-number'), { hasSecret: true }), /chat id is a number/i);
  assert.equal(checkSettings(settingsFor('telegram', '-1001234567890'), { hasSecret: true }), null);
  assert.match(checkSettings(settingsFor('discord', 'https://evil.example/hook')), /Discord webhook URL/);
  assert.match(checkSettings(settingsFor('slack', 'https://evil.example/hook')), /Slack webhook URL/);
});

test('every provider is described well enough to fill in', () => {
  const v = view(CHANNEL_DEFAULTS);
  assert.deepEqual(v.providers.map(p => p.name), PROVIDER_NAMES);
  for (const p of v.providers) {
    assert.ok(p.label && p.targetLabel && p.hint.length > 20, p.name);
    assert.ok(['no', 'optional', 'required'].includes(p.secret), p.name);
    if (p.secret !== 'no') assert.ok(p.secretLabel, `${p.name} names its token field`);
  }
});

test('the view never carries the secret, only whether there is one', () => {
  const v = view(settingsFor('pushover', 'u'.repeat(30)), { hasSecret: true });
  assert.equal(v.hasSecret, true);
  assert.equal(JSON.stringify(v).includes('secret-value'), false);
  assert.ok(!('secret' in v) || typeof v.secret !== 'string');
});

// ------------------------------------------------------------------ URL safety

test('plain http is only allowed to this PC and private networks', () => {
  assert.equal(localOrHttps('https://example.com/hook'), true);
  assert.equal(localOrHttps('http://127.0.0.1:8080/hook'), true);
  assert.equal(localOrHttps('http://localhost/hook'), true);
  assert.equal(localOrHttps('http://192.168.1.10/hook'), true);
  assert.equal(localOrHttps('http://10.0.0.5/hook'), true);
  assert.equal(localOrHttps('http://172.16.4.2/hook'), true);
  assert.equal(localOrHttps('http://nas.local/hook'), true);
  // A token over plain http to the open internet is readable in transit.
  assert.equal(localOrHttps('http://example.com/hook'), false);
  assert.equal(localOrHttps('http://172.32.0.1/hook'), false, '172.32 is not private');
  assert.equal(localOrHttps('ftp://example.com'), false);
  assert.equal(localOrHttps('file:///C:/x'), false);
  assert.equal(localOrHttps('javascript:alert(1)'), false);
  assert.equal(localOrHttps('not a url'), false);
});

test('ntfyUrl accepts a topic or a server URL, and refuses a bare server', () => {
  assert.equal(ntfyUrl('shellby-a7f3b2'), 'https://ntfy.sh/shellby-a7f3b2');
  assert.equal(ntfyUrl('https://ntfy.sh/mytopic'), 'https://ntfy.sh/mytopic');
  assert.equal(ntfyUrl('https://ntfy.example.com/mytopic/'), 'https://ntfy.example.com/mytopic');
  assert.equal(ntfyUrl('http://192.168.1.9:8080/mytopic'), 'http://192.168.1.9:8080/mytopic');
  assert.equal(ntfyUrl('https://ntfy.sh'), null, 'no topic: nowhere to publish');
  assert.equal(ntfyUrl('https://ntfy.sh/a/b/c'), null);
  assert.equal(ntfyUrl('has spaces'), null);
  assert.equal(ntfyUrl(''), null);
});

// ------------------------------------------------------------------ messages

test('composeMessage says who needs what, per event', () => {
  const a = composeMessage(asking);
  assert.equal(a.title, 'Shellby needs you in shellby');
  assert.equal(a.body, 'Bash wants to run npm test');
  assert.equal(a.priority, 'high');

  const d = composeMessage({ kind: 'done', project: 'shellby', tools: 14, seconds: 95 });
  assert.equal(d.title, 'Finished in shellby');
  assert.equal(d.body, '14 tools · 1m 35s');

  const l = composeMessage({ kind: 'limit', resetsAt: new Date('2026-10-02T15:30:00').getTime() });
  assert.match(l.body, /napping until 15:30/);
  assert.equal(composeMessage({ kind: 'limit' }).title, 'Your usage limit has reset');

  const h = composeMessage({ kind: 'health', title: 'GPU is running hot: 84°C', body: 'Above your 80°C warning.' });
  assert.equal(h.title, 'GPU is running hot: 84°C');

  const ci = composeMessage({ kind: 'ci', project: 'x-salmon/shellby#42', passing: false });
  assert.match(ci.title, /Build failed: x-salmon\/shellby#42/);
  assert.equal(composeMessage({ kind: 'ci', passing: true }).emoji, '✅');
});

test('composeMessage flattens and caps whatever it is handed', () => {
  const m = composeMessage({ kind: 'asking', project: 'p'.repeat(200), message: `a\nb\tc   ${'x'.repeat(900)}` });
  assert.ok(m.title.length < 130);
  assert.equal(m.body.length, 500);
  assert.ok(!/[\n\t]/.test(m.body));
  assert.equal(typeof composeMessage(null).title, 'string');
  assert.equal(typeof composeMessage({ kind: 'nonsense' }).title, 'string');
});

test('duration reads like a person wrote it', () => {
  assert.equal(duration(9), '9s');
  assert.equal(duration(95), '1m 35s');
  assert.equal(duration(3725), '1h 2m');
  assert.equal(duration(undefined), '');
  assert.equal(duration(-5), '');
});

// ------------------------------------------------------------------ when to send

test('shouldSend respects the switch, the event list and the quick-task floor', () => {
  const s = settingsFor('ntfy', 'topic', { minSeconds: 60 });
  assert.equal(shouldSend(asking, s), true);
  assert.equal(shouldSend(asking, { ...s, enabled: false }), false);
  assert.equal(shouldSend({ kind: 'health' }, s), false, 'health is off by default');
  assert.equal(shouldSend({ kind: 'health' }, normalizeChannelSettings(s, { events: { health: true } })), true);
  assert.equal(shouldSend({ kind: 'nope' }, s), false);
  assert.equal(shouldSend(null, s), false);
  // A four-second task is not worth a buzz; a four-second permission prompt is.
  assert.equal(shouldSend({ kind: 'done', seconds: 4 }, s), false);
  assert.equal(shouldSend({ kind: 'done', seconds: 600 }, s), true);
  assert.equal(shouldSend({ kind: 'done' }, s), true, 'no duration known: send it');
  assert.equal(shouldSend({ kind: 'done', seconds: 4 }, normalizeChannelSettings(s, { minSeconds: 0 })), true);
});

test('a focus session holds everything back except the ones that need you', () => {
  const s = settingsFor('ntfy', 'topic');
  assert.equal(shouldSend({ kind: 'done', seconds: 600 }, s, { focused: true }), false);
  assert.equal(shouldSend(asking, s, { focused: true }), true, 'a permission prompt still gets through');
  assert.equal(shouldSend({ kind: 'done', seconds: 600 }, normalizeChannelSettings(s, { whileFocused: true }), { focused: true }), true);
});

// ------------------------------------------------------------------ the requests

test('ntfy: the text is the body, everything else is a header', () => {
  const { request } = buildRequest(settingsFor('ntfy', 'shellby-a7f3b2'), '', asking);
  assert.equal(request.url, 'https://ntfy.sh/shellby-a7f3b2');
  assert.equal(request.method, 'POST');
  assert.equal(request.body, 'Bash wants to run npm test');
  assert.equal(request.headers.Title, 'Shellby needs you in shellby');
  assert.equal(request.headers.Priority, '4');
  assert.equal(request.headers.Tags, 'crab,warning');
  assert.equal(request.headers.Authorization, undefined);
});

test('ntfy: a token becomes a bearer header, and a non-ASCII title is encoded', () => {
  const withToken = buildRequest(settingsFor('ntfy', 'shellby-a7f3b2'), 'tk_abc', asking).request;
  assert.equal(withToken.headers.Authorization, 'Bearer tk_abc');
  // Headers are latin-1; "84°C" would otherwise throw when the request is made.
  const hot = buildRequest(settingsFor('ntfy', 'topic'), '', { kind: 'health', title: 'GPU at 84°C', body: 'x' }).request;
  assert.match(hot.headers.Title, /^=\?UTF-8\?B\?/);
  assert.equal(Buffer.from(hot.headers.Title.slice(10, -2), 'base64').toString('utf8'), 'GPU at 84°C');
});

test('pushover: form-encoded, with the app token and user key in the right fields', () => {
  const { request } = buildRequest(settingsFor('pushover', 'u'.repeat(30)), 'app-token', asking);
  assert.equal(request.url, 'https://api.pushover.net/1/messages.json');
  assert.equal(request.headers['Content-Type'], 'application/x-www-form-urlencoded');
  const form = new URLSearchParams(request.body);
  assert.equal(form.get('token'), 'app-token', 'token is the application token');
  assert.equal(form.get('user'), 'u'.repeat(30), 'user is the user key');
  assert.equal(form.get('title'), 'Shellby needs you in shellby');
  assert.equal(form.get('message'), 'Bash wants to run npm test');
  assert.equal(form.get('priority'), '1');
});

test('telegram: the bot token is in the path and MarkdownV2 is escaped', () => {
  const { request } = buildRequest(settingsFor('telegram', '-1001234567890'), '123:ABC-DEF', asking);
  assert.equal(request.url, 'https://api.telegram.org/bot123%3AABC-DEF/sendMessage');
  const body = JSON.parse(request.body);
  assert.equal(body.chat_id, '-1001234567890');
  assert.equal(body.parse_mode, 'MarkdownV2');
  // Every reserved character escaped, or Telegram rejects the whole message.
  const dotty = JSON.parse(buildRequest(settingsFor('telegram', '1'), 't', { kind: 'health', title: 'v0.19.0 (hot!)', body: 'a-b_c' }).request.body);
  assert.match(dotty.text, /v0\\\.19\\\.0 \\\(hot\\!\\\)/);
  assert.match(dotty.text, /a\\-b\\_c/);
});

test('discord: a task title can never make Shellby ping the channel', () => {
  const { request } = buildRequest(settingsFor('discord', 'https://discord.com/api/webhooks/1/abc'), '',
    { kind: 'asking', project: 'x', message: 'hello @everyone' });
  const body = JSON.parse(request.body);
  assert.match(body.content, /hello @everyone/, 'the text is kept as written');
  assert.deepEqual(body.allowed_mentions, { parse: [] }, '...but it cannot mention anyone');
});

test('slack: one line of text to the webhook URL', () => {
  const { request } = buildRequest(settingsFor('slack', 'https://hooks.slack.com/services/T/B/x'), '', asking);
  assert.equal(request.url, 'https://hooks.slack.com/services/T/B/x');
  assert.match(JSON.parse(request.body).text, /Shellby needs you in shellby/);
});

test('my own endpoint: Shellby\'s own JSON, with the event name', () => {
  const { request } = buildRequest(settingsFor('webhook', 'https://example.com/hook'), 'bearer-tok',
    { kind: 'done', project: 'shellby', tools: 3, seconds: 200, at: 1700000000000 });
  const body = JSON.parse(request.body);
  assert.equal(request.headers.Authorization, 'Bearer bearer-tok');
  assert.equal(body.event, 'done');
  assert.equal(body.project, 'shellby');
  assert.equal(body.at, 1700000000000);
  assert.equal(body.priority, 'normal');
  assert.match(body.body, /3 tools/);
});

test('buildRequest refuses before it builds anything when misconfigured', () => {
  assert.match(buildRequest(settingsFor('ntfy', ''), '', asking).error, /needs topic/i);
  assert.match(buildRequest(settingsFor('pushover', 'u'.repeat(30)), '', asking).error, /application token/i);
  assert.equal(buildRequest(settingsFor('ntfy', 'topic'), '', asking).error, undefined);
});

test('every provider builds a request that could actually be sent', () => {
  const targets = {
    ntfy: 'shellby-a7f3b2',
    pushover: 'u'.repeat(30),
    telegram: '-1001234567890',
    discord: 'https://discord.com/api/webhooks/1/abc',
    slack: 'https://hooks.slack.com/services/T/B/x',
    webhook: 'https://example.com/hook',
  };
  for (const name of PROVIDER_NAMES) {
    for (const kind of EVENT_NAMES) {
      const { request, error } = buildRequest(settingsFor(name, targets[name]), 'a-secret', { kind, project: 'p', seconds: 100 });
      assert.equal(error, undefined, `${name}/${kind}: ${error}`);
      assert.match(request.url, /^https?:\/\//, `${name} has a URL`);
      assert.equal(request.method, 'POST');
      assert.ok(typeof request.body === 'string' && request.body.length > 0, `${name}/${kind} has a body`);
      // Headers must be latin-1 or the request throws when it is made.
      for (const [k, v] of Object.entries(request.headers)) {
        assert.doesNotThrow(() => Buffer.from(String(v), 'latin1'), `${name} header ${k}`);
        assert.match(String(v), /^[\x20-\x7e]*$/, `${name} header ${k} is ASCII-safe: ${v}`);
      }
    }
  }
});

// ------------------------------------------------------------------ delivery

test('deliver reports success, and the server\'s own complaint on failure', async () => {
  const ok = await deliver({ url: 'https://x/y', method: 'POST', headers: {}, body: 'x' },
    { fetchImpl: async () => ({ ok: true, status: 200 }) });
  assert.deepEqual(ok, { ok: true });

  const bad = await deliver({ url: 'https://x/y', method: 'POST', headers: {}, body: 'x' },
    { fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'user key is invalid' }) });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, '400: user key is invalid');
});

test('deliver caps a huge error body and survives one it cannot read', async () => {
  const huge = await deliver({ url: 'https://x', method: 'POST', headers: {}, body: '' },
    { fetchImpl: async () => ({ ok: false, status: 500, text: async () => 'y'.repeat(100000) }) });
  assert.ok(huge.error.length < 200, `error was ${huge.error.length} characters`);
  const unreadable = await deliver({ url: 'https://x', method: 'POST', headers: {}, body: '' },
    { fetchImpl: async () => ({ ok: false, status: 502, text: async () => { throw new Error('no body'); } }) });
  assert.equal(unreadable.error, '502');
});

test('deliver turns a timeout and a network error into something readable', async () => {
  const timedOut = await deliver({ url: 'https://x', method: 'POST', headers: {}, body: '' }, {
    timeoutMs: 5,
    fetchImpl: (_u, opts) => new Promise((_res, rej) => {
      opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  assert.deepEqual(timedOut, { ok: false, error: 'timed out' });

  const refused = await deliver({ url: 'https://x', method: 'POST', headers: {}, body: '' },
    { fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND x'); } });
  assert.match(refused.error, /ENOTFOUND/);
});

test('deliver never follows a redirect', async () => {
  let saw = null;
  await deliver({ url: 'https://x', method: 'POST', headers: {}, body: '' },
    { fetchImpl: async (_u, opts) => { saw = opts.redirect; return { ok: true }; } });
  assert.equal(saw, 'error');
});
