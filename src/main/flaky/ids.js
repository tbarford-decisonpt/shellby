// The flaky test detective's names: test ids as stored and said, and the
// part of a test command that decides what runs. Pure. See ../flaky.js.
const crypto = require('crypto');

const MAX_FAILED = 25;            // test ids kept from one run
const MAX_ID = 160;
const SUITE = '*';                // a run that failed without naming a test
const FRAMEWORKS = ['node', 'jest', 'vitest', 'mocha', 'pytest', 'go', 'cargo', 'playwright', 'rspec', 'dotnet', 'phpunit'];

// ------------------------------------------------------------------ test ids

// Names come from code anyone could have written and end up in a Claude
// prompt: printable, one line, short, and none of the characters that could
// close a fence or a tag around them.
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const TEST_ID_RE = /^[^\n\r`<>]{1,160}$/;
// Ids are object keys: these would be swallowed by the prototype, not stored.
const RESERVED = new Set(['__proto__', 'constructor', 'prototype']);

/** A test id as stored, or null when it can't be one. */
function cleanId(s) {
  if (typeof s !== 'string') return null;
  const t = s.replace(ANSI_RE, '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!t || t.length > MAX_ID || !TEST_ID_RE.test(t) || !/[\p{L}\p{N}]/u.test(t) || RESERVED.has(t)) return null;
  return t;
}

const FILEISH_RE = /[\\/]|\.(test|spec)\b|\.([cm]?[jt]sx?|py|rb|go|rs|cs|php)$/i;
const shortFile = f => f.split(/[\\/]/).pop().replace(/\.([cm]?[jt]sx?|py|rb|go|rs|cs|php)$/i, '');
const clipTo = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The short name he says out loud: "auth.spec › signs in", "TestServer". */
function labelOf(id) {
  if (id === SUITE) return 'the test suite';
  const parts = id.split(' › ');
  const last = parts[parts.length - 1];
  if (parts.length === 1) return clipTo(FILEISH_RE.test(last) ? shortFile(last) : last, 48);
  return FILEISH_RE.test(parts[0]) ? `${clipTo(shortFile(parts[0]), 20)} › ${clipTo(last, 30)}` : clipTo(last, 48);
}

// ------------------------------------------------------------------ commands

/**
 * The part of a test command that decides what runs: no `cd x &&` in front,
 * no `2>&1`, no `| tail` or `; echo $?` behind. `npm test 2>&1 | tail -30`
 * and `npm test` are the same run; `npm test -- auth` is not.
 */
function normalizeCmd(cmd) {
  if (typeof cmd !== 'string') return '';
  let c = cmd.slice(0, 2000).replace(/\r?\n/g, ' ').trim();
  // Leading folder changes, as many as there are.
  for (let i = 0; i < 4; i++) {
    const next = c.replace(/^(cd|Set-Location|pushd)\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*/i, '');
    if (next === c) break;
    c = next;
  }
  c = c
    .replace(/\s+(\d|\*)?>&\d\b/g, '')                       // 2>&1, *>&1
    .replace(/\s*;\s*(echo|Write-(Host|Output))\b.*$/i, '')  // ; echo "exit: $?"
    .replace(/\s*\|\|\s*(true|:|exit\s+0|echo\b.*)$/i, '')   // || true
    .replace(/\s*&&\s*echo\b.*$/i, '');
  // Everything after the first pipe only filters what was printed.
  const pipe = c.search(/\s\|(?!\|)\s*/);
  if (pipe > 0) c = c.slice(0, pipe);
  return c.replace(/\s+/g, ' ').trim();
}

/** A short hash of the normalised command: what runs are compared by. */
function cmdKey(cmd) {
  const n = normalizeCmd(cmd);
  return n ? crypto.createHash('sha1').update(n).digest('hex').slice(0, 12) : null;
}

/** Whether the exit code can't be trusted: a pipe, `|| true`, `; echo`. */
function masked(cmd) {
  if (typeof cmd !== 'string') return false;
  return /\s\|(?!\|)/.test(cmd) || /\|\|\s*(true|:|exit\s+0|echo)\b/i.test(cmd) || /;\s*(echo|Write-(Host|Output))\b/i.test(cmd);
}

module.exports = { SUITE, MAX_FAILED, MAX_ID, FRAMEWORKS, ANSI_RE, cleanId, clipTo, labelOf, normalizeCmd, cmdKey, masked };
