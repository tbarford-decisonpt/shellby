// Shell mail: a wave from one crab to another, carried as a comment on the
// friend's calling card gist. There's no free text on purpose. A wave is one of
// a few fixed lines, so nobody can put anything in your crab's mouth, and only
// friends you added get delivered at all. The comment still reads fine on github.com.
//
// Letters ride the same way: a swap offered, accepted, declined or called off
// (swaps.js), and an egg hatched (eggs.js). Each is a marker with ids in it and
// nothing else; whoever reads one checks it against what's really open on its
// side (an offer it made, an egg it laid) before anything happens.
const { sameLogin } = require('./card');

const WAVES = Object.freeze({
  wave: 'waves hello 👋',
  outfit: 'loves the outfit',
  ship: 'says go ship it!',
  coffee: 'says coffee break?',
  proud: 'is proud of you',
  sleep: 'says go to bed!',
});
const MARK_RE = /<!-- shellby-wave:([a-z]{2,12}) -->/;
const PAGE = 100;
const MAX_PAGES = 5;
const MAX_DELIVER = 3; // a backlog after a week away still only says a few things

const isWave = k => typeof k === 'string' && Object.prototype.hasOwnProperty.call(WAVES, k);

// Letters: <!-- shellby-swap:offer:SID:give=ID[*]:get=ID[*] -->, <!-- shellby-swap:accept|decline|cancel:SID -->,
// <!-- shellby-hatch:EGGID -->. A * is a sparkly copy. Swap ids are 8 characters; egg ids 16 (eggs.js).
const ID = '[a-z0-9](?:[a-z0-9-]{0,39})';
const SID_RE = /^[a-z0-9]{8}$/;
const SWAP_RE = new RegExp(`<!-- shellby-swap:(offer|accept|decline|cancel):([a-z0-9]{8})(?::give=(${ID})(\\*?):get=(${ID})(\\*?))? -->`);
const HATCH_RE = /<!-- shellby-hatch:([a-z0-9]{16}) -->/;

/** A gist comment as a letter: { id, from, at, kind: 'swap' | 'hatch', ... }, or null. */
function parseLetter(c) {
  if (typeof c?.body !== 'string' || !Number.isSafeInteger(c.id) || typeof c.user?.login !== 'string') return null;
  const at = Date.parse(c.created_at);
  const base = { id: c.id, from: c.user.login, at: Number.isFinite(at) ? at : 0 };
  const h = HATCH_RE.exec(c.body);
  if (h) return { ...base, kind: 'hatch', egg: h[1] };
  const m = SWAP_RE.exec(c.body);
  if (!m) return null;
  const [, act, sid, give, giveShiny, get, getShiny] = m;
  if (act === 'offer' && !(give && get)) return null;
  if (act !== 'offer' && give) return null;
  return { ...base, kind: 'swap', act, sid, ...(act === 'offer' ? { give: { id: give, shiny: giveShiny === '*' }, get: { id: get, shiny: getShiny === '*' } } : {}) };
}

/** The comment body for a letter. `words` is our own fixed sentence, never anything typed. */
function formatLetter(marker, from, words) {
  return `🦀 **@${from}'s Shellby** ${words}\n\n<!-- ${marker} -->`;
}

async function sendLetter(gh, cardId, marker, from, words) {
  if (!/^shellby-(?:swap|hatch):[a-z0-9:=*-]{8,140}$/.test(marker)) throw new Error('Not a letter Shellby sends.');
  await gh.post(`/gists/${encodeURIComponent(cardId)}/comments`, { body: formatLetter(marker, from, words) });
}

/** The comment body for a wave from `from`. */
function formatWave(waveKey, from) {
  return `🦀 **@${from}'s Shellby** ${WAVES[waveKey]}\n\n<!-- shellby-wave:${waveKey} -->`;
}

/** A gist comment as a wave: { id, from, wave, at }, or null. */
function parseWave(c) {
  const m = typeof c?.body === 'string' ? MARK_RE.exec(c.body) : null;
  if (!m || !isWave(m[1]) || !Number.isSafeInteger(c.id) || typeof c.user?.login !== 'string') return null;
  const at = Date.parse(c.created_at);
  return { id: c.id, from: c.user.login, wave: m[1], at: Number.isFinite(at) ? at : 0 };
}

async function sendWave(gh, cardId, waveKey, from) {
  if (!isWave(waveKey)) throw new Error('Unknown wave.');
  await gh.post(`/gists/${encodeURIComponent(cardId)}/comments`, { body: formatWave(waveKey, from) });
}

/**
 * New waves on your own card since last time, from friends only.
 * cursor: { page, seenId } from the last check (comments come oldest first, so
 * we pick up on the page we stopped at). Returns { waves, cursor }.
 */
async function checkWaves(gh, cardId, { cursor = {}, friends = [], me = null } = {}) {
  let page = Number.isSafeInteger(cursor.page) && cursor.page > 0 ? cursor.page : 1;
  const firstCheck = !Number.isSafeInteger(cursor.seenId);
  let seenId = firstCheck ? 0 : cursor.seenId;
  const found = [];
  const letters = [];
  for (let n = 0; n < MAX_PAGES; n++) {
    const list = await gh.get(`/gists/${encodeURIComponent(cardId)}/comments?per_page=${PAGE}&page=${page}`);
    for (const c of list || []) {
      if (!Number.isSafeInteger(c?.id) || c.id <= seenId) continue;
      const w = parseWave(c);
      if (w) {
        if (!sameLogin(w.from, me) && friends.some(f => sameLogin(f, w.from))) found.push(w);
        continue;
      }
      // Swaps come from friends only, like waves. A hatch can come from anyone
      // (the person you sent the egg to isn't a friend yet), but only names an
      // egg id, checked against the eggs you laid. Nothing is capped, so a
      // stranger's junk can't crowd a real one out.
      const l = parseLetter(c);
      if (!l || sameLogin(l.from, me)) continue;
      if (l.kind === 'hatch' || friends.some(f => sameLogin(f, l.from))) letters.push(l);
    }
    for (const c of list || []) if (Number.isSafeInteger(c?.id)) seenId = Math.max(seenId, c.id);
    if (!list || list.length < PAGE) break;
    page++;
  }
  // The first look only marks where things are: old waves aren't news. Letters
  // are still delivered: an egg hatched before you ever looked still hatched.
  const waves = firstCheck ? [] : found.slice(-MAX_DELIVER);
  return { waves, letters, cursor: { page, seenId } };
}

module.exports = { WAVES, SID_RE, isWave, formatWave, parseWave, sendWave, checkWaves, parseLetter, formatLetter, sendLetter };
