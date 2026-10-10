// Debug mode (debug-mode.js): /debug <what goes wrong> in a conversation.
//
// 1. Claude lists hypotheses and adds logging marked SHELLBY-DEBUG, which
//    posts its lines to this debug session's address (debug-ingest.js).
// 2. When that turn ends the card says "reproduce it now", and the receiver
//    keeps what arrives, shown live on the card.
// 3. Send gives Claude those lines; it fixes from them (or logs more).
// 4. Reproduce again: still broken sends the new lines, It's fixed asks Claude
//    to take the logging out, and Shellby then looks for marked lines left
//    behind (git grep, minus any that were there before it started).
//
// Every message goes only from a button you pressed, into a conversation that
// isn't working. The card is a transcript item swapped in place (the tries
// card's way); the lines arriving update it without touching History.
// Kept out of main.js, which only wires it up.
const crypto = require('crypto');
const dm = require('../debug-mode');
const { DebugIngest } = require('../debug-ingest');

const LIVE_MS = 250;      // the card's line count, at most this often
const GREP_MS = 15000;
const MAX_ENDED = 20;

/**
 * d: what main shares (main.js `shared`).
 * opts.ingest(onLines) (tests) -> { open(token) -> port, close(token), closeAll() };
 * opts.git(cwd, args) -> { ok, out, error }; opts.now().
 */
function wireDebugMode(d, opts = {}) {
  const sessions = new Map(); // id -> session
  const byTab = new Map();    // tabId -> id, while live
  const byToken = new Map();  // token -> id, while the receiver takes its lines
  const now = opts.now || Date.now;
  const git = opts.git || ((cwd, args) => require('../worktrees').git(cwd, args, { timeout: GREP_MS }));
  const ingest = opts.ingest ? opts.ingest(arrived) : new DebugIngest({ onLines: arrived });

  const winOf = tabId => d.tabWindow?.(tabId) || d.panel;
  const tabOf = s => d.manager.tabs.get(s.tabId) || null;

  // ------------------------------------------------------------ the card

  function publish(s) {
    const item = { ...dm.view(s), t: now() };
    try {
      if (d.manager.tabs.has(s.tabId)) d.manager.note(s.tabId, item);
      else if (d.history.get(s.tabId)) d.history.append(s.tabId, item);
    } catch (err) { d.log?.info(`debug mode: ${err.message}`); }
    return item;
  }

  let liveTimer = null;
  const pending = new Set();
  function liveSoon(s) {
    pending.add(s.id);
    if (liveTimer) return;
    liveTimer = setTimeout(() => {
      liveTimer = null;
      for (const id of pending) {
        const x = sessions.get(id);
        if (x) d.send(winOf(x.tabId), 'debug:lines', { tabId: x.tabId, view: dm.view(x) });
      }
      pending.clear();
    }, LIVE_MS);
  }

  // ------------------------------------------------------------ the receiver

  function arrived(token, body) {
    const s = sessions.get(byToken.get(token));
    if (!s || s.phase !== 'recording') return; // only while you're reproducing
    s.rec = dm.keep(s.rec, dm.linesFrom(body, now()));
    liveSoon(s);
  }

  function letGo(s) {
    if (byToken.get(s.token) === s.id) byToken.delete(s.token);
    try { ingest.close(s.token); } catch { /* already closed */ }
    if (byTab.get(s.tabId) === s.id) byTab.delete(s.tabId);
    // Finished ones are kept a while, for a replayed card's status.
    const ended = [...sessions.values()].filter(x => !dm.LIVE.has(x.phase));
    for (const old of ended.slice(0, Math.max(0, ended.length - MAX_ENDED))) sessions.delete(old.id);
  }

  // ------------------------------------------------------------ marked lines

  const GREP = ['-c', 'core.quotepath=off', 'grep', '-n', '-z', '-I', '--untracked', '--no-color', '-F', '-e', dm.MARKER];

  async function inRepo(cwd) {
    const r = await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return r.ok && r.out.trim() === 'true';
  }

  // Marked lines now, minus the ones there before. null: couldn't look (not a git repo).
  async function marked(s) {
    if (!s.git) return null;
    const r = await git(s.cwd, GREP);
    if (r.ok || r.out) return dm.leftovers(r.out, s.baseline);
    // git grep exits 1, saying nothing, when nothing matches.
    return /fatal|error/i.test(r.error || '') ? null : [];
  }

  async function check(s) {
    const left = await marked(s);
    s.checked = left !== null;
    s.left = left || [];
    s.phase = s.left.length ? 'leftovers' : 'done';
    if (s.phase === 'done') letGo(s);
    publish(s);
  }

  // ------------------------------------------------------------ sending

  function say(s, prompt, shown) {
    const tab = tabOf(s);
    if (!tab) return { ok: false, error: 'That conversation is closed.' };
    if (tab.session.busy) return { ok: false, error: 'Let him finish first, then press it again.' };
    let turnId;
    try { turnId = d.manager.send(s.tabId, prompt, { kind: 'user', text: shown }); } catch (err) { return { ok: false, error: err.message }; }
    d.send(winOf(s.tabId), 'tab:sent', { tabId: s.tabId, item: { kind: 'user', text: shown, attachments: [], turnId } });
    d.wake?.();
    return { ok: true };
  }

  // ------------------------------------------------------------ what the panel asks

  /** /debug <bug>. -> { ok, id } | { ok: false, error } */
  async function start(tabId, arg) {
    const tab = d.manager.tabs.get(tabId);
    if (!tab) return { ok: false, error: 'That conversation is closed.' };
    const parsed = dm.parseBug(arg);
    if (parsed.error) return { ok: false, error: parsed.error };
    if (byTab.has(tabId)) return { ok: false, error: 'This conversation is already in debug mode: finish or stop that one first.' };
    if (tab.session.busy) return { ok: false, error: 'Let him finish first, then start debug mode.' };
    // The app runs where the folder is: on another computer, 127.0.0.1 isn't this PC.
    if (d.remoteService?.placeOf(tab.session.cwd)) return { ok: false, error: 'Debug mode needs the app running on this PC, and this folder is on another computer.' };
    const token = crypto.randomBytes(16).toString('hex');
    let port;
    try { port = await ingest.open(token); } catch (err) { return { ok: false, error: `Couldn't start listening for the logging: ${err.message}` }; }
    const cwd = tab.session.cwd;
    const s = {
      id: crypto.randomUUID(), tabId, token, cwd, bug: parsed.bug, phase: 'instrumenting', round: 0,
      rec: { lines: [], dropped: 0 }, left: [], baseline: new Set(), git: false, checked: true, startedAt: now(),
    };
    s.git = await inRepo(cwd);
    if (s.git) {
      const before = await git(cwd, GREP);
      s.baseline = dm.baselineOf(before.out);
    }
    sessions.set(s.id, s);
    byTab.set(tabId, s.id);
    byToken.set(token, s.id);
    const sent = say(s, dm.startPrompt({ bug: s.bug, url: `http://127.0.0.1:${port}/debug/${token}` }), `${dm.MARK} Debug: ${s.bug}`);
    if (!sent.ok) {
      s.phase = 'ended';
      letGo(s);
      return sent;
    }
    publish(s);
    d.stat?.('debug-start');
    return { ok: true, id: s.id };
  }

  const live = id => {
    const s = typeof id === 'string' ? sessions.get(id) : null;
    return s && dm.LIVE.has(s.phase) ? s : null;
  };

  /** Send what was logged: the first time, or "still broken". */
  function sendLogs(id) {
    const s = live(id);
    if (!s || s.phase !== 'recording') return { ok: false, error: 'There is nothing waiting to send.' };
    const n = s.rec.lines.length + s.rec.dropped;
    const round = s.round + 1;
    const shown = s.round ? `${dm.MARK} Still broken. Here's what was logged (${n} line${n === 1 ? '' : 's'})` : `${dm.MARK} Reproduced it. Here's what was logged (${n} line${n === 1 ? '' : 's'})`;
    const r = say(s, dm.evidencePrompt({ lines: s.rec.lines, dropped: s.rec.dropped, round }), shown);
    if (!r.ok) return r;
    s.round = round;
    s.phase = 'fixing';
    publish(s);
    return { ok: true };
  }

  /** It's fixed: Claude takes the logging out, then Shellby checks. */
  function fixed(id) {
    const s = live(id);
    if (!s || s.phase !== 'recording' || !s.round) return { ok: false, error: 'Send what was logged first.' };
    const r = say(s, dm.cleanupPrompt(), `${dm.MARK} It's fixed. Take the debugging out`);
    if (!r.ok) return r;
    s.phase = 'cleaning';
    publish(s);
    return { ok: true };
  }

  /** Marked lines were left: ask once more. */
  function again(id) {
    const s = live(id);
    if (!s || s.phase !== 'leftovers' || !s.left.length) return { ok: false, error: 'Nothing is left to take out.' };
    const r = say(s, dm.leftoversPrompt(s.left), `${dm.MARK} Some debugging lines are still there. Take them out`);
    if (!r.ok) return r;
    s.phase = 'cleaning';
    publish(s);
    return { ok: true };
  }

  /** Stop: any marked lines still there are listed, and left for you. */
  async function stop(id) {
    const s = live(id);
    if (!s) return { ok: false, error: 'Debug mode has already finished here.' };
    if (s.phase === 'leftovers') {
      s.phase = 'ended';
      letGo(s);
      publish(s);
      return { ok: true };
    }
    const tab = tabOf(s);
    s.phase = 'ended';
    letGo(s);
    // Mid-turn the files are still changing: what's left can't be known yet.
    if (!tab?.session.busy) {
      const left = await marked(s);
      s.left = left || [];
      s.checked = left !== null;
    }
    publish(s);
    return { ok: true };
  }

  /** A turn in a debugging conversation ended (wiring/timetrack.js onResult). */
  async function turnEnded(tabId) {
    const s = live(byTab.get(tabId));
    if (!s) return;
    if (s.phase === 'instrumenting' || s.phase === 'fixing') {
      s.phase = 'recording';
      s.rec = { lines: [], dropped: 0 };
      publish(s);
    } else if (s.phase === 'cleaning') {
      await check(s);
    }
  }

  /** A replayed card asks: still going? -> its view, or null once Shellby has forgotten it. */
  function status(id) {
    const s = typeof id === 'string' ? sessions.get(id) : null;
    return s ? dm.view(s) : null;
  }

  // The conversation closed: nothing more can be reproduced into it.
  function tabClosed(tabId) {
    const s = live(byTab.get(tabId));
    if (!s) return;
    s.phase = 'ended';
    letGo(s);
  }

  function shutdown() {
    try { ingest.closeAll(); } catch { /* quitting anyway */ }
  }

  return { start, sendLogs, fixed, again, stop, turnEnded, status, tabClosed, shutdown };
}

module.exports = { wireDebugMode };
