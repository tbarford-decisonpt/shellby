// Starting a task from your phone.
//
// replies.js lets the phone press Allow or Deny on something Shellby is already
// doing. This lets it say what to do in the first place: a Telegram message to
// your bot, or a post to an ntfy topic beside yours, becomes a task in one of
// your projects.
//
// Everything that arrives here is untrusted text. It only ever becomes the
// words of a prompt: never a shell command, a snippet, a slash command, a mode
// or a setting. The task always runs in Ask first, so every edit and command
// still comes back to you as a permission prompt (to the phone's single-use
// buttons, or the desk).
//
// Pure: the wiring (wiring/phone-tasks.js) does the starting and the talking.
const crypto = require('crypto');
const path = require('path');
const { ntfyUrl, REPLY_PROVIDERS } = require('./channels');

const MAX_TEXT = 4000;                 // a task, not a document
const MAX_AGE_MS = 10 * 60 * 1000;     // older than this, it was meant for a PC that was off
const HOUR_MS = 60 * 60 * 1000;
const MAX_STARTS_PER_HOUR = 10;
const MAX_OPEN = 3;                    // phone tasks working (or waiting on you) at once
const MAX_MESSAGES_PER_HOUR = 60;      // anything past this is dropped unread
const TITLE_PREFIX = '📱';
const MODE = 'ask';                    // always: never Smart, Auto-edit, Plan-only or Autonomous
const PASS_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const PASS_GROUPS = 4;
const PASS_GROUP_LEN = 4;

// ------------------------------------------------------------------ text

// C0/C1 controls (newline and tab survive), bidi overrides and zero-width
// characters: what makes text read differently from what it says.
const CONTROL_RANGES = [[0x00, 0x08], [0x0b, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff]];
const esc = n => `\\u${n.toString(16).padStart(4, '0')}`;
const CONTROL = new RegExp(`[${CONTROL_RANGES.map(([a, b]) => `${esc(a)}-${esc(b)}`).join('')}]`, 'g');

/** Untrusted text -> plain text: no controls, LF line ends, trimmed. */
function cleanText(raw) {
  return String(raw ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, '').replace(/\t/g, '  ').trim();
}

// ------------------------------------------------------------------ who may start one

/** sha256, shortened: enough to tell two tokens apart, never enough to be one. */
const fingerprint = secret => (secret ? crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 16) : '');

/**
 * The destination a yes was given for: provider, chat or topic, and which
 * token. A different bot, chat or topic is a different key, so the yes no
 * longer counts and phone tasks are off until you say yes again.
 */
function consentKey(settings, secret) {
  return `${settings?.provider || ''}|${settings?.target || ''}|tasks|${fingerprint(secret)}`;
}

const isPrivateChatId = id => /^[1-9]\d{0,19}$/.test(String(id ?? ''));

/**
 * Why phone tasks can't be on with these settings, or null.
 *   settings: channels.normalizeChannelSettings(...)
 *   { hasSecret, confirmed (the channel's destination), hasFolder, canEncrypt }
 */
function tasksProblem(settings, { hasSecret = false, confirmed = false, hasFolder = false, canEncrypt = true } = {}) {
  if (!settings || !REPLY_PROVIDERS.has(settings.provider)) return 'Only Telegram and ntfy can start tasks.';
  if (!settings.enabled || !settings.target) return 'Turn on notifications to your phone first.';
  if (!confirmed) return 'Confirm where notifications go first.';
  if (settings.provider === 'telegram') {
    if (!hasSecret) return 'Telegram needs the bot token.';
    if (!isPrivateChatId(settings.target)) return 'Starting tasks needs your own private chat with the bot, not a group.';
  } else {
    const topic = (ntfyUrl(settings.target) || '').split('/').pop() || '';
    if (!hasSecret && topic.length < 20) return 'Starting tasks needs a topic nobody will guess (20 characters or more, like the one Shellby picks), or an access token.';
    if (!canEncrypt) return "Windows can't keep a passphrase safe on this PC, so ntfy can't start tasks.";
  }
  if (!hasFolder) return 'Pick the folder phone tasks go to first.';
  return null;
}

/** Where ntfy task messages are posted: a third topic beside yours, like -reply. */
function ntfyTasksUrl(target) {
  const url = ntfyUrl(target);
  if (!url) return null;
  const at = url.lastIndexOf('/');
  return `${url.slice(0, at + 1)}${url.slice(at + 1).slice(0, 58)}-tasks`;
}

/** A passphrase nobody will guess (~79 bits), easy to read off a screen: "k7mp-2qax-...". */
function newPassphrase(bytes = crypto.randomBytes(PASS_GROUPS * PASS_GROUP_LEN)) {
  const chars = [...bytes].map(b => PASS_ALPHABET[b % PASS_ALPHABET.length]).join('');
  return chars.match(new RegExp(`.{${PASS_GROUP_LEN}}`, 'g')).join('-');
}

const PASSPHRASE = /^[a-z2-9]{4}(?:-[a-z2-9]{4}){3}$/;

/** Constant-time: how long a wrong guess takes says nothing about how close it was. */
function samePassphrase(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const h = s => crypto.createHash('sha256').update(s).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

// ------------------------------------------------------------------ what arrived

/** Fresh enough to act on: after you turned it on, and from the last ten minutes. */
function fresh(atMs, { since = 0, now = Date.now() } = {}) {
  return Number.isFinite(atMs) && atMs >= since && now - atMs <= MAX_AGE_MS && atMs - now <= 60 * 1000;
}

/**
 * One Telegram update -> { text, at, messageId } | null.
 * Only a new message, typed by you, in your own private chat with the bot:
 * not an edit, a forward, a channel post, a bot, or anyone in a group.
 */
function parseTelegramMessage(update, chatId, { since = 0, now = Date.now() } = {}) {
  const m = update?.message;
  if (!m || typeof m !== 'object' || typeof m.text !== 'string') return null;
  if (!isPrivateChatId(chatId)) return null;
  if (m.chat?.type !== 'private' || String(m.chat?.id) !== String(chatId)) return null;
  if (!m.from || m.from.is_bot || String(m.from.id) !== String(chatId)) return null;
  // Forwarded: someone else's words, whoever pressed Forward.
  if (m.forward_origin || m.forward_from || m.forward_from_chat || m.forward_date || m.forward_sender_name) return null;
  if (m.via_bot || m.is_automatic_forward) return null;
  const at = Number(m.date) * 1000;
  if (!fresh(at, { since, now })) return null;
  return { text: m.text, at, messageId: Number.isSafeInteger(m.message_id) ? m.message_id : null };
}

/**
 * One line of ntfy's JSON stream from the tasks topic -> { text, at, id } | null.
 * Anyone who knows a topic can post to it, so a message only counts if it
 * starts with your passphrase. A wrong one is { refused: true }.
 */
function parseNtfyTask(msg, passphrase, { since = 0, now = Date.now() } = {}) {
  if (!msg || msg.event !== 'message' || typeof msg.message !== 'string') return null;
  const at = Number(msg.time) * 1000;
  if (!fresh(at, { since, now })) return null;
  const m = /^\s*(\S+)\s+([\s\S]*)$/.exec(msg.message);
  if (!m || !samePassphrase(m[1], passphrase)) return { refused: true };
  return { text: m[2], at, id: typeof msg.id === 'string' ? msg.id : null };
}

// ------------------------------------------------------------------ what it says

/**
 * Which project: exact name (any case), or the only one it starts.
 *   projects: [{ name, path }]
 *   -> { project } | { ambiguous: [names] } | { none: true }
 */
function matchProject(query, projects) {
  const q = cleanText(query).toLowerCase();
  if (!q) return { none: true };
  const list = Array.isArray(projects) ? projects.filter(p => p && typeof p.name === 'string') : [];
  const exact = list.filter(p => p.name.toLowerCase() === q);
  if (exact.length === 1) return { project: exact[0] };
  // Two clones with one name: tell them apart by the folder they sit in.
  if (exact.length > 1) return { ambiguous: exact.map(p => (p.path ? `${p.name} in ${path.basename(path.dirname(p.path))}` : p.name)) };
  const prefixed = list.filter(p => p.name.toLowerCase().startsWith(q));
  if (prefixed.length === 1) return { project: prefixed[0] };
  if (prefixed.length > 1) return { ambiguous: prefixed.map(p => p.name) };
  return { none: true };
}

const names = list => list.slice(0, 8).join(', ') + (list.length > 8 ? ', …' : '');

/**
 * A message from the phone -> what to do.
 *   { kind: 'help' } | { kind: 'status' }
 *   { kind: 'task', prompt, project }   project null: the default folder
 *   { kind: 'reply', reply }            nothing to start; say this back
 */
function parseCommand(raw, { projects = [] } = {}) {
  let text = cleanText(raw);
  if (!text) return { kind: 'reply', reply: 'Say what Shellby should do. Send /help for how.' };
  if (text.length > MAX_TEXT) return { kind: 'reply', reply: `That's too long for a task from the phone (${MAX_TEXT} characters at most).` };

  const cmd = /^\/([a-z]+)(?:@[A-Za-z0-9_]+)?(?=\s|$)\s*/i.exec(text);
  if (cmd) {
    const name = cmd[1].toLowerCase();
    if (name === 'help' || name === 'start') return { kind: 'help' };
    if (name === 'status') return { kind: 'status' };
    if (name !== 'task') return { kind: 'reply', reply: 'From the phone Shellby only knows /task, /status and /help.' };
    text = text.slice(cmd[0].length).trim();
    if (!text) return { kind: 'reply', reply: 'Say what Shellby should do after /task.' };
  }

  let project = null;
  const sel = /^in\s+([^:\n]{1,80}):\s*/i.exec(text) || /^@([^\s:]{1,80}):?\s+/.exec(text);
  if (sel) {
    const found = matchProject(sel[1], projects);
    if (found.ambiguous) return { kind: 'reply', reply: `"${sel[1].trim()}" could be ${names(found.ambiguous)}. Which one? Say more of its name.` };
    if (found.none) {
      const all = projects.map(p => p.name);
      return { kind: 'reply', reply: `Shellby doesn't know a project called "${sel[1].trim()}".${all.length ? ` Yours: ${names(all)}.` : ''}` };
    }
    project = found.project;
    text = text.slice(sel[0].length).trim();
  }

  if (!text) return { kind: 'reply', reply: 'Say what Shellby should do there too.' };
  // ! runs PowerShell in a Shellby tab, and a leading / is a Claude Code
  // command: neither is something a message from outside gets to do.
  if (text.split('\n').some(line => line.trimStart().startsWith('!'))) {
    return { kind: 'reply', reply: "Lines starting with ! run commands at the desk, so they can't come from the phone. Ask for it in words instead." };
  }
  if (text.startsWith('/')) return { kind: 'reply', reply: "Claude Code's / commands can't come from the phone. Ask for it in words instead." };
  return { kind: 'task', prompt: text, project };
}

// ------------------------------------------------------------------ how many

/** Starts from the last hour only. */
const recent = (times, now) => (Array.isArray(times) ? times.filter(t => Number.isFinite(t) && now - t < HOUR_MS && t <= now) : []);

/**
 * May another task start? -> { ok: true } | { ok: false, reply }.
 *   starts: when phone tasks started (ms); open: phone tasks still working or waiting on you
 */
function startGate({ starts = [], open = 0, now = Date.now() } = {}) {
  if (open >= MAX_OPEN) return { ok: false, reply: `${MAX_OPEN} tasks from your phone are already going. Let one finish first.` };
  const last = recent(starts, now);
  if (last.length >= MAX_STARTS_PER_HOUR) {
    const mins = Math.max(1, Math.ceil((Math.min(...last) + HOUR_MS - now) / 60000));
    return { ok: false, reply: `That's ${MAX_STARTS_PER_HOUR} tasks from your phone this hour, the most there can be. Try again in ${mins} minute${mins === 1 ? '' : 's'}.` };
  }
  return { ok: true };
}

/** Is this message one too many this hour? Past the cap, messages are dropped unanswered. */
function messageGate(seen = [], now = Date.now()) {
  return recent(seen, now).length < MAX_MESSAGES_PER_HOUR;
}

// ------------------------------------------------------------------ what goes back

/** "fix the flaky test" -> "📱 fix the flaky test", one line, short enough for a tab. */
function titleFor(prompt) {
  const line = String(prompt).split('\n').find(l => l.trim()) || 'Task from your phone';
  const t = line.trim().replace(/\s+/g, ' ');
  return `${TITLE_PREFIX} ${t.length > 50 ? `${t.slice(0, 49).trimEnd()}…` : t}`;
}

function helpReply({ provider, folderName, projects = [] } = {}) {
  const pass = provider === 'ntfy' ? 'Start each message with your passphrase, then a space. ' : '';
  return [
    `${pass}Send what Shellby should do, and he starts it${folderName ? ` in ${folderName}` : ''}.`,
    'Another project: "in <project>: <task>" or "@<project> <task>".',
    '/status: what\'s running and what\'s waiting for you.',
    'He always asks before he edits a file or runs a command, so keep an eye out for Allow and Deny.',
    projects.length ? `Projects: ${names(projects.map(p => p.name))}.` : '',
  ].filter(Boolean).join('\n');
}

/**
 * /status: titles and states only. Never a file, a diff, a command or a reply.
 *   tabs: [{ title, busy, waiting, fromPhone }]
 */
function statusReply(tabs = [], { held = 0 } = {}) {
  const list = Array.isArray(tabs) ? tabs : [];
  const line = t => `${t.waiting ? '✋' : '⏳'} ${cleanText(t.title).replace(/\s+/g, ' ').slice(0, 60)}${t.waiting ? ': waiting for you' : ''}`;
  const going = list.filter(t => t.busy || t.waiting);
  const out = going.length ? going.slice(0, 8).map(line) : ['Nothing running. Shellby is free.'];
  if (going.length > 8) out.push(`…and ${going.length - 8} more.`);
  if (held > 0) out.push(`🌙 ${held} queued for after the usage reset.`);
  return out.join('\n');
}

module.exports = {
  MAX_TEXT, MAX_AGE_MS, MAX_STARTS_PER_HOUR, MAX_OPEN, MAX_MESSAGES_PER_HOUR, TITLE_PREFIX, MODE, PASSPHRASE,
  cleanText, consentKey, fingerprint, isPrivateChatId, tasksProblem, ntfyTasksUrl, newPassphrase, samePassphrase,
  fresh, parseTelegramMessage, parseNtfyTask, matchProject, parseCommand, startGate, messageGate, recent,
  titleFor, helpReply, statusReply,
};
