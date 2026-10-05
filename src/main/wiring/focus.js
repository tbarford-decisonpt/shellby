// Focus sessions (focus.js): a timer, quieter notifications, and the screen
// kept awake while one runs.
// Kept out of main.js, which only wires it up.
const focus = require('../focus');
const streaks = require('../streaks');

/** d: what main shares (main.js `shared`). */
function wireFocus(d) {
  // ---- focus sessions

  const focusState = () => { const v = focus.view(d.config?.get('focus'), Date.now()); return v.phase ? { phase: v.phase, endsAt: v.endsAt, minutes: v.minutes } : null; };
  const focusView = () => ({ ...focus.view(d.config.get('focus'), Date.now()), sessions: d.wardrobe?.stats?.focusSessions || 0 });

  function broadcastFocus() {
    d.send(d.panel, 'focus', focusView());
    d.refreshCritter();
  }

  function startFocus(minutes) {
    if (focus.normalize(d.config.get('focus'))?.phase === 'focus') return focusView();
    d.config.set({ focus: focus.start(Date.now(), Number(minutes)) });
    d.heldNotices = [];
    d.wake();
    scheduleFocus();
    broadcastFocus();
    return focusView();
  }

  // Stop early: no XP, and anything held back is delivered now.
  function stopFocus() {
    const was = focus.normalize(d.config.get('focus'));
    d.config.set({ focus: null });
    scheduleFocus();
    broadcastFocus();
    if (was?.phase === 'focus') deliverHeld('Focus stopped');
    return focusView();
  }

  function deliverHeld(title) {
    const held = d.heldNotices;
    d.heldNotices = [];
    if (!held.length) return;
    const more = held.length > 3 ? ` and ${held.length - 3} more` : '';
    d.notify(`${title}: ${held.length} notification${held.length === 1 ? '' : 's'} waited for you`, `${held.slice(-3).join(' · ')}${more}`.slice(0, 200), () => d.showPanel({ focusInput: false }));
  }

  // One timer for the next phase change, plus a tick to keep the countdown fresh.
  function scheduleFocus() {
    clearTimeout(d.focusTimer);
    clearInterval(d.focusTick);
    const s = focus.normalize(d.config.get('focus'));
    if (!s) return;
    d.focusTimer = setTimeout(advanceFocus, Math.max(0, s.endsAt - Date.now()) + 50);
    d.focusTick = setInterval(() => { d.refreshCritter(); d.refreshStatusLine(); }, 30 * 1000);
  }

  function advanceFocus() {
    const before = focus.normalize(d.config.get('focus'));
    const { session, events } = focus.advance(before, Date.now());
    d.config.set({ focus: session });
    if (events.includes('focus-done')) {
      d.awardXp('focus', { label: `Focused for ${before.minutes} minutes` });
      d.stat('focus-completed');
      recordFocusDay();
      if (!events.includes('break-done')) d.flashState('success', 5000);
      deliverHeld('Focus done');
      d.notify(`Focus done! ${before.minutes} minutes guarded`, `Take ${before.breakMinutes} minutes. Shellby will tell you when the break is over.`, showFocusCard, { tone: 'celebrate' });
    }
    if (events.includes('break-done') && events.length === 1) {
      d.notify("Break's over", 'Ready for another round? Right-click Shellby to start one.', showFocusCard);
    }
    scheduleFocus();
    broadcastFocus();
  }

  function showFocusCard() {
    d.showPanel({ focusInput: false });
    d.send(d.panel, 'panel:view', 'trophies');
  }

  // A finished focus session keeps the streak going, like a finished task.
  function recordFocusDay() {
    if (d.CAPTURE) return;
    d.saveStreaks(streaks.recordWorkDay(d.config.get('streaks'), Date.now()));
  }

  return { advanceFocus, focusState, focusView, startFocus, stopFocus };
}

module.exports = { wireFocus };
