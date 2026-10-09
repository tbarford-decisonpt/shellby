/* Shellby panel — Crew, a tab of Shellby's screen: one lasting helper crab per
   agent type, each with a name, a hat, a level and a record of its runs. Main
   keeps the roster (src/main/crew-roster.js, wiring/crew.js) and sends it whole. */
'use strict';
(function () {
  const { h, api, state, $, plural } = SB;
  const DOCK_MAX = 9; // crabs on the dock; the rest are in the roster below
  let view = null;
  let open = null; // the type whose drawer is open

  const when = t => (t ? SB.relTime(t) : 'never');
  const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');

  function crab(m, px) {
    const svg = SB.Sprite.build(state.skin, { px, accessories: m.accessories || [], fit: true });
    svg.style.filter = `hue-rotate(${m.hue}deg) saturate(1.1)`;
    return svg;
  }

  // ------------------------------------------------------------ the dock
  // The highest level stands in the middle, the rest spread out to either side.
  function dockOrder(members) {
    const out = [];
    members.slice(0, DOCK_MAX).forEach((m, i) => (i % 2 ? out.unshift(m) : out.push(m)));
    return out;
  }

  function renderDock(members) {
    const dock = $('crewDock');
    dock.hidden = !members.length;
    dock.replaceChildren(...dockOrder(members).map(m => h('button', {
      type: 'button', class: 'cr-dock-crab', title: `${m.name}, level ${m.level} ${m.type}`,
      'aria-label': `${m.name}, level ${m.level} ${m.type}: show record`,
      onclick: () => show(m.type),
    }, crab(m, 3), h('span', { class: 'cr-dock-name', text: m.name }), h('span', { class: 'cr-dock-lv', text: m.level }))));
  }

  // ------------------------------------------------------------ the roster
  function stat(n, label) {
    return h('div', { class: 'cr-stat' }, h('b', { text: n }), h('span', { text: label }));
  }

  function hatPicker(m) {
    const choice = (hat, label, art, { locked = null } = {}) => h('button', {
      type: 'button', dataset: { focus: `hat:${hat}` }, class: `cr-hat${locked ? ' locked' : ''}`, 'aria-pressed': String(m.hat === hat),
      disabled: !!locked, title: locked ? `${label}: reach level ${locked}` : label, 'aria-label': locked ? `${label}, unlocks at level ${locked}` : label,
      onclick: async () => apply(await api.setCrewHat(m.type, hat)),
    }, art, locked ? h('span', { class: 'cr-hat-lv', text: `Lv ${locked}` }) : null);
    const pixels = (item, dark) => (item ? SB.Sprite.grid(item.pixels, dark ? Object.fromEntries(Object.keys(item.palette).map(k => [k, '#2b4650'])) : item.palette, { px: 3, ink: true }) : h('span', { text: '?' }));
    return h('div', { class: 'cr-hats', role: 'group', 'aria-label': `${m.name}'s hat` },
      choice('auto', 'Best earned', h('span', { class: 'cr-hat-word', text: 'Best' })),
      ...view.ladder.map(l => choice(l.id, l.item?.name || l.id, pixels(l.item, l.level > m.level), { locked: l.level > m.level ? l.level : null })),
      choice('match', 'Same as Shellby', h('span', { class: 'cr-hat-word', text: 'His' })),
      choice('none', 'No hat', h('span', { class: 'cr-hat-word', text: 'None' })));
  }

  function renameRow(m) {
    const input = h('input', { type: 'text', class: 'field cr-rename', dataset: { focus: 'name' }, value: m.name, spellcheck: 'false', autocomplete: 'off', maxlength: '24', 'aria-label': `Rename ${m.name}` });
    const save = async () => {
      const name = input.value.trim();
      if (!name || name === m.name) { input.value = m.name; return; }
      apply(await api.renameCrew(m.type, name));
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } if (e.key === 'Escape') { input.value = m.name; input.blur(); } });
    input.addEventListener('change', save);
    input.addEventListener('blur', () => { if (stale) setTimeout(render); }); // what came in while you typed
    return h('label', { class: 'cr-field' }, h('span', { text: 'Name' }), input);
  }

  function recentList(m) {
    if (!m.recent.length) return null;
    return h('ul', { class: 'cr-recent', 'aria-label': 'Latest runs' }, m.recent.map(r => h('li', { class: r.ok ? '' : 'failed' },
      h('span', { class: 'cr-recent-what', text: r.what || 'A run' }),
      r.actedOn ? h('span', { class: 'cr-acted', text: 'acted on' }) : null,
      !r.ok ? h('span', { class: 'cr-failed', text: 'didn’t finish' }) : null,
      h('time', { text: when(r.at) }))));
  }

  function row(m) {
    const next = m.nextXp ? `${m.nextXp - m.xp} XP to level ${m.level + 1}` : 'Top level';
    const hatNote = m.nextHat ? `Hat (a new one at level ${m.nextHat.level})` : 'Hat (every one earned)';
    const drawer = h('details', { class: 'cr-more', open: open === m.type, ontoggle: e => { open = e.target.open ? m.type : (open === m.type ? null : open); } },
      h('summary', { dataset: { focus: 'drawer' }, text: 'Name, hat and latest runs' }),
      renameRow(m),
      h('p', { class: 'cr-field-label', text: hatNote }),
      view.hatsOn ? hatPicker(m) : h('p', { class: 'muted small', text: 'Helper hats are off (Outfits → Options).' }),
      recentList(m));
    return h('li', { class: 'cr-row', id: `crew-${m.type}`, dataset: { type: m.type } },
      h('div', { class: 'cr-face', 'aria-hidden': 'true' }, crab(m, 2)),
      h('div', { class: 'cr-who' },
        h('h3', { text: m.name }),
        h('p', { class: 'cr-type' }, h('code', { text: m.type }), ` ${m.title}`),
        bugsLine(m)),
      h('span', { class: 'cr-lv', title: `Level ${m.level}`, 'aria-label': `Level ${m.level}` }, m.level),
      h('div', { class: 'cr-bar', role: 'progressbar', 'aria-label': next, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(Math.round(m.progress * 100)), 'aria-valuetext': `Level ${m.level}, ${next}` },
        h('i', { style: `transform: scaleX(${m.progress})` })),
      h('p', { class: 'cr-next', text: `${next}. Last out ${when(m.lastAt)}.` }),
      h('div', { class: 'cr-stats' },
        stat(m.runs, m.runs === 1 ? 'run' : 'runs'),
        stat(m.actedOn, 'acted on'),
        stat(pct(m.completed, m.runs), 'finished'),
        stat(SB.compact(m.tokens) || '0', 'tokens')),
      drawer);
  }

  // Bug battles (bugdex/battle.js): the bugs it helped beat, and the type it's best against.
  function bugsLine(m) {
    if (!m.beaten) return null;
    const t = m.specialty && state.bugdex?.types?.find(x => x.id === m.specialty);
    return h('p', { class: 'cr-bugs' },
      `🫙 ${plural(m.beaten, 'bug')} beaten`,
      t ? h('span', { class: 'cr-specialty', style: /^#[0-9a-f]{6}$/i.test(t.color) ? `--type:${t.color}` : null, title: `Super effective against ${t.label} bugs`, text: `${t.label} specialist` }) : null);
  }

  function show(type) {
    open = type;
    render();
    const el = document.getElementById(`crew-${type}`);
    el?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el?.querySelector('summary')?.focus();
  }

  // ------------------------------------------------------------ the page
  let stale = false; // a new roster came in while a name was being typed

  // Where the keyboard was in the list (which member, which control), to put it back after a redraw.
  function focusSpot() {
    const el = document.activeElement;
    const row = el?.closest?.('#crewList .cr-row');
    return row && el.dataset.focus ? { type: row.dataset.type, focus: el.dataset.focus } : null;
  }

  function render() {
    if (!view || !state.skin) return;
    // Redrawing would throw away what's being typed: wait for the box to let go.
    if (document.activeElement?.classList?.contains('cr-rename')) { stale = true; return; }
    stale = false;
    const spot = focusSpot();
    const { members, totals } = view;
    $('crewCount').textContent = members.length || '';
    $('crewEmpty').hidden = members.length > 0;
    if (!members.length) $('crewEmptyCrab').replaceChildren(SB.Sprite.build(state.skin, { px: 3, fit: true }));
    $('crewTotals').hidden = !members.length;
    $('crewTotals').textContent = `${plural(totals.members, 'crew member')}, ${plural(totals.runs, 'run')} between them, ${totals.actedOn} acted on.`;
    renderDock(members);
    $('crewList').replaceChildren(...members.map(row));
    if (spot) [...$('crewList').querySelectorAll('.cr-row')].find(r => r.dataset.type === spot.type)?.querySelector(`[data-focus="${spot.focus}"]`)?.focus();
  }

  function apply(v) {
    if (!v) return;
    view = v;
    if (state.view === 'crew') render();
  }

  api.onCrew(apply);
  // Shellby's own hat changed: "same as Shellby" follows it.
  api.onWardrobe(() => { if (state.view === 'crew') api.getCrew().then(apply); });

  SB.views.crew = { render: () => { render(); api.getCrew().then(v => { view = v; render(); }); } };
})();
