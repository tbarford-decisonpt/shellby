/* Shellby panel — focus sessions: the Focus card on Time, and the
   Ctrl+K commands. Main owns the timer (src/main/focus.js); this only shows it. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  let ticker = null;

  const clock = ms => {
    const s = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  function render() {
    const v = state.focus;
    if (!v) return;
    const card = $('focusCard');
    card.className = `focus-card${v.phase ? ` on ${v.phase}` : ''}`;
    const done = v.sessions ? `${v.sessions} finished` : '';
    $('focusClock').hidden = !v.phase;
    clearInterval(ticker);
    if (v.phase) {
      const tick = () => { $('focusClock').textContent = clock(v.endsAt - Date.now()); };
      tick();
      ticker = setInterval(tick, 1000);
    }
    if (v.phase === 'focus') {
      $('focusTitle').textContent = 'Guarding your focus';
      $('focusSub').textContent = `Helmet on for ${v.minutes} minutes. Notifications that can wait are held back; Shellby still taps you if a task needs your OK.`;
      $('focusActions').replaceChildren(h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: stop }, 'Stop early'));
    } else if (v.phase === 'break') {
      $('focusTitle').textContent = 'Break time';
      $('focusSub').textContent = `Nice work. Stretch, get some water. ${done ? `${done}.` : ''}`;
      $('focusActions').replaceChildren(h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: stop }, 'Skip the break'));
    } else {
      $('focusTitle').textContent = 'Guard my focus';
      $('focusSub').textContent = `Shellby puts his helmet on and holds back notifications that can wait. A finished session earns XP and keeps your streak.${done ? ` ${done} so far.` : ''}`;
      $('focusActions').replaceChildren(...v.lengths.map(m => h('button', {
        type: 'button', class: `btn slim-btn${m === 25 ? ' primary' : ''}`, onclick: () => start(m),
      }, `${m} min`)));
    }
  }

  async function start(minutes) {
    apply(await api.startFocus(minutes));
    SB.toast(`Guarding your focus for ${minutes} minutes ⛑️`);
  }
  async function stop() { apply(await api.stopFocus()); }

  function apply(v) {
    if (!v) return;
    state.focus = v;
    if (state.view === 'time') render();
  }

  // Ctrl+K: start a session, or stop the one that's running.
  SB.focusCommands = () => {
    const v = state.focus;
    if (v?.phase) return [{ icon: '⛑️', title: v.phase === 'focus' ? 'Stop guarding my focus' : 'Skip the break', sub: `${clock(v.endsAt - Date.now())} left`, keys: 'focus pomodoro timer stop', run: stop }];
    return (v?.lengths || [25]).map(m => ({ icon: '⛑️', title: `Guard my focus for ${m} minutes`, sub: 'Helmet on, notifications held back', keys: 'focus pomodoro timer deep work', run: () => start(m) }));
  };

  api.onFocus(apply);
  const renderTime = SB.views.time.render;
  SB.views.time.render = () => { renderTime(); render(); };
  api.getFocus().then(apply);
})();
