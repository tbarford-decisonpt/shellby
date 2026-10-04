// Crash reports, sent to Sentry only with the user's say-so.
//
// Two things are found out here. A run that ended without Shellby quitting
// (a native crash, Windows ending the process, the power going) leaves its
// marker file behind, so the next start knows. And a report Sentry has ready
// waits in its own queue on disk until the user decides: the first time
// something goes wrong he asks, with Send, Always send and Don't send.
//
// Sentry's offline transport is what holds them. It calls shouldSend() before
// every attempt; false means shouldStore() is asked whether to keep it for a
// retry. So the whole consent rule is the gate below, decided by when each
// report's event happened: each Send or Don't send covers everything up to the
// moment the question was shown that no earlier answer covered, and the answers
// are kept in settings so they outlive a restart.
//
// No Electron imports; main.js passes things in, which is also how
// test/crash-report.test.js drives it.
const fs = require('fs');
const path = require('path');

const CONSENTS = ['ask', 'always', 'never'];

// Shellby's Sentry project. Empty means crash reporting isn't built in: no
// Settings row, no question, and nothing is loaded. Not a secret: a DSN only
// lets someone send events to the project, which is what it's for.
const DSN = 'https://7a58db607378b932e4099c1b43c311b7@o4512196447240192.ingest.us.sentry.io/4512196458053632';

// Integrations Shellby leaves out. What's kept: native crash dumps, Electron's
// own events (window and process lifecycle), child process crashes, stack
// traces and device context.
const LEFT_OUT = new Set([
  'OnUncaughtException',  // shows an error box once Shellby has a handler too; snag() reports these instead
  'OnUnhandledRejection', // same: snag() reports them, once
  'Console',              // console output can carry paths, prompts and replies
  'LocalVariables',       // the values of variables at the throw: tokens, prompt text
  'LocalVariablesAsync',  // (the name it has on newer Node)
  'ElectronNet',          // request URLs: webhook and ntfy addresses are secrets
  'NodeFetch',            // the same, for fetch()
  'MainProcessSession',   // session tracking is usage telemetry, not crash reporting
  'PreloadInjection',     // adds a preload to Shellby's windows; renderers aren't instrumented
  'RendererEventLoopBlock',
  'Screenshots',
]);

/** The DSN to use, or null. Dev builds only report when told to, to their own project. */
function dsnFor({ env = {}, isPackaged = false, capture = false } = {}) {
  if (capture) return null;
  if (!isPackaged) return env.SHELLBY_SENTRY_DSN || null;
  return DSN || null;
}

const normalizeConsent = v => (CONSENTS.includes(v) ? v : 'ask');

// ---------------------------------------------------------------- the marker

const markerFile = dir => path.join(dir, 'running.json');

/**
 * Note that this run has begun, and say whether the last one ended cleanly.
 * -> { unclean, startedAt, version }: startedAt and version describe the run
 * that didn't finish, when there was one.
 */
function startRun(dir, { version = '', now = Date.now } = {}) {
  let last = null;
  try { last = JSON.parse(fs.readFileSync(markerFile(dir), 'utf8')); } catch { /* none, or unreadable */ }
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(markerFile(dir), JSON.stringify({ startedAt: now(), version, pid: process.pid }));
  } catch { /* no marker means no warning next time; nothing worse */ }
  return last ? { unclean: true, startedAt: last.startedAt || null, version: last.version || '' } : { unclean: false };
}

/** A clean quit: the next start has nothing to report. */
function endRun(dir) {
  try { fs.rmSync(markerFile(dir), { force: true }); } catch { /* fine */ }
}

/**
 * The last lines the previous run wrote: everything in the log before this
 * run's own "starting" line, newest `n`. Already scrubbed by log.js.
 */
function previousLogTail(file, n = 40) {
  if (!file) return [];
  // log.js rotates to .1 past its size limit, possibly just as this run began.
  const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const lines = (read(`${file}.1`) + read(file)).split('\n').filter(Boolean);
  let start = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\S+ \S+ info {2}Shellby \S+ starting/.test(lines[i])) { start = i; break; }
  }
  return lines.slice(Math.max(0, start - n), start);
}

// ---------------------------------------------------------------- the gate

/** When a report's event happened, in ms, or null when it carries no event. */
function envelopeTime(envelope) {
  const items = Array.isArray(envelope) && Array.isArray(envelope[1]) ? envelope[1] : [];
  for (const [header, payload] of items) {
    if (header?.type === 'event' && payload && Number.isFinite(payload.timestamp)) return payload.timestamp * 1000;
  }
  return null;
}

const MAX_DECISIONS = 20;

/**
 * A Send / Don't send answer, added to the list kept in settings. It covers
 * every report from before `until` that no earlier answer already covered.
 */
function addDecision(list, until, send) {
  const prev = Array.isArray(list) ? list.filter(d => d && Number.isFinite(d.until)) : [];
  return [...prev, { until, send: !!send }].sort((a, b) => a.until - b.until).slice(-MAX_DECISIONS);
}

/**
 * shouldSend/shouldStore for Sentry's offline transport.
 * get() -> { consent, decisions } from settings.
 */
function makeGate(get) {
  const decide = envelope => {
    let s;
    try { s = get() || {}; } catch { s = {}; } // settings not loaded yet: fail closed (hold)
    const t = envelopeTime(envelope);
    if (t === null) return 'drop';   // sessions and the like: nothing a crash report needs
    const c = normalizeConsent(s.consent);
    if (c === 'never') return 'drop';
    // The first answer given after it happened is the one that counts: a report
    // turned down stays turned down, whatever is said yes to later.
    const answer = (Array.isArray(s.decisions) ? s.decisions : [])
      .filter(d => d && Number.isFinite(d.until) && t <= d.until)
      .sort((a, b) => a.until - b.until)[0];
    if (answer) return answer.send ? 'send' : 'drop';
    return c === 'always' ? 'send' : 'hold';
  };
  return {
    decide,
    shouldSend: envelope => decide(envelope) === 'send',
    // Asked after a refusal (or a failed send): keep only what's waiting on a decision, or approved.
    shouldStore: envelope => decide(envelope) !== 'drop',
  };
}

// ---------------------------------------------------------------- the event

/**
 * The same scrub the log gets, over every string in an event: the home folder
 * becomes ~, token-shaped things are cut. The PC's name and any user go too.
 */
function scrubEvent(event, scrub) {
  if (!event || typeof event !== 'object') return event;
  const walk = (v, depth) => {
    if (typeof v === 'string') return scrub(v);
    if (v === null || typeof v !== 'object') return v;
    if (depth > 12) return '[too deep]'; // never let something through unscrubbed
    if (Array.isArray(v)) return v.map(x => walk(x, depth + 1));
    const out = {};
    for (const [k, x] of Object.entries(v)) out[scrub(k)] = walk(x, depth + 1);
    return out;
  };
  const clean = walk(event, 0);
  delete clean.server_name;
  delete clean.user;
  return clean;
}

/** Sentry's integrations, minus the ones Shellby leaves out. */
const keepIntegrations = defaults => defaults.filter(i => !LEFT_OUT.has(i.name));

module.exports = {
  CONSENTS, DSN, LEFT_OUT, dsnFor, normalizeConsent,
  startRun, endRun, previousLogTail, markerFile,
  envelopeTime, makeGate, addDecision, scrubEvent, keepIntegrations,
};
