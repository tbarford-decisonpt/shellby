// Telling you about it when you're not at the desk.
//
// Autonomous mode is the one part of Shellby that expects you to walk away, and
// until now walking away meant missing the moment he raised a claw. One pasted
// URL or token here and a permission prompt, a finished run, a red build or an
// overheating GPU reaches your phone.
//
// Deliberately webhook-shaped: a URL and at most a token, no OAuth, no app to
// register, no server of ours in the middle. ntfy, Pushover, Telegram, a Discord
// or Slack webhook, or your own endpoint.
//
// buildRequest() and composeMessage() are pure, so every provider's exact
// request is unit-tested without touching the network. Credentials are passed in
// rather than read here: main.js keeps them in Windows' encrypted store, the
// same way it keeps the GitHub token, and they never reach settings.json.
//
// Setup does the fiddly part itself where it can: ntfy gets a topic picked for
// you (and a QR code in Settings to subscribe with), and Telegram's chat id is
// read off the bot once you've messaged it.
const crypto = require('crypto');
const net = require('net');

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_TITLE = 100;
const MAX_BODY = 500;

// What Shellby can tell you about, and whether it's on by default. "asking" is
// the one that matters when you've walked away, so it leads.
const EVENTS = Object.freeze({
  asking: { label: 'He needs permission', default: true, priority: 'high' },
  done: { label: 'A task finished', default: true, priority: 'normal' },
  limit: { label: 'Usage limit reached, and when it resets', default: true, priority: 'normal' },
  // Work you queued for the reset, often overnight: what it came to, not just that it ended.
  queue: { label: 'A task you queued for the reset finished, with its result', default: true, priority: 'normal' },
  health: { label: 'Something is overheating or filling up', default: false, priority: 'high' },
  ci: { label: 'A build goes red or green', default: false, priority: 'normal' },
  // A workflow's own "tell me on my phone" step: asked for by name, so on by default.
  workflow: { label: 'A workflow sends you a message', default: true, priority: 'normal' },
});

const EVENT_NAMES = Object.keys(EVENTS);
const PRIORITIES = ['low', 'normal', 'high', 'urgent'];

const CHANNEL_DEFAULTS = Object.freeze({
  enabled: false,
  provider: 'ntfy',
  target: '',          // the topic, chat id, or URL -- what it means depends on the provider
  events: Object.freeze(Object.fromEntries(EVENT_NAMES.map(e => [e, EVENTS[e].default]))),
  minSeconds: 60,      // don't buzz your pocket for a task that took four seconds
  whileFocused: false, // Guard my focus holds these back too, unless you say otherwise
  replies: false,      // Allow / Deny buttons on the phone (replies.js); Telegram and ntfy only
});

// The providers that can carry an answer back without a server of ours.
const REPLY_PROVIDERS = new Set(['telegram', 'ntfy']);

const clip = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

// ------------------------------------------------------------------ providers

/**
 * Each provider says what it needs and how to build its request.
 *   target: what the user pastes in, and how to check it
 *   secret: whether a token is also needed (kept in the encrypted store)
 *   build(target, secret, message) -> { url, method, headers, body }
 */
const PROVIDERS = {
  ntfy: {
    label: 'ntfy',
    targetLabel: 'Topic or full topic URL',
    hint: 'Shellby picked a topic nobody will guess. Scan the code with your phone to subscribe in the free ntfy app, no account needed. Anyone who knows the topic can read it, so keep it to yourself.',
    secret: 'optional',
    secretLabel: 'Access token (only if your server needs one)',
    checkTarget: t => (ntfyUrl(t) ? null : 'That needs to be a topic name, or an https:// URL to one.'),
    build(target, secret, m) {
      const headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        Title: encodeHeader(m.title),
        Priority: String({ low: 2, normal: 3, high: 4, urgent: 5 }[m.priority] ?? 3),
        Tags: m.tags.join(','),
      };
      if (m.url) headers.Click = m.url;
      if (secret) headers.Authorization = `Bearer ${secret}`;
      const replyUrl = m.reply && ntfyReplyUrl(target);
      if (replyUrl) headers.Actions = ntfyActions(replyUrl, m.reply.nonce);
      return { url: ntfyUrl(target), method: 'POST', headers, body: m.body };
    },
  },

  pushover: {
    label: 'Pushover',
    targetLabel: 'Your user key',
    hint: 'From pushover.net, plus an application token for Shellby.',
    secret: 'required',
    secretLabel: 'Application token',
    checkTarget: t => (/^[A-Za-z0-9]{20,40}$/.test(clip(t, 40)) ? null : 'A Pushover user key is 30 letters and digits.'),
    build(target, secret, m) {
      const form = new URLSearchParams({
        token: secret,
        user: clip(target, 40),
        title: m.title,
        message: m.body,
        priority: String({ low: -1, normal: 0, high: 1, urgent: 1 }[m.priority] ?? 0),
      });
      if (m.url) { form.set('url', m.url); form.set('url_title', 'Open'); }
      return {
        url: 'https://api.pushover.net/1/messages.json',
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
      };
    },
  },

  telegram: {
    label: 'Telegram',
    targetLabel: 'Chat id',
    hint: 'Make a bot with @BotFather in Telegram and paste its token below. Then send your bot any message, and Shellby finds your chat by itself.',
    secret: 'required',
    secretLabel: 'Bot token',
    checkTarget: t => (/^-?\d{1,20}$/.test(clip(t, 24)) ? null : 'A Telegram chat id is a number (negative for a group).'),
    build(target, secret, m) {
      return {
        url: `https://api.telegram.org/bot${encodeURIComponent(secret)}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: clip(target, 24),
          text: `${m.emoji} *${escapeMarkdown(m.title)}*\n${escapeMarkdown(m.body)}`,
          parse_mode: 'MarkdownV2',
          disable_notification: m.priority === 'low',
          link_preview_options: { is_disabled: true },
          ...(m.reply ? { reply_markup: telegramMarkup(m.reply.nonce) } : {}),
        }),
      };
    },
  },

  discord: {
    label: 'Discord',
    targetLabel: 'Webhook URL',
    hint: 'Channel settings, Integrations, New Webhook, then copy the URL.',
    secret: 'no',
    checkTarget: t => (/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(clip(t, 300)) ? null : 'That does not look like a Discord webhook URL.'),
    build(target, _secret, m) {
      return {
        url: clip(target, 300),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // allowed_mentions: a task title can't make Shellby ping @everyone.
        body: JSON.stringify({
          content: `${m.emoji} **${m.title}**\n${m.body}${m.url ? `\n${m.url}` : ''}`,
          allowed_mentions: { parse: [] },
        }),
      };
    },
  },

  slack: {
    label: 'Slack',
    targetLabel: 'Incoming webhook URL',
    hint: 'From a Slack app with Incoming Webhooks turned on.',
    secret: 'no',
    checkTarget: t => (/^https:\/\/hooks\.slack\.com\//.test(clip(t, 300)) ? null : 'That does not look like a Slack webhook URL.'),
    build(target, _secret, m) {
      return {
        url: clip(target, 300),
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `${m.emoji} *${m.title}* — ${m.body}`,
          ...(m.url ? { blocks: undefined } : {}),
        }),
      };
    },
  },

  webhook: {
    label: 'My own endpoint',
    targetLabel: 'URL to POST to',
    hint: 'Shellby POSTs JSON: event, title, body, project, priority and when it happened.',
    secret: 'optional',
    secretLabel: 'Bearer token (sent as Authorization, if you need one)',
    checkTarget: t => (localOrHttps(clip(t, 300)) ? null : 'That needs to be an https:// URL (http:// is allowed for your own machine or LAN).'),
    build(target, secret, m) {
      const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Shellby' };
      if (secret) headers.Authorization = `Bearer ${secret}`;
      return {
        url: clip(target, 300),
        method: 'POST',
        headers,
        body: JSON.stringify({
          event: m.event, title: m.title, body: m.body,
          project: m.project || null, priority: m.priority, at: m.at,
          ...(m.url ? { url: m.url } : {}),
        }),
      };
    },
  },
};

const PROVIDER_NAMES = Object.keys(PROVIDERS);

/** A bare ntfy topic or a full URL -> the URL to POST to, or null. */
function ntfyUrl(target) {
  const t = clip(target, 300);
  if (/^[A-Za-z0-9_-]{3,64}$/.test(t)) return `https://ntfy.sh/${t}`;
  if (!localOrHttps(t)) return null;
  try {
    const u = new URL(t);
    // A server URL with no topic path is not somewhere to publish.
    return /^\/[A-Za-z0-9_-]{1,64}\/?$/.test(u.pathname) ? u.toString().replace(/\/$/, '') : null;
  } catch { return null; }
}

/**
 * https anywhere, or http only to this PC and private networks: a token posted
 * over plain http to the open internet would be readable in transit.
 */
function localOrHttps(raw) {
  let u;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol === 'https:') return true;
  if (u.protocol !== 'http:') return false;
  const h = u.hostname.replace(/\.+$/, '');
  // The ranges are for addresses only: "10.example.com" is a public name.
  const ip4 = net.isIPv4(h);
  return h === 'localhost' || h === '127.0.0.1' || u.hostname === '[::1]' || h.endsWith('.local')
    || (ip4 && (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)));
}

/**
 * Where ntfy's buttons publish the answer: a second topic beside yours, so the
 * notifications you subscribed to never fill up with "allow:..." messages.
 * Topics top out at 64 characters, so a long one is shortened to make room.
 */
function ntfyReplyUrl(target) {
  const url = ntfyUrl(target);
  if (!url) return null;
  const at = url.lastIndexOf('/');
  return `${url.slice(0, at + 1)}${url.slice(at + 1).slice(0, 58)}-reply`;
}

/** ntfy's Actions header: two buttons that publish the answer to the reply topic. */
function ntfyActions(replyUrl, nonce) {
  // Commas and semicolons separate fields and actions, so neither can appear
  // in a value; the nonce alphabet (base64url) has neither.
  const button = (label, word) => `http, ${label}, ${replyUrl}, method=POST, body=${word}:${nonce}, clear=true`;
  return `${button('Allow', 'allow')}; ${button('Deny', 'deny')}`;
}

function telegramMarkup(nonce) {
  return { inline_keyboard: [[{ text: '✅ Allow', callback_data: `a:${nonce}` }, { text: '✋ Deny', callback_data: `d:${nonce}` }]] };
}

// Header values must be latin-1; a task title can hold anything.
const encodeHeader = s => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

// Telegram's MarkdownV2 needs every one of these escaped, or it rejects the whole message.
const escapeMarkdown = s => String(s).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, c => `\\${c}`);

// ------------------------------------------------------------------ setting it up for you

// Lowercase letters and digits that can't be misread off a phone (no 0/o, 1/l/i).
const TOPIC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

/** An ntfy.sh topic nobody will guess (~69 bits): knowing the topic is all it takes to read it. */
function randomTopic(bytes = crypto.randomBytes(14)) {
  return `shellby-${[...bytes].map(b => TOPIC_ALPHABET[b % TOPIC_ALPHABET.length]).join('')}`;
}

/**
 * Telegram's getUpdates reply -> the chat that last messaged the bot, preferring
 * a private chat over a group the bot was added to.
 *   -> { chatId, name } | { error }
 */
function chatFromUpdates(reply) {
  if (!reply || typeof reply !== 'object') return { error: "Telegram didn't answer." };
  if (reply.ok !== true) {
    if (reply.error_code === 401 || reply.error_code === 404) return { error: "Telegram doesn't recognise that bot token." };
    return { error: clip(reply.description, 160) || "Telegram didn't answer." };
  }
  const chats = (Array.isArray(reply.result) ? reply.result : [])
    .map(u => (u?.message || u?.edited_message || u?.channel_post || u?.my_chat_member)?.chat)
    .filter(c => c && Number.isSafeInteger(c.id))
    .reverse(); // newest first
  const chat = chats.find(c => c.type === 'private') || chats[0];
  if (!chat) return { error: 'No messages yet. Send your bot any message in Telegram, then try again.' };
  const name = chat.title || [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username;
  return { chatId: String(chat.id), name: clip(name, 60) || null };
}

/** Ask Telegram who has messaged the bot lately. -> { chatId, name } | { error } */
async function findTelegramChat(token, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!token) return { error: 'Paste the bot token first.' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates`, { signal: ctrl.signal, redirect: 'error' });
    return chatFromUpdates(await res.json().catch(() => null));
  } catch (e) {
    return { error: e?.name === 'AbortError' ? 'Telegram timed out.' : clip(e?.message, 120) || "Couldn't reach Telegram." };
  } finally {
    clearTimeout(timer);
  }
}

// ------------------------------------------------------------------ settings

/** Validate a settings patch on top of the current settings. */
function normalizeChannelSettings(current, patch = {}) {
  const base = { ...CHANNEL_DEFAULTS, ...(current && typeof current === 'object' ? current : {}) };
  const next = { ...base, events: { ...CHANNEL_DEFAULTS.events, ...(base.events || {}) } };

  if ('enabled' in patch) next.enabled = !!patch.enabled;
  if ('whileFocused' in patch) next.whileFocused = !!patch.whileFocused;
  if ('replies' in patch) next.replies = !!patch.replies;
  if ('provider' in patch && PROVIDER_NAMES.includes(patch.provider) && patch.provider !== base.provider) {
    next.provider = patch.provider;
    // One provider's target means nothing to another, and can be dangerous: a
    // Telegram chat id is a valid ntfy topic, but a public, guessable one.
    next.target = '';
  }
  if ('target' in patch) next.target = clip(patch.target, 300);
  if ('minSeconds' in patch) {
    const n = Number(patch.minSeconds);
    next.minSeconds = Number.isFinite(n) ? Math.min(3600, Math.max(0, Math.round(n))) : base.minSeconds;
  }
  if (patch.events && typeof patch.events === 'object') {
    for (const e of EVENT_NAMES) if (e in patch.events) next.events[e] = !!patch.events[e];
  }
  return next;
}

/** Is this configured enough to send anything? Returns an error string or null. */
function checkSettings(settings, { hasSecret = false } = {}) {
  const s = normalizeChannelSettings(settings);
  const p = PROVIDERS[s.provider];
  if (!p) return 'Pick where to send them.';
  if (!s.target) return `${p.label} needs ${p.targetLabel.toLowerCase()}.`;
  const bad = p.checkTarget(s.target);
  if (bad) return bad;
  if (p.secret === 'required' && !hasSecret) return `${p.label} needs ${p.secretLabel.toLowerCase()}.`;
  return null;
}

/**
 * Should this event go out?
 *   event: { kind, seconds? }
 *   { focused }: a focus session is on, and holds everything but the urgent
 *   { always }: about a task your phone started, which the phone always hears
 *     about (how it's going, what it needs), whichever kinds you ticked
 */
function shouldSend(event, settings, { focused = false, always = false } = {}) {
  const s = normalizeChannelSettings(settings);
  if (!s.enabled) return false;
  const kind = event?.kind;
  if (always && (kind === 'asking' || kind === 'done')) return true;
  if (!EVENT_NAMES.includes(kind) || !s.events[kind]) return false;
  if (focused && !s.whileFocused && EVENTS[kind].priority !== 'high') return false;
  // A task that took no time at all is not news; the "he needs you" prompts and
  // the alerts are never held back for being quick.
  if (kind === 'done' && Number.isFinite(event.seconds) && event.seconds < s.minSeconds) return false;
  return true;
}

// ------------------------------------------------------------------ messages

const EMOJI = { asking: '🦀', done: '✅', limit: '😴', queue: '🌙', health: '🥵', ci: '🔴', workflow: '⚡', phone: '📱' };

/**
 * One event -> what every provider sends.
 *   event: { kind, project?, message?, tools?, seconds?, title?, body?, url?, at? }
 */
function composeMessage(event) {
  const m = describeEvent(event);
  // Some providers put the message in the body (ntfy) and some in a field next
  // to the title. An empty body would arrive as a blank notification on the
  // first kind, so the title stands in for it.
  return { ...m, title: m.title || 'Shellby', body: m.body || m.title || 'Shellby' };
}

function describeEvent(event) {
  const e = event && typeof event === 'object' ? event : {};
  const project = clip(e.project, 60);
  const at = Number.isFinite(e.at) ? e.at : Date.now();
  const base = { event: e.kind, project, at, priority: EVENTS[e.kind]?.priority || 'normal', tags: [], emoji: EMOJI[e.kind] || '🦀', url: clip(e.url, 300) || null, reply: null };

  switch (e.kind) {
    case 'asking': {
      // Buttons only on a prompt, and only with a nonce of the right shape: it
      // goes into a header and a callback, and is the whole of the answer's proof.
      const reply = typeof e.reply?.nonce === 'string' && /^[A-Za-z0-9_-]{22}$/.test(e.reply.nonce) ? { nonce: e.reply.nonce } : null;
      const deskOnly = !reply && clip(e.deskOnly, 80);
      const asked = clip(e.message, deskOnly ? MAX_BODY - 81 : MAX_BODY) || 'A task is waiting for your permission.';
      return {
        ...base, tags: ['crab', 'warning'], reply,
        title: project ? `Shellby needs you in ${project}` : 'Shellby needs you',
        body: deskOnly ? `${asked}\n${deskOnly}` : asked,
      };
    }
    case 'done':
      return {
        ...base, tags: ['crab', 'white_check_mark'],
        title: project ? `Finished in ${project}` : 'Shellby finished',
        body: clip([e.tools ? `${e.tools} tool${e.tools === 1 ? '' : 's'}` : '', duration(e.seconds)].filter(Boolean).join(' · '), MAX_BODY)
          || 'The task is done.',
      };
    case 'limit':
      return {
        ...base, tags: ['crab', 'sleeping'],
        title: e.resetsAt ? 'Usage limit reached' : 'Your usage limit has reset',
        body: e.resetsAt ? `Shellby is napping until ${timeOf(e.resetsAt)}.` : 'Shellby is awake again and ready to go.',
      };
    case 'queue': {
      // status: 'ok' | 'error' | 'stopped' | 'paused' (the window ran dry partway; it carries on at resumeAt).
      const name = clip(e.title, 70) || 'Your queued task';
      const left = Number.isFinite(e.left) && e.left > 0 ? `${e.left} more queued.` : '';
      const head = {
        ok: { emoji: '✅', tag: 'white_check_mark', title: `Done: ${name}` },
        error: { emoji: '⚠️', tag: 'warning', title: `Hit a problem: ${name}` },
        stopped: { emoji: '⏹️', tag: 'stop_button', title: `Stopped: ${name}` },
        paused: { emoji: '😴', tag: 'sleeping', title: `Out of usage partway: ${name}` },
      }[e.status] || { emoji: '🌙', tag: 'crescent_moon', title: name };
      const said = e.status === 'paused'
        ? `It carries on from where it stopped${e.resumeAt ? ` at ${timeOf(e.resumeAt)}` : ' after the next reset'}.`
        : clip(e.body, MAX_BODY - 100) || (e.status === 'ok' ? 'It finished.' : '');
      const facts = [project, duration(e.seconds), left].filter(Boolean).join(' · ');
      return {
        ...base, emoji: head.emoji, tags: ['crab', head.tag],
        title: clip(head.title, MAX_TITLE),
        // Its own line for the facts, so the result reads first.
        body: [said, facts].filter(Boolean).join('\n'),
      };
    }
    case 'health':
      return {
        ...base, tags: ['crab', 'fire'],
        title: clip(e.title, MAX_TITLE) || 'Something needs a look',
        body: clip(e.body, MAX_BODY) || '',
      };
    case 'ci':
      return {
        ...base, tags: ['crab', e.passing ? 'white_check_mark' : 'red_circle'],
        emoji: e.passing ? '✅' : '🔴',
        title: e.passing ? `Build fixed: ${project || 'your pull request'}` : `Build failed: ${project || 'your pull request'}`,
        body: clip(e.body, MAX_BODY) || (e.passing ? 'It went green again.' : 'CI went red.'),
      };
    case 'phone':
      // Shellby answering a message from your phone (phone-tasks.js): a few
      // short lines, so the line breaks are kept.
      return {
        ...base, tags: ['crab', 'iphone'],
        title: clip(e.title, MAX_TITLE) || 'Shellby',
        body: String(e.body ?? '').split('\n').map(l => clip(l, MAX_BODY)).filter(Boolean).join('\n').slice(0, MAX_BODY * 2),
      };
    case 'workflow':
      return {
        ...base, tags: ['crab', 'zap'],
        title: clip(e.title, MAX_TITLE) || (project ? `From ${project}` : 'From a workflow'),
        body: clip(e.body, MAX_BODY) || '',
      };
    default:
      return { ...base, title: clip(e.title, MAX_TITLE) || 'Shellby', body: clip(e.body, MAX_BODY) || '' };
  }
}

function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${Math.round(seconds % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function timeOf(ms) {
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toTimeString().slice(0, 5) : 'soon';
}

// ------------------------------------------------------------------ sending

/**
 * The exact request for one event, or an error.
 *   { request: { url, method, headers, body } } | { error }
 */
function buildRequest(settings, secret, event) {
  const s = normalizeChannelSettings(settings);
  const problem = checkSettings(s, { hasSecret: !!secret });
  if (problem) return { error: problem };
  const message = composeMessage(event);
  if (!message.title) return { error: 'Nothing to say.' };
  const request = PROVIDERS[s.provider].build(s.target, secret || '', message);
  if (!request.url) return { error: 'That target is not somewhere Shellby can post.' };
  return { request, message };
}

/**
 * Actually send it. One attempt: a notification that arrives late is worse than
 * one that doesn't, and the next event will try again anyway.
 *   -> { ok: true } | { ok: false, error }
 */
async function deliver(request, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: ctrl.signal,
      redirect: 'error',       // a webhook that redirects is not one we follow
    });
    if (res.ok) {
      // Telegram says which message it made, which replies.js needs to take the
      // buttons off it later. Nobody else's reply is worth reading.
      let data;
      if (/^https:\/\/api\.telegram\.org\//.test(request.url) && typeof res.json === 'function') {
        try { data = await res.json(); } catch { /* no body */ }
      }
      return data ? { ok: true, data } : { ok: true };
    }
    // The body often says exactly what's wrong ("user key is invalid"), which is
    // worth showing; it can also be a megabyte of HTML, so it is capped.
    let detail = '';
    try { detail = clip(await res.text(), 160); } catch { /* no body */ }
    return { ok: false, error: `${res.status}${detail ? `: ${detail}` : ''}` };
  } catch (e) {
    return { ok: false, error: e?.name === 'AbortError' ? 'timed out' : clip(e?.message, 120) || 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Can Allow / Deny ride on these notifications? -> error string | null.
 * On ntfy, whoever can read the topic can press the buttons, so the topic has
 * to be one nobody will guess (like the one Shellby picks), or the server has
 * to want a token.
 */
function replyProblem(settings, { hasSecret = false } = {}) {
  const s = normalizeChannelSettings(settings);
  if (!REPLY_PROVIDERS.has(s.provider)) return `${PROVIDERS[s.provider]?.label || 'That'} can't carry an answer back. Telegram and ntfy can.`;
  if (s.provider === 'ntfy' && !hasSecret) {
    const topic = (ntfyUrl(s.target) || '').split('/').pop() || '';
    if (topic.length < 20) return 'Answering from the phone needs a topic nobody will guess (20 characters or more, like the one Shellby picks), or an access token.';
  }
  return null;
}

/** What the renderer is allowed to see: never the secret, only whether there is one. */
function view(settings, { hasSecret = false } = {}) {
  const s = normalizeChannelSettings(settings);
  return {
    ...s,
    hasSecret,
    problem: checkSettings(s, { hasSecret }),
    canReply: REPLY_PROVIDERS.has(s.provider),
    replyProblem: s.replies ? replyProblem(s, { hasSecret }) : null,
    // What a phone opens to subscribe; Settings shows it as a QR code.
    subscribeUrl: s.provider === 'ntfy' ? ntfyUrl(s.target) : null,
    providers: PROVIDER_NAMES.map(name => ({
      name,
      label: PROVIDERS[name].label,
      targetLabel: PROVIDERS[name].targetLabel,
      hint: PROVIDERS[name].hint,
      secret: PROVIDERS[name].secret,
      secretLabel: PROVIDERS[name].secretLabel || null,
      findsTarget: name === 'telegram',
    })),
    eventLabels: Object.fromEntries(EVENT_NAMES.map(e => [e, EVENTS[e].label])),
  };
}

module.exports = {
  PROVIDERS, PROVIDER_NAMES, EVENTS, EVENT_NAMES, PRIORITIES, CHANNEL_DEFAULTS,
  normalizeChannelSettings, checkSettings, shouldSend, composeMessage,
  buildRequest, deliver, view, ntfyUrl, ntfyReplyUrl, ntfyActions, telegramMarkup, localOrHttps, duration,
  randomTopic, chatFromUpdates, findTelegramChat, REPLY_PROVIDERS, replyProblem,
};
