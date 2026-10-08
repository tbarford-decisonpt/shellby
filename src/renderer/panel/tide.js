/* Shellby panel — tide events (src/main/events.js): the banner on the Us page,
   the Bugdex and the shelf while one is on (its countdown, four goals, its
   bug, its two finds and the medal), the line saying what's next when none
   is, the medals on the Us page, and the moment one is finished. Main sends
   the whole view ('events'); nothing here is ever put in as HTML. */
'use strict';
(function () {
  const { h, api, state, $ } = SB;
  const HOUR = 3600000;

  const ev = () => state.events;
  const art = (a, px) => (a?.pixels?.length && a.palette ? SB.Sprite.grid(a.pixels, a.palette, { px }) : null);
  const dayOf = t => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'long' });

  function goalRow(g) {
    return h('li', { class: `ev-goal${g.done ? ' done' : ''}` },
      h('span', { class: 'ev-goal-tick', 'aria-hidden': 'true', text: g.done ? '✓' : '' }),
      h('span', { class: 'ev-goal-text', text: g.text }),
      g.goal > 1 ? h('span', { class: 'ev-goal-n', text: `${g.n}/${g.goal}` }) : null,
      h('span', { class: 'ev-goal-bar', role: 'progressbar', 'aria-label': g.text, 'aria-valuemin': '0', 'aria-valuemax': String(g.goal), 'aria-valuenow': String(g.n) },
        h('i', { style: `width:${Math.round((g.n / g.goal) * 100)}%` })));
  }

  // The full banner: where the event is the point of the page.
  function banner(a, { compact = false } = {}) {
    const done = a.goals.filter(g => g.done).length;
    const urgent = a.lastDay && !a.done;
    return h('div', { class: `ev-card ev-${a.id}${a.done ? ' finished' : ''}${compact ? ' compact' : ''}` },
      h('div', { class: 'ev-head' },
        h('span', { class: 'ev-emoji', 'aria-hidden': 'true', text: a.emoji }),
        h('div', { class: 'ev-titles' },
          h('p', { class: 'ev-eyebrow', text: 'Tide event' }),
          h('h3', { text: `${a.name} ${a.year}` }),
          compact ? null : h('p', { class: 'ev-blurb', text: a.blurb })),
        h('span', { class: `ev-left${urgent ? ' urgent' : ''}`, title: `Until the end of ${dayOf(a.endsAt)}`, text: a.done ? 'Medal won' : a.left })),
      compact ? null : h('p', { class: 'ev-twist', text: a.twist }),
      compact
        ? h('p', { class: 'ev-progress', text: a.done ? 'Every goal done. The medal is yours.' : `${done} of ${a.goals.length} goals done` })
        : h('ul', { class: 'ev-goals', 'aria-label': 'Goals' }, a.goals.map(goalRow)),
      compact ? null : h('div', { class: 'ev-extras' },
        h('div', { class: `ev-bug${a.bug.caught ? ' caught' : ''}`, title: a.bug.rule },
          h('span', { class: 'ev-thumb', 'aria-hidden': 'true' }, art(a.bug, 4)),
          h('span', {}, h('b', { text: a.bug.caught ? a.bug.name : `${a.bug.name}?` }), h('small', { text: a.bug.caught ? 'In a jar, for good' : a.bug.rule }))),
        ...a.finds.map(f => h('div', { class: `ev-find${f.found ? ' found' : ''}` },
          h('span', { class: 'ev-thumb', 'aria-hidden': 'true' }, art(f, 4)),
          h('span', {}, h('b', { text: f.found ? f.name : '???' }), h('small', { text: f.found ? 'On the shelf' : 'Only dug up this week' })))),
        h('div', { class: `ev-medal${a.done ? ' won' : ''}`, title: a.done ? `${a.name} ${a.year}: yours` : 'Finish every goal while it’s on' },
          h('span', { class: 'ev-thumb', 'aria-hidden': 'true' }, art(a.medal, 5)),
          h('span', {}, h('b', { text: a.done ? 'Medal won' : 'The medal' }), h('small', { text: a.done ? 'Only this year’s, for good' : 'Every goal, while it’s on' })),
          a.done ? h('button', { type: 'button', class: 'btn ghost slim-btn', dataset: { shareMoment: '1' }, onclick: () => shareMedal(a) }, '📸 Share') : null)));
  }

  function nextLine(n) {
    return h('p', { class: 'ev-next' }, h('span', { 'aria-hidden': 'true', text: `${n.emoji} ` }), `Next tide event: `, h('b', { text: n.name }), `, ${n.when}.`);
  }

  function render() {
    const v = ev();
    for (const box of document.querySelectorAll('[data-ev-banner]')) {
      const where = box.dataset.evBanner; // 'us' shows it all; the rest a line
      if (!v || !v.on) { box.hidden = true; box.replaceChildren(); continue; }
      if (v.active) {
        box.hidden = false;
        box.replaceChildren(banner(v.active, { compact: where !== 'us' }));
      } else if (where === 'us' && v.next) {
        box.hidden = false;
        box.replaceChildren(nextLine(v.next));
      } else { box.hidden = true; box.replaceChildren(); }
    }
    renderMedals(v);
  }

  function renderMedals(v) {
    const box = $('usMedals');
    if (!box) return;
    const list = v?.on ? v.medals || [] : [];
    box.hidden = !list.length;
    $('usMedalCount').textContent = list.length ? SB.plural(list.length, 'medal') : '';
    $('usMedalList').replaceChildren(...list.map(m => h('li', { class: 'ev-medal-slot', tabindex: '0', title: m.name, 'aria-label': `${m.name} medal` },
      art(m, 4), h('span', { text: `${m.emoji} ${m.year}` }))));
  }

  function shareMedal(m) {
    const name = m.name.endsWith(String(m.year)) ? m.name : `${m.name} ${m.year}`;
    SB.momentCard.share('medal', {
      eyebrow: `${m.emoji} Tide event medal`, title: name, sub: 'Every goal, while it was on.',
      art: { pixels: m.medal?.pixels || m.pixels, palette: m.medal?.palette || m.palette }, accent: '#ffc15e', glints: true,
      badge: 'Only this year’s, for good',
      stats: (m.goals || []).length ? [['goals', `${m.goals.length}/${m.goals.length}`], ['days to spare', String(m.daysLeft ?? 0)]] : [],
    }, {
      title: `${name} medal`,
      alt: `The ${name} medal, a pixel emblem on a starry card`,
      post: `${m.emoji} Finished ${name} with my Shellby. Every goal, while it was on. A pixel hermit crab that runs Claude Code on my desktop.`,
    });
  }

  function apply(v) {
    if (!v) return;
    state.events = v;
    render();
  }

  // Finished: the medal card in the panel, with a share button on it.
  api.onEventFinished(m => {
    if (!m?.name) return;
    api.getEvents().then(apply).catch(() => {});
    SB.celebrate({
      eyebrow: 'Tide event finished', icon: m.emoji, title: m.name,
      text: 'Every goal, while it was on. This year’s medal is yours, and its trophy too.',
      rewards: m.pixels ? [{ name: `${m.name} medal`, pixels: m.pixels, palette: m.palette, kind: 'medal' }] : [],
      action: { label: '📸 Share the medal', run: () => shareMedal(m) },
    });
  });

  api.onEvents(apply);
  // The countdown moves on by itself: a look every hour while the panel's up.
  setInterval(() => { if (!document.hidden) api.getEvents().then(apply).catch(() => {}); }, HOUR);
  api.getEvents().then(apply).catch(() => {});
  SB.tide = { render, shareMedal, refresh: () => api.getEvents().then(apply).catch(() => {}) };
})();
