// Answering him from your phone.
//
// channels.js only ever talked outwards: "Shellby needs you" reached your
// pocket, and then you had to walk back to the desk to press Allow. This is
// the other half, for the two providers that can carry a button back without a
// server of ours in the middle:
//
//   Telegram: inline Allow / Deny buttons. Pressing one is a callback_query the
//             bot can read with getUpdates.
//   ntfy:     action buttons that POST "allow:<nonce>" to a second topic next
//             to yours (<topic>-reply), which Shellby reads back.
//
// Every prompt gets its own unguessable, single-use nonce that expires, and
// only Allow and Deny travel this way. "Always allow" (which rewrites Claude
// Code's settings), questions that need typing, plans worth reading in full,
// and anything already flagged on the desktop card stay at the desk.
//
// Shellby only listens while something is actually waiting: no prompts out,
// no polling. The one exception is phone tasks (phone-tasks.js), which you turn
// on to be heard while you're away: then this same poller also reads messages.
// A bot has one getUpdates queue, and two readers would each confirm (and so
// eat) the other's updates, so there is only ever one, and it hands presses
// to the prompts here and messages to the inbox.
const crypto = require('crypto');
const { ntfyReplyUrl } = require('./channels');

const TTL_MS = 30 * 60 * 1000;     // a prompt left this long is the desk's again
const NTFY_POLL_MS = 5000;         // ntfy.sh allows a request every 5s per visitor, sustained
const INBOX_POLL_MS = 15000;       // only listening for tasks: no need to ask as often
const TELEGRAM_LONGPOLL_S = 25;    // Telegram holds the request open until a press or this
const REQUEST_TIMEOUT_MS = 8000;
const MAX_BACKOFF_MS = 5 * 60 * 1000; // failing over and over: ask at most this rarely
const NONCE = /^[A-Za-z0-9_-]{22}$/;
const REPLY_PROVIDERS = new Set(['telegram', 'ntfy']);
const VERDICT = { allow: 'Allowed', deny: 'Denied', always: 'Always allowed', cancelled: 'No longer waiting' };

const supportsReplies = provider => REPLY_PROVIDERS.has(provider);

/** 128 random bits as 22 URL-safe characters: fits Telegram's 64-byte callback_data with room to spare. */
function newNonce(bytes = crypto.randomBytes(16)) {
  return Buffer.from(bytes).toString('base64url');
}

/**
 * Why this prompt has to be answered at the desk, or null if the phone may.
 * The same things the desktop card goes out of its way to flag.
 */
// Past this, the notification can't show the whole command, and nobody should
// approve the half they can see.
const PHONE_MAX = 300;

function deskOnlyReason(item) {
  if (!item || typeof item !== 'object') return 'Answer it at the desk.';
  const full = String(item.input?.command ?? item.input?.file_path ?? item.detail ?? '');
  if (full.length > PHONE_MAX || String(item.detail || '').length >= 400) return 'It is too long to read on a phone: check it at the desk.';
  if (item.toolName === 'AskUserQuestion') return 'It has a question for you: answer it at the desk.';
  if (item.toolName === 'ExitPlanMode') return 'It has a plan for you to read: approve it at the desk.';
  if (item.runsCreated?.length) return 'It runs a file Claude wrote this session: check it at the desk.';
  if (item.selfConfig) return `It changes ${item.selfConfig}: check it at the desk.`;
  return null;
}

/** One line of ntfy's JSON stream -> { nonce, decision } | null. */
function parseNtfyMessage(msg) {
  if (!msg || msg.event !== 'message' || typeof msg.message !== 'string') return null;
  const m = /^(allow|deny):([A-Za-z0-9_-]{22})$/.exec(msg.message.trim());
  return m ? { decision: m[1], nonce: m[2] } : null;
}

/**
 * One Telegram update -> { nonce, decision, callbackId, messageId } | null.
 * Only presses in the chat Shellby was set up with count: a bot can be added
 * to other chats, and a button forwarded there must not answer anything.
 */
function parseTelegramCallback(update, chatId) {
  const cq = update?.callback_query;
  if (!cq || typeof cq.data !== 'string' || !cq.message) return null;
  if (String(cq.message.chat?.id) !== String(chatId)) return null;
  // In a group, anyone in it could press Allow on your PC. Only your own chat with the bot counts.
  if (cq.message.chat?.type !== 'private' || String(cq.from?.id) !== String(chatId)) return null;
  const m = /^([ad]):([A-Za-z0-9_-]{22})$/.exec(cq.data);
  if (!m) return null;
  return { decision: m[1] === 'a' ? 'allow' : 'deny', nonce: m[2], callbackId: String(cq.id), messageId: cq.message.message_id };
}

/**
 * The prompts waiting on your phone, and the polling that hears the answers.
 *   getChannel(): { settings, secret } -- read fresh, so a changed token is picked up
 *   onAnswer(tabId, requestId, decision): true if the prompt was still open
 */
class RemoteAnswers {
  constructor({ getChannel, onAnswer, log = () => {}, fetchImpl = fetch, now = Date.now, ntfyPollMs = NTFY_POLL_MS, inboxPollMs = INBOX_POLL_MS, maxBackoffMs = MAX_BACKOFF_MS }) {
    Object.assign(this, { getChannel, onAnswer, log, fetchImpl, now, ntfyPollMs, inboxPollMs, maxBackoffMs });
    this.open = new Map();      // nonce -> { tabId, requestId, expiresAt, provider, messageId?, text? }
    this.polling = false;
    this.abort = null;
    this.telegramOffset = null;
    this.ntfySince = null;
    this.inbox = null;
    this.closed = false;
    this.wakeSleep = null;
    this.failures = 0;          // polls in a row that failed, for the back-off
    this.problem = null;        // { text, token }: what Telegram said, for Settings
    this.refused = null;        // a bot token Telegram turned down: never asked with again
  }

  get size() { return this.open.size; }

  /** What's stopping answers (or tasks) getting through, in words, or null. */
  trouble() {
    const { settings, secret } = this.getChannel() || {};
    if (!this.problem || settings?.provider !== 'telegram' || this.problem.token !== secret) return null;
    return this.problem.text;
  }

  /**
   * Phone tasks: messages as well as presses.
   *   inbox: {
   *     active() -> bool                 on, for this destination, right now
   *     onTelegram(update)               every Telegram update that isn't a button press
   *     ntfyUrl() -> url | null          the tasks topic
   *     ntfySince() -> id | seconds      where to read from (persisted, so a restart doesn't replay)
   *     onNtfy(msg), onNtfyCursor(id)    each message, then the last id read
   *   }
   */
  setInbox(inbox) {
    this.inbox = inbox || null;
    this.listen();
  }

  inboxOn() {
    if (this.closed || !this.inbox) return false;
    try { return !!this.inbox.active(); } catch (err) { this.log(`inbox: ${err.message}`); return false; }
  }

  /** Something to listen for: a prompt out, or phone tasks on. */
  wanted() { return !this.closed && (this.open.size > 0 || this.inboxOn()); }

  /**
   * Start listening if there's anything to hear (after phone tasks are turned
   * on, say). Settings changed, perhaps to fix what was failing: no back-off.
   */
  listen() {
    if (this.failures) { this.failures = 0; this.wakeSleep?.(); }
    this.ensurePolling();
  }

  /** Shellby is quitting: stop for good, mid-request or mid-wait. */
  shutdown() {
    this.closed = true;
    this.abort?.abort();
    this.abort = null;
    this.wakeSleep?.();
  }

  /** A prompt is about to go out with buttons. -> the nonce to put on them. */
  register({ tabId, requestId, provider }) {
    const nonce = newNonce();
    this.open.set(nonce, { tabId, requestId, provider, expiresAt: this.now() + TTL_MS });
    // ntfy: only messages published from now on can be answers to this.
    if (provider === 'ntfy' && !this.ntfySince) this.ntfySince = String(Math.floor(this.now() / 1000) - 5);
    return nonce;
  }

  /** It went out: remember what Telegram called the message, to edit it later. */
  sent(nonce, { data, text } = {}) {
    const e = this.open.get(nonce);
    if (!e) return;
    if (Number.isSafeInteger(data?.result?.message_id)) e.messageId = data.result.message_id;
    if (text) e.text = String(text).slice(0, 900);
    this.ensurePolling();
  }

  /** It never went out (held back, or the send failed). */
  forget(nonce) {
    this.open.delete(nonce);
    if (!this.open.size) this.stop();
  }

  /** Answered at the desk, or cancelled: take the buttons off the phone too. */
  settle(requestId, decision) {
    for (const [nonce, e] of this.open) {
      if (e.requestId !== requestId) continue;
      this.open.delete(nonce);
      this.markTelegram(e, `${VERDICT[decision] || 'Answered'} at the desk`);
    }
    if (!this.open.size) this.stop();
  }

  /** A tab closed: none of its prompts can be answered any more. */
  settleTab(tabId) {
    for (const [nonce, e] of this.open) {
      if (e.tabId !== tabId) continue;
      this.open.delete(nonce);
      this.markTelegram(e, VERDICT.cancelled);
    }
    if (!this.open.size) this.stop();
  }

  /** An answer arrived from the phone. -> what it did, for the callback toast. */
  answer(nonce, decision) {
    const e = this.open.get(nonce);
    if (!e) return 'That one was already answered.';
    this.open.delete(nonce);
    if (!this.open.size) this.stop();
    if (e.expiresAt < this.now()) {
      this.markTelegram(e, 'Expired: answer it at the desk');
      return 'That one expired. Answer it at the desk.';
    }
    let ok = false;
    try { ok = !!this.onAnswer(e.tabId, e.requestId, decision); } catch (err) { this.log(`answer failed: ${err.message}`); }
    if (!ok) {
      this.markTelegram(e, VERDICT.cancelled);
      return 'It was no longer waiting.';
    }
    this.markTelegram(e, `${VERDICT[decision]} from your phone`);
    return VERDICT[decision];
  }

  expire() {
    const t = this.now();
    for (const [nonce, e] of this.open) {
      if (e.expiresAt >= t) continue;
      this.open.delete(nonce);
      this.markTelegram(e, 'Expired: answer it at the desk');
    }
  }

  // ---------------------------------------------------------------- listening

  ensurePolling() {
    if (this.polling || !this.wanted()) return;
    this.polling = true;
    this.loop().catch(err => this.log(`polling stopped: ${err.message}`)).finally(() => { this.polling = false; });
  }

  /** Nothing left to answer. Phone tasks on: the listening carries on regardless. */
  stop() {
    if (!this.open.size) this.ntfySince = null;
    if (this.inboxOn()) return;
    this.abort?.abort();
    this.abort = null;
  }

  async loop() {
    while (this.wanted()) {
      this.expire();
      const { settings, secret } = this.getChannel();
      if (this.open.size && (!settings?.enabled || !settings.replies || !supportsReplies(settings.provider))) {
        // Turned off (or switched provider) with prompts out: they're the desk's now.
        for (const [nonce, e] of this.open) { this.open.delete(nonce); this.markTelegram(e, 'Answer it at the desk'); }
      }
      const listening = this.inboxOn();
      if (!this.open.size && !listening) break;
      // Telegram turned this token down: asking again won't change its mind.
      // A new token (listen(), from Settings) starts it again.
      if (settings.provider === 'telegram' && secret && secret === this.refused) break;
      const started = this.now();
      let ok = true;
      try {
        if (settings.provider === 'telegram') ok = await this.pollTelegram(settings.target, secret);
        else if (settings.provider === 'ntfy') {
          if (this.open.size) ok = await this.pollNtfy(settings.target, secret);
          if (listening && !this.closed) ok = (await this.pollNtfyTasks(secret)) && ok;
        }
      } catch (err) {
        if (err?.name !== 'AbortError') { this.log(err.message); ok = false; }
      }
      this.failures = ok === false ? this.failures + 1 : 0;
      // Never spin: a failing network waits like a quiet one does. (Telegram's
      // long poll has usually used the whole interval up by itself.)
      // ntfy with both topics read: twice the wait, to stay inside its rate limit.
      // Failing again and again: twice as long each time, up to five minutes.
      const normal = settings.provider === 'telegram' ? this.ntfyPollMs
        : this.open.size ? this.ntfyPollMs * (listening ? 2 : 1) : this.inboxPollMs;
      const every = this.failures ? Math.max(normal, Math.min(this.maxBackoffMs, this.ntfyPollMs * 2 ** (this.failures - 1))) : normal;
      const rest = every - (this.now() - started);
      if (this.wanted()) await this.sleep(Math.max(0, rest));
    }
  }

  sleep(ms) {
    return new Promise(resolve => {
      const timer = setTimeout(done, ms);
      function done() { clearTimeout(timer); resolve(); }
      this.wakeSleep = done;
    }).finally(() => { this.wakeSleep = null; });
  }

  async get(url, { headers = {}, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    const ctrl = new AbortController();
    this.abort = ctrl;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await this.fetchImpl(url, { headers, signal: ctrl.signal, redirect: 'error' });
    } finally {
      clearTimeout(timer);
      if (this.abort === ctrl) this.abort = null;
    }
  }

  /** One getUpdates. -> false when it failed (for the back-off), else true. */
  async pollTelegram(chatId, token) {
    if (!token) return true;
    const q = new URLSearchParams({ timeout: String(TELEGRAM_LONGPOLL_S) });
    if (this.telegramOffset != null) q.set('offset', String(this.telegramOffset));
    const res = await this.get(`https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates?${q}`, { timeoutMs: (TELEGRAM_LONGPOLL_S + 10) * 1000 });
    const reply = await res.json().catch(() => null);
    if (!reply?.ok || !Array.isArray(reply.result)) {
      this.telegramTrouble(reply, token);
      return false;
    }
    this.problem = null;
    const listening = this.inboxOn();
    for (const update of reply.result) {
      if (Number.isSafeInteger(update?.update_id)) this.telegramOffset = Math.max(this.telegramOffset ?? 0, update.update_id + 1);
      const press = parseTelegramCallback(update, chatId);
      if (!press) {
        // Not a press: a message, perhaps a task (phone-tasks.js decides). With
        // phone tasks off it is skipped, but still confirmed above.
        if (listening && !update?.callback_query) this.handOver(() => this.inbox.onTelegram(update));
        continue;
      }
      const said = this.answer(press.nonce, press.decision);
      this.telegram(token, 'answerCallbackQuery', { callback_query_id: press.callbackId, text: said });
    }
  }

  // What Telegram said when it said no. 401 (or 404, a token that isn't one):
  // the token is dead, so stop. 409: someone else reads this bot's updates, and
  // the two would eat each other's; keep trying, more slowly.
  telegramTrouble(reply, token) {
    const code = reply?.error_code;
    if (code === 401 || code === 404) {
      this.refused = token;
      this.problem = { text: 'Telegram turned down the bot token. Paste it again, or make a new one with @BotFather.', token };
    } else if (code === 409) {
      this.problem = { text: 'Another Shellby (or app) is reading this bot, so answers and tasks from your phone can go missing. Close it, or give this one its own bot.', token };
    }
    if (code) this.log(`telegram: ${code}${reply.description ? ` ${String(reply.description).slice(0, 120)}` : ''}`);
  }

  // The inbox's own failures are its own: they never stop the presses being read.
  handOver(fn) {
    try { fn(); } catch (err) { this.log(`inbox: ${err.message}`); }
  }

  async pollNtfyTasks(secret) {
    const url = this.inbox.ntfyUrl();
    if (!url) return true;
    const q = new URLSearchParams({ poll: '1', since: String(this.inbox.ntfySince() || 'all') });
    const res = await this.get(`${url}/json?${q}`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
    if (!res.ok) return false;
    const text = await res.text();
    let last = null;
    for (const line of text.split('\n')) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg?.id === 'string' && /^[A-Za-z0-9]{1,32}$/.test(msg.id)) last = msg.id;
      this.handOver(() => this.inbox.onNtfy(msg));
    }
    if (last) this.handOver(() => this.inbox.onNtfyCursor(last));
    return true;
  }

  async pollNtfy(target, secret) {
    const url = ntfyReplyUrl(target);
    if (!url) return true;
    const q = new URLSearchParams({ poll: '1', since: this.ntfySince || 'all' });
    const res = await this.get(`${url}/json?${q}`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
    if (!res.ok) return false;
    const text = await res.text();
    for (const line of text.split('\n')) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg?.id === 'string' && /^[A-Za-z0-9]{1,32}$/.test(msg.id)) this.ntfySince = msg.id;
      const press = parseNtfyMessage(msg);
      if (press) this.answer(press.nonce, press.decision);
    }
    return true;
  }

  // ---------------------------------------------------------------- telling the phone

  markTelegram(entry, verdict) {
    if (entry.provider !== 'telegram' || !entry.messageId) return;
    const { settings, secret } = this.getChannel();
    if (settings?.provider !== 'telegram' || !secret) return;
    // Plain text on purpose: the original was MarkdownV2, and re-escaping it is
    // more ways to have Telegram refuse the edit than it is worth.
    this.telegram(secret, 'editMessageText', {
      chat_id: settings.target, message_id: entry.messageId,
      text: `${entry.text || 'Shellby asked for permission'}\n\n→ ${verdict}`,
      reply_markup: { inline_keyboard: [] },
    });
  }

  telegram(token, method, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    this.fetchImpl(`https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal, redirect: 'error',
    }).catch(err => this.log(`${method}: ${err.message}`)).finally(() => clearTimeout(timer));
  }
}

module.exports = {
  RemoteAnswers, supportsReplies, newNonce, deskOnlyReason,
  parseNtfyMessage, parseTelegramCallback, NONCE, TTL_MS, PHONE_MAX, INBOX_POLL_MS, MAX_BACKOFF_MS,
};
