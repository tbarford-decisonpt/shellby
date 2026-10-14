// Keep warm (docs/plans/keep-warm.md): which conversations get a ping and when,
// what a ping's readback says, and when you're back. Pure: keepwarm-service.js
// brings the tabs and the clock.
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const LEAD_MS = 5 * MIN;        // a ping goes this long before the cache would expire
const MAX_MS = 3 * HOUR;        // on for no longer than this, however long you're gone
const TICK_MS = 30 * 1000;      // how often the tabs are looked at
const AWAY_IDLE_MS = 2 * MIN;   // no input for this long and you've stepped away (recap.js IDLE_MS)
const COLD_SHARE = 0.1;         // a ping that wrote this share of what it read found the cache gone,
const COLD_MIN_WRITE = 10000;   // as long as it wrote this much: every ping writes ~2.6k of its own
const MIN_KEEP_TOKENS = 200000; // smaller conversations cost little to write again, so they aren't pinged
const PING_TEXT = 'Keep-warm ping from Shellby. Reply with the single word: warm. Use no tools.';

const pad = n => String(n).padStart(2, '0');
/** 13:05, in this PC's time. */
function hhmm(ms) {
  const t = new Date(ms);
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}
/** 214k, or the number itself under a thousand. */
function tokensText(n) { return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n || 0); }

/**
 * What to do with each open tab this tick.
 * tabs: [{ id, title, saved, hasProc, inTerminal, busy, pending, crew, size, cache: { at, ttlMs } | null }]
 *   size: the conversation's tokens, as its context meter has them
 * kept: Map tabId -> { state: 'kept' | 'dropped', reason }, what the service already decided
 * -> [{ id, title, action, reason, dueAt }], action:
 *   'ping' due now; 'wait' kept, not due (reason 'working' while it's busy);
 *   'skip' not one to keep warm; 'drop' was kept and can't be any more
 */
function plan(tabs, kept, now, lead = LEAD_MS) {
  return tabs.map(t => {
    const k = kept.get(t.id);
    const out = (action, reason = null, dueAt = null) => ({ id: t.id, title: t.title, action, reason, dueAt });
    if (k?.state === 'dropped') return out('skip', k.reason);
    if (k && !t.hasProc) return out('drop', 'its Claude Code process ended');
    if (!t.saved || !t.hasProc || t.inTerminal || !t.cache) return out('skip', 'nothing to keep warm');
    if (!(t.cache.ttlMs >= HOUR)) return out('skip', 'its cache only lasts 5 minutes');
    // Kept and then compacted, say: what's left isn't worth it either.
    if (!(t.size >= MIN_KEEP_TOKENS)) return out(k ? 'drop' : 'skip', `too small to be worth it (${tokensText(t.size)})`);
    const expires = t.cache.at + t.cache.ttlMs;
    const dueAt = expires - lead;
    // Its own turn reads (and restamps) the cache: nothing to do but wait.
    if (t.busy || t.pending || t.crew) return out('wait', 'working', dueAt);
    // Past it (the PC slept, say): a ping now would pay the whole write.
    if (now >= expires) return k ? out('drop', `it went cold at ${hhmm(expires)}`) : out('skip', 'its cache is already cold');
    return out(now >= dueAt ? 'ping' : 'wait', null, dueAt);
  });
}

/**
 * A ping's readback ({ ok, error, tokens, denied } from manager.ping) -> { warm, read, wrote, reason },
 * and cold: true when it found the cache gone (the service gives that tab one more ping).
 */
function receipt(r) {
  if (r?.denied) return { warm: false, read: 0, wrote: 0, reason: 'the ping tried to use a tool' };
  if (!r?.ok) return { warm: false, read: 0, wrote: 0, reason: String(r?.error || 'the ping failed').split('\n')[0] };
  const read = r.tokens?.cacheRead || 0;
  const wrote = r.tokens?.cacheWrite || 0;
  // Read nothing, or wrote a good part of it again: the cache had already gone.
  if (!read || (wrote >= read * COLD_SHARE && wrote >= COLD_MIN_WRITE)) return { warm: false, cold: true, read, wrote, reason: `the ping found it cold (read ${tokensText(read)}, wrote ${tokensText(wrote)})` };
  return { warm: true, read, wrote, reason: null };
}

/** One idle reading while it's on. left: you've stepped away since it went on. -> { left, back } */
function watchBack(left, { idleMs = 0, locked = false } = {}) {
  if (locked || idleMs >= AWAY_IDLE_MS) return { left: true, back: false };
  return { left: false, back: !!left };
}

// wrote: only for a ping that found it cold, and kept it anyway. With nothing read, the line says only what it wrote.
function keptText(at, read, wrote = null) {
  if (wrote === null) return `Kept warm ${hhmm(at)} · read ${tokensText(read)} from cache`;
  if (!read) return `Kept warm ${hhmm(at)} · wrote ${tokensText(wrote)} back to the cache`;
  return `Kept warm ${hhmm(at)} · read ${tokensText(read)} from cache, wrote ${tokensText(wrote)}`;
}
function stoppedText(reason) { return `Stopped keeping warm: ${reason}`; }

/** The button's tooltip line for one tab: p from plan(), k its kept entry. */
function tabLine(p, k) {
  if (k?.state === 'dropped') return `stopped: ${k.reason}`;
  if (p.action === 'skip' || p.action === 'drop') return p.reason;
  if (p.reason === 'working') return 'working';
  const next = `next ping ${hhmm(p.dueAt)}`;
  return k?.lastPing ? `kept warm ${hhmm(k.lastPing.at)} · ${next}` : next;
}

module.exports = { LEAD_MS, MAX_MS, TICK_MS, AWAY_IDLE_MS, COLD_SHARE, COLD_MIN_WRITE, MIN_KEEP_TOKENS, PING_TEXT, hhmm, tokensText, plan, receipt, watchBack, keptText, stoppedText, tabLine };
