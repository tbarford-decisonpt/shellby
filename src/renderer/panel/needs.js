/* Shellby panel — "How he's doing" on the Us page: his tummy, shine, pep and
   cheer, his snacks, and Feed / Rinse / Tuck in (src/main/needs.js, care.js).
   Each meter is ten cells; the cells under his floor are drawn as sand that
   never empties, because he never gets worse than that. together.js calls
   SB.renderNeeds with the life view whenever the Us page draws. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const CELLS = 10;
  const MOOD_TEXT = {
    happy: 'He\'s on top of the world',
    content: 'He\'s doing fine',
    peckish: 'He\'s a bit peckish',
    sandy: 'He\'s a bit sandy',
    sleepy: 'He\'s getting sleepy',
    mopey: 'He\'s missing you a little',
  };
  const DONE = { feed: 'He ate a snack.', rinse: 'Rinsed. Squeaky clean.', tuck: 'Tucked in. He\'ll be up in a few minutes.' };
  const until = t => { const m = Math.max(1, Math.ceil((t - Date.now()) / 60000)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };

  // A rinse or tuck-in on cooldown: nothing else tells the page when it's over,
  // so it asks again then (and every minute meanwhile, for the "Again in" text).
  let cooldownTimer = null;
  function refreshAt(times) {
    clearTimeout(cooldownTimer);
    const next = Math.min(...times.filter(Boolean));
    if (!Number.isFinite(next)) return;
    cooldownTimer = setTimeout(() => {
      if (state.view === 'us') api.getLife().then(SB.applyLife);
    }, Math.max(1000, Math.min(next - Date.now() + 500, 60000)));
  }

  function meter(m) {
    const filled = Math.round(m.value / CELLS);
    const floor = Math.round(m.floor / CELLS);
    return h('li', { class: `us-meter${m.low ? ' low' : ''}`, 'data-need': m.id },
      h('span', { class: 'us-meter-icon', 'aria-hidden': 'true', text: m.icon }),
      h('span', { class: 'us-meter-name', id: `usMeter-${m.id}`, text: m.name }),
      h('span', {
        class: 'us-meter-cells', role: 'meter', 'aria-labelledby': `usMeter-${m.id}`,
        'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(m.value), 'aria-valuetext': m.word,
      }, Array.from({ length: CELLS }, (_, i) => h('i', { class: i < floor ? 'floor' : i < filled ? 'on' : '' }))),
      h('span', { class: 'us-meter-word', text: m.word }));
  }

  function render(v) {
    const sec = $('usNeeds');
    const n = v?.needs;
    sec.hidden = !n?.on;
    if (!n?.on) return;
    $('usNeedsMood').textContent = MOOD_TEXT[n.mood] || '';
    $('usNeedsIntro').hidden = n.introduced;
    $('usNeedsIntroFrom').textContent = SB.isCrabOnly?.() ? 'focus sessions, fixing things in Health, and games' : 'finished tasks, focus sessions and games';
    $('usMeters').replaceChildren(...n.meters.map(meter));

    const feed = document.querySelector('[data-care="feed"]');
    feed.disabled = !n.pantry.total || n.stuffed;
    $('usCareFeed').textContent = n.stuffed ? 'He\'s stuffed' : n.pantry.total ? `${n.pantry.total} snack${n.pantry.total === 1 ? '' : 's'} in the pantry` : 'No snacks yet';
    const rinse = document.querySelector('[data-care="rinse"]');
    rinse.disabled = n.clean || !!n.nextRinseAt;
    $('usCareRinse').textContent = n.clean ? 'He\'s shiny' : n.nextRinseAt ? `Again in ${until(n.nextRinseAt)}` : 'Sand off, shine on';
    const tuck = document.querySelector('[data-care="tuck"]');
    tuck.disabled = n.rested || !!n.nextTuckAt;
    $('usCareTuck').textContent = n.rested ? 'He\'s wide awake' : n.nextTuckAt ? `Again in ${until(n.nextTuckAt)}` : 'A short nap brings his pep back';
    refreshAt([n.nextRinseAt, n.nextTuckAt]);

    $('usPantry').replaceChildren(...(n.pantry.total
      ? n.snacks.filter(s => s.have).map(s => h('li', { class: `us-snack snack-${s.id}`, 'aria-label': `${s.name}: ${s.have}` },
        SB.Sprite.grid(s.pixels, s.palette, { px: 3 }), h('span', { text: `×${s.have}` })))
      : [h('li', { class: 'us-snack-empty', text: `The pantry's empty. It holds ${n.pantry.max}.` })]));
    $('usSources').replaceChildren(...n.sources.map(t => h('li', { text: t })));
  }
  SB.renderNeeds = render;

  async function care(kind) {
    const r = await api.needs[kind]();
    if (r?.life) SB.applyLife(r.life);
    if (!r?.ok) return SB.toast(r?.error || 'He can\'t right now.');
    SB.toast(DONE[kind]);
    if (kind === 'feed') {
      const crab = $('usCrab');
      crab.classList.remove('munching');
      void crab.offsetWidth; // restart the chomp
      crab.classList.add('munching');
    }
  }
  document.querySelectorAll('[data-care]').forEach(b => b.addEventListener('click', () => care(b.dataset.care)));
  $('usCrab').addEventListener('animationend', e => { if (e.animationName === 'us-munch') $('usCrab').classList.remove('munching'); });

  $('usNeedsGotIt').addEventListener('click', () => { api.needs.introSeen(); $('usNeedsIntro').hidden = true; });
  $('usNeedsOff').addEventListener('click', async () => {
    const r = await api.setSettings({ needsOn: false });
    state.settings = r.settings;
    api.needs.introSeen();
    api.getLife().then(SB.applyLife);
    SB.toast('Snacks and naps is off. Turn it back on in Settings.');
  });
})();
