// The friends' board: you and the friends who share their Bugdex, ranked by
// the bugs Claude fixed for each of you this month. One tab for every bug,
// one per habitat someone caught in ("most merge-conflict crabs" is Tangled
// Nets), and one for sparklies. Only friends, never strangers: the numbers come
// off calling cards you already read (github/card.js), and a card from last
// month counts as nothing. See docs/plans/viral.md §5.
//
// Pure: no I/O, no clock. See test/board.test.js.

const { HABITATS } = require('./bugdex/species');

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const MEDALS = ['🥇', '🥈', '🥉'];

const monthName = key => (MONTH_RE.test(key || '') ? MONTHS[Number(key.slice(5)) - 1] : '');
const n = v => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

/** What one tab counts in a tally. */
function valueOf(tally, tab) {
  if (!tally) return 0;
  if (tab === 'all') return n(tally.jars);
  if (tab === 'sparkles') return n(tally.shinies);
  return n(tally.habitats?.[tab]);
}

/** Ranked, with ties sharing a place (1, 2, 2, 4) and names breaking them for the order. */
function rank(rows) {
  const sorted = [...rows].sort((a, b) => b.value - a.value || (a.me ? -1 : b.me ? 1 : 0) || a.login.localeCompare(b.login));
  let place = 0, last = null;
  return sorted.map((r, i) => {
    if (r.value !== last) { place = i + 1; last = r.value; }
    return { ...r, place, medal: r.value > 0 && place <= 3 ? MEDALS[place - 1] : null };
  });
}

/**
 * The board for a month.
 *   me: { login, month } (month: bugdex.shared(...).month)
 *   friends: [{ login, bugdex }] as their cards carry it (cleaned)
 * -> { key, month, entrants, tabs: [{ id, label, icon }], rows: { tabId: [row] }, mine: { tabId: place } }
 *   row: { login, me, value, place, medal }
 */
function board({ me = {}, friends = [], key } = {}) {
  if (!MONTH_RE.test(key || '')) return null;
  const tallyFor = month => (month && month.key === key ? month : null); // last month's card counts as nothing
  const people = [
    { login: LOGIN_RE.test(me.login || '') ? me.login : 'you', me: true, tally: tallyFor(me.month) },
    ...friends.filter(f => f && LOGIN_RE.test(f.login || '') && f.bugdex && !(me.login && f.login.toLowerCase() === me.login.toLowerCase()))
      .slice(0, 30).map(f => ({ login: f.login, me: false, tally: tallyFor(f.bugdex.month) })),
  ];
  const habitatTabs = HABITATS.filter(h => people.some(p => valueOf(p.tally, h.id) > 0)).map(h => ({ id: h.id, label: h.name, icon: h.icon }));
  const tabs = [{ id: 'all', label: 'All bugs', icon: '🫙' }, ...habitatTabs, { id: 'sparkles', label: 'Sparklies', icon: '✨' }];
  const rows = {}, mine = {};
  for (const t of tabs) {
    rows[t.id] = rank(people.map(p => ({ login: p.login, me: p.me, value: valueOf(p.tally, t.id) })));
    mine[t.id] = rows[t.id].find(r => r.me)?.place || null;
  }
  return { key, month: monthName(key), entrants: people.length, tabs, rows, mine };
}

/**
 * Remember where you stood, and notice when a month is over.
 *   prev: { key, place, of, jars } from last time (or null)
 *   b: this month's board
 * -> { state, ended: prev's result when the month moved on (a board with someone in it) | null }
 */
function settle(prev, b) {
  if (!b) return { state: prev || null, ended: null };
  const all = b.rows.all;
  const me = all.find(r => r.me);
  const state = { key: b.key, place: me?.place || null, of: all.length, jars: me?.value || 0 };
  const p = prev && MONTH_RE.test(prev.key || '') ? prev : null;
  const ended = p && p.key !== b.key && p.of >= 2 && p.jars > 0 ? { key: p.key, month: monthName(p.key), place: p.place, of: p.of } : null;
  return { state, ended };
}

/** "1st", "2nd", "3rd", "11th". */
function ordinal(k) {
  const t = k % 100;
  if (t >= 11 && t <= 13) return `${k}th`;
  return `${k}${['th', 'st', 'nd', 'rd'][k % 10] || 'th'}`;
}

module.exports = { board, settle, ordinal, monthName, valueOf };
