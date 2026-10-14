'use strict';
// Claude Code's background sessions (`claude --bg`, or /fork and agent view in
// the terminal): Claude working on its own, with nobody watching. Shellby
// lists them from `claude agents --json --all`, says when one needs you or
// has finished, and runs Claude Code's own logs, stop, respawn and rm on them.
//
// Pure: the CLI runs in wiring/bg-sessions.js; test/bg-sessions.test.js.

// The states agent view shows, in its words.
const STATES = Object.freeze({
  working: 'Working',
  blocked: 'Needs input',
  review: 'Ready for review',
  done: 'Completed',
  failed: 'Failed',
});
// A session in one of these has stopped and wants a look.
const NEEDS_YOU = new Set(['blocked', 'review']);
const FINISHED = new Set(['done', 'failed']);

// What `claude stop`, `logs` and `rm` take: agent view's short id.
const ID = /^[0-9a-f]{6,16}$/i;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX = 50;

const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, n) : '');

/**
 * The background sessions in `claude agents --json --all`, newest first.
 * Interactive sessions (a terminal, Shellby's own tabs) are left out.
 * @returns {{ id: string, sessionId: string|null, name: string, cwd: string,
 *   state: string, needs: string, startedAt: number|null }[]}
 */
function parseAgents(stdout) {
  let list;
  try { list = JSON.parse(String(stdout ?? '').trim() || '[]'); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return list
    .filter(s => s && typeof s === 'object' && s.kind === 'background' && ID.test(String(s.id)))
    .map(s => ({
      id: String(s.id),
      sessionId: SESSION_ID.test(String(s.sessionId)) ? String(s.sessionId) : null,
      name: str(s.name, 120) || 'A background session',
      cwd: str(s.cwd, 1000),
      state: str(s.state, 20).toLowerCase() || 'working',
      needs: str(s.needs, 200),
      startedAt: Number.isFinite(s.startedAt) ? s.startedAt : null,
    }))
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, MAX);
}

/** A state in agent view's words. */
const stateLabel = state => STATES[state] || (state ? state[0].toUpperCase() + state.slice(1) : 'Unknown');

/**
 * What changed since the last listing that's worth telling you: a session
 * that now needs you, or has finished. A session seen for the first time
 * already in that state says nothing (you knew, or it's from before Shellby
 * started); the first listing of all is only a baseline (prev null).
 * @returns {{ kind: 'needs'|'finished', session: object }[]}
 */
function newsBetween(prev, next) {
  if (!prev) return [];
  const before = new Map(prev.map(s => [s.id, s.state]));
  const news = [];
  for (const s of next) {
    const was = before.get(s.id);
    if (was === undefined || was === s.state) continue;
    if (NEEDS_YOU.has(s.state)) news.push({ kind: 'needs', session: s });
    else if (FINISHED.has(s.state)) news.push({ kind: 'finished', session: s });
  }
  return news;
}

/** Is it still running (so opening it here would stop it first)? */
const isRunning = s => !FINISHED.has(s?.state);

module.exports = { STATES, ID, parseAgents, stateLabel, newsBetween, isRunning };
