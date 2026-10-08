// Your plan's usage, as Shellby keeps track of it: the limit he naps through
// (limits.js), who spent the window (spend.js), where it's heading
// (forecast.js), and the spending guard that stops unattended runs before they
// eat the share you keep for yourself (guard.js).
// Moved out of main.js; the work held for after a reset is held-service.js.
const os = require('os');
const path = require('path');
const forecast = require('./forecast');
const guard = require('./guard');
const limits = require('./limits');
const spend = require('./spend');
const turncost = require('./turncost');

const SPEND_SAVE_MS = 5000;        // calls come in bursts; one write when they settle
const OUTLOOK_TICK_MS = 60 * 1000; // a forecast goes stale with no new readings
const GUARD_TICK_MS = 30 * 1000;
const RESET_SLACK_MS = 1500;       // look a moment after the reset, not on it
const MAX_TIMER_MS = 2 ** 31 - 1;  // setTimeout's ceiling: a longer wait fires at once
const SAME_RESET_MS = 10 * 60 * 1000;

const clockTime = t => new Date(t).toLocaleString([], { weekday: new Date(t).toDateString() === new Date().toDateString() ? undefined : 'short', hour: 'numeric', minute: '2-digit' });
const sameReset = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < SAME_RESET_MS;

/**
 * d: what this needs from main, read when it's used (most of it is only there
 * once Shellby has booted).
 *   config, panel, manager, workflows, recapLog, history, usagePlan: getters
 *   send, notify, showPanel, refreshCritter, flashState, tellChannel, sayText,
 *   markActive (he's just been busy), routines (the saved list), heldViews
 *   (held-service.js), log, every (main's cleared-on-quit interval),
 *   powerMonitor (Electron's), sendEveryWindow (optional: the panel and every
 *   popped-out conversation, wiring/popouts.js)
 */
function createUsage(d) {
  // ---- the limit: when your plan's limit is reached Shellby naps until it
  // resets, then wakes up and taps you (see limits.js).

  let limitTimer = null;
  const limitWait = () => (limits.status(d.config?.get('limitWait'), Date.now()) === 'waiting' ? limits.normalize(d.config.get('limitWait')) : null);

  function onUsage(u) {
    const hit = limits.limitFrom(u, Date.now());
    const saved = limits.normalize(d.config.get('limitWait'));
    if (hit) {
      if (saved?.resetsAt === hit.resetsAt) return;
      d.config.set({ limitWait: hit });
      scheduleLimit();
      d.refreshCritter();
      const name = limits.windowName(hit.window);
      d.send(d.panel, 'limit', { phase: 'hit', ...hit, name, at: clockTime(hit.resetsAt) });
      d.notify(`Your ${name} Claude limit is reached`, `Shellby will nap and tap you when it resets, ${clockTime(hit.resetsAt)}.`, () => d.showPanel({ focusInput: false }));
    } else if (saved && limits.cleared(u)) {
      d.config.set({ limitWait: null }); // lifted early (e.g. extra usage)
      scheduleLimit();
      d.refreshCritter();
    }
  }

  function scheduleLimit() {
    clearTimeout(limitTimer);
    const w = limitWait();
    if (w) limitTimer = setTimeout(checkLimit, Math.min(w.resetsAt - Date.now() + RESET_SLACK_MS, MAX_TIMER_MS));
  }

  // Runs at the reset time, after the PC wakes up, and at startup.
  function checkLimit() {
    const raw = d.config.get('limitWait');
    const st = limits.status(raw, Date.now());
    if (st === 'waiting') return scheduleLimit();
    d.config.set({ limitWait: null });
    d.refreshCritter();
    sendOutlook();
    if (st !== 'reset') return;
    const name = limits.windowName(limits.normalize(raw).window);
    d.markActive();
    d.flashState('refreshed', 6500);
    d.tellChannel({ kind: 'limit' });
    d.send(d.panel, 'limit', { phase: 'reset', name });
    d.notify(`Your ${name} Claude limit just reset`, "Shellby's awake and ready. Anything you queued can go now.", () => d.showPanel());
  }

  // ---- who used it (spend.js): the meters' breakdown by tab, routine and project

  let spendLedger = null;
  let spendSaveTimer = null;

  // A folder as the ledgers key it: { project (its name), pk (its full path, lowercased) }.
  function projectKeyOf(dir) {
    const full = dir ? path.resolve(dir) : null;
    const pk = full?.toLowerCase() || null;
    const project = !full ? null : pk === path.resolve(os.homedir()).toLowerCase() ? 'Home folder' : path.basename(full);
    return { project, pk };
  }

  // A tab's copy counts for the project it was copied from.
  function spendSource(tab) {
    const { project, pk } = projectKeyOf(tab.worktree?.originalCwd || tab.session?.cwd || '');
    if (tab.routineId) {
      // A routine renamed or deleted mid-run still counts as that routine.
      const routine = d.routines().find(r => r.id === tab.routineId);
      return { key: `r:${tab.routineId}`, kind: 'routine', label: routine?.name || tab.title.replace(/^⟳\s*/, ''), project, pk };
    }
    if (tab.workflowRunId) {
      // Counted per workflow, not per run, so an hourly one is one line on the meter.
      const name = tab.title.replace(/^⚡\s*/, '');
      return { key: `w:${name.toLowerCase()}`, kind: 'workflow', label: name, project, pk };
    }
    return { key: `t:${tab.id}`, kind: 'tab', label: tab.title, project, pk };
  }

  function onSpend(s, tab) {
    spendLedger ??= spend.normalize(d.config.get('spendLedger'));
    spendLedger = spend.record(spendLedger, spendSource(tab), s.weight, Date.now());
    d.usagePlan?.onSpend(tab, s.weight); // and towards what this turn cost (turncost.js)
    if (!spendSaveTimer) spendSaveTimer = setTimeout(saveSpend, SPEND_SAVE_MS);
  }

  function saveSpend() {
    clearTimeout(spendSaveTimer);
    spendSaveTimer = null;
    if (spendLedger) d.config.set({ spendLedger });
  }

  function usageBreakdown() {
    spendLedger ??= spend.normalize(d.config.get('spendLedger'));
    const u = d.config.get('lastUsage') || {};
    const now = Date.now();
    return Object.keys(spend.WINDOW_MS).map(window => {
      const resetsAt = u[window]?.resetsAt;
      const since = spend.windowStart(window, resetsAt, now);
      // A reading from before the last reset says nothing about this window.
      const current = Number.isFinite(resetsAt) && resetsAt > now;
      return {
        window, name: limits.windowName(window), pct: current ? u[window].pct ?? null : null,
        tasks: spend.breakdown(spendLedger, since, 'task'),
        projects: spend.breakdown(spendLedger, since, 'project'),
      };
    });
  }

  // ---- what a turn or a tab cost (turncost.js): a share of the current 5-hour window

  /** A share of the 5-hour window, in percent: `weight`, or all a source spent in it (key). Null with no current reading. */
  function windowShare({ weight = null, key = null } = {}) {
    spendLedger ??= spend.normalize(d.config.get('spendLedger'));
    const w = d.config.get('lastUsage')?.fiveHour;
    const now = Date.now();
    if (!w || !Number.isFinite(w.pct) || !(w.resetsAt > now)) return null;
    const since = spend.windowStart('fiveHour', w.resetsAt, now);
    const spent = key ? spend.weightSince(spendLedger, since, key) : weight;
    return turncost.windowShare({ weight: spent, windowWeight: spend.weightSince(spendLedger, since), windowPct: w.pct });
  }

  /** The context menu's running total for one tab: tokens so far, its share of the window, the costliest turns. */
  function tabCost(tabId) {
    const tab = d.manager?.tabs.get(tabId);
    if (!tab) return null;
    const total = turncost.tabTotal(tab.saved ? d.history.load(tabId) : []);
    const share = windowShare({ key: spendSource(tab).key });
    return {
      tokens: total.tokens, tokensText: turncost.compact(total.tokens), read: total.read, turns: total.turns,
      share, shareText: turncost.shareText(share),
      top: total.top.map(t => ({ turnId: t.turnId, prompt: t.prompt, tokensText: turncost.compact(t.tokens), shareText: turncost.shareText(t.share) })),
    };
  }

  // ---- the forecast (forecast.js)

  let lastOutlook = '';

  // When "after the reset" is: the limit you're held at, else the 5-hour window's
  // next reset as last reported. null until Claude Code has said.
  function resetTarget(now = Date.now()) {
    const w = limitWait();
    if (w) return w.resetsAt;
    const r = d.config.get('lastUsage')?.fiveHour?.resetsAt;
    return Number.isFinite(r) && r > now ? r : null;
  }

  // Everything the panel shows about where the window's heading and what's waiting on it.
  function outlookView() {
    const now = Date.now();
    const o = forecast.outlook(d.recapLog, now);
    const w = limitWait();
    const resetAt = resetTarget(now);
    const warn = !!o?.warn && d.config.get('forecast') !== false && !w;
    return {
      pace: o ? { pct: o.pct, perHour: o.perHour, hitAt: o.hitAt, hitText: clockTime(o.hitAt), resetsAt: o.resetsAt, warn } : null,
      warning: warn ? { text: forecast.message(o, now, clockTime), resetsAt: o.resetsAt } : null,
      limit: w ? { window: w.window, name: limits.windowName(w.window), resetsAt: w.resetsAt, at: clockTime(w.resetsAt) } : null,
      resetAt, resetText: resetAt ? clockTime(resetAt) : null,
      held: d.heldViews(),
      keepAwake: d.config.get('queueKeepAwake') !== false,
    };
  }

  // A popped-out conversation's queue banner reads the outlook too ("Send after the reset").
  const toEveryWindow = (channel, payload) => (d.sendEveryWindow ? d.sendEveryWindow(channel, payload) : d.send(d.panel, channel, payload));

  function sendOutlook() {
    if (!d.config) return;
    const view = outlookView();
    lastOutlook = JSON.stringify(view);
    toEveryWindow('outlook', view);
  }

  // A new reading: show the forecast, and the first time a window's pace says
  // it'll run out before the reset, say so (once per window).
  function refreshOutlook() {
    sendOutlook();
    if (d.config.get('forecast') === false || limitWait()) return;
    const now = Date.now();
    const o = forecast.outlook(d.recapLog, now);
    if (!o?.warn || sameReset(d.config.get('forecastWarned'), o.resetsAt)) return;
    d.config.set({ forecastWarned: o.resetsAt });
    d.log.info('Usage forecast', `${o.pct}% at ${o.perHour}%/h: full ~${new Date(o.hitAt).toISOString()}, resets ${new Date(o.resetsAt).toISOString()}`);
    d.sayText(`At this pace we run dry around ${clockTime(o.hitAt)}.`, 'forecast');
    if (d.panel?.isVisible() && d.panel.isFocused()) return; // the panel's banner says it
    d.notify('Heading for your 5-hour limit', `${forecast.message(o, now, clockTime)} You can hold work for after the reset.`, () => d.showPanel());
  }

  // The forecast lapses when readings stop, and the reset passes: keep the panel current.
  function watchOutlook() {
    d.every(() => {
      if (!d.config || !d.panel || d.panel.isDestroyed()) return;
      const view = outlookView();
      const json = JSON.stringify(view);
      if (json !== lastOutlook) { lastOutlook = json; toEveryWindow('outlook', view); }
    }, OUTLOOK_TICK_MS).unref?.();
  }

  // ---- the spending guard (guard.js): unattended runs stop before they eat
  // the share of the 5-hour window you keep for yourself, and a routine that
  // runs far too long stops too.

  const guardSettings = () => guard.settingsOf(k => d.config.get(k));

  // Each turn as it starts: what kind of unattended run it is, by who sent it
  // (sessions.js turnFrom). What you type yourself, even in a routine's or a
  // workflow's tab, is yours. A run you started by hand (Run now, a manual
  // workflow run) is never stopped on the ceiling: only a routine's time cap
  // still applies to it.
  // A task queued for the reset counts as yours: you queued it to spend that
  // window, overnight, in whatever mode you picked, so the ceiling and the
  // "you've walked away" rule don't stop it (the limit itself still does).
  function armGuard(tab) {
    const { routine, workflow, queued } = tab.turnFrom || {};
    const kind = routine ? 'routine' : workflow ? 'workflow' : null;
    const byHand = queued ? true : routine ? routine.reason === 'manual' : !!workflow && d.workflows?.originOf(workflow.runId) === 'manual';
    tab.guardRun = { kind, startedAt: Date.now(), exempt: byHand, stopped: null };
  }

  function idleForGuard() {
    try {
      return d.powerMonitor.getSystemIdleState(60) === 'locked' ? Infinity : d.powerMonitor.getSystemIdleTime() * 1000;
    } catch (err) {
      // Unreadable idle time counts as "at the keyboard": the guard errs toward not stopping you.
      d.log.warn('idle time unreadable for the spending guard', err?.message);
      return 0;
    }
  }

  // On each usage reading and every half minute: stop any run the guard says
  // should stop. Autonomous is read off the tab now, not when the turn started,
  // so switching into it mid-turn counts.
  function checkGuards() {
    if (!d.manager || !d.config) return;
    const settings = guardSettings();
    if (!settings.on) return;
    const now = Date.now();
    const usage = d.config.get('lastUsage');
    let idleMs = null;
    for (const [tabId, tab] of d.manager.tabs) {
      const run = tab.guardRun;
      if (!run || run.stopped || !d.manager.isBusy(tabId)) continue;
      const kind = run.kind || (tab.session.mode === 'autonomous' ? 'autonomous' : null);
      if (!kind) continue;
      if (kind === 'autonomous' && idleMs === null) idleMs = idleForGuard();
      const v = guard.verdict({ ...run, kind }, settings, { usage, now, idleMs: idleMs ?? 0 });
      if (!v) continue;
      run.stopped = v;
      d.log.info('Spending guard stopped a run', `${tab.title}: ${v.reason}${v.pct ? ` at ${v.pct}%` : ''}`);
      d.manager.interrupt(tabId);
      const m = guard.message(v, tab.title, settings, clockTime);
      d.notify(m.title, m.body, () => d.showPanel({ tabId }), { tone: 'problem' });
    }
  }

  function watchGuards() {
    setInterval(checkGuards, GUARD_TICK_MS).unref?.();
  }

  // Quitting: the reset tap mustn't fire into a half-torn-down app.
  function stop() {
    clearTimeout(limitTimer);
  }

  return {
    armGuard, checkGuards, checkLimit, clockTime, guardSettings, limitWait, onSpend, onUsage,
    outlookView, projectKeyOf, refreshOutlook, resetTarget, saveSpend, scheduleLimit, sendOutlook, spendSource,
    stop, tabCost, usageBreakdown, watchGuards, watchOutlook, windowShare,
  };
}

module.exports = { createUsage, clockTime, OUTLOOK_TICK_MS, GUARD_TICK_MS, SPEND_SAVE_MS };
