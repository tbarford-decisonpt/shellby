/* Shellby panel — Health: live vitals, drives, sensor setup and alert settings.
   This file holds the snapshot from main, the hero, the porthole, the alert
   settings and log, and the live updates. The gauges are health-gauges.js,
   fans, drives, clutter and sensors health-drives.js, and what's using the
   machine and starts with Windows health-hogs.js; the words and numbers are
   health-logic.js's. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const L = window.ShellbyHealthLogic;
  const MIN = 60 * 1000;
  const HISTORY_MAX = 720;           // matches the monitor's hour of 5 s samples

  let view = null;                   // last snapshot from main (see health/service.js view())
  let history = [];
  let fx = null;
  let saveTimer = null;
  const drawn = {};                  // section -> signature of what it shows now

  const levelOf = id => view?.checks?.[id]?.level || 'ok';
  const pendingOf = id => view?.checks?.[id]?.pending || null;
  const setText = (el, text) => { if (el.textContent !== text) el.textContent = text; };
  const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
  // Rebuild a section only when what it shows has changed, so a 5 s sample
  // doesn't throw away a focused button or make a screen reader start over.
  const changed = (name, sig) => (drawn[name] === sig ? false : ((drawn[name] = sig), true));

  // Shared with the screen's other files, which add their parts to it as they
  // load (health-gauges.js, health-drives.js, health-hogs.js).
  const H = SB.health = {
    view: () => view, history: () => history,
    levelOf, pendingOf, setText, smooth, changed, ask: checkId => ask(checkId),
  };

  // ------------------------------------------------------------ hero

  function renderHero() {
    const hero = $('hlHero');
    const mood = view?.settings?.moods === false ? null : view?.mood;
    const off = view && !view.settings?.enabled;
    hero.dataset.level = off ? 'off' : view?.worst || 'ok';
    $('hlLive').classList.toggle('on', !!view?.running);
    $('hlEnable').hidden = !off;
    const words = L.heroWords(view);
    $('hlAsk').hidden = !words.ask;
    if (words.ask) {
      $('hlAsk').dataset.check = words.ask.check;
      setText($('hlAsk'), words.ask.text);
    }
    // The hero is a live region: only touch it when the words change.
    setText($('hlEyebrow'), words.eyebrow);
    setText($('hlTitle'), words.title);
    setText($('hlSub'), words.sub);
    fx?.set(mood?.mood || null);
  }

  function renderCrab() {
    // fit:false keeps the sprite's view box on the crab itself, which the
    // health overlays are positioned against (hats just overflow upwards).
    $('hlSprite').replaceChildren(SB.sprite(state.skin, { fit: false }));
    if (!fx) fx = window.ShellbyHealthFx.mount($('hlFx'), $('hlHero'));
    renderPorthole();
  }

  // ------------------------------------------------------------ the porthole

  // A window into his real tank (tank.js, tank-paint.js): the floor, the back
  // glass and whatever stands nearest his spot, painted once, still. He and
  // his mood effects stay on top as before, at --px, so they scale together.
  // An empty tank looks just as this always has.
  const PORTHOLE_PX = 4;   // css px per art pixel, as --px on .has-porthole
  const CRAB_LIFT = 14;    // css px, .hl-crab's bottom
  const FOCUS_AT = 0.28;   // his favourite piece stands to his left, not behind him
  function renderPorthole(v = SB.tankView?.()) {
    const box = $('hlHero').querySelector('.hl-tank');
    const P = SB.tankPaint;
    let canvas = box.querySelector('.hl-porthole');
    const show = !!(P && v && v.pieces.length);
    box.classList.toggle('has-porthole', show);
    if (!show) { canvas?.remove(); box.style.removeProperty('--px'); return; }
    if (!box.dataset.watched) { // a narrow panel changes its size: paint it again at the new one
      box.dataset.watched = '1';
      new ResizeObserver(() => { if (state.view === 'health') renderPorthole(); }).observe(box);
    }
    if (!canvas) {
      canvas = h('canvas', { class: 'hl-porthole', 'aria-hidden': 'true' });
      box.prepend(canvas);
    }
    const dpr = window.devicePixelRatio || 1;
    // Whole device pixels a pixel, as near --px as they come (exact at 100–200%),
    // and he and his moods take the same scale, so they stand on the floor.
    const K = Math.max(1, Math.round(PORTHOLE_PX * dpr));
    box.style.setProperty('--px', `${K / dpr}px`);
    const cssW = box.clientWidth || 148, cssH = box.clientHeight || 112;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    const scene = P.resolve(v.layout, v);
    const artW = canvas.width / K;
    const ox = Math.max(0, Math.min(scene.world.w - artW, v.focusX - artW * FOCUS_AT));
    const oy = scene.world.crabY + 1 - (cssH - CRAB_LIFT) * dpr / K;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(K, 0, 0, K, -Math.round(ox * K), -Math.round(oy * K));
    P.paint(ctx, scene, { still: true, gauges: SB.tankGauges?.current() || null });
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  document.addEventListener('sb:tank', e => { if (state.view === 'health') renderPorthole(e.detail); });
  document.addEventListener('sb:tank-gauges', () => { if (state.view === 'health') renderPorthole(); }); // the water takes his mood

  // ------------------------------------------------------------ settings + log

  function renderSettings() {
    const st = view?.settings || {};
    $('hlEnabledToggle').checked = !!st.enabled;
    $('hlMoodsToggle').checked = !!st.moods;
    $('hlNotifyToggle').checked = !!st.notify;
    $('hlSpaceToggle').checked = !!st.space;
    $('hlNotifyToggle').closest('label').title = state.settings.notifications ? '' : 'Notifications are off in Settings';
    for (const input of $('hlThresholds').querySelectorAll('input')) {
      if (document.activeElement !== input) input.value = st[input.dataset.key] ?? '';
    }
    setText($('hlSettingsSum'), L.settingsSummary(view));
  }

  function renderLog() {
    const log = view?.log || [];
    $('hlClearLog').hidden = !log.length;
    // Times are relative, so the list is redrawn once a minute at most.
    if (!changed('log', `${log.length}|${log[0]?.at}|${Math.floor(Date.now() / MIN)}`)) return;
    if (!log.length) {
      $('hlLog').replaceChildren(h('li', { class: 'hl-empty', text: "No alerts yet. Shellby's keeping an eye out." }));
      return;
    }
    $('hlLog').replaceChildren(...log.slice(0, 15).map(e => {
      const { up, where } = L.logEntry(e);
      const inner = [
        h('span', { class: 'hl-logdot', 'aria-hidden': 'true' }),
        h('span', { class: 'hl-logtitle', text: e.title }),
        h('time', { text: SB.relTime(e.at), title: new Date(e.at).toLocaleString() }),
      ];
      return h('li', { class: `hl-logrow ${up ? e.to : 'recovered'}` }, where
        ? h('button', { class: 'hl-logbtn', type: 'button', title: `Show ${where}`, onclick: () => H.showAlert(e) }, inner)
        : inner);
    }));
  }

  function renderBadge() {
    const b = $('healthBadge');
    const worst = view?.settings?.enabled ? view.worst : 'ok';
    b.hidden = !worst || worst === 'ok';
    b.classList.toggle('critical', worst === 'critical');
    b.classList.toggle('warn', worst === 'warn');
  }

  function render() {
    renderBadge();
    if (state.view !== 'health') return;
    renderHero();
    H.renderSelf();
    H.renderHogs();
    H.renderGauges();
    H.renderFans();
    H.renderDisks();
    H.renderSpace();
    H.renderSources();
    renderSettings();
    renderLog();
  }

  // ------------------------------------------------------------ actions

  async function ask(checkId) {
    const r = await api.askAboutHealth(checkId);
    if (r?.needsClaude) return SB.claudeUpsell('health');
    if (!r?.ok) return SB.toast(r?.error || "Couldn't start that.");
    SB.setView('chat');
    SB.toast('Shellby is looking into it');
  }

  async function save(patch) {
    view = await api.setHealth(patch);
    render();
  }

  $('hlAsk').addEventListener('click', e => ask(e.currentTarget.dataset.check));
  $('hlAskSpace').addEventListener('click', () => ask('reclaim'));
  $('hlEnable').addEventListener('click', () => save({ enabled: true }));
  $('hlRecheck').addEventListener('click', async () => { view = await api.recheckHealth(); render(); SB.toast('Checked every sensor again'); });
  $('hlCheckLhm').addEventListener('click', async () => {
    view = await api.recheckHealth();
    render();
    const st = view.sources?.lhm;
    SB.toast(st === 'ok' ? 'Found it! CPU temperature is on.' : st === 'auth' ? 'LHM wants a password; turn off its authentication.' : `Nothing answering on port ${view.settings.lhmPort} yet.`);
  });
  // Hand the whole LHM setup to Claude. The box is filled in, not sent: it runs
  // winget and an elevated program, so you see what you're agreeing to first.
  $('hlClaudeLhm').addEventListener('click', () => {
    if (SB.isCrabOnly()) return SB.claudeUpsell('lhm');
    const port = view?.settings?.lhmPort || 8085;
    SB.prefillNew([
      'Set up LibreHardwareMonitor so Shellby can read my CPU temperature from its local web server.',
      '1. If it isn\'t installed, install it with `winget install --id LibreHardwareMonitor.LibreHardwareMonitor -e --accept-source-agreements --accept-package-agreements`, then find where LibreHardwareMonitor.exe ended up.',
      `2. Make sure LHM isn't running, then in LibreHardwareMonitor.config (next to the exe; run LHM once and close it if the file isn't there yet) turn on the remote web server on port ${port} with no authentication, and set it to start minimized to the tray. Read the file first and use the setting names it already has.`,
      '3. Start it as administrator (`Start-Process -Verb RunAs`); I\'ll accept the Windows prompt.',
      `4. Check that http://127.0.0.1:${port}/data.json answers, and tell me if anything needs me to click something in LHM.`,
      'Ask me before making LHM run at Windows startup.',
    ].join('\n') + '\n');
  });
  $('hlGetLhm').addEventListener('click', () => api.openExternal('https://github.com/LibreHardwareMonitor/LibreHardwareMonitor/releases/latest'));
  $('hlPort').addEventListener('change', e => save({ lhmPort: Number(e.target.value) }));
  $('hlEnabledToggle').addEventListener('change', e => save({ enabled: e.target.checked }));
  $('hlMoodsToggle').addEventListener('change', e => save({ moods: e.target.checked }));
  $('hlNotifyToggle').addEventListener('change', e => save({ notify: e.target.checked }));
  $('hlSpaceToggle').addEventListener('change', e => save({ space: e.target.checked }));
  $('hlThresholds').addEventListener('input', e => {
    const input = e.target.closest('input[data-key]');
    if (!input || input.value === '') return;
    clearTimeout(saveTimer);
    // Debounced, and the main process clamps to the allowed range.
    saveTimer = setTimeout(() => save({ [input.dataset.key]: Number(input.value) }), 500);
  });
  $('hlThresholds').addEventListener('focusout', () => renderSettings());
  $('hlClearLog').addEventListener('click', async () => { view = await api.clearHealthLog(); render(); });

  // ------------------------------------------------------------ live updates

  api.onHealth(snap => {
    // Live samples carry no history, only the point this sample added to main's.
    const { point, ...rest } = snap;
    view = { ...view, ...rest, history: undefined };
    if (point && point.at !== history[history.length - 1]?.at) {
      history.push(point);
      if (history.length > HISTORY_MAX) history.splice(0, history.length - HISTORY_MAX);
    }
    render();
  });
  api.onHealthLog(log => { if (view) { view.log = log; if (state.view === 'health') renderLog(); } });

  async function load() {
    view = await api.getHealth();
    // Keep any live points that arrived while this was on its way.
    const base = view.history || [];
    const last = base[base.length - 1]?.at ?? -Infinity;
    history = [...base, ...history.filter(p => p.at > last)].slice(-HISTORY_MAX);
    render();
  }

  SB.views.health = {
    render: () => {
      renderCrab();
      api.healthViewed();
      load();
      H.loadStartup();
    },
  };
  SB.refreshHealthCrab = () => { if (state.view === 'health') renderCrab(); };
  // The titlebar badge needs a first reading even if the view is never opened.
  setTimeout(() => api.getHealth().then(v => { view = v; history = v.history || []; renderBadge(); }), 1500);
})();
