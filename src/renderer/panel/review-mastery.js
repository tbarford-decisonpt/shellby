/* Shellby panel — review mastery (src/main/review-mastery.js,
   docs/CLAUDE-CODE.md#review-mastery): the tier ladder card on Trophies
   (html/trophies.html #rmCard), with points, catches and the quiz run, what the
   next tier needs, and the last few things that counted. Read through
   api.getGame('review'); a tier reached or a catch arrives on api.onGame. */
'use strict';
(function () {
  const { h, api, $ } = SB;
  let view = null;

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  const ago = at => {
    const m = Math.round((Date.now() - at) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
  };

  function stat(value, label) {
    return h('div', { class: 'rm-stat' }, h('b', { text: String(value) }), h('span', { class: 'muted small', text: label }));
  }

  // One bar per thing the next tier needs, filled as far as you've got.
  function needBar(label, have, goal) {
    if (!goal) return null;
    const done = have >= goal;
    return h('div', { class: `rm-need${done ? ' done' : ''}` },
      h('span', { class: 'small', text: label }),
      h('span', { class: 'rm-bar', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': String(goal), 'aria-valuenow': String(Math.min(have, goal)) },
        h('i', { style: `transform:scaleX(${Math.min(1, have / goal)})` })),
      h('em', { class: 'small', text: `${Math.min(have, goal)}/${goal}` }));
  }

  function render() {
    const card = $('rmCard');
    if (!card || !view) return;
    card.dataset.tier = String(view.tier);
    $('rmTier').textContent = view.tier ? `Tier ${view.tier} · ${view.tierName}${view.flair ? ` · ${view.flair}` : ''}` : 'Not ranked yet';
    $('rmStats').replaceChildren(
      stat(view.points, 'points'),
      stat(view.caught, view.caught === 1 ? 'catch' : 'catches'),
      stat(view.quizStreak, 'quiz run'),
      stat(view.quizBest, 'best run'));
    const n = view.next;
    $('rmNext').replaceChildren(...(n ? [
      h('p', { class: 'small' }, 'Next: ', h('b', { text: n.name }), n.reward ? ` · ${n.reward}` : ''),
      needBar('Points', view.points, n.goal.points),
      needBar('Catches', view.caught, n.goal.caught),
      needBar('Best quiz run', view.quizBest, n.goal.quizBest),
    ] : [h('p', { class: 'small', text: 'Every tier reached. The abyss has no secrets from you.' })]).filter(Boolean));
    $('rmLadder').replaceChildren(...view.tiers.map(t => h('li', { class: `rm-rung${t.reached ? ' reached' : ''}${t.n === view.tier ? ' current' : ''}` },
      h('span', { class: 'rm-rung-n', text: t.reached ? '✓' : String(t.n) }),
      h('span', { class: 'rm-rung-text' },
        h('b', { text: t.name }),
        h('span', { class: 'muted small', text: [plural(t.points, 'point'), t.caught && plural(t.caught, 'catch', 'catches'), t.quizBest && `quiz run of ${t.quizBest}`].filter(Boolean).join(' · ') }),
        t.reward ? h('span', { class: 'rm-reward small', text: t.reward }) : null))));
    const log = view.log || [];
    $('rmLog').hidden = !log.length && !view.watching;
    $('rmLog').replaceChildren(
      ...(view.watching ? [h('li', { class: 'rm-watching muted', text: `Watching Claude's next turn on ${plural(view.watching, 'review')} for a catch.` })] : []),
      ...log.map(e => h('li', { class: `rm-log-${e.kind}` }, h('b', { text: `+${e.points}` }), ` ${e.text}`, h('span', { class: 'muted', text: ` · ${ago(e.at)}` }))));
  }

  async function load() {
    try {
      const v = await api.getGame('review');
      if (v && typeof v.tier === 'number') view = v;
    } catch { /* not there yet */ }
    render();
  }

  api.onGame(({ what, view: v, event } = {}) => {
    if (what !== 'review' || !v || typeof v.tier !== 'number') return;
    view = v;
    render();
    if (event?.kind === 'tier') SB.toast(`🔎 Review mastery: ${event.name}!${event.reward ? ` ${event.reward}.` : ''}`, { ms: 8000 });
    else if (event?.kind === 'caught') SB.toast(`🦅 Caught in review: Claude reworked the lines you flagged in ${event.file}. +${event.points} review points.`);
  });

  new MutationObserver(() => { if (SB.state.view === 'trophies') load(); })
    .observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
  SB.reviewMastery = { load, render };
})();
