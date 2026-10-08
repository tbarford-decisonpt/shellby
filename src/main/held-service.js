// What's held for after the usage reset (held.js): messages, routine runs and
// queued tasks, sent one at a time once the window rolls over, with the PC
// kept awake while any of it waits.
// Moved out of main.js; the limit and forecast it waits on are usage/service.js.
const path = require('path');
const held = require('./held');
const recap = require('./recap');
const { isModel } = require('./models');
const worktrees = require('./worktrees');

const MAX_TIMER_MS = 2 ** 31 - 1;      // setTimeout's ceiling: a longer wait fires at once
const HELD_STAGGER_MS = 5000;          // one after another, not all at once
const HELD_BUSY_RETRY_MS = 60 * 1000;  // its conversation is still working: try again shortly
const HELD_SETTLE_MS = 45 * 1000;      // how long to wait for word on the window between held messages
const HELD_SETTLE_STEP_MS = 500;
const QUEUE_WATCH_MS = 20 * 1000;      // how often a running queued task is checked on, in case its end goes unheard
const MAX_TASK_CHARS = 50000;

// The first message of a task that was started before and is still queued:
// the window ran dry partway, or Shellby closed while it worked.
const QUEUE_CARRY_ON = 'This task was cut off partway through (the usage limit ran out, or Shellby was closed), and your usage window has reset since. Carry on from where you stopped and finish it. If it was already finished, say so briefly and recap what you did.';

const pause = ms => new Promise(r => setTimeout(r, ms));

/**
 * d: what this needs from main, read when it's used.
 *   config, panel, manager, history, claudeStatus: getters
 *   tabWindow(tabId): optional, the window a tab is shown in (the panel, or its own: wiring/popouts.js)
 *   CAPTURE, graceMs (how long after the reset held work goes),
 *   log, send, notify, showPanel, tellChannel, wake, openTab, sendToTab, noteRecap (away-service.js),
 *   currentCwd, isFolder, isStr, dialogLook, confirm ({ ask }), randomUUID,
 *   powerSaveBlocker (Electron's), worktreeHome, adoptPhoneTab (wiring/phone-tasks.js),
 *   from usage/service.js: limitWait, resetTarget, clockTime, sendOutlook,
 *   from routines/service.js: routines, routinesView, runRoutine, makeRoomForRoutine
 */
function createHeldQueue(d) {
  const queueTabs = new Map();       // tabId -> held task id, for tasks queued for the reset
  const queueWaits = new Map();      // tabId -> resolve(how its turn ended), while the queue waits on it
  let heldTimer = null;
  let releasing = false;
  let keepAwakeId = null;

  const heldList = () => held.normalize(d.config.get('held'), Date.now());

  function saveHeld(list) {
    d.config.set({ held: list });
    scheduleHeld();
    syncKeepAwake();
    d.sendOutlook();
    d.send(d.panel, 'routines', d.routinesView()); // routines show their own "after the reset"
  }

  // Queued tasks are mostly for overnight, and a PC that falls asleep at 1am
  // runs nothing at 3. While one waits or runs, Windows is asked not to sleep
  // when idle (the screen still turns off). A lid shut or Sleep chosen still
  // wins: the queue then goes when the PC wakes (powerMonitor 'resume').
  function syncKeepAwake() {
    if (!d.config || d.CAPTURE) return;
    const want = d.config.get('queueKeepAwake') !== false && (queueWaits.size > 0 || heldList().some(h => h.kind === 'task'));
    if (want && keepAwakeId === null) {
      keepAwakeId = d.powerSaveBlocker.start('prevent-app-suspension');
      d.log.info('Keeping the PC awake for the reset queue');
    } else if (!want && keepAwakeId !== null) {
      d.powerSaveBlocker.stop(keepAwakeId);
      keepAwakeId = null;
      d.log.info('Reset queue empty: the PC may sleep again');
    }
  }

  function heldView(h) {
    const base = { id: h.id, kind: h.kind, at: h.at, atText: d.clockTime(h.at) };
    if (h.kind === 'message') return { ...base, tabId: h.tabId, text: h.text, attachments: h.attachments };
    if (h.kind === 'routine') return { ...base, routineId: h.routineId, name: h.name };
    return {
      ...base, name: h.name, prompt: h.prompt, cwd: h.cwd, folder: h.cwd ? path.basename(h.cwd) : null, mode: h.mode, model: h.model || '',
      tabId: h.tabId, running: !!h.tabId && queueWaits.has(h.tabId),
      // Started before and still here: it ran dry partway (or Shellby restarted), and carries on.
      resuming: !!h.tabId && !queueWaits.has(h.tabId),
    };
  }

  const heldViews = () => heldList().map(heldView);

  /** Hold a message or a routine run for after the reset. raw: { kind, ... } from held.js. */
  function holdForReset(raw) {
    const at = d.resetTarget();
    // A window seen before and since run out: you're on a fresh one already.
    if (!at && raw.kind === 'task' && d.config.get('lastUsage')?.fiveHour) return { ok: false, idle: true, error: "There's no 5-hour window running to wait for, so it would just start now. Run it as a normal task instead." };
    if (!at) return { ok: false, error: "Shellby doesn't know when your window resets yet. He finds out with your next message." };
    const res = held.hold(heldList(), { ...raw, at: at + d.graceMs }, Date.now());
    if (res.error) return { ok: false, error: res.error };
    const added = res.list.length > heldList().length;
    if (added) saveHeld(res.list);
    return { ok: true, id: res.item.id, at: res.item.at, atText: d.clockTime(res.item.at), added };
  }

  /**
   * "Run it when my limit resets": a task from the Routines page's queue.
   * input: { prompt, cwd?, mode? }. Autonomous is only allowed once you've
   * acknowledged it, and asked about each time: it runs while you sleep.
   */
  async function queueTask(input) {
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!prompt) return { ok: false, error: 'Say what Shellby should do.' };
    if (prompt.length > MAX_TASK_CHARS) return { ok: false, error: 'That task is too long to queue (50,000 characters at most).' };
    const cwd = d.isStr(input.cwd) ? input.cwd : d.currentCwd();
    if (!d.isFolder(cwd)) return { ok: false, error: "That folder doesn't exist any more." };
    const mode = held.TASK_MODES.includes(input.mode) ? input.mode : null;
    if (mode === 'autonomous') {
      if (!d.config.get('autonomousAcknowledged')) return { ok: false, error: 'Turn on Autonomous in Settings first.' };
      const response = await d.confirm.ask(d.panel, {
        ...d.dialogLook(), icon: '🌙', danger: true,
        title: 'Queue an Autonomous task?',
        message: "It runs after your usage resets, likely while you're away, and won't ask before it acts.",
        detail: `Folder: ${cwd}\n\n${prompt}`,
        note: 'You can cancel it from the queue on the Routines page until it starts.',
        buttons: [{ label: 'Queue it', style: 'danger' }, { label: 'Cancel' }], defaultId: 1, cancelId: 1,
      });
      if (response !== 0) return { ok: false, cancelled: true };
    }
    const model = typeof input.model === 'string' && isModel(input.model) ? input.model : '';
    const res = holdForReset({ kind: 'task', prompt, cwd, mode, model });
    if (res.ok) d.log.info('Task queued for the reset', `${held.taskName(prompt)} at ${res.atText}`);
    return res;
  }

  function scheduleHeld() {
    clearTimeout(heldTimer);
    const at = held.next(heldList());
    if (at === null) return;
    heldTimer = setTimeout(() => releaseHeld().catch(err => d.log.warn('Held release failed', err.message)), Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS));
  }

  // After a held message goes, wait to hear how the window looks (a usage
  // reading, or the limit) before the next: if the reset wasn't the one that
  // mattered (the weekly window is full too), the rest mustn't all go and fail.
  async function heardSince(t) {
    for (let waited = 0; waited < HELD_SETTLE_MS; waited += HELD_SETTLE_STEP_MS) {
      if (!d.config || d.limitWait() || (d.config.get('lastUsage')?.at || 0) > t) return;
      await pause(HELD_SETTLE_STEP_MS);
    }
  }

  // Due: send what's held, one at a time. Still limited (a reset later than
  // expected, or the weekly window): wait for that reset instead.
  async function releaseHeld() {
    if (releasing || !d.config) return;
    const ready = held.due(heldList(), Date.now());
    if (!ready.length) return scheduleHeld();
    const w = d.limitWait();
    if (w) return saveHeld(held.defer(heldList(), ready.map(h => h.id), w.resetsAt + d.graceMs));
    releasing = true;
    const went = [];
    try {
      for (const [i, h] of ready.entries()) {
        if (i) {
          if (went.length && went[went.length - 1].kind === 'message') await heardSince(went[went.length - 1].sentAt);
          await pause(HELD_STAGGER_MS);
        }
        if (!d.config) return; // quitting
        if (!heldList().some(x => x.id === h.id)) continue; // cancelled in the meantime
        if (d.limitWait()) break; // limited again: the next pass moves the rest to that reset
        let outcome;
        try {
          // A task is waited on until it finishes, so heavy ones go one at a
          // time and whatever the window can't fit waits for the next reset.
          outcome = h.kind === 'routine' ? releaseRoutine(h) : h.kind === 'task' ? await releaseTask(h) : releaseMessage(h);
        } catch (err) {
          // Dropped rather than left due: a failure that repeats would retry forever.
          d.log.warn('Held item failed', err.message);
          outcome = 'failed';
        }
        if (!d.config) return; // quit while a task ran: it carries on next time
        const list = heldList();
        // 'resume': a task that ran dry partway stays queued, and carries on in its conversation.
        if (outcome !== 'resume') d.config.set({ held: outcome === 'retry' ? held.defer(list, [h.id], Date.now() + HELD_BUSY_RETRY_MS) : held.without(list, h.id) });
        d.sendOutlook(); // its chip goes now, not when the whole batch is done
        if (outcome === 'sent') went.push({ ...h, sentAt: Date.now() });
      }
    } finally {
      releasing = false;
      if (d.config) saveHeld(heldList());
    }
    if (!went.length) return;
    const what = held.summary(went);
    d.log.info('Held work released', what);
    d.noteRecap?.(recap.heldEvent(went)); // "sent … after the reset" in the while-you-were-away card
    if (!went.some(h => h.kind === 'task')) return d.notify('Your usage window reset', `Shellby sent ${what}.`, () => d.showPanel());
    const left = heldList().filter(h => h.kind === 'task').length;
    d.notify(left ? 'Shellby got through part of your queue' : 'Your reset queue is done',
      `Shellby got through ${what}.${left ? ` ${left} more wait${left === 1 ? 's' : ''} for the next reset.` : ''}`, () => d.showPanel());
  }

  /**
   * One queued task: started (or carried on in its conversation), then waited
   * on until it ends, and the result sent to your phone. -> 'sent' | 'failed'
   * | 'retry' (its conversation is busy with you) | 'resume' (ran dry partway:
   * stays queued for the next reset).
   */
  async function releaseTask(h) {
    const left = () => heldList().filter(x => x.kind === 'task' && x.id !== h.id).length;
    const project = h.cwd ? path.basename(h.cwd) : '';
    const tell = (status, extra = {}) => d.tellChannel({ kind: 'queue', status, title: h.name, project, left: left(), ...extra });
    const fail = why => {
      d.log.warn('Queued task failed', `${h.name}: ${why}`);
      d.notify(`Queued task didn't run: ${h.name}`, why, () => d.showPanel({ focusInput: false }), { tone: 'problem' });
      tell('error', { body: why });
      return 'failed';
    };
    // A folder on another computer needs Claude Code there, not here (remote/service.js).
    const elsewhere = !!d.remoteService?.placeOf(h.cwd || d.currentCwd());
    if (d.config.get('crabOnly') || (!elsewhere && (!d.claudeStatus?.installed || !d.claudeStatus?.loggedIn))) return fail('Claude Code isn\'t set up and signed in, so it couldn\'t start. Queue it again once it is.');
    if (held.spent(h)) return fail(`It was cut off ${held.MAX_TRIES} times, so Shellby stopped retrying. Its conversation is in History.`);

    const { manager, history } = d;
    const open = h.tabId ? manager.tabs.get(h.tabId) : null;
    if (open && manager.isBusy(h.tabId)) return 'retry'; // you're working in it right now
    const carryOn = !!h.tabId && !!(open || history.get(h.tabId));
    const tabId = carryOn ? h.tabId : d.randomUUID();
    const title = `${h.fromPhone ? '📱' : '🌙'} ${h.name}`;
    const prompt = carryOn ? QUEUE_CARRY_ON : h.prompt;
    const cwd = h.cwd && d.isFolder(h.cwd) ? h.cwd : d.currentCwd();
    // From the phone: in its own copy, as if it had started straight away
    // (wiring/phone-tasks.js), so your checkout stays untouched while you're out.
    let copy;
    try {
      copy = h.fromPhone && !carryOn ? await worktrees.create(cwd, { home: d.worktreeHome(), title }) : null;
    } catch (err) { return fail(err.message); }
    if (copy && !copy.ok) return fail(copy.error);
    let turnId;
    try {
      if (!open) {
        d.makeRoomForRoutine();
        const tab = d.openTab(carryOn ? { tabId, historyEntry: history.get(tabId) }
          : { tabId, cwd: copy ? copy.worktree.cwd : cwd, mode: h.mode, title });
        if (copy) {
          tab.worktree = copy.worktree;
          history.update(tabId, { cwd: copy.worktree.cwd, worktree: copy.worktree });
        }
        if (h.model && !tab.session.proc) tab.session.model = h.model; // before its process starts (--model)
      }
      turnId = manager.send(tabId, prompt, { kind: 'user', text: prompt, title, queued: { id: h.id, name: h.name } });
      if (copy) manager.note(tabId, { kind: 'moved', branch: copy.worktree.branch, base: copy.worktree.base });
      if (h.fromPhone && !carryOn) d.adoptPhoneTab(tabId);
      else if (h.fromPhone && manager.tabs.get(tabId)) manager.tabs.get(tabId).fromPhone = true; // carrying on: noted when it started
      queueTabs.set(tabId, h.id);
      // Saved as soon as it starts: if Shellby closes mid-task, the next pass carries on here.
      d.config.set({ held: held.started(heldList(), h.id, tabId) });
    } catch (err) {
      // A copy made for it would point at nothing: tidy it away, as startTaskInCopy does.
      if (copy?.ok) {
        try {
          if (manager.tabs.has(tabId)) await manager.closeAndWait(tabId);
          if (history.get(tabId)) history.remove(tabId);
          await worktrees.remove(copy.worktree, { force: true });
        } catch (e) { d.log.info(`queued phone task cleanup: ${e.message}`); }
      }
      return fail(err.message);
    }
    const ended = waitForQueued(tabId);
    syncKeepAwake();
    d.sendOutlook();
    d.wake();
    if (open) { const win = d.tabWindow?.(tabId) || d.panel; d.send(win, 'tab:sent', { tabId, item: { kind: 'user', text: prompt, attachments: [], turnId } }); }
    else d.send(d.panel, 'tab:opened', { tabId, entry: history.get(tabId), items: history.load(tabId), background: true, busy: true });
    d.log.info('Queued task started', `${h.name}${carryOn ? ' (carrying on)' : ''}`);

    const end = await ended;
    syncKeepAwake();
    if (!d.config) return 'resume';
    // The limit arrives as a usage reading, separately from the result: an
    // error might be the window running dry before that reading is in.
    if (!end.ok && !end.interrupted && !d.limitWait()) await heardSince(Date.now());
    if (!d.config) return 'resume';
    // Limited now: it most likely ran dry partway. It stays queued and carries
    // on after this reset; if it had in fact finished, the next turn says so.
    const w = d.limitWait();
    if (w && !end.interrupted) {
      tell('paused', { resumeAt: w.resetsAt + d.graceMs, seconds: end.seconds });
      return 'resume';
    }
    const status = end.ok ? 'ok' : end.interrupted ? 'stopped' : 'error';
    tell(status, { body: end.ok ? end.reply : end.closed ? 'Its tab was closed.' : end.error, seconds: end.seconds });
    return end.ok ? 'sent' : 'failed';
  }

  // How a queued task's turn ended: onResult answers, closing its tab answers,
  // and if neither is heard (its process died quietly), finding it idle twice does.
  function waitForQueued(tabId) {
    return new Promise(resolve => {
      let idle = 0;
      const watch = setInterval(() => {
        const gone = !d.manager?.tabs.has(tabId);
        idle = !gone && !d.manager.isBusy(tabId) ? idle + 1 : 0;
        if (gone || idle >= 2) finish({ ok: false, interrupted: gone, closed: gone, error: gone ? null : 'It stopped without saying how it went.' });
      }, QUEUE_WATCH_MS);
      watch.unref?.();
      function finish(end) {
        clearInterval(watch);
        if (queueWaits.get(tabId) === finish) queueWaits.delete(tabId);
        resolve(end);
      }
      queueWaits.set(tabId, finish);
    });
  }

  function releaseRoutine(h) {
    const r = d.routines().find(x => x.id === h.routineId);
    if (!r) return 'dropped'; // deleted while it waited
    // Held only because it came due at the limit, then paused: it stays paused.
    if (h.auto && !r.enabled) return 'dropped';
    const res = d.runRoutine(r, { reason: 'after-reset' });
    if (res.ok) return 'sent';
    if (res.skipped) d.notify(`Routine "${r.name}" didn't run`, res.error);
    return 'failed';
  }

  // Back to its conversation, reopened from History if it was closed. If it
  // can't go, it lands back in that conversation's box rather than vanishing.
  function releaseMessage(h) {
    const open = d.manager.tabs.get(h.tabId);
    if (open?.session.busy) return 'retry';
    if (!open) {
      try {
        reopenForHeld(h);
      } catch (err) {
        d.notify("A held message couldn't be sent", `${err.message} It was: ${h.text.slice(0, 140)}`);
        return 'failed';
      }
    }
    const r = d.sendToTab(h.tabId, h.text, h.attachments);
    if (!open) {
      d.send(d.panel, 'tab:opened', {
        tabId: h.tabId, entry: d.history.get(h.tabId), items: d.history.load(h.tabId), background: true, busy: r.ok,
        ...(r.ok ? {} : { draft: h.text, attachments: h.attachments }),
      });
    } else {
      // The window it's shown in: a popped-out conversation isn't in the panel to take it back.
      const win = d.tabWindow?.(h.tabId) || d.panel;
      if (r.ok) d.send(win, 'tab:sent', { tabId: h.tabId, item: r.item });
      else d.send(win, 'held:returned', { tabId: h.tabId, text: h.text, attachments: h.attachments, error: r.error });
    }
    if (!r.ok) d.notify("A held message couldn't be sent", `${r.error} It's back in its conversation's box.`, () => d.showPanel());
    return r.ok ? 'sent' : 'failed';
  }

  // The conversation a held message belongs to, open again under its own id:
  // from History, or (never sent anything yet) as a fresh tab in its folder.
  function reopenForHeld(h) {
    const entry = d.history.get(h.tabId);
    d.makeRoomForRoutine();
    return d.openTab(entry
      ? { tabId: h.tabId, historyEntry: entry }
      : { tabId: h.tabId, cwd: h.cwd && d.isFolder(h.cwd) ? h.cwd : d.currentCwd(), title: h.title });
  }

  return {
    heldList, heldView, heldViews, holdForReset, queueTabs, queueTask, queueWaits, releaseHeld,
    reopenForHeld, saveHeld, scheduleHeld, syncKeepAwake,
  };
}

module.exports = { createHeldQueue, QUEUE_CARRY_ON, HELD_STAGGER_MS, HELD_BUSY_RETRY_MS };
