/* Shellby panel — the Logbook: every game system on one page (main/logbook.js
   composes the cards). Each card says what's going on and what to do next,
   opens the screen it comes from, and lists what it feeds ("catch it with a
   test → its nest clears → coral grows"), each a link to that screen. A card
   whose system hasn't arrived says "not yet". Cards pin to the top or fold
   down to their title. The quest line's chapters sit under the cards. It reads
   its views through api.getGame / api.gameAct / api.onGame. */
'use strict';
(function () {
  const { api, h, $ } = SB;

  let view = null;   // main's logbookView()
  let quests = null; // main's questsView(), for the chapter list

  SB.NAV_SECTION.logbook = 'wardrobe'; // a tab of the Shellby screen

  const VIEW_NAMES = {
    chat: 'Chat', logbook: 'Logbook', wardrobe: 'Outfits', trophies: 'Trophies', finds: 'Finds', stickers: 'Stickers',
    bugdex: 'Bugdex', tank: 'Tank', us: 'Us', crew: 'Crew', council: 'Council', projects: 'Projects', history: 'History',
    notes: 'Notes', health: 'Health', toolbox: 'Toolbox', workflows: 'Automate', routines: 'Routines', time: 'Time', shop: 'Skill Shop',
  };

  /** Go to a screen and, when it names one, bring an element on it into view. */
  SB.go = SB.go || ((target, focus) => {
    SB.setView(target);
    if (!focus) return;
    requestAnimationFrame(() => {
      const el = $(focus);
      if (!el) return;
      el.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      if (el.tabIndex >= 0 || el.hasAttribute('tabindex')) el.focus({ preventScroll: true });
    });
  });

  // ------------------------------------------------------------ the tab

  // The Logbook is the first tab of his screen. Its own page and Outfits have
  // the button in their markup; the other pages' strips get it here.
  function addTabs() {
    for (const nav of document.querySelectorAll('.shellby-tabs')) {
      if (nav.querySelector('[data-goto="logbook"]')) continue;
      const b = h('button', { type: 'button', 'data-goto': 'logbook', text: 'Logbook' });
      b.addEventListener('click', () => SB.setView('logbook'));
      nav.prepend(b);
    }
  }

  // ------------------------------------------------------------ cards

  function bar(n, of, label) {
    const pct = of > 0 ? Math.round(Math.min(1, n / of) * 100) : 0;
    return h('div', { class: 'lb-bar', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) },
      h('i', { style: `width:${pct}%` }));
  }

  function row(r) {
    const count = r.of ? `${r.n}/${r.of}` : r.max ? `${r.hp}/${r.max} HP` : '';
    return h('li', { class: r.done ? 'done' : r.now ? 'now' : '' },
      h('span', { class: 'lb-row-mark', 'aria-hidden': 'true', text: r.done ? '✓' : r.nest ? '🪺' : r.icon || '·' }),
      h('span', { class: 'lb-row-text', text: r.project ? `${r.text} · ${r.project}` : r.text }),
      r.nest && h('span', { class: 'sr-only', text: 'in a nest' }),
      count && h('span', { class: 'lb-row-n', text: count }));
  }

  function chart(days) {
    const max = Math.max(1, ...days.map(d => d.xp));
    return h('div', { class: 'lb-chart', role: 'img', 'aria-label': `XP over the last ${days.length} days: ${days.map(d => d.xp).join(', ')}` },
      ...days.map(d => h('i', { style: `height:${Math.max(4, Math.round((d.xp / max) * 100))}%`, title: `${d.day}: ${d.xp} XP` })));
  }

  function feeds(c) {
    if (!c.feeds.length) return null;
    return h('ul', { class: 'lb-feeds', 'aria-label': 'What this feeds' },
      ...c.feeds.map(f => h('li', {},
        h('button', { type: 'button', class: 'lb-feed', 'data-to': f.to, title: `Open ${VIEW_NAMES[f.to] || f.to}`, onclick: () => SB.go(f.to) },
          h('span', { class: 'lb-feed-arrow', 'aria-hidden': 'true', text: '→' }), f.text,
          h('span', { class: 'lb-feed-to', text: VIEW_NAMES[f.to] || f.to })))));
  }

  async function act(action, payload) {
    try {
      const v = await api.gameAct('logbook', action, payload);
      if (v) received(v);
    } catch (e) {
      SB.toast('The Logbook couldn’t save that. Try again.');
    }
  }

  function renderCard(c) {
    const where = VIEW_NAMES[c.go.view] || c.go.view;
    const head = h('div', { class: 'lb-head' },
      h('span', { class: 'lb-icon', 'aria-hidden': 'true', text: c.icon }),
      h('h3', { class: 'lb-title', text: c.title }),
      c.isNew && h('span', { class: 'lb-new', text: 'New' }),
      h('button', {
        type: 'button', class: `lb-pin${c.pinned ? ' on' : ''}`, 'aria-pressed': c.pinned ? 'true' : 'false',
        title: c.pinned ? 'Unpin' : 'Pin to the top', 'aria-label': `${c.pinned ? 'Unpin' : 'Pin'} ${c.title}`, text: '📌',
        onclick: () => act('pin', { id: c.id, on: !c.pinned }),
      }),
      h('button', {
        type: 'button', class: 'lb-fold', 'aria-expanded': c.collapsed ? 'false' : 'true',
        'aria-label': `${c.collapsed ? 'Open' : 'Fold'} ${c.title}`, text: c.collapsed ? '▸' : '▾',
        onclick: () => act('collapse', { id: c.id, on: !c.collapsed }),
      }));
    const body = c.collapsed ? null : h('div', { class: 'lb-body' },
      h('p', { class: 'lb-text', text: c.text }),
      c.progress && bar(c.progress.n, c.progress.of, `${c.title}: ${c.progress.n} of ${c.progress.of}`),
      c.rows.length ? h('ul', { class: 'lb-rows' }, ...c.rows.map(row)) : null,
      c.chart?.length ? chart(c.chart) : null,
      feeds(c),
      !c.missing && h('button', { type: 'button', class: 'btn ghost slim-btn lb-go', text: `Open ${where}`, onclick: () => SB.go(c.go.view, c.go.focus) }));
    return h('article', {
      class: `lb-card lb-${c.id}${c.missing ? ' missing' : ''}${c.quiet ? ' quiet' : ''}${c.pinned ? ' pinned' : ''}`,
      'data-card': c.id, 'aria-label': c.title,
    }, head, body);
  }

  // Before the core loop, a card about a room that hasn't opened yet
  // (rooms.js) waits with it, so someone new isn't shown the whole game on day one.
  const CARD_ROOM = { loose: 'bugdex', tide: 'us', reef: 'reef', review: 'mastery' };
  const waits = c => !!SB.isGameWaiting?.() && !!SB.isRoomLocked?.(CARD_ROOM[c.id]);
  function renderCards() {
    const box = $('lbCards');
    if (!box || !view) return;
    box.replaceChildren(...view.cards.filter(c => !waits(c)).map(renderCard));
  }
  api.onRooms(() => requestAnimationFrame(renderCards));

  // ------------------------------------------------------------ the chapters

  function renderChapters() {
    const list = $('lbChapterList');
    if (!list) return;
    $('lbChapters').hidden = !quests || SB.isCrabOnly?.();
    if (!quests || SB.isCrabOnly?.()) return;
    $('lbChapterCount').textContent = `· ${quests.chaptersDone} of ${quests.totalChapters} chapters`;
    list.replaceChildren(...quests.chapters.map(ch => h('li', { class: `${ch.done ? 'done' : ''}${ch.unlocked ? '' : ' locked'}`, 'data-chapter': ch.id },
      h('div', { class: 'lb-ch-head' },
        h('span', { class: 'lb-ch-icon', 'aria-hidden': 'true', text: ch.unlocked ? ch.icon : '🔒' }),
        h('b', { text: `${ch.n}. ${ch.title}` }),
        h('span', { class: 'lb-row-n', text: ch.unlocked ? `${ch.doneCount}/${ch.total}` : '' })),
      h('p', { class: 'muted small', text: ch.unlocked ? `${ch.blurb} ${ch.teaches}` : ch.unlockText }),
      ch.unlocked && !ch.done ? h('ul', { class: 'lb-rows' }, ...ch.quests.map(q => h('li', { class: q.done ? 'done' : '' },
        h('span', { class: 'lb-row-mark', 'aria-hidden': 'true', text: q.done ? '✓' : q.icon }),
        h('span', { class: 'lb-row-text' }, h('b', { text: q.title }), q.done ? null : h('span', { class: 'muted small', text: ` ${q.how}` }))))) : null)));
  }

  // ------------------------------------------------------------ updates

  function received(v) {
    if (!v || !Array.isArray(v.cards)) return;
    view = v;
    renderCards();
  }

  async function refresh() {
    try {
      const [v, q] = await Promise.all([api.getGame('logbook'), api.getGame('quests')]);
      received(v);
      quests = q;
      renderChapters();
      // The newest chapter has been seen: its "New" mark goes.
      if (q?.chapter?.isNew && SB.state.view === 'logbook') api.gameAct('quests', 'seen', q.chapter.id).catch(() => {});
    } catch (e) {
      const box = $('lbCards');
      if (box && !view) box.replaceChildren(h('p', { class: 'muted', text: 'The Logbook couldn’t load just now. Try again in a moment.' }));
    }
  }

  // An arrival counts as opening it (the logbook-opened stat); a re-render while here doesn't.
  let arrived = false;
  const setView = SB.setView;
  SB.setView = target => { arrived = target === 'logbook' && SB.state.view !== 'logbook'; setView(target); };

  SB.views.logbook = {
    render() {
      addTabs();
      if (arrived) act('open').then(refresh); else refresh();
      arrived = false;
    },
  };

  api.onGame(({ what, view: v } = {}) => {
    if (what === 'logbook') received(v);
    if (what === 'quests' && v) { quests = v; renderChapters(); }
  });

  addTabs();
})();
