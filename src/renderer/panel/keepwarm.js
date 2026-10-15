/* Shellby panel — Keep warm (main's keepwarm-service.js): the mug in the tab
   strip, its countdown and tooltip, and the dim line a ping leaves. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  let view = { on: false, endsAt: null, tabs: [] };

  // 2h41m, or 41m under the hour.
  const left = ms => {
    const m = Math.max(0, Math.ceil(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`;
  };

  function draw() {
    const btn = $('keepWarmBtn');
    btn.classList.toggle('on', view.on);
    btn.setAttribute('aria-pressed', String(view.on));
    $('keepWarmLeft').hidden = !view.on;
    if (view.on) $('keepWarmLeft').textContent = `Warm · ${left(view.endsAt - Date.now())}`;
    btn.title = view.on
      ? ['Keeping warm while you\'re away (click to stop)', ...view.tabs.map(t => `${t.title} · ${t.line}`)].join('\n')
      : "Keep warm while you're away";
  }
  const take = v => { if (v && typeof v.on === 'boolean') { view = v; draw(); } };

  api.onKeepWarm(take);
  api.keepWarmGet().then(take).catch(() => {});
  $('keepWarmBtn').addEventListener('click', async () => {
    const r = await api.keepWarmSet(!view.on);
    take(r);
    if (r?.ok === false && r.error) SB.toast(r.error);
  });
  setInterval(() => { if (view.on) draw(); }, 30 * 1000); // the countdown

  SB.keepWarm = { view: () => view };
  // The line a ping (or a stop) leaves in its conversation (feed.js 'keepwarm').
  SB.renderKeepWarm = (feed, item) => feed.append(h('div', { class: `home-mark keepwarm-mark${item.warm ? '' : ' stopped'}` },
    h('span', { class: 'chg-icon', 'aria-hidden': 'true', text: '☕' }), item.text));

  // A ping's turn ends with its receipt, not a result (main's sessions.js ping): the tab
  // isn't working any more, and anything you queued meanwhile goes now. A drop line
  // without endsTurn can land mid-turn of yours, so it leaves the turn alone.
  // SB.onTurnEnded and SB.syncBusyUi are defined elsewhere, so they're looked up when called.
  SB.onKeepWarmItem = (tab, item) => {
    if (!item.endsTurn) return;
    tab.busy = false;
    SB.onTurnEnded(tab, { ok: true });
    SB.syncBusyUi();
  };
})();
