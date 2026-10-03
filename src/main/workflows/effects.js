// The real side effects behind a workflow run: a Claude turn in a Shellby
// tab, a web request, a file, a timer. engine.js only ever sees these through
// the effects object the service builds per run, so everything here stays
// small, bounded and stoppable (every one honours the AbortSignal).
const fs = require('fs');
const path = require('path');

const MAX_READ = 1024 * 1024;        // a file step reads at most 1 MB
const MAX_RESPONSE = 1024 * 1024;    // and a web request keeps at most 1 MB of the answer
const MAX_REDIRECTS = 5;

const abortError = () => Object.assign(new Error('Stopped.'), { name: 'AbortError' });

/** Abortable sleep. setTimeout caps out at ~24.8 days; waits are at most 7. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, Math.max(0, ms));
    function onAbort() { clearTimeout(t); reject(abortError()); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A rendered path a step wants to read or write -> the path, or throws. Full
 * paths only, and never a network share or a device path: opening one makes
 * Windows sign in to that machine.
 */
function safePath(p) {
  const s = String(p ?? '').trim();
  if (!s || s.includes('\0') || s.length > 1024) throw new Error('That isn\'t a file path.');
  if (/^[\\/]{2}/.test(s)) throw new Error('Network and device paths aren\'t allowed.');
  if (!path.isAbsolute(s)) throw new Error(`“${s.slice(0, 80)}” isn't a full path.`);
  return path.normalize(s);
}

async function readFile(p, signal) {
  const file = safePath(p);
  const st = await fs.promises.stat(file).catch(() => null);
  if (!st || !st.isFile()) throw new Error(`There's no file at ${file}`);
  if (st.size > MAX_READ) throw new Error(`${path.basename(file)} is over 1 MB, too big to read into a workflow.`);
  if (signal?.aborted) throw abortError();
  return fs.promises.readFile(file, 'utf8');
}

async function writeFile(p, content, { append = false, signal } = {}) {
  const file = safePath(p);
  const dir = path.dirname(file);
  const st = await fs.promises.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error(`The folder ${dir} doesn't exist.`);
  if (signal?.aborted) throw abortError();
  await (append ? fs.promises.appendFile(file, content) : fs.promises.writeFile(file, content));
}

/** A bounded web request. -> { status, body } */
async function http({ method, url, headers = {}, body, timeoutMs = 60000, signal, fetchImpl = fetch }) {
  let u;
  try { u = new URL(url); } catch { throw new Error('That isn\'t a web address.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http:// and https:// addresses can be called.');
  const timeout = AbortSignal.timeout(timeoutMs);
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = u.href;
  let res;
  let hopMethod = method;
  let hopBody = method === 'GET' || method === 'HEAD' ? undefined : body;
  let hopHeaders = { ...headers };
  try {
    // Redirects are followed by hand, so every hop is checked: still the web,
    // never down from https to http, and a hop to another site loses the
    // headers, which may carry a secret meant for the first one.
    for (let hop = 0; ; hop++) {
      res = await fetchImpl(current, { method: hopMethod, headers: hopHeaders, body: hopBody, signal: both, redirect: 'manual' });
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (!loc) break;
      if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects.');
      const from = new URL(current);
      const next = new URL(loc, current);
      if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new Error('It redirected somewhere that isn\'t a web address.');
      if (from.protocol === 'https:' && next.protocol === 'http:') throw new Error('It redirected from https to plain http, so Shellby stopped.');
      if (next.origin !== from.origin) hopHeaders = {};
      // As browsers do: 303 always, and 301/302 for a POST, carry on as a GET with no body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && hopMethod === 'POST')) {
        hopMethod = hopMethod === 'HEAD' ? 'HEAD' : 'GET';
        hopBody = undefined;
      }
      current = next.href;
    }
  } catch (e) {
    if (signal?.aborted) throw abortError();
    if (timeout.aborted) throw new Error(`No answer within ${Math.round(timeoutMs / 1000)} seconds.`, { cause: e });
    throw new Error(`The request didn't go through: ${whyFailed(e)}`, { cause: e });
  }
  return { status: res.status, body: await readCapped(res) };
}

// fetch says only "fetch failed"; the reason is a code a level or two down.
const NET_REASONS = {
  ECONNREFUSED: 'nothing is answering at that address',
  ENOTFOUND: 'that site couldn\'t be found',
  EAI_AGAIN: 'that site couldn\'t be found (is the PC online?)',
  ECONNRESET: 'the connection was cut off',
  ETIMEDOUT: 'it took too long to connect',
  UND_ERR_CONNECT_TIMEOUT: 'it took too long to connect',
  CERT_HAS_EXPIRED: 'its certificate has expired',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'its certificate isn\'t trusted',
  SELF_SIGNED_CERT_IN_CHAIN: 'its certificate isn\'t trusted',
  ERR_TLS_CERT_ALTNAME_INVALID: 'its certificate is for a different site',
};
function whyFailed(e) {
  const code = e?.cause?.code || e?.cause?.errors?.[0]?.code || e?.cause?.cause?.code || e?.code;
  return NET_REASONS[code] || code || e?.cause?.message || e?.message || 'unknown';
}

async function readCapped(res) {
  if (!res.body?.getReader) return (await res.text()).slice(0, MAX_RESPONSE);
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_RESPONSE) { chunks.push(value.slice(0, value.length - (size - MAX_RESPONSE))); reader.cancel().catch(() => {}); break; }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8');
}

/**
 * One Claude turn in a tab, from send to result. -> { ok, reply, text, tabId, error }
 * `reply` is Claude's last message of the turn, `text` all of them (the
 * structured block may be in either). Stopping interrupts the turn.
 */
function claudeTurn(manager, tabId, prompt, userItem, signal) {
  return new Promise((resolve, reject) => {
    const texts = [];
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      manager.off('item', onItem);
      signal?.removeEventListener('abort', onAbort);
      resolve(value);
    };
    function onItem(id, item) {
      if (id !== tabId) return;
      if (item.kind === 'text' && !item.sub) texts.push(item.text);
      if (item.kind === 'result') {
        finish({
          ok: !!item.ok && !item.interrupted, tabId,
          reply: texts[texts.length - 1] || '', text: texts.join('\n\n'),
          error: item.interrupted ? 'Stopped.' : item.error || null,
        });
      }
      // The process died mid-turn: there's an error item and no result.
      if (item.kind === 'error') setImmediate(() => { if (!manager.isBusy(tabId)) finish({ ok: false, tabId, reply: '', text: '', error: item.text || 'Claude Code stopped.' }); });
    }
    function onAbort() { manager.interrupt(tabId); }
    if (signal?.aborted) { reject(abortError()); return; }
    manager.on('item', onItem);
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      manager.send(tabId, prompt, userItem);
    } catch (e) {
      finish({ ok: false, tabId, reply: '', text: '', error: e.message });
    }
  });
}

module.exports = { sleep, safePath, readFile, writeFile, http, claudeTurn, abortError, MAX_READ, MAX_RESPONSE };
