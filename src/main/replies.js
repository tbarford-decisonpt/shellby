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
// no polling.
const crypto = require('crypto');
const { ntfyReplyUrl } = require('./channels');

const TTL_MS = 30 * 60 * 1000;     // a prompt left this long is the desk's again
const NTFY_POLL_MS = 5000;         // ntfy.sh allows a request every 5s per visitor, sustained
const TELEGRAM_LONGPOLL_S = 25;    // Telegram holds the request open until a press or this
const REQUEST_TIMEOUT_MS = 8000;
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
  constructor({ getChannel, onAnswer, log = () => {}, fetchImpl = fetch, now = Date.now, ntfyPollMs = NTFY_POLL_MS }) {
    Object.assign(this, { getChannel, onAnswer, log, fetchImpl, now, ntfyPollMs });
    this.open = new Map();      // nonce -> { tabId, requestId, expiresAt, provider, messageId?, text? }
    this.polling = false;
    this.abort = null;
    this.telegramOffset = null;
    this.ntfySince = null;
  }

  get size() { return this.open.size; }

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
    if (this.polling || !this.open.size) return;
    this.polling = true;
    this.loop().catch(err => this.log(`polling stopped: ${err.message}`)).finally(() => { this.polling = false; });
  }

  stop() {
    this.abort?.abort();
    this.abort = null;
    if (!this.open.size) this.ntfySince = null;
  }

  async loop() {
    while (this.open.size) {
      this.expire();
      if (!this.open.size) break;
      const { settings, secret } = this.getChannel();
      if (!settings?.enabled || !settings.replies || !supportsReplies(settings.provider)) {
        // Turned off (or switched provider) with prompts out: they're the desk's now.
        for (const [nonce, e] of this.open) { this.open.delete(nonce); this.markTelegram(e, 'Answer it at the desk'); }
        break;
      }
      const started = this.now();
      try {
        if (settings.provider === 'telegram') await this.pollTelegram(settings.target, secret);
        else await this.pollNtfy(settings.target, secret);
      } catch (err) {
        if (err?.name !== 'AbortError') this.log(err.message);
      }
      // Never spin: a failing network waits like a quiet one does. (Telegram's
      // long poll has usually used the whole interval up by itself.)
      const rest = this.ntfyPollMs - (this.now() - started);
      if (this.open.size) await new Promise(r => setTimeout(r, Math.max(0, rest)));
    }
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

  async pollTelegram(chatId, token) {
    if (!token) return;
    const q = new URLSearchParams({ timeout: String(TELEGRAM_LONGPOLL_S) });
    if (this.telegramOffset != null) q.set('offset', String(this.telegramOffset));
    const res = await this.get(`https://api.telegram.org/bot${encodeURIComponent(token)}/getUpdates?${q}`, { timeoutMs: (TELEGRAM_LONGPOLL_S + 10) * 1000 });
    const reply = await res.json().catch(() => null);
    if (!reply?.ok || !Array.isArray(reply.result)) return;
    for (const update of reply.result) {
      if (Number.isSafeInteger(update?.update_id)) this.telegramOffset = Math.max(this.telegramOffset ?? 0, update.update_id + 1);
      const press = parseTelegramCallback(update, chatId);
      if (!press) continue;
      const said = this.answer(press.nonce, press.decision);
      this.telegram(token, 'answerCallbackQuery', { callback_query_id: press.callbackId, text: said });
    }
  }

  async pollNtfy(target, secret) {
    const url = ntfyReplyUrl(target);
    if (!url) return;
    const q = new URLSearchParams({ poll: '1', since: this.ntfySince || 'all' });
    const res = await this.get(`${url}/json?${q}`, { headers: secret ? { Authorization: `Bearer ${secret}` } : {} });
    if (!res.ok) return;
    const text = await res.text();
    for (const line of text.split('\n')) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (typeof msg?.id === 'string' && /^[A-Za-z0-9]{1,32}$/.test(msg.id)) this.ntfySince = msg.id;
      const press = parseNtfyMessage(msg);
      if (press) this.answer(press.nonce, press.decision);
    }
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
  parseNtfyMessage, parseTelegramCallback, NONCE, TTL_MS, PHONE_MAX,
};
