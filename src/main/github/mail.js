// Shell mail: a wave from one crab to another, carried as a comment on the
// friend's calling card gist. There's no free text on purpose. A wave is one of
// a few fixed lines, so nobody can put anything in your crab's mouth, and only
// friends you added get delivered at all. The comment still reads fine on github.com.
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
  for (let n = 0; n < MAX_PAGES; n++) {
    const list = await gh.get(`/gists/${encodeURIComponent(cardId)}/comments?per_page=${PAGE}&page=${page}`);
    for (const c of list || []) {
      const w = parseWave(c);
      if (!w || w.id <= seenId) continue;
      if (!sameLogin(w.from, me) && friends.some(f => sameLogin(f, w.from))) found.push(w);
    }
    for (const c of list || []) if (Number.isSafeInteger(c?.id)) seenId = Math.max(seenId, c.id);
    if (!list || list.length < PAGE) break;
    page++;
  }
  // The first look only marks where things are: old waves aren't news.
  const waves = firstCheck ? [] : found.slice(-MAX_DELIVER);
  return { waves, cursor: { page, seenId } };
}

module.exports = { WAVES, isWave, formatWave, parseWave, sendWave, checkWaves };
