// Keep warm (docs/plans/keep-warm.md): while it's on, every conversation with a
// warm one-hour cache gets one tiny message shortly before that cache would
// expire, so the first message after lunch reads the conversation from the
// cache instead of writing it all again. keepwarm.js has the rules; this runs
// them against the open tabs, keeps the PC awake and tells the panel.
const kw = require('./keepwarm');

/**
 * d: what this needs from main, read when it's used.
 *   manager, panel: getters
 *   log, send, powerSaveBlocker (Electron's), CAPTURE
 *   leadMs: dev and e2e only, how long before expiry a ping goes (SHELLBY_KEEPWARM_LEAD_MS)
 *   now, setInterval, clearInterval, setTimeout, clearTimeout: tests bring their own clock
 */
function createKeepWarm(d) {
  const now = d.now || Date.now;
  const every = d.setInterval || setInterval;
  const stopEvery = d.clearInterval || clearInterval;
  const lead = d.leadMs || kw.LEAD_MS;
  let on = null;           // { endsAt, left } while it's on
  let timer = null;
  let blocker = null;      // the powerSaveBlocker's id while it's on
  let lastPlan = [];
  // tabId -> { state: 'kept' | 'dropped', reason, lastPing: { at, read } | null, coldOnce: its last ping found it cold }
  const kept = new Map();
  const inFlight = new Set();
  const isWarm = p => p.action === 'ping' || p.action === 'wait';

  function tabsNow() {
    return [...d.manager.tabs.values()].map(t => ({
      id: t.id, title: t.title, saved: !!t.saved, inTerminal: !!t.inTerminal,
      hasProc: !!t.session.proc, busy: !!t.session.busy, pending: t.session.pending.size,
      crew: t.session.runningCrew().length, size: t.session.context?.tokens || 0, cache: t.session.cache || null,
    }));
  }

  function view() {
    return {
      on: !!on, endsAt: on ? on.endsAt : null,
      tabs: on ? lastPlan.map(p => ({ id: p.id, title: p.title, line: kw.tabLine(p, kept.get(p.id)) })) : [],
    };
  }
  function push() { d.send(d.panel, 'keepwarm', view()); }

  function arm() {
    if (on) return { ok: true, ...view() };
    const t = now();
    kept.clear();
    lastPlan = kw.plan(tabsNow(), kept, t, lead);
    const warm = lastPlan.filter(isWarm);
    if (!warm.length) return { ok: false, error: `Nothing to keep warm: no conversation of ${kw.tokensText(kw.MIN_KEEP_TOKENS)} or more has a warm one-hour cache.`, ...view() };
    for (const p of warm) kept.set(p.id, { state: 'kept', reason: null, lastPing: null });
    on = { endsAt: t + kw.MAX_MS, left: false };
    timer = every(tick, kw.TICK_MS);
    timer?.unref?.();
    // A laptop asleep at lunch pings nothing (held-service.js does the same for the reset queue).
    if (!d.CAPTURE) blocker = d.powerSaveBlocker.start('prevent-app-suspension');
    d.log.info('Keep warm on', `${warm.length} conversation${warm.length === 1 ? '' : 's'}`);
    tick();
    return { ok: true, ...view() };
  }

  function stop(why) {
    if (!on) return { ok: true, ...view() };
    on = null;
    stopEvery(timer);
    timer = null;
    if (blocker !== null) { d.powerSaveBlocker.stop(blocker); blocker = null; }
    // What it was keeping counts as just used: its last ping may be most of an
    // hour ago, and idle stop would end those processes the minute you're back.
    for (const [id, k] of kept) if (k.state === 'kept') d.manager.touch?.(id);
    kept.clear();
    d.log.info('Keep warm off', why);
    push();
    return { ok: true, ...view() };
  }

  // endsTurn: the line ends a ping's turn in the panel (boot.js). A tick's own
  // drop doesn't: that tab may be in the middle of a turn of yours.
  function drop(id, reason, endsTurn = false) {
    if (on) kept.set(id, { state: 'dropped', reason, lastPing: null });
    d.manager.note(id, { kind: 'keepwarm', warm: false, endsTurn, at: now(), text: kw.stoppedText(reason) });
  }

  async function ping(id) {
    inFlight.add(id);
    let r = null;
    // One hung ping must not hold up every other tab: past the lead time it's interrupted,
    // which ends its turn (sessions.js kills a process that won't wind down), so the promise settles.
    let timedOut = false;
    const fuse = (d.setTimeout || setTimeout)(() => { timedOut = true; d.manager.interrupt(id); }, kw.LEAD_MS);
    fuse?.unref?.();
    try { r = await d.manager.ping(id, kw.PING_TEXT); } catch { /* it took up work of its own meanwhile: the next tick looks again */ }
    (d.clearTimeout || clearTimeout)(fuse);
    inFlight.delete(id);
    if (!d.manager.tabs.has(id)) { tick(); return; } // closed meanwhile: it just leaves, with no line
    if (!r && !timedOut) return;
    const v = timedOut ? { warm: false, reason: 'the ping got no reply' } : kw.receipt(r);
    const k = kept.get(id);
    // A cold ping wrote the cache back, so the next one should read it (a process's
    // second turn rewrites part of its first): only two cold in a row drop the tab.
    if (!v.warm && !(v.cold && !k?.coldOnce)) drop(id, v.reason, true);
    else {
      const at = now();
      if (on && k) kept.set(id, { ...k, coldOnce: !!v.cold, lastPing: { at, read: v.read } });
      const wrote = v.cold ? v.wrote : null; // what a cold one wrote is said; a warm one's few k aren't
      d.manager.note(id, { kind: 'keepwarm', warm: true, endsTurn: true, at, read: v.read, ...(v.cold ? { wrote } : {}), text: kw.keptText(at, v.read, wrote) });
    }
    tick(); // the next due tab, if any: one ping at a time
  }

  function tick() {
    if (!on) return;
    const t = now();
    if (t >= on.endsAt) { stop('3 hours are up'); return; }
    for (const id of [...kept.keys()]) if (!d.manager.tabs.has(id)) kept.delete(id); // closed: just gone
    const tabs = tabsNow();
    lastPlan = kw.plan(tabs, kept, t, lead);
    for (const p of lastPlan) {
      if (p.action === 'drop') drop(p.id, p.reason);
      else if (isWarm(p) && !kept.has(p.id)) kept.set(p.id, { state: 'kept', reason: null, lastPing: null }); // warmed up since
      // One at a time (ping() ticks again when it's done), and never the same tab twice
      // in a row: its cache was just read, whatever the stamp says.
      const k = kept.get(p.id);
      const recent = k?.lastPing && t - k.lastPing.at < kw.LEAD_MS;
      if (p.action === 'ping' && !inFlight.size && !recent) ping(p.id);
    }
    // Every tab it kept is dropped or closed, and none is working that could warm up
    // again: nothing to do but keep the PC awake.
    const keeping = [...kept.values()].some(k => k.state === 'kept');
    if (!keeping && !tabs.some(x => x.busy || x.pending || x.crew)) { stop('nothing left to keep warm'); return; }
    push();
  }

  return {
    set: want => (want ? arm() : stop('turned off')),
    view,
    isKept: id => !!on && kept.get(id)?.state === 'kept',
    userSent: () => { if (on) stop('you sent a message'); },
    // Each idle reading away-service.js takes: the first short one after a long one means you're back.
    reading: r => {
      if (!on) return;
      const w = kw.watchBack(on.left, r);
      on.left = w.left;
      if (w.back) stop("you're back");
    },
    tick,
  };
}

module.exports = { createKeepWarm };
