// Coming and going: "while you were away" (recap.js) and "is it safe to
// leave?" (leaving.js), with the shutdown guard that holds Windows up while
// work this PC alone has is at risk.
// Moved out of main.js.
const leaving = require('./leaving');
const recap = require('./recap');
const secretscan = require('./secretscan');
const streaks = require('./streaks');

// What finished, failed and used the window is noted as it happens; whether
// you're at the keyboard comes from Windows' idle time, read once a minute and
// on lock, unlock, sleep and wake.
const AWAY_POLL_MS = 60 * 1000;
const LOCKED_AFTER_S = 60;                        // what Windows calls idle enough to read as locked
const LEAVE_RECENT_MS = 14 * 24 * 60 * 60 * 1000; // projects worked in this recently are checked
const LEAVE_REFRESH_MS = 10 * 60 * 1000;
const LEAVE_AFTER_WORK_MS = 30 * 1000;            // a finished turn usually committed or changed something
const LEAVE_FIRST_MS = 90 * 1000;                 // the first look, once boot has settled
const LEAVE_LINES_SHOWN = 12;

/**
 * d: what this needs from main, read when it's used.
 *   config, critter, panel, manager, external, devServers: getters
 *   CAPTURE, RECAP_TEST (dev:away supplies the idle readings),
 *   powerMonitor (Electron's), native (native-windows.js), confirm ({ ask }),
 *   log, send, every (main's cleared-on-quit interval), speak, notify,
 *   showPanel, dialogLook, limitWait (usage-service.js)
 */
function createAway(d) {
  let recapLog = [];
  let away = { since: null };
  let leaveProjects = [];   // the last git check, for the shutdown guard (which can't wait for git)
  let leaveChecking = null; // the check in flight, shared by everyone who asks meanwhile
  let leaveSoon = null;

  // ---- while you were away (recap.js)

  // Stepped away (idle or locked) as of the last reading: the weekly card's
  // "routines worked … while you were away" counts runs that finish now.
  function isAway() { return away.since !== null; }

  function noteRecap(event) {
    if (event) recapLog = recap.record(recapLog, event, Date.now());
  }

  function checkAway({ locked = false, idleMs = null } = {}) {
    if (d.CAPTURE || !d.config) return;
    if (idleMs === null) {
      if (d.RECAP_TEST) return;
      try {
        idleMs = d.powerMonitor.getSystemIdleTime() * 1000;
        // Asked each time rather than tracked from events: a nudge of the mouse
        // on the lock screen, or a wake nobody is there for, still reads as locked.
        locked = locked || d.powerMonitor.getSystemIdleState(LOCKED_AFTER_S) === 'locked';
      } catch (err) {
        d.log.warn('idle time unreadable', err?.message);
        return;
      }
    }
    const r = recap.watch(away, { now: Date.now(), idleMs, locked });
    away = r.state;
    if (r.back) {
      greet(r.back.until - r.back.since);
      welcomeBack(r.back);
    }
  }

  // He runs to the front of his window and waves you back in, both claws once
  // you've been gone a good while. Never a sulk, however long it was.
  function greet(awayMs) {
    if (d.CAPTURE || !d.critter || d.critter.isDestroyed()) return;
    d.send(d.critter, 'critter:greet', { awayMs: Math.max(0, Number(awayMs) || 0) });
  }

  function watchAway() {
    if (d.CAPTURE) return;
    for (const gone of ['lock-screen', 'suspend']) d.powerMonitor.on(gone, () => checkAway({ locked: true }));
    for (const here of ['unlock-screen', 'resume']) d.powerMonitor.on(here, () => checkAway());
    d.every(checkAway, AWAY_POLL_MS);
  }

  // Prompts open right now, in Shellby's tabs and in Claude Code elsewhere.
  function waitingOnYou() {
    const kindOf = items => (items.some(i => i.toolName === 'AskUserQuestion') ? 'question' : items.some(i => i.toolName === 'ExitPlanMode') ? 'plan' : 'approval');
    const own = [...(d.manager?.tabs.values() || [])]
      .filter(t => t.session.pending.size)
      .map(t => ({ tabId: t.id, title: t.title, what: kindOf([...t.session.pending.values()]) }));
    const elsewhere = (d.external?.summary.sessions || [])
      .filter(s => s.state === 'asking')
      .map(s => ({ tabId: null, title: s.where || s.project, what: 'approval', external: true }));
    return [...own, ...elsewhere];
  }

  function welcomeBack({ since, until }) {
    const { panel } = d;
    if (d.config.get('recap') === false || !panel || panel.isDestroyed()) return;
    const digest = recap.build(recapLog, { since, until, waiting: waitingOnYou(), limit: d.limitWait() });
    if (!digest) return;
    d.send(panel, 'recap', digest);
    d.speak('back', { force: true });
    if (panel.isVisible() && panel.isFocused()) return;
    d.notify(`While you were away (${recap.awayFor(digest.awayMs)})`, recap.headline(digest), () => d.showPanel({ focusInput: false }));
  }

  // ---- is it safe to leave? (leaving.js)
  // Unpushed, uncommitted and stashed work in the projects you've been in lately,
  // plus anything still running. Asked from the menu ("Is it safe to leave?" and
  // "Lock the PC", which checks first), and kept fresh in the background so that
  // a shutdown or sign-out can be held up with the reason beside Shellby's name:
  // Windows can't tell an app the screen is about to lock, but it does ask before
  // ending the session.

  function leaveFolders() {
    const now = Date.now();
    const recent = Object.entries(streaks.normalize(d.config.get('streaks')).projects)
      .filter(([, p]) => now - p.lastSeen < LEAVE_RECENT_MS)
      .sort((a, b) => b[1].lastSeen - a[1].lastSeen)
      .map(([key]) => key);
    const tabs = [...(d.manager?.tabs.values() || [])].map(t => t.session?.cwd);
    return [...tabs, ...(d.config.get('recentFolders') || []), ...recent].filter(Boolean);
  }

  // What's in flight right now, in Shellby and in Claude Code elsewhere. Live, so cheap.
  function runningNow() {
    const tabs = [...(d.manager?.tabs.values() || [])];
    const ext = d.external?.summary || { sessions: [], background: [] };
    return {
      working: [
        ...tabs.filter(t => t.session.busy && !t.session.pending.size).map(t => t.title),
        ...(ext.sessions || []).filter(s => s.state === 'working').map(s => s.where || s.project),
      ],
      waiting: waitingOnYou().map(w => w.title),
      background: (ext.background || []).map(b => ({ program: b.program, project: b.project })),
      servers: d.devServers?.runningList() || [],
    };
  }

  // fresh: don't settle for a check that started before you asked (a push you
  // made a moment ago must count), so wait for that one and run another.
  async function checkLeaving({ fresh = false } = {}) {
    if (d.CAPTURE || !d.config) return [];
    if (fresh && leaveChecking) await leaveChecking;
    leaveChecking ||= leaving.check(leaveFolders(), undefined, { scan: secretscan.atRisk })
      .then(projects => { leaveProjects = projects; return projects; })
      .catch(e => { d.log.warn('safe-to-leave check failed', e.message); return leaveProjects; })
      .finally(() => { leaveChecking = null; });
    return leaveChecking;
  }

  // The cached answer, with what's running read fresh.
  const leaveVerdict = () => leaving.verdict(leaveProjects, runningNow());

  function checkLeavingSoon() {
    clearTimeout(leaveSoon);
    leaveSoon = setTimeout(checkLeaving, LEAVE_AFTER_WORK_MS);
  }

  // lock: asked from "Lock the PC". Safe locks straight away; anything at risk is
  // listed first, with the choice to lock anyway or have Claude tidy it up.
  async function leaveCheck({ lock = false } = {}) {
    const v = leaving.verdict(await checkLeaving({ fresh: true }), runningNow());
    if (v.safe && lock) { d.native.lockScreen(); return; }
    const fixable = leaveProjects.find(p => p.ok && leaving.verdict([p]).lines.length);
    const canFix = !v.safe && !!fixable && !d.config.get('crabOnly');
    const buttons = v.safe
      ? [{ label: 'Lock the PC' }, { label: 'Close' }]
      : [{ label: 'Lock anyway', style: 'danger' }, ...(canFix ? [{ label: `Tidy up ${fixable.name}` }] : []), { label: 'Stay' }];
    const cancelId = buttons.length - 1;
    const more = v.lines.length - LEAVE_LINES_SHOWN;
    const response = await d.confirm.ask(d.panel, {
      ...d.dialogLook(), icon: v.safe ? '🐚' : '🧳',
      title: v.safe ? 'Safe to leave' : 'Not quite safe to leave',
      message: v.headline,
      detail: v.lines.slice(0, LEAVE_LINES_SHOWN).join('\n') + (more > 0 ? `\n…and ${more} more` : ''),
      note: v.safe ? '' : 'Locking never loses any of this, but a shutdown or a dead battery can.',
      buttons, defaultId: v.safe ? 0 : cancelId, cancelId,
    });
    if (response === 0) d.native.lockScreen();
    else if (canFix && response === 1) {
      d.showPanel();
      // Never "commit and push everything" past a secret: Claude is told what Shellby found, and to stop there.
      const found = fixable.secrets?.findings.map(secretscan.describe) || [];
      const secrets = found.length
        ? ` Shellby found what look like secrets in work that hasn't gone out yet: ${found.join('; ')}. Don't commit or push those: tell me about them first.`
        : '';
      d.send(d.panel, 'tab:new-in', { cwd: fixable.root, draft: `I'm about to leave my PC. In ${fixable.name}: commit any uncommitted work with clear messages, push every branch that has commits the remote doesn't, and tell me what's in any stashes. Never commit or push a .env file, a key file or anything that looks like a password or API key.${secrets} Ask me before anything destructive.` });
    }
  }

  // Windows asks every window before a shutdown, restart or sign-out. While work
  // is at risk Shellby says no, with the reason, and Windows shows it beside his
  // name with "Shut down anyway". Only for work this PC alone has, or Claude
  // mid-turn (leaving.verdict's hold); never for a critical shutdown or an
  // installer asking apps to close (close-app). With no reason to show (koffi
  // missing), he never holds it up: a nameless "an app is preventing shutdown"
  // would just look broken.
  function guardSessionEnd(win) {
    const { native } = d;
    const release = () => { try { if (!win.isDestroyed()) native.unblockShutdown(native.hwndOf(win)); } catch { /* best effort: the session is ending anyway */ } };
    win.on('query-session-end', e => {
      try {
        const reasons = e.reasons || [];
        const v = leaveVerdict();
        if (d.config.get('leaveGuard') === false || reasons.includes('critical') || reasons.includes('close-app') || !v.hold) { release(); return; }
        if (native.blockShutdown(native.hwndOf(win), `Shellby: ${v.headline}`)) e.preventDefault();
        // What it said may be up to ten minutes old: look again, so the next try is right.
        checkLeaving();
      } catch (err) { d.log.warn('shutdown guard failed', err.message); }
    });
    win.on('session-end', release);
  }

  function watchLeaving() {
    if (d.CAPTURE) return;
    guardSessionEnd(d.critter);
    setTimeout(checkLeaving, LEAVE_FIRST_MS);
    d.every(checkLeaving, LEAVE_REFRESH_MS);
    // Leaving the desk is when the answer matters next: have it ready.
    for (const gone of ['lock-screen', 'suspend']) d.powerMonitor.on(gone, () => checkLeaving());
  }

  return {
    checkAway, checkLeaving, checkLeavingSoon, greet, isAway, leaveCheck, leaveVerdict, noteRecap,
    waitingOnYou, watchAway, watchLeaving,
    // dev:usage backdates readings straight into the log (ipc/progress.js).
    get recapLog() { return recapLog; }, set recapLog(v) { recapLog = v; },
  };
}

module.exports = { createAway, AWAY_POLL_MS, LEAVE_AFTER_WORK_MS };
