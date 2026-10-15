/* Shellby panel — bug nests, at the top of the Bugdex. A species that keeps
   turning up in one project has a nest there (src/main/bugdex/nests.js): each
   gets a ring that fills toward clearing once it's caught and stays away, and
   the species fought more than once list their past fix reports. The view
   comes through api.getGame('nests') and the 'game' event; nothing here is
   ever put in as HTML. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  const RING_R = 15;
  const RING_C = 2 * Math.PI * RING_R;
  const MAX_RIVALS = 6;
  let view = null;

  function ring(n) {
    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('viewBox', '0 0 36 36');
    svg.setAttribute('class', 'bd-nest-ring');
    svg.setAttribute('aria-hidden', 'true');
    for (const [cls, dash] of [['track', RING_C], ['fill', RING_C * Math.max(0, Math.min(1, n.progress || 0))]]) {
      const c = document.createElementNS(svgNs, 'circle');
      c.setAttribute('cx', '18');
      c.setAttribute('cy', '18');
      c.setAttribute('r', String(RING_R));
      c.setAttribute('class', cls);
      c.setAttribute('stroke-dasharray', `${dash} ${RING_C}`);
      svg.append(c);
    }
    const t = document.createElementNS(svgNs, 'text');
    t.setAttribute('x', '18');
    t.setAttribute('y', '22');
    t.setAttribute('text-anchor', 'middle');
    t.textContent = '🪺';
    svg.append(t);
    return svg;
  }

  function status(n) {
    if (!n.caught) return `Seen ${n.count}× · catch it to start the ${n.clearDays}-day clock`;
    if (n.daysLeft === 0) return 'Clearing at the next check';
    return `${n.daysLeft} day${n.daysLeft === 1 ? '' : 's'} to clear${n.sealed ? ' · sealed 🔒' : ''}`;
  }

  function nestRow(n) {
    const label = `${n.name}${n.project ? ` in ${n.project}` : ''}`;
    return h('li', { class: `bd-nest${n.caught ? ' caught' : ''}` },
      ring(n),
      h('div', { class: 'bd-nest-text' },
        h('b', { text: label }),
        h('span', { class: 'muted small', text: status(n) }),
        n.generation > 1 ? h('span', { class: 'muted small', text: `Nest #${n.generation}` }) : null),
      h('button', { type: 'button', class: 'link-btn inline', 'aria-label': `See ${n.name} in the Bugdex`, onclick: () => SB.focusBug?.(n.species) }, 'See it'));
  }

  function rivalRow(r) {
    const past = (r.catches || []).map(c => `${SB.bugReport?.letters(c.q) || '–'}${c.held ? '✓' : ''}`).join('  ');
    return h('li', { class: 'bd-rival' },
      h('b', { text: r.name }),
      h('span', { class: 'muted small', text: `${r.project ? `${r.project} · ` : ''}seen ${r.seen}×` }),
      h('span', { class: 'bd-rival-past', title: '🧪 proof · 🎯 first try · 🌱 root cause · 🌊 wider · ✓ held', text: past || 'not caught yet' }));
  }

  function render() {
    const box = $('bdNests');
    if (!box) return;
    const v = view;
    const open = v?.open || [];
    const rivals = (v?.rivals || []).slice(0, MAX_RIVALS);
    box.hidden = !open.length && !rivals.length && !(v?.clearedTotal > 0);
    if (box.hidden) return;
    const rules = v.rules || {};
    box.replaceChildren(
      h('h3', { class: 'bd-section-title', id: 'bdNestsTitle', text: open.length ? `Nests (${open.length})` : 'Nests' }),
      open.length
        ? h('ul', { class: 'bd-nest-list', 'aria-label': 'Open nests' }, open.map(nestRow))
        : h('p', { class: 'muted small', text: 'No nests right now.' }),
      v.clearedTotal > 0 ? h('p', { class: 'muted small bd-nests-cleared', text: `🏅 ${v.clearedTotal} nest${v.clearedTotal === 1 ? '' : 's'} cleared for good.` }) : null,
      h('p', { class: 'muted small bd-nests-note', text: `A nest forms when the same bug turns up ${rules.formCount || 3} times in ${rules.formDays || 30} days in one project. Catch it and keep it away ${rules.clearDays || 14} days to clear it, or ${rules.sealedDays || 7} if a new test sealed it.` }),
      rivals.length ? h('details', { class: 'bd-rivals' },
        h('summary', { text: 'Rematch history' }),
        h('ul', {}, rivals.map(rivalRow))) : null);
  }

  function load() {
    api.getGame?.('nests').then(v => { view = v; render(); }).catch(() => {});
  }

  api.onGame?.(msg => {
    if (!msg || msg.what !== 'nests') return;
    view = msg.view;
    render();
  });
  // Fresh each time the Bugdex comes into view: the rings move with the days.
  const page = $('bugdexView');
  if (page && typeof IntersectionObserver === 'function') {
    new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) load(); }).observe(page);
  }
  load();
  SB.renderNests = render;
})();
