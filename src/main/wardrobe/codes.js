// Outfit codes: a whole look as a short string, like SHB-7Q2F-K9XA-3MWD, that
// people paste to wear someone else's outfit. No server: each worn item is a
// slot number plus a 17-bit hash of its key, so codes keep working as catalogs
// grow (no list positions), and community items are recognised by their
// globally unique "pack/item" key.
//
// Layout (big-endian bits): version(2) count(3) [slot(3) hash(17)] x count
// checksum(10), padded to whole groups of four Crockford base32 characters.
// Pure: no I/O. See test/codes.test.js.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford: no I, L, O, U
const SLOTS = ['hat', 'face', 'neck', 'held', 'shell', 'effect', 'skin'];
const VERSION = 1;
const HASH_BITS = 17;
const CHECK_BITS = 10;
const DEFAULT_SKIN = 'classic';

/** 32-bit FNV-1a: tiny, stable across versions, good enough for ~1000 items. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(String(str), 'utf8')) {
    h ^= ch;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
const itemHash = key => fnv1a(key) & ((1 << HASH_BITS) - 1);
const checksum = bits => fnv1a(`shellby-outfit:${bits}`) & ((1 << CHECK_BITS) - 1);
const toBits = (n, width) => n.toString(2).padStart(width, '0');

/**
 * Encode an outfit. outfit: { hat, face, neck, held, shell, effect } item keys
 * (or null); skin: the skin id/key (the default skin is left out).
 */
function encodeOutfit(outfit = {}, skin = DEFAULT_SKIN) {
  const entries = [];
  SLOTS.forEach((slot, i) => {
    const key = slot === 'skin' ? (skin && skin !== DEFAULT_SKIN ? skin : null) : outfit?.[slot];
    if (typeof key === 'string' && key) entries.push(toBits(i, 3) + toBits(itemHash(key), HASH_BITS));
  });
  let bits = toBits(VERSION, 2) + toBits(entries.length, 3) + entries.join('');
  bits += toBits(checksum(bits), CHECK_BITS);
  const chars = Math.ceil(Math.ceil(bits.length / 5) / 4) * 4;
  bits = bits.padEnd(chars * 5, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return `SHB-${out.match(/.{4}/g).join('-')}`;
}

/** Forgiving parse: any case, spaces or dashes, O->0, I/L->1. */
function normalizeCode(text) {
  const t = String(text || '').toUpperCase().replace(/^\s*SHB/, '').replace(/[\s-]+/g, '')
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  // Real codes are whole groups of four characters.
  return /^[0-9A-HJKMNP-TV-Z]{4,40}$/.test(t) && t.length % 4 === 0 ? t : null;
}

/**
 * Decode a code into [{ slot, hash }]. Returns { ok: true, entries } or
 * { ok: false, error } with a friendly message.
 */
function decodeOutfit(text) {
  const body = normalizeCode(text);
  if (!body) return { ok: false, error: "That doesn't look like an outfit code. They look like SHB-7Q2F-K9XA-3MWD." };
  const bits = [...body].map(c => toBits(ALPHABET.indexOf(c), 5)).join('');
  const version = parseInt(bits.slice(0, 2), 2);
  if (version === 0) return { ok: false, error: "That doesn't look like an outfit code. They look like SHB-7Q2F-K9XA-3MWD." };
  if (version !== VERSION) return { ok: false, error: 'That outfit code is from a newer Shellby. Update Shellby to wear it.' };
  const count = parseInt(bits.slice(2, 5), 2);
  const used = 5 + count * 20;
  if (bits.length < used + CHECK_BITS) return { ok: false, error: 'That outfit code is too short. Check you copied all of it.' };
  if (parseInt(bits.slice(used, used + CHECK_BITS), 2) !== checksum(bits.slice(0, used))) {
    return { ok: false, error: "That outfit code has a typo somewhere (the checksum doesn't match)." };
  }
  const entries = [];
  for (let i = 0; i < count; i++) {
    const e = bits.slice(5 + i * 20, 25 + i * 20);
    const slot = SLOTS[parseInt(e.slice(0, 3), 2)];
    if (!slot) return { ok: false, error: 'That outfit code is damaged.' };
    entries.push({ slot, hash: parseInt(e.slice(3), 2) });
  }
  return { ok: true, entries };
}

/**
 * Match decoded entries to items. items: [{ key, slot }] where slot is one of
 * SLOTS ('effect' for effects, 'skin' for skins). Returns
 * { found: [{ slot, key }], missing: [{ slot, hash }] }.
 */
function resolveEntries(entries, items) {
  const found = [], missing = [];
  for (const e of entries) {
    const hit = items.find(it => it.slot === e.slot && itemHash(it.key) === e.hash);
    if (hit) found.push({ slot: e.slot, key: hit.key });
    else missing.push(e);
  }
  return { found, missing };
}

module.exports = { encodeOutfit, decodeOutfit, normalizeCode, resolveEntries, itemHash, fnv1a, SLOTS, DEFAULT_SKIN };
