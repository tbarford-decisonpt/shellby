/* Shellby panel — quests: a short line of the features worth finding (main/quests.js
   decides which are done). The next one sits on the chat's empty state once the
   first rooms have opened; the whole line, as a trail, sits in Trophies. Each
   finishes the first time the real thing works, and a card says so and points
   at the next. Just-the-crab mode has no Claude, so no quests. */
'use strict';
(function () {
  const { api, h, $ } = SB;

  let view = null; // main's questsView(); null until it arrives (nothing shows)

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

  SB.showQuests = () => {
    SB.setView('trophies');
    requestAnimationFrame(() => $('xpQuests')?.scrollIntoView({ block: 'nearest' }));
  };

  const pips = () => h('span', { class: 'quest-pips', 'aria-hidden': 'true' },
    ...view.list.map(q => h('i', { class: q.done ? 'done' : q.id === view.current ? 'now' : '' })));

  // ------------------------------------------------------------ the chat's card

  // Only once he has finished a task (History is open), so someone brand new
  // meets the crab and the box first.
  const cardShows = () => !off() && !view.hidden && !view.complete && !SB.isRoomLocked?.('history');

  function renderCard(el) {
    if (!el) return;
    el.hidden = !cardShows();
    if (el.hidden) return el.replaceChildren();
    const q = byId(view.current);
    const act = actionFor(q);
    el.replaceChildren(
      h('div', { class: 'quest-top' },
        h('span', { class: 'quest-step', text: `Quest ${view.doneCount + 1} of ${view.total}` }), pips(),
        h('button', { class: 'quest-x', type: 'button', title: 'Hide quests from the chat (they stay in Trophies)', 'aria-label': 'Hide quests from the chat', text: '×', onclick: () => hide(true) })),
      h('h2', { class: 'quest-title' }, h('span', { class: 'quest-icon', 'aria-hidden': 'true', text: q.icon }), q.title),
      h('p', { class: 'quest-why', text: q.why }),
      h('p', { class: 'quest-how', text: q.how }),
      ...(act ? [h('button', { class: 'btn slim-btn quest-go', type: 'button', text: act.label, onclick: act.run })] : []));
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
    $('xpQuestCount').textContent = view.complete ? '· all found' : `· ${view.doneCount} of ${view.total}`;
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

  function celebrate({ done, next, finished }) {
    if (!done || SB.isCrabOnly?.()) return;
    const trail = { label: 'See the quest line', run: SB.showQuests };
    SB.celebrate({
      eyebrow: finished ? 'Quest line complete' : 'Quest complete',
      icon: finished ? '🗺️' : done.icon,
      title: finished ? 'Every hidden trick, found' : done.title,
      text: finished ? `${done.title} was the last one. Comments, second takes, copies and the reset queue are all yours now.`
        : `Next up: ${next.title}. ${next.why}`,
      action: finished ? trail : (actionFor(next) || trail),
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
