/* Shellby panel — the Bugdex, a tab of Shellby's screen beside Finds: every
   kind of bug Claude has fixed for you, as a pixel creature in a jar. Seen ones
   are silhouettes, caught ones are in colour with their stats, and the ones
   still unfixed in a tab are "on the loose". Main sends the whole page as one
   view (src/main/bugdex.js view()); nothing here is ever put in as HTML. */
'use strict';
(function () {
  const { h, api, state, $, plural } = SB;
  const MINUTE = 60000;
  const SEEN_AFTER_MS = 2500; // a moment to notice what's new, as on the shelf
  const MAX_LOOSE = 6;
  const HEX = /^#[0-9a-f]{3,8}$/i;
  // Why a fix didn't count (src/main/bugdex/cheats.js REASONS: the renderer can't require main files).
  const REASONS = {
    'no-change': 'the code didn’t change',
    revert: 'that just put the code back how it was',
    'deleted-tests': 'a test was deleted',
    skipped: 'a test was skipped',
    suppressed: 'the error was silenced, not fixed',
    'fewer-tests': 'fewer tests ran',
    'snapshots-only': 'the snapshots were just updated',
    'bigger-number': 'a limit was just raised',
    insecure: 'certificate checks were turned off',
    'tests-only': 'only the tests changed',
  };
  const FORMS = {
    'first-try': ['🎯', 'First try'], swift: ['⚡', 'Swift'], golden: ['✦', 'Golden'], nocturnal: ['☾', 'Nocturnal'],
    spectral: ['👻', 'Spectral'], shiny: ['✨', 'Shiny'], 'for-good': ['🛡', 'For good'],
  };
  const LANGS = { js: 'JS', ts: 'TypeScript', py: 'Python', rust: 'Rust', go: 'Go', jvm: 'JVM', cs: 'C#', rb: 'Ruby', php: 'PHP', git: 'Git', ci: 'CI' };
  const STAGE_NAMES = ['', 'I', 'II', 'III', 'Master'];

  let selected = null; // the species whose card is open
  let filter = 'all';  // all, caught, seen, or a habitat id
  let seenTimer = null;

  SB.NAV_SECTION.bugdex = 'wardrobe'; // a tab of the Shellby screen, like Finds

  const dex = () => state.bugdex;
  const num = n => `#${String(n).padStart(3, '0')}`;
  const day = t => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short', year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
  function ago(t) {
    const m = Math.round((Date.now() - t) / MINUTE);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    if (m < 60 * 24) return `${Math.floor(m / 60)} h ago`;
    return `${plural(Math.floor(m / 1440), 'day')} ago`;
  }
  function took(ms) {
    const s = Math.max(1, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
  }
  const times = n => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`);
  const habitatOf = s => dex()?.habitats.find(x => x.id === s.habitat) || null;

  // Its pixels, scaled to fit a box (main has already made seen ones silhouettes).
  const fit = (s, box) => Math.max(2, Math.floor(box / Math.max(s.pixels.length, ...s.pixels.map(r => r.length))));
  const hasArt = s => Array.isArray(s?.pixels) && s.pixels.length > 0 && s.palette;
  const art = (s, box) => SB.Sprite.grid(s.pixels, s.palette, { px: fit(s, box) });
  const unknownArt = () => h('span', { class: 'bd-unknown', 'aria-hidden': 'true', text: '???' });

  // ------------------------------------------------------------ the page
  function render() {
    const v = dex();
    if (!v) return;
    renderHero(v);
    renderLoose(v);
    renderHabitats(v);
    renderFilters(v);
    renderGrid(v);
    renderDetail();
  }

  function renderHero(v) {
    $('bdTotal').textContent = v.seen || v.caught
      ? `${v.caught} of ${v.of} caught · ${v.seen} seen · ${plural(v.jars, 'jar')} filled`
      : 'No bugs in the jars yet';
    const fav = v.species.find(s => s.id === v.favourite && s.state === 'caught' && hasArt(s));
    $('bdFav').replaceChildren(fav
      ? h('div', { class: `fd-fav-art rarity-${fav.rarity}`, title: fav.name }, art(fav, 84), h('span', { class: 'fd-fav-cap', text: 'showing off' }))
      : h('div', { class: 'fd-fav-art empty', 'aria-hidden': 'true' }, h('span', { text: '?' })));
    $('bdEmpty').hidden = !!(v.seen || v.loose.length);
  }

  function renderLoose(v) {
    const list = v.loose.slice(0, MAX_LOOSE);
    $('bdLooseBox').hidden = !list.length;
    $('bdLoose').replaceChildren(...list.map(l => {
      const where = l.project ? ` in ${l.project}` : '';
      const why = l.refused ? `Not like that: ${REASONS[l.refused] || 'that fix didn’t count'}` : l.engaged ? 'Claude’s on it' : 'Waiting for a fix';
      return h('li', { class: `bd-loose-row${l.refused ? ' refused' : ''}` },
        h('span', { class: 'bd-loose-art', 'aria-hidden': 'true' }, hasArt(l) ? art(l, 28) : null),
        h('span', { class: 'bd-loose-text' },
          h('span', {}, h('b', { text: l.name }), ` spotted${where} ${ago(l.at)}`),
          h('span', { class: 'bd-loose-why', text: why })),
        l.tabId ? h('button', { type: 'button', class: 'btn ghost slim-btn', 'aria-label': `Open the tab where ${l.name} is loose`, onclick: () => api.openBugTab(l.tabId) }, 'Open the tab') : h('span'));
    }));
  }

  function renderHabitats(v) {
    const byId = new Map(v.species.map(s => [s.id, s]));
    $('bdHabitats').replaceChildren(...v.habitats.filter(x => x.of > 0).map(x => h('li', {
      class: `fd-set${x.done && !x.added ? ' done' : ''}`,
      title: x.members.map(id => byId.get(id)).filter(s => s && s.state !== 'unknown').map(s => s.name).join(', ') || undefined,
    },
    h('span', { class: 'fd-set-icon', 'aria-hidden': 'true', text: x.icon }),
    h('span', { class: 'fd-set-name', text: x.name }),
    h('span', { class: 'fd-set-dots', 'aria-label': `${x.have} of ${x.of} caught` }, x.members.map(id => h('i', { class: byId.get(id)?.state === 'caught' ? 'on' : '' }))),
    x.done && !x.added ? h('span', { class: 'fd-set-done', text: '✓' }) : null,
    x.added ? h('span', { class: 'new-pill fd-set-new', text: `${x.added} new` }) : null)));
  }

  // All · Caught · Seen · one per habitat: a tab list, so the arrow keys walk it (a11y.js).
  function renderFilters(v) {
    const count = st => v.species.filter(s => s.state === st).length;
    const chips = [
      { id: 'all', label: 'All', n: v.species.length },
      { id: 'caught', label: 'Caught', n: count('caught') },
      { id: 'seen', label: 'Seen', n: count('seen') },
      ...v.habitats.filter(x => x.of > 0).map(x => ({ id: x.id, label: `${x.icon} ${x.name}`, n: `${x.have}/${x.of}` })),
    ];
    if (!chips.some(c => c.id === filter)) filter = 'all';
    $('bdFilters').hidden = !v.seen;
    $('bdFilters').replaceChildren(...chips.map(c => h('button', {
      type: 'button', role: 'tab', 'aria-selected': String(c.id === filter), dataset: { filter: c.id },
    }, c.label, ' ', h('span', { class: 'n', text: String(c.n) }))));
  }

  const shows = s => filter === 'all' || (filter === 'caught' ? s.state === 'caught' : filter === 'seen' ? s.state === 'seen' : s.habitat === filter);

  function labelOf(s) {
    if (s.state === 'unknown') return `${num(s.no)}, not seen yet. ${s.blurb}`;
    if (s.state === 'seen') return `${num(s.no)} ${s.name}, seen but not caught yet. ${s.blurb}`;
    const forms = (s.forms || []).map(f => FORMS[f]?.[1]).filter(Boolean);
    return `${num(s.no)} ${s.name}, ${s.rarityLabel}, caught ${times(s.caught)}${forms.length ? `, ${forms.join(', ')}` : ''}${s.isNew ? ', new' : ''}`;
  }

  function pips(s) {
    if (s.state !== 'caught' || !s.stage) return null;
    if (s.stage >= 4) return h('span', { class: 'bd-crown', title: 'Master', text: '👑' });
    return h('span', { class: 'bd-pips', title: `Stage ${STAGE_NAMES[s.stage]}` }, [1, 2, 3].map(i => h('i', { class: i <= s.stage ? 'on' : '' })));
  }

  function tile(s) {
    const caught = s.state === 'caught';
    const forms = caught ? (s.forms || []).map(f => FORMS[f]?.[0]).filter(Boolean).join('') : '';
    return h('li', {},
      h('button', {
        type: 'button', class: `fd-tile bd-tile rarity-${s.rarity} ${s.state}${caught ? '' : ' locked'}${selected === s.id ? ' on' : ''}`,
        'aria-label': labelOf(s), 'aria-pressed': String(selected === s.id), dataset: { id: s.id },
        onclick: () => select(s.id),
      },
      h('span', { class: 'bd-no', 'aria-hidden': 'true', text: num(s.no) }),
      h('span', { class: 'fd-art' }, hasArt(s) ? art(s, 40) : unknownArt()),
      h('span', { class: 'fd-name', text: s.name }),
      h('span', { class: 'fd-rarity', text: caught ? s.rarityLabel : s.state === 'seen' ? 'Seen' : '' }),
      h('span', { class: 'bd-meta', 'aria-hidden': 'true' }, pips(s), forms ? h('span', { class: 'bd-forms', text: forms }) : null),
      caught && s.caught > 1 ? h('span', { class: 'fd-count-pill', 'aria-hidden': 'true', text: `×${s.caught}` }) : null,
      s.isNew ? h('span', { class: 'new-pill', 'aria-hidden': 'true', text: 'new' }) : null));
  }

  const tileFor = id => [...$('bdGrid').querySelectorAll('[data-id]')].find(b => b.dataset.id === id) || null;

  function renderGrid(v) {
    // Redrawing takes the focused tile with it: put the keyboard back on the same one.
    const had = document.activeElement?.closest?.('#bdGrid [data-id]')?.dataset.id;
    const list = v.species.filter(shows).sort((a, b) => a.no - b.no);
    $('bdGrid').replaceChildren(...(list.length ? list.map(tile) : [h('li', { class: 'muted small', text: filter === 'caught' ? 'Nothing caught yet.' : 'Nothing here yet.' })]));
    if (had) tileFor(had)?.focus({ preventScroll: true });
  }

  function statsLine(s) {
    if (s.state === 'seen') return `Seen ${times(s.seenCount || 1)}${s.seenAt ? ` · last spotted ${ago(s.seenAt)}` : ''} · not caught yet`;
    if (s.state !== 'caught') return null;
    return [
      s.first ? `First caught ${day(s.first)}${s.firstProject ? ` in ${s.firstProject}` : ''}` : null,
      `caught ${plural(s.caught, 'time')}`,
      s.fastest ? `fastest ${took(s.fastest)}` : null,
      s.escapes ? `got away ${times(s.escapes)}` : null,
    ].filter(Boolean).join(' · ');
  }

  function nextLine(s) {
    if (s.state !== 'caught' || !s.toNext) return null;
    const more = plural(s.toNext, 'more catch', 'more catches');
    if (s.nextName) return h('p', { class: 'bd-next' }, h('b', { text: `→ ${s.nextName}` }), ` · ${more} to evolve`);
    return h('p', { class: 'bd-next', text: `${more} to stage ${STAGE_NAMES[(s.stage || 1) + 1]}` });
  }

  function chips(s) {
    if (s.state !== 'caught') return null;
    const forms = (s.forms || []).filter(f => FORMS[f]).map(f => h('span', { class: `bd-chip form form-${f}`, text: `${FORMS[f][0]} ${FORMS[f][1]}` }));
    const langs = (s.langs || []).map(l => LANGS[l] || l);
    if (!forms.length && !langs.length) return null;
    return h('div', { class: 'bd-chips' }, forms, langs.length ? h('span', { class: 'bd-chip', text: `Caught in ${langs.join(' · ')}` }) : null);
  }

  function renderDetail() {
    const v = dex();
    const s = v?.species.find(x => x.id === selected);
    const box = $('bdDetail');
    if (!s) { box.hidden = true; box.replaceChildren(); return; }
    const where = habitatOf(s);
    const caught = s.state === 'caught';
    const isFav = v.favourite === s.id;
    box.hidden = false;
    box.className = `fd-detail bd-detail rarity-${s.rarity} ${s.state}`;
    box.replaceChildren(
      h('div', { class: 'fd-big' }, hasArt(s) ? art(s, 110) : unknownArt()),
      h('div', { class: 'fd-info' },
        h('p', { class: 'fd-rarity-line bd-where' },
          [num(s.no), where?.name, caught ? s.rarityLabel : s.state === 'seen' ? 'Seen' : null].filter(Boolean).join(' · '),
          s.state !== 'unknown' && s.typeLabel ? h('span', { class: 'bd-type', style: HEX.test(s.typeColor) ? `--type:${s.typeColor}` : null, text: s.typeLabel }) : null),
        h('h3', { text: s.state === 'unknown' ? 'Not seen yet' : s.name }),
        nextLine(s),
        h('p', { class: 'fd-blurb', text: s.blurb }),
        statsLine(s) ? h('p', { class: 'fd-when', text: statsLine(s) }) : null,
        chips(s),
        caught ? h('div', { class: 'fd-actions' },
          isFav
            ? h('button', { type: 'button', class: 'btn ghost slim-btn', onclick: () => favourite(null) }, '★ His favourite (let him choose)')
            : h('button', { type: 'button', class: 'btn primary slim-btn', onclick: () => favourite(s.id) }, 'Make this his favourite')) : null),
      h('button', { type: 'button', class: 'icon-btn fd-close', 'aria-label': 'Close', onclick: () => close() }, '×'));
  }

  function select(id) {
    selected = selected === id ? null : id;
    render();
  }

  // Closing the card hands the keyboard back to its tile.
  function close() {
    const id = selected;
    selected = null;
    render();
    if (id) tileFor(id)?.focus();
  }

  async function favourite(id) {
    try {
      apply(await api.setFavouriteBug(id));
      SB.toast(id ? 'He’ll show that one off.' : 'He’ll pick his own favourite again.');
    } catch {
      SB.toast('Couldn’t change his favourite.');
    }
  }

  async function startOver() {
    try {
      const r = await api.forgetBugdex(); // main asks first
      if (!r?.ok) return;
      selected = null;
      filter = 'all';
      apply(await api.getBugdex());
      SB.toast('The Bugdex is empty again.');
    } catch {
      SB.toast('Couldn’t start the Bugdex over.');
    }
  }

  // ------------------------------------------------------------ data in
  function apply(v) {
    if (!v) return;
    state.bugdex = v;
    document.querySelectorAll('.bd-count').forEach(el => { el.textContent = v.caught ? String(v.caught) : ''; });
    document.querySelectorAll('.bd-badge').forEach(el => { el.hidden = !v.unseen.length; });
    SB.refreshShellbyBadge?.();
    if (state.view === 'bugdex') render();
  }

  // Looking at the page counts as seeing what's new on it, after a moment to notice.
  function notice() {
    clearTimeout(seenTimer);
    if (!dex()?.unseen.length) return;
    seenTimer = setTimeout(() => { if (state.view === 'bugdex' && !document.hidden) api.bugdexSeen(); }, SEEN_AFTER_MS);
  }

  const refresh = () => api.getBugdex().then(v => { apply(v); notice(); }).catch(() => {});

  // Open the page on one entry, its card showing and its tile under the keyboard.
  function focusOn(id) {
    selected = id || null;
    filter = 'all';
    SB.setView('bugdex');
    const tileEl = id && tileFor(id);
    if (!tileEl) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    $('bdDetail').scrollIntoView({ block: 'nearest', behavior: smooth ? 'smooth' : 'auto' });
    tileEl.focus({ preventScroll: true });
  }

  // ------------------------------------------------------------ wiring
  $('bdFilters').addEventListener('click', e => {
    const b = e.target.closest('[data-filter]');
    if (!b || b.dataset.filter === filter) return;
    filter = b.dataset.filter;
    render();
  });
  $('bdForget').addEventListener('click', startOver);

  api.onBugdex(apply);
  api.onBugdexFocus(m => focusOn(m?.id));

  // A catch: a card for a first rare one, a toast for the rest, and only while you're looking.
  api.onBugdexCaught(c => {
    if (!c?.name) return;
    refresh();
    if (document.hidden) return;
    const open = () => focusOn(c.id);
    if (c.isNew && (c.rarity === 'rare' || c.rarity === 'legendary')) {
      SB.celebrate({
        eyebrow: c.rarity === 'legendary' ? 'Legendary catch' : 'Rare catch', icon: '🫙', title: c.name,
        text: 'New to the Bugdex. Claude fixed it, so it’s in a jar.',
        action: { label: 'See it in the Bugdex', run: open },
      });
      return;
    }
    const extra = [
      c.evolved ? `It evolved to stage ${STAGE_NAMES[c.stage] || c.stage}!` : '',
      c.completed?.length ? `${c.completed.join(' and ')} finished!` : '',
    ].filter(Boolean).join(' ');
    SB.toast(`${c.isNew ? 'New to the Bugdex' : 'In the jar'}: ${c.name}${extra ? `. ${extra}` : ''}`, { action: 'Bugdex', ms: 4500, onAction: open });
  });

  SB.views.bugdex = { render: () => { render(); notice(); refresh(); } };
  refresh();
})();
