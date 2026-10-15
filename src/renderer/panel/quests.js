/* Shellby panel — quests: a short line of the features worth finding (main/quests.js
   decides which are done). The next one sits on the chat's empty state once the
   first rooms have opened; the whole line, as a trail, sits in Trophies. Each
   finishes the first time the real thing works, and a card says so and points
   at the next. Just-the-crab mode has no Claude, so no quests. */
'use strict';
(function () {
  const { api, h, $ } = SB;

  let view = null; // main's questsView(); null until it arrives (nothing shows)

  const SCREEN_LABELS = {
    projects: 'Projects', bugdex: 'the Bugdex', tank: 'the Tank', routines: 'Routines', workflows: 'Automate', council: 'the Council',
    crew: 'the Crew', us: 'Us', trophies: 'Trophies', wardrobe: 'Outfits',
  };

  const off = () => !view || SB.isCrabOnly?.();
  const byId = id => view?.list.find(q => q.id === id) || null;

  // Where each quest points, when there's something to point at right now.
  function actionFor(q) {
    const tab = SB.activeTab?.();
    const idle = tab && !tab.busy;
    if (q.go === 'diff' && SB.hasChanges?.(tab)) return { label: 'Show his changes', run: () => SB.showChanges(tab) };
    if (q.go === 'branch' && idle && tab.lastTurnId) return { label: 'Try it another way', run: () => SB.tryAgain(tab) };
    if (q.go === 'home' && idle && tab.worktree) return { label: 'Bring it home', run: () => SB.bringHome(tab) };
    if (q.go === 'reset') return { label: 'Open the reset queue', run: openResetQueue };
    // Later chapters point at a screen (quests/chapters.js go).
    if (SCREEN_LABELS[q.go] && SB.state.view !== q.go) return { label: `Open ${SCREEN_LABELS[q.go]}`, run: () => SB.setView(q.go) };
    return null;
  }

  function openResetQueue() {
    SB.setView('routines'); // Automate → Routines, where the queue lives
    requestAnimationFrame(() => {
      const box = $('resetQueueText');
      if (!box) return;
      box.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      box.focus({ preventScroll: true });
    });
  }

  // The whole line lives in the Logbook now, chapter by chapter.
  SB.showQuests = () => {
    SB.setView('logbook');
    requestAnimationFrame(() => $('lbChapters')?.scrollIntoView({ block: 'nearest' }));
  };

  const pips = () => h('span', { class: 'quest-pips', 'aria-hidden': 'true' },
    ...view.list.map(q => h('i', { class: q.done ? 'done' : q.id === view.current ? 'now' : '' })));

  // ------------------------------------------------------------ the chat's card

  // Only once he has finished a task (History is open), so someone brand new
  // meets the crab and the box first.
  // First steps (first-run.js) go first: one card at a time on the start screen.
  const cardShows = () => !off() && !view.hidden && !view.complete && !SB.isRoomLocked?.('history') && !SB.firstRunCardShows?.();

  function renderCard(el) {
    if (!el) return;
    el.hidden = !cardShows();
    if (el.hidden) return el.replaceChildren();
    const q = byId(view.current);
    const act = actionFor(q);
    el.replaceChildren(
      h('div', { class: 'quest-top' },
        h('span', { class: 'quest-step', text: `${view.chapter && view.chapter.n > 1 ? `Chapter ${view.chapter.n} · ` : ''}Quest ${view.doneCount + 1} of ${view.total}` }), pips(),
        h('button', { class: 'quest-x', type: 'button', title: 'Hide quests from the chat (they stay in Trophies)', 'aria-label': 'Hide quests from the chat', text: '×', onclick: () => hide(true) })),
      h('h2', { class: 'quest-title' }, h('span', { class: 'quest-icon', 'aria-hidden': 'true', text: q.icon }), q.title),
      h('p', { class: 'quest-why', text: q.why }),
      h('p', { class: 'quest-how', text: q.how }),
      ...(act ? [h('button', { class: 'btn slim-btn quest-go', type: 'button', text: act.label, onclick: act.run })] : []),
      h('button', { class: 'btn ghost slim-btn quest-logbook', type: 'button', text: 'Logbook', title: 'Every chapter, and what each quest feeds', onclick: SB.showQuests }));
  }
  SB.questCardShows = cardShows;
  SB.renderQuestCard = renderCard;

  async function hide(hidden) {
    received({ view: await api.hideQuests(hidden) });
    if (hidden) SB.toast('Quests are in Trophies now.', { action: 'Undo', onAction: () => hide(false), ms: 5000 });
  }

  // ------------------------------------------------------------ the trail in Trophies

  function renderTrail() {
    const box = $('xpQuests');
    box.hidden = off();
    if (box.hidden) return;
    const ch = view.chapter && view.chapter.n > 1 ? `chapter ${view.chapter.n}, ` : '';
    $('xpQuestCount').textContent = view.complete ? '· all found' : `· ${ch}${view.doneCount} of ${view.total}`;
    const toggle = $('xpQuestShow');
    toggle.hidden = !view.hidden || view.complete;
    $('xpQuestList').replaceChildren(...view.list.map((q, i) => {
      const now = q.id === view.current;
      const act = now && actionFor(q);
      return h('li', { class: q.done ? 'done' : now ? 'now' : '', 'aria-current': now ? 'step' : null },
        h('span', { class: 'quest-node', 'aria-hidden': 'true', text: q.done ? '✓' : String(i + 1) }),
        h('div', { class: 'quest-body' },
          h('b', { text: q.title }),
          h('span', { class: 'sr-only', text: q.done ? 'done' : now ? 'next up' : 'not done yet' }),
          (now || !q.done) && h('p', { text: now ? `${q.why} ${q.how}` : q.why }),
          act && h('button', { class: 'btn slim-btn quest-go', type: 'button', text: act.label, onclick: act.run })));
    }));
  }

  // ------------------------------------------------------------ updates

  function celebrate({ done, next, finished, chapter, chapterDone, opened = [] }) {
    if (SB.isCrabOnly?.()) return;
    const trail = { label: 'Open the Logbook', run: SB.showQuests };
    if (!done && opened.length) {
      const c = opened[0];
      SB.celebrate({ eyebrow: 'New chapter', icon: c.icon, title: `Chapter ${c.n}: ${c.title}`, text: `${c.blurb} ${c.teaches}`, action: trail });
      return;
    }
    if (!done) return;
    if (chapterDone && chapter && chapter.n > 1) {
      SB.celebrate({
        eyebrow: 'Chapter complete', icon: chapter.icon, title: `Chapter ${chapter.n}: ${chapter.title}`,
        text: next ? `${chapter.teaches} Next up: ${next.title}.` : `${chapter.teaches} More chapters open as he levels up.`,
        action: trail,
      });
      return;
    }
    // Chapter 1 is the old quest line: finishing it still reads as the line done.
    const first = finished || (chapterDone && chapter?.n === 1);
    SB.celebrate({
      eyebrow: first ? 'Chapter 1 complete' : 'Quest complete',
      icon: first ? '🗺️' : done.icon,
      title: first ? 'Every hidden trick, found' : done.title,
      text: first ? `${done.title} was the last one. Comments, second takes, copies and the reset queue are all yours now. More chapters open as he levels up.`
        : `Next up: ${next.title}. ${next.why}`,
      action: first || !next ? trail : (actionFor(next) || trail),
    });
  }

  function received({ view: v, ...news } = {}) {
    if (!v) return;
    view = v;
    renderTrail();
    document.querySelectorAll('.empty .quest-card').forEach(renderCard);
    celebrate(news);
  }

  $('xpQuestShow').addEventListener('click', () => hide(false));

  // The trail's button depends on the conversation in front: refresh it on the way in.
  const setView = SB.setView;
  SB.setView = target => { setView(target); if (target === 'trophies' && view) renderTrail(); };

  // Switching in or out of just the crab hides or shows them.
  const applyCrabOnly = SB.applyCrabOnly;
  SB.applyCrabOnly = () => { applyCrabOnly(); received({ view }); };

  // History opening (his first task) is what lets the card show on a chat already open.
  api.onRooms(() => requestAnimationFrame(() => document.querySelectorAll('.empty .quest-card').forEach(renderCard)));
  api.onQuests(received);
  api.getQuests().then(v => received({ view: v })).catch(() => {}); // no quests is a fine way to fail
})();
