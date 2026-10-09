/* Shellby panel — one project's page (projects.js opens it and holds what's
   open). Top to bottom: who it is and the buttons you came for, what needs you
   (each line takes you to where it's dealt with), a row of links to every part
   of the page, then the cards: what to work on, how it's going, where you left
   off, health, releases, helpers, conversations, the standup to paste
   (project-report.js), and last the clones (git and dev servers,
   projects-servers.js), which is where the work actually happens. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  const F = SB.pjFacts;
  const L = window.ShellbyProjectsLogic;
  const P = SB.pj;

  // The page's parts, in order, as the links at the top name them.
  const SECTIONS = [
    ['next', 'Next up'], ['pulse', 'Pulse'], ['notes', 'Notes'], ['health', 'Health'], ['releases', 'Releases'],
    ['helpers', 'Helpers'], ['convos', 'Conversations'], ['report', 'Report'], ['clones', 'On this PC'],
  ];
  const sectionId = key => `pj-sec-${key}`;

  function renderDetail() {
    const p = P.detail();
    if (!p) return;
    const main = p.local[0];
    const reload = () => P.openProject(p.key, { quiet: true });
    // Each card sits in a wrapper the links point at: some cards redraw themselves in place.
    const cards = [
      // What to work on comes first: it's why you opened the page (backlog.js).
      ['next', (main || p.github) && SB.backlog.card({ root: main?.root || null, repo: p.github?.repo || null, name: p.name }, { onClone: repo => P.openClone(repo) })],
      ['pulse', main && F.pulse(p, { onChange: reload })],
      ['notes', main && F.journal(p, { newHere: P.newHere, onChange: reload, keptDetails: P.keptDetails })],
      ['health', F.health(p)],
      ['releases', main && SB.releasesCard(main.root, p.name)],
      ['helpers', main && SB.projectTools.card({ root: main.root, name: p.name })],
      ['convos', main && F.conversations(p, { newHere: P.newHere })],
      ['report', main && SB.pjReport.card(p)],
    ].filter(([, el]) => el).map(([key, el]) => [key, section(key, el)]);
    const clones = section('clones', ...clonesPart(p));
    const present = new Set([...cards.map(([key]) => key), 'clones']);
    const foot = h('div', { class: 'row wrap pj-detail-foot' },
      h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Remove from Projects', onclick: () => removeProject(p) }));
    SB.keepFocus($('pjDetailScreen'), () => $('pjDetailScreen').replaceChildren(
      head(p), needsStrip(p), jumpLinks(present), ...cards.map(([, el]) => el), clones, foot,
    ));
  }

  // A part of the page a link can jump to (and focus): data-keep keeps you on it through a redraw.
  const section = (key, ...body) => h('div', { class: 'pj-sec', id: sectionId(key), tabindex: '-1', dataset: { keep: `sec:${key}` } }, ...body);

  // ------------------------------------------------------------------ the top

  function head(p) {
    const main = p.local[0];
    const sticker = p.insights?.sticker;
    const dev = P.devAction(p);
    return h('div', { class: 'pj-detail-head' },
      h('button', { type: 'button', class: 'btn ghost slim-btn', text: '← Projects', onclick: P.closeProject }),
      h('div', { class: 'pj-hero' },
        F.tile(p, 'lg'),
        h('div', { class: 'pj-hero-text' },
          h('h3', { class: 'pj-detail-name', text: p.name }),
          h('span', { class: 'pj-hero-tags' },
            p.github && h('button', { type: 'button', class: 'link-btn pj-repo', text: p.github.repo, onclick: () => api.openProjectOnGitHub(p.github.repo) }),
            p.github?.private && h('span', { class: 'pj-tag', text: 'private' }),
            p.github?.fork && h('span', { class: 'pj-tag', text: 'fork' }),
            p.github?.archived && h('span', { class: 'pj-tag', text: 'archived' })),
          sticker && h('span', { class: 'pj-hero-sticker', title: sticker.marks.map(m => m.name).join(', ') },
            `${sticker.tierName} sticker · ${SB.plural(sticker.ships, 'ship')}`,
            sticker.marks.length ? ` · ${sticker.marks.map(m => m.icon).join(' ')}` : ''))),
      p.github?.description && h('p', { class: 'muted small pj-desc', text: p.github.description }),
      h('div', { class: 'row wrap pj-hero-acts' },
        main && h('button', { type: 'button', class: 'btn primary', text: 'New conversation here', onclick: () => P.newHere(main.root) }),
        dev && h('button', { type: 'button', class: 'btn slim-btn', text: dev.label, onclick: () => dev.run() }),
        main && h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Open folder', onclick: () => api.openProjectFolder(main.root) }),
        !main && p.github && h('button', { type: 'button', class: 'btn primary', text: 'Clone…', onclick: () => P.openClone(p.github.repo) }),
        p.github && main && h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Open on GitHub', onclick: () => api.openProjectOnGitHub(p.github.repo) })));
  }

  // What needs you, worst first, each a button to where it's dealt with. Nothing when nothing does.
  function needsStrip(p) {
    const main = p.local[0];
    const mine = p.local.flatMap(c => P.serversIn(c.root));
    const crashed = mine.filter(s => s.status === 'crashed');
    const list = L.needsList(p, { crashed: crashed.length, dirty: main?.git?.dirty || 0 });
    if (!list.length) return null;
    const go = n => {
      if (n.go === 'tidy' && main) return P.newHere(main.root, L.tidyPrompt(p.name));
      const card = n.go === 'servers' && crashed[0] && document.getElementById(`srv-card-${crashed[0].id}`);
      jumpTo(card || $(sectionId(n.go === 'servers' ? 'clones' : 'health')));
    };
    return h('section', { class: 'pj-needs', 'aria-label': 'Needs you' },
      h('p', { class: 'row-label', text: 'Needs you' }),
      h('ul', { class: 'pj-needs-list' }, list.map(n => h('li', {},
        h('button', { type: 'button', class: `pj-need ${n.tone}`, dataset: { keep: `need:${n.id}` }, onclick: () => go(n) },
          h('span', { class: 'pj-need-text', text: n.text }),
          h('span', { class: 'pj-need-go', text: n.go === 'tidy' ? 'Tidy up…' : n.go === 'servers' ? 'See it' : 'Health' }))))));
  }

  // A link to each part of the page, on a row that stays at the top as you scroll.
  // Its right edge fades while there are more links past it.
  function jumpLinks(present) {
    const nav = h('nav', { class: 'pj-jump', 'aria-label': 'On this page' },
      SECTIONS.filter(([key]) => present.has(key)).map(([key, label]) =>
        h('button', { type: 'button', class: 'pj-jump-link', dataset: { keep: `jump:${key}` }, text: label, onclick: () => jumpTo($(sectionId(key))) })));
    const edge = () => nav.classList.toggle('more', nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 1);
    nav.addEventListener('scroll', edge, { passive: true });
    requestAnimationFrame(edge);
    return nav;
  }

  // Scrolls there and moves focus with you, so the keyboard carries on from it.
  function jumpTo(el) {
    if (!el) return;
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ block: 'start', behavior: smooth ? 'smooth' : 'auto' });
    (el.matches('[tabindex], button') ? el : el.querySelector('button') || el).focus({ preventScroll: true });
  }

  // ------------------------------------------------------------------ the clones

  function clonesPart(p) {
    if (!p.local.length) return [h('section', { class: 'pj-clone' }, h('p', { class: 'muted', text: 'Not on this PC. Clone it to run it, and to see its git, tests and dependencies here.' }))];
    return [h('p', { class: 'row-label pj-clones-label', text: p.local.length > 1 ? `${p.local.length} clones on this PC` : 'On this PC' }), ...p.local.map(c => cloneSection(c, p))];
  }

  function cloneSection(c, p) {
    const git = c.git;
    const { text: facts, atRisk } = L.cloneFacts(c); // atRisk is a boolean: h() would draw a bare 0
    return h('section', { class: 'pj-clone', dataset: { root: c.root } },
      h('div', { class: 'pj-clone-head' },
        h('code', { class: 'pj-path', text: SB.shortPath(c.root, 46), title: c.root }),
        p.local.length > 1 && h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'Open folder', onclick: () => api.openProjectFolder(c.root) }),
        p.local.length > 1 && h('button', { type: 'button', class: 'btn ghost slim-btn', text: 'New conversation here', onclick: () => P.newHere(c.root) })),
      facts && h('p', { class: 'muted small pj-facts', text: facts }),
      atRisk && h('div', { class: 'pj-tidy' },
        h('span', { class: 'small', text: git.unpushed ? 'This work is only on this PC.' : 'Changes not committed yet.' }),
        h('button', { type: 'button', class: 'btn slim-btn', text: 'Tidy up…', onclick: () => P.newHere(c.root, L.tidyPrompt(p.name)) })),
      copiesList(c.root, git),
      P.serversSection(c));
  }

  // Shellby's copies of the repo (worktrees.js): work that's easy to forget about.
  function copiesList(root, git) {
    const list = git?.copyList || [];
    if (!list.length) return null;
    const d = P.keptDetails(`copies:${root}`, L.copiesSummary(list),
      h('ul', { class: 'pj-copy-list' }, list.map(w => h('li', {},
        h('code', { text: w.branch || 'detached', title: w.path }),
        w.changed ? h('span', { class: 'pj-chip warn', text: `${w.changed} changed` }) : h('span', { class: 'muted small', text: 'clean' })))));
    d.classList.add('pj-copies');
    return d;
  }

  // ------------------------------------------------------------------ removing

  async function removeProject(p) {
    const r = await api.removeProject(p.key);
    if (!r?.ok) return SB.toast("Couldn't remove it.");
    SB.toast(`${p.name} is off the list. Its folder is untouched.`);
    P.closeProject();
  }

  P.renderDetail = renderDetail;
})();
