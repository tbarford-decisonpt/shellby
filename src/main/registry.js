// The community pack registry: a static site (GitHub Pages) that lists
// reviewed wardrobe packs, plus the shellby:// deep links its "Add to Shellby"
// buttons use.
//
// Trust model: a deep link carries ONLY a pack id. Everything else (where to
// download from, what the bytes must hash to) comes from the registry index,
// which is only ever fetched from REGISTRY_URL. A pack is accepted only if its
// URL lives under that same base and its bytes match the index's sha256.
// Nothing here throws, installs or touches the disk: main.js still validates the
// pack and asks for native confirmation before anything is installed.
//
// Pure (no Electron) so it's unit-tested; fetch is injectable.
const crypto = require('crypto');

const REGISTRY_URL = 'https://x-salmon.github.io/shellby-packs/';
const PROTOCOL = 'shellby';
const PACK_ID_RE = /^[a-z0-9][a-z0-9-]{1,39}$/; // same rule as wardrobe/catalog.js
const SHA256_RE = /^[0-9a-f]{64}$/;
const INDEX_FORMAT = 1;
const MAX_LINK_CHARS = 2048;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------ deep links

/**
 * Parse a shellby:// link. Accepts shellby://install?pack=<id> and
 * shellby:install?pack=<id> (any scheme case, optional trailing slashes).
 * Other query params are ignored; any URL or path in the link is never used.
 * @returns {{ action: 'install', packId: string } | null}
 */
function parseDeepLink(url) {
  if (typeof url !== 'string' || url.length > MAX_LINK_CHARS) return null;
  let u;
  try { u = new URL(url.trim()); } catch { return null; }
  if (u.protocol !== `${PROTOCOL}:`) return null; // URL lowercases the scheme
  if (u.username || u.password || u.port) return null;

  // shellby://install/  -> host "install", path "" or "/"
  // shellby:install     -> no host, path "install"
  let action;
  if (u.host) {
    if (!/^\/*$/.test(u.pathname)) return null; // e.g. shellby://install/../x
    action = u.host;
  } else {
    action = u.pathname.replace(/\/+$/, '');
  }
  if (action.toLowerCase() !== 'install') return null;

  const ids = u.searchParams.getAll('pack');
  if (ids.length !== 1 || !PACK_ID_RE.test(ids[0])) return null;
  return { action: 'install', packId: ids[0] };
}

/** First argv entry that looks like a shellby: link (Windows passes it as an argument). */
function findDeepLink(argv) {
  if (!Array.isArray(argv)) return null;
  const hit = argv.find(a => typeof a === 'string' && a.slice(0, PROTOCOL.length + 1).toLowerCase() === `${PROTOCOL}:`);
  return hit || null;
}

// ------------------------------------------------------------ fetching

// Normalize the base so prefix checks are exact ("…/shellby-packs/").
function normalizeBase(baseUrl) {
  try {
    const b = new URL(baseUrl);
    if (!['https:', 'http:'].includes(b.protocol) || b.username || b.password) return null;
    b.search = '';
    b.hash = '';
    if (!b.pathname.endsWith('/')) b.pathname += '/';
    return b;
  } catch { return null; }
}

// True if `url` is on the base's origin and under its path. URL parsing already
// resolves "..", "%2e%2e" and friends, so a sneaky path can't climb out after the check.
function isUnderBase(url, base) {
  if (typeof url !== 'string' || url.length > MAX_LINK_CHARS) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.username || u.password) return false;
  if (u.origin !== base.origin) return false;
  if (/%2f|%5c/i.test(u.pathname)) return false; // encoded slashes: the server might decode them
  return u.pathname.startsWith(base.pathname) && u.pathname.length > base.pathname.length;
}

class FetchError extends Error {}

// GET a URL with a timeout and a hard byte cap enforced while streaming
// (content-length is only a hint and is never trusted). Returns a Buffer.
async function fetchBytes(url, { fetchImpl, maxBytes, timeoutMs, base, what }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let res;
    try {
      res = await fetchImpl(url, { signal: ctrl.signal, redirect: 'follow', cache: 'no-store', headers: { accept: 'application/json' } });
    } catch {
      throw new FetchError(ctrl.signal.aborted
        ? 'The Shellby community registry took too long to respond. Try again in a moment.'
        : "Couldn't reach the Shellby community registry. Check your internet connection and try again.");
    }
    // A redirect must not carry us off the registry.
    if (res.url && !isUnderBase(res.url, base)) throw new FetchError(`The ${what} redirected somewhere outside the Shellby community registry, so it was not downloaded.`);
    if (!res.ok) {
      throw new FetchError(res.status === 404
        ? `The ${what} wasn't found on the Shellby community registry (404).`
        : `The Shellby community registry answered with an error (HTTP ${res.status}). Try again later.`);
    }
    const tooBig = () => new FetchError(`The ${what} is too big (max ${Math.round(maxBytes / 1024)} KB), so it was not downloaded.`);
    const declared = Number(res.headers?.get?.('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) throw tooBig();

    const chunks = [];
    let total = 0;
    try {
      if (res.body && typeof res.body.getReader === 'function') {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > maxBytes) {
            try { reader.cancel().catch(() => {}); } catch { /* ignore */ }
            ctrl.abort();
            throw tooBig();
          }
          chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        }
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > maxBytes) throw tooBig();
        chunks.push(buf);
        total = buf.length;
      }
    } catch (e) {
      if (e instanceof FetchError) throw e;
      throw new FetchError(ctrl.signal.aborted
        ? 'The Shellby community registry took too long to respond. Try again in a moment.'
        : `The ${what} download was interrupted. Try again.`);
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Look a pack up in the registry index, download it, and verify it against the
 * index's sha256. Never throws.
 * @returns {Promise<{ ok: boolean, entry?: object, text?: string, errors: string[] }>}
 */
async function fetchRegistryPack(packId, { baseUrl = REGISTRY_URL, fetchImpl = globalThis.fetch, maxBytes = 512 * 1024, timeoutMs = 15000 } = {}) {
  const fail = msg => ({ ok: false, errors: [msg] });
  if (typeof packId !== 'string' || !PACK_ID_RE.test(packId)) return fail("That isn't a valid Shellby pack id.");
  const base = normalizeBase(baseUrl);
  if (!base) return fail('The Shellby community registry address is misconfigured.');
  if (typeof fetchImpl !== 'function') return fail('Downloading is not available in this version of Shellby.');
  const opts = { fetchImpl, timeoutMs, base };

  try {
    // 1. The index.
    const indexUrl = new URL('index.json', base).href;
    let index;
    try {
      const raw = await fetchBytes(indexUrl, { ...opts, maxBytes: MAX_INDEX_BYTES, what: 'registry index' });
      index = JSON.parse(raw.toString('utf8').replace(/^﻿/, ''));
    } catch (e) {
      if (e instanceof FetchError) throw e;
      return fail("The Shellby community registry sent something unreadable. Try again later.");
    }
    if (!isObj(index) || index.format !== INDEX_FORMAT || !Array.isArray(index.packs)) {
      return fail("The Shellby community registry is in a format this version of Shellby doesn't understand. Try updating Shellby.");
    }

    // 2. The entry (exact id match only).
    const entry = index.packs.find(p => isObj(p) && p.id === packId);
    if (!entry) return fail("That pack isn't in the Shellby community registry.");
    if (!isUnderBase(entry.url, base)) return fail('The registry lists that pack at an address outside the Shellby community registry, so it was not downloaded.');
    if (typeof entry.sha256 !== 'string' || !SHA256_RE.test(entry.sha256)) return fail("The registry entry for that pack has no valid checksum, so it can't be verified.");
    if (entry.bytes !== undefined && !(Number.isFinite(entry.bytes) && entry.bytes >= 0)) return fail('The registry entry for that pack is malformed.');
    if (entry.bytes > maxBytes) return fail(`That pack is too big (max ${Math.round(maxBytes / 1024)} KB).`);

    // 3. The pack itself, checked byte-for-byte against the registry.
    const bytes = await fetchBytes(entry.url, { ...opts, maxBytes, what: 'pack' });
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha !== entry.sha256) {
      return fail("Download didn't match the registry checksum, so it was not installed. The pack may have just been updated; try again in a few minutes.");
    }
    const clean = {
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name.slice(0, 60) : entry.id,
      version: typeof entry.version === 'string' ? entry.version.slice(0, 20) : '',
      url: entry.url, sha256: entry.sha256, bytes: bytes.length,
    };
    return { ok: true, entry: clean, text: bytes.toString('utf8'), errors: [] };
  } catch (e) {
    if (e instanceof FetchError) return fail(e.message);
    return fail("Something went wrong talking to the Shellby community registry. Try again later.");
  }
}

/**
 * The gallery's catalog.json: every community item with its pack, so an outfit
 * code can say which pack a missing item comes from. Never throws.
 * @returns {Promise<{ ok: boolean, items?: [{ key, slot, name, packId, packName }], errors: string[] }>}
 */
async function fetchRegistryCatalog({ baseUrl = REGISTRY_URL, fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
  const fail = msg => ({ ok: false, errors: [msg] });
  const base = normalizeBase(baseUrl);
  if (!base || typeof fetchImpl !== 'function') return fail('The Shellby community registry is unavailable.');
  try {
    const raw = await fetchBytes(new URL('catalog.json', base).href, { fetchImpl, timeoutMs, base, maxBytes: MAX_INDEX_BYTES * 2, what: 'community catalog' });
    const cat = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, ''));
    if (!isObj(cat) || !Array.isArray(cat.packs)) return fail("The community catalog is in a format this version of Shellby doesn't understand.");
    const ITEM_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
    const name = (v, id) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]+/g, ' ').slice(0, 60) : id);
    const items = [];
    for (const pk of cat.packs.slice(0, 500)) {
      if (!isObj(pk) || !PACK_ID_RE.test(pk.id)) continue;
      const add = (list, slotOf) => {
        for (const it of Array.isArray(list) ? list.slice(0, 200) : []) {
          if (!isObj(it) || !ITEM_ID.test(it.id)) continue;
          const slot = slotOf(it);
          if (slot) items.push({ key: `${pk.id}/${it.id}`, slot, name: name(it.name, it.id), packId: pk.id, packName: name(pk.name, pk.id) });
        }
      };
      add(pk.accessories, it => (['hat', 'face', 'neck', 'held', 'shell'].includes(it.slot) ? it.slot : null));
      add(pk.effects, () => 'effect');
      add(pk.skins, () => 'skin');
    }
    return { ok: true, items, errors: [] };
  } catch (e) {
    if (e instanceof FetchError) return fail(e.message);
    return fail("Couldn't read the community catalog. Try again later.");
  }
}

module.exports = { REGISTRY_URL, PROTOCOL, parseDeepLink, findDeepLink, fetchRegistryPack, fetchRegistryCatalog, isUnderBase, normalizeBase };
