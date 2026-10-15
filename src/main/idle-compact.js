// Idle compaction: a long conversation left quiet is compacted shortly before
// its hour-long prompt cache runs out, so the next message doesn't send the
// whole of it again at full price.
//
// Claude Code 2.1.290 does this itself, but only in its terminal UI: in print
// mode (how Shellby runs it) the timer finds no UI to compact through and
// stands down. So Shellby does the same from outside, with the same rules:
// a cache written for an hour, about 54 minutes quiet (90% of it), 200K tokens
// or more (CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS, never under 100K), and never
// where a Claude Code settings file says "idleCompaction": false. It's off
// unless you turn it on in Settings, since it uses your plan while you're away.
//
// Pure: callers pass `now`, the env and the settings they read (test/idle-compact.test.js).

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DEFAULT_MIN_TOKENS = 200000; // Claude Code's own default
const FLOOR_MIN_TOKENS = 100000;   // ...and the lowest it lets the env var go
const FIRE_AT = 0.9;               // of the cache's life: 54 minutes into an hour
const ENV_KEY = 'CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS';

/** The token floor from an env (process.env, or a settings file's env block), as Claude Code reads it. */
function minTokens(...envs) {
  for (const env of envs) {
    const raw = env?.[ENV_KEY];
    if (raw === undefined || raw === null || raw === '') continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return Math.max(FLOOR_MIN_TOKENS, n);
  }
  return DEFAULT_MIN_TOKENS;
}

/**
 * What Claude Code's settings say, given each file's data from lowest to
 * highest precedence (user, project, local, managed): { off, env }.
 * The last file that says anything about idleCompaction wins; only false turns it off.
 */
function fromSettings(datas = []) {
  let off = false;
  let env = {};
  for (const data of datas) {
    if (!data || typeof data !== 'object') continue;
    if (typeof data.idleCompaction === 'boolean') off = data.idleCompaction === false;
    if (data.env && typeof data.env === 'object' && !Array.isArray(data.env)) env = { ...env, ...data.env };
  }
  return { off, env };
}

/**
 * Whether a tab should be compacted now. tab: { saved, routine, inTerminal,
 * busy, waiting (permission cards or running helpers), cache: { at, ttlMs },
 * tokens, lastFor (the cache.at it was last compacted for) }.
 */
function due(tab, { now, floor = DEFAULT_MIN_TOKENS }) {
  if (!tab?.saved || tab.routine || tab.inTerminal || tab.busy || tab.waiting) return false;
  const cache = tab.cache;
  if (!cache || !Number.isFinite(cache.at) || cache.ttlMs !== HOUR) return false;
  if (tab.lastFor === cache.at) return false; // tried for this cache already
  if (!Number.isFinite(tab.tokens) || tab.tokens < floor) return false;
  const fireAt = cache.at + cache.ttlMs * FIRE_AT;
  return now >= fireAt && now < cache.at + cache.ttlMs;
}

module.exports = { due, minTokens, fromSettings, DEFAULT_MIN_TOKENS, FLOOR_MIN_TOKENS, FIRE_AT, ENV_KEY };
