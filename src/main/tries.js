// Try it N ways: the same message, sent 2-4 times at once, each in its own
// copy of the project, then ranked once they're done so you can pick one.
// Diversity comes from sampling: every try gets exactly the same prompt.
//
// It spends N tasks' worth of your plan, so it never starts by itself: only
// /tries or "Try it N ways…" on the send button, and only after the isolated
// confirmation window has shown what it usually costs (costQuestion).
//
// All pure: wiring/tries.js runs them. See test/tries.test.js.
const MARK = '⑂';
const MIN_TRIES = 2;
const MAX_TRIES = 4;
const DEFAULT_TRIES = 3;
const MAX_TEXT = 50000;
const MAX_ATTACHMENTS = 20; // what one message carries (task:send); every try gets them all
const TITLE_MAX = 60;

const WORDS = { 2: 'two', 3: 'three', 4: 'four' };
const MODE_NAMES = { ask: 'Ask first', smart: 'Smart', acceptEdits: 'Auto-edit', plan: 'Plan only', autonomous: 'Autonomous' };
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * What follows /tries: "3 fix the login", "3 ways: fix the login", or just
 * "fix the login" (three tries). -> { n, text } | { error }
 */
function parseArg(arg) {
  const s = String(arg || '').trim();
  const m = /^(\d+)(?:\s*(?:ways?|x|×))?\s*[:,-]?\s*([\s\S]*)$/i.exec(s);
  const n = m ? Number(m[1]) : DEFAULT_TRIES;
  const text = (m ? m[2] : s).trim();
  if (!Number.isInteger(n) || n < MIN_TRIES || n > MAX_TRIES) return { error: 'Two, three or four tries: /tries 3 fix the flaky login test' };
  if (!text) return { error: 'What should he try? /tries 3 fix the flaky login test' };
  return { n, text };
}

/** Why it can't start (before asking about the cost), or null. */
function problem({ n, text, tabsOpen = 0, maxTabs = 32, attachments = 0 } = {}) {
  if (!Number.isInteger(n) || n < MIN_TRIES || n > MAX_TRIES) return 'Two, three or four tries.';
  if (typeof text !== 'string' || !text.trim()) return 'Type what he should try first.';
  if (text.length > MAX_TEXT) return "That's too long to try several ways at once.";
  if (attachments > MAX_ATTACHMENTS) return `That's more than one message carries: ${MAX_ATTACHMENTS} attachments at most.`;
  const room = maxTabs - tabsOpen;
  if (room < n) {
    return room <= 0
      ? `Shellby can run up to ${maxTabs} conversations at once. Close ${plural(n, 'one')} first.`
      : `That needs ${n} new tabs and there's room for ${room}. Close ${plural(n - room, 'conversation')} first.`;
  }
  return null;
}

/** "Fix the login test\nmore…" -> "Fix the login test". */
function titleFor(text) {
  const line = String(text || '').split(/\r?\n/).map(l => l.trim()).find(Boolean) || 'New task';
  const flat = line.replace(/\s+/g, ' ');
  return flat.length > TITLE_MAX ? `${flat.slice(0, TITLE_MAX - 1)}…` : flat;
}

/** (2, 3, "Fix it") -> "⑂ 2/3 Fix it". */
function tryTitle(i, n, title) {
  const t = String(title || '').replace(new RegExp(`^(\\s*${MARK}\\s*(\\d+/\\d+\\s*)?)+`), '').trim() || 'New task';
  return `${MARK} ${i}/${n} ${t}`;
}

// "about 8%", or "less than 1%" for the tiny ones.
const aboutPct = p => (p < 1 ? 'less than 1%' : `about ${Math.round(p)}%`);

/**
 * The confirmation, in the isolated window. estimate: usage:estimate's shape
 * (wiring/usageplan.js estimateFor) or null. attachments: how many go with it.
 * -> { title, message, detail, note, danger, over, total, buttons, defaultId, cancelId }
 */
function costQuestion({ n, estimate = null, mode = '', attachments = 0 } = {}) {
  const e = estimate || {};
  const known = e.basis && e.basis !== 'none' && Number.isFinite(e.pct) && e.pct >= 0;
  const total = known ? Math.round(e.pct * n * 10) / 10 : null;
  const hasLeft = Number.isFinite(e.left);
  const leftText = hasLeft ? ` You've ${Math.round(e.left)}% left${e.guardOn ? ' before the part you keep for yourself' : ''}.` : '';
  const message = known
    ? `Each try usually takes ${aboutPct(e.pct)} of your window, so ${aboutPct(total)} in all.${leftText}`
    : `He hasn't seen enough tasks like this to guess; each try is a full task.${leftText}`;
  const over = known && total > 0 && Number.isFinite(e.nowPct) && Number.isFinite(e.line) && e.nowPct + total > e.line;
  const warning = !over ? ''
    : e.guardOn
      ? `\n\nThat's more than you've got before the share you keep for yourself (${100 - e.line}%), so the spending guard would hold this back.`
      : '\n\nThat would likely run past your 5-hour limit before they finish.';
  return {
    title: `Try this ${WORDS[n] || n} ways?`,
    message: message + warning,
    detail: `${n} tabs, each in its own copy of the project from your last commit, with exactly the same message`
      + `${attachments > 0 ? ` (and ${attachments === 1 ? 'its attachment' : `all ${attachments} attachments`})` : ''}`
      + `${mode ? ` and the same permission mode (${MODE_NAMES[mode] || mode})` : ' and the same permission mode as this one'}. `
      + "When they're done he runs the project's tests on each and ranks them. Nothing is kept or thrown away until you pick.",
    note: 'Only uncommitted work stays behind: commit first if the tries need it.',
    danger: over,
    over,
    total,
    buttons: over
      ? [{ label: 'Try anyway', style: 'danger' }, { label: 'Cancel' }]
      : [{ label: `Try it ${n} ways`, style: 'primary' }, { label: 'Cancel' }],
    defaultId: over ? 1 : 0,
    cancelId: 1,
  };
}

// ------------------------------------------------------------ ranking

const UNKNOWN = new Set(['none', 'declined', 'error', 'cancelled', 'stopped', null, undefined]);
const ENDED_BADLY = new Set(['stopped', 'failed', 'gone']);

// Lower is better: checks pass, then not checked, then failing; anything
// that changed nothing or never finished after those.
function tierOf(row) {
  if (ENDED_BADLY.has(row.state)) return 4;
  if (!row.files) return 3;
  if (row.checks === 'pass') return 0;
  if (UNKNOWN.has(row.checks)) return 1;
  return 2;
}

const sizeOf = r => (Number(r.added) || 0) + (Number(r.removed) || 0);
const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);

/**
 * The tries, best first: checks pass, then fewer failing, then the smaller
 * diff (+/−), then the faster. -> a new array, each row with its `place`.
 */
function rank(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((r, i) => ({ r, i }))
    .sort((a, b) => tierOf(a.r) - tierOf(b.r)
      || num(a.r.failing, 0) - num(b.r.failing, 0)
      || sizeOf(a.r) - sizeOf(b.r)
      || num(a.r.durationMs, Infinity) - num(b.r.durationMs, Infinity)
      || a.i - b.i)
    .map(({ r }, n) => ({ ...r, place: n + 1 }));
}

/** One row's verdict, short: { icon, text, tone }. */
function verdictOf(row) {
  if (row.state === 'running') return { icon: '…', text: 'working', tone: 'busy' };
  if (row.state === 'checking') return { icon: '…', text: 'running its tests', tone: 'busy' };
  if (row.state === 'stopped') return { icon: '■', text: 'stopped', tone: 'warn' };
  if (row.state === 'failed') return { icon: '⚠', text: 'went wrong', tone: 'fail' };
  if (row.state === 'gone') return { icon: '✕', text: 'closed', tone: 'warn' };
  if (!row.files) return { icon: '·', text: 'changed nothing', tone: 'warn' };
  if (row.checks === 'pass') return { icon: '✅', text: 'checks pass', tone: 'pass' };
  if (row.checks === 'fail') return { icon: '❌', text: row.failing ? `${row.failing} failing` : 'checks fail', tone: 'fail' };
  if (row.checks === 'timeout') return { icon: '❌', text: 'tests ran out of time', tone: 'fail' };
  if (row.checks === 'none') return { icon: '·', text: 'no tests found', tone: 'muted' };
  if (row.checks === 'declined') return { icon: '·', text: 'tests not run', tone: 'muted' };
  return { icon: '·', text: 'not checked', tone: 'muted' };
}

const isDone = row => !['running', 'checking'].includes(row.state);
const allDone = rows => Array.isArray(rows) && rows.length > 0 && rows.every(isDone);

/** The toast once they're all done. ranked: from rank(). */
function doneLine(ranked) {
  const list = Array.isArray(ranked) ? ranked : [];
  const lead = list[0];
  const n = list.length;
  if (!lead || tierOf(lead) >= 3) return `All ${plural(n, 'try', 'tries')} are done, but none changed anything worth keeping. Have a look.`;
  const why = lead.checks === 'pass' ? 'checks pass' : verdictOf(lead).text;
  return `All ${plural(n, 'try', 'tries')} are done. "${lead.title}" comes out on top (${why}). Have a look, then keep one.`;
}

module.exports = {
  parseArg, problem, titleFor, tryTitle, costQuestion, rank, verdictOf, allDone, isDone, doneLine, tierOf,
  MIN_TRIES, MAX_TRIES, DEFAULT_TRIES, MAX_TEXT, MAX_ATTACHMENTS, MARK,
};
